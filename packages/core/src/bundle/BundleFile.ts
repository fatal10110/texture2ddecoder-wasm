// Ported from AssetStudio/BundleFile.cs (MIT, © Perfare / RazTools / Razviar)
// Ported from UnityPy/files/BundleFile.py (MIT, © K0lb3)

import { decompressLz4 } from "../codec/lz4.js";
import { lzmaDecompress } from "../codec/lzma.js";
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
  /**
   * 2020.3.34 / 2021.3.2 / 2022.1.1 and later: the data blocks start on a
   * 16-byte boundary. Older editors wrote the same bit to mean "uses
   * AssetBundle encryption"; {@link usesOldArchiveFlags} tells the two apart.
   */
  BlockInfoNeedPaddingAtStart: 0x200,
  /**
   * AssetBundle encryption on a 2020.3.34 / 2021.3.2 / 2022.1.1 or later
   * bundle: Unity moved the bit from 0x400 to 0x1000, and UnityCN builds reuse
   * 0x400 for their own scheme, so both are refused. The composite is UnityPy's
   * (`ArchiveFlags.UsesAssetBundleEncryption = 0x1400`); AssetStudio's own enum
   * stops at `UnityCNEncryption = 0x400`.
   */
  EncryptionMask: 0x1400,
  /**
   * The same on an older bundle, where 0x200 is the encryption bit
   * (UnityPy `ArchiveFlagsOld.UsesAssetBundleEncryption`). 0x400 and 0x1000
   * stay in the mask: neither has another meaning in that editor range, and
   * dropping them would turn bundles this reader refuses today into bundles it
   * hands to the codecs.
   */
  OldEncryptionMask: 0x1600,
} as const;

/** Low six bits of a storage block's flag word: which codec compressed it. */
const BLOCK_COMPRESSION_TYPE_MASK = 0x3f;

/** Hash of the uncompressed data that legacy format version 4 and up write. */
const LEGACY_HASH_SIZE = 16;

/** LZMA property bytes: the packed `lc`/`lp`/`pb` byte, then a u32 dictionary size. */
const LZMA_PROPS_SIZE = 5;

/** Legacy LZMA prefix: the property bytes plus a little-endian u64 output size. */
const LEGACY_LZMA_HEADER_SIZE = LZMA_PROPS_SIZE + 8;

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
  /** Container signature: `"UnityFS"`, `"UnityWeb"` or `"UnityRaw"`. */
  signature: string;
  /** Bundle format version (not a Unity version): 3, 6 and 7 in the wild. */
  version: number;
  /** Unity's own `unityVersion` string, usually the useless `"5.x.x"`. */
  unityVersion: string;
  /** Build revision, e.g. `"2022.3.0f1"` - the version worth reading. */
  unityRevision: string;
  /**
   * Total size of the bundle as the header records it.
   *
   * A pre-version-6 `UnityWeb`/`UnityRaw` header has no such field; upstream
   * stores that layout's header size here instead, which is the offset the
   * level data starts at, and so does this reader.
   */
  size: number;
  /** Bytes of blocks info on disk; 0 in the legacy layout, which has none. */
  compressedBlocksInfoSize: number;
  /** Bytes of blocks info after decompression; 0 in the legacy layout. */
  uncompressedBlocksInfoSize: number;
  /**
   * Raw archive flags; see {@link ArchiveFlags} for the bits that matter. The
   * legacy layout has no flags word, so it reports 0 like upstream does.
   */
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
 * The leading numeric components of a `unityRevision`, as
 * {@link parseVersion} reads them: major, minor, build.
 */
type UnityVersion = readonly [major: number, minor: number, build: number];

/** The four fields every container spells the same way, before they diverge. */
type HeaderStart = Pick<
  BundleHeader,
  "signature" | "version" | "unityVersion" | "unityRevision"
>;

/**
 * Parse a Unity bundle into its files.
 *
 * Covers the `UnityFS` archive layout and the legacy `UnityWeb` / `UnityRaw`
 * one. `UnityArchive` is refused: there is no upstream implementation to port.
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

  const base: HeaderStart = {
    signature: reader.readStringToNull(SIGNATURE_MAX_LENGTH),
    version: reader.readUInt32(),
    unityVersion: reader.readStringToNull(),
    unityRevision: reader.readStringToNull(),
  };

  // Confirmed while porting (#18): upstream has nothing to port for
  // UnityArchive. AssetStudio's switch is `case "UnityArchive": break; //TODO`
  // and UnityPy raises NotImplementedError, so neither reads a single field of
  // it. The kind matches the one detect.ts uses, so a caller branching on the
  // error does not have to care which entry point sniffed the bytes (R9).
  if (base.signature === "UnityArchive") {
    throw new UnsupportedError("container", base.signature, "no upstream implementation to port");
  }

  const legacy = base.signature === "UnityWeb" || base.signature === "UnityRaw";
  if (!legacy && base.signature !== "UnityFS") {
    throw new UnsupportedError("container", base.signature || "(none)", "not a Unity bundle");
  }

  // Format version 6 is where UnityWeb/UnityRaw switched to the archive layout;
  // upstream reaches it with `goto case "UnityFS"`. Older versions keep the
  // level-based layout the web player streamed.
  return legacy && base.version !== 6
    ? readLegacyBundle(reader, base)
    : readArchiveBundle(reader, base, legacy);
}

/** The `UnityFS` layout: a flags word, a blocks info, then storage blocks. */
function readArchiveBundle(
  reader: BinaryReader,
  base: HeaderStart,
  legacy: boolean,
): BundleFile {
  const header: BundleHeader = {
    ...base,
    size: toSize(reader.readInt64(), "bundle size"),
    compressedBlocksInfoSize: reader.readUInt32(),
    uncompressedBlocksInfoSize: reader.readUInt32(),
    flags: reader.readUInt32(),
  };

  // A format version 6 UnityWeb/UnityRaw header carries one more byte here than
  // a UnityFS one does; upstream reads and discards it, as does UnityPy.
  if (legacy) reader.readUInt8();

  // Which bits the flags word uses depends on the editor that wrote it, so the
  // revision has to be parsed before a single flag is branched on.
  const version = parseVersion(header.unityRevision);
  const mask = usesOldArchiveFlags(version)
    ? ArchiveFlags.OldEncryptionMask
    : ArchiveFlags.EncryptionMask;

  // Encrypted archives would otherwise decompress into garbage, which R9 puts
  // above "try anyway". Decryption is game-specific work (plan M6).
  const encryption = header.flags & mask;
  if (encryption !== 0) {
    throw new UnsupportedError(
      "archive flag",
      `0x${encryption.toString(16)}`,
      "the archive is encrypted",
    );
  }

  const { blocks, nodes } = readBlocksInfoAndDirectory(reader, header, version);
  const blocksData = readBlocks(reader, blocks);
  return { header, files: readFiles(nodes, blocksData) };
}

/**
 * The pre-version-6 `UnityWeb` / `UnityRaw` layout (upstream
 * `ReadHeaderAndBlocksInfo` + `ReadBlocksAndDirectory`).
 *
 * Nothing here is shared with the archive layout: there is no flags word and no
 * codec field, the directory sits inside the payload rather than in its own
 * blocks info, and its nodes are written path-first with 32-bit offsets.
 */
function readLegacyBundle(reader: BinaryReader, base: HeaderStart): BundleFile {
  // Format version 4 added a hash of the uncompressed data and its CRC; both
  // are read and ignored upstream.
  if (base.version >= 4) {
    reader.readBytes(LEGACY_HASH_SIZE);
    reader.readUInt32();
  }
  reader.readUInt32(); // minimumStreamedBytes
  // Upstream keeps this in the same `size` field as UnityFS's total size, but
  // it is the header size: the offset the level data starts at.
  const headerSize = reader.readUInt32();
  reader.readUInt32(); // numberOfLevelsToDownloadBeforeStreaming

  // One level per LOD the web player could stream. Each level is a prefix of
  // the next, so upstream keeps the last one and ignores the rest.
  let compressedSize: number | undefined;
  for (let i = count(reader.readInt32(), "level"); i > 0; i--) {
    compressedSize = reader.readUInt32();
    reader.readUInt32(); // uncompressedSize; the LZMA stream carries its own
  }
  if (compressedSize === undefined) {
    throw new CorruptError("legacy bundle declares no levels, so it holds no files");
  }
  if (base.version >= 2) reader.readUInt32(); // completeFileSize
  if (base.version >= 3) reader.readUInt32(); // fileInfoHeaderSize

  const header: BundleHeader = {
    ...base,
    size: headerSize,
    // This layout has no blocks info and no flags word: the one level holds the
    // directory and the file data together. Upstream leaves the three fields at
    // zero rather than inventing values for them, and so does this.
    compressedBlocksInfoSize: 0,
    uncompressedBlocksInfoSize: 0,
    flags: 0,
  };

  reader.position = headerSize;
  const stored = reader.readBytes(compressedSize);
  // UnityRaw stores the level verbatim and UnityWeb compresses it with LZMA.
  // The signature is the whole codec selection; there is no field to read.
  const blocksData = base.signature === "UnityWeb" ? decompressLegacyLzma(stored) : stored;

  const info = new BinaryReader(blocksData, "big");
  const nodes: DirectoryNode[] = [];
  for (let i = count(info.readInt32(), "directory node"); i > 0; i--) {
    // Path first, then two 32-bit fields, and no flags at all - the archive
    // layout writes 64-bit offsets and flags, and puts the path last.
    nodes.push({
      path: info.readStringToNull(),
      offset: info.readUInt32(),
      size: info.readUInt32(),
      flags: 0,
    });
  }
  return { header, files: readFiles(nodes, blocksData) };
}

/**
 * Decompress one legacy level, whose LZMA stream is the plain `.lzma` shape:
 * 5 property bytes, a little-endian u64 output size, then the bit stream
 * (upstream `SevenZipHelper.StreamDecompress`).
 *
 * The size comes out of the stream, not out of the level record - upstream
 * ignores the level's `uncompressedSize` here, and a disagreement between the
 * two is not evidence that either the stream or the record is wrong.
 *
 * @throws {CorruptError} when the prefix is missing, its size is not a byte
 *   count below 2^53, or the stream does not expand to exactly that size
 * @throws {UnsupportedError} when the level is larger than one buffer can hold
 */
function decompressLegacyLzma(stream: Uint8Array): Uint8Array {
  const head = new BinaryReader(stream, "little");
  const props = head.readBytes(LZMA_PROPS_SIZE);
  const size = toSize(head.readUInt64(), "legacy LZMA uncompressed size");
  // Same ceiling as the archive path: upstream spills a level this big into a
  // temp file, which core cannot do (D3), so it is out of reach rather than bad.
  if (size > MAX_BLOCKS_BYTES) {
    throw new UnsupportedError(
      "bundle size",
      size,
      `above the ${MAX_BLOCKS_BYTES} byte buffer limit`,
    );
  }
  return lzmaDecompress(props, stream.subarray(LEGACY_LZMA_HEADER_SIZE), size);
}

/**
 * Locate, decompress and parse the blocks info, then leave the reader at the
 * first data block (upstream `ReadBlocksInfoAndDirectory`).
 */
function readBlocksInfoAndDirectory(
  reader: BinaryReader,
  header: BundleHeader,
  version: UnityVersion,
): { blocks: StorageBlock[]; nodes: DirectoryNode[] } {
  // Format version 7 (Unity 2020.1+): the header is padded to 16 bytes.
  //
  // 2019.4.15 got the alignment fix backported (issuetracker: files within
  // AssetBundles do not start on aligned boundaries, breaking patching on
  // Nintendo Switch) while the format version stayed at 6, so such a header is
  // padded too and the format version alone misses it - the blocks info would
  // be read ~14 bytes early. AssetStudio gates on the format version only;
  // UnityPy adds the 2019.4.15 case and that is the behaviour matched here.
  if (header.version >= 7 || (version[0] === 2019 && !isBefore(version, 2019, 4, 15))) {
    reader.align(16);
  }

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

  // 2020.3.34 / 2021.3.2 / 2022.1.1 and later: with this flag the data blocks
  // start on a 16-byte boundary. On an older bundle the same bit is the
  // encryption flag, which readArchiveBundle already refused, so the flag-set
  // test here is redundant today - it is the guard UnityPy writes
  // (`isinstance(self.dataflags, ArchiveFlags) and ...`) and it keeps the two
  // readings apart whatever the encryption mask above is narrowed to later.
  if (
    !usesOldArchiveFlags(version) &&
    (header.flags & ArchiveFlags.BlockInfoNeedPaddingAtStart) !== 0
  ) {
    reader.align(16);
  }

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
 * codecs and the same flag layout - and hold every codec to its declared
 * output size.
 *
 * That size is load-bearing: {@link readBlocks} advances its cursor by the
 * declared size, not by what came back, so a codec that overshoots corrupts the
 * blocks after it and one that undershoots leaves files silently zero-filled.
 * Upstream checks the write count per codec; one check here covers every
 * branch, including codecs wired up later whose decoder does not police its own
 * output - the #13 spike found `lzma1` returns more than it was asked for on
 * truncated input and throws nothing.
 *
 * @param type compression id from the low six bits of the flag word
 * @param src compressed bytes
 * @param uncompressedSize what the header says the chunk expands to
 * @param where what is being decompressed, for the error message
 * @throws {CorruptError} when the codec does not produce exactly `uncompressedSize` bytes
 * @throws {UnsupportedError} for a compression type this library does not implement
 */
function decompress(
  type: number,
  src: Uint8Array,
  uncompressedSize: number,
  where: string,
): Uint8Array {
  const out = decode(type, src, uncompressedSize);
  if (out.length !== uncompressedSize) {
    throw new CorruptError(
      `${where} wrote ${out.length} bytes but expected ${uncompressedSize} bytes`,
    );
  }
  return out;
}

/** The codec dispatch itself; {@link decompress} owns the size invariant. */
function decode(type: number, src: Uint8Array, uncompressedSize: number): Uint8Array {
  switch (type) {
    case CompressionType.None:
      // Upstream copies the stored bytes and never compares the two sizes; a
      // disagreement is caught by the length check in the caller.
      return src;

    case CompressionType.Lzma:
      // UnityFS keeps LZMA's 5 property bytes in front of the raw stream and
      // the output size in the header, so the decoder is handed all three. The
      // legacy shape carries its own size - see {@link decompressLegacyLzma}.
      return lzmaDecompress(
        src.subarray(0, LZMA_PROPS_SIZE),
        src.subarray(LZMA_PROPS_SIZE),
        uncompressedSize,
      );

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
 * Read the first three numbers out of a `unityRevision` such as `"2019.4.15f1"`
 * (upstream `BundleFile.ParseVersion`, which splits on every non-digit run).
 *
 * Missing components read as 0, so an empty or non-numeric revision is
 * `[0, 0, 0]` - older than every version gate, which is the safe side: the
 * gates below then pick the older flag set and refuse rather than guess.
 * Upstream throws on such a revision (AssetStudio indexes an empty array,
 * UnityPy demands a configured fallback version), and neither is useful to a
 * caller that only wanted the files out.
 *
 * @param revision the header's `unityRevision`
 * @returns major, minor and build; never throws
 */
function parseVersion(revision: string): UnityVersion {
  const parsed: [number, number, number] = [0, 0, 0];
  let part = 0;
  let value = -1;
  for (let i = 0; i < revision.length && part < parsed.length; i++) {
    const digit = revision.charCodeAt(i) - 0x30;
    if (digit >= 0 && digit <= 9) {
      value = (value < 0 ? 0 : value) * 10 + digit;
    } else if (value >= 0) {
      parsed[part++] = value;
      value = -1;
    }
  }
  if (value >= 0 && part < parsed.length) parsed[part] = value;
  return parsed;
}

/** `true` when `version` is strictly older than `major.minor.build`. */
function isBefore(version: UnityVersion, major: number, minor: number, build: number): boolean {
  if (version[0] !== major) return version[0] < major;
  if (version[1] !== minor) return version[1] < minor;
  return version[2] < build;
}

/**
 * Whether the editor that wrote this bundle used the old archive flag set,
 * where 0x200 means "uses AssetBundle encryption" rather than
 * "blocks info needs padding at start" (UnityPy `ArchiveFlagsOld`).
 *
 * The bit changed meaning in 2020.3.34, 2021.3.2 and 2022.1.1, each of which
 * only gates its own major version. AssetStudio draws the 2022 line at 2022.3.2
 * instead; UnityPy's boundaries are the ones this reader is checked against.
 *
 * @param version the parsed `unityRevision`
 */
function usesOldArchiveFlags(version: UnityVersion): boolean {
  switch (version[0]) {
    case 2020:
      return isBefore(version, 2020, 3, 34);
    case 2021:
      return isBefore(version, 2021, 3, 2);
    case 2022:
      return isBefore(version, 2022, 1, 1);
    default:
      return version[0] < 2020;
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
