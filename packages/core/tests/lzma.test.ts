import assert from "node:assert/strict";
import { test } from "node:test";

import { assertMatchesGolden, loadFixture, type StreamFile } from "../../../fixtures/helpers.js";
import { readBundle } from "../src/bundle/BundleFile.js";
import { lzmaDecompress } from "../src/codec/lzma.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";

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

test("unpacks a UnityFS bundle whose blocks info and blocks are both LZMA", () => {
  // Shape 1, end to end: `readBundle` decompresses the blocks info and every
  // storage block through this codec. BundleFile.test.ts covers the same
  // fixture from the parser's side; this asserts it from the codec's.
  assertMatchesGolden("lzma.bundle", readBundle(loadFixture("lzma.bundle")).files);
});

test("decodes the LZMA level of a legacy UnityWeb bundle", () => {
  // Shape 2: the stream carries its own 13-byte header, so the u64 size is read
  // out of it instead of coming from the container. The legacy container parser
  // is #18's, so this walks the v3 header by hand - just far enough to reach
  // the one LZMA stream - and checks the unpacked nodes against the golden.
  const bundle = loadFixture("unityweb-lzma.bundle");
  const view = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
  let pos = 0;
  const stringToNull = (): string => {
    let out = "";
    while (bundle[pos] !== 0) out += String.fromCharCode(bundle[pos++] as number);
    pos++;
    return out;
  };
  const u32 = (): number => {
    const value = view.getUint32(pos);
    pos += 4;
    return value;
  };

  assert.equal(stringToNull(), "UnityWeb");
  assert.equal(u32(), 3, "fixture should be a format v3 legacy bundle");
  stringToNull(); // unityVersion
  stringToNull(); // unityRevision
  u32(); // minimum streamed bytes
  const headerSize = u32();
  u32(); // levels to download before streaming
  const levelCount = u32();
  // Upstream keeps only the last level; every level but the last is a prefix of it.
  let level = { compressedSize: 0, uncompressedSize: 0 };
  for (let i = 0; i < levelCount; i++) level = { compressedSize: u32(), uncompressedSize: u32() };

  const stream = bundle.subarray(headerSize, headerSize + level.compressedSize);
  const declaredSize = new DataView(
    stream.buffer,
    stream.byteOffset,
    stream.byteLength,
  ).getBigUint64(5, true);
  assert.equal(declaredSize, BigInt(level.uncompressedSize));

  const blob = lzmaDecompress(stream.subarray(0, 5), stream.subarray(13), Number(declaredSize));

  // The decompressed level is the directory: a node count, then path/offset/size.
  const blobView = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  pos = 0;
  const files: StreamFile[] = [];
  const nodeCount = blobView.getUint32(0);
  pos = 4;
  for (let i = 0; i < nodeCount; i++) {
    let path = "";
    while (blob[pos] !== 0) path += String.fromCharCode(blob[pos++] as number);
    pos++;
    const offset = blobView.getUint32(pos);
    const size = blobView.getUint32(pos + 4);
    pos += 8;
    files.push({ path, data: blob.subarray(offset, offset + size) });
  }

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
