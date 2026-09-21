import assert from "node:assert/strict";
import { test } from "node:test";

import { assertMatchesGolden, loadFixture, type StreamFile } from "../../../fixtures/helpers.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { lzmaDecompress } from "../src/codec/lzma.js";

const hex = (text: string): Uint8Array =>
  Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16));

/**
 * Vectors from CPython's `lzma` module (liblzma), compressed as
 * `FORMAT_RAW` + `FILTER_LZMA1` with `dict_size=0x800000` - the same filter
 * UnityPy's writer uses - and recorded here as `props ++ bitstream`. The
 * payload is `("unity-asset-reader/" * 40)[:512]`.
 */
const PAYLOAD = Uint8Array.from({ length: 512 }, (_, i) =>
  "unity-asset-reader/".charCodeAt(i % 19),
);
const PROPS_5D = hex("5d00008000");
const STREAM_5D = hex(
  "003a9b8962453cf15ddc94ba6c46122fe93c3fc99e5ef5d7b185414bffffeb3b0000",
);
/** The same payload at `lc 0, lp 0, pb 3` - properties byte 135, legal LZMA. */
const PROPS_PB3 = hex("8700008000");
const STREAM_PB3 = hex(
  "003a9bfc40ca6a9d13ad7f559fd0b18be816356c508a9dc24535d067ffff40f80000",
);
/** An empty payload: a real stream that decodes to zero bytes. */
const STREAM_EMPTY = hex("0083fffbffffc0000000");

test("decodes a stream whose properties Unity always writes (0x5d: lc3/lp0/pb2)", () => {
  assert.deepEqual(lzmaDecompress(PROPS_5D, STREAM_5D, PAYLOAD.length), PAYLOAD);
});

test("decodes a zero-byte stream", () => {
  assert.deepEqual(lzmaDecompress(PROPS_5D, STREAM_EMPTY, 0), new Uint8Array(0));
});

test("does not read or write outside the buffers it was given", () => {
  const backing = new Uint8Array(STREAM_5D.length + 16).fill(0xee);
  const data = backing.subarray(8, 8 + STREAM_5D.length);
  data.set(STREAM_5D);
  assert.deepEqual(lzmaDecompress(PROPS_5D, data, PAYLOAD.length), PAYLOAD);
  assert.equal(backing[7], 0xee);
  assert.equal(backing[backing.length - 1], 0xee);
});

// --- The two Unity stream shapes, on committed fixtures --------------------
//
// BundleFile (#17) is not written yet, so these tests walk just enough of each
// container to reach its LZMA streams. Both parsers go away when `load()` lands
// and this file keeps only the codec-level tests above.

class Cursor {
  private pos = 0;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  seek(pos: number): void {
    this.pos = pos;
  }

  /** Null-terminated ASCII, as Unity writes signatures and version strings. */
  stringToNull(): string {
    let out = "";
    while (this.data[this.pos] !== 0) out += String.fromCharCode(this.data[this.pos++] as number);
    this.pos++;
    return out;
  }

  u16(): number {
    const value = this.view.getUint16(this.pos);
    this.pos += 2;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.pos);
    this.pos += 4;
    return value;
  }

  i64(): number {
    const value = this.view.getBigInt64(this.pos);
    this.pos += 8;
    return Number(value);
  }

  bytes(count: number): Uint8Array {
    const out = this.data.subarray(this.pos, this.pos + count);
    this.pos += count;
    return out;
  }
}

/** `props ++ bitstream` as a UnityFS block stores it: no size in the stream. */
const unpackBlock = (block: Uint8Array, uncompressedSize: number): Uint8Array =>
  lzmaDecompress(block.subarray(0, 5), block.subarray(5), uncompressedSize);

test("decodes the LZMA blocks-info and data blocks of a UnityFS bundle", () => {
  const cursor = new Cursor(loadFixture("lzma.bundle"));
  assert.equal(cursor.stringToNull(), "UnityFS");
  cursor.u32(); // format version
  cursor.stringToNull(); // unityVersion
  cursor.stringToNull(); // unityRevision
  cursor.i64(); // archive size
  const compressedInfoSize = cursor.u32();
  const uncompressedInfoSize = cursor.u32();
  const flags = cursor.u32();
  assert.equal(flags & 0x3f, 1, "fixture should use LZMA for its blocks info");

  // Shape 1, first use: the blocks info itself is an LZMA block.
  const blocksInfo = new Cursor(
    unpackBlock(cursor.bytes(compressedInfoSize), uncompressedInfoSize),
  );
  blocksInfo.bytes(16); // uncompressed data hash

  const blockCount = blocksInfo.u32();
  const blocks = Array.from({ length: blockCount }, () => ({
    uncompressedSize: blocksInfo.u32(),
    compressedSize: blocksInfo.u32(),
    flags: blocksInfo.u16(),
  }));
  assert.ok(
    blocks.every((block) => (block.flags & 0x3f) === 1),
    "fixture should use LZMA for its data blocks",
  );

  // Shape 1, second use: every data block, concatenated into the blocks stream.
  const blob = new Uint8Array(blocks.reduce((sum, block) => sum + block.uncompressedSize, 0));
  let written = 0;
  for (const block of blocks) {
    blob.set(unpackBlock(cursor.bytes(block.compressedSize), block.uncompressedSize), written);
    written += block.uncompressedSize;
  }

  const nodeCount = blocksInfo.u32();
  const files: StreamFile[] = Array.from({ length: nodeCount }, () => {
    const offset = blocksInfo.i64();
    const size = blocksInfo.i64();
    blocksInfo.u32(); // node flags
    return { path: blocksInfo.stringToNull(), data: blob.subarray(offset, offset + size) };
  });

  assertMatchesGolden("lzma.bundle", files);
});

test("decodes the LZMA level of a legacy UnityWeb bundle", () => {
  const cursor = new Cursor(loadFixture("unityweb-lzma.bundle"));
  assert.equal(cursor.stringToNull(), "UnityWeb");
  const formatVersion = cursor.u32();
  cursor.stringToNull(); // unityVersion
  cursor.stringToNull(); // unityRevision
  cursor.u32(); // minimum streamed bytes
  const headerSize = cursor.u32();
  cursor.u32(); // levels to download before streaming
  const levelCount = cursor.u32();
  const levels = Array.from({ length: levelCount }, () => ({
    compressedSize: cursor.u32(),
    uncompressedSize: cursor.u32(),
  }));
  assert.equal(formatVersion, 3);

  // Shape 2: the level's stream carries its own 13-byte header, so the u64 size
  // is read out of it rather than taken from the level record.
  cursor.seek(headerSize);
  const level = levels[levelCount - 1]!;
  const stream = cursor.bytes(level.compressedSize);
  const declaredSize = new DataView(
    stream.buffer,
    stream.byteOffset,
    stream.byteLength,
  ).getBigUint64(5, true);
  assert.equal(declaredSize, BigInt(level.uncompressedSize));

  const blob = lzmaDecompress(stream.subarray(0, 5), stream.subarray(13), Number(declaredSize));

  const blocksStream = new Cursor(blob);
  const nodeCount = blocksStream.u32();
  const files: StreamFile[] = Array.from({ length: nodeCount }, () => {
    const path = blocksStream.stringToNull();
    const offset = blocksStream.u32();
    const size = blocksStream.u32();
    return { path, data: blob.subarray(offset, offset + size) };
  });

  assertMatchesGolden("unityweb-lzma.bundle", files);
});

// --- Unhappy paths ---------------------------------------------------------

test("rejects a truncated stream, which lzma1 decodes into garbage instead (R9)", () => {
  // The #13 spike fed lzma1 a 100 KB slice of a 26 MB stream and got 52 MB of
  // garbage back, with no error and a length *above* the declared size. Only
  // the length check here turns that into a failure.
  assert.throws(
    () => lzmaDecompress(PROPS_5D, STREAM_5D.subarray(0, 12), PAYLOAD.length),
    (error: unknown) =>
      error instanceof CorruptError &&
      /LZMA decompression error, write \d+ bytes but expected 512 bytes/.test(String(error)),
  );
});

test("rejects an uncompressedSize the stream does not expand to", () => {
  assert.throws(
    () => lzmaDecompress(PROPS_5D, STREAM_5D, 1024),
    (error: unknown) =>
      error instanceof CorruptError &&
      error.message === "LZMA decompression error, write 512 bytes but expected 1024 bytes",
  );
});

test("rejects an uncompressedSize smaller than the stream expands to", () => {
  assert.throws(
    () => lzmaDecompress(PROPS_5D, STREAM_5D, 100),
    (error: unknown) =>
      error instanceof CorruptError && /but expected 100 bytes/.test(String(error)),
  );
});

test("reports a stream lzma1 itself rejects as a CorruptError", () => {
  assert.throws(
    () => lzmaDecompress(PROPS_5D, new Uint8Array(0), 512),
    (error: unknown) =>
      error instanceof CorruptError &&
      /LZMA stream of 0 bytes failed to decode: corrupted input/.test(String(error)),
  );
});

test("rejects an uncompressedSize that is not a byte count, as CorruptError (R9)", () => {
  for (const size of [2 ** 53, -1, Infinity, NaN, 1.5]) {
    assert.throws(
      () => lzmaDecompress(PROPS_5D, STREAM_5D, size),
      (error: unknown) =>
        error instanceof CorruptError &&
        error.message === `LZMA uncompressed size ${size} is not a byte count`,
      `size ${size} should be rejected as CorruptError`,
    );
  }
});

test("rejects properties that are not exactly five bytes", () => {
  for (const props of [hex(""), hex("5d000080"), hex("5d0000800000")]) {
    assert.throws(
      () => lzmaDecompress(props, STREAM_5D, PAYLOAD.length),
      (error: unknown) =>
        error instanceof CorruptError &&
        error.message === `LZMA properties are ${props.length} bytes, expected 5`,
    );
  }
});

test("rejects a properties byte that is not a legal lc/lp/pb triple", () => {
  // 225 and up decode to pb 5, which the format does not have.
  assert.throws(
    () => lzmaDecompress(hex("e100008000"), STREAM_5D, PAYLOAD.length),
    (error: unknown) =>
      error instanceof CorruptError &&
      error.message ===
        "LZMA properties byte 0xe1 is above the largest legal value 0xe0 (lc 8, lp 4, pb 4)",
  );
});

test("refuses a legal properties byte of 0x80 or more instead of running lzma1 out of memory", () => {
  // 0x87 is lc0/lp0/pb3: legal LZMA that liblzma round-trips, but lzma1 reads
  // the byte signed, derives a negative pb, and then grows its output buffer
  // until the heap dies. Without this guard the call never returns.
  assert.throws(
    () => lzmaDecompress(PROPS_PB3, STREAM_PB3, PAYLOAD.length),
    (error: unknown) =>
      error instanceof UnsupportedError &&
      error.kind === "LZMA properties byte" &&
      error.found === "0x87 (lc 0, lp 0, pb 3)",
  );
  // Same guard, at the top of the legal range (0xe0 = lc8/lp4/pb4).
  assert.throws(
    () => lzmaDecompress(hex("e000008000"), STREAM_5D, PAYLOAD.length),
    (error: unknown) =>
      error instanceof UnsupportedError && error.found === "0xe0 (lc 8, lp 4, pb 4)",
  );
});
