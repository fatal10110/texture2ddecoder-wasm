// Ported from AssetStudio/AssetsManager.cs (MIT, © Perfare / RazTools / Razviar)

import { readBundle } from "./bundle/BundleFile.js";
import { detectContainer, detectFileType } from "./bundle/detect.js";
import { readWebFile } from "./bundle/WebFile.js";
import { gunzip } from "./codec/inflate.js";
import { UnsupportedError } from "./errors.js";

/**
 * How deep containers may nest before the input is refused.
 *
 * Every level costs real bytes, so a well-formed bundle terminates long before
 * this; the cap only stops a crafted file from recursing until the stack goes.
 * Upstream has no equivalent because it never recurses into a bundle node.
 */
const MAX_DEPTH = 16;

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
}

/**
 * Unpack Unity files into their contents.
 *
 * Each input is sniffed, and containers are opened recursively: a gzip wrapper
 * is removed and the result sniffed again, a bundle or `UnityWebData` file is
 * unpacked and every node sniffed in turn. Anything that is not a container -
 * a SerializedFile, a `.resS` sidecar - is kept as it is, under its own name.
 *
 * Nothing is decompressed lazily and nothing is copied: the returned bytes are
 * views into the decompressed blocks.
 *
 * @param inputs the files to open; an `ArrayBuffer` is wrapped, never copied
 * @returns an {@link Env} whose `files` hold every unpacked file
 * @throws {UnsupportedError} for a container, compression type or nesting depth
 *   this library does not implement, its message naming the containers it was
 *   found under, outermost first
 * @throws {CorruptError} when a file claims to be a container but does not hold
 *   together, named the same way
 */
export function load(inputs: readonly LoadInput[]): Env {
  const files: LoadedFile[] = [];
  for (const { name, data } of inputs) {
    ingest(name, data instanceof Uint8Array ? data : new Uint8Array(data), 0, files);
  }
  return { files };
}

/**
 * Sniff one file and either keep it or open it, appending whatever comes out,
 * with every failure inside it named after this file.
 */
function ingest(name: string, data: Uint8Array, depth: number, out: LoadedFile[]): void {
  try {
    openFile(name, data, depth, out);
  } catch (error) {
    throw withSource(name, error);
  }
}

/**
 * Upstream's `AssetsManager.LoadFile` switch, minus the parts that are not
 * layer 1-2: a SerializedFile node is kept as bytes here rather than parsed
 * (M2), and the game-specific containers (`BlkFile`, `MhyFile`, ...) are not
 * ported at all.
 */
function openFile(name: string, data: Uint8Array, depth: number, out: LoadedFile[]): void {
  if (depth > MAX_DEPTH) {
    throw new UnsupportedError("container nesting", depth, `above the ${MAX_DEPTH} level limit`);
  }

  // `resource` is detection's "matched nothing" fallback, so `detectContainer`
  // refuses it - but as an input it is exactly the `.resS` sidecar a caller
  // passes next to its bundle, and as a node it is the sidecar packed inside
  // one. Everything else goes through `detectContainer`, which owns the reason
  // each refused type is refused (R9).
  if (detectFileType(data) === "resource") {
    out.push({ path: name, data });
    return;
  }

  switch (detectContainer(data)) {
    case "serialized":
      out.push({ path: name, data });
      return;
    // Upstream re-sniffs the decompressed bytes under the same path, so a
    // gzip-wrapped bundle keeps the `.gz` name only if it unwraps to a leaf.
    case "gzip":
      ingest(name, gunzip(data), depth + 1, out);
      return;
    case "UnityWebData":
      for (const file of readWebFile(data).files) {
        ingest(file.path, file.data, depth + 1, out);
      }
      return;
    default:
      for (const file of readBundle(data).files) {
        ingest(file.path, file.data, depth + 1, out);
      }
  }
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
