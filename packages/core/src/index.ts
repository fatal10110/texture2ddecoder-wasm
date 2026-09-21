// brotliDecompress/lzhamDecompress stay internal until the codec dispatch in
// #16/#17 settles - two always-throwing symbols are not public API yet.
export { gunzip, unzlib } from "./codec/inflate.js";
export { CorruptError, UnsupportedError } from "./errors.js";
