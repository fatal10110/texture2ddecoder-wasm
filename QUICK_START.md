# Quick Start

Read a Unity AssetBundle in five minutes, in Node.js or in a browser.

## 1. Pick the packages

| You want to | Install |
|---|---|
| Unpack bundles and read objects (text, script data, raw audio / video / font bytes) | `unity-asset-reader` |
| Also get textures and sprites as RGBA pixels | `unity-asset-reader-texture` |
| Load files and folders from disk in Node.js | `unity-asset-reader-node` |

```bash
npm install unity-asset-reader unity-asset-reader-texture unity-asset-reader-node
```

## 2. Node.js: extract a bundle

Save this as `extract.mjs` and run `node extract.mjs path/to/bundle-or-folder`:

```js
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadPath } from "unity-asset-reader-node";
import { initTexture, decodeTexture2D } from "unity-asset-reader-texture";

/** Write `data` to `out/<path>`, creating folders. */
function save(path, data) {
  const file = join("out", path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}

/** JSON.stringify replacer: 64-bit integers are bigints, byte arrays are Uint8Arrays. */
const replacer = (_key, value) =>
  typeof value === "bigint" ? value.toString()
  : value instanceof Uint8Array ? `<${value.length} bytes>`
  : value;

// A bundle with its .resS / .resource files, or every file below a folder.
const env = loadPath(process.argv[2]);

// 1. Unpack: every file inside the bundles, byte for byte.
for (const { path, data } of env.files) save(join("files", path), data);

// 2. Every asset, as JSON.
await initTexture(); // loads the WASM texture decoder; Node.js needs no options
for (const asset of env.assets()) {
  const name = `${asset.typeName}-${asset.pathId}`;
  console.log(name, asset.name, asset.path ?? ""); // "Texture2D-1234" "icon" "assets/ui/icon.png"
  try {
    save(join("objects", `${name}.json`), JSON.stringify(asset.data, replacer, 2));
  } catch (error) {
    console.warn(`${name}: ${error.message}`); // e.g. a Mesh in a bundle built without type trees
  }

  // 3. Textures as raw RGBA, top row first.
  if (asset.type === "Texture2D") {
    const { data, width, height } = await decodeTexture2D(asset.data);
    save(join("textures", `${name}-${width}x${height}.rgba`), data);
    // To get a PNG, hand the pixels to an image library, e.g. sharp:
    // await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(`${name}.png`);
  }
}
console.log(`${env.files.length} files, ${env.objects.length} objects -> out/`);
```

What happens here:

- `loadPath()` reads the file together with its `.resS` / `.resource` sidecars (or the whole
  folder), and calls `load()` from `unity-asset-reader`.
- `env.files` holds every unpacked file. `env.assets()` yields every object of every
  SerializedFile among them, with its `type`, `name` and container `path` (the path the asset had
  in the Unity project).
- `asset.data` is read when you first use it. For the common classes it comes from a hand-written
  reader, which also works without type trees; `asset.type` is then the class name, and checking
  it types `data`. Any other class (`asset.type === "Other"`, `asset.typeName === "Mesh"`) is read
  through its type tree, which includes your own scripts' fields when the bundle was built with
  type trees (the Unity default).
- 64-bit integers, such as path ids, are always `bigint`, so JSON needs the replacer.

Without Node.js file access (a server that received an upload, say), use `load()` directly, or
`open()` to fetch the file first:

```js
import { load, open } from "unity-asset-reader";

const env = load(bytes); // bytes: Uint8Array or ArrayBuffer
const env2 = await open("https://cdn.example.com/a.bundle");
```

## 3. Browser

The parser is synchronous, so run it in a Web Worker. A big bundle then does not freeze the page.

- **No bundler:** [`examples/cdn.html`](examples/cdn.html) is a complete page: pick a bundle, list
  its objects, draw a texture. It loads everything from jsDelivr.
- **Vite, Next.js:** see the [Bundler Guide](BUNDLER_GUIDE.md).

The core of it, in a module Worker:

```js
import { load } from "unity-asset-reader";
import { initTexture, decodeTexture2D } from "unity-asset-reader-texture";

// The WASM files, copied with `npx texture2ddecoder-copy-wasm public/wasm`, or from a CDN.
const ready = initTexture({ wasmPath: new URL("/wasm/", self.location.href).href });

self.onmessage = async ({ data: { name, bytes } }) => {
  await ready;
  const env = load({ name, data: bytes }); // bytes: the ArrayBuffer the page transferred
  for (const texture of env.assets("Texture2D")) {
    const { data, width, height } = await decodeTexture2D(texture.data);
    self.postMessage({ name: texture.name, width, height, rgba: data.buffer }, [data.buffer]);
  }
};
```

On the page, `new ImageData(new Uint8ClampedArray(rgba), width, height)` goes straight onto a
canvas.

## Next steps

- [`unity-asset-reader`](packages/core/README.md): the API, the supported containers,
  compression and classes, error types, and 64-bit values.
- [`unity-asset-reader-texture`](packages/texture/README.md): texture formats, sprites, WASM setup.
- [`unity-asset-reader-node`](packages/node/README.md): what `loadPath()` reads.
- [Bundler Guide](BUNDLER_GUIDE.md): Vite, Next.js, CDN, Node.js ESM and CommonJS.
