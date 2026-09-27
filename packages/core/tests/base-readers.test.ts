// Object, EditorExtension and NamedObject (#37): the hardcoded header readers,
// checked against the oracle's typetree dumps (R12).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fixtureNames,
  golden,
  loadFixture,
  type GoldenNode,
  type GoldenSerialized,
} from "../../../fixtures/helpers.js";
import { readEditorExtension } from "../src/classes/EditorExtension.js";
import { readNamedObject } from "../src/classes/NamedObject.js";
import { readObject } from "../src/classes/Object.js";
import { load } from "../src/env.js";
import { CorruptError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ClassID } from "../src/serialized/ClassID.js";
import { ObjectReader } from "../src/serialized/ObjectReader.js";
import { readSerializedFile, type SerializedFile } from "../src/serialized/SerializedFile.js";

const SERIALIZED_FIXTURES = fixtureNames().filter((name) => golden(name).serialized);
const STRIPPED_FIXTURES = SERIALIZED_FIXTURES.filter((name) => name.includes("/lz4-notypetree/"));
const TYPED_FIXTURES = SERIALIZED_FIXTURES.filter((name) => !STRIPPED_FIXTURES.includes(name));

/** The same bundle built with type trees: `lz4-notypetree` -> `lz4`, manifest included. */
const typedTwin = (name: string): string => name.replace(/lz4-notypetree/g, "lz4");

/** Every object reader of a fixture, by SerializedFile node path, then path id. */
function objectsOf(name: string): Map<string, Map<string, ObjectReader>> {
  const env = load([{ name, data: loadFixture(name) }]);
  const out = new Map<string, Map<string, ObjectReader>>();
  for (const { path, data } of env.files) {
    if (!golden(name).serialized?.[path]) continue;
    const sf = readSerializedFile(data);
    const readers = sf.objects.map((i) => new ObjectReader(data, sf, i));
    out.set(path, new Map(readers.map((r) => [String(r.pathId), r])));
  }
  return out;
}

/** The fields right below the root of the oracle's type tree for a class. */
function topFields(sf: GoldenSerialized, classId: number): GoldenNode[] {
  const type = sf.types.find((t) => t.classId === classId && t.nodes);
  assert.ok(type?.nodes, `the golden has no type tree for class ${classId}`);
  return type.nodes.filter(([level]) => level === 1);
}

/**
 * Read the field a golden type tree node describes, in the golden's normalized
 * form - enough to prove a header reader left `reader` at that field's first
 * byte. A vector or map is checked by its element count.
 */
function readField(reader: ObjectReader, [, type, name]: GoldenNode, want: unknown): void {
  let actual: unknown;
  let expected = want;
  if (type === "string") actual = reader.readAlignedString();
  else if (type === "int") actual = reader.readInt32();
  else if (type === "bool") actual = reader.readUInt8() !== 0;
  else if (type.startsWith("PPtr<")) {
    actual = { m_FileID: reader.readInt32(), m_PathID: String(reader.readInt64()) };
  } else if (type === "vector" || type === "map") {
    actual = reader.readInt32();
    expected = (want as unknown[]).length;
  } else {
    assert.fail(`no reader for golden field ${type} ${name}`);
  }
  assert.deepEqual(actual, expected, `field ${type} ${name}`);
}

/**
 * Check the header readers on one object against the oracle's dump of it:
 * `readEditorExtension` must stop at the first serialized field, and on a
 * NamedObject `readNamedObject` must read `m_Name` and stop at the next one.
 *
 * @returns whether the object was a NamedObject
 */
function checkObject(
  reader: ObjectReader,
  sf: GoldenSerialized,
  dump: Record<string, unknown>,
): boolean {
  const [first, second] = topFields(sf, reader.type);
  assert.ok(first, `class ${reader.type} has no fields`);

  // Every fixture is a player build: nothing before the first field.
  assert.deepEqual(readEditorExtension(reader), {});
  assert.equal(reader.position, 0);
  readField(reader, first, dump[first[2]]);

  if (first[2] !== "m_Name") return false;
  assert.deepEqual(readNamedObject(reader), { m_Name: dump.m_Name });
  assert.ok(second, `class ${reader.type} has nothing after m_Name`);
  readField(reader, second, dump[second[2]]);
  return true;
}

// --- editor fixtures with type trees ------------------------------------------------

for (const name of TYPED_FIXTURES) {
  test(`${name}: header readers stop where the golden's first fields start`, () => {
    for (const [path, readers] of objectsOf(name)) {
      const sf = golden(name).serialized![path]!;
      for (const [pathId, { value }] of Object.entries(sf.typetrees)) {
        const reader = readers.get(pathId);
        assert.ok(reader, `${path} has no object ${pathId}`);
        checkObject(reader, sf, value as Record<string, unknown>);
      }
    }
  });
}

test("the typed checks cover every dumped class in format 21 and in format 22", () => {
  const seen = new Set<string>();
  for (const name of TYPED_FIXTURES) {
    for (const [path, readers] of objectsOf(name)) {
      const sf = golden(name).serialized![path]!;
      for (const pathId of Object.keys(sf.typetrees)) {
        seen.add(`${sf.formatVersion}:${readers.get(pathId)!.type}`);
      }
    }
  }
  const classes = [
    ClassID.Texture2D,
    ClassID.Mesh,
    ClassID.TextAsset,
    ClassID.MonoBehaviour,
    ClassID.AssetBundle,
    ClassID.AssetBundleManifest,
  ];
  for (const format of [21, 22]) {
    for (const classId of classes) {
      assert.ok(seen.has(`${format}:${classId}`), `class ${classId} in format ${format}`);
    }
  }
});

// --- editor fixtures without type trees: the hardcoded path is the only one ----------

for (const name of STRIPPED_FIXTURES) {
  test(`${name}: names and first fields match the typed build's golden`, () => {
    const twin = golden(typedTwin(name));
    const env = load([{ name, data: loadFixture(name) }]);
    const byPathId = new Map(env.objects.map((o) => [String(o.pathId), o]));

    // Pair the SerializedFiles by position: the manifest bundle's node is named
    // after the build, so its CAB name differs between the two.
    const paths = Object.keys(golden(name).objects).sort();
    const twinPaths = Object.keys(twin.objects).sort();
    assert.equal(paths.length, twinPaths.length);

    let named = 0;
    paths.forEach((path, i) => {
      const twinPath = twinPaths[i]!;
      assert.deepEqual(golden(name).objects[path], twin.objects[twinPath], "object tables differ");
      assert.equal(golden(name).serialized![path]!.enableTypeTree, false);
      const sf = twin.serialized![twinPath]!;
      for (const [pathId, { value }] of Object.entries(sf.typetrees)) {
        const reader = byPathId.get(pathId);
        assert.ok(reader, `${path} has no object ${pathId}`);
        assert.equal(reader.serializedType?.nodes, null, "the file has a type tree after all");
        if (checkObject(reader, sf, value as Record<string, unknown>)) named++;
      }
    });
    assert.ok(named > 0, "no NamedObject was checked");
  });
}

test("the stripped fixtures cover format 21 and format 22", () => {
  const formats = STRIPPED_FIXTURES.flatMap((name) =>
    Object.values(golden(name).serialized!).map((sf) => sf.formatVersion),
  );
  assert.deepEqual([...new Set(formats)].sort(), [21, 22]);
});

// --- editor-only (NoTarget) header: no fixture is one, so the bytes are written here --

/** A TextAsset's file and object entry from a real fixture, to re-point at other bytes. */
function textAsset(): { sf: SerializedFile; info: SerializedFile["objects"][number] } {
  const name = "editor/6000.3.25f1/uncompressed/shared";
  const data = load([{ name, data: loadFixture(name) }]).files.find((f) =>
    Boolean(golden(name).serialized![f.path]),
  )!.data;
  const sf = readSerializedFile(data);
  const info = sf.objects.find((o) => o.classId === ClassID.TextAsset)!;
  assert.equal(sf.bigEndian, false);
  return { sf, info };
}

/** A reader over `bytes` for a file built for `platform` in SerializedFile `format`. */
function synthetic(bytes: Uint8Array, platform: BuildTarget, format: number): ObjectReader {
  const { sf, info } = textAsset();
  const file: SerializedFile = {
    ...sf,
    header: { ...sf.header, version: format },
    targetPlatform: platform,
  };
  return new ObjectReader(bytes, file, { ...info, byteStart: 0, byteSize: bytes.length });
}

type Field = ["u32" | "i32", number] | ["i64", bigint] | ["str", string];

/** Little-endian bytes from `[kind, value]` pairs; a string is Unity's aligned one. */
function bytesOf(fields: Field[]): Uint8Array {
  const out: number[] = [];
  const view = new DataView(new ArrayBuffer(8));
  for (const [kind, value] of fields) {
    if (kind === "i64") {
      view.setBigInt64(0, value, true);
      out.push(...new Uint8Array(view.buffer, 0, 8));
    } else if (kind === "str") {
      const text = new TextEncoder().encode(value);
      view.setInt32(0, text.length, true);
      out.push(...new Uint8Array(view.buffer, 0, 4), ...text);
      while (out.length % 4) out.push(0);
    } else {
      if (kind === "u32") view.setUint32(0, value, true);
      else view.setInt32(0, value, true);
      out.push(...new Uint8Array(view.buffer, 0, 4));
    }
  }
  return Uint8Array.from(out);
}

test("NoTarget, format 14+: hide flags, two 64-bit prefab PPtrs, then m_Name", () => {
  const bytes = bytesOf([
    ["u32", 0x8000_0001],
    ["i32", 1],
    ["i64", -(2n ** 60n)],
    ["i32", 0],
    ["i64", 2n ** 53n + 1n],
    ["str", "héllo"],
    ["i32", 0x1234],
  ]);
  const reader = synthetic(bytes, BuildTarget.NoTarget, 22);
  assert.deepEqual(readNamedObject(reader), {
    m_ObjectHideFlags: 0x8000_0001,
    m_PrefabParentObject: { m_FileID: 1, m_PathID: -(2n ** 60n) },
    m_PrefabInternal: { m_FileID: 0, m_PathID: 2n ** 53n + 1n },
    m_Name: "héllo",
  });
  assert.equal(reader.readInt32(), 0x1234);
  assert.equal(reader.remaining, 0);
});

test("NoTarget, below format 14: prefab PPtr path ids are 32-bit, still bigint", () => {
  const bytes = bytesOf([
    ["u32", 4],
    ["i32", 2],
    ["i32", -7],
    ["i32", 0],
    ["i32", 9],
    ["i32", 0x1234],
  ]);
  const reader = synthetic(bytes, BuildTarget.NoTarget, 13);
  assert.deepEqual(readEditorExtension(reader), {
    m_ObjectHideFlags: 4,
    m_PrefabParentObject: { m_FileID: 2, m_PathID: -7n },
    m_PrefabInternal: { m_FileID: 0, m_PathID: 9n },
  });
  assert.equal(reader.readInt32(), 0x1234);
});

test("NoTarget: readObject reads the hide flags and nothing else", () => {
  const reader = synthetic(bytesOf([["u32", 7], ["i32", 1]]), BuildTarget.NoTarget, 22);
  assert.deepEqual(readObject(reader), { m_ObjectHideFlags: 7 });
  assert.equal(reader.position, 4);
});

test("a player build has no header: readObject reads nothing", () => {
  const reader = synthetic(bytesOf([["u32", 7]]), BuildTarget.StandaloneWindows64, 22);
  assert.deepEqual(readObject(reader), {});
  assert.equal(reader.position, 0);
});

test("every reader starts from the object's first byte, as upstream's Reset() does", () => {
  const bytes = bytesOf([["str", "twice"], ["i32", 0]]);
  const reader = synthetic(bytes, BuildTarget.Android, 22);
  assert.equal(readNamedObject(reader).m_Name, "twice");
  reader.position = 8;
  assert.equal(readNamedObject(reader).m_Name, "twice");
});

test("throws CorruptError when an editor object ends inside its prefab PPtrs", () => {
  const bytes = bytesOf([["u32", 0], ["i32", 0], ["i32", 0]]);
  const reader = synthetic(bytes, BuildTarget.NoTarget, 22);
  assert.throws(() => readEditorExtension(reader), CorruptError);
});

test("throws CorruptError when an object ends before m_Name's length", () => {
  const reader = synthetic(new Uint8Array(2), BuildTarget.StandaloneWindows64, 22);
  assert.throws(() => readNamedObject(reader), CorruptError);
});
