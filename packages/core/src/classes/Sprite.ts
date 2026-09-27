// Ported from AssetStudio/Classes/Sprite.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Classes/Mesh.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError, UnsupportedError } from "../errors.js";
import { BuildTarget } from "../serialized/BuildTarget.js";
import { SerializedFileFormatVersion as V } from "../serialized/FormatVersion.js";
import type { ObjectReader, Quaternion, Vector3 } from "../serialized/ObjectReader.js";
import type { UnityVersion } from "../serialized/SerializedFile.js";
import { readCount } from "../serialized/TypeTree.js";
import type { Rectf } from "./Font.js";
import type { Vector2 } from "./Material.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
import { readPPtr, type PPtr } from "./PPtr.js";
import { readStringField } from "./strings.js";
import { atLeast } from "./version.js";

/** Four floats (Unity's `Vector4f`). */
export interface Vector4 {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * A GUID in the shape `readTypeTree()` gives it: four `UInt32` words, keyed
 * `"data[0]"` to `"data[3]"` in that order.
 */
export type GUID = { [word: `data[${number}]`]: number };

/** A 4x4 matrix (Unity's `Matrix4x4f`), keyed `e00` to `e33`, row by row. */
export type Matrix4x4 = { [element in `e${0 | 1 | 2 | 3}${0 | 1 | 2 | 3}`]: number };

/** One texture a sprite adds to its main one (Unity's `SecondarySpriteTexture`). */
export interface SecondarySpriteTexture {
  texture: PPtr;
  /** The shader property it binds to, such as `"_NormalMap"`. */
  name: string;
}

/** A vertex of a sprite mesh before Unity 5.6 (Unity's `SpriteVertex`). */
export interface SpriteVertex {
  pos: Vector3;
  /** Unity 4.3 only. */
  uv?: Vector2;
}

/** A bounding box (Unity's `AABB`): its centre and half its size. */
export interface AABB {
  m_Center: Vector3;
  m_Extent: Vector3;
}

/** A run of a mesh's index buffer (Unity's `SubMesh`). */
export interface SubMesh {
  /** Byte offset of its first index in the index buffer. */
  firstByte: number;
  indexCount: number;
  /** Unity's `GfxPrimitiveType`: 0 is triangles. */
  topology: number;
  /** Unity 2017.3 and later. */
  baseVertex?: number;
  firstVertex: number;
  vertexCount: number;
  localAABB: AABB;
}

/** Where a vertex attribute sits in the vertex data (Unity's `ChannelInfo`). */
export interface ChannelInfo {
  stream: number;
  /** Byte offset in its stream's vertex. */
  offset: number;
  /** Unity's vertex format, numbered by Unity version (see upstream `MeshHelper`). */
  format: number;
  /**
   * Components per vertex in the low 4 bits, as the file holds it; upstream
   * masks the byte with `0xF`.
   */
  dimension: number;
}

/** The vertices of a mesh (Unity's `VertexData`), Unity 5.6 and later in a sprite. */
export interface VertexData {
  /** Before Unity 2018.1. */
  m_CurrentChannels?: number;
  m_VertexCount: number;
  m_Channels: ChannelInfo[];
  /** Every stream, one after the other: a view into the object's bytes (R7). */
  m_DataSize: Uint8Array;
}

/** Four bone weights of a vertex (Unity's `BoneWeights4`), Unity 2018.1 only here. */
export interface BoneWeights4 {
  "weight[0]": number;
  "weight[1]": number;
  "weight[2]": number;
  "weight[3]": number;
  "boneIndex[0]": number;
  "boneIndex[1]": number;
  "boneIndex[2]": number;
  "boneIndex[3]": number;
}

/** One blend shape vertex (Unity's `BlendShapeVertex`). */
export interface BlendShapeVertex {
  vertex: Vector3;
  normal: Vector3;
  tangent: Vector3;
  index: number;
}

/** One blend shape (Unity's `MeshBlendShape`). */
export interface MeshBlendShape {
  firstVertex: number;
  vertexCount: number;
  hasNormals: boolean;
  hasTangents: boolean;
}

/** One blend shape channel (Unity's `MeshBlendShapeChannel`). */
export interface MeshBlendShapeChannel {
  name: string;
  nameHash: number;
  frameIndex: number;
  frameCount: number;
}

/** The blend shapes of a mesh (Unity's `BlendShapeData`), Unity 6000.5 and later here. */
export interface BlendShapeData {
  vertices: BlendShapeVertex[];
  shapes: MeshBlendShape[];
  channels: MeshBlendShapeChannel[];
  fullWeights: number[];
}

/**
 * The mesh and the texture area a sprite is drawn with (Unity's
 * `SpriteRenderData`). A sprite packed into a `SpriteAtlas` has its texture
 * area in the atlas' `m_RenderDataMap` instead; here its `texture` is then a
 * null pointer.
 */
export interface SpriteRenderData {
  texture: PPtr;
  /** Unity 5.2 and later: the alpha of a texture whose format has none (ETC1 split alpha). */
  alphaTexture?: PPtr;
  /** Unity 2019.1 and later. */
  secondaryTextures?: SecondarySpriteTexture[];
  /** Unity 5.6 and later. */
  m_SubMeshes?: SubMesh[];
  /** Unity 5.6 and later: `UInt16` indices, a view into the object's bytes (R7). */
  m_IndexBuffer?: Uint8Array;
  /** Unity 5.6 and later. */
  m_VertexData?: VertexData;
  /** Before Unity 5.6. */
  vertices?: SpriteVertex[];
  /** Before Unity 5.6. */
  indices?: number[];
  /** Unity 2018.1 and later. */
  m_Bindpose?: Matrix4x4[];
  /** Unity 2018.1 only. */
  m_SourceSkin?: BoneWeights4[];
  /** Unity 6000.5 and later. */
  m_BlendShapes?: BlendShapeData;
  /** The sprite's area in `texture`, in pixels from its bottom-left corner. */
  textureRect: Rectf;
  /** Where `textureRect` starts inside the sprite's `m_Rect` (its trimmed margin). */
  textureRectOffset: Vector2;
  /** Unity 5.4.6 to 5.4.x, 5.5.3 to 5.5.x, and 5.6 and later. */
  atlasRectOffset?: Vector2;
  /**
   * Packing flags: bit 0 packed, bit 1 packing mode (0 tight, 1 rectangle),
   * bits 2-5 packing rotation (see {@link SpritePackingRotation}), bit 6 mesh
   * type (0 full rect, 1 tight).
   */
  settingsRaw: number;
  /** Unity 4.5 and later. */
  uvTransform?: Vector4;
  /** Unity 2017.1 and later. */
  downscaleMultiplier?: number;
}

/** A bone of a sprite skeleton (Unity's `SpriteBone`), Unity 2018.1 and later. */
export interface SpriteBone {
  name: string;
  /** Unity 2021.1 and later. */
  guid?: string;
  position: Vector3;
  rotation: Quaternion;
  length: number;
  parentId: number;
  /** Unity 2021.1 and later: an `RGBA32` packed into a `UInt32`. */
  color?: { rgba: number };
}

/**
 * The fields of a `Sprite`, as a player build stores them, under Unity's
 * names: the keys, their order and their values agree with `readTypeTree()`
 * on the same object, pairs as `[first, second]` arrays as it gives them.
 */
export interface Sprite extends NamedObject {
  /** The sprite's area in its source texture, in pixels from the bottom-left corner. */
  m_Rect: Rectf;
  m_Offset: Vector2;
  /** Unity 4.5 and later: the 9-slice border, left, bottom, right, top. */
  m_Border?: Vector4;
  m_PixelsToUnits: number;
  /** Unity 5.4.1p3 and later; the centre (0.5, 0.5) before. */
  m_Pivot?: Vector2;
  m_Extrude: number;
  /** Unity 5.3 to 6000.4. */
  m_IsPolygon?: boolean;
  /**
   * Unity 2017.1 and later: the key of the sprite's render data in its
   * atlas' `m_RenderDataMap`.
   */
  m_RenderDataKey?: [GUID, bigint];
  /** Unity 2017.1 and later. */
  m_AtlasTags?: string[];
  /** Unity 2017.1 and later: a null pointer when the sprite is not packed into one. */
  m_SpriteAtlas?: PPtr;
  m_RD: SpriteRenderData;
  /** Unity 2017.1 and later: one outline per shape, in units. */
  m_PhysicsShape?: Vector2[][];
  /** Unity 2018.1 and later. */
  m_Bones?: SpriteBone[];
  /** Unity 2023.1 and later. */
  m_ScriptableObjects?: PPtr[];
}

/**
 * How a packer turned a sprite to fit it into an atlas (Unity's
 * `SpritePackingRotation`, bits 2-5 of `settingsRaw`).
 */
export const SpritePackingRotation = {
  None: 0,
  FlipHorizontal: 1,
  FlipVertical: 2,
  Rotate180: 3,
  Rotate90: 4,
} as const;

/**
 * Read a `Sprite` from the object's first byte: every field Unity's own player
 * type trees give for its version (as UnityPy's TPK data records them), in
 * their order. Upstream stops after `m_PhysicsShape`; the rest (`m_Bones`,
 * `m_ScriptableObjects`) is read here so the object is consumed to its last
 * byte, and the object must end exactly there, so a layout this reader does
 * not know is refused rather than returned half-read.
 *
 * Where TPK and upstream disagree, TPK is followed: `atlasRectOffset` from
 * 5.4.6 and 5.5.3 (upstream: 5.6), `m_IsPolygon` gone in 6000.5, and a
 * `SecondarySpriteTexture.name` that is an aligned string (upstream reads a
 * C string). `m_Pivot` keeps upstream's 5.4.1p3
 * gate, which TPK (no 5.4.1 patch releases) cannot contradict, and
 * `SpriteVertex.pos` upstream's `readVector3`, which reads four floats before
 * 5.4 where TPK has three: no fixture predates 2019.4, and the end-of-object
 * check refuses a wrong guess.
 *
 * ponytail: `SpriteVertex.pos` before 5.4 is read as four floats, as #34's
 * acceptance and upstream require (maintainer decision on PR #156), though
 * TPK records three. If TPK is right, every 4.3 to 5.3 sprite with vertices
 * fails the end-of-object check (a CorruptError) rather than being read. A
 * 5.x fixture settles it (#155).
 *
 * A file whose Unity version is unknown (`[0, 0, 0, 0]`, as
 * `AssetBundleStripUnityVersion` leaves it) is read when its format is 18 to
 * 21: only Unity 2019 writes those, and every 2019 release has one Sprite
 * layout (rule for version-stripped files, #36, as amended; as `readMaterial`
 * does). That layout is assumed, not known, so an object that does not fit it
 * is refused as not that layout rather than called corrupt. Any other format
 * allows layouts that differ inside the object, which the bytes cannot tell
 * apart, so the file is refused.
 *
 * ponytail: the gates compare release numbers only (see `atLeast`), except
 * the two patch-release gates, as upstream's do. Unity changed this layout in
 * pre-releases: 5.6.0b1 to b9 lack `atlasRectOffset`, 2019.1.0a1 to a9 (format
 * 18) lack `secondaryTextures`, and 6000.5.0a3 to a6 lack `m_BlendShapes`; such
 * a pre-release fails the end-of-object check. Compare the build type in the
 * gate if one ever matters.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`: when the version is unknown (`[0, 0, 0, 0]`:
 *   stripped, or a loose file below format 7) unless the format is 18 to 21,
 *   and in those formats when the fields after `m_Name` do not fit 2019's
 *   layout; or older than 4.3, which had no sprites. Of kind `"build target"`
 *   for an editor file (`BuildTarget.NoTarget`), which stores editor-only
 *   fields in between
 * @throws {CorruptError} when the object ends early, a count or string length
 *   is negative or runs past its end, or bytes are left over after the last
 *   field, with the version known; with it unknown, only inside `m_Name`
 */
export function readSprite(reader: ObjectReader): Sprite {
  const version = layoutVersion(reader, "Sprite", 4, 3);
  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<Sprite> & NamedObject = readNamedObject(reader);
  assumingLayout(reader, "Sprite", () => readSpriteFields(reader, version, out));
  // Every required field was set above.
  return out as Sprite;
}

/** Every field of a `Sprite` after `m_Name`, and the end-of-object check. */
function readSpriteFields(
  reader: ObjectReader,
  version: UnityVersion,
  out: Partial<Sprite>,
): void {
  out.m_Rect = readRectf(reader);
  out.m_Offset = readVector2(reader);
  if (atLeast(version, 4, 5)) out.m_Border = readVector4(reader);
  out.m_PixelsToUnits = reader.readFloat32();
  // 5.4.1p3+ (upstream `Sprite.cs:222`).
  if (atLeast(version, 5, 4, 2) || isPatchFrom(reader, 5, 4, 1, 3)) {
    out.m_Pivot = readVector2(reader);
  }
  out.m_Extrude = reader.readUInt32();
  // 5.3 to 6000.4; 6000.5 dropped it and aligns after m_Extrude instead.
  if (atLeast(version, 5, 3) && !atLeast(version, 6000, 5)) {
    out.m_IsPolygon = readBool(reader);
  }
  reader.align();
  if (atLeast(version, 2017, 1)) {
    out.m_RenderDataKey = [readGUID(reader), reader.readInt64()];
    out.m_AtlasTags = readArray(reader, "Sprite", "m_AtlasTags", (r) =>
      readStringField(r, "Sprite", "m_AtlasTags tag"),
    );
    out.m_SpriteAtlas = readPPtr(reader);
  }
  out.m_RD = readSpriteRenderData(reader, version);
  reader.align();
  if (atLeast(version, 2017, 1)) {
    out.m_PhysicsShape = readArray(reader, "Sprite", "m_PhysicsShape", (r) =>
      readArray(r, "Sprite", "m_PhysicsShape outline", readVector2),
    );
  }
  if (atLeast(version, 2018, 1)) {
    out.m_Bones = readArray(reader, "Sprite", "m_Bones", (r) => readBone(r, version));
  }
  if (atLeast(version, 2023, 1)) {
    out.m_ScriptableObjects = readArray(reader, "Sprite", "m_ScriptableObjects", readPPtr);
  }
  endOfObject(reader, "Sprite");
}

/** Upstream `SpriteRenderData(ObjectReader)`, with the fields TPK adds. */
function readSpriteRenderData(reader: ObjectReader, version: UnityVersion): SpriteRenderData {
  const out: Partial<SpriteRenderData> = { texture: readPPtr(reader) };
  if (atLeast(version, 5, 2)) out.alphaTexture = readPPtr(reader);
  if (atLeast(version, 2019, 1)) out.secondaryTextures = readSecondaryTextures(reader, "Sprite");
  if (atLeast(version, 5, 6)) {
    out.m_SubMeshes = readArray(reader, "Sprite", "m_SubMeshes", (r) => readSubMesh(r, version));
    const indexBytes = readCount(reader, `Sprite ${reader.pathId} m_IndexBuffer byte`);
    out.m_IndexBuffer = reader.readBytes(indexBytes);
    reader.align();
    out.m_VertexData = readVertexData(reader, version);
  } else {
    out.vertices = readArray(reader, "Sprite", "vertices", (r) => readSpriteVertex(r, version));
    out.indices = readArray(reader, "Sprite", "indices", (r) => r.readUInt16());
    reader.align();
  }
  if (atLeast(version, 2018, 1)) {
    out.m_Bindpose = readArray(reader, "Sprite", "m_Bindpose", readMatrix);
    // 2018.1 only.
    if (!atLeast(version, 2018, 2)) {
      out.m_SourceSkin = readArray(reader, "Sprite", "m_SourceSkin", readBoneWeights);
    }
  }
  if (atLeast(version, 6000, 5)) out.m_BlendShapes = readBlendShapeData(reader, version);
  out.textureRect = readRectf(reader);
  out.textureRectOffset = readVector2(reader);
  // 5.4.6+, 5.5.3+ and 5.6+ (TPK; upstream reads it from 5.6 only).
  const [major, minor, patch] = version;
  if (
    atLeast(version, 5, 6) ||
    (major === 5 && minor === 5 && patch >= 3) ||
    (major === 5 && minor === 4 && patch >= 6)
  ) {
    out.atlasRectOffset = readVector2(reader);
  }
  out.settingsRaw = reader.readUInt32();
  if (atLeast(version, 4, 5)) out.uvTransform = readVector4(reader);
  if (atLeast(version, 2017, 1)) out.downscaleMultiplier = reader.readFloat32();
  return out as SpriteRenderData;
}

/** Upstream `SpriteVertex(ObjectReader)`: the position is a Vector3 as `readVector3` reads it. */
function readSpriteVertex(reader: ObjectReader, version: UnityVersion): SpriteVertex {
  // Upstream `Sprite.cs:70`: four floats before 5.4 (see readSprite's ponytail).
  const pos = reader.readVector3();
  // 4.3 and down.
  return atLeast(version, 4, 5) ? { pos } : { pos, uv: readVector2(reader) };
}

/** Upstream `SubMesh(ObjectReader)`, for the versions a sprite has one (5.6+). */
function readSubMesh(reader: ObjectReader, version: UnityVersion): SubMesh {
  const out: Partial<SubMesh> = {
    firstByte: reader.readUInt32(),
    indexCount: reader.readUInt32(),
    topology: reader.readInt32(),
  };
  // 2017.3+.
  if (atLeast(version, 2017, 3)) out.baseVertex = reader.readUInt32();
  out.firstVertex = reader.readUInt32();
  out.vertexCount = reader.readUInt32();
  out.localAABB = { m_Center: vector3(reader, version), m_Extent: vector3(reader, version) };
  return out as SubMesh;
}

/** Upstream `VertexData(ObjectReader)`, for the versions a sprite has one (5.6+). */
function readVertexData(reader: ObjectReader, version: UnityVersion): VertexData {
  const out: Partial<VertexData> = {};
  // Before 2018.1 (TPK: gone in 2018.1.0b2; upstream: before 2018).
  if (!atLeast(version, 2018, 1)) out.m_CurrentChannels = reader.readInt32();
  out.m_VertexCount = reader.readUInt32();
  out.m_Channels = readArray(reader, "Sprite", "m_Channels", (r) => ({
    stream: r.readUInt8(),
    offset: r.readUInt8(),
    format: r.readUInt8(),
    dimension: r.readUInt8(),
  }));
  out.m_DataSize = reader.readBytes(readCount(reader, `Sprite ${reader.pathId} m_DataSize byte`));
  reader.align();
  return out as VertexData;
}

/** A `Matrix4x4f`, `e00` to `e33`. */
function readMatrix(reader: ObjectReader): Matrix4x4 {
  const out: Partial<Matrix4x4> = {};
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      out[`e${row}${column}` as keyof Matrix4x4] = reader.readFloat32();
    }
  }
  return out as Matrix4x4;
}

/** Upstream `BoneWeights4(ObjectReader)`. */
function readBoneWeights(reader: ObjectReader): BoneWeights4 {
  return {
    "weight[0]": reader.readFloat32(),
    "weight[1]": reader.readFloat32(),
    "weight[2]": reader.readFloat32(),
    "weight[3]": reader.readFloat32(),
    "boneIndex[0]": reader.readInt32(),
    "boneIndex[1]": reader.readInt32(),
    "boneIndex[2]": reader.readInt32(),
    "boneIndex[3]": reader.readInt32(),
  };
}

/** Upstream `BlendShapeData(ObjectReader)`, as Unity 6000.5 writes it into a sprite. */
function readBlendShapeData(reader: ObjectReader, version: UnityVersion): BlendShapeData {
  const out: BlendShapeData = {
    vertices: readArray(reader, "Sprite", "m_BlendShapes vertices", (r) => ({
      vertex: vector3(r, version),
      normal: vector3(r, version),
      tangent: vector3(r, version),
      index: r.readUInt32(),
    })),
    shapes: readArray(reader, "Sprite", "m_BlendShapes shapes", (r) => {
      const shape = {
        firstVertex: r.readUInt32(),
        vertexCount: r.readUInt32(),
        hasNormals: readBool(r),
        hasTangents: readBool(r),
      };
      r.align();
      return shape;
    }),
    channels: readArray(reader, "Sprite", "m_BlendShapes channels", (r) => ({
      name: readStringField(r, "Sprite", "m_BlendShapes channel name"),
      nameHash: r.readUInt32(),
      frameIndex: r.readInt32(),
      frameCount: r.readInt32(),
    })),
    fullWeights: readArray(reader, "Sprite", "m_BlendShapes fullWeights", (r) => r.readFloat32()),
  };
  reader.align();
  return out;
}

/** A `SpriteBone`: 2021.1 added `guid` after the name and `color` at the end. */
function readBone(reader: ObjectReader, version: UnityVersion): SpriteBone {
  const v2021 = atLeast(version, 2021, 1);
  const out: Partial<SpriteBone> = { name: readStringField(reader, "Sprite", "m_Bones name") };
  if (v2021) out.guid = readStringField(reader, "Sprite", "m_Bones guid");
  out.position = vector3(reader, version);
  out.rotation = {
    x: reader.readFloat32(),
    y: reader.readFloat32(),
    z: reader.readFloat32(),
    w: reader.readFloat32(),
  };
  out.length = reader.readFloat32();
  out.parentId = reader.readInt32();
  if (v2021) out.color = { rgba: reader.readUInt32() };
  return out as SpriteBone;
}

/**
 * A `vector<SecondarySpriteTexture>`: a pointer and an aligned name each.
 * Internal: shared with `SpriteAtlas.ts`.
 */
export function readSecondaryTextures(
  reader: ObjectReader,
  owner: string,
): SecondarySpriteTexture[] {
  return readArray(reader, owner, "secondaryTextures", (r) => ({
    texture: readPPtr(r),
    // Upstream reads a C string here; Unity writes an aligned string.
    name: readStringField(r, owner, "secondaryTextures name"),
  }));
}

/** A `Rectf`. Internal: shared with `SpriteAtlas.ts`. */
export function readRectf(reader: ObjectReader): Rectf {
  return {
    x: reader.readFloat32(),
    y: reader.readFloat32(),
    width: reader.readFloat32(),
    height: reader.readFloat32(),
  };
}

/** A `Vector2f`. Internal: shared with `SpriteAtlas.ts`. */
export function readVector2(reader: ObjectReader): Vector2 {
  return { x: reader.readFloat32(), y: reader.readFloat32() };
}

/** A `Vector4f`. Internal: shared with `SpriteAtlas.ts`. */
export function readVector4(reader: ObjectReader): Vector4 {
  return {
    x: reader.readFloat32(),
    y: reader.readFloat32(),
    z: reader.readFloat32(),
    w: reader.readFloat32(),
  };
}

/** A `GUID`: four `UInt32` words. Internal: shared with `SpriteAtlas.ts`. */
export function readGUID(reader: ObjectReader): GUID {
  const out: GUID = {};
  for (let i = 0; i < 4; i++) out[`data[${i}]`] = reader.readUInt32();
  return out;
}

/**
 * An `Int32` count, then that many elements. Internal: shared with
 * `SpriteAtlas.ts`.
 *
 * @throws {CorruptError} when the count is negative or larger than the bytes left
 */
export function readArray<T>(
  reader: ObjectReader,
  owner: string,
  what: string,
  element: (r: ObjectReader) => T,
): T[] {
  const count = readCount(reader, `${owner} ${reader.pathId} ${what}`);
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(element(reader));
  return out;
}

/**
 * Whether the version is `major.minor.patch` patch release `p<build>` or any
 * later release, as upstream's `IsPatch` gates put it (`5.4.1p3 and up`).
 * Internal: shared with `SpriteAtlas.ts`.
 */
export function isPatchFrom(
  reader: ObjectReader,
  major: number,
  minor: number,
  patch: number,
  build: number,
): boolean {
  const [a, b, c, d] = reader.version;
  return a === major && b === minor && c === patch && reader.buildType === "p" && d >= build;
}

/**
 * What a file of unknown version and format 18 to 21 is read as: those formats
 * are Unity 2019.1 to 2019.4 (`SerializedFileFormatVersion`), and Unity's type
 * trees give one Sprite layout from 2019.1.0a10 to 2021.1.0a2 and one
 * SpriteAtlas layout from 2017.2.0b9 to 2020.2.0a7.
 */
const UNITY_2019: UnityVersion = [2019, 4, 0, 0];

/**
 * The version whose layout the object has, after the refusals every sprite
 * class reader shares: the file's own, or 2019's for an unknown version in a
 * format only 2019 writes (rule for version-stripped files, #36, as amended;
 * the same choice as `readMaterial`'s). Internal: shared with `SpriteAtlas.ts`.
 *
 * @param major the first Unity version that has the class, with `minor`
 * @throws {UnsupportedError} of kind `"Unity version"` for an unknown version
 *   in any other format, or one before the class existed; of kind
 *   `"build target"` for an editor file
 */
export function layoutVersion(
  reader: ObjectReader,
  owner: string,
  major: number,
  minor: number,
): UnityVersion {
  let { version } = reader;
  const { format } = reader;
  if (version.every((part) => part === 0)) {
    if (format < V.RefactorShareableTypeTreeData || format > V.StoresTypeDependencies) {
      throw new UnsupportedError(
        "Unity version",
        reader.unityVersion,
        `object ${reader.pathId}: a ${owner}'s layout depends on the Unity version, which ` +
          `this format ${format} file does not record, and its bytes cannot decide it`,
      );
    }
    version = UNITY_2019;
  } else if (!atLeast(version, major, minor)) {
    throw new UnsupportedError(
      "Unity version",
      reader.unityVersion,
      `object ${reader.pathId}: Unity has no ${owner} before ${major}.${minor}`,
    );
  }
  if (reader.platform === BuildTarget.NoTarget) {
    throw new UnsupportedError(
      "build target",
      "NoTarget",
      `object ${reader.pathId}: an editor file's ${owner} holds editor-only fields`,
    );
  }
  return version;
}

/**
 * Run `read`, which reads the fields after `m_Name`. With the file's version
 * unknown the layout is only assumed (see {@link layoutVersion}), so a misfit
 * there means "not 2019's layout", which the file cannot tell apart from
 * corruption: it is refused, as `readMaterial` does. Internal: shared with
 * `SpriteAtlas.ts`.
 *
 * @throws {UnsupportedError} of kind `"Unity version"` for such a misfit
 * @throws {CorruptError} what `read` throws, with the version known
 */
export function assumingLayout(reader: ObjectReader, owner: string, read: () => void): void {
  if (!reader.version.every((part) => part === 0)) {
    read();
    return;
  }
  try {
    read();
  } catch (error) {
    if (!(error instanceof CorruptError)) throw error;
    throw new UnsupportedError(
      "Unity version",
      reader.unityVersion,
      `object ${reader.pathId}: the object does not fit 2019's ${owner} layout, the only ` +
        `one formats 18 to 21 allow (${error.message})`,
    );
  }
}

/**
 * A Vector3 as `ObjectReader.readVector3` reads it for `version`: three floats
 * from 5.4 on. The version is the file's own or, for a stripped file, 2019's,
 * which `readVector3`, going by the file's `[0, 0, 0, 0]`, would take for pre-5.4.
 */
function vector3(reader: ObjectReader, version: UnityVersion): Vector3 {
  if (version === reader.version) return reader.readVector3();
  return { x: reader.readFloat32(), y: reader.readFloat32(), z: reader.readFloat32() };
}

/**
 * The end-of-object check. Internal: shared with `SpriteAtlas.ts`.
 *
 * @throws {CorruptError} when bytes are left over after the last field
 */
export function endOfObject(reader: ObjectReader, owner: string): void {
  if (reader.remaining !== 0) {
    throw new CorruptError(
      `${owner} ${reader.pathId} ends at ${reader.position} of its ${reader.byteSize} bytes`,
    );
  }
}

/** A one-byte bool, as Unity writes it. */
function readBool(reader: ObjectReader): boolean {
  return reader.readUInt8() !== 0;
}
