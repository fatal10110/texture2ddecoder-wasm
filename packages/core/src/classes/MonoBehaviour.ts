// Ported from AssetStudio/Classes/MonoBehaviour.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Classes/Behaviour.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Classes/Component.cs (MIT, © Perfare / RazTools / Razviar)

import { UnsupportedError } from "../errors.js";
import { BuildTarget } from "../serialized/BuildTarget.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import { readEditorExtension, type EditorExtension } from "./EditorExtension.js";
import { readPPtr, type PPtr } from "./PPtr.js";
import { readStringField } from "./TextAsset.js";

/**
 * The header of a `MonoBehaviour`, the fields Unity writes before the
 * script's own serialized fields, as a player build stores them. Keys, their
 * order and their values agree with the first fields `readTypeTree()` gives
 * for the same object.
 */
export interface MonoBehaviour extends EditorExtension {
  /** The GameObject it is attached to; a null pointer for a ScriptableObject. */
  m_GameObject: PPtr;
  /** A `UInt8`, 1 when enabled, kept as the number the file holds. */
  m_Enabled: number;
  /** The `MonoScript` naming its C# class. */
  m_Script: PPtr;
  /** The asset's name; `""` for a component on a GameObject. */
  m_Name: string;
}

/**
 * Read a `MonoBehaviour`'s header from the object's first byte: the
 * `Component` field `m_GameObject`, the `Behaviour` field `m_Enabled` and its
 * padding, then `m_Script` and `m_Name`.
 *
 * The rest of the object is the script's own fields, whose layout only its
 * type tree gives; read it with `readTypeTree()`, which starts with this same
 * header. Without a type tree, upstream derives the layout from the script's
 * assembly (Mono.Cecil), which is out of scope (plan §7).
 *
 * No field depends on the Unity version, so a version-stripped file reads.
 * Only player builds are read: an editor file (`BuildTarget.NoTarget`) has
 * `m_EditorHideFlags` between `m_Enabled` and `m_Script`, which upstream does
 * not read either.
 *
 * @param reader the object's reader, rewound first and left just past
 *   `m_Name` and its padding, where the script's fields start
 * @throws {UnsupportedError} of kind `"build target"` for an editor file
 * @throws {CorruptError} when the object ends inside the header, or
 *   `m_Name`'s length runs past its end
 */
export function readMonoBehaviour(reader: ObjectReader): MonoBehaviour {
  if (reader.platform === BuildTarget.NoTarget) {
    throw new UnsupportedError(
      "build target",
      "NoTarget",
      `object ${reader.pathId}: an editor file's MonoBehaviour header holds editor-only fields`,
    );
  }
  const base = readEditorExtension(reader);
  const m_GameObject = readPPtr(reader);
  const m_Enabled = reader.readUInt8();
  reader.align();
  return {
    ...base,
    m_GameObject,
    m_Enabled,
    m_Script: readPPtr(reader),
    m_Name: readStringField(reader, "MonoBehaviour", "m_Name"),
  };
}
