import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import {
  assertMatchesGolden,
  fixtureNames,
  golden,
  loadFixture,
} from "../../../fixtures/helpers.js";
import { NodeFlags } from "../src/bundle/BundleFile.js";
import { load } from "../src/env.js";
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

test("a SerializedFile of format 7 or later keeps its own version inside any bundle", () => {
  const node = load([{ name: SHARED, data: loadFixture(SHARED) }]).files[0]!.data;
  const own = readSerializedFile(node).version;
  assert.deepEqual(own, [6000, 3, 25, 1]);

  const bundle = buildBundle([{ path: SHARED_CAB, data: node }], "2.6.1f3");
  const { objects } = load([{ name: "old.bundle", data: bundle }]);
  assert.ok(objects.length > 0);
  for (const object of objects) assert.deepEqual(object.version, own);
});

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
