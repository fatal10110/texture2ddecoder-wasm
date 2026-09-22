import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { fixtureNames, golden, gunzipFixture, loadFixture } from "../../../fixtures/helpers.js";
import { detectContainer, detectFileType, type FileType } from "../src/bundle/detect.js";
import { UnsupportedError } from "../src/errors.js";

/** ASCII bytes followed by a NUL, the shape Unity writes a signature in. */
function signed(signature: string, trailing = 32): Uint8Array {
  const data = new Uint8Array(signature.length + 1 + trailing);
  for (let i = 0; i < signature.length; i++) data[i] = signature.charCodeAt(i);
  return data;
}

interface Header {
  version: number;
  /** Bytes handed to the detector; defaults to 64. */
  length?: number;
  /** What the header claims, when it should disagree with `length`. */
  fileSize?: number;
  dataOffset?: number;
}

/**
 * A raw SerializedFile header as `FileReader.IsSerializedFile` reads it:
 * big-endian, 32-bit fields before format version 22 and 64-bit ones from 22 on.
 * The backing buffer is always full size so a truncated case still carries a
 * plausible header - only the returned view is short.
 */
function serializedFile({ version, length = 64, fileSize, dataOffset = 32 }: Header): Uint8Array {
  const full = new Uint8Array(Math.max(length, 48));
  const view = new DataView(full.buffer);
  const claimedSize = fileSize ?? length;
  view.setUint32(0, 16); // m_MetadataSize
  view.setUint32(4, version >= 22 ? 0 : claimedSize);
  view.setUint32(8, version);
  view.setUint32(12, version >= 22 ? 0 : dataOffset);
  full[16] = 1; // m_Endianess: big-endian
  if (version >= 22) {
    view.setUint32(20, 16);
    view.setBigInt64(24, BigInt(claimedSize));
    view.setBigInt64(32, BigInt(dataOffset));
  }
  return full.subarray(0, length);
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** Upstream looks for ASCII "brotli" at offset 0x20, not at the start. */
function brotliFile(): Uint8Array {
  const data = new Uint8Array(0x20 + 6);
  data.set([..."brotli"].map((ch) => ch.charCodeAt(0)), 0x20);
  return data;
}

// --- the detection table over every committed fixture -----------------------

/**
 * The file type a golden's signature stands for. They spell it the same way
 * except for `UnityWebData`, whose signature carries its version too.
 */
function expectedType(signature: string): string {
  return signature.startsWith("UnityWebData") ? "UnityWebData" : signature;
}

for (const name of fixtureNames()) {
  const expected = name.endsWith(".gz") ? "gzip" : expectedType(golden(name).signature);

  test(`detects ${name} as ${expected}`, () => {
    const data = loadFixture(name);
    assert.equal(detectFileType(data), expected);
    // Every fixture is a container the library opens, so nothing here throws.
    assert.equal(detectContainer(data), expected);
  });
}

test("a gzip fixture reveals its bundle signature once unwrapped", () => {
  for (const name of fixtureNames().filter((n) => n.endsWith(".gz"))) {
    assert.equal(detectFileType(gunzipFixture(name)), expectedType(golden(name).signature));
  }
});

// --- types no fixture covers ------------------------------------------------

const TABLE: [string, Uint8Array, FileType][] = [
  ["a UnityArchive signature", signed("UnityArchive"), "UnityArchive"],
  ["a UnityWebData signature", signed("UnityWebData1.0"), "UnityWebData"],
  ["a zip archive", bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00), "zip"],
  ["a spanned zip archive", bytes(0x50, 0x4b, 0x07, 0x08, 0x00, 0x00), "zip"],
  ["a gzip stream", bytes(0x1f, 0x8b, 0x08, 0x00), "gzip"],
  ["a brotli stream", brotliFile(), "brotli"],
  ["a raw SerializedFile", serializedFile({ version: 17 }), "serialized"],
  ["a 64-bit SerializedFile (22+)", serializedFile({ version: 22 }), "serialized"],
  ["a resource file", bytes(...new Array<number>(64).fill(0xaa)), "resource"],
];

for (const [what, data, expected] of TABLE) {
  test(`detects ${what} as ${expected}`, () => {
    assert.equal(detectFileType(data), expected);
  });
}

test("a signature with no NUL terminator is not a bundle", () => {
  // "UnityFSX..." must not be read as "UnityFS": a prefix match would hand a
  // foreign container to the bundle reader.
  const data = new Uint8Array(40);
  for (const [i, ch] of [..."UnityFSX and then some more text"].entries()) {
    data[i] = ch.charCodeAt(0);
  }
  assert.equal(detectFileType(data), "resource");
});

test("detection reads the view, not the whole backing buffer", () => {
  // R7 keeps the read path on `subarray`, so every input arrives as a view with
  // a non-zero byte offset sooner or later.
  for (const data of [loadFixture("lz4.bundle"), serializedFile({ version: 22 })]) {
    const padded = new Uint8Array(data.length + 7);
    padded.set(data, 7);
    assert.equal(detectFileType(padded.subarray(7)), detectFileType(data));
  }
  assert.equal(detectFileType(serializedFile({ version: 22 })), "serialized");
});

// --- the SerializedFile heuristic must not fire on anything else ------------

test("a header whose file size disagrees with the bytes is not serialized", () => {
  assert.equal(detectFileType(serializedFile({ version: 17, fileSize: 63 })), "resource");
  assert.equal(detectFileType(serializedFile({ version: 22, fileSize: 65 })), "resource");
});

test("a data offset past the end of the file is not serialized", () => {
  assert.equal(detectFileType(serializedFile({ version: 17, dataOffset: 65 })), "resource");
  assert.equal(detectFileType(serializedFile({ version: 22, dataOffset: 1 << 30 })), "resource");
});

test("a 22+ header too small to hold its 64-bit fields is not serialized", () => {
  assert.equal(detectFileType(serializedFile({ version: 22, length: 47 })), "resource");
  assert.equal(detectFileType(serializedFile({ version: 22, length: 48 })), "serialized");
});

test("format version 21 still reads its sizes from the 32-bit fields", () => {
  // Pins the `>= 22` gate itself: 47 bytes is under the floor version 22+ needs,
  // so this can only pass through the 32-bit path. A gate at 21 or lower turns
  // the most common version on the low side (2019/2020) into a resource file.
  const v21 = serializedFile({ version: 21, length: 47, dataOffset: 47 });
  assert.equal(detectFileType(v21), "serialized");
});

test("the smallest accepted 32-bit header is 20 bytes", () => {
  const header = (length: number) => serializedFile({ version: 17, length, dataOffset: length });
  assert.equal(detectFileType(header(20)), "serialized");
  assert.equal(detectFileType(header(19)), "resource");
});

// --- unknown and too-short input --------------------------------------------

test("input too short to classify falls back to resource", () => {
  const tooShort = [
    new Uint8Array(0),
    bytes(0x1f), // half a gzip magic
    bytes(0x50, 0x4b), // half a zip magic
    bytes(...new Array<number>(19).fill(1)), // one byte short of a header
  ];
  for (const data of tooShort) assert.equal(detectFileType(data), "resource");
});

test("garbage is reported as resource rather than guessed at", () => {
  const garbage = new Uint8Array(256);
  for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 37 + 11) & 0xff;
  assert.equal(detectFileType(garbage), "resource");
});

// --- unsupported types throw, naming what was found (R9) --------------------

test("detectContainer throws UnsupportedError naming the detected type", () => {
  for (const [expected, data] of [
    ["UnityArchive", signed("UnityArchive")],
    ["brotli", brotliFile()],
    ["zip", bytes(0x50, 0x4b, 0x03, 0x04)],
    ["resource", new Uint8Array(64)],
    ["resource", new Uint8Array(0)],
  ] as const) {
    assert.throws(
      () => detectContainer(data),
      (error: unknown) => {
        assert.ok(error instanceof UnsupportedError, `expected UnsupportedError, got ${error}`);
        assert.equal(error.kind, "container");
        assert.equal(error.found, expected);
        assert.match(error.message, new RegExp(`^unsupported container: ${expected} \\(.+\\)$`));
        return true;
      },
    );
  }
});

test("detectContainer passes through every type the library opens", () => {
  assert.equal(detectContainer(signed("UnityWebData1.0")), "UnityWebData");
  assert.equal(detectContainer(bytes(0x1f, 0x8b, 0x08, 0x00)), "gzip");
  assert.equal(detectContainer(serializedFile({ version: 17 })), "serialized");
  assert.equal(detectContainer(loadFixture("unityweb-lzma.bundle")), "UnityWeb");
  assert.equal(detectContainer(loadFixture("unityraw.bundle")), "UnityRaw");
});

test("the detector is exported from the package entry point", async () => {
  const dist = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));
  const built = (await import(dist)) as typeof import("../src/index.js");
  assert.equal(built.detectFileType(loadFixture("lz4.bundle")), "UnityFS");
  assert.throws(() => built.detectContainer(new Uint8Array(8)), built.UnsupportedError);
});
