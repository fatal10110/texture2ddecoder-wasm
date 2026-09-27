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
import { ClassID, classIdName } from "unity-asset-reader";
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

// 2. Every object, as JSON, through its type tree.
await initTexture(); // loads the WASM texture decoder; Node.js needs no options
for (const obj of env.objects) {
  const name = `${classIdName(obj.type) ?? obj.type}-${obj.pathId}`;
  try {
    save(join("objects", `${name}.json`), JSON.stringify(obj.readTypeTree(), replacer, 2));
  } catch (error) {
    console.warn(`${name}: ${error.message}`); // e.g. a bundle built without type trees
  }

  // 3. Textures as raw RGBA, top row first.
  if (obj.type === ClassID.Texture2D) {
    const { data, width, height } = await decodeTexture2D(obj.read());
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
- `env.files` holds every unpacked file. `env.objects` holds every object of every SerializedFile
  among them.
- `readTypeTree()` reads any class, including your own scripts' fields, when the bundle was built
  with type trees (the Unity default). `obj.read()` instead uses a hand-written reader for the
  common classes, and those also work without type trees.
- 64-bit integers, such as path ids, are always `bigint`, so JSON needs the replacer.

Without Node.js file access (a server that received an upload, say), use `load()` directly:

```js
import { load } from "unity-asset-reader";

const env = load([{ name: "a.bundle", data: bytes }]); // bytes: Uint8Array or ArrayBuffer
```

## 3. Browser

The parser is synchronous, so run it in a Web Worker. A big bundle then does not freeze the page.

- **No bundler:** [`examples/cdn.html`](examples/cdn.html) is a complete page: pick a bundle, list
  its objects, draw a texture. It loads everything from jsDelivr.
- **Vite, Next.js:** see the [Bundler Guide](BUNDLER_GUIDE.md).

The core of it, in a module Worker:

```js
import { load, ClassID } from "unity-asset-reader";
import { initTexture, decodeTexture2D } from "unity-asset-reader-texture";

// The WASM files, copied with `npx texture2ddecoder-copy-wasm public/wasm`, or from a CDN.
const ready = initTexture({ wasmPath: new URL("/wasm/", self.location.href).href });

self.onmessage = async ({ data: { name, bytes } }) => {
  await ready;
  const env = load([{ name, data: new Uint8Array(bytes) }]);
  for (const obj of env.objects) {
    if (obj.type === ClassID.Texture2D) {
      const { data, width, height } = await decodeTexture2D(obj.read());
      self.postMessage({ width, height, rgba: data.buffer }, [data.buffer]);
    }
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
