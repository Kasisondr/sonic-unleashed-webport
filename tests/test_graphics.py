"""Regression tests for Mirage graphics data, independent of private assets."""
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from mirage import FormatError, parse_light, parse_light_field, parse_material, parse_texture
from prepare_graphics import effect_parameters
from disc import read_archive_list


def resource(body, version=1):
    return struct.pack('>6I', len(body) + 24, version, len(body), 24, 0, 0) + bytes(body)


class GraphicsFormats(unittest.TestCase):
    def test_archive_names_follow_variable_split_count(self):
        for count in [0, 1, 2, 5, 11]:
            data = b'ARL2' + struct.pack('<I', count) + struct.pack('<' + str(count) + 'I', *([100] * count))
            data += b'\x08road.dds\x0blight.light'
            self.assertEqual(read_archive_list(data), ['road.dds', 'light.light'])

    def test_japanese_animation_name_does_not_abort_material_index(self):
        name='dfcn_appear0１.anm.hkx'.encode('shift_jis')
        data=b'ARL2'+struct.pack('<I',0)+bytes([len(name)])+name+b'\x08road.dds'
        self.assertEqual(read_archive_list(data),['dfcn_appear0１.anm.hkx','road.dds'])

    def test_named_material_tables_preserve_arrays_and_types(self):
        body = bytearray(36)
        def append(payload):
            at = len(body)
            body.extend(payload)
            return at
        def parameter(name, values, code):
            name_at = append(name.encode() + b'\0')
            value_at = append(b''.join(struct.pack('>' + code, *value) for value in values))
            return append(struct.pack('>4B2I', 2, 0, len(values), 0, name_at, value_at))
        float_at = parameter('specular', [[1.25, 0.5, 0.25, 0], [0, 1, 0, 1]], '4f')
        int_at = parameter('mask', [[-1, 2, 3, 4]], '4i')
        bool_at = parameter('enabled', [[0], [1]], 'I')
        tables = [append(struct.pack('>I', at)) for at in [float_at, int_at, bool_at]]
        struct.pack_into('>4B4B3I', body, 16, 128, 1, 0, 0, 1, 1, 1, 0, *tables)
        parsed = parse_material(resource(body))
        self.assertEqual(parsed['parameters']['float']['specular'], [[1.25, .5, .25, 0], [0, 1, 0, 1]])
        self.assertEqual(parsed['parameters']['int']['mask'], [[-1, 2, 3, 4]])
        self.assertEqual(parsed['parameters']['bool']['enabled'], [False, True])
        self.assertEqual(parsed['alpha'], 128)
        self.assertTrue(parsed['no_cull'])

    def test_light_ray_direction_and_point_inner_outer_range(self):
        directional = parse_light(resource(struct.pack('>I6f', 0, -.5, -.75, .25, 1.2, .8, .6)))
        self.assertEqual(directional['type'], 'directional')
        self.assertEqual(directional['direction'], [-.5, -.75, .25])
        self.assertGreater(directional['color'][0], 1)
        point = parse_light(resource(struct.pack('>I6fI4f', 1, 10, 20, 30, 1, 1, 1, 2, 0, 0, 5, 15)))
        self.assertEqual(point['position'], [10, 20, 30])
        self.assertEqual(point['range'][2:], [5, 15])

    def test_light_field_interleaved_bounds_and_unaligned_probe_bytes(self):
        # Probe stride is 25, not padded to a word. The following index table
        # may therefore start unaligned, as in original disc light-field data.
        body = bytearray(struct.pack('>6f6I', -10, 10, 0, 20, -30, 30, 1, 48, 1, 56, 8, 81))
        body += struct.pack('>2I', 3, 0) + bytes(range(25)) + struct.pack('>8I', *([0] * 8))
        parsed = parse_light_field(resource(body))
        self.assertEqual(parsed['bounds'], {'min': [-10, 0, -30], 'max': [10, 20, 30]})
        self.assertEqual(parsed['probeStride'], 25)
        self.assertEqual(parsed['indices']['offset'], 105)
        struct.pack_into('>I', body, 52, 1)
        with self.assertRaises(FormatError):
            parse_light_field(resource(body))

    def test_texture_keeps_uv_set_and_wrap_modes(self):
        body = struct.pack('>I4BI', 12, 1, 2, 1, 0, 16) + b'tex\0normal\0'
        parsed = parse_texture(resource(body))
        self.assertEqual(parsed['picture'], 'normal')
        self.assertEqual((parsed['texcoord'], parsed['wrap_u'], parsed['wrap_v']), (1, 2, 1))

    def test_effect_categories_do_not_overwrite_identically_named_fields(self):
        xml = b'<Effects><GI><Category><Basic><Param><Mode>0</Mode></Param></Basic><LightField><Param><Mode>1</Mode><enable>false</enable></Param></LightField></Category></GI></Effects>'
        parsed = effect_parameters(xml)
        self.assertEqual(parsed['GI']['Basic']['Mode'], 0)
        self.assertEqual(parsed['GI']['LightField']['Mode'], 1)
        self.assertIs(parsed['GI']['LightField']['enable'], False)


if __name__ == '__main__':
    unittest.main()
