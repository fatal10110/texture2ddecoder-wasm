import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  PACKAGE_DIRS,
  planRelease,
  readManifests,
  readManifestsAt,
  satisfies,
} from "../check-release.mjs";

// Release invariants of #45 and #192: every package versions on its own and is published when
// its `version` changes. The feature packages peer on core's major, the texture package depends
// on a decoder range the workspace decoder satisfies, every reader package gates `npm publish`
// on the root verify, and CHANGELOG.md has a dated entry for each package's version on disk. The
// release plan (scripts/check-release.mjs) picks the packages whose version changed and is not
// on npm, and refuses one whose range on another package of this repo nothing satisfies yet.

const root = join(import.meta.dirname, "../..");
const read = (path) => readFileSync(join(root, path), "utf8");
const manifest = (dir) => JSON.parse(read(`packages/${dir}/package.json`));

const READERS = ["core", "texture", "node"];
const FEATURES = ["texture", "node"];

/** `### <version> - <date>` headings under the `## <section>` heading of CHANGELOG.md. */
function changelogHeadings(section) {
  const text = read("CHANGELOG.md");
  const start = text.indexOf(`\n## ${section}\n`);
  assert.notEqual(start, -1, `CHANGELOG.md has no "## ${section}" section`);
  const next = text.indexOf("\n## ", start + 1);
  const body = text.slice(start, next === -1 ? undefined : next);
  return new Map([...body.matchAll(/^### (\d+\.\d+\.\d+\S*) - (.*)$/gm)].map((m) => [m[1], m[2]]));
}

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
  assert.ok(satisfies(decoder.version, range), `${range} does not admit ${decoder.version}`);
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

test("CHANGELOG.md has a dated entry for each package's version", () => {
  for (const dir of PACKAGE_DIRS) {
    const { name, version } = manifest(dir);
    const date = changelogHeadings(name).get(version);
    assert.ok(date !== undefined, `## ${name}: no "### ${version} - "`);
    // The version on disk is published on merge, so its entry is not "Unreleased" (RELEASING.md).
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/, `## ${name}: "### ${version} - ${date}"`);
  }
});

// The release plan (#192, scripts/check-release.mjs).

/** The four packages as this repo has them, at the given versions, in publish order. */
function repo({ decoder = "1.2.3", core = "1.0.0", texture = "1.0.0", node = "1.0.0" } = {}) {
  return [
    { name: "texture2ddecoder-wasm", version: decoder },
    { name: "unity-asset-reader", version: core },
    {
      name: "unity-asset-reader-texture",
      version: texture,
      dependencies: { "texture2ddecoder-wasm": "^1.2.3", fflate: "^0.8.0" },
      peerDependencies: { "unity-asset-reader": "^1" },
      devDependencies: { "unity-asset-reader": "*" },
    },
    {
      name: "unity-asset-reader-node",
      version: node,
      peerDependencies: { "unity-asset-reader": "^1" },
      devDependencies: { "unity-asset-reader": "*" },
    },
  ];
}

/** An npm registry with these `name@version`s, answering `npm view <name>@<range|version>`. */
function registry(...specs) {
  const calls = [];
  const view = (spec) => {
    calls.push(spec);
    const at = spec.lastIndexOf("@");
    const [name, range] = [spec.slice(0, at), spec.slice(at + 1)];
    return specs
      .filter((s) => s.slice(0, s.lastIndexOf("@")) === name)
      .map((s) => s.slice(s.lastIndexOf("@") + 1))
      .filter((version) => satisfies(version, range));
  };
  return Object.assign(view, { calls });
}

/** npm after the first release: decoder 1.2.3 and every reader at 1.0.0. */
const RELEASED = [
  "texture2ddecoder-wasm@1.2.2",
  "texture2ddecoder-wasm@1.2.3",
  "unity-asset-reader@1.0.0",
  "unity-asset-reader-texture@1.0.0",
  "unity-asset-reader-node@1.0.0",
];

const specs = (release) => release.map((p) => `${p.name}@${p.version}`);

test("release plan: a single bump publishes that package only", () => {
  const plan = planRelease(repo({ texture: "1.0.1" }), repo(), registry(...RELEASED));
  assert.deepEqual(specs(plan), ["unity-asset-reader-texture@1.0.1"]);
});

test("release plan: two bumps in one push publish both, dependencies first", () => {
  const head = repo({ core: "1.1.0", decoder: "1.2.4" });
  const plan = planRelease(head, repo(), registry(...RELEASED));
  assert.deepEqual(specs(plan), ["texture2ddecoder-wasm@1.2.4", "unity-asset-reader@1.1.0"]);
});

test("release plan: no bump publishes nothing and asks npm nothing", () => {
  const view = registry(...RELEASED);
  assert.deepEqual(planRelease(repo(), repo(), view), []);
  assert.deepEqual(view.calls, []);
  // A package.json change that is not a version change (a new dependency, say) is no bump.
  const head = repo();
  head[3] = { ...head[3], dependencies: { fflate: "^0.8.0" } };
  assert.deepEqual(planRelease(head, repo(), view), []);
});

test("release plan: a version already on npm is not published again", () => {
  const onNpm = [...RELEASED, "unity-asset-reader-node@1.0.1"];
  const plan = planRelease(repo({ node: "1.0.1", core: "1.0.1" }), repo(), registry(...onNpm));
  assert.deepEqual(specs(plan), ["unity-asset-reader@1.0.1"]);
});

test("release plan: a bump whose range on another package is not on npm fails", () => {
  const head = repo({ texture: "1.1.0" });
  head[2] = { ...head[2], dependencies: { "texture2ddecoder-wasm": "^1.3.0" } };
  assert.throws(
    () => planRelease(head, repo(), registry(...RELEASED)),
    new RegExp(
      "^Error: unity-asset-reader-texture@1\\.1\\.0 needs texture2ddecoder-wasm@\\^1\\.3\\.0 " +
        "\\(dependencies\\), but npm has 1\\.2\\.2, 1\\.2\\.3; release a matching " +
        "texture2ddecoder-wasm first",
    ),
  );
  // A peer range counts too: core 2.x is not on npm and not in this run.
  const peer = repo({ node: "2.0.0" });
  peer[3] = { ...peer[3], peerDependencies: { "unity-asset-reader": "^2" } };
  assert.throws(
    () => planRelease(peer, repo(), registry(...RELEASED)),
    /unity-asset-reader-node@2\.0\.0 needs unity-asset-reader@\^2 \(peerDependencies\)/,
  );
  // Nothing of the name on npm at all.
  assert.throws(
    () => planRelease(repo({ texture: "1.0.1" }), repo(), registry()),
    /needs texture2ddecoder-wasm@\^1\.2\.3 \(dependencies\), but npm has no version of it/,
  );
});

test("release plan: a range satisfied by an earlier package of the same run passes", () => {
  const head = repo({ decoder: "1.3.0", texture: "1.1.0" });
  head[2] = { ...head[2], dependencies: { "texture2ddecoder-wasm": "^1.3.0" } };
  const plan = planRelease(head, repo(), registry(...RELEASED));
  assert.deepEqual(specs(plan), [
    "texture2ddecoder-wasm@1.3.0",
    "unity-asset-reader-texture@1.1.0",
  ]);
  // The same, but the run's decoder does not satisfy the range: it fails and says so.
  head[0] = { ...head[0], version: "1.2.4" };
  assert.throws(
    () => planRelease(head, repo(), registry(...RELEASED)),
    /and this run releases texture2ddecoder-wasm@1\.2\.4; release a matching/,
  );
});

test("release plan: a dispatch takes every package whose version is not on npm", () => {
  // The first release: only the decoder's older versions are on npm.
  const first = registry("texture2ddecoder-wasm@1.2.1", "texture2ddecoder-wasm@1.2.2");
  assert.deepEqual(specs(planRelease(repo(), undefined, first)), [
    "texture2ddecoder-wasm@1.2.3",
    "unity-asset-reader@1.0.0",
    "unity-asset-reader-texture@1.0.0",
    "unity-asset-reader-node@1.0.0",
  ]);
  // Recovery: a push published the decoder and core, then failed.
  const half = registry(...RELEASED.slice(0, 3));
  assert.deepEqual(specs(planRelease(repo(), undefined, half)), [
    "unity-asset-reader-texture@1.0.0",
    "unity-asset-reader-node@1.0.0",
  ]);
  // Everything is out: nothing to do.
  assert.deepEqual(planRelease(repo(), undefined, registry(...RELEASED)), []);
});

test("release plan: a package new since the base commit is a candidate", () => {
  const base = [...repo().slice(0, 3), null];
  const plan = planRelease(repo(), base, registry(...RELEASED.slice(0, 4)));
  assert.deepEqual(specs(plan), ["unity-asset-reader-node@1.0.0"]);
});

test("release plan: ranges follow npm's caret rules", () => {
  const cases = [
    ["1.2.3", "^1.2.3", true],
    ["1.9.0", "^1.2.3", true],
    ["1.2.2", "^1.2.3", false],
    ["2.0.0", "^1.2.3", false],
    ["1.0.0", "^1", true],
    ["0.9.0", "^1", false],
    ["0.2.9", "^0.2.3", true],
    ["0.3.0", "^0.2.3", false],
    ["0.0.3", "^0.0.3", true],
    ["0.0.4", "^0.0.3", false],
    ["1.3.0-beta.1", "^1.2.3", false],
    ["1.3.0-beta.1", "1.3.0-beta.1", true],
    ["1.0.0", "1.0.1", false],
    ["5.0.0", "*", true],
  ];
  for (const [version, range, want] of cases) {
    assert.equal(satisfies(version, range), want, `${version} in ${range}`);
  }
  // A range form the plan does not know fails loudly instead of being misread.
  for (const range of [">=1.0.0", "~1.2.3", "1.x", "workspace:*"]) {
    assert.throws(() => satisfies("1.2.3", range), /unsupported range/, range);
  }
});

test("release plan: publish order puts every package after what it depends on", () => {
  const manifests = readManifests(root);
  assert.deepEqual(
    manifests.map((pkg) => pkg.name),
    [
      "texture2ddecoder-wasm",
      "unity-asset-reader",
      "unity-asset-reader-texture",
      "unity-asset-reader-node",
    ],
  );
  const names = manifests.map((pkg) => pkg.name);
  manifests.forEach((pkg, i) => {
    for (const deps of [pkg.dependencies, pkg.peerDependencies]) {
      for (const dep of Object.keys(deps ?? {})) {
        if (names.includes(dep)) assert.ok(names.indexOf(dep) < i, `${pkg.name} before ${dep}`);
      }
    }
  });
});

// The base-commit side, against a throwaway git repository.

const guard = join(root, "scripts/check-release.mjs");

/** A git repo whose packages/<dir>/package.json are the given manifests, one commit per state. */
function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "release-plan-"));
  const config = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...config, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  const commit = (manifests) => {
    manifests.forEach((pkg, i) => {
      if (!pkg) return;
      mkdirSync(join(dir, "packages", PACKAGE_DIRS[i] ?? ""), { recursive: true });
      const file = join(dir, "packages", PACKAGE_DIRS[i] ?? "", "package.json");
      writeFileSync(file, JSON.stringify(pkg));
    });
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "state");
    return git("rev-parse", "HEAD");
  };
  return { dir, commit };
}

test("release plan: base manifests come from the base commit", () => {
  const { dir, commit } = gitRepo();
  const first = commit([...repo().slice(0, 3), null]);
  const second = commit(repo({ texture: "1.0.1" }));
  const base = readManifestsAt(dir, first);
  assert.deepEqual(base.map((pkg) => pkg?.version ?? null), ["1.2.3", "1.0.0", "1.0.0", null]);
  const head = readManifestsAt(dir, second).map((pkg) => pkg ?? assert.fail("missing"));
  assert.deepEqual(specs(planRelease(head, base, registry(...RELEASED))), [
    "unity-asset-reader-texture@1.0.1",
  ]);
  // A newly created branch has an all-zero `before`; a force-pushed-away one is not fetched.
  for (const sha of ["0".repeat(40), "f".repeat(40)]) {
    assert.throws(() => readManifestsAt(dir, sha), /is not in this checkout; release by hand/);
  }
});

// The CLI's whole output: `packages=` then zero or more space-separated `name@x.y.z` specs.
const packagesLine = /^packages=(\S+@\d+\.\d+\.\d+\S*( \S+@\d+\.\d+\.\d+\S*)*)?\n$/;

test("release plan: the packages-line pattern takes empty and non-empty lists only", () => {
  for (const line of [
    "packages=\n",
    "packages=unity-asset-reader@1.0.2\n",
    "packages=unity-asset-reader@1.0.2 unity-asset-reader-node@1.0.2 x@2.0.0-rc.1\n",
  ]) {
    assert.match(line, packagesLine);
  }
  for (const line of [
    "packages=unity-asset-reader@1.0.2",
    "packages=unity-asset-reader@1.0.2 \n",
    "packages= unity-asset-reader@1.0.2\n",
    "packages=unity-asset-reader\n",
    "packages=unity-asset-reader@1.0\n",
    "packages=a@1.0.0\nb@1.0.0\n",
    "released=unity-asset-reader@1.0.2\n",
  ]) {
    assert.doesNotMatch(line, packagesLine);
  }
});

test("release plan: the CLI prints the packages line, and exits 1 on a bad base", () => {
  // This repo against its own HEAD: the committed versions are the ones on disk unless the
  // working tree bumps one, so only the shape is checked (no bump asks npm nothing).
  const out = execFileSync("node", [guard, "--base", "HEAD"], { encoding: "utf8" });
  assert.match(out, packagesLine);
  for (const args of [["--base", "0".repeat(40)], ["--base"], []]) {
    assert.throws(() => execFileSync("node", [guard, ...args], { stdio: "pipe" }), { status: 1 });
  }
});

// The release workflow (#192, .github/workflows/release.yml).

const workflow = read(".github/workflows/release.yml");
const gate = read(".github/actions/release-gate/action.yml");

/** The text of one top-level job of release.yml. */
function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `release.yml has no job ${name}`);
  const rest = workflow.slice(start + 1);
  // Up to the next job, or the comment above it.
  const next = rest.slice(1).search(/\n {2}(?:#|[\w-]+:\n)/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test("the release workflow runs on a package.json change, not on docs or tags", () => {
  const on = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
  const paths = ' {4}paths: \\["packages/\\*/package\\.json"\\]\\n';
  assert.match(on, new RegExp(`\\n {2}push:\\n {4}branches: \\[main\\]\\n${paths}`));
  assert.match(on, new RegExp(`\\n {2}pull_request:\\n${paths}`));
  assert.match(on, /\n {2}workflow_dispatch:\n/);
  assert.match(on, /\n {6}dry_run:\n(.*\n)*? {8}default: true\n/);
  assert.doesNotMatch(on, /tags/);
  // Workflow-wide the token can only read.
  assert.match(workflow, /\npermissions:\n {2}contents: read\n\n/);
});

test("the release plan's base is the push's before or the pull request's base", () => {
  assert.match(gate, /BEFORE: \$\{\{ github\.event\.before \}\}/);
  assert.match(gate, /PR_BASE: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(gate, /push\) args=\(--base "\$BEFORE"\) ;;/);
  assert.match(gate, /pull_request\) args=\(--base "\$PR_BASE"\) ;;/);
  assert.match(gate, /\*\) args=\(--unpublished\) ;;/);
  // Both jobs plan and gate through the same action, with the base commit in the checkout.
  for (const name of ["dry-run", "publish"]) {
    assert.match(job(name), /uses: \.\/\.github\/actions\/release-gate\n/, name);
    assert.match(job(name), /fetch-depth: 0\n/, name);
  }
  // Every gate step is skipped when there is nothing to release.
  const gated = "if: steps\\.plan\\.outputs\\.packages != ''\\n.*\\n.*run: ";
  const steps = ["npm ci", "npm run build:wasm", "npm run verify"];
  for (const step of [...steps, "npm test -w texture2ddecoder-wasm"]) {
    assert.match(gate, new RegExp(`${gated}${step}\\n`), step);
  }
});

// npm's trusted publisher does not check the ref, only repo, workflow file and environment. The
// `npm` environment (branch main only) is what keeps a branch's edited copy of release.yml from
// publishing, so the only job that publishes for real is in it, and nothing else is.
test("only the publish job publishes, in the npm environment, with an OIDC token", () => {
  const dispatch = "github.event_name == 'workflow_dispatch'";
  const real = `github.event_name == 'push' || (${dispatch} && !inputs.dry_run)`;
  const dry = `github.event_name == 'pull_request' || (${dispatch} && inputs.dry_run)`;
  assert.match(job("publish"), new RegExp(`\\n {4}if: ${escape(real)}\\n`));
  assert.match(job("dry-run"), new RegExp(`\\n {4}if: ${escape(dry)}\\n`));
  const environments = [...workflow.matchAll(/^\s*environment:\s*(.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(environments, ["npm"]);
  assert.match(job("publish"), /\n {4}environment: npm\n/);
  assert.match(job("publish"), /\n {4}permissions:\n {6}contents: read\n {6}id-token: write\n/);
  // No id-token and no environment for pull requests and dry runs.
  assert.doesNotMatch(job("dry-run"), /id-token|environment|secrets\./);
  // Publishing: once for real (publish), once with --dry-run (dry-run), from the plan.
  const publishes = [...workflow.matchAll(/^ +(npm publish .*)$/gm)].map((m) => m[1]);
  assert.deepEqual(publishes, [
    'npm publish -w "${spec%@*}" --access public --dry-run',
    'npm publish -w "${spec%@*}" --access public',
  ]);
  const loops = [...workflow.matchAll(/^\s*for spec in (.+); do$/gm)].map((m) => m[1]);
  assert.deepEqual(loops, ["$PACKAGES", "$PACKAGES", "$PUBLISHED"]);
  assert.equal(workflow.match(/PACKAGES: \$\{\{ steps\.gate\.outputs\.packages \}\}/g)?.length, 2);
});

// The first publish authenticates with the repository secret NPM_TOKEN (#194). A repository
// secret is readable by any job, so only the publish job names it, and ~/.npmrc gets a reference
// to the variable, never the value.
test("only the publish job reads NPM_TOKEN, and only as a reference in .npmrc", () => {
  assert.deepEqual([...workflow.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]), ["NPM_TOKEN"]);
  assert.doesNotMatch(gate, /secrets\./);
  assert.match(job("publish"), /\n {10}NPM_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}\n/);
  const npmrc = 'echo "//registry.npmjs.org/:_authToken=\\${NPM_TOKEN}" > "$HOME/.npmrc"';
  const ifSet = 'if [ -n "$NPM_TOKEN" ]; then';
  const written = `\\n {10}${escape(ifSet)}\\n.*::warning::.*\\n {12}${escape(npmrc)}\\n {10}fi\\n`;
  assert.match(job("publish"), new RegExp(written));
});

test("the tag job alone can write, and tags what the publish job published", () => {
  const tag = job("tag");
  assert.match(tag, /\n {4}needs: publish\n/);
  assert.match(tag, /\n {4}if: always\(\) && needs\.publish\.outputs\.published != ''\n/);
  assert.match(tag, /\n {4}permissions:\n {6}contents: write\n {4}steps:/);
  assert.equal(workflow.match(/contents: write/g)?.length, 1);
  assert.match(tag, /PUBLISHED: \$\{\{ needs\.publish\.outputs\.published \}\}/);
  assert.match(tag, /git tag -a "\$spec" -m "\$spec" "\$GITHUB_SHA"/);
  // An existing tag is skipped, not failed.
  assert.match(tag, /exists already, skipping/);
  assert.match(job("publish"), /published: \$\{\{ steps\.publish\.outputs\.published \}\}/);
  const trap = `trap 'echo "published=\${published[*]}" >> "$GITHUB_OUTPUT"' EXIT`;
  assert.ok(job("publish").includes(trap), "the publish step writes its output on any exit");
});

test("release runs queue instead of cancelling each other", () => {
  const concurrency = [
    "concurrency:",
    "  group: release-${{ github.ref }}",
    "  cancel-in-progress: false",
    "  queue: max",
  ];
  assert.ok(workflow.includes(`\n${concurrency.join("\n")}\n`), concurrency.join(" / "));
});

/** A string as a literal regular expression. */
function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
