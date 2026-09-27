// Ported from AssetStudio.Utility/Texture2DConverter.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from UnityPy/helpers/TextureSwizzler.py and UnityPy/export/Texture2DConverter.py (MIT, © K0lb3), itself based on AssetsTools.NET's SwitchSwizzle.cs (MIT, © nesrak1)

import { BuildTarget, CorruptError, TextureFormat, UnsupportedError } from "unity-asset-reader";

// Internal to the package: decodeTexture2D applies both layouts, nothing else
// exports them.

const F = TextureFormat;

/**
 * The formats whose 16-bit words Xbox 360 builds store big-endian: upstream's
 * `SwapBytesForXbox` calls. UnityPy also swaps DXT1Crunched and DXT5Crunched
 * but not ARGB4444; AssetStudio, the source of truth, is followed.
 */
const XBOX360_SWAPPED: ReadonlySet<number> = new Set([F.ARGB4444, F.RGB565, F.DXT1, F.DXT5]);

/**
 * Upstream `SwapBytesForXbox`: for an Xbox 360 texture in one of the formats
 * it applies to, a copy of `data` with the bytes of every 16-bit word
 * swapped (a trailing odd byte stays); otherwise `data` itself.
 *
 * @param data the image data, every mip level, as upstream swaps it
 * @param platform the texture's `BuildTarget`
 * @param format `m_TextureFormat`
 */
export function xbox360Swap(data: Uint8Array, platform: number, format: number): Uint8Array {
  if (platform !== BuildTarget.XBOX360 || !XBOX360_SWAPPED.has(format)) return data;
  // A copy: `data` is a view into the file, which decoding must not change.
  const out = new Uint8Array(data.length);
  for (let i = 0; i + 1 < data.length; i += 2) {
    out[i] = data[i + 1]!;
    out[i + 1] = data[i]!;
  }
  if (data.length % 2 === 1) out[data.length - 1] = data[data.length - 1]!;
  return out;
}

/** The PlayStation platforms whose texture tiling nothing here can undo (#130). */
const PLAYSTATION: ReadonlyMap<number, string> = new Map([
  [BuildTarget.PS4, "PS4"],
  [BuildTarget.PS5, "PS5"],
]);

/**
 * Refuse a PS4 or PS5 texture (R9). Their builds can store textures tiled,
 * and neither upstream (AssetStudio, UnityPy) detiles them, so there is no
 * behavior to port and no oracle; decoding one as linear would give a wrong
 * image with no error. Linear PlayStation textures are refused too, as
 * nothing in the file tells the two apart. Lifted by #130.
 *
 * @param platform the texture's `BuildTarget`
 * @throws {UnsupportedError} for `BuildTarget.PS4` and `BuildTarget.PS5`
 */
export function refuseTiledPlatform(platform: number): void {
  const name = PLAYSTATION.get(platform);
  if (name !== undefined) {
    throw new UnsupportedError(
      "texture platform",
      platform,
      `${name} textures may be tiled, and detiling them is not supported yet (#130)`,
    );
  }
}

/**
 * Texel shape of a Switch-swizzled format: how many pixels across and down
 * fill the 16 bytes the Tegra block-linear layout moves as one unit
 * (UnityPy's `TEXTURE_FORMAT_BLOCK_SIZE_MAP`). A format not here cannot be
 * deswizzled; RGB24 and BGR24 are stored as RGBA32 and BGRA32 on Switch.
 */
const SWITCH_TEXEL: ReadonlyMap<number, readonly [number, number]> = new Map([
  [F.Alpha8, [16, 1]],
  [F.ARGB4444, [8, 1]],
  [F.RGBA32, [4, 1]],
  [F.ARGB32, [4, 1]],
  [F.ARGBFloat, [1, 1]],
  [F.RGB565, [8, 1]],
  [F.R16, [8, 1]],
  [F.DXT1, [8, 4]],
  [F.DXT5, [4, 4]],
  [F.RGBA4444, [8, 1]],
  [F.BGRA32, [4, 1]],
  [F.BC6H, [4, 4]],
  [F.BC7, [4, 4]],
  [F.BC4, [8, 4]],
  [F.BC5, [4, 4]],
  [F.ASTC_RGB_4x4, [4, 4]],
  [F.ASTC_RGB_5x5, [5, 5]],
  [F.ASTC_RGB_6x6, [6, 6]],
  [F.ASTC_RGB_8x8, [8, 8]],
  [F.ASTC_RGB_10x10, [10, 10]],
  [F.ASTC_RGB_12x12, [12, 12]],
  [F.ASTC_RGBA_4x4, [4, 4]],
  [F.ASTC_RGBA_5x5, [5, 5]],
  [F.ASTC_RGBA_6x6, [6, 6]],
  [F.ASTC_RGBA_8x8, [8, 8]],
  [F.ASTC_RGBA_10x10, [10, 10]],
  [F.ASTC_RGBA_12x12, [12, 12]],
  [F.RG16, [8, 1]],
  [F.R8, [16, 1]],
]);

/** A GOB (group of bytes) is 4 x 8 texels of 16 bytes: 64 bytes across, 8 rows. */
const GOB_WIDTH = 4;
const GOB_HEIGHT = 8;

/** Texel `i` of a GOB -> its column and row in the GOB (UnityPy's `GOB_MAP`). */
const GOB_MAP: readonly (readonly [number, number])[] = Array.from({ length: 32 }, (_, v) => [
  ((v >> 3) & 0b10) | ((v >> 1) & 0b1),
  ((v >> 1) & 0b110) | (v & 0b1),
]);

/** How a Switch texture is swizzled: the format its data is in and its padded size. */
export interface SwitchLayout {
  /** `m_TextureFormat`, or RGBA32 / BGRA32 for RGB24 / BGR24. */
  format: number;
  texelWidth: number;
  texelHeight: number;
  gobsPerBlock: number;
  /** The size the swizzled level covers: the texture's, padded to whole blocks of GOBs. */
  paddedWidth: number;
  paddedHeight: number;
}

/**
 * UnityPy's `is_switch_swizzled`, plus the layout: a Switch texture is
 * swizzled when its `m_PlatformBlob` (Unity 2020.2+) has at least 12 bytes
 * and bytes 8-11, little-endian, give log2 of the GOBs per block as 1 or
 * more. Anything else, or any other platform, is stored linear: `undefined`.
 *
 * @param platform the texture's `BuildTarget`
 * @param blob `m_PlatformBlob`, when the texture has one
 * @param format `m_TextureFormat`
 * @param width `m_Width`, a non-negative integer
 * @param height `m_Height`, a non-negative integer
 * @throws {UnsupportedError} when the texture is swizzled but its format has
 *   no texel shape above (Crunch, ETC, PVRTC, ASTC HDR, the half and float
 *   formats but ARGBFloat, ...), or the GOBs per block are more than 32, the
 *   most the Tegra block-linear layout has
 */
export function switchLayout(
  platform: number,
  blob: Uint8Array | undefined,
  format: number,
  width: number,
  height: number,
): SwitchLayout | undefined {
  if (platform !== BuildTarget.Switch || blob === undefined || blob.length < 12) return undefined;
  const log2 = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(8, true);
  if (log2 === 0) return undefined;
  if (log2 > 5) {
    throw new UnsupportedError(
      "Switch GOBs per block (log2)",
      log2,
      "the Tegra block-linear layout has 1 to 32 GOBs per block",
    );
  }
  const stored = format === F.RGB24 ? F.RGBA32 : format === F.BGR24 ? F.BGRA32 : format;
  const texel = SWITCH_TEXEL.get(stored);
  if (texel === undefined) {
    throw new UnsupportedError("Switch-swizzled texture format", format, "no known texel layout");
  }
  const [texelWidth, texelHeight] = texel;
  const gobsPerBlock = 2 ** log2;
  const across = texelWidth * GOB_WIDTH;
  const down = texelHeight * GOB_HEIGHT * gobsPerBlock;
  return {
    format: stored,
    texelWidth,
    texelHeight,
    gobsPerBlock,
    paddedWidth: Math.ceil(width / across) * across,
    paddedHeight: Math.ceil(height / down) * down,
  };
}

/**
 * UnityPy's `deswizzle`: the first level of a Switch block-linear texture,
 * reordered into rows of texels. Block after block of `gobsPerBlock` GOBs
 * stacked down, GOB after GOB of 32 texels, each texel is 16 bytes read in
 * turn and written where `GOB_MAP` puts it.
 *
 * @param data the image data; only its first `paddedWidth x paddedHeight`
 *   level is read
 * @param layout from {@link switchLayout}
 * @returns a new array, the padded level's size
 * @throws {CorruptError} when `data` is shorter than the padded level
 */
export function deswizzle(data: Uint8Array, layout: SwitchLayout): Uint8Array {
  const { texelWidth, texelHeight, gobsPerBlock, paddedWidth, paddedHeight } = layout;
  const texelsAcross = paddedWidth / texelWidth;
  const texelsDown = paddedHeight / texelHeight;
  const size = texelsAcross * texelsDown * 16;
  if (data.length < size) {
    throw new CorruptError(
      `Switch-swizzled format ${layout.format} image data is ${data.length} bytes, its ` +
        `${paddedWidth} x ${paddedHeight} padded level needs ${size}`,
    );
  }
  const out = new Uint8Array(size);
  const gobsAcross = texelsAcross / GOB_WIDTH;
  const blocksDown = texelsDown / GOB_HEIGHT / gobsPerBlock;
  let src = 0;
  for (let block = 0; block < blocksDown; block++) {
    for (let gobX = 0; gobX < gobsAcross; gobX++) {
      for (let gob = 0; gob < gobsPerBlock; gob++) {
        const top = (block * gobsPerBlock + gob) * GOB_HEIGHT;
        for (const [x, y] of GOB_MAP) {
          const dst = ((top + y) * texelsAcross + gobX * GOB_WIDTH + x) * 16;
          out.set(data.subarray(src, src + 16), dst);
          src += 16;
        }
      }
    }
  }
  return out;
}
