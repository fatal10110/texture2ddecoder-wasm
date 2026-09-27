// Ported from AssetStudio/Classes/SpriteAtlas.cs (MIT, © Perfare / RazTools / Razviar)

import { UnsupportedError } from "../errors.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
import { readPPtr, type PPtr } from "./PPtr.js";
import {
  endOfObject,
  isPatchFrom,
  readArray,
  readGUID,
  readRectf,
  readSecondaryTextures,
  readVector2,
  readVector4,
  refuseUnreadable,
  type GUID,
  type Rectf,
  type SecondarySpriteTexture,
  type Vector2,
  type Vector4,
} from "./Sprite.js";
import { readStringField } from "./strings.js";
import { atLeast } from "./version.js";

/**
 * Where one packed sprite sits in its atlas (Unity's `SpriteAtlasData`): the
 * fields of a sprite's `m_RD` that packing changes.
 */
export interface SpriteAtlasData {
  texture: PPtr;
  alphaTexture: PPtr;
  /** The sprite's area in `texture`, in pixels from its bottom-left corner. */
  textureRect: Rectf;
  textureRectOffset: Vector2;
  /** Unity 2017.1.1p1 and later. */
  atlasRectOffset?: Vector2;
  uvTransform: Vector4;
  downscaleMultiplier: number;
  /** As a sprite's `m_RD.settingsRaw`. */
  settingsRaw: number;
  /** Unity 2020.2 and later. */
  secondaryTextures?: SecondarySpriteTexture[];
}

/**
 * The fields of a `SpriteAtlas`, as a player build stores them, under Unity's
 * names: the keys, their order and their values agree with `readTypeTree()`
 * on the same object, map entries and pairs as `[first, second]` arrays as it
 * gives them.
 */
export interface SpriteAtlas extends NamedObject {
  m_PackedSprites: PPtr[];
  /** The names of `m_PackedSprites`, in the same order. */
  m_PackedSpriteNamesToIndex: string[];
  /** A packed sprite's `m_RenderDataKey` to where it sits in the atlas. */
  m_RenderDataMap: [[GUID, bigint], SpriteAtlasData][];
  m_Tag: string;
  m_IsVariant: boolean;
  /** Unity 6000.5 and later. */
  m_Guid?: GUID;
}

/**
 * Read a `SpriteAtlas` from the object's first byte: every field Unity's own
 * player type trees give for its version (as UnityPy's TPK data records
 * them), in their order, so the object is consumed to its last byte; it must
 * end exactly there.
 *
 * Where TPK and upstream disagree, TPK's gates are taken: `atlasRectOffset`
 * from 2017.1.1p1 (upstream: 2017.2), and `m_Guid` from 6000.5, which
 * upstream does not read. 6000.6 drops `m_PackedSprites` and adds a
 * `spriteInstanceData` to every entry; that layout is only known from
 * pre-release type trees, so it is refused.
 *
 * ponytail: the gates compare release numbers only (see `atLeast`), except
 * the 2017.1 patch-release gate. 2017.2.0b2 to b8 lack `atlasRectOffset`;
 * such a pre-release fails the end-of-object check with a CorruptError.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`, when the version is unknown (`[0, 0, 0, 0]`),
 *   older than 2017.1, which had no sprite atlases, or 6000.6 and later; of
 *   kind `"build target"` for an editor file (`BuildTarget.NoTarget`), which
 *   stores the atlas' editor settings in between
 * @throws {CorruptError} when the object ends early, a count or string length
 *   is negative or runs past its end, or bytes are left over after the last
 *   field
 */
export function readSpriteAtlas(reader: ObjectReader): SpriteAtlas {
  refuseUnreadable(reader, "SpriteAtlas", 2017, 1);
  const { version } = reader;
  if (atLeast(version, 6000, 6)) {
    throw new UnsupportedError(
      "Unity version",
      reader.unityVersion,
      `object ${reader.pathId}: the SpriteAtlas layout of 6000.6 is not ported`,
    );
  }

  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<SpriteAtlas> & NamedObject = readNamedObject(reader);
  out.m_PackedSprites = readArray(reader, "SpriteAtlas", "m_PackedSprites", readPPtr);
  out.m_PackedSpriteNamesToIndex = readArray(
    reader,
    "SpriteAtlas",
    "m_PackedSpriteNamesToIndex",
    (r) => readStringField(r, "SpriteAtlas", "m_PackedSpriteNamesToIndex name"),
  );
  out.m_RenderDataMap = readArray(reader, "SpriteAtlas", "m_RenderDataMap", (r) => [
    [readGUID(r), r.readInt64()],
    readSpriteAtlasData(r),
  ]);
  out.m_Tag = readStringField(reader, "SpriteAtlas", "m_Tag");
  out.m_IsVariant = reader.readUInt8() !== 0;
  reader.align();
  if (atLeast(version, 6000, 5)) out.m_Guid = readGUID(reader);

  endOfObject(reader, "SpriteAtlas");
  // Every required field was set above.
  return out as SpriteAtlas;
}

/** Upstream `SpriteAtlasData(ObjectReader)`. */
function readSpriteAtlasData(reader: ObjectReader): SpriteAtlasData {
  const { version } = reader;
  const out: Partial<SpriteAtlasData> = {
    texture: readPPtr(reader),
    alphaTexture: readPPtr(reader),
    textureRect: readRectf(reader),
    textureRectOffset: readVector2(reader),
  };
  // 2017.1.1p1+ (TPK; upstream reads it from 2017.2 only).
  if (atLeast(version, 2017, 1, 2) || isPatchFrom(reader, 2017, 1, 1, 1)) {
    out.atlasRectOffset = readVector2(reader);
  }
  out.uvTransform = readVector4(reader);
  out.downscaleMultiplier = reader.readFloat32();
  out.settingsRaw = reader.readUInt32();
  // 2020.2+.
  if (atLeast(version, 2020, 2)) {
    out.secondaryTextures = readSecondaryTextures(reader, "SpriteAtlas");
    reader.align();
  }
  return out as SpriteAtlasData;
}
