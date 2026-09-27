// Ported from AssetStudio/Classes/Font.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError, UnsupportedError } from "../errors.js";
import { SerializedFileFormatVersion as V } from "../serialized/FormatVersion.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import { readCount } from "../serialized/TypeTree.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
import { readPPtr, type PPtr } from "./PPtr.js";
import { readStringField } from "./strings.js";
import { atLeast } from "./version.js";

/** A rectangle (Unity's `Rectf`). */
export interface Rectf {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One glyph of a font's texture (Unity's `CharacterInfo`). */
export interface CharacterInfo {
  index: number;
  uv: Rectf;
  vert: Rectf;
  /** Before Unity 5.3; renamed `advance` there. */
  width?: number;
  /** Unity 5.3 and later. */
  advance?: number;
  /** Unity 4.0 and later. */
  flipped?: boolean;
}

/**
 * The fields of a `Font`, under Unity's names: keys, their order and their
 * values agree with `readTypeTree()` on the same object, pairs and map entries
 * as `[first, second]` arrays as it gives them.
 *
 * The font file itself, a TrueType or OpenType file as imported, is
 * `m_FontData`, inline in the object; it is empty for a font that is only a
 * texture (not dynamic, or imported without its font data). Unity reordered
 * the fields in 5.5.
 */
export interface Font extends NamedObject {
  m_AsciiStartOffset: number;
  /** Unity 3.4 to 3.5. */
  m_FontCountX?: number;
  /** Unity 3.4 to 3.5. */
  m_FontCountY?: number;
  /** Before Unity 5.3; renamed `m_Tracking` there. */
  m_Kerning?: number;
  /** Unity 5.3 and later. */
  m_Tracking?: number;
  m_LineSpacing: number;
  /** Unity 3.4 to 3.5: `[character, kerning]`. */
  m_PerCharacterKerning?: [number, number][];
  /** Unity 4.0 and later. */
  m_CharacterSpacing?: number;
  /** Unity 4.0 and later. */
  m_CharacterPadding?: number;
  m_ConvertCase: number;
  m_DefaultMaterial: PPtr;
  m_CharacterRects: CharacterInfo[];
  m_Texture: PPtr;
  /** `[[first character, second character], kerning]`. */
  m_KerningValues: [[number, number], number][];
  /** Unity 3.4 to 3.5. */
  m_GridFont?: boolean;
  /** Unity 4.0 and later. */
  m_PixelScale?: number;
  /** The TrueType / OpenType file, a view into the object's bytes (R7). */
  m_FontData: Uint8Array;
  m_FontSize: number;
  m_Ascent: number;
  /** Unity 5.4 and later. */
  m_Descent?: number;
  m_DefaultStyle: number;
  m_FontNames: string[];
  /** Unity 4.0 and later. */
  m_FallbackFonts?: PPtr[];
  /** Unity 4.0 and later. */
  m_FontRenderingMode?: number;
  /** Some releases of 5.6 to 2017.3 (see `readFont`), and 2018.1 and later. */
  m_UseLegacyBoundsCalculation?: boolean;
  /** Unity 2018.1 and later. */
  m_ShouldRoundAdvanceValue?: boolean;
}

/**
 * Read a `Font` from the object's first byte: every field of Unity's own type
 * trees for its version (UnityPy's TPK data), in their order, through the
 * last one. Upstream reads up to `m_FontData` and stops.
 *
 * Editor and player files share the layout after `m_Name`, so both are read.
 * Below Unity 3.4 there is no type tree data, so such a file is refused.
 *
 * `m_UseLegacyBoundsCalculation` came with patch releases: TPK has it in
 * 5.6.5f1, 2017.1.2p1, 2017.2.0p1 and 2017.3.0b11 but not in 2017.1.0b1,
 * 2017.2.0b2 or 2017.3.0b1, so the release number does not say which 5.5 to
 * 2017.x files have it. It is the last field and not padded, so there, one
 * byte left after `m_FontRenderingMode` is it and none is its absence.
 *
 * A file whose Unity version is unknown (`[0, 0, 0, 0]`) is read when its
 * format is 16 (5.5) or later (rule for version-stripped files, #36): every
 * layout those formats allow shares the fields through `m_FontRenderingMode`,
 * and the bytes left, 0, 1 or 2, pick 5.5's, the one with
 * `m_UseLegacyBoundsCalculation` or 2018.1's. Before 16 the layouts differ
 * inside the object, so the file is refused.
 *
 * The object must end exactly after its last field (upstream does not check).
 *
 * ponytail: the gates compare release numbers only (see `atLeast`), so a
 * 2018.1.0b1 file is read with 2018.1.0b2's `m_ShouldRoundAdvanceValue`; if it
 * lacks it, the end-of-object check throws a CorruptError. Compare the build
 * type if a pre-release ever matters.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`, below 3.4, for an unknown version below format
 *   16, or for an unknown version whose bytes after `m_FontRenderingMode` fit
 *   no layout; as `readNamedObject` does, for an editor file of unknown version
 * @throws {CorruptError} when the object ends early, a count or string length
 *   is negative or runs past its end, or bytes are left over after the last
 *   field
 */
export function readFont(reader: ObjectReader): Font {
  const { version } = reader;
  // #36 rule: an unknown version is read only where the bytes decide.
  const stripped = version.every((part) => part === 0);
  if (stripped && reader.format < V.RefactoredClassId) {
    throw refuse(reader, "below format 16 a Font's layout depends on the Unity version");
  }
  if (!stripped && !atLeast(version, 3, 4)) {
    throw refuse(reader, "no known Font layout before Unity 3.4");
  }

  const base = readNamedObject(reader);
  const out = stripped || atLeast(version, 5, 5) ? readFields(reader, base) : readOld(reader, base);

  // 5.5+: the tail bools (see above); 0 bytes are left when neither is there.
  if (stripped) {
    if (reader.remaining > 2) {
      throw refuse(
        reader,
        `the ${reader.remaining} bytes after m_FontRenderingMode fit none of the layouts ` +
          "of format 16 and later (5.5, 5.6.5, 2018.1)",
      );
    }
    readTail(reader, out, reader.remaining);
  } else if (atLeast(version, 2018, 1)) {
    readTail(reader, out, 2);
  } else if (atLeast(version, 5, 5)) {
    readTail(reader, out, reader.remaining === 1 ? 1 : 0);
  }

  if (reader.remaining !== 0) {
    throw new CorruptError(
      `Font ${reader.pathId} ends at ${reader.position} of its ${reader.byteSize} bytes`,
    );
  }
  return out;
}

/** 5.5+: the fields after `m_Name` through `m_FontRenderingMode`. */
function readFields(reader: ObjectReader, base: NamedObject): Font {
  const out: Partial<Font> & NamedObject = { ...base };
  out.m_LineSpacing = reader.readFloat32();
  out.m_DefaultMaterial = readPPtr(reader);
  out.m_FontSize = reader.readFloat32();
  out.m_Texture = readPPtr(reader);
  out.m_AsciiStartOffset = reader.readInt32();
  out.m_Tracking = reader.readFloat32();
  out.m_CharacterSpacing = reader.readInt32();
  out.m_CharacterPadding = reader.readInt32();
  out.m_ConvertCase = reader.readInt32();
  out.m_CharacterRects = readArray(reader, "m_CharacterRects", (r) =>
    readCharacterInfo(r, true, true),
  );
  out.m_KerningValues = readArray(reader, "m_KerningValues", readKerningPair);
  out.m_PixelScale = reader.readFloat32();
  out.m_FontData = readFontData(reader);
  out.m_Ascent = reader.readFloat32();
  out.m_Descent = reader.readFloat32();
  out.m_DefaultStyle = reader.readUInt32();
  out.m_FontNames = readFontNames(reader);
  out.m_FallbackFonts = readArray(reader, "m_FallbackFonts", readPPtr);
  out.m_FontRenderingMode = reader.readInt32();
  // Every required field was set above.
  return out as Font;
}

/** 5.5+: `count` (0 to 2) of the unpadded bools the object ends with. */
function readTail(reader: ObjectReader, out: Font, count: number): void {
  if (count >= 1) out.m_UseLegacyBoundsCalculation = reader.readUInt8() !== 0;
  if (count >= 2) out.m_ShouldRoundAdvanceValue = reader.readUInt8() !== 0;
}

/**
 * 3.4 to 5.4: the fields after `m_Name`, in the order before 5.5's. 4.0
 * replaced the grid font fields with spacing and fallbacks, 5.3 renamed two
 * fields, 5.4 added `m_Descent`.
 */
function readOld(reader: ObjectReader, base: NamedObject): Font {
  const { version } = reader;
  const v4 = atLeast(version, 4, 0);
  const v5_3 = atLeast(version, 5, 3);
  const out: Partial<Font> & NamedObject = { ...base };
  out.m_AsciiStartOffset = reader.readInt32();
  if (!v4) {
    out.m_FontCountX = reader.readInt32();
    out.m_FontCountY = reader.readInt32();
  }
  if (v5_3) out.m_Tracking = reader.readFloat32();
  else out.m_Kerning = reader.readFloat32();
  out.m_LineSpacing = reader.readFloat32();
  if (v4) {
    out.m_CharacterSpacing = reader.readInt32();
    out.m_CharacterPadding = reader.readInt32();
  } else {
    out.m_PerCharacterKerning = readArray(reader, "m_PerCharacterKerning", (r) => [
      r.readInt32(),
      r.readFloat32(),
    ]);
  }
  out.m_ConvertCase = reader.readInt32();
  out.m_DefaultMaterial = readPPtr(reader);
  out.m_CharacterRects = readArray(reader, "m_CharacterRects", (r) =>
    readCharacterInfo(r, v5_3, v4),
  );
  out.m_Texture = readPPtr(reader);
  out.m_KerningValues = readArray(reader, "m_KerningValues", readKerningPair);
  if (v4) {
    out.m_PixelScale = reader.readFloat32();
  } else {
    out.m_GridFont = reader.readUInt8() !== 0;
    reader.align();
  }
  out.m_FontData = readFontData(reader);
  out.m_FontSize = reader.readFloat32();
  out.m_Ascent = reader.readFloat32();
  if (atLeast(version, 5, 4)) out.m_Descent = reader.readFloat32();
  out.m_DefaultStyle = reader.readUInt32();
  out.m_FontNames = readFontNames(reader);
  if (v4) {
    out.m_FallbackFonts = readArray(reader, "m_FallbackFonts", readPPtr);
    out.m_FontRenderingMode = reader.readInt32();
  }
  // Every required field was set above.
  return out as Font;
}

/**
 * One `CharacterInfo`: its last float is `width` before 5.3 and `advance`
 * from it; 4.0 added `flipped`, padded.
 */
function readCharacterInfo(
  reader: ObjectReader,
  advance: boolean,
  flipped: boolean,
): CharacterInfo {
  const index = reader.readUInt32();
  const uv = readRectf(reader);
  const vert = readRectf(reader);
  const last = reader.readFloat32();
  const out: CharacterInfo = advance
    ? { index, uv, vert, advance: last }
    : { index, uv, vert, width: last };
  if (flipped) {
    out.flipped = reader.readUInt8() !== 0;
    reader.align();
  }
  return out;
}

function readRectf(reader: ObjectReader): Rectf {
  return {
    x: reader.readFloat32(),
    y: reader.readFloat32(),
    width: reader.readFloat32(),
    height: reader.readFloat32(),
  };
}

/** A `m_KerningValues` entry: `pair<pair<UInt16, UInt16>, float>`. */
function readKerningPair(reader: ObjectReader): [[number, number], number] {
  return [[reader.readUInt16(), reader.readUInt16()], reader.readFloat32()];
}

/** `m_FontData`: a byte count, the bytes, padding. */
function readFontData(reader: ObjectReader): Uint8Array {
  const data = reader.readBytes(readCount(reader, `Font ${reader.pathId} m_FontData byte`));
  reader.align();
  return data;
}

function readFontNames(reader: ObjectReader): string[] {
  return readArray(reader, "m_FontNames", (r) => readStringField(r, "Font", "m_FontNames entry"));
}

/** An `Int32` count, then that many elements. */
function readArray<T>(reader: ObjectReader, what: string, element: (r: ObjectReader) => T): T[] {
  const count = readCount(reader, `Font ${reader.pathId} ${what}`);
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(element(reader));
  return out;
}

/** Refuse a version this reader has no layout for, naming the file's own version string. */
function refuse(reader: ObjectReader, why: string): UnsupportedError {
  const hint = `object ${reader.pathId}: ${why}`;
  return new UnsupportedError("Unity version", reader.unityVersion, hint);
}
