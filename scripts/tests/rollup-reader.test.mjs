import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
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

test("installed dependency kinds are external, devDependencies are not", () => {
  const path = manifest("declared", {
    dependencies: { fflate: "^0.8.3" },
    peerDependencies: { "unity-asset-reader": "*" },
    optionalDependencies: { fzstd: "^0.1.1" },
    devDependencies: { rollup: "^4.30.1" },
  });
  const external = declaredDependencies(path);
  const matches = (spec) => external.some((re) => re.test(spec));

  assert.ok(matches("fflate"));
  assert.ok(matches("unity-asset-reader"));
  assert.ok(matches("fzstd"), "npm installs optionalDependencies too, so they must not be inlined");
  assert.ok(matches("unity-asset-reader/classes"), "subpaths of a declared dep are external too");
  assert.ok(!matches("rollup"), "a devDependency is a build-time dep, so it gets bundled");
  assert.ok(!matches("fflate-extra"), "a longer name that starts the same is not a subpath");
});

test("a package with no dependencies externalizes nothing", () => {
  assert.deepEqual(declaredDependencies(manifest("bare", { name: "x" })), []);
});

// Anchored at the start of a line, so a quoted `from "..."` inside an error
// message is not mistaken for an import (core has several: `... from "corrupt"`).
const STATEMENT = [
  /^\s*(?:import|export)\b[^"']*?\bfrom\s*["']([^"']+)["']/, // import x from "y", export * from "y"
  /^\s*\}\s*from\s*["']([^"']+)["']/, //                        closing line of a multi-line import
  /^\s*import\s*["']([^"']+)["']/, //                           side-effect import
];
/** Dynamic `import("y")` / `require("y")`, which can sit anywhere on a line. */
const DYNAMIC = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Package specifiers `src/` reaches for, bare ones only (no `./` relatives). */
function importedPackages(dir) {
  const files = readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.ts$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
  const specs = new Set();
  const add = (spec) => {
    if (spec && !spec.startsWith(".")) specs.add(spec);
  };
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      for (const re of STATEMENT) add(line.match(re)?.[1]);
      for (const [, spec] of line.matchAll(DYNAMIC)) add(spec);
    }
  }
  return [...specs];
}

/** Node builtins, external only for `packages/node` via its own rollup config (R4). */
const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

// Runs after `npm run build` (root `verify` order, and each package's `pretest`).
for (const pkg of ["core", "texture", "node"]) {
  const root = join(repo, "packages", pkg);

  // Rollup does not catch this: npm hoists every root devDependency and symlinks
  // every workspace sibling into the root node_modules, so an undeclared import
  // of one resolves and is inlined silently. Only a package absent from
  // node_modules fails the build. This row is the guard instead.
  test(`${pkg}: src/ imports nothing undeclared (#71)`, () => {
    const external = declaredDependencies(join(root, "package.json"));
    const undeclared = importedPackages(join(root, "src")).filter(
      (spec) => !external.some((re) => re.test(spec)) && !(pkg === "node" && BUILTIN.has(spec)),
    );
    assert.deepEqual(
      undeclared,
      [],
      `undeclared import(s) would be inlined into dist/: declare them in packages/${pkg}/package.json`,
    );
  });

  test(`${pkg}: declared dependencies survive as imports in dist/ (#71)`, () => {
    const external = declaredDependencies(join(root, "package.json"));
    const used = importedPackages(join(root, "src")).filter((s) => external.some((re) => re.test(s)));
    // texture and node import nothing yet, so their rows only start biting with
    // M3/M5. core must never go quietly empty the day it stops importing fflate.
    if (pkg === "core") assert.ok(used.length > 0, "core declares and imports at least one dep; this row is vacuous otherwise");

    const esm = readFileSync(join(root, "dist/index.mjs"), "utf8");
    const cjs = readFileSync(join(root, "dist/index.cjs"), "utf8");
    for (const spec of used) {
      assert.match(esm, new RegExp(`from\\s*["']${spec}["']`), `${spec} inlined into dist/index.mjs`);
      assert.match(cjs, new RegExp(`require\\(["']${spec}["']\\)`), `${spec} inlined into dist/index.cjs`);
    }
  });
}
