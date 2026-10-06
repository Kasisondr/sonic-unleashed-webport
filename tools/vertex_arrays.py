"""Vectorized decoding of the disc's interleaved vertex attributes.

Keep endian/normalization conventions identical to mirage._component. Formats
not seen in exported terrain fall back to that scalar decoder.
"""
import numpy as np
from mirage import _component


def attribute(mesh, element, size, default):
    count, stride = mesh['vertex_count'], mesh['vertex_size']
    if element is None:
        return np.tile(np.asarray(default, dtype=np.float32), (count, 1))
    fmt, offset = element['format'], element['offset']
    if fmt.startswith('Float'):
        half = fmt.startswith('Float16')
        parts = 2 if half and fmt.endswith('_2') else 4 if half else int(fmt[5:])
        values = np.ndarray((count, parts), dtype='>f2' if half else '>f4', buffer=mesh['vertices'],
                            offset=offset, strides=(stride, 2 if half else 4)).astype(np.float32)
        return values[:, :size]
    if fmt in ('D3dColor', 'UByte4', 'UByte4Norm', 'Byte4', 'Byte4Norm'):
        signed = fmt.startswith('Byte')
        values = np.ndarray((count, 4), dtype='i1' if signed else 'u1', buffer=mesh['vertices'],
                            offset=offset, strides=(stride, 1)).astype(np.float32)
        if fmt != 'Byte4':
            values /= 127 if signed else 255
        return values[:, :size]
    if fmt in ('Hend3', 'Hend3Norm', 'Dhen3', 'Dhen3Norm', 'UHend3', 'Uhend3Norm', 'Udhen3', 'Udhen3Norm',
               'Dec3', 'Dec3Norm', 'UDec3', 'UDec3Norm'):
        raw = np.ndarray((count,), dtype='>u4', buffer=mesh['vertices'], offset=offset,
                         strides=(stride,)).astype(np.uint32)
        hend = 'hen' in fmt.lower()
        widths = (11,11,10) if hend else (10,10,10)
        shifts = (0,11,22) if hend else (0,10,20)
        signed = not fmt.startswith(('U','u'))
        result = []
        for bits, shift in zip(widths, shifts):
            values = ((raw >> shift) & ((1 << bits) - 1)).astype(np.int32)
            if signed:
                sign = 1 << (bits - 1)
                values = np.where(values & sign, values - (1 << bits), values)
                result.append(values / (sign - 1))
            else:
                result.append(values / (1023 if hend else ((1 << bits) - 1)))
        return np.stack(result, axis=1).astype(np.float32)[:, :size]
    return np.asarray([_component(mesh['vertices'][i*stride:(i+1)*stride], offset, fmt)[:size]
                       for i in range(count)], dtype=np.float32)
