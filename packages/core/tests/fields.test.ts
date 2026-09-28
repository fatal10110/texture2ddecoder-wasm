// The friendly `asset.data` shapes (#184): on every fixture object of every
// class with a hand reader, `asset.data` is the low-level `obj.read()` result
// renamed by one rule, written out here apart from the per-class mappings in
// `src/classes/fields.ts`: drop `m_`, lower-case the first letter, at every
// level except inside a PPtr, plus the few renames the JSDoc documents.

import assert from "node:assert/strict";
import { test } from "node:test";

import { fixtureNames, golden, loadFixture } from "../../../fixtures/helpers.js";
import type { AudioClipData } from "../src/classes/AudioClip.js";
import {
  toAudioClipFields,
  toMonoBehaviourFields,
  toMovieTextureFields,
} from "../src/classes/fields.js";
import { readMonoBehaviour } from "../src/classes/MonoBehaviour.js";
import { readMovieTexture } from "../src/classes/MovieTexture.js";
import type { MonoBehaviourData, Texture2DData } from "../src/classes/registry.js";
import { textAssetString, type TextAsset } from "../src/classes/TextAsset.js";
import { TextureFormat } from "../src/classes/TextureFormat.js";
import { load } from "../src/env.js";
import { ClassID } from "../src/serialized/ClassID.js";
import type { ObjectReader } from "../src/serialized/ObjectReader.js";
import { build, readerOf, template, type Writer } from "./media.js";

/** Fixtures holding real SerializedFiles. */
const EDITOR = fixtureNames().filter((name) => golden(name).serialized !== undefined);

/** The renames beyond the rule, as the fields' JSDoc documents them; `null` drops the key. */
const RENAMES: Record<string, string | null> = {
  m_TextureFormat: "format",
  m_3D: "is3D",
  m_RD: "renderData",
  m_DataSize: "data",
  m_PixelAspecRatioNum: "pixelAspectRatioNum",
  m_PixelAspecRatioDen: "pixelAspectRatioDen",
  // Folded into `imageData` / `audioData`, which hold the same bytes whenever
  // these hold any.
  "image data": null,
  m_AudioData: null,
};

/** The rule: `m_Width` -> `width`, `Width` -> `width`, `m_sRGB` -> `sRGB`. */
function camel(key: string): string | null {
  if (key in RENAMES) return RENAMES[key]!;
  const bare = key.startsWith("m_") ? key.slice(2) : key;
  return bare.charAt(0).toLowerCase() + bare.slice(1);
}

/** `value` with every key renamed by {@link camel}, a PPtr and bytes left as they are. */
function renamed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renamed);
  if (!value || typeof value !== "object" || value instanceof Uint8Array) return value;
  if ("m_FileID" in value) return value; // a PPtr stays a PPtr
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const name = camel(key);
    if (name !== null) out[name] = renamed(v);
  }
  return out;
}

/** What `asset.data` must be for `low`, what `reader.read()` gave for the object. */
function expected(type: string, low: Record<string, unknown>, reader: ObjectReader): unknown {
  if (type === "TextAsset") {
    const { m_Script, ...rest } = low as unknown as TextAsset;
    return { ...(renamed(rest) as object), bytes: m_Script, text: textAssetString(low as never) };
  }
  if (type === "MonoBehaviour") {
    // The header is what the header reader reads; with a type tree, the rest
    // is the script's.
    const header = new Set(Object.keys(readMonoBehaviour(reader)));
    const head = Object.entries(low).filter(([k]) => header.has(k));
    const out = renamed(Object.fromEntries(head)) as Record<string, unknown>;
    out.enabled = low.m_Enabled !== 0;
    if (reader.serializedType?.nodes?.length) {
      out.fields = Object.fromEntries(Object.entries(low).filter(([k]) => !header.has(k)));
    }
    return out;
  }
  return renamed(low);
}

test("asset.data is obj.read() under the friendly names, for every class on the fixtures", () => {
  const seen = new Set<string>();
  for (const name of EDITOR) {
    const env = load([{ name, data: loadFixture(name) }]);
    for (const asset of env.assets()) {
      if (asset.type === "Other") continue;
      const id = `${name}: ${asset.type} ${asset.pathId}`;
      let low: Record<string, unknown>;
      try {
        low = asset.reader.read() as Record<string, unknown>;
      } catch {
        assert.throws(() => asset.data, id);
        continue;
      }
      assert.deepStrictEqual(asset.data, expected(asset.type, low, asset.reader), id);
      seen.add(asset.type);
    }
  }
  // MovieTexture has no fixture (see the synthetic test below).
  assert.deepStrictEqual(
    [...seen].sort(),
    [
      "AssetBundle",
      "AudioClip",
      "Font",
      "Material",
      "MonoBehaviour",
      "MonoScript",
      "Sprite",
      "SpriteAtlas",
      "TextAsset",
      "Texture2D",
      "VideoClip",
    ],
  );
});

test("the #184 usage fields: Texture2D, TextAsset and MonoBehaviour", () => {
  const env = load(loadFixture("editor/6000.3.25f1/lz4/main"));
  const assets = [...env.assets()];

  const textures = load(loadFixture("editor/6000.3.25f1/lz4/texture"));
  const texture = [...textures.assets()].find((a) => a.type === "Texture2D");
  assert.ok(texture?.type === "Texture2D");
  const t = texture.reader.read() as Texture2DData;
  assert.equal(texture.data.format, t.m_TextureFormat);
  assert.ok(Object.values(TextureFormat).includes(texture.data.format));
  assert.equal(texture.data.width, t.m_Width);
  assert.equal(texture.data.height, t.m_Height);
  assert.equal(texture.data.mipCount, t.m_MipCount);
  assert.equal("m_TextureFormat" in texture.data, false);

  const shared = load(loadFixture("editor/6000.3.25f1/lz4/shared"));
  const text = [...shared.assets()].find((a) => a.type === "TextAsset");
  assert.ok(text?.type === "TextAsset");
  const low = text.reader.read() as TextAsset;
  assert.deepStrictEqual(text.data.bytes, low.m_Script);
  assert.equal(text.data.text, textAssetString(low));
  assert.equal(text.data.text, text.data.text);

  const behaviour = assets.find((a) => a.type === "MonoBehaviour");
  assert.ok(behaviour?.type === "MonoBehaviour");
  const b = behaviour.reader.read() as MonoBehaviourData;
  assert.deepStrictEqual(behaviour.data.script, b.m_Script);
  assert.ok(behaviour.data.fields && Object.keys(behaviour.data.fields).length > 0);
  for (const key of Object.keys(behaviour.data.fields)) assert.ok(!(key in behaviour.data), key);
  assert.equal("m_Script" in behaviour.data.fields, false);
});

test("MonoBehaviour: no fields without a type tree; editor header fields stay header", () => {
  const bare = load(loadFixture("editor/6000.3.25f1/lz4-notypetree/main"));
  const noTree = [...bare.assets("MonoBehaviour")][0]!;
  assert.equal(noTree.reader.serializedType?.nodes ?? null, null);
  assert.equal("fields" in noTree.data, false);
  assert.equal(noTree.data.name, "data");

  // An editor file's type tree puts editor fields around the header.
  const typed = load(loadFixture("editor/6000.3.25f1/lz4/main"));
  const asset = [...typed.assets("MonoBehaviour")][0]!;
  const editor = {
    m_ObjectHideFlags: 0,
    m_CorrespondingSourceObject: { m_FileID: 0, m_PathID: 0n },
    m_PrefabInstance: { m_FileID: 0, m_PathID: 0n },
    m_PrefabAsset: { m_FileID: 0, m_PathID: 0n },
    m_EditorHideFlags: 0,
    m_EditorClassIdentifier: "",
    ...(asset.reader.read() as MonoBehaviourData),
  };
  const fields = toMonoBehaviourFields(editor, asset.reader);
  assert.equal(fields.objectHideFlags, 0);
  assert.deepStrictEqual(fields.prefabAsset, { m_FileID: 0, m_PathID: 0n });
  assert.equal(fields.editorHideFlags, 0);
  assert.equal(fields.editorClassIdentifier, "");
  assert.deepStrictEqual(fields.fields, asset.data.fields);
});

test("AudioClip before 5.0: m_3D is is3D, the inline m_AudioData is audioData", () => {
  const sound = Uint8Array.of(1, 2, 3);
  const low: AudioClipData = {
    m_Name: "beep",
    m_Format: 2,
    m_Type: 20,
    m_3D: true,
    m_UseHardware: false,
    m_Stream: 1,
    m_AudioData: sound,
    audioData: sound,
  };
  const fields = toAudioClipFields(low);
  assert.deepStrictEqual(fields, renamed(low));
  assert.equal(fields.is3D, true);
  assert.equal(fields.audioData, sound);
  assert.equal("m_AudioData" in fields, false);
});

test("MovieTexture, on hand-built layouts (no fixture has one)", () => {
  const from = template("editor/6000.3.25f1/lz4/font", ClassID.Font);
  const movie = Uint8Array.of(0x4f, 0x67, 0x67, 0x53, 7);
  const layouts: [[number, number, number, number], number, (w: Writer) => object][] = [
    // 3.5 to 2017.2: the movie fields after m_Name, then m_ColorSpace.
    [
      [5, 0, 0, 1],
      15,
      (w) => ({
        m_Name: w.str("intro"),
        m_Loop: w.pad(w.bool(true)),
        m_AudioClip: w.pptr(0, 9n),
        m_MovieData: w.pad(w.bytes(movie)),
        m_ColorSpace: w.i32(1),
      }),
    ],
    // 2017.3 to 2019.2: the Texture fallback fields first.
    [
      [2017, 3, 0, 1],
      17,
      (w) => ({
        m_Name: w.str("intro"),
        m_ForcedFallbackFormat: w.i32(4),
        m_DownscaleFallback: w.pad(w.bool(false)),
        m_Loop: w.pad(w.bool(true)),
        m_AudioClip: w.pptr(0, 9n),
        m_MovieData: w.pad(w.bytes(movie)),
        m_ColorSpace: w.i32(1),
      }),
    ],
  ];
  for (const [unity, format, layout] of layouts) {
    const { bytes, expected: low } = build(layout);
    const reader = readerOf(from, bytes, { unity, format, classId: ClassID.MovieTexture });
    const read = readMovieTexture(reader);
    assert.deepStrictEqual(read, low, unity.join("."));
    assert.deepStrictEqual(toMovieTextureFields(read), renamed(read), unity.join("."));
  }
});
