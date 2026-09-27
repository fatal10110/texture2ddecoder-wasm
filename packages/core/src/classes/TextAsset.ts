// Ported from AssetStudio/Classes/TextAsset.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError, UnsupportedError } from "../errors.js";
import { BinaryReader } from "../io/BinaryReader.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import { readCount } from "../serialized/TypeTree.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
import { readStringField } from "./strings.js";
import { atLeast } from "./version.js";

/**
 * The fields of a `TextAsset`, under Unity's names and in Unity's order, as
 * `readTypeTree()` gives them, except that `m_Script` is the raw bytes here
 * rather than a string: a TextAsset holds any file (`.txt`, `.json`, `.bytes`),
 * and binary content does not survive a UTF-8 decode. {@link textAssetString}
 * decodes it.
 */
export interface TextAsset extends NamedObject {
  /** The file's content, a view into the object's bytes (R7). */
  m_Script: Uint8Array;
  /** Unity 3.4 to 2017.1 only: the source asset's path. */
  m_PathName?: string;
}

/**
 * Read a `TextAsset` from the object's first byte: the `NamedObject` fields,
 * then `m_Script`, and `m_PathName` where Unity wrote it.
 *
 * Unity's type trees (UnityPy's TPK data) have `m_PathName` after `m_Script`
 * from 3.4 until 2017.1, in player and editor files alike; upstream does not
 * read it. Below 3.4 there is no type tree data, so such a file is refused.
 *
 * A file of format 7 or later whose Unity version was stripped
 * (`[0, 0, 0, 0]`) is still read, under the rule for version-stripped files
 * (#36): the two layouts differ only by the trailing `m_PathName`, an aligned
 * string of at least 4 bytes, so the bytes left after `m_Script` pick one, and
 * the end-of-object check refuses anything that fits neither. A file below
 * format 7 also has `[0, 0, 0, 0]` but was written by Unity 2.x, before any
 * known layout, so it is refused.
 *
 * The object must end exactly after its last field (upstream does not check).
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`, for a Unity version below 3.4, or `[0, 0, 0, 0]`
 *   in a file below format 7; for an editor file with no known header layout,
 *   as `readNamedObject` does
 * @throws {CorruptError} when the object ends early, the `m_Script` or
 *   `m_PathName` byte count is negative or runs past the object's end, or bytes
 *   are left over after the last field
 */
export function readTextAsset(reader: ObjectReader): TextAsset {
  const { version } = reader;
  const stripped = version.every((part) => part === 0);
  // #36: only a stripped version of a format 7+ file may leave the layout to
  // the bytes; below 3.4 no layout is known at all.
  if (stripped ? reader.format < 7 : !atLeast(version, 3, 4)) {
    throw new UnsupportedError(
      "Unity version",
      reader.unityVersion,
      `object ${reader.pathId}: no known TextAsset layout before Unity 3.4`,
    );
  }

  const base = readNamedObject(reader);
  const scriptBytes = readCount(reader, `TextAsset ${reader.pathId} m_Script byte`);
  const m_Script = reader.readBytes(scriptBytes);
  reader.align();
  const out: TextAsset = { ...base, m_Script };

  // 3.4 to 2017.1: m_PathName follows; gone from 2017.1. Stripped: the bytes
  // left decide, see above.
  // ponytail: 2017.1.0b1 still has m_PathName (TPK drops it at b2), and the
  // gates compare release numbers only (see `atLeast`), so that beta fails the
  // end-of-object check. Compare `buildType` if it ever matters.
  const hasPathName = stripped ? reader.remaining > 0 : !atLeast(version, 2017, 1);
  if (hasPathName) out.m_PathName = readStringField(reader, "TextAsset", "m_PathName");

  if (reader.remaining !== 0) {
    throw new CorruptError(
      `TextAsset ${reader.pathId} ends at ${reader.position} of its ${reader.byteSize} bytes`,
    );
  }
  return out;
}

/**
 * A TextAsset's content as text: `m_Script` decoded as UTF-8, with the
 * decoding every string of this library uses (`BinaryReader.readString`):
 * invalid sequences become U+FFFD instead of throwing.
 *
 * @param textAsset what `readTextAsset` or `obj.read()` returned for a
 *   TextAsset
 * @returns the text; equal to the `m_Script` string `readTypeTree()` gives for
 *   the same object
 */
export function textAssetString(textAsset: Pick<TextAsset, "m_Script">): string {
  const bytes = textAsset.m_Script;
  return new BinaryReader(bytes).readString(bytes.length);
}
