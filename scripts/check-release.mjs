// Release version guard (#175, #182). Two release lines, each with its own tag family:
//
//   unity-asset-reader@<v>      the three reader packages, in lockstep
//   texture2ddecoder-wasm@<v>   the decoder, on its own version line
//
//   node scripts/check-release.mjs <tag> [--family <name>]
//   node scripts/check-release.mjs --family <name>          (dry run off a branch)
//
// Prints `family=`, `version=` and `packages=` lines (for $GITHUB_OUTPUT), or exits 1 when the
// tag, the family and the versions on disk disagree. For the readers it also fails when the
// texture package's `texture2ddecoder-wasm` range has no version on npm yet, so the readers are
// never published ahead of the decoder they need. The release workflow runs it before anything
// is built.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The decoder's npm name. */
export const DECODER = "texture2ddecoder-wasm";

/**
 * The release families: tag prefix -> package directories under `packages/`, in publish order
 * (dependencies first).
 */
export const FAMILIES = {
  "unity-asset-reader": ["core", "texture", "node"],
  [DECODER]: ["decoder"],
};

/**
 * Splits a release tag into its family and version.
 * @param {string} tag the pushed git tag, for example `unity-asset-reader@1.0.0`
 * @returns {{ family: string, version: string }}
 * @throws {Error} when the tag is not `<family>@<version>` of a known family
 */
export function parseTag(tag) {
  const at = tag.lastIndexOf("@");
  const family = tag.slice(0, at);
  const version = tag.slice(at + 1);
  if (at <= 0 || !Object.hasOwn(FAMILIES, family) || !/^\d+\.\d+\.\d+\S*$/.test(version)) {
    const known = Object.keys(FAMILIES).map((f) => `${f}@<version>`).join(" or ");
    throw new Error(`tag "${tag}" is not a release tag (expected ${known})`);
  }
  return { family, version };
}

/**
 * Checks that every package of a family carries the same version and, when a tag version is
 * given, that it is that version.
 * @param {{ name: string, version: string }[]} manifests the family's `package.json` contents
 * @param {string} [tagVersion] the version from the pushed tag; omitted for a dry run off a branch
 * @returns {string} the shared version
 * @throws {Error} naming each package's version when they differ, or the tag and the version
 */
export function releaseVersion(manifests, tagVersion) {
  const first = manifests[0];
  if (!first) throw new Error("no packages to release");
  const version = first.version;
  if (manifests.some((pkg) => pkg.version !== version)) {
    const list = manifests.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ");
    throw new Error(`packages do not share one version: ${list}`);
  }
  if (tagVersion !== undefined && tagVersion !== version) {
    throw new Error(`tag version ${tagVersion} does not match the packages' version ${version}`);
  }
  return version;
}

/**
 * Checks that the texture package's decoder range is satisfied by a version already on npm.
 * @param {{ name: string, dependencies?: Record<string, string> }} texture its `package.json`
 * @param {(spec: string) => string[]} view the versions npm has for a `name@range` spec
 * @throws {Error} when the range is missing or nothing on npm satisfies it
 */
export function checkDecoderPublished(texture, view) {
  const range = texture.dependencies?.[DECODER];
  if (!range) throw new Error(`${texture.name} has no dependency on ${DECODER}`);
  if (view(`${DECODER}@${range}`).length === 0) {
    throw new Error(
      `${texture.name} needs ${DECODER}@${range}, which is not on npm yet; ` +
        `release ${DECODER} first (RELEASING.md)`,
    );
  }
}

/**
 * The versions npm has for a spec, through `npm view`.
 * @param {string} spec `name@range`
 * @returns {string[]} empty when nothing matches
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
 * Reads a family's manifests from a checkout.
 * @param {string} root the repository root
 * @param {string} family a key of {@link FAMILIES}
 * @returns {{ name: string, version: string, dependencies?: Record<string, string> }[]} in
 *   publish order
 */
export function readManifests(root, family) {
  return FAMILIES[family].map((dir) =>
    JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8")),
  );
}

/**
 * The whole guard: which family a tag (or, off a branch, the `family` option) releases, at which
 * version, and which packages.
 * @param {string} root the repository root
 * @param {{ tag?: string, family?: string }} ref the pushed tag, the family chosen for a dry run,
 *   or both (a dispatch on a tag), which must then agree
 * @param {(spec: string) => string[]} [view] npm lookup, {@link npmView} by default
 * @returns {{ family: string, version: string, packages: string[] }}
 * @throws {Error} on an unknown or disagreeing family, a version mismatch, or a decoder range
 *   that npm cannot satisfy yet
 */
export function checkRelease(root, { tag, family }, view = npmView) {
  const parsed = tag === undefined ? undefined : parseTag(tag);
  if (family !== undefined && !Object.hasOwn(FAMILIES, family)) {
    throw new Error(`unknown release family "${family}" (${Object.keys(FAMILIES).join(", ")})`);
  }
  if (parsed && family !== undefined && parsed.family !== family) {
    throw new Error(`tag ${tag} releases ${parsed.family}, not ${family}`);
  }
  const chosen = parsed?.family ?? family;
  if (chosen === undefined) throw new Error("give a release tag or --family <name>");
  const manifests = readManifests(root, chosen);
  const version = releaseVersion(manifests, parsed?.version);
  if (chosen !== DECODER) {
    const texture = manifests.find((pkg) => pkg.name === "unity-asset-reader-texture");
    if (!texture) throw new Error(`${chosen} has no unity-asset-reader-texture`);
    checkDecoderPublished(texture, view);
  }
  return { family: chosen, version, packages: manifests.map((pkg) => pkg.name) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(import.meta.dirname, "..");
  const args = process.argv.slice(2);
  const flag = args.indexOf("--family");
  const family = flag === -1 ? undefined : args.splice(flag, 2)[1];
  const tag = args[0] || undefined;
  try {
    const release = checkRelease(root, { tag, family: family || undefined });
    const { version, packages } = release;
    console.log(`family=${release.family}\nversion=${version}\npackages=${packages.join(" ")}`);
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
