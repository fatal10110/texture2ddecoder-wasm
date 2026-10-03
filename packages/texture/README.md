# unity-asset-reader-texture

Decodes Unity `Texture2D` and `Sprite` objects read by
[`unity-asset-reader`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/core/README.md)
to RGBA8 pixels. It runs in browsers, Web Workers and Node.js.

- **Plain formats** (RGBA32, RGB565, RHalf, ...) are converted in TypeScript.
- **Block-compressed and Crunch formats** (BC1–BC7, ETC, EAC, PVRTC, ASTC, ATC) are decoded by
  [`texture2ddecoder-wasm`](https://www.npmjs.com/package/texture2ddecoder-wasm), a
  small single-threaded WASM module (about 150 KB). It needs no special headers (COOP/COEP).
- **Output is always RGBA, top row first:** `{ data, width, height }`, ready for `ImageData` or an
  image encoder. Unity stores rows bottom first and the WASM decoders produce BGRA; both are
  undone for you.

## Install

```bash
npm install unity-asset-reader unity-asset-reader-texture
```

`unity-asset-reader` is a peer dependency, so your app has exactly one copy of the parser.
`texture2ddecoder-wasm` is installed with this package.

## Usage

Images are free functions over the assets of `env.assets()`:

```ts
import { load } from "unity-asset-reader";
import { isImage, imageInfo, decodeImage, images } from "unity-asset-reader-texture";

const env = load([{ name: "ui.bundle", data: bundleBytes }]);

for (const asset of env.assets()) {
  if (isImage(asset)) {                     // a Texture2D or Sprite asset
    const info = imageInfo(asset);          // sync metadata, no WASM
    const image = await decodeImage(asset); // info + { rgba, width, height }
  }
}
for await (const image of images(env)) {    // every Texture2D and Sprite, decoded
  console.log(image.kind, image.name, image.width, image.height, image.formatName);
}
```

- **`isImage(asset)`** is a type guard: `true` for a `Texture2D` or `Sprite` asset.
- **`imageInfo(asset)`** describes the image without decoding it: `kind`, `name`, `path`,
  `pathId`, `file`, `width`, `height`, `format` (the `TextureFormat` value), `formatName`
  (`"DXT5"`), `compression` (`"none"`, `"bc"`, `"etc"`, `"etc2"`, `"eac"`, `"pvrtc"`, `"atc"`,
  `"astc"`, `"crunch"`, or `"unknown"` for a format number `TextureFormat` does not name),
  `mipCount`, `readable`, `colorSpace` (`"srgb"` or `"linear"`), `filterMode`, `wrapMode`
  (`{ u, v, w }`), `platform` (the `BuildTarget`), `encodedSize` and `streamed` (the data is in
  a `.resS`). It is synchronous, needs no WASM, and reads no image data, so a `.resS` that is not
  loaded does not stop it. Each field's JSDoc names the Unity field it comes from.
- For a **Sprite**, `width` and `height` are the size of the cut-out image, the encoding fields
  are those of the texture it is cut from, and `info.sprite` adds `rect`, `textureRect`, `pivot`,
  `border`, `pixelsPerUnit`, `packed`, `packingMode` (`"tight"` or `"rectangle"`), `rotation`
  (a `SpritePackingRotation`), `atlas` (the SpriteAtlas' name, when it is packed into one that is
  loaded) and `texture` (the texture's own `imageInfo`). `info.kind === "Sprite"` narrows to it.
- **`decodeImage(asset, options?)`** returns `imageInfo(asset)` plus `rgba`: RGBA8 pixels, top
  row first, `width * height * 4` bytes. A Sprite is cut out of its texture or atlas, as
  `decodeSprite` does.
- **`images(env, { onError })`** decodes every Texture2D and Sprite, in `env.assets()` order. An
  image that fails to decode throws (`onError: "throw"`, the default) or is left out
  (`onError: "skip"`). It gives the event loop a turn between images, so a loop on a page's main
  thread keeps the page responsive.

`decodeImage` and `images` load the WASM decoder on first use. In Node.js that needs nothing. A
browser has to say where the WASM files are: pass `{ wasmPath }` to the first call, or call
`initTexture({ wasmPath })` once before (see "Where the WASM files come from").

In a browser, put the pixels on a canvas:

```js
const { rgba, width, height } = await decodeImage(asset, { wasmPath });
const imageData = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), width, height);
canvas.getContext("2d").putImageData(imageData, 0, 0);
```

In Node.js, hand the raw RGBA to the image library of your choice. For example, with
[`sharp`](https://www.npmjs.com/package/sharp):
`sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile("out.png")`. This package does
not encode images itself.

### The low-level API

`decodeTexture2D`, `decodeSprite` and `initTexture` work on the objects of `env.objects`
directly. They are what `decodeImage` uses, and they do not load the WASM themselves: call
`initTexture()` once, and wait for it, before the first decode.

```ts
import { load, ClassID } from "unity-asset-reader";
import { initTexture, decodeTexture2D, decodeSprite } from "unity-asset-reader-texture";

await initTexture(); // Node.js: no options. Browsers: see "Where the WASM files come from".

const env = load([{ name: "ui.bundle", data: bundleBytes }]);
for (const obj of env.objects) {
  if (obj.type === ClassID.Texture2D) {
    const { data, width, height } = await decodeTexture2D(obj.read()); // RGBA, top row first
  }
  if (obj.type === ClassID.Sprite) {
    const { data, width, height } = await decodeSprite(obj, env); // its rectangle, cut out
  }
}
```

### Where the WASM files come from

`initTexture()` loads `texture2ddecoder.js` and `texture2ddecoder.wasm`. `decodeImage` and
`images` call it on first use with the `wasmPath` they were given; `decodeTexture2D` and
`decodeSprite` need it called, and waited for, before the first decode. Every format needs it,
the plain ones too.

- **Node.js:** nothing to do, or `await initTexture()`. The files are found inside the installed
  package.
- **Browser, self-hosted:** copy the files into your static folder, then pass their URL:

  ```bash
  npx texture2ddecoder-copy-wasm public/wasm
  ```

  ```js
  await initTexture({ wasmPath: "/wasm" });
  ```

  A root-relative path is resolved against the page's or the Worker's location.
- **Browser, CDN:**
  `await initTexture({ wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1/wasm" })`.

**In a Web Worker**, `texture2ddecoder-wasm` 1.2.3 or later is needed. 1.2.2 refuses to
initialize in a Worker ([#149](https://github.com/fatal10110/unity-asset-reader/issues/149)).
This package depends on `^1.2.3`; a CDN `wasmPath` should point at 1.2.3 or later too.

The [Bundler Guide](https://github.com/fatal10110/unity-asset-reader/blob/main/BUNDLER_GUIDE.md)
has the setup for Vite, Next.js and CDN pages. Next.js, and a root-relative `wasmPath` in the
Vite dev server, need `texture2ddecoder-wasm` 1.2.4 or later
([#171](https://github.com/fatal10110/unity-asset-reader/issues/171)).

### Sprites

A sprite's pixels are in another object. `decodeImage` finds it through the Sprite asset's
`env`; `decodeSprite(obj, env, options?)` takes the Sprite's `ObjectReader` and the `env` that
loaded it. Both find the texture through the Sprite's pointers, through its `SpriteAtlas` when
that atlas is loaded. It cuts the sprite's rectangle out, and it
undoes the packer's flip or rotation. So pass the bundles holding the texture and the atlas to
the same `load()`.

With `decodeSprite`'s `{ tightMesh: true }`, pixels outside a tight-packed sprite's mesh become
transparent, as AssetStudio does. The default, and `decodeImage`, return the whole rectangle.

What is supported, and what it is tested on (sprites built by 2019.4.41f2 and 6000.3.25f1):

| Sprite | Support |
|---|---|
| Cut from its own texture, inline or in the `.resS` | Yes, at any rectangle and pivot, with a border |
| Packed into a `SpriteAtlas` (Sprite Atlas V1 fixtures), tight or rectangle packing | Yes, when the atlas is loaded |
| Packer rotation `FlipHorizontal`, `FlipVertical`, `Rotate180` | Undone |
| Packer rotation `Rotate90` | Undone as AssetStudio does; no fixture ([#160](https://github.com/fatal10110/unity-asset-reader/issues/160)) |
| Pixels outside a tight mesh | Transparent with `decodeSprite`'s `{ tightMesh: true }` |
| Alpha texture (ETC1 split alpha), variant atlas (`downscaleMultiplier` other than 1) | Refused |

## Texture formats

`decodeTexture2D` decodes the first mip level. Every format below is checked against pixels from
UnityPy (the test oracle) or, where UnityPy cannot decode it, against AssetStudio's decoder.
"Editor-built" means the test texture was made by the Unity editor. "Synthetic" means it was
generated block data; no current editor writes those formats.

| Group | Formats | Decoded by | Tested on |
|---|---|---|---|
| Plain | `Alpha8`, `ARGB4444`, `RGB24`, `RGBA32`, `ARGB32`, `RGB565`, `R16`, `RGBA4444`, `BGRA32`, `RHalf`, `RGHalf`, `RGBAHalf`, `RFloat`, `RGFloat`, `RGBAFloat`, `RGB9e5Float`, `YUY2` | TypeScript | editor-built (6000.3), all 17 |
| BC | `DXT1` (BC1), `DXT5` (BC3), `BC4`, `BC5`, `BC6H`, `BC7` | WASM `decode_bc1`, `decode_bc3` to `decode_bc7` | editor-built (6000.3) |
| ETC | `ETC_RGB4` (ETC1), `ETC2_RGB`, `ETC2_RGBA1`, `ETC2_RGBA8` | WASM `decode_etc1`, `decode_etc2`, `decode_etc2a1`, `decode_etc2a8` | editor-built (6000.3) |
| | `ETC_RGB4_3DS`, `ETC_RGBA8_3DS` | WASM, the decoder of `ETC_RGB4` / `ETC2_RGBA8` | `ETC_RGB4` / `ETC2_RGBA8` fixture data |
| EAC | `EAC_R`, `EAC_RG` | WASM `decode_eacr`, `decode_eacrg` | editor-built (6000.3) |
| | `EAC_R_SIGNED`, `EAC_RG_SIGNED` | WASM `decode_eacr_signed`, `decode_eacrg_signed` | synthetic |
| PVRTC | `PVRTC_RGB2`, `PVRTC_RGBA2`, `PVRTC_RGB4`, `PVRTC_RGBA4` | WASM `decode_pvrtc` | editor-built (2019.4) |
| ATC | `ATC_RGB4`, `ATC_RGBA8` | WASM `decode_atc_rgb4`, `decode_atc_rgba8` | synthetic |
| ASTC | `ASTC_RGB_4x4`, `ASTC_RGB_5x5`, `ASTC_RGB_6x6`, `ASTC_RGB_8x8`, `ASTC_RGB_10x10`, `ASTC_RGB_12x12` (Unity's `ASTC_4x4` ... `ASTC_12x12`), `ASTC_HDR_4x4`, `ASTC_HDR_12x12` | WASM `decode_astc` | editor-built (6000.3) |
| | `ASTC_RGBA_4x4`, `ASTC_RGBA_5x5`, `ASTC_RGBA_6x6`, `ASTC_RGBA_8x8`, `ASTC_RGBA_10x10`, `ASTC_RGBA_12x12`, `ASTC_HDR_5x5`, `ASTC_HDR_6x6`, `ASTC_HDR_8x8`, `ASTC_HDR_10x10` | WASM `decode_astc` | fixture data of the `ASTC_RGB_*` format of the same block size |
| Crunch | `DXT1Crunched`, `DXT5Crunched`, `ETC_RGB4Crunched`, `ETC2_RGBA8Crunched` | WASM `unpack_unity_crunch` (or `unpack_crunch`, see below), then the block decoder | editor-built (6000.3; Unity's crunch, 2017.3+) |

Every other `TextureFormat` is refused (see [Not supported](#not-supported)).

Details worth knowing:

- Output is 8 bits per channel. Half and float channels are scaled by 255 and clamped, so HDR
  values saturate.
- Channels a format lacks are 0 (color) or 255 (alpha); `Alpha8` is white with that alpha.
- `DXT1Crunched` / `DXT5Crunched` from before Unity 2017.3 use the original crunch format. It is
  unpacked too, and checked against AssetStudio's decoder only.
- `DXT5` color is decoded in 4-color mode, as the S3TC spec says. On blocks with `c0 <= c1` that differs from AssetStudio
  ([#137](https://github.com/fatal10110/unity-asset-reader/issues/137)).

### Platforms

- **Switch:** swizzled textures are deswizzled first (as UnityPy does; AssetStudio has no Switch
  support). Formats with no known Switch layout, such as Crunch, ETC, PVRTC and ASTC HDR, are
  refused.
- **Xbox 360:** the byte order of `ARGB4444`, `RGB565`, `DXT1` and `DXT5` is swapped back.
- **PS4, PS5:** refused. Their textures can be tiled, and no reference implementation detiles them
  yet ([#130](https://github.com/fatal10110/unity-asset-reader/issues/130)).
- **Every other build target** (Windows, macOS, Linux, Android, iOS, WebGL, ...): the image data
  is decoded as stored.

No fixture editor here has the Switch or Xbox 360 module, so those two are tested on generated
data checked against UnityPy, not on real console builds.

## Not supported

Each of these throws `UnsupportedError`, whose `kind` and `found` say what was refused:

- Formats: `DXT3`, `ARGBFloat`, `RGBFloat`, `BGR24`, `R8`, `RG16`, `RG32`, `RGB48`, `RGBA64`.
  `YUY2` of odd width. (A swizzled Switch texture stores `BGR24` as `BGRA32`; that one decodes.)
- Textures built for PS4 or PS5.
- Sprites with an alpha texture (ETC1 split alpha), and sprites of a variant atlas (a
  `downscaleMultiplier` other than 1).
- With `tightMesh`, a sprite mesh whose positions are not 32-bit floats.

Not provided at all: mip levels other than the first; the `Cubemap`, `Texture2DArray` and
`Texture3D` classes; image encoding (PNG, JPEG).

`Rotate90`-packed sprites are turned the way AssetStudio turns them, which no test bundle has
confirmed against Unity's packer yet
([#160](https://github.com/fatal10110/unity-asset-reader/issues/160)).

## Requirements

- **Browsers:** WebAssembly and ES2020. No COOP/COEP headers, no `SharedArrayBuffer`.
- **Node.js:** 20.19+ or 22.12+ (`engines`: `^20.19.0 || >=22.12.0`), for both `import` and
  `require`; CI tests on 20.19.0 and 22.12.0. `initTexture()` loads
  `texture2ddecoder-wasm`'s ES-module glue code, which older Node.js versions refuse
  ([#172](https://github.com/fatal10110/unity-asset-reader/issues/172)). Node.js 22 prints a
  `MODULE_TYPELESS_PACKAGE_JSON` warning while loading it. The warning is harmless.

## API reference

Every export. Each one has full JSDoc (parameters, return values, what it throws) in the bundled
`index.d.ts`.

| Export | What |
|---|---|
| `isImage(asset)` | Type guard: whether an asset is a `Texture2D` or `Sprite` (an `ImageAsset`) |
| `imageInfo(asset)` | An image asset's `ImageInfo`, sync, no WASM, no image data read |
| `decodeImage(asset, options?)` | An image asset decoded: its `ImageInfo` plus `rgba`, top row first. Loads the WASM on first use |
| `images(env, options?)` | Async generator: every `Texture2D` and `Sprite` of `env`, decoded |
| `ImageAsset` | `Asset<"Texture2D" \| "Sprite">` |
| `ImageInfo`, `TextureImageInfo`, `SpriteImageInfo`, `SpriteInfo` | What `imageInfo` returns; `kind` tells the two apart |
| `ImageCompression` | `compression`'s values |
| `DecodedImage` | `ImageInfo & { rgba }` |
| `DecodeImageOptions`, `ImagesOptions` | `{ wasmPath? }`, and `{ wasmPath?, onError? }` |
| `initTexture(options?)` | Load the WASM decoder. Optional before `decodeImage` and `images`; call it once, and await it, before `decodeTexture2D` and `decodeSprite` |
| `InitTextureOptions` | `{ wasmPath?, locateFile? }`, passed to `texture2ddecoder-wasm`'s `initialize` |
| `decodeTexture2D(texture)` | A `Texture2D`, as `obj.read()` returns it, to RGBA, top row first |
| `decodeSprite(obj, env, options?)` | A `Sprite` to RGBA, top row first, cut out of its texture or atlas |
| `DecodeSpriteOptions` | `{ tightMesh? }` |
| `convertPlain(data, width, height, format)` | One plain-format image to RGBA, rows **as stored** (bottom row first). No console layouts undone. `decodeTexture2D` is usually what you want |
| `RgbaImage` | `{ data, width, height }`: 4 bytes per pixel, R G B A |

## Acknowledgements

- [AssetStudio](https://github.com/Razviar/assetstudio) (MIT, © Perfare, RazTools, Razviar): the
  plain texture conversion, the choice of block decoder per format, the Xbox 360 byte swap, the
  vertical flip, and sprite cropping, rotation and the tight-mesh mask are hand-ported from it.
- [UnityPy](https://github.com/K0lb3/UnityPy) (MIT, © K0lb3): generates the test goldens, and is
  the source of the Switch texture deswizzle, which is based in turn on
  [AssetsTools.NET](https://github.com/nesrak1/AssetsTools.NET)'s `SwitchSwizzle.cs` (MIT,
  © nesrak1).
- [ImageSharp.Drawing](https://github.com/SixLabors/ImageSharp.Drawing) (Apache-2.0, © Six Labors):
  the tight-mesh triangle fill is a modified translation of parts of it.
- [`texture2ddecoder-wasm`](https://www.npmjs.com/package/texture2ddecoder-wasm) (MIT): the block
  and Crunch decoding, which is [K0lb3's texture2ddecoder](https://github.com/K0lb3/texture2ddecoder)
  compiled to WASM with [Emscripten](https://github.com/emscripten-core/emscripten).

The full list, and a comparison with similar npm packages, is in the
[repository README](https://github.com/fatal10110/unity-asset-reader/blob/main/README.md#acknowledgements).

## License

`MIT AND Apache-2.0`. The package is MIT, except the sprite tight-mesh fill in `decodeSprite`. That
fill is derived from [ImageSharp.Drawing](https://github.com/SixLabors/ImageSharp.Drawing) and is
under the Apache License 2.0. See
[`NOTICE`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/texture/NOTICE)
and
[`LICENSE-APACHE`](https://github.com/fatal10110/unity-asset-reader/blob/main/packages/texture/LICENSE-APACHE).
The texture conversion is ported from AssetStudio and UnityPy (MIT).
