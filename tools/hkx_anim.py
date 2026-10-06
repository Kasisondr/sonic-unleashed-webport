"""Decoder for the disc's spline-compressed Havok animations (``*.anm.hkx``).

The layout was derived from the disc's own class definitions and verified
against decoded values:

* each block opens with a four-byte mask per transform track (plus one byte per
  float track): a quantization byte, then one flag byte each for position,
  rotation and scale.  A position/scale flag byte marks components as static
  (bits 0-3) or spline-compressed (bits 4-7); the rotation byte marks a static
  low nibble or a spline-compressed high nibble;
* position and scale channels store either one float (static) or a NURBS spline:
  a 16-bit control point count, one skipped byte, the degree, the knot vector as
  bytes, per-component bounds and quantized control points;
* rotation channels store quantized quaternions (32/40/48-bit packs), or the
  uncompressed 16-byte form.

Sampling evaluates the NURBS basis with the byte knot vector, exactly like the
original block layout expects.
"""
import math
import struct

from hkx import Packfile

QT_8BIT, QT_16BIT, QT_32BIT, QT_40BIT, QT_48BIT, QT_24BIT, QT_16BIT_QUAT, QT_UNCOMPRESSED = range(8)
STATIC_X, STATIC_Y, STATIC_Z, STATIC_W, SPLINE_X, SPLINE_Y, SPLINE_Z, SPLINE_W = range(8)


class Block:
    """One animation block: masks plus per-track spline or static data."""

    def __init__(self, data, offset, tracks):
        self.data = data
        self.offset = offset
        self.tracks = tracks
        self.masks = [tuple(data[offset + i * 4:offset + i * 4 + 4]) for i in range(tracks)]
        cursor = offset + tracks * 4
        cursor = _align(cursor, 4)
        self.position, self.rotation, self.scale = [], [], []
        for mask in self.masks:
            quantization, pos_flags, rot_flags, scale_flags = mask
            self.position.append(_read_vector_track(self, cursor, quantization & 3, pos_flags, 0.0))
            cursor = self.position[-1]["end"]
            self.rotation.append(_read_rotation_track(self, cursor, (quantization >> 2) & 0xF, rot_flags))
            cursor = self.rotation[-1]["end"]
            self.scale.append(_read_vector_track(self, cursor, (quantization >> 6) & 3, scale_flags, 1.0))
            cursor = self.scale[-1]["end"]


def _align(offset, alignment):
    remainder = offset & (alignment - 1)
    return offset if not remainder else offset + alignment - remainder


def _component_kinds(flags, prefix):
    kinds = []
    for index in range(3):
        if flags & (1 << index):
            kinds.append("static")
        elif flags & (1 << (4 + index)):
            kinds.append("spline")
        else:
            kinds.append("identity")
    return kinds


def _read_vector_track(block, cursor, quantization, flags, default):
    kinds = _component_kinds(flags, None)
    if "spline" not in kinds:
        values = [default, default, default]
        for index, kind in enumerate(kinds):
            if kind == "static":
                values[index] = struct.unpack_from("<f", block.data, cursor)[0]
                cursor += 4
        return {"kind": "static", "values": values, "end": cursor}
    count = struct.unpack_from("<H", block.data, cursor)[0]
    cursor += 2
    degree = block.data[cursor]  # count and degree are byte-packed: three header bytes
    cursor += 1
    knot_count = count + degree + 2
    knots = list(block.data[cursor:cursor + knot_count])
    cursor += knot_count
    cursor = _align(cursor, 4)
    bounds, points = {}, {}
    for index, kind in enumerate(kinds):
        if kind == "spline":
            bounds[index] = struct.unpack_from("<2f", block.data, cursor)
            cursor += 8
        elif kind == "static":
            points[index] = [struct.unpack_from("<f", block.data, cursor)[0]]
            cursor += 4
    for component in range(3):
        if kinds[component] == "spline":
            points[component] = []
    for _ in range(count + 1):
        for index, kind in enumerate(kinds):
            if kind != "spline":
                continue
            if quantization == QT_8BIT:
                raw = block.data[cursor]
                cursor += 1
                fraction = raw / 255.0
            else:
                raw = struct.unpack_from("<H", block.data, cursor)[0]
                cursor += 2
                fraction = raw / 65535.0
            low, high = bounds[index]
            points[index].append(low + (high - low) * fraction)
    cursor = _align(cursor, 4)
    return {"kind": "spline", "degree": degree, "knots": knots, "count": count,
            "values": [points.get(i, [default]) for i in range(3)], "end": cursor}


def _read_rotation_track(block, cursor, quantization_code, flags):
    dynamic = bool(flags & 0xF0)
    static = bool(flags & 0x0F) and not dynamic
    if not dynamic and not static:
        return {"kind": "identity", "values": [(0.0, 0.0, 0.0, 1.0)], "end": cursor}
    quant = quantization_code + 2
    if not dynamic:
        value, cursor = _read_quaternion(block.data, cursor, quant)
        return {"kind": "static", "values": [value], "end": _align(cursor, 4)}
    count = struct.unpack_from("<H", block.data, cursor)[0]
    cursor += 2
    degree = block.data[cursor]
    cursor += 1
    knot_count = count + degree + 2
    knots = list(block.data[cursor:cursor + knot_count])
    cursor += knot_count
    if quant in (QT_48BIT, QT_16BIT_QUAT):
        cursor = _align(cursor, 2)
    elif quant in (QT_32BIT, QT_UNCOMPRESSED):
        cursor = _align(cursor, 4)
    values = []
    for _ in range(count + 1):
        value, cursor = _read_quaternion(block.data, cursor, quant)
        values.append(value)
    cursor = _align(cursor, 4)
    return {"kind": "spline", "degree": degree, "knots": knots, "count": count,
            "values": values, "end": cursor}


def _read_quaternion(data, cursor, quantization):
    if quantization == QT_32BIT:
        packed = struct.unpack_from("<I", data, cursor)[0]
        cursor += 4
        return _unpack_32(packed), cursor
    if quantization == QT_40BIT:
        chunk = data[cursor:cursor + 5].ljust(5, b"\0")
        packed = int.from_bytes(chunk, "little")
        cursor += 5
        return _unpack_40(packed), cursor
    if quantization == QT_48BIT:
        x, y, z = struct.unpack_from("<3h", data, cursor)
        cursor += 6
        return _unpack_48(x, y, z), cursor
    if quantization == QT_UNCOMPRESSED:
        value = struct.unpack_from("<4f", data, cursor)
        cursor += 16
        return value, cursor
    if quantization == QT_16BIT_QUAT:
        raw = struct.unpack_from("<4h", data, cursor)
        cursor += 8
        return tuple(component / 32767.0 for component in raw), cursor
    return (0.0, 0.0, 0.0, 1.0), cursor


def _place(stored, dropped, shift):
    """Place the reconstructed component in the slot the packing left out.

    The three stored components occupy the remaining slots in order; the
    dropped one is recovered from the unit-length constraint, because a
    quaternion packing never stores its largest component.
    """
    remaining = 1.0 - sum(value * value for value in stored)
    dropped *= math.sqrt(remaining) if remaining > 0.0 else 0.0
    iterator = iter(stored)
    return tuple(dropped if slot == shift else next(iterator) for slot in range(4))


def _unpack_32(packed):
    fraction = 1.0 / 1023.0
    r = ((packed >> 18) & 0x3FF) * fraction
    r = 1.0 - r * r
    phi_theta = float(packed & 0x3FFFF)
    phi = math.floor(math.sqrt(phi_theta))
    theta = (math.pi / 4.0) * (phi_theta - phi * phi) / phi if phi > 0.0 else 0.0
    phi = (math.pi / 2.0 / 511.0) * phi
    magnitude = math.sqrt(max(0.0, 1.0 - r * r))
    values = [math.sin(phi) * math.cos(theta) * magnitude,
              math.sin(phi) * math.sin(theta) * magnitude,
              math.cos(phi) * magnitude, r]
    for index, bit in enumerate((0x10000000, 0x20000000, 0x40000000, 0x80000000)):
        if packed & bit:
            values[index] = -values[index]
    return tuple(values)


def _unpack_40(packed):
    fraction = 0.000345436
    bias = (1 << 11) - 1
    stored = [((packed >> (12 * index)) & 0xFFF) - bias for index in range(3)]
    stored = [value * fraction for value in stored]
    sign = -1.0 if (packed >> 38) & 1 else 1.0
    shift = (packed >> 36) & 3
    return _place(stored, sign, shift)


def _unpack_48(x, y, z):
    fraction = 0.000043161
    bias = (1 << 14) - 1
    shift = ((y >> 14) & 2) | ((x >> 15) & 1)
    sign = -1.0 if z < 0 else 1.0
    stored = [((value & 0x7FFF) - bias) * fraction for value in (x, y, z)]
    return _place(stored, sign, shift)


def _knot_span(degree, value, control_points, knots):
    if value >= knots[control_points]:
        return control_points - 1
    low, high = degree, control_points
    mid = (low + high) // 2
    while value < knots[mid] or value >= knots[mid + 1]:
        if value < knots[mid]:
            high = mid
        else:
            low = mid
        mid = (low + high) // 2
    return mid


def _evaluate(degree, frame, knots, points):
    span = _knot_span(degree, frame, len(points), knots)
    basis = [1.0] + [0.0] * degree
    for index in range(1, degree + 1):
        for other in range(index - 1, -1, -1):
            denominator = knots[span + index - other] - knots[span - other]
            factor = (frame - knots[span - other]) / denominator if denominator else 0.0
            temporary = basis[other] * factor
            basis[other + 1] += basis[other] - temporary
            basis[other] = temporary
    return basis, span


def sample_vector(track, frame):
    if track["kind"] != "spline":
        values = track["values"]
        # A static track keeps one component per axis, an identity track its default.
        return [value[0] if isinstance(value, list) else value for value in values]
    values = []
    for component in range(3):
        points = track["values"][component]
        if len(points) == 1:
            values.append(points[0])
            continue
        basis, span = _evaluate(track["degree"], frame, track["knots"], points)
        total = 0.0
        for index in range(track["degree"] + 1):
            total += points[span - index] * basis[index]
        values.append(total)
    return values


def sample_quaternion(track, frame):
    if track["kind"] != "spline":
        return track["values"][0]
    points = track["values"]
    basis, span = _evaluate(track["degree"], frame, track["knots"], points)
    total = [0.0, 0.0, 0.0, 0.0]
    for index in range(track["degree"] + 1):
        point = points[span - index]
        for component in range(4):
            total[component] += point[component] * basis[index]
    length = math.sqrt(sum(component * component for component in total)) or 1.0
    return tuple(component / length for component in total)


class SplineAnimation:
    """One decoded ``hkaSplineSkeletalAnimation`` and its binding."""

    def __init__(self, packfile):
        self.packfile = packfile
        data = packfile.data_section.data
        base = next(offset for offset, name in packfile.classes.items()
                    if name == "hkaSplineSkeletalAnimation")
        self.base = base
        unpack = lambda fmt, at: struct.unpack_from(fmt, data, at)[0]
        self.duration = unpack(">f", base + 0x0C)
        self.track_count = unpack(">I", base + 0x10)
        self.num_frames = unpack(">I", base + 0x24)
        self.num_blocks = unpack(">I", base + 0x28)
        self.max_frames_per_block = unpack(">I", base + 0x2C)
        self.mask_size = unpack(">I", base + 0x30)
        self.block_duration = unpack(">f", base + 0x34)
        self.frame_duration = unpack(">f", base + 0x3C)
        self.block_offsets = self._array(base + 0x40)
        self.data_offset = packfile.data_local(base + 0x70)
        self.data_size = unpack(">I", base + 0x74)
        self.binding = self._read_binding()
        self.blocks = [Block(data, self.data_offset + offset, self.track_count)
                       for offset in self.block_offsets]

    def _array(self, offset):
        pointer = self.packfile.data_local(offset)
        size = struct.unpack_from(">I", self.packfile.data_section.data, offset + 4)[0]
        if not pointer or not size:
            return []
        return [struct.unpack_from(">I", self.packfile.data_section.data, pointer + i * 4)[0]
                for i in range(size)]

    def _read_binding(self):
        """The binding maps each transform track to a skeleton bone index."""
        for offset, name in self.packfile.classes.items():
            if name != "hkaAnimationBinding":
                continue
            data = self.packfile.data_section.data
            pointer = self.packfile.data_local(offset + 4)
            count = struct.unpack_from(">I", data, offset + 8)[0]
            if not pointer or not count:
                continue
            indices = struct.unpack_from(f">{count}H", data, pointer)
            return list(indices)
        return list(range(self.track_count))

    def block_for_frame(self, frame):
        """Which block holds a frame, and where inside it."""
        per_block = self.max_frames_per_block - 1 if self.max_frames_per_block > 1 else 1
        index = min(max(frame, 0), self.num_frames - 1) // per_block
        index = min(index, self.num_blocks - 1)
        return self.blocks[index], min(max(frame, 0), self.num_frames - 1) - index * per_block

    def sample(self, frame):
        """Decode every track at one frame, in skeleton bone order."""
        block, local = self.block_for_frame(frame)
        span = max(1, min(self.max_frames_per_block - 1, self.num_frames - 1))
        position, rotation, scale = [], [], []
        value = self._frame_value(local, span, None)
        for track in range(self.track_count):
            position.append(sample_vector(block.position[track], value))
            rotation.append(sample_quaternion(block.rotation[track], value))
            scale.append(sample_vector(block.scale[track], value))
        return position, rotation, scale

    @staticmethod
    def _frame_value(local, span, knots):
        """Knot vectors are byte values in frame units, so frames index them directly."""
        return min(float(local), float(span))


def load_animation(data):
    return SplineAnimation(Packfile(data))
