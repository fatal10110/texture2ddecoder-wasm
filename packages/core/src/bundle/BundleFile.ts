// Ported from AssetStudio/BundleFile.cs (MIT, © Perfare / RazTools / Razviar)

import { decompressLz4 } from "../codec/lz4.js";
import { CorruptError, UnsupportedError } from "../errors.js";
import { BinaryReader } from "../io/BinaryReader.js";

/** Upstream reads a NUL-terminated signature of at most 20 bytes. */
const SIGNATURE_MAX_LENGTH = 20;

/** The 16-byte hash of the uncompressed data, read and ignored like upstream. */
const UNCOMPRESSED_DATA_HASH_SIZE = 16;

/**
 * Bits of the archive flag word (`kArchive*` in Unity's own source).
 *
 * `BlocksAndDirectoryInfoCombined` (0x40) and `OldWebPluginCompatibility`
 * (0x100) are read by upstream but never branched on for a stock bundle, so
 * they are not listed here.
 */
const ArchiveFlags = {
  /** Low six bits: which codec compressed the blocks info. */
  CompressionTypeMask: 0x3f,
  /** Blocks info sits at the end of the file instead of after the header. */
  BlocksInfoAtTheEnd: 0x80,
  /** 2019.4+: the data blocks start on a 16-byte boundary. */
  BlockInfoNeedPaddingAtStart: 0x200,
  /**
   * AssetBundle encryption. Unity moved the bit from 0x400 to 0x1000, and
   * UnityCN builds reuse 0x400 for their own scheme, so both are refused.
   */
  EncryptionMask: 0x1400,
} as const;

/** Low six bits of a storage block's flag word: which codec compressed it. */
const BLOCK_COMPRESSION_TYPE_MASK = 0x3f;

/** Flags Unity stores on a directory node. */
export const NodeFlags = {
  /** The node is a SerializedFile; without it the node is a resource blob. */
  SerializedFile: 4,
} as const;

/**
 * Compression ids as Unity writes them, indexed by id so an unsupported one can
 * be named rather than reported as a number (R9).
 *
 * 5 is `zstd` in stock Unity and something game-specific in several forks; the
 * plan keeps it out of core until game variants land (#50), so it is named here
 * only to make the refusal readable.
 */
const COMPRESSION_NAMES = ["none", "LZMA", "LZ4", "LZ4HC", "LZHAM", "zstd"] as const;

const CompressionType = {
  None: 0,
  Lzma: 1,
  Lz4: 2,
  Lz4HC: 3,
} as const;

/**
 * Cap on the stitched block buffer.
 *
 * Upstream spills above this into a temp file, which core cannot do (D3), and
 * browsers refuse allocations of this size anyway. A bundle that big is
 * well-formed but out of reach, so it is `UnsupportedError`, not `CorruptError`.
 */
const MAX_BLOCKS_BYTES = 0x7fffffff;

/** The bundle header, as it is written on disk. */
export interface BundleHeader {
  /** Container signature; `"UnityFS"` for everything this module parses. */
  signature: string;
  /** Bundle format version (not a Unity version): 6 and 7 in the wild. */
  version: number;
  /** Unity's own `unityVersion` string, usually the useless `"5.x.x"`. */
  unityVersion: string;
  /** Build revision, e.g. `"2022.3.0f1"` - the version worth reading. */
  unityRevision: string;
  /** Total size of the bundle as the header records it. */
  size: number;
  /** Bytes of blocks info on disk. */
  compressedBlocksInfoSize: number;
  /** Bytes of blocks info after decompression. */
  uncompressedBlocksInfoSize: number;
  /** Raw archive flags; see {@link ArchiveFlags} for the bits that matter. */
  flags: number;
}

/** One file stitched back together out of the bundle's storage blocks. */
export interface StreamFile {
  /** Node path inside the bundle, e.g. `"CAB-1234"` or `"CAB-1234.resS"`. */
  path: string;
  /**
   * File bytes, a view into the decompressed blocks (R7). Writing through it
   * writes through to the sibling files, and it keeps the whole block buffer
   * alive; copy it if you need either avoided.
   */
  data: Uint8Array;
  /** Raw node flags; test against {@link NodeFlags} to tell what the node is. */
  flags: number;
}

/** A parsed bundle: its header plus every file it contains. */
export interface BundleFile {
  header: BundleHeader;
  files: StreamFile[];
}

interface StorageBlock {
  compressedSize: number;
  uncompressedSize: number;
  flags: number;
}

interface DirectoryNode {
  offset: number;
  size: number;
  flags: number;
  path: string;
}

/**
 * Parse a Unity bundle into its files.
 *
 * Only the `UnityFS` container is implemented here; the legacy `UnityWeb` /
 * `UnityRaw` layouts and `UnityArchive` are refused by signature.
 *
 * @param data whole bundle bytes; kept by reference, never copied (R7)
 * @returns the header and every unpacked file, in directory order
 * @throws {UnsupportedError} for a container, archive flag or compression type
 *   this library does not implement
 * @throws {CorruptError} when the bundle is truncated, or a size, offset or
 *   count in it disagrees with the bytes that are there
 */
export function readBundle(data: Uint8Array): BundleFile {
  // Unity writes bundle headers big-endian; only SerializedFile flips (M2).
  const reader = new BinaryReader(data, "big");

  const signature = reader.readStringToNull(SIGNATURE_MAX_LENGTH);
  const version = reader.readUInt32();
  const unityVersion = reader.readStringToNull();
  const unityRevision = reader.readStringToNull();

  // UnityWeb/UnityRaw (and their version-6 spelling, which reuses the UnityFS
  // layout) plus WebFile land with #18; UnityArchive has no upstream
  // implementation to port at all.
  if (signature !== "UnityFS") {
    throw new UnsupportedError("bundle signature", signature || "(none)", "only UnityFS is read");
  }

  const header: BundleHeader = {
    signature,
    version,
    unityVersion,
    unityRevision,
    size: toSize(reader.readInt64(), "bundle size"),
    compressedBlocksInfoSize: reader.readUInt32(),
    uncompressedBlocksInfoSize: reader.readUInt32(),
    flags: reader.readUInt32(),
  };

  // Encrypted archives would otherwise decompress into garbage, which R9 puts
  // above "try anyway". Decryption is game-specific work (plan M6).
  const encryption = header.flags & ArchiveFlags.EncryptionMask;
  if (encryption !== 0) {
    throw new UnsupportedError(
      "archive flag",
      `0x${encryption.toString(16)}`,
      "the archive is encrypted",
    );
  }

  const { blocks, nodes } = readBlocksInfoAndDirectory(reader, header);
  const blocksData = readBlocks(reader, blocks);
  return { header, files: readFiles(nodes, blocksData) };
}

/**
 * Locate, decompress and parse the blocks info, then leave the reader at the
 * first data block (upstream `ReadBlocksInfoAndDirectory`).
 */
function readBlocksInfoAndDirectory(
  reader: BinaryReader,
  header: BundleHeader,
): { blocks: StorageBlock[]; nodes: DirectoryNode[] } {
  // Format version 7 (Unity 2020.1+): the header is padded to 16 bytes. UnityPy
  // additionally aligns a version-6 header written by 2019.4.15+; AssetStudio
  // is the source of truth here, and no fixture shows that case, so the gate
  // stays on the format version.
  if (header.version >= 7) reader.align(16);

  const start = reader.position;
  let blocksInfoBytes: Uint8Array;
  if ((header.flags & ArchiveFlags.BlocksInfoAtTheEnd) !== 0) {
    const infoStart = reader.length - header.compressedBlocksInfoSize;
    if (infoStart < start) {
      throw new CorruptError(
        `blocks info of ${header.compressedBlocksInfoSize} bytes does not fit before the ` +
          `end of ${reader.length} bytes`,
      );
    }
    reader.position = infoStart;
    blocksInfoBytes = reader.readBytes(header.compressedBlocksInfoSize);
    reader.position = start;
  } else {
    blocksInfoBytes = reader.readBytes(header.compressedBlocksInfoSize);
  }

  const info = new BinaryReader(
    decompress(
      header.flags & ArchiveFlags.CompressionTypeMask,
      blocksInfoBytes,
      header.uncompressedBlocksInfoSize,
      "blocks info",
    ),
    "big",
  );

  info.readBytes(UNCOMPRESSED_DATA_HASH_SIZE); // uncompressed data hash, unused
  const blocks: StorageBlock[] = [];
  for (let i = count(info.readInt32(), "storage block"); i > 0; i--) {
    blocks.push({
      uncompressedSize: info.readUInt32(),
      compressedSize: info.readUInt32(),
      flags: info.readUInt16(),
    });
  }

  const nodes: DirectoryNode[] = [];
  for (let i = count(info.readInt32(), "directory node"); i > 0; i--) {
    nodes.push({
      offset: toSize(info.readInt64(), "node offset"),
      size: toSize(info.readInt64(), "node size"),
      flags: info.readUInt32(),
      path: info.readStringToNull(),
    });
  }

  // 2019.4+: with this flag the data blocks start on a 16-byte boundary. Before
  // 2020 the same bit meant "uses AssetBundle encryption"; such a bundle is
  // already refused above, so aligning unconditionally matches upstream.
  if ((header.flags & ArchiveFlags.BlockInfoNeedPaddingAtStart) !== 0) reader.align(16);

  return { blocks, nodes };
}

/** Decompress every storage block into one buffer (upstream `ReadBlocks`). */
function readBlocks(reader: BinaryReader, blocks: StorageBlock[]): Uint8Array {
  let total = 0;
  for (const block of blocks) total += block.uncompressedSize;
  if (total > MAX_BLOCKS_BYTES) {
    throw new UnsupportedError(
      "bundle size",
      total,
      `above the ${MAX_BLOCKS_BYTES} byte buffer limit`,
    );
  }

  const blocksData = new Uint8Array(total);
  let written = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const chunk = decompress(
      block.flags & BLOCK_COMPRESSION_TYPE_MASK,
      reader.readBytes(block.compressedSize),
      block.uncompressedSize,
      `block ${i}`,
    );
    blocksData.set(chunk, written);
    written += block.uncompressedSize;
  }
  return blocksData;
}

/** Cut each directory node out of the stitched blocks (upstream `ReadFiles`). */
function readFiles(nodes: DirectoryNode[], blocksData: Uint8Array): StreamFile[] {
  return nodes.map((node) => {
    const end = node.offset + node.size;
    if (end > blocksData.length) {
      throw new CorruptError(
        `node "${node.path}" ends at ${end} but the bundle holds ` +
          `${blocksData.length} bytes of blocks`,
      );
    }
    return { path: node.path, data: blocksData.subarray(node.offset, end), flags: node.flags };
  });
}

/**
 * Decompress one chunk - a blocks info or a storage block, which use the same
 * codecs and the same flag layout.
 *
 * @param type compression id from the low six bits of the flag word
 * @param src compressed bytes
 * @param uncompressedSize what the header says the chunk expands to
 * @param where what is being decompressed, for the error message
 */
function decompress(
  type: number,
  src: Uint8Array,
  uncompressedSize: number,
  where: string,
): Uint8Array {
  switch (type) {
    case CompressionType.None:
      // Upstream copies the stored bytes and never checks the pair. A
      // disagreement means every later block is read from the wrong offset, so
      // it is reported instead of being unpacked into silent garbage (R9).
      if (src.length !== uncompressedSize) {
        throw new CorruptError(
          `${where} is stored uncompressed but holds ${src.length} bytes ` +
            `where the header says ${uncompressedSize}`,
        );
      }
      return src;

    case CompressionType.Lzma: {
      // UnityFS keeps LZMA's 5 property bytes in front of the raw stream and
      // the output size in the header, so the decoder is handed all three:
      //   lzmaDecompress(src.subarray(0, 5), src.subarray(5), uncompressedSize)
      // #14 owns codec/lzma.ts; until it lands the path refuses rather than
      // returning nothing (R9). The legacy stream shape, which carries its own
      // size, belongs to #18.
      throw new UnsupportedError(
        "compression type",
        COMPRESSION_NAMES[CompressionType.Lzma]!,
        "the LZMA decoder is not wired up yet",
      );
    }

    // LZ4HC only changes how the compressor searches; the blocks decode
    // identically, so there is no separate path (plan §1).
    case CompressionType.Lz4:
    case CompressionType.Lz4HC:
      return decompressLz4(src, uncompressedSize);

    default:
      throw new UnsupportedError("compression type", COMPRESSION_NAMES[type] ?? type);
  }
}

/**
 * Convert a 64-bit size or offset read from the file into a `number` (D9/R6).
 *
 * @throws {CorruptError} when it is negative or 2^53 and above, which no real
 * bundle reaches and a `number` cannot hold exactly
 */
function toSize(value: bigint, what: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CorruptError(`${what} ${value} is not a byte count below 2^53`);
  }
  return Number(value);
}

/**
 * Validate a signed count read from the blocks info.
 *
 * @throws {CorruptError} when it is negative, which upstream turns into an
 * empty list instead of a complaint
 */
function count(value: number, what: string): number {
  if (value < 0) throw new CorruptError(`${what} count ${value} is negative`);
  return value;
}
