import assert from "node:assert/strict";
import { test } from "node:test";

import { BinaryReader } from "../src/io/BinaryReader.js";
import { CorruptError } from "../src/errors.js";

/** Bytes from a hex string, so the expected encoding is visible in the test. */
const hex = (text: string): Uint8Array =>
  Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16));

/** UTF-8 bytes of `text`, encoded independently of the reader's own decoding. */
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

test("defaults to big-endian, like upstream EndianBinaryReader", () => {
  assert.equal(new BinaryReader(hex("1234")).endian, "big");
  assert.equal(new BinaryReader(hex("1234")).readUInt16(), 0x1234);
});

test("reads every fixed-width type big-endian", () => {
  const reader = new BinaryReader(
    hex("7f" + "ff" + "1234" + "fffe" + "12345678" + "fffffffe" + "3fc00000" + "c002000000000000"),
  );
  assert.equal(reader.readUInt8(), 0x7f);
  assert.equal(reader.readInt8(), -1);
  assert.equal(reader.readUInt16(), 0x1234);
  assert.equal(reader.readInt16(), -2);
  assert.equal(reader.readUInt32(), 0x12345678);
  assert.equal(reader.readInt32(), -2);
  assert.equal(reader.readFloat32(), 1.5);
  assert.equal(reader.readFloat64(), -2.25);
  assert.equal(reader.remaining, 0);
});

test("reads every fixed-width type little-endian", () => {
  const reader = new BinaryReader(
    hex("7f" + "ff" + "3412" + "feff" + "78563412" + "feffffff" + "0000c03f" + "00000000000002c0"),
    "little",
  );
  assert.equal(reader.readUInt8(), 0x7f);
  assert.equal(reader.readInt8(), -1);
  assert.equal(reader.readUInt16(), 0x1234);
  assert.equal(reader.readInt16(), -2);
  assert.equal(reader.readUInt32(), 0x12345678);
  assert.equal(reader.readInt32(), -2);
  assert.equal(reader.readFloat32(), 1.5);
  assert.equal(reader.readFloat64(), -2.25);
  assert.equal(reader.remaining, 0);
});

test("the endian switch applies to later reads (SerializedFile flips mid-file)", () => {
  const reader = new BinaryReader(hex("12341234"), "big");
  assert.equal(reader.readUInt16(), 0x1234);
  reader.endian = "little";
  assert.equal(reader.endian, "little");
  assert.equal(reader.readUInt16(), 0x3412);
});

test("single bytes ignore the endian setting", () => {
  for (const endian of ["big", "little"] as const) {
    const reader = new BinaryReader(hex("ff80"), endian);
    assert.equal(reader.readUInt8(), 255);
    assert.equal(reader.readInt8(), -128);
  }
});

test("64-bit integers come back as bigint in both endians (D9)", () => {
  // Each endian reads a negative i64 too, so the signed path cannot pass by
  // accident on a value that is identical read signed or unsigned.
  const big = new BinaryReader(
    hex("0020000000000001" + "7fffffffffffffff" + "8000000000000000" + "fffffffffffffffe"),
    "big",
  );
  assert.equal(big.readUInt64(), 9007199254740993n);
  assert.equal(big.readInt64(), 9223372036854775807n);
  assert.equal(big.readInt64(), -9223372036854775808n);
  assert.equal(big.readInt64(), -2n);

  const little = new BinaryReader(
    hex("0100000000002000" + "ffffffffffffff7f" + "0000000000000080" + "feffffffffffffff"),
    "little",
  );
  assert.equal(little.readUInt64(), 9007199254740993n);
  assert.equal(little.readInt64(), 9223372036854775807n);
  assert.equal(little.readInt64(), -9223372036854775808n);
  assert.equal(little.readInt64(), -2n);
});

test("64-bit edge values survive exactly", () => {
  const reader = new BinaryReader(
    hex("ffffffffffffffff" + "8000000000000000" + "ffffffffffffffff" + "0000000000000000"),
  );
  assert.equal(reader.readUInt64(), 18446744073709551615n);
  assert.equal(reader.readInt64(), -9223372036854775808n);
  assert.equal(reader.readInt64(), -1n);
  assert.equal(reader.readUInt64(), 0n);
});

test("bigint keeps precision a number would lose above 2^53", () => {
  const value = new BinaryReader(hex("0020000000000001")).readUInt64();
  assert.equal(value, 9007199254740993n);
  assert.notEqual(value, BigInt(Number(value)));
});

test("align(n) skips to the next boundary and is a no-op when already aligned", () => {
  const reader = new BinaryReader(new Uint8Array(32));
  reader.position = 1;
  reader.align(4);
  assert.equal(reader.position, 4);
  reader.align(4);
  assert.equal(reader.position, 4);
  reader.align(16);
  assert.equal(reader.position, 16);
  reader.position = 17;
  reader.align(8);
  assert.equal(reader.position, 24);
  reader.position = 3;
  reader.align();
  assert.equal(reader.position, 4, "default alignment is 4, like upstream AlignStream()");
});

test("align stops at the end instead of running past it", () => {
  const reader = new BinaryReader(new Uint8Array(6));
  reader.position = 5;
  reader.align(4);
  assert.equal(reader.position, 6);
});

test("align rejects a non-positive alignment", () => {
  const reader = new BinaryReader(new Uint8Array(8));
  assert.throws(() => reader.align(0), RangeError);
  assert.throws(() => reader.align(-4), RangeError);
  assert.throws(() => reader.align(1.5), RangeError);
});

test("reads a length-prefixed string and the padding after it", () => {
  const reader = new BinaryReader(concat(hex("00000006"), utf8("héllo"), hex("0000"), hex("2a")));
  assert.equal(reader.readAlignedString(), "héllo");
  assert.equal(reader.position, 12, "4 length + 6 utf-8 bytes + 2 padding");
  assert.equal(reader.readUInt8(), 0x2a);
});

test("a length-prefixed string needing no padding does not consume any", () => {
  const reader = new BinaryReader(concat(hex("00000004"), utf8("abcd"), hex("2a")));
  assert.equal(reader.readAlignedString(), "abcd");
  assert.equal(reader.position, 8);
  assert.equal(reader.readUInt8(), 0x2a);
});

test("a length-prefixed string honours the endian switch", () => {
  const reader = new BinaryReader(concat(hex("04000000"), utf8("abcd")), "little");
  assert.equal(reader.readAlignedString(), "abcd");
});

test("an empty or impossible length yields \"\" and still aligns, as upstream does", () => {
  const empty = new BinaryReader(concat(hex("00000000"), hex("2a")));
  assert.equal(empty.readAlignedString(), "");
  assert.equal(empty.position, 4);

  const negative = new BinaryReader(concat(hex("ffffffff"), hex("2a")));
  assert.equal(negative.readAlignedString(), "");
  assert.equal(negative.position, 4);

  const tooLong = new BinaryReader(concat(hex("00000064"), utf8("ab")));
  assert.equal(tooLong.readAlignedString(), "", "a length longer than what remains is ignored");
  assert.equal(tooLong.position, 4, "the bytes it claimed are left unread");
});

test("aligning after a length-prefixed string never runs past the end", () => {
  const reader = new BinaryReader(concat(hex("00000003"), utf8("abc"), hex("00")));
  assert.equal(reader.readAlignedString(), "abc");
  assert.equal(reader.position, 8, "one padding byte, and there is exactly one");

  const short = new BinaryReader(concat(hex("00000003"), utf8("abc")));
  assert.equal(short.readAlignedString(), "abc");
  assert.equal(short.position, 7, "no padding to skip past the end");
});

test("reads a NUL-terminated C string and consumes the terminator", () => {
  const reader = new BinaryReader(concat(utf8("UnityFS"), hex("00"), hex("2a")));
  assert.equal(reader.readStringToNull(), "UnityFS");
  assert.equal(reader.position, 8);
  assert.equal(reader.readUInt8(), 0x2a);
});

test("a C string decodes multi-byte UTF-8", () => {
  const reader = new BinaryReader(concat(utf8("héllo ☃"), hex("00")));
  assert.equal(reader.readStringToNull(), "héllo ☃");
});

test("an empty C string consumes only its terminator", () => {
  const reader = new BinaryReader(hex("002a"));
  assert.equal(reader.readStringToNull(), "");
  assert.equal(reader.position, 1);
});

test("a C string stops at maxLength without consuming a terminator", () => {
  const reader = new BinaryReader(concat(utf8("abcdef"), hex("00")));
  assert.equal(reader.readStringToNull(3), "abc");
  assert.equal(reader.position, 3);
});

test("an unterminated C string stops at the end, like upstream", () => {
  const reader = new BinaryReader(utf8("abc"));
  assert.equal(reader.readStringToNull(), "abc");
  assert.equal(reader.position, 3);
  assert.equal(reader.remaining, 0);
});

test("readBytes returns a zero-copy view aliasing the input (R7)", () => {
  const data = hex("0011223344556677");
  const reader = new BinaryReader(data);
  reader.position = 2;
  const view = reader.readBytes(3);

  assert.deepEqual(Array.from(view), [0x22, 0x33, 0x44]);
  assert.equal(view.buffer, data.buffer, "must be a subarray, never a slice");
  assert.equal(view.byteOffset, data.byteOffset + 2);
  assert.equal(reader.position, 5);

  data[2] = 0x99;
  assert.equal(view[0], 0x99, "the view aliases the input, so writes show through");
  view[1] = 0x88;
  assert.equal(data[3], 0x88);
});

test("readBytes(0) returns an empty view and does not move", () => {
  const reader = new BinaryReader(hex("0011"));
  const view = reader.readBytes(0);
  assert.equal(view.length, 0);
  assert.equal(reader.position, 0);
});

test("readBytes rejects a count that is not a whole number in 0..2^53", () => {
  const reader = new BinaryReader(new Uint8Array(8));
  assert.throws(() => reader.readBytes(-1), RangeError);
  assert.throws(() => reader.readBytes(1.5), RangeError);
  assert.throws(() => reader.readBytes(2 ** 53), RangeError);
});

test("an offset above 2^53 throws rather than losing precision (D9)", () => {
  const reader = new BinaryReader(new Uint8Array(16));
  for (const offset of [2 ** 53, 2 ** 53 + 2, 2 ** 60, Number.MAX_VALUE, Infinity]) {
    assert.throws(
      () => {
        reader.position = offset;
      },
      (error: unknown) =>
        error instanceof RangeError && /0\.\.2\^53/.test((error as Error).message),
      `expected offset ${offset} to be rejected`,
    );
  }
  assert.equal(reader.position, 0, "a rejected offset leaves the cursor alone");
});

test("an offset that is not a usable number is the caller's mistake, not corrupt data", () => {
  const reader = new BinaryReader(new Uint8Array(16));
  for (const offset of [1.5, -1, NaN]) {
    assert.throws(
      () => {
        reader.position = offset;
      },
      RangeError,
      `expected offset ${offset} to be rejected as a RangeError`,
    );
  }
  assert.equal(reader.position, 0, "a rejected offset leaves the cursor alone");
});

test("an offset past the end is corrupt data, not a RangeError", () => {
  const reader = new BinaryReader(new Uint8Array(16));
  assert.throws(
    () => {
      reader.position = 17;
    },
    (error: unknown) =>
      error instanceof CorruptError &&
      !(error instanceof RangeError) &&
      /offset 17 is past the end of 16 bytes/.test((error as Error).message),
  );
  reader.position = 16;
  assert.equal(reader.position, 16, "seeking to the end itself is allowed");
});

test("reading past the end throws CorruptError naming what was short", () => {
  const reader = new BinaryReader(hex("0011223344"));
  reader.position = 2;
  assert.throws(() => reader.readUInt32(), {
    name: "CorruptError",
    message: /read of 4 bytes at offset 2 runs past the end: 3 of 5 bytes remain/,
  });
  assert.equal(reader.position, 2, "a failed read leaves the cursor alone");
  assert.throws(() => reader.readBytes(4), CorruptError);
  assert.throws(() => reader.readUInt64(), CorruptError);
});

test("reads through a view into a larger buffer without seeing its neighbours", () => {
  const backing = hex("aaaa12345678bbbb");
  const reader = new BinaryReader(backing.subarray(2, 6));
  assert.equal(reader.length, 4);
  assert.equal(reader.readUInt32(), 0x12345678);
  assert.equal(reader.remaining, 0);
  reader.position = 0;
  assert.equal(reader.readBytes(4).byteOffset, 2);
});

test("position, length and remaining track each other", () => {
  const reader = new BinaryReader(new Uint8Array(10));
  assert.equal(reader.length, 10);
  assert.equal(reader.remaining, 10);
  reader.readBytes(4);
  assert.equal(reader.position, 4);
  assert.equal(reader.remaining, 6);
});
