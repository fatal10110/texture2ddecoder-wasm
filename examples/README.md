# texture2ddecoder-wasm Examples

This directory contains example configurations for popular bundlers and frameworks.

## Available Examples

### CDN Usage (No Build Required!)

- **File:** `cdn-example.html`
- **Zero setup:** Just open in a browser!
- **Perfect for:** Quick prototypes, demos, learning

**Try it:**

```bash
# Just open the file in your browser
open examples/cdn-example.html
# or
python -m http.server 8000  # Then visit http://localhost:8000/examples/cdn-example.html
```

Uses jsDelivr CDN to load the library without any installation or build tools.

### Vite + React

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

### Next.js (App Router)

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
