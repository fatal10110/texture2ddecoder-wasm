// Ported from AssetStudio.Utility/Texture2DConverter.cs, AssetStudio/Math/Half.cs and HalfHelper.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError, TextureFormat, UnsupportedError } from "unity-asset-reader";

/** Decoded pixels: 4 bytes per pixel, R G B A, `width * height * 4` bytes (D5). */
export interface RgbaImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * The plain formats: Unity `TextureFormat` value -> bytes per pixel.
 * Block and Crunch formats go through `texture2ddecoder-wasm` instead (#32).
 */
const BYTES_PER_PIXEL: ReadonlyMap<number, number> = new Map([
  [TextureFormat.Alpha8, 1],
  [TextureFormat.ARGB4444, 2],
  [TextureFormat.RGB24, 3],
  [TextureFormat.RGBA32, 4],
  [TextureFormat.ARGB32, 4],
  [TextureFormat.RGB565, 2],
  [TextureFormat.R16, 2],
  [TextureFormat.RGBA4444, 2],
  [TextureFormat.BGRA32, 4],
  [TextureFormat.RHalf, 2],
  [TextureFormat.RGHalf, 4],
  [TextureFormat.RGBAHalf, 8],
  [TextureFormat.RFloat, 4],
  [TextureFormat.RGFloat, 8],
  [TextureFormat.RGBAFloat, 16],
  [TextureFormat.YUY2, 2], // 4 bytes per two pixels
  [TextureFormat.RGB9e5Float, 4],
]);

/**
 * Convert the first mip level of an uncompressed ("plain") texture to RGBA8.
 *
 * Covers Alpha8, RGB24, RGBA32, ARGB32, BGRA32, RGB565, ARGB4444, RGBA4444,
 * R16, RHalf, RGHalf, RGBAHalf, RFloat, RGFloat, RGBAFloat, RGB9e5Float and
 * YUY2 - the formats upstream decodes in C#, not through the block decoder.
 * Channels a format lacks are 0 (colour) or 255 (alpha); Alpha8's colour is
 * white. Half and float channels are scaled by 255, rounded half to even and
 * clamped to 0..255, so HDR values saturate and NaN becomes 0.
 *
 * Rows stay in the order Unity stores them, bottom row first; turning the
 * image top-down is a separate step (#33). No platform byte swap is applied
 * (#33 too).
 *
 * Only the first `width * height` pixels are read, so image data holding
 * further mip levels is fine.
 *
 * @param data the Texture2D's image data (`image data` or its `.resS` slice)
 * @param width `m_Width`
 * @param height `m_Height`
 * @param format `m_TextureFormat`, Unity's `TextureFormat` value
 * @returns a new RGBA buffer; `data` is not modified
 * @throws {UnsupportedError} when `format` is not one of the formats above,
 *   or for YUY2 of odd width (upstream reads `width / 2` pairs a row there and
 *   writes its rows out of step, so there is no behavior to match)
 * @throws {CorruptError} when `data` is shorter than `width * height` pixels
 *   of `format`, or `width`/`height` is not a non-negative integer
 */
export function convertPlain(
  data: Uint8Array,
  width: number,
  height: number,
  format: number,
): RgbaImage {
  const bpp = BYTES_PER_PIXEL.get(format);
  if (bpp === undefined) {
    throw new UnsupportedError("texture format", format, "not a plain format");
  }
  if (!Number.isInteger(width) || width < 0 || !Number.isInteger(height) || height < 0) {
    throw new CorruptError(`texture size ${width} x ${height} is not a non-negative integer size`);
  }
  if (format === TextureFormat.YUY2 && width % 2 !== 0) {
    throw new UnsupportedError("YUY2 texture width", width, "YUY2 packs pixels in pairs");
  }
  const pixels = width * height;
  const need = pixels * bpp;
  if (data.length < need) {
    throw new CorruptError(
      `format ${format} image data is ${data.length} bytes, ${width} x ${height} needs ${need}`,
    );
  }

  const out = new Uint8Array(pixels * 4);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (i: number) => view.getUint16(i, true);
  const f32 = (i: number) => view.getFloat32(i, true);
  const half = (i: number) => halfToFloat(view.getUint16(i, true));

  switch (format) {
    case TextureFormat.Alpha8:
      for (let i = 0; i < pixels; i++) {
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255;
        out[i * 4 + 3] = data[i]!;
      }
      break;
    case TextureFormat.ARGB4444: // 16-bit little endian, A in the top nibble, B in the bottom
      for (let i = 0; i < pixels; i++) {
        const p = u16(i * 2);
        put(out, i, nibble(p >> 8), nibble(p >> 4), nibble(p), nibble(p >> 12));
      }
      break;
    case TextureFormat.RGB24:
      for (let i = 0; i < pixels; i++) {
        put(out, i, data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!, 255);
      }
      break;
    case TextureFormat.RGBA32:
      out.set(data.subarray(0, need));
      break;
    case TextureFormat.ARGB32:
      for (let i = 0; i < pixels; i++) {
        put(out, i, data[i * 4 + 1]!, data[i * 4 + 2]!, data[i * 4 + 3]!, data[i * 4]!);
      }
      break;
    case TextureFormat.RGB565: // 16-bit little endian, R in the top 5 bits; bits repeated to widen
      for (let i = 0; i < pixels; i++) {
        const p = u16(i * 2);
        put(out, i, ((p >> 8) & 0xf8) | (p >> 13), ((p >> 3) & 0xfc) | ((p >> 9) & 3),
          ((p << 3) & 0xf8) | ((p >> 2) & 7), 255);
      }
      break;
    case TextureFormat.R16:
      for (let i = 0; i < pixels; i++) put(out, i, downscale16(u16(i * 2)), 0, 0, 255);
      break;
    case TextureFormat.RGBA4444: // 16-bit little endian, R in the top nibble, A in the bottom
      for (let i = 0; i < pixels; i++) {
        const p = u16(i * 2);
        put(out, i, nibble(p >> 12), nibble(p >> 8), nibble(p >> 4), nibble(p));
      }
      break;
    case TextureFormat.BGRA32:
      for (let i = 0; i < pixels; i++) {
        put(out, i, data[i * 4 + 2]!, data[i * 4 + 1]!, data[i * 4]!, data[i * 4 + 3]!);
      }
      break;
    case TextureFormat.RHalf:
      for (let i = 0; i < pixels; i++) put(out, i, unorm(half(i * 2)), 0, 0, 255);
      break;
    case TextureFormat.RGHalf:
      for (let i = 0; i < pixels; i++) {
        put(out, i, unorm(half(i * 4)), unorm(half(i * 4 + 2)), 0, 255);
      }
      break;
    case TextureFormat.RGBAHalf:
      for (let i = 0; i < pixels; i++) {
        const o = i * 8;
        put(out, i, unorm(half(o)), unorm(half(o + 2)), unorm(half(o + 4)), unorm(half(o + 6)));
      }
      break;
    case TextureFormat.RFloat:
      for (let i = 0; i < pixels; i++) put(out, i, unorm(f32(i * 4)), 0, 0, 255);
      break;
    case TextureFormat.RGFloat:
      for (let i = 0; i < pixels; i++) {
        put(out, i, unorm(f32(i * 8)), unorm(f32(i * 8 + 4)), 0, 255);
      }
      break;
    case TextureFormat.RGBAFloat:
      for (let i = 0; i < pixels; i++) {
        const o = i * 16;
        put(out, i, unorm(f32(o)), unorm(f32(o + 4)), unorm(f32(o + 8)), unorm(f32(o + 12)));
      }
      break;
    case TextureFormat.YUY2: // Y0 U Y1 V per pixel pair, BT.601 video range
      for (let i = 0; i < pixels; i += 2) {
        const y0 = data[i * 2]! - 16;
        const d = data[i * 2 + 1]! - 128;
        const y1 = data[i * 2 + 2]! - 16;
        const e = data[i * 2 + 3]! - 128;
        yuv(out, i, y0, d, e);
        yuv(out, i + 1, y1, d, e);
      }
      break;
    case TextureFormat.RGB9e5Float: // 9-bit R G B mantissas, shared 5-bit exponent (bias 15) on top
      for (let i = 0; i < pixels; i++) {
        const n = view.getUint32(i * 4, true);
        const scale = 2 ** ((n >>> 27) - 24);
        // Double arithmetic, as upstream: an int times a double times 255f.
        const channel = (shift: number) => roundByte(((n >>> shift) & 0x1ff) * scale * 255);
        put(out, i, channel(0), channel(9), channel(18), 255);
      }
      break;
  }
  return { data: out, width, height };
}

function put(out: Uint8Array, i: number, r: number, g: number, b: number, a: number): void {
  out[i * 4] = r;
  out[i * 4 + 1] = g;
  out[i * 4 + 2] = b;
  out[i * 4 + 3] = a;
}

/** Low 4 bits of `v`, widened to 8 by repeating them (`0xA` -> `0xAA`). */
function nibble(v: number): number {
  return (v & 0xf) * 0x11;
}

/** 16-bit to 8-bit, rounded: upstream's `DownScaleFrom16BitTo8Bit`. */
function downscale16(c: number): number {
  return (c * 255 + 32895) >> 16;
}

/** One YUY2 pixel, upstream's integer BT.601 conversion, clamped. */
function yuv(out: Uint8Array, i: number, c: number, d: number, e: number): void {
  put(
    out,
    i,
    clamp((298 * c + 409 * e + 128) >> 8),
    clamp((298 * c - 100 * d - 208 * e + 128) >> 8),
    clamp((298 * c + 516 * d + 128) >> 8),
    255,
  );
}

function clamp(x: number): number {
  return x < 0 ? 0 : x > 255 ? 255 : x;
}

/**
 * A 0..1 channel as a byte. Upstream multiplies in single precision
 * (`value * 255f`), hence the `fround`.
 */
function unorm(v: number): number {
  return roundByte(Math.fround(v * 255));
}

/**
 * `(byte)Math.Round(v)`: round half to even (.NET's default), then saturate.
 *
 * .NET 8 wraps an out-of-range double-to-byte cast and .NET 9+ saturates, so
 * upstream's own output for HDR values depends on its runtime; saturating is
 * the one that keeps an over-bright pixel bright. NaN becomes 0 on both.
 */
function roundByte(v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 255) return 255;
  const r = Math.round(v);
  return r - v === 0.5 && r % 2 === 1 ? r - 1 : r;
}

/**
 * IEEE 754 binary16 to a number. Exact, so it equals upstream's table lookup
 * (`HalfHelper.HalfToSingle`) for every input, subnormals, infinities and NaN
 * included.
 */
export function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exponent = (h >> 10) & 0x1f;
  const mantissa = h & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * (1024 + mantissa) * 2 ** (exponent - 25);
}
