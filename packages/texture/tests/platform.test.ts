// Console layouts (#33): the Xbox 360 byte swap and the Switch deswizzle. No
// fixture editor here has either platform's module, so the expected bytes come
// from UnityPy run on generated data (the `platform` and `deswizzle` goldens),
// from AssetStudio's algorithm worked by hand, and from the linear fixtures
// relabelled with a console platform where the layout must not apply.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BuildTarget,
  ClassID,
  CorruptError,
  load,
  TextureFormat,
  UnsupportedError,
  type Texture2DData,
} from "unity-asset-reader";
import {
  deswizzleGoldens,
  fourColor,
  golden,
  loadFixture,
  platformGoldens,
  reverseRows,
  sha256,
  syntheticBytes,
  type GoldenTexture,
} from "../../../fixtures/helpers.js";
import { decodeTexture2D, initTexture } from "../src/decode.js";
import { deswizzle, switchLayout, xbox360Swap } from "../src/platform.js";

// Same rule as decode.test.ts: decode tests skip without the WASM, except where
// the CI job that builds it sets REQUIRE_WASM=1 (#119).
const WASM = "decoder/wasm/texture2ddecoder.wasm";
const skip = existsSync(fileURLToPath(new URL(`../../${WASM}`, import.meta.url)))
  ? false
  : `packages/${WASM} not built (npm run build:wasm)`;
if (skip && process.env.REQUIRE_WASM === "1") {
  throw new Error(`REQUIRE_WASM=1 but ${skip}; the decode tests must not skip here`);
}

before(async () => {
  if (!skip) await initTexture();
});

const wasmTest = (name: string, fn: () => Promise<void>) => test(name, { skip }, fn);

const F = TextureFormat;

/** A `m_PlatformBlob` of 12 bytes whose bytes 8-11 give log2 of the GOBs per block. */
function blob(gobsLog2: number): Uint8Array {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setUint32(8, gobsLog2, true);
  return out;
}

/** A hand-built input: the fields decoding reads, the cast standing for the rest. */
function texture(
  format: number,
  width: number,
  height: number,
  imageData: Uint8Array,
  platform: number,
  m_PlatformBlob?: Uint8Array,
): Texture2DData {
  return {
    m_Width: width,
    m_Height: height,
    m_TextureFormat: format,
    imageData,
    platform,
    m_PlatformBlob,
  } as Texture2DData;
}

/** One Texture2D of the Windows block fixture, as `obj.read()` gives it, and its golden. */
function windowsTexture(format: number): { input: Texture2DData; golden: GoldenTexture } {
  const fixture = "editor/6000.3.25f1/block/windows";
  const serialized = Object.values(golden(fixture).serialized ?? {});
  const env = load([{ name: fixture, data: loadFixture(fixture) }]);
  for (const obj of env.objects.filter((o) => o.type === ClassID.Texture2D)) {
    const input = obj.read<Texture2DData>();
    if (input.m_TextureFormat !== format) continue;
    const g = serialized.map((s) => s.textures?.[String(obj.pathId)]).find((t) => t);
    assert.ok(g?.rgbaSha256 && !g.oracleNote, `${fixture}: no agreed golden for ${format}`);
    return { input, golden: g };
  }
  throw new Error(`${fixture} has no Texture2D in format ${format}`);
}

/** `decodeTexture2D`, its rows back in stored order to compare with a texture golden. */
async function decodeStored(input: Texture2DData): Promise<string> {
  const out = await decodeTexture2D(input);
  return sha256(reverseRows(out.data, out.width));
}

/**
 * How many DXT5 blocks of `data` have a colour half with c0 <= c1, the blocks
 * upstream Texture2DDecoder decoded in 3-colour mode (#131). Xbox 360 stores
 * the 16-bit words big-endian.
 */
function lowC0Blocks(data: Uint8Array, bigEndian: boolean): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let n = 0;
  for (let block = 0; block < data.length; block += 16) {
    if (view.getUint16(block + 8, !bigEndian) <= view.getUint16(block + 10, !bigEndian)) n++;
  }
  return n;
}

// --- against UnityPy ------------------------------------------------------------

/** A format of each texel shape in the deswizzle goldens, as `switchLayout` takes it. */
const SHAPE_FORMAT: Record<string, number> = {
  "16x1": F.Alpha8,
  "8x1": F.ARGB4444,
  "4x1": F.RGBA32,
  "1x1": F.ARGBFloat,
  "8x4": F.DXT1,
  "4x4": F.DXT5,
  "5x5": F.ASTC_RGB_5x5,
  "6x6": F.ASTC_RGB_6x6,
  "8x8": F.ASTC_RGB_8x8,
  "10x10": F.ASTC_RGBA_10x10,
  "12x12": F.ASTC_RGBA_12x12,
};

test("Switch: padding and deswizzle = UnityPy's, for every texel shape it knows", () => {
  const goldens = deswizzleGoldens();
  assert.deepEqual(Object.keys(goldens).sort(), Object.keys(SHAPE_FORMAT).sort());
  for (const [name, g] of Object.entries(goldens)) {
    const format = SHAPE_FORMAT[name]!;
    const gobs = blob(Math.log2(g.gobsPerBlock));
    const layout = switchLayout(BuildTarget.Switch, gobs, format, g.width, g.height);
    assert.ok(layout, name);
    const { texelWidth, texelHeight, gobsPerBlock, paddedWidth, paddedHeight } = g;
    const want = { format, texelWidth, texelHeight, gobsPerBlock, paddedWidth, paddedHeight };
    assert.deepEqual(layout, want, name);
    const input = syntheticBytes(`deswizzle ${name}`, g.inputSize);
    assert.equal(sha256(input), g.inputSha256, name);
    const out = deswizzle(input, layout);
    assert.equal(out.length, g.inputSize, name);
    assert.equal(sha256(out), g.outputSha256, name);
    // A permutation: every byte moved, none made up (the input is sha256 output,
    // so a texel repeated or dropped would change the sorted bytes).
    assert.deepEqual([...out].sort(), [...input].sort(), name);
  }
});

wasmTest("Switch and Xbox 360 textures = UnityPy on generated data, top row first", async () => {
  const goldens = platformGoldens();
  assert.deepEqual(Object.keys(goldens).sort(), [
    "Switch ARGB4444", "Switch BC5", "Switch DXT1", "Switch DXT5", "Switch RGB24",
    "Switch RGBA32", "XBOX360 DXT1", "XBOX360 DXT5",
  ]);
  for (const [name, g] of Object.entries(goldens)) {
    // DXT1 inputs in 4-colour blocks, where UnityPy's decoder and AssetStudio's agree.
    const imageData = syntheticBytes(name, g.inputSize);
    if (g.fourColor) fourColor(imageData, ...g.fourColor);
    assert.equal(sha256(imageData), g.inputSha256, name);
    assert.equal(g.fourColor !== null, g.format === F.DXT1, `${name}: fourColor`);
    // DXT5 inputs as generated, c0 <= c1 colour blocks included: the decoder decodes
    // them in 4-colour mode, as the spec and Pillow do (#137, #147).
    if (g.format === F.DXT5) {
      const low = lowC0Blocks(imageData, g.platform === BuildTarget.XBOX360);
      assert.ok(low > 0, `${name}: no c0 <= c1 colour block`);
    }
    const platformBlob =
      g.platformBlob === null ? undefined : new Uint8Array(Buffer.from(g.platformBlob, "hex"));
    const input = texture(g.format, g.width, g.height, imageData, g.platform, platformBlob);
    const out = await decodeTexture2D(input);
    assert.equal(out.width, g.width, name);
    assert.equal(out.height, g.height, name);
    // UnityPy's flip=True: what decodeTexture2D returns.
    assert.equal(sha256(out.data), g.rgbaTopDownSha256, name);
    // And flip=False, which is reverseRows of it: the other tests' way back to the goldens.
    assert.equal(sha256(reverseRows(out.data, out.width)), g.rgbaSha256, name);
    assert.equal(sha256(imageData), g.inputSha256, `${name}: imageData is not modified`);
  }
});

// --- Xbox 360 -------------------------------------------------------------------

wasmTest("Xbox 360 ARGB4444 and RGB565 read their 16-bit words big-endian", async () => {
  // AssetStudio's SwapBytesForXbox, worked by hand. ARGB4444 0x1234: A 1, R 2, G 3,
  // B 4, each nibble times 0x11. UnityPy does not swap ARGB4444, so it is no oracle here.
  const argb = new Uint8Array([0x12, 0x34]);
  const xbox = await decodeTexture2D(texture(F.ARGB4444, 1, 1, argb, BuildTarget.XBOX360));
  assert.deepEqual([...xbox.data], [0x22, 0x33, 0x44, 0x11]);
  // Anywhere else the word is little-endian, 0x3412.
  const windows = BuildTarget.StandaloneWindows64;
  const pc = await decodeTexture2D(texture(F.ARGB4444, 1, 1, argb, windows));
  assert.deepEqual([...pc.data], [0x44, 0x11, 0x22, 0x33]);

  // RGB565 0xF800 is pure red; read little-endian, 0x00F8 is R 0, G 7, B 24, widened.
  const rgb = new Uint8Array([0xf8, 0x00]);
  const red = await decodeTexture2D(texture(F.RGB565, 1, 1, rgb, BuildTarget.XBOX360));
  assert.deepEqual([...red.data], [255, 0, 0, 255]);
  const other = await decodeTexture2D(texture(F.RGB565, 1, 1, rgb, BuildTarget.PS3));
  assert.deepEqual([...other.data], [0, 28, 198, 255]);
  assert.deepEqual([...argb, ...rgb], [0x12, 0x34, 0xf8, 0x00], "imageData is not modified");
});

wasmTest("Xbox 360 leaves Crunch and the other formats as stored (AssetStudio)", async () => {
  // UnityPy also swaps DXT1Crunched and DXT5Crunched; AssetStudio, the source of
  // truth, does not. Formats upstream never swaps are the same bytes on any platform.
  for (const format of [F.DXT1Crunched, F.DXT5Crunched, F.BC7, F.BC5]) {
    const t = windowsTexture(format);
    const input = { ...t.input, platform: BuildTarget.XBOX360 };
    assert.equal(await decodeStored(input), t.golden.rgbaSha256, t.golden.name);
  }
});

test("xbox360Swap swaps every 16-bit word of the formats upstream names, into a copy", () => {
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  for (const format of [F.ARGB4444, F.RGB565, F.DXT1, F.DXT5]) {
    // The whole image data, as upstream swaps it; an odd last byte stays.
    assert.deepEqual([...xbox360Swap(data, BuildTarget.XBOX360, format)], [2, 1, 4, 3, 5]);
  }
  assert.deepEqual([...data], [1, 2, 3, 4, 5]);
  for (const [platform, format] of [
    [BuildTarget.XBOX360, F.RGBA4444],
    [BuildTarget.XBOX360, F.DXT1Crunched],
    [BuildTarget.XboxOne, F.DXT1],
    [BuildTarget.PS3, F.RGB565],
  ] as const) {
    assert.equal(xbox360Swap(data, platform, format), data, `${platform} ${format}`);
  }
});

// --- Switch -----------------------------------------------------------------------

wasmTest("Switch with no block-linear blob decodes as linear", async () => {
  // UnityPy's is_switch_swizzled: a blob of 12+ bytes giving 2+ GOBs per block.
  // Unity before 2020.2 has no blob; the fixture's own is empty.
  const t = windowsTexture(F.DXT1);
  assert.equal(t.input.m_PlatformBlob?.length, 0);
  for (const m_PlatformBlob of [undefined, t.input.m_PlatformBlob, new Uint8Array(11), blob(0)]) {
    const input = { ...t.input, platform: BuildTarget.Switch, m_PlatformBlob };
    assert.equal(await decodeStored(input), t.golden.rgbaSha256, `${m_PlatformBlob?.length}`);
  }
  // Nor does a blob count on any other platform.
  const xboxOne = { ...t.input, platform: BuildTarget.XboxOne, m_PlatformBlob: blob(4) };
  assert.equal(await decodeStored(xboxOne), t.golden.rgbaSha256);
});

// --- PlayStation ------------------------------------------------------------------

wasmTest("PS4 and PS5 textures are refused until they can be detiled (#130, R9)", async () => {
  // Real image data, so only the platform can be what is refused.
  const t = windowsTexture(F.DXT1);
  for (const [platform, name] of [[BuildTarget.PS4, "PS4"], [BuildTarget.PS5, "PS5"]] as const) {
    await assert.rejects(decodeTexture2D({ ...t.input, platform }), {
      name: "UnsupportedError",
      message:
        `unsupported texture platform: ${platform} (${name} textures may be tiled, and ` +
        "detiling them is not supported yet (#130))",
    });
  }
  // Every other platform decodes, PS3 and PS Vita included: no upstream tiles them either.
  for (const platform of [BuildTarget.PS3, BuildTarget.PSP2, BuildTarget.UnknownPlatform]) {
    assert.equal(await decodeStored({ ...t.input, platform }), t.golden.rgbaSha256, `${platform}`);
  }
});

test("switchLayout: RGB24 and BGR24 are stored as RGBA32 and BGRA32", () => {
  assert.equal(switchLayout(BuildTarget.Switch, blob(1), F.RGB24, 4, 4)?.format, F.RGBA32);
  assert.equal(switchLayout(BuildTarget.Switch, blob(1), F.BGR24, 4, 4)?.format, F.BGRA32);
  assert.equal(switchLayout(BuildTarget.Switch, blob(1), F.BC7, 0, 0)?.paddedWidth, 0);
});

wasmTest("Switch: a format with no layout, or over 32 GOBs a block, is unsupported", async () => {
  // Not in UnityPy's texel map, which raises for them.
  const data = new Uint8Array(4096);
  for (const format of [F.DXT1Crunched, F.ETC2_RGBA8, F.PVRTC_RGBA4, F.ASTC_HDR_4x4, F.RGBAHalf]) {
    await assert.rejects(
      decodeTexture2D(texture(format, 8, 8, data, BuildTarget.Switch, blob(1))),
      (e: Error) =>
        e instanceof UnsupportedError &&
        e.kind === "Switch-swizzled texture format" &&
        e.found === format,
    );
  }
  await assert.rejects(
    decodeTexture2D(texture(F.DXT1, 8, 8, data, BuildTarget.Switch, blob(6))),
    (e: Error) => e instanceof UnsupportedError && e.found === 6,
  );
});

wasmTest("Switch data short of the padded level: CorruptError with both sizes", async () => {
  // 20 x 10 RGBA32, 2 GOBs a block: padded to 32 x 16, 2048 bytes.
  const g = platformGoldens()["Switch RGBA32"]!;
  assert.equal(g.inputSize, 2048);
  const short = syntheticBytes("Switch RGBA32", 2047);
  await assert.rejects(
    decodeTexture2D(texture(F.RGBA32, 20, 10, short, BuildTarget.Switch, blob(1))),
    (e: Error) =>
      e instanceof CorruptError &&
      e.message ===
        "Switch-swizzled format 4 image data is 2047 bytes, its 32 x 16 padded level needs 2048",
  );
  // Longer data (further mip levels) is fine: only the first level is read.
  const long = new Uint8Array(4096);
  long.set(syntheticBytes("Switch RGBA32", 2048));
  const out = await decodeTexture2D(texture(F.RGBA32, 20, 10, long, BuildTarget.Switch, blob(1)));
  assert.equal(sha256(out.data), g.rgbaTopDownSha256);
});

// --- input checks (no decoder needed) ----------------------------------------------

test("platform and m_PlatformBlob of the wrong type are a TypeError", async () => {
  const base = texture(F.RGBA32, 1, 1, new Uint8Array(4), BuildTarget.Switch);
  const cases: [unknown, string][] = [
    [{ ...base, platform: "Switch" }, "platform must be a number (string)"],
    [{ ...base, m_PlatformBlob: [0, 1] }, "m_PlatformBlob must be a Uint8Array (Array)"],
  ];
  for (const [input, problem] of cases) {
    await assert.rejects(decodeTexture2D(input as Texture2DData), {
      name: "TypeError",
      message: `decodeTexture2D: not a Texture2D with image data: ${problem}`,
    });
  }
});
