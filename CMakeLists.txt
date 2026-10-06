cmake_minimum_required(VERSION 3.20)
project(UnleashedWebHostTools LANGUAGES C CXX)

# Build the pinned code generator on the host independently of desktop graphics,
# SDL, vcpkg and the game's own build. Generated code is cross-compiled later.
set(CMAKE_CXX_STANDARD 20)
set(FMT_TEST OFF CACHE BOOL "" FORCE)
set(XXHASH_BUILD_XXHSUM OFF CACHE BOOL "" FORCE)
add_subdirectory(upstream/tools/XenonRecomp xenon)

add_executable(extract_update tools/extract_update.cpp
    upstream/UnleashedRecomp/install/xcontent_file_system.cpp)
target_include_directories(extract_update PRIVATE upstream/UnleashedRecomp/install)
target_compile_options(extract_update PRIVATE -include ${CMAKE_CURRENT_SOURCE_DIR}/tools/host_prelude.h)
target_link_libraries(extract_update PRIVATE XenonUtils)

set(UNLEASHED_RECOMP_TOOLS_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/upstream/tools")
add_subdirectory(upstream/tools/x_decompress x_decompress)
