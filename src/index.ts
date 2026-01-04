import { join } from "path";

// Load the WebAssembly module
let wasmModule: any = null;
let isInitialized = false;

/**
 * Initialize the WebAssembly module
 * This is called automatically on first use, but can be called manually for better control
 */
export async function initialize(): Promise<void> {
  if (isInitialized) {
    return;
  }

  try {
    // Try to load the JS glue code
    const wasmPath = join(__dirname, "..", "wasm", "texture2ddecoder.js");
    const createModule = require(wasmPath);
    wasmModule = await createModule();
    isInitialized = true;
  } catch (error) {
    throw new Error(`Failed to initialize WebAssembly module: ${error}`);
  }
}

/**
 * Ensure the module is initialized before use
 */
async function ensureInitialized(): Promise<void> {
  if (!isInitialized) {
    await initialize();
  }
}

/**
 * Convert WASM output to Buffer
 */
function wasmOutputToBuffer(wasmResult: any): Buffer | null {
  if (!wasmResult || wasmResult === null) {
    return null;
  }

  try {
    const uint8Array = new Uint8Array(wasmResult.length);
    for (let i = 0; i < wasmResult.length; i++) {
      uint8Array[i] = wasmResult[i];
    }
    return Buffer.from(uint8Array);
  } catch (error) {
    return null;
  }
}

/**
 * Decode BC1 (DXT1) compressed texture to BGRA
 */
export async function decode_bc1(
  data: Buffer,
  width: number,
  height: number
): Promise<Buffer | null> {
  await ensureInitialized();
  const result = wasmModule.decode_bc1(new Uint8Array(data), width, height);
  return wasmOutputToBuffer(result);
}

/**
 * Decode BC3 (DXT5) compressed texture to BGRA
 */
export async function decode_bc3(
  data: Buffer,
  width: number,
  height: number
): Promise<Buffer | null> {
  await ensureInitialized();
  const result = wasmModule.decode_bc3(new Uint8Array(data), width, height);
  return wasmOutputToBuffer(result);
}

/**
 * Decode BC4 compressed texture to BGRA
 */
export async function decode_bc4(
  data: Buffer,
  width: number,
  height: number
): Promise<Buffer | null> {
  await ensureInitialized();
  const result = wasmModule.decode_bc4(new Uint8Array(data), width, height);
  return wasmOutputToBuffer(result);
}

/**
 * Decode BC5 compressed texture to BGRA
 */
export async function decode_bc5(
  data: Buffer,
  width: number,
  height: number
): Promise<Buffer | null> {
  await ensureInitialized();
  const result = wasmModule.decode_bc5(new Uint8Array(data), width, height);
  return wasmOutputToBuffer(result);
}

/**
 * Decode BC6 compressed texture to BGRA
 */
export async function decode_bc6(
  data: Buffer,
  width: number,
  height: number
): Promise<Buffer | null> {
  await ensureInitialized();
  const result = wasmModule.decode_bc6(new Uint8Array(data), width, height);
  return wasmOutputToBuffer(result);
}

/**
 * Decode BC7 compressed texture to BGRA
 */
export async function decode_bc7(
  data: Buffer,
  width: number,
  height: number
): Promise<Buffer | null> {
  await ensureInitialized();
  const result = wasmModule.decode_bc7(new Uint8Array(data), width, height);
  return wasmOutputToBuffer(result);
}

/**
 * Decode PVRTC compressed texture to BGRA
 */
export async function decode_pvrtc(
  data: Buffer,
  width: number,
  height: number,
  is2bpp: boolean = false
): Promise<Buffer | null> {
  await ensureInitialized();
  const result = wasmModule.decode_pvrtc(
    new Uint8Array(data),
    width,
    height,
    is2bpp
  );
  return wasmOutputToBuffer(result);
}

/**
 * Decode ETC1 compressed texture to BGRA
 */
export async function decode_etc1(
  data: Buffer,
  width: number,
  height: number
): Promise<Buffer | null> {
  await ensureInitialized();
  const result = wasmModule.decode_etc1(new Uint8Array(data), width, height);
  return wasmOutputToBuffer(result);
}

/**
 * Decode ETC2 compressed texture to BGRA
 */
export async function decode_etc2(
  data: Buffer,
  width: number,
  height: number
): Promise<Buffer | null> {
  await ensureInitialized();
  const result = wasmModule.decode_etc2(new Uint8Array(data), width, height);
  return wasmOutputToBuffer(result);
}

/**
 * Decode ETC2 with 1-bit alpha compressed texture to BGRA
 */
export async function decode_etc2a1(
  data: Buffer,
  width: number,
  height: number
): Promise<Buffer | null> {
  await ensureInitialized();
  const result = wasmModule.decode_etc2a1(new Uint8Array(data), width, height);
  return wasmOutputToBuffer(result);
}

/**
 * Decode ETC2 with 8-bit alpha compressed texture to BGRA
 */
export async function decode_etc2a8(
  data: Buffer,
  width: number,
  height: number
): Promise<Buffer | null> {
  await ensureInitialized();
  const result = wasmModule.decode_etc2a8(new Uint8Array(data), width, height);
  return wasmOutputToBuffer(result);
}

/**
 * Decode EAC R11 compressed texture to BGRA
 */
export async function decode_eacr(
  data: Buffer,
  width: number,
  height: number
): Promise<Buffer | null> {
  await ensureInitialized();
  const result = wasmModule.decode_eacr(new Uint8Array(data), width, height);
  return wasmOutputToBuffer(result);
}

/**
 * Decode EAC R11 signed compressed texture to BGRA
 */
export async function decode_eacr_signed(
  data: Buffer,
  width: number,
  height: number
): Promise<Buffer | null> {
  await ensureInitialized();
  const result = wasmModule.decode_eacr_signed(
    new Uint8Array(data),
    width,
    height
  );
  return wasmOutputToBuffer(result);
}

/**
 * Decode EAC RG11 compressed texture to BGRA
 */
export async function decode_eacrg(
  data: Buffer,
  width: number,
  height: number
): Promise<Buffer | null> {
  await ensureInitialized();
  const result = wasmModule.decode_eacrg(new Uint8Array(data), width, height);
  return wasmOutputToBuffer(result);
}

/**
 * Decode EAC RG11 signed compressed texture to BGRA
 */
export async function decode_eacrg_signed(
  data: Buffer,
  width: number,
  height: number
): Promise<Buffer | null> {
  await ensureInitialized();
  const result = wasmModule.decode_eacrg_signed(
    new Uint8Array(data),
    width,
    height
  );
  return wasmOutputToBuffer(result);
}

/**
 * Decode ATC RGB4 compressed texture to BGRA
 */
export async function decode_atc_rgb4(
  data: Buffer,
  width: number,
  height: number
): Promise<Buffer | null> {
  await ensureInitialized();
  const result = wasmModule.decode_atc_rgb4(
    new Uint8Array(data),
    width,
    height
  );
  return wasmOutputToBuffer(result);
}

/**
 * Decode ATC RGBA8 compressed texture to BGRA
 */
export async function decode_atc_rgba8(
  data: Buffer,
  width: number,
  height: number
): Promise<Buffer | null> {
  await ensureInitialized();
  const result = wasmModule.decode_atc_rgba8(
    new Uint8Array(data),
    width,
    height
  );
  return wasmOutputToBuffer(result);
}

/**
 * Decode ASTC compressed texture to BGRA
 * @param blockWidth - Block width (typically 4, 5, 6, 8, 10, or 12)
 * @param blockHeight - Block height (typically 4, 5, 6, 8, 10, or 12)
 */
export async function decode_astc(
  data: Buffer,
  width: number,
  height: number,
  blockWidth: number,
  blockHeight: number
): Promise<Buffer | null> {
  await ensureInitialized();
  const result = wasmModule.decode_astc(
    new Uint8Array(data),
    width,
    height,
    blockWidth,
    blockHeight
  );
  return wasmOutputToBuffer(result);
}

/**
 * Unpack Crunch compressed data
 * Uses typed array for binary-safe data transfer
 */
export async function unpack_crunch(data: Buffer): Promise<Buffer | null> {
  await ensureInitialized();
  // Pass as Uint8Array directly
  const result = wasmModule.unpack_crunch(new Uint8Array(data));
  return wasmOutputToBuffer(result);
}

/**
 * Unpack Unity Crunch compressed data
 * Uses typed array for binary-safe data transfer
 */
export async function unpack_unity_crunch(
  data: Buffer
): Promise<Buffer | null> {
  await ensureInitialized();
  // Pass as Uint8Array directly
  const result = wasmModule.unpack_unity_crunch(new Uint8Array(data));
  return wasmOutputToBuffer(result);
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
