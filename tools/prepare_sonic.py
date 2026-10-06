#!/usr/bin/env python3
"""Export Sonic's character model, skeleton and textures for the web port.

Reads SonicRoot.model from the disc's Sonic archive, packs the mesh geometry
into one 16-bit buffer (the same chunk container the terrain uses), decodes the
skeleton plus per-vertex blend data so the browser can skin the rig, and writes
serialised diffuse textures plus a manifest under dist/probe/game.

The model ships in its bind pose with the skin data the game uses:

* each node's 4x4 matrix is an **inverse bind** matrix, so the browser skins
  with ``world(animation) * inverseBind``;
* every mesh carries a byte table of node indices that the vertex blend indices
  address as slots, plus four ``UByte4Norm`` weights.
"""
import argparse
import json
import struct
from array import array
from pathlib import Path

from disc import Disc
from mirage import (FormatError, _component, mesh_triangles, parse_material, parse_model,
                    parse_texset, parse_texture)
from prepare_stage import OUTPUT, Library, convert_texture, resolve_texture

ROOT = Path(__file__).resolve().parents[1]
MAGIC = 0x32554753
VERTEX_BYTES = 44
SLOT_FLAGS = {"Opaque": 0, "Transparent": 1, "PunchThrough": 2}


def first_element(mesh, kind):
    return next((element for element in mesh["elements"] if element["type"] == kind), None)


def export_geometry(meshes, material_slots):
    """Pack meshes into one vertex/index buffer with blend data for skinning."""
    positions, uvs, colors, normals, blends, indices, primitives = (array("f"), array("f"), array("B"),
                                                                   array("f"), array("B"), array("H"), [])
    for mesh, material_index in zip(meshes, material_slots):
        triangles = mesh_triangles(mesh)
        position = first_element(mesh, "Position")
        if not triangles or position is None:
            continue
        texcoord, color, normal = (first_element(mesh, name) for name in ("TexCoord", "Color", "Normal"))
        indices_at, weights_at = first_element(mesh, "BlendIndices"), first_element(mesh, "BlendWeight")
        # Each mesh carries its own bone table, so the blend indices stored in
        # the vertices are slots into that table rather than bone numbers. The
        # browser's skinning shader indexes one global bone texture, so the
        # slots have to be resolved to node indices here.
        bone_table = mesh["bone_indices"]
        if len(positions) // 3 + mesh["vertex_count"] > 0xFFFF:
            raise FormatError("character geometry exceeds a single 16-bit buffer")
        vertex_start = len(positions) // 3
        stride, size = mesh["vertices"], mesh["vertex_size"]
        for index in range(mesh["vertex_count"]):
            vertex = stride[index * size:(index + 1) * size]
            point = _component(vertex, position["offset"], position["format"])[:3]
            uvs.extend(_component(vertex, texcoord["offset"], texcoord["format"])[:2] if texcoord else (0.0, 0.0))
            colors.extend(bytes(round(min(max(value, 0.0), 1.0) * 255) for value in
                                (_component(vertex, color["offset"], color["format"])[:4] if color else (1, 1, 1, 1))))
            direction = _component(vertex, normal["offset"], normal["format"])[:3] if normal else (0.0, 1.0, 0.0)
            # Blend indices are byte-wide slots; the signed Byte4 decode must wrap back to unsigned.
            slots = [int(value) & 0xFF for value in
                     (_component(vertex, indices_at["offset"], indices_at["format"])[:4] if indices_at else (0, 0, 0, 0))]
            # Resolve each slot through the mesh's own bone table. Slots the
            # table does not cover fall back to the root; their weight is zero
            # anyway, so they contribute nothing to the skin.
            slots = [bone_table[slot] if slot < len(bone_table) else 0 for slot in slots]
            weights = (_component(vertex, weights_at["offset"], weights_at["format"])[:4] if weights_at else (1, 0, 0, 0))
            positions.extend(point)
            length = sum(value * value for value in direction) ** 0.5 or 1.0
            normals.extend(value / length for value in direction)
            blends.extend(bytes(slots))
            blends.extend(bytes(round(min(max(value, 0.0), 1.0) * 255) for value in weights))
        index_start = len(indices)
        for triangle in triangles:
            indices.extend(vertex_start + vertex for vertex in triangle)
        primitives.append({"material": material_index, "flags": SLOT_FLAGS.get(mesh["slot"], 0),
                           "indexStart": index_start, "indexCount": len(triangles) * 3,
                           "vertexStart": vertex_start, "vertexCount": mesh["vertex_count"]})
    if not primitives:
        return None
    return positions, uvs, colors, indices, normals, blends, primitives


def write_geometry(path, geometry):
    positions, uvs, colors, indices, normals, blends, primitives = geometry
    header = struct.pack("<4I", MAGIC, len(primitives), len(positions) // 3, len(indices))
    table = b"".join(struct.pack("<6I", primitive["material"], primitive["flags"], primitive["indexStart"],
                                 primitive["indexCount"], primitive["vertexStart"], primitive["vertexCount"])
                     for primitive in primitives)
    vertices = bytearray()
    for index in range(len(positions) // 3):
        vertices += struct.pack("<5f4B3f8B", positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2],
                                uvs[index * 2], uvs[index * 2 + 1], *colors[index * 4:index * 4 + 4],
                                normals[index * 3], normals[index * 3 + 1], normals[index * 3 + 2],
                                *blends[index * 8:index * 8 + 8])
    path.write_bytes(header + table + bytes(vertices) + struct.pack(f"<{len(indices)}H", *indices))


def build(iso, limit=512):
    disc = Disc(iso)
    library = Library(disc, {"sonic": disc.open_archive("Sonic")})
    model = parse_model(library.payload("SonicRoot.model"))
    materials, textures, material_index = [], {}, {}

    def material_slot(name, slot):
        key = (name, slot)
        if key in material_index:
            return material_index[key]
        flags = SLOT_FLAGS.get(slot, 0)
        payload = library.payload(name + ".material")
        if payload is not None:
            parsed = parse_material(payload)
            if parsed["no_cull"]:
                flags |= 4
            if parsed["blend"]:
                flags |= 1
        texture_name, texture_payload = resolve_texture(library, name)
        file = None
        if texture_name is not None:
            if texture_name not in textures:
                try:
                    textures[texture_name] = convert_texture(texture_payload, texture_name, limit, OUTPUT / "textures")
                except Exception as error:  # A few console textures use layouts PIL cannot open.
                    textures[texture_name] = {"file": None, "error": str(error)[:120], "source": texture_name + ".dds"}
            file = textures[texture_name]["file"]
        material_index[key] = len(materials)
        materials.append({"name": name, "slot": slot, "flags": flags, "texture": file,
                          "shader": (parse_material(payload)["shader"] if payload else None)})
        return material_index[key]

    meshes, slots = [], []
    for group in model["groups"]:
        for mesh in group["meshes"]:
            meshes.append(mesh)
            slots.append(material_slot(mesh["material"] or "unknown", mesh["slot"]))
    geometry = export_geometry(meshes, slots)
    if geometry is None:
        raise FormatError("character model produced no geometry")
    file = OUTPUT / "sonic.bin"
    write_geometry(file, geometry)

    # Per-mesh bone tables: vertex blend indices are local slots into these lists,
    # and each entry is an index into the skeleton node array.
    mesh_table = []
    for mesh, material in zip(meshes, slots):
        mesh_table.append({"material": material, "bones": mesh["bone_indices"]})

    bones = []
    for index, node in enumerate(model["nodes"]):
        transform = model["transforms"][index] if index < len(model["transforms"]) else None
        bones.append({"name": node["name"], "parent": node["parent"], "transform": transform})

    manifest = {"file": f"game/{file.name}", "bytes": file.stat().st_size, "materials": materials,
                "textures": textures, "meshes": mesh_table, "bones": bones,
                "vertices": len(geometry[0]) // 3, "triangles": len(geometry[3]) // 3,
                "source": {"archive": "Sonic.ar.00", "model": "SonicRoot.model"}}
    (OUTPUT / "sonic.json").write_text(json.dumps(manifest))
    print(f"Exported Sonic: {manifest['triangles']} triangles, {len(materials)} materials, "
          f"{len(bones)} bones, {len(textures)} textures ({file.stat().st_size / 1e6:.1f} MB).")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    parser.add_argument("--texture-size", type=int, default=512)
    arguments = parser.parse_args()
    try:
        build(arguments.iso, arguments.texture_size)
    except (FormatError, OSError, KeyError, IndexError) as error:
        raise SystemExit(f"character export failed: {error}") from error
