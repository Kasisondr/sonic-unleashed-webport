#!/usr/bin/env python3
"""Confirm the model's node matrices are world-space inverse binds.

Each node stores one matrix; inverting it should land the bone on the centroid
of the vertices it drives, because the mesh ships in its bind pose.  Composing
them down the hierarchy first would be wrong -- they are already world-space.

Run: ``python tools/diag_bind3.py "<iso>"``
"""
import argparse
from math import sqrt
from pathlib import Path

from disc import Disc
from mirage import parse_model
from prepare_stage import Library
from diag_bind import bone_centroids, invert


def main(iso):
    disc = Disc(iso)
    library = Library(disc, {"sonic": disc.open_archive("Sonic")})
    model = parse_model(library.payload("SonicRoot.model"))
    nodes, raw = model["nodes"], model["transforms"]
    centroids = bone_centroids(model)
    errors = []
    for node, centroid in centroids.items():
        matrix = raw[node]
        if matrix is None:
            continue
        position = [invert(matrix)[row][3] for row in range(3)]
        errors.append((sqrt(sum((centroid[a] - position[a]) ** 2 for a in range(3))), nodes[node]["name"],
                       centroid, position))
    errors.sort(reverse=True)
    values = sorted(error for error, *_ in errors)
    print(f"invert(node matrix) vs geometry centroid, {len(values)} bones")
    print(f"  median {values[len(values) // 2]:.4f}   mean {sum(values)/len(values):.4f}   worst {values[-1]:.4f}")
    print(f"  within 10 cm: {sum(1 for v in values if v < 0.10)}/{len(values)}")
    print("\nworst:")
    for error, name, centroid, position in errors[:8]:
        print(f"  {name:24s} centroid ({centroid[0]:7.3f},{centroid[1]:7.3f},{centroid[2]:7.3f}) "
              f"bind ({position[0]:7.3f},{position[1]:7.3f},{position[2]:7.3f})  {error:.4f}")
    print("\nbest:")
    for error, name, centroid, position in errors[-5:]:
        print(f"  {name:24s} centroid ({centroid[0]:7.3f},{centroid[1]:7.3f},{centroid[2]:7.3f}) "
              f"bind ({position[0]:7.3f},{position[1]:7.3f},{position[2]:7.3f})  {error:.4f}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    main(parser.parse_args().iso)
