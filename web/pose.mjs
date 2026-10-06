// Skinned pose engine for Sonic: replays the disc animations baked by
// tools/prepare_sonic_anims.py and writes the skinning matrices the shader wants.
//
// Layout notes that keep this small:
//   * one animation is a dense block of `bones` records of 14 bytes — a quantised
//     quaternion (4 x int16) and a quantised translation (3 x int16). The
//     manifest's `offset` and `stride` are therefore *byte* offsets, and the
//     bank is little-endian, so it is read through a DataView rather than an
//     Int16Array (which would index by elements and read every other value);
//   * `parents` is the model's own bone hierarchy and `order` lists every bone
//     parent-before-child, so the rig composes in one pass;
//   * a bone's skinning matrix is `world(animation) * inverseBind`, exactly the
//     convention the character exporter found in the model file.

const FADE_SECONDS = 0.14;

/** Column-major 4x4 multiply: out[offset..] = a * b. */
function multiply4(out, offset, a, aOffset, b, bOffset) {
  for (let column = 0; column < 4; column++) {
    const base = column * 4;
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[aOffset + k * 4 + row] * b[bOffset + base + k];
      out[offset + base + row] = sum;
    }
  }
}

/** Quaternion product out = a * b, both stored as (x, y, z, w). */
function multiplyQuaternion(out, outOffset, a, aOffset, b, bOffset) {
  const ax = a[aOffset], ay = a[aOffset + 1], az = a[aOffset + 2], aw = a[aOffset + 3];
  const bx = b[bOffset], by = b[bOffset + 1], bz = b[bOffset + 2], bw = b[bOffset + 3];
  out[outOffset] = aw * bx + ax * bw + ay * bz - az * by;
  out[outOffset + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[outOffset + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[outOffset + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** Normalise the four quaternion components starting at `at`. */
function normalise(values, at) {
  const x = values[at], y = values[at + 1], z = values[at + 2], w = values[at + 3];
  const length = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
  values[at] = x / length; values[at + 1] = y / length;
  values[at + 2] = z / length; values[at + 3] = w / length;
}

/** Write the column-major transform of (translation, rotation) into `matrix`. */
function toMatrix(matrix, tx, ty, tz, q, at) {
  const x = q[at], y = q[at + 1], z = q[at + 2], w = q[at + 3];
  matrix[0] = 1 - 2 * (y * y + z * z); matrix[1] = 2 * (x * y + z * w); matrix[2] = 2 * (x * z - y * w); matrix[3] = 0;
  matrix[4] = 2 * (x * y - z * w); matrix[5] = 1 - 2 * (x * x + z * z); matrix[6] = 2 * (y * z + x * w); matrix[7] = 0;
  matrix[8] = 2 * (x * z + y * w); matrix[9] = 2 * (y * z - x * w); matrix[10] = 1 - 2 * (x * x + y * y); matrix[11] = 0;
  matrix[12] = tx; matrix[13] = ty; matrix[14] = tz; matrix[15] = 1;
}

export class Rig {
  constructor(manifest, character, data) {
    this.manifest = manifest;
    this.data = new DataView(data);
    this.count = manifest.bones;
    this.stride = manifest.stride;
    this.frameBytes = this.count * this.stride;
    this.positionScale = manifest.positionScale;
    this.quaternionScale = manifest.quaternionScale;
    this.parents = manifest.parents;
    this.order = manifest.order;
    this.animations = manifest.animations;
    // Model transforms map mesh-space vertices into each bone's bind space.
    // A rotated inverse bind can have its translation on -X while its bone
    // sits at +Y; that is a normal consequence of the inverse rotation.
    this.bind = new Float32Array(this.count * 16);
    character.bones.forEach((bone, index) => {
      const matrix = bone.transform, at = index * 16;
      for (let row = 0; row < 4; row++) {
        for (let column = 0; column < 4; column++) this.bind[at + column * 4 + row] = matrix[row][column];
      }
    });
    this.localT = new Float32Array(this.count * 3);
    this.localR = new Float32Array(this.count * 4);
    this.mixT = new Float32Array(this.count * 3);
    this.mixR = new Float32Array(this.count * 4);
    this.worldT = new Float32Array(this.count * 3);
    this.worldR = new Float32Array(this.count * 4);
    this.nextT = new Float32Array(this.count * 3);
    this.nextR = new Float32Array(this.count * 4);
    this.fromT = new Float32Array(this.count * 3);
    this.fromR = new Float32Array(this.count * 4);
    this.matrix = new Float32Array(16);
    this.quaternion = new Float32Array(4);
    this.skin = new Float32Array(this.count * 16);
    // Until an animation runs the mesh must keep its bind pose, so seed the
    // matrices with the identity and let the first update overwrite them.
    this.state = null;
    this.time = 0;
    this.fade = 0;
    this.reset();

  }

  reset() {
    for (let index = 0; index < this.count; index++) {
      const at = index * 16;
      this.skin[at] = 1; this.skin[at + 5] = 1; this.skin[at + 10] = 1; this.skin[at + 15] = 1;
      const t = index * 3, r = index * 4;
      this.localT[t] = this.localT[t + 1] = this.localT[t + 2] = 0;
      this.localR[r] = this.localR[r + 1] = this.localR[r + 2] = 0; this.localR[r + 3] = 1;
      this.worldT[t] = this.worldT[t + 1] = this.worldT[t + 2] = 0;
      this.worldR[r] = this.worldR[r + 1] = this.worldR[r + 2] = 0; this.worldR[r + 3] = 1;
    }
  }

  /** Read one animation frame straight from the quantised bank. */
  readFrame(spec, frame, translation, rotation) {
    // Offsets and stride are byte counts, so the bank is read as bytes.
    const base = spec.offset + frame * this.frameBytes;
    const data = this.data;
    for (let bone = 0; bone < this.count; bone++) {
      const at = base + bone * this.stride, out = bone * 3, outRotation = bone * 4;
      rotation[outRotation] = data.getInt16(at, true) / this.quaternionScale;
      rotation[outRotation + 1] = data.getInt16(at + 2, true) / this.quaternionScale;
      rotation[outRotation + 2] = data.getInt16(at + 4, true) / this.quaternionScale;
      rotation[outRotation + 3] = data.getInt16(at + 6, true) / this.quaternionScale;
      normalise(rotation, outRotation);
      translation[out] = data.getInt16(at + 8, true) / this.positionScale;
      translation[out + 1] = data.getInt16(at + 10, true) / this.positionScale;
      translation[out + 2] = data.getInt16(at + 12, true) / this.positionScale;
    }
  }

  /** Compose the rig: `order` visits every parent first, so one pass suffices. */
  compose(translation, rotation, worldT, worldR) {
    const {parents, order} = this;
    for (let index = 0; index < order.length; index++) {
      const bone = order[index], parent = parents[bone], at = bone * 3, r = bone * 4;
      const x = translation[at], y = translation[at + 1], z = translation[at + 2];
      const qx = rotation[r], qy = rotation[r + 1], qz = rotation[r + 2], qw = rotation[r + 3];
      if (parent < 0) {
        worldT[at] = x; worldT[at + 1] = y; worldT[at + 2] = z;
        worldR[r] = qx; worldR[r + 1] = qy; worldR[r + 2] = qz; worldR[r + 3] = qw;
        continue;
      }
      const p = parent * 3, pr = parent * 4;
      const px = worldR[pr], py = worldR[pr + 1], pz = worldR[pr + 2], pw = worldR[pr + 3];
      // world = parent position + rotate(parent rotation, child translation)
      const tx = 2 * (py * z - pz * y), ty = 2 * (pz * x - px * z), tz = 2 * (px * y - py * x);
      worldT[at] = worldT[p] + x + pw * tx + py * tz - pz * ty;
      worldT[at + 1] = worldT[p + 1] + y + pw * ty + pz * tx - px * tz;
      worldT[at + 2] = worldT[p + 2] + z + pw * tz + px * ty - py * tx;
      this.quaternion[0] = qx; this.quaternion[1] = qy; this.quaternion[2] = qz; this.quaternion[3] = qw;
      multiplyQuaternion(worldR, r, worldR, pr, this.quaternion, 0);
    }
  }

  /** Blend two composed poses: lerp the positions, slerp the rotations. */
  blend(fromT, fromR, toT, toR, amount) {
    const {worldT, worldR} = this;
    for (let bone = 0; bone < this.count; bone++) {
      const at = bone * 3, r = bone * 4;
      worldT[at] = fromT[at] + (toT[at] - fromT[at]) * amount;
      worldT[at + 1] = fromT[at + 1] + (toT[at + 1] - fromT[at + 1]) * amount;
      worldT[at + 2] = fromT[at + 2] + (toT[at + 2] - fromT[at + 2]) * amount;
      const dot = fromR[r] * toR[r] + fromR[r + 1] * toR[r + 1] + fromR[r + 2] * toR[r + 2] + fromR[r + 3] * toR[r + 3];
      const sign = dot < 0 ? -1 : 1;
      const cosine = Math.min(1, Math.abs(dot));
      if (cosine > 0.9995) {
        for (let k = 0; k < 4; k++) worldR[r + k] = fromR[r + k] + (toR[r + k] * sign - fromR[r + k]) * amount;
      } else {
        const theta = Math.acos(cosine), sine = Math.sin(theta);
        const a = Math.sin((1 - amount) * theta) / sine, b = Math.sin(amount * theta) / sine;
        for (let k = 0; k < 4; k++) worldR[r + k] = fromR[r + k] * a + toR[r + k] * sign * b;
      }
      normalise(worldR, r);
    }
  }

  /** Advance playback and refresh the skinning matrices. */
  update(dt, name) {
    const spec = this.animations[name];
    if (!spec) return false;
    if (name !== this.state) {
      // Keep the pose we are leaving so the new one can cross-fade out of it.
      this.fromT.set(this.worldT);
      this.fromR.set(this.worldR);
      this.state = name;
      this.time = 0;
      this.fade = this.initialised ? FADE_SECONDS : 0;
      this.initialised = true;
    } else {
      this.time += dt;
    }
    const span = spec.duration || 1;
    const progress = spec.loop ? (this.time % span) / span : Math.min(1, this.time / span);
    const frame = progress * (spec.frames - 1);
    const first = Math.floor(frame), second = Math.min(spec.frames - 1, first + 1), mix = frame - first;
    this.readFrame(spec, first, this.localT, this.localR);
    if (mix > 0.001 && second !== first) {
      this.readFrame(spec, second, this.nextT, this.nextR);
      for (let index = 0; index < this.localT.length; index++) {
        this.localT[index] += (this.nextT[index] - this.localT[index]) * mix;
      }
      for (let bone = 0; bone < this.count; bone++) {
        const r = bone * 4;
        let dot = 0;
        for (let k = 0; k < 4; k++) dot += this.localR[r + k] * this.nextR[r + k];
        const sign = dot < 0 ? -1 : 1;
        for (let k = 0; k < 4; k++) {
          this.localR[r + k] += (this.nextR[r + k] * sign - this.localR[r + k]) * mix;
        }
        normalise(this.localR, r);
      }
    }
    this.compose(this.localT, this.localR, this.mixT, this.mixR);
    if (this.fade > 0) {
      this.fade = Math.max(0, this.fade - dt);
      this.blend(this.fromT, this.fromR, this.mixT, this.mixR, 1 - this.fade / FADE_SECONDS);
    } else {
      this.worldT.set(this.mixT);
      this.worldR.set(this.mixR);
    }
    for (let bone = 0; bone < this.count; bone++) {
      const at = bone * 3, out = bone * 16;
      toMatrix(this.matrix, this.worldT[at], this.worldT[at + 1], this.worldT[at + 2], this.worldR, bone * 4);
      multiply4(this.skin, out, this.matrix, 0, this.bind, out);
    }
    return true;
  }
}