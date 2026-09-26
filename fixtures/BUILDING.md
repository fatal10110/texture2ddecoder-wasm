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
each holding the same three files:

```
<project>/Assets/Fixtures/shared/hello.txt
<project>/Assets/Scripts/FixtureData.cs
<project>/Assets/Editor/BuildFixtures.cs
```

Unity creates `ProjectSettings/`, `Packages/` and the `.meta` files on first open.

`hello.txt` is UTF-8 without a BOM, LF line endings, 58 bytes. Create it
byte-exact rather than in an editor:

```bash
printf 'Hello from unity-asset-reader fixtures.\nLine 2: \xc3\xa9\xe2\x82\xac\xf0\x9f\x98\x80\n' > hello.txt
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

`Assets/Editor/BuildFixtures.cs` - creates `Assets/Fixtures/main/` and the
ScriptableObject asset in it on first run, points it at `hello.txt`, and builds
every variant:

```csharp
using System.IO;
using UnityEditor;
using UnityEngine;

public static class BuildFixtures
{
    const string Data = "Assets/Fixtures/main/data.asset";

    public static void Build()
    {
        var text = AssetDatabase.LoadAssetAtPath<TextAsset>("Assets/Fixtures/shared/hello.txt");
        // CreateAsset does not create folders, and a fresh project has no main/.
        if (!AssetDatabase.IsValidFolder("Assets/Fixtures/main")) AssetDatabase.CreateFolder("Assets/Fixtures", "main");
        var data = AssetDatabase.LoadAssetAtPath<FixtureData>(Data);
        if (data == null) { data = ScriptableObject.CreateInstance<FixtureData>(); AssetDatabase.CreateAsset(data, Data); }
        data.textRef = text;
        EditorUtility.SetDirty(data);
        AssetDatabase.SaveAssets();

        var builds = new[] {
            new AssetBundleBuild { assetBundleName = "shared", assetNames = new[] { "Assets/Fixtures/shared/hello.txt" } },
            new AssetBundleBuild { assetBundleName = "main",   assetNames = new[] { Data } },
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

for `<variant>` in `lz4`, `lzma`, `uncompressed`, `lz4-notypetree`: 12 files per
editor, 36 in total, about 145 KB.

## 4. Goldens

```bash
.venv-oracle/bin/python scripts/make-goldens.py
npm test
```

A rebuild does not reproduce the committed bytes: a fresh project gets new
asset GUIDs, so object IDs (pathIDs, SerializeReference rids) change, and with
them the order of objects and types and a few bytes of padding. Everything else
- headers, externals, type trees, object classes and sizes, typetree values - is
the same (checked for all 36 bundles against projects made from this page
alone). So if you rebuild, replace all of an editor's bundles together,
regenerate the goldens and commit both.
The oracle cannot fully read the version 1 `[SerializeReference]` registry
(2019.4, 2020.3); `make-goldens.py` handles that one case and records an
`oracleNote` on the object (see #25).
