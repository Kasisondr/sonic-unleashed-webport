"""Export the original Sonic Unleashed HUD art from the disc.

The game builds its on-screen display from a handful of texture atlases that
live in the ordinary content archives:

    Sonic/ui_ps1_gauge1.dds            main gauge, ring icon, bar, labels
    Sonic/mat_playscreen_001.dds       gauge plate caps and digit pieces
    Sonic/mat_playscreen_002.dds       stacked gauge plate layers
    ActionCommon/ui_ps1_e_gauge1.dds   the life / vitality caps

Those atlases are sprite sheets: the game picks sub-rectangles at runtime. The
rectangles below were recovered with a connected-component pass over each
atlas' alpha channel (see ``describe``), then given names matching the element
names the disc's own UI layout files use (``gauge_frame``, ``ring_count``,
``score_count``, ``oso_speed_gauge``, ``so_ringenagy_gauge``, ``time_count``).

Every sprite is written as its own tightly-cropped PNG so the page can use a
plain ``background-image`` per element, plus ``ui.json`` describing the atlases
for anything that wants to sample them directly.
"""
import argparse
import io
import json
from collections import deque
from pathlib import Path

from PIL import Image

from disc import Disc

OUTPUT = Path(__file__).resolve().parents[1] / "dist/probe/ui"

# atlas name -> (archive, entry, sprites)
# Rectangles are (x0, y0, x1, y1) in atlas pixels.
ATLASES = {
    "gauge": ("Sonic", "ui_ps1_gauge1.dds", {
        # The signature Unleashed speed gauge: purple plate, tick ruler and
        # the gold boost ring, drawn as one piece.
        "gauge_frame": (1, 1, 186, 63),
        "sonic_head": (213, 3, 255, 37),
        # Fills left-to-right as Sonic accelerates.
        "speed_bar": (64, 64, 121, 80),
        "speed_line_a": (0, 106, 200, 108),
        "speed_line_b": (0, 109, 161, 111),
        "ring_icon": (72, 82, 95, 104),
        "plate": (206, 53, 255, 83),
        # Three chevrons that march while the gauge is filling.
        "chevron_0": (4, 64, 19, 83),
        "chevron_1": (22, 64, 41, 84),
        "chevron_2": (44, 64, 62, 79),
        "triangle": (0, 85, 20, 105),
        "cap_0": (45, 85, 56, 96),
        "cap_1": (59, 85, 70, 96),
        "label_ring": (0, 116, 52, 128),
        "label_energy": (55, 116, 133, 128),
        "label_speed": (134, 119, 210, 128),
        "label_time": (216, 101, 255, 108),
        "label_score": (206, 110, 255, 118),
        "label_ring_right": (213, 119, 252, 128),
    }),
    "playscreen_002": ("Sonic", "mat_playscreen_002.dds", {
        # Three stacked plate layers: the back plate, the middle plate and the
        # dark inset the numbers sit on.
        "plate_back": (27, 6, 147, 34),
        "plate_mid": (7, 39, 162, 91),
        "plate_mid_2": (25, 99, 149, 135),
        "plate_front": (5, 140, 164, 198),
        "plate_notch": (45, 84, 74, 101),
        "digit_0": (4, 222, 29, 251),
        "digit_1": (36, 222, 60, 251),
        "tick": (246, 2, 254, 23),
    }),
    "playscreen_001": ("Sonic", "mat_playscreen_001.dds", {
        "cap_a": (50, 3, 92, 31),
        "cap_b": (50, 38, 93, 66),
        "cap_c": (50, 74, 90, 98),
        "cap_d": (50, 104, 91, 127),
        "digit_a": (0, 3, 29, 21),
        "digit_b": (0, 27, 29, 46),
        "digit_c": (0, 74, 27, 88),
        "digit_d": (0, 101, 24, 113),
        "digit_rule_a": (0, 98, 26, 100),
        "digit_rule_b": (50, 103, 81, 105),
    }),
    "egauge": ("ActionCommon", "ui_ps1_e_gauge1.dds", {
        "vitality": (5, 2, 96, 28),
        "shield": (8, 35, 89, 55),
        "label_vitality": (1, 89, 105, 107),
        "label_shield": (111, 89, 194, 107),
    }),
}

# Extra art that is not part of the in-game HUD but belongs to the same family.
# The main menu already has its own exporter; these are the shared caps.
MENU_ARCHIVES = {
    "SystemCommonCore": ["ui_general.yncp", "ui_pause.yncp", "ui_status.yncp"],
    "Sonic": ["ui_lcursor.yncp"],
    "ActionCommon": ["ui_result.yncp", "ui_start.yncp"],
}


def components(image, threshold=24):
    """Label the opaque blobs in an atlas so sprite rects can be found."""
    width, height = image.size
    alpha = image.getchannel("A").load()
    solid = [[alpha[x, y] > threshold for x in range(width)] for y in range(height)]
    seen = [[False] * width for _ in range(height)]
    found = []
    for y in range(height):
        for x in range(width):
            if not solid[y][x] or seen[y][x]:
                continue
            queue, seen[y][x] = deque([(x, y)]), True
            points = []
            while queue:
                cx, cy = queue.popleft()
                points.append((cx, cy))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, 1), (0, -1)):
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < width and 0 <= ny < height and solid[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        queue.append((nx, ny))
            xs = [p[0] for p in points]
            ys = [p[1] for p in points]
            found.append((len(points), min(xs), min(ys), max(xs) + 1, max(ys) + 1))
    found.sort(reverse=True)
    return found


def load(disc, archive, entry, cache):
    key = (archive, entry)
    if key not in cache:
        cache[key] = disc.open_archive(archive)[entry]
    return Image.open(io.BytesIO(cache[key])).convert("RGBA")


def build(iso, describe=False):
    disc = Disc(iso)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    cache = {}
    manifest = {"atlases": {}, "sprites": {}}

    for atlas_name, (archive, entry, sprites) in ATLASES.items():
        image = load(disc, archive, entry, cache)
        if describe:
            print(f"=== {atlas_name} {image.size} from {archive}/{entry}")
            for area, x0, y0, x1, y1 in components(image)[:20]:
                print(f"    area={area:6d} ({x0},{y0},{x1},{y1}) {x1 - x0}x{y1 - y0}")
        atlas_path = OUTPUT / f"{atlas_name}.png"
        image.save(atlas_path)
        manifest["atlases"][atlas_name] = {
            "file": atlas_path.name, "width": image.width, "height": image.height,
            "source": f"{archive}/{entry}",
        }
        for sprite, (x0, y0, x1, y1) in sprites.items():
            crop = image.crop((x0, y0, x1, y1))
            crop.save(OUTPUT / f"{atlas_name}_{sprite}.png")
            manifest["sprites"][sprite] = {
                "file": f"{atlas_name}_{sprite}.png",
                "atlas": atlas_name, "rect": [x0, y0, x1, y1],
                "width": crop.width, "height": crop.height,
            }

    # Keep the raw .yncp layout files alongside the art: they are the game's own
    # description of this UI (element names, draw order) and are small.
    for archive, entries in MENU_ARCHIVES.items():
        available = disc.open_archive(archive)
        for entry in entries:
            if entry in available:
                (OUTPUT / f"{archive}_{entry}.yncp").write_bytes(available[entry])

    (OUTPUT / "ui.json").write_text(json.dumps(manifest, indent=1))
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso")
    parser.add_argument("--describe", action="store_true",
                        help="print the detected sprite rects instead of relying on the table")
    args = parser.parse_args()
    manifest = build(args.iso, describe=args.describe)
    print(f"wrote {len(manifest['sprites'])} sprites and {len(manifest['atlases'])} atlases to {OUTPUT}")


if __name__ == "__main__":
    main()
