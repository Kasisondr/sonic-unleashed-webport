#!/usr/bin/env python3
"""Cross-compile representative generated game units without linking or booting."""
import argparse
import json
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--units", default="0,130,260", help="Comma-separated generated unit indices, or all")
args = parser.parse_args()
game = ROOT / "generated/game"
if args.units == "all":
    sources = sorted(game.glob("ppc_recomp.*.cpp"))
else:
    sources = [game / f"ppc_recomp.{int(index)}.cpp" for index in args.units.split(",")]
if not sources or any(not source.exists() for source in sources):
    raise SystemExit("Generate the game sources before compiling them.")
emxx = shutil.which("em++")
if not emxx:
    raise SystemExit("Source emsdk_env.sh first.")
out = ROOT / "build/game-wasm"
out.mkdir(parents=True, exist_ok=True)


def compile_unit(source):
    log = out / (source.stem + ".log")
    object_path = out / (source.stem + ".o")
    with log.open("w") as stream:
        result = subprocess.run([emxx, str(source), "-std=c++20", "-O0", "-msimd128",
                                 "-fno-strict-aliasing", "-ferror-limit=20", "-I", str(game),
                                 "-I", str(ROOT / "upstream/tools/XenonRecomp/thirdparty/simde"),
                                 "-c", "-o", str(object_path)], stdout=stream, stderr=subprocess.STDOUT)
    record = {"unit": source.name, "compiled": result.returncode == 0,
              "log": str(log), "object_bytes": object_path.stat().st_size if result.returncode == 0 else 0}
    print(f"{'PASS' if record['compiled'] else 'FAIL'}: {source.name}", flush=True)
    return record


with ThreadPoolExecutor(max_workers=3) as pool:
    records = list(pool.map(compile_unit, sources))
report = {"units": records, "game_booted": False, "linked": False,
          "game_code_executed": False, "all_units_compiled": len(records) == 261 and all(r["compiled"] for r in records)}
(ROOT / "build/game-compile-report.json").write_text(json.dumps(report, indent=2) + "\n")
raise SystemExit(0 if all(record["compiled"] for record in records) else 1)
