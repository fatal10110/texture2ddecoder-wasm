import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// Release invariants of #45 and #174: all four packages version in lockstep, the feature packages
// peer on core's major, the texture package depends on the decoder's major, every reader package
// gates `npm publish` on the root verify, and CHANGELOG.md has an entry for the version on disk.
// RELEASING.md relies on this test to catch a half-bumped release.

const root = join(import.meta.dirname, "../..");
const read = (path) => readFileSync(join(root, path), "utf8");
const manifest = (dir) => JSON.parse(read(`packages/${dir}/package.json`));

const READERS = ["core", "texture", "node"];
const FEATURES = ["texture", "node"];
/** Every published package: the reader packages and the decoder. */
const ALL = [...READERS, "decoder"];

/** The versions of the `## <version> - ` headings of CHANGELOG.md. */
function changelogVersions() {
  return [...read("CHANGELOG.md").matchAll(/^## (\d+\.\d+\.\d+\S*) - /gm)].map((m) => m[1]);
}

test("all four packages share one version", () => {
  const core = manifest("core");
  assert.equal(core.name, "unity-asset-reader");
  assert.equal(manifest("decoder").name, "unity-asset-reader-decoder");
  for (const dir of ALL) {
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

test("the texture package depends on the decoder's major, as a regular dependency", () => {
  const major = manifest("core").version.split(".")[0];
  const pkg = manifest("texture");
  const range = pkg.dependencies?.["unity-asset-reader-decoder"];
  assert.match(range ?? "", new RegExp(`^\\^${major}\\.\\d+\\.\\d+$`), `${pkg.name}: ${range}`);
  assert.equal(pkg.peerDependencies?.["unity-asset-reader-decoder"], undefined, pkg.name);
  // Resolved from the workspace, not from npm.
  const lock = JSON.parse(read("package-lock.json"));
  assert.deepEqual(lock.packages["node_modules/unity-asset-reader-decoder"], {
    resolved: "packages/decoder",
    link: true,
  });
});

test("every reader package gates npm publish on the root verify", () => {
  for (const dir of READERS) {
    const pkg = manifest(dir);
    assert.equal(pkg.scripts?.prepublishOnly, "npm run verify --prefix ../..", pkg.name);
  }
  const rootScripts = JSON.parse(read("package.json")).scripts;
  assert.ok(rootScripts.verify, "root package.json has no verify script");
});

test("CHANGELOG.md has an entry for the version", () => {
  const version = manifest("core").version;
  assert.ok(changelogVersions().includes(version), `no "## ${version} - " entry`);
});
