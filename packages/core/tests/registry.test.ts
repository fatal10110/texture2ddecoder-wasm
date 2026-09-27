// The ClassID -> reader registry behind `obj.read()` (#103): the hardcoded
// Texture2D reader with its image data resolved, the readTypeTree() fallback,
// and the refusals. Image hashes and dumps come from the oracle (R12).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fixtureNames,
  golden,
  loadFixture,
  sha256,
  type GoldenTexture,
} from "../../../fixtures/helpers.js";
import type { Texture2DData } from "../src/classes/registry.js";
import { textAssetString, type TextAsset } from "../src/classes/TextAsset.js";
import { readTexture2D } from "../src/classes/Texture2D.js";
import { load, type Env } from "../src/env.js";
import { CorruptError, ResourceNotFoundError, UnsupportedError } from "../src/errors.js";
import { ClassID, classIdName } from "../src/serialized/ClassID.js";
import { ObjectReader } from "../src/serialized/ObjectReader.js";
import { readSerializedFile } from "../src/serialized/SerializedFile.js";
import { objectBytes, synthetic } from "./class-readers.js";

/**
 * Fixtures holding a Texture2D with image data, per their (or their typed
 * twin's) texture goldens. A dynamic font's 0x0 "Font Texture" has none, so no
 * golden (#41); `Font.test.ts` checks that `read()` refuses it.
 */
const TEXTURE_FIXTURES = fixtureNames().filter((name) => textureGoldens(name).size > 0);

/** Fixtures whose SerializedFiles all carry type trees, and those built without. */
const TYPED = fixtureNames().filter((name) => {
  const files = Object.values(golden(name).serialized ?? {});
  return files.length > 0 && files.every((sf) => sf.enableTypeTree);
});
const NO_TYPE_TREE = fixtureNames().filter((name) => name.includes("/lz4-notypetree/"));
/**
 * Classes whose `read()` never goes through the type tree. A MonoBehaviour's
 * does when the file has one (#39), so it is not listed.
 */
const HARDCODED: ReadonlySet<number> = new Set([
  ClassID.Texture2D,
  ClassID.AssetBundle,
  ClassID.TextAsset,
  ClassID.MonoScript,
  ClassID.Material,
  ClassID.AudioClip,
  ClassID.Font,
  ClassID.VideoClip,
  ClassID.MovieTexture,
  ClassID.Sprite,
  ClassID.SpriteAtlas,
]);
/** Whether a fixture holds an object of a class without a hardcoded reader. */
const hasOthers = (name: string): boolean =>
  Object.values(golden(name).objects).some((objs) => objs.some((o) => !HARDCODED.has(o.classId)));

const loadName = (name: string): Env => load([{ name, data: loadFixture(name) }]);

/**
 * The oracle's texture entries for a fixture, by path id. A build without
 * type trees has none of its own; its typed twin holds the same objects.
 */
function textureGoldens(name: string): Map<string, GoldenTexture> {
  const source = golden(name.replace(/lz4-notypetree/g, "lz4"));
  const out = new Map<string, GoldenTexture>();
  for (const sf of Object.values(source.serialized ?? {})) {
    for (const [pathId, texture] of Object.entries(sf.textures ?? {})) out.set(pathId, texture);
  }
  return out;
}

/** `read()` without `imageData` and `platform`: what `readTexture2D` alone returns. */
function withoutImageData(data: Texture2DData): Omit<Texture2DData, "imageData" | "platform"> {
  const { imageData: _, platform: __, ...rest } = data;
  return rest;
}

/** The oracle's `m_TargetPlatform` for a fixture whose SerializedFiles share one. */
function targetPlatform(name: string): number {
  const files = Object.values(golden(name).serialized ?? {});
  const platforms = new Set(files.map((sf) => sf.targetPlatform));
  assert.equal(platforms.size, 1, `${name}: ${[...platforms]}`);
  return [...platforms][0]!;
}

// --- Texture2D: the registered hardcoded reader ------------------------------------

for (const name of TEXTURE_FIXTURES) {
  test(`${name}: env.objects -> obj.read() gives every Texture2D and its golden image`, () => {
    const env = loadName(name);
    const want = textureGoldens(name);
    const textures = env.objects.filter((o) => o.type === ClassID.Texture2D);
    assert.equal(textures.length, want.size);

    for (const obj of textures) {
      const expected = want.get(String(obj.pathId));
      assert.ok(expected, `no golden for Texture2D ${obj.pathId}`);
      const data: Texture2DData = obj.read();

      // The hardcoded reader's result, plus the image data and the platform, nothing else.
      assert.deepEqual(Object.keys(data), [
        ...Object.keys(readTexture2D(obj)),
        "imageData",
        "platform",
      ]);
      assert.deepEqual(withoutImageData(data), readTexture2D(obj));
      // The file's platform, which decoding a console texture needs (#33).
      assert.equal(data.platform, obj.platform);
      assert.equal(data.platform, targetPlatform(name));
      assert.equal(data.m_Name, expected.name);
      assert.equal(data.m_TextureFormat, expected.format);
      assert.equal(data.imageData.length, expected.imageSize);
      assert.equal(sha256(data.imageData), expected.imageSha256);

      // A view, never a copy (R7): into the .resS node, or the inline bytes.
      const stream = data.m_StreamData;
      if (stream?.path) {
        assert.equal(data["image data"].length, 0);
        const ress = env.files.find((f) => f.path.endsWith(".resS"))!.data;
        assert.equal(data.imageData.buffer, ress.buffer);
        assert.equal(data.imageData.byteOffset, ress.byteOffset + stream.offset);
      } else {
        assert.equal(data.imageData, data["image data"]);
      }
    }
  });
}

test("the read() texture checks cover .resS and inline data, typed and not, every editor", () => {
  const kinds = new Set<string>();
  for (const name of TEXTURE_FIXTURES) {
    const editor = name.split("/")[1];
    const typed = name.includes("/lz4-notypetree/") ? "notypetree" : "typed";
    for (const obj of loadName(name).objects.filter((o) => o.type === ClassID.Texture2D)) {
      const where = obj.read<Texture2DData>().m_StreamData?.path ? "resS" : "inline";
      kinds.add(`${editor} ${typed} ${where}`);
    }
  }
  for (const editor of ["2019.4.41f2", "2020.3.30f1", "6000.3.25f1"]) {
    for (const typed of ["typed", "notypetree"]) assert.ok(kinds.has(`${editor} ${typed} resS`));
  }
  assert.ok(kinds.has("6000.3.25f1 typed inline"));
});

for (const name of TEXTURE_FIXTURES.filter((n) => n.includes("/lz4-notypetree/"))) {
  test(`${name}: read() takes the hardcoded path, where the type tree cannot`, () => {
    for (const obj of loadName(name).objects.filter((o) => o.type === ClassID.Texture2D)) {
      assert.equal(obj.serializedType?.nodes, null, "the file has a type tree after all");
      assert.throws(() => obj.readTypeTree(), UnsupportedError);
      assert.ok(obj.read<Texture2DData>().imageData.length > 0);
    }
  });
}

test("a typed Texture2D is still read by the hardcoded reader, not its type tree", () => {
  // From 2020.1 the type tree reads m_StreamData.offset as UInt64, a bigint (D9);
  // the hardcoded reader gives a number.
  const obj = loadName("editor/6000.3.25f1/lz4/texture").objects.find(
    (o) => o.type === ClassID.Texture2D,
  )!;
  const tree = obj.readTypeTree() as { m_StreamData: { offset: unknown } };
  assert.equal(typeof tree.m_StreamData.offset, "bigint");
  assert.equal(typeof obj.read<Texture2DData>().m_StreamData?.offset, "number");
});

// --- the readTypeTree() fallback ----------------------------------------------------

for (const name of TYPED.filter(hasOthers)) {
  test(`${name}: read() of a class without a reader is the readTypeTree() result`, () => {
    // A typed MonoBehaviour is among them: its read() is the whole type tree (#39).
    const others = loadName(name).objects.filter((o) => !HARDCODED.has(o.type));
    assert.ok(others.length > 0);
    for (const obj of others) assert.deepEqual(obj.read(), obj.readTypeTree(), `${obj.pathId}`);
  });
}

test("read() of a TextAsset equals the oracle's dump", () => {
  const names = TYPED.filter((n) => n.endsWith("/shared"));
  assert.equal(names.length, 9);
  for (const name of names) {
    const obj = loadName(name).objects.find((o) => o.type === ClassID.TextAsset);
    assert.ok(obj, `${name}: no TextAsset`);
    const dump = Object.values(golden(name).serialized!)
      .map((s) => s.typetrees[String(obj.pathId)])
      .find((d) => d !== undefined);
    assert.ok(dump, `${name}: no golden dump for ${obj.pathId}`);
    // The golden's m_Script is the string; read() gives the bytes (#39).
    const data = obj.read<TextAsset>();
    assert.deepEqual({ ...data, m_Script: textAssetString(data) }, dump.value, name);
  }
});

// --- refusals ---------------------------------------------------------------------

for (const name of NO_TYPE_TREE.filter(hasOthers)) {
  test(`${name}: read() of a class without a reader or type tree throws UnsupportedError`, () => {
    const others = loadName(name).objects.filter(
      (o) => !HARDCODED.has(o.type) && o.type !== ClassID.MonoBehaviour,
    );
    assert.ok(others.length > 0);
    for (const obj of others) {
      assert.throws(
        () => obj.read(),
        (err: unknown) =>
          err instanceof UnsupportedError &&
          err.kind === "object without a type tree" &&
          err.found === `class ${obj.type}, path id ${obj.pathId}`,
      );
    }
  });
}

/** Every fixture whose Texture2D data is in a `.resS` node. */
const RESS_FIXTURES = TEXTURE_FIXTURES.filter((name) =>
  Object.keys(golden(name).files).some((path) => path.endsWith(".resS")),
);

for (const name of RESS_FIXTURES) {
  test(`${name}: read() without the .resS throws ResourceNotFoundError`, () => {
    const { files } = loadName(name);
    const ress = files.find((f) => f.path.endsWith(".resS"))!;
    const cab = files.find((f) => f !== ress)!;
    // The SerializedFile alone, as a loose input: nothing else is loaded.
    const obj = load([{ name: cab.path, data: cab.data }]).objects.find(
      (o) => o.type === ClassID.Texture2D,
    )!;
    const { path } = readTexture2D(obj).m_StreamData!;
    assert.throws(
      () => obj.read(),
      (err: unknown) =>
        err instanceof ResourceNotFoundError && err.path === path && err.fileName === ress.path,
    );
  });
}

test("read() finds the .resS passed as its own input next to a loose SerializedFile", () => {
  const { files } = loadName("editor/2020.3.30f1/lz4/texture");
  const ress = files.find((f) => f.path.endsWith(".resS"))!;
  const cab = files.find((f) => f !== ress)!;
  const env = load([cab, ress].map(({ path, data }) => ({ name: path, data })));
  const obj = env.objects.find((o) => o.type === ClassID.Texture2D)!;
  const { imageData, m_StreamData } = obj.read<Texture2DData>();
  assert.equal(imageData.buffer, ress.data.buffer);
  assert.equal(imageData.length, m_StreamData!.size);
});

/** A Texture2D's SerializedFile and entry, taken apart to build a reader by hand. */
function handBuilt(name: string): ObjectReader {
  const node = loadName(name).files.find((f) => golden(name).serialized![f.path])!;
  const sf = readSerializedFile(node.data);
  const info = sf.objects.find((o) => o.classId === ClassID.Texture2D)!;
  return new ObjectReader(node.data, sf, info);
}

test("a reader not built by load() reads inline data, and has no .resS to look in", () => {
  const inline = handBuilt("editor/6000.3.25f1/plain/textures").read<Texture2DData>();
  assert.ok(inline.imageData.length > 0);
  assert.equal(inline.imageData, inline["image data"]);

  const streamed = handBuilt("editor/6000.3.25f1/lz4/texture");
  const { path } = readTexture2D(streamed).m_StreamData!;
  assert.throws(
    () => streamed.read(),
    (err: unknown) => err instanceof ResourceNotFoundError && err.path === path,
  );
});

test("non-empty inline image data wins over a non-empty m_StreamData.path", () => {
  // Upstream `Texture2D.cs` reads `m_StreamData` only when the inline size is
  // 0, and UnityPy returns `image_data` whenever it is non-empty. Unity never
  // writes both, so the path is spliced into an inline texture.
  const name = "editor/6000.3.25f1/plain/textures";
  const node = loadName(name).files.find((f) => golden(name).serialized![f.path])!;
  const sf = readSerializedFile(node.data);
  assert.equal(sf.bigEndian, false);
  const info = sf.objects.find((o) => o.classId === ClassID.Texture2D)!;
  const object = node.data.subarray(info.byteStart, info.byteStart + info.byteSize);
  // The object ends with m_StreamData.path: an empty string, Int32 length 0.
  assert.deepEqual([...object.subarray(-4)], [0, 0, 0, 0]);

  const path = "archive:/CAB-x/CAB-x.resS";
  const text = new TextEncoder().encode(path);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setInt32(0, text.length, true);
  const padding = new Uint8Array((4 - (text.length % 4)) % 4);
  const bytes = Uint8Array.from([...object.subarray(0, -4), ...length, ...text, ...padding]);
  const reader = new ObjectReader(bytes, sf, { ...info, byteStart: 0, byteSize: bytes.length });
  const texture = readTexture2D(reader);
  assert.equal(texture.m_StreamData?.path, path);
  assert.ok(texture["image data"].length > 0);

  // A hand-built reader has no .resS to look in, so the stream would throw.
  const data = reader.read<Texture2DData>();
  assert.equal(data.imageData, data["image data"]);
  const want = textureGoldens(name).get(String(info.pathId))!;
  assert.equal(sha256(data.imageData), want.imageSha256);
});

test("no image data, neither inline nor in a .resS, throws CorruptError (R9)", () => {
  // Decided on PR #118, as UnityPy raises: the .resS-backed Texture2D with
  // its m_StreamData.path emptied, so both sources are empty.
  const name = "editor/6000.3.25f1/lz4/texture";
  const node = loadName(name).files.find((f) => golden(name).serialized![f.path])!;
  const sf = readSerializedFile(node.data);
  assert.equal(sf.bigEndian, false);
  const info = sf.objects.find((o) => o.classId === ClassID.Texture2D)!;
  const object = node.data.subarray(info.byteStart, info.byteStart + info.byteSize);
  const streamed = new ObjectReader(node.data, sf, info);
  const { m_StreamData, "image data": inline } = readTexture2D(streamed);
  assert.equal(inline.length, 0);
  // The object ends with the path: an Int32 length, the bytes, padding to 4.
  const pathBytes = 4 + Math.ceil(new TextEncoder().encode(m_StreamData!.path).length / 4) * 4;
  const bytes = Uint8Array.from([...object.subarray(0, -pathBytes), 0, 0, 0, 0]);
  const reader = new ObjectReader(bytes, sf, { ...info, byteStart: 0, byteSize: bytes.length });
  const texture = readTexture2D(reader);
  assert.equal(texture.m_StreamData?.path, "");
  assert.equal(texture["image data"].length, 0);

  assert.throws(
    () => reader.read(),
    (err: unknown) =>
      err instanceof CorruptError &&
      err.message ===
        `Texture2D ${info.pathId} has no image data, neither inline nor in a .resS ` +
          "(image data is empty and m_StreamData.path names no file)",
  );
});

/**
 * A big-endian format-8 SerializedFile (Unity 3.x layout, the smallest that
 * records an editor version) whose one object, path id 1, is a Texture2D of
 * four bytes. `"0.0.0"` is what `AssetBundleStripUnityVersion` writes; none of
 * the editor fixtures holds a Texture2D in a stripped build.
 */
function format8Texture(unityVersion: string): Uint8Array {
  const bytes: number[] = [];
  const u8 = (v: number) => bytes.push(v & 0xff);
  const u16 = (v: number) => (u8(v >> 8), u8(v));
  const u32 = (v: number) => (u16(v >>> 16), u16(v));
  const cstring = (s: string) => ([...s].forEach((c) => u8(c.charCodeAt(0))), u8(0));

  u8(1); // endianess: big
  cstring(unityVersion);
  u32(19); // m_TargetPlatform: StandaloneWindows64
  u32(0); // types
  u32(0); // bigIDEnabled
  u32(1); // objects
  u32(1); // m_PathID
  u32(0); // byteStart, relative to m_DataOffset
  u32(4); // byteSize
  u32(ClassID.Texture2D); // typeID
  u16(ClassID.Texture2D); // classID
  u16(0); // isDestroyed
  u32(0); // externals
  cstring(""); // userInformation
  const metadata = bytes.splice(0);

  const dataOffset = 16;
  u32(metadata.length);
  u32(dataOffset + 4 + metadata.length); // file size
  u32(8); // m_Version
  u32(dataOffset);
  bytes.push(0, 0, 0, 0, ...metadata);
  return Uint8Array.from(bytes);
}

test("read() of a Texture2D in a version-stripped file: UnsupportedError(Unity version)", () => {
  const data = format8Texture("0.0.0");
  const [obj, ...more] = load([{ name: "CAB-stripped", data }]).objects;
  assert.ok(obj && more.length === 0);
  assert.equal(obj.type, ClassID.Texture2D);
  assert.deepEqual(obj.version, [0, 0, 0, 0]);
  assert.throws(
    () => obj.read(),
    (err: unknown) =>
      err instanceof UnsupportedError && err.kind === "Unity version" && err.found === "0.0.0",
  );
  // The same file with a version gets past the version check to the bytes.
  const versioned = load([{ name: "CAB-v", data: format8Texture("3.4.2f3") }]).objects[0]!;
  assert.deepEqual(versioned.version, [3, 4, 2, 3]);
  assert.throws(() => versioned.read(), CorruptError);
});

// --- m_Name: strict in every NamedObject reader (#129) ------------------------------

/** A fixture object of each registered NamedObject class, in a 6000 player build. */
const NAMED: { classId: number; name: string }[] = [
  { classId: ClassID.Texture2D, name: "editor/6000.3.25f1/uncompressed/texture" },
  { classId: ClassID.TextAsset, name: "editor/6000.3.25f1/uncompressed/shared" },
  { classId: ClassID.MonoScript, name: "editor/6000.3.25f1/uncompressed/main" },
  { classId: ClassID.AssetBundle, name: "editor/6000.3.25f1/uncompressed/shared" },
  { classId: ClassID.Material, name: "editor/6000.3.25f1/material/lz4/material" },
  // #41. MovieTexture has no fixture; MovieTexture.test.ts checks it the same way.
  { classId: ClassID.AudioClip, name: "editor/6000.3.25f1/lz4/audio" },
  { classId: ClassID.Font, name: "editor/6000.3.25f1/lz4/font" },
  { classId: ClassID.VideoClip, name: "editor/6000.3.25f1/lz4/video" },
  // #34.
  { classId: ClassID.Sprite, name: "editor/6000.3.25f1/sprite/sprites" },
  { classId: ClassID.SpriteAtlas, name: "editor/6000.3.25f1/sprite/sprites" },
];

for (const { classId, name } of NAMED) {
  const className = classIdName(classId)!;
  test(`read(): ${className} with a bad m_Name length throws CorruptError, not ""`, () => {
    const from = objectBytes(name, classId);
    const size = from.bytes.length;
    // A player build: m_Name's length is the object's first 4 bytes.
    const cases: [number, string][] = [
      [-1, "m_Name byte count -1 at offset 0 is negative"],
      [size, `m_Name byte count ${size} at offset 0 exceeds the ${size - 4} bytes left`],
    ];
    for (const [length, message] of cases) {
      const bytes = from.bytes.slice();
      new DataView(bytes.buffer).setInt32(0, length, true);
      const obj = synthetic(from, bytes, from.sf.version, from.sf.unityVersion);
      assert.throws(
        () => obj.read(),
        (err: unknown) =>
          err instanceof CorruptError &&
          err.message === `${className} ${obj.pathId} ${message}`,
        `length ${length}`,
      );
    }
  });
}
