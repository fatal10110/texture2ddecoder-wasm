// Ported from AssetStudio/Classes/Material.cs (MIT, © Perfare / RazTools / Razviar)

import { CorruptError, UnsupportedError } from "../errors.js";
import { BuildTarget } from "../serialized/BuildTarget.js";
import { SerializedFileFormatVersion as V } from "../serialized/FormatVersion.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import type { UnityVersion } from "../serialized/SerializedFile.js";
import { readCount } from "../serialized/TypeTree.js";
import { readNamedObject, type NamedObject } from "./NamedObject.js";
import { readPPtr, type PPtr } from "./PPtr.js";
import { readStringField } from "./strings.js";
import { atLeast } from "./version.js";

/** Unity's `Vector2f`. */
export interface Vector2f {
  x: number;
  y: number;
}

/** Unity's `ColorRGBA`: linear floats, not clamped to 0..1 (an HDR color exceeds 1). */
export interface ColorRGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** One texture slot of a material (Unity's `UnityTexEnv`). */
export interface UnityTexEnv {
  /** The texture; a null pointer (`m_PathID` 0) when the slot is empty. */
  m_Texture: PPtr;
  /** Tiling. */
  m_Scale: Vector2f;
  m_Offset: Vector2f;
}

/**
 * A material's property values (Unity's `UnityPropertySheet`), each a list of
 * `[property name, value]` pairs in the order Unity wrote them. The names are
 * the shader's property names, such as `"_MainTex"` or `"_Color"`.
 */
export interface UnityPropertySheet {
  m_TexEnvs: [string, UnityTexEnv][];
  /** Unity 2021.1 and later: properties a shader declares as `Integer`. */
  m_Ints?: [string, number][];
  m_Floats: [string, number][];
  m_Colors: [string, ColorRGBA][];
}

/** One entry of `m_BuildTextureStacks` (virtual texturing). */
export interface BuildTextureStackReference {
  groupName: string;
  itemName: string;
}

/**
 * The fields of a `Material`, under Unity's names: the keys, their order and
 * their values agree with `readTypeTree()` on the same object, pairs as
 * `[first, second]` arrays as it gives them. The one difference is before
 * Unity 5.6, where a property name is Unity's `FastPropertyName` struct, which
 * `readTypeTree()` gives as `{ name }`; here it is the name itself, as from
 * 5.6 on (the bytes are the same).
 */
export interface Material extends NamedObject {
  /** The shader, usually in another file (a dependency bundle or Unity's built-in resources). */
  m_Shader: PPtr;
  /**
   * The enabled shader keywords: a list in Unity 4.1 to 4.x, one string of
   * space-separated keywords from 5.0 until 2021.2.18, which replaced it with
   * `m_ValidKeywords` and `m_InvalidKeywords`.
   */
  m_ShaderKeywords?: string | string[];
  /** Unity 2021.2.18 and later: enabled keywords the shader declares. */
  m_ValidKeywords?: string[];
  /** Unity 2021.2.18 and later: enabled keywords the shader does not declare. */
  m_InvalidKeywords?: string[];
  /** Unity 5.0 and later: `MaterialGlobalIlluminationFlags`. */
  m_LightmapFlags?: number;
  /** Unity 5.6 and later. */
  m_EnableInstancingVariants?: boolean;
  /** Unity 5.6.2 and later. */
  m_DoubleSidedGI?: boolean;
  /** Unity 4.3 and later: the render queue, or -1 for the shader's own. */
  m_CustomRenderQueue?: number;
  /** Unity 5.1 and later: override tags, tag name to value. */
  stringTagMap?: [string, string][];
  /** Unity 5.6 and later: the `LightMode` of each disabled pass, upper-cased by Unity. */
  disabledShaderPasses?: string[];
  m_SavedProperties: UnityPropertySheet;
  /** Unity 2020.1 and later. */
  m_BuildTextureStacks?: BuildTextureStackReference[];
}

/**
 * What a file of unknown version and format 18 to 21 is read as: those
 * formats are Unity 2019.1 to 2019.4 (`SerializedFileFormatVersion`), and the
 * Material layout of Unity's type trees is the same from 2017.1 to 2020.1.0a12.
 */
const UNITY_2019: UnityVersion = [2019, 4, 0, 0];

/**
 * Read a `Material` from the object's first byte: every field Unity's own type
 * trees give for its version (as UnityPy's TPK data records them), in their
 * order. Upstream reads `m_Shader` and `m_SavedProperties` and skips the rest
 * without keeping it; here it is kept, and `m_BuildTextureStacks` after the
 * property sheet is read too, so the object is consumed to its last byte.
 *
 * Unity changed the layout at 4.1, 4.3, 5.0, 5.1, 5.6, 5.6.2, 2020.1, 2021.1
 * and 2021.2.18, and has kept it since (checked up to 6000.6). Upstream moves
 * to `m_ValidKeywords` at 2021.3 rather than 2021.2.18, so it misreads
 * 2021.2.18 and later 2021.2 files.
 *
 * An editor file (`BuildTarget.NoTarget`) has the same layout after the
 * `EditorExtension` header until 2021.x, so it is read; from 2022.1 Unity adds
 * editor-only fields in between (`m_Parent`, `m_LockedProperties`, ...), which
 * upstream does not read either, so it is refused rather than misread.
 *
 * A file whose Unity version is unknown (`[0, 0, 0, 0]`, as
 * `AssetBundleStripUnityVersion` leaves it) is read when its format is 18 to
 * 21: only Unity 2019 writes those, and every 2019 release has the one layout
 * (rule for version-stripped files, #36). Any other format allows layouts that
 * differ inside the object (a keyword string or two keyword lists, `m_Ints` or
 * not), which the bytes cannot tell apart, so the file is refused.
 *
 * The object must end exactly where the last field does, so a layout this
 * reader does not know is refused rather than returned half-read.
 *
 * ponytail: the gates compare release numbers only (see `atLeast`), as the
 * other class readers' do. Pre-releases with an interim layout (TPK data):
 * 5.6.0b1 to b4 lack `m_EnableInstancingVariants` or `disabledShaderPasses`,
 * 2017.1.0b1 to b8 lack `m_DoubleSidedGI`, 2020.1.0a1 to a12 lack
 * `m_BuildTextureStacks`, and 2022.1.0a7 to b13 still have
 * `m_ShaderKeywords`. Such a file is misread or, mostly, fails the
 * end-of-object check. Compare `buildType` and the build number in the gates if
 * one ever matters.
 *
 * @param reader the object's reader, rewound first and left at its end
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`: below 3.4, for which no type tree data says what
 *   it holds, and for an unknown version (`[0, 0, 0, 0]`) unless the format is
 *   18 to 21; of kind `"build target"` for an editor file of 2022.1 or later;
 *   and as `readNamedObject` does, for an editor file of unknown version
 * @throws {CorruptError} when the object ends early, a count or string length
 *   is negative or runs past its end, or bytes are left over after the last
 *   field
 */
export function readMaterial(reader: ObjectReader): Material {
  const version = layoutVersion(reader);
  if (reader.platform === BuildTarget.NoTarget && atLeast(version, 2022, 1)) {
    throw new UnsupportedError(
      "build target",
      "NoTarget",
      `object ${reader.pathId}: an editor file's Material holds editor-only fields from 2022.1`,
    );
  }

  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<Material> & NamedObject = readNamedObject(reader);
  out.m_Shader = readPPtr(reader);
  if (atLeast(version, 2021, 2, 18)) {
    out.m_ValidKeywords = readStrings(reader, "m_ValidKeywords");
    out.m_InvalidKeywords = readStrings(reader, "m_InvalidKeywords");
  } else if (atLeast(version, 5, 0)) {
    // 5.0: the keyword list became one space-separated string.
    out.m_ShaderKeywords = readStringField(reader, "Material", "m_ShaderKeywords");
  } else if (atLeast(version, 4, 1)) {
    out.m_ShaderKeywords = readStrings(reader, "m_ShaderKeywords");
  }
  if (atLeast(version, 5, 0)) out.m_LightmapFlags = reader.readUInt32();
  if (atLeast(version, 5, 6)) {
    out.m_EnableInstancingVariants = reader.readUInt8() !== 0;
    // 5.6.2+: a second flag inside the same padding.
    if (atLeast(version, 5, 6, 2)) out.m_DoubleSidedGI = reader.readUInt8() !== 0;
    reader.align();
  }
  if (atLeast(version, 4, 3)) out.m_CustomRenderQueue = reader.readInt32();
  if (atLeast(version, 5, 1)) {
    out.stringTagMap = readArray(reader, "stringTagMap", (r): [string, string] => [
      readStringField(r, "Material", "stringTagMap tag"),
      readStringField(r, "Material", "stringTagMap value"),
    ]);
  }
  if (atLeast(version, 5, 6)) {
    out.disabledShaderPasses = readStrings(reader, "disabledShaderPasses");
  }
  out.m_SavedProperties = readPropertySheet(reader, version);
  if (atLeast(version, 2020, 1)) {
    out.m_BuildTextureStacks = readArray(reader, "m_BuildTextureStacks", (r) => ({
      groupName: readStringField(r, "Material", "m_BuildTextureStacks groupName"),
      itemName: readStringField(r, "Material", "m_BuildTextureStacks itemName"),
    }));
  }

  if (reader.remaining !== 0) {
    throw new CorruptError(
      `Material ${reader.pathId} ends at ${reader.position} of its ${reader.byteSize} bytes`,
    );
  }
  // Every required field was set above.
  return out as Material;
}

/**
 * The version whose layout the object has: the file's own, or 2019's for an
 * unknown version in a format only 2019 writes (see `readMaterial`).
 *
 * @throws {UnsupportedError} when no layout can be picked
 */
function layoutVersion(reader: ObjectReader): UnityVersion {
  const { version, format } = reader;
  // Rule for version-gated class readers (#36, amended on #123/#126): an
  // unknown version is read only where the layout is certain without it.
  if (version.every((part) => part === 0)) {
    if (format >= V.RefactorShareableTypeTreeData && format <= V.StoresTypeDependencies) {
      return UNITY_2019;
    }
    throw refuse(
      reader,
      `a Material's layout depends on the Unity version, which this format ${format} file ` +
        "does not record, and its bytes cannot decide it",
    );
  }
  if (!atLeast(version, 3, 4)) throw refuse(reader, "no known Material layout before Unity 3.4");
  return version;
}

/** The property sheet: texture slots, then (2021.1+) ints, floats and colors. */
function readPropertySheet(reader: ObjectReader, version: UnityVersion): UnityPropertySheet {
  // Filled in field order, so the keys come out in the order Unity wrote them.
  const out: Partial<UnityPropertySheet> = {};
  out.m_TexEnvs = readArray(reader, "m_TexEnvs", (r): [string, UnityTexEnv] => [
    readName(r, "m_TexEnvs"),
    { m_Texture: readPPtr(r), m_Scale: readVector2f(r), m_Offset: readVector2f(r) },
  ]);
  if (atLeast(version, 2021, 1)) {
    out.m_Ints = readArray(reader, "m_Ints", (r): [string, number] => [
      readName(r, "m_Ints"),
      r.readInt32(),
    ]);
  }
  out.m_Floats = readArray(reader, "m_Floats", (r): [string, number] => [
    readName(r, "m_Floats"),
    r.readFloat32(),
  ]);
  out.m_Colors = readArray(reader, "m_Colors", (r): [string, ColorRGBA] => [
    readName(r, "m_Colors"),
    { r: r.readFloat32(), g: r.readFloat32(), b: r.readFloat32(), a: r.readFloat32() },
  ]);
  // Every required field was set above.
  return out as UnityPropertySheet;
}

/**
 * A property name. Before 5.6 it is a `FastPropertyName`, a struct holding
 * only the string, so the bytes are the same.
 */
function readName(reader: ObjectReader, what: string): string {
  return readStringField(reader, "Material", `${what} name`);
}

function readVector2f(reader: ObjectReader): Vector2f {
  return { x: reader.readFloat32(), y: reader.readFloat32() };
}

/** A `vector<string>`. */
function readStrings(reader: ObjectReader, what: string): string[] {
  return readArray(reader, what, (r) => readStringField(r, "Material", `${what} element`));
}

/** An `Int32` count, then that many elements. */
function readArray<T>(reader: ObjectReader, what: string, element: (r: ObjectReader) => T): T[] {
  const count = readCount(reader, `Material ${reader.pathId} ${what}`);
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(element(reader));
  return out;
}

/** Refuse a version this reader has no layout for, naming the file's own version string. */
function refuse(reader: ObjectReader, why: string): UnsupportedError {
  const hint = `object ${reader.pathId}: ${why}`;
  return new UnsupportedError("Unity version", reader.unityVersion, hint);
}
