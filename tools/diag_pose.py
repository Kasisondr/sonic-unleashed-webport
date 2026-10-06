#!/usr/bin/env python3
"""Skin the character offline and report per-mesh bounds for one animation frame.

Reproduces exactly what the browser does -- ``world(animation) * inverseBind``
with the model's own node matrices as inverse binds -- so a stretched vertex can
be traced back to the bone that moved it.

Run: ``python tools/diag_pose.py "<iso>" [animation] [frame]``
"""
import argparse
import json
from collections import defaultdict
from pathlib import Path

from disc import Disc
from hkx import Packfile
from hkx_anim import SplineAnimation
from mirage import _component, parse_model
from prepare_sonic import first_element
from prepare_sonic_anims import ANIMATIONS, FPS, multiply, normalise
from prepare_stage import OUTPUT, Library

SOURCE = {name: source for name, source, _ in ANIMATIONS}


def to_matrix(pose):
    x, y, z, w = pose["r"]
    p = pose["p"]
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), p[0]],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), p[1]],
            [2 * (x * z + y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), p[2]],
            [0, 0, 0, 1]]


def compose(nodes, locals_):
    world, pending = [None] * len(nodes), list(range(len(nodes)))
    while pending:
        progressed = False
        for node in list(pending):
            parent = nodes[node]["parent"]
            if parent >= 0 and world[parent] is None:
                continue
            local = to_matrix(locals_[node])
            world[node] = local if parent < 0 else multiply(world[parent], local)
            pending.remove(node)
            progressed = True
        if not progressed:
            raise SystemExit("unresolved parents")
    return world


def inverse(matrix):
    rotation = [[matrix[row][column] for column in range(3)] for row in range(3)]
    translation = [matrix[row][3] for row in range(3)]
    inverse_rotation = [[rotation[column][row] for column in range(3)] for row in range(3)]
    offset = [-sum(inverse_rotation[row][k] * translation[k] for k in range(3)) for row in range(3)]
    return [[inverse_rotation[row][column] for column in range(3)] + [offset[row]] for row in range(3)] + [[0, 0, 0, 1]]


def main(iso, animation_name, frame_index):
    disc = Disc(iso)
    library = Library(disc, {"sonic": disc.open_archive("Sonic")})
    model = parse_model(library.payload("SonicRoot.model"))
    nodes = model["nodes"]
    # Each node matrix IS the world-space inverse bind; invert only to report
    # where the bone itself sits.
    bind_inverse = model["transforms"]
    bind_position = [inverse(m) for m in model["transforms"]]

    skeleton = Packfile(library.payload("SonicRoot.skl.hkx")).skeleton()
    bone_of_skeleton = {normalise(name): index for index, name in enumerate(skeleton["bones"])}
    node_of_bone = {}
    for index, node in enumerate(nodes):
        bone = bone_of_skeleton.get(normalise(node["name"]))
        if bone is not None:
            node_of_bone[bone] = index

    source = SOURCE.get(animation_name, animation_name)
    animation = SplineAnimation(Packfile(library.payload(source + ".anm.hkx")))
    frame = min(animation.num_frames - 1, frame_index)
    position, rotation, _scale = animation.sample(frame)
    locals_ = []
    driven = 0
    for index in range(len(nodes)):
        locals_.append(None)
    for track, bone in enumerate(animation.binding):
        node = node_of_bone.get(bone)
        if node is not None:
            q = list(rotation[track])
            n = sum(v * v for v in q) ** 0.5 or 1.0
            locals_[node] = {"p": list(position[track]), "r": [v / n for v in q]}
            driven += 1
    missing = [nodes[i]["name"] for i, pose in enumerate(locals_) if pose is None]
    print(f"{source} frame {frame}/{animation.num_frames - 1}: {driven}/{len(nodes)} bones driven by the animation")
    if missing:
        print(f"  bones with no track: {len(missing)} -> {missing[:12]}")

    # The browser falls back to the bake's stored locals for undriven bones, so
    # load them from the exported bank instead of guessing.
    manifest = json.loads((OUTPUT / "sonic_anims.json").read_text())
    spec = manifest["animations"][animation_name]
    bank = (OUTPUT / "sonic_anims.bin").read_bytes()
    import struct
    for node in range(len(nodes)):
        if locals_[node] is not None:
            continue
        at = spec["offset"] + frame_index * manifest["bones"] * manifest["stride"] + node * manifest["stride"]
        q = [value / manifest["quaternionScale"] for value in struct.unpack_from("<4h", bank, at)]
        t = [value / manifest["positionScale"] for value in struct.unpack_from("<3h", bank, at + 8)]
        locals_[node] = {"p": t, "r": q}
    world = compose(nodes, locals_)
    skin = [multiply(world[n], bind_inverse[n]) for n in range(len(nodes))]

    # Per-bone: where the bind geometry centroid ended up.
    moved = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])
    mesh_report, detail = [], []
    for group in model["groups"]:
        for mesh in group["meshes"]:
            table = mesh["bone_indices"]
            if not table or not mesh["vertex_count"]:
                continue
            position_e = first_element(mesh, "Position")
            indices_at, weights_at = first_element(mesh, "BlendIndices"), first_element(mesh, "BlendWeight")
            if position_e is None or indices_at is None or weights_at is None:
                continue
            low = [1e9, 1e9, 1e9]
            high = [-1e9, -1e9, -1e9]
            worst = (0.0, None, None)
            for index in range(mesh["vertex_count"]):
                vertex = mesh["vertices"][index * mesh["vertex_size"]:(index + 1) * mesh["vertex_size"]]
                point = _component(vertex, position_e["offset"], position_e["format"])[:3]
                slots = [int(v) & 0xFF for v in _component(vertex, indices_at["offset"], indices_at["format"])[:4]]
                weights = _component(vertex, weights_at["offset"], weights_at["format"])[:4]
                result = [0.0, 0.0, 0.0]
                for slot, weight in zip(slots, weights):
                    if slot >= len(table) or weight <= 0:
                        continue
                    node = table[slot]
                    m = skin[node]
                    for axis in range(3):
                        result[axis] += weight * (m[axis][0] * point[0] + m[axis][1] * point[1]
                                                  + m[axis][2] * point[2] + m[axis][3])
                    entry = moved[node]
                    for axis in range(3):
                        entry[axis] += weight * point[axis]
                    entry[3] += weight
                displacement = sum((result[axis] - point[axis]) ** 2 for axis in range(3)) ** 0.5
                if displacement > worst[0]:
                    worst = (displacement, index, point)
                if displacement > 0.25:
                    detail.append((displacement, mesh["material"], index, list(point), list(result),
                                   [(table[slt] if slt < len(table) else -1, nodes[table[slt]]["name"] if slt < len(table) else "?", w)
                                    for slt, w in zip(slots, weights) if w > 0]))
                for axis in range(3):
                    low[axis] = min(low[axis], result[axis])
                    high[axis] = max(high[axis], result[axis])
            mesh_report.append((max(abs(high[a] - low[a]) for a in range(3)), mesh["material"],
                                [round(v, 3) for v in low], [round(v, 3) for v in high], worst))
    mesh_report.sort(reverse=True)
    print(f"\n{'mesh':26s} {'low':>26s} {'high':>26s}  worst vertex move")
    for extent, material, low, high, worst in mesh_report:
        print(f"{material:26s} ({low[0]:7.3f},{low[1]:7.3f},{low[2]:7.3f}) "
              f"({high[0]:7.3f},{high[1]:7.3f},{high[2]:7.3f})  {worst[0]:6.3f} at v{worst[1]}")

    detail.sort(reverse=True)
    print("\nvertices that moved more than 25 cm:")
    for displacement, material, index, point, result, blend in detail[:15]:
        bones = ", ".join(f"{name}:{weight:.2f}" for _node, name, weight in blend)
        print(f"  {material:22s} v{index:<6d} ({point[0]:6.2f},{point[1]:6.2f},{point[2]:6.2f}) -> "
              f"({result[0]:6.2f},{result[1]:6.2f},{result[2]:6.2f})  {displacement:5.3f}  {bones}")

    rows = []
    for node, entry in moved.items():
        if entry[3] <= 0:
            continue
        centroid = [value / entry[3] for value in entry[:3]]
        bind = [bind_position[node][row][3] for row in range(3)]
        rows.append((sum((centroid[a] - bind[a]) ** 2 for a in range(3)) ** 0.5, nodes[node]["name"],
                     centroid, bind))
    rows.sort(reverse=True)
    print(f"\nlargest bone travel this frame ({rows[0][0]:.3f} worst):")
    for error, name, centroid, bind in rows[:12]:
        print(f"  {name:24s} bind ({bind[0]:7.3f},{bind[1]:7.3f},{bind[2]:7.3f}) "
              f"moved to ({centroid[0]:7.3f},{centroid[1]:7.3f},{centroid[2]:7.3f})  {error:6.3f}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    parser.add_argument("animation", nargs="?", default="idle")
    parser.add_argument("frame", nargs="?", type=int, default=0)
    arguments = parser.parse_args()
    main(arguments.iso, arguments.animation, arguments.frame)
