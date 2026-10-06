#!/usr/bin/env python3
"""Index a local Xbox 360 disc and extract verified build inputs only.

The partition offsets and directory format follow upstream's
UnleashedRecomp/install/iso_file_system.cpp (originally Xenia).
Reads individual directory tables; never loads the whole ISO into RAM.
"""
import argparse
import hashlib
import json
import re
import struct
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
SECTOR = 2048
OFFSETS = (0, 0xFB20, 0x20600, 0x2080000, 0xFD90000)
MAGIC = b"MICROSOFT*XBOX*MEDIA"


def index_iso(path):
    size = path.stat().st_size
    if size == 0:
        raise ValueError("ISO is empty; wait for archive extraction to finish.")
    entries = {}
    with path.open("rb") as f:
        def read(offset, length):
            if offset < 0 or length < 0 or offset + length > size:
                raise ValueError("Disc entry extends beyond the ISO.")
            f.seek(offset)
            result = f.read(length)
            if len(result) != length:
                raise ValueError("ISO changed or was truncated while reading.")
            return result

        partitions = [offset for offset in OFFSETS
                      if offset + 32 * SECTOR + 28 <= size
                      and read(offset + 32 * SECTOR, len(MAGIC)) == MAGIC]
        if not partitions:
            raise ValueError("No supported Xbox disc filesystem descriptor found.")
        partition = partitions[-1]  # Same precedence as the upstream reader.
        root_sector, root_size = struct.unpack("<II", read(partition + 32 * SECTOR + 20, 8))
        pending = [(PurePosixPath(), root_sector, root_size)]
        visited_dirs = set()
        while pending:
            prefix, sector, length = pending.pop()
            if sector in visited_dirs:
                raise ValueError("Repeated or cyclic directory table.")
            visited_dirs.add(sector)
            if not 14 <= length <= 32 * 1024 * 1024:
                raise ValueError("Invalid directory table size.")
            table = read(partition + sector * SECTOR, length)
            nodes, visited_nodes = [0], set()
            while nodes:
                offset = nodes.pop()
                if offset in visited_nodes:
                    raise ValueError("Cyclic directory node.")
                visited_nodes.add(offset)
                if offset + 14 > length:
                    raise ValueError("Directory node is outside its table.")
                left, right, file_sector, file_size, attributes, name_len = struct.unpack_from("<HHIIBB", table, offset)
                if offset + 14 + name_len > length or name_len == 0:
                    raise ValueError("Invalid disc filename length.")
                name = table[offset + 14:offset + 14 + name_len].decode("ascii")
                if name in (".", "..") or any(c in name for c in "/\\\0"):
                    raise ValueError("Unsafe disc filename.")
                entry = (prefix / name).as_posix()
                if left:
                    nodes.append(left * 4)
                if right:
                    nodes.append(right * 4)
                if attributes & 0x10:
                    if file_size:
                        pending.append((prefix / name, file_sector, file_size))
                else:
                    absolute = partition + file_sector * SECTOR
                    if absolute + file_size > size:
                        raise ValueError("File data extends beyond the ISO.")
                    if entry in entries:
                        raise ValueError("Duplicate disc path.")
                    entries[entry] = {"offset": absolute, "size": file_size}
        if path.stat().st_size != size:
            raise ValueError("ISO extraction is still in progress; retry once complete.")
    return {"iso": str(path.resolve()), "size": size,
            "partition_offset": partition, "file_count": len(entries), "files": entries}


def known_hashes(source, array, files_array):
    text = source.read_text()
    hashes = [int(n) for n in re.findall(r"(\d+)ULL", text.split(f"{array}[] = {{", 1)[1].split("};", 1)[0])]
    files = re.findall(r'\{ "([^"]+)", (\d+) \}', text.split(f"{files_array}[] = {{", 1)[1].split("};", 1)[0])
    result, cursor = {}, 0
    for name, count in files:
        count = int(count)
        result[name] = hashes[cursor:cursor + count]
        cursor += count
    if cursor != len(hashes):
        raise ValueError("Upstream hash manifest is inconsistent.")
    return result


def store_verified(data, name, expected):
    import xxhash
    value = xxhash.xxh3_64_intdigest(data)
    if value not in expected:
        raise ValueError(f"{name} does not match a version supported by the pinned upstream.")
    destination = ROOT / "private" / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.read_bytes() != data:
        raise ValueError(f"Refusing to overwrite different input: {destination}")
    if not destination.exists():
        destination.write_bytes(data)
    return {"size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "xxh3_64": f"{value:016x}", "upstream_hash_match": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    parser.add_argument("--update", type=Path, help="Locally supplied default.xexp title-update patch")
    args = parser.parse_args()
    report = index_iso(args.iso)
    source = ROOT / "upstream/UnleashedRecomp/install/hashes"
    hashes = known_hashes(source / "game.cpp", "GameHashes", "GameFiles")
    required = ("default.xex", "shader.ar")
    missing = [name for name in required if name not in report["files"]]
    if missing:
        raise ValueError(f"Missing Unleashed build inputs: {missing}")
    report["verified_inputs"] = {}
    with args.iso.open("rb") as f:
        for name in required:
            entry = report["files"][name]
            f.seek(entry["offset"])
            data = f.read(entry["size"])
            if len(data) != entry["size"]:
                raise ValueError("Incomplete read; ISO may still be extracting.")
            report["verified_inputs"][name] = store_verified(data, name, hashes[name])
    if args.update:
        updates = known_hashes(source / "update.cpp", "UpdateHashes", "UpdateFiles")
        report["verified_inputs"]["default.xexp"] = store_verified(args.update.read_bytes(), "default.xexp", updates["default.xexp"])
    report["title_update_available"] = "default.xexp" in report["verified_inputs"]
    output = ROOT / "build/input-audit.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "files"}, indent=2))
    print(f"Full disc index: {output}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, UnicodeError) as error:
        raise SystemExit(str(error))
