// Deterministic detail scatter on the original grass terrain, never paved roads.
export function isWater(material = {}, flags = 0) {
  return Boolean((flags | (material.flags || 0)) & 8);
}

export function grassSurface(material = {}) {
  const name = material.name || '';
  return /grass|lawn|rawn/i.test(name) && !/plant|leaf|foliage/i.test(name)
    && !isWater(material) && !(material.flags & 3);
}

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function scatterGrass(chunk, materials, limit = 16000) {
  const {positions: p, indices: indices} = chunk;
  const instances = [];
  const name = chunk.chunk?.name || '';
  let seed = 2166136261;
  for (const ch of name) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
  const rand = random(seed);
  for (const primitive of chunk.primitives) {
    if (!grassSurface(materials[primitive.material]) || (primitive.flags & 3)) continue;
    for (let t = primitive.indexStart; t < primitive.indexStart + primitive.indexCount; t += 3) {
      const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
      const ab = [p[b]-p[a], p[b+1]-p[a+1], p[b+2]-p[a+2]];
      const ac = [p[c]-p[a], p[c+1]-p[a+1], p[c+2]-p[a+2]];
      const normal = [ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]];
      const length = Math.hypot(...normal);
      if (!length || normal[1] / length < .72) continue;
      const density = length * .5 * 2.4;
      const samples = Math.min(1200, Math.floor(density) + (rand() < density % 1 ? 1 : 0));
      for (let j = 0; j < samples && instances.length / 6 < limit; j++) {
        const u = Math.sqrt(rand()), v = rand();
        const weights = [1-u, u*(1-v), u*v];
        for (let axis = 0; axis < 3; axis++) instances.push(p[a+axis]*weights[0]+p[b+axis]*weights[1]+p[c+axis]*weights[2]);
        instances.push(.30 + rand() * .32, rand() * Math.PI * 2, rand() < .035 ? 1 + Math.floor(rand()*2) : 0);
      }
    }
  }
  return new Float32Array(instances);
}
