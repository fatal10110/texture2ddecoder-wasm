#!/usr/bin/env python3
"""Generate the committed goldens from the UnityPy oracle (R12).

Goldens must never come from this library's own output, so everything written
here is read back out of UnityPy. Run it once after adding or regenerating a
fixture; the oracle is not a dependency of the package or of CI.

Per fixture:
  files      - node path -> sha256 of the unpacked bytes  (what M1's env.files must match)
  objects    - per unpacked SerializedFile, the object table  (empty until M2 fixtures exist)

Normalization (plan section 5): int64 -> decimal string, byte arrays -> sha256 hex.
Floats are compared by float32 bit pattern; nothing here emits floats yet.

Usage:  .venv-oracle/bin/python scripts/make-goldens.py
"""

from __future__ import annotations

import gzip
import hashlib
import json
import pathlib
import sys

import UnityPy

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures" / "bundles"
GOLDENS = ROOT / "fixtures" / "goldens.json"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def object_table(serialized) -> list[dict]:
    """Object table for a SerializedFile, or [] for an opaque resource node."""
    table = []
    for obj in getattr(serialized, "objects", {}).values():
        table.append(
            {
                # path_id is int64 - decimal string so JS reading the golden
                # does not lose precision before it gets to a BigInt.
                "pathId": str(obj.path_id),
                "classId": int(obj.class_id),
                "byteSize": int(obj.byte_size),
            }
        )
    table.sort(key=lambda o: o["pathId"])
    return table


def raw_bytes(name: str, entry) -> bytes:
    """The node's bytes exactly as stored in the container.

    Opaque nodes carry them as ``.bytes``. A node UnityPy parsed as a
    SerializedFile keeps them on its ``.reader``; ``entry.save()`` would write
    the file back out instead, and that re-serialization can differ from the
    original (#81: 7576 vs 7580 bytes on a Unity 6 bundle).
    """
    if hasattr(entry, "bytes"):
        return bytes(entry.bytes)
    reader = getattr(entry, "reader", None)
    if reader is None:
        raise SystemExit(f"{name}: node has neither .bytes nor .reader - cannot hash its raw bytes")
    return bytes(reader.bytes)


def read_fixture(path: pathlib.Path) -> dict:
    raw = path.read_bytes()
    note = None
    if raw[:2] == b"\x1f\x8b":
        # UnityPy only unwraps gzip around a UnityWebData file, not around a
        # bundle, so the oracle is handed the decompressed stream. The reader
        # under test has to do this itself - see #15 / #19.
        raw = gzip.decompress(raw)
        note = "gunzipped with stdlib before handing the stream to UnityPy"

    env = UnityPy.load(raw)
    bundle = list(env.files.values())[0]

    files = {}
    objects = {}
    for name, entry in bundle.files.items():
        data = raw_bytes(name, entry)
        files[name] = {"sha256": sha256(data), "size": len(data)}
        table = object_table(entry)
        if table:
            objects[name] = table

    golden = {"signature": bundle.signature}
    # A WebFile has none of the bundle version fields - it carries its version
    # inside the signature ("UnityWebData1.0") and nothing else.
    if hasattr(bundle, "version"):
        golden["formatVersion"] = int(bundle.version)
        golden["unityVersion"] = bundle.version_player
        golden["unityRevision"] = bundle.version_engine
    golden["files"] = dict(sorted(files.items()))
    golden["objects"] = objects
    if note:
        golden["oracleNote"] = note
    return golden


def main() -> None:
    if not FIXTURES.is_dir():
        raise SystemExit("no fixtures - run scripts/make-fixtures.py first")

    goldens = {
        "_oracle": f"UnityPy {UnityPy.__version__}",
        "_generator": "scripts/make-goldens.py",
        "fixtures": {},
    }
    for path in sorted(FIXTURES.iterdir()):
        if path.name.startswith("."):
            continue
        goldens["fixtures"][path.name] = read_fixture(path)
        print(f"  {path.name:<32} {len(goldens['fixtures'][path.name]['files'])} files")

    GOLDENS.write_text(json.dumps(goldens, indent=2, sort_keys=False) + "\n")
    print(f"\n{len(goldens['fixtures'])} goldens -> {GOLDENS.relative_to(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
