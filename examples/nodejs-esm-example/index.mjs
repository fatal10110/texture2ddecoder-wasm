// Node.js ESM Example for texture2ddecoder-wasm
// This example demonstrates how to use texture2ddecoder-wasm with ES6 modules

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decode_bc1, decode_bc3, decode_astc, decode_etc2, decode_etc2a8, initialize } from 'texture2ddecoder-wasm';

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log('texture2ddecoder-wasm - Node.js ESM Example\n');

  try {
    // In Node.js, initialize() is called automatically on first decode,
    // but you can call it explicitly if needed
    console.log('Initializing WASM module...');
    await initialize();
    console.log('✓ WASM module initialized successfully!\n');

    // Example 1: Decode BC1 (DXT1) texture
    console.log('Example 1: BC1 (DXT1) Decoder');
    console.log('------------------------------');

    // Create a simple BC1-compressed data (8 bytes per 4x4 block)
    // For a 4x4 texture, we need 8 bytes
    const bc1Data = new Uint8Array([
      0xFF, 0xFF, 0x00, 0x00, 0xAA, 0xAA, 0xAA, 0xAA
    ]);

    const width = 4;
    const height = 4;

    console.log(`Decoding BC1 texture: ${width}x${height}`);
    const decodedBc1 = await decode_bc1(bc1Data, width, height);

    if (decodedBc1) {
      console.log(`✓ Decoded successfully!`);
      console.log(`  Input size: ${bc1Data.length} bytes`);
      console.log(`  Output size: ${decodedBc1.length} bytes (BGRA format)`);
      console.log(`  Expected output: ${width * height * 4} bytes\n`);
    } else {
      console.log('✗ Decoding failed\n');
    }

    // Example 2: Decode BC3 (DXT5) texture
    console.log('Example 2: BC3 (DXT5) Decoder');
    console.log('------------------------------');

    // BC3 uses 16 bytes per 4x4 block (alpha + color)
    const bc3Data = new Uint8Array([
      0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0xFF, 0xFF, 0x00, 0x00, 0xAA, 0xAA, 0xAA, 0xAA
    ]);

    console.log(`Decoding BC3 texture: ${width}x${height}`);
    const decodedBc3 = await decode_bc3(bc3Data, width, height);

    if (decodedBc3) {
      console.log(`✓ Decoded successfully!`);
      console.log(`  Input size: ${bc3Data.length} bytes`);
      console.log(`  Output size: ${decodedBc3.length} bytes (BGRA format)\n`);
    } else {
      console.log('✗ Decoding failed\n');
    }

    // Example 3: Decode ETC2 texture (simple example)
    console.log('Example 3: ETC2 Decoder');
    console.log('-----------------------');

    // ETC2 uses 8 bytes per 4x4 block
    const etc2Data = new Uint8Array([
      0x00, 0x00, 0xFF, 0xFF, 0xAA, 0xAA, 0x55, 0x55
    ]);

    console.log(`Decoding ETC2 texture: ${width}x${height}`);
    const decodedEtc2 = await decode_etc2(etc2Data, width, height);

    if (decodedEtc2) {
      console.log(`✓ Decoded successfully!`);
      console.log(`  Input size: ${etc2Data.length} bytes`);
      console.log(`  Output size: ${decodedEtc2.length} bytes (BGRA format)\n`);
    } else {
      console.log('✗ Decoding failed\n');
    }

    // Example 4: Decode ASTC texture
    console.log('Example 4: ASTC Decoder');
    console.log('-----------------------');

    // ASTC block size varies - using 4x4 blocks (16 bytes per block)
    const astcData = new Uint8Array([
      0xFC, 0xFD, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    ]);

    const blockWidth = 4;
    const blockHeight = 4;

    console.log(`Decoding ASTC texture: ${width}x${height} (${blockWidth}x${blockHeight} blocks)`);
    const decodedAstc = await decode_astc(astcData, width, height, blockWidth, blockHeight);

    if (decodedAstc) {
      console.log(`✓ Decoded successfully!`);
      console.log(`  Input size: ${astcData.length} bytes`);
      console.log(`  Output size: ${decodedAstc.length} bytes (BGRA format)\n`);
    } else {
      console.log('✗ Decoding failed\n');
    }

    // Example 5: Decode actual ETC2 RGBA compressed image file
    console.log('Example 5: Decode Real ETC2 RGBA Image (from PNG)');
    console.log('--------------------------------------------------');

    const etc2FilePath = path.join(__dirname, '../compressed_etc2_rgba_400x400.bin');

    if (fs.existsSync(etc2FilePath)) {
      // Load the ETC2 compressed texture file
      // This is a 400x400 ETC2 RGBA compressed image (originally a PNG)
      const etc2FileData = fs.readFileSync(etc2FilePath);
      const imageWidth = 400;
      const imageHeight = 400;

      console.log(`Loading ETC2 RGBA texture from: ${etc2FilePath}`);
      console.log(`  Original format: PNG compressed as ETC2 RGBA`);
      console.log(`  Texture size: ${imageWidth}x${imageHeight}`);
      console.log(`  Compressed size: ${etc2FileData.length} bytes`);

      // ETC2 with alpha uses decode_etc2a8 (ETC2 with 8-bit alpha)
      const decodedEtc2File = await decode_etc2a8(etc2FileData, imageWidth, imageHeight);

      if (decodedEtc2File) {
        console.log(`✓ Decoded successfully!`);
        console.log(`  Output size: ${decodedEtc2File.length} bytes (BGRA format)`);
        console.log(`  Expected output: ${imageWidth * imageHeight * 4} bytes`);

        // Try to convert to PNG using sharp if available
        try {
          const sharp = (await import('sharp')).default;

          // Convert BGRA to RGBA for sharp
          const rgbaData = Buffer.alloc(decodedEtc2File.length);
          for (let i = 0; i < decodedEtc2File.length; i += 4) {
            rgbaData[i] = decodedEtc2File[i + 2];     // R from B
            rgbaData[i + 1] = decodedEtc2File[i + 1]; // G stays
            rgbaData[i + 2] = decodedEtc2File[i];     // B from R
            rgbaData[i + 3] = decodedEtc2File[i + 3]; // A stays
          }

          const outputPath = path.join(__dirname, 'decoded-etc2.png');
          await sharp(rgbaData, {
            raw: {
              width: imageWidth,
              height: imageHeight,
              channels: 4
            }
          }).toFile(outputPath);

          console.log(`  Saved PNG to: ${outputPath}\n`);
        } catch (sharpError) {
          // If sharp is not available, save as raw BGRA
          console.log('  ⚠ sharp not installed, saving as raw BGRA instead');
          const outputPath = path.join(__dirname, 'decoded-etc2.raw');
          fs.writeFileSync(outputPath, decodedEtc2File);
          console.log(`  Saved raw BGRA to: ${outputPath}`);
          console.log('  To convert to PNG, install sharp:');
          console.log('    npm install sharp\n');
        }
      } else {
        console.log('✗ Decoding failed\n');
      }
    } else {
      console.log(`  ⚠ File not found: ${etc2FilePath}`);
      console.log('  Skipping real image example\n');
    }

    // Example 6: Working with texture files
    console.log('Example 6: Working with Other Texture Files');
    console.log('--------------------------------------------');
    console.log('To decode other texture formats from files:\n');
    console.log('  // ES6 import');
    console.log('  import fs from "fs";\n');
    console.log('  // Read texture file');
    console.log('  const textureData = fs.readFileSync("texture.bin");');
    console.log('  const decoded = await decode_bc1(textureData, width, height);\n');
    console.log('  // Save as raw BGRA');
    console.log('  fs.writeFileSync("output.raw", decoded);\n');
    console.log('  // Or use with image libraries like sharp:');
    console.log('  import sharp from "sharp";\n');
    console.log('  await sharp(decoded, {');
    console.log('    raw: { width, height, channels: 4 }');
    console.log('  }).toFile("output.png");\n');

    console.log('✓ All examples completed successfully!');
    console.log('\nSupported formats: BC1-7, ETC1/2, PVRTC, ASTC, ATC, EAC, Crunch');

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Run the example
main();
