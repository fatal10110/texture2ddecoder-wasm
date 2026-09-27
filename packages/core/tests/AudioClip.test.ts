// AudioClip (#41): the hardcoded reader, checked against the oracle's typetree
// dumps and raw-data hashes (R12), readTypeTree() on the same objects, and
// hand-built layouts from Unity's type trees (UnityPy's TPK data).

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadFixture, sha256 } from "../../../fixtures/helpers.js";
import {
  readAudioClip,
  readAudioClipData,
  type AudioClip,
  type AudioClipData,
} from "../src/classes/AudioClip.js";
import { load, type Env, type LoadedFile } from "../src/env.js";
import { CorruptError, ResourceNotFoundError, UnsupportedError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ClassID } from "../src/serialized/ClassID.js";
import { ObjectReader } from "../src/serialized/ObjectReader.js";
import { readSerializedFile, type UnityVersion } from "../src/serialized/SerializedFile.js";
import { fixturesWith, objectsOf } from "./class-readers.js";
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

const FIXTURES = fixturesWith(ClassID.AudioClip);

// --- every AudioClip of the editor fixtures ----------------------------------------

for (const name of FIXTURES) {
  test(`${name}: readAudioClip equals the golden dump, read() the golden audio bytes`, () => {
    const tree = goldenTree(name, ClassID.AudioClip);
    const objects = objectsOf(name, ClassID.AudioClip);
    // A PCM clip and a Vorbis one (fixtures/BUILDING.md section 11).
    assert.equal(objects.length, 2);
    for (const { env, reader, dump, enableTypeTree } of objects) {
      assert.ok(dump, `no golden dump for AudioClip ${reader.pathId}`);
      const clip = readAudioClip(reader);
      assert.equal(reader.position, reader.byteSize, "byteSize not consumed exactly");
      // Every field, in Unity's order, with the oracle's values.
      assert.deepEqual(Object.keys(clip), Object.keys(dump));
      assert.deepEqual(goldenForm(tree, clip), dump);
      if (enableTypeTree) {
        // The same object through its type tree: only m_Offset and m_Size differ,
        // bigints there (D9), numbers here.
        const typed = reader.readTypeTree();
        assert.deepEqual(Object.keys(clip), Object.keys(typed));
        assert.deepEqual(goldenForm(tree, clip), goldenForm(tree, typed));
      } else {
        assert.equal(reader.serializedType?.nodes, null, "the file has a type tree after all");
      }

      // obj.read(): the same fields, then the bytes of the .resource node.
      const data = reader.read<AudioClipData>();
      assert.deepEqual(Object.keys(data), [...Object.keys(clip), "audioData"]);
      const { audioData, ...fields } = data;
      assert.deepEqual(fields, clip);
      const want = rawGolden(name, reader.pathId);
      assert.ok(want, `no raw-data golden for AudioClip ${reader.pathId}`);
      assert.equal(audioData.length, want.size);
      assert.equal(sha256(audioData), want.sha256);
      // A view into the node, never a copy (R7).
      const node = env.files.find((f) => f.path === want.source);
      assert.ok(node, `no node ${want.source}`);
      assert.equal(audioData.buffer, node.data.buffer);
      assert.equal(audioData.byteOffset, node.data.byteOffset + clip.m_Resource!.m_Offset);
    }
  });
}

test("the AudioClip checks cover formats 21 and 22, typed, notypetree and version-stripped", () => {
  const seen = new Set<string>();
  const formats = new Set<number>();
  for (const name of FIXTURES) {
    for (const { formatVersion, unityVersion, enableTypeTree, reader } of objectsOf(
      name,
      ClassID.AudioClip,
    )) {
      const kind = !enableTypeTree ? "notypetree" : unityVersion === "0.0.0" ? "stripped" : "typed";
      if (kind === "stripped") assert.deepEqual(reader.version, [0, 0, 0, 0]);
      seen.add(`${formatVersion} ${kind}`);
      formats.add(readAudioClip(reader).m_CompressionFormat!);
    }
  }
  assert.deepEqual(
    [...seen].sort(),
    ["21 notypetree", "21 stripped", "21 typed", "22 notypetree", "22 stripped", "22 typed"],
  );
  // PCM and Vorbis, both FSB5 in the .resource.
  assert.deepEqual([...formats].sort(), [0, 1]);
});

test("the resolved audio is an FMOD sound bank (FSB5), as Unity 5+ writes it", () => {
  for (const { reader } of objectsOf("editor/6000.3.25f1/lz4/audio", ClassID.AudioClip)) {
    const { audioData } = reader.read<AudioClipData>();
    assert.equal(new TextDecoder().decode(audioData.subarray(0, 4)), "FSB5");
  }
});

// --- the resource file ------------------------------------------------------------

const AUDIO = "editor/2020.3.30f1/lz4/audio";

/** The fixture's SerializedFile and .resource nodes. */
function nodes(): { cab: LoadedFile; res: LoadedFile } {
  const { files } = load([{ name: AUDIO, data: loadFixture(AUDIO) }]);
  const res = files.find((f) => f.path.endsWith(".resource"));
  const cab = files.find((f) => f !== res);
  assert.ok(cab && res);
  return { cab, res };
}

test("read() finds the .resource passed as its own input next to a loose SerializedFile", () => {
  const { cab, res } = nodes();
  const env = load([cab, res].map(({ path, data }) => ({ name: path, data })));
  const clips = env.objects.filter((o) => o.type === ClassID.AudioClip);
  assert.equal(clips.length, 2);
  for (const obj of clips) {
    const { audioData, m_Resource } = obj.read<AudioClipData>();
    assert.equal(audioData.buffer, res.data.buffer);
    assert.equal(audioData.length, m_Resource!.m_Size);
    assert.equal(sha256(audioData), rawGolden(AUDIO, obj.pathId)!.sha256);
  }
});

test("read() without the .resource throws ResourceNotFoundError naming it", () => {
  const { cab, res } = nodes();
  const env = load([{ name: cab.path, data: cab.data }]);
  for (const obj of env.objects.filter((o) => o.type === ClassID.AudioClip)) {
    const { m_Resource } = readAudioClip(obj);
    assert.throws(
      () => obj.read(),
      (err: unknown) =>
        err instanceof ResourceNotFoundError &&
        err.path === m_Resource!.m_Source &&
        err.fileName === res.path,
    );
  }
});

test("a reader not built by load() has no .resource to look in", () => {
  const { cab } = nodes();
  const sf = readSerializedFile(cab.data);
  const info = sf.objects.find((o) => o.classId === ClassID.AudioClip)!;
  const reader = new ObjectReader(cab.data, sf, info);
  assert.throws(() => reader.read(), ResourceNotFoundError);
  assert.throws(() => readAudioClipData(reader, undefined), ResourceNotFoundError);
});

test("a .resource too short for m_Resource throws CorruptError", () => {
  const { cab, res } = nodes();
  const short = { name: res.path, data: res.data.subarray(0, res.data.length - 1) };
  const env = load([{ name: cab.path, data: cab.data }, short]);
  // The PCM clip is the one at the end of the file.
  const last = env.objects
    .filter((o) => o.type === ClassID.AudioClip)
    .find((o) => {
      const { m_Offset, m_Size } = readAudioClip(o).m_Resource!;
      return m_Offset + m_Size === res.data.length;
    });
  assert.ok(last);
  assert.throws(() => last.read(), CorruptError);
});

// --- layouts of Unity's type trees ---------------------------------------------------

const FROM = template("editor/6000.3.25f1/lz4/audio", ClassID.AudioClip);

/** 3.4 to 4.x (TPK 3.4.0, unchanged in 3.5.0 and 4.3.0 but for type names). */
const LEGACY = (w: Writer): AudioClip => ({
  m_Name: w.str("beep"),
  m_Format: w.i32(2),
  m_Type: w.i32(20),
  m_3D: w.bool(true),
  m_UseHardware: w.pad(w.bool(false)),
  m_Stream: w.i32(1),
  m_AudioData: w.pad(w.bytes(Uint8Array.of(1, 2, 3, 4, 5))),
});

/** 5.0 to 2017.1 (TPK 5.0.0f4; TPK's 5.6.0b5 lacks m_LoadInBackground). */
const L5_0 = (w: Writer): AudioClip => ({
  m_Name: w.str("beep"),
  m_LoadType: w.i32(1),
  m_Channels: w.i32(2),
  m_Frequency: w.i32(44100),
  m_BitsPerSample: w.i32(16),
  m_Length: w.f32(1.25),
  m_IsTrackerFormat: w.pad(w.bool(true)),
  m_SubsoundIndex: w.i32(3),
  m_PreloadAudioData: w.bool(true),
  m_LoadInBackground: w.bool(false),
  m_Legacy3D: w.pad(w.bool(true)),
  m_Resource: {
    m_Source: w.str("archive:/CAB-a/CAB-a.resource"),
    m_Offset: w.u64n(1234),
    m_Size: w.u64n(5678),
  },
  m_CompressionFormat: w.i32(1),
});

/** 2017.1 and later (TPK 2017.1.0b1, 2020.1.0a19's FileSize m_Offset the same bytes). */
const L2017_1 = (w: Writer): AudioClip => ({
  m_Name: w.str("beep"),
  m_LoadType: w.i32(1),
  m_Channels: w.i32(2),
  m_Frequency: w.i32(44100),
  m_BitsPerSample: w.i32(16),
  m_Length: w.f32(1.25),
  m_IsTrackerFormat: w.bool(true),
  m_Ambisonic: w.pad(w.bool(true)),
  m_SubsoundIndex: w.i32(3),
  m_PreloadAudioData: w.bool(true),
  m_LoadInBackground: w.bool(false),
  m_Legacy3D: w.pad(w.bool(true)),
  m_Resource: {
    m_Source: w.str("archive:/CAB-a/CAB-a.resource"),
    m_Offset: w.u64n(1234),
    m_Size: w.u64n(5678),
  },
  m_CompressionFormat: w.i32(1),
});

/** Each layout at its first version and the last one before the next, with its format. */
const LAYOUTS: { unity: UnityVersion; format: number; layout: (w: Writer) => AudioClip }[] = [
  { unity: [3, 4, 0, 1], format: 8, layout: LEGACY },
  { unity: [3, 5, 7, 1], format: 9, layout: LEGACY },
  { unity: [4, 7, 2, 1], format: 9, layout: LEGACY },
  { unity: [5, 0, 0, 1], format: 15, layout: L5_0 },
  { unity: [5, 6, 7, 1], format: 17, layout: L5_0 },
  { unity: [2017, 1, 0, 1], format: 17, layout: L2017_1 },
  { unity: [2019, 4, 41, 2], format: 21, layout: L2017_1 },
  { unity: [6000, 3, 25, 1], format: 22, layout: L2017_1 },
];

for (const { unity, format, layout } of LAYOUTS) {
  test(`Unity ${unity.slice(0, 3).join(".")}: the player layout of Unity's type tree`, () => {
    const { bytes, expected } = build(layout);
    const reader = readerOf(FROM, bytes, { unity, format });
    const clip = readAudioClip(reader);
    assert.deepEqual(Object.keys(clip), Object.keys(expected));
    assert.deepEqual(clip, expected);
    assert.equal(reader.remaining, 0);
  });
}

test("before 5.0: read() gives the inline m_AudioData, a view into the object", () => {
  const { bytes, expected } = build(LEGACY);
  const reader = readerOf(FROM, bytes, { unity: [4, 7, 2, 1], format: 9 });
  const data = reader.read<AudioClipData>();
  assert.deepEqual(data.audioData, expected.m_AudioData);
  assert.equal(data.audioData, data.m_AudioData);
  assert.equal(data.audioData.buffer, bytes.buffer);
});

test("before 5.0, 1 byte of data and its padding read inline, not as a streamed offset", () => {
  // 4 bytes follow the count either way; upstream calls them the padded data.
  const { bytes, expected } = build((w) => ({
    m_Name: w.str("beep"),
    m_Format: w.i32(2),
    m_Type: w.i32(20),
    m_3D: w.bool(true),
    m_UseHardware: w.pad(w.bool(false)),
    m_Stream: w.i32(1),
    m_AudioData: w.pad(w.bytes(Uint8Array.of(9))),
  }));
  const clip = readAudioClip(readerOf(FROM, bytes, { unity: [4, 7, 2, 1], format: 9 }));
  assert.deepEqual(clip, expected);
});

// --- streamed before 5.0: the SerializedFile's own .resS (#138) ---------------------

/** The sound a hand-built streamed clip points at: `SIZE` bytes at `OFFSET` of its .resS. */
const OFFSET = 12;
const SIZE = 21;

/**
 * A streamed clip of 3.2 to 4.x as upstream reads it: `m_AudioData`'s byte
 * count, then a `UInt32` offset where the bytes would be. No editor fixture
 * writes this (they are 2019.4 and later), so the layout is upstream's.
 */
const STREAMED = (w: Writer): AudioClip => ({
  m_Name: w.str("beep"),
  m_Format: w.i32(2),
  m_Type: w.i32(14),
  m_3D: w.bool(true),
  m_UseHardware: w.pad(w.bool(false)),
  m_Stream: w.i32(2),
  m_Size: w.i32(SIZE),
  m_Offset: w.u32(OFFSET),
});

/** A `.resS` whose every byte differs from its neighbours, so a wrong range shows. */
const RES_S = Uint8Array.from({ length: 48 }, (_, i) => (i * 7 + 1) & 0xff);

/** Header bytes: the file and bundle headers mix byte orders. */
class Bytes {
  private readonly out: number[] = [];

  u8(v: number): this {
    this.out.push(v & 0xff);
    return this;
  }

  u16le(v: number): this {
    return this.u8(v).u8(v >>> 8);
  }

  u32le(v: number): this {
    return this.u16le(v).u16le(v >>> 16);
  }

  u32be(v: number): this {
    return this.u8(v >>> 24).u8(v >>> 16).u8(v >>> 8).u8(v);
  }

  cstr(text: string): this {
    for (const c of text) this.u8(c.charCodeAt(0));
    return this.u8(0);
  }

  raw(data: Uint8Array): this {
    this.out.push(...data);
    return this;
  }

  get length(): number {
    return this.out.length;
  }

  done(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

/**
 * A little-endian format-9 SerializedFile (Unity 3.5 to 4.x) written by
 * Unity 4.7.2f1, with no type tree and one object: `object`, an AudioClip of
 * path id 1.
 */
function format9File(object: Uint8Array): Uint8Array {
  const metadata = new Bytes()
    .cstr("4.7.2f1")
    .u32le(BuildTarget.StandaloneWindows64)
    .u32le(0) // types
    .u32le(0) // bigIDEnabled
    .u32le(1) // objects
    .u32le(1) // m_PathID
    .u32le(0) // byteStart, relative to m_DataOffset
    .u32le(object.length) // byteSize
    .u32le(ClassID.AudioClip) // typeID
    .u16le(ClassID.AudioClip) // classID
    .u16le(0) // isDestroyed
    .u32le(0) // externals
    .cstr("") // userInformation
    .done();
  // The object data starts on a 16-byte boundary, as Unity writes it.
  const dataOffset = Math.ceil((20 + metadata.length) / 16) * 16;
  return new Bytes()
    .u32be(metadata.length)
    .u32be(dataOffset + object.length) // file size
    .u32be(9) // m_Version
    .u32be(dataOffset)
    .u32be(0) // endianess (little), reserved
    .raw(metadata)
    .raw(new Uint8Array(dataOffset - 20 - metadata.length))
    .raw(object)
    .done();
}

/** An uncompressed format-3 `UnityRaw` bundle, as Unity 4.x builds one, of `nodes`. */
function unityRaw(nodes: { path: string; data: Uint8Array }[]): Uint8Array {
  // Node offsets count from the start of the level, which opens with the directory.
  let directorySize = 4;
  for (const { path } of nodes) directorySize += path.length + 1 + 8;
  const level = new Bytes().u32be(nodes.length);
  let offset = directorySize;
  for (const { path, data } of nodes) {
    level.cstr(path).u32be(offset).u32be(data.length);
    offset += data.length;
  }
  for (const { data } of nodes) level.raw(data);

  const header = new Bytes().cstr("UnityRaw").u32be(3).cstr("3.x.x").cstr("4.7.2f1");
  // Eight words follow: minimumStreamedBytes, headerSize, levels to download,
  // level count, the one level's two sizes, completeFileSize, fileInfoHeaderSize.
  const headerSize = header.length + 4 * 8;
  const total = headerSize + level.length;
  return header
    .u32be(total)
    .u32be(headerSize)
    .u32be(1)
    .u32be(1)
    .u32be(level.length)
    .u32be(level.length)
    .u32be(total)
    .u32be(directorySize)
    .raw(level.done())
    .done();
}

/** The one AudioClip of an env. */
function clipOf(env: Env): ObjectReader {
  const [obj, ...more] = env.objects;
  assert.ok(obj && more.length === 0 && obj.type === ClassID.AudioClip);
  return obj;
}

/** `audioData` is the referenced range of `resS`, `SIZE` bytes at `OFFSET`, as a view (R7). */
function assertReferencedRange(data: AudioClipData, resS: Uint8Array): void {
  assert.deepEqual(data.audioData, resS.subarray(OFFSET, OFFSET + SIZE));
  assert.equal(data.audioData.buffer, resS.buffer);
  assert.equal(data.audioData.byteOffset, resS.byteOffset + OFFSET);
}

test("before 5.0, a streamed clip reads its count as m_Size, then a UInt32 m_Offset", () => {
  const { bytes, expected } = build(STREAMED);
  for (const [unity, format] of [
    [[3, 4, 0, 1], 8],
    [[4, 7, 2, 1], 9],
  ] as [UnityVersion, number][]) {
    const reader = readerOf(FROM, bytes, { unity, format });
    const clip = readAudioClip(reader);
    assert.deepEqual(Object.keys(clip), Object.keys(expected));
    assert.deepEqual(clip, expected);
    assert.equal(reader.remaining, 0);
  }
});

test("before 5.0, a streamed clip in a bundle reads <file>.resS: the referenced range", () => {
  const cab = format9File(build(STREAMED).bytes);
  const bundle = unityRaw([
    { path: "CAB-4f1e", data: cab },
    { path: "CAB-4f1e.resS", data: RES_S },
  ]);
  const env = load([{ name: "clip.unity3d", data: bundle }]);
  const resS = env.files.find((f) => f.path === "CAB-4f1e.resS");
  assert.ok(resS);
  const obj = clipOf(env);
  assert.equal(obj.fileName, "CAB-4f1e");
  const data = obj.read<AudioClipData>();
  const { audioData, ...fields } = data;
  assert.deepEqual(Object.keys(data), [...Object.keys(fields), "audioData"]);
  assert.deepEqual(fields, build(STREAMED).expected);
  assert.deepEqual(audioData, RES_S.subarray(OFFSET, OFFSET + SIZE));
  assertReferencedRange(data, resS.data);
});

test("before 5.0, a streamed clip of a loose file reads the <file>.resS passed next to it", () => {
  const file = format9File(build(STREAMED).bytes);
  const resS = RES_S.slice();
  const env = load([
    { name: "sharedassets0.assets", data: file },
    { name: "sharedassets0.assets.resS", data: resS },
  ]);
  assert.equal(clipOf(env).fileName, "sharedassets0.assets");
  assertReferencedRange(clipOf(env).read<AudioClipData>(), resS);

  // Passed under a path, the file is still named by its last component.
  const nested = load([
    { name: "Game_Data/sharedassets0.assets", data: file },
    { name: "Game_Data/sharedassets0.assets.resS", data: resS },
  ]);
  assert.equal(clipOf(nested).fileName, "sharedassets0.assets");
  assertReferencedRange(clipOf(nested).read<AudioClipData>(), resS);
});

test("before 5.0, two bundles of one file name each read their own .resS", () => {
  // The env's container rule, which `readResource` applies for every class.
  const cab = format9File(build(STREAMED).bytes);
  const other = RES_S.map((b) => b ^ 0xff);
  const env = load([
    {
      name: "a.unity3d",
      data: unityRaw([
        { path: "CAB-same", data: cab },
        { path: "CAB-same.resS", data: other },
      ]),
    },
    {
      name: "b.unity3d",
      data: unityRaw([
        { path: "CAB-same", data: cab },
        { path: "CAB-same.resS", data: RES_S },
      ]),
    },
  ]);
  const [a, b] = env.objects;
  const [resA, resB] = env.files.filter((f) => f.path === "CAB-same.resS");
  assert.ok(a && b && resA && resB);
  assertReferencedRange(a.read<AudioClipData>(), resA.data);
  assertReferencedRange(b.read<AudioClipData>(), resB.data);
  assert.notDeepEqual(a.read<AudioClipData>().audioData, b.read<AudioClipData>().audioData);
});

test("before 5.0, a streamed clip without its .resS: read() throws ResourceNotFoundError", () => {
  const cab = format9File(build(STREAMED).bytes);
  const bundle = unityRaw([{ path: "CAB-4f1e", data: cab }]);
  const cases: [Env, string][] = [
    [load([{ name: "clip.unity3d", data: bundle }]), "CAB-4f1e.resS"],
    [load([{ name: "sharedassets0.assets", data: cab }]), "sharedassets0.assets.resS"],
  ];
  for (const [env, name] of cases) {
    const obj = clipOf(env);
    // The fields read without it; only the sound needs the file.
    assert.deepEqual(readAudioClip(obj), build(STREAMED).expected);
    assert.throws(
      () => obj.read(),
      (err: unknown) =>
        err instanceof ResourceNotFoundError &&
        err.path === name &&
        err.fileName === name &&
        err.message.includes(name),
    );
  }
});

test("before 5.0, a streamed clip read by a reader not built by load() has no .resS", () => {
  const data = format9File(build(STREAMED).bytes);
  const sf = readSerializedFile(data);
  const named = new ObjectReader(data, sf, sf.objects[0]!, "sharedassets0.assets");
  assert.equal(named.fileName, "sharedassets0.assets");
  for (const read of [() => named.read(), () => readAudioClipData(named, undefined)]) {
    assert.throws(
      read,
      (err: unknown) =>
        err instanceof ResourceNotFoundError && err.fileName === "sharedassets0.assets.resS",
    );
  }
  // Built without a file name: nothing to find either way.
  const unnamed = new ObjectReader(data, sf, sf.objects[0]!);
  assert.equal(unnamed.fileName, "");
  assert.throws(() => unnamed.read(), ResourceNotFoundError);
});

test("before 5.0, a streamed range past the end of the .resS throws CorruptError", () => {
  const env = load([
    { name: "sharedassets0.assets", data: format9File(build(STREAMED).bytes) },
    { name: "sharedassets0.assets.resS", data: RES_S.subarray(0, OFFSET + SIZE - 1) },
  ]);
  assert.throws(
    () => clipOf(env).read(),
    /sharedassets0\.assets\.resS: resource range 12\+21 runs past the end of 32 bytes/,
  );
});

// --- refusals ---------------------------------------------------------------------

const STRIPPED: UnityVersion = [0, 0, 0, 0];

test('Unity "0.0.0" in a file of format 18 or later: the 2017.1 layout', () => {
  for (const format of [18, 21, 22]) {
    const { bytes, expected } = build(L2017_1);
    const reader = readerOf(FROM, bytes, { unity: STRIPPED, text: "0.0.0", format });
    assert.deepEqual(readAudioClip(reader), expected, `format ${format}`);
  }
});

test('Unity "0.0.0": an object that does not fit the 2017.1 layout is refused, not corrupt', () => {
  // #36 as amended on #136: the layout is inferred from the format, so a misfit
  // means "not that layout", which the file cannot tell apart from corruption.
  const { bytes } = build(L2017_1);
  const misfits: [string, Uint8Array][] = [
    ["4 bytes left over", withTail(bytes, 0, 0, 0, 0)],
    ["1 byte left over", withTail(bytes, 0)],
    ["4 bytes short", bytes.subarray(0, bytes.length - 4)],
    ["cut inside m_Resource", bytes.subarray(0, bytes.length - 12)],
    ["the 5.0 layout's bytes, 2 bytes short", build(L5_0).bytes.subarray(0, bytes.length - 2)],
  ];
  for (const format of [18, 22]) {
    for (const [why, data] of misfits) {
      const reader = readerOf(FROM, data, { unity: STRIPPED, text: "0.0.0", format });
      assert.throws(
        () => readAudioClip(reader),
        (err: unknown) =>
          versionRefusal("0.0.0")(err) &&
          (err as UnsupportedError).message.includes("does not fit 2017.1's AudioClip layout"),
        `format ${format}: ${why}`,
      );
    }
  }
  // m_Name comes before any layout choice: a bad one is still corrupt.
  const badName = bytes.slice();
  new DataView(badName.buffer).setInt32(0, -1, true);
  const reader = readerOf(FROM, badName, { unity: STRIPPED, text: "0.0.0", format: 22 });
  assert.throws(() => readAudioClip(reader), CorruptError);
});

/** Refused with the file's own version string, per the #36 rule. */
const REFUSED: { unity: UnityVersion; text: string; format: number; why: string }[] = [
  { unity: STRIPPED, text: "0.0.0", format: 17, why: "[0,0,0,0] in format 17 (5.5 to 2018.4)" },
  { unity: STRIPPED, text: "0.0.0", format: 15, why: "[0,0,0,0] in format 15 (5.x)" },
  { unity: STRIPPED, text: "2.5.0f5", format: 6, why: "[0,0,0,0] in a format 6 loose file" },
  { unity: [3, 3, 0, 1], text: "3.3.0f1", format: 8, why: "a known version below 3.4" },
];

for (const { unity, text, format, why } of REFUSED) {
  test(`${why}: UnsupportedError("Unity version", "${text}")`, () => {
    for (const layout of [LEGACY, L5_0, L2017_1]) {
      const reader = readerOf(FROM, build(layout).bytes, { unity, text, format });
      assert.throws(() => readAudioClip(reader), versionRefusal(text));
      assert.throws(() => reader.read(), versionRefusal(text));
    }
  });
}

test("an editor file (NoTarget) is refused: its AudioClip has editor-only fields", () => {
  const reader = readerOf(FROM, build(L2017_1).bytes, {
    unity: [2019, 4, 41, 2],
    platform: BuildTarget.NoTarget,
  });
  assert.throws(
    () => readAudioClip(reader),
    (err: unknown) =>
      err instanceof UnsupportedError && err.kind === "build target" && err.found === "NoTarget",
  );
});

// --- corrupt objects ----------------------------------------------------------------

test("every cut through an AudioClip throws CorruptError", () => {
  const { bytes } = build(L2017_1);
  const unity: UnityVersion = [6000, 3, 25, 1];
  assert.deepEqual(readAudioClip(readerOf(FROM, bytes, { unity })), build(L2017_1).expected);
  for (let cut = 0; cut < bytes.length; cut++) {
    const reader = readerOf(FROM, bytes.subarray(0, cut), { unity });
    assert.throws(() => readAudioClip(reader), CorruptError, `cut at ${cut}`);
  }
  const legacy = build(LEGACY).bytes;
  // The last 3 bytes of the legacy layout are m_AudioData's padding. A cut that
  // leaves exactly 4 bytes after the count (at 32) has the shape of a streamed
  // clip, which upstream reads as one, so it reads as that instead (#138).
  for (let cut = 0; cut < legacy.length - 3; cut++) {
    const reader = readerOf(FROM, legacy.subarray(0, cut), { unity: [4, 7, 2, 1], format: 9 });
    if (cut === 32) {
      const clip = readAudioClip(reader);
      assert.equal(clip.m_Size, 5, "legacy cut at 32");
      assert.equal(clip.m_AudioData, undefined, "legacy cut at 32");
      continue;
    }
    assert.throws(() => readAudioClip(reader), CorruptError, `legacy cut at ${cut}`);
  }
});

test("bytes left after m_CompressionFormat, or after m_AudioData, throw CorruptError", () => {
  const reader = readerOf(FROM, withTail(build(L2017_1).bytes, 0, 0, 0, 0), {
    unity: [6000, 3, 25, 1],
  });
  assert.throws(() => readAudioClip(reader), /AudioClip -?\d+ ends at \d+ of its \d+ bytes/);
  const legacy = readerOf(FROM, withTail(build(LEGACY).bytes, 0, 0, 0, 0, 0, 0, 0, 0), {
    unity: [4, 7, 2, 1],
    format: 9,
  });
  assert.throws(() => readAudioClip(legacy), CorruptError);
});

test("before 5.0, a negative m_AudioData count throws CorruptError", () => {
  const { bytes } = build((w) => ({
    m_Name: w.str("beep"),
    m_Format: w.i32(2),
    m_Type: w.i32(20),
    m_3D: w.bool(true),
    m_UseHardware: w.pad(w.bool(false)),
    m_Stream: w.i32(1),
    count: w.i32(-1),
  }));
  const reader = readerOf(FROM, bytes, { unity: [4, 7, 2, 1], format: 9 });
  assert.throws(() => readAudioClip(reader), /m_AudioData byte count -1 at offset 24/);
});

test("m_Resource.m_Offset and m_Size read up to 2^53 - 1 and throw CorruptError above", () => {
  const unity: UnityVersion = [6000, 3, 25, 1];
  const { bytes } = build(L2017_1);
  // The object ends with m_Offset, m_Size (8 bytes each) and m_CompressionFormat.
  const at = bytes.length - 4 - 16;
  for (const [field, offset] of [["m_Offset", at], ["m_Size", at + 8]] as const) {
    const copy = bytes.slice();
    const view = new DataView(copy.buffer);
    view.setBigUint64(offset, 2n ** 53n - 1n, true);
    assert.equal(readAudioClip(readerOf(FROM, copy, { unity })).m_Resource![field], 2 ** 53 - 1);
    view.setBigUint64(offset, 2n ** 53n, true);
    assert.throws(
      () => readAudioClip(readerOf(FROM, copy, { unity })),
      new RegExp(`m_Resource\\.${field} 9007199254740992 is not a byte offset below 2\\^53`),
    );
  }
});

test("read() of a clip with no data throws CorruptError (R9)", () => {
  // From 5.0: an empty m_Resource.m_Source, which upstream would read past the
  // object's end for.
  const empty = build((w) => ({
    m_Name: w.str("beep"),
    m_LoadType: w.i32(1),
    m_Channels: w.i32(2),
    m_Frequency: w.i32(44100),
    m_BitsPerSample: w.i32(16),
    m_Length: w.f32(1.25),
    m_IsTrackerFormat: w.bool(true),
    m_Ambisonic: w.pad(w.bool(true)),
    m_SubsoundIndex: w.i32(3),
    m_PreloadAudioData: w.bool(true),
    m_LoadInBackground: w.bool(false),
    m_Legacy3D: w.pad(w.bool(true)),
    m_Resource: { m_Source: w.str(""), m_Offset: w.u64n(0), m_Size: w.u64n(64) },
    m_CompressionFormat: w.i32(1),
  }));
  const reader = readerOf(FROM, empty.bytes, { unity: [6000, 3, 25, 1] });
  assert.deepEqual(readAudioClip(reader), empty.expected);
  assert.throws(() => reader.read(), /AudioClip -?\d+ has no data: its resource path is empty/);

  // Before 5.0: an empty m_AudioData.
  const none = build((w) => ({
    m_Name: w.str("beep"),
    m_Format: w.i32(2),
    m_Type: w.i32(20),
    m_3D: w.bool(true),
    m_UseHardware: w.pad(w.bool(false)),
    m_Stream: w.i32(1),
    m_AudioData: w.bytes(new Uint8Array(0)),
  }));
  const legacy = readerOf(FROM, none.bytes, { unity: [4, 7, 2, 1], format: 9 });
  assert.throws(() => legacy.read(), /AudioClip -?\d+ has no data: m_AudioData is empty/);
});
