// MonoScript (#39): the hardcoded reader, checked against readTypeTree() on the
// same objects and against what the oracle's goldens say about each script
// (R12). The oracle does not dump MonoScript objects (make-goldens.py's
// DUMPED_CLASSES), so there is no dump to compare whole.

import assert from "node:assert/strict";
import { test } from "node:test";

import { golden } from "../../../fixtures/helpers.js";
import { readMonoScript, type Hash128 } from "../src/classes/MonoScript.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ClassID } from "../src/serialized/ClassID.js";
import type { UnityVersion } from "../src/serialized/SerializedFile.js";
import {
  build,
  fixturesWith,
  objectBytes,
  objectsOf,
  synthetic,
  typedTwin,
  withTail,
} from "./class-readers.js";

const FIXTURES = fixturesWith(ClassID.MonoScript);

const hex = (hash: Hash128 | number): string => {
  assert.equal(typeof hash, "object");
  return Buffer.from(Object.values(hash as Hash128)).toString("hex");
};

/**
 * The `oldTypeHash` the golden records for the MonoBehaviour type whose
 * object points at `pathId`: Unity's hash of the script's fields, which the
 * MonoScript holds as `m_PropertiesHash`.
 */
function goldenPropertiesHash(name: string, pathId: bigint): string {
  const sf = Object.values(golden(typedTwin(name)).serialized!)[0]!;
  const pointing = Object.values(sf.typetrees).filter(({ value }) => {
    const script = (value as { m_Script?: unknown }).m_Script;
    if (typeof script !== "object") return false; // a TextAsset's m_Script is text
    return (script as { m_PathID: string }).m_PathID === String(pathId);
  });
  assert.equal(pointing.length, 1, `not one MonoBehaviour points at ${pathId}`);
  const types = sf.types.filter((t) => t.classId === ClassID.MonoBehaviour);
  assert.equal(types.length, 1);
  return types[0]!.oldTypeHash!;
}

/**
 * What the fixture project's C# says (fixtures/BUILDING.md): `FixtureData` in
 * `main`, `RegistryData` in `registry/refs`, both in the global namespace and
 * Unity's default assembly, which Unity 6 names without `.dll`. Checked
 * against UnityPy 1.25.3 for every typed fixture (recorded on the PR).
 */
function expectedScript(name: string): Record<string, string> {
  const className = name.endsWith("/registry/refs") ? "RegistryData" : "FixtureData";
  const assembly = name.includes("/6000.") ? "Assembly-CSharp" : "Assembly-CSharp.dll";
  return { m_Name: className, m_ClassName: className, m_Namespace: "", m_AssemblyName: assembly };
}

// --- every MonoScript of the editor fixtures ----------------------------------------

for (const name of FIXTURES) {
  test(`${name}: readMonoScript equals readTypeTree() and the goldens`, () => {
    const objects = objectsOf(name, ClassID.MonoScript);
    assert.equal(objects.length, 1);
    for (const { env, reader, enableTypeTree } of objects) {
      const script = readMonoScript(reader);
      // The golden object table's byteSize, consumed exactly.
      assert.equal(reader.position, reader.byteSize, "byteSize not consumed exactly");
      assert.deepEqual(env.objects.find((o) => o.pathId === reader.pathId)!.read(), script);

      assert.deepEqual(Object.keys(script), [
        "m_Name",
        "m_ExecutionOrder",
        "m_PropertiesHash",
        "m_ClassName",
        "m_Namespace",
        "m_AssemblyName",
      ]);
      const { m_Name, m_ClassName, m_Namespace, m_AssemblyName } = script;
      assert.deepEqual({ m_Name, m_ClassName, m_Namespace, m_AssemblyName }, expectedScript(name));
      assert.equal(script.m_ExecutionOrder, 0);
      assert.equal(hex(script.m_PropertiesHash), goldenPropertiesHash(name, reader.pathId));

      if (enableTypeTree) {
        // Every field, in Unity's order, as the type tree reads it.
        const tree = reader.readTypeTree();
        assert.deepEqual(Object.keys(script), Object.keys(tree));
        assert.deepEqual(script, tree);
      } else {
        assert.equal(reader.serializedType?.nodes, null, "the file has a type tree after all");
        // The typed twin holds the same object under the same path id.
        const [twin] = objectsOf(typedTwin(name), ClassID.MonoScript);
        assert.equal(twin?.reader.pathId, reader.pathId);
        assert.deepEqual(script, twin.reader.readTypeTree());
      }
    }
  });
}

test("the MonoScript checks cover formats 21 and 22, typed and without type trees", () => {
  const seen = new Set<string>();
  for (const name of FIXTURES) {
    for (const { formatVersion, enableTypeTree } of objectsOf(name, ClassID.MonoScript)) {
      seen.add(`${formatVersion} ${enableTypeTree ? "typed" : "notypetree"}`);
    }
  }
  assert.deepEqual([...seen].sort(), ["21 notypetree", "21 typed", "22 notypetree", "22 typed"]);
});

// --- layouts before the fixtures' ---------------------------------------------------

const FROM = objectBytes("editor/6000.3.25f1/uncompressed/main", ClassID.MonoScript);
const TAIL = ["str m_ClassName", "str m_Namespace", "str m_AssemblyName"];
const V5_HEAD = ["str m_Name", "i32 m_ExecutionOrder", "hash m_PropertiesHash"];

/** Unity's player type trees (UnityPy's TPK data), which start at 3.4. */
const LAYOUTS: { unity: UnityVersion; fields: string[] }[] = [
  {
    unity: [3, 4, 0, 1],
    fields: ["str m_Name", "i32 m_ExecutionOrder", "u32 m_PropertiesHash", ...TAIL]
      .concat("bool m_IsEditorScript"),
  },
  {
    unity: [4, 7, 2, 1],
    fields: ["str m_Name", "i32 m_ExecutionOrder", "u32 m_PropertiesHash", ...TAIL]
      .concat("bool m_IsEditorScript"),
  },
  { unity: [5, 0, 0, 1], fields: [...V5_HEAD, ...TAIL, "bool m_IsEditorScript"] },
  { unity: [2018, 1, 9, 1], fields: [...V5_HEAD, ...TAIL, "bool m_IsEditorScript"] },
  { unity: [2018, 2, 0, 1], fields: [...V5_HEAD, ...TAIL] },
];

for (const { unity, fields } of LAYOUTS) {
  test(`Unity ${unity.slice(0, 3).join(".")}: ${fields.length} fields, in Unity's order`, () => {
    const { bytes, expected } = build(fields);
    const reader = synthetic(FROM, bytes, unity);
    const script = readMonoScript(reader);
    assert.deepEqual(Object.keys(script), Object.keys(expected));
    assert.deepEqual(script, expected);
    assert.equal(reader.remaining, 0);
  });
}

// --- refusals -----------------------------------------------------------------------

/**
 * Per the class-reader rule on #36: an all-zero version is refused with the
 * file's own version string, from a stripped file (`"0.0.0"`) or a loose file
 * below format 7 (`"2.5.0f5"`, #98). The bytes cannot pick a layout there:
 * the candidates differ inside the object, not at its end. A known version
 * below 3.4 has no type tree data, and is refused too.
 */
const REFUSED: { unity: UnityVersion; text: string; format?: number }[] = [
  { unity: [0, 0, 0, 0], text: "0.0.0" },
  { unity: [0, 0, 0, 0], text: "2.5.0f5", format: 6 },
  { unity: [3, 3, 0, 1], text: "3.3.0f1", format: 9 },
  { unity: [3, 0, 0, 1], text: "3.0.0f1", format: 8 },
  { unity: [2, 6, 1, 1], text: "2.6.1f1", format: 6 },
];

for (const { unity, text, format } of REFUSED) {
  test(`Unity "${text}" at ${unity.join(".")}: UnsupportedError("Unity version")`, () => {
    const reader = synthetic(FROM, FROM.bytes, unity, text, undefined, format);
    assert.throws(
      () => readMonoScript(reader),
      (err: unknown) =>
        err instanceof UnsupportedError &&
        err.kind === "Unity version" &&
        err.found === text &&
        err.message.includes(`object ${reader.pathId}`),
    );
  });
}

test("an editor file (NoTarget) is refused: its MonoScript has editor-only fields", () => {
  const reader = synthetic(FROM, FROM.bytes, [6000, 3, 25, 1], "6000.3.25f1", BuildTarget.NoTarget);
  assert.throws(
    () => readMonoScript(reader),
    (err: unknown) =>
      err instanceof UnsupportedError && err.kind === "build target" && err.found === "NoTarget",
  );
});

test("every cut through a field throws CorruptError", () => {
  const unity: UnityVersion = [6000, 3, 25, 1];
  const { m_AssemblyName } = readMonoScript(synthetic(FROM, FROM.bytes, unity));
  // Only m_AssemblyName's padding may be cut without losing data.
  const end = FROM.bytes.length - ((4 - (m_AssemblyName.length % 4)) % 4);
  for (let cut = 0; cut < end; cut++) {
    const reader = synthetic(FROM, FROM.bytes.subarray(0, cut), unity);
    assert.throws(() => readMonoScript(reader), CorruptError, `cut at ${cut}`);
  }
});

test("a string's length past the object's end throws CorruptError, not an empty string", () => {
  const { bytes } = build(["str m_Name", "i32 m_ExecutionOrder", "hash m_PropertiesHash"]);
  const reader = synthetic(FROM, withTail(bytes, 40, 0, 0, 0, 0x41), [2020, 3, 30, 1]);
  assert.throws(
    () => readMonoScript(reader),
    /MonoScript -?\d+ m_ClassName byte count 40 at offset \d+ exceeds the 1 bytes left/,
  );
});

// Unity 2018.2+: m_AssemblyName is the last field, so a negative count on it,
// or on m_Namespace before an empty m_AssemblyName, leaves no bytes for the end
// check to catch.
for (const field of ["m_ClassName", "m_Namespace", "m_AssemblyName"]) {
  test(`a negative ${field} length throws CorruptError, not an empty string`, () => {
    const head = build(V5_HEAD).bytes;
    const str = (text: string) => {
      const data = new TextEncoder().encode(text);
      const out = [...new Uint8Array(Int32Array.of(data.length).buffer), ...data];
      while (out.length % 4) out.push(0);
      return out;
    };
    const NEG = [0xff, 0xff, 0xff, 0xff];
    const fields = {
      m_ClassName: [...NEG, ...str(""), ...str("")],
      m_Namespace: [...str("A"), ...NEG, ...str("")],
      m_AssemblyName: [...str("A"), ...str(""), ...NEG],
    }[field]!;
    const reader = synthetic(FROM, withTail(head, ...fields), [2020, 3, 30, 1]);
    assert.throws(
      () => readMonoScript(reader),
      new RegExp(`${field} byte count -1 at offset \\d+ is negative`),
    );
  });
}

test("bytes left after the last field throw CorruptError", () => {
  const reader = synthetic(FROM, withTail(FROM.bytes, 0, 0, 0, 0), [6000, 3, 25, 1]);
  assert.throws(
    () => readMonoScript(reader),
    (err: unknown) =>
      err instanceof CorruptError && err.message.includes(`ends at ${FROM.bytes.length} of its`),
  );
});
