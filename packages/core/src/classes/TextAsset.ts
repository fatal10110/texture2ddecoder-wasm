// Ported from AssetStudio/Classes/TextAsset.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError } from "../errors.js";
import { BinaryReader } from "../io/BinaryReader.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import { readCount } from "../serialized/TypeTree.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
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
 * read it. With a version from 3.4 on, the version decides. It is the last
 * field, so when the version gives no layout - the file does not record one
 * (`[0, 0, 0, 0]`: stripped, or a loose file below format 7), or it is older
 * than 3.4, where no type tree data says - whether it is there shows in the
 * bytes left after `m_Script`, and no version is needed. That keeps a
 * TextAsset of a version-stripped bundle readable, where the #36 rule would
 * have a reader that guesses from the version refuse it.
 *
 * The object must end exactly after its last field (upstream does not check).
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} for an editor file with no known header layout,
 *   as `readNamedObject` does
 * @throws {CorruptError} when the object ends early, the `m_Script` byte count
 *   is negative or runs past the object's end, `m_PathName`'s length runs past
 *   it, or bytes are left over after the last field
 */
export function readTextAsset(reader: ObjectReader): TextAsset {
  const base = readNamedObject(reader);
  const m_Script = reader.readBytes(readCount(reader, "m_Script byte"));
  reader.align();
  const out: TextAsset = { ...base, m_Script };

  const { version } = reader;
  // 3.4 to 2017.1: m_PathName follows; gone from 2017.1. Below 3.4, which
  // includes an unknown [0, 0, 0, 0], the bytes left decide.
  const hasPathName = atLeast(version, 3, 4)
    ? !atLeast(version, 2017, 1)
    : reader.remaining > 0;
  if (hasPathName) {
    out.m_PathName = readStringField(reader, "TextAsset", "m_PathName");
  }

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

/**
 * `readAlignedString` for a class reader's field, except that a length past
 * the object's end throws: upstream reads it as `""`, and so would return a
 * truncated object as a whole one. Internal to the class readers.
 *
 * @param reader the object's reader, left past the string and its padding
 * @param owner the class, for the error message
 * @param field the field, for the error message
 * @throws {CorruptError} when the length prefix, or the length it gives, runs
 *   past the object's end
 */
export function readStringField(reader: ObjectReader, owner: string, field: string): string {
  const at = reader.position;
  const length = reader.readInt32();
  if (length > reader.remaining) {
    throw new CorruptError(
      `${owner} ${reader.pathId} ${field} of ${length} bytes at offset ${at} ` +
        `runs past the ${reader.remaining} bytes left`,
    );
  }
  reader.position = at;
  return reader.readAlignedString();
}
