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
  /** pathId -> `read_typetree()` dump, for the `DUMPED_CLASSES` in `make-goldens.py`. */
  typetrees: Record<string, { value: unknown; oracleNote?: string }>;
  /** pathId -> Texture2D golden; only files holding a Texture2D have it (#31). */
  textures?: Record<string, GoldenTexture>;
}

/**
 * One Texture2D as the oracle decodes it (#31). The RGBA hash is of the rows
 * in the order Unity stores them, bottom row first (UnityPy's `flip=False`).
 */
export interface GoldenTexture {
  name: string;
  /** `m_TextureFormat`, Unity's `TextureFormat` value. */
  format: number;
  width: number;
  height: number;
  /** Image data, all mip levels, inline or from the `.resS` node. */
  imageSize: number;
  imageSha256: string;
  /** UnityPy's RGBA8; absent when UnityPy cannot decode the format. */
  rgbaSha256?: string;
  /** Why UnityPy could not decode it, when it could not. */
  oracleError?: string;
  /** Where UnityPy's RGBA is known to differ from AssetStudio's, and the verdict. */
  oracleNote?: string;
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

/**
 * UnityPy's decode of generated block data, for a format no fixture editor
 * writes (#32): `syntheticBytes(name, inputSize)` in, RGBA8 out.
 */
export interface GoldenSynthetic {
  /** Unity's `TextureFormat` value. */
  format: number;
  width: number;
  height: number;
  inputSize: number;
  inputSha256: string;
  rgbaSha256: string;
}

const goldenFile: {
  fixtures: Record<string, Golden>;
  synthetic: Record<string, GoldenSynthetic>;
} = JSON.parse(readFileSync(join(HERE, "goldens.json"), "utf8"));
const goldens = goldenFile.fixtures;

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

/** Every synthetic texture golden, by name (`"ATC_RGB4"`). */
export function syntheticGoldens(): Record<string, GoldenSynthetic> {
  return goldenFile.synthetic;
}

/**
 * An RGBA8 image with its rows in reverse order, as a new array. The texture
 * goldens hash Unity's stored order, bottom row first; `decodeTexture2D`
 * returns the top row first (#33), so its tests turn it back before hashing.
 * The `platform` goldens record both orders, which proves this is UnityPy's
 * own flip.
 */
export function reverseRows(rgba: Uint8Array, width: number): Uint8Array {
  const stride = width * 4;
  const out = new Uint8Array(rgba.length);
  for (let from = 0; from < rgba.length; from += stride) {
    out.set(rgba.subarray(from, from + stride), rgba.length - from - stride);
  }
  return out;
}

/**
 * The input of a synthetic golden: `sha256("<name>/0") + sha256("<name>/1") + ...`,
 * cut to `size` bytes, as `synthetic_bytes` in `scripts/make-goldens.py` makes it.
 */
export function syntheticBytes(name: string, size: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(size / 32) * 32);
  for (let i = 0; i * 32 < size; i++) {
    out.set(createHash("sha256").update(`${name}/${i}`).digest(), i * 32);
  }
  return out.subarray(0, size);
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
