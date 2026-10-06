#!/usr/bin/env python3
"""Compare each bone's animation rotation against its bind rotation.

Skinning turns the mesh from the bind pose into the animated pose, so a bone
whose local rotation differs from its bind rotation by a whole half turn is a
bone that will fling its vertices to the wrong side of the body.

Run: ``python tools/diag_limb.py "<iso>" [animation] [frame]``
"""
import argparse
import json
import struct
from math import acos
from pathlib import Path

from disc import Disc
from mirage import parse_model
from prepare_stage import OUTPUT, Library

SOURCE = {"idle": "sonic_idle"}


def inverse(matrix):
    rotation = [[matrix[row][column] for column in range(3)] for row in range(3)]
    translation = [matrix[row][3] for row in range(3)]
    inverse_rotation = [[rotation[column][row] for column in range(3)] for row in range(3)]
    offset = [-sum(inverse_rotation[row][k] * translation[k] for k in range(3)) for row in range(3)]
    return [[inverse_rotation[row][column] for column in range(3)] + [offset[row]] for row in range(3)] + [[0, 0, 0, 1]]


def multiply(a, b):
    return [[sum(a[row][k] * b[k][column] for k in range(4)) for column in range(4)] for row in range(4)]


def quat_of(m):
    trace = m[0][0] + m[1][1] + m[2][2]
    if trace > 0:
        s = (trace + 1.0) ** 0.5 * 2.0
        q = ((m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s, 0.25 * s)
    else:
        i = max(range(3), key=lambda r: m[r][r])
        j, k = (i + 1) % 3, (i + 2) % 3
        s = (1.0 + m[i][i] - m[j][j] - m[k][k]) ** 0.5 * 2.0
        q = [0.0, 0.0, 0.0]
        q[i] = 0.25 * s
        q[j] = (m[j][i] + m[i][j]) / s
        q[k] = (m[k][i] + m[i][k]) / s
        q = (q[0], q[1], q[2], (m[k][j] - m[j][k]) / s)
    n = sum(v * v for v in q) ** 0.5 or 1.0
    return tuple(v / n for v in q)


def angle_between(a, b):
    dot = abs(sum(x * y for x, y in zip(a, b)))
    return acos(max(-1.0, min(1.0, dot)))


def main(iso, animation, frame):
    disc = Disc(iso)
    library = Library(disc, {"sonic": disc.open_archive("Sonic")})
    model = parse_model(library.payload("SonicRoot.model"))
    nodes = model["nodes"]
    bind_world = [inverse(m) for m in model["transforms"]]

    manifest = json.loads((OUTPUT / "sonic_anims.json").read_text())
    bank = (OUTPUT / "sonic_anims.bin").read_bytes()
    spec = manifest["animations"][animation]
    stride, sq, sp = manifest["stride"], manifest["quaternionScale"], manifest["positionScale"]
    at = spec["offset"] + frame * manifest["bones"] * stride
    anim_local, bind_local = [], []
    for bone in range(manifest["bones"]):
        q = [v / sq for v in struct.unpack_from("<4h", bank, at + bone * stride)]
        n = sum(v * v for v in q) ** 0.5 or 1.0
        q = [v / n for v in q]
        t = [v / sp for v in struct.unpack_from("<3h", bank, at + bone * stride + 8)]
        anim_local.append([[1, 0, 0, t[0]], [0, 1, 0, t[1]], [0, 0, 1, t[2]], [0, 0, 0, 1]])
        anim_local[-1] = quat_matrix(q, t)
        parent = nodes[bone]["parent"]
        if parent >= 0:
            local = multiply(inverse(bind_world[parent]), bind_world[bone])
        else:
            local = bind_world[bone]
        bind_local.append(local)

    rows = []
    for bone in range(len(nodes)):
        angle = angle_between(quat_of(bind_local[bone]), quat_of(anim_local[bone]))
        dbind = [bind_local[bone][r][3] for r in range(3)]
        danim = [anim_local[bone][r][3] for r in range(3)]
        shift = sum((dbind[r] - danim[r]) ** 2 for r in range(3)) ** 0.5
        rows.append((angle, shift, nodes[bone]["name"], dbind, danim))
    rows.sort(reverse=True)
    print(f"{animation} frame {frame}: rotation the animation applies on top of the bind pose")
    print(f"{'bone':24s} {'angle':>8s} {'bind local t':>26s} {'anim local t':>26s}  shift")
    for angle, shift, name, dbind, danim in rows[:20]:
        print(f"{name:24s} {angle*57.2958:7.1f}d ({dbind[0]:7.3f},{dbind[1]:7.3f},{dbind[2]:7.3f}) "
              f"({danim[0]:7.3f},{danim[1]:7.3f},{danim[2]:7.3f})  {shift:6.3f}")
    print("  ...")
    for angle, shift, name, dbind, danim in rows[-4:]:
        print(f"{name:24s} {angle*57.2958:7.1f}d ({dbind[0]:7.3f},{dbind[1]:7.3f},{dbind[2]:7.3f}) "
              f"({danim[0]:7.3f},{danim[1]:7.3f},{danim[2]:7.3f})  {shift:6.3f}")


def quat_matrix(q, t):
    x, y, z, w = q
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), t[0]],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), t[1]],
            [2 * (x * z + y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), t[2]],
            [0, 0, 0, 1]]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    parser.add_argument("animation", nargs="?", default="idle")
    parser.add_argument("frame", nargs="?", type=int, default=0)
    arguments = parser.parse_args()
    main(arguments.iso, arguments.animation, arguments.frame)
