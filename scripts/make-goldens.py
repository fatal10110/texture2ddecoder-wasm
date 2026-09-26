#!/usr/bin/env python3
"""Generate the committed goldens from the UnityPy oracle (R12).

Goldens must never come from this library's own output, so everything written
here is read back out of UnityPy. Run it once after adding or regenerating a
fixture; the oracle is not a dependency of the package or of CI.

Per fixture (keyed by its path under fixtures/bundles/):
  files       - node path -> sha256 of the unpacked bytes  (what M1's env.files must match)
  objects     - per unpacked SerializedFile, the object table
  serialized  - per unpacked SerializedFile: header, externals, type trees, and
                read_typetree() dumps of TextAsset / MonoBehaviour objects  (M2)

Normalization (plan section 5), applied by walking the type tree next to the
value so the node type decides, not the Python type:
  SInt64/UInt64/FileSize -> decimal string
  float  -> "f32:<8 hex digits>"   double -> "f64:<16 hex digits>"  (bit patterns,
            big-endian, so NaN / -0 / Infinity compare exactly)
  TypelessData, vectors of UInt8/SInt8/char, other raw bytes -> "hex:<hex>"
  hashes (guid, script ids) -> hex string

Usage:  .venv-oracle/bin/python scripts/make-goldens.py
"""

from __future__ import annotations

import gzip
import hashlib
import json
import pathlib
import re
import struct
import sys

import UnityPy
from UnityPy.helpers.TypeTreeHelper import get_ref_type_node

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures" / "bundles"
GOLDENS = ROOT / "fixtures" / "goldens.json"

INT64_TYPES = {"SInt64", "UInt64", "long long", "unsigned long long", "FileSize"}
BYTE_TYPES = {"UInt8", "SInt8", "char"}
# Classes whose read_typetree() output is part of the goldens (#25).
DUMPED_CLASSES = {49: "TextAsset", 114: "MonoBehaviour"}
# Sentinel entry that ends a ManagedReferencesRegistry version 1 list (#25).
REGISTRY_V1_TERMINUS = (
    b"\x08\x00\x00\x00Terminus" b"\x10\x00\x00\x00UnityEngine.DMAT" b"\x08\x00\x00\x00FAKE_ASM"
)


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


def hex_or_none(value) -> str | None:
    return None if value is None else bytes(value).hex()


def flatten(node) -> list[list]:
    """Type tree as a pre-order list of [level, type, name, byteSize, metaFlag]."""
    out = []
    stack = [node]
    while stack:
        n = stack.pop()
        out.append([n.m_Level, n.m_Type, n.m_Name, n.m_ByteSize, n.m_MetaFlag])
        stack.extend(reversed(n.m_Children))
    return out


def serialized_type(t) -> dict:
    out = {
        "classId": int(t.class_id),
        "isStrippedType": t.is_stripped_type,
        "scriptTypeIndex": t.script_type_index,
        "scriptId": hex_or_none(t.script_id),
        "oldTypeHash": hex_or_none(t.old_type_hash),
        "typeDependencies": None if t.type_dependencies is None else list(t.type_dependencies),
        "nodes": flatten(t.node) if t.node is not None else None,
    }
    if t.m_ClassName is not None:  # ref types only
        out["className"] = t.m_ClassName
        out["namespace"] = t.m_NameSpace
        out["assembly"] = t.m_AssemblyName
    return out


def normalize(node, value, sf):
    """Apply the plan section 5 normalization, driven by the type tree node."""
    typ = node.m_Type
    if typ in INT64_TYPES:
        return str(value)
    if typ == "float":
        return "f32:" + struct.pack(">f", value).hex()
    if typ == "double":
        return "f64:" + struct.pack(">d", value).hex()
    if isinstance(value, (bytes, bytearray, memoryview)):
        return "hex:" + bytes(value).hex()
    if isinstance(value, (str, bool, int)) or value is None:
        return value
    if typ == "pair":
        return [normalize(node.m_Children[0], value[0], sf), normalize(node.m_Children[1], value[1], sf)]
    if node.m_Children and node.m_Children[0].m_Type == "Array":
        element = node.m_Children[0].m_Children[1]
        # A byte vector (C# byte[] / sbyte[]) is a byte array under section 5,
        # though UnityPy hands it over as a list of ints. Strings never get here.
        if element.m_Type in BYTE_TYPES:
            return "hex:" + bytes(v & 0xFF for v in value).hex()
        return [normalize(element, v, sf) for v in value]
    if typ == "ReferencedObject":
        out = {}
        for child in node.m_Children:
            if child.m_Name not in value:
                continue
            if child.m_Type == "ReferencedObjectData":
                out[child.m_Name] = normalize(get_ref_type_node(value, sf), value[child.m_Name], sf)
            else:
                out[child.m_Name] = normalize(child, value[child.m_Name], sf)
        return out
    if isinstance(value, dict):
        by_name = {c.m_Name: c for c in node.m_Children}
        return {k: normalize(by_name[k], v, sf) for k, v in value.items()}
    raise SystemExit(f"cannot normalize {typ} {node.m_Name}: {type(value).__name__}")


def dump_typetree(name: str, obj, sf) -> dict:
    """read_typetree() of one object, normalized, plus a note if UnityPy needed help."""
    node = obj._get_typetree_node()
    try:
        return {"value": normalize(node, obj.read_typetree(), sf)}
    except ValueError as error:
        # UnityPy walks a ManagedReferencesRegistry version 1 (Unity <= 2020) as
        # if it held one entry and stops before the Terminus sentinel that ends
        # the list, then fails its own read-length check (#25). Accept that one
        # case - and only when the unread tail is exactly the sentinel - and
        # record it; anything else is a real oracle failure.
        # Every v1 registry ends with the sentinel, so that alone proves nothing:
        # UnityPy must also have stopped exactly the sentinel's length short. A
        # larger gap means it skipped real entries too (e.g. a second one).
        short = re.search(r"Expected to read (\d+) bytes, but only read (\d+)", str(error))
        unread = int(short[1]) - int(short[2]) if short else None
        raw = obj.get_raw_data()
        if unread != len(REGISTRY_V1_TERMINUS) or not raw.endswith(REGISTRY_V1_TERMINUS):
            raise SystemExit(f"{name} pathId {obj.path_id}: read_typetree failed: {error}")
        value = obj.read_typetree(check_read=False)
        if value.get("references", {}).get("version") != 1:
            raise SystemExit(f"{name} pathId {obj.path_id}: unexpected read failure: {error}")
        return {
            "value": normalize(node, value, sf),
            "oracleNote": (
                "UnityPy stops before the ManagedReferencesRegistry v1 Terminus sentinel "
                f"({len(REGISTRY_V1_TERMINUS)} bytes, verified present); dump read with "
                "check_read=False - see #25"
            ),
        }


def serialized_golden(name: str, sf) -> dict:
    """Header, types and typetree dumps of one SerializedFile (M2 goldens)."""
    out = {
        "formatVersion": int(sf.header.version),
        "unityVersion": sf.unity_version,
        "targetPlatform": int(sf.target_platform),
        "bigEndian": sf.header.endian == ">",
        "enableTypeTree": bool(sf._enable_type_tree),
        "externals": [
            {"path": e.path, "guid": hex_or_none(e.guid), "type": e.type} for e in sf.externals
        ],
        "types": [serialized_type(t) for t in sf.types],
        "refTypes": [serialized_type(t) for t in (sf.ref_types or [])],
        "typetrees": {},
    }
    if sf._enable_type_tree:
        for obj in sorted(sf.objects.values(), key=lambda o: str(o.path_id)):
            if obj.class_id in DUMPED_CLASSES:
                out["typetrees"][str(obj.path_id)] = dump_typetree(name, obj, sf)
    return out


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
    serialized = {}
    for name, entry in bundle.files.items():
        data = raw_bytes(name, entry)
        files[name] = {"sha256": sha256(data), "size": len(data)}
        table = object_table(entry)
        if table:
            objects[name] = table
        if hasattr(entry, "header") and hasattr(entry, "types"):
            serialized[name] = serialized_golden(f"{path.name}:{name}", entry)

    golden = {"signature": bundle.signature}
    # A WebFile has none of the bundle version fields - it carries its version
    # inside the signature ("UnityWebData1.0") and nothing else.
    if hasattr(bundle, "version"):
        golden["formatVersion"] = int(bundle.version)
        golden["unityVersion"] = bundle.version_player
        golden["unityRevision"] = bundle.version_engine
    golden["files"] = dict(sorted(files.items()))
    golden["objects"] = objects
    # Only real SerializedFiles get this - the M1 stand-ins hold opaque bytes.
    if serialized:
        golden["serialized"] = dict(sorted(serialized.items()))
    if note:
        golden["oracleNote"] = note
    return golden


def to_json(value, level: int = 0) -> str:
    """json.dumps(indent=2), except a list of scalars stays on one line.

    Type trees are hundreds of [level, type, name, byteSize, metaFlag] rows;
    one line per row keeps goldens.json readable and its diffs reviewable.
    """
    pad, end = "  " * (level + 1), "  " * level
    if isinstance(value, dict) and value:
        items = (f"{pad}{json.dumps(k)}: {to_json(v, level + 1)}" for k, v in value.items())
        return "{\n" + ",\n".join(items) + "\n" + end + "}"
    if isinstance(value, list) and any(isinstance(v, (dict, list)) for v in value):
        return "[\n" + ",\n".join(pad + to_json(v, level + 1) for v in value) + "\n" + end + "]"
    return json.dumps(value)


def main() -> None:
    if not FIXTURES.is_dir():
        raise SystemExit("no fixtures - run scripts/make-fixtures.py first")

    goldens = {
        "_oracle": f"UnityPy {UnityPy.__version__}",
        "_generator": "scripts/make-goldens.py",
        "fixtures": {},
    }
    paths = [p for p in FIXTURES.rglob("*") if p.is_file()]
    for path in sorted(paths, key=lambda p: p.relative_to(FIXTURES).as_posix()):
        key = path.relative_to(FIXTURES).as_posix()
        if any(part.startswith(".") for part in key.split("/")):
            continue
        goldens["fixtures"][key] = read_fixture(path)
        print(f"  {key:<48} {len(goldens['fixtures'][key]['files'])} files")

    GOLDENS.write_text(to_json(goldens) + "\n")
    print(f"\n{len(goldens['fixtures'])} goldens -> {GOLDENS.relative_to(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
