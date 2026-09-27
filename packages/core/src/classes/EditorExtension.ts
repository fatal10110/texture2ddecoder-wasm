// Ported from AssetStudio/Classes/EditorExtension.cs (MIT, © Perfare / RazTools / Razviar)

import { UnsupportedError } from "../errors.js";
import { BuildTarget } from "../serialized/BuildTarget.js";
import type { ObjectReader } from "../serialized/ObjectReader.js";
import type { UnityVersion } from "../serialized/SerializedFile.js";
import { readObject, type UnityObject } from "./Object.js";
import { readPPtr, type PPtr } from "./PPtr.js";

/**
 * The fields of an `EditorExtension` (upstream's base of every asset and
 * component): the {@link UnityObject} header plus, in a file built for the
 * editor (`BuildTarget.NoTarget`), the editor's prefab links.
 *
 * A player build stores none of the pointers. An editor file stores the set
 * its Unity version wrote, under Unity's names, so the keys agree with
 * `readTypeTree()` on the same object:
 *
 * | Unity | Pointers |
 * |---|---|
 * | 3.4 | `m_ExtensionPtr` |
 * | 3.5 to 2018.1 | `m_PrefabParentObject`, `m_PrefabInternal` |
 * | 2018.2 | `m_CorrespondingSourceObject`, `m_PrefabInternal` |
 * | 2018.3 and later | `m_CorrespondingSourceObject`, `m_PrefabInstance`, `m_PrefabAsset` |
 */
export interface EditorExtension extends UnityObject {
  /** Editor file, Unity 3.4 only. */
  m_ExtensionPtr?: PPtr;
  /** Editor file, Unity 3.5 to 2018.1. */
  m_PrefabParentObject?: PPtr;
  /** Editor file, Unity 2018.2 and later: `m_PrefabParentObject` renamed. */
  m_CorrespondingSourceObject?: PPtr;
  /** Editor file, Unity 3.5 to 2018.2. */
  m_PrefabInternal?: PPtr;
  /** Editor file, Unity 2018.3 and later. */
  m_PrefabInstance?: PPtr;
  /** Editor file, Unity 2018.3 and later. */
  m_PrefabAsset?: PPtr;
}

/**
 * Read an `EditorExtension` from the object's first byte: the object header,
 * then, in a file built for the editor, the prefab pointers its Unity version
 * wrote (see {@link EditorExtension}).
 *
 * Upstream reads two pointers for every version, which misreads every editor
 * file from 2018.3 on, where Unity writes three. The layouts here come from
 * Unity's own editor type trees as UnityPy's TPK data records them.
 *
 * @param reader the object's reader, rewound first and left just past these
 *   fields
 * @throws {UnsupportedError} of kind `"Unity version"`, with the file's own
 *   `unityVersion` as `found`, for an editor file whose version is unknown
 *   (`[0, 0, 0, 0]`: stripped, or a loose file below format 7) or older than
 *   3.4, where no type tree data says what it holds
 * @throws {CorruptError} when the object is too short for these fields
 */
export function readEditorExtension(reader: ObjectReader): EditorExtension {
  const base = readObject(reader);
  if (reader.platform !== BuildTarget.NoTarget) return base;

  const { version } = reader;
  // Rule for version-gated class readers (#36): an unknown version must not
  // fall through to the oldest branch, so refuse it.
  if (version.every((part) => part === 0)) {
    throw new UnsupportedError(
      "Unity version",
      reader.unityVersion,
      `object ${reader.pathId}: an editor file's prefab pointers depend on the Unity version, ` +
        "and this file does not record one",
    );
  }
  if (atLeast(version, 2018, 3)) {
    return {
      ...base,
      m_CorrespondingSourceObject: readPPtr(reader),
      m_PrefabInstance: readPPtr(reader),
      m_PrefabAsset: readPPtr(reader),
    };
  }
  // 2018.2: m_PrefabParentObject renamed, the prefab rework not in yet.
  if (atLeast(version, 2018, 2)) {
    return {
      ...base,
      m_CorrespondingSourceObject: readPPtr(reader),
      m_PrefabInternal: readPPtr(reader),
    };
  }
  if (atLeast(version, 3, 5)) {
    return { ...base, m_PrefabParentObject: readPPtr(reader), m_PrefabInternal: readPPtr(reader) };
  }
  if (atLeast(version, 3, 4)) return { ...base, m_ExtensionPtr: readPPtr(reader) };
  throw new UnsupportedError(
    "Unity version",
    reader.unityVersion,
    `object ${reader.pathId}: no known layout for an editor file's prefab pointers before 3.4`,
  );
}

/** Whether `version` is `major.minor` or later. */
function atLeast([major, minor]: UnityVersion, wantMajor: number, wantMinor: number): boolean {
  return major > wantMajor || (major === wantMajor && minor >= wantMinor);
}
