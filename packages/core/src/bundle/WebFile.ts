// Ported from AssetStudio/WebFile.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError, UnsupportedError } from "../errors.js";
import { BinaryReader } from "../io/BinaryReader.js";
import type { StreamFile } from "./BundleFile.js";

/**
 * Signature prefix Unity's web player writes. The version follows it in the
 * same string (`"UnityWebData1.0"`), so the check is a prefix, not an equality.
 */
const SIGNATURE_PREFIX = "UnityWebData";

/** Upstream reads a NUL-terminated signature of at most 20 bytes. */
const SIGNATURE_MAX_LENGTH = 20;

/** A parsed `UnityWebData` container and the files it holds. */
export interface WebFile {
  /** Signature including its version, e.g. `"UnityWebData1.0"`. */
  signature: string;
  /** Every file in header order; {@link StreamFile.flags} is always 0. */
  files: StreamFile[];
}

/**
 * Parse a `UnityWebData` container (the Web player's asset package) into its
 * files.
 *
 * The container is a flat table of offset / length / path triples followed by
 * the file bytes; it holds bundles and SerializedFiles, but does not compress
 * anything itself. A gzip or brotli wrapper around one is the caller's to
 * remove first, exactly as upstream's `FileReader` does it (#19).
 *
 * @param data whole file bytes; kept by reference, never copied (R7)
 * @returns the signature and every file, in header order
 * @throws {UnsupportedError} when the signature is not a `UnityWebData` one
 * @throws {CorruptError} when the header is truncated or an entry points
 *   outside the file
 */
export function readWebFile(data: Uint8Array): WebFile {
  // The only Unity container that is little-endian throughout; the bundle
  // headers next to it are big-endian.
  const reader = new BinaryReader(data, "little");

  const signature = reader.readStringToNull(SIGNATURE_MAX_LENGTH);
  if (!signature.startsWith(SIGNATURE_PREFIX)) {
    throw new UnsupportedError("container", signature || "(none)", "not a UnityWebData file");
  }

  // The header length doubles as the offset of the first file, so the entry
  // table is read until the cursor reaches it rather than by a count.
  const headerLength = reader.readInt32();
  if (headerLength < reader.position) {
    throw new CorruptError(
      `web file header of ${headerLength} bytes ends before its own ` +
        `${reader.position} byte signature`,
    );
  }

  const files: StreamFile[] = [];
  while (reader.position < headerLength) {
    const offset = reader.readInt32();
    const length = reader.readInt32();
    const pathLength = reader.readInt32();
    // Signed on disk, so a negative length has to be refused before it reaches
    // the reader, which treats a negative count as a caller bug (RangeError).
    if (pathLength < 0) {
      throw new CorruptError(`web file path length ${pathLength} is negative`);
    }
    const path = reader.readString(pathLength);
    files.push({ path, data: cut(data, path, offset, length), flags: 0 });
  }
  return { signature, files };
}

/**
 * Cut one file out of the container.
 *
 * Both fields are signed on disk, so a negative one has to be caught here:
 * `subarray` would silently count it from the end of the file and hand back
 * someone else's bytes (R9).
 */
function cut(data: Uint8Array, path: string, offset: number, length: number): Uint8Array {
  const end = offset + length;
  if (offset < 0 || length < 0 || end > data.length) {
    throw new CorruptError(
      `web file "${path}" spans ${offset}..${end} but the file holds ${data.length} bytes`,
    );
  }
  return data.subarray(offset, end);
}
