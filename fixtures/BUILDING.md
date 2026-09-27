# Building the editor fixtures

How `bundles/editor/**` was made, and how to make it again. Everything needed
is on this page: **the Unity project is never committed** (R2: no `.cs` in the
repo), so the two C# files below live only in a local project you create.

## Editors

| Editor | UnityFS | SerializedFile | `[SerializeReference]` registry |
|---|---|---|---|
| 2019.4.41f2 | v7 | **21** | version 1 |
| 2020.3.30f1 | v7 | **22** | version 1 |
| 6000.3.25f1 | v8 | **22** | version 2 |

Windows, build target `StandaloneWindows64`, no extra modules. Format 20 and
older (Unity 2019.2 and earlier) have no fixture.

## 1. Create the project (once per editor)

A `Library/` folder is editor-specific, so use one project folder per editor,
each holding the same four files:

```
<project>/Assets/Fixtures/shared/hello.txt
<project>/Assets/Fixtures/texture/checker.png
<project>/Assets/Scripts/FixtureData.cs
<project>/Assets/Editor/BuildFixtures.cs
```

Unity creates `ProjectSettings/`, `Packages/` and the `.meta` files on first open.

`hello.txt` is UTF-8 without a BOM, LF line endings, 58 bytes. Create it
byte-exact rather than in an editor:

```bash
printf 'Hello from unity-asset-reader fixtures.\nLine 2: \xc3\xa9\xe2\x82\xac\xf0\x9f\x98\x80\n' > hello.txt
```

`checker.png` is a 4x4 RGBA PNG, 136 bytes, sha256
`bd768da6b1b22a5518559a0a9bd29665de8f20a3393e0ce8479f132cda410063`. Every pixel
differs and alpha varies, so the importer keeps an alpha channel. Generate it
(stored deflate, so the bytes do not depend on the zlib version):

```python
import struct, zlib
# 4x4 RGBA, every pixel distinct, alpha varies so the importer keeps RGBA.
px = [[(r * 64, g * 64, 255 - 16 * (4 * r + g), 255 - 32 * g) for g in range(4)] for r in range(4)]
raw = b"".join(b"\x00" + bytes(c for p in row for c in p) for row in px)
chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 0)) + chunk(b"IEND", b"")
open("checker.png", "wb").write(png)
```

`Assets/Scripts/FixtureData.cs` - one field per value shape the typetree reader
has to get right:

```csharp
using System;
using System.Collections.Generic;
using UnityEngine;

public enum FixtureKind { None, Alpha, Beta = 7 }

[Serializable]
public struct Nested { public int a; public string b; public Vector3 v; }

[Serializable] public class RefBase { public int id; }
[Serializable] public class RefChild : RefBase { public string label; }

[CreateAssetMenu]
public class FixtureData : ScriptableObject
{
    public int i32 = -123456;
    public long i64 = -9007199254740993L;          // > 2^53: must survive as bigint
    public ulong u64 = 18446744073709551615UL;
    public float f32 = -0.0f;
    public float fInf = float.PositiveInfinity;
    public float fNaN = float.NaN;
    public double f64 = 0.1;
    public bool flag = true;
    public byte u8 = 200;
    public string text = "héllo €";
    public FixtureKind kind = FixtureKind.Beta;
    public List<int> ints = new List<int> { 1, 2, 3 };
    public byte[] bytes = { 0, 1, 2, 255 };
    public Nested nested = new Nested { a = 42, b = "nested", v = new Vector3(1, 2, 3) };
    public List<Nested> nestedList = new List<Nested> { new Nested { a = 1, b = "x" } };
    public TextAsset textRef;                       // PPtr -> other bundle (externals)
    [SerializeReference] public RefBase polymorphic = new RefChild { id = 9, label = "ref" }; // ref types (v20+)
}
```

`Assets/Editor/BuildFixtures.cs` - creates `Assets/Fixtures/main/`, the
ScriptableObject asset and a one-triangle Mesh in it on first run, points the
asset at `hello.txt`, imports `checker.png` as uncompressed RGBA32 without
mips, and builds every variant:

```csharp
using System.IO;
using UnityEditor;
using UnityEngine;

public static class BuildFixtures
{
    const string Data = "Assets/Fixtures/main/data.asset";
    const string Tex = "Assets/Fixtures/texture/checker.png";
    const string Tri = "Assets/Fixtures/main/tri.asset";

    public static void Build()
    {
        var text = AssetDatabase.LoadAssetAtPath<TextAsset>("Assets/Fixtures/shared/hello.txt");
        // CreateAsset does not create folders, and a fresh project has no main/.
        if (!AssetDatabase.IsValidFolder("Assets/Fixtures/main")) AssetDatabase.CreateFolder("Assets/Fixtures", "main");
        var data = AssetDatabase.LoadAssetAtPath<FixtureData>(Data);
        if (data == null) { data = ScriptableObject.CreateInstance<FixtureData>(); AssetDatabase.CreateAsset(data, Data); }
        data.textRef = text;
        // A Mesh keeps its vertex data inline as TypelessData; a texture's goes to .resS.
        if (AssetDatabase.LoadAssetAtPath<Mesh>(Tri) == null)
        {
            var tri = new Mesh { name = "tri", vertices = new[] { Vector3.zero, Vector3.up, Vector3.right }, triangles = new[] { 0, 1, 2 } };
            AssetDatabase.CreateAsset(tri, Tri);
        }
        EditorUtility.SetDirty(data);
        AssetDatabase.SaveAssets();

        // Plain RGBA32, one mip: every byte of the image is predictable.
        var imp = (TextureImporter)AssetImporter.GetAtPath(Tex);
        imp.textureCompression = TextureImporterCompression.Uncompressed;
        imp.mipmapEnabled = false;
        imp.SaveAndReimport();

        var builds = new[] {
            new AssetBundleBuild { assetBundleName = "shared", assetNames = new[] { "Assets/Fixtures/shared/hello.txt" } },
            new AssetBundleBuild { assetBundleName = "main",   assetNames = new[] { Data, Tri } },
            new AssetBundleBuild { assetBundleName = "texture", assetNames = new[] { Tex } },
        };
        Emit("lz4",          BuildAssetBundleOptions.ChunkBasedCompression, builds);
        Emit("lzma",         BuildAssetBundleOptions.None, builds);
        Emit("uncompressed", BuildAssetBundleOptions.UncompressedAssetBundle, builds);
        Emit("lz4-notypetree", BuildAssetBundleOptions.ChunkBasedCompression | BuildAssetBundleOptions.DisableWriteTypeTree, builds);
    }

    static void Emit(string name, BuildAssetBundleOptions opts, AssetBundleBuild[] builds)
    {
        var dir = Path.Combine("Build", name);
        Directory.CreateDirectory(dir);
        var m = BuildPipeline.BuildAssetBundles(dir, builds, opts,
                                                BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: " + name);
        Debug.Log("FIXTURE-OK " + name + " -> " + dir);
    }
}
```

Do not add `BuildAssetBundleOptions.DeterministicAssetBundle`: Unity 6 marks it
obsolete as an error, and it has been the default since 5.0 anyway.

## 2. Build (batch mode, no GUI)

```
Unity.exe -batchmode -nographics -quit -projectPath <project> -executeMethod BuildFixtures.Build -logFile <project>\build.log
```

`Unity.exe` is under `<Unity Hub editors dir>\<version>\Editor\`. The editor
uses the licence Unity Hub already activated. A run takes 1-2 minutes; the log
must contain four `FIXTURE-OK` lines. From WSL, call the same `Unity.exe`
through `/mnt/c/...` and pass Windows paths (`C:\...`) to `-projectPath`.

Output, per variant: `Build/<variant>/{shared, main, <variant>}` plus a
`.manifest` text file next to each. `<variant>` (the file named like its
folder) is the AssetBundleManifest bundle Unity writes for the build.

## 3. Copy into the repo

Only the bundles, never the `.manifest` text files:

```
Build/<variant>/<file>  ->  fixtures/bundles/editor/<editor version>/<variant>/<file>
```

for `<file>` in `shared`, `main`, `texture` and `<variant>`, and `<variant>` in
`lz4`, `lzma`, `uncompressed`, `lz4-notypetree`: 16 files per editor, 48 in
total, about 150 KB.

## 4. Goldens

```bash
.venv-oracle/bin/python scripts/make-goldens.py
npm test
```

A rebuild does not reproduce the committed bytes: a fresh project gets new
asset GUIDs, so object IDs (pathIDs, SerializeReference rids) change, and with
them the order of objects and types, the order of the AssetBundle preload
table, the bundle hashes in the AssetBundleManifest and a few bytes of padding.
Everything else - headers, externals, type trees, object classes and sizes,
all other typetree values - is the same (checked for all 48 bundles against
projects made from this page alone). So if you rebuild, replace all of an
editor's bundles together, regenerate the goldens and commit both.

Build every variant in one run, as `BuildFixtures.Build` does. In the first
run after the asset is created, the first variant built (`lz4`) serializes the
in-memory `float.NaN` as `0xFFC00000` and the rest get `0x7FC00000` (read back
from the saved asset). A second run writes `0x7FC00000` everywhere, which
changes the `lz4` NaN golden.

The oracle cannot fully read the version 1 `[SerializeReference]` registry
(2019.4, 2020.3); `make-goldens.py` handles that one case and records an
`oracleNote` on the object (see #25).

## 5. The `registry` bundle (#96)

One more bundle per editor, `registry/refs`: a ScriptableObject whose
`[SerializeReference]` list holds 13 entries, so a version 1 registry has
entry keys past `00000009`, and whose first entry is a ref type with a
`[SerializeReference]` field of its own, so its type tree carries a nested
`ManagedReferencesRegistry` node. It is built by a separate method into its own
folder, so the bundles of sections 1-3 and their manifests stay as they are.

Add two files to the same project:

`Assets/Scripts/RegistryData.cs`:

```csharp
using System;
using System.Collections.Generic;
using UnityEngine;

[Serializable] public class RefLeaf { public int n; }
[Serializable] public class RefHolder : RefLeaf { [SerializeReference] public RefLeaf inner; }

// 13 [SerializeReference] entries (v1 keys past 9) and a ref type with a
// [SerializeReference] field of its own (a nested registry node), #96.
public class RegistryData : ScriptableObject
{
    [SerializeReference] public List<RefLeaf> refs = new List<RefLeaf>();
}
```

`Assets/Editor/BuildRegistry.cs`:

```csharp
using System.IO;
using UnityEditor;
using UnityEngine;

public static class BuildRegistry
{
    const string Asset = "Assets/Fixtures/registry/registry.asset";

    public static void Build()
    {
        if (!AssetDatabase.IsValidFolder("Assets/Fixtures/registry")) AssetDatabase.CreateFolder("Assets/Fixtures", "registry");
        var data = AssetDatabase.LoadAssetAtPath<RegistryData>(Asset);
        if (data == null) { data = ScriptableObject.CreateInstance<RegistryData>(); AssetDatabase.CreateAsset(data, Asset); }
        // The holder first: UnityPy reads only the first v1 entry, so the oracle walks its ref type.
        data.refs.Clear();
        data.refs.Add(new RefHolder { n = 0, inner = new RefLeaf { n = 100 } });
        for (int i = 1; i <= 11; i++) data.refs.Add(new RefLeaf { n = i });
        EditorUtility.SetDirty(data);
        AssetDatabase.SaveAssets();

        var dir = Path.Combine("Build", "registry");
        Directory.CreateDirectory(dir);
        var builds = new[] { new AssetBundleBuild { assetBundleName = "refs", assetNames = new[] { Asset } } };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, BuildAssetBundleOptions.UncompressedAssetBundle,
                                                BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: registry");
        Debug.Log("FIXTURE-OK registry -> " + dir);
    }
}
```

Build with `-executeMethod BuildRegistry.Build` (same command as section 2;
the log must contain one `FIXTURE-OK registry` line), then copy only
`Build/registry/refs` to `fixtures/bundles/editor/<editor version>/registry/refs`
and rerun `make-goldens.py`.

The oracle reads only the first of the 13 version 1 entries, so the rest,
and the names Unity gives them, are checked against the asset's YAML
(`Assets/Fixtures/registry/registry.asset`), which the test copies by hand.
In 2019.4.41f2 and 2020.3.30f1 it names the entries `00000000` to
`00000009`, then `0000000A`, `0000000B`, `0000000C`: the id in 8 uppercase
hex digits. If you rebuild, check the YAML still says so.

## 6. The `plain` texture bundle (#31)

One bundle, `plain/textures`, built with **6000.3.25f1** only: an 8x5
Texture2D, no mips, in each plain (non-block) format the texture package
converts in TS - Alpha8, ARGB4444, RGB24, RGBA32, ARGB32, RGB565, R16,
RGBA4444, BGRA32, RHalf, RGHalf, RGBAHalf, RFloat, RGFloat, RGBAFloat, YUY2 and
RGB9e5Float. Pixel conversion does not depend on the editor version, so one
editor is enough. All 17 formats can be created on Windows, YUY2 included.

The textures are made by script, not imported, so their bytes are exactly what
the script writes: a byte ramp for the 8-bit and packed formats, `k/16` for
every half and float channel (checkable by hand, and `8/16` hits the 127.5
rounding tie), and exponents 14 and 15 for RGB9e5 (every value below 1). A
readable texture made by script keeps its pixels inline in `image data`, so
this bundle has no `.resS` node; the `texture` bundles of sections 1-3 cover
that path.

It needs none of the other assets, so any project will do; the committed
bundle came from a fresh, empty one. Add `Assets/Editor/BuildPlainTextures.cs`:

```csharp
using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

// One small Texture2D per plain (non-block) format, pixels written raw (#31).
public static class BuildPlainTextures
{
    const string Dir = "Assets/Fixtures/plain";
    // Not square and an odd height, so a transposed or row-shifted decode shows.
    const int W = 8, H = 5;

    static readonly TextureFormat[] Formats = {
        TextureFormat.Alpha8, TextureFormat.ARGB4444, TextureFormat.RGB24, TextureFormat.RGBA32,
        TextureFormat.ARGB32, TextureFormat.RGB565, TextureFormat.R16, TextureFormat.RGBA4444,
        TextureFormat.BGRA32, TextureFormat.RHalf, TextureFormat.RGHalf, TextureFormat.RGBAHalf,
        TextureFormat.RFloat, TextureFormat.RGFloat, TextureFormat.RGBAFloat, TextureFormat.YUY2,
        TextureFormat.RGB9e5Float,
    };

    public static void Build()
    {
        if (!AssetDatabase.IsValidFolder("Assets/Fixtures")) AssetDatabase.CreateFolder("Assets", "Fixtures");
        if (!AssetDatabase.IsValidFolder(Dir)) AssetDatabase.CreateFolder("Assets/Fixtures", "plain");
        var paths = new List<string>();
        foreach (var format in Formats)
        {
            try
            {
                var tex = new Texture2D(W, H, format, false) { name = format.ToString() };
                var size = tex.GetRawTextureData().Length;
                tex.LoadRawTextureData(Pixels(format, size));
                tex.Apply(false, false); // stays readable, so the pixels are kept as written
                var path = Dir + "/" + format + ".asset";
                AssetDatabase.DeleteAsset(path);
                AssetDatabase.CreateAsset(tex, path);
                paths.Add(path);
                Debug.Log("FIXTURE-TEX " + format + " " + size + " bytes");
            }
            catch (Exception e)
            {
                Debug.Log("FIXTURE-SKIP " + format + ": " + e.Message);
            }
        }
        AssetDatabase.SaveAssets();

        var dir = Path.Combine("Build", "plain");
        Directory.CreateDirectory(dir);
        var builds = new[] { new AssetBundleBuild { assetBundleName = "textures", assetNames = paths.ToArray() } };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, BuildAssetBundleOptions.UncompressedAssetBundle,
                                                BuildTarget.StandaloneWindows64);
        if (m == null) throw new Exception("build failed: plain");
        Debug.Log("FIXTURE-OK plain -> " + dir);
    }

    // Values a reader can check by hand: halves and floats are k/16, RGB9e5 has
    // exponent 14 or 15 (every value below 1), everything else is a byte ramp.
    static byte[] Pixels(TextureFormat format, int size)
    {
        var raw = new byte[size];
        switch (format)
        {
            case TextureFormat.RHalf:
            case TextureFormat.RGHalf:
            case TextureFormat.RGBAHalf:
                for (int j = 0; j < size / 2; j++)
                {
                    ushort h = Mathf.FloatToHalf((j % 17) / 16f);
                    raw[2 * j] = (byte)h;
                    raw[2 * j + 1] = (byte)(h >> 8);
                }
                break;
            case TextureFormat.RFloat:
            case TextureFormat.RGFloat:
            case TextureFormat.RGBAFloat:
                for (int j = 0; j < size / 4; j++)
                    Buffer.BlockCopy(BitConverter.GetBytes((j % 17) / 16f), 0, raw, 4 * j, 4);
                break;
            case TextureFormat.RGB9e5Float:
                for (int i = 0; i < size / 4; i++)
                {
                    uint e = (uint)(14 + i % 2);
                    uint r = (uint)(3 * i * 29 % 512), g = (uint)((3 * i + 1) * 29 % 512), b = (uint)((3 * i + 2) * 29 % 512);
                    Buffer.BlockCopy(BitConverter.GetBytes(e << 27 | b << 18 | g << 9 | r), 0, raw, 4 * i, 4);
                }
                break;
            default:
                for (int k = 0; k < size; k++) raw[k] = (byte)((k * 37 + 11) & 0xFF);
                break;
        }
        return raw;
    }
}
```

Build with `-executeMethod BuildPlainTextures.Build` (same command as section
2; `-nographics` is fine). The log must hold 17 `FIXTURE-TEX` lines, no
`FIXTURE-SKIP` and one `FIXTURE-OK plain`. Copy only `Build/plain/textures` to
`fixtures/bundles/editor/6000.3.25f1/plain/textures` and rerun
`make-goldens.py`.

UnityPy 1.25.3 decodes only 8 of the 17 formats, and 2 of those differently
from AssetStudio; the goldens record which (`oracleError`, `oracleNote`), see
[`README.md`](README.md#oracle-notes).

## 7. The `stripped` bundles (#104)

Two bundles per editor, built with **6000.3.25f1** and **2020.3.30f1** only:
`stripped/lz4` and `stripped/uncompressed`. Each holds `hello.txt` (the
section 1 file, byte-exact) and is built with `AssetBundleStripUnityVersion`.
Unity then writes `"0.0.0"` as the bundle header's `unityRevision` and as the
SerializedFile's editor version. 6000.3.25f1 also sets archive flag 0x200
(`BlockInfoNeedPaddingAtStart`, flags `0x243`), the bit an editor before
2020.3.34 wrote for encryption. 2020.3.30f1 does not set it (`0x43`), so its
pair is the control.

Any project will do. The committed bundles came from fresh ones holding only
`Assets/Fixtures/strip/hello.txt` and `Assets/Editor/BuildStripped.cs`:

```csharp
using System.IO;
using UnityEditor;
using UnityEngine;

// One TextAsset, built with AssetBundleStripUnityVersion, so the UnityFS header's
// unityRevision is "0.0.0" (#104).
public static class BuildStripped
{
    public static void Build()
    {
        Emit("lz4", BuildAssetBundleOptions.ChunkBasedCompression);
        Emit("uncompressed", BuildAssetBundleOptions.UncompressedAssetBundle);
    }

    static void Emit(string name, BuildAssetBundleOptions opts)
    {
        var dir = Path.Combine("Build", "stripped-" + name);
        Directory.CreateDirectory(dir);
        var builds = new[] { new AssetBundleBuild { assetBundleName = name, assetNames = new[] { "Assets/Fixtures/strip/hello.txt" } } };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, opts | BuildAssetBundleOptions.AssetBundleStripUnityVersion,
                                                BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: stripped " + name);
        Debug.Log("FIXTURE-OK stripped " + name + " -> " + dir);
    }
}
```

Build with `-executeMethod BuildStripped.Build` (same command as section 2).
The log must hold two `FIXTURE-OK stripped` lines. Copy only
`Build/stripped-lz4/lz4` and `Build/stripped-uncompressed/uncompressed` to
`fixtures/bundles/editor/<editor version>/stripped/`, then rerun
`make-goldens.py`. UnityPy has to be told the editor for these bundles. The
script takes it from the folder name and records an `oracleNote`
([`README.md`](README.md#oracle-notes)).

## 8. The `block` bundles (#32)

Two bundles built with **6000.3.25f1**, `block/windows` and `block/android`:
one 32x16 Texture2D with a full mip chain per block and Crunch format that the
editor compresses, made by script from the same RGBA32 pixels and compressed
with `EditorUtility.CompressTexture`. A readable texture keeps its image data
inline, as in section 6. Pixel decoding does not depend on the editor, so one
editor is enough; PVRTC is the exception (section 9).

The editor only compresses a texture with mips when its sides are powers of
two, hence 32x16; that is still not a whole number of 6x6, 10x10 or 12x12 ASTC
blocks, so partial blocks are covered. A StandaloneWindows64 build refuses ETC
Crunch, so the mobile formats go into an Android bundle (the editor needs the
Android module). The editor does not compress signed EAC and has no ATC; see
[`README.md`](README.md#oracle-notes) for how those are covered.

Any project will do; the committed bundles came from one holding only
`Assets/Editor/BuildBlockTextures.cs`:

```csharp
using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

// One small Texture2D per block / Crunch format, compressed by the editor (#32).
public static class BuildBlockTextures
{
    const string Dir = "Assets/Fixtures/block";
    // Power of two (the editor only compresses those when there are mips), not
    // square, and not a whole number of 6x6, 10x10 or 12x12 ASTC blocks.
    const int W = 32, H = 16;

    // By value: several of these names are obsolete in Unity 6, some as errors.
    // Desktop formats go into a StandaloneWindows64 bundle; the mobile ones into
    // an Android bundle, since a Standalone build refuses ETC Crunch.
    static readonly int[] Windows = {
        10, 12, 26, 27, 24, 25,         // DXT1 DXT5 BC4 BC5 BC6H BC7
        28, 29,                         // DXT1Crunched DXT5Crunched
    };
    static readonly int[] Android = {
        34, 45, 46, 47,                 // ETC_RGB4 ETC2_RGB ETC2_RGBA1 ETC2_RGBA8
        41, 43,                         // EAC_R EAC_RG
        64, 65,                         // ETC_RGB4Crunched ETC2_RGBA8Crunched
        48, 49, 50, 51, 52, 53,         // ASTC 4x4 5x5 6x6 8x8 10x10 12x12
        66, 71,                         // ASTC_HDR_4x4 ASTC_HDR_12x12
    };

    public static void Build()
    {
        if (!AssetDatabase.IsValidFolder("Assets/Fixtures")) AssetDatabase.CreateFolder("Assets", "Fixtures");
        if (!AssetDatabase.IsValidFolder(Dir)) AssetDatabase.CreateFolder("Assets/Fixtures", "block");
        Emit("windows", Windows, BuildTarget.StandaloneWindows64);
        Emit("android", Android, BuildTarget.Android);
    }

    static void Emit(string bundle, int[] formats, BuildTarget target)
    {
        var paths = new List<string>();
        foreach (var value in formats)
        {
            var format = (TextureFormat)value;
            var name = value + "_" + format;
            try
            {
                int w = W, h = H;
                var tex = new Texture2D(w, h, TextureFormat.RGBA32, true) { name = name };
                tex.SetPixels32(Pixels(w, h));
                tex.Apply(true, false);
                EditorUtility.CompressTexture(tex, format, 100);
                if (tex.format != format) throw new Exception("came out as " + tex.format);
                tex.Apply(false, false); // stays readable, so the image data stays inline
                var path = Dir + "/" + name + ".asset";
                AssetDatabase.DeleteAsset(path);
                AssetDatabase.CreateAsset(tex, path);
                paths.Add(path);
                Debug.Log("FIXTURE-TEX " + name + " " + w + "x" + h + " mips " + tex.mipmapCount + " " + tex.GetRawTextureData().Length + " bytes");
            }
            catch (Exception e)
            {
                Debug.Log("FIXTURE-SKIP " + name + ": " + e.Message);
            }
        }
        AssetDatabase.SaveAssets();

        var dir = Path.Combine("Build", "block-" + bundle);
        Directory.CreateDirectory(dir);
        var builds = new[] { new AssetBundleBuild { assetBundleName = bundle, assetNames = paths.ToArray() } };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, BuildAssetBundleOptions.UncompressedAssetBundle, target);
        if (m == null) throw new Exception("build failed: block " + bundle);
        Debug.Log("FIXTURE-OK block " + bundle + " -> " + dir);
    }

    // Smooth ramps (what block encoders are made for) plus a hard diagonal edge,
    // and alpha that varies, so the alpha formats keep an alpha channel.
    static Color32[] Pixels(int w, int h)
    {
        var px = new Color32[w * h];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                byte r = (byte)(x * 255 / (w - 1));
                byte g = (byte)(y * 255 / (h - 1));
                byte b = (byte)(x + y < (w + h) / 2 ? 40 : 220);
                byte a = (byte)(255 - (x * 7 + y * 11) % 256);
                px[y * w + x] = new Color32(r, g, b, a);
            }
        return px;
    }
}
```

Build with `-executeMethod BuildBlockTextures.Build` (same command as section
2). The log must hold 24 `FIXTURE-TEX` lines, no `FIXTURE-SKIP`, and two
`FIXTURE-OK block` lines. Copy only `Build/block-windows/windows` and
`Build/block-android/android` to `fixtures/bundles/editor/6000.3.25f1/block/`
and rerun `make-goldens.py`.

## 9. The PVRTC bundle (#32)

Unity 6 no longer compresses PVRTC ("PVRTC compression is obsolete and no
longer supported"), so `block/ios` is built with **2019.4.41f2**, which needs
the iOS module: one 32x32 Texture2D (PVRTC wants a square power of two) with a
full mip chain in each of PVRTC_RGB2, PVRTC_RGBA2, PVRTC_RGB4 and PVRTC_RGBA4,
same pixels as section 8, for BuildTarget iOS. The script tries ATC too;
2019.4's editor leaves it RGBA32 and skips it, and no fixture editor has it.

The committed bundle came from a project holding only
`Assets/Editor/BuildMobileTextures.cs`:

```csharp
using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

// PVRTC and ATC, which Unity 6 no longer compresses (#32).
public static class BuildMobileTextures
{
    const string Dir = "Assets/Fixtures/mobile";
    // PVRTC wants a square power of two.
    const int W = 32, H = 32;

    static readonly int[] Ios = { 30, 31, 32, 33 };   // PVRTC_RGB2 PVRTC_RGBA2 PVRTC_RGB4 PVRTC_RGBA4
    static readonly int[] Android = { 35, 36 };       // ATC_RGB4 ATC_RGBA8

    public static void Build()
    {
        if (!AssetDatabase.IsValidFolder("Assets/Fixtures")) AssetDatabase.CreateFolder("Assets", "Fixtures");
        if (!AssetDatabase.IsValidFolder(Dir)) AssetDatabase.CreateFolder("Assets/Fixtures", "mobile");
        Emit("ios", Ios, BuildTarget.iOS);
        Emit("android", Android, BuildTarget.Android);
    }

    static void Emit(string bundle, int[] formats, BuildTarget target)
    {
        var paths = new List<string>();
        foreach (var value in formats)
        {
            var format = (TextureFormat)value;
            var name = value + "_" + format;
            try
            {
                var tex = new Texture2D(W, H, TextureFormat.RGBA32, true) { name = name };
                tex.SetPixels32(Pixels(W, H));
                tex.Apply(true, false);
                EditorUtility.CompressTexture(tex, format, 100);
                if (tex.format != format) throw new Exception("came out as " + tex.format);
                tex.Apply(false, false);
                var path = Dir + "/" + name + ".asset";
                AssetDatabase.DeleteAsset(path);
                AssetDatabase.CreateAsset(tex, path);
                paths.Add(path);
                Debug.Log("FIXTURE-TEX " + name + " " + W + "x" + H + " mips " + tex.mipmapCount + " " + tex.GetRawTextureData().Length + " bytes");
            }
            catch (Exception e)
            {
                Debug.Log("FIXTURE-SKIP " + name + ": " + e.Message);
            }
        }
        AssetDatabase.SaveAssets();
        if (paths.Count == 0) { Debug.Log("FIXTURE-SKIP bundle " + bundle); return; }

        var dir = Path.Combine("Build", "mobile-" + bundle);
        Directory.CreateDirectory(dir);
        var builds = new[] { new AssetBundleBuild { assetBundleName = bundle, assetNames = paths.ToArray() } };
        var m = BuildPipeline.BuildAssetBundles(dir, builds, BuildAssetBundleOptions.UncompressedAssetBundle, target);
        if (m == null) throw new Exception("build failed: mobile " + bundle);
        Debug.Log("FIXTURE-OK mobile " + bundle + " -> " + dir);
    }

    static Color32[] Pixels(int w, int h)
    {
        var px = new Color32[w * h];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                byte r = (byte)(x * 255 / (w - 1));
                byte g = (byte)(y * 255 / (h - 1));
                byte b = (byte)(x + y < (w + h) / 2 ? 40 : 220);
                byte a = (byte)(255 - (x * 7 + y * 11) % 256);
                px[y * w + x] = new Color32(r, g, b, a);
            }
        return px;
    }
}
```

Build with `-executeMethod BuildMobileTextures.Build` (same command as
section 2). The log holds four `FIXTURE-TEX` lines for PVRTC, one
`FIXTURE-OK mobile ios`, and `FIXTURE-SKIP` for the two ATC formats and the
Android bundle. Copy only `Build/mobile-ios/ios` to
`fixtures/bundles/editor/2019.4.41f2/block/ios` and rerun `make-goldens.py`.

A rebuild of either section gives new pathIDs (section 4) and may give other
compressed bytes. Then regenerate the goldens and the AssetStudio cross-check
hashes of `decode.test.ts` together
([`README.md`](README.md#assetstudio-block-cross-check)).

## 10. The `material` bundles (#40)

Three bundles per editor, all three editors: `material/lz4`,
`material/lz4-notypetree` and `material/lz4-stripped`, each holding one bundle
file `material`. It holds one Material whose serialized fields are set to
values other than their defaults, except three:
`m_BuildTextureStacks` stays empty (it needs virtual texturing), the
`_BumpMap` slot has no texture (it is the shader's second slot, left null), and
`_NegZero` is saved as `+0` although the script sets `-0f` (see the end of this
section). The elements of `m_BuildTextureStacks` are covered only by the
hand-built layouts in `packages/core/tests/Material.test.ts`. The shader and
the texture it uses go into a second
bundle, `matdeps`, which is not committed: the material bundle then holds only
the Material and its AssetBundle, and `m_Shader` and the `_MainTex` slot point
at an external file. (With the built-in Standard shader, Unity copies the whole
compiled shader, about 74 KB, into the bundle.)

Any project will do; the committed bundles came from a fresh one per editor
holding only these files:

```
<project>/Assets/Fixtures/material/checker.png   (section 1)
<project>/Assets/Fixtures/material/uar.shader
<project>/Assets/Editor/BuildMaterial.cs
```

`uar.shader` declares each kind of property the Material saves. Replace
`INT_TYPE` with `Integer` for 6000.3.25f1 (Unity 2021.1 added the type; its
values go to `m_Ints`) and with `Int` for 2019.4.41f2 and 2020.3.30f1 (a float,
saved in `m_Floats`):

```shaderlab
// Properties of every kind a Material saves (#40). INT_TYPE is Integer from
// Unity 2021.1 (saved in m_Ints), Int (a float, saved in m_Floats) before.
Shader "UAR/Fixture"
{
    Properties
    {
        _MainTex ("Main", 2D) = "white" {}
        _BumpMap ("Bump", 2D) = "bump" {}
        _Color ("Color", Color) = (1, 1, 1, 1)
        _EmissionColor ("Emission", Color) = (0, 0, 0, 1)
        _Glossiness ("Gloss", Range(0, 1)) = 0.5
        _NegZero ("NegZero", Float) = 0
        _UarInt ("Int", INT_TYPE) = 0
    }
    SubShader
    {
        Tags { "RenderType" = "Opaque" }
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma shader_feature _EMISSION
            #pragma shader_feature _NORMALMAP
            #include "UnityCG.cginc"
            sampler2D _MainTex;
            fixed4 _Color;
            float4 vert(float4 v : POSITION) : SV_POSITION { return UnityObjectToClipPos(v); }
            fixed4 frag() : SV_Target { return _Color; }
            ENDCG
        }
        Pass
        {
            Tags { "LightMode" = "ShadowCaster" }
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"
            float4 vert(float4 v : POSITION) : SV_POSITION { return UnityObjectToClipPos(v); }
            fixed4 frag() : SV_Target { return 0; }
            ENDCG
        }
    }
}
```

`Assets/Editor/BuildMaterial.cs`:

```csharp
using System.IO;
using UnityEditor;
using UnityEngine;

// One Material with the fields Unity serializes set to values other than
// their defaults (#40): a shader and a texture in another bundle, scale and offset, floats,
// colors, keywords, tags, a disabled pass, a render queue, instancing, GI flags.
public static class BuildMaterial
{
    const string Dir = "Assets/Fixtures/material";
    const string Mat = Dir + "/uar.mat";
    const string Tex = Dir + "/checker.png";
    const string Shd = Dir + "/uar.shader";

    public static void Build()
    {
        if (!AssetDatabase.IsValidFolder("Assets/Fixtures")) AssetDatabase.CreateFolder("Assets", "Fixtures");
        if (!AssetDatabase.IsValidFolder(Dir)) AssetDatabase.CreateFolder("Assets/Fixtures", "material");
        var imp = (TextureImporter)AssetImporter.GetAtPath(Tex);
        imp.textureCompression = TextureImporterCompression.Uncompressed;
        imp.mipmapEnabled = false;
        imp.SaveAndReimport();

        AssetDatabase.DeleteAsset(Mat);
        var mat = new Material(AssetDatabase.LoadAssetAtPath<Shader>(Shd)) { name = "uar" };
        mat.SetTexture("_MainTex", AssetDatabase.LoadAssetAtPath<Texture2D>(Tex));
        mat.SetTextureScale("_MainTex", new Vector2(2f, 3f));
        mat.SetTextureOffset("_MainTex", new Vector2(0.25f, -0.5f));
        mat.SetColor("_Color", new Color(0.1f, 0.2f, 0.3f, 0.4f));
        mat.SetColor("_EmissionColor", new Color(2f, 0.5f, 0f, 1f));
        mat.SetFloat("_Glossiness", 0.75f);
        mat.SetFloat("_NegZero", -0f);
#if UNITY_2021_1_OR_NEWER
        mat.SetInteger("_UarInt", -7);
#else
        mat.SetFloat("_UarInt", -7f);
#endif
        mat.EnableKeyword("_EMISSION");
        mat.EnableKeyword("_NORMALMAP");
        mat.EnableKeyword("UAR_NOT_IN_SHADER");
        mat.SetOverrideTag("RenderType", "TransparentCutout");
        mat.SetShaderPassEnabled("ShadowCaster", false);
        mat.renderQueue = 2450;
        mat.enableInstancing = true;
        mat.doubleSidedGI = true;
        mat.globalIlluminationFlags = MaterialGlobalIlluminationFlags.BakedEmissive;
        AssetDatabase.CreateAsset(mat, Mat);
        AssetDatabase.SaveAssets();

        // The shader and the texture go into a bundle of their own, so m_Shader and
        // m_TexEnvs point at another file and the material bundle holds only the
        // Material (and its AssetBundle).
        var builds = new[] {
            new AssetBundleBuild { assetBundleName = "material", assetNames = new[] { Mat } },
            new AssetBundleBuild { assetBundleName = "matdeps", assetNames = new[] { Shd, Tex } },
        };
        var lz4 = BuildAssetBundleOptions.ChunkBasedCompression;
        Emit("lz4", lz4, builds);
        Emit("lz4-notypetree", lz4 | BuildAssetBundleOptions.DisableWriteTypeTree, builds);
        Emit("lz4-stripped", lz4 | BuildAssetBundleOptions.AssetBundleStripUnityVersion, builds);
    }

    static void Emit(string name, BuildAssetBundleOptions opts, AssetBundleBuild[] builds)
    {
        var dir = Path.Combine("Build", "material-" + name);
        Directory.CreateDirectory(dir);
        var m = BuildPipeline.BuildAssetBundles(dir, builds, opts, BuildTarget.StandaloneWindows64);
        if (m == null) throw new System.Exception("build failed: material " + name);
        Debug.Log("FIXTURE-OK material " + name + " -> " + dir);
    }
}
```

Build with `-executeMethod BuildMaterial.Build` (same command as section 2).
The log must hold three `FIXTURE-OK material` lines. Copy only
`Build/material-<variant>/material` to
`fixtures/bundles/editor/<editor version>/material/<variant>/material` for
`<variant>` in `lz4`, `lz4-notypetree` and `lz4-stripped`, then rerun
`make-goldens.py`; it dumps the Material's type tree (class 21).

Unity drops properties the shader does not declare, and saved `_NegZero`'s
`-0f` as `+0`. The keywords come out as the script enabled them:
`_EMISSION` and `_NORMALMAP` are declared, `UAR_NOT_IN_SHADER` is not, so from
2021.2.18 it lands in `m_InvalidKeywords`. `SetShaderPassEnabled` stores the
pass's `LightMode` upper-cased (`SHADOWCASTER`).
