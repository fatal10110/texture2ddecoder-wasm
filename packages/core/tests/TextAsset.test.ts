// TextAsset (#39): the hardcoded reader, checked against the oracle's typetree
// dumps (R12) and readTypeTree() on the same objects, in every editor fixture.

import assert from "node:assert/strict";
import { test } from "node:test";

import { readTextAsset, textAssetString, type TextAsset } from "../src/classes/TextAsset.js";
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
  withTail,
} from "./class-readers.js";

const FIXTURES = fixturesWith(ClassID.TextAsset);

/** The reader's result in the golden's form: `m_Script` as the string the oracle dumps. */
const asText = (asset: TextAsset): Record<string, unknown> => ({
  ...asset,
  m_Script: textAssetString(asset),
});

// --- every TextAsset of the editor fixtures ---------------------------------------

for (const name of FIXTURES) {
  test(`${name}: readTextAsset equals the golden dump and readTypeTree()`, () => {
    const objects = objectsOf(name, ClassID.TextAsset);
    assert.ok(objects.length > 0);
    for (const { env, reader, file, dump, enableTypeTree } of objects) {
      assert.ok(dump, `no golden dump for TextAsset ${reader.pathId}`);
      const asset = readTextAsset(reader);
      assert.equal(reader.position, reader.byteSize, "byteSize not consumed exactly");

      // Every field, in Unity's order, with the oracle's values.
      assert.deepEqual(Object.keys(asset), Object.keys(dump));
      assert.deepEqual(asText(asset), dump);
      // A view into the SerializedFile, never a copy (R7).
      assert.equal(asset.m_Script.buffer, file.buffer);
      // obj.read() goes through the registry to this reader.
      assert.deepEqual(env.objects.find((o) => o.pathId === reader.pathId)!.read(), asset);

      if (enableTypeTree) {
        const tree = reader.readTypeTree();
        assert.deepEqual(Object.keys(asset), Object.keys(tree));
        assert.deepEqual(asText(asset), tree);
      } else {
        assert.equal(reader.serializedType?.nodes, null, "the file has a type tree after all");
      }
    }
  });
}

test("the TextAsset checks cover formats 21 and 22, typed, notypetree and version-stripped", () => {
  const seen = new Set<string>();
  for (const name of FIXTURES) {
    for (const { formatVersion, unityVersion, enableTypeTree, reader } of objectsOf(
      name,
      ClassID.TextAsset,
    )) {
      const kind = !enableTypeTree ? "notypetree" : unityVersion === "0.0.0" ? "stripped" : "typed";
      if (kind === "stripped") assert.deepEqual(reader.version, [0, 0, 0, 0]);
      seen.add(`${formatVersion} ${kind}`);
    }
  }
  assert.deepEqual(
    [...seen].sort(),
    ["21 notypetree", "21 typed", "22 notypetree", "22 stripped", "22 typed"],
  );
});

test("the UTF-8 text keeps the fixture's 4-byte emoji", () => {
  for (const name of FIXTURES) {
    for (const { reader } of objectsOf(name, ClassID.TextAsset)) {
      const asset = readTextAsset(reader);
      // hello.txt: 58 bytes, ending "é€😀\n" (fixtures/BUILDING.md).
      assert.equal(asset.m_Script.length, 58, name);
      assert.deepEqual([...asset.m_Script.subarray(-5, -1)], [0xf0, 0x9f, 0x98, 0x80]);
      const text = textAssetString(asset);
      assert.ok(text.endsWith("Line 2: é€\u{1F600}\n"), name);
      assert.equal([...text].at(-2), "\u{1F600}");
    }
  }
});

test("textAssetString: invalid UTF-8 becomes U+FFFD, as every string of the reader", () => {
  assert.equal(textAssetString({ m_Script: Uint8Array.of(0x61, 0xff, 0x62) }), "a�b");
  assert.equal(textAssetString({ m_Script: Uint8Array.of(0xf0, 0x9f, 0x98) }), "�");
  assert.equal(textAssetString({ m_Script: new Uint8Array(0) }), "");
});

test("textAssetString keeps a leading UTF-8 BOM as U+FEFF, as upstream and UnityPy do", () => {
  // A text file saved on Windows: EF BB BF, then "hi".
  const m_Script = Uint8Array.of(0xef, 0xbb, 0xbf, 0x68, 0x69);
  assert.equal(textAssetString({ m_Script }), "\uFEFFhi");
});

// --- m_PathName, Unity 3.4 to 2017.1 -----------------------------------------------

const FROM = objectBytes("editor/6000.3.25f1/uncompressed/shared", ClassID.TextAsset);
const OLD = ["str m_Name", "bytes m_Script", "align", "str m_PathName"];
const NEW = ["str m_Name", "bytes m_Script", "align"];

const LAYOUTS: { unity: UnityVersion; fields: string[] }[] = [
  { unity: [3, 4, 0, 1], fields: OLD },
  { unity: [5, 6, 7, 1], fields: OLD },
  { unity: [2017, 1, 0, 1], fields: NEW },
  { unity: [2019, 4, 41, 2], fields: NEW },
];

for (const { unity, fields } of LAYOUTS) {
  test(`Unity ${unity.slice(0, 3).join(".")}: the layout of Unity's type tree`, () => {
    const { bytes, expected } = build(fields);
    const reader = synthetic(FROM, bytes, unity);
    const asset = readTextAsset(reader);
    assert.deepEqual(Object.keys(asset), Object.keys(expected));
    assert.deepEqual(asset, expected);
    assert.equal(reader.remaining, 0);
  });
}

test("with a known version, the version decides whether m_PathName is there", () => {
  const old = build(OLD).bytes;
  const recent = build(NEW).bytes;
  // A 2017.1+ file with bytes after m_Script, a 5.6 file without m_PathName.
  assert.throws(() => readTextAsset(synthetic(FROM, old, [2017, 1, 0, 1])), /ends at/);
  assert.throws(() => readTextAsset(synthetic(FROM, recent, [5, 6, 7, 1])), CorruptError);
});

// The #36 rule for version-stripped files (maintainer decision): at [0,0,0,0] in a
// format 7+ file the object's bytes may pick the layout when the candidates are
// unambiguous under the end-of-object check; everything else is refused.

const STRIPPED: UnityVersion = [0, 0, 0, 0];

test('Unity "0.0.0" in a format 22 file: m_PathName is read when bytes are left for it', () => {
  for (const fields of [OLD, NEW]) {
    const { bytes, expected } = build(fields);
    const reader = synthetic(FROM, bytes, STRIPPED, "0.0.0");
    assert.equal(reader.format, 22);
    const asset = readTextAsset(reader);
    assert.deepEqual(Object.keys(asset), Object.keys(expected));
    assert.deepEqual(asset, expected);
  }
});

test('Unity "0.0.0" in a format 7 file: the bytes still decide', () => {
  const { bytes, expected } = build(OLD);
  const reader = synthetic(FROM, bytes, STRIPPED, "0.0.0", undefined, 7);
  assert.deepEqual(readTextAsset(reader), expected);
});

test('Unity "0.0.0": a tail that fits neither layout throws CorruptError', () => {
  const { bytes } = build(NEW);
  const { bytes: old } = build(OLD);
  const tails = [
    withTail(bytes, 1), // too short for m_PathName's count
    withTail(bytes, 1, 0, 0), // likewise
    withTail(bytes, 8, 0, 0, 0, 0x61), // m_PathName's count runs past the end
    withTail(bytes, 0xff, 0xff, 0xff, 0xff), // a negative count
    withTail(old, 0, 0, 0, 0), // bytes left after m_PathName
  ];
  for (const [i, tail] of tails.entries()) {
    assert.throws(
      () => readTextAsset(synthetic(FROM, tail, STRIPPED, "0.0.0")),
      CorruptError,
      `tail ${i}`,
    );
  }
});

/** Refused with the file's own version string, per #36. */
const REFUSED: { unity: UnityVersion; text: string; format?: number; why: string }[] = [
  { unity: STRIPPED, text: "2.5.0f5", format: 6, why: "[0,0,0,0] in a format 6 loose file" },
  { unity: STRIPPED, text: "0.0.0", format: 6, why: "[0,0,0,0] below format 7" },
  { unity: [3, 3, 0, 1], text: "3.3.0f1", format: 9, why: "a known version below 3.4" },
  { unity: [2, 6, 1, 1], text: "2.6.1f1", format: 6, why: "a known 2.x version" },
];

for (const { unity, text, format, why } of REFUSED) {
  test(`${why}: UnsupportedError("Unity version", "${text}")`, () => {
    for (const fields of [OLD, NEW]) {
      const reader = synthetic(FROM, build(fields).bytes, unity, text, undefined, format);
      assert.throws(
        () => readTextAsset(reader),
        (err: unknown) =>
          err instanceof UnsupportedError &&
          err.kind === "Unity version" &&
          err.found === text &&
          err.message.includes(`object ${reader.pathId}`),
      );
    }
  });
}

test("an editor file (NoTarget): the EditorExtension header, then the TextAsset fields", () => {
  const { bytes, expected } = build(["u32 m_ObjectHideFlags", "pptr m_CorrespondingSourceObject"]
    .concat(["pptr m_PrefabInstance", "pptr m_PrefabAsset", ...NEW]));
  const reader = synthetic(FROM, bytes, [2019, 4, 41, 2], "2019.4.41f2", BuildTarget.NoTarget);
  const asset = readTextAsset(reader);
  assert.deepEqual(Object.keys(asset), Object.keys(expected));
  assert.deepEqual(asset, expected);
});

// --- corrupt objects ----------------------------------------------------------------

test("every cut through a field throws CorruptError", () => {
  const { bytes } = FROM;
  const unity: UnityVersion = [6000, 3, 25, 1];
  const whole = readTextAsset(synthetic(FROM, bytes, unity));
  // Only m_Script's padding may be cut without losing data.
  const end = whole.m_Script.byteOffset - bytes.byteOffset + whole.m_Script.length;
  assert.ok(end >= bytes.length - 3);
  for (let cut = 0; cut < end; cut++) {
    const reader = synthetic(FROM, bytes.subarray(0, cut), unity);
    assert.throws(() => readTextAsset(reader), CorruptError, `cut at ${cut}`);
  }
});

test("a negative m_Script byte count throws CorruptError", () => {
  const bytes = FROM.bytes.slice();
  // m_Name "hello": a 4-byte length and 5 bytes, padded to 12.
  new DataView(bytes.buffer).setInt32(12, -1, true);
  assert.throws(
    () => readTextAsset(synthetic(FROM, bytes, [6000, 3, 25, 1])),
    new RegExp(`TextAsset ${FROM.info.pathId} m_Script byte count -1 at offset 12 is negative`),
  );
});

test("m_PathName's length past the object's end throws CorruptError, not an empty path", () => {
  const { bytes } = build(NEW);
  const reader = synthetic(FROM, withTail(bytes, 9, 0, 0, 0, 0x61), [5, 6, 7, 1]);
  assert.throws(
    () => readTextAsset(reader),
    /TextAsset -?\d+ m_PathName byte count 9 at offset \d+ exceeds the 1 bytes left/,
  );
});

test("a negative m_PathName length throws CorruptError, not an empty path", () => {
  const { bytes } = build(NEW);
  for (const unity of [[5, 6, 7, 1], STRIPPED] as UnityVersion[]) {
    const reader = synthetic(FROM, withTail(bytes, 0xff, 0xff, 0xff, 0xff), unity);
    assert.throws(() => readTextAsset(reader), /m_PathName byte count -1 at offset \d+ is neg/);
  }
});

test("bytes left after the last field throw CorruptError", () => {
  const reader = synthetic(FROM, withTail(FROM.bytes, 0, 0, 0, 0), [6000, 3, 25, 1]);
  assert.throws(
    () => readTextAsset(reader),
    (err: unknown) =>
      err instanceof CorruptError && err.message.includes(`ends at ${FROM.bytes.length} of its`),
  );
});
