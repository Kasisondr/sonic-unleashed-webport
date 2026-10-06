import {poseScene, buildQuads} from './csd-runtime.mjs';
import {MenuRenderer} from './renderer.mjs';
import {MenuAudio} from './audio.mjs';
import {Cinematics} from './cinematics.mjs';

const $ = id => document.getElementById(id);
let renderer, audio, projects, textures, manifest;
let state = 'title', selected = 0, entered = performance.now(), ready = false, stopped = false;
let lastInput = 0, previousButtons = [], toastTimer;
const options = ['New game', 'Continue', 'Options', 'Music', 'Sound'];
const status = {gameBooted: false, guestMenuLogicExecuted: false, renderer: 'WebGL2', state: 'loading', frames: 0, drawCalls: 0, errors: []};
let labelSprites = [], hitboxes = [], movies, movieReturn = 'title', pendingStage = null;
let lastActivity = performance.now();
function modalOpen() { return $('options').open || $('scene-select').open; }
function activity() { lastActivity = performance.now(); }
function launch(stage, resume = false, missionId = null) {
  try { localStorage.setItem('unleashed-last-stage', stage); } catch {}
  const missionParam = missionId ? `&mission=${encodeURIComponent(missionId)}` : '';
  location.href = `play.html?stage=${encodeURIComponent(stage)}${resume ? "&continue=1" : ""}${missionParam}`;
}
function cinematic(roles, next = 'title', stage = null) {
  movieReturn = next; pendingStage = stage;
  state = 'cinematic'; audio.stopMusic();
  $('enter').hidden = true; $('actions').hidden = true;
  movies.play(roles, {muted: !audio.enabled, volume: audio.volume});
}
async function chooseScene() {
  activity();
  try {
    const [catalog, missionsData] = await Promise.all([
      json('game/catalog.json'),
      json('game/missions.json').catch(() => null),
    ]);
    let clears = {}, progression = [];
    try { clears = JSON.parse(localStorage.getItem('unleashed-completions') || '{}'); } catch {}
    try { progression = JSON.parse(localStorage.getItem('unleashed-progression') || '[]'); } catch {}

    $('scene-list').replaceChildren();
    for (const kind of ['act', 'town']) {
      const entries = catalog.scenes.filter(scene => scene.kind === kind);
      if (!entries.length) continue;
      const heading = document.createElement('h3');
      heading.textContent = kind === 'act' ? 'Daytime Stages & Missions' : 'Towns';
      $('scene-list').append(heading);
      for (const scene of entries) {
        const stageClear = clears[scene.id];
        const rankBadge = stageClear?.bestRank ? ` [Challenge rank ${stageClear.bestRank}]` : '';
        const timeBadge = stageClear?.bestTime && Number.isFinite(stageClear.bestTime)
          ? ` (${Math.floor(stageClear.bestTime / 60)}:${String(Math.floor(stageClear.bestTime % 60)).padStart(2, '0')})`
          : '';

        const button = document.createElement('button');
        button.textContent = `${scene.title}${rankBadge}${timeBadge}`;
        button.addEventListener('click', () => { sound('decide'); launch(scene.id); });
        $('scene-list').append(button);

        // If this daytime scene has extra mission variants:
        if (kind === 'act' && missionsData?.scenes?.[scene.id]?.missions?.length) {
          const variantContainer = document.createElement('div');
          variantContainer.className = 'scene-mission-variants';
          variantContainer.style.display = 'flex';
          variantContainer.style.flexWrap = 'wrap';
          variantContainer.style.gap = '4px';
          variantContainer.style.margin = '2px 0 8px 16px';

          for (const mId of missionsData.scenes[scene.id].missions) {
            const mDef = missionsData.missions?.[mId];
            if (!mDef) continue;
            const subButton = document.createElement('button');
            subButton.style.fontSize = '12px';
            subButton.style.padding = '4px 10px';
            subButton.style.background = '#0a3556';
            subButton.textContent = `★ Browser challenge: ${mDef.missionTitle || mDef.title}`;
            subButton.addEventListener('click', () => { sound('decide'); launch(scene.id, false, mId); });
            variantContainer.append(subButton);
          }
          $('scene-list').append(variantContainer);
        }
      }
    }
    $('scene-select').showModal();
  } catch (error) { notify(error.message); }
}

function notify(message) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
  toastTimer = setTimeout(() => $('toast').hidden = true, 4000);
}
function fail(error) {
  status.errors.push(String(error));
  $('diagnostics').dataset.errors = status.errors.length;
  $('load-status').textContent = `Menu could not load: ${error.message}`;
  $('loading').hidden = false; stopped = true; console.error(error);
}
function sound(name) { audio.effect(name).catch(error => notify(`Sound unavailable: ${error.message}`)); }
async function enableSound() {
  if (!ready) return;
  try {
    if (!await audio.unlock()) throw new Error('Audio remains paused. Try the sound button.');
    $('audio').setAttribute('aria-pressed', 'true'); $('audio').textContent = 'Mute sound';
    if (state === 'cinematic') { $('movie').muted = false; $('movie').volume = audio.volume; }
    else await audio.playMusic(state === 'title' ? 'title' : 'menu');
    status.audio = {state: audio.context.state, track: audio.track, volume: audio.volume};
  } catch (error) { notify(error.message); }
}
function changeState(next) {
  if (!ready || state === next) return;
  state = next; status.state = next; entered = performance.now();
  $('back').disabled = state === 'title'; $('enter').hidden = state !== 'title';
  $('actions').hidden = state === 'title';
  $('help').textContent = state === 'title' ? 'Enter / A to open · Escape / B to return'
    : 'Arrows / D-pad to move · Enter / A to select · Escape / B to return';
  if (audio.enabled) audio.playMusic(state === 'title' ? 'title' : 'menu').catch(error => notify(error.message));
}
function enterMenu() {
  activity();
  if (state === 'cinematic') { movies.skip(); return; }
  if (!ready || modalOpen()) return;
  enableSound().then(() => sound('start')); selected = 0; changeState('menu'); updateSelection();
}
function back() {
  activity();
  if (state === 'cinematic') { movies.skip(); return; }
  if ($('scene-select').open) { $('scene-select').close(); return; }
  if ($('options').open) { $('options').close(); sound('back'); return; }
  if (state !== 'title') { sound('back'); changeState('title'); }
}
function updateSelection() {
  [...$('actions').children].forEach((button, i) => button.setAttribute('aria-current', String(selected === i)));
  status.selected = options[selected];
}
function move(direction) {
  activity();
  if (!ready || state === 'title' || state === 'cinematic' || modalOpen()) return;
  selected = (selected + direction + options.length) % options.length;
  updateSelection(); sound('cursor');
}
function select() {
  activity();
  if (state === 'cinematic') { movies.skip(); return; }
  if (!ready || modalOpen()) return;
  if (state === 'title') { enterMenu(); return; }
  if (options[selected] === 'Options') { sound('decide'); $('options').showModal(); }
  else if (options[selected] === 'Music') {
    audio.musicEnabled = !audio.musicEnabled;
    if (audio.musicEnabled) {
      enableSound();
    } else audio.stopMusic();
    sound('decide'); notify(`Music ${audio.musicEnabled ? 'on' : 'off'}`);
  }
  else if (options[selected] === 'Sound') {
    audio.effectsEnabled = !audio.effectsEnabled;
    if (audio.effectsEnabled) { enableSound().then(() => sound('decide')); }
    notify(`Sound effects ${audio.effectsEnabled ? 'on' : 'off'}`);
  }
  else if (options[selected] === 'New game') {
    try { localStorage.removeItem('unleashed-progress'); } catch {}
    enableSound().then(() => { sound('decide'); cinematic(['opening'], 'play', 'ActD_MykonosAct1'); });
  } else if (options[selected] === 'Continue') {
    let saved;
    try { saved = localStorage.getItem('unleashed-last-stage'); } catch {}
    if (saved) launch(saved, true); else chooseScene();
  }
}
$('enter').addEventListener('click', enterMenu);
$('stages').addEventListener('click', chooseScene);
$('demo').addEventListener('click', () => cinematic(['attract'], state));
$('skip-movie').addEventListener('click', () => movies.skip());
$('close-scenes').addEventListener('click', () => $('scene-select').close());
$('back').addEventListener('click', back);
$('audio').addEventListener('click', async () => {
  if (!audio.enabled) await enableSound();
  else { audio.stopMusic(); audio.enabled = false; $('movie').muted = true; await audio.pause(); $('audio').setAttribute('aria-pressed','false'); $('audio').textContent='Enable sound'; }
});
$('volume').addEventListener('input', () => {
  audio?.setVolume(Number($('volume').value) / 100);
  $('movie').volume = Number($('volume').value) / 100;
  try { localStorage.setItem('unleashed-menu-volume', $('volume').value); } catch {}
});
$('fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('stage').requestFullscreen().catch(error => notify(error.message));
});
$('close-options').addEventListener('click', back);
$('screen').addEventListener('click', event => {
  if (state === 'title') { enterMenu(); return; }
  const rect = $('screen').getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height;
  const index = hitboxes.findIndex(b => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]);
  if (index >= 0) { selected=index; updateSelection(); select(); }
});
document.addEventListener('keydown', event => {
  if (event.target.tagName === 'INPUT') return;
  activity();
  if (event.target.tagName === 'BUTTON' && ['Enter',' '].includes(event.key)) return;
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!event.repeat) select(); }
  if (event.key === 'Escape') { event.preventDefault(); back(); }
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); move(1); }
  if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
});
document.addEventListener('visibilitychange', () => {
  const promise = document.hidden ? audio?.pause() : audio?.resume();
  promise?.catch(error => console.error(error));
});
$('screen').addEventListener('webglcontextlost', event => { event.preventDefault(); fail(new Error('Graphics context was lost. Reload to restore the menu.')); });

function gamepad(now) {
  const pad = navigator.getGamepads?.()[0]; if (!pad) return;
  const pressed = pad.buttons.map(b => b.pressed);
  if ((pressed[0] && !previousButtons[0]) || (pressed[9] && !previousButtons[9])) select();
  if (pressed[1] && !previousButtons[1]) back();
  if (now - lastInput > 180) {
    const direction = pressed[13] || pad.axes[1] > .5 ? 1 : pressed[12] || pad.axes[1] < -.5 ? -1 : 0;
    if (direction) { move(direction); lastInput = now; }
  }
  previousButtons = pressed;
}

function scene(project, name, motions, overrides = {}) {
  const s = projects[project].scenes.find(s => s.name === name);
  if (!s) throw new Error(`Missing scene ${name}`);
  const pose = poseScene(s, motions, overrides);
  renderer.draw(buildQuads(s, pose, textures[project]));
}
function cycle(project, name, motion, seconds) {
  const s = projects[project].scenes.find(s => s.name === name);
  const m = s.motions.find(m => m.name === motion);
  return {name: motion, frame: m.start + (seconds * s.fps % Math.max(1, m.end - m.start))};
}
function rectQuad(texture, uv, x, y, w, h, color = [1,1,1,1]) {
  return {texture, uv, points:[[x,y],[x,y+h],[x+w,y],[x+w,y+h]],
    colors:[color,color,color,color],additive:false,linear:true};
}
function drawMenuLabels() {
  hitboxes = [];
  const quads = [];
  for (let i=0; i<options.length; i++) {
    const y = .1875 + i / 9, label = labelSprites[i];
    const meta = manifest.textures[projects.title.textures[label.texture]];
    const width = (label.uv[2]-label.uv[0])*meta.width / 1280;
    const height = (label.uv[3]-label.uv[1])*meta.height / 720;
    quads.push(rectQuad(textures.title[label.texture],label.uv,.66-width/2,y-height/2,width,height,
      i === selected ? [1,1,1,1] : [.72,.76,.78,1]));
    hitboxes.push([.365,y-.045,.965,y+.045]);
  }
  // Original English navigation footer, replacing the Japanese atlas region.
  quads.push(rectQuad(textures.mainmenu[1],[0, .9, 1, 1],0,.9111,1,.0889));
  renderer.draw(quads);
}
function animate(now) {
  if (stopped) return;
  try {
    if (!document.hidden) {
      gamepad(now); const seconds = (now - entered) / 1000;
      if (state === 'title' && !modalOpen() && now - lastActivity > 30000) cinematic(['attract']);
      renderer.begin();
      if (state === 'menu') {
        for (const name of ['mm_base','mm_bg_usual','mm_donut_idle']) {
          scene('mainmenu', name, [cycle('mainmenu', name, 'DefaultAnim', seconds)]);
        }
        const bars = projects.mainmenu.scenes.find(s=>s.name==='mm_contentsitem_idle');
        const positions = bars.groups.slice(1,6).map(g=>g.casts[0].info.translation);
        const overrides = {
          index_bar3:{translation:positions[selected]},
          [`index_bar${selected+1}`]:{translation:positions[2]},
          index_light_a:{translation:[.4125,.4111+(selected-2)/9]},
          index_light_b:{translation:[.391406,.4111+(selected-2)/9]}
        };
        if (selected===2) overrides.index_bar3={translation:positions[2]};
        scene('mainmenu','mm_contentsitem_idle',[cycle('mainmenu','mm_contentsitem_idle','DefaultAnim',seconds)],overrides);
        for (const name of ['mm_title_usual','mm_front_usual']) scene('mainmenu',name,[cycle('mainmenu',name,'DefaultAnim',seconds)]);
        drawMenuLabels();
      } else if (state !== 'cinematic') {
        scene('title', 'bg', [cycle('title', 'bg', 'Usual_Anim_2', seconds)]);
        scene('title', 'title_1', [{name:'Intro_Anim_1',frame:80},cycle('title','title_1','Usual_Anim_1',seconds)]);
        scene('title', 'menu', [cycle('title','menu',state === 'title' ? 'Usual_Anim_1' : 'Usual_Anim_2',seconds)]);
      }
      status.frames++; status.drawCalls = renderer.drawCalls;
      status.audio = audio.context ? {state:audio.context.state,track:audio.track,volume:audio.volume} : {state:'locked'};
      if (status.frames % 6 === 0) {
        Object.assign($('diagnostics').dataset, {state,frames:String(status.frames),drawCalls:String(status.drawCalls),
          audioState:status.audio.state,audioTrack:status.audio.track || '',audioRms:String(audio.rms()),
          selected:options[selected],gameBooted:'false',musicEnabled:String(audio.musicEnabled),effectsEnabled:String(audio.effectsEnabled)});
      }
    }
  } catch (error) { fail(error); return; }
  requestAnimationFrame(animate);
}
async function json(path) { const r = await fetch(path); if (!r.ok) throw new Error(`${path} (${r.status})`); return r.json(); }
async function boot() {
  renderer = new MenuRenderer($('screen'));
  [manifest, projects] = await Promise.all([json('assets/manifest.json'),
    Promise.all([json('assets/title.json'),json('assets/mainmenu.json')]).then(([title,mainmenu]) => ({title,mainmenu}))]);
  const all = new Map();
  await Promise.all(Object.entries(manifest.textures).map(async ([name,meta]) => {
    const response = await fetch(`assets/${meta.file}`);
    if (!response.ok) throw new Error(`Menu texture ${meta.file}: HTTP ${response.status}`);
    let image;
    try { image = await createImageBitmap(await response.blob(), {premultiplyAlpha: 'none', colorSpaceConversion: 'none'}); }
    catch (error) { throw new Error(`Menu texture ${meta.file}: ${error.message}`); }
    all.set(name, renderer.upload(image)); image.close();
  }));
  textures = Object.fromEntries(Object.entries(projects).map(([key,p]) => [key,p.textures.map(name => all.get(name))]));
  const textScene = projects.title.scenes.find(s=>s.name==='txt');
  labelSprites = ['new_game','continue','option','bgm','sound'].map(name => {
    const cast=textScene.groups.flatMap(g=>g.casts).find(c=>c.name===name);
    return textScene.sprites[cast.indices[0]];
  });
  let volume = 50;
  try { const saved = Number(localStorage.getItem('unleashed-menu-volume')); if (localStorage.getItem('unleashed-menu-volume') !== null && Number.isFinite(saved)) volume = Math.max(0,Math.min(100,saved)); } catch {}
  $('volume').value = volume; audio = new MenuAudio(manifest.audio, volume / 100);
  options.forEach((name,i) => {
    const button = document.createElement('button'); button.textContent = name;
    button.addEventListener('click', () => { selected=i; updateSelection(); select(); });
    $('actions').append(button);
  });
  movies = new Cinematics($('movie'), $('cinema'), () => {
    activity();
    if (movieReturn === 'play' && pendingStage) { launch(pendingStage); return; }
    changeState(movieReturn);
  }, notify);
  $('movie').addEventListener('timeupdate', () => {
    Object.assign($('diagnostics').dataset, {movie: $('movie').dataset.movie, movieTime: $('movie').currentTime.toFixed(2)});
  });
  ready = true; status.state = 'title'; entered = performance.now();
  $('loading').hidden = true; $('enter').disabled = false; $('audio').disabled = false;
  $('stages').disabled = false; $('demo').disabled = false;
  updateSelection(); requestAnimationFrame(animate);
  const params = new URLSearchParams(location.search);
  if (params.has('menu')) {
    changeState('menu');
    if (params.has('select')) chooseScene();
  } else cinematic(['sega','engine']);
}
boot().catch(fail);
