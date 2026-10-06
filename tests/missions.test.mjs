import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Mission, MissionState, triggered} from '../web/missions.mjs';

const missionData = JSON.parse(readFileSync(new URL('../dist/probe/game/missions.json', import.meta.url)));
const definitions = missionData.scenes;
const allMissions = missionData.missions || {};
const source = definitions.ActD_MykonosAct1;

function playing(definition = source) {
  const mission = new Mission(definition);
  mission.ready();
  mission.start();
  mission.update(1, definition.spawn);
  return mission;
}

test('original source checkpoint, death, respawn, goal and restart form a real loop', () => {
  const mission = playing();
  const checkpoint = source.checkpoints[0];
  assert.equal(mission.state, MissionState.PLAYING);
  assert.equal(mission.lives, 3);

  mission.update(0.1, checkpoint.position);
  assert.equal(mission.checkpoint.id, checkpoint.id);
  assert.equal(mission.drainEvents().filter(event => event.type === 'checkpoint').length, 1);

  // Take a death: lives decrement to 2
  mission.die('Fell off the stage');
  assert.equal(mission.state, MissionState.RESPAWNING);
  assert.equal(mission.lives, 2);
  assert.equal(mission.deaths, 1);

  const elapsed = mission.elapsed;
  mission.update(0.7, checkpoint.position);
  assert.equal(mission.elapsed, elapsed);
  assert.equal(mission.state, MissionState.PLAYING);
  assert.equal(mission.drainEvents().filter(event => event.type === 'respawn').length, 1);

  assert.equal(mission.goal('not-a-real-goal', {rings: 100}), false);
  assert.equal(mission.goal(source.goals[0].id, {rings: 24, score: 5000}), true);
  assert.equal(mission.controllable, false);

  // Rank is calculated from real score, time bonus, ring bonus, and death penalty
  assert.ok(['S', 'A', 'B', 'C', 'D', 'E'].includes(mission.result.rank));
  assert.equal(mission.result.rings, 24);
  assert.equal(mission.result.deaths, 1);
  assert.equal(mission.result.livesRemaining, 2);
  assert.equal(mission.result.success, true);

  mission.update(1.5, source.goals[0].position);
  assert.equal(mission.state, MissionState.RESULTS);
  assert.equal(mission.goal(source.goals[0].id), false);

  mission.retry();
  mission.update(1, source.spawn);
  assert.equal(mission.state, MissionState.PLAYING);
  assert.equal(mission.elapsed, 0);
  assert.equal(mission.checkpoint, null);
  assert.equal(mission.lives, 3);
  assert.equal(mission.deaths, 0);
});

test('rotated original death planes detect crossings within their rectangles', () => {
  const plane = definitions.Town_Africa.deathPlanes[0].trigger;
  const [x, y, z] = plane.position;
  assert.equal(triggered(plane, [x, y - 2, z], [x, y + 2, z]), true);
  assert.equal(triggered(plane, [x + plane.size[0] + 5, y - 2, z], [x + plane.size[0] + 5, y + 2, z]), false);
  assert.equal(triggered(plane, [x, y + 3, z], [x, y + 2, z]), false);

  const mission = playing(definitions.Town_Africa);
  mission.previous = [x, y + 2, z];
  mission.update(0.1, [x, y - 2, z]);
  assert.equal(mission.state, MissionState.RESPAWNING);
  assert.equal(mission.deaths, 1);
});

test('saved clear and checkpoint state restore without softlocking or invented progression', () => {
  const mission = playing();
  const checkpoint = source.checkpoints[0];
  mission.update(0.1, checkpoint.position);
  const active = mission.snapshot();
  const resumed = new Mission(source);

  assert.equal(resumed.restore(active, checkpoint.position), true);
  assert.equal(resumed.checkpoint.id, checkpoint.id);
  assert.equal(resumed.state, MissionState.INTRO);

  resumed.start();
  resumed.update(1, checkpoint.position);
  assert.equal(resumed.drainEvents().filter(event => event.type === 'checkpoint').length, 0);

  resumed.goal(source.goals[0].id, {rings: 5});
  const clear = new Mission(source);
  clear.restore(resumed.snapshot(), source.spawn);
  assert.equal(clear.state, MissionState.RESULTS);
  assert.equal(clear.result.success, true);
  assert.equal(clear.restore({...active, id: 'other-stage'}, source.spawn), false);
});

test('exploration scenes never auto-complete, and optional typed objectives use actual events', () => {
  const exploration = playing(definitions.Town_Mykonos);
  exploration.update(10000, exploration.definition.spawn, {rings: 999999, score: 999999});
  assert.equal(exploration.state, MissionState.PLAYING);

  // Collect objective
  const collect = playing({
    ...source,
    objective: {type: 'collect', text: 'Collect rings', targetCount: 3},
    goals: [],
    checkpoints: [],
  });
  collect.collect(2);
  assert.equal(collect.controllable, true);
  collect.collect(1, {rings: 3});
  assert.equal(collect.state, MissionState.COMPLETE);

  // Time trial objective
  const timed = playing({
    ...source,
    objective: {type: 'time_trial', text: 'Reach the goal', limit: 2},
    checkpoints: [],
  });
  timed.update(2.1, source.spawn);
  assert.equal(timed.state, MissionState.FAILED);
  timed.update(1.5, source.spawn);
  assert.equal(timed.state, MissionState.RESULTS);
  timed.retry();
  assert.equal(timed.state, MissionState.READY);

  // Enemy defeat objective
  const defeatMission = playing({
    ...source,
    objective: {type: 'defeat', text: 'Defeat robots', targetCount: 2},
    goals: [],
    checkpoints: [],
  });
  defeatMission.defeat('robot_01', 'arena_01');
  assert.equal(defeatMission.controllable, true);
  assert.equal(defeatMission.defeatedCount, 1);
  defeatMission.defeat('robot_02', 'arena_01', {score: 1000});
  assert.equal(defeatMission.state, MissionState.COMPLETE);
  assert.equal(defeatMission.defeatedCount, 2);
});

test('lives system decrements lives on death and triggers mission failure at zero lives', () => {
  const survival = playing({
    ...source,
    lives: 2,
    objective: {type: 'survive', text: 'Survive with 2 lives'},
  });
  assert.equal(survival.lives, 2);

  // First death: lives = 1, respawns
  survival.die('Hit spike');
  assert.equal(survival.state, MissionState.RESPAWNING);
  assert.equal(survival.lives, 1);
  survival.update(0.7, source.spawn);
  assert.equal(survival.state, MissionState.PLAYING);

  // Second death: lives = 0, fails mission
  survival.die('Fell off cliff');
  assert.equal(survival.state, MissionState.FAILED);
  assert.equal(survival.lives, 0);
  assert.equal(survival.result.success, false);
  assert.equal(survival.failureReason, 'No lives remaining');
});

test('ranking calculation evaluates scores against thresholds and requires 0 deaths for S rank', () => {
  const mission = playing();
  // Fast clear with high rings and 0 deaths -> S rank
  mission.elapsed = 60; // 60s under 150s par -> (150-60)*250 = 22,500 time bonus
  const highResult = mission.calculateResult({rings: 500, score: 30000});
  // 30,000 + 22,500 + 50,000 = 102,500 >= 70,000 and 0 deaths -> S rank
  assert.equal(highResult.rank, 'S');
  assert.equal(highResult.deaths, 0);

  // Same score but with 1 death -> Cannot get S rank even with high score!
  mission.deaths = 1;
  const deathPenaltyResult = mission.calculateResult({rings: 500, score: 30000});
  assert.notEqual(deathPenaltyResult.rank, 'S');
  assert.equal(deathPenaltyResult.rank, 'A');
});

test('progression sequence connects daytime stages and provides mission variants', () => {
  assert.equal(Object.keys(definitions).length, 38);
  assert.equal(Object.values(definitions).filter(def => def.goals.length).length, 13);
  assert.equal(Object.values(definitions).reduce((count, def) => count + def.checkpoints.length, 0), 61);

  // Progression chain from Windmill Isle to Savannah Citadel to Rooftop Run
  assert.equal(definitions.ActD_MykonosAct1.nextMission, 'ActD_Africa');
  assert.equal(definitions.ActD_Africa.nextMission, 'ActD_EU');
  assert.equal(definitions.ActD_EU.nextMission, 'ActD_China');

  // Side missions for Windmill Isle Act 1
  assert.ok(allMissions.ActD_MykonosAct1_time);
  assert.ok(allMissions.ActD_MykonosAct1_rings);
  assert.ok(allMissions.ActD_MykonosAct1_defeat);
  assert.ok(allMissions.ActD_MykonosAct1_survive);
  assert.equal(allMissions.ActD_MykonosAct1_time.objective.type, 'time_trial');
  assert.equal(allMissions.ActD_MykonosAct1_rings.objective.type, 'collect');
  assert.equal(allMissions.ActD_MykonosAct1_defeat.objective.type, 'defeat');
  assert.equal(allMissions.ActD_MykonosAct1_survive.lives, 1);
});

test('source mode planes switch modes without forcing camera changes', () => {
  const mission = playing();
  assert.equal(mission.mode, '3D');
  const cross = trigger => {
    const [x,y,z,w]=trigger.rotation;
    const n=[2*(x*z+w*y),2*(y*z-w*x),1-2*(x*x+y*y)];
    mission.previous=trigger.position.map((v,i)=>v-n[i]);
    // Test an actual short crossing, rather than teleporting across unrelated
    // mode planes that lie between distant trigger centres.
    mission.definition={...mission.definition,modeTriggers:[trigger]};
    mission.update(.1,trigger.position.map((v,i)=>v+n[i]));
  };

  const trigger2D = source.modeTriggers.find(t => t.mode === '2D');
  assert.ok(trigger2D);
  cross(trigger2D);
  assert.equal(mission.mode, '2D');
  const events2D = mission.drainEvents().filter(e => e.type === 'mode_change');
  assert.equal(events2D.length, 1);
  assert.equal(events2D[0].mode, '2D');
  assert.equal(events2D[0].changeCamera,false);

  const trigger3D = source.modeTriggers.find(t => t.mode === '3D');
  assert.ok(trigger3D);
  cross(trigger3D);
  assert.equal(mission.mode, '3D');
  const events3D = mission.drainEvents().filter(e => e.type === 'mode_change');
  assert.equal(events3D.length, 1);
  assert.equal(events3D[0].mode, '3D');
});

test('goal distance and progress fraction dynamically update during playthrough', () => {
  const mission = playing();
  assert.equal(mission.definition.objective.type, 'reach_goal');
  const initialFraction = mission.progressFraction;
  assert.ok(initialFraction >= 0 && initialFraction <= 1);

  // Moving halfway to the goal ring increases progress fraction
  const goalPos = source.goals[0].position;
  const spawnPos = source.spawn;
  const midPoint = [
    (goalPos[0] + spawnPos[0]) / 2,
    (goalPos[1] + spawnPos[1]) / 2,
    (goalPos[2] + spawnPos[2]) / 2,
  ];
  mission.update(0.5, midPoint);
  assert.ok(mission.progressFraction > initialFraction);
  assert.ok(mission.progressFraction <= 1.0);
});
