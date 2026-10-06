#!/usr/bin/env python3
"""Produce an isolated, fail-fast WASM context for integer/SIMD feasibility tests.

This does NOT implement PowerPC floating-point mode changes or the timebase.
Those paths trap rather than silently producing incorrect gameplay.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
source = ROOT / "upstream/tools/XenonRecomp/XenonUtils/ppc_context.h"
text = source.read_text()
# SIMDe maps both its float and integer vectors to v128_t on WASM, so the
# upstream overloads collide. The generator supplies 0xF for float lanes and
# 0xFFFF for byte lanes, which preserves the distinction in one WASM overload.
mask_start = text.index("    inline void setFromMask(simde__m128 mask")
mask_end = text.index("\n};", mask_start)
text = text[:mask_start] + """#if defined(__wasm__)
    inline void setFromMask(simde__m128 mask, int imm) noexcept
    {
        int m;
        if (imm == 0xF) m = simde_mm_movemask_ps(mask);
        else if (imm == 0xFFFF) m = simde_mm_movemask_epi8(mask);
        else __builtin_trap();
        lt = m == imm;
        gt = 0;
        eq = m == 0;
        so = 0;
    }
#else
""" + text[mask_start:mask_end] + "\n#endif" + text[mask_end:]
fpscr_marker = "#if defined(__x86_64__) || defined(_M_X64)"
if text.count(fpscr_marker) != 1:
    raise SystemExit("Unexpected upstream floating-point context; review the patch.")
text = text.replace(fpscr_marker, """#if defined(__wasm__)
    static constexpr size_t RoundShift = 13;
    static constexpr size_t RoundMask = 3 << RoundShift;
    static constexpr size_t FlushMask = 0x8040;
    static constexpr size_t GuestToHost[] = { 0, 3 << RoundShift, 2 << RoundShift, 1 << RoundShift };
    inline uint32_t getcsr() noexcept { return 0; }
    inline void setcsr(uint32_t value) noexcept
    {
        if ((value & (RoundMask | FlushMask)) != 0)
            __builtin_trap(); // Default rounding only; no silent FPSCR approximation.
    }
#elif defined(__x86_64__) || defined(_M_X64)""")
timer_marker = "#if defined(__aarch64__) || defined(_M_ARM64)\ninline uint64_t __rdtsc()"
if text.count(timer_marker) != 1:
    raise SystemExit("Unexpected upstream timer context; review the patch.")
text = text.replace(timer_marker, """#if defined(__wasm__)
inline uint64_t __rdtsc() { __builtin_trap(); } // Guest timebase remains unimplemented.
#elif defined(__aarch64__) || defined(_M_ARM64)
inline uint64_t __rdtsc()""")
output = ROOT / "generated/browser/ppc_context.h"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(text)
print(output)
