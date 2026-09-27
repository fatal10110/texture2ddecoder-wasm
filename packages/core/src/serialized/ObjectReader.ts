// Ported from AssetStudio/ObjectReader.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/Math/XForm.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from AssetStudio/EndianBinaryReader.cs (MIT, © Perfare / RazTools / Razviar)

import {
  readObjectData,
  type ObjectData,
  type ResourceReader,
} from "../classes/registry.js";
import { CorruptError } from "../errors.js";
import { BinaryReader } from "../io/BinaryReader.js";
import type { BuildTarget } from "./BuildTarget.js";
import type { ObjectInfo, SerializedFile, UnityVersion } from "./SerializedFile.js";
import { readCount, type SerializedType } from "./TypeTree.js";
import { readTypeTree, type TypeTreeObject } from "./TypeTreeReader.js";

/** Three floats (upstream `Vector3`). */
export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/** A rotation as four floats (upstream `Quaternion`). */
export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Translation, rotation and scale (upstream `XForm`). */
export interface XForm {
  t: Vector3;
  q: Quaternion;
  s: Vector3;
}

/**
 * The resource reader of each object `load()` built, for {@link ObjectReader.read}.
 * A side table rather than a field, so it stays out of the public class.
 */
const resourceReaders = new WeakMap<ObjectReader, ResourceReader>();

/**
 * Let `reader.read()` read resource files through `resources` (the env's
 * `readResource`). Internal: `load()` calls it for every object it builds.
 */
export function setResourceReader(reader: ObjectReader, resources: ResourceReader): void {
  resourceReaders.set(reader, resources);
}

/**
 * A reader over one object's data, in the file's byte order, carrying what a
 * class or typetree reader needs to know about the object and its file.
 *
 * Position 0 is the object's first byte and {@link length} is its `byteSize`,
 * so a read past the object throws {@link CorruptError}, like upstream's
 * bounded `Read`. The bytes are a view into the file, never a copy (R7).
 *
 * ponytail: `align()` counts from the object's first byte, upstream from the
 * file's. The two agree whenever `byteStart` is a multiple of 4, and Unity pads
 * every object start to 8 or 16. If a file ever breaks that, give
 * `BinaryReader` an alignment base.
 *
 * Upstream's `Game` (per-game quirks) is not ported.
 *
 * @example
 * // `data` is one SerializedFile node (a `load().files` entry), not a bundle.
 * const { data } = load([{ name: "a.bundle", data: bundleBytes }]).files[0]!;
 * const sf = readSerializedFile(data);
 * for (const info of sf.objects) {
 *   const reader = new ObjectReader(data, sf, info);
 *   if (reader.type === ClassID.TextAsset) reader.readAlignedString(); // m_Name
 * }
 */
export class ObjectReader extends BinaryReader {
  /** Object id within its file (D9). */
  readonly pathId: bigint;
  /**
   * Unity class id (upstream `type`), kept as the number the file holds even
   * when `ClassID` does not name it; see `classIdName`.
   */
  readonly type: number;
  /** Absolute offset of the object's data in the file. */
  readonly byteStart: number;
  /** Size of the object's data in bytes; equal to {@link length}. */
  readonly byteSize: number;
  /** The object's type entry, with its type tree when the file has one. */
  readonly serializedType: SerializedType | null;
  /** SerializedFile format version of the file (upstream `m_Version`). */
  readonly format: number;
  /** Unity version that wrote the file (upstream `version`). */
  readonly version: UnityVersion;
  /**
   * Release type of that version (upstream `buildType`), such as `"f"`, `"p"`
   * or `"a"`; see `SerializedFile.buildType`. Upstream's `IsPatch` is
   * `buildType === "p"`, `IsAlpha` is `buildType === "a"`.
   */
  readonly buildType: string;
  /** The Unity version exactly as the file holds it (`"0.0.0"` when stripped). */
  readonly unityVersion: string;
  /** Platform the file was built for (upstream `platform`). */
  readonly platform: BuildTarget;
  /** The file's `[SerializeReference]` types, for {@link readTypeTree}. */
  readonly refTypes: SerializedType[];

  /**
   * @param data the whole SerializedFile the object table was read from
   * @param file the parsed header and metadata of `data`
   * @param info one entry of `file.objects`
   * @throws {CorruptError} when the object's data runs past the end of `data`
   */
  constructor(data: Uint8Array, file: SerializedFile, info: ObjectInfo) {
    const { pathId, byteStart, byteSize } = info;
    const end = byteStart + byteSize;
    if (end > data.length) {
      throw new CorruptError(
        `object ${pathId} data at ${byteStart} of ${byteSize} bytes ends at ${end}, ` +
          `past the end of the ${data.length}-byte file`,
      );
    }
    super(data.subarray(byteStart, end), file.bigEndian ? "big" : "little");
    this.pathId = pathId;
    this.type = info.classId;
    this.byteStart = byteStart;
    this.byteSize = byteSize;
    this.serializedType = info.serializedType;
    this.format = file.header.version;
    this.version = file.version;
    this.buildType = file.buildType;
    this.unityVersion = file.unityVersion;
    this.platform = file.targetPlatform;
    this.refTypes = file.refTypes;
  }

  /**
   * Read a Vector3: three floats from Unity 5.4 on, and before it a Vector4
   * whose `w` is read and dropped.
   *
   * @throws {CorruptError} past the end of the object
   */
  readVector3(): Vector3 {
    const [major, minor] = this.version;
    // Before 5.4 a Vector3 field is serialized as a Vector4.
    if (major < 5 || (major === 5 && minor < 4)) return readVector4AsVector3(this);
    return { x: this.readFloat32(), y: this.readFloat32(), z: this.readFloat32() };
  }

  /**
   * Read `length` Vector3s (see {@link readVector3}), or an `Int32` count and
   * then that many when `length` is not given.
   *
   * @param length how many to read; omit to read the count from the data
   * @throws {CorruptError} when the count is negative or larger than the bytes
   *   left, or past the end of the object
   */
  readVector3Array(length?: number): Vector3[] {
    const count = length ?? readCount(this, "Vector3");
    const out: Vector3[] = [];
    for (let i = 0; i < count; i++) out.push(this.readVector3());
    return out;
  }

  /**
   * Read an XForm: a Vector3 translation (see {@link readVector3}), a
   * quaternion and a Vector3 scale.
   *
   * @throws {CorruptError} past the end of the object
   */
  readXForm(): XForm {
    return { t: this.readVector3(), q: readQuaternion(this), s: this.readVector3() };
  }

  /**
   * Read an XForm stored with Vector4 translation and scale, whatever the
   * version; their `w` is read and dropped, as upstream's conversion to
   * Vector3 does.
   *
   * @throws {CorruptError} past the end of the object
   */
  readXForm4(): XForm {
    return {
      t: readVector4AsVector3(this),
      q: readQuaternion(this),
      s: readVector4AsVector3(this),
    };
  }

  /**
   * Read the whole object into a plain JS object by walking its type tree; see
   * the `readTypeTree` function for the value shapes.
   *
   * @throws {UnsupportedError} when the file has no type tree for the object
   * @throws {CorruptError} when the data does not match the type tree, or does
   *   not end exactly at `byteSize`
   */
  readTypeTree(): TypeTreeObject {
    return readTypeTree(this);
  }

  /**
   * Read the whole object: with the hardcoded reader of its class when there
   * is one, as upstream does, and with {@link readTypeTree} otherwise.
   *
   * The classes with a hardcoded reader are the keys of `CLASS_READERS` in
   * `classes/registry.ts`, the one list of them, and {@link ObjectData} is the
   * union of what they return; each result type there documents its shape. A
   * reader that needs a resource file (a `Texture2D`'s `.resS` / `.resource`,
   * named by `m_StreamData`) reads it through the env that built this reader.
   *
   * `MonoBehaviour` is the exception: its hardcoded reader reads only the
   * header, so when the file has a type tree `read()` is the whole
   * {@link readTypeTree} result, the script's fields included, and only
   * without one is it the header `readMonoBehaviour` reads.
   *
   * When a hardcoded reader refuses an object, `read()` throws; it does not
   * fall back to the type tree. Call {@link readTypeTree} for that.
   *
   * **`T` is not checked.** It is the caller's claim about the result, an
   * unchecked cast of the `ObjectData` union, and nothing at run time makes it
   * true. Pick it after checking {@link type}, as in
   * `if (obj.type === ClassID.Texture2D) decodeTexture2D(obj.read())`, where
   * it is inferred from the parameter; without it the result is the union.
   * The type system does not stop `decodeTexture2D(obj.read())` on any other
   * class either, so a consumer such as `decodeTexture2D` must validate its
   * input at run time rather than trust the type.
   *
   * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
   *   `unityVersion` as `found`, when a version-gated class reader has no
   *   layout for the file's version: one it has no layout data for (such as
   *   below Unity 3.4), or an unknown one (`[0, 0, 0, 0]`: version-stripped, or
   *   a loose file below format 7) unless the file's format and the object's
   *   own bytes leave exactly one candidate layout (the rule on epic #36). So
   *   `Texture2D` and `MonoScript` refuse every version-stripped file, while
   *   `TextAsset` (from format 7) and `AssetBundle` (from format 16) read one
   *   where the bytes decide. An editor file's header of an unknown or pre-3.4
   *   version is refused the same way. Each reader's JSDoc gives its exact
   *   conditions.
   * @throws {UnsupportedError} of kind `"build target"`, found `"NoTarget"`,
   *   when a class reader that does not read editor-only fields gets a file
   *   built for the editor (`BuildTarget.NoTarget`), such as a `Texture2D` or
   *   a `MonoScript`. `MonoBehaviour`'s header reader refuses one too, but
   *   `read()` reaches it only when the file has no type tree, and Unity
   *   always writes one into an editor file.
   * @throws {UnsupportedError} of kind `"object without a type tree"`, naming
   *   the class id and path id, for a class without a hardcoded reader in a
   *   file built without type trees; and whatever else {@link readTypeTree}
   *   refuses
   * @throws {ResourceNotFoundError} when the data is in a resource file that
   *   was not passed to `load()`; always, for data in a resource file, when
   *   this reader was not built by `load()`
   * @throws {CorruptError} when the data does not hold together, for example:
   *   the object ends early, a count or length the reader checks is negative
   *   or runs past the object's end, a reader that reads the whole object
   *   finds bytes left after its last field, or the type tree read does not
   *   end exactly at `byteSize`; when a `Texture2D`'s `m_StreamData.offset` is
   *   2^53 or above, or the resource range runs past the end of its file; when
   *   a `Texture2D` has no image data, neither inline nor in a resource file;
   *   and whatever else {@link readTypeTree} throws, such as for a malformed
   *   type tree or an undeclared `[SerializeReference]` type
   */
  read<T extends ObjectData = ObjectData>(): T {
    // The caller's claim, per the JSDoc: `T` narrows the union unchecked.
    return readObjectData(this, resourceReaders.get(this)) as T;
  }
}

/** Four floats with the fourth dropped (upstream's implicit `Vector4` to `Vector3`). */
function readVector4AsVector3(reader: BinaryReader): Vector3 {
  const v = { x: reader.readFloat32(), y: reader.readFloat32(), z: reader.readFloat32() };
  reader.readFloat32(); // w
  return v;
}

/** Four floats as x, y, z, w (upstream `ReadQuaternion`). */
function readQuaternion(reader: BinaryReader): Quaternion {
  return {
    x: reader.readFloat32(),
    y: reader.readFloat32(),
    z: reader.readFloat32(),
    w: reader.readFloat32(),
  };
}
