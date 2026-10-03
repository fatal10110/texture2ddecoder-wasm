import assert from "node:assert/strict";
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { ClassID, CorruptError, load } from "unity-asset-reader";

import { assertMatchesGolden, golden, loadFixture } from "../../../fixtures/helpers.js";
import { loadPath } from "../src/index.js";

const tmp = mkdtempSync(join(tmpdir(), "unity-asset-reader-externals-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Write hand-built or editor-built bytes into a temporary directory. */
function folder(name: string, files: Record<string, Uint8Array>): string {
  const root = join(tmp, name);
  mkdirSync(root);
  for (const [path, data] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }
  return root;
}

/** Format 17, one object (path ID 1) containing a PPtr to its first external. */
function serialized(externals: string[]): Uint8Array {
  const bytes = Buffer.alloc(2048);
  let at = 20;
  const int = (value: number) => { bytes.writeInt32LE(value, at); at += 4; };
  const string = (value: string) => { at += bytes.write(value, at); bytes[at++] = 0; };
  string("2018.4.0f1");
  int(19); // StandaloneWindows64
  bytes[at++] = 0; // no type tree
  int(1); // one type
  int(ClassID.TextAsset);
  bytes[at++] = 0; // not stripped
  bytes.writeInt16LE(-1, at); at += 2; // no script type
  at += 16; // old type hash
  int(1); // one object
  at = Math.ceil(at / 4) * 4;
  bytes.writeBigInt64LE(1n, at); at += 8;
  int(0); // object offset, relative to dataOffset
  int(12); // Int32 file ID + Int64 path ID
  int(0); // type index
  int(0); // no script types
  int(externals.length);
  for (const external of externals) {
    string(""); // tempEmpty
    at += 16; // GUID
    int(0); // external type
    string(external);
  }
  string(""); // user information
  bytes.writeUInt32BE(at - 20, 0); // metadata size
  at = Math.ceil(at / 8) * 8;
  bytes.writeUInt32BE(at + 12, 4); // file size
  bytes.writeUInt32BE(17, 8); // format
  bytes.writeUInt32BE(at, 12); // dataOffset
  int(externals.length ? 1 : 0);
  bytes.writeBigInt64LE(1n, at); at += 8;
  return new Uint8Array(bytes.buffer, bytes.byteOffset, at);
}

const sidecar = Uint8Array.of(1, 2, 3, 4);

test("a loose sharedassets file loads its external and both files' sidecars; its PPtr resolves", () => {
  const root = folder("sharedassets", {
    "sharedassets0.assets": serialized(["library/sharedassets1.assets"]),
    "sharedassets0.assets.resS": sidecar,
    "sharedassets1.assets": serialized([]),
    "sharedassets1.resource": sidecar,
    "unrelated.assets": serialized([]),
  });
  const env = loadPath(join(root, "sharedassets0.assets"));
  assert.deepEqual(env.files.map((f) => f.path), [
    "sharedassets0.assets", "sharedassets0.assets.resS",
    "sharedassets1.assets", "sharedassets1.resource",
  ]);
  const source = env.objects.find((o) => o.fileName === "sharedassets0.assets")!;
  const result = env.resolve({ m_FileID: source.readInt32(), m_PathID: source.readInt64() }, source);
  assert.equal(result.status, "found");
  if (result.status !== "found") assert.fail("external pointer did not resolve");
  assert.equal(result.object.fileName, "sharedassets1.assets");
  assert.equal(result.object.pathId, 1n);
});

test("a missing external leaves its PPtr unresolved and does not scan subfolders", () => {
  const root = folder("missing", {
    "sharedassets0.assets": serialized(["sharedassets1.assets"]),
    "nested/sharedassets1.assets": serialized([]),
  });
  const env = loadPath(join(root, "sharedassets0.assets"));
  assert.deepEqual(env.files.map((f) => f.path), ["sharedassets0.assets"]);
  const source = env.objects[0]!;
  assert.deepEqual(
    env.resolve({ m_FileID: source.readInt32(), m_PathID: source.readInt64() }, source),
    { status: "fileNotLoaded", fileName: "sharedassets1.assets" },
  );
});

test("transitive, repeated and cyclic externals are loaded once, ignoring case", () => {
  const root = folder("cycle", {
    "first.assets": serialized(["SECOND.ASSETS", "second.assets", "first.assets"]),
    "second.assets": serialized(["third.assets"]),
    "third.assets": serialized(["FIRST.ASSETS"]),
    "unrelated.assets": serialized([]),
  });
  const env = loadPath(join(root, "first.assets"));
  assert.deepEqual(env.files.map((f) => f.path), ["first.assets", "second.assets", "third.assets"]);
  assert.equal(env.objects.length, 3);
});

test("split primary files, externals and their sidecars are merged", () => {
  const main = serialized(["other.assets"]);
  const other = serialized([]);
  const root = folder("split", {
    "main.assets.split0": main.subarray(0, 50),
    "main.assets.split1": main.subarray(50),
    "other.assets.split0": other.subarray(0, 40),
    "other.assets.split1": other.subarray(40),
    "other.assets.resS.split0": sidecar.subarray(0, 2),
    "other.assets.resS.split1": sidecar.subarray(2),
  });
  const env = loadPath(join(root, "main.assets.split1"));
  assert.deepEqual(env.files.map((f) => f.path), ["main.assets", "other.assets", "other.assets.resS"]);
  assert.deepEqual(env.files[1]!.data, other);
  assert.deepEqual(env.files[2]!.data, sidecar);
});

test("an existing merged external wins over its incomplete split parts", () => {
  const other = serialized([]);
  const root = folder("merged", {
    "main.assets": serialized(["other.assets"]),
    "other.assets": other,
    "other.assets.split1": Uint8Array.of(0),
  });
  const env = loadPath(join(root, "main.assets"));
  assert.deepEqual(env.files.map((f) => f.path), ["main.assets", "other.assets"]);
  assert.deepEqual(env.files[1]!.data, other);
});

test("a gap in an external's split parts is refused with the external's name", () => {
  const root = folder("gap", {
    "main.assets": serialized(["other.assets"]),
    "other.assets.split1": serialized([]),
  });
  assert.throws(() => loadPath(join(root, "main.assets")),
    (error: unknown) => error instanceof CorruptError &&
      error.message.includes("other.assets: split file is missing part .split0"));
});

test("invalid external metadata throws with the external's path and byte context", () => {
  const broken = serialized([]);
  new DataView(broken.buffer, broken.byteOffset).setUint32(0, broken.length);
  const root = folder("corrupt", {
    "main.assets": serialized(["other.assets"]),
    "other.assets": broken,
  });
  assert.throws(() => loadPath(join(root, "main.assets")),
    (error: unknown) => error instanceof CorruptError &&
      error.message.startsWith(`${join(root, "other.assets")}: metadata`) &&
      error.message.includes("offset 20"));
});

test("a directory with an external's name is skipped along with its orphan sidecar", () => {
  const root = folder("directory", {
    "main.assets": serialized(["other.assets"]),
    "other.assets.resS": sidecar,
  });
  mkdirSync(join(root, "other.assets"));
  assert.deepEqual(loadPath(join(root, "main.assets")).files.map((f) => f.path), ["main.assets"]);
});

test("a dangling external link is missing and leaves its PPtr unresolved", (t) => {
  const root = folder("dangling", { "main.assets": serialized(["other.assets"]) });
  try {
    symlinkSync(join(root, "gone.assets"), join(root, "other.assets"), "file");
  } catch {
    t.skip("cannot create symbolic links here");
    return;
  }
  const env = loadPath(join(root, "main.assets"));
  assert.deepEqual(env.files.map((f) => f.path), ["main.assets"]);
  assert.deepEqual(env.resolve({ m_FileID: 1, m_PathID: 1n }, env.objects[0]!),
    { status: "fileNotLoaded", fileName: "other.assets" });
});

test("an unreadable external throws Node's error", (t) => {
  const root = folder("unreadable", {
    "main.assets": serialized(["locked.assets"]),
    "locked.assets": serialized([]),
  });
  const locked = join(root, "locked.assets");
  chmodSync(locked, 0o000);
  t.after(() => chmodSync(locked, 0o644));
  try {
    readFileSync(locked);
    t.skip("file permissions do not stop this user (root, or Windows)");
    return;
  } catch {
    // Unreadable, as intended.
  }
  assert.throws(() => loadPath(join(root, "main.assets")),
    (error: NodeJS.ErrnoException) => error.code === "EACCES" && error.path === locked);
});

test("editor-built loose files resolve the cross-file TextAsset against the UnityPy golden", () => {
  const mainName = "editor/6000.3.25f1/lz4/main";
  const sharedName = "editor/6000.3.25f1/lz4/shared";
  const main = load([{ name: mainName, data: loadFixture(mainName) }]).files[0]!;
  const shared = load([{ name: sharedName, data: loadFixture(sharedName) }]).files[0]!;
  const root = folder("editor", { [main.path]: main.data, [shared.path]: shared.data });
  const env = loadPath(join(root, main.path));
  const source = env.objects.find((o) => o.type === ClassID.MonoBehaviour)!;
  const dump = golden(mainName).serialized![main.path]!.typetrees[String(source.pathId)]!.value as {
    textRef: { m_FileID: number; m_PathID: string };
  };
  const result = env.resolve({
    m_FileID: dump.textRef.m_FileID, m_PathID: BigInt(dump.textRef.m_PathID),
  }, source);
  assert.equal(result.status, "found");
  if (result.status !== "found") assert.fail("external TextAsset did not resolve");
  assert.equal(result.object.type, ClassID.TextAsset);
  assert.equal(result.object.fileName, shared.path);
  assert.equal(result.object.read<{ m_Name: string }>().m_Name, "hello");
  assertMatchesGolden(sharedName, [env.files.find((f) => f.path === shared.path)!]);
});

test("a bundle does not pull its nodes' external references from disk", () => {
  const mainName = "editor/6000.3.25f1/lz4/main";
  const sharedName = "editor/6000.3.25f1/lz4/shared";
  const shared = load([{ name: sharedName, data: loadFixture(sharedName) }]).files[0]!;
  const root = folder("bundle", { main: loadFixture(mainName), [shared.path]: shared.data });
  const env = loadPath(join(root, "main"));
  assert.equal(env.files.length, 1);
  assert.equal(env.objects.some((o) => o.type === ClassID.TextAsset), false);
});
