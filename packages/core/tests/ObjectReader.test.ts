import assert from "node:assert/strict";
import { test } from "node:test";

import { fixtureNames, golden, loadFixture } from "../../../fixtures/helpers.js";
import { load } from "../src/env.js";
import { CorruptError } from "../src/errors.js";
import { ClassID, classIdName } from "../src/serialized/ClassID.js";
import { ObjectReader } from "../src/serialized/ObjectReader.js";
import { readSerializedFile, setUnityVersion } from "../src/serialized/SerializedFile.js";

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

// --- build type -----------------------------------------------------------------

test("the build type is f for every editor-built fixture, stripped-suffix ones included", () => {
  let suffixed = 0;
  for (const name of SERIALIZED_FIXTURES) {
    for (const path of Object.keys(golden(name).serialized!)) {
      const data = node(name, path);
      const sf = readSerializedFile(data);
      if (sf.unityVersion.includes("\n")) suffixed++;
      assert.equal(sf.buildType, "f", `${name} ${path}`);
      for (const r of readers(data)) assert.equal(r.buildType, "f");
    }
  }
  assert.ok(suffixed > 0, "no fixture carries the typetree-stripped suffix");
});

test("an object reader takes the build type setUnityVersion gives its file", () => {
  const data = node(MAIN, MAIN_CAB);
  const sf = readSerializedFile(data);
  setUnityVersion(sf, "5.4.1p3");
  const r = new ObjectReader(data, sf, sf.objects[0]!);
  assert.equal(r.buildType, "p");
  assert.deepEqual(r.version, [5, 4, 1, 3]);
});

// --- vector helpers on hand-built bytes -------------------------------------------

/** Little-endian float32s 1, 2, 3, ... `count`. */
function floats(count: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(count * 4));
  for (let i = 0; i < count; i++) view.setFloat32(i * 4, i + 1, true);
  return new Uint8Array(view.buffer);
}

/** A little-endian reader over `bytes` as if written by editor `version`. */
function handBuilt(bytes: Uint8Array, version: string): ObjectReader {
  const sf = readSerializedFile(node(MAIN, MAIN_CAB));
  setUnityVersion(sf, version);
  assert.equal(sf.bigEndian, false);
  const info = { ...sf.objects[0]!, byteStart: 0, byteSize: bytes.length };
  return new ObjectReader(bytes, sf, info);
}

const V3 = { x: 1, y: 2, z: 3 };

test("readVector3 reads 12 bytes on 5.4 and later", () => {
  for (const version of ["5.4.0f3", "5.6.7f1", "2019.4.41f2", "6000.3.25f1"]) {
    const r = handBuilt(floats(5), version);
    assert.deepEqual(r.readVector3(), V3);
    assert.equal(r.position, 12, version);
  }
});

test("readVector3 reads a 16-byte Vector4 and drops w before 5.4", () => {
  for (const version of ["5.3.8f2", "5.0.0f4", "4.7.2f1", "3.4.2f1"]) {
    const r = handBuilt(floats(5), version);
    assert.deepEqual(r.readVector3(), V3);
    assert.equal(r.position, 16, version);
    assert.equal(r.readFloat32(), 5);
  }
});

test("readVector3Array reads an Int32 count, or the length it is given", () => {
  const counted = new Uint8Array(4 + 6 * 4);
  new DataView(counted.buffer).setInt32(0, 2, true);
  counted.set(floats(6), 4);
  const r = handBuilt(counted, "2019.4.41f2");
  assert.deepEqual(r.readVector3Array(), [V3, { x: 4, y: 5, z: 6 }]);
  assert.equal(r.remaining, 0);

  const old = handBuilt(floats(8), "5.3.8f2");
  assert.deepEqual(old.readVector3Array(2), [V3, { x: 5, y: 6, z: 7 }]);
  assert.equal(old.remaining, 0);
});

test("readVector3Array refuses a negative count and a count past the object", () => {
  for (const count of [-1, 1000]) {
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setInt32(0, count, true);
    assert.throws(
      () => handBuilt(bytes, "2019.4.41f2").readVector3Array(),
      (e) => e instanceof CorruptError && e.message.includes(`Vector3 count ${count}`),
    );
  }
  assert.throws(() => handBuilt(floats(5), "2019.4.41f2").readVector3Array(2), CorruptError);
});

test("readXForm reads Vector3, Quaternion, Vector3 with the 5.4 gate", () => {
  const r = handBuilt(floats(12), "2019.4.41f2");
  assert.deepEqual(r.readXForm(), {
    t: V3,
    q: { x: 4, y: 5, z: 6, w: 7 },
    s: { x: 8, y: 9, z: 10 },
  });
  assert.equal(r.position, 40);

  const old = handBuilt(floats(12), "5.3.8f2");
  assert.deepEqual(old.readXForm(), {
    t: V3,
    q: { x: 5, y: 6, z: 7, w: 8 },
    s: { x: 9, y: 10, z: 11 },
  });
  assert.equal(old.position, 48);
});

test("readXForm4 reads Vector4, Quaternion, Vector4 in every version and drops w", () => {
  for (const version of ["2019.4.41f2", "5.3.8f2"]) {
    const r = handBuilt(floats(12), version);
    assert.deepEqual(r.readXForm4(), {
      t: V3,
      q: { x: 5, y: 6, z: 7, w: 8 },
      s: { x: 9, y: 10, z: 11 },
    });
    assert.equal(r.position, 48, version);
  }
});

test("vector helpers throw CorruptError past the end of the object", () => {
  assert.throws(() => handBuilt(floats(2), "2019.4.41f2").readVector3(), CorruptError);
  assert.throws(() => handBuilt(floats(3), "5.3.8f2").readVector3(), CorruptError);
  assert.throws(() => handBuilt(floats(11), "2019.4.41f2").readXForm4(), CorruptError);
});
