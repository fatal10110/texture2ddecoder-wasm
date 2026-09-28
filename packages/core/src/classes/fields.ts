// The TypeScript-style shapes of `asset.data` (#184): the low-level reader
// results (`obj.read()`) under camelCase names without Unity's `m_` prefix.
// Not a port: a renaming on top of the ported readers, which keep Unity's
// names because the UnityPy goldens and upstream compare against them.
//
// Naming: `<UnityType>Fields` is the friendly form of the low-level
// `<UnityType>`. Every renamed field cites its Unity name in its JSDoc.

import type { BuildTarget } from "../serialized/BuildTarget.js";
import type { ObjectReader, Vector3 } from "../serialized/ObjectReader.js";
import type { TypeTreeObject } from "../serialized/TypeTreeReader.js";
import type {
  AssetBundle,
  AssetBundleScriptInfo,
  AssetInfo,
} from "./AssetBundle.js";
import type { AudioClipData } from "./AudioClip.js";
import type { EditorExtension } from "./EditorExtension.js";
import type { CharacterInfo, Font, Rectf } from "./Font.js";
import type {
  BuildTextureStackReference,
  Color,
  Material,
  UnityPropertySheet,
  UnityTexEnv,
  Vector2,
} from "./Material.js";
import type { MonoScript, Hash128 } from "./MonoScript.js";
import type { MovieTexture } from "./MovieTexture.js";
import type { NamedObject } from "./NamedObject.js";
import type { PPtr } from "./PPtr.js";
import type { MonoBehaviourData, Texture2DData } from "./registry.js";
import type {
  AABB,
  BlendShapeData,
  BoneWeights4,
  ChannelInfo,
  GUID,
  Matrix4x4,
  SecondarySpriteTexture,
  Sprite,
  SpriteBone,
  SpriteRenderData,
  SpriteVertex,
  SubMesh,
  Vector4,
  VertexData,
} from "./Sprite.js";
import type { SpriteAtlas, SpriteAtlasData } from "./SpriteAtlas.js";
import { textAssetString, type TextAsset } from "./TextAsset.js";
import type { Texture } from "./Texture.js";
import type { GLTextureSettings, StreamingInfo } from "./Texture2D.js";
import type { TextureFormat } from "./TextureFormat.js";
import type { StreamedResource, VideoClipData } from "./VideoClip.js";

// ---------------------------------------------------------------------------
// Shared bases

/**
 * The fields every object of an editor file (`BuildTarget.NoTarget`) starts
 * with; a player build stores none of them, and then they are absent.
 */
export interface EditorExtensionFields {
  /** Unity: `m_ObjectHideFlags`. Editor file only. */
  objectHideFlags?: number;
  /** Unity: `m_ExtensionPtr`. Editor file, Unity 3.4 only. */
  extensionPtr?: PPtr;
  /** Unity: `m_PrefabParentObject`. Editor file, Unity 3.5 to 2018.1. */
  prefabParentObject?: PPtr;
  /**
   * Unity: `m_CorrespondingSourceObject`. Editor file, Unity 2018.2 and later:
   * `prefabParentObject` renamed.
   */
  correspondingSourceObject?: PPtr;
  /** Unity: `m_PrefabInternal`. Editor file, Unity 3.5 to 2018.2. */
  prefabInternal?: PPtr;
  /** Unity: `m_PrefabInstance`. Editor file, Unity 2018.3 and later. */
  prefabInstance?: PPtr;
  /** Unity: `m_PrefabAsset`. Editor file, Unity 2018.3 and later. */
  prefabAsset?: PPtr;
}

/** {@link EditorExtensionFields} and the object's name. */
export interface NamedObjectFields extends EditorExtensionFields {
  /** Unity: `m_Name`. */
  name: string;
}

/** The fields every texture class starts with (Unity's `Texture`). */
export interface TextureFields extends NamedObjectFields {
  /** Unity: `m_ForcedFallbackFormat`. Unity 2017.3 to 2023.1. */
  forcedFallbackFormat?: TextureFormat;
  /** Unity: `m_DownscaleFallback`. Unity 2017.3 to 2023.1. */
  downscaleFallback?: boolean;
  /** Unity: `m_IsAlphaChannelOptional`. Unity 2020.2 and later. */
  isAlphaChannelOptional?: boolean;
}

// ---------------------------------------------------------------------------
// AssetBundle

/** The friendly form of {@link AssetBundle}. */
export interface AssetBundleFields extends NamedObjectFields {
  /**
   * Unity: `m_PreloadTable`. Every object the bundle's assets need, their
   * dependencies included.
   */
  preloadTable: PPtr[];
  /**
   * Unity: `m_Container`. Asset path (`"assets/ui/logo.png"`, lower-cased by
   * Unity) to asset, in the order Unity wrote them; a path may repeat.
   */
  container: [string, AssetInfo][];
  /** Unity: `m_MainAsset`. */
  mainAsset: AssetInfo;
  /** Unity: `m_ScriptCompatibility`. Unity 3.4 to 4.x. */
  scriptCompatibility?: AssetBundleScriptInfo[];
  /** Unity: `m_ClassCompatibility`. Unity 3.5 to 4.x: class id to class version. */
  classCompatibility?: [number, number][];
  /** Unity: `m_ClassVersionMap`. Unity 5.4 only: class id to class version. */
  classVersionMap?: [number, number][];
  /** Unity: `m_RuntimeCompatibility`. Unity 4.2 and later. */
  runtimeCompatibility?: number;
  /** Unity: `m_AssetBundleName`. Unity 5.0 and later. */
  assetBundleName?: string;
  /** Unity: `m_Dependencies`. Unity 5.0 and later: the bundles this one needs. */
  dependencies?: string[];
  /** Unity: `m_IsStreamedSceneAssetBundle`. Unity 5.0 and later. */
  isStreamedSceneAssetBundle?: boolean;
  /** Unity: `m_ExplicitDataLayout`. Unity 2017.3 and later. */
  explicitDataLayout?: number;
  /** Unity: `m_PathFlags`. Unity 2017.1 and later. */
  pathFlags?: number;
  /** Unity: `m_SceneHashes`. Unity 2017.3 and later: scene path to scene hash. */
  sceneHashes?: [string, string][];
}

/**
 * An `AssetBundle` as {@link AssetBundleFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toAssetBundleFields(data: AssetBundle): AssetBundleFields {
  return defined({
    ...namedObject(data),
    preloadTable: data.m_PreloadTable,
    container: data.m_Container,
    mainAsset: data.m_MainAsset,
    scriptCompatibility: data.m_ScriptCompatibility,
    classCompatibility: data.m_ClassCompatibility,
    classVersionMap: data.m_ClassVersionMap,
    runtimeCompatibility: data.m_RuntimeCompatibility,
    assetBundleName: data.m_AssetBundleName,
    dependencies: data.m_Dependencies,
    isStreamedSceneAssetBundle: data.m_IsStreamedSceneAssetBundle,
    explicitDataLayout: data.m_ExplicitDataLayout,
    pathFlags: data.m_PathFlags,
    sceneHashes: data.m_SceneHashes,
  });
}

// ---------------------------------------------------------------------------
// TextAsset

/** The friendly form of {@link TextAsset}, with its content decoded too. */
export interface TextAssetFields extends NamedObjectFields {
  /**
   * Unity: `m_Script`. The file's content as it is stored (`.txt`, `.json`,
   * `.bytes`, ...), a view into the object's bytes (R7).
   */
  bytes: Uint8Array;
  /**
   * `bytes` decoded as UTF-8 by {@link textAssetString}: invalid sequences
   * become U+FFFD. Decoded on first access and kept, so a binary TextAsset
   * costs nothing until it is asked for.
   */
  readonly text: string;
  /** Unity: `m_PathName`. Unity 3.4 to 2017.1 only: the source asset's path. */
  pathName?: string;
}

/**
 * A `TextAsset` as {@link TextAssetFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toTextAssetFields(data: TextAsset): TextAssetFields {
  let text: string | undefined;
  const out: TextAssetFields = {
    ...namedObject(data),
    bytes: data.m_Script,
    get text(): string {
      text ??= textAssetString(data);
      return text;
    },
  };
  if (data.m_PathName !== undefined) out.pathName = data.m_PathName;
  return out;
}

// ---------------------------------------------------------------------------
// MonoBehaviour

/** The friendly form of {@link MonoBehaviourData}: the header, and the script's fields apart. */
export interface MonoBehaviourFields extends EditorExtensionFields {
  /**
   * Unity: `m_GameObject`. The GameObject it is attached to; a null pointer
   * for a ScriptableObject.
   */
  gameObject: PPtr;
  /** Unity: `m_Enabled`, a `UInt8`: `true` when it is not 0. */
  enabled: boolean;
  /** Unity: `m_EditorHideFlags`. Editor file only. */
  editorHideFlags?: number;
  /** Unity: `m_Script`. The `MonoScript` naming its C# class. */
  script: PPtr;
  /** Unity: `m_Name`. The asset's name; `""` for a component on a GameObject. */
  name: string;
  /** Unity: `m_EditorClassIdentifier`. Editor file, Unity 4.2 and later. */
  editorClassIdentifier?: string;
  /**
   * The script's own serialized fields, under the names the script gives
   * them: the object's type tree without the header fields above. Absent
   * when the file has no type tree, which is the only way to read them here
   * (see {@link MonoBehaviourData}).
   */
  fields?: TypeTreeObject;
}

/** The {@link MonoBehaviourData} keys that are header, not the script's fields. */
const MONO_BEHAVIOUR_HEADER: ReadonlySet<string> = new Set([
  "m_ObjectHideFlags",
  "m_ExtensionPtr",
  "m_PrefabParentObject",
  "m_CorrespondingSourceObject",
  "m_PrefabInternal",
  "m_PrefabInstance",
  "m_PrefabAsset",
  "m_GameObject",
  "m_Enabled",
  "m_EditorHideFlags",
  "m_Script",
  "m_Name",
  "m_EditorClassIdentifier",
]);

/**
 * A `MonoBehaviour` as {@link MonoBehaviourFields}.
 *
 * @param data what `obj.read()` returns for the object
 * @param reader the object it was read from: its type tree, or the lack of
 *   one, tells whether `data` holds the script's fields (a script with no
 *   fields and a file without type trees give the same keys)
 */
export function toMonoBehaviourFields(
  data: MonoBehaviourData,
  reader: ObjectReader,
): MonoBehaviourFields {
  const out: MonoBehaviourFields = defined({
    ...editorExtension(data),
    gameObject: data.m_GameObject,
    enabled: data.m_Enabled !== 0,
    editorHideFlags: data.m_EditorHideFlags as number | undefined,
    script: data.m_Script,
    name: data.m_Name,
    editorClassIdentifier: data.m_EditorClassIdentifier as string | undefined,
  });
  const nodes = reader.serializedType?.nodes;
  if (nodes && nodes.length > 0) {
    // With a type tree, `data` is `readTypeTree()`'s result: every value past
    // the header is a TypeTreeValue.
    const entries = Object.entries(data).filter(([key]) => !MONO_BEHAVIOUR_HEADER.has(key));
    out.fields = Object.fromEntries(entries) as TypeTreeObject;
  }
  return out;
}

// ---------------------------------------------------------------------------
// MonoScript

/** The friendly form of {@link MonoScript}. */
export interface MonoScriptFields extends NamedObjectFields {
  /** Unity: `m_ExecutionOrder`. */
  executionOrder: number;
  /**
   * Unity: `m_PropertiesHash`. A `UInt32` before Unity 5.0, a {@link Hash128}
   * from 5.0: the hash of the class's serialized fields.
   */
  propertiesHash: number | Hash128;
  /** Unity: `m_ClassName`. The C# class name, without its namespace. */
  className: string;
  /** Unity: `m_Namespace`. `""` for the global namespace. */
  namespace: string;
  /** Unity: `m_AssemblyName`. Such as `"Assembly-CSharp.dll"`. */
  assemblyName: string;
  /** Unity: `m_IsEditorScript`. Before Unity 2018.2. */
  isEditorScript?: boolean;
}

/**
 * A `MonoScript` as {@link MonoScriptFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toMonoScriptFields(data: MonoScript): MonoScriptFields {
  return defined({
    ...namedObject(data),
    executionOrder: data.m_ExecutionOrder,
    propertiesHash: data.m_PropertiesHash,
    className: data.m_ClassName,
    namespace: data.m_Namespace,
    assemblyName: data.m_AssemblyName,
    isEditorScript: data.m_IsEditorScript,
  });
}

// ---------------------------------------------------------------------------
// Material

/** The friendly form of {@link UnityTexEnv}: one texture slot of a material. */
export interface UnityTexEnvFields {
  /** Unity: `m_Texture`. A null pointer (`m_PathID` 0) when the slot is empty. */
  texture: PPtr;
  /** Unity: `m_Scale`. Tiling. */
  scale: Vector2;
  /** Unity: `m_Offset`. */
  offset: Vector2;
}

/** The friendly form of {@link UnityPropertySheet}: a material's properties by name. */
export interface UnityPropertySheetFields {
  /** Unity: `m_TexEnvs`. Texture slots, such as `"_MainTex"`. */
  texEnvs: [string, UnityTexEnvFields][];
  /** Unity: `m_Ints`. Unity 2021.1 and later: properties declared `Integer`. */
  ints?: [string, number][];
  /** Unity: `m_Floats`. */
  floats: [string, number][];
  /** Unity: `m_Colors`. */
  colors: [string, Color][];
}

/** The friendly form of {@link Material}. */
export interface MaterialFields extends NamedObjectFields {
  /** Unity: `m_Shader`. Usually in another file (a dependency bundle or built-in resources). */
  shader: PPtr;
  /**
   * Unity: `m_ShaderKeywords`. The enabled keywords: a list in Unity 4.1 to
   * 4.x, one space-separated string from 5.0 until 2021.2.18.
   */
  shaderKeywords?: string | string[];
  /** Unity: `m_ValidKeywords`. Unity 2021.2.18 and later. */
  validKeywords?: string[];
  /** Unity: `m_InvalidKeywords`. Unity 2021.2.18 and later. */
  invalidKeywords?: string[];
  /** Unity: `m_LightmapFlags`. Unity 5.0 and later: `MaterialGlobalIlluminationFlags`. */
  lightmapFlags?: number;
  /** Unity: `m_EnableInstancingVariants`. Unity 5.6 and later. */
  enableInstancingVariants?: boolean;
  /** Unity: `m_DoubleSidedGI`. Unity 5.6.2 and later. */
  doubleSidedGI?: boolean;
  /** Unity: `m_CustomRenderQueue`. Unity 4.3 and later: -1 for the shader's own. */
  customRenderQueue?: number;
  /** Unity 5.1 and later: override tags, tag name to value. */
  stringTagMap?: [string, string][];
  /** Unity 5.6 and later: the `LightMode` of each disabled pass. */
  disabledShaderPasses?: string[];
  /** Unity: `m_SavedProperties`. */
  savedProperties: UnityPropertySheetFields;
  /** Unity: `m_BuildTextureStacks`. Unity 2020.1 and later. */
  buildTextureStacks?: BuildTextureStackReference[];
}

/**
 * A `Material` as {@link MaterialFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toMaterialFields(data: Material): MaterialFields {
  const sheet = data.m_SavedProperties;
  return defined({
    ...namedObject(data),
    shader: data.m_Shader,
    shaderKeywords: data.m_ShaderKeywords,
    validKeywords: data.m_ValidKeywords,
    invalidKeywords: data.m_InvalidKeywords,
    lightmapFlags: data.m_LightmapFlags,
    enableInstancingVariants: data.m_EnableInstancingVariants,
    doubleSidedGI: data.m_DoubleSidedGI,
    customRenderQueue: data.m_CustomRenderQueue,
    stringTagMap: data.stringTagMap,
    disabledShaderPasses: data.disabledShaderPasses,
    savedProperties: defined({
      texEnvs: sheet.m_TexEnvs.map(([name, env]): [string, UnityTexEnvFields] => [
        name,
        { texture: env.m_Texture, scale: env.m_Scale, offset: env.m_Offset },
      ]),
      ints: sheet.m_Ints,
      floats: sheet.m_Floats,
      colors: sheet.m_Colors,
    }),
    buildTextureStacks: data.m_BuildTextureStacks,
  });
}

// ---------------------------------------------------------------------------
// Texture2D

/** The friendly form of {@link GLTextureSettings}: how a texture is sampled. */
export interface GLTextureSettingsFields {
  /** Unity: `m_FilterMode`. 0 point, 1 bilinear, 2 trilinear. */
  filterMode: number;
  /** Unity: `m_Aniso`. */
  aniso: number;
  /** Unity: `m_MipBias`. */
  mipBias: number;
  /** Unity: `m_WrapMode`. Before Unity 2017.1. */
  wrapMode?: number;
  /** Unity: `m_WrapU`. Unity 2017.1 and later. */
  wrapU?: number;
  /** Unity: `m_WrapV`. Unity 2017.1 and later. */
  wrapV?: number;
  /** Unity: `m_WrapW`. Unity 2017.1 and later. */
  wrapW?: number;
}

/**
 * The friendly form of {@link Texture2DData}: the header, the image bytes
 * wherever they were stored, and the platform they were built for.
 */
export interface Texture2DFields extends TextureFields {
  /** Unity: `m_Width`. */
  width: number;
  /** Unity: `m_Height`. */
  height: number;
  /** Unity: `m_CompleteImageSize`. Bytes of image data, all mip levels. */
  completeImageSize: number;
  /** Unity: `m_MipsStripped`. Unity 2020.1 and later. */
  mipsStripped?: number;
  /**
   * Unity: `m_TextureFormat`. The number the file holds, which may be one
   * `TextureFormat` does not name.
   */
  format: TextureFormat;
  /** Unity: `m_MipMap`. Before Unity 5.2: whether there are mip levels at all. */
  mipMap?: boolean;
  /** Unity: `m_MipCount`. Unity 5.2 and later. */
  mipCount?: number;
  /** Unity: `m_IsReadable`. Unity 2.6 and later. */
  isReadable?: boolean;
  /** Unity: `m_IsPreProcessed`. Unity 2019.4.9 and later. */
  isPreProcessed?: boolean;
  /** Unity: `m_IgnoreMasterTextureLimit`. Unity 2019.3 to 2022.1. */
  ignoreMasterTextureLimit?: boolean;
  /** Unity: `m_IgnoreMipmapLimit`. Unity 2022.2 and later. */
  ignoreMipmapLimit?: boolean;
  /** Unity: `m_MipmapLimitGroupName`. Unity 2022.2 and later. */
  mipmapLimitGroupName?: string;
  /** Unity: `m_ReadAllowed`. Unity 3.0 to 5.4. */
  readAllowed?: boolean;
  /** Unity: `m_StreamingMipmaps`. Unity 2018.2 and later. */
  streamingMipmaps?: boolean;
  /** Unity: `m_StreamingMipmapsPriority`. Unity 2018.2 and later. */
  streamingMipmapsPriority?: number;
  /** Unity: `m_ImageCount`. */
  imageCount: number;
  /** Unity: `m_TextureDimension`. */
  textureDimension: number;
  /** Unity: `m_TextureSettings`. */
  textureSettings: GLTextureSettingsFields;
  /** Unity: `m_LightmapFormat`. Unity 3.0 and later. */
  lightmapFormat?: number;
  /** Unity: `m_ColorSpace`. Unity 3.5 and later. */
  colorSpace?: number;
  /** Unity: `m_PlatformBlob`. Unity 2020.2 and later: a view into the object's bytes (R7). */
  platformBlob?: Uint8Array;
  /**
   * Unity: `m_StreamData`. Unity 5.3 and later: the byte range of a resource
   * file holding the image when it is not inline (an empty `path` otherwise).
   */
  streamData?: StreamingInfo;
  /**
   * The image, every mip level, still encoded in `format`: Unity's inline
   * `image data` when it is not empty, and otherwise the `streamData` bytes
   * (see {@link Texture2DData.imageData}). A view, never a copy (R7).
   */
  imageData: Uint8Array;
  /**
   * The platform the object's file was built for; not a Texture2D field
   * (see {@link Texture2DData.platform}).
   */
  platform: BuildTarget;
}

/**
 * A `Texture2D` as {@link Texture2DFields}. Unity's inline `image data` is
 * not carried over on its own: `imageData` is it whenever it holds anything.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toTexture2DFields(data: Texture2DData): Texture2DFields {
  return defined({
    ...texture(data),
    width: data.m_Width,
    height: data.m_Height,
    completeImageSize: data.m_CompleteImageSize,
    mipsStripped: data.m_MipsStripped,
    format: data.m_TextureFormat as TextureFormat,
    mipMap: data.m_MipMap,
    mipCount: data.m_MipCount,
    isReadable: data.m_IsReadable,
    isPreProcessed: data.m_IsPreProcessed,
    ignoreMasterTextureLimit: data.m_IgnoreMasterTextureLimit,
    ignoreMipmapLimit: data.m_IgnoreMipmapLimit,
    mipmapLimitGroupName: data.m_MipmapLimitGroupName,
    readAllowed: data.m_ReadAllowed,
    streamingMipmaps: data.m_StreamingMipmaps,
    streamingMipmapsPriority: data.m_StreamingMipmapsPriority,
    imageCount: data.m_ImageCount,
    textureDimension: data.m_TextureDimension,
    textureSettings: textureSettings(data.m_TextureSettings),
    lightmapFormat: data.m_LightmapFormat,
    colorSpace: data.m_ColorSpace,
    platformBlob: data.m_PlatformBlob,
    streamData: data.m_StreamData,
    imageData: data.imageData,
    platform: data.platform,
  });
}

// ---------------------------------------------------------------------------
// Sprite

/** The friendly form of {@link AABB}: a bounding box, its centre and half its size. */
export interface AABBFields {
  /** Unity: `m_Center`. */
  center: Vector3;
  /** Unity: `m_Extent`. */
  extent: Vector3;
}

/** The friendly form of {@link SubMesh}: a run of a mesh's index buffer. */
export interface SubMeshFields {
  /** Byte offset of its first index in the index buffer. */
  firstByte: number;
  indexCount: number;
  /** Unity's `GfxPrimitiveType`: 0 is triangles. */
  topology: number;
  /** Unity 2017.3 and later. */
  baseVertex?: number;
  firstVertex: number;
  vertexCount: number;
  localAABB: AABBFields;
}

/** The friendly form of {@link VertexData}: a mesh's vertex streams. */
export interface VertexDataFields {
  /** Unity: `m_CurrentChannels`. Before Unity 2018.1. */
  currentChannels?: number;
  /** Unity: `m_VertexCount`. */
  vertexCount: number;
  /** Unity: `m_Channels`. */
  channels: ChannelInfo[];
  /**
   * Unity: `m_DataSize`, which despite its name holds the bytes: every stream,
   * one after the other, a view into the object's bytes (R7).
   */
  data: Uint8Array;
}

/** The friendly form of {@link SpriteRenderData}: the mesh and texture area a sprite draws. */
export interface SpriteRenderDataFields {
  texture: PPtr;
  /** Unity 5.2 and later: the alpha of a texture whose format has none. */
  alphaTexture?: PPtr;
  /** Unity 2019.1 and later. */
  secondaryTextures?: SecondarySpriteTexture[];
  /** Unity: `m_SubMeshes`. Unity 5.6 and later. */
  subMeshes?: SubMeshFields[];
  /** Unity: `m_IndexBuffer`. Unity 5.6 and later: `UInt16` indices, a view (R7). */
  indexBuffer?: Uint8Array;
  /** Unity: `m_VertexData`. Unity 5.6 and later. */
  vertexData?: VertexDataFields;
  /** Before Unity 5.6. */
  vertices?: SpriteVertex[];
  /** Before Unity 5.6. */
  indices?: number[];
  /** Unity: `m_Bindpose`. Unity 2018.1 and later. */
  bindpose?: Matrix4x4[];
  /** Unity: `m_SourceSkin`. Unity 2018.1 only. */
  sourceSkin?: BoneWeights4[];
  /** Unity: `m_BlendShapes`. Unity 6000.5 and later. */
  blendShapes?: BlendShapeData;
  /** The sprite's area in `texture`, in pixels from its bottom-left corner. */
  textureRect: Rectf;
  /** Where `textureRect` starts inside the sprite's `rect` (its trimmed margin). */
  textureRectOffset: Vector2;
  /** Unity 5.4.6 to 5.4.x, 5.5.3 to 5.5.x, and 5.6 and later. */
  atlasRectOffset?: Vector2;
  /** Packing flags (see {@link SpriteRenderData.settingsRaw}). */
  settingsRaw: number;
  /** Unity 4.5 and later. */
  uvTransform?: Vector4;
  /** Unity 2017.1 and later. */
  downscaleMultiplier?: number;
}

/** The friendly form of {@link Sprite}. */
export interface SpriteFields extends NamedObjectFields {
  /** Unity: `m_Rect`. The sprite's area in its source texture, from the bottom-left corner. */
  rect: Rectf;
  /** Unity: `m_Offset`. */
  offset: Vector2;
  /** Unity: `m_Border`. Unity 4.5 and later: the 9-slice border, left, bottom, right, top. */
  border?: Vector4;
  /** Unity: `m_PixelsToUnits`. */
  pixelsToUnits: number;
  /** Unity: `m_Pivot`. Unity 5.4.1p3 and later; the centre (0.5, 0.5) before. */
  pivot?: Vector2;
  /** Unity: `m_Extrude`. */
  extrude: number;
  /** Unity: `m_IsPolygon`. Unity 5.3 to 6000.4. */
  isPolygon?: boolean;
  /**
   * Unity: `m_RenderDataKey`. Unity 2017.1 and later: the key of the sprite's
   * render data in its atlas' `renderDataMap`.
   */
  renderDataKey?: [GUID, bigint];
  /** Unity: `m_AtlasTags`. Unity 2017.1 and later. */
  atlasTags?: string[];
  /** Unity: `m_SpriteAtlas`. Unity 2017.1 and later: a null pointer when not packed. */
  spriteAtlas?: PPtr;
  /** Unity: `m_RD`. */
  renderData: SpriteRenderDataFields;
  /** Unity: `m_PhysicsShape`. Unity 2017.1 and later: one outline per shape, in units. */
  physicsShape?: Vector2[][];
  /** Unity: `m_Bones`. Unity 2018.1 and later. */
  bones?: SpriteBone[];
  /** Unity: `m_ScriptableObjects`. Unity 2023.1 and later. */
  scriptableObjects?: PPtr[];
}

/**
 * A `Sprite` as {@link SpriteFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toSpriteFields(data: Sprite): SpriteFields {
  return defined({
    ...namedObject(data),
    rect: data.m_Rect,
    offset: data.m_Offset,
    border: data.m_Border,
    pixelsToUnits: data.m_PixelsToUnits,
    pivot: data.m_Pivot,
    extrude: data.m_Extrude,
    isPolygon: data.m_IsPolygon,
    renderDataKey: data.m_RenderDataKey,
    atlasTags: data.m_AtlasTags,
    spriteAtlas: data.m_SpriteAtlas,
    renderData: spriteRenderData(data.m_RD),
    physicsShape: data.m_PhysicsShape,
    bones: data.m_Bones,
    scriptableObjects: data.m_ScriptableObjects,
  });
}

// ---------------------------------------------------------------------------
// SpriteAtlas

/** The friendly form of {@link SpriteAtlas}. */
export interface SpriteAtlasFields extends NamedObjectFields {
  /** Unity: `m_PackedSprites`. */
  packedSprites: PPtr[];
  /** Unity: `m_PackedSpriteNamesToIndex`. The names of `packedSprites`, in the same order. */
  packedSpriteNamesToIndex: string[];
  /**
   * Unity: `m_RenderDataMap`. A packed sprite's `renderDataKey` to where it
   * sits in the atlas.
   */
  renderDataMap: [[GUID, bigint], SpriteAtlasData][];
  /** Unity: `m_Tag`. */
  tag: string;
  /** Unity: `m_IsVariant`. */
  isVariant: boolean;
  /** Unity: `m_Guid`. Unity 6000.5 and later. */
  guid?: GUID;
}

/**
 * A `SpriteAtlas` as {@link SpriteAtlasFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toSpriteAtlasFields(data: SpriteAtlas): SpriteAtlasFields {
  return defined({
    ...namedObject(data),
    packedSprites: data.m_PackedSprites,
    packedSpriteNamesToIndex: data.m_PackedSpriteNamesToIndex,
    renderDataMap: data.m_RenderDataMap,
    tag: data.m_Tag,
    isVariant: data.m_IsVariant,
    guid: data.m_Guid,
  });
}

// ---------------------------------------------------------------------------
// AudioClip, VideoClip

/** The friendly form of {@link StreamedResource}: a byte range of a resource file. */
export interface StreamedResourceFields {
  /** Unity: `m_Source`. The resource file; `""` when there is none. */
  source: string;
  /** Unity: `m_Offset`. */
  offset: number;
  /** Unity: `m_Size`. */
  size: number;
}

/** The friendly form of {@link AudioClipData}. */
export interface AudioClipFields extends NamedObjectFields {
  /** Unity: `m_Format`. Before Unity 5.0. */
  format?: number;
  /** Unity: `m_Type`. Before Unity 5.0: an FMOD sound type. */
  type?: number;
  /** Unity: `m_3D`. Before Unity 5.0. */
  is3D?: boolean;
  /** Unity: `m_UseHardware`. Before Unity 5.0. */
  useHardware?: boolean;
  /** Unity: `m_Stream`. Before Unity 5.0. */
  stream?: number;
  /** Unity: `m_Size`. Before Unity 5.0, streamed only: the sound's byte count. */
  size?: number;
  /** Unity: `m_Offset`. Before Unity 5.0, streamed only: where it starts in the `.resS`. */
  offset?: number;
  /** Unity: `m_LoadType`. Unity 5.0 and later. */
  loadType?: number;
  /** Unity: `m_Channels`. Unity 5.0 and later. */
  channels?: number;
  /** Unity: `m_Frequency`. Unity 5.0 and later. */
  frequency?: number;
  /** Unity: `m_BitsPerSample`. Unity 5.0 and later. */
  bitsPerSample?: number;
  /** Unity: `m_Length`. Unity 5.0 and later: seconds. */
  length?: number;
  /** Unity: `m_IsTrackerFormat`. Unity 5.0 and later. */
  isTrackerFormat?: boolean;
  /** Unity: `m_Ambisonic`. Unity 2017.1 and later. */
  ambisonic?: boolean;
  /** Unity: `m_SubsoundIndex`. Unity 5.0 and later. */
  subsoundIndex?: number;
  /** Unity: `m_PreloadAudioData`. Unity 5.0 and later. */
  preloadAudioData?: boolean;
  /** Unity: `m_LoadInBackground`. Unity 5.0 and later. */
  loadInBackground?: boolean;
  /** Unity: `m_Legacy3D`. Unity 5.0 and later. */
  legacy3D?: boolean;
  /** Unity: `m_Resource`. Unity 5.0 and later: where the sound is. */
  resource?: StreamedResourceFields;
  /**
   * Unity: `m_CompressionFormat`. Unity 5.0 and later: upstream's
   * `AudioCompressionFormat` (0 PCM, 1 Vorbis, ...).
   */
  compressionFormat?: number;
  /**
   * The sound, still encoded (usually FSB5), wherever it was stored; before
   * Unity 5.0 it is Unity's inline `m_AudioData` when there is one (see
   * {@link AudioClipData.audioData}). A view, never a copy (R7).
   */
  audioData: Uint8Array;
}

/**
 * An `AudioClip` as {@link AudioClipFields}. Unity's pre-5.0 inline
 * `m_AudioData` is not carried over on its own: `audioData` is it then.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toAudioClipFields(data: AudioClipData): AudioClipFields {
  return defined({
    ...namedObject(data),
    format: data.m_Format,
    type: data.m_Type,
    is3D: data.m_3D,
    useHardware: data.m_UseHardware,
    stream: data.m_Stream,
    size: data.m_Size,
    offset: data.m_Offset,
    loadType: data.m_LoadType,
    channels: data.m_Channels,
    frequency: data.m_Frequency,
    bitsPerSample: data.m_BitsPerSample,
    length: data.m_Length,
    isTrackerFormat: data.m_IsTrackerFormat,
    ambisonic: data.m_Ambisonic,
    subsoundIndex: data.m_SubsoundIndex,
    preloadAudioData: data.m_PreloadAudioData,
    loadInBackground: data.m_LoadInBackground,
    legacy3D: data.m_Legacy3D,
    resource: data.m_Resource && streamedResource(data.m_Resource),
    compressionFormat: data.m_CompressionFormat,
    audioData: data.audioData,
  });
}

/** The friendly form of {@link VideoClipData}. */
export interface VideoClipFields extends NamedObjectFields {
  /** Unity: `m_OriginalPath`. The asset's path in the editor project. */
  originalPath: string;
  /** Unity: `m_ProxyWidth`. */
  proxyWidth: number;
  /** Unity: `m_ProxyHeight`. */
  proxyHeight: number;
  /** Unity: `Width`. */
  width: number;
  /** Unity: `Height`. */
  height: number;
  /** Unity: `m_PixelAspecRatioNum` (sic). Unity 2017.2 and later. */
  pixelAspectRatioNum?: number;
  /** Unity: `m_PixelAspecRatioDen` (sic). Unity 2017.2 and later. */
  pixelAspectRatioDen?: number;
  /** Unity: `m_FrameRate`. */
  frameRate: number;
  /** Unity: `m_FrameCount`, a `UInt64` (D9). */
  frameCount: bigint;
  /** Unity: `m_Format`. */
  format: number;
  /** Unity: `m_AudioChannelCount`. One per audio track. */
  audioChannelCount: number[];
  /** Unity: `m_AudioSampleRate`. One per audio track. */
  audioSampleRate: number[];
  /** Unity: `m_AudioLanguage`. One per audio track. */
  audioLanguage: string[];
  /** Unity: `m_VideoShaders`. Unity 2020.1 and later. */
  videoShaders?: PPtr[];
  /** Unity: `m_ExternalResources`. Where the video is. */
  externalResources: StreamedResourceFields;
  /** Unity: `m_HasSplitAlpha`. */
  hasSplitAlpha: boolean;
  /** Unity: `m_sRGB`. Unity 2019.2 and later. */
  sRGB?: boolean;
  /**
   * The video, still encoded (the imported file, or the editor's transcode;
   * see {@link VideoClipData.videoData}). A view, never a copy (R7).
   */
  videoData: Uint8Array;
}

/**
 * A `VideoClip` as {@link VideoClipFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toVideoClipFields(data: VideoClipData): VideoClipFields {
  return defined({
    ...namedObject(data),
    originalPath: data.m_OriginalPath,
    proxyWidth: data.m_ProxyWidth,
    proxyHeight: data.m_ProxyHeight,
    width: data.Width,
    height: data.Height,
    pixelAspectRatioNum: data.m_PixelAspecRatioNum,
    pixelAspectRatioDen: data.m_PixelAspecRatioDen,
    frameRate: data.m_FrameRate,
    frameCount: data.m_FrameCount,
    format: data.m_Format,
    audioChannelCount: data.m_AudioChannelCount,
    audioSampleRate: data.m_AudioSampleRate,
    audioLanguage: data.m_AudioLanguage,
    videoShaders: data.m_VideoShaders,
    externalResources: streamedResource(data.m_ExternalResources),
    hasSplitAlpha: data.m_HasSplitAlpha,
    sRGB: data.m_sRGB,
    videoData: data.videoData,
  });
}

// ---------------------------------------------------------------------------
// Font, MovieTexture

/** The friendly form of {@link Font}. */
export interface FontFields extends NamedObjectFields {
  /** Unity: `m_AsciiStartOffset`. */
  asciiStartOffset: number;
  /** Unity: `m_FontCountX`. Unity 3.4 to 3.5. */
  fontCountX?: number;
  /** Unity: `m_FontCountY`. Unity 3.4 to 3.5. */
  fontCountY?: number;
  /** Unity: `m_Kerning`. Before Unity 5.3; renamed `tracking` there. */
  kerning?: number;
  /** Unity: `m_Tracking`. Unity 5.3 and later. */
  tracking?: number;
  /** Unity: `m_LineSpacing`. */
  lineSpacing: number;
  /** Unity: `m_PerCharacterKerning`. Unity 3.4 to 3.5: `[character, kerning]`. */
  perCharacterKerning?: [number, number][];
  /** Unity: `m_CharacterSpacing`. Unity 4.0 and later. */
  characterSpacing?: number;
  /** Unity: `m_CharacterPadding`. Unity 4.0 and later. */
  characterPadding?: number;
  /** Unity: `m_ConvertCase`. */
  convertCase: number;
  /** Unity: `m_DefaultMaterial`. */
  defaultMaterial: PPtr;
  /** Unity: `m_CharacterRects`. */
  characterRects: CharacterInfo[];
  /** Unity: `m_Texture`. */
  texture: PPtr;
  /** Unity: `m_KerningValues`. `[[first character, second character], kerning]`. */
  kerningValues: [[number, number], number][];
  /** Unity: `m_GridFont`. Unity 3.4 to 3.5. */
  gridFont?: boolean;
  /** Unity: `m_PixelScale`. Unity 4.0 and later. */
  pixelScale?: number;
  /** Unity: `m_FontData`. The TrueType / OpenType file, a view into the object's bytes (R7). */
  fontData: Uint8Array;
  /** Unity: `m_FontSize`. */
  fontSize: number;
  /** Unity: `m_Ascent`. */
  ascent: number;
  /** Unity: `m_Descent`. Unity 5.4 and later. */
  descent?: number;
  /** Unity: `m_DefaultStyle`. */
  defaultStyle: number;
  /** Unity: `m_FontNames`. */
  fontNames: string[];
  /** Unity: `m_FallbackFonts`. Unity 4.0 and later. */
  fallbackFonts?: PPtr[];
  /** Unity: `m_FontRenderingMode`. Unity 4.0 and later. */
  fontRenderingMode?: number;
  /** Unity: `m_UseLegacyBoundsCalculation`. Some releases of 5.6 to 2017.3, and 2018.1+. */
  useLegacyBoundsCalculation?: boolean;
  /** Unity: `m_ShouldRoundAdvanceValue`. Unity 2018.1 and later. */
  shouldRoundAdvanceValue?: boolean;
}

/**
 * A `Font` as {@link FontFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toFontFields(data: Font): FontFields {
  return defined({
    ...namedObject(data),
    asciiStartOffset: data.m_AsciiStartOffset,
    fontCountX: data.m_FontCountX,
    fontCountY: data.m_FontCountY,
    kerning: data.m_Kerning,
    tracking: data.m_Tracking,
    lineSpacing: data.m_LineSpacing,
    perCharacterKerning: data.m_PerCharacterKerning,
    characterSpacing: data.m_CharacterSpacing,
    characterPadding: data.m_CharacterPadding,
    convertCase: data.m_ConvertCase,
    defaultMaterial: data.m_DefaultMaterial,
    characterRects: data.m_CharacterRects,
    texture: data.m_Texture,
    kerningValues: data.m_KerningValues,
    gridFont: data.m_GridFont,
    pixelScale: data.m_PixelScale,
    fontData: data.m_FontData,
    fontSize: data.m_FontSize,
    ascent: data.m_Ascent,
    descent: data.m_Descent,
    defaultStyle: data.m_DefaultStyle,
    fontNames: data.m_FontNames,
    fallbackFonts: data.m_FallbackFonts,
    fontRenderingMode: data.m_FontRenderingMode,
    useLegacyBoundsCalculation: data.m_UseLegacyBoundsCalculation,
    shouldRoundAdvanceValue: data.m_ShouldRoundAdvanceValue,
  });
}

/** The friendly form of {@link MovieTexture}. */
export interface MovieTextureFields extends TextureFields {
  /** Unity: `m_Loop`. Before Unity 2019.3. */
  loop?: boolean;
  /** Unity: `m_AudioClip`. Before Unity 2019.3: the clip that plays with the movie. */
  audioClip?: PPtr;
  /** Unity: `m_MovieData`. Before Unity 2019.3: the Ogg Theora file, a view (R7). */
  movieData?: Uint8Array;
  /** Unity: `m_ColorSpace`. Unity 3.5 to 2019.2. */
  colorSpace?: number;
}

/**
 * A `MovieTexture` as {@link MovieTextureFields}.
 *
 * @param data what `obj.read()` returns for the object
 */
export function toMovieTextureFields(data: MovieTexture): MovieTextureFields {
  return defined({
    ...texture(data),
    loop: data.m_Loop,
    audioClip: data.m_AudioClip,
    movieData: data.m_MovieData,
    colorSpace: data.m_ColorSpace,
  });
}

// ---------------------------------------------------------------------------
// Helpers

/** Drop the keys whose value is `undefined`: a field a version does not have is absent. */
function defined<T extends object>(fields: T): T {
  for (const key of Object.keys(fields) as (keyof T)[]) {
    if (fields[key] === undefined) delete fields[key];
  }
  return fields;
}

function editorExtension(data: EditorExtension): EditorExtensionFields {
  return {
    objectHideFlags: data.m_ObjectHideFlags,
    extensionPtr: data.m_ExtensionPtr,
    prefabParentObject: data.m_PrefabParentObject,
    correspondingSourceObject: data.m_CorrespondingSourceObject,
    prefabInternal: data.m_PrefabInternal,
    prefabInstance: data.m_PrefabInstance,
    prefabAsset: data.m_PrefabAsset,
  };
}

function namedObject(data: NamedObject): NamedObjectFields {
  return defined({ ...editorExtension(data), name: data.m_Name });
}

function texture(data: Texture): TextureFields {
  return defined({
    ...namedObject(data),
    forcedFallbackFormat: data.m_ForcedFallbackFormat as TextureFormat | undefined,
    downscaleFallback: data.m_DownscaleFallback,
    isAlphaChannelOptional: data.m_IsAlphaChannelOptional,
  });
}

function textureSettings(settings: GLTextureSettings): GLTextureSettingsFields {
  return defined({
    filterMode: settings.m_FilterMode,
    aniso: settings.m_Aniso,
    mipBias: settings.m_MipBias,
    wrapMode: settings.m_WrapMode,
    wrapU: settings.m_WrapU,
    wrapV: settings.m_WrapV,
    wrapW: settings.m_WrapW,
  });
}

function streamedResource(resource: StreamedResource): StreamedResourceFields {
  return { source: resource.m_Source, offset: resource.m_Offset, size: resource.m_Size };
}

function aabb(box: AABB): AABBFields {
  return { center: box.m_Center, extent: box.m_Extent };
}

function subMesh(mesh: SubMesh): SubMeshFields {
  return { ...mesh, localAABB: aabb(mesh.localAABB) };
}

function vertexData(data: VertexData): VertexDataFields {
  return defined({
    currentChannels: data.m_CurrentChannels,
    vertexCount: data.m_VertexCount,
    channels: data.m_Channels,
    data: data.m_DataSize,
  });
}

function spriteRenderData(rd: SpriteRenderData): SpriteRenderDataFields {
  return defined({
    texture: rd.texture,
    alphaTexture: rd.alphaTexture,
    secondaryTextures: rd.secondaryTextures,
    subMeshes: rd.m_SubMeshes?.map(subMesh),
    indexBuffer: rd.m_IndexBuffer,
    vertexData: rd.m_VertexData && vertexData(rd.m_VertexData),
    vertices: rd.vertices,
    indices: rd.indices,
    bindpose: rd.m_Bindpose,
    sourceSkin: rd.m_SourceSkin,
    blendShapes: rd.m_BlendShapes,
    textureRect: rd.textureRect,
    textureRectOffset: rd.textureRectOffset,
    atlasRectOffset: rd.atlasRectOffset,
    settingsRaw: rd.settingsRaw,
    uvTransform: rd.uvTransform,
    downscaleMultiplier: rd.downscaleMultiplier,
  });
}
