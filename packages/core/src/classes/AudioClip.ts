// Ported from AssetStudio/Classes/AudioClip.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError, UnsupportedError } from "../errors.js";
import { BuildTarget } from "../serialized/BuildTarget.js";
import { SerializedFileFormatVersion as V } from "../serialized/FormatVersion.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
import type { ResourceReader } from "./registry.js";
import { atLeast } from "./version.js";
import { readStreamedData, readStreamedResource, type StreamedResource } from "./VideoClip.js";

/**
 * The fields of an `AudioClip`, as a player build stores them, under Unity's
 * names: keys, their order and their values agree with `readTypeTree()` on the
 * same object, except that `m_Resource.m_Offset` and `m_Size` are `number`s
 * here.
 *
 * Unity 5.0 rewrote the class. Before it the sound is inline in
 * `m_AudioData`; from it, `m_Resource.m_Size` bytes of a resource file, an
 * FMOD sound bank (FSB5) holding PCM, Vorbis, ADPCM or a platform codec as
 * `m_CompressionFormat` says. Nothing here decodes it.
 */
export interface AudioClip extends NamedObject {
  /** Before Unity 5.0. */
  m_Format?: number;
  /** Before Unity 5.0: an FMOD sound type (upstream's `FMODSoundType`). */
  m_Type?: number;
  /** Before Unity 5.0. */
  m_3D?: boolean;
  /** Before Unity 5.0. */
  m_UseHardware?: boolean;
  /** Before Unity 5.0. */
  m_Stream?: number;
  /** Before Unity 5.0: the sound, a view into the object's bytes (R7). */
  m_AudioData?: Uint8Array;
  /** Unity 5.0 and later. */
  m_LoadType?: number;
  /** Unity 5.0 and later. */
  m_Channels?: number;
  /** Unity 5.0 and later. */
  m_Frequency?: number;
  /** Unity 5.0 and later. */
  m_BitsPerSample?: number;
  /** Unity 5.0 and later: seconds. */
  m_Length?: number;
  /** Unity 5.0 and later. */
  m_IsTrackerFormat?: boolean;
  /** Unity 2017.1 and later. */
  m_Ambisonic?: boolean;
  /** Unity 5.0 and later. */
  m_SubsoundIndex?: number;
  /** Unity 5.0 and later. */
  m_PreloadAudioData?: boolean;
  /** Unity 5.0 and later. */
  m_LoadInBackground?: boolean;
  /** Unity 5.0 and later. */
  m_Legacy3D?: boolean;
  /** Unity 5.0 and later: where the sound is. */
  m_Resource?: StreamedResource;
  /** Unity 5.0 and later: upstream's `AudioCompressionFormat` (0 PCM, 1 Vorbis, ...). */
  m_CompressionFormat?: number;
}

/**
 * An `AudioClip` as `obj.read()` returns it: every field `readAudioClip`
 * reads, plus the sound's bytes wherever they live.
 */
export interface AudioClipData extends AudioClip {
  /**
   * The sound, still encoded: `m_AudioData` before Unity 5.0, and otherwise
   * `m_Resource.m_Size` bytes of the resource file it names (upstream's
   * `m_AudioData` resource reader). A view either way, never a copy (R7).
   * Named like `Texture2DData.imageData`, outside Unity's `m_` names, so it
   * never collides with the pre-5.0 `m_AudioData` field.
   */
  audioData: Uint8Array;
}

/**
 * Read an `AudioClip` from the object's first byte: every field of Unity's own
 * player type trees for its version (UnityPy's TPK data), in their order,
 * which from 5.0 is what upstream reads, plus 2017.1's `m_Ambisonic`, which
 * upstream reads past without knowing it (it lands in its padding).
 *
 * Unity 3.4 to 4.x (upstream's legacy branch) keep the sound inline in
 * `m_AudioData`. Upstream also reads a clip of 3.2 to 4.x whose byte count is
 * not followed by that many bytes as a streamed one: the count, then a
 * `UInt32` offset into the SerializedFile's own `.resS`. That case is refused,
 * since an `ObjectReader` does not know its file's name to look the `.resS`
 * up by. Below 3.4 there is no type tree data, so such a file is refused too.
 *
 * A file whose Unity version is unknown (`[0, 0, 0, 0]`) is read when its
 * format is 18 or later (rule for version-stripped files, #36): such a file is
 * Unity 2019.1 or later, and the layout has not changed from 2017.1 to 6000.6.
 * Below 18 the format allows 5.0's layout and 2017.1's, which have the same
 * size (`m_Ambisonic` takes a byte of padding), so the bytes cannot decide.
 *
 * Only player builds are read: an editor file (`BuildTarget.NoTarget`) holds
 * editor-only fields (`m_EditorResource`, ...) that upstream does not read.
 *
 * The object must end exactly after its last field (upstream does not check).
 *
 * ponytail: the gates compare release numbers only (see `atLeast`). Unity
 * 5.6.0b5 lacks `m_LoadInBackground` (TPK data; b11 has it again, the betas
 * between are not recorded), and such a beta is misread rather than refused:
 * the three bools share one padded word, so its `m_Legacy3D` comes out as
 * `m_LoadInBackground` and `m_Legacy3D` as the padding (false). Compare the
 * build type and number if a 5.6 beta ever matters.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`, below 3.4 or for an unknown version below
 *   format 18; of kind `"build target"` for an editor file; of kind
 *   `"AudioClip storage"` for a streamed clip before 5.0
 * @throws {CorruptError} when the object ends early, a count or string length
 *   is negative or runs past its end, `m_Offset` or `m_Size` is 2^53 or above,
 *   or bytes are left over after the last field
 */
export function readAudioClip(reader: ObjectReader): AudioClip {
  const { version } = reader;
  // #36 rule: an unknown version is read only where the layout is decided.
  const stripped = version.every((part) => part === 0);
  if (stripped && reader.format < V.RefactorShareableTypeTreeData) {
    throw refuse(reader, "below format 18 an AudioClip's layout depends on the Unity version");
  }
  if (!stripped && !atLeast(version, 3, 4)) {
    throw refuse(reader, "no known AudioClip layout before Unity 3.4");
  }
  if (reader.platform === BuildTarget.NoTarget) {
    throw new UnsupportedError(
      "build target",
      "NoTarget",
      `object ${reader.pathId}: an editor file's AudioClip holds editor-only fields`,
    );
  }

  const base = readNamedObject(reader);
  const out = !stripped && !atLeast(version, 5, 0)
    ? readLegacyFields(reader, base)
    : readFields(reader, base, stripped || atLeast(version, 2017, 1));

  if (reader.remaining !== 0) {
    throw new CorruptError(
      `AudioClip ${reader.pathId} ends at ${reader.position} of its ${reader.byteSize} bytes`,
    );
  }
  return out;
}

/** 5.0+: everything after `m_Name`; `m_Ambisonic` from 2017.1. */
function readFields(reader: ObjectReader, base: NamedObject, ambisonic: boolean): AudioClip {
  const out: AudioClip = { ...base };
  out.m_LoadType = reader.readInt32();
  out.m_Channels = reader.readInt32();
  out.m_Frequency = reader.readInt32();
  out.m_BitsPerSample = reader.readInt32();
  out.m_Length = reader.readFloat32();
  out.m_IsTrackerFormat = readBool(reader);
  if (ambisonic) out.m_Ambisonic = readBool(reader);
  reader.align();
  out.m_SubsoundIndex = reader.readInt32();
  out.m_PreloadAudioData = readBool(reader);
  out.m_LoadInBackground = readBool(reader);
  out.m_Legacy3D = readBool(reader);
  reader.align();
  out.m_Resource = readStreamedResource(reader, "AudioClip", "m_Resource");
  out.m_CompressionFormat = reader.readInt32();
  return out;
}

/** 3.4 to 4.x: everything after `m_Name`, the sound inline. */
function readLegacyFields(reader: ObjectReader, base: NamedObject): AudioClip {
  const out: AudioClip = { ...base };
  out.m_Format = reader.readInt32();
  out.m_Type = reader.readInt32();
  out.m_3D = readBool(reader);
  out.m_UseHardware = readBool(reader);
  reader.align();
  out.m_Stream = reader.readInt32();

  const at = reader.position;
  const count = reader.readInt32();
  const padded = count + ((4 - (count % 4)) % 4);
  // Upstream's test for a streamed clip: the bytes left are not the data and
  // its padding. It then reads a UInt32 offset into "<this file>.resS".
  if (count >= 0 && reader.remaining !== padded && reader.remaining === 4) {
    throw new UnsupportedError(
      "AudioClip storage",
      "streamed before Unity 5.0",
      `object ${reader.pathId}: its ${count} bytes are in the SerializedFile's own .resS, ` +
        "which an ObjectReader cannot name",
    );
  }
  if (count < 0 || count > reader.remaining) {
    throw new CorruptError(
      `AudioClip ${reader.pathId} m_AudioData byte count ${count} at offset ${at} ` +
        `does not fit the ${reader.remaining} bytes left`,
    );
  }
  out.m_AudioData = reader.readBytes(count);
  reader.align();
  return out;
}

/**
 * `readAudioClip` with the sound's bytes resolved, as upstream's `AudioClip`
 * sets `m_AudioData`: before 5.0 the inline data, from 5.0 the bytes of the
 * resource file `m_Resource` names, read through the env's resource resolver
 * (the `Texture2DData` pattern). The registry's reader for `obj.read()`.
 *
 * @param reader the object's reader
 * @param resources how to read resource files for it; `undefined` for a reader
 *   not built by `load()`
 * @throws {ResourceNotFoundError} when the resource file is not loaded, or
 *   there are no `resources` to look in
 * @throws {CorruptError} when there is no sound: an empty `m_AudioData` before
 *   5.0, or an empty `m_Resource.m_Source` from it (upstream would read past
 *   the object's end); and as `readAudioClip` does
 * @throws {UnsupportedError} as `readAudioClip` does
 */
export function readAudioClipData(
  reader: ObjectReader,
  resources: ResourceReader | undefined,
): AudioClipData {
  const clip = readAudioClip(reader);
  if (clip.m_AudioData) {
    if (clip.m_AudioData.length === 0) {
      throw new CorruptError(`AudioClip ${reader.pathId} has no data: m_AudioData is empty`);
    }
    return { ...clip, audioData: clip.m_AudioData };
  }
  // Set whenever m_AudioData is not: readFields reads it.
  const resource = clip.m_Resource!;
  return { ...clip, audioData: readStreamedData(reader, resources, resource, "AudioClip") };
}

/** A one-byte bool, as Unity writes it. */
function readBool(reader: ObjectReader): boolean {
  return reader.readUInt8() !== 0;
}

/** Refuse a version this reader has no layout for, naming the file's own version string. */
function refuse(reader: ObjectReader, why: string): UnsupportedError {
  const hint = `object ${reader.pathId}: ${why}`;
  return new UnsupportedError("Unity version", reader.unityVersion, hint);
}
