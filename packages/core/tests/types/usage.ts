// The #183 usage block, with #184's friendly `data` fields, as a function the
// tests run against the fixtures and `types.test.ts` compiles under the
// package's strict flags. The type
// assertions below compile only while `switch (asset.type)` and
// `assets(...types)` narrow; each `@ts-expect-error` fails the compile if the
// line after it stops being an error.

import { load, open, type Asset, type Env, type TypeTreeObject } from "../../src/index.js";
import type {
  AssetBundleFields,
  MonoBehaviourFields,
  PPtr,
  SpriteFields,
  TextAssetFields,
  Texture2DFields,
  TextureFormat,
} from "../../src/index.js";

/** `A` and `B` are the same type. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Compiles only when `T` is `true`. */
function expectType<T extends true>(ok?: T): void {
  void ok;
}

/** What the usage block saw, for the runtime test to check. */
export interface UsageResult {
  env: Env;
  env2: Env;
  env3: Env;
  rows: {
    type: string;
    classId: number;
    name: string;
    path: string | undefined;
    pathId: bigint;
    file: string;
    byteSize: number;
    data: unknown;
  }[];
  filtered: Asset<"Texture2D" | "Sprite">[];
  byPath: Asset | undefined;
}

/**
 * The usage block of #183.
 *
 * @param bytes a bundle
 * @param bundleBytes a bundle whose loose sidecar is `resS`
 * @param resS the sidecar, named as in the issue
 * @param url a bundle to fetch
 * @param path a container path of `bytes`
 */
export async function usage(
  bytes: Uint8Array,
  bundleBytes: Uint8Array,
  resS: Uint8Array,
  url: string,
  path: string,
): Promise<UsageResult> {
  const env = load(bytes); // Uint8Array | ArrayBuffer; name optional
  const env2 = load([bundleBytes, { name: "sharedassets0.assets.resS", data: resS }]);
  // URL | string | Request | Response | Blob/File | bytes | { name, data } | array
  const env3 = await open(url);

  const rows: UsageResult["rows"] = [];
  for (const asset of env.assets()) {
    // every object, whatever its class
    asset.type; // "Texture2D" | "Sprite" | "TextAsset" | ... | "Other"
    asset.classId; // number (ClassID), always present
    asset.name; // m_Name, or "" when the class has none
    asset.path; // container path from the bundle's AssetBundle object, or undefined
    asset.pathId; // bigint
    asset.file; // SerializedFile name
    asset.byteSize;
    asset.data; // parsed on first access, cached; typed by `type`
    switch (asset.type) {
      case "Texture2D":
        expectType<Equal<typeof asset.data, Texture2DFields>>();
        // @ts-expect-error - a Texture2D's data is not a TextAsset
        asset.data satisfies TextAssetFields;
        // #184: friendly names, not m_TextureFormat
        expectType<Equal<typeof asset.data.format, TextureFormat>>();
        expectType<Equal<typeof asset.data.width, number>>();
        expectType<Equal<typeof asset.data.mipCount, number | undefined>>();
        // @ts-expect-error - Unity's names are the low-level reader's
        asset.data.m_TextureFormat;
        break;
      case "TextAsset":
        expectType<Equal<typeof asset.data, TextAssetFields>>();
        expectType<Equal<typeof asset.data.text, string>>();
        expectType<Equal<typeof asset.data.bytes, Uint8Array>>();
        break;
      case "MonoBehaviour":
        expectType<Equal<typeof asset.data, MonoBehaviourFields>>();
        expectType<Equal<typeof asset.data.script, PPtr>>();
        expectType<Equal<typeof asset.data.fields, TypeTreeObject | undefined>>();
        break;
      case "AssetBundle":
        expectType<Equal<typeof asset.data, AssetBundleFields>>();
        break;
      case "Other":
        // TypeTreeObject for classes without a hand reader
        expectType<Equal<typeof asset.data, TypeTreeObject>>();
        break;
      default:
        // @ts-expect-error - narrowed away from "Other" in this branch
        asset.type === "Other";
    }
    expectType<Equal<typeof asset.classId, number>>();
    expectType<Equal<typeof asset.pathId, bigint>>();
    expectType<Equal<typeof asset.path, string | undefined>>();
    rows.push({
      type: asset.type,
      classId: asset.classId,
      name: asset.name,
      path: asset.path,
      pathId: asset.pathId,
      file: asset.file,
      byteSize: asset.byteSize,
      data: asset.data,
    });
  }

  const filtered = [...env.assets("Texture2D", "Sprite")]; // filtered and narrowed
  for (const asset of filtered) {
    expectType<Equal<typeof asset.type, "Texture2D" | "Sprite">>();
    expectType<Equal<typeof asset.data, Texture2DFields | SpriteFields>>();
    // @ts-expect-error - no TextAsset left after the filter
    asset.type === "TextAsset";
  }
  // @ts-expect-error - not an asset type
  env.assets("Texture2d");

  const byPath = env.get(path); // by container path, or undefined
  expectType<Equal<typeof byPath, Asset | undefined>>();

  return { env, env2, env3, rows, filtered, byPath };
}
