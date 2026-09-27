// Ported from AssetStudio/ImportHelper.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/AssetsManager.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/ResourceReader.cs (MIT, © Perfare / RazTools / Razviar)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CorruptError, load, type Env, type LoadInput } from "unity-asset-reader";

/**
 * One part of a file Unity split for size (`<name>.split0`, `.split1`, ...):
 * the name it merges to and the part number. Unity numbers from 0 without
 * leading zeros, so `.split01` is not a part, just a file with an odd name.
 */
const SPLIT_PART = /^(.+)\.split(0|[1-9]\d*)$/;

/**
 * Load a Unity file, or every file below a directory, from disk and unpack it
 * with `load()` from `unity-asset-reader`.
 *
 * **A directory** is scanned recursively and every regular file in it is
 * loaded, whatever its name, as upstream's `LoadFolder` does. A symbolic link
 * to a file is read; a link to a directory is not followed, so a link cycle
 * cannot hang the scan. Sockets, FIFOs and devices are not files and are left
 * out.
 *
 * **A file** is loaded together with its sidecars from the same directory:
 * `<name>.resS` and `<stem>.resource` (`sharedassets0.assets` takes
 * `sharedassets0.assets.resS` and `sharedassets0.resource`), matched ignoring
 * case as `load()` matches resource names. Those are the names Unity gives a
 * loose file's resource files, so `readResource()` and `obj.read()` find a
 * texture's or clip's bulk data without the caller passing it. Nothing else in
 * the directory is read: to load more, pass the directory.
 *
 * **Split files** (`<name>.split0` ... `.splitN`, as Unity writes large files
 * for Android) are merged, parts in numeric order, into one input named
 * `<name>`, like upstream's `MergeSplitAssets`, but in memory: nothing is
 * written to disk. A path to one part loads the whole merged file. When
 * `<name>` itself sits next to its parts, it is loaded and the parts are not,
 * as upstream uses an already merged file. Sidecars may be split too.
 *
 * **Names.** Each input is named by its path relative to the directory given
 * (for a file: its own directory), with `/` between components on every
 * platform: `bundles/main`, `Data/sharedassets0.assets.resS`. That name is the
 * `path` a loose file gets in `env.files`. `load()` matches resource files and
 * externals by the last component of a name only, so the directories never
 * change what resolves. Inputs are passed in code-unit order of those names,
 * which decides the "first one loaded" of `load()`'s duplicate-name rules.
 * Every input is loose, so they all share one container: when one directory
 * holds two builds that both have, say, a `sharedassets0.assets.resS`, the
 * first one serves both. Load each build with its own call to keep them apart.
 *
 * Sync on purpose: `load()` is sync (D4, parsing blocks either way), so an
 * async read would only make this the one promise outside texture decoding.
 *
 * @param fileOrDir a file or directory path, absolute or relative to the
 *   working directory
 * @returns the env `load()` returns for those files; an empty directory gives
 *   an empty env, as `load([])` does
 * @throws {Error} Node's own file system error (`code` `ENOENT`, `EACCES`,
 *   ...) when `fileOrDir` does not exist, or when any file or directory in the
 *   scan cannot be listed or read, a dangling link included: a scan that skips
 *   what it cannot read would hand back an env with holes in it
 * @throws {Error} when `fileOrDir` is neither a file nor a directory
 * @throws {CorruptError} when the parts of a split file do not run 0..N without
 *   a gap, naming the file and the first missing part
 * @throws {UnsupportedError} / {CorruptError} as `load()` does
 */
export function loadPath(fileOrDir: string): Env {
  const stats = statSync(fileOrDir);
  if (stats.isDirectory()) return load(readInputs(fileOrDir, listFiles(fileOrDir)));
  if (!stats.isFile()) throw new Error(`${fileOrDir} is neither a file nor a directory`);

  const dir = dirname(fileOrDir);
  const own = basename(fileOrDir);
  const target = SPLIT_PART.exec(own)?.[1] ?? own;
  const sidecars = [`${target}.resS`, `${stem(target)}.resource`].map((n) => n.toLowerCase());
  // Match names first, so an unrelated entry next to the file is never
  // touched; then keep the matches that are files or links to files, as
  // upstream's `File.Exists` does (a folder named `main.resS` is no sidecar).
  const wanted = readdirSync(dir).filter((name) => {
    const merged = SPLIT_PART.exec(name)?.[1] ?? name;
    if (merged !== target && !sidecars.includes(merged.toLowerCase())) return false;
    return statSync(join(dir, name)).isFile();
  });
  return load(readInputs(dir, wanted));
}

/**
 * Read the files at `names` below `root`, merging split parts, in code-unit
 * order of their (merged) names.
 *
 * @param names `/`-separated paths relative to `root`
 * @throws {CorruptError} when a split file's parts have a gap
 */
function readInputs(root: string, names: readonly string[]): LoadInput[] {
  const whole = new Set<string>();
  const parts = new Map<string, Map<number, string>>();
  for (const name of names) {
    const split = SPLIT_PART.exec(name);
    if (!split) {
      whole.add(name);
      continue;
    }
    const merged = split[1]!;
    const own = parts.get(merged) ?? new Map<number, string>();
    own.set(Number(split[2]), name);
    parts.set(merged, own);
  }

  const inputs: LoadInput[] = [...whole].map((name) => ({
    name,
    data: view(readFileSync(fromRoot(root, name))),
  }));
  for (const [name, own] of parts) {
    // Upstream merges only when `<name>` is not there yet, and then loads
    // `<name>` instead of the parts either way.
    if (whole.has(name)) continue;
    inputs.push({ name, data: merge(root, name, own) });
  }
  return inputs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Concatenate the parts of one split file, `.split0` first.
 *
 * Upstream counts the parts and opens `.split0` up to that count, so a gap
 * fails on a missing file, while parts without a `.split0` are dropped without
 * a word; UnityPy stops at the first gap. Either way the file comes out short
 * or not at all, so any gap is refused here instead (R9). A missing last part
 * cannot be seen from the names; `load()` refuses the short file it makes.
 *
 * ponytail: peak memory is twice the merged size (the parts, then the copy).
 * Read the parts straight into the result if split files that big show up.
 *
 * @param parts part number to `/`-separated path relative to `root`
 * @throws {CorruptError} naming the file and the first missing part
 */
function merge(root: string, name: string, parts: ReadonlyMap<number, string>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (let index = 0; index < parts.size; index++) {
    const part = parts.get(index);
    if (part === undefined) {
      const found = [...parts.keys()].sort((a, b) => a - b).map((i) => `.split${i}`);
      throw new CorruptError(
        `${fromRoot(root, name)}: split file is missing part .split${index} ` +
          `(found ${found.join(", ")})`,
      );
    }
    chunks.push(readFileSync(fromRoot(root, part)));
  }
  const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Every file below `root`, as `/`-separated paths relative to it, following
 * links to files but not links to directories.
 */
function listFiles(root: string, dir = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir ? fromRoot(root, dir) : root, { withFileTypes: true })) {
    const name = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFiles(root, name));
    } else if (entry.isFile()) {
      out.push(name);
    } else if (entry.isSymbolicLink() && statSync(fromRoot(root, name)).isFile()) {
      out.push(name);
    }
  }
  return out;
}

/** The file system path of a `/`-separated `name` below `root`. */
function fromRoot(root: string, name: string): string {
  return join(root, ...name.split("/"));
}

/**
 * The bytes of a `Buffer` as a plain `Uint8Array` over the same memory, so
 * `env.files` holds the type `load()` documents rather than a subclass.
 */
function view(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** A file name without its last extension: `sharedassets0.assets` → `sharedassets0`. */
function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
