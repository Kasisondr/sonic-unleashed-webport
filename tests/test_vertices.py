import sys
import struct
import unittest
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from mirage import _component
from vertex_arrays import attribute
from prepare_stage import export_geometry, export_geometry_reference, parse_stage_info

class VertexTests(unittest.TestCase):
    def test_packed_normals_match_scalar_decoder(self):
        for fmt in ['Hend3Norm','Dhen3Norm','UHend3','Dec3Norm','UDec3Norm']:
            for value in [0,0xFFFFFFFF,0xFF801400,0x08112345]:
                mesh={'vertex_count':2,'vertex_size':4,'vertices':struct.pack('>2I',value,value)}
                decoded=attribute(mesh, {'format':fmt,'offset':0},3,(0,1,0))
                np.testing.assert_allclose(decoded[0],_component(mesh['vertices'],0,fmt),atol=1e-7)
    def test_diffuse_uses_uv_zero_with_transformed_geometry(self):
        vertices=b''.join(struct.pack('>3f2f2f',*p,*uv,99,99) for p,uv in
                           [((0,0,0),(0,0)),((1,0,0),(1,0)),((0,0,1),(0,1))])
        mesh={'vertices':vertices,'vertex_count':3,'vertex_size':28,'indices':[0,1,2],'slot':'Opaque',
              'elements':[{'type':'Position','usage':0,'format':'Float3','offset':0},
                          {'type':'TexCoord','usage':0,'format':'Float2','offset':12},
                          {'type':'TexCoord','usage':1,'format':'Float2','offset':20}]}
        transform=[[0,-1,0,3],[1,0,0,2],[0,0,1,1]]
        actual=export_geometry([mesh],transform,[0]);expected=export_geometry_reference([mesh],transform,[0])
        for i in range(5):np.testing.assert_allclose(actual[i],expected[i],atol=1e-6)
        np.testing.assert_array_equal(actual[1],[0,0,1,0,0,1])
        np.testing.assert_array_equal(actual[0],[3,2,1,3,3,1,3,2,2])
    def test_only_active_object_layers_are_selected_and_missing_yaw_defaults(self):
        xml=b'<Stage><Sonic><Position><x>1</x><y>2</y><z>3</z></Position></Sonic><SetData><Layer><FileName>Normal.set.xml</FileName><IsGameActive>true</IsGameActive></Layer><Layer><FileName>Hard.set.xml</FileName><IsGameActive>false</IsGameActive></Layer></SetData></Stage>'
        stage=parse_stage_info(xml)
        self.assertEqual(stage['activeSets'],['Normal.set.xml'])
        self.assertEqual(stage['yaw'],0)


class TopologyTests(unittest.TestCase):
    def test_single_strip_without_restart_keeps_every_triangle(self):
        from mirage import mesh_triangles
        mesh={'indices':[0,1,2,3,4], 'vertex_count':5}
        self.assertEqual(mesh_triangles(mesh),[(1,0,2),(1,2,3),(3,2,4)])
    def test_restarts_and_degenerate_stitches_preserve_winding(self):
        from mirage import mesh_triangles
        mesh={'indices':[0,1,2,2,3,4,65535,5,6,7], 'vertex_count':8}
        self.assertEqual(mesh_triangles(mesh),[(1,0,2),(2,3,4),(6,5,7)])
