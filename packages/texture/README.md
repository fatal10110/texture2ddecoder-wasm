# unity-asset-reader-texture

Decodes Unity `Texture2D` and `Sprite` objects read by
[`unity-asset-reader`](https://github.com/fatal10110/texture2ddecoder-wasm/blob/main/packages/core/README.md)
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

```ts
import { load, ClassID, type ObjectReader } from "unity-asset-reader";
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

In a browser, put the pixels on a canvas:

```js
const image = new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height);
canvas.getContext("2d").putImageData(image, 0, 0);
```

In Node.js, hand the raw RGBA to the image library of your choice. For example, with
[`sharp`](https://www.npmjs.com/package/sharp):
`sharp(data, { raw: { width, height, channels: 4 } }).png().toFile("out.png")`. This package does
not encode images itself.

### Where the WASM files come from

`initTexture()` loads `texture2ddecoder.js` and `texture2ddecoder.wasm`. Call it once and wait
for it before the first decode. Every format needs it, the plain ones too.

- **Node.js:** `await initTexture()`. The files are found inside the installed package.
- **Browser, self-hosted:** copy the files into your static folder, then pass their URL:

  ```bash
  npx texture2ddecoder-copy-wasm public/wasm
  ```

  ```js
  await initTexture({ wasmPath: new URL("/wasm/", location.href).href });
  ```

  Pass an absolute URL. In the Vite dev server, a root-relative `"/wasm"` fails to load.
  In a Worker, use `self.location.href` in place of `location.href`.
- **Browser, CDN:**
  `await initTexture({ wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1/wasm" })`.

**In a Web Worker**, `texture2ddecoder-wasm` 1.2.3 or later is needed. 1.2.2 refuses to
initialize in a Worker ([#149](https://github.com/fatal10110/texture2ddecoder-wasm/issues/149)).
This package depends on `^1.2.3`; a CDN `wasmPath` should point at 1.2.3 or later too.

The [Bundler Guide](https://github.com/fatal10110/texture2ddecoder-wasm/blob/main/BUNDLER_GUIDE.md)
has the setup for Vite, Next.js and CDN pages. **Next.js cannot bundle the WASM loader yet**
([#171](https://github.com/fatal10110/texture2ddecoder-wasm/issues/171)); the guide shows how to
keep it out of the Next.js bundle.

### Sprites

`decodeSprite(obj, env, options?)` takes the Sprite's `ObjectReader` and the `env` that loaded it,
because its pixels are in another object. It finds the texture through the Sprite's pointers,
through its `SpriteAtlas` when that atlas is loaded. It cuts the sprite's rectangle out, and it
undoes the packer's flip or rotation. So pass the bundles holding the texture and the atlas to
the same `load()`.

With `{ tightMesh: true }`, pixels outside a tight-packed sprite's mesh become transparent, as
AssetStudio does. The default returns the whole rectangle.

## Texture formats

`decodeTexture2D` decodes the first mip level. Every format below is checked against pixels from
UnityPy (the test oracle) or, where UnityPy cannot decode it, against AssetStudio's decoder.
"Editor-built" means the test texture was made by the Unity editor. "Synthetic" means it was
generated block data; no current editor writes those formats.

| Group | Formats | Decoded by | Tested on |
|---|---|---|---|
| Plain | `Alpha8`, `ARGB4444`, `RGB24`, `RGBA32`, `ARGB32`, `RGB565`, `R16`, `RGBA4444`, `BGRA32`, `RHalf`, `RGHalf`, `RGBAHalf`, `RFloat`, `RGFloat`, `RGBAFloat`, `RGB9e5Float`, `YUY2` | TypeScript | editor-built, all 17 |
| BCn | `DXT1`, `DXT5`, `BC4`, `BC5`, `BC6H`, `BC7` | WASM | editor-built |
| ETC / EAC | `ETC_RGB4`, `ETC2_RGB`, `ETC2_RGBA1`, `ETC2_RGBA8`, `EAC_R`, `EAC_RG` | WASM | editor-built |
| | `EAC_R_SIGNED`, `EAC_RG_SIGNED` | WASM | synthetic |
| | `ETC_RGB4_3DS`, `ETC_RGBA8_3DS` | WASM (same decoder as `ETC_RGB4` / `ETC2_RGBA8`) | not separately |
| PVRTC | `PVRTC_RGB2`, `PVRTC_RGBA2`, `PVRTC_RGB4`, `PVRTC_RGBA4` | WASM | editor-built (2019.4) |
| ASTC | `ASTC_RGB_4x4` to `ASTC_RGB_12x12` (Unity's `ASTC_4x4` ...), `ASTC_HDR_4x4`, `ASTC_HDR_12x12` | WASM | editor-built |
| | `ASTC_RGBA_4x4` to `ASTC_RGBA_12x12`, `ASTC_HDR_5x5` to `ASTC_HDR_10x10` | WASM (same decoder) | not separately |
| ATC | `ATC_RGB4`, `ATC_RGBA8` | WASM | synthetic |
| Crunch | `DXT1Crunched`, `DXT5Crunched`, `ETC_RGB4Crunched`, `ETC2_RGBA8Crunched` | WASM | editor-built (Unity's crunch, 2017.3+) |

Details worth knowing:

- Output is 8 bits per channel. Half and float channels are scaled by 255 and clamped, so HDR
  values saturate.
- Channels a format lacks are 0 (color) or 255 (alpha); `Alpha8` is white with that alpha.
- `DXT1Crunched` / `DXT5Crunched` from before Unity 2017.3 use the original crunch format. It is
  unpacked too, and checked against AssetStudio's decoder only.
- `DXT5` color is decoded in 4-color mode, as the S3TC spec says. On blocks with `c0 <= c1` that differs from AssetStudio
  ([#137](https://github.com/fatal10110/texture2ddecoder-wasm/issues/137)).

### Platforms

- **Switch:** swizzled textures are deswizzled first (as UnityPy does; AssetStudio has no Switch
  support). Formats with no known Switch layout, such as Crunch, ETC, PVRTC and ASTC HDR, are
  refused.
- **Xbox 360:** the byte order of `ARGB4444`, `RGB565`, `DXT1` and `DXT5` is swapped back.
- **PS4, PS5:** refused. Their textures can be tiled, and no reference implementation detiles them
  yet.

## Not supported

Each of these throws `UnsupportedError`, whose `kind` and `found` say what was refused:

- Formats: `DXT3`, `ARGBFloat`, `RGBFloat`, `BGR24`, `R8`, `RG16`, `RG32`, `RGB48`, `RGBA64`.
  `YUY2` of odd width. (A swizzled Switch texture stores `BGR24` as `BGRA32`; that one decodes.)
- Textures built for PS4 or PS5.
- Sprites with an alpha texture (ETC1 split alpha), and sprites of a variant atlas (a
  `downscaleMultiplier` other than 1).

Not provided at all: mip levels other than the first; the `Cubemap`, `Texture2DArray` and
`Texture3D` classes; image encoding (PNG, JPEG).

`Rotate90`-packed sprites are turned the way AssetStudio turns them, which no test bundle has
confirmed against Unity's packer yet
([#160](https://github.com/fatal10110/texture2ddecoder-wasm/issues/160)).

## Requirements

- **Browsers:** WebAssembly and ES2020. No COOP/COEP headers, no `SharedArrayBuffer`.
- **Node.js:** 20.19+ or 22.12+, for both `import` and `require`. `initTexture()` loads
  `texture2ddecoder-wasm`'s ES-module glue code, which older Node.js versions refuse
  ([#172](https://github.com/fatal10110/texture2ddecoder-wasm/issues/172)). Node.js 22 prints a
  `MODULE_TYPELESS_PACKAGE_JSON` warning while loading it. The warning is harmless.

## API reference

Every export. Each one has full JSDoc (parameters, return values, what it throws) in the bundled
`index.d.ts`.

| Export | What |
|---|---|
| `initTexture(options?)` | Load the WASM decoder. Call it once, and await it, before decoding |
| `InitTextureOptions` | `{ wasmPath?, locateFile? }`, passed to `texture2ddecoder-wasm`'s `initialize` |
| `decodeTexture2D(texture)` | A `Texture2D`, as `obj.read()` returns it, to RGBA, top row first |
| `decodeSprite(obj, env, options?)` | A `Sprite` to RGBA, top row first, cut out of its texture or atlas |
| `DecodeSpriteOptions` | `{ tightMesh? }` |
| `convertPlain(data, width, height, format)` | One plain-format image to RGBA, rows **as stored** (bottom row first). No console layouts undone. `decodeTexture2D` is usually what you want |
| `RgbaImage` | `{ data, width, height }`: 4 bytes per pixel, R G B A |

## License

`MIT AND Apache-2.0`. The package is MIT, except the sprite tight-mesh fill in `decodeSprite`. That
fill is derived from [ImageSharp.Drawing](https://github.com/SixLabors/ImageSharp.Drawing) and is
under the Apache License 2.0. See
[`NOTICE`](https://github.com/fatal10110/texture2ddecoder-wasm/blob/main/packages/texture/NOTICE)
and
[`LICENSE-APACHE`](https://github.com/fatal10110/texture2ddecoder-wasm/blob/main/packages/texture/LICENSE-APACHE).
The texture conversion is ported from AssetStudio and UnityPy (MIT).
