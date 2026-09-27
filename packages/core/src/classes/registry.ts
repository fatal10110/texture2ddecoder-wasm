// Ported from AssetStudio/AssetsManager.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Classes/Texture2D.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Classes/MonoBehaviour.cs (MIT, © Perfare / RazTools / Razviar)

import type { ResourceRef } from "../env.js";
import { CorruptError, ResourceNotFoundError } from "../errors.js";
import type { BuildTarget } from "../serialized/BuildTarget.js";
import { ClassID } from "../serialized/ClassID.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import { baseName } from "../serialized/SerializedFile.js";
import { readTypeTree, type TypeTreeObject } from "../serialized/TypeTreeReader.js";
import { readAssetBundle, type AssetBundle } from "./AssetBundle.js";
import { readTexture2D, type Texture2D } from "./Texture2D.js";
import { readMonoBehaviour, type MonoBehaviour } from "./MonoBehaviour.js";
import { readMonoScript, type MonoScript } from "./MonoScript.js";
import { readSprite, type Sprite } from "./Sprite.js";
import { readSpriteAtlas, type SpriteAtlas } from "./SpriteAtlas.js";
import { readTextAsset, type TextAsset } from "./TextAsset.js";

/**
 * A `Texture2D` as `obj.read()` returns it: every field `readTexture2D` reads,
 * plus the image bytes wherever they live and the platform they were built for.
 */
export interface Texture2DData extends Texture2D {
  /**
   * The platform the object's file was built for (`ObjectReader.platform`,
   * upstream's `Texture2D.platform`). Not a Texture2D field: decoding needs it,
   * since Switch and Xbox 360 builds store the image data in their own layout.
   */
  platform: BuildTarget;
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
 * A `MonoBehaviour` as `obj.read()` returns it: the whole object as
 * `readTypeTree()` reads it when the file has a type tree, and otherwise the
 * header alone. The header fields have the same values and shapes either
 * way; the script's own fields are there only with a type tree.
 *
 * In a player build the type tree starts with the header, in the same order.
 * An editor file's (`BuildTarget.NoTarget`) type tree puts editor fields
 * around it: `m_ObjectHideFlags` and the prefab pointers first,
 * `m_EditorHideFlags` between `m_Enabled` and `m_Script`, and, from Unity 4.2,
 * `m_EditorClassIdentifier` after `m_Name`. Such a file always has a type
 * tree; the header reader alone refuses it.
 */
export type MonoBehaviourData = MonoBehaviour & { [field: string]: unknown };

/**
 * What `obj.read()` returns: a hardcoded class reader's result for a class
 * that has one ({@link Texture2DData} for a `Texture2D`, `TextAsset`,
 * `MonoScript`, {@link MonoBehaviourData} for a `MonoBehaviour`, `Sprite`,
 * `SpriteAtlas`), and the `readTypeTree()` result for any other class.
 */
export type ObjectData =
  | Texture2DData
  | AssetBundle
  | TextAsset
  | MonoScript
  | MonoBehaviourData
  | Sprite
  | SpriteAtlas
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
  [ClassID.TextAsset, readTextAsset],
  [ClassID.MonoScript, readMonoScript],
  [ClassID.MonoBehaviour, readMonoBehaviourData],
  [ClassID.Sprite, readSprite],
  [ClassID.SpriteAtlas, readSpriteAtlas],
]);

/**
 * Read an object with the hardcoded reader of its class when there is one,
 * as upstream always prefers it, and with its type tree otherwise. Internal:
 * callers use `obj.read()`.
 *
 * The one exception is a `MonoBehaviour` whose file has a type tree: its
 * hardcoded reader reads only the header, so the type tree is read instead
 * (see {@link MonoBehaviourData}).
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
  if (inline.length > 0) return { ...texture, imageData: inline, platform: reader.platform };
  const stream = texture.m_StreamData;
  if (!stream?.path) {
    throw new CorruptError(
      `Texture2D ${reader.pathId} has no image data, neither inline nor in a .resS ` +
        "(image data is empty and m_StreamData.path names no file)",
    );
  }
  // A reader built outside `load()` has no files to look in.
  if (!resources) throw new ResourceNotFoundError(stream.path, baseName(stream.path));
  return { ...texture, imageData: resources(stream, reader), platform: reader.platform };
}

/**
 * The whole `MonoBehaviour` when there is a way to read it: its type tree,
 * which starts with the header `readMonoBehaviour` reads and goes on through
 * the script's fields. Without one, the header alone, which is all a file
 * built without type trees gives up without the script's assembly (upstream
 * reads the rest through Mono.Cecil, out of scope, plan §7).
 *
 * Unlike the other hardcoded readers, which read the whole object, the header
 * reader stops where the script's fields start, so preferring it as upstream
 * does would drop data the file holds.
 */
function readMonoBehaviourData(reader: ObjectReader): MonoBehaviourData {
  const nodes = reader.serializedType?.nodes;
  // The type tree holds the header under the same names: its first four fields
  // in a player build, with editor fields around them in an editor file.
  if (nodes && nodes.length > 0) return readTypeTree(reader) as MonoBehaviourData;
  // An interface has no implicit index signature; the header has no other keys.
  return readMonoBehaviour(reader) as MonoBehaviourData;
}
