// Ported from AssetStudio/Classes/AssetBundle.cs (MIT, © Perfare / RazTools / Razviar)

import type { Env } from "../env.js";
import { CorruptError, UnsupportedError } from "../errors.js";
import { ClassID } from "../serialized/ClassID.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import { readCount } from "../serialized/TypeTree.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
import { readPPtr, type PPtr, type PPtrResolution } from "./PPtr.js";
import { atLeast } from "./version.js";

/**
 * One entry of an AssetBundle's container (Unity's `AssetInfo`): the asset
 * itself, and the run of the preload table Unity loads with it.
 */
export interface AssetInfo {
  /** Index of the entry's first object in `m_PreloadTable`. */
  preloadIndex: number;
  /** How many `m_PreloadTable` entries, from `preloadIndex`, belong to it. */
  preloadSize: number;
  /** The asset the path names. */
  asset: PPtr;
}

/** A script an AssetBundle of Unity 3.4 to 4.x was built against. */
export interface AssetBundleScriptInfo {
  className: string;
  nameSpace: string;
  assemblyName: string;
  hash: number;
}

/**
 * The fields of an `AssetBundle` object, under Unity's names: the keys, their
 * order and their values agree with `readTypeTree()` on the same object, pairs
 * and map entries as `[first, second]` arrays as it gives them.
 *
 * Every bundle has one. Its `m_Container` maps the path each asset had in the
 * editor project (`"assets/ui/logo.png"`, lower-cased by Unity) to the asset;
 * a path is listed once per object under it, so an asset with sub-assets
 * (a texture and its sprite) appears more than once.
 */
export interface AssetBundle extends NamedObject {
  /** Every object the bundle's assets need, their dependencies included. */
  m_PreloadTable: PPtr[];
  /** Asset path to asset, in the order Unity wrote them; a path may repeat. */
  m_Container: [string, AssetInfo][];
  m_MainAsset: AssetInfo;
  /** Unity 3.4 to 4.x. */
  m_ScriptCompatibility?: AssetBundleScriptInfo[];
  /** Unity 3.5 to 4.x: class id to class version. */
  m_ClassCompatibility?: [number, number][];
  /** Unity 5.4 only: class id to class version. */
  m_ClassVersionMap?: [number, number][];
  /** Unity 4.2 and later. */
  m_RuntimeCompatibility?: number;
  /** Unity 5.0 and later. */
  m_AssetBundleName?: string;
  /** Unity 5.0 and later: the names of the bundles this one needs. */
  m_Dependencies?: string[];
  /** Unity 5.0 and later. */
  m_IsStreamedSceneAssetBundle?: boolean;
  /** Unity 2017.3 and later. */
  m_ExplicitDataLayout?: number;
  /** Unity 2017.1 and later. */
  m_PathFlags?: number;
  /** Unity 2017.3 and later: scene path to scene hash. */
  m_SceneHashes?: [string, string][];
}

/**
 * Read an `AssetBundle` from the object's first byte: every field Unity's own
 * type trees give for its version (as UnityPy's TPK data records them), in
 * their order. Upstream reads `m_PreloadTable` and `m_Container` and stops;
 * the rest is read here so the object is consumed to its last byte.
 *
 * The layout after `m_Name` is the same in editor and player files, so both
 * are read. Unity changed it at 3.5, 4.2, 5.0, 5.4, 5.5, 2017.1 and 2017.3, and
 * has kept it since (checked up to 6000.6).
 *
 * The object must end exactly where the last field does, so a layout this
 * reader does not know is refused rather than returned half-read.
 *
 * ponytail: the gates compare release numbers only (see `atLeast`), as the
 * other class readers' do. 2017.1.0b1 lacks `m_PathFlags`, which 2017.1.0b2
 * added; such a pre-release fails the end-of-object check with a CorruptError.
 * Compare the build type in the gate if one ever matters.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`, when the version is unknown (`[0, 0, 0, 0]`:
 *   stripped, or a loose file below format 7), since every field past
 *   `m_Container` depends on it, or older than 3.4, for which no type tree
 *   data says what it holds
 * @throws {CorruptError} when the object ends early, a count or string length
 *   is negative or runs past its end, or bytes are left over after the last
 *   field
 */
export function readAssetBundle(reader: ObjectReader): AssetBundle {
  const { version } = reader;
  // Rule for version-gated class readers (#36): an unknown version must not
  // fall through to the oldest branch, so refuse it.
  if (version.every((part) => part === 0)) {
    throw new UnsupportedError(
      "Unity version",
      reader.unityVersion,
      `object ${reader.pathId}: an AssetBundle's fields depend on the Unity version, ` +
        "and this file does not record one",
    );
  }
  if (!atLeast(version, 3, 4)) {
    throw new UnsupportedError(
      "Unity version",
      reader.unityVersion,
      `object ${reader.pathId}: no known AssetBundle layout before 3.4`,
    );
  }

  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<AssetBundle> & NamedObject = readNamedObject(reader);
  out.m_PreloadTable = readArray(reader, "m_PreloadTable", readPPtr);
  out.m_Container = readArray(reader, "m_Container", (r): [string, AssetInfo] => [
    readString(r, "m_Container path"),
    readAssetInfo(r),
  ]);
  out.m_MainAsset = readAssetInfo(reader);

  if (!atLeast(version, 5, 0)) {
    // 3.4 to 4.x; 5.0 dropped both compatibility lists.
    out.m_ScriptCompatibility = readArray(reader, "m_ScriptCompatibility", (r) => ({
      className: readString(r, "m_ScriptCompatibility className"),
      nameSpace: readString(r, "m_ScriptCompatibility nameSpace"),
      assemblyName: readString(r, "m_ScriptCompatibility assemblyName"),
      hash: r.readUInt32(),
    }));
    if (atLeast(version, 3, 5)) {
      out.m_ClassCompatibility = readArray(reader, "m_ClassCompatibility", readClassVersion);
    }
    // 4.2+: last here, after m_MainAsset (or 5.4's m_ClassVersionMap) from 5.0.
    if (atLeast(version, 4, 2)) out.m_RuntimeCompatibility = reader.readUInt32();
  } else {
    // 5.4 only.
    if (atLeast(version, 5, 4) && !atLeast(version, 5, 5)) {
      out.m_ClassVersionMap = readArray(reader, "m_ClassVersionMap", readIntPair);
    }
    out.m_RuntimeCompatibility = reader.readUInt32();
    out.m_AssetBundleName = readString(reader, "m_AssetBundleName");
    out.m_Dependencies = readArray(reader, "m_Dependencies", (r) =>
      readString(r, "m_Dependencies name"),
    );
    out.m_IsStreamedSceneAssetBundle = reader.readUInt8() !== 0;
    reader.align();
    // 2017.3+: m_ExplicitDataLayout before 2017.1's m_PathFlags, m_SceneHashes after.
    const v2017_3 = atLeast(version, 2017, 3);
    if (v2017_3) out.m_ExplicitDataLayout = reader.readInt32();
    if (atLeast(version, 2017, 1)) out.m_PathFlags = reader.readInt32();
    if (v2017_3) {
      out.m_SceneHashes = readArray(reader, "m_SceneHashes", (r): [string, string] => [
        readString(r, "m_SceneHashes path"),
        readString(r, "m_SceneHashes hash"),
      ]);
    }
  }

  if (reader.remaining !== 0) {
    throw new CorruptError(
      `AssetBundle ${reader.pathId} ends at ${reader.position} of its ${reader.byteSize} bytes`,
    );
  }
  // Every required field was set above.
  return out as AssetBundle;
}

/**
 * Find the objects the AssetBundles of `env` list under an asset path: the
 * `asset` of every `m_Container` entry whose path is exactly `path`, resolved
 * with `env.resolve` from the AssetBundle object. This is what Unity's
 * `AssetBundle.LoadAsset(path)` answers, so the preload table is not consulted.
 *
 * Paths are compared as they are, as upstream and UnityPy do; Unity writes
 * them lower-cased (`"assets/ui/logo.png"`). Every call reads every
 * AssetBundle object again; to list or index the whole container, read them
 * once with `obj.read()` and resolve their `m_Container` entries instead.
 *
 * @param env the loaded files to look in
 * @param path an `m_Container` path, such as `"assets/ui/logo.png"`
 * @returns one resolution per matching entry, in `env.objects` order and then
 *   container order; empty when no bundle lists the path. A dangling pointer
 *   is a result, as with `env.resolve`, not dropped.
 * @throws {UnsupportedError} / {CorruptError} as {@link readAssetBundle} does,
 *   for any AssetBundle object of `env`, and as `env.objects` does
 */
export function findAssets(env: Env, path: string): PPtrResolution[] {
  const found: PPtrResolution[] = [];
  for (const object of env.objects) {
    if (object.type !== ClassID.AssetBundle) continue;
    for (const [entryPath, { asset }] of readAssetBundle(object).m_Container) {
      if (entryPath === path) found.push(env.resolve(asset, object));
    }
  }
  return found;
}

/** Unity's `AssetInfo`: two `Int32`s and the asset pointer. */
function readAssetInfo(reader: ObjectReader): AssetInfo {
  return {
    preloadIndex: reader.readInt32(),
    preloadSize: reader.readInt32(),
    asset: readPPtr(reader),
  };
}

/** An `Int32` count, then that many elements. */
function readArray<T>(reader: ObjectReader, what: string, element: (r: ObjectReader) => T): T[] {
  const count = readCount(reader, `AssetBundle ${reader.pathId} ${what}`);
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(element(reader));
  return out;
}

/** A `pair<int, UInt32>`: 3.5 to 4.x's class id and class version. */
function readClassVersion(reader: ObjectReader): [number, number] {
  return [reader.readInt32(), reader.readUInt32()];
}

/** A `pair<int, int>`: 5.4's class id and class version. */
function readIntPair(reader: ObjectReader): [number, number] {
  return [reader.readInt32(), reader.readInt32()];
}

/**
 * Unity's aligned string, with a length that is negative or runs past the
 * object's end refused: `readAlignedString` would read those as `""` and
 * carry on inside the string's bytes.
 */
function readString(reader: ObjectReader, what: string): string {
  const text = reader.readString(readCount(reader, `AssetBundle ${reader.pathId} ${what} byte`));
  reader.align();
  return text;
}
