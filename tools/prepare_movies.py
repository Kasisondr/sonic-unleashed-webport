#!/usr/bin/env python3
"""Convert the locally supplied disc's startup/attract/opening SFDs to MP4.

Source files remain private; derived H.264/AAC files stay in ignored dist/.
FFmpeg decodes the original MPEG-1 video and ADX audio, with no replacement art.
"""
import argparse
import json
import os
import subprocess
import struct
import wave
from pathlib import Path
from disc import Disc

ROOT = Path(__file__).resolve().parents[1]
MOVIES = {
    'sega': 'movie/sega_logo_us.sfd',
    'engine': 'movie/HedgehogEngine_logo.sfd',
    'attract': 'movie/evmo_title_loop.sfd',
    'opening': 'movie/evmo_m0_01_05_OPN_cs.sfd',
}


def build(iso, ffmpeg):
    disc = Disc(iso)
    output = ROOT / 'dist/probe/movies'
    output.mkdir(parents=True, exist_ok=True)
    manifest = {}
    decoder = ROOT / "build/tools/vgmstream-build/cli/vgmstream-cli"
    for role, source in MOVIES.items():
        target = output / f'{role}.mp4'
        if not target.exists():
            private = ROOT / 'private/movies' / Path(source).name
            private.parent.mkdir(parents=True, exist_ok=True)
            # Stream the disc file rather than allocating hundreds of MB.
            entry = disc.files[source]
            with disc.iso_path.open('rb') as src, private.open('wb') as dst:
                src.seek(entry['offset'])
                remaining = entry['size']
                while remaining:
                    data = src.read(min(4 * 1024 * 1024, remaining))
                    if not data:
                        raise ValueError(f'short read: {source}')
                    dst.write(data)
                    remaining -= len(data)
            # SFD audio may be an AIX container, which FFmpeg identifies as
            # plain ADX. Demux first; vgmstream understands the nested layers.
            demux = private.with_suffix('.audio')
            subprocess.run([str(ffmpeg), '-hide_banner', '-loglevel', 'quiet', '-y', '-i', str(private),
                            '-map', '0:a:0', '-c', 'copy', '-f', 'data', str(demux)], check=True)
            with demux.open('rb') as handle:
                header = handle.read(64)
            audio_source = private
            separate_audio = False
            if header.startswith(b'AIXF'):
                aix = demux.with_suffix('.aix')
                os.replace(demux, aix)
                expected = struct.unpack_from('>I', header, 32)[0] + struct.unpack_from('>I', header, 36)[0]
                if aix.stat().st_size != expected:
                    raise ValueError(f'truncated AIX stream: {source}')
                audio_source = private.with_suffix('.wav')
                subprocess.run([str(decoder), '-i', '-o', str(audio_source), str(aix)], check=True,
                               stdout=subprocess.DEVNULL)
                with wave.open(str(audio_source)) as handle:
                    if handle.getnframes() != struct.unpack_from('>I', header, 40)[0]:
                        raise ValueError(f'AIX sample count mismatch: {source}')
                separate_audio = True
            temporary = target.with_suffix('.tmp.mp4')
            subprocess.run([str(ffmpeg), '-hide_banner', '-loglevel', 'error', '-y', '-i', str(private),
                            *(['-i', str(audio_source)] if separate_audio else []),
                            '-map', '0:v:0', '-map', '1:a:0' if separate_audio else '0:a:0?', '-ac', '2', '-vf', 'setsar=1',
                            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
                            '-threads', '4', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
                            str(temporary)], check=True)
            os.replace(temporary, target)
        manifest[role] = {'file': f'movies/{target.name}', 'source': source, 'bytes': target.stat().st_size, 'audioValidated': True}
        (output / 'manifest.json').write_text(json.dumps(manifest, indent=2))
        print(f'{role}: {target.stat().st_size / 1e6:.1f} MB', flush=True)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('iso', type=Path)
    parser.add_argument('--ffmpeg', type=Path)
    args = parser.parse_args()
    if args.ffmpeg is None:
        import imageio_ffmpeg
        args.ffmpeg = Path(imageio_ffmpeg.get_ffmpeg_exe())
    build(args.iso, args.ffmpeg)
