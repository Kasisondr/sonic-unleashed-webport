"""Export the stage's original sky dome art from the disc.

Windmill Isle Act 1 keeps its sky in the ``ActD_MykonosAct1`` archive:

    myk_sky_morning.model   the dome the stage instance places in the world
    myk_sky01_morningA.dds  the sky layer (gradient, haze, sun disc)
    myk_sky01_morningB.dds  the second layer the Sky shader blends in
    light-field.lft         the stage's light field (sun position and colour)

The dome model is a plain sphere shell whose only meaningful data is its UVs,
so this tool writes a matching UV sphere in the same container the renderer
already reads (see ``Scene.loadSky``) and converts both disc layers to PNG.

The light field is a flat run of (position, direction) float pairs; the sun
direction is recovered from the most common direction in it, which is what
drives the shadow pass in ``scene.mjs``.
"""
import argparse
import io
import json
import math
import struct
from array import array
from pathlib import Path

from PIL import Image

from disc import Disc

OUTPUT = Path(__file__).resolve().parents[1] / "dist/probe/game"
STAGE_ARCHIVE = "ActD_MykonosAct1"
LAYERS = ("myk_sky01_morningA", "myk_sky01_morningB")
LIGHT_FIELD = "light-field.lft"

CHUNK_MAGIC = 0xFB15713D
VERTEX_FLOATS = 6  # position xyz, uv xy, padding z


def dome(rings=48, sectors=96, radius=1.0):
    """A UV sphere shell. The renderer projects it onto the far plane itself."""
    vertices, indices = [], []
    for row in range(rings + 1):
        v = row / rings
        theta = v * math.pi
        for column in range(sectors + 1):
            u = column / sectors
            phi = u * 2 * math.pi
            vertices.extend((
                radius * math.sin(theta) * math.cos(phi),
                radius * math.cos(theta),
                radius * math.sin(theta) * math.sin(phi),
                u, 1.0 - v, 0.0,
            ))
    stride = sectors + 1
    for row in range(rings):
        for column in range(sectors):
            a = row * stride + column
            indices.extend((a, a + stride, a + 1, a + 1, a + stride, a + stride + 1))
    return vertices, indices


def write_dome(path, radius=1.0):
    vertices, indices = dome(radius=radius)
    index_count = len(indices)
    header = struct.pack("<4I", CHUNK_MAGIC, 1, len(vertices) // VERTEX_FLOATS, index_count)
    primitive = struct.pack("<6I", 0, 0, 0, index_count, 0, len(vertices) // VERTEX_FLOATS)
    body = array("f", vertices).tobytes()
    body += array("H", indices).tobytes()
    path.write_bytes(header + primitive + body)
    return len(vertices) // VERTEX_FLOATS, index_count


def sun_from_sky(image):
    """Recover the sun's direction from the sky layer's own sun disc.

    The stage's light field (``light-field.lft``) stores surface positions and
    light directions in an undocumented layout, but the sky dome already has
    the sun painted into it, and the sky shader maps texels to directions as

        u = atan(z, x) / 2pi + 0.5,  v = 1 - texture.y,  y = v * 2 - 1

    so the brightest texel gives the direction the shadows have to agree with.
    """
    width, height = image.size
    pixels = image.convert("RGB").load()
    best, best_score = (0.0, 1.0, 0.0), -1.0
    # Only the upper hemisphere: the dome's lower band is the sea and the
    # horizon glow, which is bright but is not where the sun lights from.
    for ty in range(0, int(height * 0.45), 2):
        for tx in range(0, width, 2):
            r, g, b = pixels[tx, ty]
            # Weight brightness, and prefer a near-white sun over the warm
            # horizon glow which is bright but strongly tinted.
            score = (r + g + b) / 3.0 - abs(r - b) * 0.75
            if score <= best_score:
                continue
            u = (tx + 0.5) / width
            v = 1.0 - (ty + 0.5) / height
            angle = (u - 0.5) * 2 * math.pi
            y = v * 2 - 1
            length = math.sqrt(1.0 - y * y)
            best = (math.cos(angle) * length, y, math.sin(angle) * length)
            best_score = score
    length = math.sqrt(sum(c * c for c in best))
    return [round(c / length, 4) for c in best], round(best_score, 1)


def build(iso, radius=500.0):
    disc = Disc(iso)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    archive = disc.open_archive(STAGE_ARCHIVE)
    layers = {}
    first = None
    for name in LAYERS:
        payload = archive.get(name + ".dds")
        if payload is None:
            continue
        with Image.open(io.BytesIO(payload)) as image:
            image = image.convert("RGBA")
            path = OUTPUT / "textures" / f"{name}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            image.save(path)
            # Windmill Isle's two morning layers are both fully opaque renders
            # of the same dome (they average ~6% apart), so only a layer that
            # actually carries transparency is worth compositing over the base.
            low, high = image.getchannel("A").getextrema()
            layers[name] = {"file": path.name, "width": image.width, "height": image.height,
                            "overlay": low < 250}
            if first is None:
                first = Image.open(io.BytesIO(payload))
    vertices, indices = write_dome(OUTPUT / "sky.bin", radius)
    sky = {
        "file": "sky.bin", "radius": radius, "vertices": vertices, "indices": indices,
        "layers": layers,
        "source": {"archive": STAGE_ARCHIVE, "model": "myk_sky_morning.model"},
    }
    if first is not None:
        direction, score = sun_from_sky(first)
        sky["sun"] = {"direction": direction, "score": score,
                      "from": "sky disc in " + LAYERS[0] + ".dds"}
    if LIGHT_FIELD in archive:
        sky["source"]["lightField"] = LIGHT_FIELD
    return sky


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso")
    # The renderer draws the dome with a perspective matrix whose near plane is
    # 1 unit, so the shell has to sit comfortably inside the frustum or it is
    # clipped away entirely.
    parser.add_argument("--radius", type=float, default=500.0)
    args = parser.parse_args()
    sky = build(args.iso, args.radius)
    # The renderer reads the sky description out of the stage manifest.
    manifest_path = OUTPUT / "stage.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["sky"] = sky
    manifest_path.write_text(json.dumps(manifest))
    print(json.dumps(sky, indent=1))


if __name__ == "__main__":
    main()
