// Ported from AssetStudio/AssetsManager.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Classes/Texture2D.cs (MIT, © Perfare / RazTools / Razviar)

import type { ResourceRef } from "../env.js";
import { CorruptError, ResourceNotFoundError } from "../errors.js";
import { ClassID } from "../serialized/ClassID.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import { baseName } from "../serialized/SerializedFile.js";
import { readTypeTree, type TypeTreeObject } from "../serialized/TypeTreeReader.js";
import { readAssetBundle, type AssetBundle } from "./AssetBundle.js";
import { readTexture2D, type Texture2D } from "./Texture2D.js";

/**
 * A `Texture2D` as `obj.read()` returns it: every field `readTexture2D` reads,
 * plus the image bytes wherever they live.
 */
export interface Texture2DData extends Texture2D {
  /**
   * The image data, every mip level, still encoded in `m_TextureFormat`:
   * `image data` when it is not empty, and otherwise `size` bytes of the
   * resource file `m_StreamData` names. When neither holds anything,
   * `obj.read()` throws `CorruptError` instead. Either way a view, never a
   * copy (R7), with the aliasing of the bytes it views.
   */
  imageData: Uint8Array;
}

/**
 * What `obj.read()` returns: a hardcoded class reader's result for a class
 * that has one ({@link Texture2DData} for a `Texture2D`), and the
 * `readTypeTree()` result for any other class.
 */
export type ObjectData =
  | Texture2DData
  | AssetBundle
  | TypeTreeObject;

/**
 * Reads the bytes a {@link ResourceRef} names, for the object it was read
 * from: the env's `readResource`, which `load()` hands to every object it
 * builds. Internal: not exported from the package.
 */
export type ResourceReader = (ref: ResourceRef, from: ObjectReader) => Uint8Array;

/** A hardcoded class reader, as the registry calls it. */
type ClassReader = (reader: ObjectReader, resources: ResourceReader | undefined) => ObjectData;

/**
 * The hardcoded class readers by class id (upstream `ReadAssets`' switch). A
 * class gets an entry once its reader is ported; everything else goes through
 * its type tree.
 */
const CLASS_READERS: ReadonlyMap<number, ClassReader> = new Map<number, ClassReader>([
  [ClassID.Texture2D, readTexture2DData],
  [ClassID.AssetBundle, readAssetBundle],
]);

/**
 * Read an object with the hardcoded reader of its class when there is one,
 * as upstream always prefers it, and with its type tree otherwise. Internal:
 * callers use `obj.read()`.
 *
 * Upstream's switch falls back to the bare `Object` fields; the type tree
 * reads every field instead, and a file without one is refused (R9) rather
 * than answered with a header.
 *
 * @param reader the object to read, rewound first
 * @param resources how to read resource files for it; `undefined` for a
 *   reader not built by `load()`
 * @throws {UnsupportedError} what the class reader throws, or, for a class
 *   without one, when the file has no type tree, naming the class id and path
 *   id
 * @throws {ResourceNotFoundError} when the data is in a resource file that is
 *   not loaded
 * @throws {CorruptError} when the data does not hold together
 */
export function readObjectData(
  reader: ObjectReader,
  resources: ResourceReader | undefined,
): ObjectData {
  const read = CLASS_READERS.get(reader.type);
  return read ? read(reader, resources) : readTypeTree(reader);
}

/**
 * `readTexture2D` with the image bytes resolved, as upstream's `Texture2D`
 * sets `image_data`: non-empty inline data wins, since upstream only reads
 * `m_StreamData` when the inline size is 0 (UnityPy agrees). Then a non-empty
 * `m_StreamData.path` is read.
 *
 * With neither, upstream hands back 0 bytes; UnityPy raises, and so does this
 * (R9, decided on PR #118), rather than pass an empty image on as a texture.
 *
 * @throws {CorruptError} when the inline data is empty and `m_StreamData` is
 *   missing or its `path` is empty
 */
function readTexture2DData(
  reader: ObjectReader,
  resources: ResourceReader | undefined,
): Texture2DData {
  const texture = readTexture2D(reader);
  const inline = texture["image data"];
  if (inline.length > 0) return { ...texture, imageData: inline };
  const stream = texture.m_StreamData;
  if (!stream?.path) {
    throw new CorruptError(
      `Texture2D ${reader.pathId} has no image data, neither inline nor in a .resS ` +
        "(image data is empty and m_StreamData.path names no file)",
    );
  }
  // A reader built outside `load()` has no files to look in.
  if (!resources) throw new ResourceNotFoundError(stream.path, baseName(stream.path));
  return { ...texture, imageData: resources(stream, reader) };
}
