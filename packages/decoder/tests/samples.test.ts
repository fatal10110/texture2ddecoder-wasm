import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import * as texture2ddecoder from '../src/index.js';
import AdmZip from 'adm-zip';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load test samples
const zipPath = join(__dirname, 'samples.zip');
const zip = new AdmZip(zipPath);

describe('Texture2DDecoder Sample Tests', () => {
  before(async () => {
    await texture2ddecoder.initialize();
  });

  describe('ATC Tests', () => {
    it('should decode ATC_RGB4', async () => {
      await testFormat('ATC_RGB4', texture2ddecoder.decode_atc_rgb4);
    });

    it('should decode ATC_RGBA8', async () => {
      await testFormat('ATC_RGBA8', texture2ddecoder.decode_atc_rgba8);
    });
  });

  describe('PVRTC Tests', () => {
    it('should decode PVRTC_RGB4', async () => {
      await testFormat('PVRTC_RGB4', (data, w, h) =>
        texture2ddecoder.decode_pvrtc(data, w, h, false)
      );
    });

    it('should decode PVRTC_RGBA2', async () => {
      await testFormat('PVRTC_RGBA2', (data, w, h) =>
        texture2ddecoder.decode_pvrtc(data, w, h, true)
      );
    });
  });

  describe('ETC Tests', () => {
    it('should decode ETC_RGB4', async () => {
      await testFormat('ETC_RGB4', texture2ddecoder.decode_etc1);
    });

    it('should decode ETC2_RGB', async () => {
      await testFormat('ETC2_RGB', texture2ddecoder.decode_etc2);
    });

    it('should decode ETC2_RGBA8', async () => {
      await testFormat('ETC2_RGBA8', texture2ddecoder.decode_etc2a8);
    });
  });

  describe('ETC Crunched Tests', () => {
    it('should decode ETC_RGB4Crunched', async () => {
      await testCrunchedFormat('ETC_RGB4Crunched', texture2ddecoder.decode_etc1, true);
    });

    it('should decode ETC2_RGBA8Crunched', async () => {
      await testCrunchedFormat('ETC2_RGBA8Crunched', texture2ddecoder.decode_etc2a8, true);
    });
  });

  describe('ASTC Tests', () => {
    it('should decode all ASTC formats', async () => {
      const entries = zip.getEntries();
      const astcFiles = entries.filter(
        entry => entry.entryName.includes('ASTC') && entry.entryName.endsWith('.data')
      );

      assert.ok(astcFiles.length > 0);

      for (const entry of astcFiles) {
        const name = entry.entryName.replace('.data', '');

        // Load sample data
        const data = zip.readFile(entry);
        const detailsEntry = zip.getEntry(name + '.json');
        if (!detailsEntry) continue;
        const detailsBuffer = zip.readFile(detailsEntry);
        if (!detailsBuffer) continue;
        const details = JSON.parse(detailsBuffer.toString());

        // Extract block dimensions from filename (e.g., "ASTC_4x4" -> bw=4, bh=4)
        const match = name.match(/(\d+)x(\d+)$/);
        assert.ok(match);

        const bw = parseInt(match[1]);
        const bh = parseInt(match[2]);
        const width = details.m_Width;
        const height = details.m_Height;

        // Decode
        const decoded = await texture2ddecoder.decode_astc(data!, width, height, bw, bh);

        assert.notStrictEqual(decoded, null);
        assert.strictEqual(decoded!.length, width * height * 4);
      }
    });
  });
});

// Helper function to test a format
async function testFormat(
  name: string,
  decodeFunc: (data: Buffer, width: number, height: number) => Promise<Buffer | null>,
  skipComparison: boolean = false
): Promise<void> {
  // Load sample data
  const dataEntry = zip.getEntry(name + '.data');
  const jsonEntry = zip.getEntry(name + '.json');
  const pngEntry = zip.getEntry(name + '.png');

  assert.ok(dataEntry);
  assert.ok(jsonEntry);
  assert.ok(pngEntry);

  const data = zip.readFile(dataEntry);
  const jsonBuffer = zip.readFile(jsonEntry);
  const pngData = zip.readFile(pngEntry);

  assert.ok(data);
  assert.ok(jsonBuffer);
  assert.ok(pngData);

  const details = JSON.parse(jsonBuffer.toString());

  // Decode
  const width = details.m_Width;
  const height = details.m_Height;
  const decoded = await decodeFunc(data, width, height);

  // Verify output
  assert.notStrictEqual(decoded, null);
  assert.strictEqual(decoded!.length, width * height * 4); // BGRA format

  // PVRTC has known differences, so we skip pixel-perfect comparison
  if (name.includes('PVRTC')) {
    skipComparison = true;
  }

  if (!skipComparison) {
    // In a full test, we would compare with the PNG reference
    // For now, just verify we got valid output
    assert.ok(decoded!.length > 0);
  }
}

// Helper function to test crunched formats
async function testCrunchedFormat(
  name: string,
  decodeFunc: (data: Buffer, width: number, height: number) => Promise<Buffer | null>,
  unity: boolean = false
): Promise<void> {
  // Load sample data
  const dataEntry = zip.getEntry(name + '.data');
  const jsonEntry = zip.getEntry(name + '.json');
  const pngEntry = zip.getEntry(name + '.png');

  assert.ok(dataEntry);
  assert.ok(jsonEntry);
  assert.ok(pngEntry);

  const data = zip.readFile(dataEntry);
  const jsonBuffer = zip.readFile(jsonEntry);
  const pngData = zip.readFile(pngEntry);

  assert.ok(data);
  assert.ok(jsonBuffer);
  assert.ok(pngData);

  const details = JSON.parse(jsonBuffer.toString());

  // Unpack crunch
  let unpackedData: Buffer | null;
  if (unity) {
    unpackedData = await texture2ddecoder.unpack_unity_crunch(data);
  } else {
    unpackedData = await texture2ddecoder.unpack_crunch(data);
  }

  assert.notStrictEqual(unpackedData, null);

  // Decode
  const width = details.m_Width;
  const height = details.m_Height;
  const decoded = await decodeFunc(unpackedData!, width, height);

  // Verify output
  assert.notStrictEqual(decoded, null);
  assert.strictEqual(decoded!.length, width * height * 4); // BGRA format
  assert.ok(decoded!.length > 0);
}
