import { readMonoBehaviour } from "./classes/MonoBehaviour.js";
import { readNamedObject } from "./classes/NamedObject.js";
import type { PPtr, PPtrResolution } from "./classes/PPtr.js";
import type { Env } from "./env.js";
import { classReaderName, readAssetData, type AssetDataMap } from "./classes/registry.js";
import { ClassID, classIdName } from "./serialized/ClassID.js";
import type { ObjectReader } from "./serialized/ObjectReader.js";
import { readTypeTreeName, type TypeTreeObject } from "./serialized/TypeTreeReader.js";

export type { AssetDataMap } from "./classes/registry.js";

/**
 * The class name of an asset whose class has a hardcoded reader: a key of
 * {@link AssetDataMap}.
 */
export type KnownAssetType = keyof AssetDataMap;

/**
 * An asset's {@link Asset.type}: the class name for a class with a hardcoded
 * reader, and `"Other"` for every other class, whose name is in
 * {@link Asset.typeName}.
 *
 * `"Other"` rather than the class name typed as `string`: a union member whose
 * discriminant is `string` matches every `case`, so `switch (asset.type)` would
 * no longer narrow `data`.
 */
export type AssetType = KnownAssetType | "Other";

/** The fields every {@link Asset} has, for one `type` and its `data`. */
interface AssetOf<T extends AssetType, D> {
  /** Discriminant: narrows {@link data} (see {@link AssetType}). */
  readonly type: T;
  /**
   * The class name (`classIdName(classId)`), for every class, or
   * `"class <id>"` for a class id this library does not name.
   */
  readonly typeName: string;
  /** Unity class id (`ClassID`), the number the file holds. */
  readonly classId: number;
  /**
   * `m_Name`, or `""` when the class has none or it cannot be read without
   * its type tree (see {@link Env.assets}). Read on first access and kept.
   */
  readonly name: string;
  /**
   * The asset's path in the editor project, as an `AssetBundle` object's
   * `m_Container` lists it (`"assets/ui/icon.png"`, lower-cased by Unity), or
   * `undefined` when no container entry points at it. Read on first access of
   * any asset's `path` or of `Env.get`, from every `AssetBundle` loaded.
   */
  readonly path: string | undefined;
  /** Object id within its file (D9). */
  readonly pathId: bigint;
  /** Name of the SerializedFile holding it: a bundle node (`"CAB-<hash>"`) or a loose file. */
  readonly file: string;
  /** Size of the object's data in bytes. */
  readonly byteSize: number;
  /**
   * The object's data, typed by {@link type}: for a class with a hardcoded
   * reader, what `reader.read()` returns under camelCase names without the
   * `m_` prefix ({@link AssetDataMap}; each field's JSDoc names its Unity
   * field), and for `"Other"` the `readTypeTree()` result, under Unity's
   * names. Read on first access and kept; a failed read is not kept, and
   * throws again on the next access.
   */
  readonly data: D;
  /** The low-level reader, for `readTypeTree()`, `Env.resolve` and `Env.readResource`. */
  readonly reader: ObjectReader;
  /**
   * The env that loaded it, whose `resolve` and `readResource` take its
   * {@link reader}: what a free function over assets needs to follow the
   * asset's pointers (a Sprite's texture, #185).
   */
  readonly env: Env;
}

/**
 * One object of an {@link Env}, as `env.assets()` yields it: plain data with a
 * discriminant, {@link AssetOf.type}. A `switch (asset.type)` narrows
 * `data` to that class's shape ({@link AssetDataMap}), and to
 * `TypeTreeObject` for `"Other"`.
 *
 * There are no methods: what an asset can be turned into is a free function
 * taking it.
 *
 * @typeParam T the types to narrow to, all of them by default
 */
export type Asset<T extends AssetType = AssetType> = T extends KnownAssetType
  ? AssetOf<T, AssetDataMap[T]>
  : AssetOf<"Other", TypeTreeObject>;

/**
 * Classes whose data starts with the `NamedObject` header, so `m_Name` can be
 * read without a type tree: those AssetStudio derives from `NamedObject`
 * (its `Classes/`), and `AssetBundleManifest`, whose type tree starts with
 * `m_Name` too. Any other class without a type tree is named `""`.
 */
const NAMED_CLASSES: ReadonlySet<number> = new Set([
  ClassID.AnimationClip,
  ClassID.AnimatorController,
  ClassID.AnimatorOverrideController,
  ClassID.AssetBundle,
  ClassID.AssetBundleManifest,
  ClassID.AudioClip,
  ClassID.Avatar,
  ClassID.Font,
  ClassID.Material,
  ClassID.Mesh,
  ClassID.MonoScript,
  ClassID.MovieTexture,
  ClassID.Shader,
  ClassID.Sprite,
  ClassID.SpriteAtlas,
  ClassID.TextAsset,
  ClassID.Texture2D,
  ClassID.VideoClip,
]);

/** Where each asset's container path comes from, built by {@link indexContainers}. */
export interface ContainerIndex {
  /** Asset to its first container path. */
  pathOf: Map<ObjectReader, string>;
  /** Lower-cased container path to the first asset listed under it. */
  byPath: Map<string, ObjectReader>;
}

/**
 * Build the {@link Asset} of one object. Internal: `Env.assets()` builds one
 * per object, once.
 *
 * @param reader the object
 * @param source the containers the object's file was found under, outermost
 *   first, then the file, for error messages
 * @param containers the env's container index, built on first call
 * @param env the env building it
 */
export function makeAsset(
  reader: ObjectReader,
  source: string,
  containers: () => ContainerIndex,
  env: Env,
): Asset {
  const typeName = classIdName(reader.type) ?? `class ${reader.type}`;
  let name: string | undefined;
  let data: unknown;
  let read = false;
  const asset = {
    type: classReaderName(reader.type) ?? "Other",
    typeName,
    classId: reader.type,
    get name(): string {
      if (name === undefined) name = inContext(source, reader, () => readName(reader));
      return name;
    },
    get path(): string | undefined {
      return containers().pathOf.get(reader);
    },
    pathId: reader.pathId,
    file: reader.fileName,
    byteSize: reader.byteSize,
    get data(): unknown {
      if (!read) {
        data = inContext(source, reader, () => readAssetData(reader));
        read = true;
      }
      return data;
    },
    reader,
    env,
  };
  // `type` and `data` are paired by `classReaderName` and `readAssetData`,
  // which dispatch on the same list (`CLASS_READERS`).
  return asset as Asset;
}

/**
 * `m_Name` as cheaply as the object allows: through the type tree as far as
 * `m_Name`; without one, the `NamedObject` header or a `MonoBehaviour`'s
 * header; otherwise `""`.
 */
function readName(reader: ObjectReader): string {
  const nodes = reader.serializedType?.nodes;
  if (nodes && nodes.length > 0) return readTypeTreeName(reader) ?? "";
  if (NAMED_CLASSES.has(reader.type)) return readNamedObject(reader).m_Name;
  if (reader.type === ClassID.MonoBehaviour) return readMonoBehaviour(reader).m_Name;
  // ponytail: a GameObject's m_Name follows its component list, whose layout
  // needs a ported reader; add one when a stripped bundle needs the names.
  return "";
}

/**
 * Map every `m_Container` (`container`) entry of every `AssetBundle` object to the asset it
 * points at (upstream's `AssetBundle` container handling, UnityPy's
 * `env.container`). An asset listed under several paths gets the first; a
 * path listing several assets (a texture and its sprite) gives the first;
 * both in `env.objects` order, then `m_Container` order. An entry whose
 * pointer does not resolve (a bundle that is not loaded) is skipped.
 *
 * @param assets every asset of the env, in `env.objects` order
 * @param resolve the env's `resolve`
 * @throws what reading an `AssetBundle` throws, with its file and path id
 */
export function indexContainers(
  assets: readonly Asset[],
  resolve: (pptr: PPtr, from: ObjectReader) => PPtrResolution,
): ContainerIndex {
  const pathOf = new Map<ObjectReader, string>();
  const byPath = new Map<string, ObjectReader>();
  for (const bundle of assets) {
    if (bundle.type !== "AssetBundle") continue;
    for (const [path, info] of bundle.data.container) {
      const target = resolve(info.asset, bundle.reader);
      if (target.status !== "found") continue;
      if (!pathOf.has(target.object)) pathOf.set(target.object, path);
      const key = path.toLowerCase();
      if (!byPath.has(key)) byPath.set(key, target.object);
    }
  }
  return { pathOf, byPath };
}

/**
 * Run `read`, prefixing any error's message with where the object is: its
 * file (after the containers it came out of), class and path id. The error
 * is edited in place and rethrown, so its class and fields survive, as
 * `load()` does with its own errors.
 */
function inContext<T>(source: string, reader: ObjectReader, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof Error) {
      const typeName = classIdName(reader.type) ?? `class ${reader.type}`;
      error.message = `${source}: ${typeName} ${reader.pathId}: ${error.message}`;
    }
    throw error;
  }
}
