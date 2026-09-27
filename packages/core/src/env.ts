// Ported from AssetStudio/AssetsManager.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/ResourceReader.cs (MIT, © Perfare / RazTools / Razviar)

import { readBundle } from "./bundle/BundleFile.js";
import { detectContainer, detectFileType, type FileType } from "./bundle/detect.js";
import { readWebFile } from "./bundle/WebFile.js";
import { resolvePPtr, type PPtr, type PPtrResolution } from "./classes/PPtr.js";
import { gunzip } from "./codec/inflate.js";
import { CorruptError, ResourceNotFoundError, UnsupportedError } from "./errors.js";
import { SerializedFileFormatVersion as V } from "./serialized/FormatVersion.js";
import { ObjectReader } from "./serialized/ObjectReader.js";
import {
  baseName,
  readSerializedFile,
  setUnityVersion,
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
 * The editor version a build with `AssetBundleStripUnityVersion` writes, in
 * the SerializedFile and in the bundle header alike (upstream
 * `IsVersionStripped`).
 *
 * A copy of `SerializedFile.ts`'s private `STRIPPED_VERSION`: export that one
 * and drop this copy the next time that file changes (after #102).
 */
const STRIPPED_VERSION = "0.0.0";

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

/**
 * Where an object's bulk data lives outside the object: a byte range of a
 * resource file. This is the shape of Unity's `StreamingInfo` (Texture2D's
 * `m_StreamData`); other classes name the same three fields differently
 * (AudioClip's `m_Resource` has `m_Source`, `m_Offset`, `m_Size`).
 */
export interface ResourceRef {
  /**
   * The resource file, as Unity writes it: `archive:/CAB-<hash>/CAB-<hash>.resS`
   * in a bundle, `sharedassets0.assets.resS` or `sharedassets0.resource` in a
   * player build. Only the last path component is matched.
   */
  path: string;
  /**
   * Byte offset into that file. A `number` (D9): a caller holding the 64-bit
   * field as a `bigint` converts it, refusing 2^53 and above.
   */
  offset: number;
  /** Byte count. */
  size: number;
}

/** Everything {@link load} was given, unpacked. */
export interface Env {
  /**
   * Every unpacked file, in the order its input was passed and, within an
   * input, in container order.
   *
   * Paths are not unique - two bundles can hold a node of the same name, and
   * nothing here drops or renames either. {@link readResource} says which one a
   * `.resS` reference means.
   */
  files: LoadedFile[];
  /**
   * Every object of every SerializedFile in {@link files}, in file order and,
   * within a file, in object table order.
   *
   * A SerializedFile below format 7 does not record the editor that wrote it;
   * when it is a node of a bundle, its objects' `version` is the bundle's
   * `unityRevision`, as upstream does, and `[0, 0, 0, 0]` otherwise. A
   * SerializedFile whose version was stripped at build time (`"0.0.0"`) takes
   * the `unityRevision` of the bundle it is a node of, too, and keeps
   * `[0, 0, 0, 0]` when there is none - editors write `"0.0.0"` in the header
   * of a stripped bundle as well. Its objects stay readable; a class reader
   * that branches on `version` has to refuse `[0, 0, 0, 0]` with
   * `UnsupportedError` rather than guess.
   *
   * The SerializedFiles are parsed on the first access of this, of
   * {@link resolve} or of {@link readResource}, not by {@link load}, so a file
   * this library cannot parse never costs a caller who only unpacks. The
   * result is kept; a failed parse is not, and throws again on the next access.
   *
   * @throws {UnsupportedError} for a SerializedFile format version this library
   *   does not read, its message naming the containers the file was found
   *   under, outermost first, then the file
   * @throws {CorruptError} when a SerializedFile's metadata does not hold
   *   together - an object table listing a path id twice included - named the
   *   same way
   */
  readonly objects: ObjectReader[];
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
   * @throws {UnsupportedError} / {CorruptError} as {@link objects} does, since
   *   resolving parses the SerializedFiles too
   */
  resolve(pptr: PPtr, from: ObjectReader): PPtrResolution;
  /**
   * Read an object's bulk data out of the resource file it references (a
   * `.resS` or `.resource` sidecar), as upstream's `ResourceReader` does.
   *
   * The file is found among {@link files} by the last component of
   * `ref.path`, ignoring case, like upstream. When several loaded files have
   * that name, the one in the same container as `from`'s SerializedFile wins -
   * the bundle it is a node of, or the caller's own inputs when it was passed
   * loose - and otherwise the first one loaded, as with upstream's `TryAdd`.
   * So a sidecar passed next to a bundle serves the bundle's objects, and two
   * bundles holding the same `CAB-<hash>.resS` each read their own.
   *
   * An empty `ref.path` means the data is inline in the object; there is no
   * file to read, so it throws {@link ResourceNotFoundError} like any other
   * name that is not loaded.
   *
   * @param ref which bytes, as the object's `StreamingInfo` holds them
   * @param from the object whose data the reference was read from
   * @returns exactly `ref.size` bytes, a view into the resource file (R7), with
   *   the same aliasing as {@link LoadedFile.data}
   * @throws {Error} when `from` is not one of this env's {@link objects}
   * @throws {ResourceNotFoundError} when no loaded file has that name
   * @throws {RangeError} when `ref.offset` or `ref.size` is not a whole number
   *   in 0..2^53, or is a `bigint` (D9)
   * @throws {CorruptError} when the range runs past the end of the file,
   *   naming the file, the range and the file's size
   * @throws {UnsupportedError} / {CorruptError} as {@link objects} does, since
   *   finding `from`'s file parses the SerializedFiles too
   */
  readResource(ref: ResourceRef, from: ObjectReader): Uint8Array;
}

/**
 * One parsed SerializedFile of an {@link Env}, as pointer resolution needs it.
 * Internal: not exported from the package.
 */
export interface SerializedFileEntry {
  /** Last component of the file's path, which is what an external names. */
  name: string;
  file: SerializedFile;
  /** Objects by path id, which are unique within a file. */
  objects: Map<bigint, ObjectReader>;
  /** The container it came out of, for {@link Env.readResource}. */
  container: ContainerId;
}

/**
 * Which container a file came out of: 0 for the caller's own inputs, then one
 * id per bundle or `UnityWebData` file opened. A gzip wrapper holds one file
 * and names no directory, so it is not a container: what it unwraps to keeps
 * the wrapper's own.
 */
type ContainerId = number;

/** A file of {@link Env.files} and where it came from. */
interface KeptFile {
  file: LoadedFile;
  container: ContainerId;
}

/** A file detection called a SerializedFile, kept by {@link load} unparsed. */
interface SerializedCandidate {
  /** The containers it was found under, outermost first, then its own path. */
  source: string;
  /** Its own path. */
  path: string;
  data: Uint8Array;
  /**
   * `unityRevision` of the bundle it is a node of; `undefined` when it is not
   * a node of a bundle.
   */
  revision: string | undefined;
  container: ContainerId;
}

/** What {@link load} collects on its way down. */
interface Collected {
  files: LoadedFile[];
  serialized: SerializedCandidate[];
  /** Every file by lower-cased last path component, in load order. */
  byName: Map<string, KeptFile[]>;
  /** The last {@link ContainerId} handed out. */
  lastContainer: ContainerId;
}

/** The parsed SerializedFiles of an env, indexed for {@link Env.resolve}. */
interface EnvIndex {
  objects: ObjectReader[];
  sourceOf: Map<ObjectReader, SerializedFileEntry>;
  /** By lower-cased name, first loaded only. */
  byName: Map<string, SerializedFileEntry>;
}

/**
 * Unpack Unity files into their contents, and give access to the objects of
 * every SerializedFile among them.
 *
 * Each input is sniffed, and containers are opened recursively: a gzip wrapper
 * is removed and the result sniffed again, a bundle or `UnityWebData` file is
 * unpacked and every node sniffed in turn. Anything that is not a container -
 * a SerializedFile, a `.resS` sidecar - is kept as it is, under its own name.
 * A node only counts as a container when Unity's own signature says so; a
 * wrapper detected by a magic number is opened for an input, never for a node.
 *
 * Files detected as SerializedFiles are only parsed when {@link Env.objects},
 * {@link Env.resolve} or {@link Env.readResource} is first used, so unpacking
 * never fails over one; see there for what that parse throws.
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
  const out: Collected = { files: [], serialized: [], byName: new Map(), lastContainer: 0 };
  for (const { name, data } of inputs) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    ingest(name, bytes, 0, false, "", undefined, 0, out);
  }

  let index: EnvIndex | undefined;
  const indexed = (): EnvIndex => (index ??= indexSerializedFiles(out.serialized));

  return {
    files: out.files,
    get objects() {
      return indexed().objects;
    },
    resolve(pptr, from) {
      const { sourceOf, byName } = indexed();
      const source = sourceOf.get(from);
      if (!source) {
        throw new Error(`object ${from.pathId} was not loaded by this env`);
      }
      return resolvePPtr(pptr, source, (fileName) => byName.get(fileName.toLowerCase()));
    },
    readResource(ref, from) {
      const source = indexed().sourceOf.get(from);
      if (!source) {
        throw new Error(`object ${from.pathId} was not loaded by this env`);
      }
      return readRange(findResource(ref.path, source.container, out.byName), ref);
    },
  };
}

/**
 * Upstream `ResourceReader.GetReader`, over the loaded files only: the file
 * system search it falls back to is the node adapter's (M5).
 *
 * Upstream keys its resource cache by file name alone and keeps the first file
 * added, whichever container it came from; UnityPy's keeps the last. Both
 * agree while names are unique, which `CAB-<hash>` names are within one build.
 * They stop being unique when two builds are loaded together, and there the
 * requester's own container is the only choice that cannot hand one bundle's
 * object another bundle's bytes. Failing that, the first one loaded wins, as
 * upstream's does.
 *
 * @throws {ResourceNotFoundError} when no loaded file has that name
 */
function findResource(
  path: string,
  container: ContainerId,
  byName: ReadonlyMap<string, readonly KeptFile[]>,
): LoadedFile {
  const fileName = baseName(path);
  const candidates = fileName ? byName.get(fileName.toLowerCase()) : undefined;
  if (!candidates) throw new ResourceNotFoundError(path, fileName);
  const kept = candidates.find((c) => c.container === container) ?? candidates[0]!;
  return kept.file;
}

/**
 * The bytes a {@link ResourceRef} names inside its file (upstream
 * `ResourceReader.GetData`, which seeks and reads without a check and so hands
 * back short data past the end).
 *
 * @throws {RangeError} when the offset or size is a bigint, or not a whole
 *   number in 0..2^53
 * @throws {CorruptError} when the range runs past the end of the file
 */
function readRange({ path, data }: LoadedFile, { offset, size }: ResourceRef): Uint8Array {
  for (const [what, value] of [["offset", offset], ["size", size]] as const) {
    // A 2020.1+ typetree reads `offset` as UInt64, so a caller passing
    // `readTypeTree()` output straight through hands over a bigint (D9).
    if (typeof value === "bigint") {
      throw new RangeError(
        `${path}: resource ${what} ${value}n is a bigint; ` +
          "convert it to a number, refusing 2^53 and above (D9)",
      );
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        `${path}: resource ${what} ${value} is not a whole number in 0..2^53 (D9)`,
      );
    }
  }
  if (offset + size > data.length) {
    throw new CorruptError(
      `${path}: resource range ${offset}+${size} runs past the end of ${data.length} bytes`,
    );
  }
  return data.subarray(offset, offset + size);
}

/**
 * Parse every SerializedFile {@link load} kept (upstream `LoadAssetsFile` /
 * `LoadAssetsFromMemory`) and index their objects.
 *
 * A file detection calls a SerializedFile but that does not parse as one
 * throws here (R9), where upstream logs the error and keeps it as a resource.
 * Detection only says "serialized" when the header's file size is exactly the
 * bytes at hand, so such a file is broken or of a format this library does not
 * read, not a resource that happened to look like one - and dropping its
 * objects without a word would hand back an `objects` with holes in it. Its
 * bytes stay in `files` either way.
 */
function indexSerializedFiles(candidates: readonly SerializedCandidate[]): EnvIndex {
  const objects: ObjectReader[] = [];
  const sourceOf = new Map<ObjectReader, SerializedFileEntry>();
  // Upstream matches externals with `OrdinalIgnoreCase`; lower-casing agrees
  // with it on every name Unity writes (`CAB-<hex>`, `sharedassets0.assets`).
  const byName = new Map<string, SerializedFileEntry>();
  for (const { source, path, data, revision, container } of candidates) {
    let entry: SerializedFileEntry;
    try {
      entry = readEntry(path, data, revision, container);
    } catch (error) {
      throw withSource(source, error);
    }
    for (const object of entry.objects.values()) {
      objects.push(object);
      sourceOf.set(object, entry);
    }
    const key = entry.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, entry);
  }
  return { objects, sourceOf, byName };
}

/**
 * Parse one SerializedFile and give each of its objects a reader.
 *
 * A file below format 7 does not record the editor that wrote it, so one found
 * in a bundle takes the bundle's `unityRevision` first, before any reader
 * copies the version (upstream `LoadAssetsFromMemory`). Anywhere else it keeps
 * `[0, 0, 0, 0]`, as upstream's loose and `UnityWebData` paths do.
 *
 * A version-stripped file (upstream `CheckStrippedVersion`) takes the revision
 * of the bundle it is a node of too. Upstream takes the first bundle revision
 * its whole load saw instead; the enclosing bundle is UnityPy's fallback, which
 * names the build that wrote this file rather than whichever input came first.
 *
 * When that revision is missing, empty or stripped too, the file keeps
 * `[0, 0, 0, 0]`.
 *
 * @param revision `unityRevision` of the bundle the file is a node of
 * @param container the container the file came out of
 * @throws {CorruptError} when the object table lists a path id twice. Unity
 *   never writes that, and either choice of object would leave a pointer to
 *   it meaning one of two things; upstream's `ObjectsDic.Add` throws too.
 */
function readEntry(
  path: string,
  data: Uint8Array,
  revision: string | undefined,
  container: ContainerId,
): SerializedFileEntry {
  const file = readSerializedFile(data);
  // An empty revision names nothing; upstream checks `IsNullOrEmpty`.
  // `setUnityVersion` skips a revision that is itself stripped.
  const stripped = file.unityVersion === STRIPPED_VERSION;
  if (revision && (file.header.version < V.Unknown_7 || stripped)) {
    setUnityVersion(file, revision);
  }
  // ponytail: a stripped file with no usable revision keeps `[0, 0, 0, 0]`,
  // like AssetStudio does for the `"0.0.0"` header editors write (UnityPy
  // raises earlier, in `BundleFile.parse_version`). Typetree reads do not need
  // the version, so its objects stay readable; a version-gated class reader
  // must refuse `[0, 0, 0, 0]` with `UnsupportedError` itself (decided on PR
  // #107). A caller-supplied version (#105) is the upgrade path.
  const objects = new Map<bigint, ObjectReader>();
  for (const info of file.objects) {
    if (objects.has(info.pathId)) {
      throw new CorruptError(`object table lists path id ${info.pathId} twice`);
    }
    objects.set(info.pathId, new ObjectReader(data, file, info));
  }
  return { name: baseName(path), file, objects, container };
}

/**
 * Sniff one file and either keep it or open it, appending whatever comes out,
 * with every failure inside it named after this file.
 *
 * @param trail the containers this file was found in, outermost first, each
 *   followed by `": "`; empty for an input
 * @param revision `unityRevision` of the bundle this file is a node of;
 *   `undefined` for an input and for a node of anything else
 * @param container the container this file came out of; 0 for an input
 */
function ingest(
  name: string,
  data: Uint8Array,
  depth: number,
  packed: boolean,
  trail: string,
  revision: string | undefined,
  container: ContainerId,
  out: Collected,
): void {
  try {
    openFile(name, data, depth, packed, trail, revision, container, out);
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
 * @param revision as for {@link ingest}
 * @param container as for {@link ingest}
 */
function openFile(
  name: string,
  data: Uint8Array,
  depth: number,
  packed: boolean,
  trail: string,
  revision: string | undefined,
  container: ContainerId,
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
    keep(name, data, type, trail, revision, container, out);
    return;
  }

  // Everything that is left goes through `detectContainer`, which owns the
  // reason each refused type is refused (R9).
  //
  // Only a bundle's own nodes get its revision: upstream's `LoadWebFile`
  // passes none, and a gzip wrapper is only ever opened for an input.
  const inner = `${trail}${name}: `;
  switch (detectContainer(data)) {
    case "serialized":
      keep(name, data, type, trail, revision, container, out);
      return;
    // Upstream re-sniffs the decompressed bytes under the same path, so a
    // gzip-wrapped bundle keeps the `.gz` name only if it unwraps to a leaf.
    case "gzip":
      ingest(name, gunzip(data), depth + 1, packed, inner, undefined, container, out);
      return;
    case "UnityWebData": {
      const own = ++out.lastContainer;
      for (const file of readWebFile(data).files) {
        ingest(file.path, file.data, depth + 1, true, inner, undefined, own, out);
      }
      return;
    }
    default: {
      const bundle = readBundle(data);
      const { unityRevision } = bundle.header;
      const own = ++out.lastContainer;
      for (const file of bundle.files) {
        ingest(file.path, file.data, depth + 1, true, inner, unityRevision, own, out);
      }
    }
  }
}

/**
 * Keep a file that is not a container, index it by name for
 * {@link Env.readResource}, and remember it for parsing later when detection
 * calls it a SerializedFile.
 */
function keep(
  name: string,
  data: Uint8Array,
  type: FileType,
  trail: string,
  revision: string | undefined,
  container: ContainerId,
  out: Collected,
): void {
  if (type === "serialized") {
    out.serialized.push({ source: `${trail}${name}`, path: name, data, revision, container });
  }
  const file = { path: name, data };
  out.files.push(file);
  // Upstream matches resource names with `OrdinalIgnoreCase`, like externals.
  const key = baseName(name).toLowerCase();
  const same = out.byName.get(key);
  if (same) same.push({ file, container });
  else out.byName.set(key, [{ file, container }]);
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
