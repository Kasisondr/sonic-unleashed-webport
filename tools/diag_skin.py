#!/usr/bin/env python3
"""Diagnose the character skin: per-bone geometry vs. rest-pose bone positions.

The port's skinning is only correct if every bone lands on the centroid of the
vertices it drives.  For each mesh this tool reports, per bone actually used by
that mesh's blend data, the weighted vertex centroid and the rest-pose bone
position, so a wrong per-mesh bone table or a mis-parented chain shows up as a
large error rather than as spikes nobody can explain.

Run: ``python tools/diag_skin.py "<iso>"``
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
from prepare_sonic_anims import multiply, normalise
from prepare_stage import OUTPUT, Library


def rest_locals(library, nodes):
    """Idle frame 0 locals keyed by node index."""
    bone_of_skeleton, node_of_bone = {}, {}
    skeleton = Packfile(library.payload("SonicRoot.skl.hkx")).skeleton()
    for index, name in enumerate(skeleton["bones"]):
        bone_of_skeleton[normalise(name)] = index
    for index, node in enumerate(nodes):
        bone = bone_of_skeleton.get(normalise(node["name"]))
        if bone is not None:
            node_of_bone[bone] = index
    animation = SplineAnimation(Packfile(library.payload("sonic_idle.anm.hkx")))
    position, rotation, _scale = animation.sample(0)
    locals_ = [None] * len(nodes)
    for track, bone in enumerate(animation.binding):
        node = node_of_bone.get(bone)
        if node is not None:
            locals_[node] = {"p": list(position[track]), "r": list(rotation[track])}
    return locals_


def to_matrix(pose):
    """(x,y,z,w) quaternion + translation as a column-major-style 4x4 (rows)."""
    x, y, z, w = pose["r"]
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), pose["p"][0]],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), pose["p"][1]],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), pose["p"][2]],
            [0, 0, 0, 1]]


def compose_world(nodes, locals_):
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
            raise SystemExit("unresolved parents in rest pose")
    return world


def main(iso):
    disc = Disc(iso)
    library = Library(disc, {"sonic": disc.open_archive("Sonic")})
    model = parse_model(library.payload("SonicRoot.model"))
    nodes = model["nodes"]
    world = compose_world(nodes, rest_locals(library, nodes))
    name_of = [node["name"] for node in nodes]

    report = []
    for group in model["groups"]:
        for mesh in group["meshes"]:
            table = mesh["bone_indices"]
            elements = mesh["elements"]
            if not table or not mesh["vertex_count"]:
                continue
            position = first_element(mesh, "Position")
            indices_at, weights_at = first_element(mesh, "BlendIndices"), first_element(mesh, "BlendWeight")
            if position is None or indices_at is None or weights_at is None:
                continue
            centroids = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])
            slots_used = set()
            for index in range(mesh["vertex_count"]):
                vertex = mesh["vertices"][index * mesh["vertex_size"]:(index + 1) * mesh["vertex_size"]]
                point = _component(vertex, position["offset"], position["format"])[:3]
                slots = [int(value) & 0xFF for value in
                         _component(vertex, indices_at["offset"], indices_at["format"])[:4]]
                weights = _component(vertex, weights_at["offset"], weights_at["format"])[:4]
                for slot, weight in zip(slots, weights):
                    if slot >= len(table) or weight <= 0:
                        continue
                    slots_used.add(slot)
                    slot_total = centroids[slot]
                    slot_total[0] += point[0] * weight
                    slot_total[1] += point[1] * weight
                    slot_total[2] += point[2] * weight
                    slot_total[3] += weight
            rows = []
            for slot in sorted(slots_used):
                total = centroids[slot]
                if total[3] <= 0:
                    continue
                node = table[slot]
                centroid = [value / total[3] for value in total[:3]]
                bone = [world[node][row][3] for row in range(3)]
                error = sum((centroid[axis] - bone[axis]) ** 2 for axis in range(3)) ** 0.5
                rows.append((error, slot, node, name_of[node], centroid, bone, total[3]))
            rows.sort(reverse=True)
            report.append({"mesh": mesh["material"], "slot": mesh["slot"],
                           "vertices": mesh["vertex_count"], "bones": rows})

    worst = []
    for entry in report:
        for error, slot, node, name, centroid, bone, weight in entry["bones"]:
            worst.append((error, name, node, centroid, bone, weight, entry["mesh"]))
    worst.sort(reverse=True)
    print(f"{'error':>7}  {'bone':28s} {'centroid':>26s} {'rest':>26s}  {'mesh'}")
    for error, name, node, centroid, bone, weight, mesh in worst[:30]:
        print(f"{error:7.3f}  {name:28s} "
              f"({centroid[0]:8.3f},{centroid[1]:8.3f},{centroid[2]:8.3f}) "
              f"({bone[0]:8.3f},{bone[1]:8.3f},{bone[2]:8.3f})  {mesh}")
    median = sorted(error for error, *_ in worst)[len(worst) // 2] if worst else 0.0
    print(f"\nmedian error {median:.4f} over {len(worst)} bones in {len(report)} meshes")
    (OUTPUT / "skin-diag.json").write_text(json.dumps(
        {"rows": [{"error": error, "bone": name, "node": node, "centroid": centroid,
                   "rest": bone, "weight": weight, "mesh": mesh} for error, name, node, centroid, bone, weight, mesh in worst]}, indent=1))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    main(parser.parse_args().iso)
