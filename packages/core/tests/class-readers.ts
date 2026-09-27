// Shared by the TextAsset, MonoScript and MonoBehaviour tests (#39): the
// fixture objects of one class with the oracle's dump of each (R12), and
// synthetic objects laid out field by field.

import assert from "node:assert/strict";

import { fixtureNames, golden, loadFixture } from "../../../fixtures/helpers.js";
import { load, type Env } from "../src/env.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ObjectReader } from "../src/serialized/ObjectReader.js";
import {
  readSerializedFile,
  type SerializedFile,
  type UnityVersion,
} from "../src/serialized/SerializedFile.js";

/** The same bundle built with type trees: `lz4-notypetree` -> `lz4`. */
export const typedTwin = (name: string): string => name.replace(/lz4-notypetree/g, "lz4");

/** Editor fixtures holding an object of `classId`, per their golden object tables. */
export function fixturesWith(classId: number): string[] {
  return fixtureNames().filter((name) =>
    Object.values(golden(name).objects).some((objs) => objs.some((o) => o.classId === classId)),
  );
}

/** One fixture object of the class, with what the oracle says about it. */
export interface FixtureObject {
  env: Env;
  reader: ObjectReader;
  /** The SerializedFile node the object is in: its data is what views must alias. */
  file: Uint8Array;
  /** Format version and raw Unity version of that file, from the golden. */
  formatVersion: number;
  unityVersion: string;
  enableTypeTree: boolean;
  /**
   * The oracle's `read_typetree()` dump of the object: the fixture's own, or,
   * for a build without type trees, its typed twin's, which holds the same
   * objects under the same path ids. `undefined` for a class the oracle does
   * not dump (MonoScript).
   */
  dump: Record<string, unknown> | undefined;
}

/**
 * Every object of `classId` in a fixture. Each editor fixture holds one
 * SerializedFile, so `env.objects` are all its objects.
 */
export function objectsOf(name: string, classId: number): FixtureObject[] {
  const env = load([{ name, data: loadFixture(name) }]);
  const [path, ...more] = Object.keys(golden(name).serialized ?? {});
  assert.ok(path && !more.length, `${name} does not hold one SerializedFile`);
  const sf = golden(name).serialized![path]!;
  const file = env.files.find((f) => f.path === path)!.data;
  const twin = Object.values(golden(typedTwin(name)).serialized!)[0]!;
  return env.objects
    .filter((reader) => reader.type === classId)
    .map((reader) => ({
      env,
      reader,
      file,
      formatVersion: sf.formatVersion,
      unityVersion: sf.unityVersion,
      enableTypeTree: sf.enableTypeTree,
      dump: twin.typetrees[String(reader.pathId)]?.value as Record<string, unknown> | undefined,
    }));
}

/** A value in the golden's form (plan §5): int64 as a decimal string. */
export function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

/** The raw bytes and file entry of the first `classId` object of a fixture. */
export function objectBytes(
  name: string,
  classId: number,
): { bytes: Uint8Array; sf: SerializedFile; info: SerializedFile["objects"][number] } {
  const env = load([{ name, data: loadFixture(name) }]);
  const data = env.files.find((f) => Boolean(golden(name).serialized![f.path]))!.data;
  const sf = readSerializedFile(data);
  const info = sf.objects.find((o) => o.classId === classId)!;
  assert.equal(sf.bigEndian, false);
  return { bytes: data.slice(info.byteStart, info.byteStart + info.byteSize), sf, info };
}

/**
 * A reader over `bytes` as an object of `from` (a fixture's file and entry)
 * in a file of the given Unity version, platform and, when given,
 * SerializedFile format (the fixture's, 21 or 22, otherwise).
 */
export function synthetic(
  from: Pick<ReturnType<typeof objectBytes>, "sf" | "info">,
  bytes: Uint8Array,
  unity: UnityVersion,
  text = unity.slice(0, 3).join("."),
  platform: BuildTarget = BuildTarget.StandaloneWindows64,
  format = from.sf.header.version,
): ObjectReader {
  const file: SerializedFile = {
    ...from.sf,
    header: { ...from.sf.header, version: format },
    unityVersion: text,
    version: unity,
    targetPlatform: platform,
  };
  return new ObjectReader(bytes, file, { ...from.info, byteStart: 0, byteSize: bytes.length });
}

/**
 * Little-endian bytes for a field layout, and the object a reader must return
 * for it. Fields are `"<kind> <name>"`, or `"align"`; kinds: `i32`, `u32`,
 * `u8`, `bool`, `str` (aligned string), `bytes` (count + 3 bytes, not
 * aligned), `pptr` (Int32 file id + Int64 path id), `pptr32` (Int32 file id
 * + Int32 path id, format < 14) and `hash`
 * (16 bytes, as a `Hash128`). Each value differs from its neighbours.
 */
export function build(fields: string[]): { bytes: Uint8Array; expected: Record<string, unknown> } {
  const out: number[] = [];
  const view = new DataView(new ArrayBuffer(8));
  const push = (size: number) => out.push(...new Uint8Array(view.buffer, 0, size));
  const expected: Record<string, unknown> = {};
  let bools = 0;
  fields.forEach((field, i) => {
    if (field === "align") {
      while (out.length % 4) out.push(0);
      return;
    }
    const [kind, name] = field.split(" ") as [string, string];
    if (kind === "i32" || kind === "u32") {
      const value = kind === "i32" ? -1000 - i : 0x8000_0000 + i;
      view.setUint32(0, value >>> 0, true);
      push(4);
      expected[name] = value;
    } else if (kind === "u8") {
      out.push(200 + i);
      expected[name] = 200 + i;
    } else if (kind === "bool") {
      const value = bools++ % 2 === 0;
      out.push(value ? 1 : 0);
      expected[name] = value;
    } else if (kind === "str" || kind === "bytes") {
      // Never a multiple of 4, so a missing align shows.
      let text = `${name}#${i}`;
      if (text.length % 4 === 0) text += "x";
      const data = kind === "str" ? new TextEncoder().encode(text) : Uint8Array.of(i, 0xff, i + 2);
      view.setInt32(0, data.length, true);
      push(4);
      out.push(...data);
      if (kind === "str") while (out.length % 4) out.push(0);
      expected[name] = kind === "str" ? text : data;
    } else if (kind === "pptr") {
      view.setInt32(0, i, true);
      push(4);
      view.setBigInt64(0, -(2n ** 60n) - BigInt(i), true);
      push(8);
      expected[name] = { m_FileID: i, m_PathID: -(2n ** 60n) - BigInt(i) };
    } else if (kind === "pptr32") {
      // Format < 14: the path id is 32-bit.
      view.setInt32(0, i, true);
      push(4);
      view.setInt32(0, -1_000_000 - i, true);
      push(4);
      expected[name] = { m_FileID: i, m_PathID: BigInt(-1_000_000 - i) };
    } else if (kind === "hash") {
      const hash: Record<string, number> = {};
      for (let b = 0; b < 16; b++) {
        out.push((i * 16 + b) & 0xff);
        hash[`bytes[${b}]`] = (i * 16 + b) & 0xff;
      }
      expected[name] = hash;
    } else {
      assert.fail(`unknown kind ${kind}`);
    }
  });
  return { bytes: Uint8Array.from(out), expected };
}

/** `bytes` with `extra` appended. */
export const withTail = (bytes: Uint8Array, ...extra: number[]): Uint8Array =>
  Uint8Array.from([...bytes, ...extra]);
