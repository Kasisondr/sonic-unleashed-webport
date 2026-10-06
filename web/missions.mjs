/** Data-driven browser mission flow.
 * Supports objective types: reach_goal, collect, defeat, time_trial, survive, score, explore.
 * Full state machine: LOADING -> INTRO -> READY -> PLAYING -> RESPAWNING -> COMPLETE/FAILED -> RESULTS.
 * Browser challenge scoring and S..E ranks. These bonus rules are a local
 * approximation; the original runtime's complete scoring formula is not ported.
 */
export const MissionState = Object.freeze({
  LOADING: 'LOADING',
  INTRO: 'INTRO',
  READY: 'READY',
  PLAYING: 'PLAYING',
  RESPAWNING: 'RESPAWNING',
  COMPLETE: 'MISSION_COMPLETE',
  FAILED: 'MISSION_FAILED',
  RESULTS: 'RESULTS',
});

function localPoint(point, center, rotation = [0, 0, 0, 1]) {
  const x = point[0] - center[0], y = point[1] - center[1], z = point[2] - center[2];
  const length = Math.hypot(...rotation) || 1;
  // Inverse quaternion rotates world-space displacement into trigger space
  const qx = -rotation[0] / length, qy = -rotation[1] / length, qz = -rotation[2] / length, qw = rotation[3] / length;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + qy * tz - qz * ty, y + qw * ty + qz * tx - qx * tz, z + qw * tz + qx * ty - qy * tx];
}

/** Test reusable original-coordinate trigger shapes, including swept planes and boxes. */
export function triggered(trigger, position, previous = position) {
  const local = localPoint(position, trigger.position, trigger.rotation);
  if (trigger.type === 'cylinder') {
    return Math.hypot(local[0], local[2]) <= trigger.radius && Math.abs(local[1]) <= trigger.height;
  }
  if (trigger.type === 'box') {
    return local.every((value, axis) => Math.abs(value) <= trigger.size[axis] / 2);
  }
  if (trigger.type === 'plane') {
    const start = localPoint(previous, trigger.position, trigger.rotation);
    if (Math.abs(start[2] - local[2]) < 1e-7 || start[2] * local[2] > 0) return false;
    const t = start[2] / (start[2] - local[2]);
    if (t < 0 || t > 1) return false;
    const x = start[0] + (local[0] - start[0]) * t, y = start[1] + (local[1] - start[1]) * t;
    return Math.abs(x) <= trigger.size[0] / 2 && Math.abs(y) <= trigger.size[1] / 2;
  }
  return false;
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

export class Mission {
  constructor(definition) {
    if (!definition?.id || !definition.spawn?.every(Number.isFinite)) {
      throw new Error('Invalid mission definition');
    }
    this.definition = definition;
    this.state = MissionState.LOADING;
    this.elapsed = 0;
    this.deaths = 0;
    this.lives = Number.isInteger(definition.lives) ? definition.lives : 3;
    this.collectedCount = 0;
    this.defeatedCount = 0;
    this.defeatedEnemies = new Set();
    this.checkpoint = null;
    this.activatedCheckpoints = new Set();
    this.events = [];
    this.result = null;
    this.previous = [...definition.spawn];
    this.phaseTime = 0;
    this.failureReason = '';
    this.version = 0;
    this.mode = '3D';
  }

  transition(state) {
    this.state = state;
    this.phaseTime = 0;
    this.version++;
    this.events.push({type: 'state', state});
  }

  ready() {
    this.transition(MissionState.INTRO);
  }

  start() {
    if (this.state !== MissionState.INTRO && this.state !== MissionState.READY) return;
    this.transition(MissionState.READY);
  }

  get controllable() {
    return this.state === MissionState.PLAYING;
  }

  get objectiveText() {
    const objective = this.definition.objective || {};
    if (objective.type === 'collect') {
      return `${objective.text} · ${this.collectedCount} / ${objective.targetCount}`;
    }
    if (objective.type === 'defeat') {
      return `${objective.text} · ${this.defeatedCount} / ${objective.targetCount}`;
    }
    if (objective.type === 'time_trial') {
      const remaining = Math.max(0, (objective.limit || 0) - this.elapsed);
      return `${objective.text} · ${remaining.toFixed(1)}s left`;
    }
    if (objective.type === 'survive') {
      return `${objective.text} · ${this.lives} ${this.lives === 1 ? 'life' : 'lives'}`;
    }
    if (objective.type === 'score' && Number.isFinite(objective.targetScore)) {
      return `${objective.text} · Target: ${objective.targetScore}`;
    }
    return objective.text || 'Explore the stage';
  }

  get progressFraction() {
    const objective = this.definition.objective || {};
    if (objective.type === 'collect' && objective.targetCount > 0) {
      return Math.min(1, this.collectedCount / objective.targetCount);
    }
    if (objective.type === 'defeat' && objective.targetCount > 0) {
      return Math.min(1, this.defeatedCount / objective.targetCount);
    }
    if (objective.type === 'time_trial' && objective.limit > 0) {
      return Math.max(0, (objective.limit - this.elapsed) / objective.limit);
    }
    if ((objective.type === 'reach_goal' || objective.type === 'survive') && this.definition.goals?.length && this.definition.spawn) {
      const gx = this.definition.goals[0].position[0], gz = this.definition.goals[0].position[2];
      const sx = this.definition.spawn[0], sz = this.definition.spawn[2];
      const totalDist = Math.hypot(gx - sx, gz - sz);
      if (totalDist > 10) {
        const curDist = Math.hypot(gx - this.previous[0], gz - this.previous[2]);
        return Math.min(1, Math.max(0, (totalDist - curDist) / totalDist));
      }
    }
    return 0;
  }

  update(dt, position, values = {}) {
    const step = Math.max(0, dt);
    this.phaseTime += step;

    if (this.state === MissionState.READY && this.phaseTime >= 0.8) {
      this.transition(MissionState.PLAYING);
    } else if (this.state === MissionState.RESPAWNING && this.phaseTime >= 0.65) {
      this.events.push({type: 'respawn', checkpoint: this.checkpoint});
      this.transition(MissionState.PLAYING);
    } else if ((this.state === MissionState.COMPLETE || this.state === MissionState.FAILED) && this.phaseTime >= 1.4) {
      this.transition(MissionState.RESULTS);
    } else if (this.controllable) {
      this.elapsed += step;

      // Death planes
      for (const plane of this.definition.deathPlanes || []) {
        if (triggered(plane.trigger, position, this.previous)) {
          this.die('Fell off the stage');
          break;
        }
      }

      if (this.controllable) {
        // Checkpoints
        for (const checkpoint of this.definition.checkpoints || []) {
          if (!this.activatedCheckpoints.has(checkpoint.id) && triggered(checkpoint.trigger, position, this.previous)) {
            this.activatedCheckpoints.add(checkpoint.id);
            this.checkpoint = checkpoint;
            this.events.push({type: 'checkpoint', checkpoint, splitTime: this.elapsed});
            this.version++;
          }
        }

        // 2D / 3D Mode Triggers
        for (const mt of this.definition.modeTriggers || []) {
          const trig = mt.trigger || {type: 'cylinder', position: mt.position, radius: 5, height: 10};
          if (triggered(trig, position, this.previous)) {
            if (this.mode !== mt.mode) {
              this.mode = mt.mode;
              this.events.push({type: 'mode_change', mode: mt.mode, changeCamera: mt.changeCamera !== false});
            }
          }
        }

        // Objective evaluations
        const objective = this.definition.objective || {};
        if (objective.type === 'time_trial' && this.elapsed >= objective.limit) {
          this.fail('Time is up');
        } else if (objective.type === 'collect' && this.collectedCount >= objective.targetCount) {
          this.complete(values);
        } else if (objective.type === 'defeat' && this.defeatedCount >= objective.targetCount) {
          this.complete(values);
        } else if (objective.type === 'score' && Number.isFinite(objective.targetScore) && values.score >= objective.targetScore) {
          this.complete(values);
        }
      }
    }
    this.previous[0] = position[0];
    this.previous[1] = position[1];
    this.previous[2] = position[2];
  }

  collect(count = 1, values = {}) {
    if (!this.controllable) return;
    this.collectedCount += count;
    this.version++;
    if (this.definition.objective.type === 'collect' && this.collectedCount >= this.definition.objective.targetCount) {
      this.complete(values);
    }
  }

  defeat(id, groupId = null, values = {}) {
    if (!this.controllable) return;
    if (id && this.defeatedEnemies.has(id)) return;
    if (id) this.defeatedEnemies.add(id);
    this.defeatedCount++;
    this.version++;
    this.events.push({type: 'enemy_defeated', id, groupId, count: this.defeatedCount});
    if (this.definition.objective.type === 'defeat' && this.defeatedCount >= this.definition.objective.targetCount) {
      this.complete(values);
    }
  }

  goal(id, values = {}) {
    if (!this.controllable) return false;
    const goals = this.definition.goals || [];
    if (!goals.some(goal => goal.id === id)) return false;
    if (!['reach_goal', 'time_trial', 'survive'].includes(this.definition.objective.type)) {
      if (this.definition.objective.type === 'collect' && this.collectedCount < this.definition.objective.targetCount) {
        return false;
      }
      if (this.definition.objective.type === 'defeat' && this.defeatedCount < this.definition.objective.targetCount) {
        return false;
      }
    }
    this.complete(values);
    return true;
  }

  calculateResult(values = {}) {
    const rules = this.definition.resultRules || {};
    const parTime = rules.parTime || 180;
    const timeRemaining = Math.max(0, parTime - this.elapsed);
    const timeBonus = Math.floor(timeRemaining * (rules.timeBonusRate ?? 250));
    const rings = finite(values.rings);
    const ringBonus = Math.floor(rings * (rules.ringBonusMultiplier ?? 100));
    const enemyBonus = Math.floor(this.defeatedCount * (rules.enemyBonusMultiplier ?? 500));
    const baseScore = finite(values.score);
    const deathPenalty = this.deaths * (rules.deathPenalty ?? 10000);
    const totalScore = Math.max(0, baseScore + timeBonus + ringBonus + enemyBonus - deathPenalty);

    let rank = 'E';
    const thresholds = rules.rankThresholds;
    if (thresholds) {
      if (totalScore >= thresholds.S && this.deaths === 0) rank = 'S';
      else if (totalScore >= thresholds.A) rank = 'A';
      else if (totalScore >= thresholds.B) rank = 'B';
      else if (totalScore >= thresholds.C) rank = 'C';
      else if (totalScore >= thresholds.D) rank = 'D';
      else rank = 'E';
    }

    return {
      stage: this.definition.stage,
      missionId: this.definition.id,
      elapsed: this.elapsed,
      timeBonus,
      rings,
      ringBonus,
      defeated: this.defeatedCount,
      enemyBonus,
      score: totalScore,
      baseScore,
      deaths: this.deaths,
      livesRemaining: this.lives,
      collected: this.collectedCount,
      rank,
      success: true,
      nextMission: this.definition.nextMission || null,
    };
  }

  complete(values = {}) {
    if (!this.controllable) return;
    this.result = this.calculateResult(values);
    this.transition(MissionState.COMPLETE);
    this.events.push({type: 'complete', result: this.result});
  }

  die(reason = 'Fell off the stage') {
    if (!this.controllable) return;
    this.deaths++;
    this.lives--;
    this.failureReason = reason;

    if (this.lives <= 0) {
      this.fail('No lives remaining');
    } else {
      this.transition(MissionState.RESPAWNING);
    }
  }

  fail(reason = 'Mission Failed') {
    if (!this.controllable) return;
    this.failureReason = reason;
    this.result = {
      stage: this.definition.stage,
      missionId: this.definition.id,
      elapsed: this.elapsed,
      timeBonus: 0,
      rings: 0,
      ringBonus: 0,
      defeated: this.defeatedCount,
      enemyBonus: 0,
      score: 0,
      baseScore: 0,
      deaths: this.deaths,
      livesRemaining: this.lives,
      collected: this.collectedCount,
      rank: 'E',
      success: false,
      reason,
      nextMission: null,
    };
    this.transition(MissionState.FAILED);
    this.events.push({type: 'failed', result: this.result});
  }

  drainEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  snapshot() {
    return {
      version: 2,
      id: this.definition.id,
      state: this.state,
      elapsed: this.elapsed,
      deaths: this.deaths,
      lives: this.lives,
      collectedCount: this.collectedCount,
      defeatedCount: this.defeatedCount,
      defeatedEnemies: [...this.defeatedEnemies],
      checkpoint: this.checkpoint?.id || null,
      activatedCheckpoints: [...this.activatedCheckpoints],
      result: this.result,
    };
  }

  restore(saved, position) {
    if (!saved || saved.id !== this.definition.id) return false;
    this.elapsed = finite(saved.elapsed);
    this.deaths = Math.floor(finite(saved.deaths));
    this.lives = Number.isInteger(saved.lives) ? saved.lives : (this.definition.lives ?? 3);
    this.collectedCount = finite(saved.collectedCount);
    this.defeatedCount = finite(saved.defeatedCount);
    this.defeatedEnemies = new Set(Array.isArray(saved.defeatedEnemies) ? saved.defeatedEnemies : []);

    const known = new Set((this.definition.checkpoints || []).map(checkpoint => checkpoint.id));
    this.activatedCheckpoints = new Set((saved.activatedCheckpoints || []).filter(id => known.has(id)));
    this.checkpoint = (this.definition.checkpoints || []).find(checkpoint => checkpoint.id === saved.checkpoint) || null;

    if (position?.every(Number.isFinite)) this.previous = [...position];
    this.result = saved.result?.stage === this.definition.stage ? saved.result : null;

    this.transition(
      [MissionState.COMPLETE, MissionState.FAILED, MissionState.RESULTS].includes(saved.state) && this.result
        ? MissionState.RESULTS
        : MissionState.INTRO
    );
    return true;
  }

  retry(position = this.definition.spawn) {
    this.elapsed = 0;
    this.deaths = 0;
    this.lives = Number.isInteger(this.definition.lives) ? this.definition.lives : 3;
    this.collectedCount = 0;
    this.defeatedCount = 0;
    this.defeatedEnemies.clear();
    this.checkpoint = null;
    this.activatedCheckpoints.clear();
    this.result = null;
    this.failureReason = '';
    this.previous = [...position];
    this.mode = '3D';
    this.transition(MissionState.READY);
  }
}
