/**
 * gzip (RFC 1952) and zlib (RFC 1950) wrappers, plus the two wrapper formats
 * Unity can emit that this library deliberately does not decode.
 *
 * Why `fflate` and not something built in: `node:zlib` is node-only (R4, core
 * is isomorphic) and the platform `DecompressionStream` is **async**, which
 * would pull `await` into the parse path (D4). Both are dead ends here - do not
 * "modernize" this module to either one.
 *
 * fflate inflates the deflate stream but ignores the trailing checksum, and on
 * some malformed inputs it hands back short or wrong output instead of throwing
 * (a flipped byte in the deflate stream, a zlib stream cut to its header). So
 * each entry point verifies the trailer itself: R9 - never return partial or
 * garbage bytes silently. That pass is not free: CRC32 runs at ~380 MiB/s
 * (~2.6 ms per MiB), and on already-incompressible data it dominates - 32 MiB
 * inflates in 2.0 ms and then spends 81.5 ms being checksummed.
 *
 * ponytail: byte-at-a-time CRC32 caps at ~380 MiB/s; a slice-by-8 table reaches
 * ~811 MiB/s with identical output if gzip-wrapped bundles ever get big enough
 * for it to matter.
 */

import { gunzipSync, unzlibSync } from "fflate";

import { CorruptError, UnsupportedError } from "../errors.js";

/** 10-byte header + 8-byte trailer; a gzip member cannot be shorter. */
const GZIP_MIN_SIZE = 18;
/** 2-byte header + 4-byte Adler-32 trailer. */
const ZLIB_MIN_SIZE = 6;

const SKIPPED_HINT = "no sync browser-safe decoder is bundled; decompress the file " +
  "before loading it, or open an issue with a sample";

/**
 * Decompress a gzip member and verify its trailer.
 *
 * @param data one complete gzip member (magic `1f 8b`), not a concatenation
 * @returns the decompressed bytes
 * @throws {CorruptError} bad magic, truncated input, a deflate stream fflate
 *   rejects, or a CRC32/length trailer that disagrees with the output
 */
export function gunzip(data: Uint8Array): Uint8Array {
  if (data.length < GZIP_MIN_SIZE) {
    throw new CorruptError(
      `gzip stream is ${data.length} bytes, too short for a header and trailer`,
    );
  }
  if (data[0] !== 0x1f || data[1] !== 0x8b) {
    throw new CorruptError(`not a gzip stream: magic ${magic(data)}, expected 1f8b`);
  }

  const out = inflateWith(() => gunzipSync(data), "gzip", data.length);

  // Trailer: CRC32 of the output, then ISIZE - its length modulo 2^32, which a
  // Uint8Array length can never exceed. Both little-endian.
  const trailer = new DataView(data.buffer, data.byteOffset + data.length - 8, 8);
  const expectedCrc = trailer.getUint32(0, true);
  const expectedSize = trailer.getUint32(4, true);

  if (out.length >>> 0 !== expectedSize) {
    throw new CorruptError(
      `gzip wrote ${out.length} bytes but its trailer expected ${expectedSize}`,
    );
  }
  const actualCrc = crc32(out);
  if (actualCrc !== expectedCrc) {
    throw new CorruptError(
      `gzip CRC32 ${hex32(actualCrc)} does not match the trailer's ${hex32(expectedCrc)}`,
    );
  }
  return out;
}

/**
 * Decompress a zlib stream and verify its Adler-32 trailer.
 *
 * @param data one complete zlib stream (RFC 1950 header, not raw deflate)
 * @returns the decompressed bytes
 * @throws {CorruptError} truncated input, a stream fflate rejects, or an
 *   Adler-32 trailer that disagrees with the output
 */
export function unzlib(data: Uint8Array): Uint8Array {
  if (data.length < ZLIB_MIN_SIZE) {
    throw new CorruptError(
      `zlib stream is ${data.length} bytes, too short for a header and trailer`,
    );
  }

  const out = inflateWith(() => unzlibSync(data), "zlib", data.length);

  // Trailer: Adler-32 of the output, big-endian (RFC 1950 §2.2).
  const expected = new DataView(data.buffer, data.byteOffset + data.length - 4, 4).getUint32(0);
  const actual = adler32(out);
  if (actual !== expected) {
    throw new CorruptError(
      `zlib Adler-32 ${hex32(actual)} does not match the trailer's ${hex32(expected)}`,
    );
  }
  return out;
}

/**
 * Brotli-compressed payload (Unity WebGL `.unityweb` builds). Not implemented:
 * the decision on record is to skip it and add a decoder only once this fires
 * on a real file.
 *
 * Takes the data it will not decode so a caller can dispatch to it like any
 * other codec.
 *
 * @throws {UnsupportedError} always, naming brotli
 */
export function brotliDecompress(_data: Uint8Array): never {
  throw new UnsupportedError("compression type", "brotli", SKIPPED_HINT);
}

/**
 * LZHAM-compressed bundle block (`CompressionType` 4). Not implemented, on the
 * same terms as {@link brotliDecompress}: Unity stopped emitting it and no
 * fixture exists, so a decoder waits until this throw is seen in the wild.
 *
 * @throws {UnsupportedError} always, naming LZHAM
 */
export function lzhamDecompress(_data: Uint8Array): never {
  throw new UnsupportedError("compression type", "LZHAM", SKIPPED_HINT);
}

/** Run one fflate call, reporting whatever it rejects as a {@link CorruptError}. */
function inflateWith(decode: () => Uint8Array, format: string, size: number): Uint8Array {
  try {
    return decode();
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new CorruptError(`${format} stream of ${size} bytes failed to inflate: ${reason}`);
  }
}

let crcTable: Uint32Array | undefined;

/** CRC32 (IEEE 802.3, the polynomial gzip uses), built on first use. */
function crc32(data: Uint8Array): number {
  let table = crcTable;
  if (!table) {
    table = crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i;
      for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[i] = value;
    }
  }

  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Adler-32 (RFC 1950 §9), the checksum zlib streams end with. */
function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; ) {
    // 5552 bytes is the longest run that cannot overflow the 32-bit sums.
    const end = Math.min(i + 5552, data.length);
    for (; i < end; i++) {
      a += data[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** First two bytes as hex, for a "this is not that format" message. */
function magic(data: Uint8Array): string {
  return [...data.subarray(0, 2)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hex32(value: number): string {
  return `0x${value.toString(16).padStart(8, "0")}`;
}
