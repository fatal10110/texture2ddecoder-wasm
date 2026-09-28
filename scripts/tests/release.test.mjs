import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkDecoderPublished,
  checkRelease,
  FAMILIES,
  parseTag,
  readManifests,
  releaseVersion,
} from "../check-release.mjs";

// Release invariants of #45, #175 and #182: the reader packages version in lockstep, the decoder
// (`texture2ddecoder-wasm`) on its own line; the feature packages peer on core's major, the
// texture package depends on a decoder range the workspace decoder satisfies; every reader
// package gates `npm publish` on the root verify; CHANGELOG.md has an entry for both versions on
// disk; and the release workflow's version guard refuses a mismatched tag or version, and readers
// whose decoder range is not on npm yet. RELEASING.md relies on this test to catch a half-bumped
// release before tag time.

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

/** `[major, minor, patch]` of a plain `x.y.z` version. */
const parts = (version) => version.split(".").map(Number);

test("reader packages share one version", () => {
  const core = manifest("core");
  assert.equal(core.name, "unity-asset-reader");
  for (const dir of READERS) {
    const pkg = manifest(dir);
    const message = `${pkg.name} is ${pkg.version}, core is ${core.version}`;
    assert.equal(pkg.version, core.version, message);
  }
});

test("the decoder keeps its npm name and its own version line", () => {
  const decoder = manifest("decoder");
  assert.equal(decoder.name, "texture2ddecoder-wasm");
  assert.match(decoder.version, /^1\.\d+\.\d+$/);
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

test("the texture package depends on a decoder range the workspace decoder satisfies", () => {
  const decoder = manifest("decoder");
  const pkg = manifest("texture");
  const range = pkg.dependencies?.["texture2ddecoder-wasm"] ?? "";
  assert.match(range, /^\^\d+\.\d+\.\d+$/, `${pkg.name}: ${range}`);
  assert.equal(pkg.peerDependencies?.["texture2ddecoder-wasm"], undefined, pkg.name);
  // ^a.b.c: same major, and at least a.b.c.
  const [want, have] = [parts(range.slice(1)), parts(decoder.version)];
  const atLeast = have[1] !== want[1] ? have[1] > want[1] : have[2] >= want[2];
  assert.ok(have[0] === want[0] && atLeast, `${range} does not admit ${decoder.version}`);
  // Resolved from the workspace, not from npm.
  const lock = JSON.parse(read("package-lock.json"));
  assert.deepEqual(lock.packages["node_modules/texture2ddecoder-wasm"], {
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

test("CHANGELOG.md has an entry for the reader version", () => {
  const version = manifest("core").version;
  assert.ok(changelogVersions("Reader packages").includes(version), `no "### ${version} - " entry`);
});

test("CHANGELOG.md has an entry for the texture2ddecoder-wasm version", () => {
  const version = manifest("decoder").version;
  const versions = changelogVersions("texture2ddecoder-wasm");
  assert.ok(versions.includes(version), `no "### ${version} - " entry`);
});

// The release workflow's version guard (#175, #182, scripts/check-release.mjs).

const guard = join(root, "scripts/check-release.mjs");
const pkgs = (...versions) => versions.map((version, i) => ({ name: `pkg${i}`, version }));
/** An npm registry that has these decoder versions, for `npm view <name>@^x.y.z`. */
const registry = (...versions) => (spec) => {
  const range = spec.slice(spec.lastIndexOf("@") + 1);
  assert.match(range, /^\^\d+\.\d+\.\d+$/, spec);
  const want = parts(range.slice(1));
  return versions.filter((v) => {
    const have = parts(v);
    if (have[0] !== want[0]) return false;
    return have[1] !== want[1] ? have[1] > want[1] : have[2] >= want[2];
  });
};

/** A throwaway checkout: packages/<dir>/package.json for each given manifest. */
function checkout(manifests) {
  const dir = mkdtempSync(join(tmpdir(), "release-guard-"));
  for (const [pkgDir, contents] of Object.entries(manifests)) {
    mkdirSync(join(dir, "packages", pkgDir), { recursive: true });
    writeFileSync(join(dir, "packages", pkgDir, "package.json"), JSON.stringify(contents));
  }
  return dir;
}

const readers = (core, texture, node, decoderRange = "^1.2.3") => ({
  core: { name: "unity-asset-reader", version: core },
  texture: {
    name: "unity-asset-reader-texture",
    version: texture,
    dependencies: { "texture2ddecoder-wasm": decoderRange },
  },
  node: { name: "unity-asset-reader-node", version: node },
});

test("release guard: publish order is dependencies first", () => {
  assert.deepEqual(
    readManifests(root, "unity-asset-reader").map((pkg) => pkg.name),
    ["unity-asset-reader", "unity-asset-reader-texture", "unity-asset-reader-node"],
  );
  assert.deepEqual(
    readManifests(root, "texture2ddecoder-wasm").map((pkg) => pkg.name),
    ["texture2ddecoder-wasm"],
  );
  // Every family's directories, together, are every published package, each once.
  assert.deepEqual(Object.values(FAMILIES).flat().sort(), ["core", "decoder", "node", "texture"]);
});

test("release guard: tags name the family and the version", () => {
  assert.deepEqual(parseTag("unity-asset-reader@1.0.0"), {
    family: "unity-asset-reader",
    version: "1.0.0",
  });
  assert.deepEqual(parseTag("texture2ddecoder-wasm@1.2.3"), {
    family: "texture2ddecoder-wasm",
    version: "1.2.3",
  });
  // The decoder's old tags (v1.0.1 ... v1.2.2) and the other packages' names are not release tags.
  for (const tag of [
    "v1.0.0",
    "1.0.0",
    "unity-asset-reader-texture@1.0.0",
    "unity-asset-reader@",
    "unity-asset-reader@v1.0.0",
    "@1.0.0",
    "",
  ]) {
    assert.throws(() => parseTag(tag), /not a release tag/, tag);
  }
});

test("release guard: the repo's decoder passes with its matching tag", () => {
  const version = manifest("decoder").version;
  const tag = `texture2ddecoder-wasm@${version}`;
  assert.deepEqual(checkRelease(root, { tag }), {
    family: "texture2ddecoder-wasm",
    version,
    packages: ["texture2ddecoder-wasm"],
  });
  // The CLI prints the lines the workflow appends to $GITHUB_OUTPUT.
  assert.equal(
    execFileSync("node", [guard, tag], { encoding: "utf8" }),
    `family=texture2ddecoder-wasm\nversion=${version}\npackages=texture2ddecoder-wasm\n`,
  );
});

test("release guard: the repo's readers pass with their matching tag once the decoder is on npm", () => {
  const version = manifest("core").version;
  const decoder = manifest("decoder").version;
  assert.deepEqual(
    checkRelease(root, { tag: `unity-asset-reader@${version}` }, registry("1.2.2", decoder)),
    {
      family: "unity-asset-reader",
      version,
      packages: ["unity-asset-reader", "unity-asset-reader-texture", "unity-asset-reader-node"],
    },
  );
});

test("release guard: a matching readers tag passes", () => {
  const dir = checkout(readers("1.0.0", "1.0.0", "1.0.0"));
  const tag = "unity-asset-reader@1.0.0";
  assert.equal(checkRelease(dir, { tag }, registry("1.2.2", "1.2.3")).version, "1.0.0");
  // A dry run off a branch: the family instead of a tag.
  const family = "unity-asset-reader";
  assert.equal(checkRelease(dir, { family }, registry("1.2.3")).version, "1.0.0");
});

test("release guard: a readers tag with an unsatisfiable decoder range fails", () => {
  const dir = checkout(readers("1.0.0", "1.0.0", "1.0.0"));
  const tag = "unity-asset-reader@1.0.0";
  assert.throws(
    () => checkRelease(dir, { tag }, registry("1.2.0", "1.2.1", "1.2.2")),
    /needs texture2ddecoder-wasm@\^1\.2\.3, which is not on npm yet/,
  );
  // A dry run fails the same way: the real run would.
  assert.throws(
    () => checkRelease(dir, { family: "unity-asset-reader" }, registry()),
    /not on npm yet/,
  );
  assert.throws(
    () => checkDecoderPublished({ name: "unity-asset-reader-texture" }, registry("1.2.3")),
    /no dependency on texture2ddecoder-wasm/,
  );
});

test("release guard: a reader package with a different version fails", () => {
  const dir = checkout(readers("1.0.0", "1.0.1", "1.0.0"));
  assert.throws(
    () => checkRelease(dir, { tag: "unity-asset-reader@1.0.0" }, registry("1.2.3")),
    /do not share one version: .*unity-asset-reader-texture@1\.0\.1/,
  );
  // Without a tag too: a dry run off a branch still catches the drift.
  assert.throws(
    () => checkRelease(dir, { family: "unity-asset-reader" }, registry("1.2.3")),
    /one version/,
  );
  assert.throws(() => releaseVersion(pkgs("2.0.0", "1.0.0", "1.0.0")), /one version/);
});

test("release guard: a tag whose version differs from the packages' fails", () => {
  const dir = checkout({
    ...readers("1.0.0", "1.0.0", "1.0.0"),
    decoder: { name: "texture2ddecoder-wasm", version: "1.2.3" },
  });
  // The decoder's own line: its tag carries its version, not the readers'.
  assert.equal(checkRelease(dir, { tag: "texture2ddecoder-wasm@1.2.3" }).version, "1.2.3");
  for (const tag of ["texture2ddecoder-wasm@1.0.0", "texture2ddecoder-wasm@1.2.4"]) {
    assert.throws(() => checkRelease(dir, { tag }), /does not match/, tag);
  }
  for (const tag of ["unity-asset-reader@1.2.3", "unity-asset-reader@1.0.1"]) {
    assert.throws(() => checkRelease(dir, { tag }, registry("1.2.3")), /does not match/, tag);
  }
});

test("release guard: a dispatch family must agree with the tag", () => {
  const dir = checkout({ decoder: { name: "texture2ddecoder-wasm", version: "1.2.3" } });
  const tag = "texture2ddecoder-wasm@1.2.3";
  assert.equal(checkRelease(dir, { tag, family: "texture2ddecoder-wasm" }).version, "1.2.3");
  assert.throws(
    () => checkRelease(dir, { tag, family: "unity-asset-reader" }),
    /releases texture2ddecoder-wasm, not unity-asset-reader/,
  );
  assert.throws(() => checkRelease(dir, { family: "decoder" }), /unknown release family/);
  assert.throws(() => checkRelease(dir, {}), /release tag or --family/);
});

test("release guard: the CLI exits 1 on a mismatched tag", () => {
  for (const tag of ["texture2ddecoder-wasm@0.0.0", "v1.0.0"]) {
    assert.throws(() => execFileSync("node", [guard, tag], { stdio: "pipe" }), { status: 1 }, tag);
  }
});

test("the release workflow publishes the guard's packages, in its order", () => {
  const workflow = read(".github/workflows/release.yml");
  const loops = [...workflow.matchAll(/^\s*for pkg in (.+); do$/gm)];
  assert.equal(loops.length, 1, "one publish loop in release.yml");
  assert.equal(loops[0]?.[1], "$PACKAGES");
  assert.match(workflow, /^\s*PACKAGES: \$\{\{ steps\.guard\.outputs\.packages \}\}$/m);
});

test("the release workflow runs on both tag families", () => {
  const workflow = read(".github/workflows/release.yml");
  const tags = workflow.match(/^\s*tags: (.+)$/m)?.[1];
  const families = Object.keys(FAMILIES).map((f) => `${f}@*.*.*`);
  assert.deepEqual(JSON.parse(tags ?? "null"), families);
  // The dispatch input offers the same families.
  const options = workflow.match(/^\s*options: (.+)$/m)?.[1];
  assert.deepEqual(JSON.parse(options ?? "null"), Object.keys(FAMILIES));
});

// npm's trusted publisher does not check the ref, only repo, workflow file and environment. The
// `npm` environment (the release tags only) is what keeps a branch's edited copy of release.yml
// from publishing, so every run that is not a dry run must be in it (RELEASING.md, One-time setup).
test("the release workflow publishes only from the npm environment", () => {
  const workflow = read(".github/workflows/release.yml");
  const dryRun = "github.event_name == 'workflow_dispatch' && inputs.dry_run";
  const environments = [...workflow.matchAll(/^\s*environment:\s*(.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(environments, [`\${{ !(${dryRun}) && 'npm' || '' }}`]);
  // The same condition decides `--dry-run`, so no run publishes outside the environment.
  const dryRunEnv = [...workflow.matchAll(/^\s*DRY_RUN:\s*(.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(dryRunEnv, [`\${{ ${dryRun} }}`]);
});
