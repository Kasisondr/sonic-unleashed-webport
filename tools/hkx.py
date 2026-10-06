"""Reader for the Havok 5.5 packfiles the disc uses for character animation.

The layout was derived from the disc's own files and verified against them:

* the file header is big-endian (the 360 build) and ends after the
  16-byte ``contentsVersion`` string ("KHavok-5.5.0-r1");
* three section headers follow, each 0x30 bytes: name[16], a marker word
  (0xFF), the section's file offset and size, then offsets of the local,
  global and virtual fixup tables relative to that data, then the extent;
* ``__classnames__`` holds ``(u32 hash, u8 length, name)`` entries used by the
  virtual fixups to name each object's class;
* ``__data__`` holds the serialized objects, patched by local fixups
  ``(from, to)``, global fixups ``(from, section, to)`` and virtual fixups
  ``(from, section, classOffset)`` that give an object its class.
"""
import struct

MAGIC = 0x57E0E057
CLASSNAMES, TYPES, DATA = "__classnames__", "__types__", "__data__"


class HkxError(ValueError):
    """Raised when a packfile does not match the verified layout."""


class Section:
    def __init__(self, data, header):
        (self.name_raw, self.marker, self.offset, self.local_offset, self.global_offset,
         self.virtual_offset, self.end, _pad0, _pad1) = header
        self.name = self.name_raw.split(b"\0")[0].decode("ascii")
        self.data = data[self.offset:self.offset + min(self.local_offset, self.end)]
        self.local = [(a, b) for a, b in
                      struct.iter_unpack(">2I", data[self.offset + self.local_offset:self.offset + self.global_offset])]
        # The global table carries a trailing 4-byte terminator, so trim to the entry size.
        raw = data[self.offset + self.global_offset:self.offset + self.virtual_offset]
        self.global_ = list(struct.iter_unpack(">3I", raw[:len(raw) // 12 * 12]))
        raw = data[self.offset + self.virtual_offset:self.offset + self.end]
        self.virtual = list(struct.iter_unpack(">3I", raw[:len(raw) // 12 * 12]))

    def __repr__(self):
        return (f"<Section {self.name!r} at {self.offset:#x} size {len(self.data)} "
                f"local {len(self.local)} global {len(self.global_)} virtual {len(self.virtual)}>")


class Packfile:
    """Objects and fixups of one Havok packfile."""

    def __init__(self, data):
        if len(data) < 0x40:
            raise HkxError("truncated packfile")
        if struct.unpack_from(">I", data, 0)[0] != MAGIC:
            raise HkxError("not a Havok packfile")
        self.raw = data
        version = data[0x0C:0x10]
        if version != b"\0\0\0\x05":
            raise HkxError(f"unsupported Havok version {version.hex()}")
        self.version = 5
        self.contents_section = struct.unpack_from(">I", data, 0x18)[0]
        self.contents_offset = struct.unpack_from(">I", data, 0x1C)[0]
        self.sections = []
        for index in range(3):
            header = struct.unpack_from(">16s8I", data, 0x40 + index * 0x30)
            self.sections.append(Section(data, header))
        self.classnames = self.sections[0]
        self.type_section = self.sections[1]
        self.data_section = self.sections[2]
        self.names = self._read_classnames()
        self.classes = {}
        for from_offset, section, name_offset in self.data_section.virtual:
            name = self.names.get(name_offset)
            if name is not None:
                self.classes[from_offset] = name

    def _read_classnames(self):
        """Class name entries: a hash, a flag byte, then a NUL-terminated name.

        Virtual fixups reference the name's own offset, so keys are the offset
        of the first character.
        """
        names, offset, data = {}, 0, self.classnames.data
        while offset + 6 <= len(data):
            end = data.find(b"\0", offset + 5)
            if end < 0:
                break
            try:
                names[offset + 5] = data[offset + 5:end].decode("ascii")
            except UnicodeDecodeError:
                break
            offset = end + 1
        return names

    def data_pointer(self, offset):
        """Resolve a pointer slot in the data section to (section, offset)."""
        for from_offset, section, to_offset in self.data_section.global_:
            if from_offset == offset:
                return section, to_offset
        return None

    def data_local(self, offset):
        for from_offset, to_offset in self.data_section.local:
            if from_offset == offset:
                return to_offset
        return None

    def class_at(self, offset):
        return self.classes.get(offset)

    def objects(self):
        """Every object in the data section with its class name."""
        return sorted((offset, name) for offset, name in self.classes.items())

    def bytes_at(self, offset, count):
        return self.data_section.data[offset:offset + count]

    def u32(self, offset):
        return struct.unpack_from(">I", self.data_section.data, offset)[0]

    def i32(self, offset):
        return struct.unpack_from(">i", self.data_section.data, offset)[0]

    def string_at(self, offset):
        data = self.data_section.data
        return data[offset:data.find(b"\0", offset)].decode("ascii", "replace")

    def global_pointer(self, offset):
        """Target offset of a global fixup, or None when the slot is empty."""
        for from_offset, _section, to_offset in self.data_section.global_:
            if from_offset == offset:
                return to_offset
        return None

    def skeleton(self):
        """Read the first ``hkaSkeleton``: bone names and parent indices.

        The class layout is the Havok 5.5 one: name, then five pointer/count
        array pairs (parent indices, bones, transforms, float slots).  Bones are
        separate objects reached through global fixups whose names are stored
        inline right after each object.
        """
        base = next((offset for offset, name in self.classes.items() if name == "hkaSkeleton"), None)
        if base is None:
            raise HkxError("packfile has no hkaSkeleton")
        parents_at, count = self.data_local(base + 0x04), self.u32(base + 0x08)
        bones_at, bone_count = self.data_local(base + 0x0C), self.u32(base + 0x10)
        parents = list(struct.unpack_from(f">{count}h", self.data_section.data, parents_at))
        names = []
        for index in range(bone_count):
            bone = self.global_pointer(bones_at + index * 4)
            name_at = self.data_local(bone) if bone is not None else None
            names.append(self.string_at(name_at) if name_at is not None else "")
        return {"name": self.string_at(self.data_local(base)), "bones": names, "parents": parents}


    def u16(self, offset):
        return struct.unpack_from(">H", self.data_section.data, offset)[0]

    def f32(self, offset):
        return struct.unpack_from(">f", self.data_section.data, offset)[0]

    def pointer(self, offset):
        """Follow a pointer slot; returns (section index, offset) or None."""
        target = self.data_pointer(offset)
        if target is not None:
            return target
        local = self.data_local(offset)
        if local is not None:
            return 2, local
        return None

    def string(self, offset):
        """Read a string referenced by a pointer slot."""
        target = self.pointer(offset)
        if target is None:
            return None
        section, at = target
        data = self.sections[section].data if section < 3 else self.classnames.data
        end = data.find(b"\0", at)
        if end < 0:
            return None
        return data[at:end].decode("utf-8", "replace")

    def array(self, offset):
        """hkArray: pointer, size, capacity (three words)."""
        target = self.pointer(offset)
        size = self.u32(offset + 4)
        if target is None:
            return []
        section, at = target
        return (section, at, size)
