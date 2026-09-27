import assert from "node:assert/strict";
import { test } from "node:test";

import { fixtureNames, golden, loadFixture } from "../../../fixtures/helpers.js";
import { load } from "../src/env.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { ClassID } from "../src/serialized/ClassID.js";
import { ObjectReader } from "../src/serialized/ObjectReader.js";
import { readSerializedFile, type SerializedFile } from "../src/serialized/SerializedFile.js";
import type { TypeTreeNode } from "../src/serialized/TypeTree.js";
import {
  readTypeTree,
  type TypeTreeObject,
  type TypeTreeValue,
} from "../src/serialized/TypeTreeReader.js";

// --- plan §5 normalization, written from the golden format, not our output ---

/** A type tree node with its children, rebuilt from the flat pre-order list. */
interface Node {
  type: string;
  name: string;
  children: Node[];
}

function nest(nodes: TypeTreeNode[]): Node {
  const stack: { node: Node; level: number }[] = [];
  let root: Node | undefined;
  for (const n of nodes) {
    const node: Node = { type: n.type, name: n.name, children: [] };
    while (stack.length > 0 && stack[stack.length - 1]!.level >= n.level) stack.pop();
    if (stack.length === 0) root = node;
    else stack[stack.length - 1]!.node.children.push(node);
    stack.push({ node, level: n.level });
  }
  assert.ok(root, "empty type tree");
  return root;
}

const INT64_TYPES = new Set(["SInt64", "UInt64", "long long", "unsigned long long", "FileSize"]);
const BYTE_TYPES = new Set(["UInt8", "SInt8", "char"]);

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

function floatBits(value: number, size: 4 | 8): string {
  const view = new DataView(new ArrayBuffer(size));
  if (size === 4) view.setFloat32(0, value);
  else view.setFloat64(0, value);
  return hex(new Uint8Array(view.buffer));
}

/**
 * `make-goldens.py`'s `normalize`, driven by the type tree node: int64 as a
 * decimal string, float and double by bit pattern, bytes as hex, pairs as
 * two-element lists. It also asserts the JS type each node must come back as.
 */
function normalize(node: Node, value: unknown, sf: SerializedFile): unknown {
  const where = `${node.type} ${node.name}`;
  if (INT64_TYPES.has(node.type)) {
    assert.equal(typeof value, "bigint", `${where} is not a bigint (D9)`);
    return String(value);
  }
  if (node.type === "float") {
    assert.equal(typeof value, "number", `${where} is not a number`);
    return `f32:${floatBits(value as number, 4)}`;
  }
  if (node.type === "double") {
    assert.equal(typeof value, "number", `${where} is not a number`);
    return `f64:${floatBits(value as number, 8)}`;
  }
  if (value instanceof Uint8Array) {
    const element = node.children[0]?.children[1];
    assert.ok(
      node.type === "TypelessData" || (element && BYTE_TYPES.has(element.type)),
      `${where} came back as bytes`,
    );
    return `hex:${hex(value)}`;
  }
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (node.type === "pair") {
    assert.ok(Array.isArray(value) && value.length === 2, `${where} is not a [first, second] pair`);
    return [normalize(node.children[0]!, value[0], sf), normalize(node.children[1]!, value[1], sf)];
  }
  if (node.children[0]?.type === "Array") {
    assert.ok(Array.isArray(value), `${where} is not an array`);
    const element = node.children[0].children[1]!;
    return value.map((v) => normalize(element, v, sf));
  }
  assert.ok(value !== null && typeof value === "object", `${where} is not an object`);
  const fields = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(fields)) {
    let child = node.children.find((c) => c.name === key);
    // A version 1 registry names entries 00000000, 00000001, ... after its one entry node.
    if (!child && node.type === "ManagedReferencesRegistry") {
      child = node.children.find((c) => c.type === "ReferencedObject");
    }
    assert.ok(child, `${where} has no field ${key}`);
    if (child.type === "ReferencedObjectData") {
      const type = fields.type as { class: string; ns: string; asm: string };
      const ref = sf.refTypes.find(
        (r) => r.className === type.class && r.namespace === type.ns && r.assemblyName === type.asm,
      );
      assert.ok(ref?.nodes, `no ref type ${type.class}`);
      out[key] = normalize(nest(ref.nodes), v, sf);
    } else {
      out[key] = normalize(child, v, sf);
    }
  }
  return out;
}

// --- fixtures -----------------------------------------------------------------

/** Every fixture whose golden describes at least one SerializedFile. */
const SERIALIZED_FIXTURES = fixtureNames().filter((name) => golden(name).serialized);

/** The unpacked bytes of one SerializedFile node of a fixture. */
function node(name: string, path: string): Uint8Array {
  const file = load([{ name, data: loadFixture(name) }]).files.find((f) => f.path === path);
  assert.ok(file, `${name} has no node ${path}`);
  return file.data;
}

/** One object of a fixture node, with its file. */
function object(
  name: string,
  path: string,
  pathId: string,
): { data: Uint8Array; sf: SerializedFile; reader: ObjectReader } {
  const data = node(name, path);
  const sf = readSerializedFile(data);
  const info = sf.objects.find((o) => String(o.pathId) === pathId);
  assert.ok(info, `${name}:${path} has no object ${pathId}`);
  return { data, sf, reader: new ObjectReader(data, sf, info) };
}

/** The first object of a class in a fixture's SerializedFile node. */
function objectOf(name: string, classId: number): ReturnType<typeof object> {
  for (const path of Object.keys(golden(name).serialized!)) {
    const data = node(name, path);
    const sf = readSerializedFile(data);
    const info = sf.objects.find((o) => o.classId === classId);
    if (info) return { data, sf, reader: new ObjectReader(data, sf, info) };
  }
  assert.fail(`${name} has no object of class ${classId}`);
}

/** Every typetree dump in the goldens: 6 classes, 3 editors, 3 variants. */
const DUMPS = SERIALIZED_FIXTURES.flatMap((name) =>
  Object.entries(golden(name).serialized!).flatMap(([path, expected]) =>
    Object.entries(expected.typetrees).map(([pathId, dump]) => ({ name, path, pathId, dump })),
  ),
);

/**
 * `value` cut to what the oracle read. UnityPy reads only the first entry of a
 * version 1 registry, and the golden's note says how many it left unread
 * (#96); those are checked against Unity's YAML further down.
 */
function asOracleRead(value: TypeTreeObject, dump: { value: unknown; oracleNote?: string }) {
  const registry = value.references as TypeTreeObject | undefined;
  if (dump.oracleNote === undefined || registry === undefined) return value;
  const read = Object.keys((dump.value as { references: object }).references);
  const kept = Object.entries(registry).filter(([key]) => read.includes(key));
  const left = Number(/before the other (\d+)/.exec(dump.oracleNote)?.[1] ?? 0);
  assert.equal(Object.keys(registry).length - kept.length, left, "v1 entries past the oracle's");
  return { ...value, references: Object.fromEntries(kept) };
}

// --- every golden dump ----------------------------------------------------------

for (const { name, path, pathId, dump } of DUMPS) {
  test(`${name}: object ${pathId} reads as the golden typetree dump`, () => {
    const { sf, reader } = object(name, path, pathId);
    const value = asOracleRead(readTypeTree(reader), dump);
    assert.equal(reader.position, reader.byteSize);
    const normalized = normalize(nest(reader.serializedType!.nodes!), value, sf);
    assert.deepEqual(normalized, dump.value);
    // Same fields in the same (type tree) order, which deepEqual does not check.
    assert.equal(JSON.stringify(normalized), JSON.stringify(dump.value));
  });
}

test("the golden dumps cover all six classes in format 21 and in format 22", () => {
  const seen = new Set<string>();
  for (const { name, path, pathId } of DUMPS) {
    const { reader } = object(name, path, pathId);
    seen.add(`${reader.format}:${reader.type}`);
  }
  const classes = [
    ClassID.TextAsset,
    ClassID.MonoBehaviour,
    ClassID.Mesh,
    ClassID.Texture2D,
    ClassID.AssetBundle,
    ClassID.AssetBundleManifest,
  ];
  for (const format of [21, 22]) {
    for (const classId of classes) {
      const key = `${format}:${classId}`;
      assert.ok(seen.has(key), `no dump of class ${classId} in format ${format}`);
    }
  }
});

test("ObjectReader.readTypeTree() is readTypeTree(), from the object's first byte", () => {
  const { reader } = objectOf("editor/6000.3.25f1/lz4/shared", ClassID.TextAsset);
  const expected = readTypeTree(reader);
  reader.position = 7;
  assert.deepEqual(reader.readTypeTree(), expected);
  assert.equal(reader.position, reader.byteSize);
});

test("plan §3 end to end: load() -> env.objects -> obj.readTypeTree() equals the golden", () => {
  for (const name of ["editor/2019.4.41f2/lz4/shared", "editor/6000.3.25f1/lz4/shared"]) {
    const env = load([{ name, data: loadFixture(name) }]);
    const obj = env.objects.find((o) => o.type === ClassID.TextAsset);
    assert.ok(obj, `${name}: no TextAsset in env.objects`);
    const dump = Object.values(golden(name).serialized!)
      .map((s) => s.typetrees[String(obj.pathId)])
      .find((d) => d !== undefined);
    assert.ok(dump, `${name}: no golden dump for ${obj.pathId}`);
    // A TextAsset has only strings, which the §5 normalization leaves as they are.
    assert.deepEqual(obj.readTypeTree(), dump.value, name);
  }
});

// --- value shapes ---------------------------------------------------------------

/** The `main` MonoBehaviour's fields that the shape tests look at. */
interface Data extends TypeTreeObject {
  i64: bigint;
  u64: bigint;
  fNaN: number;
  bytes: Uint8Array;
  textRef: TypeTreeObject;
}

// #25 as amended on PR #97: the reader must not canonicalize NaN itself. It
// cannot do better than the engine (SpiderMonkey and JavaScriptCore collapse
// every NaN to 0x7FC00000), so this proves the pass-through where the engine
// keeps the bits: on V8 any canonicalization in the reader turns the lz4
// builds' 0xFFC00000 into 0x7FC00000 and fails here.
test("passes a NaN's bits through: on V8 0xFFC00000 (lz4) and 0x7FC00000 (rest) survive", () => {
  const raw = new DataView(Uint8Array.from([0xff, 0xc0, 0, 0]).buffer).getFloat32(0);
  assert.equal(floatBits(raw, 4), "ffc00000", "this engine canonicalizes NaN; run on V8");
  for (const editor of ["2019.4.41f2", "2020.3.30f1", "6000.3.25f1"]) {
    for (const [variant, bits] of [
      ["lz4", "ffc00000"],
      ["lzma", "7fc00000"],
      ["uncompressed", "7fc00000"],
    ] as const) {
      const { reader } = objectOf(`editor/${editor}/${variant}/main`, ClassID.MonoBehaviour);
      const data = reader.readTypeTree() as Data;
      assert.ok(Number.isNaN(data.fNaN));
      assert.equal(floatBits(data.fNaN, 4), bits, `${editor}/${variant}`);
    }
  }
});

test("int64 fields are bigint beyond 2^53, PPtrs are { m_FileID, m_PathID: bigint }", () => {
  const { reader } = objectOf("editor/6000.3.25f1/lzma/main", ClassID.MonoBehaviour);
  const data = reader.readTypeTree() as Data;
  assert.equal(data.i64, -9007199254740993n);
  assert.equal(data.u64, 18446744073709551615n);
  assert.deepEqual(Object.keys(data.textRef), ["m_FileID", "m_PathID"]);
  assert.equal(data.textRef.m_FileID, 1);
  assert.equal(typeof data.textRef.m_PathID, "bigint");
});

test("TypelessData and byte vectors are views into the input, not copies (R7)", () => {
  const { data, reader } = objectOf("editor/2020.3.30f1/uncompressed/main", ClassID.Mesh);
  const mesh = reader.readTypeTree() as {
    m_VertexData: { m_DataSize: Uint8Array };
    m_IndexBuffer: Uint8Array;
  };
  const vertices = mesh.m_VertexData.m_DataSize;
  assert.ok(vertices instanceof Uint8Array);
  assert.equal(vertices.length, 36);
  assert.equal(vertices.buffer, data.buffer);
  assert.equal(mesh.m_IndexBuffer.length, 6);
  assert.equal(mesh.m_IndexBuffer.buffer, data.buffer);

  const mono = objectOf("editor/2020.3.30f1/uncompressed/main", ClassID.MonoBehaviour);
  const bytes = (mono.reader.readTypeTree() as Data).bytes;
  assert.deepEqual([...bytes], [0, 1, 2, 255]);
  assert.equal(bytes.buffer, mono.data.buffer);
});

test("an empty TypelessData is an empty Uint8Array (Texture2D image data)", () => {
  for (const editor of ["2019.4.41f2", "2020.3.30f1", "6000.3.25f1"]) {
    const { reader } = objectOf(`editor/${editor}/lz4/texture`, ClassID.Texture2D);
    const texture = reader.readTypeTree();
    const image = texture["image data"];
    assert.ok(image instanceof Uint8Array, editor);
    assert.equal(image.length, 0, editor);
  }
});

test("a map is an array of [key, value] pairs, string and int keys alike", () => {
  const bundle = objectOf("editor/2019.4.41f2/lz4/main", ClassID.AssetBundle).reader.readTypeTree();
  const container = bundle.m_Container as [string, TypeTreeObject][];
  assert.deepEqual(
    container.map(([key]) => key),
    ["assets/fixtures/main/data.asset", "assets/fixtures/main/tri.asset"],
  );
  const manifest = objectOf("editor/2019.4.41f2/lz4/lz4", ClassID.AssetBundleManifest);
  const names = manifest.reader.readTypeTree().AssetBundleNames;
  assert.deepEqual(names, [
    [0, "shared"],
    [1, "main"],
    [2, "texture"],
  ]);
});

// --- [SerializeReference] registry, version 1 -----------------------------------

/** The 44-byte entry that ends a version 1 registry: Terminus / UnityEngine.DMAT / FAKE_ASM. */
const TERMINUS = Uint8Array.from([
  ...[8, 0, 0, 0],
  ...Buffer.from("Terminus"),
  ...[16, 0, 0, 0],
  ...Buffer.from("UnityEngine.DMAT"),
  ...[8, 0, 0, 0],
  ...Buffer.from("FAKE_ASM"),
]);

const V1_FIXTURES = ["2019.4.41f2", "2020.3.30f1"].flatMap((editor) =>
  ["lz4", "lzma", "uncompressed"].map((variant) => `editor/${editor}/${variant}/main`),
);

/** The first object of a class in a fixture, with its raw bytes. */
function rawObject(
  name: string,
  classId: number = ClassID.MonoBehaviour,
): ReturnType<typeof object> & { bytes: Uint8Array } {
  const found = objectOf(name, classId);
  const bytes = found.reader.readBytes(found.reader.byteSize);
  found.reader.position = 0;
  return { ...found, bytes };
}

/** A reader over `bytes` as if they were the object's data. */
function readerOver(bytes: Uint8Array, sf: SerializedFile, like: ObjectReader): ObjectReader {
  const info = sf.objects.find((o) => o.pathId === like.pathId)!;
  return new ObjectReader(bytes, sf, { ...info, byteStart: 0, byteSize: bytes.length });
}

/** A hand-built type tree node. */
function at(level: number, type: string, name: string): TypeTreeNode {
  return {
    type,
    name,
    byteSize: -1,
    index: 0,
    typeFlags: 0,
    version: 1,
    metaFlag: 0,
    level,
    typeStrOffset: 0,
    nameStrOffset: 0,
    refTypeHash: 0n,
  };
}

test("v1 registry: the golden notes UnityPy stopping 44 bytes short; we read to byteSize", () => {
  for (const name of V1_FIXTURES) {
    const { reader, bytes } = rawObject(name);
    const dump = Object.values(golden(name).serialized!)
      .map((s) => s.typetrees[String(reader.pathId)])
      .find((d) => d !== undefined);
    assert.ok(dump, `${name}: no golden dump`);
    assert.match(dump.oracleNote ?? "", /Terminus sentinel \(44 bytes/, name);
    // The 44 bytes UnityPy leaves unread are exactly the sentinel ...
    assert.deepEqual(bytes.subarray(bytes.length - 44), TERMINUS, name);
    // ... and we consume them without returning them.
    const value = reader.readTypeTree();
    assert.equal(reader.position, reader.byteSize, name);
    assert.deepEqual(Object.keys(value.references as TypeTreeObject), ["version", "00000000"]);
  }
});

/** The first v1 entry's bytes: from its `class` string to the sentinel. */
function firstEntry(bytes: Uint8Array): { start: number; end: number } {
  const needle = Uint8Array.from([8, 0, 0, 0, ...Buffer.from("RefChild")]);
  const start = Buffer.from(bytes).indexOf(needle);
  assert.ok(start > 0, "no RefChild entry");
  return { start, end: bytes.length - TERMINUS.length };
}

test("v1 registry: reads every entry up to the sentinel, not just the one the tree names", () => {
  const { sf, reader, bytes } = rawObject("editor/2019.4.41f2/uncompressed/main");
  const { start, end } = firstEntry(bytes);
  const second = new Uint8Array(bytes.subarray(start, end));
  // RefChild data is `int id` then `string label` "ref" (4 + 3 + 1 pad): id is 12 from the end.
  new DataView(second.buffer).setInt32(second.length - 12, 10, true);
  const spliced = Uint8Array.from([...bytes.subarray(0, end), ...second, ...TERMINUS]);

  const value = readerOver(spliced, sf, reader).readTypeTree();
  const type = { class: "RefChild", ns: "", asm: "Assembly-CSharp" };
  assert.deepEqual(value.references, {
    version: 1,
    "00000000": { type, data: { id: 9, label: "ref" } },
    "00000001": { type, data: { id: 10, label: "ref" } },
  });
});

test("v1 registry: throws CorruptError when the sentinel is missing", () => {
  const { sf, reader, bytes } = rawObject("editor/2020.3.30f1/lzma/main");
  const cut = bytes.subarray(0, bytes.length - TERMINUS.length);
  assert.throws(() => readerOver(cut, sf, reader).readTypeTree(), CorruptError);
});

test("throws CorruptError naming the type when an entry's ref type is not in the file", () => {
  const { sf, reader, bytes } = rawObject("editor/2019.4.41f2/lzma/main");
  const copy = new Uint8Array(bytes);
  copy[firstEntry(bytes).start + 4 + 7] = "X".charCodeAt(0); // RefChild -> RefChilX
  assert.throws(
    () => readerOver(copy, sf, reader).readTypeTree(),
    (err: unknown) => err instanceof CorruptError && err.message.includes('"RefChilX"'),
  );
});

const holder = { class: "RefHolder", ns: "", asm: "Assembly-CSharp" };
const leaf = { class: "RefLeaf", ns: "", asm: "Assembly-CSharp" };

// Copied by hand from Unity's YAML of the asset the `registry/refs` bundles are
// built from (Assets/Fixtures/registry/registry.asset, the same in 2019.4.41f2
// and 2020.3.30f1), never from our output (R12). The oracle reads only the
// first entry, so this is what checks the rest, and their keys: Unity names a
// v1 entry by its id in 8 uppercase hex digits, so the eleventh is 0000000A.
const REGISTRY_YAML = {
  version: 1,
  "00000000": { type: holder, data: { n: 0, inner: { id: 12 } } },
  "00000001": { type: leaf, data: { n: 1 } },
  "00000002": { type: leaf, data: { n: 2 } },
  "00000003": { type: leaf, data: { n: 3 } },
  "00000004": { type: leaf, data: { n: 4 } },
  "00000005": { type: leaf, data: { n: 5 } },
  "00000006": { type: leaf, data: { n: 6 } },
  "00000007": { type: leaf, data: { n: 7 } },
  "00000008": { type: leaf, data: { n: 8 } },
  "00000009": { type: leaf, data: { n: 9 } },
  "0000000A": { type: leaf, data: { n: 10 } },
  "0000000B": { type: leaf, data: { n: 11 } },
  "0000000C": { type: leaf, data: { n: 100 } },
};

test("v1 registry: 13 entries come back named as in Unity's YAML (0000000A, not 00000010)", () => {
  for (const editor of ["2019.4.41f2", "2020.3.30f1"]) {
    const { reader } = objectOf(`editor/${editor}/registry/refs`, ClassID.MonoBehaviour);
    const references = reader.readTypeTree().references as TypeTreeObject;
    assert.equal(reader.position, reader.byteSize, editor);
    assert.deepEqual(references, REGISTRY_YAML, editor);
    assert.deepEqual(Object.keys(references), Object.keys(REGISTRY_YAML), editor);
  }
});

// --- [SerializeReference] registry nested in a ref type -----------------------------

test("a ref type's own registry node is in its type tree, in every editor", () => {
  for (const editor of ["2019.4.41f2", "2020.3.30f1", "6000.3.25f1"]) {
    const { sf } = objectOf(`editor/${editor}/registry/refs`, ClassID.MonoBehaviour);
    const refType = sf.refTypes.find((r) => r.className === "RefHolder");
    const nested = refType?.nodes?.filter((n) => n.type === "ManagedReferencesRegistry");
    assert.equal(nested?.length, 1, editor);
  }
});

test("a ref type's own registry is left out and reads no bytes, as in UnityPy (v1 and v2)", () => {
  for (const editor of ["2019.4.41f2", "2020.3.30f1", "6000.3.25f1"]) {
    const { reader } = objectOf(`editor/${editor}/registry/refs`, ClassID.MonoBehaviour);
    const references = reader.readTypeTree().references as TypeTreeObject;
    assert.equal(reader.position, reader.byteSize, editor);
    const entries =
      references.version === 1
        ? Object.values(references).slice(1)
        : (references.RefIds as TypeTreeValue[]);
    const first = entries[0] as { type: TypeTreeObject; data: TypeTreeObject };
    assert.equal(first.type.class, "RefHolder", editor);
    assert.deepEqual(Object.keys(first.data), ["n", "inner"], editor);
  }
});

test("a registry met inside another is skipped until the class holding the outer one ends", () => {
  const { sf, reader } = objectOf("editor/6000.3.25f1/lzma/shared", ClassID.TextAsset);
  const info = sf.objects.find((o) => o.pathId === reader.pathId)!;
  const registry = (level: number) => [
    at(level, "ManagedReferencesRegistry", "references"),
    at(level + 1, "int", "version"),
  ];
  const nodes = [
    at(0, "Base", "Base"),
    at(1, "Holder", "a"),
    ...registry(2), // read: the flag set inside `a` ends with `a`
    ...registry(1), // read, and sets the flag for the rest of Base
    at(1, "Holder", "b"),
    ...registry(2), // skipped: inside Base's registry flag
  ];
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setInt32(0, 1, true);
  new DataView(bytes.buffer).setInt32(4, 2, true);
  const synthetic = new ObjectReader(bytes, sf, {
    ...info,
    byteStart: 0,
    byteSize: bytes.length,
    serializedType: { ...info.serializedType!, nodes },
  });
  assert.deepEqual(synthetic.readTypeTree(), {
    a: { references: { version: 1 } },
    references: { version: 2 },
    b: {},
  });
});

// --- unhappy paths ----------------------------------------------------------------

test("throws UnsupportedError for an object in a file built without type trees", () => {
  const { reader } = objectOf("editor/6000.3.25f1/lz4-notypetree/main", ClassID.MonoBehaviour);
  assert.equal(reader.serializedType?.nodes, null);
  assert.throws(
    () => reader.readTypeTree(),
    (err: unknown) =>
      err instanceof UnsupportedError && err.message.includes(`path id ${reader.pathId}`),
  );
});

test("throws CorruptError naming both sizes when the tree ends before byteSize", () => {
  const { sf, reader, bytes } = rawObject("editor/2019.4.41f2/lzma/shared", ClassID.TextAsset);
  const padded = Uint8Array.from([...bytes, 0, 0, 0, 0]);
  assert.throws(
    () => readerOver(padded, sf, reader).readTypeTree(),
    (err: unknown) =>
      err instanceof CorruptError &&
      err.message.includes(`read ${bytes.length} bytes but expected ${bytes.length + 4} bytes`),
  );
});

test("throws CorruptError when the data ends before the tree does", () => {
  const { sf, reader, bytes } = rawObject("editor/6000.3.25f1/lzma/main");
  const cut = bytes.subarray(0, bytes.length - 3);
  assert.throws(() => readerOver(cut, sf, reader).readTypeTree(), CorruptError);
});

test("throws CorruptError, not TypeError, when a tree ends in an Array with no children", () => {
  const { sf, reader } = objectOf("editor/6000.3.25f1/lzma/shared", ClassID.TextAsset);
  const info = sf.objects.find((o) => o.pathId === reader.pathId)!;
  const nodes = [at(0, "Base", "Base"), at(1, "vector", "v"), at(2, "Array", "Array")];
  const synthetic = new ObjectReader(new Uint8Array(8), sf, {
    ...info,
    byteStart: 0,
    byteSize: 8,
    serializedType: { ...info.serializedType!, nodes },
  });
  assert.throws(() => synthetic.readTypeTree(), CorruptError);
});
