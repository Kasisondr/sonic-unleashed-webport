#!/usr/bin/env python3
"""Generate Unleashed C++ privately from hash-verified game and update inputs."""
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from audit_input import known_hashes, store_verified

ROOT = Path(__file__).resolve().parents[1]
upstream = ROOT / "upstream"
hash_root = upstream / "UnleashedRecomp/install/hashes"
game_hashes = known_hashes(hash_root / "game.cpp", "GameHashes", "GameFiles")
update_hashes = known_hashes(hash_root / "update.cpp", "UpdateHashes", "UpdateFiles")
for name, hashes in [("default.xex", game_hashes), ("shader.ar", game_hashes), ("default.xexp", update_hashes)]:
    path = ROOT / "private" / name
    if not path.exists():
        raise SystemExit(f"Missing verified input {path}; run audit_input.py first.")
    store_verified(path.read_bytes(), name, hashes[name])

config_dir = ROOT / "generated/config"
output_dir = ROOT / "generated/game"
config_dir.mkdir(parents=True, exist_ok=True)
output_dir.mkdir(parents=True, exist_ok=True)
text = (upstream / "UnleashedRecompLib/config/SWA.toml").read_text()
paths = {
    "file_path": ROOT / "private/default.xex",
    "patch_file_path": ROOT / "private/default.xexp",
    "patched_file_path": ROOT / "private/default_patched.xex",
    "out_directory_path": output_dir,
    "switch_table_file_path": upstream / "UnleashedRecompLib/config/SWA_switch_tables.toml",
}
for key, path in paths.items():
    relative = Path(os.path.relpath(path, config_dir)).as_posix()
    text, count = re.subn(rf'^{key} = ".*"$', f'{key} = "{relative}"', text, flags=re.MULTILINE)
    if count != 1:
        raise SystemExit(f"Unexpected upstream config key: {key}")
config = config_dir / "SWA.toml"
config.write_text(text)
subprocess.run([sys.executable, ROOT / "tools/make_browser_context.py"], check=True)
generator = ROOT / "build/host/xenon/XenonRecomp/XenonRecomp"
log_path = ROOT / "build/codegen.log"
with log_path.open("w") as log:
    result = subprocess.run([generator, config, ROOT / "generated/browser/ppc_context.h"], stdout=log, stderr=subprocess.STDOUT)
if result.returncode:
    raise SystemExit(f"Code generation failed; inspect {log_path}")
units = sorted(output_dir.glob("ppc_recomp.*.cpp"))
if not units:
    raise SystemExit(f"Code generation produced no units; inspect {log_path}")
mapping = (output_dir / "ppc_func_mapping.cpp").read_text()
functions = len(re.findall(r'\{ 0x[0-9A-F]+,', mapping))
report = {"translation_units": len(units), "mapped_functions": functions,
          "generated_bytes": sum(p.stat().st_size for p in output_dir.iterdir() if p.is_file()),
          "game_booted": False, "game_code_executed": False,
          "context": "Browser feasibility context; FP mode and timing limitations apply"}
(ROOT / "build/codegen-report.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
print(f"Generator diagnostics: {log_path}")
