import assert from "node:assert/strict";
import { test } from "node:test";

import { fixtureNames, golden, loadFixture } from "../../../fixtures/helpers.js";
import { load } from "../src/env.js";
import { CorruptError } from "../src/errors.js";
import { ClassID, classIdName } from "../src/serialized/ClassID.js";
import { ObjectReader } from "../src/serialized/ObjectReader.js";
import { readSerializedFile } from "../src/serialized/SerializedFile.js";

/** Every fixture whose golden describes at least one SerializedFile. */
const SERIALIZED_FIXTURES = fixtureNames().filter((name) => golden(name).serialized);

/** The unpacked bytes of one SerializedFile node of a fixture. */
function node(name: string, path: string): Uint8Array {
  const file = load([{ name, data: loadFixture(name) }]).files.find((f) => f.path === path);
  assert.ok(file, `${name} has no node ${path}`);
  return file.data;
}

/** A reader for every object of a SerializedFile node, in table order. */
function readers(data: Uint8Array): ObjectReader[] {
  const sf = readSerializedFile(data);
  return sf.objects.map((info) => new ObjectReader(data, sf, info));
}

const byPathId = (a: { pathId: string }, b: { pathId: string }): number =>
  a.pathId < b.pathId ? -1 : a.pathId > b.pathId ? 1 : 0;

// --- every editor-built fixture against the oracle goldens -------------------

for (const name of SERIALIZED_FIXTURES) {
  for (const [path, expected] of Object.entries(golden(name).serialized!)) {
    test(`${name}: object readers of ${path} match the golden table`, () => {
      const objects = readers(node(name, path));
      const table = objects
        .map((r) => ({ pathId: String(r.pathId), classId: r.type, byteSize: r.length }))
        .sort(byPathId);
      assert.deepEqual(table, golden(name).objects[path]);
      for (const r of objects) {
        assert.equal(r.format, expected.formatVersion);
        assert.equal(r.endian, expected.bigEndian ? "big" : "little");
        assert.equal(r.platform, expected.targetPlatform);
        assert.equal(r.serializedType?.classId, r.type);
        assert.ok(classIdName(r.type), `class id ${r.type} has no name`);
      }
    });

    test(`${name}: object readers of ${path} are views of exactly byteSize bytes`, () => {
      const data = node(name, path);
      for (const r of readers(data)) {
        // align() counts from the object start; upstream counts from the file start.
        assert.equal(r.byteStart % 8, 0, `object ${r.pathId} starts off an 8-byte boundary`);
        assert.equal(r.length, r.byteSize);
        const bytes = r.readBytes(r.byteSize);
        assert.equal(bytes.buffer, data.buffer, `object ${r.pathId} was copied`);
        assert.equal(bytes.byteOffset, data.byteOffset + r.byteStart);
        assert.throws(() => r.readUInt8(), CorruptError);
      }
    });

    test(`${name}: class id names of ${path} match the oracle's type trees`, () => {
      for (const type of expected.types) {
        // A typetree's root node is named after the class.
        if (type.nodes) assert.equal(classIdName(type.classId), type.nodes[0]![1]);
      }
    });
  }
}

test("object readers cover both format 21 (UInt32 byteStart) and 22 (Int64 byteStart)", () => {
  const formats = new Set<number>();
  for (const name of SERIALIZED_FIXTURES) {
    for (const path of Object.keys(golden(name).serialized!)) {
      for (const r of readers(node(name, path))) formats.add(r.format);
    }
  }
  assert.deepEqual([...formats].sort(), [21, 22]);
});

test("a TextAsset reader starts at m_Name and ends after m_Script, in both formats", () => {
  const formats = new Set<number>();
  for (const name of SERIALIZED_FIXTURES) {
    for (const [path, expected] of Object.entries(golden(name).serialized!)) {
      for (const r of readers(node(name, path))) {
        if (r.type !== ClassID.TextAsset) continue;
        const want = expected.typetrees[String(r.pathId)]?.value as
          | { m_Name: string; m_Script: string }
          | undefined;
        if (!want) continue; // typetree-stripped build: no oracle dump
        assert.equal(r.readAlignedString(), want.m_Name);
        assert.equal(r.readAlignedString(), want.m_Script);
        assert.equal(r.remaining, 0);
        formats.add(r.format);
      }
    }
  }
  assert.deepEqual([...formats].sort(), [21, 22]);
});

// --- unhappy paths ------------------------------------------------------------

const MAIN = "editor/6000.3.25f1/lz4/main";
const MAIN_CAB = "CAB-ba01e3c16ba268ec36e9543a39dc83ad";

test("throws CorruptError when the file ends inside an object", () => {
  const data = node(MAIN, MAIN_CAB);
  const sf = readSerializedFile(data);
  const last = sf.objects.reduce((a, b) => (a.byteStart > b.byteStart ? a : b));
  const cut = data.subarray(0, last.byteStart + last.byteSize - 1);
  assert.throws(
    () => new ObjectReader(cut, sf, last),
    (err: unknown) =>
      err instanceof CorruptError &&
      err.message.includes(`object ${last.pathId}`) &&
      err.message.includes(`at ${last.byteStart} of ${last.byteSize} bytes`) &&
      err.message.includes(`${cut.length}-byte file`),
  );
});

test("throws CorruptError for an object that starts past the end of the file", () => {
  const data = node(MAIN, MAIN_CAB);
  const sf = readSerializedFile(data);
  const info = { ...sf.objects[0]!, byteStart: data.length + 16, byteSize: 0 };
  assert.throws(() => new ObjectReader(data, sf, info), CorruptError);
});

// --- ClassID ------------------------------------------------------------------

test("names the class ids the fixtures hold", () => {
  assert.equal(classIdName(114), "MonoBehaviour");
  assert.equal(classIdName(142), "AssetBundle");
  assert.equal(classIdName(49), "TextAsset");
  assert.equal(classIdName(115), "MonoScript");
  assert.equal(classIdName(290), "AssetBundleManifest");
  assert.equal(ClassID.Texture2D, 28);
  assert.equal(ClassID.Sprite, 213);
});

test("holds every name of upstream's ClassIDType, game-specific ones included", () => {
  assert.equal(Object.keys(ClassID).length, 381);
  assert.equal(classIdName(601), "MiHoYoGrassData");
  assert.equal(classIdName(1205), "LODLevel");
  assert.equal(classIdName(1211), "MiHoYoTextureStreamingPreloader");
});

test("keeps both of upstream's names for 126 and looks up NavMeshProjectSettings", () => {
  assert.equal(ClassID.NavMeshAreas, 126);
  assert.equal(ClassID.NavMeshProjectSettings, 126);
  assert.equal(classIdName(126), "NavMeshProjectSettings");
  for (const [name, id] of Object.entries(ClassID)) {
    if (name !== "NavMeshAreas") assert.equal(classIdName(id), name);
  }
});

test("returns undefined for a class id it does not name, without throwing", () => {
  assert.equal(classIdName(-1), "UnknownType");
  assert.equal(classIdName(7), undefined);
  assert.equal(classIdName(1209), undefined); // a gap in upstream's 1201-1211 run
  assert.equal(classIdName(0x7fffffff), undefined);
});

test("an object with a class id outside ClassID keeps its number", () => {
  const data = node(MAIN, MAIN_CAB);
  const sf = readSerializedFile(data);
  const r = new ObjectReader(data, sf, { ...sf.objects[0]!, classId: 123456 });
  assert.equal(r.type, 123456);
  assert.equal(classIdName(r.type), undefined);
});
