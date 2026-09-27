# unity-asset-reader-node

Node.js adapter for [`unity-asset-reader`](https://github.com/fatal10110/texture2ddecoder-wasm/blob/main/packages/core/README.md).
It adds `loadPath()`, which reads a Unity file or a whole folder from disk and unpacks it. It
finds each file's `.resS` / `.resource` sidecars and merges split files (`.split0`, `.split1`,
...).

`unity-asset-reader` itself takes bytes (`Uint8Array`) and works anywhere. Use this package only
when the files are on a local disk.

## Install

```bash
npm install unity-asset-reader unity-asset-reader-node
```

`unity-asset-reader` is a peer dependency, so your app has exactly one copy of the parser.

## Usage

```js
import { ClassID, classIdName } from "unity-asset-reader";
import { loadPath } from "unity-asset-reader-node";

// A folder: every file below it, recursively.
const env = loadPath("Build/StreamingAssets/bundles");
for (const obj of env.objects) {
  console.log(classIdName(obj.type), obj.pathId);
}

// Or one file, with its sidecars from the same folder
// (here sharedassets0.assets.resS and sharedassets0.resource, when they exist).
const level = loadPath("Game_Data/sharedassets0.assets");
const textures = level.objects.filter((obj) => obj.type === ClassID.Texture2D);
```

`loadPath()` returns the same `Env` as `load()`, so everything in the
[`unity-asset-reader` README](https://github.com/fatal10110/texture2ddecoder-wasm/blob/main/packages/core/README.md)
applies: `env.files`, `env.objects`, `obj.read()`, `env.resolve()`. Add
[`unity-asset-reader-texture`](https://github.com/fatal10110/texture2ddecoder-wasm/blob/main/packages/texture/README.md)
for pixels.

## What `loadPath()` reads

- **A folder** is scanned recursively. Every regular file in it is loaded, whatever its name. A
  symbolic link to a file is read; a link to a folder is not followed.
- **A file** is loaded with its sidecars from the same folder: `<name>.resS` and
  `<stem>.resource`. For `sharedassets0.assets` those are `sharedassets0.assets.resS` and
  `sharedassets0.resource`. Names are matched ignoring case. Nothing else in the folder is read.
  To load more, pass the folder.
- **Split files** (`<name>.split0` ... `<name>.splitN`, as Unity writes large files for Android)
  are merged in memory into one input named `<name>`. A path to any one part loads the whole
  file. When the merged `<name>` already sits next to its parts, it is used and the parts are
  skipped. Nothing is written to disk.

Each file is passed to `load()` under its path relative to the folder you gave (for a file: its
own folder), with `/` as the separator on every platform, for example `bundles/main`. That is the
`path` a loose file gets in `env.files`.

All the files of one call share one container. If one folder holds two builds that both have, for
example, a `sharedassets0.assets.resS`, the first one (in name order) serves both. Load each
build with its own call to keep them apart.

`loadPath()` is synchronous, like `load()`: it reads with `readFileSync`.

## Errors

- Node.js's own file system error (`ENOENT`, `EACCES`, ...) when the path does not exist, or when
  any file or folder in the scan cannot be read. A dangling symbolic link counts too. The scan
  never skips what it cannot read.
- `Error` when the path is neither a file nor a folder (a socket, a device).
- `CorruptError` when the parts of a split file have a gap. The message names the file and the
  first missing part.
- Anything `load()` throws: `UnsupportedError`, `CorruptError`.

## Not supported

- Loading only the files a file depends on. `loadPath(file)` reads the file and its sidecars, not
  the other files its `m_Externals` name. Pointers into those resolve as `fileNotLoaded`; pass the
  folder to load them
  ([#165](https://github.com/fatal10110/texture2ddecoder-wasm/issues/165)).
- Streaming, or reading a large `.resS` in pieces: every file is read into memory whole.
- Browsers. Use `unity-asset-reader`'s `load()` with the bytes of a `File` or `fetch` response.

## Requirements

Node.js 18+ for `import`. `require()` needs Node.js 20.19+ or 22.12+, because
`unity-asset-reader`'s LZMA dependency is published as ES modules only.

## API reference

| Export | What |
|---|---|
| `loadPath(fileOrDir)` | Read a file with its sidecars, or every file below a folder, and `load()` them. Returns the `Env`. |

Full JSDoc is in the bundled `index.d.ts`.

## License

MIT. `loadPath()` ports parts of AssetStudio (MIT); see
[`NOTICE`](https://github.com/fatal10110/texture2ddecoder-wasm/blob/main/packages/node/NOTICE).
