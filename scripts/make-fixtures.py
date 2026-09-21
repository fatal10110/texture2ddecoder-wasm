#!/usr/bin/env python3
"""Generate the M1 bundle fixtures.

We have no Unity Editor, so instead of building AssetBundles in one we write the
containers with UnityPy's own writer (``BundleFile.save``) and prove each one is
a real container by reading it back with UnityPy before it is committed.

This satisfies R11 (nothing third-party is committed - every byte here is
generated from the seeded payloads below) but it is a stand-in, not a
replacement: the payload inside each node is opaque bytes, not a SerializedFile,
so these fixtures only exercise layers 1-2 (unpack to ``env.files``). M2's
SerializedFile/TypeTree work needs bundles authored by a real Unity Editor.

Goldens are NOT produced here - see make-goldens.py (R12).

Usage:  .venv-oracle/bin/python scripts/make-fixtures.py
"""

from __future__ import annotations

import gzip
import hashlib
import pathlib
import sys

from UnityPy.enums.BundleFile import ArchiveFlags
from UnityPy.files.BundleFile import BundleFile
from UnityPy.files.WebFile import WebFile
from UnityPy.streams import EndianBinaryReader

import UnityPy

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "fixtures" / "bundles"

# Node flag bit 2 marks a SerializedFile; resource sidecars carry 0.
FLAG_SERIALIZED = 4
FLAG_RESOURCE = 0

# UnityPy's save_fs signature is (data_flag, block_info_flag). Despite the
# names, data_flag's low bits compress the *blocks-info* and block_info_flag
# compresses the *data blocks*. Verified by round-trip, not by the docstring,
# which has the tuple the other way round.
DIR_INFO = 0x40  # BlocksAndDirectoryInfoCombined - UnityPy always writes it
AT_END = 0x80  # BlocksInfoAtTheEnd
PADDING = 0x200  # 16-byte align before the data blocks (2019.4+)
NONE, LZMA, LZ4 = 0, 1, 2


def payload(seed: str, size: int) -> bytes:
    """Deterministic bytes for one node.

    Mixes incompressible digest runs with repeated literals and zero runs, so a
    block codec has to handle both long literals and back-references. Without
    the repetition LZ4 blocks come out as pure literal runs and the match path
    is never exercised by a fixture.
    """
    out = bytearray()
    h = hashlib.sha256(seed.encode()).digest()
    filler = (seed.encode() + b"/unity-asset-reader/") * 3
    while len(out) < size:
        out += h
        out += filler  # back-references, incl. matches longer than their offset
        out += b"\x00" * 48
        h = hashlib.sha256(h).digest()
    return bytes(out[:size])


def nodes(stem: str) -> dict[str, tuple[bytes, int]]:
    return {
        f"CAB-{stem}": (payload(f"{stem}:cab", 4096), FLAG_SERIALIZED),
        f"CAB-{stem}.resS": (payload(f"{stem}:resS", 1536), FLAG_RESOURCE),
    }


def build(
    stem: str,
    *,
    signature: str = "UnityFS",
    version: int = 6,
    packer,
    align: bool = False,
) -> bytes:
    bundle = BundleFile.__new__(BundleFile)
    bundle.signature = signature
    bundle.version = version
    bundle.version_player = "5.x.x"
    bundle.version_engine = "2022.3.0f1"
    bundle.dataflags = ArchiveFlags(0)
    bundle._uses_block_alignment = align
    bundle.is_changed = True
    bundle.files = {}
    for name, (data, flags) in nodes(stem).items():
        reader = EndianBinaryReader(data)
        reader.flags = flags
        bundle.files[name] = reader
    return bundle.save(packer=packer)


def build_webdata(stem: str) -> bytes:
    """A UnityWebData1.0 container - what a Unity WebGL build ships as .data.

    Not a bundle: a flat offset/length/path table followed by the file bytes,
    with no compression of its own. Written uncompressed; the gzip/brotli
    wrappers Unity can put around it are the caller's to remove (#15, #19).
    """
    web = WebFile.__new__(WebFile)
    web.packer = "none"
    web.files = {name: EndianBinaryReader(data) for name, (data, _) in nodes(stem).items()}
    return web.save()


def verify(name: str, raw: bytes, stem: str) -> None:
    """A fixture is only valid if the independent reader agrees it is one."""
    data = gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw
    env = UnityPy.load(data)
    inner = list(env.files.values())[0].files
    expected = {k: v[0] for k, v in nodes(stem).items()}
    if {k: bytes(v.bytes) for k, v in inner.items()} != expected:
        raise SystemExit(f"{name}: UnityPy read back different bytes than were written")


FIXTURES = [
    # name, kwargs for build()
    ("uncompressed", dict(packer=(DIR_INFO | NONE, NONE))),
    ("lz4", dict(packer=(DIR_INFO | LZ4, LZ4))),
    ("lzma", dict(packer=(DIR_INFO | LZMA, LZMA))),
    ("lz4-blocksinfo-at-end", dict(packer=(DIR_INFO | AT_END | LZ4, LZ4))),
    ("lz4-padding", dict(packer=(DIR_INFO | PADDING | LZ4, LZ4))),
    ("lz4-v7-align", dict(packer=(DIR_INFO | LZ4, LZ4), version=7, align=True)),
    ("unityweb-lzma", dict(packer="none", signature="UnityWeb", version=3)),
    ("unityraw", dict(packer="none", signature="UnityRaw", version=3)),
    # Format version 2 drops the fileInfoHeaderSize field version 3 added, so
    # the legacy header's version gates are exercised, not just one shape.
    ("unityraw-v2", dict(packer="none", signature="UnityRaw", version=2)),
]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    written = []

    for name, kwargs in FIXTURES:
        raw = build(name, **kwargs)
        verify(name, raw, name)
        (OUT / f"{name}.bundle").write_bytes(raw)
        written.append((f"{name}.bundle", len(raw)))

    # The one non-bundle container: same node payloads, different layout.
    web_stem = "webdata"
    web = build_webdata(web_stem)
    verify(f"{web_stem}.data", web, web_stem)
    (OUT / f"{web_stem}.data").write_bytes(web)
    written.append((f"{web_stem}.data", len(web)))

    # gzip-wrapped copy: same inner bundle, so it must unpack to the same files.
    gz_stem = "lz4"
    gz = gzip.compress(build(gz_stem, packer=(DIR_INFO | LZ4, LZ4)), mtime=0)
    verify("gzip", gz, gz_stem)
    (OUT / "gzip-lz4.bundle.gz").write_bytes(gz)
    written.append(("gzip-lz4.bundle.gz", len(gz)))

    for filename, size in written:
        print(f"  {filename:<32} {size:>7} B")
    print(f"\n{len(written)} fixtures -> {OUT.relative_to(ROOT)}")
    print("Now run: scripts/make-goldens.py")


if __name__ == "__main__":
    sys.exit(main())
