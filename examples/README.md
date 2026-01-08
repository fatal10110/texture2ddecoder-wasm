# texture2ddecoder-wasm Examples

This directory contains example configurations for popular bundlers and frameworks.

## Available Examples

### Node.js Examples

#### Pure Node.js (CommonJS)

- **Directory:** `nodejs-commonjs-example/`
- **Files:**
  - `index.js` - Pure Node.js example using `require()`
  - `package.json` - CommonJS configuration
- **Perfect for:** Traditional Node.js projects, backend services

**Try it:**

```bash
cd examples/nodejs-commonjs-example
npm install
npm start
```

Features automatic WASM initialization and demonstrates BC1/BC3 decoding with file I/O.

#### Node.js ESM

- **Directory:** `nodejs-esm-example/`
- **Files:**
  - `index.mjs` - Modern Node.js example using `import/export`
  - `package.json` - ESM configuration with `"type": "module"`
- **Perfect for:** Modern Node.js projects, TypeScript projects

**Try it:**

```bash
cd examples/nodejs-esm-example
npm install
npm start
```

Features BC1, BC3, ETC2, and ASTC decoding examples with modern ES6 syntax.

### Browser Examples

#### Vite + CDN (Recommended)

- **Directory:** `vite-cdn-example/`
- **Files:**
  - `index.html` - Main HTML file
  - `src/main.js` - Application logic with CDN imports
  - `vite.config.js` - Vite configuration
  - `public/compressed_etc2_rgba_400x400.bin` - Real ETC2 RGBA texture (400x400)
- **Perfect for:** Modern development with fast HMR and CDN

**Try it:**

```bash
cd examples/vite-cdn-example
npm install
npm run dev
```

Features Vite dev server, CDN loading, real texture decoding with canvas display, and optimized production builds.

#### CDN Usage (No Build Required!)

- **File:** `cdn-example.html`
- **Zero setup:** No npm install needed!
- **Perfect for:** Quick prototypes, minimal setup

**Try it:**

```bash
# Serve with HTTP server (required for file loading)
cd examples
python -m http.server 8000

# Then visit: http://localhost:8000/cdn-example.html
```

**⚠️ Important:** Must be served via HTTP server (not `file://`) to avoid CORS errors when loading the texture file.

Uses jsDelivr CDN to load the library without any installation or build tools.

#### Vite + React

- **Directory:** `vite-react-example/`
- **Files:**
  - `vite.config.js` - Simple Vite configuration
  - `src/App.jsx` - React component example using CDN

**Setup:**

```bash
npm install vite @vitejs/plugin-react
npm install texture2ddecoder-wasm
```

**Note:** This example uses CDN - no WASM file copying needed!

#### Next.js (App Router)

- **Directory:** `nextjs-example/`
- **Files:**
  - `next.config.js` - Next.js configuration
  - `app/texture-viewer/page.tsx` - Client component example using CDN

**Setup:**

```bash
npm install texture2ddecoder-wasm
```

**Note:** This example uses CDN - no WASM file copying needed!

## Usage Instructions

### CDN Approach (Recommended for Development)

All examples now use CDN by default - no WASM file copying needed!

1. **Install the package** via npm

   ```bash
   npm install texture2ddecoder-wasm
   ```

2. **Initialize with CDN:**

   ```typescript
   import { initialize } from "texture2ddecoder-wasm";

   await initialize({
     wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.1/wasm",
   });
   ```

3. **Use decode functions** after initialization

### Local Files Approach (For Production)

If you prefer to serve WASM files locally:

1. **Install the package** via npm
2. **Copy WASM files** to your public directory:
   ```bash
   npx texture2ddecoder-copy-wasm public/wasm
   ```
3. **Initialize with local path:**

   ```typescript
   import { initialize } from "texture2ddecoder-wasm";

   await initialize({ wasmPath: "/wasm" });
   ```

## General Pattern

**CDN Benefits:**

- ✅ No file copying needed
- ✅ Fastest setup time
- ✅ Globally cached by CDN
- ✅ Perfect for development and prototyping

**Local Files Benefits:**

- ✅ Faster loading (same domain)
- ✅ Works offline
- ✅ No external dependencies
- ✅ Better for production

## Additional Resources

- [Complete Bundler Guide](../BUNDLER_GUIDE.md) - Comprehensive setup for all bundlers
- [Main README](../README.md) - API documentation and usage guide
- [npm package](https://www.npmjs.com/package/texture2ddecoder-wasm)

## Contributing Examples

Have a working configuration for another bundler? Please submit a PR!

Popular frameworks we'd love examples for:

- Webpack 5
- Create React App
- SvelteKit
- Angular
- Remix
- Astro
- Nuxt 3
- Deno
- Bun
