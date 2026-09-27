import type { ObjectReader } from "../serialized/ObjectReader.js";
import { readCount } from "../serialized/TypeTree.js";

/**
 * Read a class reader's string field: an `Int32` byte count, that many UTF-8
 * bytes, then padding to the next 4-byte boundary. Internal to the class
 * readers, not exported from the package.
 *
 * Unlike `BinaryReader.readAlignedString`, which `readTypeTree()` uses and
 * which, like upstream, reads a negative length or one past the object's end
 * as `""`, this throws: a class reader must not return a truncated or garbled
 * object as a whole one (R9).
 *
 * @param reader the object's reader, left past the string and its padding
 * @param owner the class, for the error message
 * @param field the field, for the error message
 * @throws {CorruptError} when the count is negative, runs past the object's
 *   end, or the object ends inside the count itself
 */
export function readStringField(reader: ObjectReader, owner: string, field: string): string {
  const length = readCount(reader, `${owner} ${reader.pathId} ${field} byte`);
  const text = reader.readString(length);
  reader.align();
  return text;
}
