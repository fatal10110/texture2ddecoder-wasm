import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertMatchesGolden,
  golden,
  gunzipFixture,
  loadFixture,
} from "../../../fixtures/helpers.js";
import { NodeFlags, readBundle } from "../src/bundle/BundleFile.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";

/** Every committed UnityFS fixture this module can unpack today. */
const UNITYFS_FIXTURES = [
  "uncompressed.bundle",
  "lz4.bundle",
  "lz4-blocksinfo-at-end.bundle",
  "lz4-padding.bundle",
  "lz4-v7-align.bundle",
  "lzma.bundle",
];

// --- fixtures against the oracle goldens ------------------------------------

for (const name of UNITYFS_FIXTURES) {
  test(`unpacks ${name} byte-identically to the golden`, () => {
    assertMatchesGolden(name, readBundle(loadFixture(name)).files);
  });

  test(`reads the header of ${name}`, () => {
    const expected = golden(name);
    const { header } = readBundle(loadFixture(name));
    assert.equal(header.signature, expected.signature);
    assert.equal(header.version, expected.formatVersion);
    assert.equal(header.unityVersion, expected.unityVersion);
    assert.equal(header.unityRevision, expected.unityRevision);
    assert.equal(header.size, loadFixture(name).length);
  });
}

test("unpacks a gzip-wrapped bundle once the wrapper is off", () => {
  // The gzip fixture holds the same bundle as lz4.bundle; unwrapping is the
  // caller's job (#15 / #19), so the bundle parser only sees the inner bytes.
  assertMatchesGolden("gzip-lz4.bundle.gz", readBundle(gunzipFixture("gzip-lz4.bundle.gz")).files);
});

test("surfaces the node flags that tell a SerializedFile from a resource", () => {
  const files = readBundle(loadFixture("lz4.bundle")).files;
  const flags = new Map(files.map((file) => [file.path, file.flags]));
  assert.equal(flags.get("CAB-lz4"), NodeFlags.SerializedFile);
  assert.equal(flags.get("CAB-lz4.resS"), 0);
});

test("returns views into the block buffer rather than copies (R7)", () => {
  const files = readBundle(loadFixture("lz4.bundle")).files;
  const first = files[0]!;
  assert.ok(first.data.byteLength < first.data.buffer.byteLength);
});

// --- what is not implemented here -------------------------------------------

for (const name of ["unityweb-lzma.bundle", "unityraw.bundle"]) {
  test(`refuses ${name}: the legacy containers land with #18`, () => {
    assert.throws(
      () => readBundle(loadFixture(name)),
      (error: unknown) => error instanceof UnsupportedError && error.kind === "container",
    );
  });
}

// --- a hand-written bundle, so the unhappy paths can be crafted exactly ------

/** Big-endian byte sink; Unity writes every bundle header field big-endian. */
class Writer {
  private readonly out: number[] = [];

  u8(value: number): void {
    this.out.push(value & 0xff);
  }

  u16(value: number): void {
    this.u8(value >>> 8);
    this.u8(value);
  }

  u32(value: number): void {
    this.u8(value >>> 24);
    this.u8(value >>> 16);
    this.u8(value >>> 8);
    this.u8(value);
  }

  i64(value: bigint): void {
    for (let shift = 56n; shift >= 0n; shift -= 8n) this.u8(Number((value >> shift) & 0xffn));
  }

  bytes(data: Uint8Array): void {
    for (const byte of data) this.out.push(byte);
  }

  /** NUL-terminated ASCII, the shape Unity writes signatures and paths in. */
  cstr(text: string): void {
    for (const char of text) this.u8(char.charCodeAt(0));
    this.u8(0);
  }

  align(boundary: number): void {
    while (this.out.length % boundary !== 0) this.u8(0);
  }

  build(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

interface Block {
  data: Uint8Array;
  /** Defaults to `data.length`: what the blocks info claims the block expands to. */
  uncompressedSize?: number;
  /** Storage block flags; the low six bits are the compression type. */
  flags?: number;
}

interface Node {
  path: string;
  offset: number;
  size: number | bigint;
  flags?: number;
}

interface BundleOptions {
  version?: number;
  /** Archive flags; 0x40 (blocks and directory info combined) by default. */
  flags?: number;
  blocks?: Block[];
  nodes?: Node[];
  /** Overrides, so a header can be made to disagree with the bytes. */
  blockCount?: number;
  nodeCount?: number;
  compressedBlocksInfoSize?: number;
  uncompressedBlocksInfoSize?: number;
}

const BLOCKS_AND_DIRECTORY_COMBINED = 0x40;
const BLOCKS_INFO_AT_THE_END = 0x80;
const PADDING_AT_START = 0x200;

const payload = (size: number, seed = 1): Uint8Array =>
  Uint8Array.from({ length: size }, (_, i) => (i * 7 + seed) & 0xff);

/**
 * Write an uncompressed UnityFS bundle. Uncompressed keeps every offset in the
 * file readable by hand, which is the point: each test below breaks exactly one
 * field of it.
 */
function buildBundle(options: BundleOptions = {}): Uint8Array {
  const {
    version = 6,
    flags = BLOCKS_AND_DIRECTORY_COMBINED,
    blocks = [{ data: payload(64) }],
    nodes = [{ path: "CAB-test", offset: 0, size: 64, flags: NodeFlags.SerializedFile }],
  } = options;

  const info = new Writer();
  info.bytes(new Uint8Array(16)); // uncompressed data hash
  info.u32(options.blockCount ?? blocks.length);
  for (const block of blocks) {
    info.u32(block.uncompressedSize ?? block.data.length);
    info.u32(block.data.length);
    info.u16(block.flags ?? 0);
  }
  info.u32(options.nodeCount ?? nodes.length);
  for (const node of nodes) {
    info.i64(BigInt(node.offset));
    info.i64(BigInt(node.size));
    info.u32(node.flags ?? 0);
    info.cstr(node.path);
  }
  const infoBytes = info.build();

  const out = new Writer();
  out.cstr("UnityFS");
  out.u32(version);
  out.cstr("5.x.x");
  out.cstr("2022.3.0f1");
  out.i64(0n); // total size; upstream reads it but never checks it
  out.u32(options.compressedBlocksInfoSize ?? infoBytes.length);
  out.u32(options.uncompressedBlocksInfoSize ?? infoBytes.length);
  out.u32(flags);
  // Format version 7 (Unity 2020.1+) pads the header to 16 bytes.
  if (version >= 7) out.align(16);
  // Padding and alignment are counted from the start of the file, so the
  // blocks have to be written into the same sink as the header.
  if ((flags & BLOCKS_INFO_AT_THE_END) !== 0) {
    if ((flags & PADDING_AT_START) !== 0) out.align(16);
    for (const block of blocks) out.bytes(block.data);
    out.bytes(infoBytes);
  } else {
    out.bytes(infoBytes);
    if ((flags & PADDING_AT_START) !== 0) out.align(16);
    for (const block of blocks) out.bytes(block.data);
  }
  return out.build();
}

test("the hand-written bundle round-trips, so the cases below start from valid bytes", () => {
  const data = payload(64);
  const files = readBundle(buildBundle({ blocks: [{ data }] })).files;
  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, "CAB-test");
  assert.deepEqual(files[0]!.data, data);
});

test("reads the blocks info from the end of the file when flag 0x80 is set", () => {
  const data = payload(64, 3);
  const bundle = buildBundle({
    flags: BLOCKS_AND_DIRECTORY_COMBINED | BLOCKS_INFO_AT_THE_END,
    blocks: [{ data }],
  });
  assert.deepEqual(readBundle(bundle).files[0]!.data, data);
});

test("pads the data blocks to 16 bytes when flag 0x200 is set", () => {
  const data = payload(64, 5);
  // The node path is one word longer than the default on purpose: with the
  // default the header and blocks info happen to add up to 112 bytes, the
  // blocks already start on a 16-byte boundary, and the case would pass even
  // with the align deleted from the reader.
  const nodes = [{ path: "CAB-test-pad", offset: 0, size: 64, flags: NodeFlags.SerializedFile }];
  const unpadded = buildBundle({ blocks: [{ data }], nodes });
  const padded = buildBundle({
    flags: BLOCKS_AND_DIRECTORY_COMBINED | PADDING_AT_START,
    blocks: [{ data }],
    nodes,
  });

  assert.equal(padded.length - unpadded.length, 12, "the crafted bundle carries no padding");
  assert.deepEqual(readBundle(padded).files[0]!.data, data);
});

test("pads the header to 16 bytes for format version 7", () => {
  const data = payload(64, 7);
  const bundle = buildBundle({ version: 7, blocks: [{ data }] });
  const parsed = readBundle(bundle);
  assert.equal(parsed.header.version, 7);
  assert.deepEqual(parsed.files[0]!.data, data);
});

test("stitches a file that spans two blocks", () => {
  const first = payload(48, 11);
  const second = payload(16, 13);
  const files = readBundle(
    buildBundle({
      blocks: [{ data: first }, { data: second }],
      nodes: [
        { path: "CAB-split", offset: 0, size: 64, flags: NodeFlags.SerializedFile },
        { path: "CAB-split.resS", offset: 48, size: 16 },
      ],
    }),
  ).files;
  assert.deepEqual(files[0]!.data, Uint8Array.from([...first, ...second]));
  assert.deepEqual(files[1]!.data, second);
});

// --- typed errors -----------------------------------------------------------

test("refuses an unknown compression type by name, not by number", () => {
  for (const [type, name] of [
    [4, "LZHAM"],
    [5, "zstd"],
  ] as const) {
    assert.throws(
      () => readBundle(buildBundle({ flags: BLOCKS_AND_DIRECTORY_COMBINED | type })),
      (error: unknown) =>
        error instanceof UnsupportedError &&
        error.kind === "compression type" &&
        error.found === name,
      `blocks info compressed with ${name}`,
    );
  }
});

test("refuses an unnamed compression type with its number", () => {
  assert.throws(
    () => readBundle(buildBundle({ blocks: [{ data: payload(64), flags: 9 }] })),
    (error: unknown) =>
      error instanceof UnsupportedError &&
      error.kind === "compression type" &&
      error.found === 9,
  );
});

test("refuses an encrypted archive instead of unpacking garbage", () => {
  for (const bit of [0x400, 0x1000]) {
    assert.throws(
      () => readBundle(buildBundle({ flags: BLOCKS_AND_DIRECTORY_COMBINED | bit })),
      (error: unknown) => error instanceof UnsupportedError && error.kind === "archive flag",
      `flag 0x${bit.toString(16)}`,
    );
  }
});

test("reports a truncated bundle as corrupt", () => {
  const bundle = buildBundle();
  for (const cut of [8, 32, bundle.length - 1]) {
    assert.throws(
      () => readBundle(bundle.subarray(0, cut)),
      CorruptError,
      `cut to ${cut} bytes`,
    );
  }
});

test("reports a block that does not decompress to its declared size", () => {
  // The cursor in readBlocks advances by the declared size, so a codec whose
  // output does not match it would shift every later block or leave a file
  // zero-filled. The uncompressed codec is the one that can be made to
  // disagree from a crafted bundle; the check it trips is shared by all of them.
  assert.throws(
    () => readBundle(buildBundle({ blocks: [{ data: payload(64), uncompressedSize: 100 }] })),
    (error: unknown) =>
      error instanceof CorruptError &&
      error.message === "block 0 wrote 64 bytes but expected 100 bytes",
  );
});

test("reports a blocks info that does not decompress to its declared size", () => {
  assert.throws(
    () => readBundle(buildBundle({ uncompressedBlocksInfoSize: 999 })),
    (error: unknown) =>
      error instanceof CorruptError &&
      /^blocks info wrote \d+ bytes but expected 999 bytes$/.test(error.message),
  );
});

test("reports a node that runs past the end of the blocks", () => {
  assert.throws(
    () =>
      readBundle(
        buildBundle({ nodes: [{ path: "CAB-big", offset: 32, size: 64 }] }),
      ),
    (error: unknown) => error instanceof CorruptError && error.message.includes("CAB-big"),
  );
});

test("reports a node size that a number cannot hold exactly (D9)", () => {
  assert.throws(
    () => readBundle(buildBundle({ nodes: [{ path: "CAB-huge", offset: 0, size: 2n ** 60n }] })),
    (error: unknown) => error instanceof CorruptError && error.message.includes("node size"),
  );
});

test("reports a negative count in the blocks info", () => {
  assert.throws(
    () => readBundle(buildBundle({ blockCount: -1 })),
    (error: unknown) => error instanceof CorruptError && error.message.includes("storage block"),
  );
  assert.throws(
    () => readBundle(buildBundle({ nodeCount: -3 })),
    (error: unknown) => error instanceof CorruptError && error.message.includes("directory node"),
  );
});

test("reports blocks info at the end that does not fit in the file", () => {
  assert.throws(
    () =>
      readBundle(
        buildBundle({
          flags: BLOCKS_AND_DIRECTORY_COMBINED | BLOCKS_INFO_AT_THE_END,
          compressedBlocksInfoSize: 0x10000,
        }),
      ),
    (error: unknown) => error instanceof CorruptError && error.message.includes("blocks info"),
  );
});

test("reports a bundle whose signature is not a container at all", () => {
  assert.throws(
    () => readBundle(new Uint8Array(64)),
    (error: unknown) => error instanceof UnsupportedError && error.kind === "container",
  );
});
