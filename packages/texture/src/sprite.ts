// Ported from AssetStudio.Utility/SpriteHelper.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Classes/Mesh.cs (MIT, © Perfare / RazTools / Razviar)
// Derived from SixLabors/ImageSharp.Drawing src/ImageSharp.Drawing/Shapes/Rasterization/*.cs @ v1.0.0-beta15 (Apache-2.0, © Six Labors): the triangle fill at the end of this file, see there

import {
  ClassID,
  CorruptError,
  ResourceNotFoundError,
  SpritePackingRotation,
  UnsupportedError,
} from "unity-asset-reader";
import type {
  Env,
  ObjectReader,
  PPtr,
  PPtrResolution,
  Sprite,
  SpriteAtlas,
  SpriteRenderData,
  Texture2DData,
  UnityVersion,
} from "unity-asset-reader";
import type { RgbaImage } from "./convert.js";
import { decodeTexture2D } from "./decode.js";

/** Options of {@link decodeSprite}. */
export interface DecodeSpriteOptions {
  /**
   * Clear the pixels outside the sprite's mesh, as upstream does for a sprite
   * whose packing mode is Tight: they become transparent black. Without it
   * (the default) the result is the sprite's rectangle as packed. A sprite
   * packed as a rectangle is never masked.
   */
  tightMesh?: boolean;
}

/**
 * The fields of a sprite's render data that say where its pixels are: its own
 * `m_RD`, or its entry in its atlas' `m_RenderDataMap`.
 */
export type SpriteRect = Pick<
  SpriteRenderData,
  "textureRect" | "textureRectOffset" | "settingsRaw" | "downscaleMultiplier"
>;

/** A sprite's key into its atlas' `m_RenderDataMap`. */
type RenderDataKey = NonNullable<Sprite["m_RenderDataKey"]>;

/** A sprite, the texture it is drawn from and where in it. Internal: for the tests. */
export interface SpriteSource {
  sprite: Sprite;
  rect: SpriteRect;
  texture: Texture2DData;
}

/**
 * Decode a Sprite to RGBA8, top row first, like {@link decodeTexture2D}:
 * upstream's `SpriteHelper.GetImage`.
 *
 * A sprite's pixels live in another object, so this takes the Sprite's reader
 * and the env that loaded it rather than `obj.read()`'s data: the texture is
 * found through pointers, with `env.resolve`. When the sprite points at a
 * `SpriteAtlas` that is loaded, its texture and rectangle are the atlas'
 * entry for the sprite's `m_RenderDataKey`; otherwise (no atlas, or the atlas'
 * file is not loaded) they are the sprite's own `m_RD`, as upstream does.
 *
 * The rectangle is cut out of the texture (`textureRect`, from its bottom-left
 * corner, widened to whole pixels), and a packer's flip or rotation
 * (`SpritePackingRotation`) is undone. With `tightMesh`, pixels outside the
 * sprite's mesh are cleared, as upstream fills its triangles into a mask with
 * ImageSharp.Drawing 1.0.0-beta15 without antialiasing: a pixel is inside a
 * triangle when at least half of it is, measured along eight rows per pixel,
 * with the vertices' y snapped to eighths. That fill is derived from
 * ImageSharp.Drawing's code and is under the Apache License 2.0 (this
 * package's `NOTICE` and `LICENSE-APACHE`).
 *
 * `Rotate90` is turned back the way upstream turns it (ImageSharp
 * `Rotate(270)`). That direction is not verified against Unity's packer: no
 * fixture editor's packer writes `Rotate90`, and UnityPy, which turns the
 * other way, mistranslates the same upstream call rather than checking it
 * independently (#34, tracked in the follow-up named in `fixtures/README.md`).
 *
 * Every call decodes the texture again. ponytail: an atlas with many sprites
 * is decoded once per sprite; a cache of decoded textures (or a variant that
 * takes the decoded atlas) is the upgrade path when that shows up in a profile.
 *
 * Unlike upstream, which hands back no image or an unmasked one, this throws
 * where the result would be wrong: see below.
 *
 * @param sprite a Sprite (`ClassID.Sprite`) from `env.objects`
 * @param env the env that loaded it, and the files its texture and atlas are in
 * @param options see {@link DecodeSpriteOptions}
 * @returns a new RGBA image, top row first
 * @throws {TypeError} when `sprite` is not a Sprite
 * @throws {Error} before `initTexture` has finished, or when `sprite` is not
 *   one of `env.objects`
 * @throws {ResourceNotFoundError} when the texture, or the atlas it is in, is
 *   in a SerializedFile that is not loaded (its `fileName`), or the texture's
 *   data is in a `.resS` that is not
 * @throws {UnsupportedError} what `obj.read()` and `decodeTexture2D` throw,
 *   and: an alpha texture (`alphaTexture`, ETC1 split alpha; kind
 *   `"sprite alpha texture"`), a `downscaleMultiplier` other than 1 (a variant
 *   atlas; kind `"sprite downscale"`), a packing rotation Unity does not define
 *   (kind `"sprite packing rotation"`) and, with `tightMesh`, a mesh whose
 *   positions are not 32-bit floats (kind `"sprite vertex format"`)
 * @throws {CorruptError} when the sprite's atlas does not hold its render
 *   data, a pointer is null or points at nothing or at the wrong class, the
 *   rectangle does not lie in the texture, or, with `tightMesh`, the mesh
 *   does not hold together
 * @example
 * await initTexture();
 * for (const obj of env.objects) {
 *   if (obj.type === ClassID.Sprite) {
 *     const { data, width, height } = await decodeSprite(obj, env);
 *   }
 * }
 */
export async function decodeSprite(
  sprite: ObjectReader,
  env: Env,
  options: DecodeSpriteOptions = {},
): Promise<RgbaImage> {
  const source = findSpriteSource(sprite, env);
  const image = await decodeTexture2D(source.texture);
  return cutSprite(image, source.sprite, source.rect, sprite.version, options.tightMesh === true);
}

/**
 * Upstream `GetImage`'s lookup: the sprite's atlas entry when its atlas is
 * loaded, its own `m_RD` otherwise; then the texture either names. Internal:
 * exported for the tests, not from the package.
 *
 * @throws what {@link decodeSprite} throws, but for decoding
 */
export function findSpriteSource(obj: ObjectReader, env: Env): SpriteSource {
  if (obj?.type !== ClassID.Sprite) {
    throw new TypeError(
      `decodeSprite: expected the ObjectReader of a Sprite (class ${ClassID.Sprite}), ` +
        `got ${obj?.type === undefined ? String(obj) : `class ${obj.type}`}`,
    );
  }
  const sprite = obj.read<Sprite>();
  const what = `sprite "${sprite.m_Name}" (path id ${obj.pathId})`;

  const atlasPointer = sprite.m_SpriteAtlas;
  const atlas = atlasPointer ? env.resolve(atlasPointer, obj) : undefined;
  if (atlas?.status === "found") {
    const atlasObj = checkClass(atlas.object, ClassID.SpriteAtlas, `${what}'s atlas`);
    const data = atlasObj.read<SpriteAtlas>();
    const key = sprite.m_RenderDataKey;
    const entry = key && data.m_RenderDataMap.find(([k]) => sameKey(k, key))?.[1];
    if (!entry) {
      throw new CorruptError(
        `${what}: its atlas "${data.m_Name}" (path id ${atlasObj.pathId}) has no render data ` +
          "for its m_RenderDataKey",
      );
    }
    refuseAlphaTexture(entry.alphaTexture, what);
    const texture = readTexture(env, entry.texture, atlasObj, `${what}'s atlas texture`);
    return { sprite, rect: entry, texture };
  }

  // Upstream falls back to m_RD for any atlas it cannot get. When that has
  // no texture either, the atlas pointer that led nowhere is what to report:
  // its file not loaded, or the pointer dangling.
  const rd = sprite.m_RD;
  if (rd.texture.m_PathID === 0n && atlasPointer && atlas && atlas.status !== "null") {
    found(atlas, atlasPointer, `${what}'s atlas, which holds its texture,`);
  }
  refuseAlphaTexture(rd.alphaTexture, what);
  const texture = readTexture(env, rd.texture, obj, `${what}'s texture`);
  return { sprite, rect: rd, texture };
}

/** The Texture2D a pointer names, read. */
function readTexture(env: Env, pointer: PPtr, from: ObjectReader, what: string): Texture2DData {
  const texture = found(env.resolve(pointer, from), pointer, what);
  return checkClass(texture, ClassID.Texture2D, what).read<Texture2DData>();
}

/**
 * The object a pointer resolved to, or the reason there is none as an error.
 *
 * @throws {ResourceNotFoundError} when its file is not loaded
 * @throws {CorruptError} otherwise
 */
function found(resolution: PPtrResolution, pointer: PPtr, what: string): ObjectReader {
  switch (resolution.status) {
    case "found":
      return resolution.object;
    case "fileNotLoaded":
      throw notLoaded(resolution.fileName, `${what} (path id ${pointer.m_PathID}) is in`);
    case "null":
      throw new CorruptError(`${what} is a null pointer`);
    case "fileIdOutOfRange":
      throw new CorruptError(`${what} has file id ${pointer.m_FileID}, past the file's externals`);
    case "objectNotFound":
      throw new CorruptError(
        `${what} (path id ${pointer.m_PathID}) is not in ${resolution.fileName}`,
      );
  }
}

/** A {@link ResourceNotFoundError} for a SerializedFile a pointer needs. */
function notLoaded(fileName: string, what: string): ResourceNotFoundError {
  const error = new ResourceNotFoundError(fileName, fileName);
  error.message = `${what} ${fileName}, which is not loaded: pass it to load() too`;
  return error;
}

/** `obj`, when it is of class `classId`. */
function checkClass(obj: ObjectReader, classId: number, what: string): ObjectReader {
  if (obj.type !== classId) {
    throw new CorruptError(`${what} (path id ${obj.pathId}) is class ${obj.type}, not ${classId}`);
  }
  return obj;
}

/**
 * Upstream ignores a sprite's alpha texture and returns its colour texture
 * as if opaque; that is a sprite without its alpha, so it is refused (R9).
 */
function refuseAlphaTexture(alpha: PPtr | undefined, what: string): void {
  if (alpha && alpha.m_PathID !== 0n) {
    throw new UnsupportedError(
      "sprite alpha texture",
      `path id ${alpha.m_PathID}`,
      `${what} keeps its alpha in a texture of its own (ETC1 split alpha)`,
    );
  }
}

/** Whether two `m_RenderDataKey`s (a GUID and a 64-bit id) are the same. */
function sameKey(a: RenderDataKey, b: RenderDataKey): boolean {
  const [guidA, idA] = a;
  const [guidB, idB] = b;
  if (idA !== idB) return false;
  for (let i = 0; i < 4; i++) if (guidA[`data[${i}]`] !== guidB[`data[${i}]`]) return false;
  return true;
}

// --- the pixels: upstream CutImage -------------------------------------------------

/** 32-bit float rounding: upstream computes in `float`. */
const f32 = Math.fround;

/**
 * Upstream `CutImage`, over a texture already decoded: cut the rectangle out,
 * undo the packing rotation, and, when asked and the packing mode is Tight,
 * clear the pixels outside the sprite's mesh. Internal: exported for the
 * tests, not from the package.
 *
 * Upstream works on the texture with its rows as Unity stores them, bottom
 * row first, and flips the result at the end; so does this, reading the
 * top-down `image` bottom up.
 *
 * @param image the texture, as `decodeTexture2D` returns it (top row first)
 * @param sprite the Sprite's fields (its mesh, rectangle, pivot)
 * @param rect where the pixels are: the atlas entry, or `sprite.m_RD`
 * @param version the Unity version of the sprite's file, for its vertex formats
 * @param tightMesh whether to clear what is outside the mesh
 * @returns a new RGBA image, top row first
 * @throws {UnsupportedError} / {CorruptError} as {@link decodeSprite} does
 */
export function cutSprite(
  image: RgbaImage,
  sprite: Sprite,
  rect: SpriteRect,
  version: UnityVersion,
  tightMesh: boolean,
): RgbaImage {
  const { textureRect: tr, settingsRaw } = rect;
  const downscale = rect.downscaleMultiplier ?? 0;
  if (downscale > 0 && downscale !== 1) {
    // Upstream resizes the texture with ImageSharp's bicubic resampler first.
    throw new UnsupportedError(
      "sprite downscale",
      downscale,
      "a variant atlas is scaled; resampling it back is not implemented",
    );
  }

  // Upstream widens the rectangle to whole pixels, and clips its far edges.
  const x = Math.floor(tr.x);
  const y = Math.floor(tr.y);
  const right = Math.min(Math.ceil(f32(tr.x + tr.width)), image.width);
  const top = Math.min(Math.ceil(f32(tr.y + tr.height)), image.height);
  const width = right - x;
  const height = top - y;
  if (!(x >= 0 && y >= 0 && width > 0 && height > 0)) {
    throw new CorruptError(
      `sprite textureRect (${tr.x}, ${tr.y}) ${tr.width} x ${tr.height} does not lie in its ` +
        `${image.width} x ${image.height} texture`,
    );
  }

  // Rows bottom first, as upstream holds them until its final flip.
  let out = crop(image, x, y, width, height);
  if ((settingsRaw & 1) === 1) out = unpack(out, (settingsRaw >> 2) & 0xf);
  if (tightMesh && ((settingsRaw >> 1) & 1) === 0) {
    const mask = meshMask(sprite, rect, version, out.width, out.height);
    // Upstream blends the mask over every pixel with premultiplied alpha, so a
    // pixel it keeps loses its colour too when its alpha is 0.
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 0 || out.data[i * 4 + 3] === 0) out.data.fill(0, i * 4, i * 4 + 4);
    }
  }
  return flipRows(out);
}

/** `width x height` pixels from (`x`, `y`) up, of a top-down image, rows bottom first. */
function crop(image: RgbaImage, x: number, y: number, width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const from = ((image.height - 1 - (y + row)) * image.width + x) * 4;
    data.set(image.data.subarray(from, from + width * 4), row * width * 4);
  }
  return { data, width, height };
}

/**
 * Undo a packer's flip or rotation (upstream's `RotateAndFlip` switch), on
 * rows bottom first as upstream holds them. `Rotate90` is upstream's
 * ImageSharp `Rotate(270)`, a quarter turn clockwise on those rows.
 *
 * @throws {UnsupportedError} for a value `SpritePackingRotation` does not
 *   define, which upstream leaves as it is
 */
function unpack(image: RgbaImage, rotation: number): RgbaImage {
  const { data, width, height } = image;
  const out = new Uint8Array(data.length);
  const copy = (to: number, fromX: number, fromY: number) =>
    out.set(data.subarray((fromY * width + fromX) * 4, (fromY * width + fromX) * 4 + 4), to * 4);
  switch (rotation) {
    case SpritePackingRotation.None:
      return image;
    case SpritePackingRotation.FlipHorizontal:
    case SpritePackingRotation.FlipVertical:
    case SpritePackingRotation.Rotate180: {
      const flipX = rotation !== SpritePackingRotation.FlipVertical;
      const flipY = rotation !== SpritePackingRotation.FlipHorizontal;
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          copy(row * width + col, flipX ? width - 1 - col : col, flipY ? height - 1 - row : row);
        }
      }
      return { data: out, width, height };
    }
    case SpritePackingRotation.Rotate90:
      // Output (col, row), `height` wide and `width` high, is input (width - 1 - row, col).
      for (let row = 0; row < width; row++) {
        for (let col = 0; col < height; col++) copy(row * height + col, width - 1 - row, col);
      }
      return { data: out, width: height, height: width };
    default:
      throw new UnsupportedError(
        "sprite packing rotation",
        rotation,
        "SpritePackingRotation defines 0 to 4",
      );
  }
}

/** Reverse the rows, into a new image: bottom first to top first. */
function flipRows({ data, width, height }: RgbaImage): RgbaImage {
  const out = new Uint8Array(data.length);
  const stride = width * 4;
  for (let row = 0; row < height; row++) {
    out.set(data.subarray(row * stride, row * stride + stride), (height - 1 - row) * stride);
  }
  return { data: out, width, height };
}

// --- the tight mesh mask ------------------------------------------------------------

type Point = readonly [x: number, y: number];

/**
 * 1 for each pixel of a `width x height` image (rows bottom first) inside the
 * sprite's mesh, 0 outside: upstream's mask. Its triangles are moved from
 * units to the image's pixels by `m_PixelsToUnits`, the pivot and
 * `textureRectOffset`, and filled one by one.
 *
 * Upstream sizes the mask like the cut rectangle and draws it over the
 * unrotated image; for a `Rotate90` sprite that is not square the two sizes
 * differ, and the mask here is the image's size.
 */
function meshMask(
  sprite: Sprite,
  rect: SpriteRect,
  version: UnityVersion,
  width: number,
  height: number,
): Uint8Array {
  const scale = sprite.m_PixelsToUnits;
  // Upstream's default pivot, for files before 5.4.1p3 that have none.
  const pivot = sprite.m_Pivot ?? { x: 0.5, y: 0.5 };
  const dx = f32(f32(sprite.m_Rect.width * pivot.x) - rect.textureRectOffset.x);
  const dy = f32(f32(sprite.m_Rect.height * pivot.y) - rect.textureRectOffset.y);
  const mask = new Uint8Array(width * height);
  for (const triangle of meshTriangles(sprite, version)) {
    const moved = triangle.map(
      ([x, y]): Point => [f32(f32(x * scale) + dx), f32(f32(y * scale) + dy)],
    );
    fillTriangle(mask, width, height, moved);
  }
  return mask;
}

/**
 * Upstream `GetTriangles`: the sprite mesh's triangles, as x and y in units.
 * Before 5.6 from `vertices` and `indices`; from 5.6 from each sub-mesh of
 * `m_VertexData` and `m_IndexBuffer` (`UInt16`, little-endian, as upstream
 * reads it), whatever the sub-mesh's topology.
 *
 * @throws {UnsupportedError} for positions that are not 32-bit floats, or a
 *   vertex format upstream does not know
 * @throws {CorruptError} for an index past its vertices, or a read past the
 *   vertex or index data
 */
function meshTriangles(sprite: Sprite, version: UnityVersion): Point[][] {
  const rd = sprite.m_RD;
  const triangles: Point[][] = [];
  if (rd.vertices && rd.indices) {
    const { vertices, indices } = rd;
    for (let i = 0; i + 2 < indices.length; i += 3) {
      triangles.push(
        [indices[i]!, indices[i + 1]!, indices[i + 2]!].map((index): Point => {
          const vertex = vertices[index];
          if (!vertex) throw new CorruptError(`sprite mesh index ${index} is past its vertices`);
          return [vertex.pos.x, vertex.pos.y];
        }),
      );
    }
    return triangles;
  }

  const vd = rd.m_VertexData;
  const channel = vd?.m_Channels[0];
  if (!vd || !channel || !rd.m_SubMeshes || !rd.m_IndexBuffer) {
    throw new CorruptError("sprite has no mesh: m_RD has neither vertices nor m_VertexData");
  }
  if (channel.format !== 0) {
    throw new UnsupportedError(
      "sprite vertex format",
      channel.format,
      "upstream reads sprite positions as 32-bit floats only",
    );
  }
  const stream = streamLayout(vd.m_Channels, vd.m_VertexCount, version)[channel.stream]!;
  const vertexData = view(vd.m_DataSize);
  const indexData = view(rd.m_IndexBuffer);
  for (const subMesh of rd.m_SubMeshes) {
    const vertices: Point[] = [];
    for (let v = 0; v < subMesh.vertexCount; v++) {
      const at = stream.offset + (subMesh.firstVertex + v) * stream.stride + channel.offset;
      // Upstream reads three floats per vertex and keeps x and y.
      if (at + 12 > vertexData.byteLength) {
        throw new CorruptError(
          `sprite vertex ${subMesh.firstVertex + v} at byte ${at} runs past the ` +
            `${vertexData.byteLength} bytes of m_DataSize`,
        );
      }
      vertices.push([vertexData.getFloat32(at, true), vertexData.getFloat32(at + 4, true)]);
    }
    const count = Math.floor(subMesh.indexCount / 3);
    if (subMesh.firstByte + count * 6 > indexData.byteLength) {
      throw new CorruptError(
        `sprite sub-mesh indices ${subMesh.firstByte}+${count * 6} run past the ` +
          `${indexData.byteLength} bytes of m_IndexBuffer`,
      );
    }
    for (let t = 0; t < count; t++) {
      const triangle: Point[] = [];
      for (let k = 0; k < 3; k++) {
        const index = indexData.getUint16(subMesh.firstByte + (t * 3 + k) * 2, true);
        const vertex = vertices[index - subMesh.firstVertex];
        if (!vertex) {
          throw new CorruptError(
            `sprite mesh index ${index} is outside its sub-mesh's vertices ` +
              `${subMesh.firstVertex}..${subMesh.firstVertex + subMesh.vertexCount - 1}`,
          );
        }
        triangle.push(vertex);
      }
      triangles.push(triangle);
    }
  }
  return triangles;
}

/** A `DataView` over exactly `bytes`. */
function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Upstream `VertexData.GetStreams` (5.0+): each stream's offset and vertex
 * size, from the channels in it, streams padded to 16 bytes.
 */
function streamLayout(
  channels: readonly { stream: number; format: number; dimension: number }[],
  vertexCount: number,
  version: UnityVersion,
): { offset: number; stride: number }[] {
  const count = Math.max(...channels.map((c) => c.stream)) + 1;
  const streams: { offset: number; stride: number }[] = [];
  let offset = 0;
  for (let s = 0; s < count; s++) {
    let stride = 0;
    for (const channel of channels) {
      // Upstream `ChannelInfo` keeps the low 4 bits of `dimension`.
      const dimension = channel.dimension & 0xf;
      if (channel.stream === s && dimension > 0) {
        stride += dimension * vertexFormatSize(channel.format, version);
      }
    }
    streams.push({ offset, stride });
    offset = Math.ceil((offset + vertexCount * stride) / 16) * 16;
  }
  return streams;
}

/**
 * Bytes per component of a vertex format (upstream `MeshHelper.ToVertexFormat`
 * and `GetFormatSize`): Unity numbered the formats differently before 2017,
 * and again before 2019.
 *
 * @throws {UnsupportedError} for a number the version's numbering does not have
 */
function vertexFormatSize(format: number, [major]: UnityVersion): number {
  const sizes =
    major < 2017
      ? [4, 2, 1, 1, 4] // Float, Float16, Color, Byte, UInt32
      : major < 2019
        ? [4, 2, 1, 1, 1, 2, 2, 1, 1, 2, 2, 4, 4] // Float .. SInt32, Color at 2
        : [4, 2, 1, 1, 2, 2, 1, 1, 2, 2, 4, 4]; // Float, Float16, UNorm8 .. SInt32
  const size = sizes[format];
  if (size === undefined) {
    throw new UnsupportedError(
      "sprite vertex format",
      format,
      `not a vertex format of Unity ${major}`,
    );
  }
  return size;
}

// --- the triangle fill: derived from ImageSharp.Drawing (Apache-2.0) -----------------
//
// Everything from here to the end of this file is derived from ImageSharp.Drawing
// v1.0.0-beta15 (https://github.com/SixLabors/ImageSharp.Drawing, tag
// v1.0.0-beta15), Copyright (c) Six Labors, licensed under the Apache License,
// Version 2.0 (see LICENSE-APACHE in this package). It is a modified TypeScript
// translation of parts of these files of that tag:
//   src/ImageSharp.Drawing/Shapes/Rasterization/ScanEdge.cs (`line`)
//   src/ImageSharp.Drawing/Shapes/Rasterization/ScanEdgeCollection.Build.cs
//     (`scanEdges`: EdgeCategory, ApplyVertexCategory; `snap`: RoundY)
//   src/ImageSharp.Drawing/Shapes/Rasterization/RasterizerExtensions.cs
//     (`addSpan`: ScanCurrentSubpixelLineInto)
//   src/ImageSharp.Drawing/Shapes/Rasterization/PolygonScanner.cs and
//     ActiveEdgeList.cs (ScanOddEven), and
//     Processing/Processors/Drawing/FillPathProcessor{TPixel}.cs (`fillTriangle`)
//   src/ImageSharp.Drawing/Shapes/InternalPath.cs (Simplify: `near`, `collinear`)
//   src/ImageSharp.Drawing/Shapes/Helpers/TopologyUtilities.cs (EnsureOrientation)
// Changes: translated from C# to TypeScript; cut down to filling one closed
// triangle into a 0/1 mask, without antialiasing, with the odd-even rule; the
// memory pools, sort helpers and spans are replaced by plain arrays. It is kept
// derived on purpose: upstream AssetStudio fills sprite meshes with this exact
// version, and the mask has to match its output to the pixel.

/**
 * Fill one triangle into `mask` (rows bottom first) as ImageSharp.Drawing
 * 1.0.0-beta15's `FillPathProcessor` fills a polygon without antialiasing,
 * which is what upstream's mask uses, so the mask agrees with upstream's to
 * the pixel (#34). Derived from its code (see above), in 32-bit floats as it
 * computes:
 *
 * - A triangle whose last corner is within 0.2 px of its first (on both axes),
 *   or whose corners are collinear (cross product within 0.003), is dropped.
 * - The corners' y is snapped to the nearest eighth (half away from zero), x
 *   is kept.
 * - Each pixel row is sampled on eight lines, at its y plus 0/8 to 7/8. On a
 *   line through the triangle, the span between its two edges adds, to each
 *   pixel it crosses, the part of the pixel's width it covers, divided by
 *   eight; the pixels at its two ends each add their own part, even when both
 *   ends are in one pixel (then that pixel adds `(1 + span) / 8`). A line
 *   through a lone top or bottom corner is a span of width 0.
 * - A pixel is filled when the sum reaches 0.5. Only the pixels of the
 *   triangle's bounding box, widened to whole pixels, are sampled.
 */
function fillTriangle(mask: Uint8Array, width: number, height: number, corners: Point[]): void {
  let [a, b, c] = corners as [Point, Point, Point];
  if (near(a, c) || collinear(a, b, c) || collinear(b, c, a)) return;
  // Clockwise in y-down terms (a positive shoelace sum), as ImageSharp orders a lone ring.
  let sum = 0;
  for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
    sum = f32(sum + f32(f32(p[0] * q[1]) - f32(q[0] * p[1])));
  }
  if (sum < 0) [b, c] = [c, b];

  const ring = [a, b, c].map(([x, y]): Point => [x, snap(y)]);
  const edges = scanEdges(ring);

  const xs = [a[0], b[0], c[0]];
  const ys = [a[1], b[1], c[1]];
  const left = Math.max(Math.floor(Math.min(...xs)), 0);
  const right = Math.min(Math.ceil(Math.max(...xs)), width);
  const bottom = Math.max(Math.floor(Math.min(...ys)), 0);
  const top = Math.min(Math.ceil(Math.max(...ys)), height);
  const span = right - left;
  if (span <= 0 || edges.length === 0) return;

  const coverage = new Float32Array(span);
  for (let row = bottom; row < top; row++) {
    coverage.fill(0);
    for (let sub = 0; sub < 8; sub++) {
      const y = row + sub / 8;
      const hits: number[] = [];
      for (const edge of edges) {
        if (y < edge.y0 || y > edge.y1) continue;
        const x = f32(f32(edge.p * y) + edge.q);
        const times = y === edge.y0 ? edge.emit0 : y === edge.y1 ? edge.emit1 : 1;
        for (let t = 0; t < times; t++) hits.push(x);
      }
      hits.sort((m, n) => m - n);
      for (let h = 0; h + 1 < hits.length; h += 2) {
        addSpan(coverage, hits[h]! - left, hits[h + 1]! - left);
      }
    }
    for (let i = 0; i < span; i++) if (coverage[i]! >= 0.5) mask[row * width + left + i] = 1;
  }
}

/**
 * One sample line over `[start, end]`, relative to the box's left edge, into
 * `coverage`: an eighth of the part of each pixel it covers.
 */
function addSpan(coverage: Float32Array, spanStart: number, spanEnd: number): void {
  const start = f32(spanStart);
  const end = f32(spanEnd);
  const startX = Math.floor(start);
  const endX = Math.floor(end);
  if (startX >= 0 && startX < coverage.length) {
    coverage[startX] = f32(coverage[startX]! + f32(startX + 1 - start) / 8);
  }
  if (endX >= 0 && endX < coverage.length) {
    coverage[endX] = f32(coverage[endX]! + f32(end - endX) / 8);
  }
  for (let x = Math.max(startX + 1, 0); x < Math.min(endX, coverage.length); x++) {
    coverage[x] = f32(coverage[x]! + 0.125);
  }
}

/** A non-horizontal edge, top (`y0`) to bottom, with `x = p * y + q`. */
interface ScanEdge {
  y0: number;
  y1: number;
  p: number;
  q: number;
  /** How many times the sample line through `y0` / `y1` counts this edge. */
  emit0: number;
  emit1: number;
}

/**
 * The triangle's non-horizontal edges, top to bottom, each with how often a
 * sample line through one of its ends counts it: twice where it meets a
 * horizontal edge on the outside of a corner, once or not at all otherwise,
 * so a line through a corner gives the triangle's two sides exactly.
 */
function scanEdges(ring: Point[]): ScanEdge[] {
  const n = ring.length;
  // 0 up, 1 down, 2 left, 3 right: the direction of edge i, ring[i] -> ring[i + 1].
  const kind = ring.map(([x, y], i) => {
    const [nx, ny] = ring[(i + 1) % n]!;
    if (y === ny) return x < nx ? 3 : 2;
    return y < ny ? 1 : 0;
  });
  // [emit at the end of the incoming edge, at the start of the outgoing one], by kinds.
  const EMITS = [
    [[0, 1], [1, 1], [2, 0], [1, 0]],
    [[1, 1], [0, 1], [1, 0], [2, 0]],
    [[0, 1], [0, 2], [0, 0], [0, 0]],
    [[0, 2], [0, 1], [0, 0], [0, 0]],
  ];
  const start = new Array<number>(n).fill(0);
  const end = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const before = (i + n - 1) % n;
    const [emitEnd, emitStart] = EMITS[kind[before]!]![kind[i]!]!;
    end[before] = emitEnd!;
    start[i] = emitStart!;
  }
  const edges: ScanEdge[] = [];
  for (let i = 0; i < n; i++) {
    if (kind[i]! >= 2) continue;
    let from = ring[i]!;
    let to = ring[(i + 1) % n]!;
    let emit0 = start[i]!;
    let emit1 = end[i]!;
    if (kind[i] === 0) [from, to, emit0, emit1] = [to, from, emit1, emit0];
    edges.push({ ...line(from, to), y0: from[1], y1: to[1], emit0, emit1 });
  }
  return edges;
}

/** `x = p * y + q` through two points, centred first as ImageSharp does for accuracy. */
function line([x0, y0]: Point, [x1, y1]: Point): { p: number; q: number } {
  const dy = f32(y1 - y0);
  const cx = f32(f32(x0 + x1) * 0.5);
  const cy = f32(f32(y0 + y1) * 0.5);
  const [ax, ay, bx, by] = [f32(x0 - cx), f32(y0 - cy), f32(x1 - cx), f32(y1 - cy)];
  const p = f32(f32(bx - ax) / dy);
  const q = f32(f32(f32(ax * by) - f32(bx * ay)) / dy);
  return { p, q: f32(q + f32(cx - f32(p * cy))) };
}

/** `y` to the nearest eighth, halves away from zero. */
function snap(y: number): number {
  const scaled = f32(y * 8);
  return (Math.sign(scaled) * Math.round(Math.abs(scaled))) / 8;
}

/** Whether two points are within 0.2 of each other on both axes. */
function near([ax, ay]: Point, [bx, by]: Point): boolean {
  const limit = f32(0.2);
  return Math.abs(f32(ax - bx)) < limit && Math.abs(f32(ay - by)) < limit;
}

/** Whether `q` is on the line `p`-`r`, within ImageSharp's 0.003 cross-product tolerance. */
function collinear([px, py]: Point, [qx, qy]: Point, [rx, ry]: Point): boolean {
  const cross = f32(f32(f32(qy - py) * f32(rx - qx)) - f32(f32(qx - px) * f32(ry - qy)));
  const limit = f32(0.003);
  return cross > -limit && cross < limit;
}
