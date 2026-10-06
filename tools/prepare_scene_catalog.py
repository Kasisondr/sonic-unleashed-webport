#!/usr/bin/env python3
"""Export daytime acts and town environments with an incremental scene catalog.

These scenes use the browser controller, not the original Xbox game runtime.
Only fully exported scenes enter the catalog. Missing mechanics are recorded
rather than presenting an extracted environment as a complete game level.
"""
import argparse
import io
import json
import re
import wave
from pathlib import Path
from PIL import Image
from disc import Disc
from mirage import parse_model
from prepare_stage import ROOT, OUTPUT, Library, build, parse_stage_info, resolve_texture
from prepare_menu import run
from prepare_sky import sun_from_sky, write_dome

REGIONS = {
    'Mykonos': ('Windmill Isle', 'Apotos'), 'Africa': ('Savannah Citadel', 'Mazuri'),
    'EU': ('Rooftop Run', 'Spagonia'), 'China': ('Dragon Road', 'Chun-nan'),
    'Beach': ('Jungle Joyride', 'Adabat'), 'NY': ('Skyscraper Scamper', 'Empire City'),
    'Snow': ('Cool Edge', 'Holoska'), 'Petra': ('Arid Sands', 'Shamar'),
}
TOWN_REGIONS = {'EuropeanCity': 'EU', 'EULabo': 'EU', 'SouthEastAsia': 'Beach',
                'NYCity': 'NY', 'PetraCapital': 'Petra', 'PetraLabo': 'Petra'}
DECODER = ROOT / 'build/tools/vgmstream-build/cli/vgmstream-cli'


def region_for(stage):
    name = stage.removeprefix('ActD_').removeprefix('Town_').removeprefix('Sub')
    for prefix, region in TOWN_REGIONS.items():
        if name.startswith(prefix):
            return region
    return next((region for region in REGIONS if name.startswith(region)), None)


def title_for(stage, region):
    act_name, town_name = REGIONS[region]
    if stage.startswith('Town_'):
        suffix = ' — Entrance' if 'ETF' in stage else ' — Town'
        if 'Labo' in stage:
            suffix = ' — Laboratory'
        return town_name + suffix
    if stage.startswith('ActD_Sub'):
        return f'{act_name} — Extra {stage.rsplit("_", 1)[-1].lstrip("0")}'
    if region == 'Mykonos':
        return f'{act_name} Act {stage[-1]}'
    return act_name + ' Act 1'


def export_sky(disc, stage, info, output):
    archive = disc.open_archive(stage)
    library = Library(disc, {stage: archive})
    model = library.payload((info['sky'] or '') + '.model')
    names = []
    if model:
        for group in parse_model(model)['groups']:
            for mesh in group['meshes']:
                name, payload = resolve_texture(library, mesh['material'])
                if name and name not in names:
                    names.append(name)
    layers, first = {}, None
    for name in names:
        payload = library.payload(name + '.dds')
        if not payload:
            continue
        with Image.open(io.BytesIO(payload)) as image:
            image = image.convert('RGBA')
            image.save(output / 'textures' / f'{name}.png')
            layers[name] = {'file': f'{name}.png', 'overlay': image.getchannel('A').getextrema()[0] < 250}
            if first is None:
                first = image.copy()
    vertices, indices = write_dome(output / 'sky.bin', 500)
    sky = {'file': 'sky.bin', 'layers': layers, 'vertices': vertices, 'indices': indices,
           'source': {'archive': stage, 'model': info['sky']}}
    if first:
        sky['sun'] = {'direction': sun_from_sky(first)[0], 'from': 'sky texture'}
    return sky


def export_audio(disc, info):
    name = info['bgm']
    if not name or f'Sound/{name}.csb' not in disc.files:
        return None
    folder = OUTPUT / 'audio'
    folder.mkdir(exist_ok=True)
    target, meta_path = folder / f'{name}.wav', folder / f'{name}.json'
    if meta_path.exists() and target.exists():
        return json.loads(meta_path.read_text())
    source = ROOT / 'private/audio' / f'{name}.csb'
    source.parent.mkdir(parents=True, exist_ok=True)
    if not source.exists():
        source.write_bytes(disc.raw(f'Sound/{name}.csb'))
    info_text = run([DECODER, '-m', '-s', '1', source])
    run([DECODER, '-i', '-s', '1', '-o', target, source])
    with wave.open(str(target)) as handle:
        rate, samples, channels = handle.getframerate(), handle.getnframes(), handle.getnchannels()
    def value(label):
        match = re.search(label + r': (\d+)', info_text)
        return int(match[1]) if match else None
    if rate != value('sample rate') or samples != value('stream total samples'):
        raise ValueError(f'audio validation failed: {name}')
    track = {'name': name, 'url': target.relative_to(ROOT / 'dist/probe').as_posix(),
             'sample_rate': rate, 'samples': samples, 'channels': channels,
             'loop_start': value('loop start'), 'loop_end': value('loop end')}
    meta_path.write_text(json.dumps(track))
    return track


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('iso', type=Path)
    parser.add_argument('--stage', action='append')
    parser.add_argument('--texture-size', type=int, default=512)
    args = parser.parse_args()
    disc = Disc(args.iso)
    catalog_path = OUTPUT / 'catalog.json'
    catalog = json.loads(catalog_path.read_text()) if catalog_path.exists() else {'version': 1, 'runtime': 'browser-controller', 'scenes': [], 'failures': []}
    candidates = args.stage or [name.split('/')[1] for name in disc.files if name.startswith('Packed/')
                              and name.endswith('/Stage.pfd') and
                              (name.startswith('Packed/ActD_') or
                               (name.startswith('Packed/Town_') and '_Night' not in name))]
    # Keep the previously prepared stage available while new scenes are exported.
    initial = json.loads((OUTPUT / 'stage.json').read_text())
    catalog['scenes'] = [scene for scene in catalog['scenes'] if scene['id'] != initial['stage']]
    catalog['scenes'].insert(0, {'id': initial['stage'], 'title': 'Windmill Isle Act 1', 'region': 'Mykonos',
                              'kind': 'act', 'manifest': 'game/stage.json', 'mode': 'exploration'})
    catalog_path.write_text(json.dumps(catalog, indent=2))
    for stage in candidates:
        if stage == initial['stage']:
            continue
        region = region_for(stage)
        if not region:
            continue
        output = OUTPUT / 'maps' / stage
        path = output / 'stage.json'
        try:
            info = parse_stage_info(disc.open_hashed_archive(stage)['Stage.stg.xml'])
            if path.exists() and json.loads(path.read_text()).get("version") == 3:
                manifest = json.loads(path.read_text())
            else:
                print(f'Exporting {stage}…', flush=True)
                manifest = build(args.iso, args.texture_size, stage_id=stage, region=region, output=output)
            if not manifest['chunks']:
                raise ValueError('no terrain geometry')
            manifest['sky'] = export_sky(disc, stage, info, output)
            manifest['audio'] = export_audio(disc, info)
            manifest['title'] = title_for(stage, region)
            manifest['mode'] = 'exploration'
            path.write_text(json.dumps(manifest))
            catalog['scenes'] = [scene for scene in catalog['scenes'] if scene['id'] != stage]
            catalog['failures'] = [failure for failure in catalog['failures'] if failure['id'] != stage]
            catalog['scenes'].append({'id': stage, 'title': manifest['title'], 'region': region,
                                      'kind': 'town' if stage.startswith('Town_') else 'act',
                                      'mode': 'exploration', 'manifest': path.relative_to(ROOT / 'dist/probe').as_posix()})
            print(f'Ready: {manifest["title"]} ({len(manifest["chunks"])} chunks)', flush=True)
        except Exception as error:
            catalog['failures'] = [failure for failure in catalog['failures'] if failure['id'] != stage]
            catalog['failures'].append({'id': stage, 'error': str(error)[:240]})
            print(f'Unavailable {stage}: {error}', flush=True)
        catalog_path.write_text(json.dumps(catalog, indent=2))
    print(f'{len(catalog["scenes"])} environments exported; {len(catalog["failures"])} failed.', flush=True)


if __name__ == '__main__':
    main()
