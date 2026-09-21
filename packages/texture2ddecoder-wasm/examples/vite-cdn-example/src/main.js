// Import from jsDelivr CDN
import {
  initialize,
  decode_bc1,
  decode_bc3,
  decode_etc1,
  decode_astc,
  decode_etc2a8,
} from "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.1/dist/index.mjs";

const statusDiv = document.getElementById("status");
const controlsDiv = document.getElementById("controls");
const resultDiv = document.getElementById("result");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

let isReady = false;

// Initialize the WASM module
async function init() {
  try {
    // Point to WASM files on jsDelivr CDN
    await initialize({
      wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.1/wasm",
    });

    statusDiv.className = "status success";
    statusDiv.innerHTML =
      "✅ Ready! WebAssembly module loaded from CDN successfully.";

    controlsDiv.style.display = "block";
    isReady = true;

    console.log("texture2ddecoder-wasm initialized successfully!");
  } catch (error) {
    statusDiv.className = "status error";
    statusDiv.innerHTML = `❌ Error: ${error.message}`;
    console.error("Initialization error:", error);
  }
}

// Load and decode real ETC2 RGBA texture file
async function loadRealTexture() {
  if (!isReady) return;

  resultDiv.innerHTML = '<p style="color: #856404;">⏳ Loading texture file...</p>';

  try {
    // Load the real ETC2 RGBA compressed image (compressed_etc2_rgba_400x400.bin)
    const response = await fetch("/compressed_etc2_rgba_400x400.bin");
    if (!response.ok) {
      throw new Error(`Failed to load compressed_etc2_rgba_400x400.bin: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const compressedData = new Uint8Array(arrayBuffer);

    resultDiv.innerHTML = '<p style="color: #856404;">⏳ Decoding ETC2 RGBA texture...</p>';

    // Decode the 400x400 ETC2 RGBA texture
    const width = 400;
    const height = 400;
    const startTime = performance.now();

    const decoded = await decode_etc2a8(compressedData, width, height);
    const decodeTime = (performance.now() - startTime).toFixed(2);

    if (decoded) {
      // Draw decoded data to canvas
      const imageData = ctx.createImageData(width, height);

      // Convert BGRA to RGBA for canvas
      for (let i = 0; i < decoded.length; i += 4) {
        imageData.data[i] = decoded[i + 2]; // R from B
        imageData.data[i + 1] = decoded[i + 1]; // G stays
        imageData.data[i + 2] = decoded[i]; // B from R
        imageData.data[i + 3] = decoded[i + 3]; // A stays
      }

      ctx.putImageData(imageData, 0, 0);

      resultDiv.innerHTML = `
        <p style="color: #155724; font-weight: bold;">✅ Real ETC2 RGBA Image Decoded!</p>
        <p>Format: <strong>ETC2 RGBA (8-bit alpha)</strong></p>
        <p>Original format: <strong>PNG compressed as ETC2</strong></p>
        <p>Compressed size: <strong>${compressedData.length.toLocaleString()} bytes</strong></p>
        <p>Decoded size: <strong>${decoded.length.toLocaleString()} bytes (BGRA)</strong></p>
        <p>Decode time: <strong>${decodeTime}ms</strong></p>
        <p>Resolution: <strong>${width}x${height}</strong></p>
        <p style="color: #0c5460; margin-top: 10px;">📸 The decoded image is displayed in the canvas above!</p>
      `;
    } else {
      resultDiv.innerHTML =
        '<p style="color: #721c24;">❌ Decode failed (returned null)</p>';
    }
  } catch (error) {
    resultDiv.innerHTML = `<p style="color: #721c24;">❌ Error: ${error.message}</p>`;
    console.error("Decode error:", error);
  }
}

// Test decoder with sample data
async function testDecoder(format) {
  if (!isReady) return;

  resultDiv.innerHTML = '<p style="color: #856404;">⏳ Decoding...</p>';

  try {
    // Create sample compressed data (normally you'd load real texture data)
    const width = 512;
    const height = 512;
    const sampleData = new Uint8Array((width * height) / 2); // Approximate size

    // Fill with sample pattern
    for (let i = 0; i < sampleData.length; i++) {
      sampleData[i] = i % 256;
    }

    let decoded;
    let startTime = performance.now();

    switch (format) {
      case "bc1":
        decoded = await decode_bc1(sampleData, width, height);
        break;
      case "bc3":
        decoded = await decode_bc3(sampleData, width, height);
        break;
      case "etc1":
        decoded = await decode_etc1(sampleData, width, height);
        break;
      case "astc":
        decoded = await decode_astc(sampleData, width, height, 4, 4);
        break;
    }

    const decodeTime = (performance.now() - startTime).toFixed(2);

    if (decoded) {
      // Draw decoded data to canvas
      const imageData = ctx.createImageData(width, height);

      // Convert BGRA to RGBA for canvas
      for (let i = 0; i < decoded.length; i += 4) {
        imageData.data[i] = decoded[i + 2]; // R
        imageData.data[i + 1] = decoded[i + 1]; // G
        imageData.data[i + 2] = decoded[i]; // B
        imageData.data[i + 3] = decoded[i + 3]; // A
      }

      ctx.putImageData(imageData, 0, 0);

      resultDiv.innerHTML = `
        <p style="color: #155724; font-weight: bold;">✅ Decode successful!</p>
        <p>Format: <strong>${format.toUpperCase()}</strong></p>
        <p>Output size: <strong>${decoded.length.toLocaleString()} bytes</strong></p>
        <p>Decode time: <strong>${decodeTime}ms</strong></p>
        <p>Resolution: <strong>${width}x${height}</strong></p>
      `;
    } else {
      resultDiv.innerHTML =
        '<p style="color: #721c24;">❌ Decode failed (returned null)</p>';
    }
  } catch (error) {
    resultDiv.innerHTML = `<p style="color: #721c24;">❌ Error: ${error.message}</p>`;
    console.error("Decode error:", error);
  }
}

// Set up event listeners
document.getElementById("btn-bc1").addEventListener("click", () => testDecoder("bc1"));
document.getElementById("btn-bc3").addEventListener("click", () => testDecoder("bc3"));
document.getElementById("btn-etc1").addEventListener("click", () => testDecoder("etc1"));
document.getElementById("btn-astc").addEventListener("click", () => testDecoder("astc"));
document.getElementById("btn-real").addEventListener("click", loadRealTexture);

// Initialize on page load
init();
