// Shared fixture/golden helper. Imported by relative path from any package's
// tests - it is test-only, so node:* here is fine and never reaches package src.

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLES = join(HERE, "bundles");

/** One unpacked node, as `env.files` yields it. */
export interface StreamFile {
  path: string;
  data: Uint8Array;
}

interface GoldenFile {
  sha256: string;
  size: number;
}

/** One type tree node as the goldens store it: `[level, type, name, byteSize, metaFlag]`. */
export type GoldenNode = [number, string, string, number, number];

/** A `SerializedType` entry (`types` or `refTypes`); hashes are hex. */
export interface GoldenType {
  classId: number;
  isStrippedType: boolean | null;
  scriptTypeIndex: number;
  scriptId: string | null;
  oldTypeHash: string | null;
  typeDependencies: number[] | null;
  /** Pre-order node list; `null` when the file was built without type trees. */
  nodes: GoldenNode[] | null;
  /** Ref types only. */
  className?: string;
  namespace?: string;
  assembly?: string;
}

/**
 * What the oracle read out of one SerializedFile (M2). Typetree values are
 * normalized per plan §5: int64 as a decimal string, `float` as `"f32:<hex>"`,
 * `double` as `"f64:<hex>"` (big-endian bit patterns), byte vectors (`vector<UInt8>`,
 * C# `byte[]`) and `TypelessData` as `"hex:<hex>"`.
 */
export interface GoldenSerialized {
  formatVersion: number;
  /** Raw, including any suffix Unity appends (`"6000.3.25f1\n2"` when stripped). */
  unityVersion: string;
  targetPlatform: number;
  bigEndian: boolean;
  enableTypeTree: boolean;
  externals: { path: string; guid: string | null; type: number | null }[];
  types: GoldenType[];
  refTypes: GoldenType[];
  /** pathId -> `read_typetree()` dump, for TextAsset and MonoBehaviour objects. */
  typetrees: Record<string, { value: unknown; oracleNote?: string }>;
}

export interface Golden {
  signature: string;
  /** Bundle fields; absent for a `UnityWebData` fixture, which has no version. */
  formatVersion?: number;
  unityVersion?: string;
  unityRevision?: string;
  files: Record<string, GoldenFile>;
  objects: Record<string, { pathId: string; classId: number; byteSize: number }[]>;
  /** Node path -> SerializedFile golden; only editor-built fixtures have these. */
  serialized?: Record<string, GoldenSerialized>;
  oracleNote?: string;
}

const goldens: Record<string, Golden> = JSON.parse(
  readFileSync(join(HERE, "goldens.json"), "utf8"),
).fixtures;

/** sha256 hex, the normalization the goldens use for byte arrays (plan §5). */
export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Raw fixture bytes, exactly as committed - gzip fixtures stay gzipped. */
export function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(BUNDLES, name)));
}

/**
 * Every fixture that has a golden, as its path under `bundles/`
 * (`"lz4.bundle"`, `"editor/6000.3.25f1/lz4/main"`).
 */
export function fixtureNames(): string[] {
  return Object.keys(goldens);
}

export function golden(name: string): Golden {
  const g = goldens[name];
  if (!g) throw new Error(`no golden for fixture "${name}" - run scripts/make-goldens.py`);
  return g;
}

/**
 * Assert unpacked files match the committed golden: same node paths, same
 * sizes, same sha256. Throws with the offending path rather than a byte diff.
 */
export function assertMatchesGolden(name: string, files: StreamFile[]): void {
  const expected = golden(name).files;
  const actual = new Map(files.map((f) => [f.path, f.data]));

  const missing = Object.keys(expected).filter((p) => !actual.has(p));
  const extra = [...actual.keys()].filter((p) => !(p in expected));
  if (missing.length || extra.length) {
    throw new Error(`${name}: node paths differ (missing: ${missing}, unexpected: ${extra})`);
  }

  for (const [path, { sha256: want, size }] of Object.entries(expected)) {
    const data = actual.get(path)!;
    if (data.length !== size) {
      throw new Error(`${name}:${path}: ${data.length} bytes, golden has ${size}`);
    }
    const got = sha256(data);
    if (got !== want) throw new Error(`${name}:${path}: sha256 ${got}, golden has ${want}`);
  }
}

// ponytail: the gzip fixture is the only wrapped one and node:zlib is fine in
// tests, so the helper just exposes it. If more wrappers show up, sniff instead.
/** Inner bundle bytes of a gzip-wrapped fixture. */
export function gunzipFixture(name: string): Uint8Array {
  return new Uint8Array(gunzipSync(loadFixture(name)));
}
