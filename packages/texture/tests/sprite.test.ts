// Sprites (#34): the crop, packing rotation and tight-mesh mask, checked against
// the oracle's sprite goldens (R12), AssetStudio's own CutImage where the two
// differ (plan §6), and the fixture's own pixels, which encode where they are.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ClassID,
  CorruptError,
  load,
  ResourceNotFoundError,
  SpritePackingRotation,
  UnsupportedError,
  type Env,
  type ObjectReader,
  type Sprite,
} from "unity-asset-reader";
import {
  golden,
  loadFixture,
  reverseRows,
  sha256,
  type GoldenSprite,
} from "../../../fixtures/helpers.js";
import { convertPlain, type RgbaImage } from "../src/convert.js";
import { initTexture } from "../src/decode.js";
import { cutSprite, decodeSprite, findSpriteSource, type SpriteRect } from "../src/sprite.js";

// As in decode.test.ts: the WASM half of texture2ddecoder-wasm needs Docker to
// build, so without it only the tests that need no decoder run, and the CI job
// that builds it sets REQUIRE_WASM=1 so that nothing skips there (#119). The
// fixture textures are RGBA32, so every test but the decodeSprite ones works
// on convertPlain's pixels instead.
const WASM = "texture2ddecoder-wasm/wasm/texture2ddecoder.wasm";
const skip = existsSync(fileURLToPath(new URL(`../../${WASM}`, import.meta.url)))
  ? false
  : `packages/${WASM} not built (npm run build:wasm)`;
if (skip && process.env.REQUIRE_WASM === "1") {
  throw new Error(`REQUIRE_WASM=1 but ${skip}; the decode tests must not skip here`);
}

before(async () => {
  if (!skip) await initTexture();
});

const wasmTest = (name: string, fn: () => Promise<void>) => test(name, { skip }, fn);

const FIXTURES = ["editor/2019.4.41f2/sprite/sprites", "editor/6000.3.25f1/sprite/sprites"];

/**
 * AssetStudio's own `SpriteHelper.CutImage` over the fixture sprites, where the
 * sprite golden carries an oracle note: the tight-mesh images, and Rotate90.
 * Cross-check values under plan §6, not goldens; how they were made:
 * `fixtures/README.md`, Oracle notes, "AssetStudio sprite cross-check hashes".
 * Both editors give the same images, so they are keyed by sprite name.
 * Rows as stored, bottom row first, like the goldens.
 */
const ASSETSTUDIO_RGBA: Record<string, string> = {
  p_diamond: "0a7b380ab7f95d6feb561f0468f0b2bb282c78e3d9c63e5619be8ddc00cde9cf",
  p_ell: "166f5bc558ab7f004b86119f9cab535068c8139735200bbac43ac32d425137dc",
  p_ell2: "3a9600dacc52f1b61b6de414629a88710a8e0ee062ad2c688e25b3afde14909f",
  p_ell3: "e37a22104bb7e50d97548e0d18a577fa6ae3df31691084ac1e552a0e17b84b77",
  p_margin: "3936b7818be9fd72ae809097cfb9270a902ecf3b1215400c456337785f8d4bf3",
  p_tri: "2ba2b3c1fff25af21e6da9f533db46bf1dd7c1d5db2871e7ef895fa94b46cb49",
  p_tri2: "ffb44a725428f841b9c87bb5497e0aaae9ce798b781decdb1da6e889b4beac22",
  p_tri3: "287510cc84e8a14560e209e0948abb02ada4f2e7d61215db8ffbec2a68037de8",
  p_tri4: "83bf159f814c2410b73d5ecb4dd32a95e4308d27b1e434eb5787bc35b40eb13f",
  p_tri5: "2d3091d6a369c3edc5889de42f9dd32651bba5b3a4635aa345d2d0fc4b40e18d",
  p_tri6: "a5060e4760d61cf201f949555026fc77bfb6edd87a0fde49dad7a84055c36c1f",
  sheet_d: "508c8a19096e38475961bc8e59c4b28ab218ff98237e7c3b87aed48a01d5817b",
  tight: "82efdcbd6983dc346f0da8cdf1557bd7f25a81467d94e5b1b774a3fc4d25e29e",
  "sheet_b Rotate90": "b5938b891b614c0eb204d0245eb298bb1548f324b8fbffd350ab80326c168101",
  // Hand-made triangles, below.
  "synthetic quad": "30ed0874322235af4cf18b9bf379df2cc8431a3c2b7dc8598cc4bca7e6496349",
  "synthetic tri": "f201210184ab19746b302dbbd73aa9a0c95ca0f00c14c19dc6e2bafbaee3c106",
  "synthetic thin": "dc9543488b54769bb17db2dbe5728acb068671d83529f81fd44ce2a6afc7d83d",
};

/** One fixture sprite, where its pixels are, and what the oracle says it is. */
interface FixtureSprite {
  fixture: string;
  env: Env;
  obj: ObjectReader;
  sprite: Sprite;
  rect: SpriteRect;
  /** Its texture, top row first, as `decodeTexture2D` would give it. */
  image: RgbaImage;
  golden: GoldenSprite;
}

/** Every Sprite of a fixture, through the lookup `decodeSprite` does. */
function fixtureSprites(fixture: string): FixtureSprite[] {
  const env = load([{ name: fixture, data: loadFixture(fixture) }]);
  const [sf] = Object.values(golden(fixture).serialized!);
  return env.objects
    .filter((obj) => obj.type === ClassID.Sprite)
    .map((obj) => {
      const { sprite, rect, texture } = findSpriteSource(obj, env);
      const plain = convertPlain(texture.imageData, texture.m_Width, texture.m_Height, 4);
      assert.equal(texture.m_TextureFormat, 4, "the fixture textures are RGBA32");
      const image = { ...plain, data: reverseRows(plain.data, plain.width) };
      const g = sf!.sprites![String(obj.pathId)];
      assert.ok(g, `${fixture}: no sprite golden for ${obj.pathId}`);
      return { fixture, env, obj, sprite, rect, image, golden: g };
    });
}

const SPRITES = FIXTURES.flatMap(fixtureSprites);

/** Rows reversed back to the order the goldens hash. */
const stored = ({ data, width }: RgbaImage): string => sha256(reverseRows(data, width));

/** What a tight image must hash to: the golden, or AssetStudio's where they differ. */
function tightExpected({ golden: g }: FixtureSprite): string {
  const want = g.tightOracleNote ? ASSETSTUDIO_RGBA[g.name] : g.tightRgbaSha256;
  assert.ok(want, `${g.name}: no expected tight hash`);
  return want;
}

// --- the goldens -------------------------------------------------------------------

for (const s of SPRITES) {
  test(`${s.fixture} ${s.golden.name}: the rectangle, unpacked, equals the golden`, () => {
    const out = cutSprite(s.image, s.sprite, s.rect, s.obj.version, false);
    assert.equal(out.width, s.golden.width);
    assert.equal(out.height, s.golden.height);
    assert.equal(stored(out), s.golden.rgbaSha256);
  });

  test(`${s.fixture} ${s.golden.name}: tightMesh equals the golden, or AssetStudio`, () => {
    const out = cutSprite(s.image, s.sprite, s.rect, s.obj.version, true);
    if (s.golden.tightRgbaSha256 === undefined) {
      // Packed as a rectangle: the mesh is not applied.
      assert.equal((s.rect.settingsRaw >> 1) & 1, 1);
      assert.equal(stored(out), s.golden.rgbaSha256);
      return;
    }
    assert.equal(out.width, s.golden.tightWidth);
    assert.equal(out.height, s.golden.tightHeight);
    assert.equal(stored(out), tightExpected(s));
    // The note is right: here UnityPy's image is not AssetStudio's.
    if (s.golden.tightOracleNote) assert.notEqual(s.golden.tightRgbaSha256, tightExpected(s));
  });
}

test("the sprite checks cover both editors, every packing flip, and masks that cut", () => {
  const seen = new Set<string>();
  for (const s of SPRITES) {
    seen.add(s.fixture);
    const packed = (s.rect.settingsRaw & 1) === 1;
    if (packed) seen.add(`rotation ${(s.rect.settingsRaw >> 2) & 0xf}`);
    if (s.golden.tightOracleNote) seen.add("noted");
    if (s.golden.tightRgbaSha256 && !s.golden.tightOracleNote) seen.add("tight, oracles agree");
  }
  assert.deepEqual([...seen].filter((k) => k.startsWith("editor/")).sort(), FIXTURES);
  for (const want of ["rotation 0", "rotation 1", "rotation 2", "rotation 3"]) {
    assert.ok(seen.has(want), want);
  }
  assert.ok(seen.has("noted") && seen.has("tight, oracles agree"));
});

for (const fixture of FIXTURES) {
  test(`${fixture}: sheet_b turned every way a packer can, against the golden`, () => {
    const s = SPRITES.find((x) => x.fixture === fixture && x.golden.name === "sheet_b")!;
    const rotations = s.golden.rotations!;
    for (const [value, turned] of Object.entries(rotations)) {
      const settingsRaw = (s.rect.settingsRaw & ~0x3f) | 1 | 2 | (Number(value) << 2);
      const out = cutSprite(s.image, s.sprite, { ...s.rect, settingsRaw }, s.obj.version, false);
      assert.equal(out.width, turned.width);
      assert.equal(out.height, turned.height);
      // Rotate90 turns the other way in UnityPy (see the note); AssetStudio decides.
      const want = turned.oracleNote ? ASSETSTUDIO_RGBA["sheet_b Rotate90"] : turned.rgbaSha256;
      assert.equal(stored(out), want, `rotation ${value}`);
    }
    assert.ok(rotations[String(SpritePackingRotation.Rotate90)]!.oracleNote);
    assert.equal(Object.keys(rotations).length, 4);
  });
}

// --- the fixture's own pixels: every one says where it is ----------------------------

/**
 * The image each fixture sprite was cut from, by name (`BuildSprites.cs` in
 * `fixtures/BUILDING.md`): pixel (x, y), y from the bottom, of image `id` is
 * R = 5x + 3, G = 5y + 5, B = 16 id + 7, all mod 256. The sheet sprites are
 * cut from one image, the rest are each their own.
 */
const IMAGE_ID: Record<string, number> = {
  sheet_a: 1, sheet_b: 1, sheet_c: 1, sheet_d: 1, tight: 2, p_tall: 3, p_wide: 4, p_tri: 5,
  p_tri2: 6, p_tri3: 7, p_ell: 8, p_diamond: 9, p_tri4: 10, p_tri5: 11, p_ell2: 12, p_ell3: 13,
  p_bar: 14, p_bar2: 15, p_tri6: 1, p_margin: 2, r_a: 11, r_b: 12,
};

/**
 * Check that every opaque pixel of the sprite's own image lands where it was
 * drawn: the crop, the bottom-left origin, the undone packing flip and the
 * final top-down order all have to be right. With `onlyOwn`, also that no
 * pixel of another sprite is left (a packed neighbour's, inside the rectangle).
 *
 * @returns how many pixels were checked
 */
function checkOwnPixels(s: FixtureSprite, out: RgbaImage, onlyOwn: boolean): number {
  const id = IMAGE_ID[s.golden.name];
  assert.ok(id !== undefined, s.golden.name);
  // Where the image starts in the sprite: the sheet rectangle, or the trimmed margin.
  const onSheet = s.golden.name.startsWith("sheet_");
  const originX = onSheet ? s.sprite.m_Rect.x : Math.floor(s.rect.textureRectOffset.x);
  const originY = onSheet ? s.sprite.m_Rect.y : Math.floor(s.rect.textureRectOffset.y);
  let checked = 0;
  for (let row = 0; row < out.height; row++) {
    for (let x = 0; x < out.width; x++) {
      const at = (row * out.width + x) * 4;
      const [r, g, b, a] = out.data.subarray(at, at + 4);
      if (a !== 255) continue;
      if (b !== ((16 * id + 7) & 0xff)) {
        assert.ok(!onlyOwn, `${s.golden.name}: a pixel of image ${b} at (${x}, ${row})`);
        continue;
      }
      const y = out.height - 1 - row;
      assert.equal(r, (5 * (originX + x) + 3) & 0xff, `${s.golden.name} R at (${x}, ${y})`);
      assert.equal(g, (5 * (originY + y) + 5) & 0xff, `${s.golden.name} G at (${x}, ${y})`);
      checked++;
    }
  }
  return checked;
}

for (const fixture of FIXTURES) {
  test(`${fixture}: every opaque pixel of each sprite is where its image drew it`, () => {
    for (const s of SPRITES.filter((x) => x.fixture === fixture)) {
      const out = cutSprite(s.image, s.sprite, s.rect, s.obj.version, false);
      assert.ok(checkOwnPixels(s, out, false) > 0, s.golden.name);
      // The mask leaves nothing of a packed neighbour, and keeps the sprite.
      const tight = cutSprite(s.image, s.sprite, s.rect, s.obj.version, true);
      assert.ok(checkOwnPixels(s, tight, true) > 0, s.golden.name);
    }
  });
}

// --- the mask on hand-made triangles, against AssetStudio's ---------------------------

/**
 * A 16x16 texture whose pixel i has alpha i and colours that differ, cut as a
 * sprite with the given triangles in pixels (pivot at the corner, 1 pixel per
 * unit). The triangles have corners off the pixel grid, and one is a sliver
 * 0.2 wide, which fills a whole column. AssetStudio's CutImage gave the hashes.
 */
function synthetic(vertices: [number, number][], triangles: number[][]): RgbaImage {
  const texture = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < 256; i++) {
    texture.set([(i * 37 + 11) & 255, (i * 91 + 3) & 255, (i * 53 + 7) & 255, i], i * 4);
  }
  const data = new Uint8Array(vertices.length * 12);
  const view = new DataView(data.buffer);
  vertices.forEach(([x, y], i) => {
    view.setFloat32(i * 12, x, true);
    view.setFloat32(i * 12 + 4, y, true);
  });
  const indices = new Uint8Array(new Uint16Array(triangles.flat()).buffer);
  const sprite = {
    m_Rect: { x: 0, y: 0, width: 16, height: 16 },
    m_Pivot: { x: 0, y: 0 },
    m_PixelsToUnits: 1,
    m_RD: {
      m_SubMeshes: [
        {
          firstByte: 0,
          indexCount: indices.length / 2,
          firstVertex: 0,
          vertexCount: vertices.length,
        },
      ],
      m_IndexBuffer: indices,
      m_VertexData: {
        m_VertexCount: vertices.length,
        m_Channels: [{ stream: 0, offset: 0, format: 0, dimension: 3 }],
        m_DataSize: data,
      },
    },
  } as unknown as Sprite;
  const rect: SpriteRect = {
    textureRect: { x: 0, y: 0, width: 16, height: 16 },
    textureRectOffset: { x: 0, y: 0 },
    settingsRaw: 0,
    downscaleMultiplier: 1,
  };
  const image = { data: reverseRows(texture, 16), width: 16, height: 16 };
  return cutSprite(image, sprite, rect, [2020, 3, 1, 1], true);
}

test("the tight mask fills triangles as AssetStudio's ImageSharp does, to the pixel", () => {
  const quad = synthetic(
    [[0, 0], [16, 0], [16, 16], [0, 16]],
    [[0, 1, 2], [0, 2, 3]],
  );
  const tri = synthetic([[0.3, 0.2], [15.7, 3.9], [6.1, 15.55]], [[0, 1, 2]]);
  const thin = synthetic([[2.1, 1], [2.25, 14], [2.3, 1]], [[0, 1, 2]]);
  assert.equal(stored(quad), ASSETSTUDIO_RGBA["synthetic quad"]);
  assert.equal(stored(tri), ASSETSTUDIO_RGBA["synthetic tri"]);
  assert.equal(stored(thin), ASSETSTUDIO_RGBA["synthetic thin"]);
  // A pixel the mask keeps keeps its colour at any alpha but 0, as upstream's blend does.
  const pixel = (image: RgbaImage, x: number, y: number) =>
    [...image.data.subarray(((15 - y) * 16 + x) * 4, ((15 - y) * 16 + x) * 4 + 4)];
  assert.deepEqual(pixel(quad, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(quad, 1, 0), [48, 94, 60, 1]);
  // The sliver fills column 2 from row 1 to 13, and nothing else.
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      assert.equal(pixel(thin, x, y)[3]! > 0, x === 2 && y >= 1 && y <= 13, `(${x}, ${y})`);
    }
  }
});

// --- refusals -------------------------------------------------------------------------

const base = SPRITES.find((s) => s.fixture === FIXTURES[1] && s.golden.name === "sheet_d")!;
const cut = (rect: Partial<SpriteRect>, sprite: Sprite = base.sprite, tight = true) =>
  cutSprite(base.image, sprite, { ...base.rect, ...rect }, base.obj.version, tight);

test("a textureRect outside its texture throws CorruptError", () => {
  for (const textureRect of [
    { x: -1, y: 0, width: 4, height: 4 },
    { x: 0, y: -0.5, width: 4, height: 4 },
    { x: 64, y: 0, width: 4, height: 4 },
    { x: 0, y: 0, width: 0, height: 4 },
  ]) {
    assert.throws(() => cut({ textureRect }), CorruptError, JSON.stringify(textureRect));
  }
  // Past the far edges it is clipped, as upstream clips it.
  const clipped = cut({ textureRect: { x: 60, y: 40, width: 10, height: 10 } }, base.sprite, false);
  assert.deepEqual([clipped.width, clipped.height], [4, 8]);
});

test("a variant atlas' downscaleMultiplier is refused: resampling it is not implemented", () => {
  assert.throws(
    () => cut({ downscaleMultiplier: 0.5 }),
    (err: unknown) =>
      err instanceof UnsupportedError && err.kind === "sprite downscale" && err.found === 0.5,
  );
  // 1, and upstream's 0 before 2017.1, mean none.
  cut({ downscaleMultiplier: 1 });
  cut({ downscaleMultiplier: 0 });
});

test("a packing rotation Unity does not define is refused, unless the sprite is not packed", () => {
  assert.throws(
    () => cut({ settingsRaw: 1 | (5 << 2) }),
    (err: unknown) =>
      err instanceof UnsupportedError && err.kind === "sprite packing rotation" && err.found === 5,
  );
  cut({ settingsRaw: 5 << 2 });
});

test("tightMesh refuses a mesh it cannot read, rather than skip the mask as upstream does", () => {
  const rd = base.sprite.m_RD;
  const vd = rd.m_VertexData!;
  const withMesh = (changes: Partial<Sprite["m_RD"]>): Sprite => ({
    ...base.sprite,
    m_RD: { ...rd, ...changes },
  });
  // Positions that are not 32-bit floats.
  const channels = [{ ...vd.m_Channels[0]!, format: 1 }];
  const half = withMesh({ m_VertexData: { ...vd, m_Channels: channels } });
  assert.throws(
    () => cut({}, half),
    (err: unknown) => err instanceof UnsupportedError && err.kind === "sprite vertex format",
  );
  // An index past the sub-mesh's vertices.
  const index = rd.m_IndexBuffer!.slice();
  index[0] = 0xff;
  assert.throws(() => cut({}, withMesh({ m_IndexBuffer: index })), /outside its sub-mesh/);
  // Vertex data cut short.
  const short = withMesh({ m_VertexData: { ...vd, m_DataSize: vd.m_DataSize.subarray(0, 20) } });
  assert.throws(() => cut({}, short), CorruptError);
  // No mesh at all.
  const none = withMesh({ m_VertexData: undefined });
  assert.throws(() => cut({}, none), /has no mesh/);
  // Without tightMesh the mesh is never read.
  cut({}, half, false);
});

/** A fixture loaded fresh, so that its bytes can be changed. */
function fresh(name: string): { env: Env; sprite: ObjectReader; file: Uint8Array } {
  const env = load([{ name: FIXTURES[1]!, data: loadFixture(FIXTURES[1]!) }]);
  const sprite = env.objects.find(
    (o) => o.type === ClassID.Sprite && o.read<Sprite>().m_Name === name,
  )!;
  const file = env.files.find((f) => !f.path.endsWith(".resS"))!.data;
  return { env, sprite, file };
}

/** Where `pattern` starts in the object's bytes, which must hold it once. */
function find(obj: ObjectReader, file: Uint8Array, pattern: Uint8Array): number {
  const bytes = file.subarray(obj.byteStart, obj.byteStart + obj.byteSize);
  const hits: number[] = [];
  for (let i = 0; i + pattern.length <= bytes.length; i++) {
    if (pattern.every((b, k) => bytes[i + k] === b)) hits.push(i);
  }
  assert.equal(hits.length, 1, "pattern not found exactly once");
  return obj.byteStart + hits[0]!;
}

/** A pointer's bytes: `Int32` file id, `Int64` path id. */
function pointer(fileId: number, pathId: bigint): Uint8Array {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setInt32(0, fileId, true);
  new DataView(out.buffer).setBigInt64(4, pathId, true);
  return out;
}

test("decodeSprite's lookup refuses what is not a Sprite with a TypeError", () => {
  const { env } = fresh("sheet_a");
  const texture = env.objects.find((o) => o.type === ClassID.Texture2D)!;
  assert.throws(() => findSpriteSource(texture, env), /expected the ObjectReader of a Sprite/);
  assert.throws(() => findSpriteSource(undefined as unknown as ObjectReader, env), TypeError);
});

test("a packed sprite whose key is not in its atlas throws CorruptError", () => {
  const { env, sprite, file } = fresh("p_tri");
  const key = sprite.read<Sprite>().m_RenderDataKey![0];
  const guid = new Uint8Array(new Uint32Array([0, 1, 2, 3].map((i) => key[`data[${i}]`]!)).buffer);
  file[find(sprite, file, guid)]! ^= 0xff;
  assert.throws(() => findSpriteSource(sprite, env), /has no render data for its m_RenderDataKey/);
});

test("an atlas pointer to nothing falls back to m_RD, whose null texture is refused", () => {
  const { env, sprite, file } = fresh("p_tri");
  const atlas = sprite.read<Sprite>().m_SpriteAtlas!;
  const at = find(sprite, file, pointer(0, atlas.m_PathID));
  file.set(pointer(0, 12345n), at);
  assert.throws(() => findSpriteSource(sprite, env), /texture is a null pointer/);
  file.set(pointer(1, atlas.m_PathID), at);
  assert.throws(() => findSpriteSource(sprite, env), /texture is a null pointer/);
});

test("a sprite with an alpha texture (ETC1 split alpha) is refused", () => {
  const { env, sprite, file } = fresh("sheet_a");
  const texture = sprite.read<Sprite>().m_RD.texture;
  const pair = Uint8Array.from([...pointer(0, texture.m_PathID), ...pointer(0, 0n)]);
  const at = find(sprite, file, pair);
  file.set(pointer(0, texture.m_PathID), at + 12);
  assert.throws(
    () => findSpriteSource(sprite, env),
    (err: unknown) => err instanceof UnsupportedError && err.kind === "sprite alpha texture",
  );
});

test("a texture pointer at the wrong class or at nothing throws CorruptError", () => {
  const { env, sprite, file } = fresh("sheet_a");
  const texture = sprite.read<Sprite>().m_RD.texture;
  const at = find(sprite, file, pointer(0, texture.m_PathID));
  file.set(pointer(0, sprite.pathId), at);
  assert.throws(() => findSpriteSource(sprite, env), /is class 213, not 28/);
  file.set(pointer(0, 777n), at);
  assert.throws(() => findSpriteSource(sprite, env), /path id 777\) is not in/);
});

test("an atlas texture in a .resS that is not loaded throws ResourceNotFoundError", () => {
  const { env: whole } = fresh("p_tri");
  const cab = whole.files.find((f) => !f.path.endsWith(".resS"))!;
  const env = load([{ name: cab.path, data: cab.data }]);
  const sprite = env.objects.find(
    (o) => o.type === ClassID.Sprite && o.read<Sprite>().m_Name === "p_tri",
  )!;
  assert.throws(() => findSpriteSource(sprite, env), ResourceNotFoundError);
});

// --- decodeSprite, end to end with the WASM decoder ------------------------------------

for (const fixture of FIXTURES) {
  wasmTest(`${fixture}: decodeSprite(obj, env) gives every sprite its expected image`, async () => {
    const env = load([{ name: fixture, data: loadFixture(fixture) }]);
    const expected = new Map(
      SPRITES.filter((s) => s.fixture === fixture).map((s) => [String(s.obj.pathId), s]),
    );
    const sprites = env.objects.filter((o) => o.type === ClassID.Sprite);
    assert.equal(sprites.length, expected.size);
    for (const obj of sprites) {
      const s = expected.get(String(obj.pathId))!;
      const out = await decodeSprite(obj, env);
      assert.equal(stored(out), s.golden.rgbaSha256, s.golden.name);
      const tight = await decodeSprite(obj, env, { tightMesh: true });
      const want = s.golden.tightRgbaSha256 ? tightExpected(s) : s.golden.rgbaSha256;
      assert.equal(stored(tight), want, `${s.golden.name} tightMesh`);
    }
  });
}

wasmTest("decodeSprite refuses a sprite that is not one of the env's objects", async () => {
  const other = load([{ name: FIXTURES[1]!, data: loadFixture(FIXTURES[1]!) }]);
  await assert.rejects(decodeSprite(base.obj, other), /was not loaded by this env/);
});
