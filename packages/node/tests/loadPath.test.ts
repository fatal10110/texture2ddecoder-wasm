import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  ClassID,
  CorruptError,
  load,
  type Env,
  type LoadInput,
  type Texture2DData,
} from "unity-asset-reader";

import { assertMatchesGolden, golden, loadFixture, sha256 } from "../../../fixtures/helpers.js";
import { loadPath } from "../src/index.js";

// Every folder below is built here from committed fixture bytes (R11); nothing
// generated is committed.
const tmp = mkdtempSync(join(tmpdir(), "unity-asset-reader-node-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Write `files` (`/`-separated relative path → bytes) below a new folder. */
function folder(name: string, files: Record<string, Uint8Array>): string {
  const root = join(tmp, name);
  mkdirSync(root);
  for (const [path, data] of Object.entries(files)) {
    const full = join(root, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }
  return root;
}

/** `data` cut into `count` parts of near-equal size, named `<name>.split0..`. */
function split(name: string, data: Uint8Array, count: number): Record<string, Uint8Array> {
  const parts: Record<string, Uint8Array> = {};
  const size = Math.ceil(data.length / count);
  for (let i = 0; i < count; i++) {
    parts[`${name}.split${i}`] = data.subarray(i * size, (i + 1) * size);
  }
  return parts;
}

/** What identifies an object across two loads of the same bytes. */
function objectRows(env: Env): unknown[] {
  return env.objects.map((o) => [
    o.fileName,
    o.pathId,
    o.type,
    o.byteStart,
    o.byteSize,
    o.unityVersion,
  ]);
}

// An editor bundle, to split, and a loose SerializedFile with its `.resS`,
// cut out of another editor's texture bundle. The two bundles hold different
// SerializedFile names, so every sidecar lookup below has one right answer.
const MAIN = "editor/6000.3.25f1/lz4/main";
const TEXTURE = "editor/2020.3.30f1/lz4/texture";
const mainBundle = loadFixture(MAIN);
const textureNodes = load([{ name: TEXTURE, data: loadFixture(TEXTURE) }]).files;
assertMatchesGolden(TEXTURE, textureNodes);
const [cab, resS] = textureNodes as [
  { path: string; data: Uint8Array },
  { path: string; data: Uint8Array },
];
assert.equal(resS.path, `${cab.path}.resS`);
const checker = Object.values(golden(TEXTURE).serialized![cab.path]!.textures!)[0]!;
const unrelated = Uint8Array.from({ length: 16 }, (_, i) => i);
/** The one SerializedFile node of `MAIN`. */
const MAIN_CAB = "CAB-ba01e3c16ba268ec36e9543a39dc83ad";

const tree = folder("tree", {
  ...split("bundles/main", mainBundle, 3),
  [`loose/${cab.path}`]: cab.data,
  ...split(`loose/${resS.path}`, resS.data, 2),
  "loose/unrelated.resS": unrelated,
});

/** The same files as `tree`, merged, named and ordered as `loadPath` must. */
const inMemory: LoadInput[] = [
  { name: "bundles/main", data: mainBundle },
  { name: `loose/${cab.path}`, data: cab.data },
  { name: `loose/${resS.path}`, data: resS.data },
  { name: "loose/unrelated.resS", data: unrelated },
];

/** The one Texture2D's image data, read through the env's resource lookup. */
function checkerImage(env: Env): Uint8Array {
  const textures = env.objects.filter((o) => o.type === ClassID.Texture2D);
  assert.equal(textures.length, 1);
  return textures[0]!.read<Texture2DData>().imageData;
}

// --- the acceptance criterion ------------------------------------------------

test("a folder with a split bundle and split sidecars loads as the same bytes in memory", () => {
  const fromDisk = loadPath(tree);
  const expected = load(inMemory);

  // Paths are relative to the folder and `/`-separated; split parts are gone.
  assert.deepEqual(
    fromDisk.files.map((f) => f.path),
    [MAIN_CAB, `loose/${cab.path}`, `loose/${resS.path}`, "loose/unrelated.resS"],
  );
  assert.deepStrictEqual(fromDisk.files, expected.files);
  assertMatchesGolden(MAIN, fromDisk.files.slice(0, 1));

  assert.ok(fromDisk.objects.length > 0);
  assert.deepStrictEqual(objectRows(fromDisk), objectRows(expected));
});

test("the loose texture reads its image out of the merged .resS", () => {
  const image = checkerImage(loadPath(tree));
  assert.equal(image.length, checker.imageSize);
  assert.equal(sha256(image), checker.imageSha256);
});

// --- a single file -----------------------------------------------------------

test("a file is loaded with its own sidecars and nothing else from its folder", () => {
  const env = loadPath(join(tree, "loose", cab.path));
  assert.deepEqual(
    env.files.map((f) => f.path),
    [cab.path, resS.path],
  );
  assert.equal(sha256(checkerImage(env)), checker.imageSha256);
});

test("a file takes <stem>.resource and matches sidecar names ignoring case", () => {
  const root = folder("sidecars", {
    "sharedassets0.assets": cab.data,
    "SHAREDASSETS0.ASSETS.RESS": resS.data,
    "sharedassets0.resource": unrelated,
    "sharedassets01.assets.resS": unrelated,
    "sharedassets0.assets.resource": unrelated,
  });
  assert.deepEqual(
    loadPath(join(root, "sharedassets0.assets")).files.map((f) => f.path),
    ["SHAREDASSETS0.ASSETS.RESS", "sharedassets0.assets", "sharedassets0.resource"],
  );
});

test("a folder named like a sidecar is not read as one", () => {
  const root = folder("sidecar-dir", { main: mainBundle });
  mkdirSync(join(root, "main.resS"));
  assert.deepEqual(
    loadPath(join(root, "main")).files.map((f) => f.path),
    [MAIN_CAB],
  );
});

test("a path to one split part loads the whole merged file", () => {
  const env = loadPath(join(tree, "bundles", "main.split1"));
  assertMatchesGolden(MAIN, env.files);
  assert.deepStrictEqual(env.files, load([{ name: "main", data: mainBundle }]).files);
});

// --- split files -------------------------------------------------------------

test("parts are merged in numeric order, not name order", () => {
  const parts = split("main", mainBundle, 12);
  assert.ok(parts["main.split10"], "needs a part that sorts before .split2 by name");
  const env = loadPath(folder("twelve", parts));
  assert.deepStrictEqual(env.files, load([{ name: "main", data: mainBundle }]).files);
});

test("a gap in the parts is refused, naming the missing part", () => {
  const { "main.split1": _, ...gap } = split("main", mainBundle, 3);
  assert.throws(
    () => loadPath(folder("gap", gap)),
    (error: unknown) =>
      error instanceof CorruptError &&
      /main: split file is missing part \.split1 \(found \.split0, \.split2\)/.test(error.message),
  );
});

test("parts without a .split0 are refused", () => {
  const { "main.split0": _, ...headless } = split("main", mainBundle, 3);
  assert.throws(
    () => loadPath(folder("headless", headless)),
    (error: unknown) =>
      error instanceof CorruptError && /missing part \.split0/.test(error.message),
  );
});

test("a merged file next to its parts is loaded once, the parts left out", () => {
  const env = loadPath(folder("merged", { main: mainBundle, ...split("main", mainBundle, 2) }));
  assert.deepStrictEqual(env.files, load([{ name: "main", data: mainBundle }]).files);
});

test("a name that only looks like a part is an ordinary file", () => {
  const root = folder("not-parts", { "a.split01": unrelated, "a.splitx": unrelated });
  assert.deepEqual(
    loadPath(root).files.map((f) => f.path),
    ["a.split01", "a.splitx"],
  );
});

// --- what is not a Unity folder ----------------------------------------------

test("an empty folder gives an empty env, as load([]) does", () => {
  const env = loadPath(folder("empty", {}));
  assert.deepEqual(env.files, []);
  assert.deepEqual(env.objects, []);
});

test("a path that does not exist throws ENOENT", () => {
  assert.throws(
    () => loadPath(join(tmp, "nowhere")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});

test("a path that is neither a file nor a folder is refused", (t) => {
  const fifo = join(folder("fifo", {}), "pipe");
  try {
    execFileSync("mkfifo", [fifo], { stdio: "ignore" });
  } catch {
    t.skip("mkfifo is not available here (Windows)");
    return;
  }
  assert.throws(() => loadPath(fifo), {
    message: `${fifo} is neither a file nor a directory`,
  });
});

test("a file in the folder that cannot be read fails the whole load", (t) => {
  const root = folder("unreadable", { main: mainBundle, "locked.resS": unrelated });
  const locked = join(root, "locked.resS");
  chmodSync(locked, 0o000);
  t.after(() => chmodSync(locked, 0o644));
  try {
    readFileSync(locked);
    t.skip("file permissions do not stop this user (root, or Windows)");
    return;
  } catch {
    // Unreadable, as intended.
  }
  assert.throws(() => loadPath(root), (error: NodeJS.ErrnoException) => error.code === "EACCES");
});

test("a dangling link fails a folder load, not a file load; folder links are not followed", (t) => {
  const root = folder("links", { "real/main": mainBundle });
  try {
    symlinkSync(join(root, "real"), join(root, "loop"), "dir");
  } catch {
    t.skip("cannot create symbolic links here");
    return;
  }
  // `loop` points back at `real`: following it would load `main` twice.
  assert.deepEqual(
    loadPath(root).files.map((f) => f.path),
    [MAIN_CAB],
  );

  symlinkSync(join(root, "gone"), join(root, "real", "dangling"), "file");
  assert.throws(() => loadPath(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  // A single file never touches the entries next to it that are not its own.
  assert.deepEqual(
    loadPath(join(root, "real", "main")).files.map((f) => f.path),
    [MAIN_CAB],
  );
});
