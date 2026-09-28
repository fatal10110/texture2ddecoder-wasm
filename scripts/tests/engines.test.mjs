// The Node.js floor of the reader packages (#172): one `engines` range for all three, the
// Requirements section of each package README says the same, and CI runs on exactly the lowest
// versions it admits (the `reader-floor` matrix, and the floor steps of the `decoder` job that
// run scripts/check-node-floor.mjs with the WASM).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "../..");
const read = (path) => readFileSync(join(root, path), "utf8");

/**
 * `import` and `require()` of each reader package and `initTexture()` work from these on
 * (`require(esm)` and ES-module syntax detection), measured with `npx node@<version>`.
 */
const ENGINES = "^20.19.0 || >=22.12.0";
const FLOORS = ["20.19.0", "22.12.0"];
const READERS = ["core", "texture", "node"];

/** The lowest version of each `||` part of a range made of `^x.y.z` and `>=x.y.z`. */
function floors(range) {
  return range.split("||").map((part) => {
    const m = /^\s*(?:\^|>=)(\d+\.\d+\.\d+)\s*$/.exec(part);
    assert.ok(m, `unexpected engines part "${part}"`);
    return m[1];
  });
}

/** The body of one job of ci.yml, up to the next job. */
function job(name) {
  const ci = read(".github/workflows/ci.yml");
  const start = ci.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `ci.yml has no job ${name}`);
  const next = ci.slice(start + 1).search(/\n  [a-z][\w-]*:\n/);
  return next === -1 ? ci.slice(start) : ci.slice(start, start + 1 + next);
}

/** The `## Requirements` section of a Markdown file. */
function requirements(path) {
  const text = read(path);
  const start = text.indexOf("\n## Requirements\n");
  assert.notEqual(start, -1, `${path} has no Requirements section`);
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

test("every reader package has the same engines range, with the measured floors", () => {
  assert.deepEqual(floors(ENGINES), FLOORS);
  for (const dir of READERS) {
    const pkg = JSON.parse(read(`packages/${dir}/package.json`));
    assert.equal(pkg.engines?.node, ENGINES, pkg.name);
  }
});

test("the lockfile records the same engines range", () => {
  const lock = JSON.parse(read("package-lock.json"));
  for (const dir of READERS) {
    assert.equal(lock.packages[`packages/${dir}`]?.engines?.node, ENGINES, dir);
  }
});

test("each reader package's README Requirements section agrees with engines", () => {
  for (const dir of READERS) {
    const path = `packages/${dir}/README.md`;
    const section = requirements(path);
    for (const text of [`\`${ENGINES}\``, "20.19+ or 22.12+"]) {
      assert.ok(section.includes(text), `${path}: no "${text}"`);
    }
    assert.doesNotMatch(section, /\b18\b/, `${path} still names Node.js 18`);
  }
});

test("CI runs the reader tests and the floor check on exactly the engines floors", () => {
  const floor = job("reader-floor");
  const matrix = /^\s+node: \[(.*)\]$/m.exec(floor);
  assert.ok(matrix, "reader-floor has no node matrix");
  const versions = matrix[1].split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
  assert.deepEqual(versions, FLOORS);
  assert.match(floor, /- run: npm run verify\n/);
  assert.match(floor, /- run: node scripts\/check-node-floor\.mjs\n/);

  // The decoder job, with the WASM: setup-node on each floor, each followed by the check.
  const step = new RegExp(
    [
      'node-version: "(\\d+\\.\\d+\\.\\d+)"',
      "\\s+- run: node scripts/check-node-floor\\.mjs",
      "\\s+env:",
      '\\s+REQUIRE_WASM: "1"',
    ].join("\n"),
    "g",
  );
  const steps = [...job("decoder").matchAll(step)].map((m) => m[1]);
  assert.deepEqual(steps, FLOORS);
});
