// Release plan (#192): which packages a run of the release workflow publishes. Every package
// versions on its own, and a release is a change of `version` in a package's package.json.
//
//   node scripts/check-release.mjs --base <commit>   push to main, pull_request: the packages
//                                                   whose version differs from <commit>
//   node scripts/check-release.mjs --unpublished     workflow_dispatch: every package
//
// Either way, a `name@version` that is on npm already is dropped. Prints one line,
// `packages=<name@version ...>` in publish order (empty when there is nothing to release), for
// $GITHUB_OUTPUT. Exits 1 when a package to release depends on another package of this repo
// through a range that neither npm nor an earlier package of the same run satisfies, so nothing
// is published ahead of what it needs. The release workflow runs it before anything is built.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The published packages' directories under `packages/`, in publish order: each one only
 * depends on packages before it.
 */
export const PACKAGE_DIRS = ["decoder", "core", "texture", "node"];

/** The dependency fields whose ranges must be on npm before a package is published. */
const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies"];

const VERSION = /^(\d+)\.(\d+)\.(\d+)(-\S+)?$/;

/**
 * Whether a version is in a range, for the range forms this repo uses: `*`, an exact version,
 * and caret ranges (`^1`, `^1.2`, `^1.2.3`) with npm's semantics. A prerelease matches only
 * an exact range.
 * @param {string} version a plain `x.y.z` version, with an optional prerelease suffix
 * @param {string} range the range from a `package.json`
 * @returns {boolean}
 * @throws {Error} on a version or range of another form, so a new form fails loudly instead of
 *   being misread
 */
export function satisfies(version, range) {
  const v = VERSION.exec(version);
  if (!v) throw new Error(`"${version}" is not an x.y.z version`);
  if (VERSION.test(range)) return range === version;
  if (range === "*") return v[4] === undefined;
  const caret = /^\^(\d+)(?:\.(\d+)(?:\.(\d+))?)?$/.exec(range);
  if (!caret) throw new Error(`unsupported range "${range}" (use *, x.y.z or ^x[.y[.z]])`);
  if (v[4] !== undefined) return false;
  const have = [Number(v[1]), Number(v[2]), Number(v[3])];
  const given = caret.filter((part, i) => i > 0 && part !== undefined).length;
  const want = [Number(caret[1]), Number(caret[2] ?? 0), Number(caret[3] ?? 0)];
  // Lower bound: at least `want`.
  const cmp = have.findIndex((part, i) => part !== want[i]);
  if (cmp !== -1 && have[cmp] < want[cmp]) return false;
  // Upper bound: the leftmost non-zero part (or the last one given) stays the same.
  let fixed = want.findIndex((part) => part !== 0);
  if (fixed === -1 || fixed >= given) fixed = given - 1;
  return have.slice(0, fixed + 1).every((part, i) => part === want[i]);
}

/**
 * The packages to release, in publish order, after the dependency check.
 * @param {{ name: string, version: string, dependencies?: Record<string, string>,
 *   peerDependencies?: Record<string, string> }[]} head the manifests being released, in
 *   {@link PACKAGE_DIRS} order
 * @param {({ version: string } | null)[] | undefined} base the same packages' manifests at the
 *   base commit (`null` for a package that did not exist there), or `undefined` to take every
 *   package whose version is not on npm (the manual dispatch)
 * @param {(spec: string) => string[]} view the versions npm has for a `name@range` spec
 * @returns {{ name: string, version: string }[]} empty when nothing is to be released
 * @throws {Error} when a package's range on another package of this repo is satisfied neither
 *   by npm nor by a package released earlier in the same run
 */
export function planRelease(head, base, view) {
  if (base !== undefined && base.length !== head.length) {
    throw new Error(`${base.length} base manifests for ${head.length} packages`);
  }
  const changed = head.filter((pkg, i) => base === undefined || base[i]?.version !== pkg.version);
  const release = changed.filter(
    ({ name, version }) => !view(`${name}@${version}`).includes(version),
  );
  const names = new Set(head.map((pkg) => pkg.name));
  release.forEach((pkg, i) => {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
        if (!names.has(dep)) continue;
        const earlier = release.slice(0, i).find((p) => p.name === dep);
        if (earlier && satisfies(earlier.version, range)) continue;
        if (view(`${dep}@${range}`).length > 0) continue;
        const onNpm = view(`${dep}@*`);
        const inRun = release.find((p) => p.name === dep);
        throw new Error(
          `${pkg.name}@${pkg.version} needs ${dep}@${range} (${field}), but npm has ` +
            `${onNpm.length ? onNpm.join(", ") : "no version of it"}` +
            `${inRun ? ` and this run releases ${inRun.name}@${inRun.version}` : ""}; ` +
            `release a matching ${dep} first (RELEASING.md)`,
        );
      }
    }
  });
  return release.map(({ name, version }) => ({ name, version }));
}

/**
 * The versions npm has for a spec, through `npm view`.
 * @param {string} spec `name@range` or `name@version`
 * @returns {string[]} empty when nothing matches or the name is not on npm
 * @throws {Error} when npm fails for another reason than "no match" (network, registry)
 */
export function npmView(spec) {
  let out;
  try {
    out = execFileSync("npm", ["view", spec, "version", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
  } catch (err) {
    // npm exits 1 with E404 when the name does not exist at all.
    if (/E404/.test(String(err.stdout) + String(err.stderr))) return [];
    throw err;
  }
  // No match prints nothing; one match a JSON string; several a JSON array.
  if (out.trim() === "") return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * Reads the published packages' manifests from the working tree.
 * @param {string} root the repository root
 * @returns {{ name: string, version: string }[]} in {@link PACKAGE_DIRS} order
 */
export function readManifests(root) {
  return PACKAGE_DIRS.map((dir) =>
    JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8")),
  );
}

/**
 * Reads the published packages' manifests as they were at a commit.
 * @param {string} root the repository root (a git checkout that has the commit)
 * @param {string} commit the base commit, for example the push's `github.event.before`
 * @returns {({ name: string, version: string } | null)[]} in {@link PACKAGE_DIRS} order,
 *   `null` for a package that did not exist at the commit
 * @throws {Error} when the commit is all zeros (a newly created branch) or not in the checkout
 */
export function readManifestsAt(root, commit) {
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    if (/^0+$/.test(commit)) throw new Error("no base commit");
    git("cat-file", "-e", `${commit}^{commit}`);
  } catch {
    throw new Error(
      `base commit "${commit}" is not in this checkout; release by hand with the ` +
        `workflow_dispatch run (RELEASING.md)`,
    );
  }
  const files = git("ls-tree", "--name-only", commit, "packages/").split("\n");
  return PACKAGE_DIRS.map((dir) =>
    files.includes(`packages/${dir}`)
      ? JSON.parse(git("show", `${commit}:packages/${dir}/package.json`))
      : null,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(import.meta.dirname, "..");
  const [mode, commit] = process.argv.slice(2);
  try {
    let base;
    if (mode === "--base" && commit) base = readManifestsAt(root, commit);
    else if (mode !== "--unpublished") throw new Error("give --base <commit> or --unpublished");
    const release = planRelease(readManifests(root), base, npmView);
    console.log(`packages=${release.map((p) => `${p.name}@${p.version}`).join(" ")}`);
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
