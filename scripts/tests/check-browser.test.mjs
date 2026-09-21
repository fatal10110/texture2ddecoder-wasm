import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { checkPackage, PACKAGES } from "../check-browser.mjs";

const tmp = mkdtempSync(join(tmpdir(), "check-browser-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A throwaway package whose src/index.ts is `source`. */
function pkg(name, source) {
  const root = join(tmp, name);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/index.ts"), source);
  return root;
}

const rules = { browser: true, noReader: true };

test("clean package passes", async () => {
  assert.deepEqual(await checkPackage(pkg("clean", "export const a = 1;\n"), rules), []);
});

for (const spec of ["fs", "node:fs", "path", "crypto"]) {
  test(`import of "${spec}" fails`, async () => {
    const problems = await checkPackage(pkg(`b-${spec.replace(":", "-")}`, `import "${spec}";\nexport {};\n`), rules);
    assert.match(problems.join("\n"), new RegExp(`resolve "${spec}"`));
  });
}

for (const [name, code] of [
  ["Buffer", "export const a = Buffer.from([1]);"],
  ["process.", "export const a = process.env.X;"],
  ["__dirname", "export const a = __dirname;"],
]) {
  test(`reference to ${name} fails`, async () => {
    const problems = await checkPackage(pkg(`g-${name.replace(".", "")}`, `${code}\n`), rules);
    assert.match(problems.join("\n"), /node-only global/);
  });
}

test("ArrayBuffer and property names are not node globals", async () => {
  const src = "export const a = new ArrayBuffer(1);\nexport const b = ({} as Record<string, number>).process;\n";
  assert.deepEqual(await checkPackage(pkg("false-pos", src), rules), []);
});

for (const spec of ["unity-asset-reader", "unity-asset-reader-texture", "unity-asset-reader/x"]) {
  test(`core importing "${spec}" fails (R14)`, async () => {
    const problems = await checkPackage(pkg(`r-${spec.replace("/", "_")}`, `import "${spec}";\nexport {};\n`), rules);
    assert.match(problems.join("\n"), /R14/);
  });
}

test("texture may import the core, and it stays external", async () => {
  const root = pkg("texture-ok", 'import { x } from "unity-asset-reader";\nexport const y = x;\n');
  assert.deepEqual(await checkPackage(root, PACKAGES.texture), []);
});

test("decoder package is dependency-checked without a browser bundle", async () => {
  const root = pkg("decoder", 'import "fs";\nimport "unity-asset-reader";\nexport {};\n');
  const problems = await checkPackage(root, PACKAGES["texture2ddecoder-wasm"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /R14/);
});

test("unreachable source file importing fs fails (R4)", async () => {
  const root = pkg("orphan", "export const a = 1;\n");
  writeFileSync(join(root, "src/orphan.ts"), 'import "fs";\nexport {};\n');
  assert.match((await checkPackage(root, rules)).join("\n"), /resolve "fs"/);
});

test("typeof process, globalThis.process and process[] fail", async () => {
  for (const [i, code] of ["typeof process", "globalThis.process", 'process["env"]'].entries()) {
    const problems = await checkPackage(pkg(`p${i}`, `export const t = ${code};\n`), rules);
    assert.match(problems.join("\n"), /node-only global/, code);
  }
});

test("deep import of a reader package fails even where imports are allowed", async () => {
  const root = pkg("deep", 'import { x } from "unity-asset-reader/src/x";\nexport const y = x;\n');
  assert.match((await checkPackage(root, PACKAGES.texture)).join("\n"), /deep import/);
});
