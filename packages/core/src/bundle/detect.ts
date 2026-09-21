// Ported from AssetStudio/FileReader.cs (MIT, © Perfare / RazTools / Razviar)

import { UnsupportedError } from "../errors.js";

/**
 * What the first bytes of a file say it is.
 *
 * Container values spell the signature exactly as Unity writes it (`UnityFS`),
 * which is also what the fixture goldens record; the lower-case values name
 * things Unity gives no signature to.
 *
 * `resource` is upstream's fallback, not a positive match: anything that looks
 * like nothing else is raw asset bytes (`.resS` / `.resource`).
 */
export type FileType =
  | "UnityFS"
  | "UnityWeb"
  | "UnityRaw"
  | "UnityArchive"
  | "UnityWebData"
  | "gzip"
  | "brotli"
  | "zip"
  | "serialized"
  | "resource";

/**
 * Every type this library cannot open, and why - the single source of truth for
 * what {@link detectContainer} rejects, so a new {@link FileType} cannot become
 * silently supported. The value becomes the error's hint (R9).
 */
const UNSUPPORTED = {
  UnityArchive: "no upstream implementation to port",
  brotli: "no brotli decoder",
  zip: "extract the archive first",
  resource: "raw asset bytes, not a container",
} as const satisfies Partial<Record<FileType, string>>;

/** The subset of {@link FileType} that this library can open. */
export type SupportedFileType = Exclude<FileType, keyof typeof UNSUPPORTED>;

/** Upstream reads a NUL-terminated signature of at most 20 bytes. */
const SIGNATURE_MAX_LENGTH = 20;

const GZIP_MAGIC = [0x1f, 0x8b];
/** ASCII "brotli", which upstream looks for at a fixed offset, not at byte 0. */
const BROTLI_MAGIC = [0x62, 0x72, 0x6f, 0x74, 0x6c, 0x69];
const BROTLI_MAGIC_OFFSET = 0x20;
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
/** Second disk of a spanned zip; upstream treats it as a zip too. */
const ZIP_SPANNED_MAGIC = [0x50, 0x4b, 0x07, 0x08];

/** A serialized file needs a header; below this there is nothing to check. */
const SERIALIZED_MIN_LENGTH = 20;
/** Format version 22+ moved size and offset to 64-bit fields, growing the header. */
const SERIALIZED_LARGE_MIN_LENGTH = 48;

function hasMagic(data: Uint8Array, magic: readonly number[], offset = 0): boolean {
  return (
    data.length >= offset + magic.length && magic.every((byte, i) => data[offset + i] === byte)
  );
}

function readSignature(data: Uint8Array): string {
  let end = 0;
  while (end < SIGNATURE_MAX_LENGTH && end < data.length && data[end] !== 0) end++;
  // Signatures are ASCII, so byte-per-char is exact; other bytes only ever
  // produce a string that matches nothing, which is the same answer upstream's
  // UTF-8 decode gives.
  return String.fromCharCode(...data.subarray(0, end));
}

/**
 * Upstream's `FileReader.IsSerializedFile`: a raw SerializedFile has no magic
 * number, so the header is read and sanity-checked instead. Every field here is
 * big-endian, and the recorded file size has to be exactly the size of the
 * bytes we were handed - that is what keeps a resource file from being parsed
 * as a serialized one.
 */
function isSerializedFile(data: Uint8Array): boolean {
  const length = data.length;
  if (length < SERIALIZED_MIN_LENGTH) return false;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // m_MetadataSize (0) is read upstream but never checked, so it is skipped.
  let fileSize = BigInt(view.getUint32(4));
  const version = view.getUint32(8);
  let dataOffset = BigInt(view.getUint32(12));
  // m_Endianess (16) and three reserved bytes complete the small header.

  // 2020.1+ (format version 22, LargeFilesSupport): the 32-bit fields above are
  // superseded by 64-bit ones that follow the reserved bytes.
  if (version >= 22) {
    if (length < SERIALIZED_LARGE_MIN_LENGTH) return false;
    fileSize = view.getBigInt64(24);
    dataOffset = view.getBigInt64(32);
  }

  // Sizes are compared as bigint: a garbage 64-bit value must not lose
  // precision on its way to a number (R6), it must simply fail to match.
  if (fileSize !== BigInt(length)) return false;
  return dataOffset <= BigInt(length);
}

/**
 * Sniff what a file is from its leading bytes.
 *
 * Never throws and never guesses beyond upstream: input that matches nothing is
 * reported as `resource`, exactly as `FileReader.CheckFileType` does. Use
 * {@link detectContainer} to reject what cannot be opened.
 *
 * @param data whole file bytes; a short or empty array is fine
 * @returns the detected type
 */
export function detectFileType(data: Uint8Array): FileType {
  switch (readSignature(data)) {
    case "UnityFS":
      return "UnityFS";
    case "UnityWeb":
      return "UnityWeb";
    case "UnityRaw":
      return "UnityRaw";
    case "UnityArchive":
      return "UnityArchive";
    case "UnityWebData1.0":
      return "UnityWebData";
  }

  if (hasMagic(data, GZIP_MAGIC)) return "gzip";
  // Detected but never decoded: the plan ships no brotli decoder (§1, §7). It is
  // sniffed so the refusal can name brotli instead of mislabelling it a resource.
  if (hasMagic(data, BROTLI_MAGIC, BROTLI_MAGIC_OFFSET)) return "brotli";
  if (isSerializedFile(data)) return "serialized";
  if (hasMagic(data, ZIP_MAGIC) || hasMagic(data, ZIP_SPANNED_MAGIC)) return "zip";

  return "resource";
}

/**
 * Sniff a file and refuse the types this library cannot open.
 *
 * @param data whole file bytes
 * @returns the detected type, narrowed to what can be opened
 * @throws {UnsupportedError} naming the detected type, so a caller can tell
 *   "not supported" from "corrupt" without re-sniffing the bytes (R9)
 */
export function detectContainer(data: Uint8Array): SupportedFileType {
  const type = detectFileType(data);
  if (isUnsupported(type)) throw new UnsupportedError("container", type, UNSUPPORTED[type]);
  return type;
}

function isUnsupported(type: FileType): type is keyof typeof UNSUPPORTED {
  return type in UNSUPPORTED;
}
