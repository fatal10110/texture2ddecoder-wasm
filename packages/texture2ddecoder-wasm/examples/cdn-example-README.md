# CDN Example - README

## Quick Start

This example demonstrates using `texture2ddecoder-wasm` loaded directly from jsDelivr CDN without any build tools.

### How to Run

**⚠️ Important:** You must serve this file via an HTTP server. Opening it directly with `file://` will cause CORS errors.

#### Option 1: Python HTTP Server (Recommended)

```bash
# Navigate to the examples directory
cd examples

# Start HTTP server
python -m http.server 8000

# Open in browser
# Visit: http://localhost:8000/cdn-example.html
```

#### Option 2: Node.js HTTP Server

```bash
# Install http-server globally (one time)
npm install -g http-server

# Navigate to examples directory
cd examples

# Start server
http-server -p 8000

# Visit: http://localhost:8000/cdn-example.html
```

#### Option 3: PHP Built-in Server

```bash
cd examples
php -S localhost:8000

# Visit: http://localhost:8000/cdn-example.html
```

#### Option 4: VS Code Live Server Extension

1. Install "Live Server" extension in VS Code
2. Right-click on `cdn-example.html`
3. Select "Open with Live Server"

## Features

- ✅ **Zero Installation**: No npm packages needed
- ✅ **CDN Loading**: Library and WASM loaded from jsDelivr
- ✅ **Real Texture**: Loads and decodes actual 400x400 ETC2 RGBA image
- ✅ **Interactive**: Test multiple texture formats (BC1, BC3, ETC1, ASTC)
- ✅ **Visual Output**: Displays decoded images on canvas

## What It Does

1. Loads `texture2ddecoder-wasm` from jsDelivr CDN
2. Initializes WASM module from CDN
3. Provides buttons to test different texture decoders
4. **"Load Real ETC2 Image"** button loads `compressed_etc2_rgba_400x400.bin` and displays it

## Troubleshooting

### CORS Error

```
Access to fetch at 'file://...' has been blocked by CORS policy
```

**Solution:** You're opening the file directly. Use an HTTP server as shown above.

### File Not Found (404)

Make sure you're running the server from the `examples` directory, not the root project directory.

```bash
# Wrong - from project root
python -m http.server 8000  # ❌

# Correct - from examples directory
cd examples
python -m http.server 8000  # ✅
```

## Technical Details

- **Texture Format**: ETC2 RGBA (8-bit alpha)
- **File Size**: ~160KB compressed
- **Dimensions**: 400x400 pixels
- **Output Format**: BGRA (4 bytes per pixel)
- **Decoded Size**: 640KB

## Next Steps

For a better development experience with HMR and build tools, try the [Vite CDN Example](vite-cdn-example/).
