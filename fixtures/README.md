# Fixtures and goldens

Shared test data for every reader package. Tests import [`helpers.ts`](helpers.ts)
by relative path; nothing here is published.

```
bundles/          M1 container fixtures (generated, see below)
bundles/editor/   editor-built bundles, one folder per Unity version and build variant
BUILDING.md       how the editor-built bundles were made, and how to rebuild them
goldens.json      what the oracle says each fixture unpacks to and contains
helpers.ts        loadFixture / golden / assertMatchesGolden, typed golden shapes
```

Fixtures are named by their path under `bundles/` (`lz4.bundle`,
`editor/6000.3.25f1/lz4/main`).

## Editor-built fixtures (`bundles/editor/`)

Built with our own Unity project in three editors, per plan §5 and R11. The
project itself is not committed (R2: no C#); [`BUILDING.md`](BUILDING.md) holds
its sources and the batch-mode command.

| Editor | UnityFS | SerializedFile | Registry |
|---|---|---|---|
| 2019.4.41f2 | v7 | **21** | `[SerializeReference]` v1 |
| 2020.3.30f1 | v7 | **22** | `[SerializeReference]` v1 |
| 6000.3.25f1 | v8 | **22** | `[SerializeReference]` v2 |

Each editor has four variants - `lz4`, `lzma`, `uncompressed`, and
`lz4-notypetree` (built with `DisableWriteTypeTree`) - and each variant four
bundles:

- `shared` - one TextAsset (UTF-8 incl. a 4-byte emoji)
- `main` - one ScriptableObject (MonoBehaviour, class 114) covering int32, int64
  below -2^53, UInt64 max, float -0 / +Infinity / NaN, double, bool, byte,
  string, enum, lists, `byte[]`, nested structs, a PPtr into `shared` (a
  cross-file external) and a `[SerializeReference]` field; plus a one-triangle
  Mesh, whose vertex data is inline `TypelessData` (36 bytes)
- `texture` - one 4x4 RGBA32 Texture2D, no mips. Its `image data` is an empty
  `TypelessData`; the 64 pixel bytes live in a `.resS` node of the bundle
- `<variant>` - the AssetBundleManifest bundle Unity writes with every build

Each editor also has `registry/refs` (uncompressed, #96): a ScriptableObject
with 13 `[SerializeReference]` entries, so version 1 entry keys go past
`00000009`, and a ref type with a `[SerializeReference]` field of its own,
whose type tree carries a nested `ManagedReferencesRegistry` node
([`BUILDING.md`](BUILDING.md) section 5).

6000.3.25f1 also has `plain/textures` (uncompressed, #31): one 8x5 Texture2D in
each of the 17 plain formats the texture package converts in TS, pixels written
by script and kept inline ([`BUILDING.md`](BUILDING.md) section 6).

The block and Crunch formats (#32) are in three uncompressed bundles, one
32x16 (PVRTC: 32x32) Texture2D per format with a full mip chain, compressed by
the editor and kept inline ([`BUILDING.md`](BUILDING.md) sections 8 and 9):

| Bundle | Target | Formats |
|---|---|---|
| `6000.3.25f1/block/windows` | StandaloneWindows64 | DXT1, DXT5, BC4, BC5, BC6H, BC7, DXT1Crunched, DXT5Crunched |
| `6000.3.25f1/block/android` | Android | ETC_RGB4, ETC2_RGB, ETC2_RGBA1, ETC2_RGBA8, EAC_R, EAC_RG, ETC_RGB4Crunched, ETC2_RGBA8Crunched, ASTC 4x4/5x5/6x6/8x8/10x10/12x12, ASTC_HDR_4x4, ASTC_HDR_12x12 |
| `2019.4.41f2/block/ios` | iOS | PVRTC_RGB2, PVRTC_RGBA2, PVRTC_RGB4, PVRTC_RGBA4 |

Unity 6 no longer compresses PVRTC, hence the 2019.4 bundle. No fixture editor
writes ATC (its `TextureFormat` no longer has it) or signed EAC (the editor
refuses it), and every one of them writes Unity's own Crunch (2017.3+), not the
original: those are covered without a fixture (see Oracle notes).

6000.3.25f1 and 2020.3.30f1 also have `stripped/lz4` and `stripped/uncompressed`
(#104): the `hello.txt` TextAsset built with `AssetBundleStripUnityVersion`, so
the bundle header and the SerializedFile both record `"0.0.0"` as the editor.
The 6000.3.25f1 pair sets archive flag 0x200 (block padding, flags `0x243`); the
2020.3.30f1 pair predates that and does not (`0x43`)
([`BUILDING.md`](BUILDING.md) section 7).

Each editor also has `material/lz4/material`, `material/lz4-notypetree/material`
and `material/lz4-stripped/material` (#40): one Material with its serialized
fields set to values other than their defaults, except an empty
`m_BuildTextureStacks`, a null `_BumpMap` texture and `_NegZero`, which Unity
saves as `+0`. Each is built with type trees, without (`DisableWriteTypeTree`) and
version-stripped (`AssetBundleStripUnityVersion`, `"0.0.0"`). Its shader and
texture are in a dependency bundle that is not committed, so `m_Shader` and the
`_MainTex` slot point at an external file. The three editors give three of
Unity's Material layouts: 2019.4's, 2020.3's (adds `m_BuildTextureStacks`) and
6000.3's (`m_ValidKeywords` / `m_InvalidKeywords` and `m_Ints`)
([`BUILDING.md`](BUILDING.md) section 10).

Every editor also has `audio`, `font` and `video` in `lz4`, `lz4-notypetree`
and `stripped` (#41), built from generated source files
([`BUILDING.md`](BUILDING.md) section 11):

- `audio` - two AudioClips, PCM and Vorbis, each an FSB5 sound bank in the
  bundle's `.resource` node
- `font` - one dynamic Font with its TrueType file inline in `m_FontData`, plus
  the Material and the empty 0x0 "Font Texture" the importer adds
- `video` - one VideoClip, the WebM file in the bundle's `.resource` node

2019.4.41f2's `stripped` bundles are format 21, the others' format 22. No
fixture holds a MovieTexture (no fixture editor makes one with a movie).

NaN does not have one bit pattern everywhere, and that comes from Unity: every
editor wrote `0xFFC00000` into the first variant it built (`lz4`) and
`0x7FC00000` into the rest (see `BUILDING.md` section 4). The goldens record the
bytes as written, so the reader has to keep a NaN's sign bit.

The tested SerializedFile range is **formats 21 and 22** (Unity 2019.4 to
6000.x); `scripts/tests/fixtures.test.ts` fails if either format goes missing,
or if either loses a non-empty or empty `TypelessData`, a `.resS` node or one
of the two NaN patterns (#86).
Format 20 and older are ported but have no fixture.

## M1 container fixtures (`bundles/*.bundle`)

These predate the editor fixtures. They are written by
[`../scripts/make-fixtures.py`](../scripts/make-fixtures.py) using UnityPy's own
bundle writer, and each one is read back through `UnityPy.load()` before it is
written to disk — a fixture that the oracle cannot parse is not committed.

This keeps both rules that matter: nothing third-party is committed (R11 — every
byte comes from the seeded payloads in the generator), and goldens still come
from the oracle rather than from our own reader (R12).

Each node holds opaque generated bytes, not a real SerializedFile, so these
only exercise layers 1–2 (unpacking to `env.files`). They stay because they
cover container shapes no current editor writes (legacy UnityWeb/UnityRaw,
`UnityWebData`, gzip wrapping, blocks-info-at-end).

| Fixture | Container | Compression |
|---|---|---|
| `uncompressed.bundle` | UnityFS v6 | none |
| `lz4.bundle` | UnityFS v6 | LZ4 |
| `lzma.bundle` | UnityFS v6 | LZMA |
| `lz4-blocksinfo-at-end.bundle` | UnityFS v6 | LZ4, flag `0x80` |
| `lz4-padding.bundle` | UnityFS v6 | LZ4, flag `0x200` (2019.4+ align) |
| `lz4-v7-align.bundle` | UnityFS v7 | LZ4, 16-byte header align |
| `unityweb-lzma.bundle` | UnityWeb v3 (legacy) | LZMA |
| `unityraw.bundle` | UnityRaw v3 (legacy) | none |
| `unityraw-v2.bundle` | UnityRaw v2 (legacy, no `fileInfoHeaderSize`) | none |
| `webdata.data` | UnityWebData1.0 (WebFile) | none |
| `gzip-lz4.bundle.gz` | gzip around UnityFS v6 | LZ4 |

Not covered yet: UnityWeb/UnityRaw v4+ (UnityPy refuses to write them, so the
hash/CRC and version-6 archive-layout paths are covered by hand-written bytes in
`BundleFile.test.ts` instead), gzip/brotli around a `UnityWebData` file. The
editor fixtures have the plain (#31) and block (#32) texture formats but no
sprites yet; M3 adds the rest.

## Oracle notes

- `files` hashes are of the raw node bytes. For a node UnityPy parses as a
  SerializedFile they come from `entry.reader.bytes`, never `entry.save()`,
  which re-serializes and can differ from the original (#81).
- Only the hashes of the file header (`guid`, `scriptId`, `oldTypeHash`) are
  hex strings. A `Hash128` inside a typetree dump (a MonoScript's
  `m_PropertiesHash`, #124; the manifest's `AssetBundleHash`) stays as its type
  tree lays it out: 16 `UInt8` fields, `"bytes[0]"` to `"bytes[15]"`.
- UnityPy cannot fully read a `[SerializeReference]` registry of version 1
  (2019.4, 2020.3): its type tree describes one entry, but the data holds the
  entries plus a `Terminus` / `UnityEngine.DMAT` / `FAKE_ASM` sentinel entry that
  UnityPy never reads, so its read-length check fails. `make-goldens.py` checks
  that the unread tail is exactly that sentinel, or the entries after the first
  (read back with UnityPy's own `read_value`) and then the sentinel, dumps with
  `check_read=False`, and records `oracleNote` on the object, with the number of
  entries left unread (#25, #96).

- Texture goldens (`serialized.<file>.textures`, #31) hash UnityPy's
  `get_image_from_texture2d(flip=False)`: RGBA8 with the rows in the order Unity
  stores them, bottom row first. `decodeTexture2D` returns the top row first
  (#33), so its tests reverse the rows again (`reverseRows` in `helpers.ts`)
  before comparing; `convertPlain` keeps the stored order. `imageSha256` is the
  image data itself, inline or from the `.resS` node.
- UnityPy 1.25.3 (with Pillow 12.3) cannot decode 9 of the 17 plain formats:
  R16, RHalf, RGHalf, RGBAHalf, RFloat, RGFloat, RGBAFloat and RGB9e5Float fail
  inside its converter, and YUY2 is not implemented. Those goldens carry
  `oracleError` and no RGBA hash; the texture tests check them against
  AssetStudio's own decode methods instead (plan §6), plus hand-derived values.
- <a id="assetstudio-cross-check"></a>**AssetStudio cross-check hashes**
  (`ASSETSTUDIO_RGBA` in `packages/texture/tests/convert.test.ts`). They cover the
  9 formats above and the 2 below. They are cross-check values under plan §6,
  **not goldens**: UnityPy 1.25.3 raises on the 9, and they never go into
  `goldens.json`. Here is how they were made (#31):
  - **Source:** Razviar/assetstudio at `c37af7d`. The plain-format `Decode*`
    methods of `AssetStudio.Utility/Texture2DConverter.cs` (Alpha8, ARGB4444,
    RGB24, RGBA32, ARGB32, RGB565, R16, RGBA4444, BGRA32, RHalf, RGHalf,
    RGBAHalf, RFloat, RGFloat, RGBAFloat, YUY2, RGB9e5Float, plus
    `DownScaleFrom16BitTo8Bit`) were copied verbatim, together with
    `AssetStudio/Math/Half.cs` and `HalfHelper.cs`.
  - **Build and run:** a .NET 8 console app, built and run on Windows x64,
    **outside the repo** (R2). It ran over the `plain/textures` image bytes as
    UnityPy's `get_image_data()` extracts them.
  - **Hashing:** upstream writes BGRA. The harness swapped R and B once, then
    the RGBA8 was sha256-hashed, with rows as stored.
  - **Runtime caveat:** on .NET 8 an out-of-range `(byte)Math.Round(x)` wraps,
    while .NET 9+ saturates. None of the fixture values is out of range, so the
    hashes do not depend on the runtime.
- Two formats decode, but not as AssetStudio (the behavior source of truth)
  does, and carry `oracleNote` with the verdict: **Alpha8**, where UnityPy
  leaves R G B at 0 and AssetStudio sets 255, and **RGB565**, where Pillow
  widens a 5/6-bit channel as `floor(x * 255 / max)` and AssetStudio repeats its
  top bits (`(x << 3) | (x >> 2)`), up to 1 higher. The tests prove everything
  else about those two against the UnityPy golden.
- UnityPy decodes the ETC, EAC, PVRTC, ATC and Crunch formats with the Python
  `texture2ddecoder`, but BCn with Pillow and ASTC with `astc-encoder`, while
  AssetStudio (and this library) use Texture2DDecoder for all of them. Four
  families of the #32 fixtures come out differently and carry `oracleNote`
  with the verdict, AssetStudio: **BC4** (UnityPy grayscale, AssetStudio red
  only), **BC6H** and **ASTC** (channels up to 1 apart), and **ASTC HDR**
  (UnityPy's LDR `astc-encoder` gives its magenta error colour for every
  block). The tests check those against AssetStudio's hashes below; BC4 also
  against the golden, through the one-to-one red to grayscale map.
- **Synthetic goldens** (`synthetic` in `goldens.json`, #32). ATC and signed EAC
  have no fixture, so `make-goldens.py` hands UnityPy's `parse_image_data`
  generated block data instead: `sha256("<name>/0") + sha256("<name>/1") + ...`
  cut to the size of a 16x8 image (`syntheticBytes` in `helpers.ts` makes the
  same bytes, and the golden records their hash). Any bytes are valid ATC and
  EAC blocks. AssetStudio's decoder (below) gives the same four RGBA hashes.
- **Console goldens** (`platform` and `deswizzle` in `goldens.json`, #33). No
  fixture editor here has the Switch or Xbox 360 module (Switch needs a console
  SDK, Xbox 360 is gone from Unity), so there is no real console fixture. Instead:
  - `platform`: UnityPy's `parse_image_data` with the platform (and, for Switch,
    a 12-byte `m_PlatformBlob` whose bytes 8-11 give log2 of the GOBs per block)
    over generated bytes, as `synthetic` does. Six Switch textures (RGBA32,
    RGB24, ARGB4444, DXT1, DXT5, BC5) at sizes that need padding and cropping,
    and Xbox 360 DXT1 and DXT5. Each records the RGBA in both row orders
    (`flip=False` and `flip=True`), which also proves `reverseRows` is UnityPy's
    flip.
  - The DXT inputs have every BC1 colour block in 4-colour mode (c0 > c1,
    `four_color` / `fourColor`). On a c0 <= c1 block the decoders part ways:
    this library's Texture2DDecoder, AssetStudio's (Kyaru 0.17.0) and K0lb3's
    `texture2ddecoder` 1.0.6 all give the same pixels, and only UnityPy's
    Pillow differs (checked by hand on #131). The verdicts:
    - **DXT1, index 3: AssetStudio**, opaque black. Pillow gives transparent
      black (D3D BC1 semantics), but Unity's DXT1 has no alpha.
    - **DXT5, colour half: a known decoder defect**, tracked in #137. The spec
      (`EXT_texture_compression_s3tc`, D3D BC3) decodes DXT3/DXT5 colour as
      though c0 > c1 always, as Pillow does. Texture2DDecoder, here and
      upstream, switches to 3-colour mode instead. The fix belongs in
      `texture2ddecoder-wasm` (R13), so the generated inputs avoid such blocks
      rather than pin either result.
    The #32 fixtures have no c0 <= c1 block (0 of 32 blocks each in DXT1,
    DXT5 and their Crunch forms, one editor), while random bytes hit it often.
    With 4-colour blocks every decoder agrees on every pixel.
  - `deswizzle`: UnityPy's `TextureSwizzler.deswizzle` alone, one case for each
    texel shape of its format map (16x1 to 12x12), with the padded size.
  - Xbox 360 ARGB4444 and RGB565 have no UnityPy golden. UnityPy does not swap
    ARGB4444, and it widens RGB565 differently (see above). The tests check them
    against AssetStudio's `SwapBytesForXbox` worked by hand.
  - UnityPy's Switch path is the reference, because AssetStudio has none.
    AssetStudio's Xbox 360 swap list (ARGB4444, RGB565, DXT1, DXT5) is the
    source of truth over UnityPy's (RGB565, DXT1/5 and their Crunch).
- <a id="assetstudio-block-cross-check"></a>**AssetStudio block cross-check
  hashes** (`ASSETSTUDIO_RGBA` in `packages/texture/tests/decode.test.ts`).
  Cross-check values under plan §6, **not goldens**, for the 10 block textures
  above whose golden carries `oracleNote`, and for the original-Crunch path,
  which no fixture editor writes. Here is how they were made (#32):
  - **Source:** the block and Crunch branch of `DecodeTexture2D` and
    `UnpackCrunch` in `AssetStudio.Utility/Texture2DConverter.cs`
    (Razviar/assetstudio `c37af7d`), calling the decoder packages its
    `AssetStudio.Utility.csproj` references there: `Kyaru.Texture2DDecoder`
    0.17.0 and `Kyaru.Texture2DDecoder.Windows` 0.1.0.
  - **Build and run:** a .NET 8 console app on Windows x64, **outside the
    repo** (R2), over each texture's image data as UnityPy's
    `get_image_data()` extracts it, and over the synthetic inputs.
  - **Original Crunch:** the DXT1Crunched and DXT5Crunched image data again,
    with the Unity version given as 2017.1, so `UnpackCrunch` runs instead of
    `UnpackUnityCrunch` (the `legacy` entries).
  - **Hashing:** R and B swapped once, then sha256 of the RGBA8, rows as
    stored. For the 18 block textures without `oracleNote` the harness gives
    the UnityPy golden exactly.
- UnityPy refuses a bundle whose revision is `"0.0.0"` (version-stripped)
  unless `config.FALLBACK_UNITY_VERSION` is set, and with an editor before
  2020.3.34 as the fallback it reads a 6000.3.25f1 bundle's 0x200 as encryption.
  For an editor fixture `make-goldens.py` sets the fallback to the editor named
  by the fixture's folder. UnityPy only uses it when a version is missing, and
  the fixtures where it did carry `oracleNote` (#104).
- UnityPy only unwraps gzip when it wraps a `UnityWebData` file, **not** when it
  wraps a bundle. `make-goldens.py` gunzips with stdlib before handing the
  stream to the oracle, and records `oracleNote` on that fixture. The reader
  under test has to do the unwrap itself.
- UnityPy's `save_fs` docstring gives its packer tuple as
  `(block_info_flag, data_flag)`; the code takes `(data_flag, block_info_flag)`.
  Despite the names, `data_flag`'s low bits compress the *blocks-info* and
  `block_info_flag` compresses the *data blocks*. Established by round-trip.
- Raw-data goldens (`serialized.<file>.rawData`, #41) hash the bytes an
  AudioClip, Font, VideoClip or MovieTexture carries: the inline field
  (`m_FontData`, `m_MovieData`, a pre-5.0 `m_AudioData`) as UnityPy reads it,
  or the `StreamedResource` (`m_Resource`, `m_ExternalResources`) read with
  UnityPy's own `get_resource_data`, as its AudioClip export does. `source`
  names the resource file or says `inline`. Only files holding one of these
  classes get the key, so the other goldens are unchanged.
- A dynamic font's "Font Texture" (in every `font` bundle) is 0x0, with no
  inline image data and no `.resS`. UnityPy then looks for a resource file
  named `""` and fails, and there is nothing to hash or decode, so
  `make-goldens.py` gives such a Texture2D no texture golden (#41). Its type
  tree is still dumped.

## Regenerating

The oracle is not a dependency of the package or of CI — it is only needed when
fixtures change. Goldens were made with UnityPy 1.25.3.

```bash
python3 -m venv .venv-oracle && .venv-oracle/bin/pip install UnityPy==1.25.3
.venv-oracle/bin/python scripts/make-fixtures.py   # M1 container fixtures only
.venv-oracle/bin/python scripts/make-goldens.py    # every fixture under bundles/
npm test
```

Adding an M1 fixture: add an entry to `FIXTURES` in `make-fixtures.py`, then
rerun both scripts. Adding an editor fixture: follow [`BUILDING.md`](BUILDING.md),
then rerun `make-goldens.py`. Goldens are committed; never hand-edit `goldens.json`, and never
regenerate it from this library's own output (R12).
