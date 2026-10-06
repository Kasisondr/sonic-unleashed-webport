#include "guest_memory.h"
#define PPC_CONFIG_H_INCLUDED
#define PPC_IMAGE_BASE 0x82000000ull
#define PPC_IMAGE_SIZE 0x2000000ull
#define PPC_CODE_BASE 0x82000000ull
#define PPC_LOAD_U8(x) memory.load<uint8_t>(uint32_t(x))
#define PPC_LOAD_U16(x) memory.load<uint16_t>(uint32_t(x))
#define PPC_LOAD_U32(x) memory.load<uint32_t>(uint32_t(x))
#define PPC_LOAD_U64(x) memory.load<uint64_t>(uint32_t(x))
#define PPC_STORE_U8(x, y) memory.store<uint8_t>(uint32_t(x), y)
#define PPC_STORE_U16(x, y) memory.store<uint16_t>(uint32_t(x), y)
#define PPC_STORE_U32(x, y) memory.store<uint32_t>(uint32_t(x), y)
#define PPC_STORE_U64(x, y) memory.store<uint64_t>(uint32_t(x), y)
#include "ppc_context.h"

static void check(bool condition, const char* label) {
    if (!condition) { std::fprintf(stderr, "FAIL: %s\n", label); std::abort(); }
}

int main(int argc, char** argv) {
    PPCContext context{};
    if (argc == 2 && std::strcmp(argv[1], "rounding") == 0) {
        context.fpscr.storeFromGuest(PPC_ROUND_UP);
        return 1;
    }
    if (argc == 2 && std::strcmp(argv[1], "flush") == 0) {
        context.fpscr.enableFlushModeUnconditional();
        return 1;
    }
    GuestMemory memory;
    memory.map(0x82000000, 4096);
    memory.map(0xA0000000, 4096);
    if (argc == 2 && std::strcmp(argv[1], "unmapped") == 0) {
        memory.load<uint32_t>(0x90000000);
        return 1;
    }
    if (argc == 2 && std::strcmp(argv[1], "boundary") == 0) {
        memory.load<uint32_t>(0x82000FFE);
        return 1;
    }
    PPC_STORE_U32(0x82000001, 0x12345678); // Unaligned Xbox data.
    check(PPC_LOAD_U32(0x82000001) == 0x12345678, "big-endian U32");
    check(PPC_LOAD_U8(0x82000001) == 0x12, "byte order");
    PPC_STORE_U16(0x82000010, 0xABCD);
    check(PPC_LOAD_U16(0x82000010) == 0xABCD, "big-endian U16");
    PPC_STORE_U64(0xA0000008, 0xFEDCBA9876543210ull);
    check(PPC_LOAD_U64(0xA0000008) == 0xFEDCBA9876543210ull, "high guest address U64");
    check(memory.allocated() == 8192, "mapped memory size");
    context.cr0.compare(-3, 7, PPCXERRegister{});
    check(context.cr0.lt && !context.cr0.gt && !context.cr0.eq, "PPC condition register");
    auto sum = simde_mm_add_epi32(simde_mm_set1_epi32(40), simde_mm_set1_epi32(2));
    simde_mm_storeu_si128(reinterpret_cast<simde__m128i*>(context.v0.u32), sum);
    for (auto value : context.v0.u32) check(value == 42, "SIMD integer lanes");
    auto floats = simde_mm_mul_ps(simde_mm_set1_ps(1.5f), simde_mm_set1_ps(2.0f));
    simde_mm_storeu_ps(context.v1.f32, floats);
    for (auto value : context.v1.f32) check(value == 3.0f, "SIMD normal floats");
    context.cr6.setFromMask(simde_mm_set1_ps(-1.0f), 0xF);
    check(context.cr6.lt && !context.cr6.eq, "float comparison lane mask");
    context.cr6.setFromMask(simde_mm_set1_epi8(-1), 0xFFFF);
    check(context.cr6.lt && !context.cr6.eq, "integer comparison lane mask");
    context.cr6.setFromMask(simde_mm_setzero_si128(), 0xFFFF);
    check(!context.cr6.lt && context.cr6.eq, "empty comparison lane mask");
    check(context.fpscr.loadFromHost() == PPC_ROUND_NEAREST, "default rounding");
    context.fpscr.storeFromGuest(PPC_ROUND_NEAREST);
    std::puts("PASS: PPC context, SIMD and segmented guest memory (8192 bytes mapped)");
    return 0;
}
