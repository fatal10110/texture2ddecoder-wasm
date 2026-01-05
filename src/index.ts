// Global module cache
let globalWasmModule: any = null;

// Detect environment
const isBrowser =
  typeof window !== "undefined" && typeof window.document !== "undefined";
const isNode =
  typeof process !== "undefined" &&
  process.versions != null &&
  process.versions.node != null;

/**
 * Load WASM module factory function (ffmpeg.wasm style - using dynamic import)
 */
async function loadWasmModuleFactory(wasmPath?: string): Promise<any> {
  if (isNode) {
    // Node.js: Use require with relative path from dist
    const path = require("path");
    const modulePath = path.join(
      __dirname,
      "..",
      "wasm",
      "texture2ddecoder.js"
    );
    const createModule = require(modulePath);

    if (typeof createModule !== "function") {
      throw new Error("Invalid WASM module: createModule is not a function");
    }

    return createModule;
  } else if (isBrowser) {
    // Browser: Use dynamic import (ffmpeg.wasm approach)
    if (wasmPath) {
      const basePath = wasmPath.endsWith(".js")
        ? wasmPath.replace(/\.js$/, "")
        : wasmPath.endsWith("/")
        ? `${wasmPath}texture2ddecoder`
        : `${wasmPath}/texture2ddecoder`;

      const moduleUrl = `${basePath}.js`;

      try {
        // Dynamic import of the WASM module (ES6 format)
        const module = await import(/* @vite-ignore */ moduleUrl);
        const createModule = module.default;

        if (typeof createModule !== "function") {
          throw new Error(
            "Invalid WASM module: createModule is not a function"
          );
        }

        return createModule;
      } catch (error) {
        throw new Error(
          `Failed to load WASM module from ${moduleUrl}\n` +
            `Error: ${
              error instanceof Error ? error.message : String(error)
            }\n` +
            "Make sure WASM files are copied to the correct location.\n" +
            "Run: npx texture2ddecoder-copy-wasm public/wasm"
        );
      }
    }

    throw new Error(
      "Browser environment requires wasmPath parameter.\n" +
        "Usage: await initialize({ wasmPath: '/wasm' })\n" +
        "Or copy WASM files: npx texture2ddecoder-copy-wasm public/wasm"
    );
  } else {
    throw new Error("Unsupported environment (not browser or Node.js)");
  }
}

/**
 * Initialize the WebAssembly module (ffmpeg.wasm-style API)
 *
 * @param options - Initialization options
 * @param options.wasmPath - Path to WASM files directory or .js file (browser only)
 * @param options.locateFile - Optional function to locate WASM binary files
 *
 * @example
 * // Node.js - auto-initialization (no parameters needed):
 * await initialize();
 *
 * // Browser - simple path (recommended):
 * await initialize({ wasmPath: '/wasm' });
 *
 * // Browser - with CDN:
 * await initialize({
 *   wasmPath: 'https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.1/wasm'
 * });
 *
 * // Browser - with custom locateFile for advanced use:
 * await initialize({
 *   wasmPath: '/wasm',
 *   locateFile: (path) => `/custom-path/${path}`
 * });
 *
 * // Or auto-initialize on first decode call (Node.js only):
 * const result = await decode_bc1(data, width, height);
 */
export async function initialize(options?: {
  wasmPath?: string;
  locateFile?: (path: string, prefix: string) => string;
}): Promise<void> {
  // Return immediately if already initialized
  if (globalWasmModule) {
    return;
  }

  try {
    // Get the module factory
    const createModule = await loadWasmModuleFactory(options?.wasmPath);

    // Initialize the module with optional locateFile
    const moduleConfig = options?.locateFile
      ? { locateFile: options.locateFile }
      : {};

    globalWasmModule = await createModule(moduleConfig);
  } catch (error) {
    globalWasmModule = null; // Reset on failure
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Ensure the module is initialized before use
 */
async function ensureInitialized(): Promise<void> {
  if (!globalWasmModule) {
    await initialize();
  }
}

/**
 * Convert WASM output to Uint8Array
 */
function wasmOutputToUint8Array(wasmResult: any): Uint8Array | null {
  if (!wasmResult || wasmResult === null) {
    return null;
  }

  try {
    const uint8Array = new Uint8Array(wasmResult.length);
    for (let i = 0; i < wasmResult.length; i++) {
      uint8Array[i] = wasmResult[i];
    }
    return uint8Array;
  } catch (error) {
    return null;
  }
}

/**
 * Decode BC1 (DXT1) compressed texture to BGRA
 */
export async function decode_bc1(
  data: Uint8Array | ArrayBuffer,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const result = globalWasmModule.decode_bc1(uint8Data, width, height);
  return wasmOutputToUint8Array(result);
}

/**
 * Decode BC3 (DXT5) compressed texture to BGRA
 */
export async function decode_bc3(
  data: Uint8Array | ArrayBuffer,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const result = globalWasmModule.decode_bc3(uint8Data, width, height);
  return wasmOutputToUint8Array(result);
}

/**
 * Decode BC4 compressed texture to BGRA
 */
export async function decode_bc4(
  data: Uint8Array | ArrayBuffer,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const result = globalWasmModule.decode_bc4(uint8Data, width, height);
  return wasmOutputToUint8Array(result);
}

/**
 * Decode BC5 compressed texture to BGRA
 */
export async function decode_bc5(
  data: Uint8Array | ArrayBuffer,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const result = globalWasmModule.decode_bc5(uint8Data, width, height);
  return wasmOutputToUint8Array(result);
}

/**
 * Decode BC6 compressed texture to BGRA
 */
export async function decode_bc6(
  data: Uint8Array | ArrayBuffer,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const result = globalWasmModule.decode_bc6(uint8Data, width, height);
  return wasmOutputToUint8Array(result);
}

/**
 * Decode BC7 compressed texture to BGRA
 */
export async function decode_bc7(
  data: Uint8Array | ArrayBuffer,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const result = globalWasmModule.decode_bc7(uint8Data, width, height);
  return wasmOutputToUint8Array(result);
}

/**
 * Decode PVRTC compressed texture to BGRA
 */
export async function decode_pvrtc(
  data: Uint8Array | ArrayBuffer,
  width: number,
  height: number,
  is2bpp: boolean = false
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const result = globalWasmModule.decode_pvrtc(
    uint8Data,
    width,
    height,
    is2bpp
  );
  return wasmOutputToUint8Array(result);
}

/**
 * Decode ETC1 compressed texture to BGRA
 */
export async function decode_etc1(
  data: Uint8Array | ArrayBuffer,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const result = globalWasmModule.decode_etc1(uint8Data, width, height);
  return wasmOutputToUint8Array(result);
}

/**
 * Decode ETC2 compressed texture to BGRA
 */
export async function decode_etc2(
  data: Uint8Array | ArrayBuffer,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const result = globalWasmModule.decode_etc2(uint8Data, width, height);
  return wasmOutputToUint8Array(result);
}

/**
 * Decode ETC2 with 1-bit alpha compressed texture to BGRA
 */
export async function decode_etc2a1(
  data: Uint8Array | ArrayBuffer,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const result = globalWasmModule.decode_etc2a1(uint8Data, width, height);
  return wasmOutputToUint8Array(result);
}

/**
 * Decode ETC2 with 8-bit alpha compressed texture to BGRA
 */
export async function decode_etc2a8(
  data: Uint8Array | ArrayBuffer,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const result = globalWasmModule.decode_etc2a8(uint8Data, width, height);
  return wasmOutputToUint8Array(result);
}

/**
 * Decode EAC R11 compressed texture to BGRA
 */
export async function decode_eacr(
  data: Uint8Array | ArrayBuffer,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const result = globalWasmModule.decode_eacr(uint8Data, width, height);
  return wasmOutputToUint8Array(result);
}

/**
 * Decode EAC R11 signed compressed texture to BGRA
 */
export async function decode_eacr_signed(
  data: Uint8Array | ArrayBuffer,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const result = globalWasmModule.decode_eacr_signed(uint8Data, width, height);
  return wasmOutputToUint8Array(result);
}

/**
 * Decode EAC RG11 compressed texture to BGRA
 */
export async function decode_eacrg(
  data: Uint8Array | ArrayBuffer,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const result = globalWasmModule.decode_eacrg(uint8Data, width, height);
  return wasmOutputToUint8Array(result);
}

/**
 * Decode EAC RG11 signed compressed texture to BGRA
 */
export async function decode_eacrg_signed(
  data: Uint8Array | ArrayBuffer,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const result = globalWasmModule.decode_eacrg_signed(uint8Data, width, height);
  return wasmOutputToUint8Array(result);
}

/**
 * Decode ATC RGB4 compressed texture to BGRA
 */
export async function decode_atc_rgb4(
  data: Uint8Array | ArrayBuffer,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const result = globalWasmModule.decode_atc_rgb4(uint8Data, width, height);
  return wasmOutputToUint8Array(result);
}

/**
 * Decode ATC RGBA8 compressed texture to BGRA
 */
export async function decode_atc_rgba8(
  data: Uint8Array | ArrayBuffer,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const result = globalWasmModule.decode_atc_rgba8(uint8Data, width, height);
  return wasmOutputToUint8Array(result);
}

/**
 * Decode ASTC compressed texture to BGRA
 * @param blockWidth - Block width (typically 4, 5, 6, 8, 10, or 12)
 * @param blockHeight - Block height (typically 4, 5, 6, 8, 10, or 12)
 */
export async function decode_astc(
  data: Uint8Array | ArrayBuffer,
  width: number,
  height: number,
  blockWidth: number,
  blockHeight: number
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const result = globalWasmModule.decode_astc(
    uint8Data,
    width,
    height,
    blockWidth,
    blockHeight
  );
  return wasmOutputToUint8Array(result);
}

/**
 * Unpack Crunch compressed data
 * Uses typed array for binary-safe data transfer
 */
export async function unpack_crunch(
  data: Uint8Array | ArrayBuffer
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  // Pass as Uint8Array directly
  const result = globalWasmModule.unpack_crunch(uint8Data);
  return wasmOutputToUint8Array(result);
}

/**
 * Unpack Unity Crunch compressed data
 * Uses typed array for binary-safe data transfer
 */
export async function unpack_unity_crunch(
  data: Uint8Array | ArrayBuffer
): Promise<Uint8Array | null> {
  await ensureInitialized();
  const uint8Data = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  // Pass as Uint8Array directly
  const result = globalWasmModule.unpack_unity_crunch(uint8Data);
  return wasmOutputToUint8Array(result);
}

// Re-export all functions as default export for convenience
export default {
  initialize,
  decode_bc1,
  decode_bc3,
  decode_bc4,
  decode_bc5,
  decode_bc6,
  decode_bc7,
  decode_pvrtc,
  decode_etc1,
  decode_etc2,
  decode_etc2a1,
  decode_etc2a8,
  decode_eacr,
  decode_eacr_signed,
  decode_eacrg,
  decode_eacrg_signed,
  decode_atc_rgb4,
  decode_atc_rgba8,
  decode_astc,
  unpack_crunch,
  unpack_unity_crunch,
};
