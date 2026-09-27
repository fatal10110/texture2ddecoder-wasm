// Ported from AssetStudio/CommonString.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from UnityPy/helpers/Tpk.py (MIT, © K0lb3)

/**
 * Unity's built-in string buffer, which type tree blobs index into instead of
 * their own buffer when an offset has the high bit set. Keyed by offset: the
 * strings are laid end to end, each followed by a NUL.
 *
 * AssetStudio's table ends at `Hash128`. The entries after it were added by
 * newer editors (2022.3 and Unity 6) and come from UnityPy's TPK common
 * strings, the golden oracle, so a node that references one of them gets the
 * name UnityPy gives it. Like UnityPy the table is not gated on the editor
 * version: a file only references offsets its own editor wrote, and offsets
 * never move. The one rename, 1209 `LoadableReference` in UnityPy's 6000.5a8
 * snapshot, reads as the later `LoadableObjectId`, as it does in UnityPy.
 */
const COMMON_STRINGS: ReadonlyMap<number, string> = new Map([
  [0, "AABB"],
  [5, "AnimationClip"],
  [19, "AnimationCurve"],
  [34, "AnimationState"],
  [49, "Array"],
  [55, "Base"],
  [60, "BitField"],
  [69, "bitset"],
  [76, "bool"],
  [81, "char"],
  [86, "ColorRGBA"],
  [96, "Component"],
  [106, "data"],
  [111, "deque"],
  [117, "double"],
  [124, "dynamic_array"],
  [138, "FastPropertyName"],
  [155, "first"],
  [161, "float"],
  [167, "Font"],
  [172, "GameObject"],
  [183, "Generic Mono"],
  [196, "GradientNEW"],
  [208, "GUID"],
  [213, "GUIStyle"],
  [222, "int"],
  [226, "list"],
  [231, "long long"],
  [241, "map"],
  [245, "Matrix4x4f"],
  [256, "MdFour"],
  [263, "MonoBehaviour"],
  [277, "MonoScript"],
  [288, "m_ByteSize"],
  [299, "m_Curve"],
  [307, "m_EditorClassIdentifier"],
  [331, "m_EditorHideFlags"],
  [349, "m_Enabled"],
  [359, "m_ExtensionPtr"],
  [374, "m_GameObject"],
  [387, "m_Index"],
  [395, "m_IsArray"],
  [405, "m_IsStatic"],
  [416, "m_MetaFlag"],
  [427, "m_Name"],
  [434, "m_ObjectHideFlags"],
  [452, "m_PrefabInternal"],
  [469, "m_PrefabParentObject"],
  [490, "m_Script"],
  [499, "m_StaticEditorFlags"],
  [519, "m_Type"],
  [526, "m_Version"],
  [536, "Object"],
  [543, "pair"],
  [548, "PPtr<Component>"],
  [564, "PPtr<GameObject>"],
  [581, "PPtr<Material>"],
  [596, "PPtr<MonoBehaviour>"],
  [616, "PPtr<MonoScript>"],
  [633, "PPtr<Object>"],
  [646, "PPtr<Prefab>"],
  [659, "PPtr<Sprite>"],
  [672, "PPtr<TextAsset>"],
  [688, "PPtr<Texture>"],
  [702, "PPtr<Texture2D>"],
  [718, "PPtr<Transform>"],
  [734, "Prefab"],
  [741, "Quaternionf"],
  [753, "Rectf"],
  [759, "RectInt"],
  [767, "RectOffset"],
  [778, "second"],
  [785, "set"],
  [789, "short"],
  [795, "size"],
  [800, "SInt16"],
  [807, "SInt32"],
  [814, "SInt64"],
  [821, "SInt8"],
  [827, "staticvector"],
  [840, "string"],
  [847, "TextAsset"],
  [857, "TextMesh"],
  [866, "Texture"],
  [874, "Texture2D"],
  [884, "Transform"],
  [894, "TypelessData"],
  [907, "UInt16"],
  [914, "UInt32"],
  [921, "UInt64"],
  [928, "UInt8"],
  [934, "unsigned int"],
  [947, "unsigned long long"],
  [966, "unsigned short"],
  [981, "vector"],
  [988, "Vector2f"],
  [997, "Vector3f"],
  [1006, "Vector4f"],
  [1015, "m_ScriptingClassIdentifier"],
  [1042, "Gradient"],
  [1051, "Type*"],
  [1057, "int2_storage"],
  [1070, "int3_storage"],
  [1083, "BoundsInt"],
  [1093, "m_CorrespondingSourceObject"],
  [1121, "m_PrefabInstance"],
  [1138, "m_PrefabAsset"],
  [1152, "FileSize"],
  [1161, "Hash128"],
  // Not in AssetStudio: newer editors, as UnityPy 1.25.3 lists them.
  [1169, "RenderingLayerMask"],
  [1188, "fixed_array"],
  [1200, "EntityId"],
  [1209, "LoadableObjectId"],
  [1226, "LoadableSceneId"],
]);

/**
 * Look up a string in Unity's built-in common string buffer.
 *
 * @param offset the offset into the common buffer, high bit already cleared
 * @returns the string, or - like upstream - the offset as decimal text when
 *   the table has no string starting there
 */
export function commonString(offset: number): string {
  return COMMON_STRINGS.get(offset) ?? String(offset);
}
