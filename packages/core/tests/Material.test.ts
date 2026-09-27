// Material (#40): the hardcoded reader, checked against the oracle's typetree
// dumps (R12) and readTypeTree() on the same objects, in the Material fixtures
// of every editor, and against hand-built layouts for each version gate of
// Unity's type trees (UnityPy's TPK data).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  readMaterial,
  type Color,
  type Material,
  type UnityTexEnv,
  type Vector2,
} from "../src/classes/Material.js";
import type { PPtr } from "../src/classes/PPtr.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ClassID } from "../src/serialized/ClassID.js";
import type { UnityVersion } from "../src/serialized/SerializedFile.js";
import {
  fixturesWith,
  normalize,
  objectBytes,
  objectsOf,
  synthetic,
  withTail,
} from "./class-readers.js";

const FIXTURES = fixturesWith(ClassID.Material);
/**
 * This PR's `material/*` bundles (fixtures/BUILDING.md section 10), whose
 * values the build script set. Other fixtures may hold a Material too (a
 * font's), checked only against the oracle.
 */
const MATERIAL_FIXTURES = FIXTURES.filter((name) => name.includes("/material/"));
const STRIPPED: UnityVersion = [0, 0, 0, 0];
const isStripped = (version: UnityVersion): boolean => version.every((part) => part === 0);

// --- plan §5 normalization: int64 as a decimal string, floats by bit pattern ---------

function f32(value: number): string {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  return `f32:${view.getUint32(0).toString(16).padStart(8, "0")}`;
}

const vector = ({ x, y }: Vector2) => ({ x: f32(x), y: f32(y) });
const color = ({ r, g, b, a }: Color) => ({ r: f32(r), g: f32(g), b: f32(b), a: f32(a) });

/** A Material in the golden's form, keys in the order they come. */
function toGolden(material: Material): unknown {
  const out = normalize(material) as Record<string, unknown>;
  const sheet: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(material.m_SavedProperties)) {
    const pairs = value as [string, unknown][];
    if (key === "m_TexEnvs") {
      sheet[key] = (pairs as [string, UnityTexEnv][]).map(([name, env]) => [
        name,
        {
          ...(normalize(env) as object),
          m_Scale: vector(env.m_Scale),
          m_Offset: vector(env.m_Offset),
        },
      ]);
    } else if (key === "m_Floats") {
      sheet[key] = (pairs as [string, number][]).map(([name, v]) => [name, f32(v)]);
    } else if (key === "m_Colors") {
      sheet[key] = (pairs as [string, Color][]).map(([name, c]) => [name, color(c)]);
    } else {
      sheet[key] = value;
    }
  }
  // Replaced in place, so m_SavedProperties keeps its position among the keys.
  out.m_SavedProperties = sheet;
  return out;
}

/** The refusal the #36 rule asks for, with the file's own version string. */
const refusedFor = (text: string, pathId: bigint) => (err: unknown) =>
  err instanceof UnsupportedError &&
  err.kind === "Unity version" &&
  err.found === text &&
  err.message.includes(`object ${pathId}`);

// --- the Material of every fixture --------------------------------------------------

for (const name of FIXTURES) {
  test(`${name}: readMaterial equals the golden dump and readTypeTree()`, () => {
    const objects = objectsOf(name, ClassID.Material);
    assert.equal(objects.length, 1);
    for (const { env, reader, dump, enableTypeTree, unityVersion } of objects) {
      assert.ok(dump, `no golden dump for Material ${reader.pathId}`);
      const obj = env.objects.find((o) => o.pathId === reader.pathId)!;

      if (isStripped(reader.version) && reader.format >= 22) {
        // Version-stripped, format 22: the layouts of 2020.1 to 6000 differ
        // inside the object, so the reader refuses; its type tree still reads.
        assert.equal(unityVersion, "0.0.0");
        assert.throws(() => readMaterial(reader), refusedFor("0.0.0", reader.pathId));
        // No fallback to the type tree (#36).
        assert.throws(() => obj.read(), refusedFor("0.0.0", reader.pathId));
        assert.deepEqual(toGolden(reader.readTypeTree() as unknown as Material), dump);
        continue;
      }

      const material = readMaterial(reader);
      assert.equal(reader.position, reader.byteSize, "byteSize not consumed exactly");
      // Every field, in Unity's order, with the oracle's values.
      assert.deepEqual(Object.keys(material), Object.keys(dump));
      assert.deepEqual(
        Object.keys(material.m_SavedProperties),
        Object.keys(dump.m_SavedProperties as object),
      );
      assert.deepEqual(toGolden(material), dump);
      // obj.read() goes through the registry to this reader.
      assert.deepEqual(obj.read(), material);

      if (enableTypeTree) {
        const tree = reader.readTypeTree();
        assert.deepEqual(Object.keys(material), Object.keys(tree));
        assert.deepEqual(material, tree);
      } else {
        assert.equal(reader.serializedType?.nodes, null, "the file has a type tree after all");
      }
    }
  });
}

test("the Material checks cover formats 21 and 22, typed, notypetree and version-stripped", () => {
  const seen = new Set<string>();
  for (const name of MATERIAL_FIXTURES) {
    for (const { formatVersion, unityVersion, enableTypeTree, reader } of objectsOf(
      name,
      ClassID.Material,
    )) {
      const kind = !enableTypeTree ? "notypetree" : unityVersion === "0.0.0" ? "stripped" : "typed";
      if (kind === "stripped") assert.deepEqual(reader.version, STRIPPED);
      seen.add(`${formatVersion} ${kind}`);
    }
  }
  assert.deepEqual(
    [...seen].sort(),
    ["21 notypetree", "21 stripped", "21 typed", "22 notypetree", "22 stripped", "22 typed"],
  );
});

test("the three editors cover three layouts: 2019.4, 2020.3 and 6000.3", () => {
  const keysOf = (editor: string) => {
    const [{ reader }] = objectsOf(`editor/${editor}/material/lz4/material`, ClassID.Material) as [
      ReturnType<typeof objectsOf>[number],
    ];
    const material = readMaterial(reader);
    return [...Object.keys(material), ...Object.keys(material.m_SavedProperties)];
  };
  const v2019 = keysOf("2019.4.41f2");
  const v2020 = keysOf("2020.3.30f1");
  const v6000 = keysOf("6000.3.25f1");
  assert.ok(v2019.includes("m_ShaderKeywords") && !v2019.includes("m_BuildTextureStacks"));
  assert.ok(v2020.includes("m_ShaderKeywords") && v2020.includes("m_BuildTextureStacks"));
  assert.ok(!v2020.includes("m_Ints"));
  assert.ok(v6000.includes("m_ValidKeywords") && v6000.includes("m_Ints"));
  assert.ok(!v6000.includes("m_ShaderKeywords"));
});

test("the fixture holds what the build script set (fixtures/BUILDING.md)", () => {
  // Three editors, three variants each.
  assert.equal(MATERIAL_FIXTURES.length, 9);
  for (const name of MATERIAL_FIXTURES) {
    for (const { reader } of objectsOf(name, ClassID.Material)) {
      if (isStripped(reader.version) && reader.format >= 22) continue;
      const m = readMaterial(reader);
      const sheet = m.m_SavedProperties;
      assert.equal(m.m_Name, "uar", name);
      // The shader and the texture are in the `matdeps` bundle, the first external.
      assert.equal(m.m_Shader.m_FileID, 1);
      assert.notEqual(m.m_Shader.m_PathID, 0n);
      const texEnvs = new Map(sheet.m_TexEnvs);
      assert.deepEqual([...texEnvs.keys()], ["_BumpMap", "_MainTex"]);
      const main = texEnvs.get("_MainTex")!;
      assert.equal(main.m_Texture.m_FileID, 1);
      assert.notEqual(main.m_Texture.m_PathID, 0n);
      assert.deepEqual(main.m_Scale, { x: 2, y: 3 });
      assert.deepEqual(main.m_Offset, { x: 0.25, y: -0.5 });
      assert.deepEqual(texEnvs.get("_BumpMap")!.m_Texture, { m_FileID: 0, m_PathID: 0n });
      const colors = new Map(sheet.m_Colors);
      const fr = Math.fround;
      assert.deepEqual(colors.get("_Color"), { r: fr(0.1), g: fr(0.2), b: fr(0.3), a: fr(0.4) });
      assert.deepEqual(colors.get("_EmissionColor"), { r: 2, g: 0.5, b: 0, a: 1 });
      const floats = new Map(sheet.m_Floats);
      assert.equal(floats.get("_Glossiness"), 0.75);
      // An Integer property from 2021.1, a float before.
      if (sheet.m_Ints) assert.deepEqual(sheet.m_Ints, [["_UarInt", -7]]);
      else assert.equal(floats.get("_UarInt"), -7);
      if (m.m_ValidKeywords) {
        assert.deepEqual(m.m_ValidKeywords, ["_EMISSION", "_NORMALMAP"]);
        assert.deepEqual(m.m_InvalidKeywords, ["UAR_NOT_IN_SHADER"]);
      } else {
        assert.deepEqual(String(m.m_ShaderKeywords).split(" ").sort(), [
          "UAR_NOT_IN_SHADER",
          "_EMISSION",
          "_NORMALMAP",
        ]);
      }
      assert.equal(m.m_LightmapFlags, 2); // MaterialGlobalIlluminationFlags.BakedEmissive
      assert.equal(m.m_EnableInstancingVariants, true);
      assert.equal(m.m_DoubleSidedGI, true);
      assert.equal(m.m_CustomRenderQueue, 2450);
      assert.deepEqual(m.stringTagMap, [["RenderType", "TransparentCutout"]]);
      assert.deepEqual(m.disabledShaderPasses, ["SHADOWCASTER"]);
    }
  }
});

// --- hand-built layouts, one per version gate of Unity's type trees --------------------

/** Little-endian bytes, as Unity writes them. */
class Writer {
  readonly out: number[] = [];
  private readonly view = new DataView(new ArrayBuffer(8));

  private push(size: number): void {
    this.out.push(...new Uint8Array(this.view.buffer, 0, size));
  }
  i32(value: number): void {
    this.view.setInt32(0, value, true);
    this.push(4);
  }
  u32(value: number): void {
    this.view.setUint32(0, value, true);
    this.push(4);
  }
  f32(value: number): void {
    this.view.setFloat32(0, value, true);
    this.push(4);
  }
  u8(value: number): void {
    this.out.push(value);
  }
  align(): void {
    while (this.out.length % 4) this.out.push(0);
  }
  str(text: string): void {
    const data = new TextEncoder().encode(text);
    this.i32(data.length);
    this.out.push(...data);
    this.align();
  }
  strings(list: string[]): void {
    this.i32(list.length);
    for (const text of list) this.str(text);
  }
  /** A pointer: a 32-bit path id below format 14. */
  pptr({ m_FileID, m_PathID }: PPtr, wide: boolean): void {
    this.i32(m_FileID);
    if (!wide) return this.i32(Number(m_PathID));
    this.view.setBigInt64(0, m_PathID, true);
    this.push(8);
  }
}

/**
 * One piece of a layout: what it writes and the fields it stands for. Every
 * value is distinct from its neighbours, and every string's length is not a
 * multiple of 4, so a missing align shows.
 */
type Piece = (w: Writer, wide: boolean, out: Record<string, unknown>) => void;

const SHADER: PPtr = { m_FileID: 1, m_PathID: -123456789n };
const TEXTURE: PPtr = { m_FileID: 2, m_PathID: 987654321n };
const NO_TEXTURE: PPtr = { m_FileID: 0, m_PathID: 0n };

const PIECES: Record<string, Piece> = {
  name: (w, _, out) => {
    w.str("mat");
    out.m_Name = "mat";
  },
  shader: (w, wide, out) => {
    w.pptr(SHADER, wide);
    out.m_Shader = SHADER;
  },
  keywordList: (w, _, out) => {
    w.strings(["_KW_A", "_KW_BB"]);
    out.m_ShaderKeywords = ["_KW_A", "_KW_BB"];
  },
  keywordString: (w, _, out) => {
    w.str("_KW_A _KW_BB");
    out.m_ShaderKeywords = "_KW_A _KW_BB";
  },
  keywordLists: (w, _, out) => {
    w.strings(["_KW_A", "_KW_BB"]);
    w.strings(["_NOPE"]);
    out.m_ValidKeywords = ["_KW_A", "_KW_BB"];
    out.m_InvalidKeywords = ["_NOPE"];
  },
  lightmap: (w, _, out) => {
    w.u32(0x8000_0004);
    out.m_LightmapFlags = 0x8000_0004;
  },
  instancing: (w, _, out) => {
    w.u8(1);
    w.align();
    out.m_EnableInstancingVariants = true;
  },
  instancingGI: (w, _, out) => {
    w.u8(1);
    w.u8(0);
    w.align();
    out.m_EnableInstancingVariants = true;
    out.m_DoubleSidedGI = false;
  },
  queue: (w, _, out) => {
    w.i32(-3000);
    out.m_CustomRenderQueue = -3000;
  },
  tags: (w, _, out) => {
    w.i32(2);
    for (const text of ["RenderType", "Opaque", "Queue", "Geometry+1"]) w.str(text);
    out.stringTagMap = [
      ["RenderType", "Opaque"],
      ["Queue", "Geometry+1"],
    ];
  },
  passes: (w, _, out) => {
    w.strings(["SHADOWCASTER"]);
    out.disabledShaderPasses = ["SHADOWCASTER"];
  },
  sheet: (w, wide, out) => sheet(w, wide, out, false),
  sheetInts: (w, wide, out) => sheet(w, wide, out, true),
  stacks: (w, _, out) => {
    w.i32(1);
    w.str("grp");
    w.str("item1");
    out.m_BuildTextureStacks = [{ groupName: "grp", itemName: "item1" }];
  },
};

function sheet(w: Writer, wide: boolean, out: Record<string, unknown>, ints: boolean): void {
  // Filled in field order, so the keys come out in Unity's order.
  const result: Record<string, unknown> = {};
  const texEnvs: [string, UnityTexEnv][] = [
    ["_MainTex", { m_Texture: TEXTURE, m_Scale: { x: 2, y: -0 }, m_Offset: { x: 0.5, y: 1024.5 } }],
    ["_Bmp", { m_Texture: NO_TEXTURE, m_Scale: { x: 1, y: 1 }, m_Offset: { x: 0, y: 0 } }],
  ];
  w.i32(texEnvs.length);
  for (const [name, env] of texEnvs) {
    w.str(name);
    w.pptr(env.m_Texture, wide);
    for (const v of [env.m_Scale, env.m_Offset]) {
      w.f32(v.x);
      w.f32(v.y);
    }
  }
  result.m_TexEnvs = texEnvs;
  if (ints) {
    w.i32(1);
    w.str("_Steps");
    w.i32(-5);
    result.m_Ints = [["_Steps", -5]];
  }
  const floats: [string, number][] = [
    ["_Cutoff", 0.25],
    ["_NegZero", -0],
  ];
  w.i32(floats.length);
  for (const [name, v] of floats) {
    w.str(name);
    w.f32(v);
  }
  result.m_Floats = floats;
  w.i32(1);
  w.str("_Color");
  for (const v of [0.5, 2, -1, 0.125]) w.f32(v);
  result.m_Colors = [["_Color", { r: 0.5, g: 2, b: -1, a: 0.125 }]];
  out.m_SavedProperties = result;
}

/** A layout's bytes and the object a reader must return for them. */
function layout(
  pieces: string[],
  wide = true,
): { bytes: Uint8Array; expected: Record<string, unknown> } {
  const w = new Writer();
  const expected: Record<string, unknown> = {};
  for (const piece of pieces) PIECES[piece]!(w, wide, expected);
  return { bytes: Uint8Array.from(w.out), expected };
}

const FROM = objectBytes("editor/6000.3.25f1/material/lz4/material", ClassID.Material);

const V3_4 = ["name", "shader", "sheet"];
const V4_1 = ["name", "shader", "keywordList", "sheet"];
const V4_3 = ["name", "shader", "keywordList", "queue", "sheet"];
const V5_0 = ["name", "shader", "keywordString", "lightmap", "queue", "sheet"];
const V5_1 = ["name", "shader", "keywordString", "lightmap", "queue", "tags", "sheet"];
const V5_6 = ["name", "shader", "keywordString", "lightmap", "instancing", "queue", "tags"]
  .concat(["passes", "sheet"]);
const V5_6_2 = V5_6.map((p) => (p === "instancing" ? "instancingGI" : p));
const V2020_1 = [...V5_6_2, "stacks"];
const V2021_1 = V2020_1.map((p) => (p === "sheet" ? "sheetInts" : p));
const V2021_2_18 = V2021_1.map((p) => (p === "keywordString" ? "keywordLists" : p));

/** Unity's type tree layouts (TPK data), each at a version it holds for, with its format. */
const LAYOUTS: { unity: UnityVersion; format: number; pieces: string[] }[] = [
  { unity: [3, 4, 0, 1], format: 8, pieces: V3_4 },
  { unity: [4, 0, 1, 1], format: 9, pieces: V3_4 },
  { unity: [4, 1, 0, 1], format: 9, pieces: V4_1 },
  { unity: [4, 2, 2, 1], format: 9, pieces: V4_1 },
  { unity: [4, 3, 0, 1], format: 9, pieces: V4_3 },
  { unity: [4, 7, 2, 1], format: 9, pieces: V4_3 },
  { unity: [5, 0, 0, 1], format: 15, pieces: V5_0 },
  { unity: [5, 1, 0, 1], format: 15, pieces: V5_1 },
  { unity: [5, 5, 6, 1], format: 17, pieces: V5_1 },
  { unity: [5, 6, 0, 1], format: 17, pieces: V5_6 },
  { unity: [5, 6, 1, 1], format: 17, pieces: V5_6 },
  { unity: [5, 6, 2, 1], format: 17, pieces: V5_6_2 },
  { unity: [2018, 4, 36, 1], format: 17, pieces: V5_6_2 },
  { unity: [2019, 4, 41, 2], format: 21, pieces: V5_6_2 },
  { unity: [2020, 1, 0, 1], format: 22, pieces: V2020_1 },
  { unity: [2020, 3, 30, 1], format: 22, pieces: V2020_1 },
  { unity: [2021, 1, 0, 1], format: 22, pieces: V2021_1 },
  { unity: [2021, 2, 17, 1], format: 22, pieces: V2021_1 },
  { unity: [2021, 2, 18, 1], format: 22, pieces: V2021_2_18 },
  { unity: [2022, 3, 0, 1], format: 22, pieces: V2021_2_18 },
  { unity: [6000, 3, 25, 1], format: 22, pieces: V2021_2_18 },
];

const text = (unity: UnityVersion): string => unity.slice(0, 3).join(".");

for (const { unity, format, pieces } of LAYOUTS) {
  test(`Unity ${text(unity)}: the layout of Unity's type tree`, () => {
    const { bytes, expected } = layout(pieces, format >= 14);
    const reader = synthetic(FROM, bytes, unity, text(unity), undefined, format);
    const material = readMaterial(reader);
    assert.deepEqual(Object.keys(material), Object.keys(expected));
    assert.deepEqual(
      Object.keys(material.m_SavedProperties),
      Object.keys(expected.m_SavedProperties as object),
    );
    assert.deepEqual(material, expected);
    assert.ok(Object.is(material.m_SavedProperties.m_Floats[1]![1], -0), "-0 kept");
    assert.equal(reader.remaining, 0);
  });
}

test("each gate's layout, read under the version before the gate, is not the same object", () => {
  for (let i = 1; i < LAYOUTS.length; i++) {
    const { unity, format, pieces } = LAYOUTS[i]!;
    const before = LAYOUTS[i - 1]!;
    if (before.pieces === pieces) continue;
    const { bytes, expected } = layout(pieces, format >= 14);
    const reader = synthetic(FROM, bytes, before.unity, text(before.unity), undefined, format);
    let result: unknown;
    try {
      result = readMaterial(reader);
    } catch (err) {
      assert.ok(err instanceof CorruptError, `${text(unity)}: ${String(err)}`);
      continue;
    }
    assert.notDeepEqual(result, expected, `${text(unity)} read as ${text(before.unity)}`);
  }
});

// --- editor files -------------------------------------------------------------------

const EDITOR_HEADERS: { unity: UnityVersion; pointers: string[]; pieces: string[] }[] = [
  { unity: [3, 4, 0, 1], pointers: ["m_ExtensionPtr"], pieces: V3_4 },
  {
    unity: [2017, 4, 0, 1],
    pointers: ["m_PrefabParentObject", "m_PrefabInternal"],
    pieces: V5_6_2,
  },
  {
    unity: [2019, 4, 41, 2],
    pointers: ["m_CorrespondingSourceObject", "m_PrefabInstance", "m_PrefabAsset"],
    pieces: V5_6_2,
  },
  {
    unity: [2021, 3, 0, 1],
    pointers: ["m_CorrespondingSourceObject", "m_PrefabInstance", "m_PrefabAsset"],
    pieces: V2021_2_18,
  },
];

for (const { unity, pointers, pieces } of EDITOR_HEADERS) {
  test(`an editor file (NoTarget) of ${text(unity)}: the EditorExtension header first`, () => {
    const wide = unity[0] >= 5;
    const w = new Writer();
    const header: Record<string, unknown> = { m_ObjectHideFlags: 0x8000_0001 };
    w.u32(0x8000_0001);
    pointers.forEach((field, i) => {
      const pptr = { m_FileID: 10 + i, m_PathID: BigInt(100 + i) };
      w.pptr(pptr, wide);
      header[field] = pptr;
    });
    const { bytes, expected } = layout(pieces, wide);
    const all = Uint8Array.from([...w.out, ...bytes]);
    const reader = synthetic(FROM, all, unity, text(unity), BuildTarget.NoTarget, wide ? 22 : 9);
    const material = readMaterial(reader);
    assert.deepEqual(Object.keys(material), [...Object.keys(header), ...Object.keys(expected)]);
    assert.deepEqual(material, { ...header, ...expected });
  });
}

test("an editor file of 2022.1 or later is refused: Unity adds editor-only fields", () => {
  for (const unity of [[2022, 1, 0, 1], [6000, 3, 25, 1]] as UnityVersion[]) {
    const reader = synthetic(FROM, FROM.bytes, unity, text(unity), BuildTarget.NoTarget);
    assert.throws(
      () => readMaterial(reader),
      (err: unknown) =>
        err instanceof UnsupportedError && err.kind === "build target" && err.found === "NoTarget",
    );
  }
});

// --- the #36 rule for version-stripped files ------------------------------------------

test('Unity "0.0.0" in a format 18 to 21 file: read as 2019, the one layout they allow', () => {
  const { bytes, expected } = layout(V5_6_2);
  for (const format of [18, 19, 20, 21]) {
    const reader = synthetic(FROM, bytes, STRIPPED, "0.0.0", undefined, format);
    assert.deepEqual(readMaterial(reader), expected, `format ${format}`);
  }
});

test('Unity "0.0.0" in a format 21 file: bytes that do not fit 2019\'s layout are refused', () => {
  // The layout was assumed, not read from the file, so a misfit means "not that
  // layout" (#36), not corruption: those of 2020.1 on, had a file of them been
  // written as format 21, bytes left over, and a cut after m_Shader.
  const v2019 = layout(V5_6_2).bytes;
  const shaderEnd = layout(["name", "shader"]).bytes.length;
  const misfits = [
    ...[V2020_1, V2021_1, V2021_2_18].map((pieces) => layout(pieces).bytes),
    withTail(v2019, 0, 0, 0, 0),
    v2019.subarray(0, shaderEnd + 2),
    v2019.subarray(0, v2019.length - 4),
  ];
  for (const [i, bytes] of misfits.entries()) {
    const reader = synthetic(FROM, bytes, STRIPPED, "0.0.0", undefined, 21);
    assert.throws(() => readMaterial(reader), refusedFor("0.0.0", reader.pathId), `misfit ${i}`);
    // With the version known, the same bytes are corrupt.
    const known = synthetic(FROM, bytes, [2019, 4, 41, 2], "2019.4.41f2", undefined, 21);
    assert.throws(() => readMaterial(known), CorruptError, `misfit ${i}, known version`);
  }
});

test('Unity "0.0.0" in a format 21 file: a cut before m_Shader ends is still corrupt', () => {
  // m_Name and m_Shader come first in every layout, so no layout was assumed yet.
  const shaderEnd = layout(["name", "shader"]).bytes.length;
  for (const cut of [2, shaderEnd - 1]) {
    const bytes = layout(V5_6_2).bytes.subarray(0, cut);
    const reader = synthetic(FROM, bytes, STRIPPED, "0.0.0", undefined, 21);
    assert.throws(() => readMaterial(reader), CorruptError, `cut at ${cut}`);
  }
});

/** Refused with the file's own version string, per #36. */
const REFUSED: { unity: UnityVersion; text: string; format: number; why: string }[] = [
  { unity: STRIPPED, text: "0.0.0", format: 22, why: "[0,0,0,0] in format 22 (2020.1 to 6000)" },
  { unity: STRIPPED, text: "0.0.0", format: 17, why: "[0,0,0,0] in format 17 (5.5 to 2018.4)" },
  { unity: STRIPPED, text: "0.0.0", format: 9, why: "[0,0,0,0] in format 9" },
  { unity: STRIPPED, text: "2.5.0f5", format: 6, why: "[0,0,0,0] in a format 6 loose file" },
  { unity: [3, 3, 0, 1], text: "3.3.0f1", format: 8, why: "a known version below 3.4" },
  { unity: [2, 6, 1, 1], text: "2.6.1f1", format: 6, why: "a known 2.x version" },
];

for (const { unity, text: found, format, why } of REFUSED) {
  test(`${why}: UnsupportedError("Unity version", "${found}")`, () => {
    for (const pieces of [V3_4, V5_6_2, V2021_2_18]) {
      const { bytes } = layout(pieces, format >= 14);
      const reader = synthetic(FROM, bytes, unity, found, undefined, format);
      assert.throws(() => readMaterial(reader), refusedFor(found, reader.pathId));
    }
  });
}

test('Unity "0.0.0" in an editor file of format 21: refused, the header needs the version', () => {
  const reader = synthetic(FROM, FROM.bytes, STRIPPED, "0.0.0", BuildTarget.NoTarget, 21);
  assert.throws(() => readMaterial(reader), refusedFor("0.0.0", reader.pathId));
});

// --- corrupt objects ----------------------------------------------------------------

const UNITY_6: UnityVersion = [6000, 3, 25, 1];

test("every cut through the fixture object throws CorruptError", () => {
  const { bytes } = FROM;
  // The last field is m_BuildTextureStacks' count: no trailing padding to cut.
  assert.equal(readMaterial(synthetic(FROM, bytes, UNITY_6)).m_BuildTextureStacks?.length, 0);
  for (let cut = 0; cut < bytes.length; cut++) {
    const reader = synthetic(FROM, bytes.subarray(0, cut), UNITY_6);
    assert.throws(() => readMaterial(reader), CorruptError, `cut at ${cut}`);
  }
});

test("bytes left after the last field throw CorruptError", () => {
  const reader = synthetic(FROM, withTail(FROM.bytes, 0, 0, 0, 0), UNITY_6);
  assert.throws(
    () => readMaterial(reader),
    (err: unknown) =>
      err instanceof CorruptError &&
      err.message.includes(`Material ${FROM.info.pathId} ends at ${FROM.bytes.length} of its`),
  );
});

/** The 6000.3 layout with the `Int32` at the start of `at` (a piece) replaced by `value`. */
function patched(at: string, value: number): Uint8Array {
  const index = V2021_2_18.indexOf(at);
  const offset = layout(V2021_2_18.slice(0, index)).bytes.length;
  const bytes = layout(V2021_2_18).bytes;
  new DataView(bytes.buffer).setInt32(offset, value, true);
  return bytes;
}

test("a negative count throws CorruptError", () => {
  for (const at of ["keywordLists", "tags", "passes", "sheetInts"]) {
    const reader = synthetic(FROM, patched(at, -1), UNITY_6);
    assert.throws(() => readMaterial(reader), /count -1 at offset \d+ is negative/, at);
  }
});

test("a string or count past the object's end throws CorruptError, not an empty string", () => {
  // m_ShaderKeywords (5.0 to 2021.2.17) is a string: its length runs past the end.
  const index = V2021_1.indexOf("keywordString");
  const offset = layout(V2021_1.slice(0, index)).bytes.length;
  const bytes = layout(V2021_1).bytes;
  new DataView(bytes.buffer).setInt32(offset, bytes.length, true);
  const reader = synthetic(FROM, bytes, [2020, 3, 30, 1]);
  assert.throws(
    () => readMaterial(reader),
    /Material -?\d+ m_ShaderKeywords byte count \d+ at offset \d+ exceeds the \d+ bytes left/,
  );
  const past = synthetic(FROM, patched("sheetInts", 1_000_000), UNITY_6);
  assert.throws(() => readMaterial(past), /m_TexEnvs count 1000000 at offset \d+ exceeds/);
});
