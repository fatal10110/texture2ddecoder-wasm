// Ported from AssetStudio/SerializedFile.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/SerializedType.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/TypeTreeNode.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError } from "../errors.js";
import { BinaryReader } from "../io/BinaryReader.js";
import { SerializedFileFormatVersion as V } from "./FormatVersion.js";

/** Size of a `Hash128` (script id, old type hash). */
const HASH_SIZE = 16;

/** Class id of `MonoBehaviour`, the one class whose types carry a script id. */
const MONO_BEHAVIOUR = 114;

/** High bit of a blob string offset: set means "index into the common strings". */
const COMMON_STRING_FLAG = 0x80000000;

/**
 * One node of a type tree, flattened in pre-order: a node's children follow it
 * with `level` one higher.
 */
export interface TypeTreeNode {
  /** Type name, e.g. `"int"`, `"string"`, `"PPtr<Object>"`. */
  type: string;
  /** Field name, e.g. `"m_Name"`. */
  name: string;
  /** Serialized size in bytes, -1 when variable. */
  byteSize: number;
  /** Position in the flattened tree; absent (0) in format 3. */
  index: number;
  /** Upstream `m_TypeFlags` (was `m_IsArray`). */
  typeFlags: number;
  /** Node version. */
  version: number;
  /** Alignment and other meta flags (`0x4000` = align after); 0 in format 3. */
  metaFlag: number;
  /** Depth; the root is 0. */
  level: number;
  /** Raw blob offset of `type`; 0 in the pre-blob layout. */
  typeStrOffset: number;
  /** Raw blob offset of `name`; 0 in the pre-blob layout. */
  nameStrOffset: number;
  /** 2019.1+ (format 19): hash of a `[SerializeReference]` type; 0n otherwise. */
  refTypeHash: bigint;
}

/** One entry of a SerializedFile's type table (`m_Types` or `m_RefTypes`). */
export interface SerializedType {
  /** Unity class id; negative for a script type before format 16. */
  classId: number;
  /** Format 16+; `false` before. */
  isStrippedType: boolean;
  /**
   * Index into the file's script types, -1 for none. Format 17+ stores it here;
   * formats 11 to 16 store it on the object entry, which writes it back here.
   */
  scriptTypeIndex: number;
  /** Type tree nodes in pre-order; `null` when the file has no type trees. */
  nodes: TypeTreeNode[] | null;
  /** Blob string buffer the node names were read from; `null` without a blob. */
  stringBuffer: Uint8Array | null;
  /** `Hash128` of the script, for script types (format 13+); `null` otherwise. */
  scriptId: Uint8Array | null;
  /** `Hash128` of the type (format 13+); `null` before. */
  oldTypeHash: Uint8Array | null;
  /** Format 21+, with type trees, `m_Types` only; `null` otherwise. */
  typeDependencies: number[] | null;
  /** Format 21+, with type trees, `m_RefTypes` only; `null` otherwise. */
  className: string | null;
  /** Format 21+, with type trees, `m_RefTypes` only; `null` otherwise. */
  namespace: string | null;
  /** Format 21+, with type trees, `m_RefTypes` only; `null` otherwise. */
  assemblyName: string | null;
}

/**
 * Read one `SerializedType` (upstream `SerializedFile.ReadSerializedType`).
 *
 * @param reader positioned at the entry, in the file's metadata byte order
 * @param format the SerializedFile format version
 * @param enableTypeTree whether the file stores type trees
 * @param isRefType `true` for an `m_RefTypes` entry
 * @throws {CorruptError} when the entry runs past the end or holds a count or
 *   string offset that cannot be right
 */
export function readSerializedType(
  reader: BinaryReader,
  format: number,
  enableTypeTree: boolean,
  isRefType: boolean,
): SerializedType {
  const type: SerializedType = {
    classId: reader.readInt32(),
    isStrippedType: false,
    scriptTypeIndex: -1,
    nodes: null,
    stringBuffer: null,
    scriptId: null,
    oldTypeHash: null,
    typeDependencies: null,
    className: null,
    namespace: null,
    assemblyName: null,
  };

  if (format >= V.RefactoredClassId) type.isStrippedType = reader.readUInt8() !== 0;
  if (format >= V.RefactorTypeData) type.scriptTypeIndex = reader.readInt16();

  if (format >= V.HasTypeTreeHashes) {
    // A script type is a negative class id before 5.5 and MonoBehaviour after.
    const isScript =
      (isRefType && type.scriptTypeIndex >= 0) ||
      (format < V.RefactoredClassId && type.classId < 0) ||
      (format >= V.RefactoredClassId && type.classId === MONO_BEHAVIOUR);
    if (isScript) type.scriptId = reader.readBytes(HASH_SIZE);
    type.oldTypeHash = reader.readBytes(HASH_SIZE);
  }

  if (!enableTypeTree) return type;

  // 5.0+ (format 12, and the odd 10) packs the tree into a node blob.
  if (format >= V.Unknown_12 || format === V.Unknown_10) {
    const blob = readTypeTreeBlob(reader, format);
    type.nodes = blob.nodes;
    type.stringBuffer = blob.stringBuffer;
  } else {
    type.nodes = readTypeTreeLegacy(reader, format);
  }

  // 2019.3+ (format 21): what the type depends on, or who a ref type is.
  if (format >= V.StoresTypeDependencies) {
    if (isRefType) {
      type.className = reader.readStringToNull();
      type.namespace = reader.readStringToNull();
      type.assemblyName = reader.readStringToNull();
    } else {
      type.typeDependencies = readInt32Array(reader);
    }
  }
  return type;
}

/**
 * The pre-5.0 layout: each node inline with its strings, followed by its
 * children (upstream `ReadTypeTree`).
 *
 * Upstream recurses; this walks an explicit stack instead, so a crafted file
 * nesting thousands deep runs out of bytes rather than out of call stack.
 */
function readTypeTreeLegacy(reader: BinaryReader, format: number): TypeTreeNode[] {
  const nodes: TypeTreeNode[] = [];
  // Children still to read at each open level; the root is the one child of
  // an imaginary level above it.
  const pending = [1];
  while (pending.length > 0) {
    const top = pending.length - 1;
    if (pending[top] === 0) {
      pending.pop();
      continue;
    }
    pending[top]!--;

    const type = reader.readStringToNull();
    const name = reader.readStringToNull();
    const byteSize = reader.readInt32();
    if (format === V.Unknown_2) reader.readInt32(); // variableCount, unused
    const index = format !== V.Unknown_3 ? reader.readInt32() : 0;
    const typeFlags = reader.readInt32();
    const version = reader.readInt32();
    const metaFlag = format !== V.Unknown_3 ? reader.readInt32() : 0;
    nodes.push({
      type,
      name,
      byteSize,
      index,
      typeFlags,
      version,
      metaFlag,
      level: top,
      typeStrOffset: 0,
      nameStrOffset: 0,
      refTypeHash: 0n,
    });

    const children = reader.readInt32();
    if (children < 0) {
      throw new CorruptError(`type tree node "${name}" has ${children} children`);
    }
    pending.push(children);
  }
  return nodes;
}

/**
 * The 5.0+ layout: fixed-size node records, then one string buffer they index
 * into (upstream `TypeTreeBlobRead`).
 */
function readTypeTreeBlob(
  reader: BinaryReader,
  format: number,
): { nodes: TypeTreeNode[]; stringBuffer: Uint8Array } {
  const nodeCount = readCount(reader, "type tree node");
  const stringBufferSize = readCount(reader, "type tree string buffer size");

  const nodes: TypeTreeNode[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const version = reader.readUInt16();
    const level = reader.readUInt8();
    const typeFlags = reader.readUInt8();
    const typeStrOffset = reader.readUInt32();
    const nameStrOffset = reader.readUInt32();
    const byteSize = reader.readInt32();
    const index = reader.readInt32();
    const metaFlag = reader.readInt32();
    // 2019.1+ (format 19): every node record grows a u64 ref type hash.
    const refTypeHash = format >= V.TypeTreeNodeWithTypeFlags ? reader.readUInt64() : 0n;
    nodes.push({
      type: "",
      name: "",
      byteSize,
      index,
      typeFlags,
      version,
      metaFlag,
      level,
      typeStrOffset,
      nameStrOffset,
      refTypeHash,
    });
  }

  const stringBuffer = reader.readBytes(stringBufferSize);
  for (const node of nodes) {
    node.type = readBlobString(stringBuffer, node.typeStrOffset);
    node.name = readBlobString(stringBuffer, node.nameStrOffset);
  }
  return { nodes, stringBuffer };
}

/**
 * Resolve a blob string reference: an offset into the file's own string
 * buffer, or - with the high bit set - into Unity's built-in common strings.
 *
 * ponytail: a common-string reference resolves to upstream's fallback for an
 * unknown one, the offset as text, until the `CommonString` table is ported
 * (#23). Only node names are affected, and nothing reads them before #23.
 */
function readBlobString(buffer: Uint8Array, value: number): string {
  if ((value & COMMON_STRING_FLAG) !== 0) return String(value & 0x7fffffff);
  if (value > buffer.length) {
    throw new CorruptError(
      `type tree string offset ${value} is past the end of the ${buffer.length}-byte buffer`,
    );
  }
  const reader = new BinaryReader(buffer, "little");
  reader.position = value;
  return reader.readStringToNull();
}

/** Upstream `ReadInt32Array`: an `Int32` count, then that many `Int32`s. */
function readInt32Array(reader: BinaryReader): number[] {
  const count = readCount(reader, "type dependency");
  if (count * 4 > reader.remaining) {
    throw new CorruptError(
      `${count} type dependencies at offset ${reader.position} need ${count * 4} bytes, ` +
        `${reader.remaining} remain`,
    );
  }
  const values: number[] = [];
  for (let i = 0; i < count; i++) values.push(reader.readInt32());
  return values;
}

/**
 * Read an `Int32` count and refuse a negative one, which upstream turns into
 * an empty list or an exception depending on where it is.
 *
 * @internal shared with `SerializedFile.ts`, not public API
 * @throws {CorruptError} when the count is negative or runs past the end
 */
export function readCount(reader: BinaryReader, what: string): number {
  const offset = reader.position;
  const value = reader.readInt32();
  if (value < 0) throw new CorruptError(`${what} count ${value} at offset ${offset} is negative`);
  return value;
}
