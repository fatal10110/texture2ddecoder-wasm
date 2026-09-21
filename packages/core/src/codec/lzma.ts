// Ported from AssetStudio/SevenZipHelper.cs (MIT, © Perfare / RazTools / Razviar)

/**
 * LZMA (LZMA1, the `.lzma`/"alone" container) as Unity writes it.
 *
 * Unity stores LZMA in two shapes and this module decodes both through one
 * entry point, because the only difference is where the uncompressed size comes
 * from - the bit stream after it is identical:
 *
 * - **UnityFS block / blocks-info:** 5 property bytes + the raw bit stream. The
 *   size lives in the archive header, so the caller passes it in.
 * - **Legacy UnityWeb / UnityRaw:** 5 property bytes + a little-endian u64 size
 *   + the bit stream. The caller splits that 13-byte prefix itself and passes
 *   the three parts, exactly as `SevenZipHelper.StreamDecompress` does.
 *
 * Why `lzma1` and not an emscripten `LzmaDec.c`: the #13 spike measured
 * ~10 MB/s against a 20 MB/s bar, and the bar was retired rather than met - a
 * WASM decoder would put WASM in `packages/core`, which plan §2 forbids, and
 * would force an `await initialize()` before `load()`. Revisit through #69 if
 * real bundles make this hurt, not before.
 */

import { decompress } from "lzma1";

import { CorruptError, UnsupportedError } from "../errors.js";

/** 5 property bytes + the little-endian u64 uncompressed size. */
const HEADER_SIZE = 13;

/** Property bytes: the packed `lc`/`lp`/`pb` byte, then a u32 dictionary size. */
const PROPS_SIZE = 5;

/**
 * Largest valid packed properties byte: `(pb 4 * 5 + lp 4) * 9 + lc 8`. Above
 * this the byte does not decode to a legal `lc`/`lp`/`pb` triple at all.
 */
const MAX_PROPS_BYTE = 224;

/**
 * `lzma1` reads the properties byte through `b << 24 >> 24`, so anything from
 * 0x80 up arrives negative and its `lc`/`lp`/`pb` come out negative too. Its
 * `pb > 4` check passes, `(1 << -4) - 1` becomes a 28-bit mask, and the decoder
 * then runs away appending output until the heap dies. So reject those streams
 * here, before the library sees them: a 0x80+ byte is legal LZMA (`pb >= 3`,
 * e.g. 135 = lc0/lp0/pb3) that this decoder cannot read, not corrupt data.
 *
 * Unity's own compressor only ever emits 0x5d (lc3/lp0/pb2), so this throw is
 * not expected to fire on a stock bundle.
 */
const LZMA1_MAX_PROPS_BYTE = 0x7f;

/**
 * Decompress one LZMA1 bit stream into exactly `uncompressedSize` bytes.
 *
 * @param props5 the 5 LZMA property bytes, as they sit in the bundle
 * @param data the bit stream that follows them, without any size prefix
 * @param uncompressedSize size the stream must expand to, from the caller's header
 * @returns a new `Uint8Array` of exactly `uncompressedSize` bytes
 * @throws {CorruptError} when the properties are not a legal LZMA triple, the
 *   stream is malformed or truncated, or it does not expand to exactly
 *   `uncompressedSize` bytes
 * @throws {UnsupportedError} when the properties are legal but use a packed
 *   byte `lzma1` decodes incorrectly (0x80 and up)
 */
export function lzmaDecompress(
  props5: Uint8Array,
  data: Uint8Array,
  uncompressedSize: number,
): Uint8Array {
  // Same reasoning as the LZ4 decoder: a size out of range comes from a corrupt
  // header and has to leave as a CorruptError, not as an allocator RangeError,
  // so callers can still tell a broken file from a broken caller (R9).
  if (!Number.isSafeInteger(uncompressedSize) || uncompressedSize < 0) {
    throw new CorruptError(`LZMA uncompressed size ${uncompressedSize} is not a byte count`);
  }
  if (props5.length !== PROPS_SIZE) {
    throw new CorruptError(
      `LZMA properties are ${props5.length} bytes, expected ${PROPS_SIZE}`,
    );
  }

  const packed = props5[0] as number;
  if (packed > MAX_PROPS_BYTE) {
    throw new CorruptError(
      `LZMA properties byte ${hex8(packed)} is above the largest legal value ` +
        `${hex8(MAX_PROPS_BYTE)} (lc 8, lp 4, pb 4)`,
    );
  }
  if (packed > LZMA1_MAX_PROPS_BYTE) {
    const lc = packed % 9;
    const rest = Math.floor(packed / 9);
    throw new UnsupportedError(
      "LZMA properties byte",
      `${hex8(packed)} (lc ${lc}, lp ${rest % 5}, pb ${Math.floor(rest / 5)})`,
      "the bundled decoder only reads properties below 0x80; open an issue with a sample",
    );
  }

  // lzma1 takes one contiguous `.lzma` container, so the bit stream is copied
  // once behind a synthesized 13-byte header. That copy is the reason R7 says
  // subarray on the read path - there is nowhere else to spend it here.
  const container = new Uint8Array(HEADER_SIZE + data.length);
  container.set(props5);
  new DataView(container.buffer).setBigUint64(PROPS_SIZE, BigInt(uncompressedSize), true);
  container.set(data, HEADER_SIZE);

  let out: Uint8Array;
  try {
    out = decompress(container);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new CorruptError(
      `LZMA stream of ${data.length} bytes failed to decode: ${reason}`,
    );
  }

  // lzma1 stops at the declared size but can overrun it by up to one match, and
  // on a truncated stream it returns garbage instead of throwing - the #13 spike
  // got 52 MB of it from a 100 KB slice. So the length is checked here, not
  // trusted (R9). Wording follows AssetStudio's BundleFile.cs so the two can be
  // diffed; upstream truncates an overrun where this throws, which only differs
  // on a stream that encodes more data than its header declares.
  if (out.length !== uncompressedSize) {
    throw new CorruptError(
      `LZMA decompression error, write ${out.length} bytes but expected ${uncompressedSize} bytes`,
    );
  }
  return out;
}

function hex8(value: number): string {
  return `0x${value.toString(16).padStart(2, "0")}`;
}
