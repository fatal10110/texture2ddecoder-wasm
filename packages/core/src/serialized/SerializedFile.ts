// Ported from AssetStudio/SerializedFile.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/SerializedFileHeader.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/ObjectInfo.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/FileIdentifier.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/LocalSerializedObjectIdentifier.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError, UnsupportedError } from "../errors.js";
import { BinaryReader } from "../io/BinaryReader.js";
import { BuildTarget, toBuildTarget } from "./BuildTarget.js";
import { SerializedFileFormatVersion as V } from "./FormatVersion.js";
import { readCount, readSerializedType, type SerializedType } from "./TypeTree.js";

/** Size of an external's GUID. */
const GUID_SIZE = 16;

/** What upstream assumes a file too old to name its editor was written by. */
const DEFAULT_UNITY_VERSION = "2.5.0f5";

/** What a typetree-stripped build writes in place of its editor version. */
const STRIPPED_VERSION = "0.0.0";

/** The fixed header every SerializedFile starts with, always big-endian. */
export interface SerializedFileHeader {
  /** Bytes of metadata (types, objects, externals, ...) after the header. */
  metadataSize: number;
  /** Size of the whole file as the header records it. */
  fileSize: number;
  /** Format version, 2 to 22; see `SerializedFileFormatVersion`. */
  version: number;
  /** Where object data starts; object `byteStart`s are relative to it on disk. */
  dataOffset: number;
  /** 0 = metadata is little-endian, anything else = big-endian. */
  endianess: number;
  /** Three bytes after `endianess` (format 9+); empty before. */
  reserved: Uint8Array;
}

/** One entry of the object table (upstream `ObjectInfo`). */
export interface ObjectInfo {
  /** Object id within this file, always `bigint` (D9). */
  pathId: bigint;
  /** Absolute offset of the object's data in the file (`dataOffset` added). */
  byteStart: number;
  /** Size of the object's data in bytes. */
  byteSize: number;
  /** Format 16+: index into `types`; before, the class id itself. */
  typeId: number;
  /** Unity class id. */
  classId: number;
  /** The object's type entry; `null` when none matches (pre-format-16 only). */
  serializedType: SerializedType | null;
  /** Before format 11; 0 after. */
  isDestroyed: number;
  /** Formats 15 and 16 only; 0 otherwise. */
  stripped: number;
}

/** A script referenced by the file (upstream `LocalSerializedObjectIdentifier`). */
export interface LocalSerializedObjectIdentifier {
  /** 0 for this file, otherwise 1 + an index into `externals`. */
  localSerializedFileIndex: number;
  /** Path id of the `MonoScript` in that file (D9). */
  localIdentifierInFile: bigint;
}

/** Another file this one references (upstream `FileIdentifier`). */
export interface FileIdentifier {
  /** Raw 16-byte GUID (format 5+), a view into the file (R7); `null` before. */
  guid: Uint8Array | null;
  /**
   * Format 5+; `null` before. 0 = non-asset, 1 = deprecated cached asset,
   * 2 = serialized asset, 3 = meta asset.
   */
  type: number | null;
  /** Path as written, e.g. `"archive:/CAB-1234/CAB-1234"`. */
  pathName: string;
  /** Last component of `pathName`, e.g. `"CAB-1234"`. */
  fileName: string;
}

/** Major, minor, patch and build number of a Unity version string. */
export type UnityVersion = readonly [major: number, minor: number, patch: number, build: number];

/** A parsed SerializedFile: header and metadata, with object data left in place. */
export interface SerializedFile {
  header: SerializedFileHeader;
  /**
   * Editor version exactly as written, suffix included: typetree-stripped files
   * carry one, e.g. `"6000.3.25f1\n2"`. `"2.5.0f5"` before format 7, unless
   * `load()` gave the file its enclosing bundle's `unityRevision`.
   */
  unityVersion: string;
  /**
   * The version parsed from the leading `major.minor.patch<type>build` of
   * `unityVersion`, suffix ignored. `[0, 0, 0, 0]` before format 7, which
   * names no editor, unless `load()` gave the file its enclosing bundle's
   * `unityRevision`; and `[0, 0, 0, 0]` for the stripped placeholder `"0.0.0"`.
   */
  version: UnityVersion;
  /** Format 8+; `UnknownPlatform` before, or when the value is not one upstream knows. */
  targetPlatform: BuildTarget;
  /** Byte order of the metadata and object data. */
  bigEndian: boolean;
  /** Format 13+; always `true` before. */
  enableTypeTree: boolean;
  types: SerializedType[];
  /** Formats 7 to 13: non-zero when path ids are 64-bit; 0 otherwise. */
  bigIdEnabled: number;
  objects: ObjectInfo[];
  /** Format 11+; empty before. */
  scriptTypes: LocalSerializedObjectIdentifier[];
  externals: FileIdentifier[];
  /** Format 20+ (`[SerializeReference]` types); empty before. */
  refTypes: SerializedType[];
  /** Format 5+; `""` before. */
  userInformation: string;
}

/**
 * Parse a SerializedFile's header and metadata: editor version, platform,
 * types, object table, script types, externals and ref types.
 *
 * Object data is not read; each {@link ObjectInfo} says where it is. Every
 * format version upstream handles is ported (2 to 22); only 21 and 22 are
 * tested against editor-built fixtures.
 *
 * @param data the whole SerializedFile, e.g. one of `load().files`; kept by
 *   reference, and hashes and GUIDs in the result are views into it (R7)
 * @returns the header and metadata
 * @throws {UnsupportedError} for a format version outside 2 to 22
 * @throws {CorruptError} when the metadata is truncated or holds a count,
 *   offset or type index that cannot be right
 */
export function readSerializedFile(data: Uint8Array): SerializedFile {
  const reader = new BinaryReader(data, "big");

  const header: SerializedFileHeader = {
    metadataSize: reader.readUInt32(),
    fileSize: reader.readUInt32(),
    version: reader.readUInt32(),
    dataOffset: reader.readUInt32(),
    endianess: 0,
    reserved: new Uint8Array(0),
  };
  const format = header.version;
  if (format <= V.Unsupported || format > V.LargeFilesSupport) {
    throw new UnsupportedError("SerializedFile format version", format, "expected 2 to 22");
  }

  if (format >= V.Unknown_9) {
    header.endianess = reader.readUInt8();
    header.reserved = reader.readBytes(3);
  } else {
    // Before 3.5 (format 9) the metadata, endianness byte first, sits at the end.
    if (header.metadataSize > header.fileSize || header.fileSize > data.length) {
      throw new CorruptError(
        `metadata of ${header.metadataSize} bytes does not end a file of ` +
          `${header.fileSize} bytes (${data.length} given)`,
      );
    }
    reader.position = header.fileSize - header.metadataSize;
    header.endianess = reader.readUInt8();
  }

  // 2020.1+ (format 22): 64-bit sizes follow, superseding the 32-bit ones.
  if (format >= V.LargeFilesSupport) {
    header.metadataSize = reader.readUInt32();
    header.fileSize = toOffset(reader.readInt64(), "file size");
    header.dataOffset = toOffset(reader.readInt64(), "data offset");
    reader.readInt64(); // reserved
  }

  // From format 9 the metadata follows the header, so a file cut inside it is
  // caught here - otherwise a cut in a trailing C string reads as a shorter
  // string rather than as an error.
  if (format >= V.Unknown_9 && reader.position + header.metadataSize > data.length) {
    throw new CorruptError(
      `metadata of ${header.metadataSize} bytes at offset ${reader.position} runs past ` +
        `the end of ${data.length} bytes`,
    );
  }

  if (header.endianess === 0) reader.endian = "little";

  let unityVersion = DEFAULT_UNITY_VERSION;
  let version: UnityVersion = [0, 0, 0, 0];
  if (format >= V.Unknown_7) {
    unityVersion = reader.readStringToNull();
    version = parseUnityVersion(unityVersion);
  }
  const targetPlatform =
    format >= V.Unknown_8 ? toBuildTarget(reader.readInt32()) : BuildTarget.UnknownPlatform;
  const enableTypeTree = format >= V.HasTypeTreeHashes ? reader.readUInt8() !== 0 : true;

  const typeCount = readCount(reader, "type");
  const types: SerializedType[] = [];
  for (let i = 0; i < typeCount; i++) {
    types.push(readSerializedType(reader, format, enableTypeTree, false));
  }

  let bigIdEnabled = 0;
  if (format >= V.Unknown_7 && format < V.Unknown_14) bigIdEnabled = reader.readInt32();

  const objectCount = readCount(reader, "object");
  const objects: ObjectInfo[] = [];
  for (let i = 0; i < objectCount; i++) {
    objects.push(readObjectInfo(reader, format, bigIdEnabled, header.dataOffset, types));
  }

  const scriptTypes: LocalSerializedObjectIdentifier[] = [];
  if (format >= V.HasScriptTypeIndex) {
    const scriptCount = readCount(reader, "script type");
    for (let i = 0; i < scriptCount; i++) {
      const localSerializedFileIndex = reader.readInt32();
      let localIdentifierInFile: bigint;
      if (format < V.Unknown_14) {
        localIdentifierInFile = BigInt(reader.readInt32());
      } else {
        reader.align(4);
        localIdentifierInFile = reader.readInt64();
      }
      scriptTypes.push({ localSerializedFileIndex, localIdentifierInFile });
    }
  }

  const externalCount = readCount(reader, "external");
  const externals: FileIdentifier[] = [];
  for (let i = 0; i < externalCount; i++) {
    if (format >= V.Unknown_6) reader.readStringToNull(); // tempEmpty, unused
    let guid: Uint8Array | null = null;
    let type: number | null = null;
    if (format >= V.Unknown_5) {
      guid = reader.readBytes(GUID_SIZE);
      type = reader.readInt32();
    }
    const pathName = reader.readStringToNull();
    externals.push({ guid, type, pathName, fileName: baseName(pathName) });
  }

  const refTypes: SerializedType[] = [];
  if (format >= V.SupportsRefObject) {
    const refTypeCount = readCount(reader, "ref type");
    for (let i = 0; i < refTypeCount; i++) {
      refTypes.push(readSerializedType(reader, format, enableTypeTree, true));
    }
  }

  const userInformation = format >= V.Unknown_5 ? reader.readStringToNull() : "";

  return {
    header,
    unityVersion,
    version,
    targetPlatform,
    bigEndian: header.endianess !== 0,
    enableTypeTree,
    types,
    bigIdEnabled,
    objects,
    scriptTypes,
    externals,
    refTypes,
    userInformation,
  };
}

/** Read one object table entry; the per-format gates are upstream's. */
function readObjectInfo(
  reader: BinaryReader,
  format: number,
  bigIdEnabled: number,
  dataOffset: number,
  types: SerializedType[],
): ObjectInfo {
  let pathId: bigint;
  if (bigIdEnabled !== 0) {
    pathId = reader.readInt64();
  } else if (format < V.Unknown_14) {
    pathId = BigInt(reader.readInt32());
  } else {
    reader.align(4);
    pathId = reader.readInt64();
  }

  // 2020.1+ (format 22): byteStart widens from UInt32 to Int64.
  const relativeStart =
    format >= V.LargeFilesSupport
      ? toOffset(reader.readInt64(), "object byteStart")
      : reader.readUInt32();
  const byteStart = relativeStart + dataOffset;
  if (!Number.isSafeInteger(byteStart)) {
    throw new CorruptError(`object ${pathId} byteStart ${byteStart} is not below 2^53`);
  }
  const byteSize = reader.readUInt32();
  const typeId = reader.readInt32();

  let classId: number;
  let serializedType: SerializedType | null;
  if (format < V.RefactoredClassId) {
    // Before 5.5 the entry holds the class id, and typeId is the class id too.
    classId = reader.readUInt16();
    serializedType = types.find((t) => t.classId === typeId) ?? null;
  } else {
    const type = types[typeId];
    if (!type) {
      throw new CorruptError(
        `object ${pathId} has type index ${typeId}, but the file has ${types.length} types`,
      );
    }
    serializedType = type;
    classId = type.classId;
  }

  let isDestroyed = 0;
  if (format < V.HasScriptTypeIndex) isDestroyed = reader.readUInt16();
  // Formats 11 to 16 keep the script type index here; 17 moved it to the type.
  if (format >= V.HasScriptTypeIndex && format < V.RefactorTypeData) {
    const scriptTypeIndex = reader.readInt16();
    if (serializedType) serializedType.scriptTypeIndex = scriptTypeIndex;
  }
  let stripped = 0;
  if (format === V.SupportsStrippedObject || format === V.RefactoredClassId) {
    stripped = reader.readUInt8();
  }

  return { pathId, byteStart, byteSize, typeId, classId, serializedType, isDestroyed, stripped };
}

/**
 * Give a parsed file the editor version it does not record itself (upstream
 * `SerializedFile.SetVersion`): set `unityVersion` and re-parse `version`.
 * Internal (not exported from the package): env uses it for a file below
 * format 7 found in a bundle, which takes the bundle's `unityRevision`.
 *
 * The stripped placeholder `"0.0.0"` names no editor, so it leaves the file
 * as it was, like upstream.
 *
 * @param file the file to change, in place
 * @param text a Unity version string such as `"2.6.1f3"`
 */
export function setUnityVersion(file: SerializedFile, text: string): void {
  if (text === STRIPPED_VERSION) return;
  file.unityVersion = text;
  file.version = parseUnityVersion(text);
}

/**
 * Parse the leading `major.minor.patch<type>build` of a Unity version string.
 *
 * Only the leading run is read: typetree-stripped files append a suffix such
 * as `"\n2"`, which upstream's split-on-every-non-digit would turn into a
 * fifth component. Missing components read as 0, which also covers the
 * stripped placeholder `"0.0.0"`.
 */
function parseUnityVersion(text: string): UnityVersion {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[A-Za-z]+(\d+))?/.exec(text);
  const part = (i: number): number => Number(match?.[i] ?? 0);
  return [part(1), part(2), part(3), part(4)];
}

/**
 * Last path component, splitting on `/` and `\` like .NET `Path.GetFileName`.
 * Internal (not exported from the package): env names loaded files with it, so
 * an external's `fileName` and a loaded file's name are cut the same way.
 *
 * @param path a path with either separator
 * @returns everything after the last separator; `path` itself if it has none
 */
export function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/**
 * Convert a 64-bit size or offset into a `number` (D9/R6).
 *
 * @throws {CorruptError} when it is negative or 2^53 and above
 */
function toOffset(value: bigint, what: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CorruptError(`${what} ${value} is not a byte offset below 2^53`);
  }
  return Number(value);
}
