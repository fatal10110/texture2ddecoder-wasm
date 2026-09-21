# Pure Node.js CommonJS Example

This example demonstrates how to use `texture2ddecoder-wasm` in a traditional Node.js environment using CommonJS (`require`).

## Features

- Pure Node.js with CommonJS modules
- No build tools required
- Automatic WASM initialization
- Examples of BC1, BC3 decoding
- Instructions for file I/O

## Setup

```bash
# Install dependencies
npm install

# Run the example
npm start
```

## What This Example Shows

1. **Automatic Initialization**: In Node.js, the WASM module initializes automatically on first use
2. **CommonJS Imports**: Using `require()` to import the library
3. **Basic Decoding**: Decoding BC1 (DXT1) and BC3 (DXT5) textures
4. **File Operations**: How to read texture files and save decoded output

## Usage

The example includes three demonstrations:

### 1. BC1 (DXT1) Decoding
```javascript
const { decode_bc1 } = require('texture2ddecoder-wasm');

const bc1Data = new Uint8Array([...]);
const decoded = await decode_bc1(bc1Data, width, height);
```

### 2. BC3 (DXT5) Decoding
```javascript
const { decode_bc3 } = require('texture2ddecoder-wasm');

const bc3Data = new Uint8Array([...]);
const decoded = await decode_bc3(bc3Data, width, height);
```

### 3. Working with Files
```javascript
const fs = require('fs');

// Read texture file
const textureData = fs.readFileSync('texture.bin');
const decoded = await decode_bc1(textureData, width, height);

// Save raw BGRA output
fs.writeFileSync('output.raw', decoded);
```

## Integration with Image Libraries

The decoded output is in BGRA format (4 bytes per pixel). You can use it with popular image libraries:

### Using sharp
```javascript
const sharp = require('sharp');

await sharp(decoded, {
  raw: { width, height, channels: 4 }
})
.toFile('output.png');
```

### Using jimp
```javascript
const Jimp = require('jimp');

const image = new Jimp(width, height);
image.bitmap.data = Buffer.from(decoded);
await image.writeAsync('output.png');
```

## Requirements

- Node.js >= 14.0.0
- No native dependencies - pure WebAssembly!

## Next Steps

- See the [ESM example](../nodejs-esm-example/) for modern ES6 modules
- Check the [API documentation](../../README.md) for all available decoders
- Explore browser examples for web usage
