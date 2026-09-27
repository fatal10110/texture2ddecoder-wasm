// MonoBehaviour (#39): the header reader, checked against the first fields of
// the oracle's typetree dumps (R12) and of readTypeTree(), and what obj.read()
// returns with and without a type tree.

import assert from "node:assert/strict";
import { test } from "node:test";

import { readMonoBehaviour } from "../src/classes/MonoBehaviour.js";
import { readMonoScript } from "../src/classes/MonoScript.js";
import type { MonoBehaviourData } from "../src/classes/registry.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ClassID } from "../src/serialized/ClassID.js";
import type { UnityVersion } from "../src/serialized/SerializedFile.js";
import {
  build,
  fixturesWith,
  normalize,
  objectBytes,
  objectsOf,
  synthetic,
  withTail,
} from "./class-readers.js";

const FIXTURES = fixturesWith(ClassID.MonoBehaviour);
const HEADER = ["m_GameObject", "m_Enabled", "m_Script", "m_Name"];

/** The first `count` fields of an object, in order. */
const firstFields = (value: Record<string, unknown>, count: number): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).slice(0, count));

// --- every MonoBehaviour of the editor fixtures -------------------------------------

for (const name of FIXTURES) {
  test(`${name}: readMonoBehaviour is the first fields of the golden and readTypeTree()`, () => {
    const objects = objectsOf(name, ClassID.MonoBehaviour);
    assert.equal(objects.length, 1);
    for (const { env, reader, dump, enableTypeTree } of objects) {
      assert.ok(dump, `no golden dump for MonoBehaviour ${reader.pathId}`);
      const header = readMonoBehaviour(reader);
      const after = reader.position;

      // The header fields, in Unity's order, with the oracle's values.
      assert.deepEqual(Object.keys(header), HEADER);
      assert.deepEqual(Object.keys(dump).slice(0, 4), HEADER);
      assert.deepEqual(normalize(header), firstFields(dump, 4));
      // A ScriptableObject: on no GameObject, and pointing into its own file.
      assert.deepEqual(header.m_GameObject, { m_FileID: 0, m_PathID: 0n });
      assert.equal(header.m_Script.m_FileID, 0);

      // The reader stops where the script's first field starts.
      if (name.endsWith("/main")) {
        assert.equal(reader.readInt32(), dump.i32);
        reader.position = after;
      }

      // m_Script leads to the MonoScript naming the class, with or without a type tree.
      const found = env.resolve(header.m_Script, reader);
      assert.equal(found.status, "found");
      if (found.status === "found") {
        const script = readMonoScript(found.object);
        const className = name.endsWith("/registry/refs") ? "RegistryData" : "FixtureData";
        assert.equal(script.m_ClassName, className);
      }

      const obj = env.objects.find((o) => o.pathId === reader.pathId)!;
      if (enableTypeTree) {
        const tree = reader.readTypeTree();
        assert.deepEqual(firstFields(tree, 4), header);
        // obj.read() is the whole object: the type tree, header first.
        assert.deepEqual(obj.read(), tree);
        assert.ok(Object.keys(tree).length > 4);
      } else {
        assert.equal(reader.serializedType?.nodes, null, "the file has a type tree after all");
        assert.throws(() => reader.readTypeTree(), UnsupportedError);
        // obj.read() is the header, all a file without type trees gives up.
        assert.deepEqual(obj.read(), header);
      }
    }
  });
}

test("the MonoBehaviour checks cover formats 21 and 22, typed and without type trees", () => {
  const seen = new Set<string>();
  for (const name of FIXTURES) {
    for (const { formatVersion, enableTypeTree } of objectsOf(name, ClassID.MonoBehaviour)) {
      seen.add(`${formatVersion} ${enableTypeTree ? "typed" : "notypetree"}`);
    }
  }
  assert.deepEqual([...seen].sort(), ["21 notypetree", "21 typed", "22 notypetree", "22 typed"]);
});

test("obj.read() of a typed MonoBehaviour carries the header and the script's fields", () => {
  const [first] = objectsOf("editor/6000.3.25f1/lz4/main", ClassID.MonoBehaviour);
  assert.ok(first);
  const { env, reader } = first;
  const data = env.objects.find((o) => o.pathId === reader.pathId)!.read<MonoBehaviourData>();
  assert.equal(data.m_Name, "data");
  assert.equal(data.m_Enabled, 1);
  assert.equal(data.i32, -123456);
  assert.equal(data.i64, -9007199254740993n);
});

// --- synthetic objects ----------------------------------------------------------------

const FROM = objectBytes("editor/6000.3.25f1/uncompressed/main", ClassID.MonoBehaviour);
const LAYOUT = ["pptr m_GameObject", "u8 m_Enabled", "align", "pptr m_Script", "str m_Name"];

// No field depends on the Unity version: Unity's player type trees (UnityPy's TPK
// data) have the same header from 3.4 on, and a version-stripped file reads.
const VERSIONS: { unity: UnityVersion; text?: string }[] = [
  { unity: [3, 4, 0, 1] },
  { unity: [2019, 4, 41, 2] },
  { unity: [0, 0, 0, 0], text: "0.0.0" },
];

for (const { unity, text } of VERSIONS) {
  const label = text ?? unity.slice(0, 3).join(".");
  test(`Unity ${label}: the header, and the reader left after it`, () => {
    const { bytes, expected } = build(LAYOUT);
    const reader = synthetic(FROM, withTail(bytes, 7, 0, 0, 0), unity, text);
    const header = readMonoBehaviour(reader);
    assert.deepEqual(Object.keys(header), HEADER);
    assert.deepEqual(header, expected);
    assert.equal(reader.readInt32(), 7);
  });
}

test("an editor file (NoTarget) is refused: m_EditorHideFlags sits inside its header", () => {
  const reader = synthetic(FROM, FROM.bytes, [6000, 3, 25, 1], "6000.3.25f1", BuildTarget.NoTarget);
  assert.throws(
    () => readMonoBehaviour(reader),
    (err: unknown) =>
      err instanceof UnsupportedError && err.kind === "build target" && err.found === "NoTarget",
  );
});

test("every cut through the header throws CorruptError", () => {
  const unity: UnityVersion = [6000, 3, 25, 1];
  const reader = synthetic(FROM, FROM.bytes, unity);
  const { m_Name } = readMonoBehaviour(reader);
  // Only m_Name's padding may be cut without losing header data.
  const end = reader.position - ((4 - (m_Name.length % 4)) % 4);
  for (let cut = 0; cut < end; cut++) {
    const cutReader = synthetic(FROM, FROM.bytes.subarray(0, cut), unity);
    assert.throws(() => readMonoBehaviour(cutReader), CorruptError, `cut at ${cut}`);
  }
});

test("m_Name's length past the object's end throws CorruptError, not an empty name", () => {
  const { bytes } = build(LAYOUT.slice(0, 4));
  const reader = synthetic(FROM, withTail(bytes, 12, 0, 0, 0, 0x64), [6000, 3, 25, 1]);
  assert.throws(() => readMonoBehaviour(reader), /m_Name of 12 bytes at offset 28 runs past/);
});
