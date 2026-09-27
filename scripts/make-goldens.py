#!/usr/bin/env python3
"""Generate the committed goldens from the UnityPy oracle (R12).

Goldens must never come from this library's own output, so everything written
here is read back out of UnityPy. Run it once after adding or regenerating a
fixture; the oracle is not a dependency of the package or of CI.

Per fixture (keyed by its path under fixtures/bundles/):
  files       - node path -> sha256 of the unpacked bytes  (what M1's env.files must match)
  objects     - per unpacked SerializedFile, the object table
  serialized  - per unpacked SerializedFile: header, externals, type trees, and
                read_typetree() dumps of the DUMPED_CLASSES objects  (M2);
                plus, for a file holding a Texture2D, `textures`: the sha256 of
                its image data and of UnityPy's RGBA decode, rows as stored  (#31)
Plus `synthetic`: UnityPy's RGBA for generated block data in the formats no
editor on hand writes (ATC, signed EAC - #32); `platform`: the same for the
console layouts no editor on hand builds (Switch swizzle, Xbox 360 byte swap),
in both row orders; and `deswizzle`: UnityPy's Switch deswizzle alone (#33).

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
import warnings

import UnityPy
from UnityPy import config
from UnityPy.exceptions import UnityVersionFallbackWarning
from UnityPy.enums import BuildTarget, TextureFormat
from UnityPy.export.Texture2DConverter import get_image_from_texture2d, parse_image_data
from UnityPy.helpers import TextureSwizzler
from UnityPy.helpers.TypeTreeHelper import (
    TypeTreeConfig,
    get_ref_type_node,
    metaflag_is_aligned,
    read_value,
)
from UnityPy.streams import EndianBinaryReader

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures" / "bundles"
GOLDENS = ROOT / "fixtures" / "goldens.json"

INT64_TYPES = {"SInt64", "UInt64", "long long", "unsigned long long", "FileSize"}
BYTE_TYPES = {"UInt8", "SInt8", "char"}
# Classes whose read_typetree() output is part of the goldens (#25). AssetBundle
# and AssetBundleManifest are the only map / pair / set in the fixtures (#84);
# Mesh and Texture2D the only TypelessData, non-empty and empty (#86).
DUMPED_CLASSES = {
    28: "Texture2D",
    43: "Mesh",
    49: "TextAsset",
    114: "MonoBehaviour",
    142: "AssetBundle",
    290: "AssetBundleManifest",
}
# Sentinel entry that ends a ManagedReferencesRegistry version 1 list (#25).
REGISTRY_V1_TERMINUS = (
    b"\x08\x00\x00\x00Terminus" b"\x10\x00\x00\x00UnityEngine.DMAT" b"\x08\x00\x00\x00FAKE_ASM"
)
REGISTRY_V1_TERMINUS_TYPE = ("Terminus", "UnityEngine.DMAT", "FAKE_ASM")
TEXTURE2D = 28
# TextureFormat -> where UnityPy's RGBA knowingly differs from AssetStudio's
# converter, the behavior source of truth (plan section 6: the verdict is
# recorded next to the golden). Established on the #31 fixture.
ORACLE_DISAGREES = {
    1: (
        "Alpha8: UnityPy leaves R G B at 0, AssetStudio sets them to 255; alpha agrees. "
        "Verdict: AssetStudio (255) - see #31"
    ),
    7: (
        "RGB565: UnityPy widens each channel as floor(x * 255 / max), AssetStudio by "
        "repeating its top bits ((x << 3) | (x >> 2)), which is up to 1 higher. "
        "Verdict: AssetStudio - see #31"
    ),
    # Block formats UnityPy decodes with Pillow or astc-encoder rather than with
    # texture2ddecoder, the codec AssetStudio (and this library) uses. Established
    # on the #32 fixtures.
    24: (
        "BC6H: UnityPy decodes with Pillow, AssetStudio with its Texture2DDecoder; they "
        "turn the half floats into 8 bits differently, channels differ by at most 1. "
        "Verdict: AssetStudio - see #32"
    ),
    26: (
        "BC4: UnityPy decodes with Pillow into grayscale (R = G = B), AssetStudio's "
        "Texture2DDecoder writes the value to R only (G = B = 0). "
        "Verdict: AssetStudio - see #32"
    ),
    **{
        f: (
            "ASTC: UnityPy decodes with astc-encoder (unorm8), AssetStudio with its "
            "Texture2DDecoder; channels differ by at most 1. Verdict: AssetStudio - see #32"
        )
        for f in range(48, 60)  # ASTC_RGB_4x4 .. ASTC_RGBA_12x12
    },
    **{
        f: (
            "ASTC HDR: UnityPy decodes with astc-encoder's LDR profile, which returns its "
            "magenta error colour for every HDR block; AssetStudio's Texture2DDecoder "
            "decodes them. Verdict: AssetStudio - see #32"
        )
        for f in range(66, 72)  # ASTC_HDR_4x4 .. ASTC_HDR_12x12
    },
}
# Formats none of the fixture editors (2019.4, 2020.3, 6000.3) compresses (#32):
# ATC, which their TextureFormat no longer has, and signed EAC, which the editor
# refuses. UnityPy decodes synthetic_bytes(name) of each instead; see
# synthetic_goldens().
SYNTHETIC = [
    # name, TextureFormat, width, height, bytes per 4x4 block
    ("ATC_RGB4", 35, 16, 8, 8),
    ("ATC_RGBA8", 36, 16, 8, 16),
    ("EAC_R_SIGNED", 42, 16, 8, 8),
    ("EAC_RG_SIGNED", 44, 16, 8, 16),
]
# Console layouts no fixture editor can build (#33): none has the Switch or
# Xbox 360 module. UnityPy decodes synthetic_bytes(name) of each as that
# platform's texture instead; see platform_goldens(). The sizes are not
# multiples of the Switch padding, so the crop back to the texture's size runs.
#
# BC1 colour blocks (DXT1, and the colour half of DXT5) whose c0 <= c1 are where
# UnityPy's Pillow parts ways with Texture2DDecoder (this library's, and
# AssetStudio's and K0lb3's, which agree with it). Verdicts (#131):
#   DXT1 index 3: AssetStudio, opaque black. Pillow gives transparent black,
#     but Unity's DXT1 has no alpha.
#   DXT5 colour: Pillow is right. The spec decodes it as though c0 > c1
#     always, and Texture2DDecoder's 3-colour mode is a known defect, to be
#     fixed in texture2ddecoder-wasm (#137), not pinned here.
# The fixtures' DXT data has no such block (#32), random bytes do. So the DXT
# inputs get every colour block's c0 > c1, by setting the top bit of c0's high
# byte and clearing c1's (`four_color`, mirrored by `fourColor` in the texture
# tests): each entry is (block stride, index of c0's high byte, index of c1's),
# as stored, so swapped for Xbox 360. With that, every decoder agrees on every
# pixel.
PLATFORM = [
    # name, BuildTarget, TextureFormat, width, height, log2 of Switch GOBs per block, four_color
    ("Switch RGBA32", BuildTarget.Switch, 4, 20, 10, 1, None),
    ("Switch RGB24", BuildTarget.Switch, 3, 12, 6, 2, None),
    ("Switch ARGB4444", BuildTarget.Switch, 2, 24, 8, 1, None),
    ("Switch DXT1", BuildTarget.Switch, 10, 36, 20, 3, (8, 1, 3)),
    ("Switch DXT5", BuildTarget.Switch, 12, 16, 16, 4, (16, 9, 11)),
    ("Switch BC5", BuildTarget.Switch, 27, 8, 40, 2, None),
    ("XBOX360 DXT1", BuildTarget.XBOX360, 10, 16, 8, None, (8, 0, 2)),
    ("XBOX360 DXT5", BuildTarget.XBOX360, 12, 16, 8, None, (16, 8, 10)),
]
# UnityPy's Switch deswizzle on its own, one case per texel shape of its
# TEXTURE_FORMAT_BLOCK_SIZE_MAP (#33); see deswizzle_goldens().
DESWIZZLE = [
    # name, texel width, texel height (pixels per 16 bytes), width, height, GOBs per block
    ("16x1", 16, 1, 40, 9, 2),
    ("8x1", 8, 1, 24, 8, 4),
    ("4x1", 4, 1, 20, 10, 2),
    ("1x1", 1, 1, 5, 3, 2),
    ("8x4", 8, 4, 36, 20, 8),
    ("4x4", 4, 4, 16, 16, 16),
    ("5x5", 5, 5, 30, 12, 2),
    ("6x6", 6, 6, 30, 30, 4),
    ("8x8", 8, 8, 40, 72, 2),
    ("10x10", 10, 10, 50, 20, 2),
    ("12x12", 12, 12, 60, 36, 32),
]


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


def count_v1_entries(raw: bytes, unread: int, node, obj, sf) -> int | None:
    """Entries in the last `unread` bytes of `raw`, read with UnityPy's own read_value.

    Returns how many v1 registry entries come before the Terminus sentinel,
    or None unless those bytes are exactly the entries plus the sentinel.
    """
    registries = [c for c in node.m_Children if c.m_Type == "ManagedReferencesRegistry"]
    entries = [c for r in registries for c in r.m_Children if c.m_Type == "ReferencedObject"]
    entry = entries[0] if len(entries) == 1 else None
    if entry is None:
        return None
    # Over the whole object, so alignment is relative to the object as in UnityPy.
    reader = EndianBinaryReader(raw, endian=obj.reader.endian)
    reader.Position = len(raw) - unread
    # Inside the host's registry, as UnityPy is when it reads the first entry.
    config = TypeTreeConfig(True, sf, True)
    count = 0
    while True:
        item = {}
        for child in entry.m_Children:
            if child.m_Type != "ReferencedObjectData":
                item[child.m_Name] = read_value(child, reader, config)
                continue
            typ = item.get("type", {})
            if (typ.get("class"), typ.get("ns"), typ.get("asm")) == REGISTRY_V1_TERMINUS_TYPE:
                return count if reader.Position == len(raw) else None
            ref_node = get_ref_type_node(item, sf)
            if ref_node is not None:
                read_value(ref_node, reader, config)
        if metaflag_is_aligned(entry.m_MetaFlag):
            reader.align_stream()
        count += 1


def dump_typetree(name: str, obj, sf) -> dict:
    """read_typetree() of one object, normalized, plus a note if UnityPy needed help."""
    node = obj._get_typetree_node()
    try:
        return {"value": normalize(node, obj.read_typetree(), sf)}
    except ValueError as error:
        # UnityPy walks a ManagedReferencesRegistry version 1 (Unity <= 2020) as
        # if it held one entry and stops before the Terminus sentinel that ends
        # the list, then fails its own read-length check (#25). Accept that one
        # case - and only when the unread tail is exactly the sentinel, or the
        # entries after the first and then the sentinel - and record it;
        # anything else is a real oracle failure.
        # Every v1 registry ends with the sentinel, so that alone proves nothing:
        # a tail longer than the sentinel must read, with UnityPy's own
        # read_value, as whole entries ending exactly at the sentinel (#96).
        short = re.search(r"Expected to read (\d+) bytes, but only read (\d+)", str(error))
        unread = int(short[1]) - int(short[2]) if short else 0
        raw = obj.get_raw_data()
        more = None
        if unread >= len(REGISTRY_V1_TERMINUS) and raw.endswith(REGISTRY_V1_TERMINUS):
            more = count_v1_entries(bytes(raw), unread, node, obj, sf)
        if more is None:
            raise SystemExit(f"{name} pathId {obj.path_id}: read_typetree failed: {error}")
        value = obj.read_typetree(check_read=False)
        if value.get("references", {}).get("version") != 1:
            raise SystemExit(f"{name} pathId {obj.path_id}: unexpected read failure: {error}")
        if more == 0:
            note = (
                "UnityPy stops before the ManagedReferencesRegistry v1 Terminus sentinel "
                f"({len(REGISTRY_V1_TERMINUS)} bytes, verified present); dump read with "
                "check_read=False - see #25"
            )
        else:
            note = (
                "UnityPy reads only the first ManagedReferencesRegistry v1 entry and stops "
                f"before the other {more} and the Terminus sentinel ({unread} bytes, read back "
                "as entries with UnityPy's read_value up to the sentinel); dump read with "
                "check_read=False - see #25, #96"
            )
        return {"value": normalize(node, value, sf), "oracleNote": note}


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
        textures = {
            str(obj.path_id): texture_golden(obj)
            for obj in sorted(sf.objects.values(), key=lambda o: str(o.path_id))
            if obj.class_id == TEXTURE2D
        }
        # Only files holding a Texture2D get the key, so every other golden
        # stays byte-identical to what it was before #31.
        if textures:
            out["textures"] = textures
    return out


def texture_golden(obj) -> dict:
    """Image data and decoded RGBA of one Texture2D, as UnityPy sees them (#31).

    `rgbaSha256` is the RGBA8 image with its rows in the order Unity stores
    them, bottom row first (`flip=False`); turning it top-down is #33. Where
    UnityPy cannot decode the format, `oracleError` says why instead.
    """
    tex = obj.read()
    data = bytes(tex.get_image_data())
    out = {
        "name": tex.m_Name,
        "format": int(tex.m_TextureFormat),
        "width": int(tex.m_Width),
        "height": int(tex.m_Height),
        "imageSize": len(data),
        "imageSha256": sha256(data),
    }
    try:
        image = get_image_from_texture2d(tex, flip=False)
    except Exception as error:  # noqa: BLE001 - any failure is recorded, never guessed around
        out["oracleError"] = f"{type(error).__name__}: {error}"
        return out
    out["rgbaSha256"] = sha256(image.convert("RGBA").tobytes())
    if out["format"] in ORACLE_DISAGREES:
        out["oracleNote"] = ORACLE_DISAGREES[out["format"]]
    return out


def synthetic_bytes(name: str, size: int) -> bytes:
    """sha256(f"{name}/0") + sha256(f"{name}/1") + ..., cut to `size` bytes.

    Every byte string is valid ATC or EAC block data, so no editor is needed;
    `syntheticBytes` in fixtures/helpers.ts makes the same bytes.
    """
    out = b""
    while len(out) < size:
        out += hashlib.sha256(f"{name}/{len(out) // 32}".encode()).digest()
    return out[:size]


def synthetic_goldens() -> dict:
    """UnityPy's RGBA for block formats no editor on hand writes (#32).

    `parse_image_data` is what `get_image_from_texture2d` calls with a
    texture's fields; here it gets `synthetic_bytes(name)` instead. The Unity
    version and platform only matter for Crunch and console swizzling, so
    UnityPy's own defaults are passed.
    """
    out = {}
    for name, fmt, width, height, block in SYNTHETIC:
        data = synthetic_bytes(name, (width // 4) * (height // 4) * block)
        image = parse_image_data(
            data, width, height, fmt, (0, 0, 0, 0), BuildTarget.UnknownPlatform, None, flip=False
        )
        out[name] = {
            "format": fmt,
            "width": width,
            "height": height,
            "inputSize": len(data),
            "inputSha256": sha256(data),
            "rgbaSha256": sha256(image.convert("RGBA").tobytes()),
        }
    return out


def four_color(data: bytes, stride: int, c0_high: int, c1_high: int) -> bytes:
    """`data` with c0 > c1 in every BC1 colour block; see PLATFORM."""
    out = bytearray(data)
    for block in range(0, len(out), stride):
        out[block + c0_high] |= 0x80
        out[block + c1_high] &= 0x7F
    return bytes(out)


def platform_goldens() -> dict:
    """UnityPy's RGBA for console texture layouts no editor on hand builds (#33).

    `parse_image_data` with the platform, and for Switch a 12-byte
    `m_PlatformBlob` whose bytes 8-11 hold log2 of the GOBs per block (the
    only bytes UnityPy reads), over `synthetic_bytes(name)`: the whole padded
    first level for Switch, the first level for Xbox 360, in 4-colour BC1
    blocks for DXT (`four_color`, see PLATFORM). Both row orders are
    recorded: `rgbaSha256` as stored (`flip=False`, like every other texture
    golden) and `rgbaTopDownSha256` (`flip=True`).
    """
    out = {}
    for name, platform, fmt, width, height, gobs_log2, four in PLATFORM:
        blob = None
        size = (width // 4) * (height // 4) * (8 if fmt == 10 else 16)
        if gobs_log2 is not None:
            blob = [0] * 8 + list(struct.pack("<I", gobs_log2))
            gobs = TextureSwizzler.get_switch_gobs_per_block(blob)
            # Switch stores RGB24 as RGBA32, which is what UnityPy decodes it as.
            unpacked = TextureFormat.RGBA32 if fmt == TextureFormat.RGB24 else TextureFormat(fmt)
            texel = TextureSwizzler.TEXTURE_FORMAT_BLOCK_SIZE_MAP[unpacked]
            padded = TextureSwizzler.get_padded_texture_size(width, height, *texel, gobs)
            size = (padded[0] // texel[0]) * (padded[1] // texel[1]) * 16
        data = synthetic_bytes(name, size)
        if four is not None:
            data = four_color(data, *four)
        args = (data, width, height, fmt, (0, 0, 0, 0), platform, blob)
        out[name] = {
            "platform": int(platform),
            "format": fmt,
            "width": width,
            "height": height,
            "platformBlob": None if blob is None else bytes(blob).hex(),
            "fourColor": None if four is None else list(four),
            "inputSize": len(data),
            "inputSha256": sha256(data),
            "rgbaSha256": sha256(parse_image_data(*args, flip=False).convert("RGBA").tobytes()),
            "rgbaTopDownSha256": sha256(
                parse_image_data(*args, flip=True).convert("RGBA").tobytes()
            ),
        }
    return out


def deswizzle_goldens() -> dict:
    """UnityPy's Switch deswizzle of `synthetic_bytes(name)`, for each texel shape (#33).

    The texture's size is padded as UnityPy pads it, and the input is exactly
    the padded level, so the output is every byte moved and none added.
    """
    out = {}
    for name, texel_width, texel_height, width, height, gobs in DESWIZZLE:
        padded = TextureSwizzler.get_padded_texture_size(
            width, height, texel_width, texel_height, gobs
        )
        size = (padded[0] // texel_width) * (padded[1] // texel_height) * 16
        data = synthetic_bytes(f"deswizzle {name}", size)
        moved = TextureSwizzler.deswizzle(data, *padded, texel_width, texel_height, gobs)
        out[name] = {
            "texelWidth": texel_width,
            "texelHeight": texel_height,
            "width": width,
            "height": height,
            "gobsPerBlock": gobs,
            "paddedWidth": padded[0],
            "paddedHeight": padded[1],
            "inputSize": len(data),
            "inputSha256": sha256(data),
            "outputSha256": sha256(bytes(moved)),
        }
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


def editor_of(path: pathlib.Path) -> str | None:
    """The editor that built an editor fixture, from its folder (editor/<version>/...)."""
    parts = path.relative_to(FIXTURES).parts
    return parts[1] if len(parts) > 2 and parts[0] == "editor" else None


def read_with_fallback(path: pathlib.Path) -> dict:
    """read_fixture(), telling UnityPy which editor built a version-stripped fixture (#104).

    A bundle built with AssetBundleStripUnityVersion records "0.0.0" as its
    revision, and UnityPy refuses that unless config.FALLBACK_UNITY_VERSION is
    set. For an editor fixture the editor is known from its folder, so the
    oracle is given that. UnityPy only consults the fallback when a version is
    missing, and warns when it does; the fixtures that needed it get a note.
    """
    editor = editor_of(path)
    config.FALLBACK_UNITY_VERSION = editor
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always", UnityVersionFallbackWarning)
            golden = read_fixture(path)
    finally:
        config.FALLBACK_UNITY_VERSION = None
    # Recording swallows every warning; only the fallback ones are handled here,
    # so pass the rest on, as they would have been without the recording.
    for w in caught:
        if not issubclass(w.category, UnityVersionFallbackWarning):
            warnings.showwarning(w.message, w.category, w.filename, w.lineno)
    if any(issubclass(w.category, UnityVersionFallbackWarning) for w in caught):
        note = (
            f'version-stripped ("0.0.0"): UnityPy refuses it without a fallback, so it was '
            f'read with config.FALLBACK_UNITY_VERSION = "{editor}", the editor that built it '
            "- see #104"
        )
        golden["oracleNote"] = f"{golden['oracleNote']}; {note}" if "oracleNote" in golden else note
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
        goldens["fixtures"][key] = read_with_fallback(path)
        print(f"  {key:<48} {len(goldens['fixtures'][key]['files'])} files")
    goldens["synthetic"] = synthetic_goldens()
    goldens["platform"] = platform_goldens()
    goldens["deswizzle"] = deswizzle_goldens()

    GOLDENS.write_text(to_json(goldens) + "\n")
    print(f"\n{len(goldens['fixtures'])} goldens -> {GOLDENS.relative_to(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
