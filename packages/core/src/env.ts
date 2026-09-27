// Ported from AssetStudio/AssetsManager.cs (MIT, © Perfare / RazTools / Razviar)

import { readBundle } from "./bundle/BundleFile.js";
import { detectContainer, detectFileType, type FileType } from "./bundle/detect.js";
import { readWebFile } from "./bundle/WebFile.js";
import { resolvePPtr, type PPtr, type PPtrResolution } from "./classes/PPtr.js";
import { gunzip } from "./codec/inflate.js";
import { UnsupportedError } from "./errors.js";
import { ObjectReader } from "./serialized/ObjectReader.js";
import {
  baseName,
  readSerializedFile,
  type SerializedFile,
} from "./serialized/SerializedFile.js";

/**
 * How deep containers may nest before the input is refused.
 *
 * Every level costs real bytes, so a well-formed bundle terminates long before
 * this; the cap only stops a crafted file from recursing until the stack goes.
 * Upstream has no equivalent because it never recurses into a bundle node.
 */
const MAX_DEPTH = 16;

/**
 * The types a file inside a container may be opened as: the ones Unity writes
 * a signature for. Everything else detection decides by a magic number.
 */
const SIGNED_CONTAINERS: readonly FileType[] = [
  "UnityFS",
  "UnityWeb",
  "UnityRaw",
  "UnityWebData",
  "UnityArchive",
];

/** One file handed to {@link load}. */
export interface LoadInput {
  /** File name, used as the path of anything that is not a container. */
  name: string;
  /** Whole file bytes. */
  data: Uint8Array | ArrayBuffer;
}

/** One unpacked file, as {@link Env.files} yields it. */
export interface LoadedFile {
  /**
   * Node path inside its container (`"CAB-1234"`, `"CAB-1234.resS"`), or the
   * input's own `name` when it was not packed in anything.
   */
  path: string;
  /**
   * File bytes. For anything unpacked from a bundle this is a view into the
   * decompressed blocks (R7), so writing through it writes through to its
   * siblings and it keeps the whole block buffer alive; copy it if you need
   * either avoided.
   */
  data: Uint8Array;
}

/** Everything {@link load} was given, unpacked. */
export interface Env {
  /**
   * Every unpacked file, in the order its input was passed and, within an
   * input, in container order.
   *
   * ponytail: paths are not unique - two bundles can hold a node of the same
   * name, and nothing here drops or renames either. The M3 resource resolver
   * (#30) is what has to decide which one a `.resS` reference means.
   */
  files: LoadedFile[];
  /**
   * Every object of every SerializedFile in {@link files}, in file order and,
   * within a file, in object table order. A path id a file lists twice is
   * kept once, the first time, as upstream's `ObjectsDic` keeps it.
   */
  objects: ObjectReader[];
  /**
   * Find the object a pointer points at.
   *
   * `m_FileID` 0 means `from`'s own file; anything above picks one of that
   * file's externals, matched to a loaded SerializedFile by file name, ignoring
   * case, like upstream. When two loaded files share that name, the first one
   * loaded wins, as with upstream's `FindIndex`.
   *
   * @param pptr the pointer, as a typetree holds it
   * @param from the object whose data the pointer was read from
   * @returns the object, or why there is none; a null or dangling pointer is a
   *   result, never an exception
   * @throws {Error} when `from` is not one of this env's {@link objects}
   */
  resolve(pptr: PPtr, from: ObjectReader): PPtrResolution;
}

/**
 * One parsed SerializedFile of an {@link Env}, as pointer resolution needs it.
 * Internal: not exported from the package.
 */
export interface SerializedFileEntry {
  /** Last component of the file's path, which is what an external names. */
  name: string;
  file: SerializedFile;
  /** Objects by path id; if a file repeats one, the first wins, as upstream. */
  objects: Map<bigint, ObjectReader>;
}

/** What {@link load} collects on its way down. */
interface Collected {
  files: LoadedFile[];
  serialized: SerializedFileEntry[];
}

/**
 * Unpack Unity files into their contents and read the object table of every
 * SerializedFile among them.
 *
 * Each input is sniffed, and containers are opened recursively: a gzip wrapper
 * is removed and the result sniffed again, a bundle or `UnityWebData` file is
 * unpacked and every node sniffed in turn. Anything that is not a container -
 * a SerializedFile, a `.resS` sidecar - is kept as it is, under its own name.
 * A node only counts as a container when Unity's own signature says so; a
 * wrapper detected by a magic number is opened for an input, never for a node.
 *
 * A file detected as a SerializedFile has its header and metadata parsed, and
 * its objects become {@link Env.objects}. Object data is not read.
 *
 * Nothing is decompressed lazily and nothing is copied: the returned bytes are
 * views into the decompressed blocks.
 *
 * @param inputs the files to open; an `ArrayBuffer` is wrapped, never copied
 * @returns an {@link Env} whose `files` hold every unpacked file and whose
 *   `objects` hold every object of every SerializedFile
 * @throws {UnsupportedError} for a container, compression type, nesting depth or
 *   SerializedFile format version this library does not implement, its message
 *   naming the containers it was found under, outermost first
 * @throws {CorruptError} when a file claims to be a container or a
 *   SerializedFile but does not hold together, named the same way
 */
export function load(inputs: readonly LoadInput[]): Env {
  const out: Collected = { files: [], serialized: [] };
  for (const { name, data } of inputs) {
    ingest(name, data instanceof Uint8Array ? data : new Uint8Array(data), 0, false, out);
  }

  const objects: ObjectReader[] = [];
  const sourceOf = new Map<ObjectReader, SerializedFileEntry>();
  // Upstream matches externals with `OrdinalIgnoreCase`; lower-casing agrees
  // with it on every name Unity writes (`CAB-<hex>`, `sharedassets0.assets`).
  const byName = new Map<string, SerializedFileEntry>();
  for (const entry of out.serialized) {
    for (const object of entry.objects.values()) {
      objects.push(object);
      sourceOf.set(object, entry);
    }
    const key = entry.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, entry);
  }

  return {
    files: out.files,
    objects,
    resolve(pptr, from) {
      const source = sourceOf.get(from);
      if (!source) {
        throw new Error(`object ${from.pathId} was not loaded by this env`);
      }
      return resolvePPtr(pptr, source, (fileName) => byName.get(fileName.toLowerCase()));
    },
  };
}

/**
 * Sniff one file and either keep it or open it, appending whatever comes out,
 * with every failure inside it named after this file.
 */
function ingest(
  name: string,
  data: Uint8Array,
  depth: number,
  packed: boolean,
  out: Collected,
): void {
  try {
    openFile(name, data, depth, packed, out);
  } catch (error) {
    throw withSource(name, error);
  }
}

/**
 * Upstream's `AssetsManager.LoadFile` switch, minus the game-specific
 * containers (`BlkFile`, `MhyFile`, ...), which are not ported at all.
 *
 * @param packed whether this file came out of a container rather than from the
 *   caller, which is what decides how far a sniff may be trusted
 */
function openFile(
  name: string,
  data: Uint8Array,
  depth: number,
  packed: boolean,
  out: Collected,
): void {
  if (depth > MAX_DEPTH) {
    throw new UnsupportedError("container nesting", depth, `above the ${MAX_DEPTH} level limit`);
  }

  const type = detectFileType(data);

  // `resource` is detection's "matched nothing" fallback, so `detectContainer`
  // refuses it - but as an input it is exactly the `.resS` sidecar a caller
  // passes next to its bundle, and as a node it is the sidecar packed inside
  // one.
  //
  // Inside a container the same goes for every type detection decides by a
  // magic number rather than by a Unity signature: `gzip` is two bytes, so
  // roughly one resource node in 65536 starts with them, and opening it would
  // fail the whole load over bytes that are simply asset data. Upstream cannot
  // hit this - `LoadBundleFile` caches every node that is not a SerializedFile
  // as an opaque resource stream and never dispatches on the sniff - and stock
  // Unity gzips whole files for web delivery, never a node inside a bundle, so
  // nothing real is left unopened.
  if (type === "resource" || (packed && !SIGNED_CONTAINERS.includes(type))) {
    keep(name, data, type, out);
    return;
  }

  // Everything that is left goes through `detectContainer`, which owns the
  // reason each refused type is refused (R9).
  switch (detectContainer(data)) {
    case "serialized":
      keep(name, data, type, out);
      return;
    // Upstream re-sniffs the decompressed bytes under the same path, so a
    // gzip-wrapped bundle keeps the `.gz` name only if it unwraps to a leaf.
    case "gzip":
      ingest(name, gunzip(data), depth + 1, packed, out);
      return;
    case "UnityWebData":
      for (const file of readWebFile(data).files) {
        ingest(file.path, file.data, depth + 1, true, out);
      }
      return;
    default:
      for (const file of readBundle(data).files) {
        ingest(file.path, file.data, depth + 1, true, out);
      }
  }
}

/**
 * Keep a file that is not a container, reading its metadata first when it is a
 * SerializedFile (upstream `LoadAssetsFile` / `LoadAssetsFromMemory`).
 *
 * A file detection calls a SerializedFile but that does not parse as one fails
 * the load (R9), where upstream logs the error and keeps it as a resource.
 * Detection only says "serialized" when the header's file size is exactly the
 * bytes at hand, so such a file is broken or of a format this library does not
 * read, not a resource that happened to look like one - and dropping its
 * objects without a word would hand back an `objects` with holes in it.
 */
function keep(name: string, data: Uint8Array, type: FileType, out: Collected): void {
  if (type === "serialized") {
    const file = readSerializedFile(data);
    const objects = new Map<bigint, ObjectReader>();
    for (const info of file.objects) {
      if (!objects.has(info.pathId)) objects.set(info.pathId, new ObjectReader(data, file, info));
    }
    out.serialized.push({ name: baseName(name), file, objects });
  }
  out.files.push({ path: name, data });
}

/**
 * Prefix an error's message with the file it came from, in place.
 *
 * The class, its fields and the stack all have to survive - a caller branching
 * on `UnsupportedError` must still see one, and `kind`/`found` are what R9
 * asks it to read instead of the message. Rewrapping would lose all three, so
 * the message is edited and the original rethrown. Each level on the way out
 * adds its own name, so the message reads as the path down to the bad bytes.
 */
function withSource(name: string, error: unknown): unknown {
  if (error instanceof Error) error.message = `${name}: ${error.message}`;
  return error;
}
