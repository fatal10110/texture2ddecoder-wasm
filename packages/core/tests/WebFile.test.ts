import assert from "node:assert/strict";
import { test } from "node:test";

import { assertMatchesGolden, golden, loadFixture } from "../../../fixtures/helpers.js";
import { readWebFile } from "../src/bundle/WebFile.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";

const FIXTURE = "webdata.data";

// --- the fixture against the oracle golden ----------------------------------

test(`unpacks ${FIXTURE} byte-identically to the golden`, () => {
  assertMatchesGolden(FIXTURE, readWebFile(loadFixture(FIXTURE)).files);
});

test("reports the signature with its version, the way the file spells it", () => {
  const { signature } = readWebFile(loadFixture(FIXTURE));
  assert.equal(signature, golden(FIXTURE).signature);
  assert.equal(signature, "UnityWebData1.0");
});

test("gives every entry flags 0, because the layout has no field for them", () => {
  for (const file of readWebFile(loadFixture(FIXTURE)).files) {
    assert.equal(file.flags, 0);
  }
});

test("returns views into the input rather than copies (R7)", () => {
  const first = readWebFile(loadFixture(FIXTURE)).files[0]!;
  assert.ok(first.data.byteLength < first.data.buffer.byteLength);
});

// --- a hand-written container, so the unhappy paths can be crafted exactly ---

/** Little-endian byte sink; a `UnityWebData` file is little-endian throughout. */
class Writer {
  private readonly out: number[] = [];

  u8(value: number): void {
    this.out.push(value & 0xff);
  }

  i32(value: number): void {
    for (let shift = 0; shift < 32; shift += 8) this.u8(value >> shift);
  }

  bytes(data: Uint8Array): void {
    for (const byte of data) this.out.push(byte);
  }

  /** NUL-terminated UTF-8, the shape the signature is written in. */
  cstr(text: string): void {
    this.bytes(utf8(text));
    this.u8(0);
  }

  get length(): number {
    return this.out.length;
  }

  build(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

interface Entry {
  path: string;
  data: Uint8Array;
  /** Overrides, so an entry can be made to disagree with the bytes. */
  offset?: number;
  length?: number;
  pathLength?: number;
}

const payload = (size: number, seed = 1): Uint8Array =>
  Uint8Array.from({ length: size }, (_, i) => (i * 11 + seed) & 0xff);

function buildWebFile(
  entries: Entry[],
  options: { signature?: string; headerLength?: number } = {},
): Uint8Array {
  const { signature = "UnityWebData1.0" } = options;

  // The header ends where the first file starts, so its length has to be known
  // before any entry is written: the signature, the length field itself, and
  // three ints plus the path bytes for each entry.
  const headerLength =
    options.headerLength ??
    utf8(signature).length +
      1 +
      4 +
      entries.reduce((total, entry) => total + 12 + utf8(entry.path).length, 0);

  const out = new Writer();
  out.cstr(signature);
  out.i32(headerLength);

  let offset = headerLength;
  for (const entry of entries) {
    out.i32(entry.offset ?? offset);
    out.i32(entry.length ?? entry.data.length);
    out.i32(entry.pathLength ?? utf8(entry.path).length);
    out.bytes(utf8(entry.path));
    offset += entry.data.length;
  }
  for (const entry of entries) out.bytes(entry.data);
  return out.build();
}

test("the hand-written container round-trips, so the cases below are valid", () => {
  const first = payload(64);
  const second = payload(32, 5);
  const files = readWebFile(
    buildWebFile([
      { path: "level0", data: first },
      { path: "sharedassets0.assets", data: second },
    ]),
  ).files;

  assert.deepEqual(
    files.map((file) => file.path),
    ["level0", "sharedassets0.assets"],
  );
  assert.deepEqual(files[0]!.data, first);
  assert.deepEqual(files[1]!.data, second);
});

test("decodes a path as UTF-8, not byte per byte", () => {
  // The path is a length-prefixed byte run, so a multi-byte character is the
  // one case where a byte-per-char read would pass every other test here.
  const path = "Assets/日本語/ファイル.bytes";
  const files = readWebFile(buildWebFile([{ path, data: payload(16) }])).files;
  assert.equal(files[0]!.path, path);
});

test("accepts a container with no entries at all", () => {
  assert.deepEqual(readWebFile(buildWebFile([])).files, []);
});

test("refuses a file that is not a UnityWebData container", () => {
  for (const signature of ["UnityFS", ""]) {
    assert.throws(
      () => readWebFile(buildWebFile([], { signature })),
      (error: unknown) => error instanceof UnsupportedError && error.kind === "container",
      `signature ${JSON.stringify(signature)}`,
    );
  }
});

test("reports an entry that runs past the end of the file", () => {
  assert.throws(
    () => readWebFile(buildWebFile([{ path: "level0", data: payload(64), length: 4096 }])),
    (error: unknown) => error instanceof CorruptError && error.message.includes("level0"),
  );
});

test("reports a negative offset instead of counting back from the end", () => {
  // `subarray` would happily read the last 64 bytes of the file here and hand
  // back some other entry's data.
  assert.throws(
    () => readWebFile(buildWebFile([{ path: "level0", data: payload(64), offset: -64 }])),
    (error: unknown) => error instanceof CorruptError && error.message.includes("level0"),
  );
});

test("reports a negative path length as corrupt, not as a caller bug", () => {
  assert.throws(
    () => readWebFile(buildWebFile([{ path: "level0", data: payload(64), pathLength: -1 }])),
    (error: unknown) => error instanceof CorruptError && error.message.includes("path length"),
  );
});

test("reports a header that ends before its own signature", () => {
  assert.throws(
    () => readWebFile(buildWebFile([], { headerLength: 4 })),
    (error: unknown) => error instanceof CorruptError && error.message.includes("header"),
  );
});

test("reports a truncated container as corrupt", () => {
  // The cuts start past the signature: a cut through it makes the file an
  // unsupported container rather than a broken one.
  const file = buildWebFile([{ path: "level0", data: payload(64) }]);
  for (const cut of [16, 20, file.length - 1]) {
    assert.throws(() => readWebFile(file.subarray(0, cut)), CorruptError, `cut to ${cut} bytes`);
  }
});
