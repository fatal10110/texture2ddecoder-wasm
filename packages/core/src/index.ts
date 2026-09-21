// brotliDecompress/lzhamDecompress stay internal until the codec dispatch in
// #16/#17 settles - two always-throwing symbols are not public API yet.
export { NodeFlags, readBundle } from "./bundle/BundleFile.js";
export type { BundleFile, BundleHeader, StreamFile } from "./bundle/BundleFile.js";
export { detectContainer, detectFileType } from "./bundle/detect.js";
export type { FileType, SupportedFileType } from "./bundle/detect.js";
export { gunzip, unzlib } from "./codec/inflate.js";
export { decompressLz4 } from "./codec/lz4.js";
export { CorruptError, UnsupportedError } from "./errors.js";
export { BinaryReader, type Endian } from "./io/BinaryReader.js";
