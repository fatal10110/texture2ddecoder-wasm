import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite configuration for texture2ddecoder-wasm with CDN
export default defineConfig({
  plugins: [react()],
});

/*
 * This example uses CDN - no WASM file copying needed!
 *
 * Usage in your code:
 * import { initialize } from 'texture2ddecoder-wasm';
 * await initialize({ wasmPath: 'https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.1/wasm' });
 *
 * Alternative (for production with local files):
 * 1. Copy WASM files: npx texture2ddecoder-copy-wasm public/wasm
 * 2. Initialize: await initialize({ wasmPath: '/wasm' });
 */
