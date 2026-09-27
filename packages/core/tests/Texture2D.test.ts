// Texture2D, Texture and StreamingInfo (#29): the hardcoded reader, checked
// against the oracle's typetree dumps and texture goldens (R12), and against
// readTypeTree() on the same objects.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fixtureNames,
  golden,
  loadFixture,
  sha256,
  type GoldenSerialized,
} from "../../../fixtures/helpers.js";
import { readTexture } from "../src/classes/Texture.js";
import { readTexture2D, type Texture2D } from "../src/classes/Texture2D.js";
import { TextureFormat } from "../src/classes/TextureFormat.js";
import { load, type Env } from "../src/env.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ClassID } from "../src/serialized/ClassID.js";
import { ObjectReader } from "../src/serialized/ObjectReader.js";
import {
  readSerializedFile,
  type SerializedFile,
  type UnityVersion,
} from "../src/serialized/SerializedFile.js";

/** Fixtures whose golden holds a Texture2D typetree dump. */
const TYPED = fixtureNames().filter((name) =>
  Object.values(golden(name).serialized ?? {}).some((sf) => Object.keys(sf.textures ?? {}).length),
);
/** Fixtures built without type trees that hold a Texture2D. */
const STRIPPED = fixtureNames().filter(
  (name) =>
    name.includes("/lz4-notypetree/") &&
    Object.values(golden(name).objects).some((objs) => objs.some((o) => o.classId === 28)),
);

interface Loaded {
  env: Env;
  /** Texture2D readers by SerializedFile node path, then path id. */
  textures: Map<string, Map<string, ObjectReader>>;
}

/**
 * Load a fixture and take its Texture2D readers from `env.objects`, so that
 * `env.readResource` accepts them. Every texture fixture holds one
 * SerializedFile, so each object of the env is one of its objects.
 */
function loadTextures(name: string): Loaded {
  const env = load([{ name, data: loadFixture(name) }]);
  const [path, ...more] = Object.keys(golden(name).serialized ?? {});
  assert.ok(path && !more.length, `${name} does not hold one SerializedFile`);
  const readers = env.objects.filter((r) => r.type === ClassID.Texture2D);
  const textures = new Map([[path, new Map(readers.map((r) => [String(r.pathId), r]))]]);
  return { env, textures };
}

// --- plan §5 normalization, driven by the golden's type tree, not our output ---

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

function f32(value: number): string {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  return hex(new Uint8Array(view.buffer));
}

/**
 * The hardcoded result in the golden's form: bytes as hex, `m_MipBias` by bit
 * pattern, and `m_StreamData.offset` as the golden's type tree types it (a
 * decimal string for `UInt64`, a number for `unsigned int`).
 */
function normalize(texture: Texture2D, sf: GoldenSerialized): unknown {
  const nodes = sf.types.find((t) => t.classId === ClassID.Texture2D)!.nodes!;
  const offsetType = nodes.find(([level, , name]) => level === 2 && name === "offset")?.[1];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(texture)) {
    if (value instanceof Uint8Array) out[key] = `hex:${hex(value)}`;
    else if (key === "m_TextureSettings") {
      out[key] = { ...value, m_MipBias: `f32:${f32(value.m_MipBias)}` };
    } else if (key === "m_StreamData") {
      const { offset } = value;
      out[key] = { ...value, offset: offsetType === "UInt64" ? String(offset) : offset };
    } else out[key] = value;
  }
  return out;
}

/**
 * The image bytes: inline, or `m_StreamData` handed as it is to the env's
 * resource resolver (#30).
 */
function imageOf(texture: Texture2D, env: Env, reader: ObjectReader): Uint8Array {
  const stream = texture.m_StreamData;
  if (!stream?.path) return texture["image data"];
  assert.equal(texture["image data"].length, 0, "both inline and streamed data");
  return env.readResource(stream, reader);
}

/** Check one reader's result against the golden texture entry (#31). */
function checkTextureGolden(
  texture: Texture2D,
  env: Env,
  reader: ObjectReader,
  want: NonNullable<GoldenSerialized["textures"]>[string],
): void {
  assert.equal(texture.m_Name, want.name);
  assert.equal(texture.m_Width, want.width);
  assert.equal(texture.m_Height, want.height);
  assert.equal(texture.m_TextureFormat, want.format);
  const image = imageOf(texture, env, reader);
  assert.equal(image.length, want.imageSize);
  assert.equal(sha256(image), want.imageSha256);
}

// --- editor fixtures with type trees ------------------------------------------------

for (const name of TYPED) {
  test(`${name}: readTexture2D equals the golden dump and readTypeTree()`, () => {
    const { env, textures } = loadTextures(name);
    let checked = 0;
    for (const [path, readers] of textures) {
      const sf = golden(name).serialized![path]!;
      assert.equal(readers.size, Object.keys(sf.textures ?? {}).length);
      for (const [pathId, want] of Object.entries(sf.textures ?? {})) {
        const reader = readers.get(pathId);
        assert.ok(reader, `${path} has no Texture2D ${pathId}`);
        const dump = sf.typetrees[pathId]!.value as Record<string, unknown>;

        const texture = readTexture2D(reader);
        assert.equal(reader.position, reader.byteSize, "byteSize not consumed exactly");
        // Every field, in Unity's order, with the oracle's values.
        assert.deepEqual(Object.keys(texture), Object.keys(dump));
        assert.deepEqual(normalize(texture, sf), dump);
        checkTextureGolden(texture, env, reader, want);

        // The same object through its type tree: only the offset's type differs.
        const tree = reader.readTypeTree() as Record<string, unknown>;
        const stream = tree.m_StreamData as { offset: bigint | number };
        assert.deepEqual(Object.keys(texture), Object.keys(tree));
        assert.deepEqual(texture, {
          ...tree,
          m_StreamData: { ...stream, offset: Number(stream.offset) },
        });
        checked++;
      }
    }
    assert.ok(checked > 0, "no Texture2D checked");
  });
}

test("the typed checks cover formats 21 and 22, .resS and inline data", () => {
  assert.ok(TYPED.includes("editor/6000.3.25f1/plain/textures"));
  const formats = new Set<number>();
  const kinds = new Set<string>();
  for (const name of TYPED) {
    for (const sf of Object.values(golden(name).serialized!)) {
      for (const pathId of Object.keys(sf.textures ?? {})) {
        formats.add(sf.formatVersion);
        const stream = (sf.typetrees[pathId]!.value as { m_StreamData: { path: string } })
          .m_StreamData;
        kinds.add(stream.path ? "resS" : "inline");
      }
    }
  }
  assert.deepEqual([...formats].sort(), [21, 22]);
  assert.deepEqual([...kinds].sort(), ["inline", "resS"]);
});

// --- editor fixtures without type trees: the hardcoded path is the only one ----------

for (const name of STRIPPED) {
  test(`${name}: readTexture2D equals the typed build's golden`, () => {
    const twinName = name.replace(/lz4-notypetree/g, "lz4");
    const { env, textures } = loadTextures(name);
    const [path, ...morePaths] = [...textures.keys()];
    const [twinPath] = Object.keys(golden(twinName).serialized!);
    assert.ok(path && twinPath && !morePaths.length, "not one SerializedFile");
    const twin = golden(twinName).serialized![twinPath]!;
    assert.equal(golden(name).serialized![path]!.enableTypeTree, false);

    const readers = textures.get(path)!;
    assert.equal(readers.size, Object.keys(twin.textures!).length);
    for (const [pathId, want] of Object.entries(twin.textures!)) {
      const reader = readers.get(pathId);
      assert.ok(reader, `${path} has no Texture2D ${pathId}`);
      assert.equal(reader.serializedType?.nodes, null, "the file has a type tree after all");

      const texture = readTexture2D(reader);
      assert.equal(reader.position, reader.byteSize, "byteSize not consumed exactly");
      assert.deepEqual(normalize(texture, twin), twin.typetrees[pathId]!.value);
      checkTextureGolden(texture, env, reader, want);
    }
  });
}

test("the stripped checks cover formats 21 and 22", () => {
  const formats = STRIPPED.flatMap((name) =>
    Object.values(golden(name).serialized!).map((sf) => sf.formatVersion),
  );
  assert.deepEqual([...new Set(formats)].sort(), [21, 22]);
});

// --- synthetic objects ---------------------------------------------------------------

interface TextureObject {
  bytes: Uint8Array;
  sf: SerializedFile;
  info: SerializedFile["objects"][number];
}

const objectCache = new Map<string, TextureObject>();

/** The first Texture2D of a fixture (6000.3's `.resS` one by default): bytes, file, entry. */
function textureObject(name = "editor/6000.3.25f1/uncompressed/texture"): TextureObject {
  let cached = objectCache.get(name);
  if (!cached) objectCache.set(name, (cached = readTextureObject(name)));
  return cached;
}

function readTextureObject(name: string): TextureObject {
  const env = load([{ name, data: loadFixture(name) }]);
  const data = env.files.find((f) => Boolean(golden(name).serialized![f.path]))!.data;
  const sf = readSerializedFile(data);
  const info = sf.objects.find((o) => o.classId === ClassID.Texture2D)!;
  assert.equal(sf.bigEndian, false);
  return { bytes: data.slice(info.byteStart, info.byteStart + info.byteSize), sf, info };
}

/** A reader over `bytes` as a Texture2D of a file with the given version and platform. */
function synthetic(
  bytes: Uint8Array,
  unity: UnityVersion,
  text = unity.slice(0, 3).join("."),
  platform: BuildTarget = BuildTarget.StandaloneWindows64,
): ObjectReader {
  const { sf, info } = textureObject();
  const file: SerializedFile = {
    ...sf,
    unityVersion: text,
    version: unity,
    targetPlatform: platform,
  };
  return new ObjectReader(bytes, file, { ...info, byteStart: 0, byteSize: bytes.length });
}

const U6000: UnityVersion = [6000, 3, 25, 1];

/**
 * Field layouts from Unity's own player type trees (UnityPy's TPK data), at the
 * versions a field appears, goes or moves. Entries are `"<kind> <name>"`; a
 * dotted name is a field of `m_TextureSettings` or `m_StreamData`.
 */
const HEAD_3 = ["str m_Name", "i32 m_Width", "i32 m_Height", "i32 m_CompleteImageSize"];
const FALLBACK = ["i32 m_ForcedFallbackFormat", "bool m_DownscaleFallback"];
const SETTINGS_OLD = ["i32 s.m_FilterMode", "i32 s.m_Aniso", "f32 s.m_MipBias", "i32 s.m_WrapMode"];
const SETTINGS = ["i32 s.m_FilterMode", "i32 s.m_Aniso", "f32 s.m_MipBias"]
  .concat(["i32 s.m_WrapU", "i32 s.m_WrapV", "i32 s.m_WrapW"]);
const DIMS = ["i32 m_ImageCount", "i32 m_TextureDimension"];
const IMAGE = ["bytes image data", "align"];
const STREAM_32 = ["u32 d.offset", "u32 d.size", "str d.path"];
const STREAM_64 = ["u64 d.offset", "u32 d.size", "str d.path"];
const STREAMING = ["bool m_StreamingMipmaps", "align", "i32 m_StreamingMipmapsPriority"];
const TAIL_2017 = [...DIMS, ...SETTINGS, "i32 m_LightmapFormat", "i32 m_ColorSpace"];
const HEAD_2020 = ["i32 m_Width", "i32 m_Height", "u32 m_CompleteImageSize", "i32 m_MipsStripped"]
  .concat(["i32 m_TextureFormat", "i32 m_MipCount", "bool m_IsReadable", "bool m_IsPreProcessed"]);
const LIMIT_2022 = ["bool m_IgnoreMipmapLimit", "align", "str m_MipmapLimitGroupName"];
const BLOB = ["bytes m_PlatformBlob", "align"];

const LAYOUTS: { unity: UnityVersion; fields: string[] }[] = [
  {
    unity: [3, 4, 0, 1],
    fields: [...HEAD_3, "i32 m_TextureFormat", "bool m_MipMap", "bool m_IsReadable"]
      .concat(["bool m_ReadAllowed", "align", ...DIMS, ...SETTINGS_OLD, "i32 m_LightmapFormat"])
      .concat(IMAGE),
  },
  {
    unity: [3, 5, 0, 1],
    fields: [...HEAD_3, "i32 m_TextureFormat", "bool m_MipMap", "bool m_IsReadable"]
      .concat(["bool m_ReadAllowed", "align", ...DIMS, ...SETTINGS_OLD, "i32 m_LightmapFormat"])
      .concat(["i32 m_ColorSpace", ...IMAGE]),
  },
  {
    unity: [5, 2, 0, 1],
    fields: [...HEAD_3, "i32 m_TextureFormat", "i32 m_MipCount", "bool m_IsReadable"]
      .concat(["bool m_ReadAllowed", "align", ...DIMS, ...SETTINGS_OLD, "i32 m_LightmapFormat"])
      .concat(["i32 m_ColorSpace", ...IMAGE]),
  },
  {
    unity: [5, 3, 0, 1],
    fields: [...HEAD_3, "i32 m_TextureFormat", "i32 m_MipCount", "bool m_IsReadable"]
      .concat(["bool m_ReadAllowed", "align", ...DIMS, ...SETTINGS_OLD, "i32 m_LightmapFormat"])
      .concat(["i32 m_ColorSpace", ...IMAGE, ...STREAM_32]),
  },
  {
    unity: [5, 5, 0, 1],
    fields: [...HEAD_3, "i32 m_TextureFormat", "i32 m_MipCount", "bool m_IsReadable", "align"]
      .concat([...DIMS, ...SETTINGS_OLD, "i32 m_LightmapFormat", "i32 m_ColorSpace"])
      .concat([...IMAGE, ...STREAM_32]),
  },
  {
    unity: [2017, 1, 0, 1],
    fields: [...HEAD_3, "i32 m_TextureFormat", "i32 m_MipCount", "bool m_IsReadable", "align"]
      .concat([...TAIL_2017, ...IMAGE, ...STREAM_32]),
  },
  {
    unity: [2017, 3, 0, 1],
    fields: ["str m_Name", ...FALLBACK, "align", ...HEAD_3.slice(1), "i32 m_TextureFormat"]
      .concat(["i32 m_MipCount", "bool m_IsReadable", "align", ...TAIL_2017, ...IMAGE])
      .concat(STREAM_32),
  },
  {
    unity: [2018, 2, 0, 1],
    fields: ["str m_Name", ...FALLBACK, "align", ...HEAD_3.slice(1), "i32 m_TextureFormat"]
      .concat(["i32 m_MipCount", "bool m_IsReadable", ...STREAMING, ...TAIL_2017, ...IMAGE])
      .concat(STREAM_32),
  },
  {
    unity: [2019, 4, 8, 1],
    fields: ["str m_Name", ...FALLBACK, "align", ...HEAD_3.slice(1), "i32 m_TextureFormat"]
      .concat(["i32 m_MipCount", "bool m_IsReadable", "bool m_IgnoreMasterTextureLimit"])
      .concat([...STREAMING, ...TAIL_2017, ...IMAGE, ...STREAM_32]),
  },
  {
    unity: [2019, 4, 9, 1],
    fields: ["str m_Name", ...FALLBACK, "align", ...HEAD_3.slice(1), "i32 m_TextureFormat"]
      .concat(["i32 m_MipCount", "bool m_IsReadable", "bool m_IgnoreMasterTextureLimit"])
      .concat(["bool m_IsPreProcessed", ...STREAMING, ...TAIL_2017, ...IMAGE, ...STREAM_32]),
  },
  {
    unity: [2020, 1, 0, 1],
    fields: ["str m_Name", ...FALLBACK, "align", ...HEAD_2020]
      .concat(["bool m_IgnoreMasterTextureLimit", ...STREAMING, ...TAIL_2017, ...IMAGE])
      .concat(STREAM_64),
  },
  {
    unity: [2020, 2, 0, 1],
    fields: ["str m_Name", ...FALLBACK, "bool m_IsAlphaChannelOptional", "align", ...HEAD_2020]
      .concat(["bool m_IgnoreMasterTextureLimit", ...STREAMING, ...TAIL_2017, ...BLOB])
      .concat([...IMAGE, ...STREAM_64]),
  },
  {
    unity: [2022, 2, 0, 1],
    fields: ["str m_Name", ...FALLBACK, "bool m_IsAlphaChannelOptional", "align", ...HEAD_2020]
      .concat([...LIMIT_2022, ...STREAMING, ...TAIL_2017, ...BLOB, ...IMAGE, ...STREAM_64]),
  },
  {
    unity: [2023, 2, 0, 1],
    fields: ["str m_Name", "bool m_IsAlphaChannelOptional", "align", ...HEAD_2020]
      .concat([...LIMIT_2022, ...STREAMING, ...TAIL_2017, ...BLOB, ...IMAGE, ...STREAM_64]),
  },
];

/**
 * Little-endian bytes for a layout, each field a value distinct from its
 * neighbours (bools alternate), and the object the reader must return for it.
 */
function build(fields: string[]): { bytes: Uint8Array; expected: Record<string, unknown> } {
  const out: number[] = [];
  const view = new DataView(new ArrayBuffer(8));
  const push = (size: number) => out.push(...new Uint8Array(view.buffer, 0, size));
  const expected: Record<string, unknown> = {};
  const nested: Record<string, Record<string, unknown>> = { s: {}, d: {} };
  let bools = 0;
  fields.forEach((field, i) => {
    if (field === "align") {
      while (out.length % 4) out.push(0);
      return;
    }
    const space = field.indexOf(" ");
    const kind = field.slice(0, space);
    const name = field.slice(space + 1);
    let value: unknown;
    if (kind === "i32" || kind === "u32") {
      value = kind === "i32" ? -1000 - i : 0x8000_0000 + i;
      view.setUint32(0, (value as number) >>> 0, true);
      push(4);
    } else if (kind === "u64") {
      value = 2 ** 40 + i;
      view.setBigUint64(0, BigInt(value as number), true);
      push(8);
    } else if (kind === "f32") {
      value = 0.5 + i;
      view.setFloat32(0, value as number, true);
      push(4);
    } else if (kind === "bool") {
      value = bools++ % 2 === 0;
      out.push(value ? 1 : 0);
    } else if (kind === "str" || kind === "bytes") {
      // Odd lengths, so a missing align shows.
      const data =
        kind === "str" ? new TextEncoder().encode(`${name}#${i}`) : Uint8Array.of(i, i + 1, i + 2);
      value = kind === "str" ? `${name}#${i}` : data;
      view.setInt32(0, data.length, true);
      push(4);
      out.push(...data);
      if (kind === "str") while (out.length % 4) out.push(0);
    } else {
      assert.fail(`unknown kind ${kind}`);
    }
    const dot = name.indexOf(".");
    if (dot === -1) expected[name] = value;
    else nested[name.slice(0, dot)]![name.slice(dot + 1)] = value;
  });
  // The nested structs sit where their first field does.
  const ordered: Record<string, unknown> = {};
  for (const field of fields) {
    const name = field.slice(field.indexOf(" ") + 1);
    if (name.startsWith("s.")) ordered.m_TextureSettings = nested.s;
    else if (name.startsWith("d.")) ordered.m_StreamData = nested.d;
    else if (field !== "align") ordered[name] = expected[name];
  }
  return { bytes: Uint8Array.from(out), expected: ordered };
}

for (const { unity, fields } of LAYOUTS) {
  test(`Unity ${unity.slice(0, 3).join(".")}: the player layout of Unity's type tree`, () => {
    const { bytes, expected } = build(fields);
    const reader = synthetic(bytes, unity);
    const texture = readTexture2D(reader);
    assert.deepEqual(Object.keys(texture), Object.keys(expected));
    assert.deepEqual(texture, expected);
    assert.equal(reader.remaining, 0);
  });
}

test("readTexture stops after the Texture fields and their padding", () => {
  const { bytes } = build(["str m_Name", ...FALLBACK, "bool m_IsAlphaChannelOptional", "align"]);
  const reader = synthetic(Uint8Array.from([...bytes, 9, 0, 0, 0]), [2020, 3, 30, 1]);
  assert.deepEqual(Object.keys(readTexture(reader)), [
    "m_Name",
    "m_ForcedFallbackFormat",
    "m_DownscaleFallback",
    "m_IsAlphaChannelOptional",
  ]);
  assert.equal(reader.readInt32(), 9);
});

// --- refusals -------------------------------------------------------------------------

/**
 * Per the class-reader rule on #36: an all-zero version is refused with the
 * file's own version string, from a stripped file (`"0.0.0"`) or a loose file
 * below format 7 (`"2.5.0f5"`, #98).
 */
for (const text of ["0.0.0", "2.5.0f5"]) {
  test(`Unity "${text}" at 0.0.0.0: UnsupportedError("Unity version")`, () => {
    const reader = synthetic(textureObject().bytes, [0, 0, 0, 0], text);
    for (const read of [readTexture, readTexture2D]) {
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

test("an editor file (NoTarget) is refused: its Texture2D has editor-only fields", () => {
  const reader = synthetic(textureObject().bytes, U6000, "6000.3.25f1", BuildTarget.NoTarget);
  assert.throws(
    () => readTexture2D(reader),
    (err: unknown) =>
      err instanceof UnsupportedError && err.kind === "build target" && err.found === "NoTarget",
  );
});

// --- truncated and oversized objects ----------------------------------------------------

const TRUNCATED: { name: string; unity: UnityVersion }[] = [
  { name: "editor/2019.4.41f2/uncompressed/texture", unity: [2019, 4, 41, 2] },
  { name: "editor/6000.3.25f1/uncompressed/texture", unity: U6000 },
];

for (const { name, unity } of TRUNCATED) {
  test(`${name}: every cut through a field throws CorruptError`, () => {
    const { bytes } = textureObject(name);
    assert.equal(readTexture2D(synthetic(bytes, unity)).m_StreamData!.size, 64);
    // The last 3 bytes may be only the path's padding; every shorter cut loses data.
    for (let cut = 0; cut <= bytes.length - 4; cut++) {
      const reader = synthetic(bytes.subarray(0, cut), unity);
      assert.throws(() => readTexture2D(reader), CorruptError, `cut at ${cut}`);
    }
  });
}

test("an inline Texture2D cut inside its image data throws CorruptError", () => {
  const { bytes } = textureObject("editor/6000.3.25f1/plain/textures");
  const texture = readTexture2D(synthetic(bytes, U6000));
  assert.ok(texture["image data"].length > 0);
  const reader = synthetic(bytes.subarray(0, bytes.length - 20), U6000);
  assert.throws(() => readTexture2D(reader), /image data byte count/);
});

test("bytes left after m_StreamData throw CorruptError", () => {
  const { bytes } = textureObject();
  const reader = synthetic(Uint8Array.from([...bytes, 0, 0, 0, 0]), U6000);
  assert.throws(
    () => readTexture2D(reader),
    (err: unknown) =>
      err instanceof CorruptError && err.message.includes(`ends at ${bytes.length} of its`),
  );
});

// --- StreamingInfo --------------------------------------------------------------------

/** Where `m_StreamData.offset` starts in a Texture2D object whose data ends with it. */
function offsetAt(bytes: Uint8Array, unity: UnityVersion): number {
  const { path } = readTexture2D(synthetic(bytes, unity)).m_StreamData!;
  const pathBytes = 4 + Math.ceil(new TextEncoder().encode(path).length / 4) * 4;
  return bytes.length - pathBytes - 4 - (unity[0] >= 2020 ? 8 : 4);
}

test("2020.1+: a UInt64 offset reads up to 2^53 - 1 and throws CorruptError above", () => {
  const { bytes } = textureObject();
  const at = offsetAt(bytes, U6000);
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);

  view.setBigUint64(at, 2n ** 53n - 1n, true);
  assert.equal(readTexture2D(synthetic(copy, U6000)).m_StreamData!.offset, 2 ** 53 - 1);

  view.setBigUint64(at, 2n ** 53n, true);
  assert.throws(() => readTexture2D(synthetic(copy, U6000)), /offset 9007199254740992 is not/);
  view.setBigUint64(at, 2n ** 64n - 1n, true);
  assert.throws(() => readTexture2D(synthetic(copy, U6000)), CorruptError);
});

test("before 2020.1: the offset is an unsigned 32-bit value", () => {
  const name = "editor/2019.4.41f2/uncompressed/texture";
  const unity: UnityVersion = [2019, 4, 41, 2];
  const copy = textureObject(name).bytes.slice();
  new DataView(copy.buffer).setUint32(offsetAt(copy, unity), 0xffff_fff0, true);
  assert.equal(readTexture2D(synthetic(copy, unity)).m_StreamData!.offset, 0xffff_fff0);
});

test("m_StreamData goes to env.readResource as it is: a view into the .resS node", () => {
  const name = "editor/6000.3.25f1/uncompressed/texture";
  const { env, textures } = loadTextures(name);
  const [reader] = [...textures.values()][0]!.values();
  assert.ok(reader);
  const { m_StreamData: stream } = readTexture2D(reader);
  assert.ok(stream);
  assert.deepEqual(Object.keys(stream), ["offset", "size", "path"]);
  assert.match(stream.path, /^archive:\/CAB-[0-9a-f]+\/CAB-[0-9a-f]+\.resS$/);

  const image = env.readResource(stream, reader);
  const resS = env.files.find((f) => f.path.endsWith(".resS"))!.data;
  assert.equal(image.length, stream.size);
  assert.equal(image.buffer, resS.buffer);
  assert.equal(image.byteOffset, resS.byteOffset + stream.offset);
});

test("inline image data is a view into the object's bytes (R7)", () => {
  const { bytes } = textureObject("editor/6000.3.25f1/plain/textures");
  const image = readTexture2D(synthetic(bytes, U6000))["image data"];
  assert.equal(image.buffer, bytes.buffer);
});

// --- TextureFormat --------------------------------------------------------------------

test("TextureFormat: the plain-format ids of the fixtures, and Unity's numbering from 66", () => {
  const plain = golden("editor/6000.3.25f1/plain/textures").serialized!;
  const formats = Object.values(plain).flatMap((sf) =>
    Object.values(sf.textures ?? {}).map((t) => [t.name, t.format] as const),
  );
  // Each plain fixture texture is named after its format.
  for (const [name, format] of formats) {
    assert.equal(TextureFormat[name as keyof typeof TextureFormat], format, name);
  }
  assert.equal(formats.length, 17);
  assert.equal(TextureFormat.ETC2_RGBA8Crunched, 65);
  assert.equal(TextureFormat.ASTC_HDR_4x4, 66);
  assert.equal(TextureFormat.RGBA64, 74);
  assert.equal(new Set(Object.values(TextureFormat)).size, Object.keys(TextureFormat).length);
});
