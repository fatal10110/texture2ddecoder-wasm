// Font (#41): the hardcoded reader, checked against the oracle's typetree dumps
// and raw-data hashes (R12), readTypeTree() on the same objects, and hand-built
// layouts from Unity's type trees (UnityPy's TPK data).

import assert from "node:assert/strict";
import { test } from "node:test";

import { golden, sha256 } from "../../../fixtures/helpers.js";
import { readFont, type CharacterInfo, type Font } from "../src/classes/Font.js";
import type { Texture2DData } from "../src/classes/registry.js";
import { readTexture2D } from "../src/classes/Texture2D.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ClassID } from "../src/serialized/ClassID.js";
import type { UnityVersion } from "../src/serialized/SerializedFile.js";
import { fixturesWith, objectBytes, objectsOf, typedTwin } from "./class-readers.js";
import {
  build,
  goldenForm,
  goldenTree,
  rawGolden,
  readerOf,
  template,
  versionRefusal,
  withTail,
  type Writer,
} from "./media.js";

const FIXTURES = fixturesWith(ClassID.Font);

// --- every Font of the editor fixtures ----------------------------------------------

for (const name of FIXTURES) {
  test(`${name}: readFont equals the golden dump; m_FontData is the golden font file`, () => {
    const tree = goldenTree(name, ClassID.Font);
    const objects = objectsOf(name, ClassID.Font);
    assert.equal(objects.length, 1);
    for (const { reader, file, dump, enableTypeTree } of objects) {
      assert.ok(dump, `no golden dump for Font ${reader.pathId}`);
      const font = readFont(reader);
      assert.equal(reader.position, reader.byteSize, "byteSize not consumed exactly");
      // Every field, in Unity's order, with the oracle's values.
      assert.deepEqual(Object.keys(font), Object.keys(dump));
      assert.deepEqual(goldenForm(tree, font), dump);
      if (enableTypeTree) {
        const typed = reader.readTypeTree();
        assert.deepEqual(Object.keys(font), Object.keys(typed));
        assert.deepEqual(font, typed);
      } else {
        assert.equal(reader.serializedType?.nodes, null, "the file has a type tree after all");
      }

      // obj.read() is readFont: the font file is inline, nothing to resolve.
      assert.deepEqual(reader.read<Font>(), font);
      const want = rawGolden(name, reader.pathId);
      assert.ok(want, `no raw-data golden for Font ${reader.pathId}`);
      assert.equal(want.source, "inline");
      assert.equal(font.m_FontData.length, want.size);
      assert.equal(sha256(font.m_FontData), want.sha256);
      // A view into the SerializedFile, never a copy (R7).
      assert.equal(font.m_FontData.buffer, file.buffer);
      // A TrueType file: sfnt version 1.0.
      assert.deepEqual([...font.m_FontData.subarray(0, 4)], [0, 1, 0, 0]);
    }
  });
}

test("the Font checks cover formats 21 and 22, typed, notypetree and version-stripped", () => {
  const seen = new Set<string>();
  for (const name of FIXTURES) {
    for (const { formatVersion, unityVersion, enableTypeTree, reader } of objectsOf(
      name,
      ClassID.Font,
    )) {
      const kind = !enableTypeTree ? "notypetree" : unityVersion === "0.0.0" ? "stripped" : "typed";
      if (kind === "stripped") assert.deepEqual(reader.version, [0, 0, 0, 0]);
      seen.add(`${formatVersion} ${kind}`);
    }
  }
  assert.deepEqual(
    [...seen].sort(),
    ["21 notypetree", "21 stripped", "21 typed", "22 notypetree", "22 stripped", "22 typed"],
  );
});

test("a dynamic font's 0x0 Font Texture: fields as the golden, read() has empty imageData", () => {
  const seen: string[] = [];
  for (const name of FIXTURES.filter((n) => !n.includes("/stripped/"))) {
    // objectsOf walks env.objects of a load(), as a caller reading every Texture2D does.
    const [texture, ...more] = objectsOf(name, ClassID.Texture2D);
    assert.ok(texture && more.length === 0);
    const { reader, dump, file } = texture;
    const fields = readTexture2D(reader);
    assert.equal(fields.m_Name, "Font Texture");
    assert.deepEqual(goldenForm(goldenTree(name, ClassID.Texture2D), fields), dump);
    assert.equal(fields.m_Width, 0);
    assert.equal(fields.m_Height, 0);
    // Neither inline data nor a .resS: no texture golden either (make-goldens.py).
    assert.equal(fields["image data"].length, 0);
    assert.equal(fields.m_StreamData?.path, "");
    const sf = Object.values(golden(typedTwin(name)).serialized!)[0]!;
    assert.equal(sf.textures, undefined);

    // Not corrupt (#139): read() is the fields, with the empty inline data as imageData.
    const { imageData, platform, ...rest } = reader.read<Texture2DData>();
    assert.deepEqual(rest, fields);
    assert.ok(imageData instanceof Uint8Array);
    assert.equal(imageData.length, 0);
    // Still a view into the SerializedFile, never a copy (R7).
    assert.equal(imageData.buffer, file.buffer);
    assert.equal(platform, reader.platform);
    seen.push(name.split("/").slice(1, 3).join(" "));
  }
  assert.deepEqual(seen.sort(), [
    "2019.4.41f2 lz4",
    "2019.4.41f2 lz4-notypetree",
    "2020.3.30f1 lz4",
    "2020.3.30f1 lz4-notypetree",
    "6000.3.25f1 lz4",
    "6000.3.25f1 lz4-notypetree",
  ]);
});

// --- layouts of Unity's type trees ---------------------------------------------------

const FROM = template("editor/6000.3.25f1/lz4/font", ClassID.Font);

const rect = (w: Writer, base: number) => ({
  x: w.f32(base),
  y: w.f32(base + 0.25),
  width: w.f32(base + 0.5),
  height: w.f32(base + 0.75),
});

/** A `CharacterInfo`: `width` before 5.3, `advance` from it; `flipped` from 4.0, padded. */
const glyph =
  (w: Writer, advance: boolean, flipped: boolean) =>
  (index: number): CharacterInfo => ({
    index: w.u32(index),
    uv: rect(w, index),
    vert: rect(w, index + 10),
    ...(advance ? { advance: w.f32(index / 2) } : { width: w.f32(index / 2) }),
    ...(flipped ? { flipped: w.pad(w.bool(index % 2 === 0)) } : {}),
  });

const kerning = (w: Writer): [[number, number], number][] =>
  w.array([[65, 86, -1.5] as const], ([a, b, k]) => [[w.u16(a), w.u16(b)], w.f32(k)]);

/** 3.4 to 3.5 (TPK 3.4.0). */
const L3_4 = (w: Writer, wide: boolean): Font => ({
  m_Name: w.str("Glyphs"),
  m_AsciiStartOffset: w.i32(32),
  m_FontCountX: w.i32(16),
  m_FontCountY: w.i32(8),
  m_Kerning: w.f32(0.5),
  m_LineSpacing: w.f32(18),
  m_PerCharacterKerning: w.array([65, 66], (c) => [w.i32(c), w.f32(c / 4)] as [number, number]),
  m_ConvertCase: w.i32(-2),
  m_DefaultMaterial: w.pptr(0, 5n, wide),
  m_CharacterRects: w.array([1, 2], glyph(w, false, false)),
  m_Texture: w.pptr(0, 6n, wide),
  m_KerningValues: kerning(w),
  m_GridFont: w.pad(w.bool(true)),
  m_FontData: w.pad(w.bytes(Uint8Array.of(0, 1, 0, 0, 9))),
  m_FontSize: w.f32(16),
  m_Ascent: w.f32(12.5),
  m_DefaultStyle: w.u32(1),
  m_FontNames: w.array(["Glyphs", "Fallback"], (n) => w.str(n)),
});

/** 4.0 to 5.4 (TPK 4.0.0; 5.3.0 renames two fields, 5.4.0 adds m_Descent). */
const L4_0 = (w: Writer, wide: boolean, v5_3 = false, v5_4 = false): Font => ({
  m_Name: w.str("Glyphs"),
  m_AsciiStartOffset: w.i32(32),
  ...(v5_3 ? { m_Tracking: w.f32(0.5) } : { m_Kerning: w.f32(0.5) }),
  m_LineSpacing: w.f32(18),
  m_CharacterSpacing: w.i32(1),
  m_CharacterPadding: w.i32(2),
  m_ConvertCase: w.i32(-2),
  m_DefaultMaterial: w.pptr(0, 5n, wide),
  m_CharacterRects: w.array([1, 2, 3], glyph(w, v5_3, true)),
  m_Texture: w.pptr(0, 6n, wide),
  m_KerningValues: kerning(w),
  m_PixelScale: w.f32(0.1),
  m_FontData: w.pad(w.bytes(Uint8Array.of(0, 1, 0, 0, 9))),
  m_FontSize: w.f32(16),
  m_Ascent: w.f32(12.5),
  ...(v5_4 ? { m_Descent: w.f32(-3.5) } : {}),
  m_DefaultStyle: w.u32(1),
  m_FontNames: w.array(["Glyphs"], (n) => w.str(n)),
  m_FallbackFonts: w.array([7n], (id) => w.pptr(1, id, wide)),
  m_FontRenderingMode: w.i32(2),
});

/**
 * 5.5 and later (TPK 5.5.0f3): the fields reordered. `tail` is how many of the
 * two unpadded bools end it: 1 in some 5.6.5 to 2017.x releases, 2 from 2018.1.
 */
const L5_5 = (w: Writer, tail: 0 | 1 | 2): Font => ({
  m_Name: w.str("Glyphs"),
  m_LineSpacing: w.f32(18),
  m_DefaultMaterial: w.pptr(0, 5n),
  m_FontSize: w.f32(16),
  m_Texture: w.pptr(0, 6n),
  m_AsciiStartOffset: w.i32(32),
  m_Tracking: w.f32(0.5),
  m_CharacterSpacing: w.i32(1),
  m_CharacterPadding: w.i32(2),
  m_ConvertCase: w.i32(-2),
  m_CharacterRects: w.array([1, 2, 3], glyph(w, true, true)),
  m_KerningValues: kerning(w),
  m_PixelScale: w.f32(0.1),
  m_FontData: w.pad(w.bytes(Uint8Array.of(0, 1, 0, 0, 9))),
  m_Ascent: w.f32(12.5),
  m_Descent: w.f32(-3.5),
  m_DefaultStyle: w.u32(1),
  m_FontNames: w.array(["Glyphs"], (n) => w.str(n)),
  m_FallbackFonts: w.array([7n], (id) => w.pptr(1, id)),
  m_FontRenderingMode: w.i32(2),
  ...(tail >= 1 ? { m_UseLegacyBoundsCalculation: w.bool(true) } : {}),
  ...(tail >= 2 ? { m_ShouldRoundAdvanceValue: w.bool(false) } : {}),
});

/** Each layout at the versions where it starts and where it is last, with a format of it. */
const LAYOUTS: { unity: UnityVersion; format: number; layout: (w: Writer) => Font }[] = [
  { unity: [3, 4, 0, 1], format: 8, layout: (w) => L3_4(w, false) },
  { unity: [3, 5, 7, 1], format: 9, layout: (w) => L3_4(w, false) },
  { unity: [4, 0, 0, 1], format: 9, layout: (w) => L4_0(w, false) },
  { unity: [4, 7, 2, 1], format: 9, layout: (w) => L4_0(w, false) },
  { unity: [5, 0, 0, 1], format: 15, layout: (w) => L4_0(w, true) },
  { unity: [5, 2, 5, 1], format: 15, layout: (w) => L4_0(w, true) },
  { unity: [5, 3, 0, 1], format: 15, layout: (w) => L4_0(w, true, true) },
  { unity: [5, 4, 0, 1], format: 15, layout: (w) => L4_0(w, true, true, true) },
  { unity: [5, 5, 0, 1], format: 17, layout: (w) => L5_5(w, 0) },
  { unity: [5, 6, 4, 1], format: 17, layout: (w) => L5_5(w, 0) },
  { unity: [5, 6, 5, 1], format: 17, layout: (w) => L5_5(w, 1) },
  { unity: [2017, 1, 0, 1], format: 17, layout: (w) => L5_5(w, 0) },
  { unity: [2017, 1, 2, 4], format: 17, layout: (w) => L5_5(w, 1) },
  { unity: [2017, 4, 40, 1], format: 17, layout: (w) => L5_5(w, 1) },
  { unity: [2018, 1, 0, 1], format: 17, layout: (w) => L5_5(w, 2) },
  { unity: [2019, 4, 41, 2], format: 21, layout: (w) => L5_5(w, 2) },
  { unity: [6000, 3, 25, 1], format: 22, layout: (w) => L5_5(w, 2) },
];

for (const { unity, format, layout } of LAYOUTS) {
  test(`Unity ${unity.slice(0, 3).join(".")}: the layout of Unity's type tree`, () => {
    const { bytes, expected } = build(layout);
    const reader = readerOf(FROM, bytes, { unity, format });
    const font = readFont(reader);
    assert.deepEqual(Object.keys(font), Object.keys(expected));
    assert.deepEqual(font, expected);
    assert.equal(reader.remaining, 0);
  });
}

test("an editor file (NoTarget): the EditorExtension header, then the Font fields", () => {
  const { bytes, expected } = build((w) => ({
    m_ObjectHideFlags: w.u32(0),
    m_CorrespondingSourceObject: w.pptr(0, 0n),
    m_PrefabInstance: w.pptr(0, 0n),
    m_PrefabAsset: w.pptr(0, 0n),
    ...L5_5(w, 2),
  }));
  const reader = readerOf(FROM, bytes, {
    unity: [2019, 4, 41, 2],
    format: 21,
    platform: BuildTarget.NoTarget,
  });
  const font = readFont(reader);
  assert.deepEqual(Object.keys(font), Object.keys(expected));
  assert.deepEqual(font, expected);
});

test("5.5 to 2017.x: two bytes after m_FontRenderingMode are one too many", () => {
  const reader = readerOf(FROM, build((w) => L5_5(w, 2)).bytes, {
    unity: [2017, 4, 40, 1],
    format: 17,
  });
  assert.throws(() => readFont(reader), /Font -?\d+ ends at \d+ of its \d+ bytes/);
});

// --- version-stripped files (#36 rule) ------------------------------------------------

const STRIPPED: UnityVersion = [0, 0, 0, 0];

test('Unity "0.0.0" in format 16 or 17: the bytes left pick 5.5, 5.6.5 or 2018.1', () => {
  for (const format of [16, 17]) {
    for (const tail of [0, 1, 2] as const) {
      const { bytes, expected } = build((w) => L5_5(w, tail));
      const reader = readerOf(FROM, bytes, { unity: STRIPPED, text: "0.0.0", format });
      assert.deepEqual(readFont(reader), expected, `format ${format}, ${tail} bools`);
    }
  }
});

test('Unity "0.0.0" in format 18 or later (2019.1 on): only 2018.1\'s two bools fit', () => {
  for (const format of [18, 21, 22]) {
    const { bytes, expected } = build((w) => L5_5(w, 2));
    const reader = readerOf(FROM, bytes, { unity: STRIPPED, text: "0.0.0", format });
    assert.deepEqual(readFont(reader), expected, `format ${format}`);
    // 0 or 1 byte left is 5.5's or 5.6.5's layout, which no editor writing
    // format 18 or later has.
    for (const tail of [0, 1] as const) {
      const short = readerOf(FROM, build((w) => L5_5(w, tail)).bytes, {
        unity: STRIPPED,
        text: "0.0.0",
        format,
      });
      assert.throws(
        () => readFont(short),
        (err: unknown) =>
          versionRefusal("0.0.0")(err) &&
          (err as UnsupportedError).message.includes("fit none of the layouts"),
        `format ${format}, ${tail} bools`,
      );
    }
  }
});

test('Unity "0.0.0": 3 or more bytes after m_FontRenderingMode fit no layout', () => {
  for (const format of [17, 22]) {
    for (const extra of [[0], [0, 0, 0, 0]]) {
      const bytes = withTail(build((w) => L5_5(w, 2)).bytes, ...extra);
      const reader = readerOf(FROM, bytes, { unity: STRIPPED, text: "0.0.0", format });
      assert.throws(
        () => readFont(reader),
        (err: unknown) =>
          versionRefusal("0.0.0")(err) &&
          (err as UnsupportedError).message.includes("fit none of the layouts"),
        `format ${format}, ${extra.length} extra`,
      );
    }
  }
});

test('Unity "0.0.0": an object cut short of the 5.5 fields is refused, not corrupt', () => {
  const { bytes } = build((w) => L5_5(w, 2));
  // Cut inside m_FontNames: past m_Name, which every layout starts with.
  const cut = bytes.subarray(0, bytes.length - 30);
  const reader = readerOf(FROM, cut, { unity: STRIPPED, text: "0.0.0", format: 22 });
  assert.throws(
    () => readFont(reader),
    (err: unknown) =>
      versionRefusal("0.0.0")(err) &&
      (err as UnsupportedError).message.includes("does not fit"),
  );
});

const REFUSED: { unity: UnityVersion; text: string; format: number; why: string }[] = [
  { unity: STRIPPED, text: "0.0.0", format: 15, why: "[0,0,0,0] in format 15 (5.0 to 5.4)" },
  { unity: STRIPPED, text: "2.5.0f5", format: 6, why: "[0,0,0,0] in a format 6 loose file" },
  { unity: [3, 3, 0, 1], text: "3.3.0f1", format: 8, why: "a known version below 3.4" },
];

for (const { unity, text, format, why } of REFUSED) {
  test(`${why}: UnsupportedError("Unity version", "${text}")`, () => {
    for (const layout of [(w: Writer) => L3_4(w, false), (w: Writer) => L5_5(w, 2)]) {
      const reader = readerOf(FROM, build(layout).bytes, { unity, text, format });
      assert.throws(() => readFont(reader), versionRefusal(text));
      assert.throws(() => reader.read(), versionRefusal(text));
    }
  });
}

// --- corrupt objects ----------------------------------------------------------------

test("every cut through a Font throws CorruptError", () => {
  const { bytes } = build((w) => L5_5(w, 2));
  const unity: UnityVersion = [6000, 3, 25, 1];
  readFont(readerOf(FROM, bytes, { unity }));
  // It ends with two unpadded bools: every cut loses data.
  for (let cut = 0; cut < bytes.length; cut++) {
    const reader = readerOf(FROM, bytes.subarray(0, cut), { unity });
    assert.throws(() => readFont(reader), CorruptError, `cut at ${cut}`);
  }
});

test("the fixture Font cut anywhere throws CorruptError", () => {
  const from = objectBytes("editor/2019.4.41f2/lz4/font", ClassID.Font);
  const unity: UnityVersion = [2019, 4, 41, 2];
  readFont(readerOf(from, from.bytes, { unity }));
  for (let cut = 0; cut < from.bytes.length; cut++) {
    const reader = readerOf(from, from.bytes.subarray(0, cut), { unity });
    assert.throws(() => readFont(reader), CorruptError, `cut at ${cut}`);
  }
});

test("a negative or oversized m_FontData count throws CorruptError", () => {
  const unity: UnityVersion = [6000, 3, 25, 1];
  const { bytes } = build((w) => L5_5(w, 2));
  // m_FontData's count follows m_PixelScale; find it by its 5-byte payload.
  const at = bytes.findIndex(
    (_, i) => bytes[i] === 5 && bytes[i + 4] === 0 && bytes[i + 5] === 1 && bytes[i + 8] === 9,
  );
  assert.ok(at > 0);
  for (const [count, message] of [
    [-1, /m_FontData byte count -1 at offset \d+ is negative/],
    [1 << 20, /m_FontData byte count 1048576 at offset \d+ exceeds the \d+ bytes left/],
  ] as const) {
    const copy = bytes.slice();
    new DataView(copy.buffer).setInt32(at, count, true);
    assert.throws(() => readFont(readerOf(FROM, copy, { unity })), message);
  }
});
