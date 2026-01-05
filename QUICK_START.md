# Quick Start Guide

Get up and running with `texture2ddecoder-wasm` in 3 simple steps!

## 🚀 For Node.js Projects

```bash
# 1. Install
npm install texture2ddecoder-wasm

# 2. Use it
```

```javascript
// app.js
import { decode_bc1 } from "texture2ddecoder-wasm";
import fs from "fs";

const textureData = fs.readFileSync("texture.bin");
const decoded = await decode_bc1(textureData, 512, 512);
console.log("Decoded!", decoded);
```

**That's it!** No configuration needed for Node.js. ✅

---

## ⚡ Quick Browser Demo (CDN - No Install!)

Want to try it instantly without any setup? Use jsDelivr CDN:

```html
<!DOCTYPE html>
<html>
  <body>
    <script type="module">
      // Import from CDN
      import {
        initialize,
        decode_bc1,
      } from "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.1/dist/index.mjs";

      // Initialize with CDN path
      await initialize({
        wasmPath:
          "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.1/wasm",
      });

      console.log("Ready to decode!");
      // Use decode functions here
    </script>
  </body>
</html>
```

**See:** [examples/cdn-example.html](examples/cdn-example.html) for a complete working demo!

**Perfect for:**

- 🎯 Quick prototypes
- 🎨 Demos and testing
- 📚 Learning and exploration
- 🚀 No build tools needed

---

## 🌐 For Browser Projects (with Build Tools)

### Step 1: Install

```bash
npm install texture2ddecoder-wasm
```

### Step 2: Copy WASM Files

Copy the WASM files to your public directory:

```bash
npx texture2ddecoder-copy-wasm public/wasm
```

See [BUNDLER_GUIDE.md](BUNDLER_GUIDE.md) for more bundler configurations.

### Step 3: Initialize and Use

```javascript
import { initialize, decode_bc1 } from "texture2ddecoder-wasm";

// Initialize with path to WASM files
await initialize({ wasmPath: "/wasm" });

// Now decode textures
const decoded = await decode_bc1(textureData, 512, 512);
```

---

## 📦 Framework-Specific Quick Start

### Vite + React

```bash
npm install texture2ddecoder-wasm
npx texture2ddecoder-copy-wasm public/wasm
```

```jsx
// App.jsx
import { useEffect, useState } from "react";
import { initialize } from "texture2ddecoder-wasm";

function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    initialize({ wasmPath: "/wasm" }).then(() => setReady(true));
  }, []);

  return ready ? <YourApp /> : <Loading />;
}
```

See: [examples/vite-react-example/](examples/vite-react-example/)

### Next.js

```bash
npm install texture2ddecoder-wasm
npx texture2ddecoder-copy-wasm public/wasm
```

```tsx
// app/page.tsx
"use client";
import { useEffect } from "react";
import { initialize } from "texture2ddecoder-wasm";

export default function Page() {
  useEffect(() => {
    if (typeof window !== "undefined") {
      initialize({ wasmPath: "/wasm" });
    }
  }, []);

  return <div>Your app</div>;
}
```

See: [examples/nextjs-example/](examples/nextjs-example/)

### Create React App

```bash
npm install texture2ddecoder-wasm
npx texture2ddecoder-copy-wasm public/wasm
```

```jsx
// src/App.js
import { useEffect, useState } from "react";
import { initialize } from "texture2ddecoder-wasm";

function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    initialize({ wasmPath: "/wasm" }).then(() => setReady(true));
  }, []);

  if (!ready) return <div>Loading...</div>;
  return <div>Ready!</div>;
}
```

### SvelteKit

```bash
npm install texture2ddecoder-wasm
npx texture2ddecoder-copy-wasm static/wasm
```

```svelte
<!-- src/routes/+page.svelte -->
<script>
  import { onMount } from 'svelte';
  import { initialize } from 'texture2ddecoder-wasm';

  let ready = false;

  onMount(async () => {
    await initialize({ wasmPath: '/wasm' });
    ready = true;
  });
</script>

{#if ready}
  <div>Ready!</div>
{:else}
  <div>Loading...</div>
{/if}
```

---

## 🎯 Common Patterns

### Pattern 1: Initialize Once

```javascript
// utils/decoder.js
import { initialize } from "texture2ddecoder-wasm";

let initialized = false;

export async function ensureDecoder() {
  if (!initialized) {
    await initialize({ wasmPath: "/wasm" });
    initialized = true;
  }
}
```

```javascript
// anywhere in your app
import { ensureDecoder } from "./utils/decoder";
import { decode_bc1 } from "texture2ddecoder-wasm";

async function decodeTexture(data) {
  await ensureDecoder();
  return await decode_bc1(data, 512, 512);
}
```

### Pattern 2: Lazy Loading

```javascript
// Load decoder only when needed
button.onclick = async () => {
  const decoder = await import("texture2ddecoder-wasm");
  await decoder.initialize({ wasmPath: "/wasm" });
  const result = await decoder.decode_bc1(data, width, height);
};
```

### Pattern 3: Service/Singleton

```typescript
// TextureDecoderService.ts
import { initialize, decode_bc1 } from "texture2ddecoder-wasm";

class TextureDecoderService {
  private static instance: TextureDecoderService;
  private initialized = false;

  private constructor() {}

  static getInstance(): TextureDecoderService {
    if (!TextureDecoderService.instance) {
      TextureDecoderService.instance = new TextureDecoderService();
    }
    return TextureDecoderService.instance;
  }

  async init() {
    if (!this.initialized) {
      await initialize({ wasmPath: "/wasm" });
      this.initialized = true;
    }
  }

  async decode(data: Uint8Array, width: number, height: number) {
    await this.init();
    return await decode_bc1(data, width, height);
  }
}

export const decoderService = TextureDecoderService.getInstance();
```

---

## 🔍 Troubleshooting

### "Cannot find WASM files"

✅ **Solution:** Make sure WASM files are copied and accessible

```bash
# Check if files exist
ls public/wasm/
# Should show: texture2ddecoder.js, texture2ddecoder.wasm

# Copy if missing
npx texture2ddecoder-copy-wasm public/wasm
```

### "MIME type mismatch"

✅ **Solution:** Configure your dev server

```javascript
// vite.config.js
export default {
  server: {
    headers: {
      "Content-Type": "application/wasm",
    },
  },
};
```

### "Module not found in Node.js"

✅ **Solution:** Just call initialize without parameters

```javascript
// Node.js - don't specify path
await initialize(); // ✅ Correct

// Browser - specify path
await initialize({ wasmPath: "/wasm" }); // ✅ Correct
```

### "Works in dev but not in production"

✅ **Solution:** Ensure WASM files are included in build

```json
// package.json
{
  "scripts": {
    "prebuild": "npx texture2ddecoder-copy-wasm public/wasm",
    "build": "vite build"
  }
}
```

---

## 📚 Next Steps

- **Detailed configurations:** [BUNDLER_GUIDE.md](BUNDLER_GUIDE.md)
- **API reference:** [README.md#api-reference](README.md#api-reference)
- **Working examples:** [examples/](examples/)
- **Report issues:** [GitHub Issues](https://github.com/fatal10110/texture2ddecoder-wasm/issues)

---

## 💡 Pro Tips

1. **Initialize early** - Call `initialize()` during app startup, not right before decode
2. **Cache the module** - Only initialize once per application lifecycle
3. **Lazy load** - For large apps, dynamically import the decoder only when needed
4. **Check environment** - Use different paths for dev vs production if needed
5. **Preload WASM** - Add preload hints for faster loading:
   ```html
   <link
     rel="preload"
     href="/wasm/texture2ddecoder.wasm"
     as="fetch"
     crossorigin
   />
   ```

---

## 🎉 You're All Set!

The decoder is now ready to handle BC1-7, ETC, PVRTC, ASTC, and more texture formats at native speed with WebAssembly!

**Happy decoding! 🚀**
