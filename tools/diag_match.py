#!/usr/bin/env python3
"""Find the animation frame whose pose best matches the model's bind pose.

The mesh ships in its bind pose, so the correct inverse binds should agree with
some pose the skeleton can actually take.  Scanning every baked frame shows
which bones never line up -- that separates a decode bug (a chain that is wrong
in every frame) from a genuine pose difference.

Run: ``python tools/diag_match.py "<iso>"``
"""
import argparse
import json
import struct
from pathlib import Path

from disc import Disc
from hkx import Packfile
from hkx_anim import SplineAnimation
from mirage import parse_model
from prepare_sonic_anims import ANIMATIONS, multiply, normalise
from prepare_stage import OUTPUT, Library

SOURCE = {name: source for name, source, _ in ANIMATIONS}


def to_matrix(p, r):
    x, y, z, w = r
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
            local = to_matrix(*locals_[node])
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


def main(iso):
    disc = Disc(iso)
    library = Library(disc, {"sonic": disc.open_archive("Sonic")})
    model = parse_model(library.payload("SonicRoot.model"))
    nodes = model["nodes"]
    bind = [[inverse(m)[row][3] for row in range(3)] for m in model["transforms"]]

    manifest = json.loads((OUTPUT / "sonic_anims.json").read_text())
    bank = (OUTPUT / "sonic_anims.bin").read_bytes()
    stride, scale_q, scale_p = manifest["stride"], manifest["quaternionScale"], manifest["positionScale"]
    frame_bytes = manifest["bones"] * stride

    best = []
    for name, spec in manifest["animations"].items():
        for frame in range(spec["frames"]):
            locals_ = []
            at = spec["offset"] + frame * frame_bytes
            for bone in range(manifest["bones"]):
                q = [v / scale_q for v in struct.unpack_from("<4h", bank, at + bone * stride)]
                p = [v / scale_p for v in struct.unpack_from("<3h", bank, at + bone * stride + 8)]
                locals_.append((p, q))
            world = compose(nodes, locals_)
            errors = sorted(sum((world[n][a][3] - bind[n][a]) ** 2 for a in range(3)) ** 0.5
                            for n in range(len(nodes)) if world[n] is not None)
            best.append((errors[len(errors) // 2], errors[-1], name, frame, errors, world))
    best.sort(key=lambda entry: entry[0])
    print("best-matching frames (median / worst bone disagreement with bind):")
    for median, worst, name, frame, _errors, _world in best[:6]:
        print(f"  {name:9s} frame {frame:4d}  median {median:.4f}  worst {worst:.4f}")

    median, worst, name, frame, errors, world = best[0]
    print(f"\nper-bone disagreement at the best frame ({name} {frame}):")
    rows = sorted(((sum((world[n][a][3] - bind[n][a]) ** 2 for a in range(3)) ** 0.5, nodes[n]["name"],
                    [world[n][a][3] for a in range(3)], bind[n]) for n in range(len(nodes)) if world[n]), reverse=True)
    for error, bone, animated, bound in rows[:16]:
        print(f"  {bone:24s} anim ({animated[0]:7.3f},{animated[1]:7.3f},{animated[2]:7.3f}) "
              f"bind ({bound[0]:7.3f},{bound[1]:7.3f},{bound[2]:7.3f})  {error:6.3f}")
    print("  ...")
    for error, bone, animated, bound in rows[-4:]:
        print(f"  {bone:24s} anim ({animated[0]:7.3f},{animated[1]:7.3f},{animated[2]:7.3f}) "
              f"bind ({bound[0]:7.3f},{bound[1]:7.3f},{bound[2]:7.3f})  {error:6.3f}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    main(parser.parse_args().iso)
