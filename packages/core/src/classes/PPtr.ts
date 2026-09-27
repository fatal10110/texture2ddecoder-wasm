// Ported from AssetStudio/Classes/PPtr.cs (MIT, © Perfare / RazTools / Razviar)

import type { SerializedFileEntry } from "../env.js";
import { SerializedFileFormatVersion as V } from "../serialized/FormatVersion.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";

/**
 * A pointer to an object, as a typetree holds it: which file, then which
 * object in that file. Field names keep Unity's spelling.
 */
export interface PPtr {
  /** 0 for the file the pointer was read from, otherwise 1 + an index into its `externals`. */
  m_FileID: number;
  /** Path id of the object in that file; 0 is a null pointer (D9). */
  m_PathID: bigint;
}

/**
 * What a {@link PPtr} points at. Every way a pointer can fail to reach an
 * object is a result rather than an exception, because a dangling pointer is
 * ordinary data: a dependency bundle that was not loaded, a stripped object.
 *
 * - `found`: the object.
 * - `null`: `m_PathID` is 0 (or `m_FileID` is negative), so it points nowhere.
 * - `fileIdOutOfRange`: `m_FileID` is past the end of the file's `externals`.
 * - `fileNotLoaded`: the external file it names is not in the env; load the
 *   file called `fileName` alongside to resolve it.
 * - `objectNotFound`: the file is loaded but holds no object with that path id.
 */
export type PPtrResolution =
  | { status: "found"; object: ObjectReader }
  | { status: "null" }
  | { status: "fileIdOutOfRange" }
  | { status: "fileNotLoaded"; fileName: string }
  | { status: "objectNotFound"; fileName: string };

/**
 * Read a pointer from object data (upstream's `PPtr(ObjectReader)`
 * constructor): an `Int32` file id, then the path id. Internal to the class
 * readers, not exported from the package.
 *
 * @param reader the object's reader, left just past the pointer
 * @throws {CorruptError} when the object ends inside the pointer
 */
export function readPPtr(reader: ObjectReader): PPtr {
  const m_FileID = reader.readInt32();
  // Format 14+ (5.0.0): path ids are 64-bit.
  const m_PathID = reader.format < V.Unknown_14 ? BigInt(reader.readInt32()) : reader.readInt64();
  return { m_FileID, m_PathID };
}

/**
 * Upstream's `PPtr.TryGet`: pick the file through the source file's externals,
 * then look the path id up in it.
 *
 * @param pptr the pointer
 * @param source the file the pointer was read from
 * @param fileNamed the loaded file an external's `fileName` means, if any
 */
export function resolvePPtr(
  pptr: PPtr,
  source: SerializedFileEntry,
  fileNamed: (fileName: string) => SerializedFileEntry | undefined,
): PPtrResolution {
  const { m_FileID: fileId, m_PathID: pathId } = pptr;
  // Upstream's `IsNull`.
  if (pathId === 0n || fileId < 0) return { status: "null" };

  let target = source;
  if (fileId !== 0) {
    const external = source.file.externals[fileId - 1];
    if (!external) return { status: "fileIdOutOfRange" };
    const found = fileNamed(external.fileName);
    if (!found) return { status: "fileNotLoaded", fileName: external.fileName };
    target = found;
  }

  const object = target.objects.get(pathId);
  return object ? { status: "found", object } : { status: "objectNotFound", fileName: target.name };
}
