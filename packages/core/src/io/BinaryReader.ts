// Ported from AssetStudio/EndianBinaryReader.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError } from "../errors.js";

/**
 * Byte order of multi-byte values.
 *
 * Unity's own containers are big-endian by default; `SerializedFile` flips the
 * reader to little-endian mid-file from its `m_Endianess` byte, which is why
 * {@link BinaryReader.endian} is writable rather than fixed at construction.
 */
export type Endian = "big" | "little";

/** Upstream `ReadStringToNull`'s cap on a C string, in bytes. */
const MAX_C_STRING = 32767;

/**
 * WHATWG `TextDecoder`, declared here because the package compiles with
 * `lib: ["ES2020"]` and no DOM or node types (R4). It is a platform global in
 * browsers, workers, Deno and Node >= 11, so declaring it locally keeps the
 * package isomorphic without widening `lib` to DOM.
 */
declare const TextDecoder: {
  new (label?: string): { decode(input?: Uint8Array): string };
};

let utf8: { decode(input?: Uint8Array): string } | undefined;

/** UTF-8 decode with U+FFFD replacement, matching C# `Encoding.UTF8.GetString`. */
function decodeUtf8(bytes: Uint8Array): string {
  if (!utf8) utf8 = new TextDecoder("utf-8");
  return utf8.decode(bytes);
}

/**
 * Cursor over a `Uint8Array` that reads Unity's primitive types in either byte
 * order.
 *
 * Sync and isomorphic (D3/D4): no streams, no copies on the read path. Bytes
 * come back as `subarray` views that alias the input buffer (R7), so a caller
 * that needs to keep them past the lifetime of the input must copy them.
 *
 * 64-bit integers are always `bigint` (D9). Offsets and sizes are `number`, and
 * anything that cannot be a `number` exactly - 2^53 and above - throws rather
 * than silently losing precision.
 *
 * Two error types, split by who is at fault: a `RangeError` means the argument
 * is not a usable offset or size at all (negative, fractional, 2^53 and above),
 * which no integer read can produce; a {@link CorruptError} means the number is
 * fine but the bytes are not there.
 *
 * @example
 * const reader = new BinaryReader(bytes, "big");
 * const signature = reader.readStringToNull();  // "UnityFS"
 * const version = reader.readUInt32();
 */
export class BinaryReader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private offset = 0;
  private little: boolean;

  /**
   * @param data bytes to read; kept by reference, never copied
   * @param endian initial byte order, big-endian like upstream's default
   */
  constructor(data: Uint8Array, endian: Endian = "big") {
    this.bytes = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.little = endian === "little";
  }

  /** Byte order used by every multi-byte read; assignable mid-file. */
  get endian(): Endian {
    return this.little ? "little" : "big";
  }

  set endian(value: Endian) {
    this.little = value === "little";
  }

  /**
   * Offset of the next byte to read.
   *
   * @throws {RangeError} when set to something that is not a usable offset at
   * all: negative, fractional, or 2^53 and above, which a `number` cannot hold
   * exactly (D9)
   * @throws {CorruptError} when the offset is a fine number but points past the
   * end of the data
   */
  get position(): number {
    return this.offset;
  }

  set position(value: number) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        `offset ${value} is not a whole number in 0..2^53; offsets and sizes are numbers (D9)`,
      );
    }
    if (value > this.bytes.length) {
      throw new CorruptError(`offset ${value} is past the end of ${this.bytes.length} bytes`);
    }
    this.offset = value;
  }

  /** Total number of bytes available to this reader. */
  get length(): number {
    return this.bytes.length;
  }

  /** Bytes between {@link position} and the end. */
  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  /** Reads one unsigned byte. @throws {CorruptError} past the end */
  readUInt8(): number {
    return this.view.getUint8(this.take(1));
  }

  /** Reads one signed byte. @throws {CorruptError} past the end */
  readInt8(): number {
    return this.view.getInt8(this.take(1));
  }

  /** Reads a 16-bit unsigned integer. @throws {CorruptError} past the end */
  readUInt16(): number {
    return this.view.getUint16(this.take(2), this.little);
  }

  /** Reads a 16-bit signed integer. @throws {CorruptError} past the end */
  readInt16(): number {
    return this.view.getInt16(this.take(2), this.little);
  }

  /** Reads a 32-bit unsigned integer. @throws {CorruptError} past the end */
  readUInt32(): number {
    return this.view.getUint32(this.take(4), this.little);
  }

  /** Reads a 32-bit signed integer. @throws {CorruptError} past the end */
  readInt32(): number {
    return this.view.getInt32(this.take(4), this.little);
  }

  /**
   * Reads a 64-bit unsigned integer as `bigint` (D9), exact above 2^53.
   *
   * @throws {CorruptError} past the end
   */
  readUInt64(): bigint {
    return this.view.getBigUint64(this.take(8), this.little);
  }

  /**
   * Reads a 64-bit signed integer as `bigint` (D9), exact above 2^53.
   *
   * @throws {CorruptError} past the end
   */
  readInt64(): bigint {
    return this.view.getBigInt64(this.take(8), this.little);
  }

  /** Reads a 32-bit float. @throws {CorruptError} past the end */
  readFloat32(): number {
    return this.view.getFloat32(this.take(4), this.little);
  }

  /** Reads a 64-bit float. @throws {CorruptError} past the end */
  readFloat64(): number {
    return this.view.getFloat64(this.take(8), this.little);
  }

  /**
   * Reads `count` bytes as a zero-copy view aliasing the input buffer (R7).
   *
   * Writing through the returned view writes through to the input, and the view
   * keeps the whole input buffer alive; copy it if you need either avoided.
   *
   * @param count how many bytes to take
   * @returns a `subarray`, never a `slice`
   * @throws {RangeError} when `count` is negative or not an integer below 2^53
   * @throws {CorruptError} when fewer than `count` bytes remain
   */
  readBytes(count: number): Uint8Array {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError(`byte count ${count} is not an integer in 0..2^53`);
    }
    const start = this.take(count);
    return this.bytes.subarray(start, start + count);
  }

  /**
   * Reads `count` bytes as UTF-8 text, without a terminator or a length prefix
   * (upstream `Encoding.UTF8.GetString(reader.ReadBytes(count))`).
   *
   * Used by the containers that store a path as an explicit length followed by
   * that many bytes, such as `WebFile`.
   *
   * @param count how many bytes of text to take
   * @throws {RangeError} when `count` is negative or not an integer below 2^53
   * @throws {CorruptError} when fewer than `count` bytes remain
   */
  readString(count: number): string {
    return decodeUtf8(this.readBytes(count));
  }

  /**
   * Skips padding up to the next multiple of `alignment` (upstream
   * `AlignStream`, default 4).
   *
   * Unlike upstream, which can leave a stream position past its end, this stops
   * at the end of the data: there is no padding beyond it, and the next read
   * reports the truncation instead.
   *
   * @param alignment boundary in bytes, positive
   * @throws {RangeError} when `alignment` is not a positive integer
   */
  align(alignment = 4): void {
    if (!Number.isInteger(alignment) || alignment < 1) {
      throw new RangeError(`alignment ${alignment} is not a positive integer`);
    }
    const mod = this.offset % alignment;
    if (mod !== 0) {
      this.offset = Math.min(this.offset + (alignment - mod), this.bytes.length);
    }
  }

  /**
   * Reads Unity's length-prefixed string: an `Int32` byte count, that many
   * UTF-8 bytes, then padding to the next 4-byte boundary (upstream
   * `ReadAlignedString`).
   *
   * A length that is zero, negative or longer than what remains yields `""` and
   * still aligns, as upstream does - Unity writes such lengths for empty fields.
   *
   * @throws {CorruptError} when the length prefix itself runs past the end
   */
  readAlignedString(): string {
    const length = this.readInt32();
    let result = "";
    if (length > 0 && length <= this.remaining) {
      result = decodeUtf8(this.readBytes(length));
    }
    this.align(4);
    return result;
  }

  /**
   * Reads a NUL-terminated UTF-8 C string (upstream `ReadStringToNull`).
   *
   * The terminator is consumed when found. Hitting `maxLength` or the end of
   * the data stops without one, matching upstream rather than throwing.
   *
   * @param maxLength most bytes of text to accept, excluding the terminator
   * @returns the text, without the terminator
   */
  readStringToNull(maxLength = MAX_C_STRING): string {
    const start = this.offset;
    const limit = Math.min(this.bytes.length, start + Math.max(maxLength, 0));
    let end = start;
    while (end < limit && this.bytes[end] !== 0) end++;
    const text = decodeUtf8(this.bytes.subarray(start, end));
    this.offset = end < limit && this.bytes[end] === 0 ? end + 1 : end;
    return text;
  }

  /**
   * Reserves `size` bytes and advances past them.
   *
   * @returns the offset the caller should read from
   */
  private take(size: number): number {
    const start = this.offset;
    if (size > this.bytes.length - start) {
      throw new CorruptError(
        `read of ${size} bytes at offset ${start} runs past the end: ` +
          `${this.bytes.length - start} of ${this.bytes.length} bytes remain`,
      );
    }
    this.offset = start + size;
    return start;
  }
}
