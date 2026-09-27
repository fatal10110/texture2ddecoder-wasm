import assert from "node:assert/strict";
import { test } from "node:test";

import { golden, loadFixture } from "../../../fixtures/helpers.js";
import type { PPtr, PPtrResolution } from "../src/classes/PPtr.js";
import { load, type Env, type LoadedFile } from "../src/env.js";
import { ClassID } from "../src/serialized/ClassID.js";
import type { ObjectReader } from "../src/serialized/ObjectReader.js";

/** One editor per SerializedFile layout; 2020.3 and 6000 are both format 22. */
const EDITORS = [
  { editor: "2019.4.41f2", format: 21 },
  { editor: "2020.3.30f1", format: 22 },
  { editor: "6000.3.25f1", format: 22 },
];

const MAIN_CAB = "CAB-ba01e3c16ba268ec36e9543a39dc83ad";
const SHARED_CAB = "CAB-71fca072df859359e7a6b09ff7151c53";

/** A pointer as the goldens dump it: the path id as a decimal string. */
interface GoldenPPtr {
  m_FileID: number;
  m_PathID: string;
}

const pptr = ({ m_FileID, m_PathID }: GoldenPPtr): PPtr => ({
  m_FileID,
  m_PathID: BigInt(m_PathID),
});

/** The oracle's typetree dump of one object of a fixture's only SerializedFile. */
function dump<T>(fixture: string, cab: string, pathId: bigint): T {
  const entry = golden(fixture).serialized?.[cab]?.typetrees[String(pathId)];
  assert.ok(entry, `${fixture} has no typetree dump for ${cab} object ${pathId}`);
  return entry.value as T;
}

/** The golden object table row of `pathId` in a fixture's SerializedFile. */
function row(fixture: string, cab: string, pathId: bigint): { classId: number } | undefined {
  return golden(fixture).objects[cab]?.find((r) => r.pathId === String(pathId));
}

function loadFixtures(...names: string[]): Env {
  return load(names.map((name) => ({ name, data: loadFixture(name) })));
}

/**
 * The first object of `type` in the env. `objects` is in load order, and each
 * fixture file holds at most one object of a class, so this is the one in the
 * first file loaded that has any.
 */
function only(env: Env, type: number): ObjectReader {
  const object = env.objects.find((o) => o.type === type);
  assert.ok(object, `no object of class ${type}`);
  return object;
}

function found(result: PPtrResolution): ObjectReader {
  if (result.status !== "found") assert.fail(`expected a resolved pointer, got ${result.status}`);
  return result.object;
}

interface MonoBehaviourDump {
  m_GameObject: GoldenPPtr;
  m_Script: GoldenPPtr;
  textRef: GoldenPPtr;
}

interface AssetBundleDump {
  m_PreloadTable: GoldenPPtr[];
  m_Container: [string, { asset: GoldenPPtr }][];
  m_MainAsset: { asset: GoldenPPtr };
}

// --- across files -------------------------------------------------------------

for (const { editor, format } of EDITORS) {
  const main = `editor/${editor}/lz4/main`;
  const shared = `editor/${editor}/lz4/shared`;

  test(`${editor} (format ${format}): main's textRef resolves to shared's TextAsset`, () => {
    const env = loadFixtures(main, shared);
    const behaviour = only(env, ClassID.MonoBehaviour);
    assert.equal(behaviour.format, format);
    const { textRef } = dump<MonoBehaviourDump>(main, MAIN_CAB, behaviour.pathId);
    assert.equal(textRef.m_FileID, 1, "textRef should point through main's first external");

    const text = found(env.resolve(pptr(textRef), behaviour));
    assert.equal(text.pathId, BigInt(textRef.m_PathID));
    assert.equal(text.type, ClassID.TextAsset);
    // The oracle's own tables put that path id, as a TextAsset, in shared only.
    assert.equal(row(shared, SHARED_CAB, text.pathId)?.classId, ClassID.TextAsset);
    assert.equal(row(main, MAIN_CAB, text.pathId), undefined);
    assert.equal(dump<{ m_Name: string }>(shared, SHARED_CAB, text.pathId).m_Name, "hello");
  });

  test(`${editor}: the cross-file pointer resolves whichever bundle is loaded first`, () => {
    const env = loadFixtures(shared, main);
    const behaviour = only(env, ClassID.MonoBehaviour);
    const { textRef } = dump<MonoBehaviourDump>(main, MAIN_CAB, behaviour.pathId);
    assert.equal(found(env.resolve(pptr(textRef), behaviour)).type, ClassID.TextAsset);
  });

  // --- within one file ----------------------------------------------------------

  test(`${editor}: the AssetBundle's preload table resolves in the same file and across`, () => {
    const env = loadFixtures(main, shared);
    const bundle = only(env, ClassID.AssetBundle);
    const { m_PreloadTable } = dump<AssetBundleDump>(main, MAIN_CAB, bundle.pathId);

    const local = m_PreloadTable.filter((p) => p.m_FileID === 0);
    assert.ok(local.length >= 3, "the fixture should preload several objects of its own file");
    for (const entry of m_PreloadTable) {
      const object = found(env.resolve(pptr(entry), bundle));
      assert.equal(object.pathId, BigInt(entry.m_PathID));
      const cab = entry.m_FileID === 0 ? MAIN_CAB : SHARED_CAB;
      const fixture = entry.m_FileID === 0 ? main : shared;
      assert.equal(object.type, row(fixture, cab, object.pathId)?.classId);
    }
  });

  test(`${editor}: container assets and m_Script resolve in the same file`, () => {
    const env = loadFixtures(main);
    const bundle = only(env, ClassID.AssetBundle);
    const { m_Container } = dump<AssetBundleDump>(main, MAIN_CAB, bundle.pathId);
    const types = m_Container.map(([, { asset }]) => found(env.resolve(pptr(asset), bundle)).type);
    assert.deepEqual(types.sort(), [ClassID.Mesh, ClassID.MonoBehaviour].sort());

    const behaviour = only(env, ClassID.MonoBehaviour);
    const { m_Script } = dump<MonoBehaviourDump>(main, MAIN_CAB, behaviour.pathId);
    assert.equal(found(env.resolve(pptr(m_Script), behaviour)).type, ClassID.MonoScript);
  });
}

// --- pointers that reach nothing ------------------------------------------------

const MAIN = "editor/6000.3.25f1/lz4/main";
const SHARED = "editor/6000.3.25f1/lz4/shared";

test("a zero path id is a null pointer, in either file", () => {
  const env = loadFixtures(MAIN, SHARED);
  const behaviour = only(env, ClassID.MonoBehaviour);
  const bundle = only(env, ClassID.AssetBundle);
  const { m_GameObject } = dump<MonoBehaviourDump>(MAIN, MAIN_CAB, behaviour.pathId);
  const { m_MainAsset } = dump<AssetBundleDump>(MAIN, MAIN_CAB, bundle.pathId);

  assert.deepEqual(env.resolve(pptr(m_GameObject), behaviour), { status: "null" });
  assert.deepEqual(env.resolve(pptr(m_MainAsset.asset), bundle), { status: "null" });
  assert.deepEqual(env.resolve({ m_FileID: 1, m_PathID: 0n }, behaviour), { status: "null" });
});

test("a negative file id is a null pointer, as upstream's IsNull has it", () => {
  const env = loadFixtures(MAIN);
  const behaviour = only(env, ClassID.MonoBehaviour);
  assert.deepEqual(env.resolve({ m_FileID: -1, m_PathID: behaviour.pathId }, behaviour), {
    status: "null",
  });
});

test("a pointer into a file that is not loaded names the file to load", () => {
  const env = loadFixtures(MAIN);
  const behaviour = only(env, ClassID.MonoBehaviour);
  const { textRef } = dump<MonoBehaviourDump>(MAIN, MAIN_CAB, behaviour.pathId);
  assert.deepEqual(env.resolve(pptr(textRef), behaviour), {
    status: "fileNotLoaded",
    fileName: SHARED_CAB,
  });
});

test("a path id the target file does not hold is objectNotFound, in either file", () => {
  const env = loadFixtures(MAIN, SHARED);
  const behaviour = only(env, ClassID.MonoBehaviour);
  const missing = 1234567890123n;
  assert.equal(row(MAIN, MAIN_CAB, missing), undefined);
  assert.equal(row(SHARED, SHARED_CAB, missing), undefined);

  assert.deepEqual(env.resolve({ m_FileID: 0, m_PathID: missing }, behaviour), {
    status: "objectNotFound",
    fileName: MAIN_CAB,
  });
  assert.deepEqual(env.resolve({ m_FileID: 1, m_PathID: missing }, behaviour), {
    status: "objectNotFound",
    fileName: SHARED_CAB,
  });
});

test("a file id past the file's externals is fileIdOutOfRange", () => {
  const env = loadFixtures(MAIN, SHARED);
  const behaviour = only(env, ClassID.MonoBehaviour);
  const text = only(env, ClassID.TextAsset);
  // main has one external, so 2 is the first id out of range; shared has none.
  assert.deepEqual(env.resolve({ m_FileID: 2, m_PathID: 1n }, behaviour), {
    status: "fileIdOutOfRange",
  });
  assert.deepEqual(env.resolve({ m_FileID: 1, m_PathID: 1n }, text), {
    status: "fileIdOutOfRange",
  });
});

// --- how an external is matched to a loaded file ---------------------------------

test("an external matches a loaded file by name, ignoring case and directories", () => {
  const sharedNode = loadFixtures(SHARED).files[0]!.data;
  const env = load([
    { name: MAIN, data: loadFixture(MAIN) },
    { name: `some/dir/${SHARED_CAB.toUpperCase()}`, data: sharedNode },
  ]);
  const behaviour = only(env, ClassID.MonoBehaviour);
  const { textRef } = dump<MonoBehaviourDump>(MAIN, MAIN_CAB, behaviour.pathId);
  assert.equal(found(env.resolve(pptr(textRef), behaviour)).type, ClassID.TextAsset);
});

test("a same-file pointer stays in its own file when another loaded file shares its name", () => {
  // Both editors' main bundles hold a CAB of the same name, with different ids.
  const older = "editor/2019.4.41f2/lz4/main";
  const env = loadFixtures(older, MAIN);
  const behaviours = env.objects.filter((o) => o.type === ClassID.MonoBehaviour);
  assert.equal(behaviours.length, 2);
  for (const behaviour of behaviours) {
    const fixture = behaviour.format === 21 ? older : MAIN;
    const { m_Script } = dump<MonoBehaviourDump>(fixture, MAIN_CAB, behaviour.pathId);
    assert.equal(found(env.resolve(pptr(m_Script), behaviour)).type, ClassID.MonoScript);
  }
});

test("an external two other containers answer to resolves into the first one loaded", () => {
  // Both editors' shared bundles hold a CAB of the same name, with different
  // ids: 2019.4's TextAsset id is not in 6000's, while both have the
  // AssetBundle at path id 1. main is a bundle of its own, so neither shared
  // CAB is in its container and the same-container rule falls back.
  const main = "editor/2019.4.41f2/lz4/main";
  const shared19 = "editor/2019.4.41f2/lz4/shared";

  for (const [first, second, format] of [
    [shared19, SHARED, 21],
    [SHARED, shared19, 22],
  ] as const) {
    const env = loadFixtures(main, first, second);
    const behaviour = only(env, ClassID.MonoBehaviour);
    const { textRef } = dump<MonoBehaviourDump>(main, MAIN_CAB, behaviour.pathId);

    const bundle = found(env.resolve({ m_FileID: 1, m_PathID: 1n }, behaviour));
    assert.equal(bundle.type, ClassID.AssetBundle);
    assert.equal(bundle.format, format, `${first} was loaded first`);

    // Only the first file is looked in; the second one is never a fallback.
    const text = env.resolve(pptr(textRef), behaviour);
    if (format === 21) {
      assert.equal(found(text).format, 21);
    } else {
      assert.deepEqual(text, { status: "objectNotFound", fileName: SHARED_CAB });
    }
  }
});

// --- two builds loaded together: the requester's own container first -----------

const MAIN19 = "editor/2019.4.41f2/lz4/main";
const SHARED19 = "editor/2019.4.41f2/lz4/shared";

/** The one node of a single-CAB fixture bundle. */
function node(fixture: string): LoadedFile {
  const [file, ...rest] = loadFixtures(fixture).files;
  assert.ok(file && rest.length === 0, `${fixture} should hold exactly one node`);
  return file;
}

/**
 * A `UnityWebData1.0` container holding `files` loose, the way a WebGL build's
 * `.data` holds the player's SerializedFiles: one container, several files.
 */
function webData(files: LoadedFile[]): Uint8Array {
  const SIGNATURE = "UnityWebData1.0\0";
  let headerLength = SIGNATURE.length + 4;
  for (const { path } of files) headerLength += 12 + path.length;
  const size = files.reduce((total, { data }) => total + data.length, headerLength);

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  const ascii = (text: string): void => {
    for (const char of text) out[at++] = char.charCodeAt(0);
  };
  const u32 = (value: number): void => {
    view.setUint32(at, value, true);
    at += 4;
  };
  ascii(SIGNATURE);
  u32(headerLength);
  let offset = headerLength;
  for (const { path, data } of files) {
    u32(offset);
    u32(data.length);
    u32(path.length);
    ascii(path);
    offset += data.length;
  }
  for (const { data } of files) {
    out.set(data, at);
    at += data.length;
  }
  return out;
}

test("each build's external resolves into its own container when two builds share names", () => {
  // Each container holds one build's main and shared CABs, and both builds use
  // the same two CAB names, so main's textRef names shared's CAB in both. The
  // 2019.4 and 6000 TextAsset ids differ: resolved into the other build's
  // shared, the pointer would be objectNotFound.
  const builds = [
    { name: "2019.4.data", data: webData([node(MAIN19), node(SHARED19)]) },
    { name: "6000.data", data: webData([node(MAIN), node(SHARED)]) },
  ];

  for (const order of [builds, [...builds].reverse()]) {
    const env = load(order);
    const first = `${order[0]!.name} loaded first`;
    const behaviours = env.objects.filter((o) => o.type === ClassID.MonoBehaviour);
    assert.deepEqual(behaviours.map((b) => b.format).sort(), [21, 22]);
    for (const behaviour of behaviours) {
      const main = behaviour.format === 21 ? MAIN19 : MAIN;
      const { textRef } = dump<MonoBehaviourDump>(main, MAIN_CAB, behaviour.pathId);
      assert.equal(textRef.m_FileID, 1);

      const text = found(env.resolve(pptr(textRef), behaviour));
      assert.equal(text.type, ClassID.TextAsset);
      assert.equal(text.pathId, BigInt(textRef.m_PathID));
      assert.equal(text.format, behaviour.format, first);

      // A path id both shared CABs hold: its own build's, not the first one's.
      const bundle = found(env.resolve({ m_FileID: 1, m_PathID: 1n }, behaviour));
      assert.equal(bundle.type, ClassID.AssetBundle);
      assert.equal(bundle.format, behaviour.format, first);
    }
  }
});

test("a loose SerializedFile's external prefers a loose file over a bundle loaded first", () => {
  // The caller's own inputs are one container, as for readResource().
  const main = node(MAIN);
  const shared = node(SHARED);
  const env = load([
    { name: SHARED19, data: loadFixture(SHARED19) },
    { name: main.path, data: main.data },
    { name: shared.path, data: shared.data },
  ]);
  const behaviour = only(env, ClassID.MonoBehaviour);
  assert.equal(behaviour.format, 22);
  const { textRef } = dump<MonoBehaviourDump>(MAIN, MAIN_CAB, behaviour.pathId);
  const text = found(env.resolve(pptr(textRef), behaviour));
  assert.equal(text.type, ClassID.TextAsset);
  assert.equal(text.format, 22);
});

test("refuses to resolve from an object another env loaded", () => {
  const behaviour = only(loadFixtures(MAIN), ClassID.MonoBehaviour);
  const env = loadFixtures(MAIN);
  assert.throws(
    () => env.resolve({ m_FileID: 0, m_PathID: 1n }, behaviour),
    /was not loaded by this env/,
  );
});
