// Release version guard (#175): `node scripts/check-release.mjs [v<version>]` prints the version the
// four packages share, or exits 1 when they differ from each other or from the tag. The release
// workflow runs it before anything is built, so a half-bumped release never reaches npm.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The published packages' directories under `packages/`, in publish order (dependencies first). */
export const RELEASE_DIRS = ["decoder", "core", "texture", "node"];

/**
 * Checks that every package carries the same version and, when a tag is given, that the tag is
 * `v<that version>`.
 * @param {{ name: string, version: string }[]} manifests the packages' `package.json` contents
 * @param {string} [tag] the pushed git tag, for example `v1.0.0`; omitted for a dry run off a branch
 * @returns {string} the shared version
 * @throws {Error} naming each package whose version differs, or the tag and the version
 */
export function releaseVersion(manifests, tag) {
  const first = manifests[0];
  if (!first) throw new Error("no packages to release");
  const version = first.version;
  const off = manifests.filter((pkg) => pkg.version !== version);
  if (off.length) {
    const list = manifests.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ");
    throw new Error(`packages do not share one version: ${list}`);
  }
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`tag ${tag} does not match the packages' version ${version} (expected v${version})`);
  }
  return version;
}

/**
 * Reads the published packages' manifests from a checkout.
 * @param {string} root the repository root
 * @returns {{ name: string, version: string }[]} in publish order
 */
export function readManifests(root) {
  return RELEASE_DIRS.map((dir) =>
    JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8")),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(import.meta.dirname, "..");
  try {
    console.log(releaseVersion(readManifests(root), process.argv[2] || undefined));
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
