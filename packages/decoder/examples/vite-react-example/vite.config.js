import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite configuration for unity-asset-reader-decoder with CDN
export default defineConfig({
  plugins: [react()],
});

/*
 * This example uses CDN - no WASM file copying needed!
 *
 * Usage in your code:
 * import { initialize } from 'unity-asset-reader-decoder';
 * await initialize({ wasmPath: 'https://cdn.jsdelivr.net/npm/unity-asset-reader-decoder@1.0.0/wasm' });
 *
 * Alternative (for production with local files):
 * 1. Copy WASM files: npx texture2ddecoder-copy-wasm public/wasm
 * 2. Initialize: await initialize({ wasmPath: '/wasm' });
 */
