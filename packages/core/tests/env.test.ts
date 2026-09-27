import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import {
  assertMatchesGolden,
  fixtureNames,
  golden,
  loadFixture,
  sha256,
} from "../../../fixtures/helpers.js";
import { NodeFlags } from "../src/bundle/BundleFile.js";
import {
  load,
  ResourceNotFoundError,
  type Env,
  type LoadedFile,
  type ResourceRef,
} from "../src/env.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { ClassID } from "../src/serialized/ClassID.js";
import { ObjectReader } from "../src/serialized/ObjectReader.js";
import { readSerializedFile } from "../src/serialized/SerializedFile.js";

/** Deterministic opaque bytes, so a failure names a byte rather than a seed. */
function payload(length: number, step = 7): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * step + 3) & 0xff);
}

// --- every M1 fixture against the oracle goldens -----------------------------

interface TableRow {
  pathId: string;
  classId: number;
  byteSize: number;
}

const byPathId = (a: TableRow, b: TableRow): number =>
  a.pathId < b.pathId ? -1 : a.pathId > b.pathId ? 1 : 0;

/** Objects as a golden object table lists them, sorted by path id. */
function objectTable(objects: ObjectReader[]): TableRow[] {
  return objects
    .map((o) => ({ pathId: String(o.pathId), classId: o.type, byteSize: o.byteSize }))
    .sort(byPathId);
}

for (const name of fixtureNames()) {
  test(`load() unpacks ${name} byte-identically to the golden`, () => {
    assertMatchesGolden(name, load([{ name, data: loadFixture(name) }]).files);
  });

  test(`load() lists the objects of ${name} as its golden object tables do`, () => {
    const { objects } = load([{ name, data: loadFixture(name) }]);
    // M1 fixtures hold only opaque nodes: no tables, so no objects either.
    const expected = Object.values(golden(name).objects).flat().sort(byPathId);
    assert.deepEqual(objectTable(objects), expected);
    for (const object of objects) assert.ok(object instanceof ObjectReader);
  });
}

test("keeps every input, in the order it was given", () => {
  const files = load([
    { name: "lz4.bundle", data: loadFixture("lz4.bundle") },
    { name: "lzma.bundle", data: loadFixture("lzma.bundle") },
  ]).files;

  assert.deepEqual(
    files.map((f) => f.path),
    ["CAB-lz4", "CAB-lz4.resS", "CAB-lzma", "CAB-lzma.resS"],
  );
});

test("returns views into the decompressed blocks rather than copies (R7)", () => {
  const files = load([{ name: "lz4.bundle", data: loadFixture("lz4.bundle") }]).files;
  // Sibling nodes are cut out of one stitched buffer, so a copy anywhere on the
  // way out would give them separate ones.
  assert.equal(files[0]!.data.buffer, files[1]!.data.buffer);
});

// --- inputs that are not containers ------------------------------------------

test("keeps a .resS sidecar under its own name", () => {
  const data = payload(64);
  assert.deepEqual(load([{ name: "a.resS", data }]).files, [{ path: "a.resS", data }]);
});

/**
 * A SerializedFile header with no metadata behind it. It has no magic:
 * detection accepts a header whose recorded size is exactly the bytes handed
 * over. Format version 21 keeps the 32-bit fields; 22 adds 64-bit ones after
 * the reserved bytes.
 */
function serializedFile(length: number, version = 21): Uint8Array {
  const data = new Uint8Array(length);
  const view = new DataView(data.buffer);
  view.setUint32(0, 12); // m_MetadataSize
  view.setUint32(4, length); // m_FileSize
  view.setUint32(8, version); // m_Version
  view.setUint32(12, 20); // m_DataOffset
  if (version >= 22) {
    view.setBigInt64(24, BigInt(length)); // m_FileSize
    view.setBigInt64(32, 20n); // m_DataOffset
  }
  return data;
}

const SHARED = "editor/6000.3.25f1/lz4/shared";
const SHARED_CAB = "CAB-71fca072df859359e7a6b09ff7151c53";

test("keeps a SerializedFile input under its own name and reads its objects", () => {
  const bundle = load([{ name: SHARED, data: loadFixture(SHARED) }]);
  const { data } = bundle.files[0]!;

  const env = load([{ name: SHARED_CAB, data }]);
  assert.deepEqual(env.files, [{ path: SHARED_CAB, data }]);
  assert.deepEqual(objectTable(env.objects), golden(SHARED).objects[SHARED_CAB]);
});

test("keeps a header-only SerializedFile in files; objects throws, naming it", () => {
  // Detection is satisfied by the header alone; the metadata after it is cut.
  const data = serializedFile(32);
  const env = load([{ name: "CAB-loose", data }]);
  assert.deepEqual(env.files, [{ path: "CAB-loose", data }]);

  // Named exactly once, also on the second throw.
  const corrupt = (error: unknown): boolean =>
    error instanceof CorruptError && /^CAB-loose: (?!CAB-loose)/.test(error.message);
  assert.throws(() => env.objects, corrupt);
  // A failed parse is not kept: the next access parses, and throws, again.
  assert.throws(() => env.objects, corrupt);
});

test("unpacks a bundle holding a SerializedFile format it does not read; objects refuses it", () => {
  const node = serializedFile(48, 23);
  const env = load([{ name: "next.bundle", data: buildBundle([{ path: "CAB-next", data: node }]) }]);
  // Unpacking is layers 1-2 and does not depend on the SerializedFile inside.
  assert.deepEqual(env.files, [{ path: "CAB-next", data: node }]);

  const unsupported = (error: unknown): boolean =>
    error instanceof UnsupportedError &&
    error.kind === "SerializedFile format version" &&
    error.found === 23 &&
    /^next\.bundle: CAB-next: unsupported/.test(error.message);
  assert.throws(() => env.objects, unsupported);
  // Resolving needs the same parse, so it refuses the same way.
  const other = load([{ name: SHARED, data: loadFixture(SHARED) }]).objects[0]!;
  assert.throws(() => env.resolve({ m_FileID: 0, m_PathID: 1n }, other), unsupported);
});

test("objects throws CorruptError, naming the file, when a path id is listed twice", () => {
  const node = load([{ name: SHARED, data: loadFixture(SHARED) }]).files[0]!.data;
  const sf = readSerializedFile(node);
  const ids = sf.objects.map((o) => o.pathId);
  // Overwrite the TextAsset's path id in the table with the AssetBundle's (1).
  // Its id is 8 bytes nothing else in the metadata repeats, and the table
  // comes before any object data, so the first match is the table entry.
  const text = sf.objects.find((o) => o.classId === ClassID.TextAsset)!.pathId;
  const data = Uint8Array.from(node);
  const view = new DataView(data.buffer);
  const offset = [...data.keys()].find(
    (i) => i + 8 <= data.length && view.getBigInt64(i, true) === text,
  );
  assert.ok(offset !== undefined && offset < sf.header.dataOffset);
  view.setBigInt64(offset, 1n, true);
  assert.deepEqual(
    readSerializedFile(data).objects.map((o) => o.pathId),
    ids.map(() => 1n),
  );

  const env = load([{ name: "patched.bundle", data: buildBundle([{ path: SHARED_CAB, data }]) }]);
  assert.equal(env.files.length, 1);
  assert.throws(
    () => env.objects,
    (error: unknown) =>
      error instanceof CorruptError &&
      error.message === `patched.bundle: ${SHARED_CAB}: object table lists path id 1 twice`,
  );
});

test("parses SerializedFiles once, on first use", () => {
  const env = load([{ name: SHARED, data: loadFixture(SHARED) }]);
  assert.equal(env.objects, env.objects);
});

test("accepts an ArrayBuffer and wraps it without copying", () => {
  const data = payload(48);
  const files = load([{ name: "a.resS", data: data.buffer }]).files;
  assert.equal(files[0]!.data.buffer, data.buffer);
  assert.deepEqual(files[0]!.data, data);
});

test("accepts no inputs at all", () => {
  assert.deepEqual(load([]).files, []);
});

// --- hand-written containers, for the nesting the fixtures cannot show --------

class Writer {
  private bytes: number[] = [];

  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  /** Little-endian; `UnityWebData` is the one container that is not big-endian. */
  u32le(value: number): this {
    for (let i = 0; i < 4; i++) this.u8(value >>> (i * 8));
    return this;
  }

  u16be(value: number): this {
    return this.u8(value >>> 8).u8(value);
  }

  u32be(value: number): this {
    for (let i = 3; i >= 0; i--) this.u8(value >>> (i * 8));
    return this;
  }

  i64be(value: number): this {
    return this.u32be(Math.floor(value / 0x100000000)).u32be(value);
  }

  ascii(text: string): this {
    for (const char of text) this.u8(char.charCodeAt(0));
    return this;
  }

  cstring(text: string): this {
    return this.ascii(text).u8(0);
  }

  raw(data: Uint8Array): this {
    for (const byte of data) this.u8(byte);
    return this;
  }

  get length(): number {
    return this.bytes.length;
  }

  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** A `UnityWebData1.0` container: a flat entry table, then the file bytes. */
function buildWebData(files: { path: string; data: Uint8Array }[]): Uint8Array {
  const SIGNATURE = "UnityWebData1.0";
  let headerLength = SIGNATURE.length + 1 + 4;
  for (const file of files) headerLength += 12 + file.path.length;

  const out = new Writer().cstring(SIGNATURE).u32le(headerLength);
  let offset = headerLength;
  for (const file of files) {
    out.u32le(offset).u32le(file.data.length).u32le(file.path.length).ascii(file.path);
    offset += file.data.length;
  }
  for (const file of files) out.raw(file.data);
  return out.done();
}

/** A stored (uncompressed) `UnityFS` bundle holding one node per file. */
function buildBundle(
  files: { path: string; data: Uint8Array }[],
  unityRevision = "2022.3.0f1",
): Uint8Array {
  const blocks = new Writer();
  for (const file of files) blocks.raw(file.data);
  const blocksData = blocks.done();

  const info = new Writer().raw(new Uint8Array(16)); // uncompressed data hash
  info.u32be(1).u32be(blocksData.length).u32be(blocksData.length).u16be(0);
  info.u32be(files.length);
  let offset = 0;
  for (const file of files) {
    info.i64be(offset).i64be(file.data.length).u32be(NodeFlags.SerializedFile).cstring(file.path);
    offset += file.data.length;
  }
  const blocksInfo = info.done();

  const header = new Writer().cstring("UnityFS").u32be(6).cstring("5.x.x").cstring(unityRevision);
  // 0x40 = BlocksAndDirectoryInfoCombined, compression type 0 (none).
  const size = header.length + 8 + 12 + blocksInfo.length + blocksData.length;
  header.i64be(size).u32be(blocksInfo.length).u32be(blocksInfo.length).u32be(0x40);
  return header.raw(blocksInfo).raw(blocksData).done();
}

test("the hand-written containers round-trip, so the cases below start from valid bytes", () => {
  const data = payload(32);
  const web = load([{ name: "w.data", data: buildWebData([{ path: "a.resS", data }]) }]);
  assert.deepEqual(web.files, [{ path: "a.resS", data }]);

  const bundle = load([{ name: "b.bundle", data: buildBundle([{ path: "CAB-a", data }]) }]);
  assert.deepEqual(bundle.files, [{ path: "CAB-a", data }]);
});

test("unwraps a bundle nested inside a bundle", () => {
  const data = payload(48, 11);
  const inner = buildBundle([{ path: "CAB-inner", data }]);
  const files = load([
    { name: "outer.bundle", data: buildBundle([{ path: "CAB-outer", data: inner }]) },
  ]).files;

  assert.deepEqual(files, [{ path: "CAB-inner", data }]);
});

test("unwraps a bundle nested inside a UnityWebData file", () => {
  const data = payload(48, 13);
  const inner = buildBundle([{ path: "CAB-inner", data }]);
  const files = load([
    { name: "w.data", data: buildWebData([{ path: "inner.bundle", data: inner }]) },
  ]).files;

  assert.deepEqual(files, [{ path: "CAB-inner", data }]);
});

test("keeps every row when two inputs unpack to the same node path", () => {
  const first = payload(32, 3);
  const second = payload(32, 5);
  const files = load([
    { name: "a.bundle", data: buildBundle([{ path: "CAB-a", data: first }]) },
    { name: "b.bundle", data: buildBundle([{ path: "CAB-a", data: second }]) },
  ]).files;

  // Nothing here may drop or rename a duplicate: which node a later `.resS`
  // reference means is the M3 resolver's call (#30), and it needs both rows.
  assert.deepEqual(files, [
    { path: "CAB-a", data: first },
    { path: "CAB-a", data: second },
  ]);
});

test("keeps a node that only looks gzip-wrapped, instead of failing the load", () => {
  // Two bytes of magic: roughly one resource node in 65536 starts with them by
  // chance. Upstream never dispatches on a node's sniff at all, and stock Unity
  // gzips whole files rather than nodes, so opening this one would fail a load
  // over ordinary asset bytes.
  const data = Uint8Array.from([0x1f, 0x8b, ...payload(30, 17)]);
  const files = load([
    { name: "b.bundle", data: buildBundle([{ path: "CAB-a.resS", data }]) },
  ]).files;

  assert.deepEqual(files, [{ path: "CAB-a.resS", data }]);
});

test("still unwraps a gzip wrapper the caller hands in directly", () => {
  // The node case above must not cost the input case: a doubly-wrapped input
  // keeps unwrapping, which is what upstream's LoadFile(DecompressGZip(...))
  // does.
  const inner = gzipSync(buildBundle([{ path: "CAB-a", data: payload(32, 19) }]));
  const files = load([{ name: "a.bundle.gz.gz", data: gzipSync(inner) }]).files;

  assert.deepEqual(
    files.map((f) => f.path),
    ["CAB-a"],
  );
});

test("keeps the input name when a gzip wrapper unwraps to something opaque", () => {
  // The fixture's inner bundle renames its nodes; only a leaf keeps the `.gz`
  // name, which is what upstream's DecompressGZip does - it reuses the path.
  const files = load([
    { name: "gzip-lz4.bundle.gz", data: loadFixture("gzip-lz4.bundle.gz") },
  ]).files;
  assert.deepEqual(
    files.map((f) => f.path),
    ["CAB-lz4", "CAB-lz4.resS"],
  );
});

test("refuses containers nested past the depth cap instead of overflowing the stack", () => {
  let nested = buildWebData([{ path: "a.resS", data: payload(8) }]);
  for (let i = 0; i < 17; i++) nested = buildWebData([{ path: `n${i}.data`, data: nested }]);

  assert.throws(
    () => load([{ name: "deep.data", data: nested }]),
    (error: unknown) =>
      error instanceof UnsupportedError &&
      error.kind === "container nesting" &&
      /above the 16 level limit/.test(error.message),
  );
});

// --- format < 7: the enclosing bundle's revision -----------------------------

/**
 * A format-6 SerializedFile (Unity 2.x), which records no editor version: a
 * 16-byte header, one 4-byte object, then the metadata, big-endian here. No
 * editor we have writes this format, so it is built by hand.
 */
function format6SerializedFile(): Uint8Array {
  const metadata = new Writer()
    .u8(1) // endianess: big
    .u32be(0) // types
    .u32be(1) // objects
    .u32be(1) // m_PathID, Int32 before format 14
    .u32be(0) // byteStart, relative to m_DataOffset
    .u32be(4) // byteSize
    .u32be(ClassID.TextAsset) // typeID: the class id itself before format 16
    .u16be(ClassID.TextAsset) // classID
    .u16be(0) // isDestroyed
    .u32be(0) // externals
    .cstring("") // userInformation
    .done();
  const dataOffset = 16;
  const fileSize = dataOffset + 4 + metadata.length;
  return new Writer()
    .u32be(metadata.length)
    .u32be(fileSize)
    .u32be(6) // m_Version
    .u32be(dataOffset)
    .raw(payload(4))
    .raw(metadata)
    .done();
}

const LEGACY = format6SerializedFile();

test("the hand-written format-6 SerializedFile parses and names no editor", () => {
  const sf = readSerializedFile(LEGACY);
  assert.equal(sf.header.version, 6);
  assert.equal(sf.unityVersion, "2.5.0f5");
  assert.deepEqual(sf.version, [0, 0, 0, 0]);
  assert.deepEqual(
    sf.objects.map((o) => [o.pathId, o.classId, o.byteStart, o.byteSize]),
    [[1n, ClassID.TextAsset, 16, 4]],
  );
});

test("an object of a format-6 SerializedFile in a bundle reports the bundle's unityRevision", () => {
  const bundle = buildBundle([{ path: "CAB-old", data: LEGACY }], "2.6.1f3");
  const { objects } = load([{ name: "old.bundle", data: bundle }]);

  assert.deepEqual(
    objects.map((o) => [o.pathId, o.format, o.version]),
    [[1n, 6, [2, 6, 1, 3]]],
  );
});

test("a format-6 SerializedFile passed as an input keeps version [0, 0, 0, 0]", () => {
  const { objects } = load([{ name: "CAB-old", data: LEGACY }]);

  assert.deepEqual(
    objects.map((o) => [o.pathId, o.format, o.version]),
    [[1n, 6, [0, 0, 0, 0]]],
  );
});

test("a bundle's revision reaches its own nodes only, not a UnityWebData file's", () => {
  // Upstream's LoadWebFile passes no revision; a bundle nested anywhere passes
  // its own, not the outer bundle's.
  const inner = buildBundle([{ path: "CAB-inner", data: LEGACY }], "3.0.0f5");
  const web = buildWebData([
    { path: "CAB-web", data: LEGACY },
    { path: "inner.bundle", data: inner },
  ]);
  const outer = buildBundle([{ path: "web.data", data: web }], "2.6.1f3");
  const env = load([{ name: "outer.bundle", data: outer }]);

  assert.deepEqual(
    env.files.map((f) => f.path),
    ["CAB-web", "CAB-inner"],
  );
  assert.deepEqual(
    env.objects.map((o) => o.version),
    [
      [0, 0, 0, 0],
      [3, 0, 0, 5],
    ],
  );
});

test("a bundle nested directly in a bundle gives its nodes its own revision", () => {
  const inner = buildBundle([{ path: "CAB-old", data: LEGACY }], "3.0.0f5");
  const outer = buildBundle([{ path: "inner.bundle", data: inner }], "2.6.1f3");
  const { objects } = load([{ name: "outer.bundle", data: outer }]);

  assert.deepEqual(objects.map((o) => o.version), [[3, 0, 0, 5]]);
});

test("a SerializedFile of format 7 or later keeps its own version inside any bundle", () => {
  const node = load([{ name: SHARED, data: loadFixture(SHARED) }]).files[0]!.data;
  const own = readSerializedFile(node).version;
  assert.deepEqual(own, [6000, 3, 25, 1]);

  const bundle = buildBundle([{ path: SHARED_CAB, data: node }], "2.6.1f3");
  const { objects } = load([{ name: "old.bundle", data: bundle }]);
  assert.ok(objects.length > 0);
  for (const object of objects) assert.deepEqual(object.version, own);
});

// --- version-stripped: the enclosing bundle's revision -----------------------

/**
 * A format-8 SerializedFile (Unity 3.x) naming `unityVersion` as its editor:
 * the format-6 layout plus the version string and the target platform, and
 * `bigIDEnabled` before the object table (formats 7 to 13). Format 8 is the
 * smallest layout that records an editor; the fallback does not depend on the
 * format, so the `"0.0.0"` that `AssetBundleStripUnityVersion` writes goes in
 * here rather than into an editor-built file.
 */
function format8SerializedFile(unityVersion: string): Uint8Array {
  const metadata = new Writer()
    .u8(1) // endianess: big
    .cstring(unityVersion)
    .u32be(19) // m_TargetPlatform: StandaloneWindows64
    .u32be(0) // types
    .u32be(0) // bigIDEnabled
    .u32be(1) // objects
    .u32be(1) // m_PathID
    .u32be(0) // byteStart, relative to m_DataOffset
    .u32be(4) // byteSize
    .u32be(ClassID.TextAsset) // typeID
    .u16be(ClassID.TextAsset) // classID
    .u16be(0) // isDestroyed
    .u32be(0) // externals
    .cstring("") // userInformation
    .done();
  const dataOffset = 16;
  return new Writer()
    .u32be(metadata.length)
    .u32be(dataOffset + 4 + metadata.length)
    .u32be(8) // m_Version
    .u32be(dataOffset)
    .raw(payload(4))
    .raw(metadata)
    .done();
}

const STRIPPED = format8SerializedFile("0.0.0");

test("the hand-written format-8 SerializedFile parses with its version stripped", () => {
  const sf = readSerializedFile(STRIPPED);
  assert.equal(sf.header.version, 8);
  assert.equal(sf.unityVersion, "0.0.0");
  assert.deepEqual(sf.version, [0, 0, 0, 0]);
  assert.deepEqual(
    sf.objects.map((o) => [o.pathId, o.classId, o.byteStart, o.byteSize]),
    [[1n, ClassID.TextAsset, 16, 4]],
  );
  // The same builder with a real version keeps it, so nothing below is an
  // artefact of the layout.
  assert.deepEqual(readSerializedFile(format8SerializedFile("3.4.2f3")).version, [3, 4, 2, 3]);
});

test("an object of a version-stripped file in a bundle reports the bundle's unityRevision", () => {
  const bundle = buildBundle([{ path: "CAB-stripped", data: STRIPPED }], "2017.4.40f1");
  const { objects } = load([{ name: "stripped.bundle", data: bundle }]);

  assert.deepEqual(
    objects.map((o) => [o.pathId, o.format, o.version]),
    [[1n, 8, [2017, 4, 40, 1]]],
  );
});

test("a version-stripped file takes its own bundle's revision, not the first one loaded", () => {
  // Upstream's fallback is the first bundle revision the load saw, which
  // would give the second bundle's file 2017.4.40f1; UnityPy's, ported here,
  // is the bundle the file is a node of.
  const first = buildBundle([{ path: "CAB-first", data: STRIPPED }], "2017.4.40f1");
  const second = buildBundle([{ path: "CAB-second", data: STRIPPED }], "2018.4.36f1");
  const { objects } = load([
    { name: "first.bundle", data: first },
    { name: "second.bundle", data: second },
  ]);

  assert.deepEqual(
    objects.map((o) => o.version),
    [
      [2017, 4, 40, 1],
      [2018, 4, 36, 1],
    ],
  );
});

/** Objects as `[pathId, format, version]`, which is what the fallback changes. */
const versions = (objects: ObjectReader[]): unknown[] =>
  objects.map((o) => [o.pathId, o.format, o.version]);

test("a version-stripped input keeps [0, 0, 0, 0] and stays readable", () => {
  // The ponytail in env.ts: nothing names the editor, so the version stays
  // unknown instead of the whole load throwing; a version-gated class reader
  // refuses [0, 0, 0, 0] itself (decided on PR #107).
  const env = load([{ name: "CAB-stripped", data: STRIPPED }]);
  assert.deepEqual(env.files, [{ path: "CAB-stripped", data: STRIPPED }]);

  assert.deepEqual(versions(env.objects), [[1n, 8, [0, 0, 0, 0]]]);
  const object = env.objects[0]!;
  assert.deepEqual(env.resolve({ m_FileID: 0, m_PathID: 1n }, object), {
    status: "found",
    object,
  });
});

test("a version-stripped SerializedFile in a UnityWebData file keeps [0, 0, 0, 0]", () => {
  // UnityWebData records no revision, and a bundle's does not reach through
  // one (as for format < 7), so there is nothing to fall back to.
  const web = buildWebData([{ path: "CAB-stripped", data: STRIPPED }]);
  const outer = buildBundle([{ path: "web.data", data: web }], "2017.4.40f1");
  const env = load([{ name: "outer.bundle", data: outer }]);
  assert.deepEqual(env.files, [{ path: "CAB-stripped", data: STRIPPED }]);

  assert.deepEqual(versions(env.objects), [[1n, 8, [0, 0, 0, 0]]]);
});

for (const revision of ["0.0.0", ""]) {
  const shown = JSON.stringify(revision);
  test(`a version-stripped file in a bundle whose revision is ${shown} keeps [0, 0, 0, 0]`, () => {
    // 2019.4.41f2, 2020.3.30f1 and 6000.3.25f1 all write "0.0.0" in the bundle
    // header of a stripped build too, so this is what a real one looks like.
    // Another bundle in the same load names a different build: it lends the
    // stripped file nothing, and keeps its own version and its objects.
    const bundle = buildBundle([{ path: "CAB-stripped", data: STRIPPED }], revision);
    const env = load([
      { name: "real.bundle", data: buildBundle([{ path: "CAB-real", data: LEGACY }], "2.6.1f3") },
      { name: "stripped.bundle", data: bundle },
    ]);
    assert.equal(env.files.length, 2);

    assert.deepEqual(versions(env.objects), [
      [1n, 6, [2, 6, 1, 3]],
      [1n, 8, [0, 0, 0, 0]],
    ]);
  });
}

// --- refusals ----------------------------------------------------------------

test("refuses a type this library cannot open, naming the input", () => {
  const data = new Writer().ascii("PK\x03\x04").raw(payload(32)).done();
  assert.throws(() => load([{ name: "assets.zip", data }]), (error: unknown) => {
    assert.ok(error instanceof UnsupportedError);
    assert.equal(error.kind, "container");
    assert.equal(error.found, "zip");
    assert.match(error.message, /^assets\.zip: /);
    return true;
  });
});

test("names the input a corrupt bundle came from", () => {
  const bundle = buildBundle([{ path: "CAB-a", data: payload(32) }]);
  assert.throws(
    () => load([{ name: "cut.bundle", data: bundle.subarray(0, bundle.length - 8) }]),
    (error: unknown) => error instanceof CorruptError && /^cut\.bundle: /.test(error.message),
  );
});

test("names every container on the way down to the bad bytes", () => {
  const bundle = buildBundle([{ path: "CAB-a", data: payload(32) }]);
  const outer = buildWebData([
    { path: "inner.bundle", data: bundle.subarray(0, bundle.length - 8) },
  ]);

  assert.throws(
    () => load([{ name: "outer.data", data: outer }]),
    (error: unknown) =>
      error instanceof CorruptError && /^outer\.data: inner\.bundle: /.test(error.message),
  );
});

// --- resource files (#30) ------------------------------------------------------

/**
 * Every fixture with a Texture2D golden and a `.resS` node - the editor
 * texture bundles built with type trees, whose image data lives in the node.
 */
const RESS_FIXTURES = fixtureNames().filter((name) => {
  const { files, serialized } = golden(name);
  return (
    Object.keys(files).some((path) => path.endsWith(".resS")) &&
    Object.values(serialized ?? {}).some((s) => s.textures)
  );
});

/** The texture fixture every hand-made case below starts from. */
const TEXTURE = "editor/2020.3.30f1/lz4/texture";

/** Its nodes: the SerializedFile holding the Texture2D, and the `.resS` beside it. */
function textureNodes(): { cab: LoadedFile; ress: LoadedFile } {
  const files = load([{ name: TEXTURE, data: loadFixture(TEXTURE) }]).files;
  const ress = files.find((f) => f.path.endsWith(".resS"));
  const cab = files.find((f) => f !== ress);
  assert.ok(cab && ress, `${TEXTURE} has no SerializedFile + .resS pair`);
  return { cab, ress };
}

/** A Texture2D and its `m_StreamData`, as its typetree holds it. */
interface StreamedTexture {
  texture: ObjectReader;
  ref: ResourceRef;
}

/** Every Texture2D of `env` with its `m_StreamData`, in load order. */
function streamedTextures(env: Env): StreamedTexture[] {
  return env.objects
    .filter((o) => o.type === ClassID.Texture2D)
    .map((texture) => {
      const tree = texture.readTypeTree() as {
        m_StreamData: { path: string; offset: number | bigint; size: number };
      };
      const { path, offset, size } = tree.m_StreamData;
      // UInt32 before 2020.1, UInt64 (so a bigint, D9) from 2020.1 on.
      return { texture, ref: { path, offset: Number(offset), size } };
    });
}

/** The only Texture2D of `env`. */
function streamedTexture(env: Env): StreamedTexture {
  const [only, ...rest] = streamedTextures(env);
  assert.ok(only && rest.length === 0, "expected exactly one Texture2D");
  return only;
}

for (const name of RESS_FIXTURES) {
  test(`readResource() reads ${name}'s image data out of its .resS as the golden hashes it`, () => {
    const env = load([{ name, data: loadFixture(name) }]);
    const { texture, ref } = streamedTexture(env);
    const expected = Object.values(golden(name).serialized ?? {})
      .map((s) => s.textures?.[String(texture.pathId)])
      .find((t) => t !== undefined);
    assert.ok(expected, `${name} has no texture golden for ${texture.pathId}`);
    assert.match(ref.path, /^archive:\/CAB-[0-9a-f]+\/CAB-[0-9a-f]+\.resS$/);

    const data = env.readResource(ref, texture);
    assert.equal(data.length, expected.imageSize);
    assert.equal(sha256(data), expected.imageSha256);

    // A view into the unpacked node (R7), not a copy.
    const ress = env.files.find((f) => f.path.endsWith(".resS"));
    assert.equal(data.buffer, ress?.data.buffer);
  });
}

test("the golden .resS fixtures cover every editor", () => {
  for (const editor of ["2019.4.41f2", "2020.3.30f1", "6000.3.25f1"]) {
    assert.ok(RESS_FIXTURES.some((name) => name.startsWith(`editor/${editor}/`)), editor);
  }
});

test("readResource() finds a .resS passed as its own input next to the bundle", () => {
  const { cab, ress } = textureNodes();
  const env = load([
    { name: "texture.bundle", data: buildBundle([cab]) },
    { name: ress.path, data: ress.data },
  ]);
  const { texture, ref } = streamedTexture(env);
  assert.deepEqual(env.readResource(ref, texture), ress.data);
});

test("readResource() finds a .resS next to a loose SerializedFile, ignoring case", () => {
  const { cab, ress } = textureNodes();
  const env = load([
    { name: cab.path, data: cab.data },
    { name: ress.path.toUpperCase(), data: ress.data },
  ]);
  const { texture, ref } = streamedTexture(env);
  assert.deepEqual(env.readResource(ref, texture), ress.data);
});

test("readResource() throws ResourceNotFoundError naming the path of a missing .resS", () => {
  const { cab, ress } = textureNodes();
  const env = load([{ name: "texture.bundle", data: buildBundle([cab]) }]);
  const { texture, ref } = streamedTexture(env);

  assert.throws(
    () => env.readResource(ref, texture),
    (error: unknown) => {
      assert.ok(error instanceof ResourceNotFoundError);
      assert.equal(error.path, ref.path);
      assert.equal(error.fileName, ress.path);
      assert.ok(error.message.includes(ref.path), error.message);
      return true;
    },
  );
});

test("readResource() refuses an empty path: the data is inline, there is no file", () => {
  const env = load([{ name: TEXTURE, data: loadFixture(TEXTURE) }]);
  const { texture } = streamedTexture(env);
  assert.throws(
    () => env.readResource({ path: "", offset: 0, size: 0 }, texture),
    ResourceNotFoundError,
  );
});

test("readResource() reads up to the last byte and refuses a range past it", () => {
  const env = load([{ name: TEXTURE, data: loadFixture(TEXTURE) }]);
  const { texture, ref } = streamedTexture(env);
  const { path, data } = textureNodes().ress;
  const at = (offset: number, size: number): ResourceRef => ({ path: ref.path, offset, size });

  assert.deepEqual(env.readResource(at(data.length - 1, 1), texture), data.subarray(-1));
  assert.equal(env.readResource(at(data.length, 0), texture).length, 0);
  for (const [offset, size] of [
    [1, data.length],
    [data.length, 1],
    [data.length + 1, 0],
  ] as const) {
    assert.throws(
      () => env.readResource(at(offset, size), texture),
      (error: unknown) =>
        error instanceof CorruptError &&
        error.message.startsWith(`${path}: `) &&
        error.message.includes(`${offset}+${size}`) &&
        error.message.includes(`${data.length} bytes`),
      `${offset}+${size}`,
    );
  }
});

test("readResource() refuses an offset or size a number cannot hold exactly (D9)", () => {
  const env = load([{ name: TEXTURE, data: loadFixture(TEXTURE) }]);
  const { texture, ref } = streamedTexture(env);
  const cases: [number, number][] = [[-1, 1], [0, -1], [2 ** 53, 0], [0, 2 ** 53], [0.5, 1]];
  for (const [offset, size] of cases) {
    assert.throws(
      () => env.readResource({ path: ref.path, offset, size }, texture),
      RangeError,
      `${offset}+${size}`,
    );
  }
});

test("readResource() refuses an object another env loaded", () => {
  const { texture, ref } = streamedTexture(load([{ name: TEXTURE, data: loadFixture(TEXTURE) }]));
  const other = load([{ name: TEXTURE, data: loadFixture(TEXTURE) }]);
  assert.throws(() => other.readResource(ref, texture), /was not loaded by this env/);
});

test("readResource() reads each bundle's own .resS when two share a name, in either order", () => {
  // A second build of the texture bundle: same node names, other `.resS`
  // bytes - what two builds of one asset loaded together look like.
  const { cab, ress } = textureNodes();
  const other = payload(ress.data.length, 5);
  const inputs = [
    { name: "real.bundle", data: loadFixture(TEXTURE) },
    { name: "rebuilt.bundle", data: buildBundle([cab, { path: ress.path, data: other }]) },
  ];

  for (const order of [inputs, [...inputs].reverse()]) {
    const env = load(order);
    const read = streamedTextures(env).map(({ texture, ref }) => env.readResource(ref, texture));
    const expected = order[0]!.name === "real.bundle" ? [ress.data, other] : [other, ress.data];
    assert.deepEqual(read, expected);
  }
});

test("readResource() prefers its own bundle's .resS over a same-named input loaded first", () => {
  const { ress } = textureNodes();
  const env = load([
    { name: ress.path, data: payload(ress.data.length, 5) },
    { name: TEXTURE, data: loadFixture(TEXTURE) },
  ]);
  const { texture, ref } = streamedTexture(env);
  assert.deepEqual(env.readResource(ref, texture), ress.data);
});

test("readResource() takes the first one loaded when its own container has none", () => {
  const { cab, ress } = textureNodes();
  const first = payload(ress.data.length, 5);
  const env = load([
    { name: "cab-only.bundle", data: buildBundle([cab]) },
    { name: "a.bundle", data: buildBundle([{ path: ress.path, data: first }]) },
    { name: "b.bundle", data: buildBundle([{ path: ress.path, data: ress.data }]) },
  ]);
  const { texture, ref } = streamedTexture(env);
  assert.deepEqual(env.readResource(ref, texture), first);
});
