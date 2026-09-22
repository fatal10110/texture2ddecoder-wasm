// brotliDecompress/lzhamDecompress stay internal: neither is reachable from a
// stock bundle, so two always-throwing symbols are not public API.
export { NodeFlags, readBundle } from "./bundle/BundleFile.js";
export type { BundleFile, BundleHeader, StreamFile } from "./bundle/BundleFile.js";
export { detectContainer, detectFileType } from "./bundle/detect.js";
export type { FileType, SupportedFileType } from "./bundle/detect.js";
export { readWebFile } from "./bundle/WebFile.js";
export type { WebFile } from "./bundle/WebFile.js";
export { gunzip, unzlib } from "./codec/inflate.js";
export { decompressLz4 } from "./codec/lz4.js";
export { lzmaDecompress } from "./codec/lzma.js";
export { load } from "./env.js";
export type { Env, LoadedFile, LoadInput } from "./env.js";
export { CorruptError, UnsupportedError } from "./errors.js";
export { BinaryReader, type Endian } from "./io/BinaryReader.js";
