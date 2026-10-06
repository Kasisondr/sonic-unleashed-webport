#!/usr/bin/env python3
"""Export original material, lighting and effect parameters into existing scenes.

This updates manifests and textures without repacking geometry. Raw light-field
trees are retained so the browser can sample the original spatial probes.
Terrain light-map atlas mapping and original compiled shaders remain separate
runtime work; recording the source settings does not implement those effects.
"""
import argparse
import json
import math
from pathlib import Path
from xml.etree import ElementTree

from disc import Disc
from mirage import (FormatError, Reader, parse_light, parse_light_field, parse_material,
                    parse_texset, parse_texture, read_string_list, sample_chunk_version)
from prepare_stage import ROOT, OUTPUT, Library, convert_texture, material_properties
from prepare_scene_catalog import region_for


def scalar(value):
    value = (value or '').strip()
    if value.lower() in ('true', 'false'):
        return value.lower() == 'true'
    try:
        return float(value.removesuffix('f'))
    except ValueError:
        return value


def effect_parameters(data):
    root = ElementTree.fromstring(data)
    return {section.tag: {category.tag: {node.tag: scalar(node.text) for node in category.findall('Param/*')}
                          for category in section.findall('Category/*')}
            for section in root}


def vector(parameters, prefix, components='xyz'):
    values = [parameters.get(prefix + '.' + axis) for axis in components]
    return values if all(value is not None for value in values) else None


def parse_gi_groups(data):
    """Record source GI instance/group metadata, without claiming mapped UVs."""
    version, origin = sample_chunk_version(data)
    reader = Reader(data, origin)
    names = read_string_list(reader, origin)
    group_count = reader.u32(origin + 12)
    table = reader.ptr(origin + 16)
    groups = []
    for index in range(group_count):
        at = reader.ptr(table + index * 4)
        count, indices = reader.u32(at + 4), reader.ptr(at + 8)
        bounds = reader.ptr(at + 12)
        groups.append({'quality': reader.u32(at),
                       'instances': [reader.u32(indices + i * 4) for i in range(count)],
                       'bounds': [reader.f32(bounds + i * 4) for i in range(4)],
                       'memorySize': reader.u32(at + 16)})
    return {'version': version, 'instances': names, 'groups': groups,
            'rendered': False, 'reason': 'Terrain GI atlas and UV1 mapping are not linked to this renderer.'}


def stage_graphics(stage, archive, structure, output):
    parameters = effect_parameters(structure['SceneEffect.prm.xml']) if 'SceneEffect.prm.xml' in structure else {}
    stage_root = ElementTree.fromstring(structure['Stage.stg.xml'])
    main = stage_root.findtext('Light/DataName')
    names = [main] if main else []
    if 'light-list.light-list' in structure:
        data = structure['light-list.light-list']
        _, origin = sample_chunk_version(data)
        names.extend(read_string_list(Reader(data, origin), origin))
    else:
        names.extend(name.removesuffix('.light') for name in structure if name.endswith('.light'))
    lights, missing = [], []
    for name in dict.fromkeys(names):
        payload = structure.get(name + '.light', archive.get(name + '.light'))
        if payload:
            lights.append(dict(parse_light(payload), name=name))
        else:
            missing.append(name)
    result = {'version': 1, 'source': {'structure': '#' + stage, 'parameters': 'SceneEffect.prm.xml'},
              'lights': lights, 'effectParameters': parameters, 'missingLights': missing}
    fog = parameters.get('LightScattering', {})
    common, values = fog.get('Common', {}), fog.get('Fog', {})
    if fog:
        result['fog'] = {'color': vector(common, 'ms_Color'), 'mode': common.get('Mode'),
                         'near': values.get('ms_FarNearScale.y'), 'far': values.get('ms_FarNearScale.x'),
                         'density': values.get('ms_ConstG_FogDensity.w'),
                         'scatteringScale': common.get('ms_FarNearScale.z')}
    gi = parameters.get('GI', {}).get('LightField', {})
    if gi:
        result['ambient'] = {'up': vector(gi, 'ms_DefaultLightFieldColorUp'),
                             'down': vector(gi, 'ms_DefaultLightFieldColorDown'),
                             'offsetUp': vector(gi, 'ms_LightFieldOffsetColorUp'),
                             'offsetDown': vector(gi, 'ms_LightFieldOffsetColorDown'),
                             'ignoreData': gi.get('ms_IgnoreLightFieldData', False),
                             'luminanceScale': gi.get('ms_DefaultLightFieldLuminanceScalingRate'),
                             'saturationScale': gi.get('ms_DefaultLightFieldSaturationScalingRate')}
    if 'light-field.lft' in archive:
        payload = archive['light-field.lft']
        result['lightField'] = dict(parse_light_field(payload), file='light-field.lft', bytes=len(payload))
        (output / 'light-field.lft').write_bytes(payload)
    if 'gi-texture.gi-texture-group-info' in structure:
        result['terrainGI'] = parse_gi_groups(structure['gi-texture.gi-texture-group-info'])
    return result


def enrich_materials(manifest, library, output, texture_size=0):
    failures, cache = [], {}
    output.joinpath('textures').mkdir(exist_ok=True)
    for record in manifest['materials']:
        name = record['name']
        try:
            payload = library.payload(name + '.material')
            if payload is None:
                raise FormatError('material resource missing')
            parsed = parse_material(payload)
            record.update(material_properties(parsed))
            # Some unused material vec4 components carry non-finite float
            # representations. JSON NaN is accepted by Python but crashes the
            # browser's JSON parser. Preserve their locations as unknown data.
            nonfinite = []
            def safe(value, location=''):
                if isinstance(value, float) and not math.isfinite(value):
                    nonfinite.append(location)
                    return None
                if isinstance(value, list):
                    return [safe(item, f'{location}[{index}]') for index, item in enumerate(value)]
                if isinstance(value, dict):
                    return {key: safe(item, f'{location}.{key}') for key, item in value.items()}
                return value
            record.update(safe(record))
            if nonfinite:
                record['uninterpretedComponents'] = nonfinite
            texset = library.payload((parsed['texset'] or '') + '.texset')
            channels = {}
            if texset:
                for entry in parse_texset(texset)['textures']:
                    data = library.payload(entry + '.texture')
                    if not data:
                        continue
                    texture = parse_texture(data)
                    texture_name, usage = texture['name'], texture['picture']
                    if texture_name not in cache:
                        dds = library.payload(texture_name + '.dds')
                        if dds is None:
                            raise FormatError('missing texture: ' + texture_name)
                        try:
                            cache[texture_name] = convert_texture(dds, texture_name, texture_size, output / 'textures')
                        except (OSError, ValueError) as error:
                            cache[texture_name] = {'file': None, 'error': str(error), 'source': texture_name + '.dds'}
                    channels.setdefault(usage, []).append({'file': cache[texture_name]['file'],
                                                          'source': texture_name + '.dds', 'texcoord': texture['texcoord'],
                                                          'wrapU': texture['wrap_u'], 'wrapV': texture['wrap_v']})
            record['textureChannels'] = channels
            for usage, target in [('diffuse', 'texture'), ('normal', 'normalTexture'), ('specular', 'specularTexture'),
                                  ('gloss', 'glossTexture'), ('opacity', 'opacityTexture'), ('emission', 'emissionTexture')]:
                if channels.get(usage):
                    record[target] = channels[usage][0]['file']
            if record.get('normalTexture'):
                record['normalEncoding'] = 'rg-xy-reconstruct-z'
        except (FormatError, OSError, IndexError, KeyError) as error:
            failures.append({'material': name, 'error': str(error)})
    manifest.setdefault('textures', {}).update(cache)
    return failures


def export_scene(disc, scene, texture_size=0):
    path = ROOT / 'dist/probe' / scene['manifest']
    output = path.parent
    manifest = json.loads(path.read_text())
    stage, region = manifest['stage'], region_for(manifest['stage'])
    archives = {'stage': disc.open_archive(stage),
                'terrain': disc.open_archive('CmnActD_Terrain_' + region),
                'common': disc.open_archive('Cmn' + region),
                'objects': disc.open_archive('SonicActionCommonGeneral'),
                'system': disc.open_archive('SystemCommon')}
    library = Library(disc, archives)
    structure = disc.open_hashed_archive(stage)
    graphics = stage_graphics(stage, archives['stage'], structure, output)
    graphics['materialFailures'] = enrich_materials(manifest, library, output, texture_size)
    manifest['graphics'] = graphics
    manifest['graphicsFile'] = 'graphics.json'
    # Publish complete JSON while the local preview may be reading it.
    for target, data in [(output / 'graphics.json', graphics), (path, manifest)]:
        temporary = target.with_suffix(target.suffix + '.tmp')
        temporary.write_text(json.dumps(data, separators=(',', ':'), allow_nan=False))
        temporary.replace(target)
    print(f"{stage}: {len(graphics['lights'])} original lights, {len(manifest['materials'])} materials, "
          f"{graphics.get('lightField', {}).get('probes', {}).get('count', 0)} probes, "
          f"{len(graphics['materialFailures'])} missing materials", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('iso', type=Path)
    parser.add_argument('--stage', action='append', help='Only update these exported scene IDs.')
    parser.add_argument('--texture-size', type=int, default=0, help='Maximum texture edge; 0 preserves the source resolution.')
    args = parser.parse_args()
    disc = Disc(args.iso)
    catalog = json.loads((OUTPUT / 'catalog.json').read_text())
    for scene in catalog['scenes']:
        if not args.stage or scene['id'] in args.stage:
            export_scene(disc, scene, args.texture_size)
    sonic_path = OUTPUT / 'sonic.json'
    sonic = json.loads(sonic_path.read_text())
    failures = enrich_materials(sonic, Library(disc, {'sonic': disc.open_archive('Sonic')}), OUTPUT, args.texture_size)
    sonic['graphics'] = {'version': 1, 'materialFailures': failures}
    temporary = sonic_path.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(sonic, separators=(',', ':'), allow_nan=False))
    temporary.replace(sonic_path)
    print(f"Sonic: {len(sonic['materials'])} original materials, {len(failures)} missing", flush=True)


if __name__ == '__main__':
    main()
