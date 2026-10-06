#include <iostream>
#include <xcontent_file_system.h>

int main(int argc, char** argv) {
    if (argc != 3) {
        std::cerr << "Usage: extract_update <local STFS title update> <output default.xexp>\n";
        return 2;
    }
    auto package = XContentFileSystem::create(argv[1]);
    if (!package) {
        std::cerr << "Cannot read this title update package.\n";
        return 1;
    }
    std::cout << "Title update entries:\n";
    for (const auto& [name, entry] : package->fileMap)
        std::cout << name << " " << entry.size << " bytes\n";
    auto size = package->getSize("default.xexp");
    if (!size || size > 32 * 1024 * 1024) {
        std::cerr << "Package has no usable default.xexp.\n";
        return 1;
    }
    std::vector<uint8_t> bytes(size);
    if (!package->load("default.xexp", bytes.data(), bytes.size())) {
        std::cerr << "Failed to read executable patch.\n";
        return 1;
    }
    if (std::filesystem::exists(argv[2])) {
        std::cerr << "Refusing to overwrite an existing candidate patch.\n";
        return 1;
    }
    std::ofstream out(argv[2], std::ios::binary);
    out.write(reinterpret_cast<char*>(bytes.data()), bytes.size());
    if (!out) return 1;
    std::cout << "Extracted candidate patch; validate its upstream hash before use.\n";
}
