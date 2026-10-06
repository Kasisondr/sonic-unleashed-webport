#!/usr/bin/env python3
"""Export the stage background music from the disc into browser audio.

Extracts the stage's CRI CSB bank named by Stage.stg.xml, decodes its first
subsong with the pinned vgmstream build and verifies the decoded frame count and
rate against vgmstream's own report before writing dist/probe/game/audio.json.
"""
import argparse
import json
import re
import wave
from pathlib import Path

from prepare_menu import run
from prepare_stage import OUTPUT, ROOT, STAGE

AUDIT = ROOT / "build/input-audit.json"
INPUT = ROOT / "build/input"
TRACK = "bgm_stg_myk_act1"


def extract(iso_path, disc_file):
    import xxhash  # noqa: F401  (kept identical to the menu pipeline's dependency)
    audit = json.loads(AUDIT.read_text())
    entry = audit["files"][disc_file]
    target = INPUT / Path(disc_file).name
    target.parent.mkdir(parents=True, exist_ok=True)
    with Path(iso_path).open("rb") as stream:
        stream.seek(entry["offset"])
        data = stream.read(entry["size"])
    if len(data) != entry["size"]:
        raise ValueError(f"short read for {disc_file}")
    if target.exists() and target.read_bytes() != data:
        raise ValueError(f"refusing to replace changed input: {target}")
    target.write_bytes(data)
    return target


def build(iso, decoder, subsong=1):
    source = extract(iso, f"Sound/{TRACK}.csb")
    info = run([decoder, "-m", "-s", str(subsong), source])
    (ROOT / f"build/{TRACK}-audio-info.txt").write_text(info)
    samples = int(re.search(r"stream total samples: (\d+)", info).group(1))
    hz = int(re.search(r"sample rate: (\d+)", info).group(1))
    channels = int(re.search(r"channels: (\d+)", info).group(1))
    target = OUTPUT / f"{TRACK}.wav"
    run([decoder, "-i", "-s", str(subsong), "-o", target, source])
    with wave.open(str(target)) as handle:
        if handle.getnframes() != samples or handle.getframerate() != hz:
            raise ValueError(f"decoded audio mismatch: {handle.getnframes()} != {samples}")
        if handle.getnchannels() != channels:
            raise ValueError("decoded channel count mismatch")
    loop_start = re.search(r"loop start: (\d+)", info)
    loop_end = re.search(r"loop end: (\d+)", info)
    manifest = {"bgm": {"file": target.name, "name": TRACK, "sample_rate": hz, "samples": samples,
                        "channels": channels, "loop_start": int(loop_start.group(1)) if loop_start else None,
                        "loop_end": int(loop_end.group(1)) if loop_end else None,
                        "source": f"Sound/{TRACK}.csb", "subsong": subsong,
                        "stage": STAGE}}
    (OUTPUT / "audio.json").write_text(json.dumps(manifest, indent=1))
    print(f"Exported {TRACK}: {samples / hz:.1f}s {hz} Hz {channels}ch "
          f"({target.stat().st_size / 1e6:.1f} MB), loop {manifest['bgm']['loop_start']}..{manifest['bgm']['loop_end']}.")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    parser.add_argument("--decoder", type=Path, default=ROOT / "build/tools/vgmstream-build/cli/vgmstream-cli")
    parser.add_argument("--subsong", type=int, default=1)
    arguments = parser.parse_args()
    try:
        build(arguments.iso, arguments.decoder, arguments.subsong)
    except (ValueError, OSError, KeyError, IndexError, AttributeError) as error:
        raise SystemExit(f"stage audio export failed: {error}") from error
