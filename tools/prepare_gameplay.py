#!/usr/bin/env python3
"""Refresh source launch settings and guided routes without re-exporting terrain."""
import argparse
import json
import math
from pathlib import Path
from xml.etree import ElementTree as ET
from disc import Disc
from prepare_stage import parse_set_objects, parse_stage_info, SET_OBJECTS

ROOT=Path(__file__).resolve().parents[1]

def rotate(v,q):
    length=math.sqrt(sum(x*x for x in q)) or 1
    x,y,z,w=[x/length for x in q]
    t=[2*(y*v[2]-z*v[1]),2*(z*v[0]-x*v[2]),2*(x*v[1]-y*v[0])]
    return [v[0]+w*t[0]+y*t[2]-z*t[1],v[1]+w*t[1]+z*t[0]-x*t[2],v[2]+w*t[2]+x*t[1]-y*t[0]]

def routes(payload):
    root=ET.fromstring(payload)
    geometry={g.get('id'):g for g in root.findall('./library/geometry')}
    result=[]
    for node in root.findall('./scene/node'):
        if '@SV' not in node.get('name',''):
            continue
        g=geometry.get(node.find('instance').get('url').lstrip('#'))
        splines=g.findall('./spline/spline3d')
        translation=[float(v) for v in node.findtext('translate','0 0 0').split()]
        rotation=[float(v) for v in node.findtext('rotate','0 0 0 1').split()]
        scale=[float(v) for v in node.findtext('scale','1 1 1').split()]
        def point(knot,key):
            return [float(v) for v in knot.findtext(key).split()]
        # These SV files store the left and right edge of the same route.
        edges=[s.findall('knot') for s in splines]
        if not edges or any(len(e)!=len(edges[0]) for e in edges):
            continue
        knots=[]
        for i in range(len(edges[0])):
            knots.append({key:[sum(point(e[i],key)[a] for e in edges)/len(edges) for a in range(3)]
                          for key in ('point','invec','outvec')})
        samples=[]
        for a,b in zip(knots,knots[1:]):
            control=[a['point'],a['outvec'],b['invec'],b['point']]
            length=sum(math.dist(x,y) for x,y in zip(control,control[1:]))
            count=max(1,math.ceil(length/.5))
            for step in range(count):
                t=step/count;u=1-t
                samples.append([u**3*control[0][axis]+3*u*u*t*control[1][axis]+3*u*t*t*control[2][axis]+t**3*control[3][axis] for axis in range(3)])
        if knots:
            samples.append(knots[-1]['point'])
        points=[]
        for p in samples:
            world=rotate([p[i]*scale[i] for i in range(3)],rotation)
            world=[round(world[i]+translation[i],4) for i in range(3)]
            if not points or math.dist(world,points[-1])>.01:
                points.append(world)
        if len(points)>1:
            result.append({'id':node.get('name'),'points':points,'source':'original SV Bezier centreline'})
    return result

def enrich(entries,manifest):
    active=parse_stage_info(entries['Stage.stg.xml'])['activeSets']
    # Preserve runtime additions and original rings/goals; replace only launchers.
    launchers=[]
    for name,data in entries.items():
        if not name.endswith('.set.xml') or (active and name not in active):
            continue
        for tag,items in parse_set_objects(data,tuple(SET_OBJECTS)).items():
            if SET_OBJECTS[tag] not in ('spring','dashpanel','jumpboard'):
                continue
            for item in items:
                launchers.append({'kind':SET_OBJECTS[tag],'element':tag,'set':name,**item})
    # Keep object indices stable for existing collected-object browser saves.
    for obj in manifest['objects']:
        if obj['kind'] not in ('spring','dashpanel','jumpboard'):
            continue
        replacement=next((o for o in launchers if o['kind']==obj['kind'] and math.dist(o['position'],obj['position'])<.01),None)
        if replacement:
            obj.update(replacement);launchers.remove(replacement)
    manifest['objects'].extend(launchers)
    manifest['guidedRoutes']=[]
    for name,data in entries.items():
        if name.endswith('.path.xml'):
            manifest['guidedRoutes'].extend(routes(data))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('iso',type=Path)
    parser.add_argument('--stage',action='append')
    args=parser.parse_args();disc=Disc(args.iso)
    catalog=json.loads((ROOT/'dist/probe/game/catalog.json').read_text())
    for entry in catalog['scenes']:
        if args.stage and entry['id'] not in args.stage:
            continue
        file=ROOT/'dist/probe'/entry['manifest'];manifest=json.loads(file.read_text())
        enrich(disc.open_hashed_archive(entry['id']),manifest)
        file.write_text(json.dumps(manifest,allow_nan=False))
        print(entry['id'],len(manifest['guidedRoutes']),'routes')
