/** @type {import('next').NextConfig} */
const nextConfig = {};

module.exports = nextConfig;

/*
Setup Instructions (CDN approach - no file copying needed!):
1. Install: npm install texture2ddecoder-wasm
2. In your 'use client' component:
   import { initialize } from 'texture2ddecoder-wasm';
   await initialize({ wasmPath: 'https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.0/wasm' });

Alternative (production with local files):
1. Install: npm install texture2ddecoder-wasm
2. Copy WASM files: npx texture2ddecoder-copy-wasm public/wasm
3. In your 'use client' component:
   import { initialize } from 'texture2ddecoder-wasm';
   await initialize({ wasmPath: '/wasm' });

Note: No special webpack configuration needed.
*/

