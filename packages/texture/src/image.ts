import { readTexture2D } from "unity-asset-reader";
import type {
  Asset,
  BuildTarget,
  Env,
  ObjectReader,
  Rectf,
  Texture2DData,
  Vector2,
  Vector4,
} from "unity-asset-reader";
import { decodeTexture2D, ensureTexture, FORMAT_NAMES } from "./decode.js";
import { decodeSprite, locateSprite, spriteSize } from "./sprite.js";

// ES2020 has no timers in its lib, and this package takes no DOM or Node
// types (R4); every browser, Worker and Node.js has this one.
declare const setTimeout: (callback: () => void, ms: number) => unknown;

/** An asset {@link isImage} accepts: a Texture2D or a Sprite. */
export type ImageAsset = Asset<"Texture2D" | "Sprite">;

/**
 * How a texture format stores its pixels, by format family: `"none"` for the
 * uncompressed formats (RGBA32, RGB565, RHalf, ...), `"bc"` for DXT1-DXT5 and
 * BC4-BC7, `"etc"` / `"etc2"` / `"eac"` / `"pvrtc"` / `"atc"` / `"astc"` for
 * the formats of those names, `"crunch"` for the four `*Crunched` formats,
 * and `"unknown"` for a value `TextureFormat` does not name.
 */
export type ImageCompression =
  | "none"
  | "bc"
  | "etc"
  | "etc2"
  | "eac"
  | "pvrtc"
  | "atc"
  | "astc"
  | "crunch"
  | "unknown";

/** The fields every {@link ImageInfo} has. */
interface ImageInfoFields {
  /** The asset's `name` (`m_Name`). */
  name: string;
  /** The asset's container path (`m_Container`), or `undefined`. */
  path: string | undefined;
  /** The asset's path id. */
  pathId: bigint;
  /** The SerializedFile holding the asset. */
  file: string;
  /**
   * Pixels across: `m_Width` for a Texture2D; for a Sprite, the width of what
   * `decodeImage` cuts out (its `textureRect` widened to whole pixels, and
   * turned back when it was packed with `Rotate90`).
   */
  width: number;
  /** Pixels down, as {@link width}. */
  height: number;
  /**
   * `m_TextureFormat`, a `TextureFormat` value, as the file holds it (so also
   * a value `TextureFormat` does not name). A Sprite's fields from here on are
   * those of its texture, whose pixels it is cut from.
   */
  format: number;
  /** The `TextureFormat` name of {@link format} (`"DXT5"`), or `"unknown"`. */
  formatName: string;
  /** How {@link format} stores its pixels. */
  compression: ImageCompression;
  /**
   * Mip levels stored: `m_MipCount` (Unity 5.2+); before 5.2 the full chain
   * down to 1x1 when `m_MipMap` is set, and 1 otherwise.
   */
  mipCount: number;
  /** `m_IsReadable` (Unity 2.6+): whether scripts can read the pixels at run time. */
  readable: boolean;
  /**
   * `m_ColorSpace` (Unity 3.5+): 1 is `"srgb"` and 0 `"linear"` (the importer's
   * "sRGB (Color Texture)" box). `"srgb"` before 3.5, which had no linear
   * textures.
   */
  colorSpace: "srgb" | "linear";
  /** `m_TextureSettings.m_FilterMode`, Unity's `FilterMode`: 0 Point, 1 Bilinear, 2 Trilinear. */
  filterMode: number;
  /**
   * Unity's `TextureWrapMode` per axis (0 Repeat, 1 Clamp, 2 Mirror, 3
   * MirrorOnce): `m_TextureSettings.m_WrapU`/`V`/`W` from Unity 2017.1, and its
   * one `m_WrapMode` for all three before.
   */
  wrapMode: { u: number; v: number; w: number };
  /** The platform the file was built for (`m_TargetPlatform`). */
  platform: BuildTarget;
  /**
   * Bytes of encoded image data, every mip level: of `image data`, or, when
   * {@link streamed}, `m_StreamData.size`.
   */
  encodedSize: number;
  /**
   * Whether the image data is in a resource file (a `.resS`) rather than the
   * object: `image data` is empty and `m_StreamData.path` names a file.
   * Decoding then needs that file loaded too.
   */
  streamed: boolean;
}

/** {@link ImageInfo} of a Texture2D. */
export interface TextureImageInfo extends ImageInfoFields {
  kind: "Texture2D";
}

/** {@link ImageInfo} of a Sprite. */
export interface SpriteImageInfo extends ImageInfoFields {
  kind: "Sprite";
  sprite: SpriteInfo;
}

/** What a Sprite adds to its {@link ImageInfo}. */
export interface SpriteInfo {
  /** `m_Rect`: the sprite's area in its source texture, in pixels from the bottom-left corner. */
  rect: Rectf;
  /**
   * `textureRect` of the render data the pixels are cut by: its atlas entry,
   * or its own `m_RD`. The sprite's area in {@link texture}, in pixels from
   * the bottom-left corner.
   */
  textureRect: Rectf;
  /** `m_Pivot` (Unity 5.4.1p3+), as a fraction of `rect`; the centre (0.5, 0.5) before. */
  pivot: Vector2;
  /** `m_Border` (Unity 4.5+): the 9-slice border, left (x), bottom (y), right (z), top (w). */
  border: Vector4 | undefined;
  /** `m_PixelsToUnits`: pixels per world unit. */
  pixelsPerUnit: number;
  /** Bit 0 of `settingsRaw`: whether a packer placed it (an atlas or legacy packing tag). */
  packed: boolean;
  /** Bit 1 of `settingsRaw`: packed on its mesh's outline (`"tight"`) or its rectangle. */
  packingMode: "tight" | "rectangle";
  /**
   * Bits 2-5 of `settingsRaw`: how the packer turned it, a
   * `SpritePackingRotation` value; `decodeImage` turns it back.
   */
  rotation: number;
  /** `m_Name` of the SpriteAtlas it is packed into, when that atlas is loaded. */
  atlas: string | undefined;
  /** The texture it is cut from. */
  texture: TextureImageInfo;
}

/**
 * What {@link imageInfo} tells about an image asset, without decoding it;
 * `kind` tells a Texture2D's from a Sprite's.
 */
export type ImageInfo = TextureImageInfo | SpriteImageInfo;

/**
 * An image asset decoded by {@link decodeImage}: its {@link ImageInfo} and
 * its pixels, RGBA8, top row first, `width * height * 4` bytes.
 */
export type DecodedImage<I extends ImageInfo = ImageInfo> = I & { rgba: Uint8Array };

/** Options of {@link decodeImage}. */
export interface DecodeImageOptions {
  /**
   * Where the WASM files are, for the first decode's auto-init: see
   * `initTexture`. Browsers need it unless `initTexture` was called first;
   * Node.js finds the files itself.
   */
  wasmPath?: string;
}

/** Options of {@link images}. */
export interface ImagesOptions extends DecodeImageOptions {
  /**
   * What to do with an image that fails to decode: `"throw"` (the default)
   * rejects with its error and ends the iteration; `"skip"` leaves it out and
   * goes on. Loading the WASM decoder failing throws either way.
   */
  onError?: "throw" | "skip";
}

/**
 * Whether an asset is an image: a Texture2D or a Sprite. A type guard, so it
 * narrows `asset` for {@link imageInfo} and {@link decodeImage}.
 *
 * @param asset any asset of `env.assets()`
 * @example
 * for (const asset of env.assets()) if (isImage(asset)) console.log(imageInfo(asset).width);
 */
export function isImage(asset: Asset): asset is ImageAsset {
  return asset.type === "Texture2D" || asset.type === "Sprite";
}

/**
 * Describe an image asset without decoding it: its size, format, mips and
 * sampling settings, and, for a Sprite, where it is cut from. Sync, and needs
 * no WASM. It reads the Texture2D and Sprite fields with the low-level
 * readers (`readTexture2D`, the Sprite's and SpriteAtlas' `obj.read()`), and
 * no image data, so a texture in a `.resS` that is not loaded is described
 * too.
 *
 * A Sprite's texture is found as `decodeSprite` finds it: through its
 * SpriteAtlas when that atlas is loaded, its own `m_RD` otherwise.
 *
 * @param asset a Texture2D or Sprite asset (see {@link isImage})
 * @returns a new {@link ImageInfo}
 * @throws {TypeError} when `asset` is not a Texture2D or Sprite asset
 * @throws {UnsupportedError} / {CorruptError} what the readers throw: an
 *   editor file or unknown Unity version, a layout that does not hold
 *   together; for a Sprite also what `decodeSprite`'s lookup throws (a
 *   pointer that is null or dangles, a texture of the wrong class, a sprite
 *   its atlas has no entry for, a `textureRect` outside its texture)
 * @throws {ResourceNotFoundError} for a Sprite whose texture or atlas is in a
 *   SerializedFile that is not loaded
 */
export function imageInfo(asset: Asset<"Texture2D">): TextureImageInfo;
export function imageInfo(asset: Asset<"Sprite">): SpriteImageInfo;
export function imageInfo(asset: ImageAsset): ImageInfo;
export function imageInfo(asset: ImageAsset): ImageInfo {
  checkImage(asset, "imageInfo");
  if (asset.type === "Texture2D") return textureInfo(asset);

  const { sprite, rect, texture: textureObj, atlas } = locateSprite(asset.reader, asset.env);
  const texture = textureInfo(textureAsset(asset.env, textureObj));
  const size = spriteSize(rect, texture.width, texture.height);
  const { settingsRaw } = rect;
  return {
    ...texture,
    kind: "Sprite",
    name: asset.name,
    path: asset.path,
    pathId: asset.pathId,
    file: asset.file,
    width: size.width,
    height: size.height,
    sprite: {
      rect: sprite.m_Rect,
      textureRect: rect.textureRect,
      // Upstream's default, for files before 5.4.1p3 that have none.
      pivot: sprite.m_Pivot ?? { x: 0.5, y: 0.5 },
      border: sprite.m_Border,
      pixelsPerUnit: sprite.m_PixelsToUnits,
      packed: (settingsRaw & 1) === 1,
      packingMode: ((settingsRaw >> 1) & 1) === 0 ? "tight" : "rectangle",
      rotation: (settingsRaw >> 2) & 0xf,
      atlas: atlas?.m_Name,
      texture,
    },
  };
}

/**
 * Decode an image asset to RGBA8, top row first, with its {@link imageInfo}:
 * a Texture2D's first mip level through `decodeTexture2D`, a Sprite cut out
 * of its texture through `decodeSprite` (without `tightMesh`). `width` and
 * `height` are the decoded image's, for a Sprite its own cut-out size.
 *
 * The WASM decoder is loaded on first use (`initTexture(options)`), so
 * calling `initTexture` first is optional. Node.js needs no options; a
 * browser passes `options.wasmPath` or calls `initTexture({ wasmPath })`
 * before.
 *
 * @param asset a Texture2D or Sprite asset (see {@link isImage})
 * @param options where the WASM files are, for the auto-init
 * @returns a new {@link DecodedImage}
 * @throws {TypeError} when `asset` is not a Texture2D or Sprite asset
 * @throws {Error} when the WASM decoder cannot be loaded
 * @throws {UnsupportedError} for a format with no decoder here, and what
 *   `decodeTexture2D` and `decodeSprite` refuse (R9)
 * @throws {ResourceNotFoundError} when the image data is in a `.resS` that
 *   is not loaded, or a Sprite's texture or atlas in a file that is not
 * @throws {CorruptError} what {@link imageInfo}, `decodeTexture2D` and
 *   `decodeSprite` throw for data that does not hold together
 * @example
 * const { rgba, width, height, formatName } = await decodeImage(asset);
 */
export async function decodeImage(
  asset: Asset<"Texture2D">,
  options?: DecodeImageOptions,
): Promise<DecodedImage<TextureImageInfo>>;
export async function decodeImage(
  asset: Asset<"Sprite">,
  options?: DecodeImageOptions,
): Promise<DecodedImage<SpriteImageInfo>>;
export async function decodeImage(
  asset: ImageAsset,
  options?: DecodeImageOptions,
): Promise<DecodedImage>;
export async function decodeImage(
  asset: ImageAsset,
  options: DecodeImageOptions = {},
): Promise<DecodedImage> {
  const info = imageInfo(asset);
  await ensureTexture({ wasmPath: options.wasmPath });
  // The reader, not `asset.data`: `decodeTexture2D` takes `obj.read()`'s shape.
  const image =
    asset.type === "Texture2D"
      ? await decodeTexture2D(asset.reader.read<Texture2DData>())
      : await decodeSprite(asset.reader, asset.env);
  return { ...info, width: image.width, height: image.height, rgba: image.data };
}

/**
 * Every Texture2D and Sprite of an env, decoded by {@link decodeImage}, in
 * `env.assets()` order. It hands the event loop a turn (a zero timeout)
 * before each image after the first, so a loop over it on a page's main
 * thread keeps the page responsive between images.
 *
 * With `onError: "skip"` an image that fails to decode is left out; by
 * default it ends the iteration with its error (R9). Either way, a WASM
 * decoder that cannot be loaded throws, and so does parsing the env.
 *
 * @param env the env to decode the images of
 * @param options `onError`, and `wasmPath` for the auto-init
 * @throws {TypeError} for an `onError` other than `"throw"` or `"skip"`
 * @throws what {@link decodeImage} throws, with `onError: "throw"`
 * @example
 * for await (const { name, rgba, width, height } of images(env)) show(name, rgba, width, height);
 */
export async function* images(
  env: Env,
  options: ImagesOptions = {},
): AsyncGenerator<DecodedImage, void, undefined> {
  const onError = options.onError ?? "throw";
  if (onError !== "throw" && onError !== "skip") {
    throw new TypeError(`images: onError must be "throw" or "skip", got ${String(onError)}`);
  }
  let first = true;
  for (const asset of env.assets("Texture2D", "Sprite")) {
    if (!first) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    first = false;
    // Outside the try: a decoder that does not load is no image's fault.
    await ensureTexture({ wasmPath: options.wasmPath });
    let image: DecodedImage;
    try {
      image = await decodeImage(asset);
    } catch (error) {
      if (onError === "skip") continue;
      throw error;
    }
    yield image;
  }
}

/** A Texture2D asset's {@link TextureImageInfo}, from `readTexture2D`. */
function textureInfo(asset: Asset<"Texture2D">): TextureImageInfo {
  const texture = readTexture2D(asset.reader);
  const { m_Width: width, m_Height: height, m_TextureFormat: format } = texture;
  const settings = texture.m_TextureSettings;
  const wrap = (axis: number | undefined): number => axis ?? settings.m_WrapMode ?? 0;
  // As `obj.read()` picks the data: inline when there is any, else the .resS.
  const inline = texture["image data"].length;
  const stream = texture.m_StreamData;
  const streamed = inline === 0 && stream !== undefined && stream.path !== "";
  return {
    kind: "Texture2D",
    name: asset.name,
    path: asset.path,
    pathId: asset.pathId,
    file: asset.file,
    width,
    height,
    format,
    formatName: FORMAT_NAMES.get(format) ?? "unknown",
    compression: compressionOf(format),
    // 5.2: the m_MipMap flag became a count; a mipmapped texture before has
    // every level down to 1x1.
    mipCount:
      texture.m_MipCount ??
      (texture.m_MipMap ? Math.floor(Math.log2(Math.max(width, height, 1))) + 1 : 1),
    readable: texture.m_IsReadable === true,
    colorSpace: texture.m_ColorSpace === 0 ? "linear" : "srgb",
    filterMode: settings.m_FilterMode,
    // 2017.1: one wrap mode per axis.
    wrapMode: { u: wrap(settings.m_WrapU), v: wrap(settings.m_WrapV), w: wrap(settings.m_WrapW) },
    platform: asset.reader.platform,
    encodedSize: streamed ? stream.size : inline,
    streamed,
  };
}

/** `TextureFormat` name prefix -> family, for the formats that are not Crunch. */
const FAMILIES: readonly [string, ImageCompression][] = [
  ["DXT", "bc"],
  ["BC", "bc"],
  ["ETC2_", "etc2"],
  ["ETC_", "etc"],
  ["EAC_", "eac"],
  ["PVRTC_", "pvrtc"],
  ["ATC_", "atc"],
  ["ASTC_", "astc"],
];

/** {@link ImageCompression} of a format, by its `TextureFormat` name. */
function compressionOf(format: number): ImageCompression {
  const name = FORMAT_NAMES.get(format);
  if (name === undefined) return "unknown";
  if (name.endsWith("Crunched")) return "crunch";
  return FAMILIES.find(([prefix]) => name.startsWith(prefix))?.[1] ?? "none";
}

/** Each env's assets by object, for a Sprite's texture; built on first use. */
const assetsByObject = new WeakMap<Env, Map<ObjectReader, Asset<"Texture2D">>>();

/** The asset of a Texture2D object of `env`. */
function textureAsset(env: Env, obj: ObjectReader): Asset<"Texture2D"> {
  let byObject = assetsByObject.get(env);
  if (!byObject) {
    byObject = new Map([...env.assets("Texture2D")].map((a) => [a.reader, a]));
    assetsByObject.set(env, byObject);
  }
  // `locateSprite` resolved `obj` in `env` and checked its class.
  return byObject.get(obj)!;
}

/** `asset` is checked at run time: a JavaScript caller's type is only a claim. */
function checkImage(asset: unknown, fn: string): void {
  const { type, typeName } = (asset ?? {}) as { type?: unknown; typeName?: unknown };
  if (type === "Texture2D" || type === "Sprite") return;
  const got = typeName === undefined ? String(asset) : `an asset of class ${String(typeName)}`;
  throw new TypeError(`${fn}: expected a Texture2D or Sprite asset, got ${got}`);
}
