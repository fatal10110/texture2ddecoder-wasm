# Node.js ESM Example

This example demonstrates how to use `texture2ddecoder-wasm` in a modern Node.js environment using ES6 modules (`import/export`).

## Features

- Modern ES6 modules (ESM)
- No build tools required
- Automatic WASM initialization
- Examples of BC1, BC3, ETC2, and ASTC decoding
- Instructions for file I/O with async/await

## Setup

```bash
# Install dependencies
npm install

# Run the example
npm start
```

## What This Example Shows

1. **Automatic Initialization**: In Node.js, the WASM module initializes automatically on first use
2. **ES6 Imports**: Using `import` to import the library
3. **Multiple Decoders**: Demonstrates BC1, BC3, ETC2, and ASTC texture decoding
4. **File Operations**: How to read texture files and save decoded output using modern Node.js APIs

## Usage

The example includes five demonstrations:

### 1. BC1 (DXT1) Decoding
```javascript
import { decode_bc1 } from 'texture2ddecoder-wasm';

const bc1Data = new Uint8Array([...]);
const decoded = await decode_bc1(bc1Data, width, height);
```

### 2. BC3 (DXT5) Decoding
```javascript
import { decode_bc3 } from 'texture2ddecoder-wasm';

const bc3Data = new Uint8Array([...]);
const decoded = await decode_bc3(bc3Data, width, height);
```

### 3. ETC2 Decoding
```javascript
import { decode_etc2 } from 'texture2ddecoder-wasm';

const etc2Data = new Uint8Array([...]);
const decoded = await decode_etc2(etc2Data, width, height);
```

### 4. ASTC Decoding
```javascript
import { decode_astc } from 'texture2ddecoder-wasm';

const astcData = new Uint8Array([...]);
const decoded = await decode_astc(astcData, width, height, blockWidth, blockHeight);
```

### 5. Working with Files
```javascript
import fs from 'fs';

// Read texture file
const textureData = fs.readFileSync('texture.bin');
const decoded = await decode_bc1(textureData, width, height);

// Save raw BGRA output
fs.writeFileSync('output.raw', decoded);
```

## Integration with Image Libraries

The decoded output is in BGRA format (4 bytes per pixel). You can use it with popular image libraries:

### Using sharp (ESM)
```javascript
import sharp from 'sharp';

await sharp(decoded, {
  raw: { width, height, channels: 4 }
})
.toFile('output.png');
```

### Using jimp (ESM)
```javascript
import Jimp from 'jimp';

const image = new Jimp(width, height);
image.bitmap.data = Buffer.from(decoded);
await image.writeAsync('output.png');
```

## Supported Formats

This library supports all major texture compression formats:

- **BC1-7** (DXT1, DXT5, etc.) - DirectX texture compression
- **ETC1/2** - Ericsson Texture Compression
- **PVRTC** - PowerVR Texture Compression
- **ASTC** - Adaptive Scalable Texture Compression
- **ATC** - AMD Texture Compression
- **EAC** - Ericsson Alpha Compression
- **Crunch** - Crunch and Unity Crunch compression

## Requirements

- Node.js >= 14.0.0 with ES6 module support
- No native dependencies - pure WebAssembly!

## Key Differences from CommonJS

1. **File Extension**: Uses `.mjs` extension (or `.js` with `"type": "module"` in package.json)
2. **Import Syntax**: Uses `import` instead of `require()`
3. **Top-Level Await**: Can use `await` at the top level
4. **Module Type**: `package.json` specifies `"type": "module"`

## Next Steps

- See the [CommonJS example](../nodejs-commonjs-example/) for traditional Node.js usage
- Check the [API documentation](../../README.md) for all available decoders
- Explore browser examples for web usage
