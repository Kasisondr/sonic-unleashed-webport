"""Read the uncompressed Mirage AR entries used by the menu archives."""
import struct


def read_archive(data):
    if len(data) < 16 or struct.unpack_from("<4I", data) != (0, 16, 20, 64):
        raise ValueError("Unsupported Mirage AR header")
    entries = {}
    offset = 16
    while offset < len(data):
        if len(data) - offset < 20:
            raise ValueError("Truncated AR entry")
        size, data_size, data_offset, _, _ = struct.unpack_from("<5I", data, offset)
        if size < 20 or offset + size > len(data) or data_offset < 21 or data_offset + data_size > size:
            raise ValueError("Invalid AR entry bounds")
        name_data = data[offset + 20:offset + data_offset]
        if b"\0" not in name_data:
            raise ValueError("Unterminated AR name")
        name = name_data.split(b"\0", 1)[0].decode("ascii")
        if not name or "/" in name or "\\" in name or ".." in name or name in entries:
            raise ValueError("Unsafe or duplicate AR name")
        entries[name] = data[offset + data_offset:offset + data_offset + data_size]
        offset += size
    return entries
