#pragma once
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <vector>

// Prototype segmented address translation. Memory is proportional to the mapped
// guest regions rather than the 4 GiB guest address space. Not yet integrated
// with the generator's direct vector, atomic, setjmp or function-table accesses.
class GuestMemory {
    struct Region {
        uint32_t address;
        size_t size;
        std::unique_ptr<uint8_t[]> bytes;
    };
    std::vector<Region> regions;
    [[noreturn]] static void fail(const char* message) {
        std::fprintf(stderr, "Guest memory: %s\n", message);
        std::abort();
    }
public:
    void map(uint32_t address, size_t size) {
        uint64_t end = uint64_t(address) + size;
        if (address == 0 || size == 0 || end > 0x100000000ull)
            fail("invalid region");
        for (const auto& region : regions)
            if (uint64_t(address) < uint64_t(region.address) + region.size && region.address < end)
                fail("overlapping regions");
        regions.push_back({address, size, std::make_unique<uint8_t[]>(size)});
    }
    uint8_t* translate(uint32_t address, size_t length) {
        for (auto& region : regions) {
            uint64_t offset = uint64_t(address) - region.address;
            if (address >= region.address && offset <= region.size && length <= region.size - offset)
                return region.bytes.get() + offset;
        }
        fail("unmapped or out-of-bounds access");
    }
    size_t allocated() const {
        size_t result = 0;
        for (const auto& region : regions) result += region.size;
        return result;
    }
    template<class T> T load(uint32_t address) {
        T value;
        std::memcpy(&value, translate(address, sizeof(T)), sizeof(T));
        if constexpr (sizeof(T) == 2) return __builtin_bswap16(value);
        if constexpr (sizeof(T) == 4) return __builtin_bswap32(value);
        if constexpr (sizeof(T) == 8) return __builtin_bswap64(value);
        return value;
    }
    template<class T> void store(uint32_t address, T value) {
        if constexpr (sizeof(T) == 2) value = __builtin_bswap16(value);
        if constexpr (sizeof(T) == 4) value = __builtin_bswap32(value);
        if constexpr (sizeof(T) == 8) value = __builtin_bswap64(value);
        std::memcpy(translate(address, sizeof(T)), &value, sizeof(T));
    }
};
