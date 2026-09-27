import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// Release invariants of #45: the reader packages version in lockstep, the feature packages peer
// on core's major, every reader package gates `npm publish` on the root verify, and CHANGELOG.md
// has an entry for the versions on disk. RELEASING.md relies on this test to catch a half-bumped
// release.

const root = join(import.meta.dirname, "../..");
const read = (path) => readFileSync(join(root, path), "utf8");
const manifest = (dir) => JSON.parse(read(`packages/${dir}/package.json`));

const READERS = ["core", "texture", "node"];
const FEATURES = ["texture", "node"];

/** `### <version>` headings under the `## <section>` heading of CHANGELOG.md. */
function changelogVersions(section) {
  const text = read("CHANGELOG.md");
  const start = text.indexOf(`\n## ${section}\n`);
  assert.notEqual(start, -1, `CHANGELOG.md has no "## ${section}" section`);
  const next = text.indexOf("\n## ", start + 1);
  const body = text.slice(start, next === -1 ? undefined : next);
  return [...body.matchAll(/^### (\d+\.\d+\.\d+\S*) - /gm)].map((m) => m[1]);
}

test("reader packages share one version", () => {
  const core = manifest("core");
  assert.equal(core.name, "unity-asset-reader");
  for (const dir of READERS) {
    const pkg = manifest(dir);
    const message = `${pkg.name} is ${pkg.version}, core is ${core.version}`;
    assert.equal(pkg.version, core.version, message);
  }
});

test("feature packages peer on core's major", () => {
  const major = manifest("core").version.split(".")[0];
  for (const dir of FEATURES) {
    const pkg = manifest(dir);
    assert.equal(pkg.peerDependencies?.["unity-asset-reader"], `^${major}`, pkg.name);
    // A regular dependency would install a second core next to the app's (plan §1).
    assert.equal(pkg.dependencies?.["unity-asset-reader"], undefined, pkg.name);
  }
});

test("every reader package gates npm publish on the root verify", () => {
  for (const dir of READERS) {
    const pkg = manifest(dir);
    assert.equal(pkg.scripts?.prepublishOnly, "npm run verify --prefix ../..", pkg.name);
  }
  const rootScripts = JSON.parse(read("package.json")).scripts;
  assert.ok(rootScripts.verify, "root package.json has no verify script");
});

test("CHANGELOG.md has an entry for the reader version", () => {
  const version = manifest("core").version;
  assert.ok(changelogVersions("Reader packages").includes(version), `no "### ${version} - " entry`);
});

test("CHANGELOG.md has an entry for the texture2ddecoder-wasm version", () => {
  const version = manifest("texture2ddecoder-wasm").version;
  const versions = changelogVersions("texture2ddecoder-wasm");
  assert.ok(versions.includes(version), `no "### ${version} - " entry`);
});
