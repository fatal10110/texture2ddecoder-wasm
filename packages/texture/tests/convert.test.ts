import assert from "node:assert/strict";
import { test } from "node:test";
import { ClassID, CorruptError, load, UnsupportedError } from "unity-asset-reader";
import {
  fixtureNames,
  golden,
  loadFixture,
  sha256,
  type GoldenTexture,
} from "../../../fixtures/helpers.js";
import { convertPlain, halfToFloat } from "../src/convert.js";

// --- fixtures -------------------------------------------------------------------

/** One Texture2D of a fixture: its fields, image bytes and golden. */
interface FixtureTexture {
  fixture: string;
  width: number;
  height: number;
  format: number;
  image: Uint8Array;
  /** Whether `image` came from the `.resS` node rather than `image data`. */
  fromResS: boolean;
  golden: GoldenTexture;
}

/**
 * Every Texture2D the goldens describe, image bytes read the way #29/#30 will:
 * `image data` when it is inline, else `m_StreamData`'s slice of the `.resS`
 * node (neither the class reader nor the resolver exists yet).
 */
function fixtureTextures(): FixtureTexture[] {
  const out: FixtureTexture[] = [];
  for (const fixture of fixtureNames()) {
    // Block and Crunch formats go through texture2ddecoder-wasm: decode.test.ts (#32).
    if (fixture.includes("/block/")) continue;
    const serialized = Object.values(golden(fixture).serialized ?? {});
    if (!serialized.some((s) => s.textures)) continue;
    const env = load([{ name: fixture, data: loadFixture(fixture) }]);
    for (const obj of env.objects.filter((o) => o.type === ClassID.Texture2D)) {
      const g = serialized.map((s) => s.textures?.[String(obj.pathId)]).find((t) => t);
      assert.ok(g, `${fixture}: no texture golden for ${obj.pathId}`);
      const tree = obj.readTypeTree() as {
        m_Width: number;
        m_Height: number;
        m_TextureFormat: number;
        "image data": Uint8Array;
        m_StreamData: { offset: number | bigint; size: number; path: string };
      };
      let image = tree["image data"];
      const stream = tree.m_StreamData;
      if (stream.size > 0) {
        const node = env.files.find((f) => stream.path.endsWith(`/${f.path}`));
        assert.ok(node, `${fixture}: no node for ${stream.path}`);
        const offset = Number(stream.offset);
        image = node.data.subarray(offset, offset + stream.size);
      }
      out.push({
        fixture,
        width: tree.m_Width,
        height: tree.m_Height,
        format: tree.m_TextureFormat,
        image,
        fromResS: stream.size > 0,
        golden: g,
      });
    }
  }
  return out;
}

const TEXTURES = fixtureTextures();
const PLAIN = "editor/6000.3.25f1/plain/textures";

/**
 * RGBA sha256 of AssetStudio's own decode methods (`Texture2DConverter.cs`
 * verbatim, `Half.cs` / `HalfHelper.cs`, .NET 8, run outside the repo), over the
 * image data of the `plain` fixture, for the formats UnityPy either cannot
 * decode (its golden has `oracleError`) or decodes differently (`oracleNote`).
 * The plan's cross-check for an oracle that is wrong or silent (§5, §6), not
 * goldens. Provenance (upstream revision, methods, runtime, BGRA -> RGBA swap):
 * `fixtures/README.md`, Oracle notes, "AssetStudio cross-check hashes".
 */
const ASSETSTUDIO_RGBA: Record<string, string> = {
  Alpha8: "1fdf356f8a42f7cc8f3574135d5239b7def065384872d4eae7c7ea8dcfcba91e",
  RGB565: "2d03c0063163cecb11bcffa2c934d7db90f26afe8bab3ef5804843bcbfac26f2",
  R16: "39d08dd77a2b706c6388a891a69aa1c0f3d4f537fe2bd9ddc93176f3ce92f90d",
  RHalf: "7d1f9ed63b0f61a2292f22544d1981404039cea030c046ed7c1e6b13cd8eb32e",
  RGHalf: "9f5fb24aae742964a0af9f994221e1ed917fb6e1215c9625ee03a966629ad156",
  RGBAHalf: "0ac6051e4db54467d9f11b0b24d6a9a806ec6ee68fe5a698ddd407b25e1c3f52",
  RFloat: "7d1f9ed63b0f61a2292f22544d1981404039cea030c046ed7c1e6b13cd8eb32e",
  RGFloat: "9f5fb24aae742964a0af9f994221e1ed917fb6e1215c9625ee03a966629ad156",
  RGBAFloat: "0ac6051e4db54467d9f11b0b24d6a9a806ec6ee68fe5a698ddd407b25e1c3f52",
  YUY2: "87386df74060278877b43a941054a227e8f6577b7bff6fec59a8d3be57bc0c3a",
  RGB9e5Float: "ea5b40bc9d49ce996b4cccaf6e70a2fe59517db501877d14a73612880d7b2611",
};

function plain(name: string): FixtureTexture {
  const t = TEXTURES.find((x) => x.fixture === PLAIN && x.golden.name === name);
  assert.ok(t, `${PLAIN} has no ${name} texture`);
  return t;
}

function decode(t: FixtureTexture): Uint8Array {
  const out = convertPlain(t.image, t.width, t.height, t.format);
  assert.equal(out.width, t.width);
  assert.equal(out.height, t.height);
  assert.equal(out.data.length, t.width * t.height * 4);
  return out.data;
}

test("the plain fixture has one Texture2D per format of #31", () => {
  const formats = TEXTURES.filter((t) => t.fixture === PLAIN).map((t) => t.format);
  assert.deepEqual(
    formats.sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 7, 9, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22],
  );
});

test("image bytes, inline or sliced from .resS, match the golden", () => {
  assert.ok(TEXTURES.some((t) => t.fromResS), "no texture reads from .resS");
  assert.ok(TEXTURES.some((t) => !t.fromResS), "no texture with inline image data");
  for (const t of TEXTURES) {
    assert.equal(t.image.length, t.golden.imageSize, `${t.fixture} ${t.golden.name}`);
    assert.equal(sha256(t.image), t.golden.imageSha256, `${t.fixture} ${t.golden.name}`);
  }
});

test("RGBA sha256 = UnityPy golden where the oracle and AssetStudio agree", () => {
  const agreed = TEXTURES.filter((t) => t.golden.rgbaSha256 && !t.golden.oracleNote);
  // RGBA32 x 9 editor-built `texture` bundles and 4 in each of the 2 `sprite`
  // bundles (#34), plus ARGB4444, RGB24, RGBA32, ARGB32, RGBA4444 and BGRA32
  // from the plain fixture.
  assert.equal(agreed.length, 23);
  for (const t of agreed) {
    assert.equal(sha256(decode(t)), t.golden.rgbaSha256, `${t.fixture} ${t.golden.name}`);
  }
});

test("convertPlain keeps the stored row order, bottom row first (decodeTexture2D flips)", () => {
  // RGBA32 is RGBA already, so any reordering of rows would show.
  for (const t of TEXTURES.filter((x) => x.format === 4)) {
    assert.deepEqual(decode(t), t.image.subarray(0, t.width * t.height * 4), t.fixture);
  }
});

test("Alpha8: alpha = UnityPy golden; colour white as in AssetStudio, not UnityPy's 0", () => {
  const t = plain("Alpha8");
  assert.match(t.golden.oracleNote ?? "", /Alpha8/);
  const rgba = decode(t);
  const black = rgba.slice();
  for (let i = 0; i < rgba.length; i += 4) {
    assert.deepEqual([...rgba.subarray(i, i + 3)], [255, 255, 255]);
    black.fill(0, i, i + 3);
  }
  assert.equal(sha256(black), t.golden.rgbaSha256);
});

test("RGB565: channel bits = UnityPy golden; widened by bit repetition as in AssetStudio", () => {
  const t = plain("RGB565");
  assert.match(t.golden.oracleNote ?? "", /RGB565/);
  const rgba = decode(t);
  const pillow = rgba.slice();
  for (let i = 0; i < rgba.length; i += 4) {
    for (const [c, bits] of [[0, 5], [1, 6], [2, 5]] as const) {
      const x = rgba[i + c]! >> (8 - bits);
      // AssetStudio repeats the top bits into the bottom ...
      assert.equal(rgba[i + c], (x << (8 - bits)) | (x >> (2 * bits - 8)));
      // ... Pillow (UnityPy) computes floor(x * 255 / max) from the same x.
      pillow[i + c] = Math.floor((x * 255) / ((1 << bits) - 1));
    }
  }
  assert.equal(sha256(pillow), t.golden.rgbaSha256);
});

test("formats UnityPy cannot decode or decodes differently = AssetStudio cross-check", () => {
  const checked = TEXTURES.filter((t) => t.golden.oracleError || t.golden.oracleNote);
  assert.deepEqual(checked.map((t) => t.golden.name).sort(), Object.keys(ASSETSTUDIO_RGBA).sort());
  for (const t of checked) {
    assert.equal(t.fixture, PLAIN);
    assert.equal(sha256(decode(t)), ASSETSTUDIO_RGBA[t.golden.name], t.golden.name);
  }
});

test("half and float fixtures decode to the k/16 levels BUILDING.md writes", () => {
  // Component j holds (j % 17) / 16; round-half-even(v * 255) by hand:
  const LEVELS = [0, 16, 32, 48, 64, 80, 96, 112, 128, 143, 159, 175, 191, 207, 223, 239, 255];
  const level = (j: number) => LEVELS[j % 17]!;
  for (const [channels, names] of [
    [1, ["RHalf", "RFloat"]],
    [2, ["RGHalf", "RGFloat"]],
    [4, ["RGBAHalf", "RGBAFloat"]],
  ] as const) {
    for (const name of names) {
      const rgba = decode(plain(name));
      for (let i = 0; i < rgba.length / 4; i++) {
        const want = [0, 1, 2, 3].map((c) =>
          c < channels ? level(i * channels + c) : c === 3 ? 255 : 0,
        );
        assert.deepEqual([...rgba.subarray(i * 4, i * 4 + 4)], want, `${name} pixel ${i}`);
      }
    }
  }
});

// --- hand-built, expected values from the format spec -------------------------------

/** Little-endian bytes of 16- or 32-bit values, whatever the host's byte order. */
function le(size: 2 | 4, values: number[]): Uint8Array {
  const view = new DataView(new ArrayBuffer(values.length * size));
  values.forEach((v, i) =>
    size === 2 ? view.setUint16(i * 2, v, true) : view.setUint32(i * 4, v >>> 0, true),
  );
  return new Uint8Array(view.buffer);
}
const u16 = (...v: number[]) => le(2, v);
const u32 = (...v: number[]) => le(4, v);
const rgba = (data: Uint8Array, width: number, height: number, format: number) => [
  ...convertPlain(data, width, height, format).data,
];

test("8-bit channel orders: RGB24, RGBA32, ARGB32, BGRA32, Alpha8", () => {
  assert.deepEqual(rgba(new Uint8Array([1, 2, 3, 4, 5, 6]), 2, 1, 3), [1, 2, 3, 255, 4, 5, 6, 255]);
  assert.deepEqual(rgba(new Uint8Array([1, 2, 3, 4]), 1, 1, 4), [1, 2, 3, 4]);
  assert.deepEqual(rgba(new Uint8Array([4, 1, 2, 3]), 1, 1, 5), [1, 2, 3, 4]);
  assert.deepEqual(rgba(new Uint8Array([3, 2, 1, 4]), 1, 1, 14), [1, 2, 3, 4]);
  assert.deepEqual(rgba(new Uint8Array([0, 128]), 2, 1, 1), [255, 255, 255, 0, 255, 255, 255, 128]);
});

test("ARGB4444 and RGBA4444: little-endian 16-bit, nibble x 0x11", () => {
  // A=F R=1 G=A B=2 and R=1 G=A B=2 A=F.
  assert.deepEqual(rgba(u16(0xf1a2), 1, 1, 2), [0x11, 0xaa, 0x22, 0xff]);
  assert.deepEqual(rgba(u16(0x1a2f), 1, 1, 13), [0x11, 0xaa, 0x22, 0xff]);
});

test("RGB565: R in the top 5 bits, channels widened by repeating their top bits", () => {
  // R = 17 (10001b), G = 33 (100001b), B = 1: 17 << 11 | 33 << 5 | 1 = 0x8c21.
  // (10001b << 3) | 100b = 140, (100001b << 2) | 10b = 134, (1 << 3) | 0 = 8.
  // Pillow's floor(x * 255 / max) would give 139, 133, 8 (see the golden's oracleNote).
  assert.deepEqual(rgba(u16(0x8c21, 0xffff, 0), 3, 1, 7), [
    140, 134, 8, 255, 255, 255, 255, 255, 0, 0, 0, 255,
  ]);
});

test("R16: (c * 255 + 32895) >> 16, rounding rather than keeping the high byte", () => {
  // 128 -> 0.498, 129 -> 0.502, 32767 -> 127.498, 32768 -> 128.002, 65280 -> 254.004
  // (the high byte would say 255), 257 -> 1.
  const r = rgba(u16(0, 65535, 128, 129, 32767, 32768, 257, 65280), 8, 1, 9);
  assert.deepEqual(r.filter((_, i) => i % 4 === 0), [0, 255, 0, 1, 127, 128, 1, 254]);
  assert.ok(r.every((v, i) => (i % 4 === 3 ? v === 255 : i % 4 === 0 || v === 0)));
});

test("half-float decode per Half.cs: normals, subnormals, zero signs, infinities, NaN", () => {
  assert.equal(halfToFloat(0x3c00), 1);
  assert.equal(halfToFloat(0xc000), -2);
  assert.equal(halfToFloat(0x3555), 0.333251953125); // 1365/4096
  assert.equal(halfToFloat(0x7bff), 65504);
  assert.equal(halfToFloat(0x0400), 2 ** -14);
  assert.equal(halfToFloat(0x03ff), 1023 * 2 ** -24);
  assert.equal(halfToFloat(0x0001), 2 ** -24);
  assert.ok(Object.is(halfToFloat(0x0000), 0));
  assert.ok(Object.is(halfToFloat(0x8000), -0));
  assert.equal(halfToFloat(0x7c00), Infinity);
  assert.equal(halfToFloat(0xfc00), -Infinity);
  assert.ok(Number.isNaN(halfToFloat(0x7e00)));
  assert.ok(Number.isNaN(halfToFloat(0xfc01)));
});

test("RHalf / RGHalf / RGBAHalf: value * 255 in single precision, half to even, saturated", () => {
  // 0.5 -> 127.5 -> 128 (even); 2^-24 -> 0; +Inf -> 255; -Inf, NaN, -1 -> 0;
  // 2.0 -> 255; 0.99951171875 -> 254.875 -> 255.
  const r = rgba(u16(0x3800, 0x0001, 0x7c00, 0xfc00, 0x7e00, 0xbc00, 0x4000, 0x3bff), 8, 1, 15);
  assert.deepEqual(r.filter((_, i) => i % 4 === 0), [128, 0, 255, 0, 0, 0, 255, 255]);
  // R = 1.0, G = 0.25 -> 63.75 -> 64.
  assert.deepEqual(rgba(u16(0x3c00, 0x3400), 1, 1, 16), [255, 64, 0, 255]);
  assert.deepEqual(rgba(u16(0x0000, 0x3800, 0x3c00, 0x3400), 1, 1, 17), [0, 128, 255, 64]);
});

test("RFloat / RGFloat / RGBAFloat: single-precision product, half to even, saturated", () => {
  // 0x3c20a0a1 * 255 is 2.50000009 in double but exactly 2.5 in single
  // precision, which rounds to even: 2 (a double product would give 3).
  // 0x3b008081 * 255 is 0.5 in single precision: 0. Then 0.5, 1, 2, -1, NaN, 0.25.
  const data = u32(
    0x3c20a0a1, 0x3b008081, 0x3f000000, 0x3f800000,
    0x40000000, 0xbf800000, 0x7fc00000, 0x3e800000,
  );
  const r = rgba(data, 8, 1, 18);
  assert.deepEqual(r.filter((_, i) => i % 4 === 0), [2, 0, 128, 255, 255, 0, 0, 64]);
  assert.deepEqual(rgba(u32(0x3e800000, 0x3f800000), 1, 1, 19), [64, 255, 0, 255]);
  assert.deepEqual(rgba(u32(0x3f800000, 0x3f000000, 0, 0x3e800000), 1, 1, 20), [255, 128, 0, 64]);
});

test("RGB9e5Float: 9-bit mantissas x 2^(exponent - 24), R in the low bits", () => {
  // e = 15: 256 / 512 * 255 = 127.5 -> 128, 128 / 512 * 255 = 63.75 -> 64,
  // 511 / 512 * 255 = 254.502 -> 255. e = 31: R = 511 * 2^7 * 255 and G = 2^7 * 255
  // saturate to 255.
  const data = u32((15 << 27) | (511 << 18) | (128 << 9) | 256, (31 << 27) | (1 << 9) | 511);
  assert.deepEqual(rgba(data, 2, 1, 22), [128, 64, 255, 255, 255, 255, 0, 255]);
});

test("YUY2: Y0 U Y1 V, integer BT.601 video range, clamped", () => {
  // Y 0 / 255 with U = 0, V = 255: R = (298 * -16 + 409 * 127 + 128) >> 8 = 184,
  // G, B below 0; then c = 239: R 481 -> 255, G = 57734 >> 8 = 225, B = 5302 >> 8 = 20.
  // Y 16 / 235 with U = V = 128: black and (298 * 219 + 128) >> 8 = 255, white.
  assert.deepEqual(rgba(new Uint8Array([0, 0, 255, 255, 16, 128, 235, 128]), 4, 1, 21), [
    184, 0, 0, 255, 255, 225, 20, 255, 0, 0, 0, 255, 255, 255, 255, 255,
  ]);
});

// --- edges and unhappy paths ------------------------------------------------------------

test("only the first mip level is read; the input is neither kept nor changed", () => {
  const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 9]);
  const out = convertPlain(data, 2, 1, 4);
  assert.deepEqual([...out.data], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.notEqual(out.data.buffer, data.buffer);
  out.data[0] = 0;
  assert.equal(data[0], 1);
});

test("a view at an odd byte offset reads the same as a copy", () => {
  const backing = new Uint8Array([0xee, 0x21, 0x8c, 0xa2, 0xf1]);
  assert.deepEqual(rgba(backing.subarray(1, 3), 1, 1, 7), [140, 134, 8, 255]);
  assert.deepEqual(rgba(backing.subarray(3), 1, 1, 2), [0x11, 0xaa, 0x22, 0xff]);
});

test("a 0 x 0 texture converts to an empty image", () => {
  assert.deepEqual(convertPlain(new Uint8Array(), 0, 0, 4), {
    data: new Uint8Array(),
    width: 0,
    height: 0,
  });
});

test("block, Crunch and unknown formats throw UnsupportedError naming the format", () => {
  for (const format of [10, 12, 28, 47, 63, 0, 999]) {
    assert.throws(
      () => convertPlain(new Uint8Array(64), 4, 4, format),
      (e: unknown) =>
        e instanceof UnsupportedError && e.kind === "texture format" && e.found === format,
    );
  }
});

test("YUY2 of odd width throws UnsupportedError", () => {
  assert.throws(() => convertPlain(new Uint8Array(64), 3, 2, 21), UnsupportedError);
});

test("image data shorter than width x height pixels throws CorruptError with both sizes", () => {
  assert.throws(
    () => convertPlain(new Uint8Array(63), 4, 4, 4),
    (e: unknown) => e instanceof CorruptError && /63 bytes.*4 x 4 needs 64/.test(e.message),
  );
  assert.throws(() => convertPlain(new Uint8Array(79), 8, 5, 21), CorruptError);
  assert.throws(() => convertPlain(new Uint8Array(15), 1, 1, 20), CorruptError);
});

test("a negative or fractional size throws CorruptError", () => {
  for (const [w, h] of [[-1, 1], [1, -1], [1.5, 1], [Number.NaN, 1]] as const) {
    assert.throws(() => convertPlain(new Uint8Array(64), w, h, 4), CorruptError);
  }
});
