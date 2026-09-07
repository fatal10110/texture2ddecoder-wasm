# texture2ddecoder-wasm

[![npm version](https://img.shields.io/npm/v/texture2ddecoder-wasm.svg)](https://www.npmjs.com/package/texture2ddecoder-wasm)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen.svg)](https://nodejs.org/)

**Zero-native-deps WebAssembly decoder for BC / ETC / ASTC / PVRTC / Crunch** (Unity assets included). Runs in the browser and Node.js — no native toolchain.

```bash
npm install texture2ddecoder-wasm
```

Try a complete Node.js example: save this as `decode.mjs` and run `node decode.mjs`.

```javascript
import { decode_bc1 } from "texture2ddecoder-wasm";

// One BC1 block representing a solid red 4 x 4 texture; no input file needed.
const data = new Uint8Array([0, 248, 0, 0, 0, 0, 0, 0]);
const decoded = await decode_bc1(data, 4, 4);
if (!decoded) throw new Error("Texture decoding failed");
console.log(decoded.length); // 64 bytes: 4 x 4 pixels x 4 channels
console.log([...decoded.slice(0, 4)]); // [0, 0, 255, 255] — BGRA, not RGBA
```

**Live demo:** [fatal10110.github.io/texture2ddecoder-wasm](https://fatal10110.github.io/texture2ddecoder-wasm/)

For real assets, supply compressed texture payloads and the matching dimensions/format. Browser initialization and WASM asset paths are covered in the [Quick Start Guide](QUICK_START.md).

Same codecs as [Perfare's Texture2DDecoder](https://github.com/Perfare/AssetStudio/tree/master/Texture2DDecoder) (AssetStudio) and the formats covered by [K0lb3/texture2ddecoder](https://github.com/K0lb3/texture2ddecoder) (Python + native) — this package ships them as WASM so you can decode in **browser + Node** without native deps.

## Features

- **Zero native dependencies** - Pure WebAssembly, works on any platform
- **Browser and Node.js compatible** - Works in both browser and Node.js environments
- **Comprehensive format support** - Decode BC1-7, ETC1/2, PVRTC, ASTC, ATC, EAC, and Crunch formats
- **TypeScript support** - Full type definitions included
- **Unity Asset support** - Decode textures from Unity game assets
- **WebAssembly codecs** - Runs the compiled Texture2DDecoder codecs in JavaScript environments

## Supported Formats

### BCn (Block Compression)

- BC1 (DXT1) - RGB compression
- BC3 (DXT5) - RGBA compression
- BC4 - Single channel compression
- BC5 - Dual channel compression
- BC6 - HDR compression
- BC7 - High quality compression

### ETC (Ericsson Texture Compression)

- ETC1 - RGB compression
- ETC2 - Improved RGB compression
- ETC2A1 - RGB + 1-bit alpha
- ETC2A8 - RGB + 8-bit alpha

### EAC (Ericsson Alpha Compression)

- EAC R11 - Single channel
- EAC R11 (signed) - Single channel signed
- EAC RG11 - Dual channel
- EAC RG11 (signed) - Dual channel signed

### Other Formats

- **PVRTC** - PowerVR Texture Compression (2bpp and 4bpp)
- **ASTC** - Adaptive Scalable Texture Compression (various block sizes)
- **ATC** - AMD Texture Compression (RGB4 and RGBA8)
- **Crunch** - Crunch compressed textures
- **Unity Crunch** - Unity's variant of Crunch compression

## Installation

```bash
npm install texture2ddecoder-wasm
```

or

```bash
yarn add texture2ddecoder-wasm
```

> 🚀 **New to this library?** Check out the [Quick Start Guide](QUICK_START.md) for the fastest way to get running!  
> 📖 **Need bundler setup?** See the [Complete Bundler Guide](BUNDLER_GUIDE.md) for detailed configurations.

## Usage

> 💡 **See the [examples/](examples/) directory for complete working configurations for popular frameworks!**

### Node.js Usage

```typescript
import { decode_astc } from "texture2ddecoder-wasm";
import * as fs from "fs";

// Load compressed texture data
const data = fs.readFileSync("texture.astc");

// Decode ASTC texture
const width = 512;
const height = 512;
const blockWidth = 4;
const blockHeight = 4;

const decoded = await decode_astc(data, width, height, blockWidth, blockHeight);

if (decoded) {
  // decoded is a Uint8Array containing BGRA pixel data
  // Use with image libraries like sharp, jimp, etc.
  console.log("Decoded successfully!");
}
```

### Browser Usage with Modern Bundlers (Webpack, Vite, etc.)

For modern frameworks (React, Vue, Svelte, Next.js, etc.), you can use CDN for quick setup or local files for production:

#### Quick Start - Using CDN (Recommended for Development)

```typescript
import { initialize, decode_bc1 } from "texture2ddecoder-wasm";

// Initialize with CDN
await initialize({
  wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.1/wasm",
});

// Load and decode texture
const response = await fetch("texture.bin");
const data = new Uint8Array(await response.arrayBuffer());
const decoded = await decode_bc1(data, 512, 512);
```

**Benefits:**

- ✅ No manual file copying needed
- ✅ Fastest setup time
- ✅ Cached by CDN globally
- ✅ Perfect for prototyping and development

#### Production Setup - Using Local Files

For production, copy WASM files to your public directory:

```bash
npx texture2ddecoder-copy-wasm public/wasm
```

```typescript
import { initialize, decode_bc1 } from "texture2ddecoder-wasm";

// Initialize with local path
await initialize({ wasmPath: "/wasm" });

const decoded = await decode_bc1(data, 512, 512);
```

**Benefits:**

- ✅ Faster loading (same domain)
- ✅ Works offline
- ✅ No external dependencies

**Framework-Specific Examples:**

**Vite + React:**

```typescript
import { initialize, decode_bc1 } from "texture2ddecoder-wasm";

// Development: Use CDN
await initialize({
  wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.1/wasm",
});

// Production: Use local files (copy with: npx texture2ddecoder-copy-wasm public/wasm)
await initialize({ wasmPath: "/wasm" });
```

**Next.js:**

```typescript
// In a 'use client' component
import { initialize, decode_bc1 } from "texture2ddecoder-wasm";

// Development: Use CDN
await initialize({
  wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.1/wasm",
});

// Production: Use local files (copy with: npx texture2ddecoder-copy-wasm public/wasm)
await initialize({ wasmPath: "/wasm" });
```

**Webpack 5:**

```typescript
import { initialize, decode_bc1 } from "texture2ddecoder-wasm";

// Development: Use CDN
await initialize({
  wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.1/wasm",
});

// Production: Use local files (copy with: npx texture2ddecoder-copy-wasm public/wasm)
await initialize({ wasmPath: "/wasm" });
```

### CDN Usage (jsDelivr)

You can use the library directly from jsDelivr CDN without any installation:

```html
<!DOCTYPE html>
<html>
  <head>
    <title>Texture Decoder - CDN Example</title>
  </head>
  <body>
    <h1>Decode Textures from CDN</h1>
    <div id="status">Loading...</div>

    <script type="module">
      // Import from jsDelivr CDN
      import {
        initialize,
        decode_bc1,
      } from "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.1/dist/index.mjs";

      // Initialize with CDN path for WASM files
      await initialize({
        wasmPath:
          "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.1/wasm",
      });

      document.getElementById("status").textContent = "✓ Ready to decode!";

      // Now you can use any decode function
      // const decoded = await decode_bc1(textureData, width, height);
    </script>
  </body>
</html>
```

**Benefits:**

- ✅ Zero build setup
- ✅ No npm install needed
- ✅ Cached by jsDelivr globally
- ✅ Perfect for quick prototypes

**Production tip:** Pin to a specific version (e.g., `@1.2.1`) instead of `@latest` for stability.

**Complete working example:** See [examples/cdn-example.html](examples/cdn-example.html) for a full interactive demo.

### Manual Initialization

```typescript
import { initialize, decode_bc3 } from "texture2ddecoder-wasm";

// Node.js - no parameter needed (auto-detects module location)
await initialize();

// Browser - provide path to WASM files
await initialize({ wasmPath: "/wasm" });

// Browser with CDN - provide full CDN URL
await initialize({
  wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.1/wasm",
});

// Browser with custom locateFile for advanced use cases
await initialize({
  wasmPath: "/wasm",
  locateFile: (path) => `/custom-path/${path}`,
});

// Now decode functions will use the already-initialized module
const result = await decode_bc3(data, width, height);
```

## API Reference

All decode functions accept `Uint8Array | ArrayBuffer` as input and return a `Promise<Uint8Array | null>`. The returned Uint8Array contains BGRA pixel data (4 bytes per pixel).

**Note:** In Node.js, you can still pass `Buffer` objects (which extend `Uint8Array`) and receive `Uint8Array` results that are compatible with Buffer operations.

### BC Decoders

#### `decode_bc1(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes BC1 (DXT1) compressed texture to BGRA.

#### `decode_bc3(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes BC3 (DXT5) compressed texture to BGRA.

#### `decode_bc4(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes BC4 compressed texture to BGRA.

#### `decode_bc5(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes BC5 compressed texture to BGRA.

#### `decode_bc6(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes BC6 compressed texture to BGRA.

#### `decode_bc7(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes BC7 compressed texture to BGRA.

### ETC Decoders

#### `decode_etc1(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes ETC1 compressed texture to BGRA.

#### `decode_etc2(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes ETC2 compressed texture to BGRA.

#### `decode_etc2a1(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes ETC2 with 1-bit alpha compressed texture to BGRA.

#### `decode_etc2a8(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes ETC2 with 8-bit alpha compressed texture to BGRA.

### EAC Decoders

#### `decode_eacr(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes EAC R11 compressed texture to BGRA.

#### `decode_eacr_signed(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes EAC R11 signed compressed texture to BGRA.

#### `decode_eacrg(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes EAC RG11 compressed texture to BGRA.

#### `decode_eacrg_signed(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes EAC RG11 signed compressed texture to BGRA.

### Other Format Decoders

#### `decode_pvrtc(data: Uint8Array | ArrayBuffer, width: number, height: number, is2bpp: boolean = false): Promise<Uint8Array | null>`

Decodes PVRTC compressed texture to BGRA.

- `is2bpp`: Set to `true` for 2 bits-per-pixel mode, `false` for 4 bits-per-pixel (default)

#### `decode_astc(data: Uint8Array | ArrayBuffer, width: number, height: number, blockWidth: number, blockHeight: number): Promise<Uint8Array | null>`

Decodes ASTC compressed texture to BGRA.

- `blockWidth`: Block width (typically 4, 5, 6, 8, 10, or 12)
- `blockHeight`: Block height (typically 4, 5, 6, 8, 10, or 12)

#### `decode_atc_rgb4(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes ATC RGB4 compressed texture to BGRA.

#### `decode_atc_rgba8(data: Uint8Array | ArrayBuffer, width: number, height: number): Promise<Uint8Array | null>`

Decodes ATC RGBA8 compressed texture to BGRA.

### Crunch Decoders

#### `unpack_crunch(data: Uint8Array | ArrayBuffer): Promise<Uint8Array | null>`

Unpacks Crunch compressed data.

#### `unpack_unity_crunch(data: Uint8Array | ArrayBuffer): Promise<Uint8Array | null>`

Unpacks Unity Crunch compressed data.

### Initialization

#### `initialize(options?: { wasmPath?: string; locateFile?: (path: string, prefix: string) => string }): Promise<void>`

Manually initialize the WebAssembly module. This is called automatically on first use of any decode function in Node.js, but must be called explicitly in browser environments.

**Parameters:**

- `options.wasmPath` - (Browser required) Path or URL to the directory containing WASM files
- `options.locateFile` - (Optional) Custom function to locate WASM binary files for advanced use cases

**Node.js Example:**

```typescript
await initialize(); // Auto-detects and loads from dist/wasm/
```

**Browser Examples:**

```typescript
// Basic usage - local path
await initialize({ wasmPath: "/wasm" });

// With CDN
await initialize({
  wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.1/wasm",
});

// With custom locateFile for advanced scenarios
await initialize({
  wasmPath: "/wasm",
  locateFile: (path) => `https://cdn.example.com/custom/${path}`,
});
```

**Framework Integration:**
This approach works seamlessly with:

- ✅ React / Next.js
- ✅ Vue / Nuxt
- ✅ Svelte / SvelteKit
- ✅ Webpack 5 / Vite / Rollup
- ✅ Server-Side Rendering (SSR) - Call `initialize()` in client-side code only

## Building from Source

### Prerequisites

- **Node.js** ≥14.0.0
- **Docker** - Required for building the WebAssembly module (no local Emscripten installation needed)

Install Docker from: https://www.docker.com/get-started

### Build Steps

```bash
# Clone the repository
git clone https://github.com/fatal10110/texture2ddecoder-wasm.git
cd texture2ddecoder-wasm

# Install dependencies
npm install

# Build WebAssembly module (uses Docker + Emscripten)
npm run build:wasm

# Build TypeScript
npm run build:ts

# Or build both at once
npm run build

# Run tests
npm test
```

### Build Scripts

- `npm run build:wasm` - Build the WebAssembly module using Docker and Emscripten
- `npm run build:ts` - Compile TypeScript
- `npm run build` - Build both WASM and TypeScript
- `npm test` - Run tests

### About the Docker Build

The WebAssembly build uses Docker with the official Emscripten SDK image, which means:

- No need to install Emscripten locally
- Consistent build environment across all platforms
- Automatic compiler toolchain setup
- Works on Windows, macOS, and Linux

The build script ([scripts/build-wasm.sh](scripts/build-wasm.sh)) automatically:

1. Checks if Docker is installed
2. Pulls the latest Emscripten SDK image
3. Compiles the C++ texture decoders to WebAssembly
4. Generates optimized WASM and JavaScript glue code

## License & Credits

This project is licensed under MIT.

Inspired by [K0lb3's texture2ddecoder](https://github.com/K0lb3/texture2ddecoder) Python library.

The texture compression codecs were derived from the following sources:

| Codec          | License       | Source                                                                                                                                |
| -------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| ATC            | MIT           | [Perfare/AssetStudio - Texture2DDecoderNative/atc.cpp](https://github.com/Perfare/AssetStudio/tree/master/atc.cpp)                    |
| ASTC           | MIT           | [Ishotihadus/mikunyan - ext/decoders/native/astc.c](https://github.com/Ishotihadus/mikunyan/tree/master/ext/decoders/native/astc.c)   |
| BCn            | MIT           | [Perfare/AssetStudio - Texture2DDecoderNative/bcn.cpp](https://github.com/Perfare/AssetStudio/tree/master/bcn.cpp)                    |
| ETC            | MIT           | [Ishotihadus/mikunyan - ext/decoders/native/etc.c](https://github.com/Ishotihadus/mikunyan/tree/master/ext/decoders/native/etc.c)     |
| f16            | MIT           | [Maratyszcza/FP16](https://github.com/Maratyszcza/FP16)                                                                               |
| PVRTC          | MIT           | [Ishotihadus/mikunyan - ext/decoders/native/pvrtc.c](https://github.com/Ishotihadus/mikunyan/tree/master/ext/decoders/native/pvrtc.c) |
| Crunch         | PUBLIC DOMAIN | [BinomialLLC/crunch](https://github.com/BinomialLLC/crunch)                                                                           |
| Crunch (Unity) | ZLIB          | [Unity-Technologies/crunch](https://github.com/Unity-Technologies/crunch)                                                             |

## Related Projects

- [texture2ddecoder](https://github.com/K0lb3/texture2ddecoder) - Python wrapper (original inspiration)
- [AssetStudio](https://github.com/Perfare/AssetStudio) - Original C++ texture decoders
- [UnityPy](https://github.com/K0lb3/UnityPy) - Unity asset extraction tool

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) to learn about our development process, how to propose bugfixes and improvements, and how to build and test your changes.

### Quick Start for Contributors

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/texture2ddecoder-wasm.git`
3. Initialize submodules: `git submodule update --init --recursive`
4. Install dependencies: `npm install`
5. Build the project: `npm run build`
6. Run tests: `npm test`
7. Create a branch, make your changes, and submit a Pull Request

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

## Platform Support

- **Node.js**: ≥14.0.0
- **Browsers**: Modern browsers with WebAssembly support (Chrome, Firefox, Safari, Edge)
- **Operating Systems**: Windows, macOS, Linux (WebAssembly is platform-independent)

### Browser Compatibility

The package works in all modern browsers that support:

- WebAssembly
- ES6 Modules (or use a bundler like Webpack/Vite)
- Typed Arrays (Uint8Array)

Tested and working in:

- Chrome/Edge 57+
- Firefox 52+
- Safari 11+
- Opera 44+

## Examples

See [browser-example.html](browser-example.html) for a complete browser usage example.
