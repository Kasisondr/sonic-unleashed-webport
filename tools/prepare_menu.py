#!/usr/bin/env python3
"""Build a local, original-assets menu preview from a verified disc ISO.

Extracted inputs, derived scenes and media remain ignored. This does not
execute guest game code or install the complete title update.
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import wave
from pathlib import Path

import xxhash
from PIL import Image
from audit_input import index_iso, known_hashes
from csd import parse_csd
from menu_archive import read_archive

ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / "private/menu"
OUTPUT = ROOT / "dist/probe/assets"


def run(args):
    result = subprocess.run([str(a) for a in args], capture_output=True, text=True)
    if result.returncode:
        raise ValueError(f"Tool failed: {args[0]}\n{result.stderr[-2500:]}")
    return result.stdout


def build(iso, decoder):
    index = index_iso(iso)
    hashes = known_hashes(ROOT / "upstream/UnleashedRecomp/install/hashes/game.cpp", "GameHashes", "GameFiles")
    INPUT.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    verified = {}
    archive_entries = {}
    source_names = {
        "Title.ar.00": "Title.ar.00", "MainMenu.ar.00": "MainMenu.ar.00",
        "Languages/English/Title.ar.00": "Title-English.ar.00",
        "Sound/bgm_sys_title.csb": "bgm_sys_title.csb", "Sound/bgm_sys_menu.csb": "bgm_sys_menu.csb",
    }
    with iso.open("rb") as stream:
        for name, local in source_names.items():
            entry = index["files"][name]
            stream.seek(entry["offset"])
            data = stream.read(entry["size"])
            if len(data) != entry["size"] or xxhash.xxh3_64_intdigest(data) not in hashes[name]:
                raise ValueError(f"Unsupported or corrupted game input: {name}")
            path = INPUT / local
            if path.exists() and path.read_bytes() != data:
                raise ValueError(f"Refusing to replace changed input: {path}")
            path.write_bytes(data)
            verified[name] = {"sha256": hashlib.sha256(data).hexdigest(), "upstream_hash_match": True, "bytes": len(data)}
            if name.endswith(".ar.00"):
                raw = path.with_suffix("")
                run([ROOT / "build/host/x_decompress/x_decompress", path, raw])
                # Validate declared output length before parsing derived entries.
                declared = int.from_bytes(data[24:32], "big") if data[:4] == b"\x0f\xf5\x12\xee" else len(data)
                if raw.stat().st_size != declared or declared > 64 * 1024 * 1024:
                    raise ValueError("Unexpected menu archive size")
                entries = read_archive(raw.read_bytes())
                archive_entries.update(entries)
                folder = INPUT / local.removesuffix(".ar.00")
                folder.mkdir(exist_ok=True)
                for filename, payload in entries.items():
                    (folder / filename).write_bytes(payload)
    textures = {}
    for key, filename in [("title", "ui_title.yncp"), ("mainmenu", "ui_mainmenu.yncp")]:
        parsed = parse_csd(archive_entries[filename])
        parsed["source"] = filename
        for name in parsed["textures"]:
            path = OUTPUT / (name.removesuffix(".dds") + ".png")
            payload = archive_entries[name]
            import io
            with Image.open(io.BytesIO(payload)) as image:
                image.convert("RGBA").save(path)
                textures[name] = {"file": path.name, "width": image.width, "height": image.height}
        (OUTPUT / f"{key}.json").write_text(json.dumps(parsed, separators=(",", ":"), allow_nan=False))
    audio = {}
    requests = [
        ("title", INPUT / "bgm_sys_title.csb", 1),
        ("menu", INPUT / "bgm_sys_menu.csb", 1),
        ("start", INPUT / "MainMenu/system.csb", 1),
        ("cursor", INPUT / "MainMenu/system.csb", 4),
        ("decide", INPUT / "MainMenu/system.csb", 12),
        ("back", INPUT / "Title/se_system_worldmap.csb", 5),
        ("unavailable", INPUT / "MainMenu/system.csb", 14),
    ]
    for name, path, subsong in requests:
        info = run([decoder, "-m", "-s", subsong, path])
        (ROOT / f"build/{name}-audio-info.txt").write_text(info)
        samples = int(re.search(r"stream total samples: (\d+)", info).group(1))
        hz = int(re.search(r"sample rate: (\d+)", info).group(1))
        target = OUTPUT / f"{name}.wav"
        run([decoder, "-i", "-s", subsong, "-o", target, path])
        with wave.open(str(target)) as w:
            if w.getnframes() != samples or w.getframerate() != hz:
                raise ValueError(f"Decoded audio count/rate mismatch: {name}")
        loop_start = re.search(r"loop start: (\d+)", info)
        loop_end = re.search(r"loop end: (\d+)", info)
        audio[name] = {"file": target.name, "sample_rate": hz, "samples": samples,
                       "loop_start": int(loop_start.group(1)) if loop_start else None,
                       "loop_end": int(loop_end.group(1)) if loop_end else None,
                       "source": path.name, "subsong": subsong}
    manifest = {"version": 1, "textures": textures, "audio": audio,
                "game_booted": False, "scene_renderer": "Original Ninja CSD assets with browser menu control"}
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    for source in (ROOT / "web").iterdir():
        if source.is_file():
            shutil.copy2(source, ROOT / "dist/probe" / source.name)
    report = {"verified_sources": verified, "texture_count": len(textures),
              "audio_tracks": len(audio), "game_booted": False,
              "original_menu_logic_executed": False,
              "decoder_commit": run(["git", "-C", ROOT / "build/tools/vgmstream-src", "rev-parse", "HEAD"]).strip()}
    (ROOT / "build/menu-assets-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Prepared {len(textures)} original textures and {len(audio)} audio tracks. Game is not booted.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    parser.add_argument("--decoder", type=Path, default=ROOT / "build/tools/vgmstream-build/cli/vgmstream-cli")
    args = parser.parse_args()
    try:
        build(args.iso, args.decoder)
    except (ValueError, OSError, KeyError, IndexError, UnicodeError) as error:
        raise SystemExit(str(error))
