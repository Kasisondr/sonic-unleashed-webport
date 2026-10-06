#!/usr/bin/env python3
"""Inspect the raw node matrices and test a global rigid alignment.

If the model's node matrices describe the bind pose in a different armature
frame, one global rigid transform will map every bone onto the centroid of the
vertices it drives.  Procrustes answers that directly.

Run: ``python tools/diag_bind2.py "<iso>"``
"""
import argparse
from collections import defaultdict
from math import sqrt
from pathlib import Path

from disc import Disc
from mirage import _component, parse_model
from prepare_sonic import first_element
from prepare_stage import Library
from diag_bind import bone_centroids, compose, invert, multiply


def procrustes(source, target):
    """Rigid G (rotation + translation) best mapping source onto target."""
    count = len(source)
    mean_source = [sum(point[axis] for point in source) / count for axis in range(3)]
    mean_target = [sum(point[axis] for point in target) / count for axis in range(3)]
    covariance = [[sum((source[i][a] - mean_source[a]) * (target[i][b] - mean_target[b]) for i in range(count))
                   for b in range(3)] for a in range(3)]
    # Jacobi eigen-decomposition of the symmetric 3x3 covariance, ascending.
    a = [row[:] for row in covariance]
    vectors = [[1.0 if i == j else 0.0 for j in range(3)] for i in range(3)]
    for _ in range(64):
        p, q, best = 0, 1, abs(a[0][1])
        for i in range(3):
            for j in range(i + 1, 3):
                if abs(a[i][j]) > best:
                    p, q, best = i, j, abs(a[i][j])
        if best < 1e-12:
            break
        angle = 0.5 * (2.0 * __import__("math").atan2(a[p][q], a[p][p] + a[q][q]))
        c, s = __import__("math").cos(angle), __import__("math").sin(angle)
        for k in range(3):
            akp, akq = a[k][p], a[k][q]
            a[k][p], a[k][q] = c * akp - s * akq, s * akp + c * akq
        for k in range(3):
            apk, aqk = a[p][k], a[q][k]
            a[p][k], a[q][k] = c * apk - s * aqk, s * apk + c * aqk
        for k in range(3):
            vkp, vkq = vectors[k][p], vectors[k][q]
            vectors[k][p], vectors[k][q] = c * vkp - s * vkq, s * vkp + c * vkq
    values = sorted([(a[i][i], [vectors[k][i] for k in range(3)]) for i in range(3)])
    rotation = [[sum(values[j][1][i] * values[(j + 1) % 3][1][k] for j in range(3)) for k in range(3)]
                for i in range(3)]
    offset = [mean_target[axis] - sum(rotation[axis][k] * mean_source[k] for k in range(3)) for axis in range(3)]
    return [[rotation[row][column] for column in range(3)] + [offset[row]] for row in range(3)] + [[0, 0, 0, 1]]


def main(iso):
    disc = Disc(iso)
    library = Library(disc, {"sonic": disc.open_archive("Sonic")})
    model = parse_model(library.payload("SonicRoot.model"))
    nodes, raw = model["nodes"], model["transforms"]
    wanted = {"Hips", "Hand_L", "Index1_L", "Middle3_L", "Toe_L", "Head", "Ear_L"}
    for index, node in enumerate(nodes):
        if node["name"] in wanted:
            flat = raw[index][0] + raw[index][1] + raw[index][2] + raw[index][3]
            print(f"{node['name']:12s} rows " + " ".join(f"({raw[index][r][0]:7.3f},{raw[index][r][1]:7.3f},"
                                                        f"{raw[index][r][2]:7.3f},{raw[index][r][3]:8.4f})" for r in range(4)))
            print(f"{'':12s} raw {[round(v, 4) for v in flat]}")

    centroids = bone_centroids(model)
    print("\nglobal rigid alignment of model bone world positions onto mesh centroids:")
    variants = {
        "as read": raw,
        "transposed": [[[m[c][r] for c in range(4)] for r in range(4)] for m in raw],
        "inverted": [invert(m) for m in raw],
    }
    for label, matrices in variants.items():
        world = compose(nodes, matrices)
        pairs = [(n, world[n], centroids[n]) for n in sorted(centroids) if world[n] is not None]
        source = [[m[row][3] for row in range(3)] for _, m, _ in pairs]
        target = [c for _, _, c in pairs]
        transform = procrustes(source, target)
        errors = sorted(sqrt(sum((sum(transform[r][k] * s[k] for k in range(3)) - t[r]) ** 2 for r in range(3)))
                        for s, t in zip(source, target))
        print(f"  {label:11s} before median {errors[len(errors)//2]:7.3f}  "
              f"after median {errors[len(errors)//2]:7.3f}  worst {errors[-1]:7.3f}")
        fitted = [sqrt(sum((sum(transform[r][k] * s[k] for k in range(3)) - t[r]) ** 2 for r in range(3)))
                  for s, t in zip(source, target)]
        fitted.sort()
        print(f"              after-fit median {fitted[len(fitted)//2]:7.3f}  worst {fitted[-1]:7.3f}  "
              f"rotation row0 ({transform[0][0]:6.3f},{transform[0][1]:6.3f},{transform[0][2]:6.3f}) "
              f"offset ({transform[0][3]:6.3f},{transform[1][3]:6.3f},{transform[2][3]:6.3f})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    main(parser.parse_args().iso)
