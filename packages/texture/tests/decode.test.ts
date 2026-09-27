import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ClassID,
  CorruptError,
  load,
  readTexture2D,
  TextureFormat,
  UnsupportedError,
  type Texture2DData,
} from "unity-asset-reader";
import {
  golden,
  loadFixture,
  sha256,
  syntheticBytes,
  syntheticGoldens,
  type GoldenTexture,
} from "../../../fixtures/helpers.js";
import { decodeTexture2D, initTexture } from "../src/decode.js";

// The WASM half of texture2ddecoder-wasm is built with Docker (`npm run build:wasm`),
// which the reader CI job does not have; without it only the tests that need no
// decoder run (see scripts/test-decoder.mjs for the same rule). The CI job that
// builds the WASM sets REQUIRE_WASM=1, so there a missing WASM fails the run
// instead of silently skipping the decode tests (#119).
const WASM = "texture2ddecoder-wasm/wasm/texture2ddecoder.wasm";
const skip = existsSync(fileURLToPath(new URL(`../../${WASM}`, import.meta.url)))
  ? false
  : `packages/${WASM} not built (npm run build:wasm)`;
if (skip && process.env.REQUIRE_WASM === "1") {
  throw new Error(`REQUIRE_WASM=1 but ${skip}; the decode tests must not skip here`);
}

before(async () => {
  if (!skip) await initTexture();
});

/** A test that needs the decoder, skipped without it. */
const wasmTest = (name: string, fn: () => Promise<void>) => test(name, { skip }, fn);

/**
 * A hand-built input with only the fields decoding reads at run time; the cast
 * stands for the Texture2D fields it does not need.
 */
function texture(
  format: number,
  width: number,
  height: number,
  imageData: Uint8Array,
): Texture2DData {
  return { m_Width: width, m_Height: height, m_TextureFormat: format, imageData } as Texture2DData;
}

// --- fixtures -------------------------------------------------------------------

const BLOCK_FIXTURES = [
  "editor/6000.3.25f1/block/windows",
  "editor/6000.3.25f1/block/android",
  "editor/2019.4.41f2/block/ios",
];
const PLAIN = "editor/6000.3.25f1/plain/textures";

/** One Texture2D of a fixture, as `decodeTexture2D(obj.read())` gets it, and its golden. */
interface FixtureTexture {
  fixture: string;
  input: Texture2DData;
  mipCount: number;
  golden: GoldenTexture;
}

/** Every Texture2D of `fixture`, as `obj.read()` returns it (plan section 3). */
function fixtureTextures(fixture: string): FixtureTexture[] {
  const serialized = Object.values(golden(fixture).serialized ?? {});
  const env = load([{ name: fixture, data: loadFixture(fixture) }]);
  return env.objects
    .filter((obj) => obj.type === ClassID.Texture2D)
    .map((obj) => {
      const input = obj.read<Texture2DData>();
      const g = serialized.map((s) => s.textures?.[String(obj.pathId)]).find((t) => t);
      assert.ok(g, `${fixture}: no texture golden for ${obj.pathId}`);
      return { fixture, input, mipCount: input.m_MipCount ?? 1, golden: g };
    });
}

const BLOCK = BLOCK_FIXTURES.flatMap(fixtureTextures);

function block(format: number): FixtureTexture {
  const t = BLOCK.find((x) => x.input.m_TextureFormat === format);
  assert.ok(t, `no block fixture texture in format ${format}`);
  return t;
}

/**
 * RGBA sha256 of AssetStudio's own decoder over the block fixtures' image data,
 * where UnityPy decodes differently (the golden has `oracleNote`), and of its
 * pre-2017.3 Crunch path. Cross-check values under plan §6, not goldens; how
 * they were made: `fixtures/README.md`, Oracle notes, "AssetStudio block
 * cross-check hashes".
 */
const ASSETSTUDIO_RGBA: Record<string, string> = {
  "24_BC6H": "42cdc295c5fe0aca844c17acf6983193b4002e9cc73bc3fbc2ddfb4b7e2d780e",
  "26_BC4": "214087943b21df6caa26a08372a698aeffbd78d2c805c2d2d8f9900211a5952a",
  "48_ASTC_4x4": "cd2a4c2ba94e09dc5e540c2c12cec4c3ed62fcbe4163cf42867ec69a6c6fdf9f",
  "49_ASTC_5x5": "c4454872b228c2a7cd74b1aad2b44a8e529e9079c1f7ac97a683a0b549fe5214",
  "50_ASTC_6x6": "7d1dc977a7bdd63e3513c734a917f9b8803272b70e6f9829c68e457ddf0add0d",
  "51_ASTC_8x8": "eb854420ae8e057567ff735b771bce46a0c2f5086309a0adb8b48d4b1192d33e",
  "52_ASTC_10x10": "736098e58bd17f20e0cf683da44576b78837041ecb05fc9be98c441822f18db2",
  "53_ASTC_12x12": "79fbdc9d737141c0196c76f3620ce435929e0ff20e30f04816ef0c1cabd1ba85",
  "66_ASTC_HDR_4x4": "d04e8b3e6baace19d748a131f3220b2be677f576d8da80a24c82f39ea7026277",
  "71_ASTC_HDR_12x12": "09be7ddd48f37635d4994f24da12922851ab89495b6d7ed0d859ffc4a165cc70",
  // The same image data, read as a Unity 2017.1 file: UnpackCrunch, not UnpackUnityCrunch.
  "legacy 28_DXT1Crunched": "6585e7f9dbd03d8c4520addca1ced130bea0454ffbc148bc9137ddb391e17595",
  "legacy 29_DXT5Crunched": "f9cbe6a740b1060ec6de994017d8f6ed31435e3aff9768f640136b8802375173",
};

/** What the decode of `t` must hash to: the UnityPy golden, or AssetStudio's where they differ. */
function expected(t: FixtureTexture): string {
  const want = t.golden.oracleNote ? ASSETSTUDIO_RGBA[t.golden.name] : t.golden.rgbaSha256;
  assert.ok(want, `${t.golden.name}: no expected hash`);
  return want;
}

async function decode(input: Texture2DData): Promise<Uint8Array> {
  const out = await decodeTexture2D(input);
  assert.equal(out.width, input.m_Width);
  assert.equal(out.height, input.m_Height);
  assert.equal(out.data.length, input.m_Width * input.m_Height * 4);
  return out.data;
}

const F = TextureFormat;

/** Block width, height and bytes, for the fixtures' formats that are not 4x4 x 16 bytes. */
const BLOCKS: Record<number, [number, number, number]> = {
  [F.DXT1]: [4, 4, 8],
  [F.BC4]: [4, 4, 8],
  [F.ETC_RGB4]: [4, 4, 8],
  [F.EAC_R]: [4, 4, 8],
  [F.ETC2_RGB]: [4, 4, 8],
  [F.ETC2_RGBA1]: [4, 4, 8],
  [F.PVRTC_RGB2]: [8, 4, 8],
  [F.PVRTC_RGBA2]: [8, 4, 8],
  [F.PVRTC_RGB4]: [4, 4, 8],
  [F.PVRTC_RGBA4]: [4, 4, 8],
  [F.ASTC_RGB_5x5]: [5, 5, 16],
  [F.ASTC_RGB_6x6]: [6, 6, 16],
  [F.ASTC_RGB_8x8]: [8, 8, 16],
  [F.ASTC_RGB_10x10]: [10, 10, 16],
  [F.ASTC_RGB_12x12]: [12, 12, 16],
  [F.ASTC_HDR_12x12]: [12, 12, 16],
};

/** Bytes of the first mip level of a non-Crunch block texture. */
function firstLevelSize({ input }: FixtureTexture): number {
  const [bw, bh, bytes] = BLOCKS[input.m_TextureFormat] ?? [4, 4, 16];
  return Math.ceil(input.m_Width / bw) * Math.ceil(input.m_Height / bh) * bytes;
}

// --- fixtures vs goldens -------------------------------------------------------

test("the block fixtures have one Texture2D per format of #32", () => {
  const formats = BLOCK.map((t) => t.input.m_TextureFormat).sort((a, b) => a - b);
  assert.deepEqual(formats, [
    F.DXT1, F.DXT5, F.BC6H, F.BC7, F.BC4, F.BC5, F.DXT1Crunched, F.DXT5Crunched,
    F.PVRTC_RGB2, F.PVRTC_RGBA2, F.PVRTC_RGB4, F.PVRTC_RGBA4, F.ETC_RGB4,
    F.EAC_R, F.EAC_RG, F.ETC2_RGB, F.ETC2_RGBA1, F.ETC2_RGBA8,
    F.ASTC_RGB_4x4, F.ASTC_RGB_5x5, F.ASTC_RGB_6x6, F.ASTC_RGB_8x8, F.ASTC_RGB_10x10,
    F.ASTC_RGB_12x12, F.ETC_RGB4Crunched, F.ETC2_RGBA8Crunched, F.ASTC_HDR_4x4,
    F.ASTC_HDR_12x12,
  ]);
});

test("image data, as obj.read() will hand it over, matches the golden", () => {
  for (const t of BLOCK) {
    assert.equal(t.input.imageData.length, t.golden.imageSize, t.golden.name);
    assert.equal(sha256(t.input.imageData), t.golden.imageSha256, t.golden.name);
  }
});

wasmTest("RGBA sha256 = UnityPy golden, hashed after the BGRA -> RGBA swap", async () => {
  const agreed = BLOCK.filter((t) => !t.golden.oracleNote);
  // DXT1, DXT5, BC5, BC7, both DXT Crunch; ETC1, ETC2 RGB/RGBA1/RGBA8, EAC R/RG,
  // both ETC Crunch; the four PVRTC.
  assert.equal(agreed.length, 18);
  for (const t of agreed) {
    assert.ok(t.golden.rgbaSha256, t.golden.name);
    assert.equal(sha256(await decode(t.input)), t.golden.rgbaSha256, t.golden.name);
  }
});

wasmTest("BC4, BC6H and ASTC: RGBA sha256 = AssetStudio's, per the golden's verdict", async () => {
  const disagreed = BLOCK.filter((t) => t.golden.oracleNote);
  assert.deepEqual(
    disagreed.map((t) => t.golden.name).sort(),
    Object.keys(ASSETSTUDIO_RGBA).filter((k) => !k.startsWith("legacy")).sort(),
  );
  for (const t of disagreed) {
    assert.match(t.golden.oracleNote!, /Verdict: AssetStudio - see #32/, t.golden.name);
    assert.equal(sha256(await decode(t.input)), ASSETSTUDIO_RGBA[t.golden.name], t.golden.name);
  }
});

wasmTest("BC4 is AssetStudio's red-only form of the UnityPy grayscale golden", async () => {
  // AssetStudio writes the value to R, UnityPy to R, G and B; that map is one to
  // one, so the golden still pins every pixel.
  const t = block(TextureFormat.BC4);
  const rgba = await decode(t.input);
  const gray = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    assert.deepEqual([rgba[i + 1], rgba[i + 2], rgba[i + 3]], [0, 0, 255], `pixel ${i / 4}`);
    gray.set([rgba[i]!, rgba[i]!, rgba[i]!, 255], i);
  }
  assert.equal(sha256(gray), t.golden.rgbaSha256);
});

wasmTest("ATC and signed EAC (no editor writes them) = UnityPy on generated data", async () => {
  const synthetic = syntheticGoldens();
  assert.deepEqual(Object.keys(synthetic).sort(), [
    "ATC_RGB4", "ATC_RGBA8", "EAC_RG_SIGNED", "EAC_R_SIGNED",
  ]);
  for (const [name, g] of Object.entries(synthetic)) {
    assert.equal(g.format, TextureFormat[name as keyof typeof TextureFormat], name);
    const imageData = syntheticBytes(name, g.inputSize);
    assert.equal(sha256(imageData), g.inputSha256, name);
    const rgba = await decode(texture(g.format, g.width, g.height, imageData));
    assert.equal(sha256(rgba), g.rgbaSha256, name);
  }
});

wasmTest("the formats upstream decodes like a fixture's decode like it", async () => {

  // Upstream's switch: [alias, the fixture format it shares a decoder with].
  const aliases: [number, number][] = [
    [F.ETC_RGB4_3DS, F.ETC_RGB4],
    // UnityPy maps this one to ETC1; upstream, the source of truth, to ETC2 RGBA8.
    [F.ETC_RGBA8_3DS, F.ETC2_RGBA8],
    [F.ASTC_RGBA_4x4, F.ASTC_RGB_4x4],
    [F.ASTC_RGBA_5x5, F.ASTC_RGB_5x5],
    [F.ASTC_RGBA_6x6, F.ASTC_RGB_6x6],
    [F.ASTC_RGBA_8x8, F.ASTC_RGB_8x8],
    [F.ASTC_RGBA_10x10, F.ASTC_RGB_10x10],
    [F.ASTC_RGBA_12x12, F.ASTC_RGB_12x12],
    [F.ASTC_HDR_5x5, F.ASTC_RGB_5x5],
    [F.ASTC_HDR_6x6, F.ASTC_RGB_6x6],
    [F.ASTC_HDR_8x8, F.ASTC_RGB_8x8],
    [F.ASTC_HDR_10x10, F.ASTC_RGB_10x10],
  ];
  for (const [alias, format] of aliases) {
    const t = block(format);
    const rgba = await decode({ ...t.input, m_TextureFormat: alias });
    assert.equal(sha256(rgba), expected(t), `${alias} as ${format}`);
  }
});

// --- Crunch ---------------------------------------------------------------------

wasmTest("DXT Crunch without the 2017.3+ fields unpacks as the original crunch", async () => {
  for (const format of [TextureFormat.DXT1Crunched, TextureFormat.DXT5Crunched]) {
    const t = block(format);
    // A 6000.3 texture: m_IsAlphaChannelOptional (2020.2+), no m_DownscaleFallback (to 2023.1).
    assert.equal(typeof t.input.m_IsAlphaChannelOptional, "boolean");
    assert.equal(t.input.m_DownscaleFallback, undefined);
    const { m_IsAlphaChannelOptional: _, ...pre2017_3 } = t.input;
    assert.equal(sha256(await decode(pre2017_3)), ASSETSTUDIO_RGBA[`legacy ${t.golden.name}`]);
    // 2017.3 to 2023.1 write m_DownscaleFallback instead, and get Unity's crunch.
    const mid = { ...pre2017_3, m_DownscaleFallback: false };
    assert.equal(sha256(await decode(mid)), t.golden.rgbaSha256);
  }
});

wasmTest("ETC Crunch is always Unity's crunch", async () => {
  for (const format of [TextureFormat.ETC_RGB4Crunched, TextureFormat.ETC2_RGBA8Crunched]) {
    const t = block(format);
    const { m_IsAlphaChannelOptional: _, ...fieldsGone } = t.input;
    assert.equal(sha256(await decode(fieldsGone)), t.golden.rgbaSha256, t.golden.name);
  }
});

wasmTest("Crunch data that does not unpack is a CorruptError", async () => {
  const t = block(TextureFormat.DXT1Crunched);
  await assert.rejects(
    decodeTexture2D({ ...t.input, imageData: new Uint8Array(64).fill(7) }),
    (e: Error) =>
      e instanceof CorruptError && /DXT1Crunched \(28\).*Unity's Crunch/.test(e.message),
  );
});

// --- the bridge itself -------------------------------------------------------------

wasmTest("the decoder's BGRA comes out as RGBA", async () => {
  // One BC1 block: color0 = 0xF800 (pure red in RGB565), every index 0.
  const imageData = new Uint8Array([0x00, 0xf8, 0, 0, 0, 0, 0, 0]);
  const rgba = await decode(texture(TextureFormat.DXT1, 4, 4, imageData));
  for (let i = 0; i < 16; i++) {
    assert.deepEqual([...rgba.subarray(i * 4, i * 4 + 4)], [255, 0, 0, 255]);
  }
});

wasmTest("only the first mip level is decoded", async () => {
  const blockOnly = BLOCK.filter((t) => !/Crunched/.test(t.golden.name));
  for (const t of blockOnly) {
    assert.ok(t.mipCount > 1, `${t.golden.name} has no mips to ignore`);
    const first = firstLevelSize(t);
    assert.ok(t.input.imageData.length > first, t.golden.name);
    // The first level alone decodes to the same image, so nothing after it is read.
    const rgba = await decode({ ...t.input, imageData: t.input.imageData.subarray(0, first) });
    assert.equal(sha256(rgba), expected(t), t.golden.name);
  }
});

wasmTest("image data shorter than the first level: CorruptError with both sizes", async () => {
  const t = block(TextureFormat.ASTC_RGB_6x6);
  // 32 x 16 in 6x6 blocks: 6 x 3 blocks of 16 bytes.
  await assert.rejects(
    decodeTexture2D({ ...t.input, imageData: t.input.imageData.subarray(0, 287) }),
    (e: Error) =>
      e instanceof CorruptError &&
      e.message === "ASTC_RGB_6x6 (50) image data is 287 bytes, 32 x 16 needs 288",
  );
  await assert.rejects(
    decodeTexture2D({ ...t.input, imageData: new Uint8Array(0) }),
    CorruptError,
  );
});

wasmTest("PVRTC whose block counts are not powers of two is a CorruptError", async () => {
  const t = block(TextureFormat.PVRTC_RGBA4);
  // 24 pixels: 6 blocks of 4 across, which the decoder refuses.
  await assert.rejects(
    decodeTexture2D({ ...t.input, m_Width: 24 }),
    (e: Error) =>
      e instanceof CorruptError && /could not decode PVRTC_RGBA4 \(33\)/.test(e.message),
  );
});

wasmTest("DXT3 and formats nothing decodes are an UnsupportedError", async () => {
  for (const format of [TextureFormat.DXT3, TextureFormat.RG16, 1000]) {
    await assert.rejects(
      decodeTexture2D(texture(format, 4, 4, new Uint8Array(64))),
      (e: Error) =>
        e instanceof UnsupportedError && e.kind === "texture format" && e.found === format,
    );
  }
});

wasmTest("plain formats go through convertPlain", async () => {
  const agreed = fixtureTextures(PLAIN).filter((t) => t.golden.rgbaSha256 && !t.golden.oracleNote);
  assert.equal(agreed.length, 6);
  for (const t of agreed) {
    assert.equal(sha256(await decode(t.input)), t.golden.rgbaSha256, t.golden.name);
  }
  // And convertPlain's own errors come through as they are.
  await assert.rejects(
    decodeTexture2D(texture(TextureFormat.YUY2, 3, 1, new Uint8Array(8))),
    (e: Error) => e instanceof UnsupportedError && e.kind === "YUY2 texture width",
  );
});

wasmTest("a texture 0 pixels wide or high is an empty image", async () => {
  for (const [w, h] of [[0, 16], [32, 0]] as const) {
    const bc7 = block(TextureFormat.BC7).input;
    const out = await decodeTexture2D({ ...bc7, m_Width: w, m_Height: h });
    assert.deepEqual(out, { data: new Uint8Array(0), width: w, height: h });
  }
});

wasmTest("a size that is not a non-negative integer is a CorruptError", async () => {
  for (const [w, h] of [[-4, 4], [4.5, 4], [4, Number.NaN]] as const) {
    await assert.rejects(
      decodeTexture2D(texture(TextureFormat.DXT1, w, h, new Uint8Array(8))),
      CorruptError,
    );
  }
});

wasmTest("initTexture() again is a no-op", async () => {
  await initTexture();
  await initTexture({ wasmPath: "/ignored/in/node" });
  assert.equal((await decode(block(TextureFormat.DXT1).input)).length, 32 * 16 * 4);
});

// --- input checks (no decoder needed) ----------------------------------------------

test("an object that is not a Texture2D is a TypeError naming what is missing", async () => {
  // obj.read() is typed by the caller, so this compiles for any object: here a TextAsset.
  const fixture = "editor/6000.3.25f1/lz4/shared";
  const env = load([{ name: fixture, data: loadFixture(fixture) }]);
  const text = env.objects.find((o) => o.type === ClassID.TextAsset);
  assert.ok(text);
  await assert.rejects(decodeTexture2D(text.read()), {
    name: "TypeError",
    message:
      "decodeTexture2D: not a Texture2D with image data: m_Width must be a number (missing), " +
      "m_Height must be a number (missing), m_TextureFormat must be a number (missing), " +
      "imageData must be a Uint8Array (missing)",
  });
});

test("a Texture2D without imageData, or with it as the wrong type, is a TypeError", async () => {
  // readTexture2D's result (no imageData) is the likely mix-up with obj.read().
  const fields = readTexture2D(
    load([{ name: PLAIN, data: loadFixture(PLAIN) }]).objects.find(
      (o) => o.type === ClassID.Texture2D,
    )!,
  );
  const cases: [unknown, string][] = [
    [fields, "imageData must be a Uint8Array (missing)"],
    [{ ...fields, imageData: [1, 2, 3] }, "imageData must be a Uint8Array (Array)"],
    [{ ...fields, imageData: new ArrayBuffer(8) }, "imageData must be a Uint8Array (ArrayBuffer)"],
    [
      { ...fields, imageData: new Uint8Array(8), m_Width: "8" },
      "m_Width must be a number (string)",
    ],
  ];
  for (const [input, problem] of cases) {
    await assert.rejects(decodeTexture2D(input as Texture2DData), {
      name: "TypeError",
      message: `decodeTexture2D: not a Texture2D with image data: ${problem}`,
    });
  }
  for (const input of [null, undefined, 42]) {
    await assert.rejects(decodeTexture2D(input as unknown as Texture2DData), TypeError);
  }
});

// --- dependency direction ------------------------------------------------------------

test("core imports neither texture2ddecoder-wasm nor the texture package (R14)", () => {
  const src = fileURLToPath(new URL("../../core/src", import.meta.url));
  const files = readdirSync(src, { recursive: true, encoding: "utf8" });
  const ts = files.filter((f) => f.endsWith(".ts"));
  assert.ok(ts.length > 10);
  for (const file of ts) {
    const text = readFileSync(join(src, file), "utf8");
    assert.doesNotMatch(text, /["']texture2ddecoder-wasm|["']unity-asset-reader-texture/, file);
  }
});
