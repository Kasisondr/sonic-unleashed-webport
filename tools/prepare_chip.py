#!/usr/bin/env python3
"""Export Chip's original WhipRoot model and flight/talk animations locally."""
import argparse
from pathlib import Path
from prepare_sonic import build as character
from prepare_sonic_anims import build as animation

def build(iso):
    options = dict(archive="SystemCommon", model_name="WhipRoot", output_name="chip")
    character(iso, **options)
    animation(iso, **options, animations=(
        ("idle", "whip_idle01", True),
        ("move", "whip_move", True),
        ("fast", "whip_move_fast", True),
        ("talk", "whip_talk", True),
    ))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    build(parser.parse_args().iso)
