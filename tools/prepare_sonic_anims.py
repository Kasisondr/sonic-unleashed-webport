#!/usr/bin/env python3
"""Bake Sonic's disc animations into a compact skinned-pose bank for the web port.

Every ``*.anm.hkx`` on the disc carries one spline track per skeleton bone and
the binding is the identity map, so track *i* is bone *i*.  Sampling those
tracks, converting them into the character model's node order and storing them
as quantised local transforms lets the browser compose the rig and skin the
mesh exactly like the game does.

Key layout facts this relies on, all verified against the disc:

* the model's node matrices are **inverse bind** matrices (inverting them lands
  every bone on the centroid of the vertices it drives, median error 4 cm);
* animation tracks are already in the same space as the bind pose (idle frame 0
  puts the hips at y=0.495 against a bind height of 0.502);
* the skeleton's own reference pose is a collapsed placeholder and is *not*
  used as the bind pose.

Run: ``python tools/prepare_sonic_anims.py "<iso>"``
"""
import argparse
import json
import struct
from pathlib import Path

from disc import Disc
from hkx import Packfile
from hkx_anim import SplineAnimation
from prepare_stage import OUTPUT, Library

# Gameplay states the player drives, in the order they are baked.
ANIMATIONS = (
    ("idle", "sonic_idle", True),
    ("walk", "sonic_walk", True),
    ("run", "sonic_run", True),
    ("dash", "sonic_dash", True),
    ("ball", "sonic_ball", True),
    ("jump", "sonic_jump_C", False),
    ("fall", "sonic_jump_D_loop", True),
    ("land", "sonic_landing_A", False),
    ("landidle", "sonic_landing_idle", True),
    ("spring", "sonic_springjump_E", False),
    ("brake", "sonic_brake_M_L", False),
    ("squat", "sonic_stand_squat", False),
    ("airboost", "sonic_airboost", True),
)
FPS = 30
POSITION_SCALE = 2048.0
QUATERNION_SCALE = 32767.0


def multiply(a, b):
    return [[sum(a[row][k] * b[k][column] for k in range(4)) for column in range(4)] for row in range(4)]


def invert(matrix):
    """Inverse of an affine matrix (rotation plus translation)."""
    rotation = [[matrix[row][column] for column in range(3)] for row in range(3)]
    translation = [matrix[row][3] for row in range(3)]
    inverse = [[rotation[column][row] for column in range(3)] for row in range(3)]
    offset = [-sum(inverse[row][k] * translation[k] for k in range(3)) for row in range(3)]
    return [[inverse[row][column] for column in range(3)] + [offset[row]] for row in range(3)] + [[0, 0, 0, 1]]


def quaternion(matrix):
    """Rotation part of a matrix as (x, y, z, w)."""
    trace = matrix[0][0] + matrix[1][1] + matrix[2][2]
    if trace > 0.0:
        scale = (trace + 1.0) ** 0.5 * 2.0
        return ((matrix[2][1] - matrix[1][2]) / scale, (matrix[0][2] - matrix[2][0]) / scale,
                (matrix[1][0] - matrix[0][1]) / scale, 0.25 * scale)
    index = max(range(3), key=lambda i: matrix[i][i])
    other, third = (index + 1) % 3, (index + 2) % 3
    scale = (1.0 + matrix[index][index] - matrix[other][other] - matrix[third][third]) ** 0.5 * 2.0
    values = [0.0, 0.0, 0.0]
    values[index] = 0.25 * scale
    values[other] = (matrix[other][index] + matrix[index][other]) / scale
    values[third] = (matrix[third][index] + matrix[index][third]) / scale
    return (values[0], values[1], values[2], (matrix[third][other] - matrix[other][third]) / scale)


def normalise(name):
    """Skeleton bone names carry an ``@LT`` tag the model's nodes omit."""
    return name[:-3] if name.endswith("@LT") else name


def build(iso, *, archive="Sonic", model_name="SonicRoot", output_name="sonic", animations=ANIMATIONS):
    disc = Disc(iso)
    library = Library(disc, {archive: disc.open_archive(archive)})
    character = json.loads((OUTPUT / (output_name + ".json")).read_text())
    nodes = character["bones"]
    bind_inverse = [[[float(value) for value in row] for row in node["transform"]] for node in nodes]

    skeleton = Packfile(library.payload(model_name + ".skl.hkx")).skeleton()
    bone_of_skeleton = {normalise(name): index for index, name in enumerate(skeleton["bones"])}
    node_of_bone = {}
    for index, node in enumerate(nodes):
        bone = bone_of_skeleton.get(normalise(node["name"]))
        if bone is not None:
            node_of_bone[bone] = index
    missing = [index for index in range(len(skeleton["bones"])) if index not in node_of_bone]
    if missing:
        raise SystemExit(f"skeleton bones without a model node: {[skeleton['bones'][i] for i in missing]}")

    # The animation's locals must be composed along the skeleton hierarchy, which
    # the model mirrors by name.  Verify that instead of assuming it.
    parents = [-1] * len(nodes)
    for index, node in enumerate(nodes):
        if node["parent"] >= 0:
            parents[index] = node["parent"]
    for bone, node in node_of_bone.items():
        parent = skeleton["parents"][bone]
        expected = node_of_bone[parent] if parent >= 0 else -1
        if expected != parents[node]:
            raise SystemExit(f"bone {skeleton['bones'][bone]} expects parent {expected}, model says {parents[node]}")

    # The model's node array is not topologically sorted, so the browser needs an
    # explicit parent-before-child order to compose the rig in one pass.
    order, seen = [], {}

    def visit(node):
        if seen.get(node):
            return
        seen[node] = "open"
        if parents[node] >= 0:
            visit(parents[node])
        seen[node] = "done"
        order.append(node)

    for index in range(len(nodes)):
        visit(index)
    cycles = [name for name, state in seen.items() if state != "done"]
    if cycles:
        raise SystemExit(f"bone hierarchy has a cycle at {cycles[0]}")

    # Bind locals only matter for bones an animation leaves untouched.
    locals_ = []
    for index in range(len(nodes)):
        parent = parents[index]
        world_bind = invert(bind_inverse[index])
        local_bind = multiply(bind_inverse[parent], world_bind) if parent >= 0 else world_bind
        rotation = quaternion(local_bind)
        offset = [local_bind[row][3] for row in range(3)]
        locals_.append({"position": offset, "rotation": rotation})

    frames, data = {}, bytearray()
    # Prefer idle locals for unanimated bones, with true local bind transforms
    # as the fallback. The browser always uses the model's original inverse bind.
    rest = [None] * len(nodes)
    for name, source, loop in animations:
        if name != "idle":
            continue
        idle = SplineAnimation(Packfile(library.payload(source + ".anm.hkx")))
        for track, bone in enumerate(idle.binding):
            if bone in node_of_bone:
                position, rotation, _ = idle.sample(0)
                node = node_of_bone[bone]
                rest[node] = {"position": list(position[track]), "rotation": list(rotation[track])}
        break
    for name, source, loop in animations:
        payload = library.payload(source + ".anm.hkx")
        if payload is None:
            raise SystemExit(f"missing animation {source}")
        animation = SplineAnimation(Packfile(payload))
        track_of_bone = {}
        for track, bone in enumerate(animation.binding):
            if bone in node_of_bone:
                track_of_bone.setdefault(node_of_bone[bone], track)
        count = max(2, round(animation.duration * FPS) + (1 if loop else 0))
        offset = len(data)
        peak = 0.0
        for frame in range(count):
            seconds = frame / FPS
            if loop:
                source_frame = round(seconds / animation.duration * (animation.num_frames - 1)) % max(1, animation.num_frames - 1)
            else:
                source_frame = min(animation.num_frames - 1, round(seconds / animation.duration * (animation.num_frames - 1)))
            position, rotation, _scale = animation.sample(source_frame)
            poses = [rest[node] or locals_[node] for node in range(len(nodes))]
            for node, track in track_of_bone.items():
                poses[node] = {"position": list(position[track]), "rotation": list(rotation[track])}
            for pose in poses:
                peak = max(peak, max(abs(value) for value in pose["position"]))
                quaternion_values = pose["rotation"]
                normal = sum(value * value for value in quaternion_values) ** 0.5 or 1.0
                data += struct.pack("<4h3h",
                                    *(round(value / normal * QUATERNION_SCALE) for value in quaternion_values),
                                    *(round(value * POSITION_SCALE) for value in pose["position"]))
        frames[name] = {"offset": offset, "bytes": len(data) - offset, "frames": count,
                        "duration": round(count / FPS, 4), "loop": loop, "source": source,
                        "peakPosition": round(peak, 3), "motion": "root" if peak > 1.0 else "inPlace"}

    file = OUTPUT / (output_name + "_anims.bin")
    file.write_bytes(data)
    manifest = {"file": f"game/{file.name}", "bytes": file.stat().st_size, "bones": len(nodes),
                "stride": 14, "fps": FPS, "positionScale": POSITION_SCALE,
                "quaternionScale": QUATERNION_SCALE, "parents": parents, "order": order,
                "animations": frames,
                "source": {"archive": archive, "skeleton": model_name + ".skl.hkx"}}
    (OUTPUT / (output_name + "_anims.json")).write_text(json.dumps(manifest))
    total = sum(frame["frames"] for frame in frames.values())
    print(f"Exported {len(frames)} animations: {total} frames, {file.stat().st_size / 1e6:.2f} MB "
          f"({manifest['stride']} bytes per bone).")
    for name, frame in frames.items():
        print(f"   {name:9s} {frame['frames']:4d} frames {frame['duration']:6.2f}s "
              f"peak|pos| {frame['peakPosition']:6.3f} {frame['motion']}")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    arguments = parser.parse_args()
    build(arguments.iso)
