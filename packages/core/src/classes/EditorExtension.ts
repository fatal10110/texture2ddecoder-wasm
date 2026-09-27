// Ported from AssetStudio/Classes/EditorExtension.cs (MIT, © Perfare / RazTools / Razviar)

import { BuildTarget } from "../serialized/BuildTarget.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import { readObject, type UnityObject } from "./Object.js";
import { readPPtr, type PPtr } from "./PPtr.js";

/**
 * The fields of an `EditorExtension` (upstream's base of every asset and
 * component): the {@link UnityObject} header plus the editor's prefab links.
 *
 * ponytail: the names are upstream's, which are Unity's before 2018.3; its
 * prefab rework renamed them and added `m_PrefabAsset`, and upstream reads the
 * two old fields for every version. Only an editor file (`NoTarget`) holds
 * them and no fixture is one; if one ever turns up, gate the third PPtr on
 * the version.
 */
export interface EditorExtension extends UnityObject {
  /** Only in a file built for the editor, like `m_ObjectHideFlags`. */
  m_PrefabParentObject?: PPtr;
  /** Only in a file built for the editor; upstream reads it as `PPtr<Prefab>`. */
  m_PrefabInternal?: PPtr;
}

/**
 * Read an `EditorExtension` from the object's first byte: the object header,
 * then, in a file built for the editor, two prefab pointers.
 *
 * @param reader the object's reader, rewound first and left just past these
 *   fields
 * @throws {CorruptError} when the object is too short for them
 */
export function readEditorExtension(reader: ObjectReader): EditorExtension {
  const base = readObject(reader);
  if (reader.platform !== BuildTarget.NoTarget) return base;
  return {
    ...base,
    m_PrefabParentObject: readPPtr(reader),
    m_PrefabInternal: readPPtr(reader),
  };
}
