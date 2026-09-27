import { describe, it, before } from "node:test";
import assert from "node:assert";
import { initialize, decode_bc1, decode_bc3 } from "../src/index.js";

// Colour-block mode of BC1 vs BC3 (#137). A BC1 colour block is in 3-colour mode when
// c0 <= c1 (index 2 = midpoint, index 3 = black); the S3TC spec
// (EXT_texture_compression_s3tc, D3D BC3) decodes the DXT5 colour block in 4-colour mode
// always. Expected pixels are the spec's, worked by hand below, and match Pillow 12.3's
// "bcn" decoder on the same bytes except where a comment says otherwise.
//
// RGB565 0x8410 expands to (132, 130, 132): r5 = 16 -> 16 << 3 | 16 >> 2, g6 = 32 ->
// 32 << 2 | 32 >> 4. 0x001F is (0, 0, 255), 0xF800 is (255, 0, 0).

type Rgba = readonly [number, number, number, number];

/** An 8-byte BC1 colour block: c0, c1 (RGB565, little-endian), then 2-bit indices. */
function colourBlock(c0: number, c1: number, indices: number): number[] {
  return [
    c0 & 0xff,
    c0 >> 8,
    c1 & 0xff,
    c1 >> 8,
    indices & 0xff,
    (indices >>> 8) & 0xff,
    (indices >>> 16) & 0xff,
    indices >>> 24,
  ];
}

// BC3 alpha half: a0 = a1 = 128, every 3-bit index 0, so every pixel's alpha is 128.
const ALPHA_128 = [0x80, 0x80, 0, 0, 0, 0, 0, 0];
// Every row reads indices 0, 1, 2, 3 left to right (0b11_10_01_00 per row).
const INDICES_0123 = 0xe4e4e4e4;
const ALL_INDEX_3 = 0xffffffff;

/**
 * Assert a decoded 4x4-block-row image (BGRA, as the decoder returns it) is `row`
 * (RGBA, left to right, repeated every 4 pixels) on every pixel of every row.
 */
function assertRows(bgra: Uint8Array | null, width: number, row: readonly Rgba[]): void {
  assert.ok(bgra, "decoder returned null");
  assert.strictEqual(bgra.length, width * 4 * 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = row[x % row.length]!;
      const i = (y * width + x) * 4;
      assert.deepStrictEqual(
        Array.from(bgra.subarray(i, i + 4)),
        [b, g, r, a],
        `pixel (${x}, ${y})`
      );
    }
  }
}

describe("BC3 colour half: 4-colour mode regardless of c0/c1 order (#137)", () => {
  before(async () => {
    await initialize();
  });

  it("c0 == c1 with index 3 decodes to the block colour, not black", async () => {
    const data = new Uint8Array([...ALPHA_128, ...colourBlock(0x8410, 0x8410, ALL_INDEX_3)]);
    assertRows(await decode_bc3(data, 4, 4), 4, [[132, 130, 132, 128]]);
  });

  it("c0 < c1 interpolates thirds for indices 2 and 3", async () => {
    // c2 = (2 * c0 + c1) / 3, c3 = (c0 + 2 * c1) / 3, truncated per channel.
    const data = new Uint8Array([...ALPHA_128, ...colourBlock(0x001f, 0xf800, INDICES_0123)]);
    assertRows(await decode_bc3(data, 4, 4), 4, [
      [0, 0, 255, 128],
      [255, 0, 0, 128],
      [85, 0, 170, 128],
      [170, 0, 85, 128],
    ]);
  });

  it("truncates the thirds, as the submodule's 4-colour branch and Pillow do", async () => {
    // 0x0841 is (8, 8, 8): r5 = 1 -> 8 | 0, g6 = 2 -> 8 | 0, b5 = 1 -> 8 | 0. The spec
    // gives no rounding rule; c2 = 8 / 3 = 2 (not 3) and c3 = 16 / 3 = 5 pin truncation.
    const data = new Uint8Array([...ALPHA_128, ...colourBlock(0x0000, 0x0841, INDICES_0123)]);
    assertRows(await decode_bc3(data, 4, 4), 4, [
      [0, 0, 0, 128],
      [8, 8, 8, 128],
      [2, 2, 2, 128],
      [5, 5, 5, 128],
    ]);
  });

  it("c0 > c1 decodes as before", async () => {
    const data = new Uint8Array([...ALPHA_128, ...colourBlock(0xf800, 0x001f, INDICES_0123)]);
    assertRows(await decode_bc3(data, 4, 4), 4, [
      [255, 0, 0, 128],
      [0, 0, 255, 128],
      [170, 0, 85, 128],
      [85, 0, 170, 128],
    ]);
  });

  it("applies per block across a multi-block image", async () => {
    // 8x4: a c0 == c1 index-3 block, then a c0 > c1 block with every index 1 (0x001F).
    const data = new Uint8Array([
      ...ALPHA_128,
      ...colourBlock(0x8410, 0x8410, ALL_INDEX_3),
      ...ALPHA_128,
      ...colourBlock(0xf800, 0x001f, 0x55555555),
    ]);
    const grey: Rgba = [132, 130, 132, 128];
    const blue: Rgba = [0, 0, 255, 128];
    assertRows(await decode_bc3(data, 8, 4), 8, [grey, grey, grey, grey, blue, blue, blue, blue]);
  });

  it("covers partial blocks and crops them (6x5 from 2x2 blocks)", async () => {
    const block = [...ALPHA_128, ...colourBlock(0x8410, 0x8410, ALL_INDEX_3)];
    const data = new Uint8Array([...block, ...block, ...block, ...block]);
    const bgra = await decode_bc3(data, 6, 5);
    assert.ok(bgra, "decoder returned null");
    assert.strictEqual(bgra.length, 6 * 5 * 4);
    for (let i = 0; i < 6 * 5; i++) {
      assert.deepStrictEqual(
        Array.from(bgra.subarray(i * 4, i * 4 + 4)),
        [132, 130, 132, 128],
        `pixel (${i % 6}, ${Math.floor(i / 6)})`
      );
    }
  });
});

describe("BC1 colour block: 3-colour mode when c0 <= c1 is unchanged (#137)", () => {
  before(async () => {
    await initialize();
  });

  // Pillow gives transparent black (0, 0, 0, 0) for index 3 here (D3D BC1 1-bit alpha).
  // The verdict on #131 is AssetStudio's opaque black: Unity's DXT1 has no alpha.
  it("c0 == c1 with index 3 is opaque black", async () => {
    const data = new Uint8Array(colourBlock(0x8410, 0x8410, ALL_INDEX_3));
    assertRows(await decode_bc1(data, 4, 4), 4, [[0, 0, 0, 255]]);
  });

  it("c0 < c1: index 2 is the midpoint, index 3 opaque black", async () => {
    // c2 = (c0 + c1) / 2, truncated. Pillow agrees except index 3 (see above).
    const data = new Uint8Array(colourBlock(0x001f, 0xf800, INDICES_0123));
    assertRows(await decode_bc1(data, 4, 4), 4, [
      [0, 0, 255, 255],
      [255, 0, 0, 255],
      [127, 0, 127, 255],
      [0, 0, 0, 255],
    ]);
  });
});
