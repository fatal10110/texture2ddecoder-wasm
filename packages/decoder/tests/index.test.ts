import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import {
  initialize,
  decode_bc1,
  decode_bc3,
  decode_etc1,
  decode_astc,
} from '../src/index.js';

describe('Texture2DDecoder WASM', () => {
  before(async () => {
    await initialize();
  });

  describe('Module initialization', () => {
    it('should initialize without errors', async () => {
      await assert.doesNotReject(async () => {
        await initialize();
      });
    });
  });

  describe('BC1 decoder', () => {
    it('should decode valid BC1 data', async () => {
      const data = Buffer.alloc(16); // 16 bytes for a 4x4 block
      data.fill(0xFF);

      const result = await decode_bc1(data, 4, 4);
      assert.notStrictEqual(result, null);
      assert.strictEqual(result?.length, 4 * 4 * 4); // 4x4 pixels * 4 bytes (BGRA)
    });

    it('should return null for invalid dimensions', async () => {
      const data = Buffer.alloc(16);
      const result = await decode_bc1(data, 0, 0);
      assert.strictEqual(result, null);
    });

    it('should handle larger textures', async () => {
      // 8x8 texture = 4 blocks (2x2 grid) * 16 bytes each = 64 bytes
      const data = Buffer.alloc(64);
      data.fill(0xAA);

      const result = await decode_bc1(data, 8, 8);
      assert.notStrictEqual(result, null);
      assert.strictEqual(result?.length, 8 * 8 * 4);
    });
  });

  describe('BC3 decoder', () => {
    it('should decode valid BC3 data', async () => {
      const data = Buffer.alloc(16); // Minimum size for BC3
      data.fill(0x80);

      const result = await decode_bc3(data, 4, 4);
      assert.notStrictEqual(result, null);
      assert.strictEqual(result?.length, 4 * 4 * 4);
    });
  });

  describe('ETC1 decoder', () => {
    it('should decode valid ETC1 data', async () => {
      const data = Buffer.alloc(8); // 8 bytes for a 4x4 block
      data.fill(0x55);

      const result = await decode_etc1(data, 4, 4);
      assert.notStrictEqual(result, null);
      assert.strictEqual(result?.length, 4 * 4 * 4);
    });
  });

  describe('ASTC decoder', () => {
    it('should decode valid ASTC data with 4x4 blocks', async () => {
      const data = Buffer.alloc(16); // 16 bytes per block for ASTC
      data.fill(0x33);

      const result = await decode_astc(data, 4, 4, 4, 4);
      assert.notStrictEqual(result, null);
      assert.strictEqual(result?.length, 4 * 4 * 4);
    });

    it('should return null for invalid block dimensions', async () => {
      const data = Buffer.alloc(16);
      const result = await decode_astc(data, 4, 4, 0, 0);
      assert.strictEqual(result, null);
    });

    it('should handle different block sizes', async () => {
      const data = Buffer.alloc(16);
      data.fill(0x77);

      const result = await decode_astc(data, 6, 6, 6, 6);
      assert.notStrictEqual(result, null);
      assert.strictEqual(result?.length, 6 * 6 * 4);
    });
  });

  describe('Output format', () => {
    it('should return Uint8Array objects', async () => {
      const data = Buffer.alloc(16);
      data.fill(0xFF);

      const result = await decode_bc1(data, 4, 4);
      assert.ok(result instanceof Uint8Array);
    });

    it('should produce BGRA format (4 bytes per pixel)', async () => {
      const data = Buffer.alloc(16);
      data.fill(0xFF);

      const result = await decode_bc1(data, 4, 4);
      assert.notStrictEqual(result, null);

      if (result) {
        // Check that we have exactly 4 bytes per pixel
        assert.strictEqual(result.length % 4, 0);
        assert.strictEqual(result.length / 4, 4 * 4);
      }
    });
  });

  describe('Error handling', () => {
    it('should handle empty buffers gracefully', async () => {
      const data = Buffer.alloc(0);
      const result = await decode_bc1(data, 4, 4);
      // Should either return null or handle gracefully
      assert.ok(result === null || result instanceof Uint8Array);
    });

    it('should handle oversized dimensions', async () => {
      const data = Buffer.alloc(16);
      // Requesting a huge texture with small data should fail gracefully
      const result = await decode_bc1(data, 10000, 10000);
      assert.ok(result === null || result instanceof Uint8Array);
    });
  });
});
