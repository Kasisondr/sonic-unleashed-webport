#!/usr/bin/env python3
"""Export one playable stage from a verified disc ISO into browser files.

Reads the packed stage archive (terrain groups, textures, sky), the stage
structure archive (set data, stage info), common object archives and the
character archive. Writes derived geometry, textures and a manifest under
dist/probe/game. Extracted and derived data stay ignored by Git.
"""
import argparse
import io
import json
import math
import shutil
import struct
from array import array
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree

from PIL import Image
import numpy as np
from vertex_arrays import attribute

from disc import Disc
from mirage import (FormatError, _component, mesh_triangles, parse_material, parse_model, parse_terrain_model,
                    parse_texset, parse_texture, read_terrain_instance_info)

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "dist/probe/game"
STAGE = "ActD_MykonosAct1"
REGION = "Mykonos"

# Material flag bits shared by the exporters and the browser renderer:
# 1 blending, 2 alpha cut-out, 4 double-sided, 8 water surface.
SLOT_FLAGS = {"Opaque": 0, "Transparent": 1, "PunchThrough": 2}
WATER_FLAG = 8


class Library:
    """Lazy lookup of derived resources across the disc's archives."""

    def __init__(self, disc, archives):
        self.disc = disc
        self.entries, self.index, self.loaded = {}, None, set()
        for base, entries in archives.items():
            self.loaded.add(base)
            for name, payload in entries.items():
                self.entries.setdefault(name, payload)

    def payload(self, name):
        if name in self.entries:
            return self.entries[name]
        if self.index is None:
            self.index = self.disc.archive_index()
        base = self.index.get(name)
        if base is None:
            return None
        if base not in self.loaded:
            for entry, payload in self.disc.open_archive(base).items():
                self.entries.setdefault(entry, payload)
            self.loaded.add(base)
        return self.entries.get(name)


def resolve_texture(library, material_name, picture="diffuse"):
    """Material name to diffuse texture file name, following texset and texture."""
    material = library.payload(material_name + ".material")
    if material is None:
        return None, None
    parsed = parse_material(material)
    if not parsed["texset"]:
        return None, None
    texset = library.payload(parsed["texset"] + ".texset")
    if texset is None:
        return None, None
    textures = parse_texset(texset)["textures"]
    for entry in textures:
        payload = library.payload(entry + ".texture")
        if payload is None:
            continue
        texture = parse_texture(payload)
        if texture["picture"] != picture:
            continue
        dds = library.payload(texture["name"] + ".dds")
        if dds is None:
            continue
        return texture["name"], dds
    return None, None


def material_properties(parsed):
    """Source constants with renderer-friendly names; retain the full tables."""
    result = {"shader": parsed["shader"], "alphaThreshold": parsed["alpha"] / 255.0,
              "materialParameters": parsed["parameters"]}
    floats = parsed["parameters"]["float"]
    for source, target in (("diffuse", "diffuseColor"), ("ambient", "ambientColor"),
                           ("specular", "specularColor"), ("emissive", "emissiveColor"),
                           ("power_gloss_level", "powerGlossLevel")):
        if floats.get(source):
            result[target] = floats[source][0]
    if result.get("powerGlossLevel"):
        result["shininess"] = result["powerGlossLevel"][0]
    opacity = floats.get("opacity_reflection_refraction_spectype")
    if opacity:
        result["opacity"] = opacity[0][0]
    return result


def flat_water_level(mesh):
    """Height of a flat sea mesh, or None when the mesh is not a horizontal sheet.

    The stage's ocean is a single flat plane; "sea" named decorations such as
    sea_plant_* are ordinary geometry, so a near-zero height spread is required.
    """
    position = next((element for element in mesh["elements"] if element["type"] == "Position"), None)
    if position is None or not mesh["vertex_count"]:
        return None
    stride, size = mesh["vertices"], mesh["vertex_size"]
    heights = [_component(stride[index * size:(index + 1) * size], position["offset"], position["format"])[1]
               for index in range(mesh["vertex_count"])]
    if max(heights) - min(heights) > 0.5:
        return None
    return round(sum(heights) / len(heights), 3)


def pack_batches(meshes, material_indices, max_vertices=0xFFFF, max_indices=0x7FFFFFFF):
    """Split meshes into batches that fit one 16-bit vertex/index buffer."""
    batches, current, vertex_total, index_total = [], [], 0, 0
    for mesh, material_index in zip(meshes, material_indices):
        triangles = mesh_triangles(mesh)
        if not triangles or mesh["vertex_count"] > max_vertices or len(triangles) * 3 > max_indices:
            continue
        if current and (vertex_total + mesh["vertex_count"] > max_vertices
                        or index_total + len(triangles) * 3 > max_indices):
            batches.append(current)
            current, vertex_total, index_total = [], 0, 0
        current.append((mesh, material_index))
        vertex_total += mesh["vertex_count"]
        index_total += len(triangles) * 3
    if current:
        batches.append(current)
    return batches


def export_geometry_reference(meshes, transform, primitive_indices):
    """Pack meshes into one vertex/index buffer with per-primitive ranges.

    Positions are transformed into world space so the browser never has to
    track per-instance matrices, and collision uses the same triangles.
    """
    positions, uvs, colors, indices, normals, primitives = (array("f"), array("f"), array("B"),
                                                           array("H"), array("f"), [])
    for mesh, material_index in zip(meshes, primitive_indices):
        vertex_count, vertex_size, stride = mesh["vertex_count"], mesh["vertex_size"], mesh["vertices"]
        if not vertex_count:
            continue
        elements = {}
        for element in sorted(mesh['elements'], key=lambda item: item['usage']):
            elements.setdefault(element['type'], element)
        position = elements.get("Position")
        if position is None:
            continue
        triangles = mesh_triangles(mesh)
        if not triangles:
            continue
        texcoord = elements.get("TexCoord")
        color = elements.get("Color")
        normal = elements.get("Normal")
        if len(positions) // 3 + vertex_count > 0xFFFF:
            raise FormatError("stage geometry exceeds a single 16-bit buffer")
        vertex_start = len(positions) // 3
        mesh_transform = mesh.get("instance_transform", transform)
        for index in range(vertex_count):
            vertex = stride[index * vertex_size:(index + 1) * vertex_size]
            x, y, z = _component(vertex, position["offset"], position["format"])[:3]
            world = [sum(mesh_transform[row][column] * (x, y, z)[column] for column in range(3)) + mesh_transform[row][3]
                     for row in range(3)]
            positions.extend(world)
            uvs.extend(_component(vertex, texcoord["offset"], texcoord["format"])[:2] if texcoord else (0.0, 0.0))
            colors.extend(bytes(round(min(max(value, 0.0), 1.0) * 255) for value in
                                (_component(vertex, color["offset"], color["format"])[:4] if color else (1, 1, 1, 1))))
            direction = _component(vertex, normal["offset"], normal["format"])[:3] if normal else (0.0, 1.0, 0.0)
            rotated = [sum(mesh_transform[row][column] * direction[column] for column in range(3)) for row in range(3)]
            length = sum(value * value for value in rotated) ** 0.5 or 1.0
            normals.extend(value / length for value in rotated)
        index_start = len(indices)
        for triangle in triangles:
            indices.extend(vertex_start + vertex for vertex in triangle)
        primitives.append({"material": material_index, "flags": SLOT_FLAGS.get(mesh["slot"], 0),
                           "indexStart": index_start, "indexCount": len(triangles) * 3,
                           "vertexStart": vertex_start, "vertexCount": vertex_count})
    if not primitives:
        return None
    return positions, uvs, colors, indices, normals, primitives


def export_geometry(meshes, transform, primitive_indices):
    positions, uvs, colors, normals, indices, primitives = [], [], [], [], [], []
    vertex_total, index_total = 0, 0
    for mesh, material in zip(meshes, primitive_indices):
        elements = {}
        for element in sorted(mesh['elements'], key=lambda item: item['usage']):
            elements.setdefault(element['type'], element)
        if not elements.get('Position'):
            continue
        triangles = mesh_triangles(mesh)
        if not triangles or not mesh['vertex_count']:
            continue
        count, index_count = mesh['vertex_count'], len(triangles) * 3
        if vertex_total + count > 0xFFFF:
            raise FormatError('geometry exceeds a 16-bit buffer')
        matrix = np.asarray(mesh.get('instance_transform', transform), dtype=np.float32)
        point = attribute(mesh, elements['Position'], 3, (0,0,0))
        positions.append(point @ matrix[:3,:3].T + matrix[:3,3])
        uvs.append(attribute(mesh, elements.get('TexCoord'), 2, (0,0)))
        colors.append(np.rint(np.clip(attribute(mesh, elements.get('Color'), 4, (1,1,1,1)),0,1)*255).astype(np.uint8))
        normal = attribute(mesh, elements.get('Normal'), 3, (0,1,0)) @ matrix[:3,:3].T
        lengths = np.linalg.norm(normal, axis=1, keepdims=True)
        normals.append(normal / np.where(lengths == 0, 1, lengths))
        indices.append((np.asarray(triangles, dtype=np.uint32).ravel() + vertex_total).astype('<u2'))
        primitives.append({'material': material, 'flags': SLOT_FLAGS.get(mesh['slot'],0),
                           'indexStart': index_total, 'indexCount': index_count,
                           'vertexStart': vertex_total, 'vertexCount': count})
        vertex_total += count
        index_total += index_count
    if not primitives:
        return None
    return (np.concatenate(positions).ravel(), np.concatenate(uvs).ravel(), np.concatenate(colors).ravel(),
            np.concatenate(indices), np.concatenate(normals).ravel(), primitives)


def write_geometry(path, geometry):
    positions, uvs, colors, indices, normals, primitives = geometry
    header = struct.pack("<4I", 0x32554753, len(primitives), len(positions) // 3, len(indices))
    table = b"".join(struct.pack("<6I", primitive["material"], primitive["flags"], primitive["indexStart"],
                                 primitive["indexCount"], primitive["vertexStart"], primitive["vertexCount"])
                     for primitive in primitives)
    dtype = np.dtype([('position','<f4',3),('uv','<f4',2),('color','u1',4),('normal','<f4',3)])
    vertices = np.empty(len(positions)//3, dtype=dtype)
    vertices['position'] = np.asarray(positions).reshape(-1,3)
    vertices['uv'] = np.asarray(uvs).reshape(-1,2)
    vertices['color'] = np.asarray(colors).reshape(-1,4)
    vertices['normal'] = np.asarray(normals).reshape(-1,3)
    path.write_bytes(header + table + vertices.tobytes() + np.asarray(indices,dtype='<u2').tobytes())


def bounds(positions):
    minimum = [min(positions[i::3]) for i in range(3)]
    maximum = [max(positions[i::3]) for i in range(3)]
    return {"min": [round(float(value), 2) for value in minimum], "max": [round(float(value), 2) for value in maximum]}


# Set-data element name to the prop model and gameplay role the browser uses.
SET_OBJECTS = {
    "Ring": "ring", "SuperRing": "superring", "GoalRing": "goal", "Spring": "spring",
    "SpringBlue": "spring", "SpringRed": "spring", "SpringYellow": "spring",
    "DashPanel": "dashpanel", "JumpBoard3D": "jumpboard", "JumpBoard": "jumpboard",
}
# Model resource backing each prop role, with the scale the web renderer uses.
PROP_MODELS = {
    "ring": ("cmn_obj_ms_ringnormalM_000", 1.0),
    "superring": ("cmn_obj_ms_superringM_000", 1.0),
    "goal": ("cmn_obj_km_goalringM_000", 1.0),
    "spring": ("cmn_obj_kt3_springblueM_000", 1.0),
    "dashpanel": ("cmn_obj_ms_dashpanelM_000", 1.0),
    "jumpboard": ("cmn_obj_ms_jumpboard30", 1.0),
}


def parse_set_objects(xml_bytes, elements):
    """Position, yaw and scale of every requested element in one set file."""
    root = ElementTree.fromstring(xml_bytes)
    found = {element: [] for element in elements}
    for node in root:
        if node.tag not in found:
            continue
        position = node.find("Position")
        if position is None:
            continue
        scale = node.findtext("Scale")
        if scale is not None and float(scale) != 1.0:
            continue  # Scaled entries are per-set variants; their world place is ambiguous.
        rotation = node.find('Rotation')
        quat = [float(rotation.findtext(axis) or 0) for axis in ('x', 'y', 'z', 'w')] if rotation is not None else [0, 0, 0, 1]
        # Set objects use a quaternion, not the stage spawn's Yaw field.
        qx, qy, qz, qw = quat
        yaw = math.degrees(math.atan2(2*(qw*qy+qx*qz), 1-2*(qy*qy+qx*qx)))
        settings = {key: float(node.findtext(key)) for key in
                    ('ImpulseSpeedOnNormal', 'ImpulseSpeedOnBoost', 'OutOfControl', 'Speed', 'AngleType')
                    if node.findtext(key) is not None}
        placements = [node] + node.findall('MultiSetParam/Element')
        for placed in placements:
            pos = placed.find('Position')
            rot = placed.find('Rotation')
            if pos is None:
                continue
            rq = [float(rot.findtext(axis) or 0) for axis in ('x', 'y', 'z', 'w')] if rot is not None else quat
            x, y, z, w = rq
            found[node.tag].append({"position": [round(float(pos.findtext(axis)), 3) for axis in ("x", "y", "z")],
                                    "yaw": round(math.degrees(math.atan2(2*(w*y+x*z), 1-2*(y*y+x*x))), 3),
                                    "rotation": rq, "launch": settings,
                                    "name": node.findtext("Name") or node.findtext('SetObjectID')})
    return found


def parse_set_positions(xml_bytes, element="Ring"):
    """Positions of one set-data element, ignoring scaled multi-set entries."""
    root = ElementTree.fromstring(xml_bytes)
    positions = []
    for node in root.findall(element):
        position = node.find("Position")
        if position is None:
            continue
        scale = node.findtext("Scale")
        if scale is not None and float(scale) != 1.0:
            continue
        positions.append([round(float(position.findtext(axis)), 3) for axis in ("x", "y", "z")])
    return positions


def parse_stage_info(xml_bytes):
    root = ElementTree.fromstring(xml_bytes)
    sonic = root.find("Sonic")
    if sonic is None:
        if root.find('Evil') is not None:
            raise FormatError('This source scene uses a Werehog spawn. Werehog gameplay is not implemented.')
        raise FormatError('Stage has no Sonic starting position')
    position = sonic.find("Position")
    spawn = [float(position.findtext(axis)) for axis in ("x", "y", "z")]
    yaw = float(sonic.findtext("Yaw") or 0)
    sky = root.find("Sky")
    path = root.find("Path")
    bgm = root.find("BGM")
    active_sets = [layer.findtext('FileName') for layer in root.findall('SetData/Layer')
                   if (layer.findtext('IsGameActive') or 'true').lower() == 'true']
    return {"activeSets": active_sets, "spawn": [round(value, 3) for value in spawn], "yaw": yaw,
            "deadHeight": float(sonic.findtext("DeadHeight") or -260),
            "sky": sky.findtext("Model") if sky is not None else None,
            "guide": (path.find("Guide").findtext("Name") if path is not None and path.find("Guide") is not None else None),
            "bgm": bgm.findtext("Container") if bgm is not None else None}


def convert_texture(payload, name, limit, output):
    with Image.open(io.BytesIO(payload)) as image:
        image = image.convert("RGBA")
        if limit > 0 and max(image.size) > limit:
            ratio = limit / max(image.size)
            image = image.resize((max(1, round(image.width * ratio)), max(1, round(image.height * ratio))),
                                 Image.LANCZOS)
        path = output / f"{name}.png"
        if path.exists():
            try:
                with Image.open(path) as cached:
                    if cached.size == image.size:
                        cached.verify()
                        return {"file": path.name, "width": image.width, "height": image.height, "source": f"{name}.dds"}
            except (OSError, ValueError):
                pass
        image.save(path)
        return {"file": path.name, "width": image.width, "height": image.height, "source": f"{name}.dds"}


def build(iso, limit=512, skip_textures=False, stage_id=STAGE, region=REGION, output=OUTPUT):
    disc = Disc(iso)
    scene_archives = {
        "stage": disc.open_archive(stage_id),
        "terrain": disc.open_archive(f"CmnActD_Terrain_{region}"),
        "common": disc.open_archive(f"Cmn{region}"),
        "objects": disc.open_archive("SonicActionCommonGeneral"),
        "system": disc.open_archive("SystemCommon"),
    }
    structure = disc.open_hashed_archive(stage_id)
    library = Library(disc, scene_archives)
    output.mkdir(parents=True, exist_ok=True)
    (output / "chunks").mkdir(exist_ok=True)
    (output / "textures").mkdir(exist_ok=True)

    materials, textures = [], {}
    material_index = {}

    def material_slot(name, slot):
        flags = SLOT_FLAGS.get(slot, 0)
        properties = {}
        payload = library.payload(name + ".material")
        if payload is not None:
            parsed = parse_material(payload)
            properties = material_properties(parsed)
            if parsed["blend"]:
                flags |= 1
            if parsed["no_cull"]:
                flags |= 4
        if name in water_materials:
            flags |= WATER_FLAG
        texture_name, texture_payload = resolve_texture(library, name)
        file = None
        if texture_name is not None and not skip_textures:
            if texture_name not in textures:
                try:
                    textures[texture_name] = convert_texture(texture_payload, texture_name, limit, output / "textures")
                except Exception as error:  # A handful of textures use console-only layouts.
                    textures[texture_name] = {"file": None, "error": str(error)[:120], "source": texture_name + ".dds"}
            file = textures[texture_name]["file"]
        key = (name, slot)
        if key not in material_index:
            material_index[key] = len(materials)
            materials.append({"name": name, "slot": slot, "flags": flags,
                              "texture": file, "shader": None, "slotId": len(materials), **properties})
        return material_index[key]

    groups, shared = disc.open_packed_stage(stage_id)
    for entries in shared.values():
        library.entries.update(entries)
    chunks = []
    # The ocean is a single flat sheet: find its height and material before packing.
    water_level, water_materials = None, set()
    for group_name in sorted(groups):
        for name, payload in sorted(groups[group_name].items()):
            if not name.endswith(".terrain-model"):
                continue
            try:
                candidate = parse_terrain_model(payload)
            except FormatError:
                continue
            for group in candidate["groups"]:
                for mesh in group["meshes"]:
                    material = mesh["material"] or ""
                    if "sea" not in material.lower() and "water" not in material.lower():
                        continue
                    level = flat_water_level(mesh)
                    if level is not None:
                        water_level = level
                        water_materials.add(material)
    for group_name in sorted(groups):
        entries = groups[group_name]
        models = {name.rsplit(".", 1)[0]: parse_terrain_model(payload)
                  for name, payload in entries.items() if name.endswith(".terrain-model")}
        meshes = []
        for name, payload in sorted(entries.items()):
            if not name.endswith(".terrain-instanceinfo"):
                continue
            info = read_terrain_instance_info(payload)
            model = models.get(info["model"])
            if model is None:
                continue
            for group in model["groups"]:
                for mesh in group["meshes"]:
                    meshes.append(dict(mesh, instance_transform=info["matrix"]))
        if not meshes:
            continue
        indices = [material_slot(mesh["material"] or "unknown", mesh["slot"]) for mesh in meshes]
        for part, batch in enumerate(pack_batches(meshes, indices)):
            geometry = export_geometry([mesh for mesh, _ in batch], [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]],
                                       [material for _, material in batch])
            if geometry is None:
                continue
            positions = geometry[0]
            suffix = "" if part == 0 else f".p{part}"
            file = output / "chunks" / (group_name.replace(".ar", "") + suffix + ".bin")
            write_geometry(file, geometry)
            chunks.append({"file": f"chunks/{file.name}", "name": group_name + suffix,
                           "triangles": len(geometry[3]) // 3, "vertices": len(positions) // 3,
                           "bounds": bounds(positions), "bytes": file.stat().st_size})

    # Props: small models placed by the set data (rings, springs, dash panels).
    props = {}
    for role, (model_name, scale) in PROP_MODELS.items():
        payload = library.payload(model_name + ".model")
        if payload is None:
            continue
        prop_meshes, prop_slots = [], []
        for group in parse_model(payload)["groups"]:
            for mesh in group["meshes"]:
                prop_meshes.append(mesh)
                prop_slots.append(material_slot(mesh["material"] or "unknown", mesh["slot"]))
        batches = pack_batches(prop_meshes, prop_slots)
        if not batches:
            continue
        geometry = export_geometry([mesh for mesh, _ in batches[0]],
                                   [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]],
                                   [material for _, material in batches[0]])
        file = output / f"{role}.bin"
        write_geometry(file, geometry)
        props[role] = {"file": file.relative_to(ROOT / "dist/probe").as_posix(), "scale": scale, "triangles": len(geometry[3]) // 3}

    objects = []
    stage = parse_stage_info(structure['Stage.stg.xml'])
    for name in sorted(structure):
        if not name.endswith(".set.xml") or (stage["activeSets"] and name not in stage["activeSets"]):
            continue
        for element, entries in parse_set_objects(structure[name], tuple(SET_OBJECTS)).items():
            for entry in entries:
                objects.append({"kind": SET_OBJECTS[element], "element": element, "set": name,
                                "position": entry["position"], "yaw": entry["yaw"], "name": entry["name"],
                                "rotation": entry['rotation'], "launch": entry['launch']})
    rings = [obj["position"] for obj in objects if obj["kind"] in ("ring", "superring")]
    springs = [{"type": obj["element"], "position": obj["position"]}
               for obj in objects if obj["kind"] == "spring"]
    stage = parse_stage_info(structure["Stage.stg.xml"])
    manifest = {"version": 3, "stage": stage_id, "spawn": stage["spawn"], "yaw": stage["yaw"],
                "materials": materials, "chunks": chunks, "rings": rings, "springs": springs,
                "objects": objects, "props": props, "water": water_level, "deadHeight": stage["deadHeight"],
                "assetBase": output.relative_to(ROOT / "dist/probe").as_posix() + "/",
                "textures": textures, "game_booted": False,
                "source": {"iso": str(disc.iso_path), "packed": f"Packed/{stage_id}/Stage.pfd",
                           "structure": f"#{stage_id}.ar.00", "bgm": stage["bgm"], "guide": stage["guide"]}}
    (output / "stage.json").write_text(json.dumps(manifest, indent=1))
    for source in (ROOT / "web").iterdir():
        if source.is_file():
            shutil.copy2(source, ROOT / "dist/probe" / source.name)
    total = sum(chunk["bytes"] for chunk in chunks)
    kinds = Counter(obj["kind"] for obj in objects)
    print(f"Exported {len(chunks)} terrain chunks ({total / 1e6:.1f} MB), {len(props)} prop models, "
          f"{dict(kinds)}, {len(materials)} material uses, {len(textures)} textures.")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    parser.add_argument("--texture-size", type=int, default=512)
    parser.add_argument("--skip-textures", action="store_true")
    parser.add_argument("--stage", default=STAGE)
    parser.add_argument("--region", default=REGION)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    arguments = parser.parse_args()
    try:
        build(arguments.iso, arguments.texture_size, arguments.skip_textures, arguments.stage, arguments.region, arguments.output)
    except (FormatError, OSError, KeyError, IndexError, ElementTree.ParseError) as error:
        raise SystemExit(f"{type(error).__name__}: {error}")
