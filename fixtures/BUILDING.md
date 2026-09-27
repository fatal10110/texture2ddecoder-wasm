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
