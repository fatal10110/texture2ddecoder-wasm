// VideoClip (#41): the hardcoded reader, checked against the oracle's typetree
// dumps and raw-data hashes (R12), readTypeTree() on the same objects, and
// hand-built layouts from Unity's type trees (UnityPy's TPK data).

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadFixture, sha256 } from "../../../fixtures/helpers.js";
import {
  readVideoClip,
  readVideoClipData,
  type VideoClip,
  type VideoClipData,
} from "../src/classes/VideoClip.js";
import { load, type LoadedFile } from "../src/env.js";
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

const FIXTURES = fixturesWith(ClassID.VideoClip);

// --- every VideoClip of the editor fixtures ----------------------------------------

for (const name of FIXTURES) {
  test(`${name}: readVideoClip equals the golden dump, read() the golden video bytes`, () => {
    const tree = goldenTree(name, ClassID.VideoClip);
    const objects = objectsOf(name, ClassID.VideoClip);
    assert.equal(objects.length, 1);
    for (const { env, reader, dump, enableTypeTree } of objects) {
      assert.ok(dump, `no golden dump for VideoClip ${reader.pathId}`);
      const clip = readVideoClip(reader);
      assert.equal(reader.position, reader.byteSize, "byteSize not consumed exactly");
      // Every field, in Unity's order, with the oracle's values.
      assert.deepEqual(Object.keys(clip), Object.keys(dump));
      assert.deepEqual(goldenForm(tree, clip), dump);
      if (enableTypeTree) {
        // Through the type tree: only m_Offset and m_Size differ (bigints there, D9).
        const typed = reader.readTypeTree();
        assert.deepEqual(Object.keys(clip), Object.keys(typed));
        assert.deepEqual(goldenForm(tree, clip), goldenForm(tree, typed));
        assert.deepEqual(clip.m_FrameCount, typed.m_FrameCount);
      } else {
        assert.equal(reader.serializedType?.nodes, null, "the file has a type tree after all");
      }

      const data = reader.read<VideoClipData>();
      assert.deepEqual(Object.keys(data), [...Object.keys(clip), "videoData"]);
      const { videoData, ...fields } = data;
      assert.deepEqual(fields, clip);
      const want = rawGolden(name, reader.pathId);
      assert.ok(want, `no raw-data golden for VideoClip ${reader.pathId}`);
      assert.equal(videoData.length, want.size);
      assert.equal(sha256(videoData), want.sha256);
      // A view into the .resource node, never a copy (R7).
      const node = env.files.find((f) => f.path === want.source);
      assert.ok(node, `no node ${want.source}`);
      assert.equal(videoData.buffer, node.data.buffer);
      assert.equal(videoData.byteOffset, node.data.byteOffset + clip.m_ExternalResources.m_Offset);
    }
  });
}

test("the VideoClip checks cover formats 21 and 22, typed, notypetree and version-stripped", () => {
  const seen = new Set<string>();
  for (const name of FIXTURES) {
    for (const { formatVersion, unityVersion, enableTypeTree, reader } of objectsOf(
      name,
      ClassID.VideoClip,
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

/** The one VideoClip of a fixture. */
function videoOf(name: string): ObjectReader {
  const [object, ...more] = objectsOf(name, ClassID.VideoClip);
  assert.ok(object && more.length === 0);
  return object.reader;
}

test("2019.4 has m_sRGB and no m_VideoShaders (upstream reads m_sRGB from 2020.1)", () => {
  const clip = readVideoClip(videoOf("editor/2019.4.41f2/lz4/video"));
  assert.equal(clip.m_sRGB, true);
  assert.ok(!("m_VideoShaders" in clip));
  assert.deepEqual(readVideoClip(videoOf("editor/2020.3.30f1/lz4/video")).m_VideoShaders, []);
});

test("the video is the imported WebM, as it went in", () => {
  const { videoData } = videoOf("editor/6000.3.25f1/lz4/video").read<VideoClipData>();
  // EBML magic; the whole file's hash is the golden's and fixtures/BUILDING.md's.
  assert.deepEqual([...videoData.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
});

// --- the resource file ------------------------------------------------------------

const VIDEO = "editor/2019.4.41f2/lz4/video";

function nodes(): { cab: LoadedFile; res: LoadedFile } {
  const { files } = load([{ name: VIDEO, data: loadFixture(VIDEO) }]);
  const res = files.find((f) => f.path.endsWith(".resource"));
  const cab = files.find((f) => f !== res);
  assert.ok(cab && res);
  return { cab, res };
}

test("read() finds the .resource passed as its own input next to a loose SerializedFile", () => {
  const { cab, res } = nodes();
  const env = load([cab, res].map(({ path, data }) => ({ name: path, data })));
  const obj = env.objects.find((o) => o.type === ClassID.VideoClip)!;
  const { videoData } = obj.read<VideoClipData>();
  assert.equal(videoData.buffer, res.data.buffer);
  assert.equal(sha256(videoData), rawGolden(VIDEO, obj.pathId)!.sha256);
});

test("read() without the .resource throws ResourceNotFoundError naming it", () => {
  const { cab, res } = nodes();
  const obj = load([{ name: cab.path, data: cab.data }]).objects.find(
    (o) => o.type === ClassID.VideoClip,
  )!;
  const { m_Source } = readVideoClip(obj).m_ExternalResources;
  assert.throws(
    () => obj.read(),
    (err: unknown) =>
      err instanceof ResourceNotFoundError && err.path === m_Source && err.fileName === res.path,
  );
});

test("a reader not built by load() has no .resource to look in", () => {
  const { cab } = nodes();
  const sf = readSerializedFile(cab.data);
  const info = sf.objects.find((o) => o.classId === ClassID.VideoClip)!;
  const reader = new ObjectReader(cab.data, sf, info);
  assert.throws(() => reader.read(), ResourceNotFoundError);
  assert.throws(() => readVideoClipData(reader, undefined), ResourceNotFoundError);
});

test("a .resource too short for m_ExternalResources throws CorruptError", () => {
  const { cab, res } = nodes();
  const short = { name: res.path, data: res.data.subarray(0, res.data.length - 1) };
  const obj = load([{ name: cab.path, data: cab.data }, short]).objects.find(
    (o) => o.type === ClassID.VideoClip,
  )!;
  assert.throws(() => obj.read(), CorruptError);
});

// --- layouts of Unity's type trees ---------------------------------------------------

const FROM = template("editor/6000.3.25f1/lz4/video", ClassID.VideoClip);

/** The fields every layout starts with, through `Height`. */
const head = (w: Writer) => ({
  m_Name: w.str("clip"),
  m_OriginalPath: w.str("Assets/Movies/clip.mp4"),
  m_ProxyWidth: w.u32(64),
  m_ProxyHeight: w.u32(36),
  Width: w.u32(1280),
  Height: w.u32(720),
});

/** `m_FrameRate` to `m_AudioLanguage`: 3 tracks, so the UInt16 array needs padding. */
const middle = (w: Writer) => ({
  m_FrameRate: w.f64(29.97),
  m_FrameCount: w.u64(2n ** 60n + 5n),
  m_Format: w.i32(1),
  m_AudioChannelCount: w.pad(w.array([1, 2, 6], (v) => w.u16(v))),
  m_AudioSampleRate: w.array([22050, 44100, 48000], (v) => w.u32(v)),
  m_AudioLanguage: w.array(["en", "fr", "und"], (v) => w.str(v)),
});

const resource = (w: Writer) => ({
  m_ExternalResources: {
    m_Source: w.str("archive:/CAB-v/CAB-v.resource"),
    m_Offset: w.u64n(96),
    m_Size: w.u64n(4860),
  },
  m_HasSplitAlpha: w.bool(true),
});

/** 5.6 to 2017.1 (TPK 5.6.0; 2017.1.0b1 only adds Array align flags). */
const L5_6 = (w: Writer): VideoClip => ({ ...head(w), ...middle(w), ...resource(w) });
/** 2017.2 (TPK 2017.2.0b2): the pixel aspect ratio. */
const L2017_2 = (w: Writer): VideoClip => ({
  ...head(w),
  m_PixelAspecRatioNum: w.u32(16),
  m_PixelAspecRatioDen: w.u32(9),
  ...middle(w),
  ...resource(w),
});
/** 2019.2 (TPK 2019.2.0a6): m_sRGB, last, not padded. */
const L2019_2 = (w: Writer): VideoClip => ({ ...L2017_2(w), m_sRGB: w.bool(false) });
/** 2020.1 (TPK 2020.1.0a7; a19's FileSize m_Offset is the same bytes): m_VideoShaders. */
const L2020_1 = (w: Writer): VideoClip => ({
  ...head(w),
  m_PixelAspecRatioNum: w.u32(16),
  m_PixelAspecRatioDen: w.u32(9),
  ...middle(w),
  m_VideoShaders: w.array([7n, -8n], (id) => w.pptr(0, id)),
  ...resource(w),
  m_sRGB: w.bool(false),
});

const LAYOUTS: { unity: UnityVersion; format: number; layout: (w: Writer) => VideoClip }[] = [
  { unity: [5, 6, 0, 1], format: 17, layout: L5_6 },
  { unity: [2017, 1, 5, 1], format: 17, layout: L5_6 },
  { unity: [2017, 2, 0, 1], format: 17, layout: L2017_2 },
  { unity: [2019, 1, 14, 1], format: 19, layout: L2017_2 },
  { unity: [2019, 2, 0, 1], format: 20, layout: L2019_2 },
  { unity: [2019, 4, 41, 2], format: 21, layout: L2019_2 },
  { unity: [2020, 1, 0, 1], format: 22, layout: L2020_1 },
  { unity: [6000, 3, 25, 1], format: 22, layout: L2020_1 },
];

for (const { unity, format, layout } of LAYOUTS) {
  test(`Unity ${unity.slice(0, 3).join(".")}: the layout of Unity's type tree`, () => {
    const { bytes, expected } = build(layout);
    const reader = readerOf(FROM, bytes, { unity, format });
    const clip = readVideoClip(reader);
    assert.deepEqual(Object.keys(clip), Object.keys(expected));
    assert.deepEqual(clip, expected);
    assert.equal(reader.remaining, 0);
  });
}

test("an editor file (NoTarget): the EditorExtension header, then the VideoClip fields", () => {
  const { bytes, expected } = build((w) => ({
    m_ObjectHideFlags: w.u32(0),
    m_CorrespondingSourceObject: w.pptr(0, 0n),
    m_PrefabInstance: w.pptr(0, 0n),
    m_PrefabAsset: w.pptr(0, 0n),
    ...L2019_2(w),
  }));
  const reader = readerOf(FROM, bytes, {
    unity: [2019, 4, 41, 2],
    format: 21,
    platform: BuildTarget.NoTarget,
  });
  const clip = readVideoClip(reader);
  assert.deepEqual(Object.keys(clip), Object.keys(expected));
  assert.deepEqual(clip, expected);
});

// --- version-stripped files (#36 rule) ------------------------------------------------

const STRIPPED: UnityVersion = [0, 0, 0, 0];

test('Unity "0.0.0": format 22 has 2020.1\'s layout, format 21 2019.2\'s', () => {
  for (const [format, layout] of [[22, L2020_1], [21, L2019_2]] as const) {
    const { bytes, expected } = build(layout);
    const clip = readVideoClip(readerOf(FROM, bytes, { unity: STRIPPED, text: "0.0.0", format }));
    assert.deepEqual(clip, expected, `format ${format}`);
  }
});

test('Unity "0.0.0": an object that does not fit its format\'s layout is refused, not corrupt', () => {
  // #36 as amended on #136: the layout is inferred from the format.
  const v2019 = build(L2019_2).bytes;
  const v2020 = build(L2020_1).bytes;
  const misfits: [number, string, Uint8Array][] = [
    [22, "2019.2's bytes", v2019],
    [22, "1 byte left over", withTail(v2020, 0)],
    [22, "cut inside m_ExternalResources", v2020.subarray(0, v2020.length - 10)],
    [21, "2020.1's bytes", v2020],
    [21, "1 byte left over", withTail(v2019, 1)],
    [21, "1 byte short", v2019.subarray(0, v2019.length - 1)],
  ];
  for (const [format, why, data] of misfits) {
    const reader = readerOf(FROM, data, { unity: STRIPPED, text: "0.0.0", format });
    const layout = format === 21 ? "2019.2" : "2020.1";
    assert.throws(
      () => readVideoClip(reader),
      (err: unknown) =>
        versionRefusal("0.0.0")(err) &&
        (err as UnsupportedError).message.includes(`does not fit ${layout}'s VideoClip layout`),
      `format ${format}: ${why}`,
    );
  }
});

const REFUSED: { unity: UnityVersion; text: string; format: number; why: string }[] = [
  { unity: STRIPPED, text: "0.0.0", format: 20, why: "[0,0,0,0] in format 20 (2019.2)" },
  { unity: STRIPPED, text: "0.0.0", format: 17, why: "[0,0,0,0] in format 17" },
  { unity: STRIPPED, text: "2.5.0f5", format: 6, why: "[0,0,0,0] in a format 6 loose file" },
  { unity: [5, 5, 3, 1], text: "5.5.3f1", format: 17, why: "a version before 5.6" },
];

for (const { unity, text, format, why } of REFUSED) {
  test(`${why}: UnsupportedError("Unity version", "${text}")`, () => {
    for (const layout of [L5_6, L2019_2, L2020_1]) {
      const reader = readerOf(FROM, build(layout).bytes, { unity, text, format });
      assert.throws(() => readVideoClip(reader), versionRefusal(text));
      assert.throws(() => reader.read(), versionRefusal(text));
    }
  });
}

// --- corrupt objects ----------------------------------------------------------------

test("every cut through a VideoClip throws CorruptError", () => {
  const { bytes } = build(L2020_1);
  const unity: UnityVersion = [6000, 3, 25, 1];
  readVideoClip(readerOf(FROM, bytes, { unity }));
  // The object ends with two unpadded bools: every cut loses data.
  for (let cut = 0; cut < bytes.length; cut++) {
    const reader = readerOf(FROM, bytes.subarray(0, cut), { unity });
    assert.throws(() => readVideoClip(reader), CorruptError, `cut at ${cut}`);
  }
});

test("bytes left after the last bool throw CorruptError", () => {
  for (const [unity, layout] of [
    [[2019, 4, 41, 2], L2019_2],
    [[5, 6, 0, 1], L5_6],
  ] as const) {
    const reader = readerOf(FROM, withTail(build(layout).bytes, 0), { unity: [...unity] });
    assert.throws(() => readVideoClip(reader), /VideoClip -?\d+ ends at \d+ of its \d+ bytes/);
  }
});

test("a negative m_AudioChannelCount count throws CorruptError", () => {
  const { bytes } = build((w) => ({ ...head(w), m_Rate: w.f64(1), n: w.u64(1n), f: w.i32(1) }));
  const reader = readerOf(FROM, withTail(bytes, 0xff, 0xff, 0xff, 0xff), {
    unity: [5, 6, 0, 1],
  });
  assert.throws(() => readVideoClip(reader), /m_AudioChannelCount count -1 at offset \d+ is neg/);
});

test("m_ExternalResources.m_Offset and m_Size throw CorruptError from 2^53", () => {
  const unity: UnityVersion = [6000, 3, 25, 1];
  const { bytes, expected } = build(L2020_1);
  // The object ends with m_Offset, m_Size (8 bytes each) and two bools.
  const at = bytes.length - 2 - 16;
  assert.equal(new DataView(bytes.buffer).getBigUint64(at, true), 96n);
  for (const [field, offset] of [["m_Offset", at], ["m_Size", at + 8]] as const) {
    const copy = bytes.slice();
    const view = new DataView(copy.buffer);
    view.setBigUint64(offset, 2n ** 53n - 1n, true);
    const clip = readVideoClip(readerOf(FROM, copy, { unity }));
    assert.equal(clip.m_ExternalResources[field], 2 ** 53 - 1);
    view.setBigUint64(offset, 2n ** 64n - 1n, true);
    assert.throws(
      () => readVideoClip(readerOf(FROM, copy, { unity })),
      new RegExp(`m_ExternalResources\\.${field} 18446744073709551615 is not a byte offset`),
    );
  }
  assert.ok(expected.m_ExternalResources.m_Size > 0);
});

test("read() of a clip whose m_Source is empty throws CorruptError (R9)", () => {
  const { bytes } = build((w) => ({
    ...head(w),
    m_PixelAspecRatioNum: w.u32(16),
    m_PixelAspecRatioDen: w.u32(9),
    ...middle(w),
    m_VideoShaders: w.array([], (id: bigint) => w.pptr(0, id)),
    m_ExternalResources: { m_Source: w.str(""), m_Offset: w.u64n(0), m_Size: w.u64n(10) },
    m_HasSplitAlpha: w.bool(false),
    m_sRGB: w.bool(true),
  }));
  const reader = readerOf(FROM, bytes, { unity: [6000, 3, 25, 1] });
  assert.equal(readVideoClip(reader).m_ExternalResources.m_Source, "");
  assert.throws(() => reader.read(), /VideoClip -?\d+ has no data: its resource path is empty/);
});
