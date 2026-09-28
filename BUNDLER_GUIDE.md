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

Tested with Vite 7, in `vite` (dev) and `vite build`.

1. Install, and copy the WASM files into `public/`:

   ```bash
   npm install unity-asset-reader unity-asset-reader-texture
   npx texture2ddecoder-copy-wasm public/wasm
   ```

2. Build Workers as ES modules. The WASM loader uses a dynamic `import()`. Vite's default
   Worker format (`iife`) cannot hold one, and `vite build` stops with
   `Invalid value "iife" for option "worker.format"`.

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

   // An absolute URL: the Vite dev server cannot load a root-relative "/wasm".
   const ready = initTexture({ wasmPath: new URL("/wasm/", self.location.href).href });

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

`vite build` may log `Module "module" has been externalized for browser compatibility` for
`texture2ddecoder.js`. That is the Node.js branch of the WASM loader, which never runs in a
browser.

## Next.js

Tested with Next.js 16 (Turbopack, and `next build --webpack`).

**`unity-asset-reader` works as is.** Import it in a module Worker started from a client
component. No `next.config.js` change is needed:

```js
// app/reader.worker.js
import { load, classIdName } from "unity-asset-reader";

self.onmessage = ({ data: { name, bytes } }) => {
  const env = load([{ name, data: new Uint8Array(bytes) }]);
  self.postMessage(env.objects.map((obj) => ({ className: classIdName(obj.type), pathId: String(obj.pathId) })));
};
```

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

**`unity-asset-reader-texture` cannot be bundled by Next.js yet**
([#171](https://github.com/fatal10110/texture2ddecoder-wasm/issues/171)). The WASM loader of
`texture2ddecoder-wasm` imports its glue code from a URL at run time, and Next.js rewrites
that import in both Turbopack and webpack builds. The build succeeds, but `initTexture()` fails with
`Cannot find module ...`.

Until that is fixed, keep the texture decoding out of the Next.js bundle. Put the Worker in
`public/`, so Next.js serves it untouched, and have it import the packages from a CDN, as
described in [CDN, no bundler](#cdn-no-bundler):

```js
// public/texture-worker.js: served as is, never bundled
const CDN = "https://cdn.jsdelivr.net/npm";

// Load and initialize once. onmessage is set right away and waits for this,
// so a message posted before the imports finish is not lost.
const ready = (async () => {
  const reader = await import(`${CDN}/unity-asset-reader@1/+esm`);
  const texture = await import(`${CDN}/unity-asset-reader-texture@1/+esm`);
  await texture.initTexture({ wasmPath: `${CDN}/texture2ddecoder-wasm@1/wasm` });
  return { ...reader, ...texture };
})();

self.onmessage = async ({ data: { name, bytes } }) => {
  const { load, ClassID, decodeTexture2D } = await ready;
  const env = load([{ name, data: new Uint8Array(bytes) }]);
  for (const obj of env.objects) {
    if (obj.type !== ClassID.Texture2D) continue;
    const { data, width, height } = await decodeTexture2D(obj.read());
    self.postMessage({ width, height, rgba: data.buffer }, [data.buffer]);
  }
};
```

```js
// in the client component
new Worker("/texture-worker.js", { type: "module" });
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

  Pin exact versions in production. Keep `unity-asset-reader` and `unity-asset-reader-texture`
  on the same version (`@1.0.0`): they are released together. `texture2ddecoder-wasm` has its
  own version line; use one the texture package's range allows (`@1.2.3` or later).
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

Which Node.js versions work
([#172](https://github.com/fatal10110/texture2ddecoder-wasm/issues/172)):

| | `import` | `require` |
|---|---|---|
| `unity-asset-reader`, `unity-asset-reader-node` | 18+ | 20.19+ or 22.12+ |
| `unity-asset-reader-texture` | 20.19+ or 22.12+ | 20.19+ or 22.12+ |

`require()` needs a Node.js that can `require()` an ES module, because the LZMA decoder `lzma1`
is published as ES modules only. `initTexture()` needs a Node.js that detects ES-module syntax
in `texture2ddecoder-wasm`'s glue code.

When you bundle a Node.js app (esbuild, Rollup, webpack with `target: "node"`), keep
`texture2ddecoder-wasm` external. `initTexture()` finds the WASM files relative to its own
installed location.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Invalid value "iife" for option "worker.format"` (Vite build) | Set `worker: { format: "es" }` in `vite.config.js`. |
| `Failed to fetch dynamically imported module: .../wasm/texture2ddecoder.js?import` (Vite dev) | Pass an absolute URL: `wasmPath: new URL("/wasm/", location.href).href`. |
| `Failed to load WASM module from ...` | The two files are not at that URL. Run `npx texture2ddecoder-copy-wasm public/wasm`, and check that `<wasmPath>/texture2ddecoder.js` opens in the browser. |
| `Browser environment requires wasmPath parameter` | `initTexture()` without options only works in Node.js. |
| `Cannot find module 'unknown'` or `Cannot find module 'http://…/texture2ddecoder.js'` (Next.js) | [#171](https://github.com/fatal10110/texture2ddecoder-wasm/issues/171): keep the texture Worker out of the bundle, see [Next.js](#nextjs). |
| `decodeTexture2D: the texture decoder is not initialized` | Await `initTexture()` before the first decode. Plain formats need it too. |
| `ERR_REQUIRE_ESM` on `lzma1` | Node.js below 20.19 / 22.12 cannot `require()` it. Use `import`, or a newer Node.js. |
| `Cannot use 'import.meta' outside a module` from `initTexture()` | Node.js below 20.19. Upgrade. |
| The page freezes while a bundle loads | The reader runs on the main thread. Move it into a Worker. |
