import assert from "node:assert/strict";
import { test } from "node:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";

import { gunzipSync as fflateGunzipSync } from "fflate";

import { golden, loadFixture, sha256 } from "../../../fixtures/helpers.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { brotliDecompress, gunzip, lzhamDecompress, unzlib } from "../src/codec/inflate.js";

/**
 * Vectors are compressed here with `node:zlib` - an implementation independent
 * of the one under test - so a round-trip proves interoperability rather than
 * self-consistency. Test-only `node:*` never reaches `src/` (R4).
 */
const VECTORS: [name: string, data: Uint8Array][] = [
  ["empty", new Uint8Array(0)],
  ["one byte", Uint8Array.of(0x55)],
  ["short ascii", new TextEncoder().encode("UnityFS 5.x.x")],
  ["64 KiB of zeros", new Uint8Array(65536)],
  ["64 KiB pseudo-random", pseudoRandom(65536)],
];

/** Deterministic, badly compressible bytes from a fixed-seed 32-bit LCG. */
function pseudoRandom(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = 0x1234abcd;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

const gzipped = (data: Uint8Array) => new Uint8Array(gzipSync(data));
const zlibbed = (data: Uint8Array) => new Uint8Array(deflateSync(data));

/** Same bytes with one byte inverted, so the stream stays structurally plausible. */
function flipByte(data: Uint8Array, index: number): Uint8Array {
  const copy = data.slice();
  copy[index]! ^= 0xff;
  return copy;
}

for (const [name, data] of VECTORS) {
  test(`gunzip round-trips ${name}`, () => {
    assert.deepStrictEqual(gunzip(gzipped(data)), data);
  });

  test(`unzlib round-trips ${name}`, () => {
    assert.deepStrictEqual(unzlib(zlibbed(data)), data);
  });
}

test("gunzip unwraps the real gzip-wrapped bundle fixture", () => {
  const name = "gzip-lz4.bundle.gz";
  const inner = gunzip(loadFixture(name));

  // The oracle does not unwrap gzip around a bundle (fixtures/README.md), so
  // the golden describes what is inside: the same UnityFS bundle as lz4.bundle.
  assert.match(golden(name).oracleNote ?? "", /gunzipped with stdlib/);
  assert.strictEqual(new TextDecoder().decode(inner.subarray(0, 7)), "UnityFS");
  assert.strictEqual(sha256(inner), sha256(loadFixture("lz4.bundle")));
  assert.deepStrictEqual(golden(name).files, golden("lz4.bundle").files);
});

test("gunzip rejects a stream that is not gzip, naming the magic it found", () => {
  const notGzip = new Uint8Array(32).fill(0x42);
  assert.throws(() => gunzip(notGzip), (error: unknown) => {
    assert.ok(error instanceof CorruptError);
    assert.match(error.message, /not a gzip stream: magic 4242, expected 1f8b/);
    return true;
  });
});

test("gunzip rejects input too short to hold a header and trailer", () => {
  assert.throws(() => gunzip(Uint8Array.of(0x1f, 0x8b, 0x08)), CorruptError);
});

test("gunzip rejects truncated streams at every stage", () => {
  const full = gzipped(pseudoRandom(8192));
  // 18 bytes is header plus trailer: past the length guard, no deflate data.
  for (const cut of [18, Math.floor(full.length / 2), full.length - 1]) {
    assert.throws(() => gunzip(full.subarray(0, cut)), CorruptError, `cut at ${cut}`);
  }
});

test("gunzip rejects a corrupted deflate payload instead of returning garbage", () => {
  // fflate inflates this one without complaint and returns wrong bytes of the
  // right length; only the CRC32 trailer catches it (R9).
  const full = gzipped(pseudoRandom(4096));
  const bad = flipByte(full, 15);
  assert.doesNotThrow(() => fflateGunzipSync(bad), "vector no longer exercises the CRC path");
  assert.throws(() => gunzip(bad), (error: unknown) => {
    assert.ok(error instanceof CorruptError);
    assert.match(error.message, /CRC32 0x[0-9a-f]{8} does not match the trailer's 0x[0-9a-f]{8}/);
    return true;
  });
});

test("gunzip rejects a trailer whose length disagrees with the output", () => {
  const full = gzipped(pseudoRandom(4096));
  const bad = full.slice();
  bad[bad.length - 1]! ^= 0x01; // ISIZE is the last four bytes, little-endian
  assert.throws(() => gunzip(bad), (error: unknown) => {
    assert.ok(error instanceof CorruptError);
    assert.match(error.message, /gzip wrote 4096 bytes but its trailer expected \d+/);
    return true;
  });
});

test("unzlib rejects input too short to hold a header and trailer", () => {
  assert.throws(() => unzlib(Uint8Array.of(0x78, 0x9c, 0x03)), CorruptError);
});

test("unzlib rejects truncated streams, including the one fflate empties", () => {
  const full = zlibbed(pseudoRandom(8192));
  // Cut to six bytes fflate returns zero bytes rather than throwing; the
  // Adler-32 check is what turns that into a CorruptError (R9).
  for (const cut of [6, Math.floor(full.length / 2), full.length - 1]) {
    assert.throws(() => unzlib(full.subarray(0, cut)), CorruptError, `cut at ${cut}`);
  }
});

test("unzlib rejects a corrupted deflate payload instead of returning garbage", () => {
  const full = zlibbed(pseudoRandom(4096));
  const bad = flipByte(full, Math.floor(full.length / 2));
  assert.throws(() => unzlib(bad), (error: unknown) => {
    assert.ok(error instanceof CorruptError);
    assert.match(error.message, /Adler-32 0x[0-9a-f]{8} does not match the trailer's/);
    return true;
  });
});

test("unzlib rejects a stream with a broken zlib header", () => {
  const bad = flipByte(zlibbed(pseudoRandom(1024)), 0);
  assert.throws(() => unzlib(bad), CorruptError);
});

test("brotli input throws UnsupportedError naming brotli", () => {
  const brotli = new Uint8Array(brotliCompressSync(pseudoRandom(1024)));
  assert.throws(() => brotliDecompress(brotli), (error: unknown) => {
    assert.ok(error instanceof UnsupportedError);
    assert.ok(!(error instanceof CorruptError));
    assert.strictEqual(error.kind, "compression type");
    assert.strictEqual(error.found, "brotli");
    assert.match(error.message, /unsupported compression type: brotli \(.+open an issue.*\)/);
    return true;
  });
});

test("LZHAM input throws UnsupportedError naming LZHAM", () => {
  // No LZHAM encoder exists here; a block of one is all a caller would hand over.
  assert.throws(() => lzhamDecompress(pseudoRandom(64)), (error: unknown) => {
    assert.ok(error instanceof UnsupportedError);
    assert.strictEqual(error.found, "LZHAM");
    assert.match(error.message, /unsupported compression type: LZHAM \(.+\)/);
    return true;
  });
});
