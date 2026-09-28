# unity-asset-reader

A browser-first reader for Unity AssetBundles and SerializedFiles. It unpacks containers
(UnityFS, UnityWeb, UnityRaw, `UnityWebData`, gzip) and reads the objects inside them, and it
runs the same way in browsers, Web Workers and Node.js.

- **Isomorphic.** It has no `node:*` import and no DOM. Input is a `Uint8Array`, or anything
  `open()` can fetch or read (a URL, a `Response`, a `Blob`).
- **Synchronous parsing.** `load()` returns the unpacked files straight away. Only `open()`, which
  fetches or reads the bytes first, is `async`; nothing in the parse path is (see
  [Run it in a Worker](#run-it-in-a-worker)).
- **No WASM.** Its only dependencies are two small, pure-JS decompressors,
  [`fflate`](https://www.npmjs.com/package/fflate) and [`lzma1`](https://www.npmjs.com/package/lzma1).
- **64-bit values are always `bigint`**, whatever their size (see
  [64-bit values and JSON](#64-bit-values-and-json)).

It is a TypeScript port of [AssetStudio](https://github.com/Razviar/assetstudio), and it is tested
against [UnityPy](https://github.com/K0lb3/UnityPy) on bundles built with our own Unity projects.

| You want to | Install |
|---|---|
| Unpack bundles and read objects: text, scripts' data, raw audio, video and font bytes | `unity-asset-reader` (this package) |
| Get textures and sprites as RGBA pixels, too | add [`unity-asset-reader-texture`](https://github.com/fatal10110/texture2ddecoder-wasm/blob/main/packages/texture/README.md) |
| Load files and folders from disk in Node.js | add [`unity-asset-reader-node`](https://github.com/fatal10110/texture2ddecoder-wasm/blob/main/packages/node/README.md) |

## Install

```bash
npm install unity-asset-reader
```

Types are included. For Node.js versions, CommonJS and bundlers, see
[Requirements](#requirements) and the [Bundler Guide](https://github.com/fatal10110/texture2ddecoder-wasm/blob/main/BUNDLER_GUIDE.md).

## Usage

```ts
import { load, open } from "unity-asset-reader";

const env = load(bundleBytes);                          // a Uint8Array or an ArrayBuffer
const web = await open("https://cdn.example.com/ui.bundle"); // or a URL, Request, Response, Blob / File

for (const asset of env.assets()) {
  console.log(asset.type, asset.name, asset.path); // "TextAsset" "hello" "assets/text/hello.txt"

  switch (asset.type) {
    case "TextAsset":
      console.log(asset.data.text, asset.data.bytes.length); // `data` is a TextAssetFields here
      break;
    case "Texture2D":
      console.log(asset.data.format, asset.data.width, asset.data.mipCount); // a Texture2DFields
      break;
    case "MonoBehaviour":
      console.log(asset.data.script, asset.data.fields); // the MonoScript pointer, the script's fields
      break;
    case "Other":
      console.log(asset.typeName, asset.data); // "Mesh" { m_Name: "tri", ... } from the type tree
  }
}

const icon = env.get("Assets/UI/Icon.png"); // by the path the asset had in the project
for (const sprite of env.assets("Sprite")) sprite.data.rect; // filtered and typed
```

- **`load(input)`** takes one file or an array of files. Each is bytes or `{ name, data }`. A file
  without a name is called `input 0`, `input 1`, ... after its place. That is fine for a bundle,
  whose contents carry their own names, but give loose files (a `.resS`, a `sharedassets0.assets`)
  their real names: resources and pointers between files are found by name.
- **`await open(source)`** gets the bytes first, then calls `load()`. A `string` or `URL` is
  fetched, a `Request` is fetched as it is, a `Response` or `Blob` / `File` is read, and bytes or
  `{ name, data }` pass through; an array mixes them. A file is named after the last segment of
  its URL's path (decoded, without the query) or its `File.name`. A response that is not OK throws
  an `Error` naming the URL and the status. Pass `{ fetch }` to fetch with your own headers or
  credentials: `open(url, { fetch: (input) => fetch(input, { headers }) })`.
- **`env.assets(...types)`** yields every object as an `Asset`: plain data with `type`, `typeName`,
  `classId`, `name`, `path`, `pathId`, `file`, `byteSize`, `data`, the low-level `reader` and the
  `env` that loaded it.
  `type` is the class name for the classes with a class reader (see [Classes](#classes)) and
  `"Other"` for the rest, whose name is in `typeName`. A `switch (asset.type)` narrows `data`;
  `env.assets("Texture2D", "Sprite")` keeps only those types and narrows too. Assets have no
  methods: what you can turn one into is a function that takes it.
- **`name`, `path` and `data` are read when you first use them, then kept.** `name` is `m_Name`,
  read only as far as that field (`""` for a class without one, or for a `GameObject` in a bundle
  without type trees). `path` is the first `m_Container` path of any loaded `AssetBundle` that
  points at the asset, or `undefined`. `data` is what `obj.read()` returns (below), in the
  TypeScript-style shape of [Classes](#classes) for a class with a class reader, and as its type
  tree reads it (under Unity's names) for `"Other"`. A read that fails throws when you access it,
  with the file, class and path id in the message, and is tried again on the next access.
- **`asset.data` field names are camelCase without Unity's `m_` prefix**: `width` for
  `m_Width`, `format` for `m_TextureFormat`. Each field's JSDoc names the Unity field it comes
  from, so the Unity documentation still applies. Pointers stay `PPtr`s (`{ m_FileID, m_PathID }`,
  follow them with `env.resolve`), 64-bit values stay `bigint`, and a field that only some Unity
  versions have is optional. The low-level `obj.read()` keeps Unity's names; the `toXFields`
  functions (`toTexture2DFields(obj.read())`, ...) turn its result into the same shape.
- **`env.get(path)`** finds the asset a container path names. Unity stores those paths in lower
  case, and the lookup ignores case. A path that lists several assets (a texture and its sprites)
  gives the first one; filter `env.assets()` by `path` for the rest.

### Low-level API

The objects themselves, as `env.assets()` sees them:

```ts
import { load, ClassID, classIdName, textAssetString, type TextAsset } from "unity-asset-reader";

// Pass the bundle, plus any .resS / .resource files that sit next to it.
const env = load([{ name: "characters.bundle", data: bundleBytes }]);

// 1. Unpack: every file inside, byte for byte.
for (const { path, data } of env.files) {
  console.log(path, data.length); // "CAB-1a2b…" 4580, "CAB-1a2b….resS" 64
}

// 2. Read objects.
for (const obj of env.objects) {
  console.log(classIdName(obj.type), obj.pathId); // "TextAsset" -2966962111441417370n

  if (obj.type === ClassID.TextAsset) {
    console.log(textAssetString(obj.read<TextAsset>()));
  }
}
```

- **`env.files`** lists every file after unpacking. Nested containers are opened too: a gzip
  wrapper, a bundle inside a `UnityWebData` file. A SerializedFile or a `.resS` is kept under its
  own path. That covers the "just unpack it" use case.
- **`env.objects`** lists every object of every SerializedFile in `env.files`. The files are parsed
  the first time you read `env.objects` (or call `env.resolve` / `env.readResource`), not by
  `load()`. So a file this library cannot parse does not stop you from unpacking.
- **`obj.read()`** reads an object with the class reader for its class, if there is one (see
  [Classes](#classes)). Otherwise it reads the object's type tree. The result type is the union
  `ObjectData`. Narrow it yourself after checking `obj.type`, for example
  `obj.read<TextAsset>()`. Nothing checks it at run time.
- **`obj.readTypeTree()`** reads any object into a plain JS object by walking its type tree. That
  works for every class, including your own `MonoBehaviour`/`ScriptableObject` fields, as long as
  the bundle was built with type trees (the Unity default).
- **`env.resolve(pptr, obj)`** follows a pointer (`{ m_FileID, m_PathID }`) to the object it names.
  It returns `{ status: "found", object }`, or a reason why not (`"null"`, `"fileNotLoaded"` with
  the file name to load, ...). A dangling pointer is a result, never an exception.
- **`env.readResource(ref, obj)`** reads bulk data that an object keeps in a `.resS` / `.resource`
  file. `obj.read()` already does that for `Texture2D`, `AudioClip` and `VideoClip`
  (`imageData`, `audioData`, `videoData`).

Returned bytes are views into your input or into the decompressed blocks, never copies. A small
view keeps its whole buffer alive, so copy it (`data.slice()`) if you want to keep a small piece
and let the rest be garbage-collected.

### Loading several files

Pass every file in one `load()` call: a bundle and its dependency bundles, or a player build's
`sharedassets0.assets` with its `.resS`. Then pointers between them resolve, and each object finds
its resource files. File names are matched by their last path component, ignoring case, as Unity
does. To keep two builds apart, load each one with its own `load()`.

In Node.js, [`unity-asset-reader-node`](https://github.com/fatal10110/texture2ddecoder-wasm/blob/main/packages/node/README.md)'s `loadPath()` reads a file with its
sidecars, or a whole folder, and calls `load()` for you.

## Run it in a Worker

Parsing is synchronous, so a big bundle blocks the thread it runs on until it is done. In a
browser, run the reader in a Web Worker and post plain data back to the page:

```js
// reader.worker.js (a module Worker)
import { load, classIdName } from "unity-asset-reader";

self.onmessage = ({ data: { name, bytes } }) => {
  const env = load([{ name, data: new Uint8Array(bytes) }]);
  self.postMessage(
    env.objects.map((obj) => ({
      className: classIdName(obj.type),
      pathId: String(obj.pathId), // bigint -> string for the page
      size: obj.byteSize,
    })),
  );
};
```

```js
// page
const worker = new Worker(new URL("./reader.worker.js", import.meta.url), { type: "module" });
const bytes = await file.arrayBuffer();
worker.postMessage({ name: file.name, bytes }, [bytes]); // transfer, do not copy
```

[`examples/cdn.html`](https://github.com/fatal10110/texture2ddecoder-wasm/blob/main/examples/cdn.html) is a complete page built this way, with no bundler.
The [Bundler Guide](https://github.com/fatal10110/texture2ddecoder-wasm/blob/main/BUNDLER_GUIDE.md) has the setup for Vite and Next.js.

## 64-bit values and JSON

Every 64-bit integer is a `bigint`: path ids (`obj.pathId`, `m_PathID`), and every `SInt64` /
`UInt64` field a type tree holds. That holds even when the value is small, so a field's type never
depends on its value. File offsets and sizes are plain `number`s. Anything at or above 2^53 is
refused with an error rather than rounded.

`JSON.stringify` throws on a `bigint`. Pass a replacer that writes it as a decimal string:

```js
/** JSON.stringify replacer: bigint -> decimal string, bytes -> hex. */
function unityJsonReplacer(_key, value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    return Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return value;
}

JSON.stringify(obj.readTypeTree(), unityJsonReplacer, 2);
```

The `Uint8Array` branch is optional. Without it, a byte array (`TypelessData`, `byte[]`, a
`TextAsset`'s `m_Script`) becomes `{"0":…,"1":…}`. Also note that JSON has no `NaN`, `Infinity`
or `-0`: `JSON.stringify` writes `null`, `null` and `0` for float fields that hold them.

## Errors

An error from `load()` or `env.objects` names the path down to the bad bytes
(`a.bundle: CAB-1a2b…: ...`); an asset's `name` or `data` adds the class and path id
(`a.bundle: CAB-1a2b…: Texture2D -2966962111441417370: ...`). Three classes let you tell the cases
apart:

| Class | Meaning | Useful fields |
|---|---|---|
| `UnsupportedError` | The input is well-formed, but it uses something this library does not read: a compression type, a container, a format or Unity version. | `kind` (`"compression type"`, `"container"`, `"Unity version"`, ...), `found` |
| `CorruptError` | The input claims to be something this library reads, but it does not hold together: it is truncated, a size disagrees with its header, the magic number is wrong. | |
| `ResourceNotFoundError` | An object's data is in a `.resS` / `.resource` file that was not passed to `load()`. Load it too. | `path`, `fileName` |

Nothing returns partial or garbage data without an error.

## Supported

### Containers and compression

| Input | Support |
|---|---|
| UnityFS | Yes: uncompressed, LZMA, LZ4 and LZ4HC blocks; blocks info at the end (flag `0x80`); 2019.4+ block padding (flag `0x200`) |
| UnityWeb, UnityRaw (legacy web player bundles) | Yes: the old level layout and the format 6 archive layout, LZMA-compressed (UnityWeb) or not (UnityRaw) |
| `UnityWebData1.0` (WebGL `.data`) | Yes, and a bundle inside it is opened too |
| A gzip-wrapped file | Yes: unwrapped, then opened as whatever is inside |
| A loose SerializedFile (`.assets`, `level0`, `globalgamemanagers`) and `.resS` / `.resource` files | Yes |
| SerializedFile format versions | 2 to 22 are ported. See [Tested range](#tested-range) |

### Classes

`obj.readTypeTree()` reads **any class** from a file with type trees. `obj.read()` uses a
hand-written reader for the classes below. Those readers also work on bundles built without type
trees (`BuildAssetBundleOptions.DisableWriteTypeTree`). The table lists the main fields of
`asset.data` (the type in brackets); the JSDoc of each type has every field, with its Unity name.

| Class | Main fields of `asset.data` |
|---|---|
| `AssetBundle` (`AssetBundleFields`) | `container`: asset path to object, the bundle's table of contents; `preloadTable`, `dependencies` |
| `TextAsset` (`TextAssetFields`) | `bytes`: the file as stored; `text`: those bytes decoded as UTF-8 (on first use) |
| `MonoBehaviour` (`MonoBehaviourFields`) | `script` (the `MonoScript` pointer), `gameObject`, `enabled`, `name`, and `fields`: every field of the script, with a type tree only |
| `MonoScript` (`MonoScriptFields`) | `className`, `namespace`, `assemblyName` |
| `Material` (`MaterialFields`) | `shader` pointer, keywords, and `savedProperties`: `texEnvs` (texture slots), `floats`, `ints`, `colors` |
| `Texture2D` (`Texture2DFields`) | `width`, `height`, `format` (a `TextureFormat`), `mipCount`, `textureSettings`, `platform` and `imageData`, still encoded (inline or from the `.resS`). Decode it with [`unity-asset-reader-texture`](https://github.com/fatal10110/texture2ddecoder-wasm/blob/main/packages/texture/README.md) |
| `Sprite` (`SpriteFields`), `SpriteAtlas` (`SpriteAtlasFields`) | `rect`, `pivot`, `border`, `pixelsToUnits`, `renderData` (texture area and mesh); an atlas' `packedSprites` and `renderDataMap`. Cut them out with `unity-asset-reader-texture` |
| `AudioClip` (`AudioClipFields`) | `channels`, `frequency`, `length`, `compressionFormat` and `audioData`: the sound bank as stored (usually FSB5), not decoded |
| `VideoClip` (`VideoClipFields`) | `width`, `height`, `frameRate`, `frameCount` and `videoData`: the video file as imported (e.g. WebM, MP4), not decoded |
| `Font` (`FontFields`) | `fontData`: the TrueType/OpenType file; `fontNames`, `fontSize`, `characterRects` |
| `MovieTexture` (`MovieTextureFields`) | `movieData` (the Ogg Theora file), `loop`, `audioClip`; no fixture covers it yet |

Every other class (`GameObject`, `Transform`, `Mesh`, `AnimationClip`, ...) comes from its type
tree. In a bundle without type trees, `obj.read()` throws `UnsupportedError` for them.

### Tested range

The parser is ported for every version its upstream handles. It is **tested** on bundles built
with Unity **2019.4.41f2, 2020.3.30f1 and 6000.3.25f1**: SerializedFile **formats 21 and 22**,
UnityFS format 7 and 8, with LZ4, LZMA and uncompressed blocks, with and without type trees, and
version-stripped (`AssetBundleStripUnityVersion`). UnityFS format 6, UnityWeb, UnityRaw,
`UnityWebData` and gzip are tested on generated containers whose contents are not real
SerializedFiles. SerializedFile formats 20 and older are ported but no test bundle covers them.

### Not supported

Each of these throws `UnsupportedError` naming what it found:

- Compression: LZHAM, brotli (a WebGL build's `.br` files: decompress them first), zstd.
- Containers: `UnityArchive`, zip archives (extract the zip first).
- Encrypted bundles (UnityCN and other game-specific encryption), and the containers of games
  that modified the format.
- One bundle that unpacks to more than `0x7fffffff` bytes (2 GiB).
- A class reader for a version it has no layout for: before Unity 3.4, or a version-stripped file
  where the bytes do not decide the layout. `readTypeTree()` still works on such files.
- An editor file (`BuildTarget.NoTarget`) read by `Texture2D`'s or `MonoScript`'s reader, which
  read player data only.

Out of scope for this package: decoding audio, video or meshes; writing or repacking bundles;
image encoding (PNG, JPEG). Texture and sprite pixels are in
[`unity-asset-reader-texture`](https://github.com/fatal10110/texture2ddecoder-wasm/blob/main/packages/texture/README.md).

## Requirements

- **Browsers:** any browser with ES2020 (`bigint`) and `TextDecoder`. Every current browser has
  both.
- **Node.js:** 20.19+ or 22.12+ (`engines`: `^20.19.0 || >=22.12.0`), for both `import` and
  `require`. `lzma1` is published as ES modules only, so `require("unity-asset-reader")` needs a
  Node.js that can `require()` an ES module
  ([#172](https://github.com/fatal10110/texture2ddecoder-wasm/issues/172)). CI tests on 20.19.0
  and 22.12.0.

## API reference

Every export, grouped. Each one has full JSDoc (parameters, return values, what it throws) in the
bundled `index.d.ts`, so your editor shows it on hover.

### Loading

| Export | What |
|---|---|
| `load(inputs)` | Unpack one file or several and index their objects. Returns an `Env` |
| `open(sources, options?)` | Fetch or read files (URL, `Request`, `Response`, `Blob` / `File`, bytes), then `load()` them. Returns a promise of the `Env` |
| `OpenSource`, `OpenOptions` | What `open()` takes; `options.fetch` replaces the global `fetch` |
| `ResponseLike`, `RequestLike`, `BlobLike`, `URLLike` | The parts of the WHATWG types `open()` uses, which `Response`, `Request`, `Blob`, `File` and `URL` fit |
| `Env` | `files`, `objects`, `assets(...types)`, `get(path)`, `resolve(pptr, from)`, `readResource(ref, from)` |
| `LoadSource` | One input of `load()`: bytes, a `LoadInput`, or `{ data }` without a name (called `input <index>`) |
| `LoadInput` | `{ name, data }`: one named file for `load()`; `data` is a `Uint8Array` or `ArrayBuffer` |
| `LoadedFile` | `{ path, data }`: one unpacked file |
| `ResourceRef` | `{ path, offset, size }`: a byte range of a resource file (a `StreamingInfo`) |
| `PPtr` | `{ m_FileID, m_PathID }`: a pointer as a type tree holds it |
| `PPtrResolution` | What `env.resolve` returns: `found` with the object, or why not |

### Objects

| Export | What |
|---|---|
| `Asset`, `AssetType`, `KnownAssetType` | One object as `env.assets()` yields it; `Asset<"Texture2D">` is one of that type. `AssetType` is `KnownAssetType` (the classes with a class reader) or `"Other"` |
| `AssetDataMap` | Class name to the type of `asset.data` (`Texture2DFields`, ...), for the classes with a class reader |
| `ObjectDataMap` | Class name to what `obj.read()` returns (`Texture2DData`, ...), under Unity's names |
| `ObjectReader` | One object: `pathId`, `type` (class id), `byteSize`, `version`, `platform`, `read()`, `readTypeTree()`, and the binary read methods of `BinaryReader` |
| `ObjectData` | The union `obj.read()` returns |
| `readTypeTree(reader)` | Read an object into a plain JS object by walking its type tree |
| `TypeTreeObject`, `TypeTreeValue` | What `readTypeTree` returns; the JSDoc lists each Unity type's JS shape |
| `ClassID`, `classIdName(id)` | Unity class ids by name (`ClassID.Texture2D === 28`), and back |
| `Vector3`, `Quaternion`, `XForm` | Shapes read by `ObjectReader.readVector3` / `readXForm` |

### Class readers

Each `readX(reader)` reads one class from the object's first byte. `obj.read()` calls them for you.
Call one yourself only to read an object as a specific class.

| Export | Result types |
|---|---|
| `readObject`, `readEditorExtension`, `readNamedObject` | `UnityObject`, `EditorExtension`, `NamedObject`: the fields every class starts with |
| `readAssetBundle` | `AssetBundle`, `AssetInfo`, `AssetBundleScriptInfo` |
| `readTextAsset`, `textAssetString` | `TextAsset` |
| `readMonoScript` | `MonoScript`, `Hash128` |
| `readMonoBehaviour` | `MonoBehaviour` (the header); `MonoBehaviourData` is what `obj.read()` returns |
| `readMaterial` | `Material`, `UnityPropertySheet`, `UnityTexEnv`, `BuildTextureStackReference`, `Color`, `Vector2` |
| `readTexture`, `readTexture2D`, `TextureFormat` | `Texture`, `Texture2D`, `StreamingInfo`, `GLTextureSettings`; `Texture2DData` is what `obj.read()` returns |
| `readSprite`, `SpritePackingRotation` | `Sprite`, `SpriteRenderData`, `SpriteVertex`, `SpriteBone`, `SecondarySpriteTexture`, `VertexData`, `ChannelInfo`, `SubMesh`, `BlendShapeData`, `BlendShapeVertex`, `MeshBlendShape`, `MeshBlendShapeChannel`, `BoneWeights4`, `AABB`, `Matrix4x4`, `Vector4`, `GUID` |
| `readSpriteAtlas` | `SpriteAtlas`, `SpriteAtlasData` |
| `readAudioClip` | `AudioClip`; `AudioClipData` is what `obj.read()` returns |
| `readVideoClip` | `VideoClip`, `StreamedResource`; `VideoClipData` is what `obj.read()` returns |
| `readFont` | `Font`, `CharacterInfo`, `Rectf` |
| `readMovieTexture` | `MovieTexture` |

### `asset.data` shapes

Each `toXFields(data)` turns what `obj.read()` returns for class `X` into what `asset.data` is for
it; `env.assets()` calls them for you.

| Export | Result types |
|---|---|
| `toAssetBundleFields`, `toTextAssetFields`, `toMonoScriptFields`, `toMaterialFields`, `toTexture2DFields`, `toSpriteFields`, `toSpriteAtlasFields`, `toAudioClipFields`, `toVideoClipFields`, `toFontFields`, `toMovieTextureFields` | `AssetBundleFields`, `TextAssetFields`, `MonoScriptFields`, `MaterialFields` (`UnityPropertySheetFields`, `UnityTexEnvFields`), `Texture2DFields` (`GLTextureSettingsFields`), `SpriteFields` (`SpriteRenderDataFields`, `VertexDataFields`, `SubMeshFields`, `AABBFields`), `SpriteAtlasFields`, `AudioClipFields` and `VideoClipFields` (`StreamedResourceFields`), `FontFields`, `MovieTextureFields` |
| `toMonoBehaviourFields(data, obj)` | `MonoBehaviourFields`; it takes the object too, whose type tree tells whether `data` holds the script's fields |
| `EditorExtensionFields`, `NamedObjectFields`, `TextureFields` | The fields every class, every named class and every texture starts with |

### Lower layers

For tools that work below `load()`:

| Export | What |
|---|---|
| `detectFileType(data)`, `FileType` | Sniff what a file is from its first bytes; never throws |
| `detectContainer(data)`, `SupportedFileType` | The same, but throws `UnsupportedError` for what cannot be opened |
| `readBundle(data)`, `BundleFile`, `BundleHeader`, `StreamFile`, `NodeFlags` | Unpack one UnityFS / UnityWeb / UnityRaw bundle |
| `readWebFile(data)`, `WebFile` | Unpack one `UnityWebData1.0` file |
| `readSerializedFile(data)`, `SerializedFile`, `SerializedFileHeader`, `ObjectInfo`, `FileIdentifier`, `LocalSerializedObjectIdentifier`, `UnityVersion` | Parse a SerializedFile's header, type trees and object table |
| `SerializedType`, `TypeTreeNode` | A type entry and its type tree |
| `SerializedFileFormatVersion`, `BuildTarget` | Format version and target platform constants |
| `decompressLz4`, `lzmaDecompress`, `gunzip`, `unzlib` | The block decompressors, each checking its output size |
| `BinaryReader`, `Endian` | Bounds-checked reader over a `Uint8Array`, little- or big-endian |
| `UnsupportedError`, `CorruptError`, `ResourceNotFoundError` | See [Errors](#errors) |

## License

MIT. This package is a derivative port of AssetStudio (MIT) and uses UnityPy (MIT) as a secondary
reference. Their copyright notices are in [`NOTICE`](https://github.com/fatal10110/texture2ddecoder-wasm/blob/main/packages/core/NOTICE).
