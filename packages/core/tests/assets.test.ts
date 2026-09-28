// The high-level API (#183): `env.assets()` and `env.get()` against the
// oracle's names and container (R12), the lazy `name` / `data` getters, the
// `type` discriminant and the filter.

import assert from "node:assert/strict";
import { test } from "node:test";

import { fixtureNames, golden, loadFixture } from "../../../fixtures/helpers.js";
import type { Asset } from "../src/asset.js";
import { readAssetData } from "../src/classes/registry.js";
import { load, type Env } from "../src/env.js";
import { UnsupportedError } from "../src/errors.js";
import { ClassID, classIdName } from "../src/serialized/ClassID.js";

/** Fixtures holding real SerializedFiles, so with names and a container golden. */
const EDITOR = fixtureNames().filter((name) => golden(name).serialized !== undefined);

/** Classes with a hardcoded reader, whose `type` is their class name. */
const KNOWN = new Set([
  "Texture2D",
  "AssetBundle",
  "TextAsset",
  "MonoScript",
  "MonoBehaviour",
  "Material",
  "AudioClip",
  "Font",
  "VideoClip",
  "MovieTexture",
  "Sprite",
  "SpriteAtlas",
]);

/** Load a fixture as bare bytes, the way the usage block does. */
const loadBytes = (name: string): Env => load(loadFixture(name));

const key = (file: string, pathId: bigint | string): string => `${file}/${pathId}`;

/** The golden's first container path per object, and first object per lower-cased path. */
function expectedContainer(name: string): {
  pathOf: Map<string, string>;
  byPath: Map<string, string>;
} {
  const pathOf = new Map<string, string>();
  const byPath = new Map<string, string>();
  for (const entry of golden(name).container ?? []) {
    assert.notEqual(entry.file, null, `${name}: the oracle resolves every container entry`);
    const target = key(entry.file!, entry.pathId);
    if (!pathOf.has(target)) pathOf.set(target, entry.path);
    if (!byPath.has(entry.path.toLowerCase())) byPath.set(entry.path.toLowerCase(), target);
  }
  return { pathOf, byPath };
}

test("the editor fixtures have container goldens to check against", () => {
  assert.ok(EDITOR.length > 50, `${EDITOR.length} editor fixtures`);
  const entries = EDITOR.flatMap((name) => golden(name).container ?? []);
  assert.ok(entries.length > 50);
  // Paths that list several objects (a texture and its sprites) are covered.
  const paths = entries.map((e) => e.path);
  assert.ok(new Set(paths).size < paths.length);
});

for (const name of EDITOR) {
  test(`${name}: assets match the object table, with UnityPy's names and paths`, () => {
    const g = golden(name);
    const env = loadBytes(name);
    const assets = [...env.assets()];
    assert.equal(assets.length, env.objects.length);

    const { pathOf } = expectedContainer(name);
    for (const [i, asset] of assets.entries()) {
      const object = env.objects[i]!;
      assert.equal(asset.reader, object);
      const where = `${asset.file} ${asset.pathId}`;
      const row = g.objects[asset.file]?.find((o) => o.pathId === String(asset.pathId));
      assert.ok(row, `${where} is in the golden object table`);
      assert.equal(asset.classId, row.classId);
      assert.equal(asset.byteSize, row.byteSize);
      assert.equal(asset.pathId, object.pathId);
      assert.equal(asset.typeName, classIdName(row.classId));
      assert.equal(asset.type, KNOWN.has(asset.typeName) ? asset.typeName : "Other");

      const names = g.serialized![asset.file]!.names;
      assert.equal(asset.name, names[String(asset.pathId)], `${where} name`);
      assert.equal(asset.path, pathOf.get(key(asset.file, asset.pathId)), `${where} path`);
    }
  });

  const { byPath } = expectedContainer(name);
  if (byPath.size === 0) continue;
  test(`${name}: get(path) finds the first object UnityPy lists under each path`, () => {
    const env = loadBytes(name);
    for (const [path, target] of byPath) {
      const asset = env.get(path);
      assert.ok(asset, path);
      assert.equal(key(asset.file, asset.pathId), target, path);
      // Unity stores the path lower-cased; the project's spelling matches too.
      assert.equal(env.get(path.toUpperCase()), asset);
    }
    assert.equal(env.get("assets/not/in/the/bundle.png"), undefined);
  });
}

test("data is reader.read() in its friendly shape, read once and kept", () => {
  const env = loadBytes("editor/6000.3.25f1/lz4/main");
  for (const asset of env.assets()) {
    const first = asset.data;
    assert.equal(asset.data, first, `${asset.typeName} ${asset.pathId}: cached`);
    // The mapping itself is checked field by field in fields.test.ts (#184).
    assert.deepStrictEqual(first, readAssetData(asset.reader), `${asset.typeName} ${asset.pathId}`);
  }
  const mesh = [...env.assets()].find((a) => a.classId === ClassID.Mesh)!;
  assert.equal(mesh.type, "Other");
  assert.equal(mesh.typeName, "Mesh");
  assert.deepStrictEqual(mesh.data, mesh.reader.readTypeTree());
});

test("each call yields the same asset objects", () => {
  const env = loadBytes("editor/6000.3.25f1/lz4/texture");
  const a = [...env.assets()];
  const b = [...env.assets()];
  assert.equal(a.length, b.length);
  a.forEach((asset, i) => assert.equal(asset, b[i]));
  assert.equal(env.get("assets/fixtures/texture/checker.png"), a.find((x) => x.name === "checker"));
});

test("name reads the type tree only as far as m_Name", () => {
  const env = loadBytes("editor/6000.3.25f1/lz4/main");
  const mesh = [...env.assets()].find((a) => a.classId === ClassID.Mesh)!;
  assert.equal(mesh.name, "tri");
  // m_Name is Mesh's first field: the rest of the object was not read.
  assert.ok(mesh.reader.position < mesh.byteSize / 2, `stopped at ${mesh.reader.position}`);
});

test("name without a type tree reads the NamedObject or MonoBehaviour header", () => {
  const env = loadBytes("editor/6000.3.25f1/lz4-notypetree/main");
  const byClass = new Map([...env.assets()].map((a) => [a.classId, a]));
  const mesh = byClass.get(ClassID.Mesh)!;
  assert.equal(mesh.reader.serializedType?.nodes ?? null, null);
  assert.equal(mesh.name, "tri");
  assert.equal(byClass.get(ClassID.MonoBehaviour)!.name, "data");
});

test("a failed data read throws at access, naming the file, class and path id, every time", () => {
  const env = loadBytes("editor/6000.3.25f1/lz4-notypetree/main");
  const mesh = [...env.assets()].find((a) => a.classId === ClassID.Mesh)!;
  const expected = (error: unknown): boolean => {
    assert.ok(error instanceof UnsupportedError);
    assert.match(error.message, new RegExp(`^input 0: ${mesh.file}: Mesh ${mesh.pathId}: `));
    assert.equal(error.kind, "object without a type tree");
    return true;
  };
  assert.throws(() => mesh.data, expected);
  // A failure is not kept: it is read, and refused, again.
  assert.throws(() => mesh.data, expected);
});

test("assets(...types) keeps only those types", () => {
  const env = loadBytes("editor/6000.3.25f1/sprite/sprites");
  const all = [...env.assets()];
  const picked = [...env.assets("Texture2D", "Sprite")];
  assert.deepStrictEqual(
    picked,
    all.filter((a) => a.type === "Texture2D" || a.type === "Sprite"),
  );
  assert.ok(picked.some((a) => a.type === "Sprite"));
  assert.ok(picked.some((a) => a.type === "Texture2D"));
  for (const sprite of env.assets("Sprite")) {
    assert.equal(typeof sprite.data.rect.width, "number");
  }

  const main = loadBytes("editor/6000.3.25f1/lz4/main");
  const other: Asset[] = [...main.assets("Other")];
  assert.deepStrictEqual(
    other.map((a) => a.typeName),
    [...main.assets()].filter((a) => !KNOWN.has(a.typeName)).map((a) => a.typeName),
  );
  assert.ok(other.length > 0);
  assert.deepStrictEqual([...main.assets("MovieTexture")], []);
});

test("a path the container does not list, and an env without bundles", () => {
  // The M1 stand-ins hold no SerializedFile at all.
  const env = loadBytes("lz4.bundle");
  assert.deepStrictEqual([...env.assets()], []);
  assert.equal(env.get("assets/anything.png"), undefined);
});
