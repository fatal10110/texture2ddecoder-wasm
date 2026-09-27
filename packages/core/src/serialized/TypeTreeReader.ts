// Ported from AssetStudio/TypeTreeHelper.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from UnityPy/helpers/TypeTreeHelper.py (MIT, © K0lb3)

import { CorruptError, UnsupportedError } from "../errors.js";
import type { ObjectReader } from "./ObjectReader.js";
import { readCount, type SerializedType, type TypeTreeNode } from "./TypeTree.js";

/** `m_MetaFlag` bit: align the stream to 4 bytes after this node's value. */
const ALIGN_BYTES = 0x4000;

/** Element types whose vectors come back as one byte view, like `TypelessData`. */
const BYTE_TYPES = new Set(["UInt8", "SInt8", "char"]);

/**
 * One value read by {@link readTypeTree}, by node type:
 *
 * - `SInt8` to `SInt32`, `UInt8` to `UInt32`, `char`, `Type*`, `float`,
 *   `double`: `number`
 * - `SInt64`, `UInt64`, `long long`, `unsigned long long`, `FileSize`:
 *   `bigint`, always (D9)
 * - `bool`: `boolean`; `string`: `string` (UTF-8)
 * - `TypelessData` and vectors of `UInt8` / `SInt8` / `char`: `Uint8Array`, a
 *   view into the object's bytes (R7)
 * - any other vector, `set` or `staticvector`: an array
 * - `map`: an array of `[key, value]` pairs; `pair`: `[first, second]`
 * - any other node with children (a class, a PPtr): an object keyed by field
 *   name in type tree order, e.g. `{ m_FileID: number, m_PathID: bigint }`
 */
export type TypeTreeValue =
  | number
  | bigint
  | boolean
  | string
  | Uint8Array
  | TypeTreeValue[]
  | TypeTreeObject;

/** A class read by {@link readTypeTree}: field name to value, in type tree order. */
export interface TypeTreeObject {
  [field: string]: TypeTreeValue;
}

/** A node list with, per node, the index just past its subtree. */
interface Tree {
  nodes: TypeTreeNode[];
  end: number[];
}

interface Walk {
  reader: ObjectReader;
  /** Ref type trees built so far, for `[SerializeReference]` data. */
  refTrees: Map<SerializedType, Tree>;
  /**
   * Set by the class that holds a `ManagedReferencesRegistry` field, for the
   * rest of that class and everything read under it (UnityPy `has_registry`).
   */
  classHasRegistry: boolean;
}

/**
 * Read an object into a plain JS object by walking its type tree (upstream
 * `TypeTreeHelper.ReadType`). This decodes any class, including script data,
 * as long as the file was built with type trees.
 *
 * Reads from the object's first byte whatever the reader's position, and
 * leaves the reader at its end.
 *
 * Floats are plain `number`s, exactly as `DataView` returns them, so -0 and
 * Infinity survive. The reader never canonicalizes NaN itself, so a NaN keeps
 * its sign bit wherever the engine keeps it: V8 (Node, Chromium) does, while
 * SpiderMonkey (Firefox) and JavaScriptCore (Safari) turn every NaN into
 * `0x7FC00000`, which ECMAScript allows. That is documented, not worked
 * around (#25's acceptance, as amended on PR #97).
 *
 * `[SerializeReference]` data (`ManagedReferencesRegistry`) is read in both
 * layouts. Version 2 (Unity 2021+) is an ordinary `RefIds` vector. In version 1
 * (Unity 2019.3 to 2020) the type tree describes one entry, `00000000`, but
 * the data holds every entry and then a `Terminus` sentinel; the entries come
 * back keyed by their id as 8 uppercase hex digits (`00000000`, ...,
 * `00000009`, `0000000A`), as Unity's YAML names them, and the sentinel is
 * consumed, not returned. Each entry's `data` is read with the file's ref type
 * of the same class, namespace and assembly, and left out for a null entry
 * (empty class). A ref type's own `ManagedReferencesRegistry` field has no
 * data, so it is left out, as UnityPy does.
 *
 * @param reader the object to read
 * @returns the object's fields by name
 * @throws {UnsupportedError} when the file has no type tree for the object
 *   (built with `DisableWriteTypeTree`): the data is valid, but only a
 *   hand-written class reader can read it
 * @throws {CorruptError} when the data runs out, holds a negative or impossible
 *   count, references a ref type the file does not declare, or ends after
 *   more or fewer bytes than the object's `byteSize`
 */
export function readTypeTree(reader: ObjectReader): TypeTreeObject {
  const nodes = reader.serializedType?.nodes ?? null;
  if (nodes === null || nodes.length === 0) {
    throw new UnsupportedError(
      "object without a type tree",
      `class ${reader.type}, path id ${reader.pathId}`,
      "the file was built without type trees",
    );
  }

  const walk: Walk = { reader, refTrees: new Map(), classHasRegistry: false };
  reader.position = 0;
  // The root's own align flag is not applied, as upstream reads its children only.
  const value = readClass(walk, tree(nodes), 0);

  if (reader.position !== reader.byteSize) {
    throw new CorruptError(
      `type tree of object ${reader.pathId} (class ${reader.type}) read ${reader.position} ` +
        `bytes but expected ${reader.byteSize} bytes`,
    );
  }
  return value;
}

/** Index a node list: `end[i]` is the first node after node `i`'s subtree. */
function tree(nodes: TypeTreeNode[]): Tree {
  const end = new Array<number>(nodes.length);
  // Nodes whose subtree is still open, deepest last.
  const open: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const level = nodes[i]!.level;
    while (open.length > 0 && nodes[open[open.length - 1]!]!.level >= level) {
      end[open.pop()!] = i;
    }
    open.push(i);
  }
  for (const i of open) end[i] = nodes.length;
  return { nodes, end };
}

/** Upstream `ReadValue`: one node's value, then its alignment. */
function readValue(walk: Walk, t: Tree, i: number): TypeTreeValue {
  const { reader } = walk;
  const node = t.nodes[i]!;
  let align = (node.metaFlag & ALIGN_BYTES) !== 0;
  let value: TypeTreeValue;

  switch (node.type) {
    case "SInt8":
      value = reader.readInt8();
      break;
    case "UInt8":
    // Upstream reads 2 bytes (a C# char); the node is 1 byte, as UnityPy reads it.
    case "char":
      value = reader.readUInt8();
      break;
    case "short":
    case "SInt16":
      value = reader.readInt16();
      break;
    case "UInt16":
    case "unsigned short":
      value = reader.readUInt16();
      break;
    case "int":
    case "SInt32":
      value = reader.readInt32();
      break;
    case "UInt32":
    case "unsigned int":
    case "Type*":
      value = reader.readUInt32();
      break;
    case "long long":
    case "SInt64":
      value = reader.readInt64();
      break;
    case "UInt64":
    case "unsigned long long":
    case "FileSize":
      value = reader.readUInt64();
      break;
    case "float":
      value = reader.readFloat32();
      break;
    case "double":
      value = reader.readFloat64();
      break;
    case "bool":
      value = reader.readUInt8() !== 0;
      break;
    case "string":
      value = reader.readAlignedString();
      break;
    case "TypelessData":
      value = reader.readBytes(readCount(reader, `"${node.name}" TypelessData byte`));
      break;
    default: {
      const child = i + 1;
      if (child < t.end[i]! && t.nodes[child]!.type === "Array") {
        // vector, map, set, staticvector: the Array node's flag aligns the whole.
        if ((t.nodes[child]!.metaFlag & ALIGN_BYTES) !== 0) align = true;
        value = readArray(walk, t, child, node.type === "map");
      } else if (node.type === "pair") {
        value = readPair(walk, t, i);
      } else if (node.type === "ReferencedObject") {
        value = readReferencedObject(walk, t, i).value;
      } else if (node.type === "ManagedReferencesRegistry") {
        value = readRegistry(walk, t, i);
      } else {
        value = readClass(walk, t, i);
      }
    }
  }

  if (align) reader.align(4);
  return value;
}

/**
 * Every child of node `i`, by name. A node without children reads as `{}`.
 *
 * A class with a `ManagedReferencesRegistry` field sets `classHasRegistry` for
 * the rest of itself and everything read under it, and clears it when it
 * ends, as UnityPy's `has_registry` does. Any registry field met while it is
 * set is left out: the type tree of a ref type whose class has
 * `[SerializeReference]` fields carries a registry node of its own, but the
 * host object's one registry holds every entry, so the data has no bytes for it.
 */
function readClass(walk: Walk, t: Tree, i: number): TypeTreeObject {
  const outer = walk.classHasRegistry;
  const out: TypeTreeObject = {};
  for (let c = i + 1; c < t.end[i]!; c = t.end[c]!) {
    const child = t.nodes[c]!;
    if (child.type === "ManagedReferencesRegistry") {
      if (walk.classHasRegistry) continue;
      walk.classHasRegistry = true;
    }
    setField(out, child.name, readValue(walk, t, c));
  }
  walk.classHasRegistry = outer;
  return out;
}

/**
 * An `Array` node's elements: an `Int32` count, then the element node (its
 * second child, after `size`) that many times.
 */
function readArray(walk: Walk, t: Tree, arrayIndex: number, isMap: boolean): TypeTreeValue {
  const { reader } = walk;
  const sizeIndex = arrayIndex + 1;
  const arrayEnd = t.end[arrayIndex]!;
  // Check the size child first: past the tree's last node, `t.end` has no entry.
  const element = sizeIndex < arrayEnd ? t.end[sizeIndex]! : arrayEnd;
  if (element >= arrayEnd) {
    throw new CorruptError(
      `type tree Array "${t.nodes[arrayIndex]!.name}" lacks its size or element node`,
    );
  }
  const elementNode = t.nodes[element]!;
  // ponytail: refuses more elements than bytes left, which a vector of empty
  // (0-byte) structs could in theory legitimately hold; relax for 0-size elements.
  const count = readCount(reader, `"${t.nodes[arrayIndex - 1]!.name}" array element`);

  if (BYTE_TYPES.has(elementNode.type) && (elementNode.metaFlag & ALIGN_BYTES) === 0) {
    return reader.readBytes(count);
  }
  const values: TypeTreeValue[] = [];
  for (let k = 0; k < count; k++) {
    // Upstream's map path reads the pair's two halves without the pair's own
    // align flag; a pair anywhere else is a node like any other.
    const pairOfMap = isMap && elementNode.type === "pair";
    values.push(pairOfMap ? readPair(walk, t, element) : readValue(walk, t, element));
  }
  return values;
}

/** A `pair` as `[first, second]`, without the pair node's own alignment. */
function readPair(walk: Walk, t: Tree, i: number): TypeTreeValue[] {
  const first = i + 1;
  const second = t.end[first]!;
  if (first >= t.end[i]! || second >= t.end[i]!) {
    throw new CorruptError(`type tree pair "${t.nodes[i]!.name}" lacks its first or second node`);
  }
  return [readValue(walk, t, first), readValue(walk, t, second)];
}

/** Class, namespace and assembly of the sentinel that ends a version 1 registry. */
const TERMINUS = { class: "Terminus", ns: "UnityEngine.DMAT", asm: "FAKE_ASM" };

/**
 * One `[SerializeReference]` entry: its fields in order (`rid` in version 2,
 * then `type` = `{class, ns, asm}`), and `data` read with the ref type `type`
 * names (UnityPy's `get_ref_type_node`).
 *
 * @returns the entry, and whether it is the version 1 `Terminus` sentinel, in
 *   which case its `data` is not read: the sentinel has none
 */
function readReferencedObject(
  walk: Walk,
  t: Tree,
  i: number,
): { value: TypeTreeObject; terminus: boolean } {
  const out: TypeTreeObject = {};
  for (let c = i + 1; c < t.end[i]!; c = t.end[c]!) {
    const child = t.nodes[c]!;
    if (child.type !== "ReferencedObjectData") {
      setField(out, child.name, readValue(walk, t, c));
      continue;
    }
    const type = out.type as TypeTreeObject | undefined;
    const cls = type?.class;
    const ns = type?.ns;
    const asm = type?.asm;
    if (cls === TERMINUS.class && ns === TERMINUS.ns && asm === TERMINUS.asm) {
      return { value: out, terminus: true };
    }
    // A null reference names no class and carries no data.
    if (cls === "") continue;
    setField(out, child.name, readRefData(walk, cls, ns, asm));
  }
  return { value: out, terminus: false };
}

/** The data of one referenced object, read with the ref type it names. */
function readRefData(walk: Walk, cls: unknown, ns: unknown, asm: unknown): TypeTreeValue {
  const { reader } = walk;
  const refType = reader.refTypes.find(
    (r) => r.className === cls && r.namespace === ns && r.assemblyName === asm,
  );
  if (!refType) {
    throw new CorruptError(
      `object ${reader.pathId} references [SerializeReference] type ` +
        `"${String(cls)}" "${String(ns)}" "${String(asm)}", which the file does not declare`,
    );
  }
  if (refType.nodes === null || refType.nodes.length === 0) {
    throw new UnsupportedError("ref type without a type tree", String(cls));
  }
  let t = walk.refTrees.get(refType);
  if (!t) {
    t = tree(refType.nodes);
    walk.refTrees.set(refType, t);
  }
  return readValue(walk, t, 0);
}

/**
 * A `ManagedReferencesRegistry`. Version 2 has a `RefIds` vector and needs
 * nothing special. Version 1 has a single `ReferencedObject` child standing
 * for every entry: read entries until the `Terminus` sentinel, which is
 * consumed and not returned. The golden oracle (UnityPy 1.25.3) and upstream
 * both read only the first entry, so they stop before the entries after it
 * and the sentinel: 44 bytes short when there is one entry.
 */
function readRegistry(walk: Walk, t: Tree, i: number): TypeTreeObject {
  const out: TypeTreeObject = {};
  for (let c = i + 1; c < t.end[i]!; c = t.end[c]!) {
    const child = t.nodes[c]!;
    if (child.type !== "ReferencedObject") {
      setField(out, child.name, readValue(walk, t, c));
      continue;
    }
    const align = (child.metaFlag & ALIGN_BYTES) !== 0;
    for (let k = 0; ; k++) {
      const entry = readReferencedObject(walk, t, c);
      if (align) walk.reader.align(4);
      if (entry.terminus) break;
      // Entries are stored in id order, without the id. Unity's YAML names each
      // by its id in 8 uppercase hex digits: 00000009, then 0000000A (2019.4
      // and 2020.3, #96).
      setField(out, k.toString(16).toUpperCase().padStart(8, "0"), entry.value);
    }
  }
  return out;
}

/**
 * Set a field by name. A name comes from the file, so `__proto__` is defined
 * as an own property rather than assigned, which would replace the prototype.
 */
function setField(target: TypeTreeObject, name: string, value: TypeTreeValue): void {
  if (name === "__proto__") {
    Object.defineProperty(target, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    target[name] = value;
  }
}
