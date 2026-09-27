// Ported from AssetStudio.Utility/Texture2DConverter.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio.Utility/Texture2DExtensions.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from UnityPy/export/Texture2DConverter.py (MIT, © K0lb3)

import {
  decode_astc,
  decode_atc_rgb4,
  decode_atc_rgba8,
  decode_bc1,
  decode_bc3,
  decode_bc4,
  decode_bc5,
  decode_bc6,
  decode_bc7,
  decode_eacr,
  decode_eacr_signed,
  decode_eacrg,
  decode_eacrg_signed,
  decode_etc1,
  decode_etc2,
  decode_etc2a1,
  decode_etc2a8,
  decode_pvrtc,
  initialize,
  unpack_crunch,
  unpack_unity_crunch,
} from "texture2ddecoder-wasm";
import { BuildTarget, CorruptError, TextureFormat, UnsupportedError } from "unity-asset-reader";
import type { Texture2DData } from "unity-asset-reader";
import { convertPlain, type RgbaImage } from "./convert.js";
import { deswizzle, switchLayout, xbox360Swap } from "./platform.js";

/** Where `initTexture` finds the WASM files; passed to `texture2ddecoder-wasm` as it is. */
export interface InitTextureOptions {
  /**
   * URL of the directory holding `texture2ddecoder.js` and `.wasm` (or of the
   * `.js` file). Browsers need it; Node finds the files itself and ignores it.
   */
  wasmPath?: string;
  /** Emscripten's `locateFile`, for the `.wasm` binary; overrides the default lookup. */
  locateFile?: (path: string, prefix: string) => string;
}

type Decode = (data: Uint8Array, width: number, height: number) => Promise<Uint8Array | null>;

/** A block decoder and its block: width and height in pixels, and bytes per block. */
interface BlockCodec {
  decode: Decode;
  blockWidth: number;
  blockHeight: number;
  blockBytes: number;
}

const block4x4 = (decode: Decode, blockBytes: number): BlockCodec => ({
  decode,
  blockWidth: 4,
  blockHeight: 4,
  blockBytes,
});

const astc = (size: number): BlockCodec => ({
  decode: (data, width, height) => decode_astc(data, width, height, size, size),
  blockWidth: size,
  blockHeight: size,
  blockBytes: 16,
});

// PVRTC 2bpp packs 8x4 pixels into a 64-bit word, 4bpp 4x4.
const PVRTC_2BPP: BlockCodec = {
  decode: (data, width, height) => decode_pvrtc(data, width, height, true),
  blockWidth: 8,
  blockHeight: 4,
  blockBytes: 8,
};
const PVRTC_4BPP: BlockCodec = {
  decode: (data, width, height) => decode_pvrtc(data, width, height, false),
  blockWidth: 4,
  blockHeight: 4,
  blockBytes: 8,
};

/**
 * Upstream's block branch of `DecodeTexture2D`: format -> decoder. DXT3 is
 * not here, as upstream does not decode it either. Unity numbers from
 * `TextureFormat`, so 66-71 are the ASTC HDR formats (upstream's `R16_Alt` is
 * not ported, see #28).
 */
const BLOCK: ReadonlyMap<number, BlockCodec> = new Map([
  [TextureFormat.DXT1, block4x4(decode_bc1, 8)],
  [TextureFormat.DXT5, block4x4(decode_bc3, 16)],
  [TextureFormat.BC4, block4x4(decode_bc4, 8)],
  [TextureFormat.BC5, block4x4(decode_bc5, 16)],
  [TextureFormat.BC6H, block4x4(decode_bc6, 16)],
  [TextureFormat.BC7, block4x4(decode_bc7, 16)],
  [TextureFormat.PVRTC_RGB2, PVRTC_2BPP],
  [TextureFormat.PVRTC_RGBA2, PVRTC_2BPP],
  [TextureFormat.PVRTC_RGB4, PVRTC_4BPP],
  [TextureFormat.PVRTC_RGBA4, PVRTC_4BPP],
  [TextureFormat.ETC_RGB4, block4x4(decode_etc1, 8)],
  [TextureFormat.ETC_RGB4_3DS, block4x4(decode_etc1, 8)],
  [TextureFormat.ATC_RGB4, block4x4(decode_atc_rgb4, 8)],
  [TextureFormat.ATC_RGBA8, block4x4(decode_atc_rgba8, 16)],
  [TextureFormat.EAC_R, block4x4(decode_eacr, 8)],
  [TextureFormat.EAC_R_SIGNED, block4x4(decode_eacr_signed, 8)],
  [TextureFormat.EAC_RG, block4x4(decode_eacrg, 16)],
  [TextureFormat.EAC_RG_SIGNED, block4x4(decode_eacrg_signed, 16)],
  [TextureFormat.ETC2_RGB, block4x4(decode_etc2, 8)],
  [TextureFormat.ETC2_RGBA1, block4x4(decode_etc2a1, 8)],
  [TextureFormat.ETC2_RGBA8, block4x4(decode_etc2a8, 16)],
  [TextureFormat.ETC_RGBA8_3DS, block4x4(decode_etc2a8, 16)],
  [TextureFormat.ASTC_RGB_4x4, astc(4)],
  [TextureFormat.ASTC_RGB_5x5, astc(5)],
  [TextureFormat.ASTC_RGB_6x6, astc(6)],
  [TextureFormat.ASTC_RGB_8x8, astc(8)],
  [TextureFormat.ASTC_RGB_10x10, astc(10)],
  [TextureFormat.ASTC_RGB_12x12, astc(12)],
  [TextureFormat.ASTC_RGBA_4x4, astc(4)],
  [TextureFormat.ASTC_RGBA_5x5, astc(5)],
  [TextureFormat.ASTC_RGBA_6x6, astc(6)],
  [TextureFormat.ASTC_RGBA_8x8, astc(8)],
  [TextureFormat.ASTC_RGBA_10x10, astc(10)],
  [TextureFormat.ASTC_RGBA_12x12, astc(12)],
  [TextureFormat.ASTC_HDR_4x4, astc(4)],
  [TextureFormat.ASTC_HDR_5x5, astc(5)],
  [TextureFormat.ASTC_HDR_6x6, astc(6)],
  [TextureFormat.ASTC_HDR_8x8, astc(8)],
  [TextureFormat.ASTC_HDR_10x10, astc(10)],
  [TextureFormat.ASTC_HDR_12x12, astc(12)],
]);

/** Crunch format -> the block format its unpacked data is in. */
const CRUNCHED: ReadonlyMap<number, number> = new Map<number, number>([
  [TextureFormat.DXT1Crunched, TextureFormat.DXT1],
  [TextureFormat.DXT5Crunched, TextureFormat.DXT5],
  [TextureFormat.ETC_RGB4Crunched, TextureFormat.ETC_RGB4],
  [TextureFormat.ETC2_RGBA8Crunched, TextureFormat.ETC2_RGBA8],
]);

const FORMAT_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(TextureFormat).map(([name, value]) => [value, name]),
);

const NOT_INITIALIZED =
  "decodeTexture2D: the texture decoder is not initialized - call `await initTexture()` " +
  "once before decoding";

let initialized = false;

/**
 * Load the WASM block decoder. Call it once, and wait for it, before
 * {@link decodeTexture2D}; later calls return at once. A passthrough to
 * `texture2ddecoder-wasm`'s `initialize`.
 *
 * @param options where the WASM files are; browsers need `wasmPath`
 *   (`npx texture2ddecoder-copy-wasm public/wasm`, or a CDN URL), Node needs
 *   nothing
 * @throws {Error} from `texture2ddecoder-wasm` when the WASM files cannot be
 *   loaded; `initTexture` can then be called again
 * @example
 * await initTexture({ wasmPath: "/wasm" });
 */
export async function initTexture(options?: InitTextureOptions): Promise<void> {
  await initialize(options);
  initialized = true;
}

/**
 * Decode the first mip level of a Texture2D to RGBA8, top row first, whatever
 * its format: the plain formats in TS (`convertPlain`), the block and Crunch
 * formats - BC1-BC7, ETC1/ETC2/EAC, PVRTC, ASTC, ATC and Crunch - through
 * `texture2ddecoder-wasm`. Its BGRA output is swapped to RGBA once (D5).
 *
 * Unity stores the rows bottom row first; they are flipped, so row 0 of the
 * result is the top of the image, as `ImageData` and image files expect
 * (upstream's `ConvertToImage(flip: true)`).
 *
 * Console layouts are undone first, by `platform` (which `obj.read()` sets):
 * - **Xbox 360:** ARGB4444, RGB565, DXT1 and DXT5 store their 16-bit words
 *   big-endian, and are swapped back (upstream's `SwapBytesForXbox`).
 * - **Switch:** a texture whose `m_PlatformBlob` gives more than one GOB per
 *   block is in the Tegra block-linear layout. It is deswizzled over its size
 *   padded to whole blocks of GOBs, decoded at that size and cropped back
 *   (UnityPy's `TextureSwizzler`; AssetStudio has no Switch path). RGB24 and
 *   BGR24 are stored as RGBA32 and BGRA32 there, and decoded as those.
 *
 * Without `platform` (an input not from `obj.read()`), the data is taken as
 * linear, as every other platform stores it.
 *
 * DXT1 and DXT5 Crunch come in two variants: upstream unpacks Unity's own
 * from Unity 2017.3 on, and the original crunch before. The Unity version is
 * not a Texture2D field, so the fields 2017.3 added stand in for it: a
 * texture with `m_DownscaleFallback` or `m_IsAlphaChannelOptional` is 2017.3
 * or later. The ETC Crunch formats only exist in Unity's variant.
 *
 * @param texture a Texture2D as `obj.read()` returns it. Only `m_Width`,
 *   `m_Height`, `m_TextureFormat` and `imageData` are required at run time
 *   (and `m_DownscaleFallback` / `m_IsAlphaChannelOptional` for DXT Crunch,
 *   `platform` and `m_PlatformBlob` for consoles, see above); they are
 *   checked, since `obj.read()`'s type is the caller's claim
 * @returns a new RGBA image, `width * height * 4` bytes, top row first;
 *   `imageData` is not modified. A texture 0 pixels wide or high gives an
 *   empty image.
 * @throws {TypeError} when `texture` is not a Texture2D with image data
 *   (`obj.read()`'s type is not checked): `m_Width`, `m_Height` or
 *   `m_TextureFormat` is not a number, `imageData` is not a `Uint8Array`, or
 *   `platform` / `m_PlatformBlob`, when present, is not a number /
 *   `Uint8Array`; the message names each
 * @throws {Error} before {@link initTexture} has finished
 * @throws {UnsupportedError} for a format with no decoder here (DXT3, and
 *   formats neither this nor `convertPlain` knows); for a Switch-swizzled
 *   texture, also a format with no known Switch layout (Crunch, ETC, PVRTC,
 *   ASTC HDR, ...) or more than 32 GOBs per block
 * @throws {CorruptError} when the image data is shorter than the first level
 *   needs (for Switch, the padded level), the Crunch data does not unpack,
 *   the block decoder refuses the data (such as PVRTC whose block counts are
 *   not powers of two), or the size is not a non-negative integer
 * @example
 * await initTexture();
 * const { data, width, height } = await decodeTexture2D(obj.read());
 */
export async function decodeTexture2D(texture: Texture2DData): Promise<RgbaImage> {
  checkInput(texture);
  if (!initialized) throw new Error(NOT_INITIALIZED);
  const { m_Width: width, m_Height: height, m_TextureFormat: format } = texture;
  if (!Number.isInteger(width) || width < 0 || !Number.isInteger(height) || height < 0) {
    throw new CorruptError(`texture size ${width} x ${height} is not a non-negative integer size`);
  }
  const platform = texture.platform ?? BuildTarget.UnknownPlatform;
  // Upstream's order: the Xbox swap, then (UnityPy) the Switch deswizzle, then decode.
  const data = xbox360Swap(texture.imageData, platform, format);
  const layout = switchLayout(platform, texture.m_PlatformBlob, format, width, height);
  let image: RgbaImage;
  if (layout === undefined) {
    image = await decodeLinear(texture, format, data, width, height);
  } else {
    const { paddedWidth, paddedHeight } = layout;
    const linear = deswizzle(data, layout);
    const padded = await decodeLinear(texture, layout.format, linear, paddedWidth, paddedHeight);
    image = crop(padded, width, height);
  }
  flipRows(image);
  return image;
}

/**
 * The first level of `data`, stored linear, to RGBA8 with the rows as
 * stored: `convertPlain`, or the WASM decoder and the BGRA -> RGBA swap.
 */
async function decodeLinear(
  texture: Texture2DData,
  format: number,
  data: Uint8Array,
  width: number,
  height: number,
): Promise<RgbaImage> {
  const unpackedFormat = CRUNCHED.get(format);
  const codec = BLOCK.get(unpackedFormat ?? format);
  if (codec === undefined) return plain(data, width, height, format);
  if (width === 0 || height === 0) return { data: new Uint8Array(0), width, height };

  // Crunch is neither byte-swapped nor swizzled, so its data is `imageData`.
  const blocks = unpackedFormat === undefined ? data : await unpack(texture);
  const need =
    Math.ceil(width / codec.blockWidth) * Math.ceil(height / codec.blockHeight) * codec.blockBytes;
  if (blocks.length < need) {
    throw new CorruptError(
      `${describe(format)} image data${unpackedFormat === undefined ? "" : " (unpacked)"} is ` +
        `${blocks.length} bytes, ${width} x ${height} needs ${need}`,
    );
  }

  // Only the first level: the binding copies its input byte by byte.
  const out = await codec.decode(blocks.subarray(0, need), width, height);
  if (out === null || out.length !== width * height * 4) {
    throw new CorruptError(
      `texture2ddecoder-wasm could not decode ${describe(format)} at ${width} x ${height} ` +
        `(${out === null ? "no output" : `${out.length} bytes out`})`,
    );
  }
  // BGRA -> RGBA, in place: the decoder's output is a fresh array.
  for (let i = 0; i < out.length; i += 4) {
    const b = out[i]!;
    out[i] = out[i + 2]!;
    out[i + 2] = b;
  }
  return { data: out, width, height };
}

/** The top-left `width x height` of a padded image, as UnityPy crops a Switch texture. */
function crop(image: RgbaImage, width: number, height: number): RgbaImage {
  if (image.width === width && image.height === height) return image;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = y * image.width * 4;
    out.set(image.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { data: out, width, height };
}

/** Reverse the order of the rows, in place: Unity's bottom-up rows to top-down. */
function flipRows({ data, width, height }: RgbaImage): void {
  const stride = width * 4;
  const row = new Uint8Array(stride);
  for (let top = 0, bottom = height - 1; top < bottom; top++, bottom--) {
    const a = top * stride;
    const b = bottom * stride;
    row.set(data.subarray(a, a + stride));
    data.copyWithin(a, b, b + stride);
    data.set(row, b);
  }
}

/**
 * `obj.read()` is typed by its caller, not checked, so a non-Texture2D can
 * get here; name what is missing rather than decode `undefined`.
 */
function checkInput(texture: unknown): asserts texture is Texture2DData {
  if (typeof texture !== "object" || texture === null) {
    throw new TypeError(`decodeTexture2D: expected a Texture2D object, got ${texture}`);
  }
  const input = texture as Record<string, unknown>;
  const problems = (["m_Width", "m_Height", "m_TextureFormat"] as const)
    .filter((key) => typeof input[key] !== "number")
    .map((key) => `${key} must be a number (${got(input[key])})`);
  if (!(input.imageData instanceof Uint8Array)) {
    problems.push(`imageData must be a Uint8Array (${got(input.imageData)})`);
  }
  // Optional: a hand-built input may leave them out, but not get them wrong.
  if (input.platform !== undefined && typeof input.platform !== "number") {
    problems.push(`platform must be a number (${got(input.platform)})`);
  }
  if (input.m_PlatformBlob !== undefined && !(input.m_PlatformBlob instanceof Uint8Array)) {
    problems.push(`m_PlatformBlob must be a Uint8Array (${got(input.m_PlatformBlob)})`);
  }
  if (problems.length > 0) {
    throw new TypeError(`decodeTexture2D: not a Texture2D with image data: ${problems.join(", ")}`);
  }
}

/** `"missing"`, a class name such as `"Array"`, or a `typeof` such as `"string"`. */
function got(value: unknown): string {
  if (value === undefined || value === null) return "missing";
  if (typeof value !== "object") return typeof value;
  return (value as { constructor?: { name?: string } }).constructor?.name ?? "object";
}

/** `convertPlain`, with its "not a plain format" turned into "no decoder at all". */
function plain(data: Uint8Array, width: number, height: number, format: number): RgbaImage {
  try {
    return convertPlain(data, width, height, format);
  } catch (error) {
    if (error instanceof UnsupportedError && error.kind === "texture format") {
      const name = FORMAT_NAMES.get(format) ?? "unknown";
      throw new UnsupportedError("texture format", format, `${name}: no decoder for it`);
    }
    throw error;
  }
}

/** Upstream `UnpackCrunch`: the first level of a Crunch texture, as block data. */
async function unpack(texture: Texture2DData): Promise<Uint8Array> {
  const format = texture.m_TextureFormat;
  const unity =
    format === TextureFormat.ETC_RGB4Crunched ||
    format === TextureFormat.ETC2_RGBA8Crunched ||
    // Unity 2017.3+, see decodeTexture2D.
    texture.m_DownscaleFallback !== undefined ||
    texture.m_IsAlphaChannelOptional !== undefined;
  const out = await (unity ? unpack_unity_crunch : unpack_crunch)(texture.imageData);
  if (out === null) {
    throw new CorruptError(
      `${describe(format)} image data (${texture.imageData.length} bytes) does not unpack as ` +
        `${unity ? "Unity's" : "the original (pre-2017.3)"} Crunch`,
    );
  }
  return out;
}

/** `"DXT1 (10)"`, or the bare number for a value `TextureFormat` does not name. */
function describe(format: number): string {
  const name = FORMAT_NAMES.get(format);
  return name === undefined ? String(format) : `${name} (${format})`;
}
