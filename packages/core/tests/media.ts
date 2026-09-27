// Shared by the AudioClip, Font, VideoClip and MovieTexture tests (#41): the
// oracle's raw-data goldens, the golden's normalization driven by its own type
// tree, and a writer for hand-built layouts from Unity's type trees (TPK).

import assert from "node:assert/strict";

import {
  golden,
  loadFixture,
  type GoldenNode,
  type GoldenRawData,
} from "../../../fixtures/helpers.js";
import { load } from "../src/env.js";
import { UnsupportedError } from "../src/errors.js";
import { BuildTarget } from "../src/serialized/BuildTarget.js";
import { ObjectReader } from "../src/serialized/ObjectReader.js";
import {
  readSerializedFile,
  type SerializedFile,
  type UnityVersion,
} from "../src/serialized/SerializedFile.js";
import { typedTwin } from "./class-readers.js";

/**
 * The oracle's raw-data golden of an object, by fixture and path id: the
 * fixture's own, or, built without type trees, its typed twin's.
 */
export function rawGolden(name: string, pathId: bigint): GoldenRawData | undefined {
  const [sf] = Object.values(golden(typedTwin(name)).serialized ?? {});
  return sf?.rawData?.[String(pathId)];
}

/** The golden type tree of a class in a fixture (its typed twin's), as nested nodes. */
export function goldenTree(name: string, classId: number): TreeNode {
  const [sf] = Object.values(golden(typedTwin(name)).serialized ?? {});
  const nodes = sf?.types.find((t) => t.classId === classId)?.nodes;
  assert.ok(nodes, `${name}: no golden type tree for class ${classId}`);
  return nest(nodes);
}

/** A golden type tree node with its children. */
export interface TreeNode {
  type: string;
  name: string;
  children: TreeNode[];
}

function nest(nodes: GoldenNode[]): TreeNode {
  const root: TreeNode = { type: nodes[0]![1], name: nodes[0]![2], children: [] };
  const stack: [number, TreeNode][] = [[nodes[0]![0], root]];
  for (const [level, type, name] of nodes.slice(1)) {
    const node: TreeNode = { type, name, children: [] };
    while (stack.at(-1)![0] >= level) stack.pop();
    stack.at(-1)![1].children.push(node);
    stack.push([level, node]);
  }
  return root;
}

const INT64 = new Set(["SInt64", "UInt64", "FileSize", "long long", "unsigned long long"]);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/**
 * A value in the golden's form (plan §5), driven by the golden's own type tree
 * node as `make-goldens.py` does: 64-bit integers (a `bigint`, or a `number`
 * for a byte offset or size) as decimal strings, `float` and `double` by bit
 * pattern, bytes as hex. Keys stay in the value's order, so a key-order check
 * still means something after it.
 */
export function goldenForm(node: TreeNode, value: unknown): unknown {
  if (INT64.has(node.type)) return String(value);
  if (node.type === "float" || node.type === "double") {
    const size = node.type === "float" ? 4 : 8;
    const view = new DataView(new ArrayBuffer(size));
    if (size === 4) view.setFloat32(0, value as number);
    else view.setFloat64(0, value as number);
    return `${node.type === "float" ? "f32" : "f64"}:${hex(new Uint8Array(view.buffer))}`;
  }
  if (value instanceof Uint8Array) return `hex:${hex(value)}`;
  if (value === null || typeof value !== "object") return value;
  if (node.type === "pair") {
    const [first, second] = value as [unknown, unknown];
    return [goldenForm(node.children[0]!, first), goldenForm(node.children[1]!, second)];
  }
  const array = node.children[0];
  if (array?.type === "Array") {
    return (value as unknown[]).map((v) => goldenForm(array.children[1]!, v));
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const child = node.children.find((c) => c.name === key);
    assert.ok(child, `no golden node for ${node.name}.${key}`);
    out[key] = goldenForm(child, v);
  }
  return out;
}

/** A fixture's SerializedFile and one of its object entries, for hand-built readers. */
export interface Template {
  sf: SerializedFile;
  info: SerializedFile["objects"][number];
}

/** The first `classId` object of a fixture's SerializedFile. */
export function template(name: string, classId: number): Template {
  const env = load([{ name, data: loadFixture(name) }]);
  const node = env.files.find((f) => Boolean(golden(name).serialized?.[f.path]));
  assert.ok(node, `${name}: no SerializedFile`);
  const sf = readSerializedFile(node.data);
  assert.equal(sf.bigEndian, false);
  const info = sf.objects.find((o) => o.classId === classId);
  assert.ok(info, `${name}: no object of class ${classId}`);
  return { sf, info };
}

/** Where a hand-built object claims to come from. */
export interface Origin {
  unity: UnityVersion;
  /** The version string; `unity`'s first three parts by default. */
  text?: string;
  /** The SerializedFile format; the template's by default. */
  format?: number;
  platform?: BuildTarget;
  /** The class id; the template's by default. */
  classId?: number;
}

/** A reader over `bytes` as one object of a file made from `from` and `origin`. */
export function readerOf(from: Template, bytes: Uint8Array, origin: Origin): ObjectReader {
  const { unity, text = unity.slice(0, 3).join("."), format = from.sf.header.version } = origin;
  const file: SerializedFile = {
    ...from.sf,
    header: { ...from.sf.header, version: format },
    unityVersion: text,
    version: unity,
    targetPlatform: origin.platform ?? BuildTarget.StandaloneWindows64,
  };
  const info = {
    ...from.info,
    classId: origin.classId ?? from.info.classId,
    byteStart: 0,
    byteSize: bytes.length,
  };
  return new ObjectReader(bytes, file, info);
}

/**
 * Little-endian bytes of a hand-built object, written field by field. Each
 * writer returns the value a reader must give back, so an object literal of
 * writer calls is at once the bytes, in the literal's order, and the expected
 * result.
 */
export class Writer {
  private readonly out: number[] = [];
  private readonly view = new DataView(new ArrayBuffer(8));

  private push(size: number): void {
    this.out.push(...new Uint8Array(this.view.buffer, 0, size));
  }

  i32(v: number): number {
    this.view.setInt32(0, v, true);
    this.push(4);
    return v;
  }

  u32(v: number): number {
    this.view.setUint32(0, v, true);
    this.push(4);
    return v;
  }

  u16(v: number): number {
    this.view.setUint16(0, v, true);
    this.push(2);
    return v;
  }

  bool(v: boolean): boolean {
    this.out.push(v ? 1 : 0);
    return v;
  }

  f32(v: number): number {
    this.view.setFloat32(0, v, true);
    this.push(4);
    return Math.fround(v);
  }

  f64(v: number): number {
    this.view.setFloat64(0, v, true);
    this.push(8);
    return v;
  }

  /** A `UInt64` the reader gives as a `bigint`. */
  u64(v: bigint): bigint {
    this.view.setBigUint64(0, v, true);
    this.push(8);
    return v;
  }

  /** A `UInt64` byte offset or size, which the reader gives as a `number`. */
  u64n(v: number): number {
    this.u64(BigInt(v));
    return v;
  }

  /** An aligned string. */
  str(v: string): string {
    const data = new TextEncoder().encode(v);
    this.i32(data.length);
    this.out.push(...data);
    this.align();
    return v;
  }

  /** A byte count and the bytes, not padded. */
  bytes(data: Uint8Array): Uint8Array {
    this.i32(data.length);
    this.out.push(...data);
    return data;
  }

  /** A count, then each item as `write` writes it. */
  array<T, R>(items: T[], write: (item: T) => R): R[] {
    this.i32(items.length);
    return items.map(write);
  }

  /** A pointer; the path id is 32-bit in formats below 14. */
  pptr(fileId: number, pathId: bigint, wide = true): { m_FileID: number; m_PathID: bigint } {
    this.i32(fileId);
    if (wide) {
      this.view.setBigInt64(0, pathId, true);
      this.push(8);
    } else {
      this.i32(Number(pathId));
    }
    return { m_FileID: fileId, m_PathID: pathId };
  }

  /** `value`, with padding to the next 4 bytes after it. */
  pad<T>(value: T): T {
    this.align();
    return value;
  }

  align(): void {
    while (this.out.length % 4) this.out.push(0);
  }

  /** Raw bytes, as they are. */
  raw(...bytes: number[]): void {
    this.out.push(...bytes);
  }

  get data(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

/** Build an object with `layout`, returning its bytes and the result a reader must give. */
export function build<T>(layout: (w: Writer) => T): { bytes: Uint8Array; expected: T } {
  const w = new Writer();
  const expected = layout(w);
  return { bytes: w.data, expected };
}

/** `bytes` with `extra` appended. */
export const withTail = (bytes: Uint8Array, ...extra: number[]): Uint8Array =>
  Uint8Array.from([...bytes, ...extra]);

/** An `UnsupportedError("Unity version")` naming `text`, for `assert.throws`. */
export const versionRefusal =
  (text: string) =>
  (err: unknown): boolean =>
    err instanceof UnsupportedError && err.kind === "Unity version" && err.found === text;
