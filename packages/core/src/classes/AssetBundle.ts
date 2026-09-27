// Ported from AssetStudio/Classes/AssetBundle.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError, UnsupportedError } from "../errors.js";
import { SerializedFileFormatVersion as V } from "../serialized/FormatVersion.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import type { UnityVersion } from "../serialized/SerializedFile.js";
import { readCount } from "../serialized/TypeTree.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
import { readPPtr, type PPtr } from "./PPtr.js";
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
 * A file whose Unity version is unknown (`[0, 0, 0, 0]`, as
 * `AssetBundleStripUnityVersion` leaves it) is still read when its format is
 * 16 (5.5) or later: the layouts that format allows share every field up to
 * `m_IsStreamedSceneAssetBundle`, and the bytes left after it tell them apart
 * (see `readUnversionedTail`).
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
 *   `unityVersion` as `found`: for a version older than 3.4, for which no type
 *   tree data says what it holds, and for an unknown version (`[0, 0, 0, 0]`)
 *   when the file's format is below 16 or the bytes after
 *   `m_IsStreamedSceneAssetBundle` fit none of the layouts format 16 allows;
 *   and as `readNamedObject` does, for an editor file of unknown version
 * @throws {CorruptError} when the object ends early, a count or string length
 *   is negative or runs past its end, or bytes are left over after the last
 *   field
 */
export function readAssetBundle(reader: ObjectReader): AssetBundle {
  const { version } = reader;
  // Rule for version-gated class readers (#36, amended on #123/#126): an
  // unknown version is read only where the bytes decide the layout.
  const unknown = version.every((part) => part === 0);
  if (unknown && reader.format < V.RefactoredClassId) {
    throw refuse(reader, "before format 16 the bytes do not decide an AssetBundle's layout");
  }
  if (!unknown && !atLeast(version, 3, 4)) {
    throw refuse(reader, "no known AssetBundle layout before 3.4");
  }

  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<AssetBundle> & NamedObject = readNamedObject(reader);
  out.m_PreloadTable = readArray(reader, "m_PreloadTable", readPPtr);
  out.m_Container = readArray(reader, "m_Container", (r): [string, AssetInfo] => [
    readString(r, "m_Container path"),
    readAssetInfo(r),
  ]);
  out.m_MainAsset = readAssetInfo(reader);
  if (unknown) readUnversionedTail(reader, out);
  else readTail(reader, version, out);

  if (reader.remaining !== 0) {
    throw new CorruptError(
      `AssetBundle ${reader.pathId} ends at ${reader.position} of its ${reader.byteSize} bytes`,
    );
  }
  // Every required field was set above.
  return out as AssetBundle;
}

/** The fields after `m_MainAsset`, by the gates of Unity's type trees. */
function readTail(reader: ObjectReader, version: UnityVersion, out: Partial<AssetBundle>): void {
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
    return;
  }
  // 5.4 only.
  if (atLeast(version, 5, 4) && !atLeast(version, 5, 5)) {
    out.m_ClassVersionMap = readArray(reader, "m_ClassVersionMap", readIntPair);
  }
  readV5Fields(reader, out);
  // 2017.3+: m_ExplicitDataLayout before 2017.1's m_PathFlags, m_SceneHashes after.
  if (atLeast(version, 2017, 3)) readV2017_3Fields(reader, out);
  else if (atLeast(version, 2017, 1)) out.m_PathFlags = reader.readInt32();
}

/**
 * The fields after `m_MainAsset` of a file of unknown version and format 16
 * (5.5) or later (#36 rule, amended on #123/#126). Those formats allow three
 * layouts: 5.5's, which ends with `m_IsStreamedSceneAssetBundle` and its
 * padding; 2017.1's, one `Int32` more; and 2017.3's, at least two `Int32`s and
 * a map count more. So 0, 4 or at least 12 bytes left after the shared fields
 * pick exactly one, and the end-of-object check confirms it. Format 15 and
 * below would add 5.4's `m_ClassVersionMap` or the 3.x/4.x lists in the middle,
 * which the bytes left cannot tell apart; those are refused before this.
 *
 * @throws {UnsupportedError} when the bytes left fit none of the three
 * @throws {CorruptError} when the object ends inside the shared fields
 */
function readUnversionedTail(reader: ObjectReader, out: Partial<AssetBundle>): void {
  readV5Fields(reader, out);
  const left = reader.remaining;
  if (left === 0) return;
  if (left === 4) {
    out.m_PathFlags = reader.readInt32();
    return;
  }
  if (left >= 12) {
    try {
      readV2017_3Fields(reader, out);
      if (reader.remaining === 0) return;
    } catch (error) {
      if (!(error instanceof CorruptError)) throw error;
    }
  }
  throw refuse(
    reader,
    `the ${left} bytes after m_IsStreamedSceneAssetBundle fit none of the layouts ` +
      "of format 16 and later (5.5, 2017.1, 2017.3)",
  );
}

/** 5.0+: `m_RuntimeCompatibility` to `m_IsStreamedSceneAssetBundle` and its padding. */
function readV5Fields(reader: ObjectReader, out: Partial<AssetBundle>): void {
  out.m_RuntimeCompatibility = reader.readUInt32();
  out.m_AssetBundleName = readString(reader, "m_AssetBundleName");
  out.m_Dependencies = readArray(reader, "m_Dependencies", (r) =>
    readString(r, "m_Dependencies name"),
  );
  out.m_IsStreamedSceneAssetBundle = reader.readUInt8() !== 0;
  reader.align();
}

/** 2017.3+: the fields after `m_IsStreamedSceneAssetBundle`. */
function readV2017_3Fields(reader: ObjectReader, out: Partial<AssetBundle>): void {
  out.m_ExplicitDataLayout = reader.readInt32();
  out.m_PathFlags = reader.readInt32();
  out.m_SceneHashes = readArray(reader, "m_SceneHashes", (r): [string, string] => [
    readString(r, "m_SceneHashes path"),
    readString(r, "m_SceneHashes hash"),
  ]);
}

/** Refuse a version this reader has no layout for, naming the file's own version string. */
function refuse(reader: ObjectReader, why: string): UnsupportedError {
  const hint = `object ${reader.pathId}: ${why}`;
  return new UnsupportedError("Unity version", reader.unityVersion, hint);
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
