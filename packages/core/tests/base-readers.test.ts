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
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ClassID } from "../src/serialized/ClassID.js";
import { ObjectReader } from "../src/serialized/ObjectReader.js";
import {
  readSerializedFile,
  type SerializedFile,
  type UnityVersion,
} from "../src/serialized/SerializedFile.js";

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
        assert.equal(reader.unityVersion, sf.unityVersion);
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

    // Each bundle holds one SerializedFile, so the two pair up directly - by
    // name they would not: the manifest bundle's node is named after the
    // build, so its CAB name differs between the two. With one file, every
    // object of the env is one of its objects and path ids are unique.
    const [path, ...morePaths] = Object.keys(golden(name).objects);
    const [twinPath, ...moreTwinPaths] = Object.keys(twin.objects);
    assert.ok(path && twinPath && !morePaths.length && !moreTwinPaths.length, "not one file each");
    assert.deepEqual(golden(name).objects[path], twin.objects[twinPath], "object tables differ");
    assert.equal(golden(name).serialized![path]!.enableTypeTree, false);

    const env = load([{ name, data: loadFixture(name) }]);
    assert.equal(env.objects.length, golden(name).objects[path]!.length);
    const byPathId = new Map(env.objects.map((o) => [String(o.pathId), o]));

    let named = 0;
    const sf = twin.serialized![twinPath]!;
    for (const [pathId, { value }] of Object.entries(sf.typetrees)) {
      const reader = byPathId.get(pathId);
      assert.ok(reader, `${path} has no object ${pathId}`);
      assert.equal(reader.serializedType?.nodes, null, "the file has a type tree after all");
      // Suffix included: a file built without type trees says so in it.
      assert.equal(reader.unityVersion, golden(name).serialized![path]!.unityVersion);
      if (checkObject(reader, sf, value as Record<string, unknown>)) named++;
    }
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

/**
 * A reader over `bytes` for a file built for `platform` by Unity `unity` in
 * SerializedFile `format`; the caller keeps the two consistent. `text` is the
 * version string the file holds.
 */
function synthetic(
  bytes: Uint8Array,
  platform: BuildTarget,
  format: number,
  unity: UnityVersion,
  text = unity.slice(0, 3).join("."),
): ObjectReader {
  const { sf, info } = textAsset();
  const file: SerializedFile = {
    ...sf,
    header: { ...sf.header, version: format },
    unityVersion: text,
    version: unity,
    targetPlatform: platform,
  };
  return new ObjectReader(bytes, file, { ...info, byteStart: 0, byteSize: bytes.length });
}

/** A player file as the 6000 fixtures are: format 22. */
const PLAYER_6000 = [22, [6000, 3, 25, 1]] as const;

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

const OLD_NAMES = ["m_PrefabParentObject", "m_PrefabInternal"];
const RENAMED = ["m_CorrespondingSourceObject", "m_PrefabInternal"];
const REWORK = ["m_CorrespondingSourceObject", "m_PrefabInstance", "m_PrefabAsset"];

/**
 * The prefab pointers Unity's editor type trees put between `m_ObjectHideFlags`
 * and `m_Name`, as UnityPy's TPK data records them (EditorRootNode of every
 * EditorExtension class, 3.4.0 to 6000.7a3), with the first and last version
 * of each layout, plus both sides of the format 14 path id gate.
 */
const LAYOUTS: { unity: UnityVersion; format: number; pointers: string[] }[] = [
  { unity: [3, 4, 0, 1], format: 8, pointers: ["m_ExtensionPtr"] },
  { unity: [3, 5, 0, 1], format: 9, pointers: OLD_NAMES },
  { unity: [5, 0, 0, 1], format: 13, pointers: OLD_NAMES },
  { unity: [5, 0, 0, 1], format: 14, pointers: OLD_NAMES },
  { unity: [2018, 1, 9, 1], format: 17, pointers: OLD_NAMES },
  { unity: [2018, 2, 0, 1], format: 17, pointers: RENAMED },
  { unity: [2018, 2, 21, 1], format: 17, pointers: RENAMED },
  { unity: [2018, 3, 0, 1], format: 17, pointers: REWORK },
  { unity: [2019, 4, 41, 2], format: 21, pointers: REWORK },
  { unity: [6000, 3, 25, 1], format: 22, pointers: REWORK },
];

for (const { unity, format, pointers } of LAYOUTS) {
  const wide = format >= 14;
  test(`NoTarget, Unity ${unity.join(".")} format ${format}: ${pointers.join(", ")}`, () => {
    const fields: Field[] = [["u32", 0x8000_0001]];
    const expected: Record<string, unknown> = { m_ObjectHideFlags: 0x8000_0001 };
    pointers.forEach((key, i) => {
      // Beyond 32 bits from format 14 on, so a 32-bit read cannot pass.
      const pathId = wide ? -(2n ** 60n) + BigInt(i) : BigInt(-7 - i);
      fields.push(["i32", i + 1], wide ? ["i64", pathId] : ["i32", Number(pathId)]);
      expected[key] = { m_FileID: i + 1, m_PathID: pathId };
    });
    fields.push(["str", "héllo"], ["i32", 0x1234]);

    const reader = synthetic(bytesOf(fields), BuildTarget.NoTarget, format, unity);
    assert.deepEqual(readNamedObject(reader), { ...expected, m_Name: "héllo" });
    assert.equal(reader.readInt32(), 0x1234);
    assert.equal(reader.remaining, 0);
  });
}

/**
 * Editor files whose header layout is unknown. Per the class-reader rule on
 * #36, the refusal is kind "Unity version" with the file's own string: an
 * all-zero version comes from a stripped file (`"0.0.0"`) or a loose file
 * below format 7 (`"2.5.0f5"`, #98).
 */
const REFUSED: { text: string; unity: UnityVersion; format: number; hint: string }[] = [
  { text: "0.0.0", unity: [0, 0, 0, 0], format: 22, hint: "does not record one" },
  // No real file looks like this: below format 8 the platform is not stored,
  // so it reads as `UnknownPlatform`, never `NoTarget`. The row only checks
  // that a loose pre-7 file's version string is passed through as `found`.
  { text: "2.5.0f5", unity: [0, 0, 0, 0], format: 6, hint: "does not record one" },
  { text: "3.3.0f1", unity: [3, 3, 0, 1], format: 8, hint: "before 3.4" },
];

for (const { text, unity, format, hint } of REFUSED) {
  test(`NoTarget, Unity "${text}" at ${unity.join(".")}: UnsupportedError("Unity version")`, () => {
    const bytes = bytesOf([["u32", 0], ["str", "x"]]);
    const reader = synthetic(bytes, BuildTarget.NoTarget, format, unity, text);
    assert.throws(
      () => readNamedObject(reader),
      (err: unknown) =>
        err instanceof UnsupportedError &&
        err.kind === "Unity version" &&
        err.found === text &&
        err.message.includes(`object ${reader.pathId}`) &&
        err.message.includes(hint),
    );
  });
}

test("a player file at an all-zero version still reads: it has no pointers to gate", () => {
  const bytes = bytesOf([["str", "stripped"], ["i32", 0]]);
  const reader = synthetic(bytes, BuildTarget.StandaloneWindows64, 22, [0, 0, 0, 0], "0.0.0");
  assert.deepEqual(readNamedObject(reader), { m_Name: "stripped" });
});

test("NoTarget, 2018.3+: two pointers are not enough (upstream reads only two)", () => {
  const bytes = bytesOf([
    ["u32", 0],
    ["i32", 0],
    ["i64", 1n],
    ["i32", 0],
    ["i64", 2n],
  ]);
  const reader = synthetic(bytes, BuildTarget.NoTarget, 21, [2019, 4, 41, 2]);
  assert.throws(() => readEditorExtension(reader), CorruptError);
});

test("NoTarget: readObject reads the hide flags and nothing else", () => {
  const reader = synthetic(bytesOf([["u32", 7], ["i32", 1]]), BuildTarget.NoTarget, ...PLAYER_6000);
  assert.deepEqual(readObject(reader), { m_ObjectHideFlags: 7 });
  assert.equal(reader.position, 4);
});

test("a player build has no header: readObject reads nothing", () => {
  const reader = synthetic(bytesOf([["u32", 7]]), BuildTarget.StandaloneWindows64, ...PLAYER_6000);
  assert.deepEqual(readObject(reader), {});
  assert.equal(reader.position, 0);
});

test("every reader starts from the object's first byte, as upstream's Reset() does", () => {
  const bytes = bytesOf([["str", "twice"], ["i32", 0]]);
  const reader = synthetic(bytes, BuildTarget.Android, ...PLAYER_6000);
  assert.equal(readNamedObject(reader).m_Name, "twice");
  reader.position = 8;
  assert.equal(readNamedObject(reader).m_Name, "twice");
});

test("throws CorruptError when an object ends before m_Name's length", () => {
  const reader = synthetic(new Uint8Array(2), BuildTarget.StandaloneWindows64, ...PLAYER_6000);
  assert.throws(() => readNamedObject(reader), CorruptError);
});
