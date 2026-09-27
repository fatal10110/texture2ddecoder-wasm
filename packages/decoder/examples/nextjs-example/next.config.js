/** @type {import('next').NextConfig} */
const nextConfig = {};

module.exports = nextConfig;

/*
Setup Instructions (CDN approach - no file copying needed!):
1. Install: npm install unity-asset-reader-decoder
2. In your 'use client' component:
   import { initialize } from 'unity-asset-reader-decoder';
   await initialize({ wasmPath: 'https://cdn.jsdelivr.net/npm/unity-asset-reader-decoder@1.0.0/wasm' });

Alternative (production with local files):
1. Install: npm install unity-asset-reader-decoder
2. Copy WASM files: npx texture2ddecoder-copy-wasm public/wasm
3. In your 'use client' component:
   import { initialize } from 'unity-asset-reader-decoder';
   await initialize({ wasmPath: '/wasm' });

Note: No special webpack configuration needed.
*/
