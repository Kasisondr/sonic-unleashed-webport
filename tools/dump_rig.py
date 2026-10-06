#!/usr/bin/env python3
"""Print the character's rest-pose skeleton: every bone's world position.

Used to see whether a chain (an arm, a finger) is placed correctly or whether
its local translations have collapsed.

Run: ``python tools/dump_rig.py "<iso>"``
"""
import argparse
from pathlib import Path

from disc import Disc
from mirage import parse_model
from prepare_stage import Library
from diag_skin import compose_world, rest_locals


def main(iso):
    disc = Disc(iso)
    library = Library(disc, {"sonic": disc.open_archive("Sonic")})
    model = parse_model(library.payload("SonicRoot.model"))
    nodes = model["nodes"]
    world = compose_world(nodes, rest_locals(library, nodes))
    for index, node in enumerate(nodes):
        parent = node["parent"]
        matrix = world[index]
        position = (matrix[0][3], matrix[1][3], matrix[2][3])
        print(f"{index:4d} {node['name']:28s} parent={parent:4d} "
              f"({position[0]:8.3f},{position[1]:8.3f},{position[2]:8.3f})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    main(parser.parse_args().iso)
