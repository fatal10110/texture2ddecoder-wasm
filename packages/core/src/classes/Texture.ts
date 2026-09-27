// Ported from AssetStudio/Classes/Texture.cs (MIT, © Perfare / RazTools / Razviar)

import { UnsupportedError } from "../errors.js";
import { BuildTarget } from "../serialized/BuildTarget.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
import { atLeast } from "./version.js";

/**
 * The fields of a `Texture` (upstream's base of `Texture2D` and the other
 * texture classes): a {@link NamedObject} plus the fallback settings Unity
 * added in 2017.3. Keys are Unity's, so they agree with `readTypeTree()`.
 */
export interface Texture extends NamedObject {
  /** Unity 2017.3 to 2023.1. */
  m_ForcedFallbackFormat?: number;
  /** Unity 2017.3 to 2023.1. */
  m_DownscaleFallback?: boolean;
  /** Unity 2020.2 and later. */
  m_IsAlphaChannelOptional?: boolean;
}

/**
 * Read a `Texture` from the object's first byte: the `NamedObject` fields,
 * then the fields its Unity version wrote. A spread helper for the concrete
 * texture readers, such as `readTexture2D`.
 *
 * Only player builds are read. An editor file (`BuildTarget.NoTarget`) stores
 * editor-only fields here, such as `m_ImageContentsHash`, that upstream does
 * not read either, so it is refused rather than misread.
 *
 * ponytail: the texture readers' gates compare release numbers only (see
 * `atLeast`), as upstream's do. Alpha and beta builds of 2020.1, 2020.2 and
 * 2023.1/2023.2 changed these layouts mid-cycle (UnityPy's TPK data), so such
 * a pre-release may be misread; the texture readers' byte-size check turns
 * most of those into a `CorruptError`. Compare `buildType` and the build
 * number in the gates if a pre-release file ever matters.
 *
 * @param reader the object's reader, rewound first and left just past these
 *   fields and their padding
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`, when the version is unknown (`[0, 0, 0, 0]`:
 *   stripped, or a loose file below format 7), since every field past `m_Name`
 *   depends on it; of kind `"build target"` for an editor file
 * @throws {CorruptError} when the object is too short for these fields
 */
export function readTexture(reader: ObjectReader): Texture {
  const { version } = reader;
  // Rule for version-gated class readers (#36): an unknown version must not
  // fall through to the oldest branch, so refuse it.
  if (version.every((part) => part === 0)) {
    throw new UnsupportedError(
      "Unity version",
      reader.unityVersion,
      `object ${reader.pathId}: a texture's fields depend on the Unity version, ` +
        "and this file does not record one",
    );
  }
  if (reader.platform === BuildTarget.NoTarget) {
    throw new UnsupportedError(
      "build target",
      "NoTarget",
      `object ${reader.pathId}: an editor file's texture holds editor-only fields`,
    );
  }

  const base = readNamedObject(reader);
  if (!atLeast(version, 2017, 3)) return base;

  const out: Texture = { ...base };
  // 2017.3 to 2023.1; gone from 2023.2.
  if (!atLeast(version, 2023, 2)) {
    out.m_ForcedFallbackFormat = reader.readInt32();
    out.m_DownscaleFallback = reader.readUInt8() !== 0;
  }
  if (atLeast(version, 2020, 2)) out.m_IsAlphaChannelOptional = reader.readUInt8() !== 0;
  reader.align();
  return out;
}
