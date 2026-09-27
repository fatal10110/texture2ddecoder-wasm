// Ported from AssetStudio/Classes/NamedObject.cs (MIT, © Perfare / RazTools / Razviar)

import type { ObjectReader } from "../serialized/ObjectReader.js";
import { readEditorExtension, type EditorExtension } from "./EditorExtension.js";

/** The fields of a `NamedObject`: an {@link EditorExtension} plus its name. */
export interface NamedObject extends EditorExtension {
  /** The asset's name; `""` when Unity stored none. */
  m_Name: string;
}

/**
 * Read a `NamedObject` from the object's first byte: the `EditorExtension`
 * fields, then `m_Name`.
 *
 * This is the base of every asset class (`Texture2D`, `TextAsset`, `Mesh`,
 * `AssetBundle`, ...), and needs no type tree, so it names the objects of a
 * bundle built without one. It does not check the class: on an object that is
 * not a `NamedObject` (a component such as `MonoBehaviour`) the bytes it reads
 * are some other field.
 *
 * @param reader the object's reader, rewound first and left just past
 *   `m_Name` and its padding
 * @throws {CorruptError} when the object is too short for these fields
 */
export function readNamedObject(reader: ObjectReader): NamedObject {
  const base = readEditorExtension(reader);
  return { ...base, m_Name: reader.readAlignedString() };
}
