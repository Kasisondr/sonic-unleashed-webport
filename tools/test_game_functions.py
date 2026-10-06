#!/usr/bin/env python3
"""Differentially execute four isolated real game functions on native and WASM.

These leaf functions have no guest-memory, graphics, kernel, floating-point,
timing or external-call dependencies. This does not boot the game.
Generated game code and transcripts remain under ignored generated/build paths.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
game = ROOT / "generated/game"
out = ROOT / "build/differential"
out.mkdir(parents=True, exist_ok=True)
functions = [(138, "82B7A9E0"), (166, "82E069C0"), (176, "82E78338"), (181, "82EAAA20")]
bodies = []
for unit, address in functions:
    text = (game / f"ppc_recomp.{unit}.cpp").read_text()
    pattern = rf'PPC_FUNC_IMPL\(__imp__sub_{address}\) \{{\n(.*?)\n\}}'
    match = re.search(pattern, text, re.S)
    if not match or re.search(r'PPC_(?:LOAD|STORE|CALL|MM)|base \+|sub_|__rdtsc|longjmp|setjmp|simde_|ctx\.fpscr', match.group(1)):
        raise SystemExit(f"Unexpected dependency in leaf function {address}; review before executing.")
    bodies.append(match.group(0))

source = out / "game_leaf_probe.cpp"
source.write_text('#include "ppc_context.h"\n#include <cstdio>\n' + "\n".join(bodies) + "\n" + r'''
int main() {
    alignas(32) uint8_t base[32]{};
    PPCFunc* functions[] = {__imp__sub_82B7A9E0, __imp__sub_82E069C0,
                           __imp__sub_82E78338, __imp__sub_82EAAA20};
    uint32_t edge[] = {0,1,7,8,15,16,17,2047,2048,2049,0x7FFFFFFF,0x80000000,0xFFFFFFFF};
    uint32_t seed = 0x534F4E49;
    for (size_t index = 0; index < 4096; ++index) {
        seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
        uint32_t input = index < sizeof(edge) / sizeof(edge[0]) ? edge[index] : seed;
        for (size_t f = 0; f < 4; ++f) {
            PPCContext context{};
            context.r3.s64 = int32_t(input);
            context.r4.s64 = int32_t(input);
            functions[f](context, base);
            std::printf("%zu %08x %016llx\n", f, input, static_cast<unsigned long long>(context.r3.u64));
        }
    }
}
''')

emxx = shutil.which("em++")
node = os.environ.get("EMSDK_NODE") or shutil.which("node")
if not emxx or not node:
    raise SystemExit("Source emsdk_env.sh first.")
common = [str(source), "-std=c++20", "-O2", "-fno-strict-aliasing", "-I", str(game),
          "-I", str(ROOT / "upstream/tools/XenonRecomp/thirdparty/simde")]
native = out / "game_leaf_native"
wasm = out / "game_leaf.js"
for target, compiler, flags, output in [("native", "clang++", [], native), ("wasm", emxx, ["-msimd128", "-sENVIRONMENT=node"], wasm)]:
    result = subprocess.run([compiler, *common, *flags, "-o", str(output)], capture_output=True, text=True)
    (out / f"{target}-build.log").write_text(result.stdout + result.stderr)
    if result.returncode:
        raise SystemExit(f"{target} leaf compilation failed; inspect its build log.")
results = []
for target, command in [("native", [str(native)]), ("wasm", [node, str(wasm)])]:
    result = subprocess.run(command, capture_output=True)
    (out / f"{target}-run.log").write_bytes(result.stdout + result.stderr)
    if result.returncode or len(result.stdout.splitlines()) != 16384:
        raise SystemExit(f"{target} leaf execution failed or was incomplete.")
    results.append(result.stdout)
if results[0] != results[1]:
    raise SystemExit("Native/WASM game-function output differs; inspect transcripts.")
report = {"functions": [address for _, address in functions], "cases_per_function": 4096,
          "calls_per_target": 16384, "native_wasm_outputs_match": True,
          "output_sha256": hashlib.sha256(results[0]).hexdigest(),
          "game_booted": False, "isolated_game_functions_executed": True}
(ROOT / "build/differential-report.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
