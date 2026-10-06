#!/usr/bin/env python3
"""Extract goal/checkpoint/enemy/mode-trigger definitions and build rich data-driven missions.

Extracts real active set elements from the original Sonic Unleashed disc archives:
- GoalRing -> goals
- PointMarker -> checkpoints
- FallDeadCollision -> death planes
- eFighter*, eAir*, eSpinner* -> enemy encounters
- ChangeMode_3Dto2D / ChangeMode_3DtoForward -> 2D/3D mode triggers
- ScoreRank -> rank thresholds

Generates primary act missions and extra mission variations (Time Attack, Ring Attack,
Robot Hunt, Survival Challenge) with browser-defined progression and scoring.
These extra challenges, fallback thresholds and bonus rates are not extracted
original missions or the original game's complete progression/ranking rules.
"""
import argparse
import json
from pathlib import Path
from xml.etree import ElementTree as ET

from disc import Disc

ROOT = Path(__file__).resolve().parents[1]

# Browser stage sequence; the original storyline's unlock graph is not ported.
DAYTIME_PROGRESSION = [
    'ActD_MykonosAct1',
    'ActD_Africa',
    'ActD_EU',
    'ActD_China',
    'ActD_Beach',
    'ActD_NY',
    'ActD_Snow',
    'ActD_Petra',
    'ActD_MykonosAct2',
]

DEFAULT_RANKS = {
    'ActD_MykonosAct1': {'S': 70000, 'A': 55000, 'B': 40000, 'C': 25000, 'D': 10000, 'E': 0},
    'ActD_Africa': {'S': 100000, 'A': 80000, 'B': 60000, 'C': 40000, 'D': 20000, 'E': 0},
    'ActD_EU': {'S': 120000, 'A': 100000, 'B': 80000, 'C': 60000, 'D': 40000, 'E': 0},
    'ActD_China': {'S': 120000, 'A': 100000, 'B': 80000, 'C': 60000, 'D': 40000, 'E': 0},
    'ActD_Beach': {'S': 140000, 'A': 110000, 'B': 85000, 'C': 60000, 'D': 35000, 'E': 0},
    'ActD_NY': {'S': 110000, 'A': 90000, 'B': 70000, 'C': 50000, 'D': 30000, 'E': 0},
    'ActD_Snow': {'S': 115000, 'A': 92000, 'B': 72000, 'C': 52000, 'D': 32000, 'E': 0},
    'ActD_Petra': {'S': 200000, 'A': 180000, 'B': 150000, 'C': 100000, 'D': 60000, 'E': 0},
    'ActD_MykonosAct2': {'S': 120000, 'A': 100000, 'B': 80000, 'C': 60000, 'D': 40000, 'E': 0},
    'ActD_SubMykonos_01': {'S': 80000, 'A': 60000, 'B': 45000, 'C': 30000, 'D': 15000, 'E': 0},
    'ActD_SubAfrica_01': {'S': 80000, 'A': 60000, 'B': 45000, 'C': 30000, 'D': 15000, 'E': 0},
    'ActD_SubEU_01': {'S': 85000, 'A': 65000, 'B': 50000, 'C': 35000, 'D': 15000, 'E': 0},
    'ActD_SubChina_04': {'S': 90000, 'A': 70000, 'B': 50000, 'C': 35000, 'D': 15000, 'E': 0},
    'ActD_SubBeach_04': {'S': 95000, 'A': 75000, 'B': 55000, 'C': 35000, 'D': 15000, 'E': 0},
    'ActD_SubNY_01': {'S': 85000, 'A': 65000, 'B': 50000, 'C': 35000, 'D': 15000, 'E': 0},
}

DEFAULT_PAR_TIMES = {
    'ActD_MykonosAct1': 150,
    'ActD_Africa': 240,
    'ActD_EU': 270,
    'ActD_China': 300,
    'ActD_Beach': 330,
    'ActD_NY': 240,
    'ActD_Snow': 260,
    'ActD_Petra': 320,
    'ActD_MykonosAct2': 280,
    'ActD_SubMykonos_01': 120,
    'ActD_SubAfrica_01': 140,
    'ActD_SubEU_01': 150,
    'ActD_SubChina_04': 160,
    'ActD_SubBeach_04': 180,
    'ActD_SubNY_01': 140,
}


def vector(node, name, axes=('x', 'y', 'z')):
    element = node.find(name)
    return [float(element.findtext(axis) or 0) for axis in axes] if element is not None else None


def extract(stage, entries, manifest):
    root = ET.fromstring(entries['Stage.stg.xml'])
    active = {layer.findtext('FileName') for layer in root.findall('SetData/Layer')
              if (layer.findtext('IsGameActive') or 'true').lower() == 'true'}
    goals, checkpoints, planes, enemies, mode_triggers = [], [], [], [], []

    for filename, payload in sorted(entries.items()):
        if not filename.endswith('.set.xml') or (active and filename not in active):
            continue
        for node in ET.fromstring(payload):
            tag = node.tag
            position = vector(node, 'Position')
            if not position:
                continue
            set_id = node.findtext('SetObjectID') or '0'
            rotation = vector(node, 'Rotation', ('x', 'y', 'z', 'w')) or [0, 0, 0, 1]
            item = {'id': f"{filename}:{set_id}", 'position': position,
                    'rotation': rotation,
                    'source': {'file': filename, 'element': tag, 'setObjectID': set_id}}

            if tag == 'GoalRing':
                item['radius'] = 2.6 + float(node.findtext('AddRange') or 0)
                item['height'] = 3.0
                item['resultPosition'] = vector(node, 'ResultPosition')
                item['objectIndex'] = next((i for i, obj in enumerate(manifest.get('objects', []))
                                           if obj.get('kind') == 'goal' and all(abs(a-b) < .002 for a,b in zip(obj['position'], position))), None)
                goals.append(item)
            elif tag == 'PointMarker':
                item['width'] = float(node.findtext('Width') or 2.5)
                item['trigger'] = {'type': 'cylinder', 'position': position,
                                   'radius': item['width'], 'height': 3.5,
                                   'collisionImplementation': 'browser-proximity'}
                checkpoints.append(item)
            elif tag == 'FallDeadCollision':
                item['trigger'] = {'type': 'plane', 'position': position, 'rotation': rotation,
                                   'size': [float(node.findtext('Collision_Width') or 0),
                                            float(node.findtext('Collision_Height') or 0)]}
                planes.append(item)
            elif tag.startswith(('eFighter', 'eAir', 'eSpinner', 'eThunderBall', 'eShooter', 'eMoleCannon')):
                item['name'] = set_id
                item['element'] = tag
                item['groupId'] = f"arena_{len(enemies)//3}"
                enemies.append(item)
            elif 'ChangeMode' in tag:
                item['mode'] = '2D' if '2D' in tag else '3D'
                item['changeCamera'] = (node.findtext('m_IsChangeCamera') or 'true').lower() == 'true'
                width = float(node.findtext('Collision_Width') or 10)
                height = float(node.findtext('Collision_Height') or 10)
                item['trigger'] = {'type': 'plane', 'position': position, 'rotation': rotation,
                                   'size': [width, height]}
                mode_triggers.append(item)

    rank = root.find('ScoreRank')
    rank_thresholds = {node.tag: float(node.text) for node in rank} if rank is not None else DEFAULT_RANKS.get(stage)
    par_time = DEFAULT_PAR_TIMES.get(stage, 180)

    # Determine progression link
    next_stage = None
    if stage in DAYTIME_PROGRESSION:
        idx = DAYTIME_PROGRESSION.index(stage)
        if idx + 1 < len(DAYTIME_PROGRESSION):
            next_stage = DAYTIME_PROGRESSION[idx + 1]

    has_goals = bool(goals)
    lives = 3 if has_goals else None
    ranking_available = bool(rank_thresholds) and has_goals

    result_rules = {
        'rankThresholds': rank_thresholds,
        'parTime': par_time,
        'timeBonusRate': 250,
        'ringBonusMultiplier': 100,
        'enemyBonusMultiplier': 500,
        'deathPenalty': 10000,
        'rankingAvailable': ranking_available,
        'reason': '' if ranking_available else 'Exploration scene or ranking unavailable.',
    }

    primary = {
        'id': stage,
        'stage': stage,
        'title': manifest.get('title', stage),
        'missionTitle': 'Daytime Stage' if has_goals else 'Exploration',
        'spawn': manifest.get('browserSpawn') or manifest['spawn'],
        'yaw': manifest['yaw'],
        'objective': {'type': 'reach_goal', 'text': 'Reach the goal ring'} if has_goals else
                     {'type': 'explore', 'text': 'Explore the stage'},
        'lives': lives,
        'goals': goals,
        'checkpoints': checkpoints,
        'deathPlanes': planes,
        'enemies': enemies,
        'modeTriggers': mode_triggers,
        'resultRules': result_rules,
        'nextMission': next_stage,
        'source': {'structure': f'#{stage}.ar.00', 'activeSets': sorted(active)},
        'limitations': []
    }

    # Build extra mission variants for Windmill Isle Act 1
    extra_missions = []
    if stage == 'ActD_MykonosAct1':
        extra_missions = [
            {
                'id': 'ActD_MykonosAct1_time',
                'stage': stage,
                'title': manifest.get('title', stage),
                'missionTitle': 'Time Attack',
                'spawn': primary['spawn'],
                'yaw': primary['yaw'],
                'objective': {'type': 'time_trial', 'text': 'Reach the goal ring before time runs out', 'limit': 120},
                'lives': 3,
                'goals': goals,
                'checkpoints': checkpoints,
                'deathPlanes': planes,
                'enemies': enemies,
                'modeTriggers': mode_triggers,
                'resultRules': dict(result_rules, parTime=100),
                'nextMission': 'ActD_MykonosAct1_rings',
            },
            {
                'id': 'ActD_MykonosAct1_rings',
                'stage': stage,
                'title': manifest.get('title', stage),
                'missionTitle': 'Ring Collector',
                'spawn': primary['spawn'],
                'yaw': primary['yaw'],
                'objective': {'type': 'collect', 'text': 'Collect 50 Rings', 'targetCount': 50},
                'lives': 3,
                'goals': goals,
                'checkpoints': checkpoints,
                'deathPlanes': planes,
                'enemies': enemies,
                'modeTriggers': mode_triggers,
                'resultRules': dict(result_rules, parTime=140),
                'nextMission': 'ActD_MykonosAct1_defeat',
            },
            {
                'id': 'ActD_MykonosAct1_defeat',
                'stage': stage,
                'title': manifest.get('title', stage),
                'missionTitle': 'Robot Hunt',
                'spawn': primary['spawn'],
                'yaw': primary['yaw'],
                'objective': {'type': 'defeat', 'text': 'Defeat 7 Egg Fighters', 'targetCount': 7},
                'lives': 3,
                'goals': goals,
                'checkpoints': checkpoints,
                'deathPlanes': planes,
                'enemies': enemies,
                'modeTriggers': mode_triggers,
                'resultRules': dict(result_rules, parTime=160),
                'nextMission': 'ActD_MykonosAct1_survive',
            },
            {
                'id': 'ActD_MykonosAct1_survive',
                'stage': stage,
                'title': manifest.get('title', stage),
                'missionTitle': 'Survival Challenge',
                'spawn': primary['spawn'],
                'yaw': primary['yaw'],
                'objective': {'type': 'survive', 'text': 'Reach the goal with 1 life · Do not fall!'},
                'lives': 1,
                'goals': goals,
                'checkpoints': checkpoints,
                'deathPlanes': planes,
                'enemies': enemies,
                'modeTriggers': mode_triggers,
                'resultRules': dict(result_rules, parTime=150),
                'nextMission': 'ActD_Africa',
            },
        ]
        primary['missions'] = [m['id'] for m in extra_missions]

    return primary, extra_missions


def build(iso, catalog_path, output):
    disc = Disc(iso)
    catalog = json.loads(catalog_path.read_text())
    scenes = {}
    all_missions = {}

    for entry in catalog['scenes']:
        manifest = json.loads((ROOT / 'dist/probe' / entry['manifest']).read_text())
        primary, extras = extract(entry['id'], disc.open_hashed_archive(entry['id']), manifest)
        scenes[entry['id']] = primary
        all_missions[primary['id']] = primary
        for extra in extras:
            all_missions[extra['id']] = extra

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({
        'version': 2,
        'runtime': 'browser-controller',
        'scenes': scenes,
        'missions': all_missions,
    }, indent=1))

    goal_scenes = sum(bool(s['goals']) for s in scenes.values())
    total_goals = sum(len(s['goals']) for s in scenes.values())
    total_checkpoints = sum(len(s['checkpoints']) for s in scenes.values())
    total_planes = sum(len(s['deathPlanes']) for s in scenes.values())
    total_enemies = sum(len(s.get('enemies', [])) for s in scenes.values())
    total_modes = sum(len(s.get('modeTriggers', [])) for s in scenes.values())

    print(json.dumps({
        'scenes': len(scenes),
        'totalMissions': len(all_missions),
        'goalScenes': goal_scenes,
        'goals': total_goals,
        'checkpoints': total_checkpoints,
        'deathPlanes': total_planes,
        'enemies': total_enemies,
        'modeTriggers': total_modes,
    }))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('iso', type=Path)
    parser.add_argument('--catalog', type=Path, default=ROOT/'dist/probe/game/catalog.json')
    parser.add_argument('--output', type=Path, default=ROOT/'dist/probe/game/missions.json')
    args = parser.parse_args()
    build(args.iso, args.catalog, args.output)
