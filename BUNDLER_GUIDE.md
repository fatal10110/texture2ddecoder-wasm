# Bundler Guide

How to set up the reader packages with Vite, Next.js, a plain CDN page, and Node.js (ESM and
CommonJS). For `texture2ddecoder-wasm` on its own, see its
[Bundler Guide](packages/decoder/BUNDLER_GUIDE.md).

- [What each package needs](#what-each-package-needs)
- [Run the reader in a Worker](#run-the-reader-in-a-worker)
- [Vite](#vite)
- [Next.js](#nextjs)
- [CDN, no bundler](#cdn-no-bundler)
- [Node.js: ESM and CommonJS](#nodejs-esm-and-commonjs)
- [Troubleshooting](#troubleshooting)

## What each package needs

| Package | In a bundler |
|---|---|
| `unity-asset-reader` | Nothing. Plain ES2020 with no WASM, no Node.js built-ins and no DOM. |
| `unity-asset-reader-texture` | Serve the two WASM files as static files, and pass their URL to `initTexture({ wasmPath })`. |
| `unity-asset-reader-node` | Node.js only (`node:fs`). Never import it in browser code. |

None of them needs COOP/COEP headers or `SharedArrayBuffer`: everything is single-threaded. The
pages work from any static host. They have to be served over HTTP; `file://` does not work.

## Run the reader in a Worker

`load()` and every class reader are synchronous (plan decision D4). On the main thread, a big
bundle freezes the page until it is parsed. So parse in a module Worker, and post plain data
back: object lists, strings, RGBA pixels. Transfer the `ArrayBuffer`s instead of copying them.

Do not post an `Env` or an `ObjectReader`: they hold functions and views into the whole unpacked
buffer. `bigint`s can be posted, but convert them to strings if the data also goes into JSON.

Every setup below uses a Worker. On the main thread, the same imports work unchanged, which is
fine for small files.

## Vite

Tested with Vite 7 and 8, in `vite` (dev) and `vite build`.

1. Install, and copy the WASM files into `public/`:

   ```bash
   npm install unity-asset-reader unity-asset-reader-texture
   npx texture2ddecoder-copy-wasm public/wasm
   ```

2. On Vite 7, build Workers as ES modules. The WASM loader uses a dynamic `import()`. Vite 7's
   default Worker format (`iife`) cannot hold one, and `vite build` stops with
   `Invalid value "iife" for option "worker.format"`. Vite 8 needs no config.

   ```js
   // vite.config.js
   import { defineConfig } from "vite";

   export default defineConfig({
     worker: { format: "es" },
   });
   ```

3. The Worker:

   ```js
   // src/reader.worker.js
   import { load, ClassID } from "unity-asset-reader";
   import { initTexture, decodeTexture2D } from "unity-asset-reader-texture";

   const ready = initTexture({ wasmPath: "/wasm" });

   self.onmessage = async ({ data: { name, bytes } }) => {
     await ready;
     const env = load([{ name, data: new Uint8Array(bytes) }]);
     for (const obj of env.objects) {
       if (obj.type !== ClassID.Texture2D) continue;
       const { data, width, height } = await decodeTexture2D(obj.read());
       self.postMessage({ width, height, rgba: data.buffer }, [data.buffer]);
     }
   };
   ```

4. The page:

   ```js
   // src/main.js
   const worker = new Worker(new URL("./reader.worker.js", import.meta.url), { type: "module" });

   worker.onmessage = ({ data: { width, height, rgba } }) => {
     const canvas = document.querySelector("canvas");
     canvas.width = width;
     canvas.height = height;
     canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
   };

   document.querySelector("input[type=file]").onchange = async ({ target }) => {
     const file = target.files[0];
     const bytes = await file.arrayBuffer();
     worker.postMessage({ name: file.name, bytes }, [bytes]);
   };
   ```

## Next.js

Tested with Next.js 16 (Turbopack, and `next build --webpack`), with `next build && next start`.

Import the packages in a module Worker started from a client component. No `next.config.js`
change is needed. `unity-asset-reader-texture` needs `texture2ddecoder-wasm` 1.2.4 or later
here: with 1.2.3 and earlier, the build fails with `Can't resolve 'module'`
([#171](https://github.com/fatal10110/texture2ddecoder-wasm/issues/171)).

1. Install, and copy the WASM files into `public/`:

   ```bash
   npm install unity-asset-reader unity-asset-reader-texture
   npx texture2ddecoder-copy-wasm public/wasm
   ```

2. The Worker:

   ```js
   // app/reader.worker.js
   import { load, ClassID } from "unity-asset-reader";
   import { initTexture, decodeTexture2D } from "unity-asset-reader-texture";

   const ready = initTexture({ wasmPath: "/wasm" });

   self.onmessage = async ({ data: { name, bytes } }) => {
     await ready;
     const env = load([{ name, data: new Uint8Array(bytes) }]);
     for (const obj of env.objects) {
       if (obj.type !== ClassID.Texture2D) continue;
       const { data, width, height } = await decodeTexture2D(obj.read());
       self.postMessage({ width, height, rgba: data.buffer }, [data.buffer]);
     }
   };
   ```

3. The client component:

   ```jsx
   // app/page.jsx
   "use client";

   import { useEffect, useRef } from "react";

   export default function Page() {
     const worker = useRef(null);
     useEffect(() => {
       worker.current = new Worker(new URL("./reader.worker.js", import.meta.url), { type: "module" });
       worker.current.onmessage = ({ data }) => console.log(data);
       return () => worker.current.terminate();
     }, []);

     const pick = async (event) => {
       const file = event.target.files[0];
       const bytes = await file.arrayBuffer();
       worker.current.postMessage({ name: file.name, bytes }, [bytes]);
     };
     return <input type="file" onChange={pick} />;
   }
   ```

## CDN, no bundler

[`examples/cdn.html`](examples/cdn.html) is a complete page: pick a bundle, list its objects, draw
a texture. Its Worker is [`examples/cdn-worker.js`](examples/cdn-worker.js).

- **Import jsDelivr's `/+esm` builds.** The packages import their dependencies by bare name
  (`fflate`, `lzma1`, `unity-asset-reader`, `texture2ddecoder-wasm`). A browser cannot
  resolve those, and import maps do not apply inside Workers. jsDelivr's `/+esm` endpoint rewrites
  them to CDN URLs:

  ```js
  const CDN = "https://cdn.jsdelivr.net/npm";
  const { load, ClassID } = await import(`${CDN}/unity-asset-reader@1/+esm`);
  const { initTexture, decodeTexture2D } = await import(`${CDN}/unity-asset-reader-texture@1/+esm`);
  await initTexture({ wasmPath: `${CDN}/texture2ddecoder-wasm@1/wasm` });
  ```

  Pin exact versions in production. Each package has its own version: pick a
  `unity-asset-reader` that `unity-asset-reader-texture`'s peer range allows (the same major),
  and a `texture2ddecoder-wasm` that its dependency range allows (`@1.2.3` or later).
- **In a Worker, `texture2ddecoder-wasm` must be 1.2.3 or later.** 1.2.2 refuses to initialize in
  a Worker ([#149](https://github.com/fatal10110/texture2ddecoder-wasm/issues/149)).
- **Try it on this repo's builds** with `node examples/serve.mjs`, a local stand-in for jsDelivr,
  and open `cdn.html?local`. See [`examples/README.md`](examples/README.md).

## Node.js: ESM and CommonJS

```js
// ESM
import { load, ClassID } from "unity-asset-reader";
import { initTexture, decodeTexture2D } from "unity-asset-reader-texture";
import { loadPath } from "unity-asset-reader-node";
```

```js
// CommonJS
const { load, ClassID } = require("unity-asset-reader");
const { initTexture, decodeTexture2D } = require("unity-asset-reader-texture");
const { loadPath } = require("unity-asset-reader-node");
```

In Node.js, `initTexture()` takes no options: the WASM files are found in the installed
`texture2ddecoder-wasm` package.

All three reader packages need Node.js 20.19+ or 22.12+ (`engines`: `^20.19.0 || >=22.12.0`),
for both `import` and `require`, and CI tests on 20.19.0 and 22.12.0
([#172](https://github.com/fatal10110/texture2ddecoder-wasm/issues/172)). `require()` needs a
Node.js that can `require()` an ES module, because the LZMA decoder `lzma1` is published as ES
modules only. `initTexture()` needs a Node.js that detects ES-module syntax in
`texture2ddecoder-wasm`'s glue code.

When you bundle a Node.js app (esbuild, Rollup, webpack with `target: "node"`), keep
`texture2ddecoder-wasm` external. `initTexture()` finds the WASM files relative to its own
installed location.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Invalid value "iife" for option "worker.format"` (Vite build) | Set `worker: { format: "es" }` in `vite.config.js`. |
| `Failed to fetch dynamically imported module: .../wasm/texture2ddecoder.js?import` (Vite dev) | `texture2ddecoder-wasm` 1.2.3 or earlier with a root-relative `wasmPath` ([#171](https://github.com/fatal10110/texture2ddecoder-wasm/issues/171)). Update it to 1.2.4 or later, or pass an absolute URL: `wasmPath: new URL("/wasm/", location.href).href`. |
| `Failed to load WASM module from ...` | The two files are not at that URL. Run `npx texture2ddecoder-copy-wasm public/wasm`, and check that `<wasmPath>/texture2ddecoder.js` opens in the browser. |
| `Browser environment requires wasmPath parameter` | `initTexture()` without options only works in Node.js. |
| `Can't resolve 'module'`, `Cannot find module 'unknown'` or `Cannot find module 'http://…/texture2ddecoder.js'` (Next.js) | `texture2ddecoder-wasm` 1.2.3 or earlier ([#171](https://github.com/fatal10110/texture2ddecoder-wasm/issues/171)). Update it to 1.2.4 or later: `npm update texture2ddecoder-wasm`. |
| `decodeTexture2D: the texture decoder is not initialized` | Await `initTexture()` before the first decode. Plain formats need it too. |
| `ERR_REQUIRE_ESM` on `lzma1` | Node.js below 20.19 / 22.12 cannot `require()` it. Use `import`, or a newer Node.js. |
| `Cannot use 'import.meta' outside a module` from `initTexture()` | Node.js below 20.19. Upgrade. |
| The page freezes while a bundle loads | The reader runs on the main thread. Move it into a Worker. |
