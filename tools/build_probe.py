#!/usr/bin/env python3
"""Compile and execute native and WASM runtime probes, retaining diagnostics."""
import json
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build/wasm"
OUT.mkdir(parents=True, exist_ok=True)
simde = ROOT / "upstream/tools/XenonRecomp/thirdparty/simde"
emxx = shutil.which("em++")
node = os.environ.get("EMSDK_NODE") or shutil.which("node")
if not emxx or not node:
    raise SystemExit("Source an installed emsdk_env.sh before running this script.")


def run(args, log):
    result = subprocess.run([str(arg) for arg in args], cwd=ROOT, capture_output=True, text=True)
    (OUT / log).write_text(result.stdout + result.stderr)
    return result


common = ["-std=c++20", "-ferror-limit=0", "-I", simde]
untouched = run([emxx, ROOT / "probes/upstream_context.cpp", *common, "-msimd128",
                 "-I", ROOT / "upstream/tools/XenonRecomp/XenonUtils",
                 "-c", "-o", OUT / "upstream_context.o"], "upstream-context.log")
if untouched.returncode == 0:
    raise SystemExit("Upstream context compiled unexpectedly; review the portability baseline.")
if "Missing implementation for FPSCR" not in untouched.stderr or "Missing implementation for __rdtsc" not in untouched.stderr:
    raise SystemExit(f"Unexpected baseline error; see {OUT / 'upstream-context.log'}")
subprocess.run([shutil.which("python3"), ROOT / "tools/make_browser_context.py"], check=True)
includes = ["-I", ROOT / "src", "-I", ROOT / "generated/browser"]
source = ROOT / "probes/browser_core.cpp"
native = OUT / "browser_core_native"
result = run(["clang++", source, *common, *includes, "-O2", "-o", native], "native-build.log")
if result.returncode:
    raise SystemExit(result.stderr)
result = run([emxx, source, *common, *includes, "-O2", "-msimd128",
              "-sENVIRONMENT=node,web", "-o", OUT / "browser_core.js"], "wasm-build.log")
if result.returncode:
    raise SystemExit(result.stderr)
checks = []
for target, command in [("native", [native]), ("wasm", [node, OUT / "browser_core.js"])]:
    result = run(command, f"{target}-run.log")
    if result.returncode != 0 or "PASS:" not in result.stdout:
        raise SystemExit(f"{target} probe failed; see {OUT / (target + '-run.log')}")
    print(result.stdout.strip())
    checks.append({"target": target, "check": "integer_simd_memory", "passed": True})
    modes = ["unmapped", "boundary"] + (["rounding", "flush"] if target == "wasm" else [])
    for mode in modes:
        result = run([*command, mode], f"{target}-{mode}.log")
        diagnostic = result.stdout + result.stderr
        expected = ("Guest memory: unmapped or out-of-bounds access" in diagnostic
                    if mode in ("unmapped", "boundary") else "unreachable" in diagnostic)
        if result.returncode == 0 or not expected:
            raise SystemExit(f"{target} {mode} failed its rejection check; inspect its log")
        checks.append({"target": target, "check": f"reject_{mode}", "passed": True})

report = {"upstream_context_compiles_unmodified": False, "checks": checks,
          "game_booted": False, "game_code_executed": False,
          "limitations": ["Guest FP rounding changes and VMX flush mode trap",
                          "Guest timebase traps", "Memory mapping is a prototype",
                          "Direct vector, atomic, setjmp and lookup accesses not integrated",
                          "Renderer, audio and guest kernel not ported"]}
(OUT / "probe-report.json").write_text(json.dumps(report, indent=2) + "\n")
site = ROOT / "dist/probe"
site.mkdir(parents=True, exist_ok=True)
for name in ("browser_core.js", "browser_core.wasm"):
    shutil.copy2(OUT / name, site / name)
shutil.copy2(ROOT / "probes/index.html", site / "index.html")
print(f"Passed {len(checks)} checks. Report: {OUT / 'probe-report.json'}")
