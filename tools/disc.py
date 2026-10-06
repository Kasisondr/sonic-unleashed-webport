"""Locate and read files inside the disc's Hedgehog Engine archives.

The disc stores most content in split, LZX-compressed "Mirage" archives. Each
archive has a companion list file (".arl") naming every entry it holds, so a
file can be found by name without unpacking the disc. Every decompressed
archive is cached on disk because decompression dominates runtime.
"""
import json
import subprocess
import os
import struct
from pathlib import Path

import audit_input
from mirage import XCOMPRESS_MAGIC, FormatError, read_ar, read_packed_file, decompress

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "build/stage/cache"
ARL_CACHE = ROOT / "build/stage/arls"


def read_archive_list(data):
    """ARL2: split archive sizes, followed by byte-length-prefixed filenames."""
    if len(data) < 8 or data[:4] != b"ARL2":
        raise FormatError("unsupported archive list header")
    split_count = struct.unpack_from('<I', data, 4)[0]
    offset, names = 8 + split_count * 4, []
    if offset > len(data):
        raise FormatError('invalid archive-list split table')
    while offset < len(data):
        length = data[offset]
        if length == 0:
            break
        if offset + 1 + length > len(data):
            raise FormatError('truncated archive-list filename')
        name = data[offset + 1:offset + 1 + length]
        try:
            decoded = name.decode('utf-8')
        except UnicodeDecodeError:
            # Some disc animation filenames contain Shift-JIS fullwidth digits.
            # Rejecting these aborts the lookup of unrelated English materials.
            try:
                decoded = name.decode('shift_jis')
            except UnicodeDecodeError as error:
                raise FormatError('invalid archive-list filename encoding') from error
        if any(ord(char) < 32 for char in decoded):
            raise FormatError('invalid archive-list filename')
        names.append(decoded)
        offset += 1 + length
    return names


class Disc:
    """Read-only access to the local disc image and its archives."""

    def __init__(self, iso_path, index_path=None):
        self.iso_path = Path(iso_path)
        index_path = index_path or ROOT / "build/input-audit.json"
        cached = json.loads(Path(index_path).read_text())
        if cached.get("iso") != str(self.iso_path.resolve()) or cached.get("size") != self.iso_path.stat().st_size:
            cached = None
        if cached is None:
            cached = audit_input.index_iso(self.iso_path)
        self.files = cached["files"]
        self._stream = None
        self.list_names = {}

    def raw(self, name):
        entry = self.files.get(name)
        if entry is None:
            raise FormatError(f"no such disc file: {name}")
        if self._stream is None:
            self._stream = self.iso_path.open("rb")
        self._stream.seek(entry["offset"])
        data = self._stream.read(entry["size"])
        if len(data) != entry["size"]:
            raise FormatError(f"short read for {name}")
        return data

    def decompressed(self, name):
        """Return the LZX-decoded contents of a disc file, cached on disk."""
        target = CACHE / (name.replace("/", "_") + ".raw")
        if target.exists():
            return target.read_bytes()
        payload = self.raw(name)
        if payload[:4] != XCOMPRESS_MAGIC:
            return payload
        target.parent.mkdir(parents=True, exist_ok=True)
        source = target.with_suffix(".lzx")
        source.write_bytes(payload)
        result = subprocess.run([str(ROOT / "build/host/x_decompress/x_decompress"), str(source), str(target)],
                                capture_output=True, text=True)
        if result.returncode:
            raise FormatError(f"decompression failed for {name}: {result.stderr[-300:]}")
        return target.read_bytes()

    def archive_parts(self, base):
        """All split parts of a logical archive, in order."""
        parts = []
        for name in self.files:
            if name.startswith("#"):
                continue
            if name == base + ".ar" or (name.startswith(base + ".ar.") and name.rsplit(".", 1)[1].isdigit()):
                parts.append(name)
        return sorted(parts, key=lambda name: 0 if name.endswith(".ar") else int(name.rsplit(".", 1)[1]))

    def open_archive(self, base):
        """Read every entry of a logical archive, merged across its parts."""
        entries = {}
        for part in self.archive_parts(base):
            entries.update(read_ar(self.decompressed(part)))
        return entries

    def open_hashed_archive(self, base):
        """Read the "#"-prefixed companion archive that holds stage structure."""
        entries = {}
        for name in self.files:
            if name.startswith("#" + base) and not name.endswith(".arl"):
                entries.update(read_ar(self.decompressed(name)))
        return entries

    def open_packed_stage(self, stage):
        """Read a packed stage file: each entry holds one compressed archive.

        Returns (terrain groups, shared archives). The terrain groups keep the
        game's own streaming order so the browser can load them by distance.
        """
        data = self.raw(f"Packed/{stage}/Stage.pfd")
        groups, shared = {}, {}
        for entry in read_packed_file(data):
            payload = decompress(data[entry["offset"]:entry["offset"] + entry["size"]], CACHE / f"scratch-{os.getpid()}")
            inner = read_ar(payload)
            if entry["name"].startswith("tg-"):
                groups[entry["name"]] = inner
            else:
                shared[entry["name"]] = inner
        return groups, shared

    def archive_index(self):
        """Map every archive entry name to the archive that holds it."""
        index_path = ROOT / "build/stage/archive-index.json"
        if index_path.exists():
            cached = json.loads(index_path.read_text())
            if cached.get('version') == 3:
                return cached['entries']
        index = {}
        for name in sorted(self.files):
            if not name.endswith(".arl") or name.startswith("#"):
                continue
            base = name[:-4]
            try:
                data = self.decompressed(name)
            except FormatError:
                continue
            for entry in read_archive_list(data):
                index.setdefault(entry, base)
        index_path.write_text(json.dumps({'version': 3, 'entries': index}))
        return index

    def find(self, name, index=None):
        return (index or self.archive_index()).get(name)
