import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from prepare_stage import parse_set_objects
from prepare_gameplay import routes

class GameplayData(unittest.TestCase):
    def test_quaternion_launch_settings_and_multiset_are_preserved(self):
        data=b'''<Set><JumpBoard><Position><x>1</x><y>2</y><z>3</z></Position>
        <Rotation><x>0</x><y>0.70710678</y><z>0</z><w>0.70710678</w></Rotation>
        <ImpulseSpeedOnNormal>57</ImpulseSpeedOnNormal><AngleType>15</AngleType>
        <MultiSetParam><Element><Position><x>4</x><y>5</y><z>6</z></Position></Element></MultiSetParam>
        </JumpBoard></Set>'''
        items=parse_set_objects(data,['JumpBoard'])['JumpBoard']
        self.assertEqual(len(items),2)
        self.assertAlmostEqual(items[0]['yaw'],90,places=3)
        self.assertEqual(items[1]['launch']['ImpulseSpeedOnNormal'],57)
        self.assertEqual(items[1]['position'],[4,5,6])

    def test_route_uses_world_transform_and_bezier_handles(self):
        data=b'''<SonicPath><library><geometry id="g"><spline><spline3d>
        <knot><point>0 0 0</point><invec>0 0 0</invec><outvec>0 3 -1</outvec></knot>
        <knot><point>0 0 -4</point><invec>0 3 -3</invec><outvec>0 0 -4</outvec></knot>
        </spline3d></spline></geometry></library><scene><node name="loop@SV">
        <translate>10 20 30</translate><instance url="#g"/></node></scene></SonicPath>'''
        route=routes(data)[0]
        self.assertEqual(route['points'][0],[10,20,30])
        self.assertEqual(route['points'][-1],[10,20,26])
        self.assertGreater(max(p[1] for p in route['points']),22)
