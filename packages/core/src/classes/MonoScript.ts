// Ported from AssetStudio/Classes/MonoScript.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError, UnsupportedError } from "../errors.js";
import { BuildTarget } from "../serialized/BuildTarget.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
import { readStringField } from "./strings.js";
import { atLeast } from "./version.js";

/**
 * A 128-bit hash (Unity's `Hash128`) in the shape `readTypeTree()` gives it:
 * one number per byte, keyed `"bytes[0]"` to `"bytes[15]"` in that order.
 */
export type Hash128 = { [byte: `bytes[${number}]`]: number };

/**
 * The fields of a `MonoScript`, the asset standing for one C# class that a
 * `MonoBehaviour`'s `m_Script` points at, as a player build stores them.
 * Keys, their order and their values agree with `readTypeTree()` on the same
 * object.
 */
export interface MonoScript extends NamedObject {
  m_ExecutionOrder: number;
  /**
   * A `UInt32` before Unity 5.0, a {@link Hash128} from 5.0. The hash of the
   * class's serialized fields: a `MonoBehaviour` type entry pointing at this
   * script has it as its `oldTypeHash`.
   */
  m_PropertiesHash: number | Hash128;
  /** The C# class name, without its namespace. */
  m_ClassName: string;
  /** `""` for the global namespace. */
  m_Namespace: string;
  /** The assembly, such as `"Assembly-CSharp.dll"` (`"Assembly-CSharp"` in Unity 6). */
  m_AssemblyName: string;
  /** Before Unity 2018.2. */
  m_IsEditorScript?: boolean;
}

/**
 * Read a `MonoScript` from the object's first byte: every field upstream
 * reads, under Unity's names, with the version gates of upstream and of
 * Unity's own player type trees (UnityPy's TPK data), which agree from 3.4 on.
 *
 * Below 3.4 there is no type tree data, so such a file is refused, per the
 * rule for version-gated readers (#36); upstream's branches for 2.x
 * (`m_PathName`, no `m_Namespace`) and 3.0 to 3.3 (no `m_ExecutionOrder`) are
 * not ported. A stripped version is refused too: the layouts differ inside
 * the object (a 4-byte or a 16-byte `m_PropertiesHash`), so the bytes cannot
 * pick one.
 *
 * The object must end exactly after its last field (upstream does not check).
 * Only player builds are read: an editor file (`BuildTarget.NoTarget`) stores
 * the script source and editor-only fields in between, which upstream does
 * not read either.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`, when the version is unknown (`[0, 0, 0, 0]`:
 *   stripped, or a loose file below format 7), since the fields depend on it,
 *   or below 3.4; of kind `"build target"` for an editor file
 * @throws {CorruptError} when the object ends early, a string's byte count is
 *   negative or runs past its end, or bytes are left over after the last field
 */
export function readMonoScript(reader: ObjectReader): MonoScript {
  const { version } = reader;
  // Rule for version-gated class readers (#36): an unknown version must not
  // fall through to the oldest branch, and below 3.4 no layout is known.
  if (version.every((part) => part === 0)) {
    throw new UnsupportedError(
      "Unity version",
      reader.unityVersion,
      `object ${reader.pathId}: a MonoScript's fields depend on the Unity version, ` +
        "and this file does not record one",
    );
  }
  if (!atLeast(version, 3, 4)) {
    throw new UnsupportedError(
      "Unity version",
      reader.unityVersion,
      `object ${reader.pathId}: no known MonoScript layout before Unity 3.4`,
    );
  }
  if (reader.platform === BuildTarget.NoTarget) {
    throw new UnsupportedError(
      "build target",
      "NoTarget",
      `object ${reader.pathId}: an editor file's MonoScript holds editor-only fields`,
    );
  }

  const base = readNamedObject(reader);
  const out: Partial<MonoScript> & NamedObject = { ...base };
  out.m_ExecutionOrder = reader.readInt32();
  // 5.0: the properties hash grew from a UInt32 to a Hash128.
  out.m_PropertiesHash = atLeast(version, 5, 0) ? readHash128(reader) : reader.readUInt32();
  out.m_ClassName = readStringField(reader, "MonoScript", "m_ClassName");
  out.m_Namespace = readStringField(reader, "MonoScript", "m_Namespace");
  out.m_AssemblyName = readStringField(reader, "MonoScript", "m_AssemblyName");
  // Gone from 2018.2.
  if (!atLeast(version, 2018, 2)) out.m_IsEditorScript = reader.readUInt8() !== 0;

  if (reader.remaining !== 0) {
    throw new CorruptError(
      `MonoScript ${reader.pathId} ends at ${reader.position} of its ${reader.byteSize} bytes`,
    );
  }
  // Every required field was set above.
  return out as MonoScript;
}

/** Sixteen bytes, keyed as `readTypeTree()` keys a `Hash128`. */
function readHash128(reader: ObjectReader): Hash128 {
  const out: Hash128 = {};
  for (let i = 0; i < 16; i++) out[`bytes[${i}]`] = reader.readUInt8();
  return out;
}
