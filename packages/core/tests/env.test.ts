import assert from "node:assert/strict";
import { test } from "node:test";

import { assertMatchesGolden, fixtureNames, loadFixture } from "../../../fixtures/helpers.js";
import { NodeFlags } from "../src/bundle/BundleFile.js";
import { load } from "../src/env.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";

/** Deterministic opaque bytes, so a failure names a byte rather than a seed. */
function payload(length: number, step = 7): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * step + 3) & 0xff);
}

// --- every M1 fixture against the oracle goldens -----------------------------

for (const name of fixtureNames()) {
  test(`load() unpacks ${name} byte-identically to the golden`, () => {
    assertMatchesGolden(name, load([{ name, data: loadFixture(name) }]).files);
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
 * A SerializedFile has no magic: detection accepts a header whose recorded size
 * is exactly the bytes handed over. Format version 21 keeps the 32-bit fields.
 */
function serializedFile(length: number): Uint8Array {
  const data = new Uint8Array(length);
  const view = new DataView(data.buffer);
  view.setUint32(0, 12); // m_MetadataSize, read but never checked
  view.setUint32(4, length); // m_FileSize
  view.setUint32(8, 21); // m_Version
  view.setUint32(12, 20); // m_DataOffset
  return data;
}

test("keeps a SerializedFile input under its own name, unparsed (M2 reads it)", () => {
  const data = serializedFile(32);
  assert.deepEqual(load([{ name: "CAB-loose", data }]).files, [{ path: "CAB-loose", data }]);
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
function buildBundle(files: { path: string; data: Uint8Array }[]): Uint8Array {
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

  const header = new Writer().cstring("UnityFS").u32be(6).cstring("5.x.x").cstring("2022.3.0f1");
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
