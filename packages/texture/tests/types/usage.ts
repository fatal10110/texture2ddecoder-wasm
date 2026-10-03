// The #185 usage block, as a function `image.test.ts` runs against the
// fixtures and compiles under the package's strict flags. The type assertions
// compile only while `isImage` narrows and `imageInfo` / `decodeImage` type
// their results by the asset's type; each `@ts-expect-error` fails the compile
// if the line after it stops being an error.

import type { Asset, Env, ObjectReader } from "unity-asset-reader";
import { decodeImage, decodeSprite, imageInfo, images, isImage } from "../../src/index.js";
import type {
  DecodedImage,
  ImageAsset,
  ImageInfo,
  SpriteImageInfo,
  TextureImageInfo,
  RgbaImage,
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
  /** Per image asset of `env.assets()`: the asset, its info and its decode. */
  rows: { asset: ImageAsset; info: ImageInfo; image: DecodedImage }[];
  /** What `images(env)` yielded. */
  all: DecodedImage[];
}

/**
 * The usage block of #185, over `env`.
 *
 * @param env an env holding textures and sprites, all decodable
 */
export async function usage(env: Env): Promise<UsageResult> {
  const rows: UsageResult["rows"] = [];
  for (const asset of env.assets()) {
    if (isImage(asset)) { // type guard: Texture2D | Sprite asset
      expectType<Equal<typeof asset, ImageAsset>>(true);
      const info = imageInfo(asset); // sync metadata, no WASM
      const image = await decodeImage(asset); // info + { rgba, width, height }
      expectType<Equal<typeof info, ImageInfo>>(true);
      expectType<Equal<typeof image.rgba, Uint8Array>>(true);
      rows.push({ asset, info, image });
    } else {
      // Not called: it would throw a TypeError at run time too.
      // @ts-expect-error: not narrowed to an image asset
      void (() => imageInfo(asset));
    }
  }
  const all: DecodedImage[] = [];
  const decodedTextures = new Map<ObjectReader, RgbaImage>();
  for await (const image of images(env, { onError: "throw", decodedTextures })) {
    // every Texture2D and Sprite, decoded
    all.push(image);
  }
  return { rows, all };
}

/** Type-only: the per-type overloads and the `kind` discriminant. */
export function typeChecks(
  texture: Asset<"Texture2D">,
  sprite: Asset<"Sprite">,
  info: ImageInfo,
): void {
  const t = imageInfo(texture);
  expectType<Equal<typeof t, TextureImageInfo>>(true);
  const s = imageInfo(sprite);
  expectType<Equal<typeof s, SpriteImageInfo>>(true);
  expectType<Equal<typeof s.sprite.texture, TextureImageInfo>>(true);
  void decodeImage(sprite).then((image) => {
    expectType<Equal<typeof image, DecodedImage<SpriteImageInfo>>>(true);
  });
  const decodedTextures = new Map<ObjectReader, RgbaImage>();
  void decodeImage(texture, { decodedTextures });
  void decodeSprite(sprite.reader, sprite.env, { decodedTextures, tightMesh: true });
  if (info.kind === "Sprite") {
    expectType<Equal<typeof info, SpriteImageInfo>>(true);
  } else {
    // @ts-expect-error: a Texture2D's info has no `sprite`
    void info.sprite;
  }
  // @ts-expect-error: onError is "throw" or "skip"
  void images({} as Env, { onError: "ignore" });
}
