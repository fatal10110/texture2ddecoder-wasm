import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readManifests, releaseVersion } from "../check-release.mjs";

// Release invariants of #45, #174 and #175: all four packages version in lockstep, the feature
// packages peer on core's major, the texture package depends on the decoder's major, every reader
// package gates `npm publish` on the root verify, CHANGELOG.md has an entry for the version on
// disk, and the release workflow's version guard refuses a mismatched tag or version.
// RELEASING.md relies on this test to catch a half-bumped release before tag time.

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

// The release workflow's version guard (#175, scripts/check-release.mjs).

const guard = join(root, "scripts/check-release.mjs");
const pkgs = (...versions) => versions.map((version, i) => ({ name: `pkg${i}`, version }));

test("release guard: the repo's four packages pass with the matching tag", () => {
  const version = manifest("core").version;
  assert.deepEqual(
    readManifests(root).map((pkg) => pkg.name),
    [
      "unity-asset-reader-decoder",
      "unity-asset-reader",
      "unity-asset-reader-texture",
      "unity-asset-reader-node",
    ],
  );
  assert.equal(releaseVersion(readManifests(root), `v${version}`), version);
  assert.equal(execFileSync("node", [guard, `v${version}`], { encoding: "utf8" }), `${version}\n`);
});

test("release guard: fails when one package's version differs", () => {
  assert.throws(
    () => releaseVersion(pkgs("1.0.0", "1.0.0", "1.0.1", "1.0.0"), "v1.0.0"),
    /do not share one version: .*pkg2@1\.0\.1/,
  );
  // Without a tag too: a dry run off a branch still catches the drift.
  assert.throws(() => releaseVersion(pkgs("2.0.0", "1.0.0", "1.0.0", "1.0.0")), /one version/);
});

test("release guard: fails when the tag differs from the version", () => {
  assert.equal(releaseVersion(pkgs("1.2.0", "1.2.0"), "v1.2.0"), "1.2.0");
  for (const tag of ["v1.2.1", "1.2.0", "v1.2", "unity-asset-reader@1.2.0", ""]) {
    assert.throws(() => releaseVersion(pkgs("1.2.0", "1.2.0"), tag), /does not match/, tag);
  }
});

test("release guard: the CLI exits 1 on a mismatched tag", () => {
  assert.throws(() => execFileSync("node", [guard, "v0.0.0-nope"], { stdio: "pipe" }), {
    status: 1,
  });
});

test("the release workflow publishes in dependency order", () => {
  const workflow = read(".github/workflows/release.yml");
  const loops = [...workflow.matchAll(/^\s*for pkg in ([\w -]+); do$/gm)];
  assert.equal(loops.length, 1, "one publish loop in release.yml");
  const names = readManifests(root).map((pkg) => pkg.name);
  assert.deepEqual(loops[0]?.[1]?.trim().split(/\s+/), names);
});
