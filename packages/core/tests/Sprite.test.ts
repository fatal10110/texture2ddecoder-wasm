// Sprite and SpriteAtlas (#34): the hardcoded readers, checked against the
// oracle's typetree dumps (R12) and readTypeTree() on the fixture objects, and
// against hand-built layouts at every version gate of Unity's type trees.

import assert from "node:assert/strict";
import { test } from "node:test";

import { golden, type GoldenNode, type GoldenSerialized } from "../../../fixtures/helpers.js";
import { readSprite, SpritePackingRotation, type Sprite } from "../src/classes/Sprite.js";
import { readSpriteAtlas, type SpriteAtlas } from "../src/classes/SpriteAtlas.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ClassID } from "../src/serialized/ClassID.js";
import { ObjectReader } from "../src/serialized/ObjectReader.js";
import type { SerializedFile, UnityVersion } from "../src/serialized/SerializedFile.js";
import { fixturesWith, objectBytes, objectsOf, withTail } from "./class-readers.js";

const FIXTURES = fixturesWith(ClassID.Sprite);
const READERS = [
  { classId: ClassID.Sprite, read: readSprite },
  { classId: ClassID.SpriteAtlas, read: readSpriteAtlas },
] as const;

// --- plan §5 normalization, driven by the golden's own type tree ----------------------

interface Node {
  type: string;
  name: string;
  children: Node[];
}

/** The golden's pre-order node list of a class, as a tree. */
function tree(sf: GoldenSerialized, classId: number): Node {
  const nodes = sf.types.find((t) => t.classId === classId)!.nodes!;
  const stack: Node[] = [];
  let root: Node | undefined;
  for (const [level, type, name] of nodes as GoldenNode[]) {
    const node: Node = { type, name, children: [] };
    stack.length = level;
    if (level === 0) root = node;
    else stack[level - 1]!.children.push(node);
    stack.push(node);
  }
  return root!;
}

const f32Hex = (value: number): string => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  return Buffer.from(view.buffer).toString("hex");
};

/** A reader's value in the golden's form: floats by bits, int64 as text, bytes as hex. */
function normalize(node: Node, value: unknown): unknown {
  if (node.type === "float") return `f32:${f32Hex(value as number)}`;
  if (typeof value === "bigint") return String(value);
  if (value instanceof Uint8Array) return `hex:${Buffer.from(value).toString("hex")}`;
  if (typeof value !== "object" || value === null) return value;
  const array = node.children[0]?.type === "Array" ? node.children[0] : undefined;
  if (array) return (value as unknown[]).map((v) => normalize(array.children[1]!, v));
  if (node.type === "pair") {
    const [a, b] = value as [unknown, unknown];
    return [normalize(node.children[0]!, a), normalize(node.children[1]!, b)];
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const child = node.children.find((c) => c.name === key);
    assert.ok(child, `${key} is not a field of ${node.type}`);
    out[key] = normalize(child, v);
  }
  return out;
}

// --- every Sprite and SpriteAtlas of the fixtures -------------------------------------

for (const name of FIXTURES) {
  for (const { classId, read } of READERS) {
    test(`${name}: class ${classId} equals the golden dump and readTypeTree()`, () => {
      const sf = Object.values(golden(name).serialized!)[0]!;
      const objects = objectsOf(name, classId);
      assert.ok(objects.length > 0);
      for (const { env, reader, dump } of objects) {
        assert.ok(dump, `no golden dump for ${reader.pathId}`);
        const value = read(reader);
        assert.equal(reader.position, reader.byteSize, "byteSize not consumed exactly");
        // Every field, in Unity's order, with the oracle's values.
        const normalized = normalize(tree(sf, classId), value);
        assert.equal(JSON.stringify(normalized), JSON.stringify(dump));
        // The same object through its type tree, keys in the same order.
        const typed = reader.readTypeTree();
        assert.equal(JSON.stringify(normalize(tree(sf, classId), typed)), JSON.stringify(dump));
        assert.deepEqual(value, typed);
        // obj.read() goes through the registry to this reader.
        assert.deepEqual(env.objects.find((o) => o.pathId === reader.pathId)!.read(), value);
      }
    });
  }
}

test("the fixtures cover formats 21 and 22, packing flips, tight meshes, trimmed sprites", () => {
  const seen = new Set<string>();
  for (const name of FIXTURES) {
    for (const { reader, formatVersion } of objectsOf(name, ClassID.SpriteAtlas)) {
      for (const [, data] of readSpriteAtlas(reader).m_RenderDataMap) {
        seen.add(`format ${formatVersion}`);
        seen.add(`rotation ${(data.settingsRaw >> 2) & 0xf}`);
        seen.add(`mode ${(data.settingsRaw >> 1) & 1}`);
        if (data.textureRectOffset.x !== 0) seen.add("trimmed");
      }
    }
    for (const { reader } of objectsOf(name, ClassID.Sprite)) {
      const sprite = readSprite(reader);
      if (sprite.m_RD.m_VertexData!.m_VertexCount > 4) seen.add("tight mesh");
      if (sprite.m_SpriteAtlas!.m_PathID === 0n) seen.add("not packed");
      if (sprite.m_Border!.x !== 0) seen.add("border");
      if (sprite.m_PhysicsShape!.length > 0) seen.add("physics shape");
    }
  }
  for (const want of ["format 21", "format 22", "rotation 0", "rotation 1", "rotation 2"]) {
    assert.ok(seen.has(want), want);
  }
  for (const want of ["rotation 3", "mode 0", "mode 1", "trimmed", "tight mesh", "not packed"]) {
    assert.ok(seen.has(want), want);
  }
  assert.ok(seen.has("border") && seen.has("physics shape"));
  // No editor packer here writes Rotate90 (see the texture package's tests).
  assert.equal(seen.has(`rotation ${SpritePackingRotation.Rotate90}`), false);
});

// --- hand-built layouts at every version gate (TPK) -------------------------------------

/**
 * Little-endian bytes for a layout, and the object the reader must return for
 * it. A field is `"<kind> <path>"`, `"align"`, or `["n", path, count]`: an
 * `Int32` count that starts an array at `path`. A path is dotted, a number
 * picking an array element (`m_RD.m_SubMeshes.0.firstByte`). Kinds: `i32`,
 * `u32`, `u16`, `u8`, `bool`, `f32`, `i64`, `str` (aligned string), `bytes`
 * (a count and 3 bytes), `pptr` (`Int32` + `Int64`), `pptr32` (`Int32` +
 * `Int32`, format < 14), `guid` (4 `UInt32`), `v2`, `v3`, `v3w` (a Vector3
 * stored as four floats, `w` dropped), `v4`, `rect`, `m44`. Each value differs
 * from its neighbours.
 */
type Field = string | ["n", string, number];

function build(fields: Field[]): { bytes: Uint8Array; expected: Record<string, unknown> } {
  const out: number[] = [];
  const view = new DataView(new ArrayBuffer(8));
  const push = (size: number) => out.push(...new Uint8Array(view.buffer, 0, size));
  const expected: Record<string, unknown> = {};
  let n = 0;
  const f32 = () => {
    const value = 0.5 + n++;
    view.setFloat32(0, value, true);
    push(4);
    return value;
  };
  const u32 = () => {
    const value = 0x8000_0000 + n++;
    view.setUint32(0, value, true);
    push(4);
    return value;
  };
  const floats = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, f32()]));
  for (const field of fields) {
    if (field === "align") {
      while (out.length % 4) out.push(0);
      continue;
    }
    if (Array.isArray(field)) {
      view.setInt32(0, field[2], true);
      push(4);
      set(expected, field[1], []);
      continue;
    }
    const [kind, path] = field.split(" ") as [string, string];
    let value: unknown;
    if (kind === "i32") {
      value = -1000 - n++;
      view.setInt32(0, value as number, true);
      push(4);
    } else if (kind === "u32") value = u32();
    else if (kind === "u16") {
      value = 1000 + n++;
      view.setUint16(0, value as number, true);
      push(2);
    } else if (kind === "u8") {
      value = (200 + n++) & 0xff;
      out.push(value as number);
    } else if (kind === "bool") {
      value = n++ % 2 === 0;
      out.push(value ? 1 : 0);
    } else if (kind === "f32") value = f32();
    else if (kind === "i64") {
      value = -(2n ** 60n) - BigInt(n++);
      view.setBigInt64(0, value as bigint, true);
      push(8);
    } else if (kind === "str" || kind === "bytes") {
      // Odd lengths, so a missing align shows.
      const text = `${path}#${n++}`;
      const data = kind === "str" ? new TextEncoder().encode(text) : Uint8Array.of(n, 0xff, n + 2);
      view.setInt32(0, data.length, true);
      push(4);
      out.push(...data);
      if (kind === "str") while (out.length % 4) out.push(0);
      value = kind === "str" ? text : data;
    } else if (kind === "pptr" || kind === "pptr32") {
      const fileId = n++;
      view.setInt32(0, fileId, true);
      push(4);
      const pathId = -1_000_000 - n++;
      if (kind === "pptr") view.setBigInt64(0, BigInt(pathId), true);
      else view.setInt32(0, pathId, true);
      push(kind === "pptr" ? 8 : 4);
      value = { m_FileID: fileId, m_PathID: BigInt(pathId) };
    } else if (kind === "guid") {
      value = Object.fromEntries([0, 1, 2, 3].map((i) => [`data[${i}]`, u32()]));
    } else if (kind === "v2") value = floats("x", "y");
    else if (kind === "v3") value = floats("x", "y", "z");
    else if (kind === "v3w") {
      value = floats("x", "y", "z");
      f32(); // w, read and dropped
    } else if (kind === "v4") value = floats("x", "y", "z", "w");
    else if (kind === "rect") value = floats("x", "y", "width", "height");
    else if (kind === "m44") {
      value = floats(...[0, 1, 2, 3].flatMap((r) => [0, 1, 2, 3].map((c) => `e${r}${c}`)));
    } else assert.fail(`unknown kind ${kind}`);
    set(expected, path, value);
  }
  return { bytes: Uint8Array.from(out), expected };
}

/** Set a dotted path, creating objects, and arrays where the next part is a number. */
function set(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let at: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    at[part] ??= /^\d+$/.test(parts[i + 1]!) ? [] : {};
    at = at[part] as Record<string, unknown>;
  }
  at[parts.at(-1)!] = value;
}

/** A Sprite's file from the fixture, for its header fields. */
const fromSprite = objectBytes("editor/6000.3.25f1/sprite/sprites", ClassID.Sprite);
const fromAtlas = objectBytes("editor/6000.3.25f1/sprite/sprites", ClassID.SpriteAtlas);

/** A reader over `bytes` as an object of `from` in a file of the given Unity version. */
function synthetic(
  from: typeof fromSprite,
  bytes: Uint8Array,
  unity: UnityVersion,
  buildType = "f",
  options: { text?: string; platform?: BuildTarget; format?: number } = {},
): ObjectReader {
  const file: SerializedFile = {
    ...from.sf,
    // 4.x files are format 9, whose path ids are 32-bit.
    header: { ...from.sf.header, version: options.format ?? (unity[0] < 5 ? 9 : 22) },
    unityVersion: options.text ?? `${unity.slice(0, 3).join(".")}${buildType}${unity[3]}`,
    version: unity,
    buildType,
    targetPlatform: options.platform ?? BuildTarget.StandaloneWindows64,
  };
  return new ObjectReader(bytes, file, { ...from.info, byteStart: 0, byteSize: bytes.length });
}

// Sprite: segments named after what Unity's player type trees (TPK) add or drop.
const HEAD: Field[] = ["str m_Name", "rect m_Rect", "v2 m_Offset"];
const BORDER: Field[] = ["v4 m_Border"];
const PIVOT: Field[] = ["v2 m_Pivot"];
const POLYGON: Field[] = ["bool m_IsPolygon", "align"];
const ATLAS: Field[] = ["guid m_RenderDataKey.0", "i64 m_RenderDataKey.1", ["n", "m_AtlasTags", 1]];
ATLAS.push("str m_AtlasTags.0", "pptr m_SpriteAtlas");
const OLD_MESH = (pos: string, uv: boolean): Field[] => [
  ["n", "m_RD.vertices", 1],
  `${pos} m_RD.vertices.0.pos`,
  ...(uv ? ["v2 m_RD.vertices.0.uv"] : []),
  ["n", "m_RD.indices", 3],
  "u16 m_RD.indices.0",
  "u16 m_RD.indices.1",
  "u16 m_RD.indices.2",
  "align",
];
const SUBMESH = (baseVertex: boolean): Field[] => [
  ["n", "m_RD.m_SubMeshes", 1],
  "u32 m_RD.m_SubMeshes.0.firstByte",
  "u32 m_RD.m_SubMeshes.0.indexCount",
  "i32 m_RD.m_SubMeshes.0.topology",
  ...(baseVertex ? ["u32 m_RD.m_SubMeshes.0.baseVertex"] : []),
  "u32 m_RD.m_SubMeshes.0.firstVertex",
  "u32 m_RD.m_SubMeshes.0.vertexCount",
  "v3 m_RD.m_SubMeshes.0.localAABB.m_Center",
  "v3 m_RD.m_SubMeshes.0.localAABB.m_Extent",
  "bytes m_RD.m_IndexBuffer",
  "align",
];
const VERTEX_DATA = (currentChannels: boolean): Field[] => [
  ...(currentChannels ? ["i32 m_RD.m_VertexData.m_CurrentChannels"] : []),
  "u32 m_RD.m_VertexData.m_VertexCount",
  ["n", "m_RD.m_VertexData.m_Channels", 1],
  "u8 m_RD.m_VertexData.m_Channels.0.stream",
  "u8 m_RD.m_VertexData.m_Channels.0.offset",
  "u8 m_RD.m_VertexData.m_Channels.0.format",
  "u8 m_RD.m_VertexData.m_Channels.0.dimension",
  "bytes m_RD.m_VertexData.m_DataSize",
  "align",
];
const SECONDARY: Field[] = [["n", "m_RD.secondaryTextures", 1]];
SECONDARY.push("pptr m_RD.secondaryTextures.0.texture", "str m_RD.secondaryTextures.0.name");
const BINDPOSE: Field[] = [["n", "m_RD.m_Bindpose", 1], "m44 m_RD.m_Bindpose.0"];
const SOURCE_SKIN: Field[] = [
  ["n", "m_RD.m_SourceSkin", 1],
  ...[0, 1, 2, 3].map((i) => `f32 m_RD.m_SourceSkin.0.weight[${i}]`),
  ...[0, 1, 2, 3].map((i) => `i32 m_RD.m_SourceSkin.0.boneIndex[${i}]`),
];
const BLEND_SHAPES: Field[] = [
  ["n", "m_RD.m_BlendShapes.vertices", 1],
  "v3 m_RD.m_BlendShapes.vertices.0.vertex",
  "v3 m_RD.m_BlendShapes.vertices.0.normal",
  "v3 m_RD.m_BlendShapes.vertices.0.tangent",
  "u32 m_RD.m_BlendShapes.vertices.0.index",
  ["n", "m_RD.m_BlendShapes.shapes", 1],
  "u32 m_RD.m_BlendShapes.shapes.0.firstVertex",
  "u32 m_RD.m_BlendShapes.shapes.0.vertexCount",
  "bool m_RD.m_BlendShapes.shapes.0.hasNormals",
  "bool m_RD.m_BlendShapes.shapes.0.hasTangents",
  "align",
  ["n", "m_RD.m_BlendShapes.channels", 1],
  "str m_RD.m_BlendShapes.channels.0.name",
  "u32 m_RD.m_BlendShapes.channels.0.nameHash",
  "i32 m_RD.m_BlendShapes.channels.0.frameIndex",
  "i32 m_RD.m_BlendShapes.channels.0.frameCount",
  ["n", "m_RD.m_BlendShapes.fullWeights", 1],
  "f32 m_RD.m_BlendShapes.fullWeights.0",
];
const RECTS: Field[] = ["rect m_RD.textureRect", "v2 m_RD.textureRectOffset"];
const PHYSICS: Field[] = [["n", "m_PhysicsShape", 1], ["n", "m_PhysicsShape.0", 2]];
PHYSICS.push("v2 m_PhysicsShape.0.0", "v2 m_PhysicsShape.0.1");
const BONES = (v2021: boolean): Field[] => [
  ["n", "m_Bones", 1],
  "str m_Bones.0.name",
  ...(v2021 ? ["str m_Bones.0.guid"] : []),
  "v3 m_Bones.0.position",
  "v4 m_Bones.0.rotation",
  "f32 m_Bones.0.length",
  "i32 m_Bones.0.parentId",
  ...(v2021 ? ["u32 m_Bones.0.color.rgba"] : []),
];
const SCRIPTABLE: Field[] = [["n", "m_ScriptableObjects", 1], "pptr m_ScriptableObjects.0"];

/** Unity's Sprite layout of a version, by the pieces its type tree has. */
function sprite(v: {
  pptr?: string;
  border?: boolean;
  pivot?: boolean;
  polygon?: boolean;
  atlas?: boolean;
  alpha?: boolean;
  secondary?: boolean;
  mesh: Field[];
  bindpose?: Field[];
  blendShapes?: boolean;
  atlasRectOffset?: boolean;
  uvTransform?: boolean;
  tail?: Field[];
}): Field[] {
  const pptr = v.pptr ?? "pptr";
  return [
    ...HEAD,
    ...(v.border ? BORDER : []),
    "f32 m_PixelsToUnits",
    ...(v.pivot ? PIVOT : []),
    "u32 m_Extrude",
    ...(v.polygon ? POLYGON : ["align"]),
    ...(v.atlas ? ATLAS : []),
    `${pptr} m_RD.texture`,
    ...(v.alpha ? [`${pptr} m_RD.alphaTexture`] : []),
    ...(v.secondary ? SECONDARY : []),
    ...v.mesh,
    ...(v.bindpose ?? []),
    ...(v.blendShapes ? BLEND_SHAPES : []),
    ...RECTS,
    ...(v.atlasRectOffset ? ["v2 m_RD.atlasRectOffset"] : []),
    "u32 m_RD.settingsRaw",
    ...(v.uvTransform ? ["v4 m_RD.uvTransform"] : []),
    ...(v.atlas ? ["f32 m_RD.downscaleMultiplier"] : []),
    "align",
    ...(v.tail ?? []),
  ];
}

const V5_6_MESH = [...SUBMESH(false), ...VERTEX_DATA(true)];
const V4_5 = { pptr: "pptr32", border: true, uvTransform: true };
const V5_2 = { border: true, alpha: true, uvTransform: true };
const V5_3 = { ...V5_2, polygon: true };
const V5_4_1P3 = { ...V5_3, pivot: true };
const OLD = OLD_MESH("v3w", false);
const V5_4_MESH = OLD_MESH("v3", false);
const V2017 = { border: true, pivot: true, polygon: true, atlas: true, alpha: true };
const V2017_REST = { atlasRectOffset: true, uvTransform: true, tail: PHYSICS };
const V2018 = { ...V2017, ...V2017_REST, mesh: [...SUBMESH(true), ...VERTEX_DATA(false)] };
const V2019 = { ...V2018, secondary: true, bindpose: BINDPOSE };

/**
 * Each Sprite layout at the version it appears, and, around each gate, the
 * last release still on the one before. `buildType` "p" marks a patch release.
 */
const SPRITE_LAYOUTS: { unity: UnityVersion; buildType?: string; fields: Field[] }[] = [
  // 4.3: a vertex carries a uv; a Vector3 is stored as four floats before 5.4.
  { unity: [4, 3, 0, 1], fields: sprite({ pptr: "pptr32", mesh: OLD_MESH("v3w", true) }) },
  { unity: [4, 5, 0, 1], fields: sprite({ ...V4_5, mesh: OLD }) },
  { unity: [5, 0, 0, 1], fields: sprite({ ...V4_5, pptr: "pptr", mesh: OLD }) },
  { unity: [5, 2, 0, 1], fields: sprite({ ...V5_2, mesh: OLD }) },
  { unity: [5, 3, 0, 1], fields: sprite({ ...V5_3, mesh: OLD }) },
  // 5.4: readVector3 reads three floats (upstream Sprite.cs:70).
  { unity: [5, 4, 0, 1], fields: sprite({ ...V5_3, mesh: V5_4_MESH }) },
  // The 5.4.1p3 gate of m_Pivot (upstream Sprite.cs:222).
  { unity: [5, 4, 1, 1], fields: sprite({ ...V5_3, mesh: V5_4_MESH }) },
  { unity: [5, 4, 1, 2], buildType: "p", fields: sprite({ ...V5_3, mesh: V5_4_MESH }) },
  { unity: [5, 4, 1, 3], buildType: "p", fields: sprite({ ...V5_4_1P3, mesh: V5_4_MESH }) },
  { unity: [5, 4, 2, 1], fields: sprite({ ...V5_4_1P3, mesh: V5_4_MESH }) },
  // atlasRectOffset: 5.4.6+, 5.5.3+ and 5.6+ (TPK; upstream: 5.6+). 5.4.5 and
  // 5.5.2 are the last releases without it.
  { unity: [5, 4, 5, 1], fields: sprite({ ...V5_4_1P3, mesh: V5_4_MESH }) },
  {
    unity: [5, 4, 6, 1],
    fields: sprite({ ...V5_4_1P3, mesh: V5_4_MESH, atlasRectOffset: true }),
  },
  { unity: [5, 5, 0, 1], fields: sprite({ ...V5_4_1P3, mesh: V5_4_MESH }) },
  { unity: [5, 5, 2, 1], fields: sprite({ ...V5_4_1P3, mesh: V5_4_MESH }) },
  {
    unity: [5, 5, 3, 1],
    fields: sprite({ ...V5_4_1P3, mesh: V5_4_MESH, atlasRectOffset: true }),
  },
  {
    unity: [5, 6, 0, 1],
    fields: sprite({ ...V5_4_1P3, mesh: V5_6_MESH, atlasRectOffset: true }),
  },
  { unity: [2017, 1, 0, 1], fields: sprite({ ...V2017, ...V2017_REST, mesh: V5_6_MESH }) },
  {
    unity: [2017, 3, 0, 1],
    fields: sprite({ ...V2017, ...V2017_REST, mesh: [...SUBMESH(true), ...VERTEX_DATA(true)] }),
  },
  {
    unity: [2018, 1, 0, 1],
    fields: sprite({
      ...V2018,
      bindpose: [...BINDPOSE, ...SOURCE_SKIN],
      tail: [...PHYSICS, ...BONES(false)],
    }),
  },
  {
    unity: [2018, 2, 0, 1],
    fields: sprite({ ...V2018, bindpose: BINDPOSE, tail: [...PHYSICS, ...BONES(false)] }),
  },
  { unity: [2019, 1, 0, 1], fields: sprite({ ...V2019, tail: [...PHYSICS, ...BONES(false)] }) },
  { unity: [2021, 1, 0, 1], fields: sprite({ ...V2019, tail: [...PHYSICS, ...BONES(true)] }) },
  {
    unity: [2023, 1, 0, 1],
    fields: sprite({ ...V2019, tail: [...PHYSICS, ...BONES(true), ...SCRIPTABLE] }),
  },
  {
    unity: [6000, 5, 0, 1],
    fields: sprite({
      ...V2019,
      polygon: false,
      blendShapes: true,
      tail: [...PHYSICS, ...BONES(true), ...SCRIPTABLE],
    }),
  },
];

for (const { unity, buildType = "f", fields } of SPRITE_LAYOUTS) {
  const version = `${unity.slice(0, 3).join(".")}${buildType}${unity[3]}`;
  test(`Sprite, Unity ${version}: the player layout of Unity's type tree`, () => {
    const { bytes, expected } = build(fields);
    const reader = synthetic(fromSprite, bytes, unity, buildType);
    const sprite = readSprite(reader);
    assert.equal(JSON.stringify(Object.keys(sprite)), JSON.stringify(Object.keys(expected)));
    assert.deepEqual(sprite, expected);
    assert.equal(reader.remaining, 0);
  });
}

test("SpriteVertex.pos is a Vector3 as readVector3 reads it: four floats before 5.4", () => {
  const layout = (pos: string) => sprite({ ...V5_3, mesh: OLD_MESH(pos, false) });
  const at = (unity: UnityVersion, pos: string) => {
    const { bytes, expected } = build(layout(pos));
    const vertex = readSprite(synthetic(fromSprite, bytes, unity)).m_RD.vertices![0]!;
    assert.deepEqual(vertex, (expected.m_RD as Sprite["m_RD"]).vertices![0]);
    return bytes.length;
  };
  // The same fields, one float longer per vertex in 5.3.
  assert.equal(at([5, 3, 8, 1], "v3w"), at([5, 4, 0, 1], "v3") + 4);
  // A 5.4 reader over 5.3 bytes misreads them, and the end-of-object check refuses it.
  const { bytes } = build(layout("v3w"));
  assert.throws(() => readSprite(synthetic(fromSprite, bytes, [5, 4, 0, 1])), CorruptError);
});

test("m_Pivot from 5.4.1p3 on: buildType 'p' and the patch number, not 5.4.1f3", () => {
  const { bytes, expected } = build(sprite({ ...V5_4_1P3, mesh: OLD_MESH("v3", false) }));
  assert.deepEqual(readSprite(synthetic(fromSprite, bytes, [5, 4, 1, 3], "p")), expected);
  // 5.4.1f3 has the same numbers as 5.4.1p3 but is no patch release: no pivot,
  // so the rest is misread, and the end-of-object check refuses it.
  assert.throws(() => readSprite(synthetic(fromSprite, bytes, [5, 4, 1, 3], "f")), CorruptError);
  assert.throws(() => readSprite(synthetic(fromSprite, bytes, [5, 4, 1, 2], "p")), CorruptError);
});

// SpriteAtlas.
const ATLAS_DATA = (atlasRectOffset: boolean, secondary: boolean): Field[] => {
  const at = "m_RenderDataMap.0.1";
  return [
    ["n", "m_RenderDataMap", 1],
    "guid m_RenderDataMap.0.0.0",
    "i64 m_RenderDataMap.0.0.1",
    `pptr ${at}.texture`,
    `pptr ${at}.alphaTexture`,
    `rect ${at}.textureRect`,
    `v2 ${at}.textureRectOffset`,
    ...(atlasRectOffset ? [`v2 ${at}.atlasRectOffset`] : []),
    `v4 ${at}.uvTransform`,
    `f32 ${at}.downscaleMultiplier`,
    `u32 ${at}.settingsRaw`,
    ...(secondary
      ? ([
          ["n", `${at}.secondaryTextures`, 1],
          `pptr ${at}.secondaryTextures.0.texture`,
          `str ${at}.secondaryTextures.0.name`,
          "align",
        ] as Field[])
      : []),
  ];
};
const atlas = (atlasRectOffset: boolean, secondary: boolean, guid = false): Field[] => [
  "str m_Name",
  ["n", "m_PackedSprites", 2],
  "pptr m_PackedSprites.0",
  "pptr m_PackedSprites.1",
  ["n", "m_PackedSpriteNamesToIndex", 1],
  "str m_PackedSpriteNamesToIndex.0",
  ...ATLAS_DATA(atlasRectOffset, secondary),
  "str m_Tag",
  "bool m_IsVariant",
  "align",
  ...(guid ? ["guid m_Guid"] : []),
];

const ATLAS_LAYOUTS: { unity: UnityVersion; buildType?: string; fields: Field[] }[] = [
  { unity: [2017, 1, 0, 1], fields: atlas(false, false) },
  { unity: [2017, 1, 1, 1], fields: atlas(false, false) },
  // 2017.1.1p1 added atlasRectOffset (TPK); upstream reads it from 2017.2.
  { unity: [2017, 1, 1, 1], buildType: "p", fields: atlas(true, false) },
  { unity: [2017, 1, 2, 1], fields: atlas(true, false) },
  { unity: [2017, 2, 0, 1], fields: atlas(true, false) },
  { unity: [2020, 1, 0, 1], fields: atlas(true, false) },
  { unity: [2020, 2, 0, 1], fields: atlas(true, true) },
  { unity: [6000, 4, 0, 1], fields: atlas(true, true) },
  { unity: [6000, 5, 0, 1], fields: atlas(true, true, true) },
];

for (const { unity, buildType = "f", fields } of ATLAS_LAYOUTS) {
  const version = `${unity.slice(0, 3).join(".")}${buildType}${unity[3]}`;
  test(`SpriteAtlas, Unity ${version}: the player layout of Unity's type tree`, () => {
    const { bytes, expected } = build(fields);
    const reader = synthetic(fromAtlas, bytes, unity, buildType);
    const value = readSpriteAtlas(reader);
    assert.equal(JSON.stringify(Object.keys(value)), JSON.stringify(Object.keys(expected)));
    assert.deepEqual(value, expected);
    assert.equal(reader.remaining, 0);
  });
}

// --- refusals ------------------------------------------------------------------------

/**
 * Per the class-reader rule on #36: an all-zero version is refused with the
 * file's own version string, from a stripped file (`"0.0.0"`) or a loose file
 * below format 7 (`"2.5.0f5"`, #98). The layouts differ inside the object, so
 * the bytes cannot decide one.
 */
for (const text of ["0.0.0", "2.5.0f5"]) {
  test(`Unity "${text}" at 0.0.0.0: UnsupportedError("Unity version")`, () => {
    for (const [from, read] of [
      [fromSprite, readSprite],
      [fromAtlas, readSpriteAtlas],
    ] as const) {
      const reader = synthetic(from, from.bytes, [0, 0, 0, 0], "", { text });
      assert.throws(
        () => read(reader),
        (err: unknown) =>
          err instanceof UnsupportedError &&
          err.kind === "Unity version" &&
          err.found === text &&
          err.message.includes(`object ${reader.pathId}`),
      );
    }
  });
}

test("a version before the class is refused: Sprite before 4.3, SpriteAtlas before 2017.1", () => {
  const refused = (err: unknown) =>
    err instanceof UnsupportedError && err.kind === "Unity version" && /has no/.test(err.message);
  assert.throws(() => readSprite(synthetic(fromSprite, fromSprite.bytes, [4, 2, 2, 1])), refused);
  const atlas = synthetic(fromAtlas, fromAtlas.bytes, [5, 6, 7, 1]);
  assert.throws(() => readSpriteAtlas(atlas), refused);
});

test("a SpriteAtlas of 6000.6, known only from pre-release type trees, is refused", () => {
  assert.throws(
    () => readSpriteAtlas(synthetic(fromAtlas, fromAtlas.bytes, [6000, 6, 0, 1])),
    (err: unknown) => err instanceof UnsupportedError && /6000\.6 is not ported/.test(err.message),
  );
});

test("an editor file (NoTarget) is refused: it holds editor-only fields", () => {
  for (const [from, read] of [
    [fromSprite, readSprite],
    [fromAtlas, readSpriteAtlas],
  ] as const) {
    const reader = synthetic(from, from.bytes, [6000, 3, 25, 1], "f", {
      platform: BuildTarget.NoTarget,
    });
    assert.throws(
      () => read(reader),
      (err: unknown) =>
        err instanceof UnsupportedError && err.kind === "build target" && err.found === "NoTarget",
    );
  }
});

// --- truncated, oversized and garbled objects ---------------------------------------------

const EDITORS: { name: string; unity: UnityVersion }[] = [
  { name: "editor/2019.4.41f2/sprite/sprites", unity: [2019, 4, 41, 2] },
  { name: "editor/6000.3.25f1/sprite/sprites", unity: [6000, 3, 25, 1] },
];

for (const { name, unity } of EDITORS) {
  test(`${name}: every cut through a Sprite or SpriteAtlas throws CorruptError`, () => {
    for (const [classId, read] of [
      [ClassID.Sprite, readSprite],
      [ClassID.SpriteAtlas, readSpriteAtlas],
    ] as const) {
      const from = objectBytes(name, classId);
      read(synthetic(from, from.bytes, unity));
      // The last 3 bytes may be only padding; every shorter cut loses data.
      for (let cut = 0; cut <= from.bytes.length - 4; cut++) {
        const reader = synthetic(from, from.bytes.subarray(0, cut), unity);
        assert.throws(() => read(reader), CorruptError, `class ${classId} cut at ${cut}`);
      }
    }
  });
}

test("bytes left after the last field throw CorruptError", () => {
  for (const [from, read, owner] of [
    [fromSprite, readSprite, "Sprite"],
    [fromAtlas, readSpriteAtlas, "SpriteAtlas"],
  ] as const) {
    const reader = synthetic(from, withTail(from.bytes, 0, 0, 0, 0), [6000, 3, 25, 1]);
    assert.throws(
      () => read(reader),
      (err: unknown) =>
        err instanceof CorruptError &&
        err.message.includes(`${owner} ${reader.pathId} ends at ${from.bytes.length} of its`),
    );
  }
});

test("a negative or oversized count throws CorruptError naming the field", () => {
  // m_AtlasTags' count follows m_RenderDataKey in every Sprite from 2017.1.
  const layout = sprite({ ...V2019, tail: [...PHYSICS, ...BONES(false)] });
  const { bytes } = build(layout);
  const head = build(layout.slice(0, layout.indexOf("i64 m_RenderDataKey.1") + 1)).bytes.length;
  for (const count of [-1, 0x7fff_ffff]) {
    const copy = bytes.slice();
    new DataView(copy.buffer).setInt32(head, count, true);
    assert.throws(
      () => readSprite(synthetic(fromSprite, copy, [2019, 1, 0, 1])),
      (err: unknown) => err instanceof CorruptError && /m_AtlasTags count/.test(err.message),
    );
  }
});
