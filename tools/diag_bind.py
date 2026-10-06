#!/usr/bin/env python3
"""Work out how the model's per-node matrices relate to the bind pose.

The .model stores one 4x4 per skeleton node and the mesh ships in its bind
pose, so the correct reading is the one that lands each bone on the centroid of
the vertices it drives.  Candidates: the matrix used directly, transposed, used
as a world inverse bind, or used as a local inverse bind that has to be composed
down the hierarchy first.

Run: ``python tools/diag_bind.py "<iso>"``
"""
import argparse
from collections import defaultdict
from pathlib import Path

from disc import Disc
from mirage import _component, parse_model
from prepare_sonic import first_element
from prepare_stage import Library


def multiply(a, b):
    return [[sum(a[row][k] * b[k][column] for k in range(4)) for column in range(4)] for row in range(4)]


def invert(matrix):
    """Inverse of an affine matrix (orthonormal rotation plus translation)."""
    rotation = [[matrix[row][column] for column in range(3)] for row in range(3)]
    translation = [matrix[row][3] for row in range(3)]
    inverse = [[rotation[column][row] for column in range(3)] for row in range(3)]
    offset = [-sum(inverse[row][k] * translation[k] for k in range(3)) for row in range(3)]
    return [[inverse[row][column] for column in range(3)] + [offset[row]] for row in range(3)] + [[0, 0, 0, 1]]


def compose(nodes, matrices):
    world, pending = [None] * len(nodes), list(range(len(nodes)))
    while pending:
        progressed = False
        for node in list(pending):
            parent = nodes[node]["parent"]
            if parent >= 0 and world[parent] is None:
                continue
            world[node] = matrices[node] if parent < 0 else multiply(world[parent], matrices[node])
            pending.remove(node)
            progressed = True
        if not progressed:
            return world
    return world


def bone_centroids(model):
    """node index -> weighted centroid of the mesh vertices it drives."""
    total = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])
    for group in model["groups"]:
        for mesh in group["meshes"]:
            table = mesh["bone_indices"]
            if not table or not mesh["vertex_count"]:
                continue
            position = first_element(mesh, "Position")
            indices_at, weights_at = first_element(mesh, "BlendIndices"), first_element(mesh, "BlendWeight")
            if position is None or indices_at is None or weights_at is None:
                continue
            for index in range(mesh["vertex_count"]):
                vertex = mesh["vertices"][index * mesh["vertex_size"]:(index + 1) * mesh["vertex_size"]]
                point = _component(vertex, position["offset"], position["format"])[:3]
                slots = [int(value) & 0xFF for value in
                         _component(vertex, indices_at["offset"], indices_at["format"])[:4]]
                weights = _component(vertex, weights_at["offset"], weights_at["format"])[:4]
                for slot, weight in zip(slots, weights):
                    if slot >= len(table) or weight <= 0:
                        continue
                    entry = total[table[slot]]
                    entry[0] += point[0] * weight
                    entry[1] += point[1] * weight
                    entry[2] += point[2] * weight
                    entry[3] += weight
    return {node: [value / entry[3] for value in entry[:3]] for node, entry in total.items() if entry[3] > 0}


def score(world, centroids):
    errors = []
    for node, centroid in centroids.items():
        matrix = world[node]
        if matrix is None:
            errors.append(10.0)
            continue
        errors.append(sum((centroid[axis] - matrix[axis][3]) ** 2 for axis in range(3)) ** 0.5)
    errors.sort()
    return errors[len(errors) // 2], errors


def main(iso):
    disc = Disc(iso)
    library = Library(disc, {"sonic": disc.open_archive("Sonic")})
    model = parse_model(library.payload("SonicRoot.model"))
    nodes, raw = model["nodes"], model["transforms"]
    centroids = bone_centroids(model)
    transpose = lambda m: [[m[column][row] for column in range(4)] for row in range(4)]
    candidates = {
        "as read, composed": compose(nodes, raw),
        "transposed, composed": compose(nodes, [transpose(m) for m in raw]),
        "inverted, composed": compose(nodes, [invert(m) for m in raw]),
        "as read, inverted after compose": [invert(m) for m in compose(nodes, raw)],
        "transposed, inverted after compose": [invert(m) for m in compose(nodes, [transpose(m) for m in raw])],
    }
    print(f"{len(centroids)} bones carry geometry\n")
    ranked = []
    for label, world in candidates.items():
        median, errors = score(world, centroids)
        ranked.append((median, max(errors), label, world))
        print(f"{label:36s} median {median:7.4f}  worst {max(errors):7.3f}")
    ranked.sort(key=lambda entry: entry[0])
    _, _, label, world = ranked[0]
    print(f"\nbest: {label}\n")
    rows = sorted(((sum((c[a] - world[n][a][3]) ** 2 for a in range(3)) ** 0.5, nodes[n]["name"], c,
                    [world[n][row][3] for row in range(3)]) for n, c in centroids.items()), reverse=True)
    print(f"{'bone':28s} {'centroid':>28s} {'bind':>28s}  error")
    for error, name, centroid, bone in rows[:10]:
        print(f"{name:28s} ({centroid[0]:8.3f},{centroid[1]:8.3f},{centroid[2]:8.3f}) "
              f"({bone[0]:8.3f},{bone[1]:8.3f},{bone[2]:8.3f})  {error:6.3f}")
    print("  ...")
    for error, name, centroid, bone in rows[-5:]:
        print(f"{name:28s} ({centroid[0]:8.3f},{centroid[1]:8.3f},{centroid[2]:8.3f}) "
              f"({bone[0]:8.3f},{bone[1]:8.3f},{bone[2]:8.3f})  {error:6.3f}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    main(parser.parse_args().iso)
