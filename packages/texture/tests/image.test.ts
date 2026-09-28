// isImage / imageInfo / decodeImage / images() over assets (#185): the fields
// against the oracle's type tree dumps and texture and sprite goldens (R12),
// the pixels against the same RGBA goldens as decode.test.ts and
// sprite.test.ts, and the #185 usage block compiled under strict and run.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  load,
  ResourceNotFoundError,
  SpritePackingRotation,
  TextureFormat,
  UnsupportedError,
  type Asset,
  type Env,
  type ObjectReader,
  type Sprite,
} from "unity-asset-reader";
import {
  fixtureNames,
  golden,
  loadFixture,
  reverseRows,
  sha256,
  type GoldenSerialized,
} from "../../../fixtures/helpers.js";
import {
  decodeImage,
  imageInfo,
  images,
  isImage,
  type DecodedImage,
  type ImageInfo,
} from "../src/image.js";
import { cutSprite, spriteSize } from "../src/sprite.js";
import { usage } from "./types/usage.js";

// As in decode.test.ts: without the WASM (built with Docker) only the tests
// that need no decoder run, and REQUIRE_WASM=1 (the CI job that builds it)
// turns a missing WASM into a failure (#119). Nothing here calls initTexture:
// decodeImage loads the decoder itself (image-autoinit.test.ts pins that down
// in a process of its own).
const WASM = "decoder/wasm/texture2ddecoder.wasm";
const skip = existsSync(fileURLToPath(new URL(`../../${WASM}`, import.meta.url)))
  ? false
  : `packages/${WASM} not built (npm run build:wasm)`;
if (skip && process.env.REQUIRE_WASM === "1") {
  throw new Error(`REQUIRE_WASM=1 but ${skip}; the decode tests must not skip here`);
}
const wasmTest = (name: string, fn: () => Promise<void>) => test(name, { skip }, fn);

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = dirname(HERE);

const SPRITES = "editor/6000.3.25f1/sprite/sprites";
const SPRITE_FIXTURES = ["editor/2019.4.41f2/sprite/sprites", SPRITES];
const PLAIN = "editor/6000.3.25f1/plain/textures";
const STREAMED = "editor/6000.3.25f1/lz4/texture";
const STRIPPED = "editor/6000.3.25f1/stripped/font";

// --- golden helpers ------------------------------------------------------------------

/** The fields of a Texture2D type tree dump the tests read, float and int64 normalized. */
interface TextureDump {
  m_Name: string;
  m_Width: number;
  m_Height: number;
  m_TextureFormat: number;
  m_MipCount: number;
  m_IsReadable: boolean;
  m_ColorSpace: number;
  m_TextureSettings: { m_FilterMode: number; m_WrapU: number; m_WrapV: number; m_WrapW: number };
  "image data": string;
  m_StreamData: { size: number; path: string };
}

/** A rectangle, vector or pointer as the dumps hold them. */
type Dumped = Record<string, string>;

/** The fields of a Sprite type tree dump the tests read. */
interface SpriteDump {
  m_Name: string;
  m_Rect: Dumped;
  m_Pivot: Dumped;
  m_Border: Dumped;
  m_PixelsToUnits: string;
  m_SpriteAtlas: Dumped;
  m_RD: { texture: Dumped; textureRect: Dumped };
}

/** A float as the goldens normalize it (`"f32:<hex>"`, plan section 5). */
function f32(value: string | undefined): number {
  assert.match(value ?? "", /^f32:[0-9a-f]{8}$/);
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, parseInt(value!.slice(4), 16));
  return view.getFloat32(0);
}

/** Every float of a dumped rectangle or vector. */
function floats(value: Dumped): Record<string, number> {
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, f32(v)]));
}

/** The SerializedFile golden holding an asset. */
function fileGolden(fixture: string, asset: Asset): GoldenSerialized {
  const sf = golden(fixture).serialized?.[asset.file];
  assert.ok(sf, `${fixture}: no golden for ${asset.file}`);
  return sf;
}

/**
 * An asset's type tree dump. The oracle cannot dump a bundle built without
 * type trees; its twin built with them holds the same objects.
 */
function dump<T>(fixture: string, asset: Asset): T {
  const from = fileGolden(fixture, asset).enableTypeTree
    ? fixture
    : fixture.replace("/lz4-notypetree/", "/lz4/");
  const tt = fileGolden(from, asset).typetrees[String(asset.pathId)];
  assert.ok(tt, `${fixture}: no type tree dump for ${asset.pathId}`);
  return tt.value as T;
}

/** The first container path of each `file/pathId`, as UnityPy lists them. */
function containerPaths(fixture: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of golden(fixture).container ?? []) {
    const key = `${e.file}/${e.pathId}`;
    if (!out.has(key)) out.set(key, e.path);
  }
  return out;
}

/** The fixture's env, as the caller builds it. */
function loadEnv(fixture: string): Env {
  return load([{ name: fixture, data: loadFixture(fixture) }]);
}

/** The `TextureFormat` name of a value. */
const formatName = (format: number): string | undefined =>
  Object.entries(TextureFormat).find(([, v]) => v === format)?.[0];

/** Every editor fixture holding a Texture2D or Sprite (class 28, 213). */
const IMAGE_FIXTURES = fixtureNames().filter(
  (name) =>
    golden(name).serialized &&
    Object.values(golden(name).objects)
      .flat()
      .some((o) => o.classId === 28 || o.classId === 213),
);

/** What an image's RGBA (rows as stored) hashes to by the oracle, when it agrees with it. */
function goldenRgba(fixture: string, asset: Asset): string | undefined {
  const sf = fileGolden(fixture, asset);
  const id = String(asset.pathId);
  if (asset.type === "Sprite") return sf.sprites?.[id]?.rgbaSha256;
  const g = sf.textures?.[id];
  // Where UnityPy and AssetStudio differ, decode.test.ts checks AssetStudio's.
  return g?.oracleNote ? undefined : g?.rgbaSha256;
}

// --- the usage block -------------------------------------------------------------------

test("the usage block compiles under strict, and isImage / imageInfo narrow", () => {
  const config = ts.readConfigFile(join(PACKAGE, "tsconfig.json"), (f) => ts.sys.readFile(f));
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, PACKAGE);
  const program = ts.createProgram([join(HERE, "types", "usage.ts")], {
    ...options,
    noEmit: true,
    rootDir: undefined,
  });
  assert.equal(options.strict, true);
  assert.equal(options.noUncheckedIndexedAccess, true);
  const problems = ts
    .getPreEmitDiagnostics(program)
    // Only this package's files count; the core's d.ts is checked where it is built.
    .filter((d) => !d.file || !relative(PACKAGE, d.file.fileName).startsWith(`..${sep}`))
    .map((d) => {
      const text = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      if (!d.file || d.start === undefined) return text;
      const { line } = d.file.getLineAndCharacterOfPosition(d.start);
      return `${relative(PACKAGE, d.file.fileName)}:${line + 1}: ${text}`;
    });
  assert.deepStrictEqual(problems, []);
});

for (const fixture of [...SPRITE_FIXTURES, "editor/6000.3.25f1/block/windows", STREAMED]) {
  wasmTest(`${fixture}: the usage block runs, with pixels equal to the goldens`, async () => {
    const env = loadEnv(fixture);
    const { rows, all } = await usage(env);
    const expected = [...env.assets("Texture2D", "Sprite")];
    assert.deepStrictEqual(
      rows.map((r) => r.asset),
      expected,
    );
    let compared = 0;
    for (const { asset, info, image } of rows) {
      assert.deepStrictEqual({ ...image, rgba: undefined }, { ...info, rgba: undefined });
      assert.equal(image.rgba.length, image.width * image.height * 4);
      const want = goldenRgba(fixture, asset);
      if (want === undefined) continue;
      assert.equal(sha256(reverseRows(image.rgba, image.width)), want, `${asset.name}`);
      compared++;
    }
    // Only BC4 and BC6H lack a UnityPy hash to agree with (decode.test.ts).
    assert.equal(compared, rows.length - (fixture.includes("block/windows") ? 2 : 0));
    // images(env) yields the same images, in the same order.
    assert.deepStrictEqual(
      all.map((i) => [i.kind, i.pathId, sha256(i.rgba)]),
      rows.map(({ image: i }) => [i.kind, i.pathId, sha256(i.rgba)]),
    );
  });
}

// --- isImage ---------------------------------------------------------------------------

test("isImage is true for Texture2D and Sprite assets only", () => {
  const env = loadEnv(SPRITES);
  const kinds = new Set<string>();
  for (const asset of env.assets()) {
    kinds.add(asset.type);
    assert.equal(isImage(asset), asset.type === "Texture2D" || asset.type === "Sprite");
  }
  // The fixture has others to say no to: its atlases and its AssetBundle.
  assert.deepStrictEqual([...kinds].sort(), ["AssetBundle", "Sprite", "SpriteAtlas", "Texture2D"]);
});

test("imageInfo and decodeImage refuse what is not an image asset with a TypeError", async () => {
  const env = loadEnv(SPRITES);
  const bundle = [...env.assets("AssetBundle")][0] as unknown as Asset<"Texture2D">;
  assert.throws(
    () => imageInfo(bundle),
    /^TypeError: imageInfo: expected a Texture2D or Sprite asset, got an asset of class AssetBundle$/,
  );
  assert.throws(() => imageInfo(undefined as unknown as Asset<"Texture2D">), TypeError);
  await assert.rejects(decodeImage(bundle), TypeError);
});

// --- imageInfo -------------------------------------------------------------------------

for (const fixture of IMAGE_FIXTURES) {
  test(`${fixture}: imageInfo of each Texture2D = the oracle's fields`, () => {
    const env = loadEnv(fixture);
    const paths = containerPaths(fixture);
    const textures = [...env.assets("Texture2D")];
    assert.ok(textures.length > 0);
    for (const asset of textures) {
      const sf = fileGolden(fixture, asset);
      if (sf.unityVersion.startsWith("0.0.0")) {
        // Stripped: the Texture2D layout depends on the version the file lacks.
        assert.throws(
          () => imageInfo(asset),
          (e: unknown) => e instanceof UnsupportedError && e.kind === "Unity version",
        );
        continue;
      }
      const t = dump<TextureDump>(fixture, asset);
      const inline = (t["image data"].length - "hex:".length) / 2;
      const streamed = inline === 0 && t.m_StreamData.path !== "";
      const info = imageInfo(asset);
      assert.deepStrictEqual(info, {
        kind: "Texture2D",
        name: t.m_Name,
        path: paths.get(`${asset.file}/${asset.pathId}`),
        pathId: asset.pathId,
        file: asset.file,
        width: t.m_Width,
        height: t.m_Height,
        format: t.m_TextureFormat,
        formatName: formatName(t.m_TextureFormat),
        compression: info.compression, // checked per format below
        mipCount: t.m_MipCount,
        readable: t.m_IsReadable,
        // TextureImporter's sRGB box: 1 checked, 0 not (a linear texture).
        colorSpace: t.m_ColorSpace === 1 ? "srgb" : "linear",
        filterMode: t.m_TextureSettings.m_FilterMode,
        wrapMode: {
          u: t.m_TextureSettings.m_WrapU,
          v: t.m_TextureSettings.m_WrapV,
          w: t.m_TextureSettings.m_WrapW,
        },
        platform: sf.targetPlatform,
        encodedSize: streamed ? t.m_StreamData.size : inline,
        streamed,
      });
      // The texture golden: what the oracle read as the image data, wherever it was.
      const g = sf.textures?.[String(asset.pathId)];
      if (g) {
        assert.deepStrictEqual(
          [info.format, info.width, info.height, info.encodedSize],
          [g.format, g.width, g.height, g.imageSize],
        );
      }
    }
  });
}

test("imageInfo's fields cover both colour spaces, several filter and wrap modes, and mips", () => {
  const infos = IMAGE_FIXTURES.flatMap((fixture) =>
    [...loadEnv(fixture).assets("Texture2D")]
      .filter((a) => !fileGolden(fixture, a).unityVersion.startsWith("0.0.0"))
      .map((a) => imageInfo(a)),
  );
  const values = (f: (i: ImageInfo) => unknown) => new Set(infos.map(f)).size;
  assert.equal(values((i) => i.colorSpace), 2);
  assert.equal(values((i) => i.readable), 2);
  assert.equal(values((i) => i.streamed), 2);
  assert.ok(values((i) => i.filterMode) >= 2);
  assert.ok(values((i) => i.wrapMode.u) >= 2);
  assert.ok(values((i) => i.mipCount) >= 2);
  assert.ok(values((i) => i.platform) >= 3);
});

/** Offset of `m_TextureFormat` in a 2020.1+ Texture2D, found by its size fields. */
function formatOffset(fixture: string, asset: Asset, file: Uint8Array): number {
  const t = dump<TextureDump & { m_CompleteImageSize: number }>(fixture, asset);
  // m_Width, m_Height, m_CompleteImageSize, m_MipsStripped (0), m_TextureFormat.
  const words = [t.m_Width, t.m_Height, t.m_CompleteImageSize, 0, t.m_TextureFormat];
  const pattern = new Uint8Array(new Int32Array(words).buffer);
  const obj: ObjectReader = asset.reader;
  const bytes = file.subarray(obj.byteStart, obj.byteStart + obj.byteSize);
  const hits: number[] = [];
  for (let i = 0; i + pattern.length <= bytes.length; i++) {
    if (pattern.every((b, k) => bytes[i + k] === b)) hits.push(i);
  }
  assert.equal(hits.length, 1, "the size fields are not found exactly once");
  return obj.byteStart + hits[0]! + 16;
}

/** A plain fixture, with the format of its RGBA32 texture ready to be rewritten. */
function patchable(): { env: Env; asset: Asset<"Texture2D">; setFormat: (f: number) => void } {
  const env = loadEnv(PLAIN);
  const asset = [...env.assets("Texture2D")].find((a) => a.name === "RGBA32")!;
  // The object's bytes are a view into the env's decompressed file, read anew by every call.
  const file = env.files.find((f) => !f.path.endsWith(".resS"))!.data;
  const at = formatOffset(PLAIN, asset, file);
  const view = new DataView(file.buffer, file.byteOffset);
  return { env, asset, setFormat: (format) => view.setInt32(at, format, true) };
}

test("formatName and compression, for every TextureFormat and an unknown value", () => {
  const F = TextureFormat;
  const families: Record<string, number[]> = {
    none: [
      F.Alpha8, F.ARGB4444, F.RGB24, F.RGBA32, F.ARGB32, F.ARGBFloat, F.RGB565, F.BGR24, F.R16,
      F.RGBA4444, F.BGRA32, F.RHalf, F.RGHalf, F.RGBAHalf, F.RFloat, F.RGFloat, F.RGBAFloat,
      F.YUY2, F.RGB9e5Float, F.RGBFloat, F.RG16, F.R8, F.RG32, F.RGB48, F.RGBA64,
    ],
    bc: [F.DXT1, F.DXT3, F.DXT5, F.BC4, F.BC5, F.BC6H, F.BC7],
    crunch: [F.DXT1Crunched, F.DXT5Crunched, F.ETC_RGB4Crunched, F.ETC2_RGBA8Crunched],
    pvrtc: [F.PVRTC_RGB2, F.PVRTC_RGBA2, F.PVRTC_RGB4, F.PVRTC_RGBA4],
    etc: [F.ETC_RGB4, F.ETC_RGB4_3DS, F.ETC_RGBA8_3DS],
    etc2: [F.ETC2_RGB, F.ETC2_RGBA1, F.ETC2_RGBA8],
    eac: [F.EAC_R, F.EAC_R_SIGNED, F.EAC_RG, F.EAC_RG_SIGNED],
    atc: [F.ATC_RGB4, F.ATC_RGBA8],
    astc: [
      F.ASTC_RGB_4x4, F.ASTC_RGB_5x5, F.ASTC_RGB_6x6, F.ASTC_RGB_8x8, F.ASTC_RGB_10x10,
      F.ASTC_RGB_12x12, F.ASTC_RGBA_4x4, F.ASTC_RGBA_5x5, F.ASTC_RGBA_6x6, F.ASTC_RGBA_8x8,
      F.ASTC_RGBA_10x10, F.ASTC_RGBA_12x12, F.ASTC_HDR_4x4, F.ASTC_HDR_5x5, F.ASTC_HDR_6x6,
      F.ASTC_HDR_8x8, F.ASTC_HDR_10x10, F.ASTC_HDR_12x12,
    ],
  };
  const listed = Object.values(families).flat().sort((a, b) => a - b);
  assert.deepStrictEqual(listed, Object.values(F).sort((a, b) => a - b), "every format, once");

  const { asset, setFormat } = patchable();
  for (const [compression, formats] of Object.entries(families)) {
    for (const format of formats) {
      setFormat(format);
      const info = imageInfo(asset);
      assert.equal(info.format, format);
      assert.equal(info.formatName, formatName(format));
      assert.equal(info.compression, compression, info.formatName);
    }
  }
  setFormat(1000);
  assert.deepStrictEqual(
    [imageInfo(asset).format, imageInfo(asset).formatName, imageInfo(asset).compression],
    [1000, "unknown", "unknown"],
  );
});

test("imageInfo needs no image data: a texture in a .resS that is not loaded", () => {
  const whole = loadEnv(STREAMED);
  const cab = whole.files.find((f) => !f.path.endsWith(".resS"))!;
  const env = load([{ name: cab.path, data: cab.data }]);
  const [texture] = env.assets("Texture2D");
  assert.ok(texture);
  const info = imageInfo(texture);
  assert.deepStrictEqual([info.streamed, info.encodedSize], [true, 64]);
  // The same without its sidecar's data, for a sprite on a streamed atlas texture.
  const sprites = loadEnv(SPRITES);
  const node = sprites.files.find((f) => !f.path.endsWith(".resS"))!;
  const noResS = load([{ name: node.path, data: node.data }]);
  const packed = [...noResS.assets("Sprite")].find((a) => a.name === "p_tri")!;
  assert.equal(imageInfo(packed).sprite.texture.streamed, true);
});

for (const fixture of SPRITE_FIXTURES) {
  test(`${fixture}: imageInfo of each Sprite = the oracle's fields and cut-out size`, () => {
    const env = loadEnv(fixture);
    const paths = containerPaths(fixture);
    const sprites = [...env.assets("Sprite")];
    assert.equal(sprites.length, 22);
    const atlased = new Set<string>();
    for (const asset of sprites) {
      const sf = fileGolden(fixture, asset);
      const s = dump<SpriteDump>(fixture, asset);
      const g = sf.sprites![String(asset.pathId)]!;
      const info = imageInfo(asset);
      const atlasId = s.m_SpriteAtlas.m_PathID!;
      const atlas = atlasId === "0" ? undefined : sf.names[atlasId];
      const texture = [...env.assets("Texture2D")].find(
        (t) => t.pathId === info.sprite.texture.pathId,
      )!;
      const { sprite, ...fields } = info;
      assert.deepStrictEqual(fields, {
        // The texture's encoding, the sprite's own identity and size.
        ...imageInfo(texture),
        kind: "Sprite",
        name: s.m_Name,
        path: paths.get(`${asset.file}/${asset.pathId}`),
        pathId: asset.pathId,
        file: asset.file,
        width: g.width,
        height: g.height,
      });
      assert.deepStrictEqual(
        { ...sprite, textureRect: undefined, texture: undefined },
        {
          rect: floats(s.m_Rect),
          textureRect: undefined,
          pivot: floats(s.m_Pivot),
          border: floats(s.m_Border),
          pixelsPerUnit: f32(s.m_PixelsToUnits),
          // The flags the oracle cut the image with: the atlas entry's, or m_RD's.
          packed: (g.settingsRaw & 1) === 1,
          packingMode: (g.settingsRaw & 2) === 0 ? "tight" : "rectangle",
          rotation: (g.settingsRaw >> 2) & 0xf,
          atlas,
          texture: undefined,
        },
        g.name,
      );
      assert.deepStrictEqual(sprite.texture, imageInfo(texture));
      if (atlas === undefined) {
        // Its own m_RD: that texture and rectangle.
        assert.equal(String(sprite.texture.pathId), s.m_RD.texture.m_PathID);
        assert.deepStrictEqual(sprite.textureRect, floats(s.m_RD.textureRect));
      } else {
        // The atlas' texture, which Unity names after it (`sactx-...-<atlas>-<hash>`).
        assert.match(sprite.texture.name, new RegExp(`^sactx-.*-${atlas}-[0-9a-f]+$`));
        atlased.add(atlas);
      }
    }
    assert.deepStrictEqual([...atlased].sort(), ["packed", "rect"]);
  });
}

test("a sprite's info size is the size cutSprite cuts, for every packing rotation", () => {
  // No fixture sprite is packed turned; the goldens above pin the unturned sizes.
  const texture = { data: new Uint8Array(16 * 16 * 4), width: 16, height: 16 };
  const textureRect = { x: 1.5, y: 2, width: 9, height: 4.25 };
  for (const packed of [0, 1]) {
    for (let rotation = 0; rotation <= 4; rotation++) {
      const rect = {
        textureRect,
        textureRectOffset: { x: 0, y: 0 },
        settingsRaw: packed | (rotation << 2) | 2, // packed as a rectangle: no mesh
      };
      const cut = cutSprite(texture, {} as Sprite, rect, [6000, 3, 25, 1], false);
      const size = spriteSize(rect, texture.width, texture.height);
      assert.deepStrictEqual(size, { width: cut.width, height: cut.height });
      const turned = packed === 1 && rotation === SpritePackingRotation.Rotate90;
      // x 1 to 11 and y 2 to 7: widened to whole pixels.
      assert.deepStrictEqual(size, turned ? { width: 5, height: 10 } : { width: 10, height: 5 });
    }
  }
});

test("imageInfo describes a sprite with an alpha texture, which decoding refuses", async () => {
  const env = loadEnv(SPRITES);
  const asset = [...env.assets("Sprite")].find((a) => a.name === "sheet_a")!;
  const file = env.files.find((f) => !f.path.endsWith(".resS"))!.data;
  // m_RD: texture, then alphaTexture (a null pointer): point the second at the first.
  const texture = asset.reader.read<{ m_RD: { texture: { m_PathID: bigint } } }>().m_RD.texture;
  const pair = new Uint8Array(24);
  new DataView(pair.buffer).setBigInt64(4, texture.m_PathID, true);
  const bytes = file.subarray(asset.reader.byteStart, asset.reader.byteStart + asset.byteSize);
  const hits = [...bytes.keys()].filter((i) => pair.every((b, k) => bytes[i + k] === b));
  assert.equal(hits.length, 1);
  file.set(pair.subarray(0, 12), asset.reader.byteStart + hits[0]! + 12);
  assert.equal(imageInfo(asset).sprite.texture.pathId, texture.m_PathID);
  if (skip) return;
  await assert.rejects(
    decodeImage(asset),
    (e: unknown) => e instanceof UnsupportedError && e.kind === "sprite alpha texture",
  );
});

// --- decodeImage -----------------------------------------------------------------------

for (const fixture of [PLAIN, "editor/6000.3.25f1/block/android", "editor/2019.4.41f2/block/ios"]) {
  wasmTest(`${fixture}: decodeImage = imageInfo + the golden's pixels`, async () => {
    const env = loadEnv(fixture);
    let compared = 0;
    for (const asset of env.assets("Texture2D")) {
      const image = await decodeImage(asset);
      const { rgba, ...info } = image;
      assert.deepStrictEqual(info, imageInfo(asset));
      assert.equal(rgba.length, image.width * image.height * 4);
      const want = goldenRgba(fixture, asset);
      if (want === undefined) continue;
      assert.equal(sha256(reverseRows(rgba, image.width)), want, asset.name);
      compared++;
    }
    assert.ok(compared >= 4, `${compared} compared`);
  });
}

wasmTest("decodeImage of a texture whose .resS is not loaded: ResourceNotFoundError", async () => {
  const cab = loadEnv(STREAMED).files.find((f) => !f.path.endsWith(".resS"))!;
  const [texture] = load([{ name: cab.path, data: cab.data }]).assets("Texture2D");
  await assert.rejects(decodeImage(texture!), ResourceNotFoundError);
});

// --- images() ------------------------------------------------------------------------

wasmTest("images(): an unsupported format throws by default, is left out with skip", async () => {
  const { env, asset, setFormat } = patchable();
  setFormat(TextureFormat.DXT3); // no decoder here or upstream
  const collect = async (options?: Parameters<typeof images>[1]) => {
    const out: DecodedImage[] = [];
    for await (const image of images(env, options)) out.push(image);
    return out;
  };
  for (const options of [undefined, {}, { onError: "throw" as const }]) {
    await assert.rejects(
      collect(options),
      (e: unknown) => e instanceof UnsupportedError && e.kind === "texture format",
    );
  }
  const skipped = await collect({ onError: "skip" });
  const all = [...env.assets("Texture2D", "Sprite")];
  assert.deepStrictEqual(
    skipped.map((i) => i.pathId),
    all.filter((a) => a !== asset).map((a) => a.pathId),
  );
});

wasmTest("images(): a texture of a stripped file is refused, or skipped", async () => {
  const env = loadEnv(STRIPPED);
  assert.equal([...env.assets("Texture2D")].length, 1);
  await assert.rejects(images(env).next(), UnsupportedError);
  const out: DecodedImage[] = [];
  for await (const image of images(env, { onError: "skip" })) out.push(image);
  assert.deepStrictEqual(out, []);
});

wasmTest("images() hands the event loop a turn between images", async () => {
  const env = loadEnv(SPRITES);
  let count = 0;
  let timerFired = false;
  for await (const image of images(env)) {
    void image;
    count++;
    if (count === 1) {
      setTimeout(() => (timerFired = true), 0);
    } else if (count === 2) {
      // Queued after the first image; images() waited a timeout of its own since.
      assert.equal(timerFired, true);
    }
  }
  assert.equal(count, [...env.assets("Texture2D", "Sprite")].length);
});

test("images() refuses an onError it does not know, with a TypeError", async () => {
  const env = loadEnv(SPRITES);
  const onError = "ignore" as unknown as "skip";
  await assert.rejects(images(env, { onError }).next(), /onError must be "throw" or "skip"/);
});
