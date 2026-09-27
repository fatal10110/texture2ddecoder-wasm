#!/bin/bash

# Docker build script for WebAssembly module
# No local Emscripten installation needed - just Docker

set -e

echo "================================"
echo "Building WebAssembly Module"
echo "================================"
echo ""

# Get the directory of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
OUTPUT_DIR="$PROJECT_ROOT/wasm"

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Error: Docker is not installed!"
    echo ""
    echo "Please install Docker from: https://www.docker.com/get-started"
    exit 1
fi

echo "✓ Docker is installed"
echo ""

# Create output directory
mkdir -p "$OUTPUT_DIR"

echo "Building with Docker..."
echo ""

cd "$PROJECT_ROOT"

# Pinned, not :latest, so every build uses one toolchain (#57). 4.0.7 is the
# emsdk that built the published 1.2.2: its v1.2.2 build is byte-identical to
# the tarball's wasm/. The digest keeps a re-pushed tag from changing the output.
EMSDK_IMAGE="emscripten/emsdk:4.0.7@sha256:8acec700a48dbff5250afc1e3ee545b7c002b689043ee82c277de6481a237fd7"

# Build using Docker with Emscripten
docker run --rm \
    -v "$PROJECT_ROOT:/project" \
    -v "$PROJECT_ROOT/texture2ddecoder/src:/project-src" \
    -w /project \
    "$EMSDK_IMAGE" \
    bash -c '
        echo "Compiling C++ to WebAssembly..."
        em++ \
            /project-src/Texture2DDecoder/bcn.cpp \
            /project-src/Texture2DDecoder/pvrtc.cpp \
            /project-src/Texture2DDecoder/etc.cpp \
            /project-src/Texture2DDecoder/atc.cpp \
            /project-src/Texture2DDecoder/astc.cpp \
            /project-src/Texture2DDecoder/crunch.cpp \
            /project-src/Texture2DDecoder/unitycrunch.cpp \
            /project/wasm_bindings.cpp \
            -I/project-src/Texture2DDecoder \
            -D__LITTLE_ENDIAN__=1 \
            -O3 \
            -s WASM=1 \
            -s ALLOW_MEMORY_GROWTH=1 \
            -s MODULARIZE=1 \
            -s EXPORT_NAME="createModule" \
            -s EXPORT_ES6=1 \
            -s ENVIRONMENT=web,worker,node \
            -s FILESYSTEM=0 \
            -s DISABLE_EXCEPTION_CATCHING=0 \
            -s ALLOW_TABLE_GROWTH=1 \
            -s EXPORTED_RUNTIME_METHODS=["ccall","cwrap"] \
            -s INCOMING_MODULE_JS_API=["locateFile"] \
            --bind \
            -std=c++17 \
            -o /project/wasm/texture2ddecoder.js 2>&1 | grep -v "warning:"
        
        if [ ${PIPESTATUS[0]} -eq 0 ]; then
            echo ""
            echo "✓ Build successful!"
        else
            echo ""
            echo "✗ Build failed!"
            exit 1
        fi
    '

if [ $? -eq 0 ]; then
    echo ""
    echo "Generated files:"
    echo "  - $OUTPUT_DIR/texture2ddecoder.js"
    echo "  - $OUTPUT_DIR/texture2ddecoder.wasm"
    echo ""
    echo "Next steps:"
    echo "  npm install        # Install dependencies"
    echo "  npm run build:ts   # Build TypeScript"
    echo "  npm test           # Run tests"
else
    echo ""
    echo "Build failed - see errors above"
    exit 1
fi
