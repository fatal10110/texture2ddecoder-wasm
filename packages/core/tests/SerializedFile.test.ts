import assert from "node:assert/strict";
import { test } from "node:test";

import { fixtureNames, golden, loadFixture } from "../../../fixtures/helpers.js";
import { load } from "../src/env.js";
import { CorruptError, UnsupportedError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import {
  readSerializedFile,
  setUnityVersion,
  type SerializedFile,
} from "../src/serialized/SerializedFile.js";

const hex = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : Buffer.from(bytes).toString("hex");

/** Every fixture whose golden describes at least one SerializedFile. */
const SERIALIZED_FIXTURES = fixtureNames().filter((name) => golden(name).serialized);

/** The unpacked bytes of one SerializedFile node of a fixture. */
function node(name: string, path: string): Uint8Array {
  const file = load([{ name, data: loadFixture(name) }]).files.find((f) => f.path === path);
  assert.ok(file, `${name} has no node ${path}`);
  return file.data;
}

// --- every editor-built fixture against the oracle goldens -------------------

for (const name of SERIALIZED_FIXTURES) {
  for (const [path, expected] of Object.entries(golden(name).serialized!)) {
    test(`${name}: header and externals of ${path} match the golden`, () => {
      const sf = readSerializedFile(node(name, path));
      assert.equal(sf.header.version, expected.formatVersion);
      assert.equal(sf.unityVersion, expected.unityVersion);
      assert.equal(sf.targetPlatform, expected.targetPlatform);
      assert.equal(sf.bigEndian, expected.bigEndian);
      assert.equal(sf.enableTypeTree, expected.enableTypeTree);
      assert.deepEqual(
        sf.externals.map((e) => ({ path: e.pathName, guid: hex(e.guid), type: e.type })),
        expected.externals,
      );
    });

    test(`${name}: object table of ${path} matches the golden`, () => {
      const data = node(name, path);
      const sf = readSerializedFile(data);
      const table = sf.objects
        .map((o) => ({ pathId: String(o.pathId), classId: o.classId, byteSize: o.byteSize }))
        .sort((a, b) => (a.pathId < b.pathId ? -1 : a.pathId > b.pathId ? 1 : 0));
      assert.deepEqual(table, golden(name).objects[path]);
      for (const o of sf.objects) {
        assert.ok(o.byteStart >= sf.header.dataOffset, `object ${o.pathId} starts before data`);
        assert.ok(o.byteStart + o.byteSize <= data.length, `object ${o.pathId} ends past file`);
      }
    });
  }
}

// --- format 21 vs format 22 layouts -----------------------------------------

/** One fixture per format, same bundle, so only the layout differs. */
const FORMAT_21 = { name: "editor/2019.4.41f2/lz4/main", editor: [2019, 4, 41, 2] };
const FORMAT_22 = { name: "editor/6000.3.25f1/lz4/main", editor: [6000, 3, 25, 1] };
const MAIN_CAB = "CAB-ba01e3c16ba268ec36e9543a39dc83ad";

test("format 21 reads the 32-bit header and UInt32 byteStart", () => {
  const data = node(FORMAT_21.name, MAIN_CAB);
  const sf = readSerializedFile(data);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  assert.equal(sf.header.version, 21);
  // The 32-bit fields at 0..16 are the only size fields a format-21 file has.
  assert.equal(sf.header.metadataSize, view.getUint32(0));
  assert.equal(sf.header.fileSize, data.length);
  assert.equal(sf.header.dataOffset, view.getUint32(12));
  assert.deepEqual(sf.version, FORMAT_21.editor);
  assertObjectsTile(sf, data);
});

test("format 22 reads the large-file header and Int64 byteStart", () => {
  const data = node(FORMAT_22.name, MAIN_CAB);
  const sf = readSerializedFile(data);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  assert.equal(sf.header.version, 22);
  // 2020.1+ supersedes the 32-bit fields with the ones after the reserved bytes.
  assert.equal(sf.header.metadataSize, view.getUint32(20));
  assert.equal(sf.header.fileSize, Number(view.getBigInt64(24)));
  assert.equal(sf.header.fileSize, data.length);
  assert.equal(sf.header.dataOffset, Number(view.getBigInt64(32)));
  assert.deepEqual(sf.version, FORMAT_22.editor);
  assertObjectsTile(sf, data);
});

/**
 * Objects laid end to end (Unity pads each start to 8 or 16 bytes) is what a wrong
 * `byteStart` width breaks first: every later field shifts, and starts stop
 * lining up with the previous object's end.
 */
function assertObjectsTile(sf: SerializedFile, data: Uint8Array): void {
  const sorted = [...sf.objects].sort((a, b) => a.byteStart - b.byteStart);
  let end = sf.header.dataOffset;
  for (const o of sorted) {
    assert.ok(o.byteStart >= end && o.byteStart - end < 16, `object ${o.pathId} is misplaced`);
    end = o.byteStart + o.byteSize;
  }
  assert.ok(end <= data.length);
}

test("both SerializedFile formats are covered by the fixtures", () => {
  const formats = new Set(
    SERIALIZED_FIXTURES.flatMap((n) =>
      Object.values(golden(n).serialized!).map((s) => s.formatVersion),
    ),
  );
  assert.deepEqual([...formats].sort(), [21, 22]);
});

test("keeps the stripped-file version suffix but parses only its leading numbers", () => {
  for (const [name, editor] of [
    ["editor/2019.4.41f2/lz4-notypetree/main", [2019, 4, 41, 2]],
    ["editor/2020.3.30f1/lz4-notypetree/main", [2020, 3, 30, 1]],
    ["editor/6000.3.25f1/lz4-notypetree/main", [6000, 3, 25, 1]],
  ] as const) {
    const sf = readSerializedFile(node(name, MAIN_CAB));
    assert.match(sf.unityVersion, /\n2$/);
    assert.deepEqual(sf.version, editor);
    assert.equal(sf.enableTypeTree, false);
    assert.ok(sf.types.every((t) => t.nodes === null));
  }
});

test("setUnityVersion sets both version fields but skips the stripped placeholder", () => {
  const sf = readSerializedFile(node(FORMAT_22.name, MAIN_CAB));
  const written = sf.unityVersion;

  setUnityVersion(sf, "0.0.0");
  assert.equal(sf.unityVersion, written);
  assert.deepEqual(sf.version, FORMAT_22.editor);

  setUnityVersion(sf, "2.6.1f3");
  assert.equal(sf.unityVersion, "2.6.1f3");
  assert.deepEqual(sf.version, [2, 6, 1, 3]);
});

test("reads script types and ref types of the MonoBehaviour fixture", () => {
  const sf = readSerializedFile(node(FORMAT_22.name, MAIN_CAB));
  const expected = golden(FORMAT_22.name).serialized![MAIN_CAB]!;
  assert.equal(sf.scriptTypes.length, 1);
  assert.deepEqual(
    sf.refTypes.map((t) => [t.className, t.namespace, t.assemblyName]),
    expected.refTypes.map((t) => [t.className, t.namespace, t.assembly]),
  );
  assert.deepEqual(
    sf.types.map((t) => [t.classId, hex(t.scriptId), hex(t.oldTypeHash), t.typeDependencies]),
    expected.types.map((t) => [t.classId, t.scriptId, t.oldTypeHash, t.typeDependencies]),
  );
});

// --- unhappy paths ------------------------------------------------------------

test("refuses a format version above 22 as unsupported", () => {
  const data = node(FORMAT_22.name, MAIN_CAB).slice();
  new DataView(data.buffer).setUint32(8, 23);
  assert.throws(() => readSerializedFile(data), UnsupportedError);
});

test("refuses format version 1 as unsupported", () => {
  const data = new Uint8Array(64);
  new DataView(data.buffer).setUint32(8, 1);
  assert.throws(() => readSerializedFile(data), UnsupportedError);
});

test("throws CorruptError when the metadata is cut inside its last string", () => {
  // The last ref type's assembly name ends 6 bytes before the metadata does;
  // a cut there used to come back as "Assembly-CS" instead of an error.
  const data = node(FORMAT_22.name, MAIN_CAB);
  const { header } = readSerializedFile(data);
  const metadataEnd = 48 + header.metadataSize;
  assert.throws(() => readSerializedFile(data.subarray(0, metadataEnd - 6)), CorruptError);
});

test("throws CorruptError on truncated metadata", () => {
  const data = node(FORMAT_21.name, MAIN_CAB);
  const sf = readSerializedFile(data);
  // Cut inside the type table.
  const cut = data.subarray(0, 20 + Math.floor(sf.header.metadataSize / 2));
  assert.throws(() => readSerializedFile(cut), CorruptError);
});

// --- formats without a fixture: hand-built files ------------------------------

/** Minimal byte writer; positions are absolute, so `align` matches the reader's. */
class Writer {
  private readonly bytes: number[] = [];
  constructor(private little: boolean) {}
  setLittle(little: boolean): void {
    this.little = little;
  }
  get length(): number {
    return this.bytes.length;
  }
  private put(size: number, write: (v: DataView) => void): this {
    const view = new DataView(new ArrayBuffer(size));
    write(view);
    this.bytes.push(...new Uint8Array(view.buffer));
    return this;
  }
  u8(v: number): this {
    return this.put(1, (d) => d.setUint8(0, v));
  }
  u16(v: number): this {
    return this.put(2, (d) => d.setUint16(0, v, this.little));
  }
  i16(v: number): this {
    return this.put(2, (d) => d.setInt16(0, v, this.little));
  }
  u32(v: number): this {
    return this.put(4, (d) => d.setUint32(0, v, this.little));
  }
  i32(v: number): this {
    return this.put(4, (d) => d.setInt32(0, v, this.little));
  }
  i64(v: bigint): this {
    return this.put(8, (d) => d.setBigInt64(0, v, this.little));
  }
  raw(v: ArrayLike<number>): this {
    this.bytes.push(...Array.from(v));
    return this;
  }
  str(v: string): this {
    return this.raw([...new TextEncoder().encode(v), 0]);
  }
  align(): this {
    while (this.bytes.length % 4) this.bytes.push(0);
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** One pre-blob type tree node with no children. */
function legacyLeaf(w: Writer, type: string, name: string, byteSize: number): void {
  w.str(type).str(name).i32(byteSize).i32(0).i32(0).i32(1).i32(0).i32(0);
}

test("format 8: metadata at the end, inline type tree, 32-bit path ids", () => {
  // Metadata first, so its size is known when the header is written.
  const meta = new Writer(false);
  meta.u8(0); // endianess: little
  meta.setLittle(true);
  meta.str("3.4.2f1").i32(BuildTarget.StandaloneWindows);
  meta.i32(1).i32(49); // one type: TextAsset
  meta.str("TextAsset").str("Base").i32(-1).i32(0).i32(0).i32(1).i32(0).i32(1); // root, 1 child
  legacyLeaf(meta, "string", "m_Name", -1);
  meta.i32(0); // bigIDEnabled
  meta.i32(1).i32(7).u32(0).u32(12).i32(49).u16(49).u16(0); // one object
  meta.i32(1).str("").raw(new Uint8Array(16).fill(0xab)).i32(2).str("library/other.assets");
  meta.str("user info");
  const metadata = meta.done();

  const dataSize = 16;
  const fileSize = 16 + dataSize + metadata.length;
  const w = new Writer(false);
  w.u32(metadata.length).u32(fileSize).u32(8).u32(16);
  w.raw(new Uint8Array(dataSize)).raw(metadata);

  const sf = readSerializedFile(w.done());
  assert.equal(sf.bigEndian, false);
  assert.equal(sf.unityVersion, "3.4.2f1");
  assert.deepEqual(sf.version, [3, 4, 2, 1]);
  assert.equal(sf.targetPlatform, BuildTarget.StandaloneWindows);
  assert.equal(sf.enableTypeTree, true);
  assert.deepEqual(
    sf.types[0]!.nodes!.map((n) => [n.level, n.type, n.name]),
    [
      [0, "TextAsset", "Base"],
      [1, "string", "m_Name"],
    ],
  );
  assert.equal(sf.types[0]!.oldTypeHash, null);
  assert.deepEqual(sf.objects, [
    {
      pathId: 7n,
      byteStart: 16,
      byteSize: 12,
      typeId: 49,
      classId: 49,
      serializedType: sf.types[0],
      isDestroyed: 0,
      stripped: 0,
    },
  ]);
  assert.deepEqual(sf.scriptTypes, []);
  assert.equal(sf.externals[0]!.fileName, "other.assets");
  assert.equal(sf.externals[0]!.type, 2);
  assert.deepEqual(sf.refTypes, []);
  assert.equal(sf.userInformation, "user info");
});

test("format 15: big-endian blob tree, script index and stripped byte on the object", () => {
  const w = new Writer(false);
  w.u32(0).u32(0).u32(15).u32(0); // sizes are not read past the header
  w.u8(1).raw([0, 0, 0]); // endianess: big
  w.str("5.3.8f2").i32(BuildTarget.Android).u8(1);
  w.i32(1).i32(-3); // one type: a script type (negative class id before 5.5)
  w.raw(new Uint8Array(16).fill(1)).raw(new Uint8Array(16).fill(2)); // scriptId, oldTypeHash
  const strings = [..."MonoBehaviour\0Base\0"].map((c) => c.charCodeAt(0));
  w.i32(1).i32(strings.length);
  w.u16(1).u8(0).u8(0).u32(0).u32(14).i32(-1).i32(0).i32(0x8000);
  w.raw(strings);
  // No bigIDEnabled from format 14 on.
  w.i32(1).align().i64(-2n).u32(64).u32(8).i32(-3).u16(114).i16(0).u8(1);
  w.i32(1).i32(0).align().i64(11400n); // one script type
  w.i32(0); // no externals
  w.str("");

  const sf = readSerializedFile(w.done());
  assert.equal(sf.bigEndian, true);
  const [type] = sf.types;
  assert.deepEqual(
    type!.nodes!.map((n) => [n.type, n.name, n.metaFlag, n.refTypeHash]),
    [["MonoBehaviour", "Base", 0x8000, 0n]],
  );
  assert.equal(hex(type!.scriptId), "01".repeat(16));
  assert.equal(type!.scriptTypeIndex, 0); // written back from the object entry
  const [obj] = sf.objects;
  assert.equal(obj!.pathId, -2n);
  assert.equal(obj!.classId, 114);
  assert.equal(obj!.stripped, 1);
  assert.equal(obj!.serializedType, type);
  assert.deepEqual(sf.scriptTypes, [{ localSerializedFileIndex: 0, localIdentifierInFile: 11400n }]);
});

test("throws CorruptError when an object names a type index that does not exist", () => {
  const w = new Writer(false);
  w.u32(0).u32(0).u32(17).u32(0).u8(0).raw([0, 0, 0]);
  w.setLittle(true);
  w.str("2018.4.0f1").i32(19).u8(0); // no type trees
  w.i32(1).i32(49).u8(0).i16(-1).raw(new Uint8Array(16));
  w.i32(1).align().i64(1n).u32(0).u32(4).i32(5); // type index 5 of 1
  assert.throws(
    () => readSerializedFile(w.done()),
    (e) => e instanceof CorruptError && /type index 5, but the file has 1 types/.test(e.message),
  );
});

test("throws CorruptError on a count larger than the bytes left", () => {
  // Format 3 externals are a bare C string each, which reads as "" at the end
  // of the data without advancing - so only the count check can catch this.
  const meta = new Writer(false);
  meta.u8(0).setLittle(true);
  meta.i32(0).i32(0).i32(3); // no types, no objects, three externals
  const metadata = meta.done();
  const w = new Writer(false);
  w.u32(metadata.length).u32(16 + metadata.length).u32(3).u32(16).raw(metadata);
  assert.throws(
    () => readSerializedFile(w.done()),
    (e) => e instanceof CorruptError && /external count 3/.test(e.message),
  );
});

test("maps a target platform upstream does not know to UnknownPlatform", () => {
  const w = new Writer(false);
  w.u32(0).u32(0).u32(17).u32(0).u8(0).raw([0, 0, 0]);
  w.setLittle(true);
  w.str("2018.4.0f1").i32(22).u8(0).i32(0).i32(0).i32(0).i32(0).str("");
  assert.equal(readSerializedFile(w.done()).targetPlatform, BuildTarget.UnknownPlatform);
});
