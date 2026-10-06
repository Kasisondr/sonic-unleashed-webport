"""Readers for the uncompressed Hedgehog Engine containers used by the disc.

Formats follow the pinned upstream loaders and the MIT-licensed SharpNeedle
implementation of the "Mirage" archive, packed stage file, sample-chunk
resource, model and terrain-model layouts. No game data is embedded here.

Byte order: archives are little-endian. Sample-chunk resources declare their
own byte order; the 360 stage files are big-endian, while vertex buffers are
stored in the little-endian layout produced by the original exporter.
"""
import struct
from pathlib import Path
from subprocess import run

ROOT = Path(__file__).resolve().parents[1]
X_DECOMPRESS = ROOT / "build/host/x_decompress/x_decompress"
XCOMPRESS_MAGIC = b"\x0f\xf5\x12\xee"


class FormatError(ValueError):
    """Raised when a container does not match the documented layout."""


class Reader:
    """Big-endian reader whose offsets resolve against a pushed origin."""

    def __init__(self, data, origin=0):
        self.data = data
        self.origin = origin
        self.endian = ">"

    def u32(self, at):
        if at < 0 or at + 4 > len(self.data):
            raise FormatError("read outside resource")
        return struct.unpack_from(self.endian + "I", self.data, at)[0]

    def i32(self, at):
        value = self.u32(at)
        return value - 0x100000000 if value & 0x80000000 else value

    def u16(self, at):
        return struct.unpack_from(self.endian + "H", self.data, at)[0]

    def f32(self, at):
        return struct.unpack_from(self.endian + "f", self.data, at)[0]

    def ptr(self, at):
        """Resolve a 32-bit offset relative to the pushed origin."""
        value = self.u32(at)
        if value == 0:
            return 0
        target = self.origin + value
        if target > len(self.data):
            raise FormatError("offset outside resource")
        return target

    def string(self, at, limit=512):
        if not at:
            return None
        end = self.data.find(b"\0", at, min(at + limit, len(self.data)))
        if end < 0:
            raise FormatError("unterminated string")
        return self.data[at:end].decode("utf-8", "replace")

    def string_ptr(self, at):
        return self.string(self.ptr(at))

    def list(self, at):
        """BinaryList<BinaryPointer<T>>: count plus a table of element offsets."""
        count = self.i32(at)
        if count < 0 or count > 0x10000:
            raise FormatError(f"implausible list count {count}")
        table = self.ptr(at + 4)
        return [self.ptr(table + i * 4) for i in range(count)]


def read_ar(data):
    """Mirage AR archive. Entries may carry two extra hash words before the name."""
    if len(data) < 16:
        raise FormatError("truncated AR archive")
    if struct.unpack_from("<4I", data, 0)[:3] != (0, 16, 20):
        raise FormatError("unsupported AR header")
    entries, offset = {}, 16
    while offset + 20 <= len(data):
        size, data_size, data_offset, _, _ = struct.unpack_from("<5I", data, offset)
        if size == 0:
            break
        if size < 20 or offset + size > len(data) or data_offset < 21 or data_offset + data_size > size:
            raise FormatError("invalid AR entry bounds")
        name = data[offset + 20:offset + data_offset].split(b"\0", 1)[0].decode("ascii")
        if not name or "/" in name or "\\" in name or name in entries:
            raise FormatError(f"unsafe or duplicate AR name {name!r}")
        entries[name] = data[offset + data_offset:offset + data_offset + data_size]
        offset += size
    if offset != len(data):
        raise FormatError("AR entry table does not cover the archive")
    return entries


def read_packed_file(data):
    """Packed stage file ("PFD"): named, compressed payloads for one stage."""
    if len(data) < 16:
        raise FormatError("truncated packed file")
    header = struct.unpack_from("<4I", data, 0)
    if header[0] != 0 or header[1] != 16 or header[2] != 20:
        raise FormatError(f"unsupported packed header {header}")
    entries, offset = [], 16
    while offset + 20 <= len(data):
        size, data_size, data_offset, hash_a, hash_b = struct.unpack_from("<5I", data, offset)
        if size == 0:
            break
        if size < 20 or offset + size > len(data) or data_offset < 21 or data_offset + data_size > size:
            raise FormatError("invalid packed entry bounds")
        name = data[offset + 20:offset + data_offset].split(b"\0", 1)[0].decode("ascii")
        entries.append({"name": name, "offset": offset + data_offset, "size": data_size,
                        "hash_a": hash_a, "hash_b": hash_b})
        offset += size
    if offset != len(data):
        raise FormatError("packed entry table does not cover the file")
    return entries


def decompress(payload, workdir):
    """Run the pinned LZX helper over a payload already in memory."""
    if payload[:4] != XCOMPRESS_MAGIC:
        return payload
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    source = workdir / "chunk.bin"
    target = workdir / "chunk.raw"
    source.write_bytes(payload)
    result = run([str(X_DECOMPRESS), str(source), str(target)], capture_output=True, text=True)
    if result.returncode:
        raise FormatError(f"LZX decompression failed: {result.stderr[-300:]}")
    return target.read_bytes()


def sample_chunk_version(data):
    """Return (version, body origin) for a version-1 sample-chunk resource."""
    if len(data) < 16:
        raise FormatError("truncated resource")
    if struct.unpack_from(">I", data, 0)[0] & 0xE0000000:
        raise FormatError("version-2 sample-chunk resources are not supported here")
    size, version, body_size, body_offset = struct.unpack_from(">4I", data, 0)
    if size != len(data):
        raise FormatError(f"resource size mismatch: {size} != {len(data)}")
    if body_offset == 0 or body_size == 0 or body_offset + body_size > len(data):
        raise FormatError("invalid resource body bounds")
    return version, body_offset


VERTEX_FORMATS = {
    "Float1": (0x2C83A4, 1), "Float2": (0x2C23A5, 2), "Float3": (0x2A23B9, 3), "Float4": (0x1A23A6, 4),
    "Int1": (0x2C83A1, 1), "Int2": (0x2C23A2, 2), "Int4": (0x1A23A3, 4),
    "Uint1": (0x2C82A1, 1), "Uint2": (0x2C22A2, 2), "Uint4": (0x1A22A3, 4),
    "Int1Norm": (0x2C81A1, 1), "Int2Norm": (0x2C21A2, 2), "Int4Norm": (0x1A21A3, 4),
    "Uint1Norm": (0x2C80A1, 1), "Uint2Norm": (0x2C20A2, 2), "Uint4Norm": (0x1A20A3, 4),
    "D3dColor": (0x182886, 1), "UByte4": (0x1A2286, 4), "Byte4": (0x1A2386, 4),
    "UByte4Norm": (0x1A2086, 4), "Byte4Norm": (0x1A2186, 4),
    "Short2": (0x2C2359, 2), "Short4": (0x1A235A, 4), "Ushort2": (0x2C2259, 2), "Ushort4": (0x1A225A, 4),
    "Short2Norm": (0x2C2159, 2), "Short4Norm": (0x1A215A, 4),
    "Ushort2Norm": (0x2C2059, 2), "Ushort4Norm": (0x1A205A, 4),
    "UDec3": (0x2A2287, 3), "Dec3": (0x2A2387, 3), "UDec3Norm": (0x2A2087, 3), "Dec3Norm": (0x2A2187, 3),
    "UDec4": (0x1A2287, 4), "Dec4": (0x1A2387, 4), "UDec4Norm": (0x1A2087, 4), "Dec4Norm": (0x1A2187, 4),
    "UHend3": (0x2A2290, 3), "Hend3": (0x2A2390, 3), "Uhend3Norm": (0x2A2090, 3), "Hend3Norm": (0x2A2190, 3),
    "Udhen3": (0x2A2291, 3), "Dhen3": (0x2A2391, 3), "Udhen3Norm": (0x2A2091, 3), "Dhen3Norm": (0x2A2191, 3),
    "Float16_2": (0x2C235F, 2), "Float16_4": (0x1A2360, 4), "Invalid": (0xFFFFFFFF, 0),
}
FORMAT_BY_ID = {value[0]: (name, value[1]) for name, value in VERTEX_FORMATS.items()}

VERTEX_TYPES = ["Position", "BlendWeight", "BlendIndices", "Normal", "PSize", "TexCoord",
                "Tangent", "Binormal", "TessFactor", "PositionT", "Color", "Fog", "Depth", "Sample"]


def read_string_list(reader, at):
    """BinaryList of string offsets: count, then an array of string offsets."""
    count = reader.i32(at)
    if count < 0 or count > 0x10000:
        raise FormatError(f"implausible string list count {count}")
    table = reader.ptr(at + 4)
    return [reader.string(reader.ptr(table + index * 4)) for index in range(count)]


def read_vertex_elements(reader, at):
    """Vertex element descriptors terminated by the Invalid format."""
    elements, offset = [], at
    while offset + 12 <= len(reader.data):
        stream, data_offset, format_id = struct.unpack_from(">HHI", reader.data, offset)
        method, type_id, usage = struct.unpack_from(">BBB", reader.data, offset + 8)
        if format_id == 0xFFFFFFFF:
            break
        name, components = FORMAT_BY_ID.get(format_id, (None, 0))
        if name is None:
            raise FormatError(f"unknown vertex format {format_id:#x}")
        if stream != 0:
            raise FormatError("multi-stream vertex layout is not supported")
        elements.append({"offset": data_offset, "format": name, "components": components,
                         "type": VERTEX_TYPES[type_id] if type_id < len(VERTEX_TYPES) else str(type_id),
                         "usage": usage})
        offset += 12
    return elements


def _component(data, at, format_name):
    """Decode one vertex attribute. Vertex buffers keep the resource byte order."""
    if format_name.startswith("Float16"):
        count = 2 if format_name.endswith("_2") else 4
        values = struct.unpack_from(f">{count}e", data, at)
        return list(values)
    if format_name.startswith("Float"):
        count = int(format_name[5:])
        return list(struct.unpack_from(f">{count}f", data, at))
    if format_name in ("Hend3", "Hend3Norm", "Dhen3", "Dhen3Norm"):
        # Packed unit vectors: 11:11:10 signed, each field's sign bit is its top
        # bit (bits 10, 21 and 31 of the word). Verified against geometry.
        packed = struct.unpack_from(">I", data, at)[0]
        x, y, z = packed & 0x7FF, (packed >> 11) & 0x7FF, (packed >> 22) & 0x3FF
        return [_sign_extend(x, 0x400) / 1023.0, _sign_extend(y, 0x400) / 1023.0,
                _sign_extend(z, 0x200) / 511.0]
    if format_name in ("UHend3", "Uhend3Norm", "Udhen3", "Udhen3Norm"):
        packed = struct.unpack_from(">I", data, at)[0]
        return [(packed & 0x7FF) / 1023.0, ((packed >> 11) & 0x7FF) / 1023.0,
                ((packed >> 22) & 0x3FF) / 1023.0]
    if format_name in ("UDec3", "Dec3", "UDec3Norm", "Dec3Norm"):
        packed = struct.unpack_from(">I", data, at)[0]
        signed = format_name.startswith("Dec")
        values = []
        for shift in (0, 10, 20):
            raw = (packed >> shift) & 0x3FF
            if signed and raw & 0x200:
                raw -= 0x400
            values.append(raw / (511.0 if signed else 1023.0))
        return values
    if format_name in ("UDec4", "Dec4", "UDec4Norm", "Dec4Norm"):
        packed = struct.unpack_from(">I", data, at)[0]
        signed = format_name.startswith("Dec")
        values = []
        for shift in (0, 10, 20, 30):
            raw = (packed >> shift) & 0x3FF if shift < 30 else (packed >> 30) & 0x3
            if signed and raw & 0x200:
                raw -= 0x400
            values.append(raw / (511.0 if signed else 1023.0))
        return values
    if format_name in ("D3dColor", "UByte4", "UByte4Norm"):
        values = list(struct.unpack_from(">4B", data, at))
        return [value / 255.0 for value in values]
    if format_name == "Byte4":
        return list(struct.unpack_from(">4b", data, at))
    if format_name == "Byte4Norm":
        return [value / 127.0 for value in struct.unpack_from(">4b", data, at)]
    if format_name in ("Short2", "Short4", "Ushort2", "Ushort4"):
        count = int(format_name[-1])
        code = "h" if format_name.startswith("Short") else "H"
        return list(struct.unpack_from(f">{count}{code}", data, at))
    if format_name in ("Short2Norm", "Short4Norm", "Ushort2Norm", "Ushort4Norm"):
        count = int(format_name[5])
        signed = not format_name.startswith("U")
        code = "h" if signed else "H"
        divisor = 32767.0 if signed else 65535.0
        return [value / divisor for value in struct.unpack_from(f">{count}{code}", data, at)]
    if format_name in ("Uint1", "Uint2", "Uint4", "Uint1Norm", "Uint2Norm", "Uint4Norm"):
        count = int(format_name[4])
        values = list(struct.unpack_from(f">{count}I", data, at))
        if format_name.endswith("Norm"):
            return [value / 4294967295.0 for value in values]
        return values
    if format_name in ("Int1", "Int2", "Int4", "Int1Norm", "Int2Norm", "Int4Norm"):
        count = int(format_name[3])
        values = list(struct.unpack_from(f">{count}i", data, at))
        if format_name.endswith("Norm"):
            return [value / 2147483647.0 for value in values]
        return values
    raise FormatError(f"unsupported vertex format {format_name}")


def _sign_extend(value, mask):
    return value - (mask << 1) if value & mask else value


def cut_present(indices, cut=0xFFFF):
    return any(value == cut for value in indices)


def mesh_strip_runs(indices, cut=0xFFFF):
    """Split an index buffer into triangle-strip runs at 0xFFFF cut markers."""
    runs, current = [], []
    for value in indices:
        if value == cut:
            if current:
                runs.append(current)
                current = []
        else:
            current.append(value)
    if current:
        runs.append(current)
    return runs


def mesh_triangles(mesh):
    """Expand a mesh's strips into a triangle list with one winding order.

    Terrain and object meshes store D3DPT_TRIANGLESTRIP runs separated by
    0xFFFF; every second triangle is reversed so the whole list winds the same
    way. Which triangle needs reversing was checked against the stored per-
    vertex normals (mean agreement 0.90 for this convention).
    """
    indices = mesh["indices"]
    vertex_count = mesh["vertex_count"]
    triangles = []
    # Version-1 Mirage models on this disc default to triangle strips,
    # including meshes containing just one strip with no restart marker.
    # HedgeLib model::get_topology_type uses strips when no Topology property
    # exists (6b51064d80174516cf50a4146e1f561c28c2b381).
    for run in mesh_strip_runs(indices):
        for i in range(len(run) - 2):
            a, b, c = run[i], run[i + 1], run[i + 2]
            if a == b or b == c or a == c:
                continue
            triangles.append((b, a, c) if i % 2 == 0 else (a, b, c))
    return [triangle for triangle in triangles if max(triangle) < vertex_count]


def read_mesh(reader, at):
    """Mesh: material name, index buffer, vertex buffer, elements and textures."""
    material = reader.string_ptr(at)
    index_count = reader.i32(at + 4)
    indices_at = reader.ptr(at + 8)
    vertex_count = reader.u32(at + 12)
    vertex_size = reader.u32(at + 16)
    vertices_at = reader.ptr(at + 20)
    elements_at = reader.ptr(at + 24)
    if index_count < 0 or index_count > 0x2000000 or vertex_count > 0x800000:
        raise FormatError("implausible mesh counts")
    if indices_at + index_count * 2 > len(reader.data) or vertices_at + vertex_count * vertex_size > len(reader.data):
        raise FormatError("mesh buffers outside resource")
    indices = list(struct.unpack_from(f">{index_count}H", reader.data, indices_at))
    vertices = reader.data[vertices_at:vertices_at + vertex_count * vertex_size]
    elements = read_vertex_elements(reader, elements_at)
    # Bone table: a count plus byte-sized skeleton node indices. Vertex blend
    # indices are slots into this table, which the eye meshes show as node 27
    # ("Model_EyeBoard"). Texture units follow as a BinaryList of usages.
    try:
        bone_count = reader.i32(at + 28)
        bone_at = reader.ptr(at + 32)
        bone_indices = (list(reader.data[bone_at:bone_at + bone_count])
                        if 0 <= bone_count <= 0x1000 and bone_at else [])
    except FormatError:
        bone_indices = []
    texture_units = []
    for unit_at in reader.list(at + 36):
        texture_units.append({"name": reader.string_ptr(unit_at), "index": reader.data[unit_at + 4]})
    return {"material": material, "indices": indices, "vertex_count": vertex_count,
            "vertex_size": vertex_size, "vertices": vertices, "elements": elements,
            "bone_indices": bone_indices, "textures": texture_units}


def read_mesh_group(reader, at, version=5):
    """Mesh group: opaque, transparent, punch-through and named special meshes."""
    group = {"name": None, "meshes": []}
    for index, slot in enumerate(("Opaque", "Transparent", "PunchThrough")):
        for mesh_at in reader.list(at + index * 8):
            mesh = read_mesh(reader, mesh_at)
            mesh["slot"] = slot
            group["meshes"].append(mesh)
    if version < 5:
        return group
    special_count = reader.i32(at + 24)
    if special_count < 0 or special_count > 0x1000:
        raise FormatError("implausible special mesh count")
    if special_count:
        names_at, counts_at, tables_at = reader.ptr(at + 28), reader.ptr(at + 32), reader.ptr(at + 36)
        for index in range(special_count):
            count = reader.i32(reader.ptr(counts_at + index * 4))
            table = reader.ptr(tables_at + index * 4)
            if count < 0 or count > 0x1000:
                raise FormatError("implausible special slot count")
            slot = reader.string(reader.ptr(names_at + index * 4)) or "Special"
            for entry in range(count):
                mesh = read_mesh(reader, reader.ptr(table + entry * 4))
                mesh["slot"] = slot
                group["meshes"].append(mesh)
    group["name"] = reader.string(at + 40)
    return group


def read_model_groups(reader, version, at):
    if version >= 5:
        return [read_mesh_group(reader, group_at, version) for group_at in reader.list(at)]
    if 0 <= version < 5:
        return [read_mesh_group(reader, at, version)]
    raise FormatError(f"unsupported model version {version}")


def parse_terrain_model(data):
    """Parse a .terrain-model resource into groups of meshes."""
    version, origin = sample_chunk_version(data)
    reader = Reader(data, origin)
    groups = read_model_groups(reader, version, origin)
    name = reader.string_ptr(origin + 8) if version >= 5 else None
    flags = reader.u32(origin + 12) if version >= 5 else 0
    return {"version": version, "name": name, "flags": flags, "groups": groups}


def parse_model(data):
    """Parse a .model resource: mesh groups plus skeleton nodes and bounds."""
    version, origin = sample_chunk_version(data)
    reader = Reader(data, origin)
    groups = read_model_groups(reader, version, origin)
    group_bytes = 8 if version >= 5 else 24
    morphs = reader.list(origin + group_bytes) if version >= 4 else []
    node_table = origin + group_bytes + (8 if version >= 4 else 0)
    node_count = reader.i32(node_table)
    nodes_at = reader.ptr(node_table + 4)
    nodes = []
    for index in range(node_count):
        node_at = reader.ptr(nodes_at + index * 4)
        nodes.append({"parent": reader.i32(node_at), "name": reader.string_ptr(node_at + 4)})
    transforms_at = reader.ptr(node_table + 8)
    transforms = []
    for index in range(node_count):
        at = transforms_at + index * 64
        if at + 64 > len(reader.data):
            break
        values = struct.unpack_from(">16f", reader.data, at)
        transforms.append([list(values[row * 4:row * 4 + 4]) for row in range(4)])
    bounds_at = reader.ptr(node_table + 12) if version >= 2 else 0
    bounds = None
    if bounds_at:
        center = list(struct.unpack_from(">3f", reader.data, bounds_at))
        extents = list(struct.unpack_from(">3f", reader.data, bounds_at + 12))
        bounds = {"center": center, "extents": extents}
    return {"version": version, "groups": groups, "morph_count": len(morphs), "nodes": nodes,
            "transforms": transforms, "bounds": bounds}


def parse_material(data):
    """Material, including named shader constants in the original resource.

    The parameter table is a table of offsets, not an inline array. Float and
    integer entries contain four-component values; bool entries contain u32s.
    Layout follows HedgeLib raw_material_v1/v2 and SharpNeedle MaterialParameter.
    """
    version, origin = sample_chunk_version(data)
    reader = Reader(data, origin)
    if version >= 3:
        raise FormatError("unexpected modern material layout on this title")
    shader = reader.string_ptr(origin)
    texset = reader.string_ptr(origin + 8)
    alpha = data[origin + 16]
    no_cull = data[origin + 17]
    blend = data[origin + 18]
    parameters = {}
    for kind, count_at, table_at, width, code in (("float", 20, 24, 16, "4f"),
                                                ("int", 21, 28, 16, "4i"),
                                                ("bool", 22, 32, 4, "I")):
        count = data[origin + count_at]
        table = reader.ptr(origin + table_at)
        if count and not table:
            raise FormatError("material parameter table missing")
        values = {}
        for index in range(count):
            entry = reader.ptr(table + index * 4)
            value_count = data[entry + 2]
            name = reader.string_ptr(entry + 4)
            value_at = reader.ptr(entry + 8)
            if value_count and (not value_at or value_at + value_count * width > len(data)):
                raise FormatError("material values outside resource")
            parsed = [list(struct.unpack_from(">" + code, data, value_at + i * width))
                      for i in range(value_count)]
            values[name] = [bool(value[0]) for value in parsed] if kind == "bool" else parsed
        parameters[kind] = values
    return {"version": version, "shader": shader, "texset": texset,
            "alpha": alpha, "no_cull": bool(no_cull), "blend": blend,
            "parameters": parameters}


def parse_texset(data):
    """Texset resource: names of the texture resources used by a material."""
    version, origin = sample_chunk_version(data)
    reader = Reader(data, origin)
    return {"version": version, "textures": read_string_list(reader, origin)}


def parse_texture(data):
    """Texture resource: picture name plus its usage kind (diffuse, normal, ...)."""
    version, origin = sample_chunk_version(data)
    reader = Reader(data, origin)
    return {"version": version, "name": reader.string_ptr(origin),
            "picture": reader.string_ptr(origin + 8), "texcoord": data[origin + 4],
            "wrap_u": data[origin + 5], "wrap_v": data[origin + 6]}


def parse_light(data):
    """Original Mirage light: directional ray vector or point position/range."""
    version, origin = sample_chunk_version(data)
    if version not in (0, 1):
        raise FormatError(f"unsupported light version {version}")
    reader = Reader(data, origin)
    kind = reader.u32(origin)
    if kind not in (0, 1):
        raise FormatError(f"unknown light type {kind}")
    vector = list(struct.unpack_from(">3f", data, origin + 4))
    color = list(struct.unpack_from(">3f", data, origin + 16))
    result = {"type": "directional" if kind == 0 else "point", "color": color,
              "direction" if kind == 0 else "position": vector}
    if kind == 1:
        if version == 0 or origin + 48 > len(data):
            raise FormatError("point light missing range")
        result.update(attribute=reader.u32(origin + 28),
                      range=list(struct.unpack_from(">4f", data, origin + 32)))
    return result


def parse_light_field(data):
    """Validate original LFT tree and return offsets for browser CPU sampling.

    Bounds are interleaved min/max by axis. Internal cells split their bounds
    at the midpoint on X/Y/Z, and reference adjacent lower/upper children.
    Probe leaves index eight entries in the probe-index table. Each probe has
    eight RGB direction octants and, in version 1, an occlusion byte.
    """
    version, origin = sample_chunk_version(data)
    if version not in (0, 1):
        raise FormatError(f"unsupported light field version {version}")
    reader = Reader(data, origin)
    bound = list(struct.unpack_from(">6f", data, origin))
    info = {"version": version, "bounds": {"min": bound[::2], "max": bound[1::2]},
            "byteOrder": "big", "probeStride": 25 if version else 24,
            "colorEncoding": "sqrt-linear-unorm8", "cornerBits": [4, 2, 1]}
    for name, at, width in (("cells", origin + 24, 8), ("probes", origin + 32, info["probeStride"]),
                            ("indices", origin + 40, 4)):
        count, offset = reader.u32(at), reader.ptr(at + 4)
        if count and (not offset or offset + count * width > len(data)):
            raise FormatError(f"light field {name} outside resource")
        info[name] = {"count": count, "offset": offset}
    for index in range(info["cells"]["count"]):
        kind, target = struct.unpack_from(">2I", data, info["cells"]["offset"] + index * 8)
        if kind > 3 or (kind == 3 and target + 8 > info["indices"]["count"]) or (
                kind < 3 and target + 2 > info["cells"]["count"]):
            raise FormatError("light field cell references outside tree")
    for index in range(info["indices"]["count"]):
        if reader.u32(info["indices"]["offset"] + index * 4) >= info["probes"]["count"]:
            raise FormatError("light field probe index outside table")
    return info


def read_terrain_instance_info(data):
    """Parse a .terrain-instanceinfo resource: model name, instance name, transform."""
    version, origin = sample_chunk_version(data)
    reader = Reader(data, origin)
    model_name = reader.string_ptr(origin)
    matrix_at = reader.ptr(origin + 4)
    if not matrix_at or matrix_at + 64 > len(data):
        raise FormatError("instance transform outside resource")
    matrix = [list(struct.unpack_from(">4f", data, matrix_at + row * 16)) for row in range(4)]
    instance_name = reader.string_ptr(origin + 8)
    return {"version": version, "model": model_name, "name": instance_name, "matrix": matrix}
