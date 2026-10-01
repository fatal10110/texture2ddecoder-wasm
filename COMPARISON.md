# Unity library comparison

Feature and format checklist based on the package documentation collected for the original
README comparison on **2026-09-29**. This is a documentation snapshot, not a compatibility test.

**✓** = documented support. **✗** = unsupported or not documented in the cited sources.
A ✗ does not prove that an undocumented feature is absent.

The **Reader** column includes `unity-asset-reader-texture` and `unity-asset-reader-node`.
The **Decoder** column is `texture2ddecoder-wasm` on its own.
CLI features include those provided by its required AssetStudioMod application.

## Libraries and sources

| Column | Library | Documentation |
|---|---|---|
| Reader | `unity-asset-reader` | [Core](packages/core/README.md), [textures](packages/texture/README.md), [Node.js](packages/node/README.md) |
| Decoder | `texture2ddecoder-wasm` | [Decoder](packages/decoder/README.md) |
| unity-js | `@arkntools/unity-js` | [npm README](https://www.npmjs.com/package/@arkntools/unity-js), [tools README](https://www.npmjs.com/package/@arkntools/unity-js-tools) |
| unityfs-js | `unityfs-js` | [npm README](https://www.npmjs.com/package/unityfs-js) |
| Studio JS | `node-asset-studio-mod-js` | [npm README](https://www.npmjs.com/package/node-asset-studio-mod-js) |
| Studio CLI | `node-asset-studio-mod` | [npm README](https://www.npmjs.com/package/node-asset-studio-mod), [AssetStudioMod](https://github.com/aelurum/AssetStudio) |
| unity-asset | `@tootallnate/unity-asset` | [Changelog](https://github.com/TooTallNate/switch-tools/blob/main/packages/unity-asset/CHANGELOG.md) |
| Studio Web | `@lego-fan9/asset-studio-web` | [npm README](https://www.npmjs.com/package/@lego-fan9/asset-studio-web) |
| decoder.js | `texture2ddecoder.js` | [npm README](https://www.npmjs.com/package/texture2ddecoder.js) |

## Runtime and requirements

| Feature | Reader | Decoder | unity-js | unityfs-js | Studio JS | Studio CLI | unity-asset | Studio Web | decoder.js |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Browser support | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ |
| Node.js support | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Synchronous Unity parsing | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Uses WebAssembly | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ |
| Requires .NET | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| Requires a browser Buffer polyfill | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

Reader parsing uses no WASM; its compressed texture decoder does.

## Containers and compression

| Format | Reader | Decoder | unity-js | unityfs-js | Studio JS | Studio CLI | unity-asset | Studio Web | decoder.js |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| UnityFS | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| UnityWeb | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| UnityRaw | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| WebGL UnityWebData | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| Loose SerializedFiles (.assets) | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Resource sidecars (.resS / .resource) | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| LZ4 / LZ4HC bundles | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| LZMA bundles | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Gzip-wrapped input | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |

## Asset features

| Feature | Reader | Decoder | unity-js | unityfs-js | Studio JS | Studio CLI | unity-asset | Studio Web | decoder.js |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Read objects through type trees | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Hand-written readers for objects without type trees | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| Read TextAsset | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Read MonoBehaviour data through type trees | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Decode Texture2D | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Extract Sprite images | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Merge separate sprite alpha textures | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Encode PNG images | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Decode audio to WAV / OGG / MP3 | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Export meshes or models | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Export Live2D | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Export Spine | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Export shader inspection text | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Edit assets and repack bundles | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Decode raw compressed texture blocks | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |

Reader exposes raw audio, video and font bytes; it does not decode audio or video.
Reading a Mesh through its type tree does not mean exporting a model.

## Texture formats

These rows compare documented decoding support, including decoders used internally.
Studio JS inherits the formats documented by unityfs-js.

| Format | Reader | Decoder | unity-js | unityfs-js | Studio JS | Studio CLI | unity-asset | Studio Web | decoder.js |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| BC1 / DXT1 | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| BC2 / DXT3 | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| BC3 / DXT5 | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| BC4 / BC5 | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ |
| BC6H | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ |
| BC7 | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| ETC1 / ETC2 | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| EAC | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| PVRTC | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ |
| ASTC | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✓ |
| ATC | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ |
| Crunch | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |

For Reader's exact formats, platform restrictions and tested Unity versions, see the
[texture README](packages/texture/README.md) and [core README](packages/core/README.md).

## Licenses

Reader, Decoder and the other listed libraries declare MIT, except `@arkntools/unity-js`
(AGPL-3.0) and Reader's texture package (MIT AND Apache-2.0).
See each package's license and notices for its included components.
This repository does not copy, import or test against `@arkntools/unity-js`;
its comparison entries use only package metadata and documentation.
