import assert from "node:assert/strict";
import { test } from "node:test";

import { fixtureNames, golden, loadFixture, type GoldenType } from "../../../fixtures/helpers.js";
import { load } from "../src/env.js";
import { CorruptError } from "../src/errors.js";
import { BinaryReader } from "../src/io/BinaryReader.js";
import { commonString } from "../src/serialized/CommonString.js";
import { readSerializedFile, type SerializedFile } from "../src/serialized/SerializedFile.js";
import { readSerializedType, type SerializedType } from "../src/serialized/TypeTree.js";

const hex = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : Buffer.from(bytes).toString("hex");

/** Every fixture whose golden describes at least one SerializedFile. */
const SERIALIZED_FIXTURES = fixtureNames().filter((name) => golden(name).serialized);

/** Every SerializedFile node of every fixture, parsed, with its golden. */
const FILES = SERIALIZED_FIXTURES.flatMap((name) => {
  const nodes = load([{ name, data: loadFixture(name) }]).files;
  return Object.entries(golden(name).serialized!).map(([path, expected]) => {
    const data = nodes.find((f) => f.path === path)?.data;
    assert.ok(data, `${name} has no node ${path}`);
    return { name, path, sf: readSerializedFile(data), expected };
  });
});

/** A parsed type in the shape of its golden; ref type names only where Unity wrote them. */
function asGolden(t: SerializedType): GoldenType {
  const out: GoldenType = {
    classId: t.classId,
    isStrippedType: t.isStrippedType,
    scriptTypeIndex: t.scriptTypeIndex,
    scriptId: hex(t.scriptId),
    oldTypeHash: hex(t.oldTypeHash),
    typeDependencies: t.typeDependencies,
    nodes: t.nodes && t.nodes.map((n) => [n.level, n.type, n.name, n.byteSize, n.metaFlag]),
  };
  if (t.className !== null) out.className = t.className;
  if (t.namespace !== null) out.namespace = t.namespace;
  if (t.assemblyName !== null) out.assembly = t.assemblyName;
  return out;
}

// --- every editor-built fixture against the oracle goldens -------------------

for (const { name, path, sf, expected } of FILES) {
  test(`${name}: types of ${path} match the golden, nodes included`, () => {
    assert.deepEqual(sf.types.map(asGolden), expected.types);
  });

  test(`${name}: ref types of ${path} match the golden, nodes included`, () => {
    assert.deepEqual(sf.refTypes.map(asGolden), expected.refTypes);
  });
}

/** Files of one format, with type trees or without. */
function filesOf(format: number, enableTypeTree: boolean): SerializedFile[] {
  return FILES.filter(
    (f) => f.sf.header.version === format && f.expected.enableTypeTree === enableTypeTree,
  ).map((f) => f.sf);
}

for (const format of [21, 22]) {
  test(`format ${format}: the goldens cover type and ref type nodes`, () => {
    const files = filesOf(format, true);
    assert.ok(files.some((sf) => sf.types.some((t) => (t.nodes?.length ?? 0) > 0)));
    assert.ok(files.some((sf) => sf.refTypes.some((t) => (t.nodes?.length ?? 0) > 0)));
  });

  test(`format ${format}: names come from both the file's buffer and the common strings`, () => {
    const nodes = filesOf(format, true).flatMap((sf) =>
      [...sf.types, ...sf.refTypes].flatMap((t) => t.nodes ?? []),
    );
    const common = nodes.filter((n) => n.typeStrOffset >= 0x80000000);
    const local = nodes.filter((n) => n.typeStrOffset < 0x80000000);
    assert.ok(common.length > 0 && local.length > 0);
    // A resolved common string never falls back to its offset as text.
    for (const n of common) assert.doesNotMatch(n.type, /^\d+$/);
  });

  test(`format ${format}: files built without type trees have no nodes`, () => {
    const files = filesOf(format, false);
    assert.ok(files.length > 0);
    for (const sf of files) {
      for (const t of [...sf.types, ...sf.refTypes]) {
        assert.equal(t.nodes, null);
        assert.equal(t.stringBuffer, null);
        assert.equal(t.typeDependencies, null);
        assert.equal(t.className, null);
      }
    }
  });
}

// --- common strings -----------------------------------------------------------

test("commonString looks up Unity's built-in strings by offset", () => {
  assert.equal(commonString(0), "AABB");
  assert.equal(commonString(263), "MonoBehaviour");
  assert.equal(commonString(840), "string");
  assert.equal(commonString(1161), "Hash128");
});

// Past AssetStudio's table: newer editors, with the names UnityPy 1.25.3 gives them.
for (const [offset, name] of [
  [1169, "RenderingLayerMask"],
  [1188, "fixed_array"],
  [1200, "EntityId"],
  [1209, "LoadableObjectId"],
  [1226, "LoadableSceneId"],
] as const) {
  test(`commonString resolves ${offset} to UnityPy's ${name}`, () => {
    assert.equal(commonString(offset), name);
  });
}

test("commonString falls back to the offset as text, like upstream", () => {
  assert.equal(commonString(1), "1"); // inside "AABB", not the start of a string
  // Past the end of every known table: UnityPy's last entry, 1226, is 16 bytes.
  assert.equal(commonString(1300), "1300");
});

/** A format-22 `m_Types` entry with one blob node, no hashes beyond the old type hash. */
function blobType(typeStrOffset: number, nameStrOffset: number, strings: string): Uint8Array {
  const buffer = new TextEncoder().encode(strings);
  const bytes = new Uint8Array(4 + 1 + 2 + 16 + 8 + 32 + buffer.length + 4);
  const view = new DataView(bytes.buffer);
  let at = 0;
  view.setInt32(at, 1, true); // classId: Object
  at += 4 + 1; // isStrippedType
  view.setInt16(at, -1, true); // scriptTypeIndex
  at += 2 + 16; // oldTypeHash
  view.setInt32(at, 1, true); // node count
  view.setInt32(at + 4, buffer.length, true); // string buffer size
  at += 8;
  // version u16, level u8, typeFlags u8, type and name offsets, byteSize,
  // index, metaFlag, refTypeHash u64
  view.setUint32(at + 4, typeStrOffset, true);
  view.setUint32(at + 8, nameStrOffset, true);
  view.setInt32(at + 12, -1, true);
  at += 32;
  bytes.set(buffer, at);
  at += buffer.length;
  view.setInt32(at, 0, true); // no type dependencies
  return bytes;
}

test("a blob node resolves high-bit offsets through the common strings", () => {
  const data = blobType(0x80000000 + 263, 0, "Base\0");
  const type = readSerializedType(new BinaryReader(data, "little"), 22, true, false);
  assert.deepEqual(
    type.nodes!.map((n) => [n.type, n.name]),
    [["MonoBehaviour", "Base"]],
  );
});

test("a blob node resolves a common string newer than AssetStudio's table", () => {
  const data = blobType(0x80000000 + 1200, 0x80000000 + 55, "");
  const type = readSerializedType(new BinaryReader(data, "little"), 22, true, false);
  assert.deepEqual(
    type.nodes!.map((n) => [n.type, n.name]),
    [["EntityId", "Base"]],
  );
});

test("a blob node keeps an unknown common-string offset as text", () => {
  const data = blobType(0x80000000 + 5000, 0x80000000 + 55, "");
  const type = readSerializedType(new BinaryReader(data, "little"), 22, true, false);
  assert.deepEqual(
    type.nodes!.map((n) => [n.type, n.name]),
    [["5000", "Base"]],
  );
});

test("a blob node offset past its string buffer throws CorruptError", () => {
  const data = blobType(9, 0, "Base\0");
  assert.throws(
    () => readSerializedType(new BinaryReader(data, "little"), 22, true, false),
    CorruptError,
  );
});

// --- the pre-5.0 inline layout --------------------------------------------------

/** A pre-blob (format 8) node written depth-first, as Unity stores it. */
interface LegacyNode {
  type: string;
  name: string;
  children?: LegacyNode[];
}

/** A format-8 `m_Types` entry: class id, then the inline tree, nothing after. */
function legacyType(root: LegacyNode): Uint8Array {
  const bytes: number[] = [];
  const i32 = (v: number): void => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    bytes.push(...b);
  };
  const str = (v: string): void => {
    bytes.push(...new TextEncoder().encode(v), 0);
  };
  const write = (node: LegacyNode): void => {
    str(node.type);
    str(node.name);
    // byteSize, index, typeFlags, version, metaFlag
    for (const v of [-1, 0, 0, 1, 0]) i32(v);
    i32(node.children?.length ?? 0);
    for (const child of node.children ?? []) write(child);
  };
  i32(1); // classId: Object
  write(root);
  return Uint8Array.from(bytes);
}

test("the inline layout returns to a sibling after a nested subtree", () => {
  const data = legacyType({
    type: "Root",
    name: "Base",
    children: [
      { type: "A", name: "a", children: [{ type: "A1", name: "a1" }] },
      { type: "B", name: "b" },
    ],
  });
  const reader = new BinaryReader(data, "little");
  const type = readSerializedType(reader, 8, true, false);
  assert.deepEqual(
    type.nodes!.map((n) => [n.level, n.type, n.name]),
    [
      [0, "Root", "Base"],
      [1, "A", "a"],
      [2, "A1", "a1"],
      [1, "B", "b"],
    ],
  );
  assert.equal(reader.remaining, 0);
});
