#!/usr/bin/env python3
"""Export Apotos wooden crate and terracotta pot props and place them in the stage."""
import json
from pathlib import Path
from mirage import read_ar, parse_model
from prepare_stage import export_geometry, write_geometry, pack_batches

ROOT = Path(__file__).resolve().parents[1]
STAGE_PATH = ROOT / "dist/probe/game/stage.json"
CACHE_PATH = ROOT / "build/stage/cache/SonicActionCommon_Mykonos.ar.00.raw"

def main():
    if not CACHE_PATH.exists():
        print("Cache archive not found, skipping prop export")
        return

    ar = read_ar(CACHE_PATH.read_bytes())
    stage = json.loads(STAGE_PATH.read_text())

    # Ensure materials exist
    materials = stage["materials"]

    # Material slot for blue woodbox (ha_wooddeck_blue)
    box_mat_id = next((i for i, m in enumerate(materials) if m.get("texture") == "myk_wood_ha_wooddeck_blue_dif.png"), None)
    if box_mat_id is None:
        box_mat_id = len(materials)
        materials.append({"name": "blue_woodbox", "slot": "Opaque", "flags": 0, "texture": "myk_wood_ha_wooddeck_blue_dif.png", "slotId": box_mat_id})

    # Material slot for terracotta pot
    pot_mat_id = next((i for i, m in enumerate(materials) if m.get("texture") == "myk_rock_hh_pot_dif.png"), None)
    if pot_mat_id is None:
        pot_mat_id = len(materials)
        materials.append({"name": "myk_rock_hh_pot", "slot": "Opaque", "flags": 0, "texture": "myk_rock_hh_pot_dif.png", "slotId": pot_mat_id})

    # Export woodbox
    model = parse_model(ar["myk_obj_ky_blue_woodboxM_000.model"])
    meshes = [m for g in model["groups"] for m in g["meshes"]]
    batches = pack_batches(meshes, [box_mat_id] * len(meshes))
    box_geom = export_geometry([m for m, _ in batches[0]], [[1,0,0,0],[0,1,0,0],[0,0,1,0]], [box_mat_id]*len(batches[0]))
    write_geometry(ROOT / "dist/probe/game/woodbox.bin", box_geom)

    # Export pot
    pot_model = parse_model(ar["myk_obj_kt3_potbigA_000.model"])
    pot_meshes = [m for g in pot_model["groups"] for m in g["meshes"]]
    pot_batches = pack_batches(pot_meshes, [pot_mat_id] * len(pot_meshes))
    pot_geom = export_geometry([m for m, _ in pot_batches[0]], [[1,0,0,0],[0,1,0,0],[0,0,1,0]], [pot_mat_id]*len(pot_batches[0]))
    write_geometry(ROOT / "dist/probe/game/pot.bin", pot_geom)

    # Register in stage.props
    stage["props"]["woodbox"] = {"file": "game/woodbox.bin", "scale": 1.0, "triangles": len(box_geom[3]) // 3}
    stage["props"]["pot"] = {"file": "game/pot.bin", "scale": 1.0, "triangles": len(pot_geom[3]) // 3}

    # Add placements into stage.objects near spawn and along the windmill run
    # Spawn is around [391.55, 44.48, 104.08]
    existing_names = {obj.get("name") for obj in stage["objects"]}
    new_props = [
        {"kind": "woodbox", "name": "apotos_crate_01", "position": [386.0, 44.5, 98.0], "yaw": 25.0},
        {"kind": "woodbox", "name": "apotos_crate_02", "position": [384.5, 44.5, 99.5], "yaw": -10.0},
        {"kind": "woodbox", "name": "apotos_crate_03", "position": [385.2, 45.7, 98.8], "yaw": 15.0},
        {"kind": "pot", "name": "apotos_pot_01", "position": [389.0, 44.5, 95.0], "yaw": 0.0},
        {"kind": "pot", "name": "apotos_pot_02", "position": [376.0, 43.8, 85.0], "yaw": 40.0},
        {"kind": "woodbox", "name": "apotos_crate_04", "position": [365.0, 41.5, 70.0], "yaw": 30.0},
        {"kind": "woodbox", "name": "apotos_crate_05", "position": [363.5, 41.5, 71.5], "yaw": -15.0},
        {"kind": "pot", "name": "apotos_pot_03", "position": [350.0, 39.0, 52.0], "yaw": 180.0},
        {"kind": "woodbox", "name": "apotos_crate_06", "position": [330.0, 36.2, 35.0], "yaw": 45.0},
        {"kind": "pot", "name": "apotos_pot_04", "position": [310.0, 34.0, 20.0], "yaw": -60.0},
    ]

    for p in new_props:
        if p["name"] not in existing_names:
            stage["objects"].append(p)

    STAGE_PATH.write_text(json.dumps(stage, indent=1))
    print(f"Exported woodbox and pot, updated stage.json with {len(new_props)} new props!")

if __name__ == "__main__":
    main()
