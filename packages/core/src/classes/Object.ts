// Ported from AssetStudio/Classes/Object.cs (MIT, © Perfare / RazTools / Razviar)

import { BuildTarget } from "../serialized/BuildTarget.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";

/**
 * The fields every Unity object starts with (upstream `Object`). Named
 * `UnityObject` so that importing it never shadows the global `Object`.
 *
 * A class reader returns its own fields spread over its base class's, so the
 * result of any reader built on this one has these keys too.
 */
export interface UnityObject {
  /**
   * Only in a file built for the editor (`BuildTarget.NoTarget`); a player
   * build does not store it, and then the key is absent.
   */
  m_ObjectHideFlags?: number;
}

/**
 * Read the header every Unity object starts with, from the object's first
 * byte: rewinds `reader` to position 0 first, as upstream's `Reset()` does,
 * so a class reader can always start here.
 *
 * Only a file built for the editor has a header at all; for any other
 * platform nothing is read and the result is empty.
 *
 * @param reader the object's reader, left just past the header
 * @throws {CorruptError} when the object is too short for its header
 */
export function readObject(reader: ObjectReader): UnityObject {
  reader.position = 0;
  if (reader.platform !== BuildTarget.NoTarget) return {};
  return { m_ObjectHideFlags: reader.readUInt32() };
}
