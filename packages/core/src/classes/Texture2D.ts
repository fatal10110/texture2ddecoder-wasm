// Ported from AssetStudio/Classes/Texture2D.cs (MIT, © Perfare / RazTools / Razviar)

import type { ResourceRef } from "../env.js";
import { CorruptError } from "../errors.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import { readCount } from "../serialized/TypeTree.js";
import { atLeast, readTexture, type Texture } from "./Texture.js";

/**
 * Where a texture's image data lives when it is not stored in the object
 * (Unity's `StreamingInfo`): `size` bytes at `offset` in the resource file
 * `path`, usually a `.resS` node of the same bundle, named like
 * `archive:/CAB-<hash>/CAB-<hash>.resS`. It is the env's `ResourceRef`, so
 * `env.readResource(texture.m_StreamData, reader)` takes it as it is.
 *
 * An empty `path` means the data is inline, in the object's `image data`.
 * `offset` is `UInt64` from Unity 2020.1 on, refused at 2^53 and above (D9);
 * the reader returns the fields in Unity's order: `offset`, `size`, `path`.
 */
export type StreamingInfo = ResourceRef;

/**
 * Sampling settings of a texture (Unity's `GLTextureSettings`). Before Unity
 * 2017.1 one wrap mode covers every axis; from 2017.1 there is one per axis.
 */
export interface GLTextureSettings {
  m_FilterMode: number;
  m_Aniso: number;
  m_MipBias: number;
  /** Before Unity 2017.1. */
  m_WrapMode?: number;
  /** Unity 2017.1 and later. */
  m_WrapU?: number;
  /** Unity 2017.1 and later. */
  m_WrapV?: number;
  /** Unity 2017.1 and later. */
  m_WrapW?: number;
}

/**
 * The fields of a `Texture2D`, as a player build stores them, under Unity's
 * names: the keys, their order and their values agree with `readTypeTree()`
 * on the same object, except that `m_StreamData.offset` is a `number` here.
 *
 * The pixels are either inline in `image data` or, when `m_StreamData.path`
 * is not empty, `m_StreamData.size` bytes of a resource file. Either way they
 * are still encoded in `m_TextureFormat`, every mip level in a row.
 */
export interface Texture2D extends Texture {
  m_Width: number;
  m_Height: number;
  /** Bytes of image data, all mip levels. */
  m_CompleteImageSize: number;
  /** Unity 2020.1 and later. */
  m_MipsStripped?: number;
  /**
   * A `TextureFormat` value, kept as the number the file holds even when
   * `TextureFormat` does not name it.
   */
  m_TextureFormat: number;
  /** Before Unity 5.2: whether there are mip levels at all. */
  m_MipMap?: boolean;
  /** Unity 5.2 and later. */
  m_MipCount?: number;
  /** Unity 2.6 and later. */
  m_IsReadable?: boolean;
  /** Unity 2019.4.9 and later. */
  m_IsPreProcessed?: boolean;
  /** Unity 2019.3 to 2022.1. */
  m_IgnoreMasterTextureLimit?: boolean;
  /** Unity 2022.2 and later: `m_IgnoreMasterTextureLimit` renamed. */
  m_IgnoreMipmapLimit?: boolean;
  /** Unity 2022.2 and later. */
  m_MipmapLimitGroupName?: string;
  /** Unity 3.0 to 5.4. */
  m_ReadAllowed?: boolean;
  /** Unity 2018.2 and later. */
  m_StreamingMipmaps?: boolean;
  /** Unity 2018.2 and later. */
  m_StreamingMipmapsPriority?: number;
  m_ImageCount: number;
  m_TextureDimension: number;
  m_TextureSettings: GLTextureSettings;
  /** Unity 3.0 and later. */
  m_LightmapFormat?: number;
  /** Unity 3.5 and later. */
  m_ColorSpace?: number;
  /** Unity 2020.2 and later: a view into the object's bytes (R7). */
  m_PlatformBlob?: Uint8Array;
  /**
   * The inline image data, a view into the object's bytes (R7); empty when the
   * data is in a resource file (see `m_StreamData`).
   */
  "image data": Uint8Array;
  /** Unity 5.3 and later. */
  m_StreamData?: StreamingInfo;
}

/**
 * Read a `Texture2D` from the object's first byte: every field upstream reads,
 * in the order and under the version gates Unity's own type trees give (as
 * UnityPy's TPK data records them), through `m_StreamData`.
 *
 * Nothing is resolved or decoded: `.resS` data is described by
 * `m_StreamData`, whose `{ offset, size, path }` is what a resource lookup
 * takes as it is.
 *
 * The object must end exactly where `m_StreamData` does (upstream does not
 * check), so a layout this reader does not know - a pre-release build, a game
 * with a modified engine - is refused rather than returned half-read.
 * Upstream instead skips `m_MipmapLimitGroupName` and `m_PlatformBlob` when
 * the object's type tree lacks them, and its per-game fields; neither is
 * ported, and such an object can still be read with `readTypeTree()`.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} for an unknown Unity version or an editor file,
 *   as `readTexture` does
 * @throws {CorruptError} when the object ends early, a length or count runs
 *   past its end, `m_StreamData.offset` is 2^53 or above, or bytes are left
 *   over after the last field
 */
export function readTexture2D(reader: ObjectReader): Texture2D {
  const base = readTexture(reader);
  const { version } = reader;
  const v2020_1 = atLeast(version, 2020, 1);

  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<Texture2D> & Texture = { ...base };
  out.m_Width = reader.readInt32();
  out.m_Height = reader.readInt32();
  // Unsigned from 2020.1; upstream reads it signed throughout.
  out.m_CompleteImageSize = v2020_1 ? reader.readUInt32() : reader.readInt32();
  if (v2020_1) out.m_MipsStripped = reader.readInt32();
  out.m_TextureFormat = reader.readInt32();
  // 5.2: the m_MipMap flag became a count.
  if (atLeast(version, 5, 2)) out.m_MipCount = reader.readInt32();
  else out.m_MipMap = readBool(reader);

  if (atLeast(version, 2, 6)) out.m_IsReadable = readBool(reader);
  // The order of these two flipped in 2020.1. Upstream reads m_IsPreProcessed
  // from 2020.1 only, so on 2019.4.9+ its next flags are one field off.
  if (v2020_1) {
    out.m_IsPreProcessed = readBool(reader);
    readMipmapLimit(reader, out);
  } else if (atLeast(version, 2019, 4, 9)) {
    readMipmapLimit(reader, out);
    out.m_IsPreProcessed = readBool(reader);
  } else {
    readMipmapLimit(reader, out);
  }
  if (atLeast(version, 3, 0) && !atLeast(version, 5, 5)) out.m_ReadAllowed = readBool(reader);
  if (atLeast(version, 2018, 2)) out.m_StreamingMipmaps = readBool(reader);
  reader.align();
  if (atLeast(version, 2018, 2)) out.m_StreamingMipmapsPriority = reader.readInt32();

  out.m_ImageCount = reader.readInt32();
  out.m_TextureDimension = reader.readInt32();
  out.m_TextureSettings = readTextureSettings(reader);
  if (atLeast(version, 3, 0)) out.m_LightmapFormat = reader.readInt32();
  if (atLeast(version, 3, 5)) out.m_ColorSpace = reader.readInt32();
  if (atLeast(version, 2020, 2)) {
    // Upstream backs off a length past the end instead; Unity never writes one.
    out.m_PlatformBlob = reader.readBytes(readCount(reader, "m_PlatformBlob byte"));
    reader.align();
  }

  // Upstream only notes where the image data starts; it is read here, so the
  // fields after it can be too.
  out["image data"] = reader.readBytes(readCount(reader, "image data byte"));
  reader.align();
  // 5.3+. Upstream skips it when the data is inline, but Unity writes it
  // either way (empty then), and the object is not over until it is read.
  if (atLeast(version, 5, 3)) out.m_StreamData = readStreamingInfo(reader);

  if (reader.remaining !== 0) {
    throw new CorruptError(
      `Texture2D ${reader.pathId} ends at ${reader.position} of its ${reader.byteSize} bytes`,
    );
  }
  // Every required field was set above.
  return out as Texture2D;
}

/**
 * The master texture limit flag, 2019.3+, with 2022.2's rename and its new
 * group name after it.
 */
function readMipmapLimit(reader: ObjectReader, out: Partial<Texture2D>): void {
  if (atLeast(reader.version, 2022, 2)) {
    out.m_IgnoreMipmapLimit = readBool(reader);
    reader.align();
    out.m_MipmapLimitGroupName = reader.readAlignedString();
  } else if (atLeast(reader.version, 2019, 3)) {
    out.m_IgnoreMasterTextureLimit = readBool(reader);
  }
}

/** Upstream `GLTextureSettings(ObjectReader)`, minus the per-game field. */
function readTextureSettings(reader: ObjectReader): GLTextureSettings {
  const m_FilterMode = reader.readInt32();
  const m_Aniso = reader.readInt32();
  const m_MipBias = reader.readFloat32();
  // 2017.1+: one wrap mode per axis.
  if (atLeast(reader.version, 2017, 1)) {
    return {
      m_FilterMode,
      m_Aniso,
      m_MipBias,
      m_WrapU: reader.readInt32(),
      m_WrapV: reader.readInt32(),
      m_WrapW: reader.readInt32(),
    };
  }
  return { m_FilterMode, m_Aniso, m_MipBias, m_WrapMode: reader.readInt32() };
}

/**
 * Upstream `StreamingInfo(ObjectReader)`.
 *
 * @throws {CorruptError} when the offset is 2^53 or above (R6), or the path's
 *   length runs past the object's end: upstream would read that as an empty
 *   path, and so call truncated data inline
 */
function readStreamingInfo(reader: ObjectReader): StreamingInfo {
  // 2020.1+: the offset is 64-bit.
  let offset: number;
  if (atLeast(reader.version, 2020, 1)) {
    const value = reader.readUInt64();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CorruptError(
        `Texture2D ${reader.pathId} m_StreamData offset ${value} is not a byte offset below 2^53`,
      );
    }
    offset = Number(value);
  } else {
    offset = reader.readUInt32();
  }
  const size = reader.readUInt32();

  const at = reader.position;
  const length = reader.readInt32();
  if (length > reader.remaining) {
    throw new CorruptError(
      `Texture2D ${reader.pathId} m_StreamData path of ${length} bytes at offset ${at} ` +
        `runs past the ${reader.remaining} bytes left`,
    );
  }
  reader.position = at;
  return { offset, size, path: reader.readAlignedString() };
}

/** A one-byte bool, as Unity writes it. */
function readBool(reader: ObjectReader): boolean {
  return reader.readUInt8() !== 0;
}
