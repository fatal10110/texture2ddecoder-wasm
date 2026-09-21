import assert from "node:assert/strict";
import { test } from "node:test";

import { decompressLz4 } from "../src/codec/lz4.js";
import { CorruptError } from "../src/errors.js";

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

/** Splice literal bytes, ASCII strings and byte arrays into one buffer. */
const block = (...parts: Array<number | number[] | Uint8Array>): Uint8Array =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === "number" ? [part] : [...part])));

const hex = (text: string): Uint8Array =>
  Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16));

/**
 * LZ4 requires a block to end with a literals-only sequence, and the last match
 * to end at least 12 bytes before the output ends. Every crafted vector below
 * that contains a match therefore ends with this 12-literal sequence, which
 * keeps the vectors decodable by any conforming LZ4 implementation - they were
 * all checked against python-lz4 before being written down here.
 */
const TAIL = "tail-padding";
const TAIL_SEQ = [0xc0, ...ascii(TAIL)];

test("decodes a literals-only block", () => {
  // token 0x50: 5 literals, no match.
  assert.deepEqual(decompressLz4(block(0x50, ascii("hello")), 5), Uint8Array.from(ascii("hello")));
});

test("decodes an empty block", () => {
  assert.deepEqual(decompressLz4(new Uint8Array(0), 0), new Uint8Array(0));
});

test("decodes a non-overlapping match", () => {
  // token 0x84: 8 literals, match length 4 + 4; offset 8, so source and
  // destination of the match do not overlap.
  const decoded = decompressLz4(block(0x84, ascii("abcdefgh"), 0x08, 0x00, TAIL_SEQ), 28);
  assert.equal(String.fromCharCode(...decoded), `abcdefghabcdefgh${TAIL}`);
});

test("repeats a single byte through an overlapping match (offset 1)", () => {
  // token 0x16: 1 literal "A", match length 4 + 6 = 10, offset 1. The match
  // reads bytes it is writing, so it fills a run of "A". Copying the source
  // range in one go would instead splice in 10 bytes of the untouched buffer.
  const decoded = decompressLz4(block(0x16, 0x41, 0x01, 0x00, TAIL_SEQ), 23);
  assert.equal(String.fromCharCode(...decoded), `AAAAAAAAAAA${TAIL}`);
});

test("repeats a multi-byte pattern through an overlapping match (offset < length)", () => {
  // token 0x34: 3 literals "xyz", match length 4 + 4 = 8, offset 3.
  const decoded = decompressLz4(block(0x34, ascii("xyz"), 0x03, 0x00, TAIL_SEQ), 23);
  assert.equal(String.fromCharCode(...decoded), `xyzxyzxyzxy${TAIL}`);
});

test("extends a long literal run through 255-terminated continuation bytes", () => {
  // token 0xf0: literal nibble is 15, so the length continues in the next
  // bytes: 15 + 255 + 30 = 300.
  const literals = Uint8Array.from({ length: 300 }, (_, i) => (i * 7 + 3) & 0xff);
  assert.deepEqual(decompressLz4(block(0xf0, 0xff, 0x1e, literals), 300), literals);
});

test("keeps reading continuation bytes after a 0xff, even when the next one is 0", () => {
  // 15 + 255 + 0 = 270. Stopping at the 0xff would lose the trailing zero byte
  // and then misread the literals as a token.
  const literals = Uint8Array.from({ length: 270 }, (_, i) => (i * 11 + 5) & 0xff);
  assert.deepEqual(decompressLz4(block(0xf0, 0xff, 0x00, literals), 270), literals);
});

test("extends a long match length in the same sequence as a long literal run", () => {
  // token 0xff: both nibbles are 15. Literals 15 + 255 + 30 = 300, then offset
  // 0x012c = 300, then match length 15 + 255 + 26 + 4 = 300.
  const literals = Uint8Array.from({ length: 300 }, (_, i) => (i * 7 + 3) & 0xff);
  const decoded = decompressLz4(
    block(0xff, 0xff, 0x1e, literals, 0x2c, 0x01, 0xff, 0x1a, TAIL_SEQ),
    612,
  );
  assert.deepEqual(decoded.subarray(0, 300), literals);
  assert.deepEqual(decoded.subarray(300, 600), literals);
  assert.equal(String.fromCharCode(...decoded.subarray(600)), TAIL);
});

/**
 * A buffer built to make a real compressor emit every sequence shape at once:
 * a long literal run, long non-overlapping matches, and an offset-1 run.
 */
const sample = (): Uint8Array => {
  const prefix = Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff);
  const runOfZ: number[] = new Array(200).fill(0x5a);
  const tail = [...prefix.slice(0, 32), ...ascii("end-of-buffer.")];
  return block(prefix, prefix, prefix, prefix, runOfZ, tail);
};

test("round-trips a block produced by the reference LZ4 compressor", () => {
  // python-lz4 4.4.5: lz4.block.compress(sample, store_size=False).
  const compressed = hex(
    "ff310b30557a9fc4e90e33587da2c7ec11365b80a5caef14395e83a8cdf2173c6186abd0f51a3f64" +
      "89aed3f81d42678cb1d6fb20456a8fb4d9fe23486d92b7dc01264000ad1f5a0100b40f88010de065" +
      "6e642d6f662d6275666665722e",
  );
  assert.deepEqual(decompressLz4(compressed, 502), sample());
});

test("decodes an LZ4HC block through the same path", () => {
  // LZ4HC only changes how the compressor searches for matches; the block
  // format is identical, so there is no separate decoder (plan §1).
  // python-lz4: lz4.block.compress(sample, mode="high_compression", compression=12).
  const compressed = hex(
    "ff310b30557a9fc4e90e33587da2c7ec11365b80a5caef14395e83a8cdf2173c6186abd0f51a3f64" +
      "89aed3f81d42678cb1d6fb20456a8fb4d9fe23486d92b7dc01264000ad1f5a0100b40f08010de065" +
      "6e642d6f662d6275666665722e",
  );
  assert.deepEqual(decompressLz4(compressed, 502), sample());
});

test("rejects a block that ends mid-sequence", () => {
  // The two offset bytes of the match are cut off.
  assert.throws(
    () => decompressLz4(block(0x84, ascii("abcdefgh"), 0x08), 28),
    (error: unknown) => error instanceof CorruptError && /ends after 10 bytes/.test(String(error)),
  );
});

test("rejects a literal run that reaches past the end of the block", () => {
  // The token promises 5 literals but only 3 bytes follow.
  assert.throws(
    () => decompressLz4(block(0x50, ascii("hel")), 5),
    (error: unknown) =>
      error instanceof CorruptError && /literal run of 5 bytes .* 4-byte block/.test(String(error)),
  );
});

test("rejects a truncated continuation of a long length", () => {
  assert.throws(() => decompressLz4(block(0xf0, 0xff), 300), CorruptError);
});

test("rejects an uncompressedSize the block does not fill", () => {
  assert.throws(
    () => decompressLz4(block(0x50, ascii("hello")), 16),
    (error: unknown) =>
      error instanceof CorruptError &&
      error.message === "LZ4 decompression error, write 5 bytes but expected 16 bytes",
  );
});

test("rejects an uncompressedSize smaller than the block expands to", () => {
  assert.throws(
    () => decompressLz4(block(0x50, ascii("hello")), 3),
    (error: unknown) =>
      error instanceof CorruptError && /overflows the 3-byte output/.test(String(error)),
  );
});

test("rejects a match that overflows the declared output size", () => {
  // 8 literals then a 8-byte match, but only 12 bytes were declared.
  assert.throws(
    () => decompressLz4(block(0x84, ascii("abcdefgh"), 0x08, 0x00, TAIL_SEQ), 12),
    (error: unknown) =>
      error instanceof CorruptError && /match of 8 bytes at 8 overflows/.test(String(error)),
  );
});

test("rejects a match offset reaching before the start of the output", () => {
  // No literals yet, so an offset of 16 points outside the output buffer.
  assert.throws(
    () => decompressLz4(block(0x00, 0x10, 0x00), 8),
    (error: unknown) =>
      error instanceof CorruptError && /offset 16 reaches outside the 0 bytes/.test(String(error)),
  );
});

test("rejects a zero match offset", () => {
  assert.throws(
    () => decompressLz4(block(0x10, 0x41, 0x00, 0x00), 8),
    (error: unknown) =>
      error instanceof CorruptError && /offset 0 reaches outside/.test(String(error)),
  );
});

test("does not read or write outside the buffers it was given", () => {
  const backing = new Uint8Array(32).fill(0xee);
  const src = backing.subarray(8, 8 + 6);
  src.set(block(0x50, ascii("hello")));
  const decoded = decompressLz4(src, 5);
  assert.deepEqual(decoded, Uint8Array.from(ascii("hello")));
  assert.equal(backing[7], 0xee);
  assert.equal(backing[14], 0xee);
});
