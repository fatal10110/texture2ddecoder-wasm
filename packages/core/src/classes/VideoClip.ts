// Ported from AssetStudio/Classes/VideoClip.cs (MIT, © Perfare / RazTools / Razviar)

import type { ResourceRef } from "../env.js";
import { CorruptError, ResourceNotFoundError, UnsupportedError } from "../errors.js";
import { SerializedFileFormatVersion as V } from "../serialized/FormatVersion.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import { baseName } from "../serialized/SerializedFile.js";
import { readCount } from "../serialized/TypeTree.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
import { readPPtr, type PPtr } from "./PPtr.js";
import type { ResourceReader } from "./registry.js";
import { readStringField } from "./strings.js";
import { atLeast } from "./version.js";

/**
 * Where an `AudioClip`'s or a `VideoClip`'s data lives (Unity's
 * `StreamedResource`): `m_Size` bytes at `m_Offset` of the resource file
 * `m_Source`, in a bundle a `.resource` node named like
 * `archive:/CAB-<hash>/CAB-<hash>.resource`.
 *
 * Unity's names, in its order. `m_Offset` and `m_Size` are `UInt64` in the
 * file (`m_Offset` a `FileSize` from 2020.1); they are byte offsets and sizes,
 * so they are `number`s here, refused at 2^53 and above (D9), where
 * `readTypeTree()` gives `bigint`s.
 */
export interface StreamedResource {
  m_Source: string;
  m_Offset: number;
  m_Size: number;
}

/**
 * The fields of a `VideoClip`, under Unity's names (`Width`, `Height` and the
 * misspelt `m_PixelAspecRatio*` included): keys, their order and their values
 * agree with `readTypeTree()` on the same object, except that
 * `m_ExternalResources.m_Offset` and `m_Size` are `number`s here.
 *
 * The video itself, the source file as imported (or as transcoded by the
 * editor), is `m_ExternalResources.m_Size` bytes of a resource file.
 */
export interface VideoClip extends NamedObject {
  /** The asset's path in the editor project. */
  m_OriginalPath: string;
  m_ProxyWidth: number;
  m_ProxyHeight: number;
  Width: number;
  Height: number;
  /** Unity 2017.2 and later. */
  m_PixelAspecRatioNum?: number;
  /** Unity 2017.2 and later. */
  m_PixelAspecRatioDen?: number;
  m_FrameRate: number;
  /** A `UInt64` (D9). */
  m_FrameCount: bigint;
  m_Format: number;
  /** One per audio track. */
  m_AudioChannelCount: number[];
  /** One per audio track. */
  m_AudioSampleRate: number[];
  /** One per audio track. */
  m_AudioLanguage: string[];
  /** Unity 2020.1 and later. */
  m_VideoShaders?: PPtr[];
  m_ExternalResources: StreamedResource;
  m_HasSplitAlpha: boolean;
  /** Unity 2019.2 and later. */
  m_sRGB?: boolean;
}

/**
 * Read a `VideoClip` from the object's first byte: every field of Unity's own
 * type trees for its version (UnityPy's TPK data), in their order. Upstream
 * reads the same fields but gates `m_sRGB` at 2020.1; Unity's trees have it
 * from 2019.2, and a 2019.4 fixture confirms it.
 *
 * Editor and player files share the layout after `m_Name`, so both are read.
 * The class came with Unity 5.6; an older version is refused.
 *
 * A file whose Unity version is unknown (`[0, 0, 0, 0]`) is read where its
 * SerializedFile format leaves one layout (rule for version-stripped files,
 * #36): format 21 is written by 2019.3 and 2019.4 only, so it has 2019.2's
 * layout; format 22 (2020.1 on) has 2020.1's. Below 21 the formats span
 * layouts that differ inside the object, so the file is refused.
 *
 * The object must end exactly after its last field (upstream does not check).
 *
 * ponytail: the gates compare release numbers only (see `atLeast`). A 2019.2
 * alpha before a6 lacks `m_sRGB`, 2017.2.0b1 the aspect ratio, a 2020.1 alpha
 * before a7 `m_VideoShaders`, and a format 22 file from such an alpha is read
 * as 2020.1. The first runs out of bytes (CorruptError); the others shift every
 * field after the gap, which the counts, string lengths and end-of-object
 * check are all but certain to catch. Compare the build type if a pre-release
 * ever matters.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`, for a version before 5.6, or an unknown one in a
 *   file below format 21; as `readNamedObject` does, for an editor file of
 *   unknown version
 * @throws {CorruptError} when the object ends early, a count or string length
 *   is negative or runs past its end, `m_Offset` or `m_Size` is 2^53 or above,
 *   or bytes are left over after the last field
 */
export function readVideoClip(reader: ObjectReader): VideoClip {
  const layout = videoClipLayout(reader);

  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<VideoClip> & NamedObject = readNamedObject(reader);
  out.m_OriginalPath = readStringField(reader, "VideoClip", "m_OriginalPath");
  out.m_ProxyWidth = reader.readUInt32();
  out.m_ProxyHeight = reader.readUInt32();
  out.Width = reader.readUInt32();
  out.Height = reader.readUInt32();
  if (layout.aspectRatio) {
    out.m_PixelAspecRatioNum = reader.readUInt32();
    out.m_PixelAspecRatioDen = reader.readUInt32();
  }
  out.m_FrameRate = reader.readFloat64();
  out.m_FrameCount = reader.readUInt64();
  out.m_Format = reader.readInt32();
  out.m_AudioChannelCount = readArray(reader, "m_AudioChannelCount", (r) => r.readUInt16());
  reader.align();
  out.m_AudioSampleRate = readArray(reader, "m_AudioSampleRate", (r) => r.readUInt32());
  out.m_AudioLanguage = readArray(reader, "m_AudioLanguage", (r) =>
    readStringField(r, "VideoClip", "m_AudioLanguage entry"),
  );
  if (layout.videoShaders) out.m_VideoShaders = readArray(reader, "m_VideoShaders", readPPtr);
  out.m_ExternalResources = readStreamedResource(reader, "VideoClip", "m_ExternalResources");
  out.m_HasSplitAlpha = reader.readUInt8() !== 0;
  // Not padded: the object ends with the last bool.
  if (layout.sRGB) out.m_sRGB = reader.readUInt8() !== 0;

  if (reader.remaining !== 0) {
    throw new CorruptError(
      `VideoClip ${reader.pathId} ends at ${reader.position} of its ${reader.byteSize} bytes`,
    );
  }
  // Every required field was set above.
  return out as VideoClip;
}

/** Which of the fields Unity added after 5.6 a VideoClip has. */
interface VideoClipLayout {
  /** 2017.2+: `m_PixelAspecRatioNum`, `m_PixelAspecRatioDen`. */
  aspectRatio: boolean;
  /** 2019.2+: `m_sRGB`. */
  sRGB: boolean;
  /** 2020.1+: `m_VideoShaders`. */
  videoShaders: boolean;
}

/** The layout of a VideoClip, from its version or, when stripped, its format. */
function videoClipLayout(reader: ObjectReader): VideoClipLayout {
  const { version } = reader;
  if (version.every((part) => part === 0)) {
    // #36 rule for version-stripped files: here the format alone leaves one layout.
    if (reader.format >= V.LargeFilesSupport) {
      return { aspectRatio: true, sRGB: true, videoShaders: true };
    }
    if (reader.format === V.StoresTypeDependencies) {
      return { aspectRatio: true, sRGB: true, videoShaders: false };
    }
    throw refuse(reader, "below format 21 the format does not decide a VideoClip's layout");
  }
  if (!atLeast(version, 5, 6)) throw refuse(reader, "no VideoClip before Unity 5.6");
  return {
    aspectRatio: atLeast(version, 2017, 2),
    sRGB: atLeast(version, 2019, 2),
    videoShaders: atLeast(version, 2020, 1),
  };
}

/**
 * `readVideoClip` with the video bytes resolved: the `size` bytes of the
 * resource file `m_ExternalResources` names, as upstream's `m_VideoData`.
 * The registry's reader for `obj.read()`.
 *
 * @param reader the object's reader
 * @param resources how to read resource files for it; `undefined` for a reader
 *   not built by `load()`
 * @throws {ResourceNotFoundError} when the resource file is not loaded, or
 *   there are no `resources` to look in
 * @throws {CorruptError} when `m_ExternalResources.m_Source` names no file
 *   (upstream would read past the object's end), and as `readVideoClip` does
 * @throws {UnsupportedError} as `readVideoClip` does
 */
export function readVideoClipData(
  reader: ObjectReader,
  resources: ResourceReader | undefined,
): VideoClipData {
  const clip = readVideoClip(reader);
  const videoData = readStreamedData(reader, resources, clip.m_ExternalResources, "VideoClip");
  return { ...clip, videoData };
}

/**
 * A `VideoClip` as `obj.read()` returns it: every field `readVideoClip` reads,
 * plus the video bytes.
 */
export interface VideoClipData extends VideoClip {
  /**
   * The video, still encoded (the imported file, or the editor's transcode):
   * `m_ExternalResources.m_Size` bytes of the resource file it names, a view
   * into that file (R7). Named like `Texture2DData.imageData`, outside Unity's
   * `m_` names, so it never collides with a field of the file.
   */
  videoData: Uint8Array;
}

/**
 * Read a `StreamedResource` (upstream's constructor), with `m_Source` read
 * strictly (see `readStringField`) and the two `UInt64`s as `number`s.
 * Internal to the class readers.
 *
 * @param reader the object's reader, left just past the struct
 * @param owner the class, for error messages
 * @param field the field, for error messages
 * @throws {CorruptError} when the object ends inside it, `m_Source`'s length is
 *   negative or runs past the end, or `m_Offset` or `m_Size` is 2^53 or above
 */
export function readStreamedResource(
  reader: ObjectReader,
  owner: string,
  field: string,
): StreamedResource {
  const m_Source = readStringField(reader, owner, `${field}.m_Source`);
  const m_Offset = toNumber(reader, reader.readUInt64(), owner, `${field}.m_Offset`);
  const m_Size = toNumber(reader, reader.readUInt64(), owner, `${field}.m_Size`);
  return { m_Source, m_Offset, m_Size };
}

/**
 * The bytes a `StreamedResource` names, read through the env's resource
 * resolver, the way `Texture2DData.imageData` reads `m_StreamData`. Internal
 * to the class readers.
 *
 * Upstream reads `m_Size` bytes from the end of the object when `m_Source` is
 * empty, which is past the object's data; UnityPy raises. This throws
 * `CorruptError` then (R9), as `obj.read()` does for a Texture2D without image
 * data (decided on PR #118).
 *
 * @throws {ResourceNotFoundError} when the file is not loaded, or there are no
 *   `resources` to look in (a reader not built by `load()`)
 * @throws {CorruptError} when `m_Source` is empty, and as `env.readResource`
 *   does when the range runs past the end of the file
 */
export function readStreamedData(
  reader: ObjectReader,
  resources: ResourceReader | undefined,
  { m_Source, m_Offset, m_Size }: StreamedResource,
  owner: string,
): Uint8Array {
  if (!m_Source) {
    throw new CorruptError(
      `${owner} ${reader.pathId} has no data: its resource path is empty ` +
        `(${m_Size} bytes at offset ${m_Offset} of no file)`,
    );
  }
  const ref: ResourceRef = { path: m_Source, offset: m_Offset, size: m_Size };
  // A reader built outside `load()` has no files to look in.
  if (!resources) throw new ResourceNotFoundError(m_Source, baseName(m_Source));
  return resources(ref, reader);
}

/** A `UInt64` offset or size as a `number`, refused at 2^53 and above (D9). */
function toNumber(reader: ObjectReader, value: bigint, owner: string, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CorruptError(
      `${owner} ${reader.pathId} ${field} ${value} is not a byte offset below 2^53`,
    );
  }
  return Number(value);
}

/** An `Int32` count, then that many elements. */
function readArray<T>(reader: ObjectReader, what: string, element: (r: ObjectReader) => T): T[] {
  const count = readCount(reader, `VideoClip ${reader.pathId} ${what}`);
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(element(reader));
  return out;
}

/** Refuse a version this reader has no layout for, naming the file's own version string. */
function refuse(reader: ObjectReader, why: string): UnsupportedError {
  const hint = `object ${reader.pathId}: ${why}`;
  return new UnsupportedError("Unity version", reader.unityVersion, hint);
}
