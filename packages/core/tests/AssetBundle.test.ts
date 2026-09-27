// AssetBundle and its container map (#38): the hardcoded reader checked against
// the oracle's typetree dumps (R12) and readTypeTree() on the same objects,
// `obj.read()`, lookup by asset path, and the refusals.

import assert from "node:assert/strict";
import { test } from "node:test";

import { fixtureNames, golden, loadFixture, type Golden } from "../../../fixtures/helpers.js";
import { findAssets, readAssetBundle, type AssetBundle } from "../src/classes/AssetBundle.js";
import type { Texture2DData } from "../src/classes/registry.js";
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

/** Fixtures holding an AssetBundle, per their golden object tables. */
const BUNDLES = fixtureNames().filter((name) =>
  Object.values(golden(name).objects).some((objs) =>
    objs.some((o) => o.classId === ClassID.AssetBundle),
  ),
);
/** Built with `AssetBundleStripUnityVersion`: no Unity version left to gate on. */
const VERSION_STRIPPED = BUNDLES.filter((name) => name.includes("/stripped/"));
/** Built without type trees: the hardcoded reader is the only way in. */
const NO_TYPE_TREE = BUNDLES.filter((name) => name.includes("/lz4-notypetree/"));
const TYPED = BUNDLES.filter((n) => !VERSION_STRIPPED.includes(n) && !NO_TYPE_TREE.includes(n));

const loadName = (name: string): Env => load([{ name, data: loadFixture(name) }]);
const bundlesOf = (env: Env): ObjectReader[] =>
  env.objects.filter((o) => o.type === ClassID.AssetBundle);

/** A golden container entry, as the oracle dumps `m_Container`. */
type GoldenEntry = [string, { asset: { m_FileID: number; m_PathID: string } }];

/**
 * The oracle's dump of every AssetBundle of a fixture, by path id. A build
 * without type trees has none of its own; its typed twin holds the same
 * objects under the same path ids.
 */
function bundleGoldens(name: string): Map<string, Record<string, unknown>> {
  const source = golden(name.replace(/lz4-notypetree/g, "lz4"));
  const out = new Map<string, Record<string, unknown>>();
  for (const [path, sf] of Object.entries(source.serialized ?? {})) {
    for (const { pathId, classId } of source.objects[path] ?? []) {
      if (classId !== ClassID.AssetBundle) continue;
      const dump = sf.typetrees[pathId];
      assert.ok(dump, `${name}: no golden dump for AssetBundle ${pathId}`);
      out.set(pathId, dump.value as Record<string, unknown>);
    }
  }
  return out;
}

/** Plan §5 normalization: every bigint (a path id) as a decimal string. */
function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

// --- editor fixtures --------------------------------------------------------------

for (const name of TYPED) {
  test(`${name}: readAssetBundle equals the golden dump, readTypeTree() and read()`, () => {
    const want = bundleGoldens(name);
    const readers = bundlesOf(loadName(name));
    assert.equal(readers.length, want.size);
    for (const reader of readers) {
      const dump = want.get(String(reader.pathId));
      assert.ok(dump, `no golden for AssetBundle ${reader.pathId}`);

      const bundle = readAssetBundle(reader);
      assert.equal(reader.position, reader.byteSize, "byteSize not consumed exactly");
      // Every field, in Unity's order, with the oracle's values.
      assert.deepEqual(Object.keys(bundle), Object.keys(dump));
      assert.deepEqual(normalize(bundle), dump);

      const tree = reader.readTypeTree();
      assert.deepEqual(Object.keys(bundle), Object.keys(tree));
      assert.deepEqual(bundle, tree);
      // obj.read() takes the hardcoded reader.
      assert.deepEqual(reader.read<AssetBundle>(), bundle);
    }
  });
}

for (const name of NO_TYPE_TREE) {
  test(`${name}: read() gives the typed build's golden, where the type tree cannot`, () => {
    const want = bundleGoldens(name);
    const readers = bundlesOf(loadName(name));
    assert.equal(readers.length, want.size);
    for (const reader of readers) {
      assert.equal(reader.serializedType?.nodes, null, "the file has a type tree after all");
      assert.throws(() => reader.readTypeTree(), UnsupportedError);

      const bundle = reader.read<AssetBundle>();
      assert.equal(reader.position, reader.byteSize, "byteSize not consumed exactly");
      assert.deepEqual(Object.keys(bundle), Object.keys(want.get(String(reader.pathId))!));
      assert.deepEqual(normalize(bundle), want.get(String(reader.pathId)));
    }
  });
}

test("the AssetBundle checks cover formats 21 and 22, typed and not, every editor", () => {
  const seen = new Set<string>();
  for (const name of [...TYPED, ...NO_TYPE_TREE]) {
    const kind = NO_TYPE_TREE.includes(name) ? "notypetree" : "typed";
    for (const sf of Object.values(golden(name).serialized!)) {
      seen.add(`${name.split("/")[1]} ${sf.formatVersion} ${kind}`);
    }
  }
  for (const editor of ["2019.4.41f2 21", "2020.3.30f1 22", "6000.3.25f1 22"]) {
    for (const kind of ["typed", "notypetree"]) assert.ok(seen.has(`${editor} ${kind}`));
  }
  // Every variant's four bundles, per editor.
  assert.equal(NO_TYPE_TREE.length, 12);
});

// --- lookup by asset path ---------------------------------------------------------

interface GoldenAsset {
  path: string;
  pathId: string;
  classId: number;
}

/** Every container entry the oracle lists for a fixture, with the golden object table. */
function goldenEntries(g: Golden): GoldenAsset[] {
  const out: GoldenAsset[] = [];
  for (const [file, sf] of Object.entries(g.serialized ?? {})) {
    const table = g.objects[file] ?? [];
    for (const { pathId, classId } of table) {
      if (classId !== ClassID.AssetBundle) continue;
      const entries = (sf.typetrees[pathId]!.value as { m_Container: GoldenEntry[] }).m_Container;
      for (const [path, { asset }] of entries) {
        // Every fixture's container points into its own file.
        assert.equal(asset.m_FileID, 0);
        const target = table.find((o) => o.pathId === asset.m_PathID);
        assert.ok(target, `${path}: ${asset.m_PathID} is not in the object table`);
        out.push({ path, pathId: asset.m_PathID, classId: target.classId });
      }
    }
  }
  return out;
}

for (const name of [...TYPED, ...NO_TYPE_TREE]) {
  test(`${name}: findAssets resolves every golden container path to its object`, () => {
    const env = loadName(name);
    const entries = goldenEntries(golden(name.replace(/lz4-notypetree/g, "lz4")));
    assert.ok(entries.length > 0);
    for (const { path } of entries) {
      const found = findAssets(env, path);
      const same = entries.filter((e) => e.path === path);
      assert.equal(found.length, same.length, path);
      found.forEach((hit, i) => {
        assert.equal(hit.status, "found", path);
        if (hit.status !== "found") return;
        assert.equal(String(hit.object.pathId), same[i]!.pathId, path);
        assert.equal(hit.object.type, same[i]!.classId, path);
        // The env's own reader, so read() and resolve() work on it.
        assert.ok(env.objects.includes(hit.object));
      });
    }
    assert.deepEqual(findAssets(env, "assets/no/such/asset.asset"), []);
  });
}

test("findAssets over a whole build: each path from its own bundle, texture readable", () => {
  const variant = "editor/2020.3.30f1/lz4-notypetree";
  const names = ["lz4-notypetree", "main", "shared", "texture"].map((b) => `${variant}/${b}`);
  const env = load(names.map((name) => ({ name, data: loadFixture(name) })));
  assert.equal(bundlesOf(env).length, 4);

  let checked = 0;
  for (const name of names) {
    const typed = golden(name.replace(/lz4-notypetree/g, "lz4"));
    for (const { path, pathId, classId } of goldenEntries(typed)) {
      const [hit, ...more] = findAssets(env, path);
      assert.ok(hit?.status === "found" && more.length === 0, path);
      assert.equal(String(hit.object.pathId), pathId);
      assert.equal(hit.object.type, classId);
      checked++;
    }
  }
  assert.ok(checked >= 5);

  // The texture's container path leads to its pixels, read through the .resS.
  const texturePath = goldenEntries(golden("editor/2020.3.30f1/lz4/texture")).find(
    (e) => e.classId === ClassID.Texture2D,
  )!.path;
  const [hit] = findAssets(env, texturePath);
  assert.ok(hit?.status === "found");
  const texture = hit.object.read<Texture2DData>();
  const want = Object.values(golden("editor/2020.3.30f1/lz4/texture").serialized!)[0]!.textures!;
  assert.equal(texture.m_Name, want[String(hit.object.pathId)]!.name);
  assert.equal(texture.imageData.length, want[String(hit.object.pathId)]!.imageSize);
});

test("findAssets compares paths exactly: Unity writes them lower-cased", () => {
  const env = loadName("editor/6000.3.25f1/lz4/main");
  const [path] = goldenEntries(golden("editor/6000.3.25f1/lz4/main")).map((e) => e.path);
  assert.ok(path && path === path.toLowerCase());
  assert.equal(findAssets(env, path).length, 1);
  assert.deepEqual(findAssets(env, path.replace("assets/", "Assets/")), []);
});

test("findAssets passes a dangling asset pointer on as env.resolve's result", () => {
  // The shared bundle's SerializedFile, loaded loose, with its one container
  // entry pointed at a path id the file does not hold.
  const name = "editor/6000.3.25f1/uncompressed/shared";
  const node = loadName(name).files.find((f) => golden(name).serialized![f.path])!;
  const data = node.data.slice();
  const sf = readSerializedFile(data);
  const info = sf.objects.find((o) => o.classId === ClassID.AssetBundle)!;
  const object = data.subarray(info.byteStart, info.byteStart + info.byteSize);
  const [entry, ...more] = readAssetBundle(synthetic(object, U6000)).m_Container;
  assert.ok(entry && more.length === 0);
  const [path, { asset }] = entry;
  // The entry is the path, then preloadIndex, preloadSize and m_FileID.
  const pathBytes = new TextEncoder().encode(path).length;
  const at = containerPathAt(object) + 4 + Math.ceil(pathBytes / 4) * 4 + 12;
  const view = new DataView(object.buffer, object.byteOffset, object.byteLength);
  assert.equal(view.getBigInt64(at, true), asset.m_PathID);
  view.setBigInt64(at, 424242n, true);

  const env = load([{ name: node.path, data }]);
  assert.equal(findAssets(loadName(name), path)[0]?.status, "found");
  assert.deepEqual(findAssets(env, path), [{ status: "objectNotFound", fileName: node.path }]);
});

// --- refusals: a version-stripped build -------------------------------------------

for (const name of VERSION_STRIPPED) {
  test(`${name}: version "0.0.0" is refused; the type tree still reads`, () => {
    const env = loadName(name);
    const [reader] = bundlesOf(env);
    assert.ok(reader);
    assert.deepEqual(reader.version, [0, 0, 0, 0]);
    const refused = (err: unknown) =>
      err instanceof UnsupportedError &&
      err.kind === "Unity version" &&
      err.found === "0.0.0" &&
      err.message.includes(`object ${reader.pathId}`);
    assert.throws(() => readAssetBundle(reader), refused);
    assert.throws(() => reader.read(), refused);
    assert.throws(() => findAssets(env, "assets/fixtures/strip/hello.txt"), refused);
    // The oracle's dump is still there for a caller who reads the type tree.
    const dump = bundleGoldens(name).get(String(reader.pathId));
    assert.deepEqual(normalize(reader.readTypeTree()), dump);
  });
}

test("the version-stripped refusal covers both stripped editors", () => {
  assert.deepEqual(
    [...new Set(VERSION_STRIPPED.map((n) => n.split("/")[1]))].sort(),
    ["2020.3.30f1", "6000.3.25f1"],
  );
});

// --- synthetic objects ------------------------------------------------------------

interface BundleObject {
  bytes: Uint8Array;
  sf: SerializedFile;
  info: SerializedFile["objects"][number];
}

const objectCache = new Map<string, BundleObject>();

/** A fixture's AssetBundle object (6000.3's `main` by default): bytes, file, entry. */
function bundleObject(name = "editor/6000.3.25f1/uncompressed/main"): BundleObject {
  let cached = objectCache.get(name);
  if (!cached) {
    const node = loadName(name).files.find((f) => golden(name).serialized![f.path])!;
    const sf = readSerializedFile(node.data);
    assert.equal(sf.bigEndian, false);
    const info = sf.objects.find((o) => o.classId === ClassID.AssetBundle)!;
    const bytes = node.data.slice(info.byteStart, info.byteStart + info.byteSize);
    objectCache.set(name, (cached = { bytes, sf, info }));
  }
  return cached;
}

/**
 * A reader over `bytes` as an AssetBundle of a file with the given version,
 * platform and SerializedFile format.
 */
function synthetic(
  bytes: Uint8Array,
  unity: UnityVersion,
  {
    text = unity.slice(0, 3).join("."),
    platform = BuildTarget.StandaloneWindows64 as BuildTarget,
    format = 22,
  } = {},
): ObjectReader {
  const { sf, info } = bundleObject();
  const file: SerializedFile = {
    ...sf,
    header: { ...sf.header, version: format },
    unityVersion: text,
    version: unity,
    targetPlatform: platform,
  };
  return new ObjectReader(bytes, file, { ...info, byteStart: 0, byteSize: bytes.length });
}

const U6000: UnityVersion = [6000, 3, 25, 1];

/**
 * Field layouts from Unity's own type trees (UnityPy's TPK data), by the
 * version they start at. Entries are `"<kind> <name>"`, each kind a whole
 * field; editor files add the `EditorExtension` fields in front of `m_Name`.
 */
const HEAD = ["str m_Name", "pptrs m_PreloadTable", "container m_Container", "info m_MainAsset"];
const V5_TAIL = ["str m_AssetBundleName", "strs m_Dependencies"]
  .concat("bool m_IsStreamedSceneAssetBundle");
const L3_4 = [...HEAD, "scripts m_ScriptCompatibility"];
const L3_5 = [...L3_4, "classVersions m_ClassCompatibility"];
const L4_2 = [...L3_5, "u32 m_RuntimeCompatibility"];
const L5_0 = [...HEAD, "u32 m_RuntimeCompatibility", ...V5_TAIL];
const L5_4 = [...HEAD, "intPairs m_ClassVersionMap", "u32 m_RuntimeCompatibility", ...V5_TAIL];
const L2017_1 = [...L5_0, "i32 m_PathFlags"];
const L2017_3 = [...L5_0, "i32 m_ExplicitDataLayout", "i32 m_PathFlags", "hashes m_SceneHashes"];

/**
 * Every layout at its first version, and, for each gate, the last minor release
 * before it still on the previous layout. Before 5.0 the file is format 9, with
 * 32-bit path ids.
 */
const LAYOUTS: { unity: UnityVersion; fields: string[] }[] = [
  { unity: [3, 4, 0, 1], fields: L3_4 },
  { unity: [3, 5, 0, 1], fields: L3_5 },
  { unity: [4, 1, 0, 1], fields: L3_5 },
  { unity: [4, 2, 0, 1], fields: L4_2 },
  { unity: [4, 7, 0, 1], fields: L4_2 },
  { unity: [5, 0, 0, 1], fields: L5_0 },
  { unity: [5, 3, 0, 1], fields: L5_0 },
  { unity: [5, 4, 0, 1], fields: L5_4 },
  { unity: [5, 5, 0, 1], fields: L5_0 },
  { unity: [5, 6, 0, 1], fields: L5_0 },
  { unity: [2017, 1, 0, 1], fields: L2017_1 },
  { unity: [2017, 2, 0, 1], fields: L2017_1 },
  { unity: [2017, 3, 0, 1], fields: L2017_3 },
  { unity: U6000, fields: L2017_3 },
];

/**
 * Little-endian bytes for a layout, each value distinct from its neighbours,
 * and the object the reader must return for it. Strings have odd lengths, so
 * a missing align shows.
 */
function build(fields: string[], format = 22): { bytes: Uint8Array; expected: AssetBundle } {
  const out: number[] = [];
  const view = new DataView(new ArrayBuffer(8));
  const push = (size: number) => out.push(...new Uint8Array(view.buffer, 0, size));
  const align = () => {
    while (out.length % 4) out.push(0);
  };
  let n = 0;
  const i32 = (value = -1000 - ++n) => (view.setInt32(0, value, true), push(4), value);
  const u32 = (value = 0x8000_0000 + ++n) => (view.setUint32(0, value, true), push(4), value);
  const str = (value = `s${++n}.`) => {
    const data = new TextEncoder().encode(value);
    i32(data.length);
    out.push(...data);
    align();
    return value;
  };
  const pptr = () => {
    const m_FileID = i32(++n % 3);
    if (format < 14) return { m_FileID, m_PathID: BigInt(i32(100 + ++n)) };
    const m_PathID = -(2n ** 60n) - BigInt(++n);
    view.setBigInt64(0, m_PathID, true);
    push(8);
    return { m_FileID, m_PathID };
  };
  const info = () => ({ preloadIndex: i32(), preloadSize: i32(), asset: pptr() });
  const list = <T>(count: number, element: () => T): T[] => {
    i32(count);
    return Array.from({ length: count }, element);
  };

  const expected: Record<string, unknown> = {};
  for (const field of fields) {
    const [kind, name] = field.split(" ") as [string, string];
    const read: Record<string, () => unknown> = {
      str,
      i32: () => i32(),
      u32: () => u32(),
      bool: () => {
        out.push(1);
        align();
        return true;
      },
      info,
      pptrs: () => list(2, pptr),
      container: () => list(2, () => [str(), info()]),
      strs: () => list(2, () => str()),
      scripts: () =>
        list(2, () => ({ className: str(), nameSpace: str(), assemblyName: str(), hash: u32() })),
      classVersions: () => list(2, () => [i32(), u32()]),
      intPairs: () => list(2, () => [i32(), i32()]),
      hashes: () => list(2, () => [str(), str()]),
    };
    assert.ok(read[kind], `unknown kind ${kind}`);
    expected[name] = read[kind]();
  }
  return { bytes: Uint8Array.from(out), expected: expected as unknown as AssetBundle };
}

for (const { unity, fields } of LAYOUTS) {
  test(`Unity ${unity.slice(0, 3).join(".")}: the layout of Unity's type tree`, () => {
    const format = unity[0] < 5 ? 9 : 22;
    const { bytes, expected } = build(fields, format);
    const reader = synthetic(bytes, unity, { format });
    const bundle = readAssetBundle(reader);
    assert.deepEqual(Object.keys(bundle), Object.keys(expected));
    assert.deepEqual(bundle, expected);
    assert.equal(reader.remaining, 0);
  });
}

test("an editor file (NoTarget): the EditorExtension fields, then the same layout", () => {
  const { bytes, expected } = build(L2017_3);
  // m_ObjectHideFlags, then 2018.3+'s three prefab pointers, all null.
  const header = new Uint8Array(4 + 3 * 12);
  header[0] = 7;
  const reader = synthetic(Uint8Array.from([...header, ...bytes]), U6000, {
    platform: BuildTarget.NoTarget,
  });
  const nil = { m_FileID: 0, m_PathID: 0n };
  assert.deepEqual(readAssetBundle(reader), {
    m_ObjectHideFlags: 7,
    m_CorrespondingSourceObject: nil,
    m_PrefabInstance: nil,
    m_PrefabAsset: nil,
    ...expected,
  });
});

/**
 * Per the class-reader rule on #36: an all-zero version is refused with the
 * file's own version string, from a stripped file (`"0.0.0"`) or a loose file
 * below format 7 (`"2.5.0f5"`, #98). Before 3.4 no type tree data says what an
 * AssetBundle holds.
 */
const REFUSED: { unity: UnityVersion; text: string }[] = [
  { unity: [0, 0, 0, 0], text: "0.0.0" },
  { unity: [0, 0, 0, 0], text: "2.5.0f5" },
  { unity: [3, 3, 0, 1], text: "3.3.0f1" },
];

for (const { unity, text } of REFUSED) {
  test(`Unity "${text}": UnsupportedError("Unity version")`, () => {
    const reader = synthetic(bundleObject().bytes, unity, { text });
    assert.throws(
      () => readAssetBundle(reader),
      (err: unknown) =>
        err instanceof UnsupportedError &&
        err.kind === "Unity version" &&
        err.found === text &&
        err.message.includes(`object ${reader.pathId}`),
    );
  });
}

// --- truncated, oversized and corrupt objects ---------------------------------------

const TRUNCATED: { name: string; unity: UnityVersion }[] = [
  { name: "editor/2019.4.41f2/uncompressed/main", unity: [2019, 4, 41, 2] },
  { name: "editor/6000.3.25f1/uncompressed/main", unity: U6000 },
];

for (const { name, unity } of TRUNCATED) {
  test(`${name}: every cut throws CorruptError`, () => {
    const { bytes } = bundleObject(name);
    assert.equal(readAssetBundle(synthetic(bytes, unity)).m_Container.length, 2);
    for (let cut = 0; cut < bytes.length; cut++) {
      const reader = synthetic(bytes.subarray(0, cut), unity);
      assert.throws(() => readAssetBundle(reader), CorruptError, `cut at ${cut}`);
    }
  });
}

test("bytes left after m_SceneHashes throw CorruptError", () => {
  const { bytes } = bundleObject();
  const reader = synthetic(Uint8Array.from([...bytes, 0, 0, 0, 0]), U6000);
  assert.throws(
    () => readAssetBundle(reader),
    (err: unknown) =>
      err instanceof CorruptError &&
      err.message ===
        `AssetBundle ${reader.pathId} ends at ${bytes.length} of its ${bytes.length + 4} bytes`,
  );
});

/** Offset of the first container path's length in the 6000.3 `main` AssetBundle. */
function containerPathAt(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameEnd = 4 + Math.ceil(view.getInt32(0, true) / 4) * 4;
  const preloadCount = view.getInt32(nameEnd, true);
  // Then the container count, then the first path.
  return nameEnd + 4 + preloadCount * 12 + 4;
}

for (const [what, length] of [["negative", -1], ["past the end", 0x7fff_ffff]] as const) {
  test(`a container path length ${what} throws CorruptError, not ""`, () => {
    const copy = bundleObject().bytes.slice();
    const at = containerPathAt(copy);
    const path = readAssetBundle(synthetic(copy, U6000)).m_Container[0]![0];
    assert.equal(new DataView(copy.buffer).getInt32(at, true), path.length);
    new DataView(copy.buffer).setInt32(at, length, true);
    assert.throws(
      () => readAssetBundle(synthetic(copy, U6000)),
      (err: unknown) =>
        err instanceof CorruptError && err.message.includes("m_Container path byte count"),
    );
  });
}

test("a container count past the end throws CorruptError", () => {
  const copy = bundleObject().bytes.slice();
  new DataView(copy.buffer).setInt32(containerPathAt(copy) - 4, 1 << 20, true);
  assert.throws(() => readAssetBundle(synthetic(copy, U6000)), /m_Container count 1048576/);
});
