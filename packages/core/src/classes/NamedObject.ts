// Ported from AssetStudio/Classes/NamedObject.cs (MIT, © Perfare / RazTools / Razviar)

import { classIdName } from "../serialized/ClassID.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import { readEditorExtension, type EditorExtension } from "./EditorExtension.js";
import { readStringField } from "./strings.js";

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
 * are some other field, or throw as a bad `m_Name` length.
 *
 * `m_Name` is read strictly, like every string field of the class readers: a
 * negative length or one past the object's end throws instead of reading as
 * `""`, as the lenient `readAlignedString` (upstream's, and `readTypeTree()`'s)
 * does. A class reader must not pass a corrupt object off as a nameless one
 * (R9).
 *
 * @param reader the object's reader, rewound first and left just past
 *   `m_Name` and its padding
 * @throws {UnsupportedError} for an editor file with no known header layout,
 *   as `readEditorExtension` does
 * @throws {CorruptError} when the object is too short for these fields, or
 *   `m_Name`'s length is negative or runs past the object's end
 */
export function readNamedObject(reader: ObjectReader): NamedObject {
  const base = readEditorExtension(reader);
  // Named after the object's class: the header is the same for every class.
  const owner = classIdName(reader.type) ?? `class ${reader.type}`;
  return { ...base, m_Name: readStringField(reader, owner, "m_Name") };
}
