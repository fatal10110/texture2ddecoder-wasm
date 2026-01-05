# texture2ddecoder-wasm

[![npm version](https://img.shields.io/npm/v/texture2ddecoder-wasm.svg)](https://www.npmjs.com/package/texture2ddecoder-wasm)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen.svg)](https://nodejs.org/)

A WebAssembly-based JavaScript/TypeScript library for decoding compressed texture formats. This project was inspired by [K0lb3's texture2ddecoder](https://github.com/K0lb3/texture2ddecoder) Python wrapper and brings the same powerful texture decoding capabilities to Node.js and web environments through WebAssembly.

Built on top of [Perfare](https://github.com/Perfare)'s [Texture2DDecoder](https://github.com/Perfare/AssetStudio/tree/master/Texture2DDecoder) from AssetStudio, with cross-platform WebAssembly bindings for JavaScript/TypeScript environments.

## Features

- **Zero native dependencies** - Pure WebAssembly, works on any platform
- **Comprehensive format support** - Decode BC1-7, ETC1/2, PVRTC, ASTC, ATC, EAC, and Crunch formats
- **TypeScript support** - Full type definitions included
- **Unity Asset support** - Decode textures from Unity game assets
- **Fast performance** - Native-speed decoding via WebAssembly

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

## Usage

### Basic Example

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
  // decoded is a Buffer containing BGRA pixel data
  // Use with image libraries like sharp, jimp, etc.
  console.log("Decoded successfully!");
}
```

### Manual Initialization

```typescript
import { initialize, decode_bc3 } from "texture2ddecoder-wasm";

// Initialize manually for better control
await initialize();

// Now decode functions will use the already-initialized module
const result = await decode_bc3(data, width, height);
```

## API Reference

All decode functions return a `Promise<Buffer | null>`. The returned Buffer contains BGRA pixel data (4 bytes per pixel).

### BC Decoders

#### `decode_bc1(data: Buffer, width: number, height: number): Promise<Buffer | null>`

Decodes BC1 (DXT1) compressed texture to BGRA.

#### `decode_bc3(data: Buffer, width: number, height: number): Promise<Buffer | null>`

Decodes BC3 (DXT5) compressed texture to BGRA.

#### `decode_bc4(data: Buffer, width: number, height: number): Promise<Buffer | null>`

Decodes BC4 compressed texture to BGRA.

#### `decode_bc5(data: Buffer, width: number, height: number): Promise<Buffer | null>`

Decodes BC5 compressed texture to BGRA.

#### `decode_bc6(data: Buffer, width: number, height: number): Promise<Buffer | null>`

Decodes BC6 compressed texture to BGRA.

#### `decode_bc7(data: Buffer, width: number, height: number): Promise<Buffer | null>`

Decodes BC7 compressed texture to BGRA.

### ETC Decoders

#### `decode_etc1(data: Buffer, width: number, height: number): Promise<Buffer | null>`

Decodes ETC1 compressed texture to BGRA.

#### `decode_etc2(data: Buffer, width: number, height: number): Promise<Buffer | null>`

Decodes ETC2 compressed texture to BGRA.

#### `decode_etc2a1(data: Buffer, width: number, height: number): Promise<Buffer | null>`

Decodes ETC2 with 1-bit alpha compressed texture to BGRA.

#### `decode_etc2a8(data: Buffer, width: number, height: number): Promise<Buffer | null>`

Decodes ETC2 with 8-bit alpha compressed texture to BGRA.

### EAC Decoders

#### `decode_eacr(data: Buffer, width: number, height: number): Promise<Buffer | null>`

Decodes EAC R11 compressed texture to BGRA.

#### `decode_eacr_signed(data: Buffer, width: number, height: number): Promise<Buffer | null>`

Decodes EAC R11 signed compressed texture to BGRA.

#### `decode_eacrg(data: Buffer, width: number, height: number): Promise<Buffer | null>`

Decodes EAC RG11 compressed texture to BGRA.

#### `decode_eacrg_signed(data: Buffer, width: number, height: number): Promise<Buffer | null>`

Decodes EAC RG11 signed compressed texture to BGRA.

### Other Format Decoders

#### `decode_pvrtc(data: Buffer, width: number, height: number, is2bpp: boolean = false): Promise<Buffer | null>`

Decodes PVRTC compressed texture to BGRA.

- `is2bpp`: Set to `true` for 2 bits-per-pixel mode, `false` for 4 bits-per-pixel (default)

#### `decode_astc(data: Buffer, width: number, height: number, blockWidth: number, blockHeight: number): Promise<Buffer | null>`

Decodes ASTC compressed texture to BGRA.

- `blockWidth`: Block width (typically 4, 5, 6, 8, 10, or 12)
- `blockHeight`: Block height (typically 4, 5, 6, 8, 10, or 12)

#### `decode_atc_rgb4(data: Buffer, width: number, height: number): Promise<Buffer | null>`

Decodes ATC RGB4 compressed texture to BGRA.

#### `decode_atc_rgba8(data: Buffer, width: number, height: number): Promise<Buffer | null>`

Decodes ATC RGBA8 compressed texture to BGRA.

### Crunch Decoders

#### `unpack_crunch(data: Buffer): Promise<Buffer | null>`

Unpacks Crunch compressed data.

#### `unpack_unity_crunch(data: Buffer): Promise<Buffer | null>`

Unpacks Unity Crunch compressed data.

### Initialization

#### `initialize(): Promise<void>`

Manually initialize the WebAssembly module. This is called automatically on first use of any decode function, but can be called manually for better control over initialization timing.

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
- **Operating Systems**: Windows, macOS, Linux (WebAssembly is platform-independent)
