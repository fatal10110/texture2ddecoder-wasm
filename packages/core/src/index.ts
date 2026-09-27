// brotliDecompress/lzhamDecompress stay internal: neither is reachable from a
// stock bundle, so two always-throwing symbols are not public API.
export { NodeFlags, readBundle } from "./bundle/BundleFile.js";
export type { BundleFile, BundleHeader, StreamFile } from "./bundle/BundleFile.js";
export { detectContainer, detectFileType } from "./bundle/detect.js";
export type { FileType, SupportedFileType } from "./bundle/detect.js";
export { readWebFile } from "./bundle/WebFile.js";
export type { WebFile } from "./bundle/WebFile.js";
export { gunzip, unzlib } from "./codec/inflate.js";
export { decompressLz4 } from "./codec/lz4.js";
export { lzmaDecompress } from "./codec/lzma.js";
export { load } from "./env.js";
export type { Env, LoadedFile, LoadInput } from "./env.js";
export { CorruptError, ResourceNotFoundError, UnsupportedError } from "./errors.js";
export { BinaryReader, type Endian } from "./io/BinaryReader.js";
export { BuildTarget } from "./serialized/BuildTarget.js";
export { SerializedFileFormatVersion } from "./serialized/FormatVersion.js";
export { readSerializedFile } from "./serialized/SerializedFile.js";
export type {
  FileIdentifier,
  LocalSerializedObjectIdentifier,
  ObjectInfo,
  SerializedFile,
  SerializedFileHeader,
  UnityVersion,
} from "./serialized/SerializedFile.js";
export type { SerializedType, TypeTreeNode } from "./serialized/TypeTree.js";
export { ClassID, classIdName } from "./serialized/ClassID.js";
export { ObjectReader } from "./serialized/ObjectReader.js";
export type { PPtr, PPtrResolution } from "./classes/PPtr.js";
export { readTypeTree } from "./serialized/TypeTreeReader.js";
export type { TypeTreeObject, TypeTreeValue } from "./serialized/TypeTreeReader.js";
export type { Quaternion, Vector3, XForm } from "./serialized/ObjectReader.js";
export { readObject } from "./classes/Object.js";
export type { UnityObject } from "./classes/Object.js";
export { readEditorExtension } from "./classes/EditorExtension.js";
export type { EditorExtension } from "./classes/EditorExtension.js";
export { readNamedObject } from "./classes/NamedObject.js";
export type { NamedObject } from "./classes/NamedObject.js";
export type { ResourceRef } from "./env.js";
export { readTexture } from "./classes/Texture.js";
export type { Texture } from "./classes/Texture.js";
export { readTexture2D } from "./classes/Texture2D.js";
export type { GLTextureSettings, StreamingInfo, Texture2D } from "./classes/Texture2D.js";
export { TextureFormat } from "./classes/TextureFormat.js";
export type { ObjectData, Texture2DData } from "./classes/registry.js";
export { readAssetBundle } from "./classes/AssetBundle.js";
export type { AssetBundle, AssetBundleScriptInfo, AssetInfo } from "./classes/AssetBundle.js";
export { readTextAsset, textAssetString } from "./classes/TextAsset.js";
export type { TextAsset } from "./classes/TextAsset.js";
export { readMonoScript } from "./classes/MonoScript.js";
export type { Hash128, MonoScript } from "./classes/MonoScript.js";
export { readMonoBehaviour } from "./classes/MonoBehaviour.js";
export type { MonoBehaviour } from "./classes/MonoBehaviour.js";
export type { MonoBehaviourData } from "./classes/registry.js";
export { readMaterial } from "./classes/Material.js";
export type {
  BuildTextureStackReference,
  Color,
  Material,
  UnityPropertySheet,
  UnityTexEnv,
  Vector2,
} from "./classes/Material.js";
export { readAudioClip } from "./classes/AudioClip.js";
export type { AudioClip, AudioClipData } from "./classes/AudioClip.js";
export { readFont } from "./classes/Font.js";
export type { CharacterInfo, Font, Rectf } from "./classes/Font.js";
export { readVideoClip } from "./classes/VideoClip.js";
export type { StreamedResource, VideoClip, VideoClipData } from "./classes/VideoClip.js";
export { readMovieTexture } from "./classes/MovieTexture.js";
export type { MovieTexture } from "./classes/MovieTexture.js";
export { readSprite, SpritePackingRotation } from "./classes/Sprite.js";
export type {
  AABB,
  BlendShapeData,
  BlendShapeVertex,
  BoneWeights4,
  ChannelInfo,
  GUID,
  Matrix4x4,
  MeshBlendShape,
  MeshBlendShapeChannel,
  SecondarySpriteTexture,
  Sprite,
  SpriteBone,
  SpriteRenderData,
  SpriteVertex,
  SubMesh,
  Vector4,
  VertexData,
} from "./classes/Sprite.js";
export { readSpriteAtlas } from "./classes/SpriteAtlas.js";
export type { SpriteAtlas, SpriteAtlasData } from "./classes/SpriteAtlas.js";
