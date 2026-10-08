import {Scene} from './scene.mjs';
import {Player} from './player.mjs';
import {Input} from './input.mjs';
import {Mission, MissionState, triggered} from './missions.mjs';

const $ = id => document.getElementById(id);
/** Top speed, mirroring the controller's boost cap so the gauge reads 0..1. */
const BOOST_SPEED = 30;
const status = {frames: 0, errors: [], chunks: 0, rings: 0, goal: false};
let scene, player, input, manifest, mission, checkpointState=null, stopped = false, last = performance.now();
let missionDefinitions = null;
const parameters = new URLSearchParams(location.search);
const goalDefinitions=new Map();

function fail(error) {
  status.errors.push(String(error));
  $('load-status').textContent = `Stage could not load: ${error.message}`;
  $('loading').hidden = false;
  $('diagnostics').dataset.errors = status.errors.length;
  stopped = true;
  console.error(error);
}

function perspective(fieldOfView, aspect, near, far) {
  const f = 1 / Math.tan(fieldOfView / 2);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1,
    0, 0, 2 * far * near / (near - far), 0]);
}

function lookAt(eye, target, up = [0, 1, 0]) {
  const z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}

function multiply(a, b) {
  const result = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let index = 0; index < 4; index++) sum += a[index * 4 + row] * b[column * 4 + index];
      result[column * 4 + row] = sum;
    }
  }
  return result;
}

/** Column-major model matrix: yaw, optional roll about the local X axis, then translation. */
function modelMatrix(position, heading, scale, spin = 0) {
  const cy = Math.cos(heading), sy = Math.sin(heading);
  const cx = Math.cos(spin), sx = Math.sin(spin);
  // Ry(heading) * Rx(spin) with the scale folded in.
  return new Float32Array([
    cy * scale, 0, -sy * scale, 0,
    sy * sx * scale, cx * scale, cy * sx * scale, 0,
    sy * cx * scale, -sx * scale, cy * cx * scale, 0,
    position[0], position[1], position[2], 1]);
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

let toastTimer = 0;
function toast(message, seconds = 2.4) {
  const element = $('toast');
  element.textContent = message;
  element.hidden = false;
  element.classList.toggle('goal', /clear/i.test(message));
  toastTimer = seconds;
}

let checkpointTimer = 0;
function showCheckpointBanner(seconds = 2.2) {
  const banner = $('checkpoint-banner');
  if (!banner) return;
  banner.hidden = false;
  banner.style.animation = 'none';
  banner.offsetHeight;
  banner.style.animation = 'checkpoint-pulse 0.4s ease-out';
  checkpointTimer = seconds;
}

const CHIP_HINTS = [
  "If you've got questions, hit the question mark! It'll give you a hint.",
  "Collect rings to fill your boost gauge, then hold Shift to blast forward!",
  "Hit that jump board to soar over obstacles and discover high-speed shortcuts!",
  "Egg Fighters ahead! Charge through them at top speed or homing attack from the air!",
  "Lost your bearings? Press 'C' anytime to snap the camera directly behind Sonic!",
  "Take tight curves like a pro! Hold Q or E to drift without sacrificing momentum!",
  "Smash wooden crates and terracotta pots while boosting for bonus rings!",
  "Nice going! Keep up your momentum and reach the goal ring ahead!"
];
let chipHintIndex = 0;
let chipTimer = 0;

function showChipHint(text, seconds = 5.5) {
  const dialog = $('chip-dialog');
  const dialogText = $('chip-dialog-text');
  if (!dialog || !dialogText) return;
  dialogText.textContent = text;
  dialog.hidden = false;
  chipTimer = seconds;
}

function hideChipHint() {
  const dialog = $('chip-dialog');
  if (dialog) dialog.hidden = true;
  chipTimer = 0;
}

function triggerNextChipHint() {
  const text = CHIP_HINTS[chipHintIndex % CHIP_HINTS.length];
  chipHintIndex++;
  showChipHint(text, 5.5);
}

let goBannerTimer = null;
function showGoBanner() {
  const phase = $('mission-phase');
  if (!phase) return;
  const bannerText = phase.querySelector('.go-banner-text');
  const beadRing = phase.querySelector('.rainbow-bead-ring');
  if (bannerText) bannerText.textContent = 'GO!';
  if (beadRing) beadRing.hidden = false;
  phase.hidden = false;
  clearTimeout(goBannerTimer);
  goBannerTimer = setTimeout(() => {
    phase.hidden = true;
    if (beadRing) beadRing.hidden = true;
  }, 1200);
}

/** Which of the disc animations the current controller state should play. */
function animationState(dt) {
  if (mission && !mission.controllable) return 'idle';
  if (player.springLaunch > 0) {
    player.springLaunch -= dt;
    return 'spring';
  }
  if (!player.grounded) {
    if (player.jumpPose > 0) {
      player.jumpPose -= dt;
      return 'jump';
    }
    // In Unleashed Sonic stays curled into a ball while he is off the ground.
    return player.velocity[1] < -8 ? 'ball' : 'fall';
  }
  if (player.landed) {
    player.landed = false;
    player.landingPose = 0.2;
  }
  if (player.landingPose > 0) {
    player.landingPose -= dt;
    return 'land';
  }
  if (player.speed > 20) return 'dash';
  if (player.speed > 7.5) return 'run';
  if (player.speed > 0.8) return 'walk';
  return 'idle';
}

/** Stage clock, shown by the goal banner. */
function clock(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function clockWithCentiseconds(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(cs).padStart(2, '0')}`;
}

/** Collect rings, launch off springs, speed up on dash panels, and fight enemies. */
function interact(dt) {
  if (!mission.controllable) return;
  const position = player.position;
  for (const object of scene.objects) {
    if (object.collected) continue;
    const dx = object.position[0] - position[0];
    const dy = object.position[1] - position[1];
    const dz = object.position[2] - position[2];
    if (object.kind === 'enemy') {
      const distXZ = Math.hypot(dx, dz);
      if (distXZ < 28) {
        object.yaw = Math.atan2(-dx, -dz) * 180 / Math.PI;
      }
      if (distXZ < 2.2 && Math.abs(dy) < 2.5) {
        const attacking = (player.speed > 16 || status.boostHeld || (!player.grounded && player.velocity[1] < 0) || player.jumps > 0);
        if (attacking) {
          object.collected = true;
          effect('defeat');
          if (!player.grounded) {
            player.velocity[1] = 13;
            player.jumps = 1;
            player.jumpPose = 0.2;
          } else if (status.boostHeld) {
            player.speed = Math.max(player.speed, 28);
          }
          player.score += 500;
          toast('Egg Fighter destroyed! +500', 1.5);
          mission.defeat(object.name, object.groupId, {rings: player.ringCount, score: player.score});
        } else if (player.invulnerableTimer <= 0) {
          if (player.ringCount > 0) {
            player.ringCount = 0;
            status.rings = 0;
            player.speed = -8;
            player.velocity[1] = 6;
            player.grounded = false;
            player.invulnerableTimer = 1.8;
            effect('land');
            toast('Hit! Lost rings!', 1.6);
          } else {
            mission.die('Defeated by Egg Fighter');
          }
        }
      }
      continue;
    }
    if (object.kind === 'woodbox' || object.kind === 'pot') {
      if (Math.hypot(dx, dz) < 1.7 && Math.abs(dy) < 2.0) {
        const smashing = (player.speed > 12 || status.boostHeld || (!player.grounded && player.velocity[1] < 0) || player.jumps > 0);
        if (smashing) {
          object.collected = true;
          effect('defeat');
          player.score += 100;
          player.ringCount += 1;
          player.boost = Math.min(1, player.boost + 0.05);
          toast(object.kind === 'woodbox' ? 'Crate smashed! +100' : 'Pot smashed! +100', 1.2);
        } else if (player.speed > 3) {
          player.speed = Math.max(0, player.speed - 5);
        }
      }
      continue;
    }
    if (object.kind === 'dashpanel') {
      if (Math.hypot(dx, dz) < 1.9 && Math.abs(dy) < 2.0) {
        effect('dashpanel', 0.8);
        player.activateDash(object);
        player.boost = 1;
        player.jumpPose = 0;
      }
      continue;
    }
    if (object.kind === 'spring' || object.kind === 'jumpboard') {
      const radius = object.kind === 'jumpboard' ? 2.4 : 1.5;
      if (Math.hypot(dx, dz) < radius && Math.abs(dy) < 2.2 && player.velocity[1] <= 0.8) {
        player.activateLauncher(object, status.boostHeld);
        player.springLaunch = 0.8;
        effect(object.kind);
        toast(object.kind === 'jumpboard' ? 'Jump board!' : 'Spring!');
      }
      continue;
    }
    if (object.kind === 'goal') {
      const goal=goalDefinitions.get(object);
      if (goal && triggered({type:'cylinder',position:goal.position,radius:goal.radius,height:goal.height},position)) {
        if (goal && mission.goal(goal.id,{rings:player.ringCount,score:player.score})) {
          object.collected=true;status.goal=true;effect('goal');
          player.speed=0;player.velocity.fill(0);saveProgress();
        }
      }
      continue;
    }
    if (!['ring','superring'].includes(object.kind)) continue;
    // Rings hover at ground level, so test a vertical cylinder around Sonic.
    if (Math.hypot(dx, dz) < 1.35 && Math.abs(dy) < 1.8) {
      object.collected = true;
      const worth = object.kind === 'superring' ? 10 : 1;
      player.ringCount += worth;
      // Original scoring consists of enemy/trick/time bonuses. Rings are
      // tracked as rings; they aren't converted into invented score points.
      player.boost=Math.min(1,player.boost+worth*.015);
      mission.collect(worth,{rings:player.ringCount,score:player.score});
      status.rings += worth; effect(worth > 1 ? 'superring' : 'ring', 0.035);
      if (worth > 1) toast(`Super ring! +${worth}`);
    }
  }
}

function resize() {
  const canvas = $('screen');
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth * ratio, height = canvas.clientHeight * ratio;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  layoutHud();
}

function frame(now) {
  if (stopped) return;
  try {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!document.hidden) {
      resize();
      const state = input.read();
      if (mission.state===MissionState.INTRO && (state.forward||state.jump||state.boost)) {
        mission.start();
        showGoBanner();
        showChipHint(CHIP_HINTS[0], 6.0);
      }
      const wasGrounded = player.grounded;
      if (mission.controllable) player.update(dt,state);
      else { player.speed=0; player.velocity.fill(0); }
      mission.update(dt,player.position,{rings:player.ringCount,score:player.score});
      if (player.fell) { player.fell=false;mission.die('Fell off the stage'); }
      if (mission.controllable && state.jump && !status.jumpHeld && !player.grounded) effect('jump');
      if (mission.controllable && state.boost && !status.boostHeld && player.boost > 0) effect('boost');
      if (player.grounded && !wasGrounded) effect('land');
      if (state.hint && !status.hintHeld) triggerNextChipHint();
      status.jumpHeld = state.jump; status.boostHeld = state.boost; status.hintHeld = state.hint;
      scene.update(scene.camera, player.position).catch(fail);
      const projection = perspective(Math.PI / 3, $('screen').width / $('screen').height, 0.3, 4200);
      const view = lookAt(player.camera.position, player.camera.lookAt);
      scene.camera = {
        position: player.camera.position,
        target: player.camera.lookAt,
        matrix: multiply(projection, view),
        skyMatrix: multiply(perspective(Math.PI / 3, $('screen').width / $('screen').height, 1, 4200),
          lookAt([0, 0, 0], player.camera.lookAt.map((value, index) => value - player.camera.position[index]))),
      };
      scene.playerPosition = player.position;
      // Sonic's mesh is authored feet-at-origin, ~1.1 units tall, so place it
      // straight on the controller position; the rig supplies the pose.
      const pose = animationState(dt);
      const rigged = Boolean(scene.rig) && scene.rig.update(dt, pose);
      status.animation = pose;
      const rolling = !player.grounded && !rigged;
      if (rolling) player.ballSpin = (player.ballSpin || 0) + dt * (6 + Math.abs(player.speed) * 0.9);
      const characterMatrix = rolling
        ? modelMatrix([player.position[0], player.position[1] - 1.1, player.position[2]], player.heading, 0.5, player.ballSpin)
        : modelMatrix([player.position[0], player.position[1] - 1.1, player.position[2]], player.heading, 1.0);
      // The sun's shadow map is rendered first so the colour pass can sample it.
      scene.renderShadows(player.position, characterMatrix);
      scene.draw(scene.camera, {time: now / 1000});
      scene.drawCharacter(scene.camera, characterMatrix, rolling);
      scene.drawCompanion(scene.camera, dt, player, chipTimer > 0);
      status.character = scene.character ? (rigged ? 'skinned' : (rolling ? 'ball' : 'model')) : 'missing';
      // The ocean is visual geometry; falling below sea level causes a retry.
      if (mission.controllable && manifest.water !== null && manifest.water !== undefined && player.position[1] < manifest.water + 0.6) {
        mission.die('Fell into the water');
      }
      interact(dt);
      handleMissionEvents();
      scene.drawObjects(scene.camera, now / 1000);
      scene.present?.();
      if (toastTimer > 0 && (toastTimer -= dt) <= 0) $('toast').hidden = true;
      if (checkpointTimer > 0 && (checkpointTimer -= dt) <= 0) {
        const banner = $('checkpoint-banner');
        if (banner) banner.hidden = true;
      }
      if (chipTimer > 0 && (chipTimer -= dt) <= 0) hideChipHint();
      status.frames++;
      if (status.frames % 60 === 0) {
        const graphicsError=scene.gl.getError();
        if (graphicsError !== scene.gl.NO_ERROR) throw new Error(`WebGL error 0x${graphicsError.toString(16)}`);
      }
      if (status.frames % 300 === 0) saveProgress();
      status.chunks = scene.chunks.size;
      if (status.frames % 6 === 0) {
        Object.assign($('diagnostics').dataset, {
          waterHeight: String(manifest.water), state: player.state, frames: String(status.frames), chunks: String(scene.chunks.size),
          grass: String(scene.stats.grass || 0), water: String(scene.stats.water || 0), companion: scene.stats.companion || 'missing',
          loading: String(scene.stats.loading), drawCalls: String(scene.stats.drawCalls),
          triangles: String(scene.stats.triangles), position: player.position.map(v => v.toFixed(1)).join(','),
          speed: player.speed.toFixed(1), grounded: String(player.grounded), rings: String(player.ringCount),
          character: String(status.character), errors: String(status.errors.length),
          objects: String(scene.objects.length), collected: String(status.rings),
          missionState:mission.state,elapsed:mission.elapsed.toFixed(2),deaths:String(mission.deaths),
          checkpoint:mission.checkpoint?.id||'',score: String(player.score), goal: String(Boolean(status.goal)),
          audio: String(status.audio || 'idle'), track: String(status.track || ''),
          animation: String(status.animation || ''),
          originalLights:String(manifest.graphics?.lights?.length || 0),
          lightField:String(Boolean(scene.lightField)),
          normalMaps:String(manifest.materials.filter(material=>material.normalTexture).length),
        });
        updateHud();
      }
    }
  } catch (error) {
    fail(error);
    return;
  }
  requestAnimationFrame(frame);
}

/**
 * The HUD is the game's own art: every sprite comes from ui/ui.json, and the
 * element boxes are sized in atlas pixels so the layout matches the disc's
 * `ui_playscreen` description. The whole thing is scaled by one factor so it
 * holds together at any window size.
 */
const hud = {
  root: null, fill: null, chevrons: [], ringsValue: null,
  scoreValue: null, timeValue: null, livesValue: null, needle: null,
  energySegs: [], debug: null, scale: 1,
};

/** Load the HUD's sprite sheets and hand back the nodes the frame loop drives. */
async function buildHud() {
  const root = $('hud');
  const response = await fetch('ui/ui.json');
  if (!response.ok) throw new Error(`ui.json (${response.status})`);
  const ui = await response.json();
  hud.root = root;
  hud.fill = $('hud-gauge')?.querySelector('.fill');
  hud.chevrons = [...($('hud-gauge')?.querySelectorAll('.chevron') || [])];
  hud.ringsValue = $('hud-rings-value');
  hud.scoreValue = $('hud-score-value');
  hud.timeValue = $('hud-time-value');
  hud.livesValue = $('hud-lives-value');
  hud.needle = $('speedo-needle');
  hud.energySegs = [...document.querySelectorAll('#hud-energy-bar .seg')];
  hud.debug = $('hud-debug');
  layoutHud();
  // Preload the sprite sheets so the first gameplay frame is not missing art.
  await Promise.all(Object.values(ui.atlases).map(async atlas => {
    const image = new Image();
    image.src = `ui/${atlas.file}`;
    if (image.decode) await image.decode().catch(() => {});
  }));
  root.hidden = false;
}

/**
 * The HUD is authored at the atlas' native 1:1 size, so scale it as one block
 * against the viewport and keep it clear of the notch on wide screens.
 */
function layoutHud() {
  if (!hud.root) return;
  const canvas = $('screen');
  hud.scale = Math.max(0.6, Math.min(1.4, Math.min(canvas.clientWidth / 720, canvas.clientHeight / 460)));
  hud.root.style.transformOrigin = '0 0';
  hud.root.style.transform = `scale(${hud.scale.toFixed(3)})`;
  // The right-hand cluster is pinned to the right edge, which scaling moves.
  hud.root.style.height = `${Math.round(canvas.clientHeight / hud.scale)}px`;
  hud.root.style.width = `${Math.round(canvas.clientWidth / hud.scale)}px`;
}

function updateHud() {
  if (!hud.root) return;
  const speed = Math.min(1, Math.abs(player.speed) / BOOST_SPEED);
  if (hud.fill) hud.fill.style.transform = `scaleX(${speed.toFixed(3)})`;
  hud.chevrons.forEach((node, index) => {
    node.classList.toggle('on', speed > (index + 1) / (hud.chevrons.length + 1));
  });

  // Authentic Xbox 360 speedometer needle rotation: -120deg (0 km/h) to +120deg (max boost speed)
  if (hud.needle) {
    const spdRatio = Math.min(1.2, Math.abs(player.speed) / BOOST_SPEED);
    const angleDeg = -120 + spdRatio * 240;
    hud.needle.style.transform = `translateX(-50%) rotate(${angleDeg.toFixed(1)}deg)`;
  }

  // 5-segment glowing rainbow boost meter
  if (hud.energySegs && hud.energySegs.length) {
    hud.energySegs.forEach((seg, i) => {
      seg.classList.toggle('on', player.boost >= (i + 1) * 0.2);
    });
  }

  // 3-digit zero-padded rings (000), 8-digit zero-padded score (00000000), 2-digit lives (05)
  if (hud.ringsValue) hud.ringsValue.textContent = String(player.ringCount).padStart(3, '0');
  if (hud.scoreValue) hud.scoreValue.textContent = String(player.score).padStart(8, '0');
  if (hud.timeValue) hud.timeValue.textContent = clockWithCentiseconds(mission.elapsed);
  if (hud.livesValue) hud.livesValue.textContent = String(mission.lives).padStart(2, '0');
  if (hud.debug) hud.debug.textContent = `${Math.round(player.speed * 3.6)} km/h`;

  const kickerNode = $('mission-hud-kicker');
  if (kickerNode) kickerNode.textContent = mission.definition.missionTitle || (mission.definition.goals?.length ? 'DAYTIME STAGE' : 'EXPLORATION');
  const objNode = $('mission-objective');
  if (objNode) objNode.textContent = mission.objectiveText;
  const fillNode = $('mission-progress-fill');
  if (fillNode) fillNode.style.width = `${Math.round(mission.progressFraction * 100)}%`;
  const deathsNode = $('mission-deaths');
  if (deathsNode) deathsNode.textContent = `Deaths ${mission.deaths}`;
  const boostNode = $('mission-boost');
  if (boostNode) boostNode.style.transform = `scaleX(${player.boost.toFixed(3)})`;
  const boostLabel = $('mission-boost-label');
  if (boostLabel) boostLabel.textContent = `Boost ${Math.round(player.boost * 100)}%`;
}

let soundtrack = null, soundStart = null;
const effectTimes = new Map();
function effect(name, interval = 0.08) {
  if (!soundtrack?.effects.has(name) || soundtrack.context.state !== 'running') return;
  const now = soundtrack.context.currentTime;
  if (now - (effectTimes.get(name) ?? -100) < interval) return;
  effectTimes.set(name, now);
  const source = soundtrack.context.createBufferSource();
  source.buffer = soundtrack.effects.get(name);
  source.connect(soundtrack.effectsGain); source.start();
  source.onended = () => source.disconnect();
}

/** Create/resume the context during the gesture, then load original audio. */
function startAudio() {
  if (soundtrack) return soundtrack.context.resume();
  if (soundStart) return soundStart;
  const context = new AudioContext(); context.resume();
  soundStart = (async () => {
    try {
      const track = manifest.audio || (await (await fetch('game/audio.json')).json()).bgm;
      const buffer = await context.decodeAudioData(await (await fetch(track.url || `game/${track.file}`)).arrayBuffer());
      const source = context.createBufferSource(); source.buffer = buffer; source.loop = true;
      source.loopStart = (track.loop_start ?? 0) / track.sample_rate;
      source.loopEnd = (track.loop_end ?? track.samples) / track.sample_rate;
      let volume = 0.5;
      try { const stored = localStorage.getItem('unleashed-menu-volume'); if (stored !== null) volume = Math.min(1,Math.max(0,Number(stored)/100)); } catch {}
      const gain = context.createGain(); gain.gain.value = volume * 0.65;
      const effectsGain = context.createGain(); effectsGain.gain.value = volume;
      source.connect(gain); gain.connect(context.destination); effectsGain.connect(context.destination);
      soundtrack = {context, source, gain, effectsGain, volume, track, effects: new Map()};
      source.start(); status.audio = context.state; status.track = track.name;
      const effectsManifest = await (await fetch('game/sfx/manifest.json')).json();
      await Promise.all(Object.entries(effectsManifest).map(async ([name, spec]) => {
        const response = await fetch(spec.url);
        if (!response.ok) throw new Error(`Effect unavailable: ${name}`);
        soundtrack.effects.set(name, await context.decodeAudioData(await response.arrayBuffer()));
      }));
      $('diagnostics').dataset.audio = context.state;
      $('diagnostics').dataset.effects = String(soundtrack.effects.size);
    } catch (error) {
      console.warn('stage audio unavailable', error); status.audio = 'unavailable';
      if (!soundtrack) { await context.close(); soundStart = null; }
    }
  })();
  return soundStart;
}

async function boot() {
  let stagePath = 'game/stage.json';
  let catalogTitle = 'Windmill Isle Act 1';
  const requested = parameters.get('stage');
  if (requested) {
    const catalog = await (await fetch('game/catalog.json')).json();
    const selected = catalog.scenes.find(scene => scene.id === requested);
    if (!selected) throw new Error('This scene is not available. Return to the main menu.');
    stagePath = selected.manifest;
    catalogTitle = selected.title;
  }
  const response = await fetch(stagePath);
  if (!response.ok) throw new Error(`stage.json (${response.status})`);
  manifest = await response.json();
  if (!manifest.title) manifest.title = catalogTitle;
  document.title = `Sonic Unleashed · ${manifest.title || 'Windmill Isle Act 1'}`;
  $('screen').setAttribute('aria-label', `${manifest.title || 'Windmill Isle Act 1'} rendered from original game data`);
  try { localStorage.setItem('unleashed-last-stage', manifest.stage); } catch {}
  scene = new Scene($('screen'), manifest);
  scene.camera = {position: [0, 0, 0], matrix: new Float32Array(16), skyMatrix: new Float32Array(16)};
  player = new Player(scene, manifest.browserSpawn || manifest.spawn, manifest.yaw);
  player.deathManaged=true;
  const definitionsResponse=await fetch('game/missions.json');
  if (!definitionsResponse.ok) throw new Error('Original mission definitions are unavailable. Run tools/prepare_missions.py.');
  missionDefinitions = await definitionsResponse.json();
  const requestedMission = parameters.get('mission');
  const baseDef = (requestedMission && missionDefinitions.missions?.[requestedMission]) || missionDefinitions.scenes[manifest.stage];
  if (!baseDef) throw new Error(`Missing original mission metadata for ${manifest.stage}`);
  const definition = Object.assign({}, baseDef, {
    spawn: [...(manifest.browserSpawn || manifest.spawn)],
  });
  mission=new Mission(definition);
  input = new Input();
  let progress;
  if (parameters.has('continue')) {
    try { progress = JSON.parse(localStorage.getItem('unleashed-progress')); } catch {}
    if (progress?.stage === manifest.stage && progress.position?.length === 3 && progress.position.every(Number.isFinite)) {
      player.position = [...progress.position];
      player.lastSafe = [...progress.position];
      player.heading = Number.isFinite(progress.heading) ? progress.heading : player.heading;
      player.ringCount = Math.max(0, progress.rings || 0);
      player.score = 0; // Old prototype ring×10 scores are not original game scores.
      checkpointState=progress.checkpointState||null;
      player.camera.position = [player.position[0], player.position[1] + 3, player.position[2] - 6];
    }
  }
  $('load-status').textContent = `Streaming ${manifest.chunks.length} terrain chunks…`;
  await scene.prepareTextures();
  await scene.loadCompanion().catch(error => console.warn('Chip unavailable', error));
  await scene.loadCharacter().catch(error => console.warn('character unavailable', error));
  await scene.loadRig().catch(error => console.warn('animations unavailable', error));
  await scene.loadProps().catch(error => console.warn('props unavailable', error));
  if (progress?.stage === manifest.stage && Array.isArray(progress.collected)) {
    const collected = new Set(progress.collected);
    scene.objects.forEach((object, i) => { object.collected = collected.has(i); });
  }
  for (const goal of definition.goals) {
    const object=scene.objects.find(object=>object.kind==='goal' && object.position.every((value,axis)=>Math.abs(value-goal.position[axis])<.002));
    if (object) goalDefinitions.set(object,goal);
  }
  await buildHud().catch(error => console.warn('original HUD unavailable', error));
  await scene.update(scene.camera, player.position);
  // Wait for the terrain around the spawn so the first frame is already solid.
  await new Promise(resolve => {
    const timer = setInterval(() => {
      const ready = [...scene.chunks.values()].filter(chunk => !chunk.pending).length;
      if (ready > 2 || performance.now() - start > 8000) { clearInterval(timer); resolve(); }
    }, 120);
    const start = performance.now();
  });
  document.addEventListener('keydown', event => {
    if (event.code === 'Enter') {
      if (mission.state === MissionState.INTRO) {
        mission.start();
        showGoBanner();
        showChipHint(CHIP_HINTS[0], 6.0);
        handleMissionEvents();
      } else if (mission.state === MissionState.RESULTS && mission.result?.success && mission.result?.nextMission) {
        const nextId = mission.result.nextMission;
        const nextDef = missionDefinitions?.missions?.[nextId] || missionDefinitions?.scenes?.[nextId];
        const targetStage = nextDef?.stage || nextId;
        location.href = `play.html?stage=${encodeURIComponent(targetStage)}&mission=${encodeURIComponent(nextId)}`;
      }
    }
    if (event.code === 'KeyR' && mission.controllable) respawn();
    if (event.code === 'Escape') { saveProgress(); location.href = 'index.html?menu=1'; }
  });
  $('return-menu').addEventListener('click', saveProgress);
  $('hint-trigger-btn')?.addEventListener('click', () => triggerNextChipHint());
  $('chip-dismiss-btn')?.addEventListener('click', () => hideChipHint());
  window.addEventListener('pagehide', saveProgress);
  $('loading').hidden = true;
  status.started=performance.now();
  mission.ready();
  if (progress?.stage===manifest.stage) {
    if (!mission.restore(progress.mission,player.position)) mission.elapsed=Math.max(0,progress.elapsed||0);
  }
  const stageTitle = manifest.title || definition.title || 'Sonic Unleashed';
  const fullMissionTitle = definition.missionTitle ? `${stageTitle} · ${definition.missionTitle}` : stageTitle;
  $('mission-name').textContent = fullMissionTitle;
  $('mission-intro-objective').textContent=mission.objectiveText;
  $('mission-start').textContent=progress?.stage===manifest.stage ? 'Continue stage' : 'Start stage';
  $('mission-start').addEventListener('click',()=>{
    startAudio();
    mission.start();
    showGoBanner();
    showChipHint(CHIP_HINTS[0], 6.0);
    handleMissionEvents();
  });
  $('mission-retry').addEventListener('click',restartMission);
  $('mission-resume').addEventListener('click',()=>{
    if (mission.state!==MissionState.RESULTS || mission.result?.success) return;
    mission.result=null;respawn();mission.transition(MissionState.READY);handleMissionEvents();
  });
  const nextButton = $('mission-next');
  if (nextButton) {
    nextButton.addEventListener('click', () => {
      if (!mission.result?.nextMission) return;
      const nextId = mission.result.nextMission;
      const nextDef = missionDefinitions?.missions?.[nextId] || missionDefinitions?.scenes?.[nextId];
      const targetStage = nextDef?.stage || nextId;
      location.href = `play.html?stage=${encodeURIComponent(targetStage)}&mission=${encodeURIComponent(nextId)}`;
    });
  }
  handleMissionEvents();
  $('diagnostics').dataset.state = 'running';
  // Browsers only allow audio after a gesture, so wait for the first input.
  document.addEventListener('pointerdown', startAudio, {once: true});
  document.addEventListener('keydown', startAudio, {once: true});
  window.addEventListener('keydown', event => {
    if (event.code === 'KeyM' && soundtrack) {
      const muted = soundtrack.gain.gain.value > 0.001;
      soundtrack.gain.gain.value = muted ? 0 : soundtrack.volume * 0.65;
      toast(muted ? 'Music muted' : 'Music on');
    }
  });
  // Debug handle used by the automated checks in this repository.
  window.game = {scene, player, manifest, mission, status, startAudio, get soundtrack() { return soundtrack; }};
  last = performance.now();
  requestAnimationFrame(frame);
}

function respawnTo(target, message, heading=player.heading, center=false) {
  player.position=[target[0],target[1]+(center?0:1.1),target[2]];
  player.velocity.fill(0);player.speed=0;player.boost=1;player.grounded=false;
  player.jumpHeld=false;player.jumps=0;player.jumpPose=0;player.springLaunch=0;
  player.routes.active=null;player.routes.cooldown=.8;
  player.launchTimer=0;player.launchCooldown=0;
  player.in2DMode=false;player.sideCamera=false;
  player.heading=heading;
  player.lastSafe=[...player.position];
  player.resetCamera();
  mission.previous=[...player.position];
  if (message) toast(message);
}

function respawn() {
  player.ringCount=0;player.score=0;
  // Use a terrain-safe point captured when the source checkpoint was reached.
  if (mission.checkpoint && checkpointState?.id===mission.checkpoint.id) {
    respawnTo(checkpointState.position,'Back to checkpoint',checkpointState.heading,true);
  } else {
    respawnTo(manifest.browserSpawn||manifest.spawn,'Back to start',(manifest.yaw-90)*Math.PI/180);
  }
  const collected=new Set(checkpointState?.collected||[]);
  scene.objects.forEach((object,index)=>{object.collected=collected.has(index);});
  status.goal=false;status.rings=player.ringCount;
}

function restartMission() {
  checkpointState=null;scene.objects.forEach(object=>{object.collected=false;});
  player.ringCount=0;player.score=0;status.rings=0;status.goal=false;
  respawnTo(manifest.browserSpawn||manifest.spawn,null,(manifest.yaw-90)*Math.PI/180);
  mission.retry(player.position);handleMissionEvents();saveProgress();
}

let missionUiState=null;
function handleMissionEvents() {
  const events=mission.drainEvents();
  for (const event of events) {
    if (event.type==='checkpoint') {
      checkpointState={id:event.checkpoint.id,
        position:[...(player.grounded?player.position:(player.lastSafe||player.position))],
        heading:player.heading,collected:scene.objects.flatMap((object,index)=>object.collected?[index]:[])};
      effect('checkpoint');
      showCheckpointBanner();
      showChipHint("Nice job reaching the checkpoint! If you take a hit or fall, you'll respawn right here.", 5.0);
      toast('Checkpoint reached');
      saveProgress();
    } else if (event.type==='respawn') {
      respawn();
      saveProgress();
    } else if (event.type==='mode_change') {
      player.in2DMode = (event.mode === '2D');
      player.sideCamera = player.in2DMode && event.changeCamera;
      toast(event.mode === '2D' ? '2D Section' : '3D Section', 1.2);
    } else if (event.type==='complete') {
      try {
        const progression = JSON.parse(localStorage.getItem('unleashed-progression') || '[]');
        const progSet = new Set(progression);
        progSet.add(manifest.stage);
        progSet.add(mission.definition.id);
        if (event.result.nextMission) progSet.add(event.result.nextMission);
        localStorage.setItem('unleashed-progression', JSON.stringify([...progSet]));

        const clears = JSON.parse(localStorage.getItem('unleashed-completions') || '{}');
        const old = clears[manifest.stage];
        const rankOrder = ['E', 'D', 'C', 'B', 'A', 'S'];
        const bestRank = (old?.bestRank && rankOrder.indexOf(old.bestRank) > rankOrder.indexOf(event.result.rank))
          ? old.bestRank
          : event.result.rank;
        clears[manifest.stage] = {
          bestTime: Math.min(old?.bestTime ?? Infinity, event.result.elapsed),
          bestScore: Math.max(old?.bestScore ?? 0, event.result.score),
          bestRank,
          clears: (old?.clears || 0) + 1,
          last: event.result,
        };
        localStorage.setItem('unleashed-completions', JSON.stringify(clears));
      } catch {}
    }
  }
  const state=mission.state;
  if (state===missionUiState && !events.length) return;
  missionUiState=state;
  $('mission-intro').hidden=state!==MissionState.INTRO;
  const phase = $('mission-phase');
  if (phase) {
    const bannerText = phase.querySelector('.go-banner-text');
    const beadRing = phase.querySelector('.rainbow-bead-ring');
    if (state === MissionState.READY) {
      if (bannerText) bannerText.textContent = 'READY';
      if (beadRing) beadRing.hidden = true;
      phase.hidden = false;
    } else if (state === MissionState.COMPLETE) {
      if (bannerText) bannerText.textContent = 'STAGE CLEAR';
      if (beadRing) beadRing.hidden = true;
      phase.hidden = false;
    } else if (state === MissionState.RESPAWNING) {
      if (bannerText) bannerText.textContent = mission.failureReason || 'TRY AGAIN';
      if (beadRing) beadRing.hidden = true;
      phase.hidden = false;
    } else if (state === MissionState.FAILED) {
      if (bannerText) bannerText.textContent = mission.failureReason || 'MISSION FAILED';
      if (beadRing) beadRing.hidden = true;
      phase.hidden = false;
    } else if (state !== MissionState.PLAYING) {
      phase.hidden = true;
    }
  }
  $('mission-results').hidden=state!==MissionState.RESULTS;
  $('death-fade').hidden=state!==MissionState.RESPAWNING;

  if (state === MissionState.RESULTS) {
    const res = mission.result;
    $('mission-results-title').textContent = res?.success ? 'STAGE CLEAR' : 'MISSION FAILED';
    const rank = res?.rank || 'E';
    const rankBadge = $('result-rank-badge');
    if (rankBadge) {
      rankBadge.textContent = rank;
      rankBadge.className = `rank-badge rank-${rank.toLowerCase()}`;
    }
    $('result-time').textContent = clockWithCentiseconds(res?.elapsed || 0);
    $('result-time-bonus').textContent = `+${(res?.timeBonus || 0).toLocaleString()}`;
    $('result-rings').textContent = String(res?.rings || 0);
    $('result-ring-bonus').textContent = `+${(res?.ringBonus || 0).toLocaleString()}`;
    $('result-enemies').textContent = String(res?.defeated || 0);
    $('result-enemy-bonus').textContent = `+${(res?.enemyBonus || 0).toLocaleString()}`;
    $('result-total-score').textContent = (res?.score || 0).toLocaleString();

    if (res?.success) {
      $('result-detail').textContent = rank === 'S'
        ? 'Browser challenge S rank · No deaths.'
        : `Browser challenge rank ${rank}.`;
    } else {
      $('result-detail').textContent = res?.reason || 'Mission failed';
    }

    const nextBtn = $('mission-next');
    if (nextBtn) {
      nextBtn.hidden = !(res?.success && res?.nextMission);
    }
    $('mission-resume').hidden = Boolean(res?.success) || mission.lives <= 0;
  }
}

function saveProgress() {
  if (!player || !scene || !mission || !player.lastSafe) return;
  try {
    localStorage.setItem('unleashed-progress',JSON.stringify({version:2,stage:manifest.stage,
      position:player.grounded?player.position:player.lastSafe,heading:player.heading,
      rings:player.ringCount,score:player.score,elapsed:mission.elapsed,mission:mission.snapshot(),checkpointState,
      collected:scene.objects.flatMap((object,index)=>object.collected?[index]:[])}));
  } catch {}
}

boot().catch(fail);
