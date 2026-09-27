// Ported from AssetStudio/ObjectReader.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError } from "../errors.js";
import { BinaryReader } from "../io/BinaryReader.js";
import type { BuildTarget } from "./BuildTarget.js";
import type { ObjectInfo, SerializedFile, UnityVersion } from "./SerializedFile.js";
import type { SerializedType } from "./TypeTree.js";

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
 * Upstream's `Game` (per-game quirks) and the `ReadVector3`/`ReadXForm`
 * helpers are not ported: nothing stock-Unity reads here yet uses them; the
 * vector helpers land with the first class reader that does (M4).
 *
 * @example
 * const sf = readSerializedFile(data);
 * const reader = new ObjectReader(data, sf, sf.objects[0]);
 * if (reader.classId === ClassID.TextAsset) reader.readAlignedString(); // m_Name
 */
export class ObjectReader extends BinaryReader {
  /** Object id within its file (D9). */
  readonly pathId: bigint;
  /** Unity class id as the file holds it; see `ClassID` and `classIdName`. */
  readonly classId: number;
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
  /** Platform the file was built for (upstream `platform`). */
  readonly platform: BuildTarget;

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
    this.classId = info.classId;
    this.byteStart = byteStart;
    this.byteSize = byteSize;
    this.serializedType = info.serializedType;
    this.format = file.header.version;
    this.version = file.version;
    this.platform = file.targetPlatform;
  }
}
