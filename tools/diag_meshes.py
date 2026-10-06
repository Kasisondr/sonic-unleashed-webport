#!/usr/bin/env python3
"""List every character mesh with the bones it actually skins.

Shows the per-mesh bone table, which slots the vertices reference and the bone
names those slots resolve to, so a mesh that is skinned to the wrong nodes is
visible without guessing.

Run: ``python tools/diag_meshes.py "<iso>"``
"""
import argparse
from collections import Counter
from pathlib import Path

from disc import Disc
from mirage import _component, parse_model
from prepare_sonic import first_element
from prepare_stage import Library


def main(iso):
    disc = Disc(iso)
    library = Library(disc, {"sonic": disc.open_archive("Sonic")})
    model = parse_model(library.payload("SonicRoot.model"))
    nodes = model["nodes"]
    for group in model["groups"]:
        for mesh in group["meshes"]:
            table = mesh["bone_indices"]
            elements = mesh["elements"]
            if not mesh["vertex_count"]:
                continue
            position = first_element(mesh, "Position")
            indices_at, weights_at = first_element(mesh, "BlendIndices"), first_element(mesh, "BlendWeight")
            used = Counter()
            if indices_at is not None and table:
                for index in range(mesh["vertex_count"]):
                    vertex = mesh["vertices"][index * mesh["vertex_size"]:(index + 1) * mesh["vertex_size"]]
                    slots = _component(vertex, indices_at["offset"], indices_at["format"])[:4]
                    weights = _component(vertex, weights_at["offset"], weights_at["format"])[:4] if weights_at else (1, 0, 0, 0)
                    for slot, weight in zip(slots, weights):
                        if weight > 0:
                            slot = int(slot) & 0xFF
                            used[slot if slot < len(table) else "OOB"] += 1
            names = ", ".join(sorted({nodes[table[s]]["name"] if s in table else f"slot{s}?" for s in used}))
            print(f"{mesh['material']:24s} slot={mesh['slot']:14s} verts={mesh['vertex_count']:5d} "
                  f"table={len(table):3d} tris={len(mesh['indices'])}")
            print(f"    elements: {[e['type'] for e in elements]}")
            print(f"    slots used: {sorted(used, key=str)}")
            print(f"    bones: {names}\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    main(parser.parse_args().iso)
