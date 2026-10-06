// CSD semantics informed by SharpNeedle and Kunai. See THIRD_PARTY.md.
const white = () => [1, 1, 1, 1];
const mul = (a, b) => a.map((v, i) => v * b[i]);
const mix = (a, b, t) => Array.isArray(a) ? a.map((v, i) => v + (b[i] - v) * t) : a + (b - a) * t;

export function sampleTrack(keys, frame, property) {
  if (!keys.length) return undefined;
  if (frame <= keys[0][0]) return keys[0][1];
  if (frame >= keys.at(-1)[0]) return keys.at(-1)[1];
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid][0] <= frame) lo = mid; else hi = mid;
  }
  const a = keys[lo], b = keys[hi], dt = b[0] - a[0];
  const t = dt ? (frame - a[0]) / dt : 0;
  if (property === 0) return a[1];
  if (property >= 7) return mix(a[1], b[1], t);
  if (a[2] === 0) return a[1];
  if (a[2] === 1) return mix(a[1], b[1], t);
  if (a[2] !== 2) throw new Error(`Unsupported CSD interpolation ${a[2]}`);
  const delta = b[1] - a[1];
  // The file stores both segment tangents on the first key.
  return (((a[4] + a[3]) * dt - 2 * delta) * t * t * t
    + (3 * delta - (2 * a[3] + a[4]) * dt) * t * t
    + a[3] * dt * t + a[1]);
}

function applyProperty(info, property, value) {
  if (value === undefined) return;
  if (property === 0) info.hidden = Boolean(value);
  else if (property <= 2) info.translation[property - 1] = value;
  else if (property === 3) info.rotation = value;
  else if (property <= 5) info.scale[property - 4] = value;
  else if (property === 6) info.sprite = value;
  else if (property === 7) info.color = value;
  else info.gradients[property - 8] = value;
}

export function poseScene(scene, motions = [], overrides = {}) {
  const poses = scene.groups.map(g => g.casts.map(c => ({...c.info,
    translation: [...c.info.translation], scale: [...c.info.scale],
    color: [...c.info.color], gradients: c.info.gradients.map(x => [...x])})));
  for (const {name, frame} of motions) {
    const motion = scene.motions.find(m => m.name === name);
    if (!motion) throw new Error(`Missing motion ${scene.name}/${name}`);
    for (const t of motion.tracks) applyProperty(poses[t.group][t.cast], t.property, sampleTrack(t.keys, frame, t.property));
  }
  const resolved = scene.groups.map(() => []);
  for (let gi = 0; gi < scene.groups.length; gi++) {
    const group = scene.groups[gi];
    const resolve = ci => {
      if (resolved[gi][ci]) return resolved[gi][ci];
      const c = group.casts[ci], p = poses[gi][ci];
      const override = overrides[c.name];
      if (override) Object.assign(p, override);
      const parentIndex = group.parents[ci];
      const parent = parentIndex >= 0 ? resolve(parentIndex) : {
        translation: [0, 0], scale: [1, 1], rotation: 0, color: white(), hidden: false};
      const angle = parent.rotation * Math.PI / 180;
      const x = p.translation[0] * parent.scale[0] * scene.aspect;
      const y = p.translation[1] * parent.scale[1];
      p.translation = [(x * Math.cos(angle) + y * Math.sin(angle)) / scene.aspect + c.origin[0],
        y * Math.cos(angle) - x * Math.sin(angle) + c.origin[1]];
      if (c.inherit & 0x100) p.translation[0] += parent.translation[0];
      if (c.inherit & 0x200) p.translation[1] += parent.translation[1];
      if (c.inherit & 2) p.rotation += parent.rotation;
      if (c.inherit & 0x400) p.scale[0] *= parent.scale[0];
      if (c.inherit & 0x800) p.scale[1] *= parent.scale[1];
      if (c.inherit & 8) p.color = mul(p.color, parent.color);
      if (!(c.mask & 1)) p.translation = [0, 0];
      else {
        if (!(c.mask & 2)) p.translation[0] = 0;
        if (!(c.mask & 4)) p.translation[1] = 0;
      }
      if (!(c.mask & 8)) p.rotation = 0;
      if (!(c.mask & 16)) p.scale[0] = 1;
      if (!(c.mask & 32)) p.scale[1] = 1;
      if (!(c.mask & 128)) p.color = white();
      for (let k = 0; k < 4; k++) if (!(c.mask & (256 << k))) p.gradients[k] = white();
      p.hidden = Boolean(p.hidden || parent.hidden || !c.enabled);
      resolved[gi][ci] = p;
      return p;
    };
    group.casts.forEach((_, ci) => resolve(ci));
  }
  return resolved;
}

export function buildQuads(scene, poses, textures) {
  const quads = [];
  scene.groups.forEach((group, gi) => group.casts.forEach((cast, ci) => {
    const p = poses[gi][ci];
    if (p.hidden || cast.type === 0) return;
    if (cast.type !== 1) throw new Error(`Unsupported font cast ${cast.name}`);
    let uv = [0, 0, 1, 1], texture = null;
    if (p.sprite >= 0) {
      const index = Math.min(cast.indices.length - 1, Math.floor(p.sprite));
      const next = Math.min(cast.indices.length - 1, index + 1);
      let a = scene.sprites[cast.indices[index]], b = scene.sprites[cast.indices[next]];
      a ||= b; b ||= a;
      if (a && b) {
        texture = textures[a.texture];
        if (!texture) throw new Error(`Missing texture for ${cast.name}`);
        uv = mix(a.uv, b.uv, p.sprite % 1);
      }
    }
    if (cast.material & 0x400) [uv[0], uv[2]] = [uv[2], uv[0]];
    if (cast.material & 0x800) [uv[1], uv[3]] = [uv[3], uv[1]];
    const angle = p.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    const points = cast.corners.map(([cx, cy]) => {
      const x = cx * p.scale[0] * scene.aspect, y = cy * p.scale[1];
      return [(x * cos + y * sin) / scene.aspect + p.translation[0],
        y * cos - x * sin + p.translation[1]];
    });
    const colors = p.gradients.map(g => mul(p.color, g));
    if (colors.every(c => c[3] <= 0)) return;
    quads.push({name: cast.name, group: gi, cast: ci, points, uv, colors, texture,
      additive: Boolean(cast.material & 1), linear: Boolean(cast.material & 0x1000)});
  }));
  return quads;
}
