import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { declaredDependencies } from "../../rollup.reader.mjs";

const repo = resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(join(tmpdir(), "rollup-reader-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A throwaway `package.json` holding `fields`; returns its path. */
function manifest(name, fields) {
  const path = join(tmp, `${name}.json`);
  writeFileSync(path, JSON.stringify(fields));
  return path;
}

test("dependencies and peerDependencies are external, devDependencies are not", () => {
  const path = manifest("declared", {
    dependencies: { fflate: "^0.8.3" },
    peerDependencies: { "unity-asset-reader": "*" },
    devDependencies: { rollup: "^4.30.1" },
  });
  const external = declaredDependencies(path);
  const matches = (spec) => external.some((re) => re.test(spec));

  assert.ok(matches("fflate"));
  assert.ok(matches("unity-asset-reader"));
  assert.ok(matches("unity-asset-reader/classes"), "subpaths of a declared dep are external too");
  assert.ok(!matches("rollup"), "a devDependency is a build-time dep, so it gets bundled");
  assert.ok(!matches("fflate-extra"), "a longer name that starts the same is not a subpath");
});

test("a package with no dependencies externalizes nothing", () => {
  assert.deepEqual(declaredDependencies(manifest("bare", { name: "x" })), []);
});

/** Import specifiers `src/` reaches for, bare ones only (no `./` relatives). */
function importedPackages(dir) {
  const files = readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.ts$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
  const specs = new Set();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [, spec] of text.matchAll(/(?:from|import\s*\(?|require\s*\()\s*["']([^"']+)["']/g)) {
      if (!spec.startsWith(".")) specs.add(spec);
    }
  }
  return [...specs];
}

// Runs after `npm run build` (root `verify` order, and each package's `pretest`).
for (const pkg of ["core", "texture", "node"]) {
  test(`${pkg}: declared dependencies survive as imports in dist/ (#71)`, () => {
    const root = join(repo, "packages", pkg);
    const external = declaredDependencies(join(root, "package.json"));
    const used = importedPackages(join(root, "src")).filter((s) => external.some((re) => re.test(s)));

    const esm = readFileSync(join(root, "dist/index.mjs"), "utf8");
    const cjs = readFileSync(join(root, "dist/index.cjs"), "utf8");
    for (const spec of used) {
      assert.match(esm, new RegExp(`from\\s*["']${spec}["']`), `${spec} inlined into dist/index.mjs`);
      assert.match(cjs, new RegExp(`require\\(["']${spec}["']\\)`), `${spec} inlined into dist/index.cjs`);
    }
  });
}
