// Browser daytime controller with solid terrain contacts and source launchers.
import {moveCapsule, cameraObstruction} from './collision.mjs';
import {GuidedRoutes} from './routes.mjs';
const GRAVITY = -30;
const JUMP_SPEED = 11.5;
const RUN_SPEED = 17;
const BOOST_SPEED = 30;
const AIR_DRAG = 0.995;
const TURN_RATE = 3.1;
const CAMERA_DISTANCE = 5.2;
const CAMERA_HEIGHT = 1.5;
const PLAYER_HEIGHT = 1.1;
const GROUND_PROBE = 1.6;
const FALL_LIMIT = -260;

export class Player {
  constructor(scene, spawn, yaw) {
    this.scene = scene;
    // Disc spawn markers can sit a few centimetres below the rendered surface.
    // Start above it so grounding still obeys the same from-above landing rule.
    this.position = [spawn[0], spawn[1] + PLAYER_HEIGHT + .05, spawn[2]];
    this.spawnPending = true;
    this.velocity = [0, 0, 0];
    this.heading = (yaw - 90) * Math.PI / 180;
    this.grounded = false;
    this.groundNormal = [0, 1, 0];
    this.boost = 1;
    this.ringCount = 0;
    this.score = 0;
    this.state = 'stand';
    // Animation hints the pose engine reads: jump start, landing and spring pops.
    this.jumpPose = 0;
    this.landingPose = 0;
    this.springLaunch = 0;
    this.landed = false;
    this.wasGrounded = false;
    this.jumpHeld = false;
    this.jumps = 0;
    this.camera = {position: [spawn[0], spawn[1] + 4, spawn[2] - 12], lookAt: [spawn[0], spawn[1] + 1.5, spawn[2]],
      yaw: this.heading + Math.PI, pitch: 0.06};
    this.speed = 0;
    this.spin = 0;
    this.in2DMode = false;
    this.sideCamera = false;
    this.launchTimer = 0;
    this.launchCooldown = 0;
    this.routes = new GuidedRoutes(scene.manifest.guidedRoutes);
    this.invulnerableTimer = 0;
    // Mission flow handles death transitions; standalone controller checks keep
    // the old immediate recovery unless explicitly enabled by the game loop.
    this.deathManaged = false;
  }

  /** Highest terrain surface under a column, or null when nothing is loaded. */
  ground(x, z, y, radius = 1.2) {
    let best = null, bestNormal = [0, 1, 0];
    for (const chunk of this.scene.chunks.values()) {
      if (chunk.pending || !chunk.grid) continue;
      const bounds = chunk.bounds;
      if (x + radius < bounds.min[0] || x - radius > bounds.max[0]) continue;
      if (z + radius < bounds.min[2] || z - radius > bounds.max[2]) continue;
      const cell = 8;
      const minX = Math.floor((x - radius) / cell), maxX = Math.floor((x + radius) / cell);
      const minZ = Math.floor((z - radius) / cell), maxZ = Math.floor((z + radius) / cell);
      for (let cx = minX; cx <= maxX; cx++) {
        for (let cz = minZ; cz <= maxZ; cz++) {
          const triangles = chunk.grid.get(`${cx},${cz}`);
          if (!triangles) continue;
          for (const triangle of triangles) {
            if (chunk.solidTriangles?.[triangle] === 0) continue;
            const hit = this.rayTriangle(chunk, triangle, x, z, y, radius);
            if (hit && (best === null || hit.y > best)) {
              best = hit.y; bestNormal = hit.normal;
            }
          }
        }
      }
    }
    return best === null ? null : {y: best, normal: bestNormal};
  }

  rayTriangle(chunk, triangle, x, z, y, radius) {
    const positions = chunk.positions;
    const a = triangle * 3, b = triangle * 3 + 1, c = triangle * 3 + 2;
    const ax = positions[chunk.indices[a] * 3], az = positions[chunk.indices[a] * 3 + 2];
    const bx = positions[chunk.indices[b] * 3], bz = positions[chunk.indices[b] * 3 + 2];
    const cx = positions[chunk.indices[c] * 3], cz = positions[chunk.indices[c] * 3 + 2];
    const area = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    if (Math.abs(area) < 1e-6) return null;
    const w0 = ((bx - x) * (cz - z) - (cx - x) * (bz - z)) / area;
    const w1 = ((cx - x) * (az - z) - (ax - x) * (cz - z)) / area;
    const w2 = 1 - w0 - w1;
    if (w0 < -0.0001 || w1 < -0.0001 || w2 < -0.0001) return null;
    const ay = positions[chunk.indices[a] * 3 + 1], by = positions[chunk.indices[b] * 3 + 1],
      cy = positions[chunk.indices[c] * 3 + 1];
    const height = w0 * ay + w1 * by + w2 * cy;
    if (height > y + GROUND_PROBE || height < y - 40) return null;
    const normal = this.faceNormal(chunk, a, b, c);
    if (normal[1] < .55) return null;
    return {y: height, normal};
  }

  faceNormal(chunk, a, b, c) {
    const positions = chunk.positions, indices = chunk.indices;
    const ax = positions[indices[a] * 3], ay = positions[indices[a] * 3 + 1], az = positions[indices[a] * 3 + 2];
    const bx = positions[indices[b] * 3], by = positions[indices[b] * 3 + 1], bz = positions[indices[b] * 3 + 2];
    const cx = positions[indices[c] * 3], cy = positions[indices[c] * 3 + 1], cz = positions[indices[c] * 3 + 2];
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const length = Math.hypot(nx, ny, nz) || 1;
    const sign = ny < 0 ? -1 : 1;
    return [sign * nx / length, sign * ny / length, sign * nz / length];
  }

  update(dt, input) {
    if(this.spawnPending) {
      const surface=this.ground(this.position[0],this.position[2],this.position[1]);
      if(surface) {
        const offset=surface.y-(this.position[1]-PLAYER_HEIGHT);
        if(offset>0 && offset<1.5)this.position[1]=surface.y+PLAYER_HEIGHT+.01;
        this.spawnPending=false;
      }
    }
    if(!input.jump)this.routes.attach(this.position,this.speed,this.heading,dt);
    const guided=this.routes.advance(dt,this.speed,input.jump&&!this.jumpHeld);
    const guidedSpeed=this.speed;
    this.launchCooldown = Math.max(0, this.launchCooldown-dt);
    const launched = this.launchTimer > 0;
    this.launchTimer = Math.max(0, this.launchTimer-dt);
    const heading = input.steer !== 0 ? input.steer : 0;
    if (!launched) this.heading -= heading * TURN_RATE * dt * (input.drift ? 1.5 : 1);

    const boosting = input.boost && this.boost > 0.02;
    if (boosting) this.boost = Math.max(0, this.boost - dt * (this.grounded ? 0.22 : 0.1));
    const target = input.forward ? (boosting ? BOOST_SPEED : RUN_SPEED) : (boosting ? BOOST_SPEED : 0);
    if (launched) {
      // Preserve a board/panel's impulse rather than braking to the run cap.
    } else if (this.grounded) {
      const acceleration = target > this.speed ? (boosting ? 26 : 12) : 26;
      this.speed += Math.sign(target - this.speed) * Math.min(Math.abs(target - this.speed), acceleration * dt);
      const slope = this.groundNormal;
      if (Math.abs(this.speed) > 0.1 && slope[1] < 0.82) {
        const along = slope[0] * Math.sin(this.heading) + slope[2] * Math.cos(this.heading);
        this.speed += -GRAVITY * along * slope[1] * dt;
      }
      if (!input.forward && !input.boost) {
        this.speed *= Math.max(0, 1 - dt * 7);
        if (Math.abs(this.speed) < 0.05) this.speed = 0;
      }
    } else {
      this.speed *= Math.pow(AIR_DRAG, dt*60);
      if (input.forward && this.speed < RUN_SPEED) this.speed += 8 * dt;
    }
    const directionX = Math.sin(this.heading), directionZ = Math.cos(this.heading);
    let vx = directionX * this.speed, vz = directionZ * this.speed;
    if (input.drift && this.grounded) {
      const strafe = input.drift;
      vx += Math.cos(this.heading) * strafe * 7;
      vz += -Math.sin(this.heading) * strafe * 7;
    }
    this.velocity[0] = vx;
    this.velocity[2] = vz;

    if (!this.grounded) {
      this.velocity[1] += GRAVITY * dt;
      if (!launched && input.jump && !this.jumpHeld && this.jumps < 2) {
        this.velocity[1] = JUMP_SPEED * 0.92;
        this.jumps++;
        this.spinTrigger = true;
        this.jumpPose = 0.26;
      }
    } else {
      this.jumps = 0;
      if (!launched && input.jump && !this.jumpHeld) {
        this.velocity[1] = JUMP_SPEED;
        this.grounded = false;
        this.jumps = 1;
        this.spinTrigger = true;
        this.jumpPose = 0.26;
      } else {
        this.velocity[1] = -2;
      }
    }
    this.jumpHeld = input.jump;

    // Remember the last solid ground so a fall off the stage can recover.
    if (this.grounded) this.lastSafe = [this.position[0], this.position[1], this.position[2]];
    if (this.position[1] < Math.min(this.scene.manifest.deadHeight ?? FALL_LIMIT, (this.scene.manifest.browserSpawn || this.scene.manifest.spawn)[1] - 80)) {
      if (this.deathManaged) {
        this.velocity.fill(0); this.speed = 0; this.fell = true; this.state = 'fallen';
        return this.position;
      }
      const safe = this.lastSafe || [0, this.position[1] + 40, 0];
      this.position = [safe[0], safe[1] + 1.5, safe[2]];
      this.velocity = [0, 0, 0];
      this.speed = 0;
      this.fell = true;
      this.resetCamera();
    }
    const step = [this.velocity[0] * dt, this.velocity[1] * dt, this.velocity[2] * dt];
    const contact = guided ? {position:guided.position,wall:false} : moveCapsule(this.scene, this.position, step, this.velocity);
    const next = contact.position;
    if (contact.wall) this.speed = Math.hypot(this.velocity[0],this.velocity[2]);
    const surface = this.ground(next[0], next[2], this.position[1], 1.1);
    if (guided) {
      this.speed=guidedSpeed;this.grounded=true;
      this.velocity=guided.tangent.map(v=>v*this.speed);
      if(Math.hypot(guided.tangent[0],guided.tangent[2])>.15)
        this.heading=Math.atan2(guided.tangent[0],guided.tangent[2]);
    } else if (surface !== null && this.position[1]-PLAYER_HEIGHT >= surface.y-(this.grounded?.45:.2)
        && next[1] - PLAYER_HEIGHT <= surface.y && this.velocity[1] <= 0.01) {
      next[1] = surface.y + PLAYER_HEIGHT;
      this.grounded = true;
      this.groundNormal = surface.normal;
      this.velocity[1] = 0;
    } else {
      this.grounded = false;
      const ahead = this.ground(next[0] + Math.sin(this.heading) * 2.5, next[2] + Math.cos(this.heading) * 2.5,
        next[1], 1.1);
      this.ahead = ahead;
    }
    // Block impossible upward steps so Sonic cannot climb walls by sliding into them.
    if (!guided && surface !== null && surface.y > this.position[1] + 2.2 && this.grounded === false) {
      next[0] = this.position[0];
      next[2] = this.position[2];
      this.speed *= 0.2;
    }
    this.position = next;
    if (this.grounded && !this.wasGrounded) {
      this.landed = true;
      this.jumpPose = 0;
      this.springLaunch = 0;
    }
    this.wasGrounded = this.grounded;
    this.spin += this.speed * dt * 0.35;
    if (this.invulnerableTimer > 0) this.invulnerableTimer -= dt;

    if (input.centerCamera) {
      this.resetCamera();
      return this.position;
    }

    const cameraHeading=guided?.cameraHeading ?? this.heading;
    const wantedYaw = this.sideCamera ? (cameraHeading + Math.PI * 0.5) : (cameraHeading + Math.PI);
    const difference = Math.atan2(Math.sin(wantedYaw-this.camera.yaw),Math.cos(wantedYaw-this.camera.yaw));
    this.camera.yaw += difference * Math.min(1, dt * (this.grounded ? 3.6 : 1.8));
    this.camera.pitch += (input.lookY * 0.6 - this.camera.pitch) * Math.min(1, dt * 2);
    const distance = (this.sideCamera ? 8.5 : CAMERA_DISTANCE) + Math.min(3, this.speed * 0.08);
    const height = (this.sideCamera ? 2.6 : CAMERA_HEIGHT) + this.camera.pitch * 3;
    // Lead the camera slightly in the direction of travel for a livelier view.
    const lookAhead = Math.min(3.5, this.speed * 0.16);
    const focus = [this.position[0] + Math.sin(cameraHeading) * lookAhead, this.position[1] + 0.0,
      this.position[2] + Math.cos(cameraHeading) * lookAhead];
    let wanted = [focus[0] + Math.sin(this.camera.yaw) * distance, focus[1] + height,
      focus[2] + Math.cos(this.camera.yaw) * distance];
    wanted = cameraObstruction(this.scene,focus,wanted);
    const waterLevel = this.scene?.manifest?.water ?? -999;
    if (wanted[1] < waterLevel + 1.2) wanted[1] = waterLevel + 1.2;
    for (let axis = 0; axis < 3; axis++) {
      this.camera.position[axis] += (wanted[axis] - this.camera.position[axis]) * Math.min(1, dt * (this.sideCamera ? 5.0 : 6.5));
      this.camera.lookAt[axis] += (focus[axis] - this.camera.lookAt[axis]) * Math.min(1, dt * 7.5);
    }
    this.camera.position = cameraObstruction(this.scene,this.camera.lookAt,this.camera.position);
    return this.position;
  }

  activateDash(object) {
    if (this.launchCooldown > 0) return false;
    const direction = launcherDirection(object,0);
    this.heading = Math.atan2(direction[0],direction[2]);
    this.speed = object.launch?.Speed || 26;
    this.launchTimer = Math.max(.25,object.launch?.OutOfControl || 0);
    this.launchCooldown = .18;
    return true;
  }

  activateLauncher(object,boosting=false) {
    if (this.launchCooldown > 0) return false;
    this.spawnPending=false;
    const board=object.kind==='jumpboard';
    const speed=object.launch?.[boosting?'ImpulseSpeedOnBoost':'ImpulseSpeedOnNormal'] || (board?40:27);
    const angle=board ? (object.launch?.AngleType ?? 45) : 90;
    const d=launcherDirection(object,angle);
    this.velocity=d.map(v=>v*speed);
    this.speed=Math.hypot(this.velocity[0],this.velocity[2]);
    if(this.speed>.01)this.heading=Math.atan2(d[0],d[2]);
    this.grounded=false;this.jumps=1;
    this.launchTimer=Math.max(.6,object.launch?.OutOfControl || 0);
    this.launchCooldown=.4;this.springLaunch=.8;
    return true;
  }

  /** Instantly snap the camera behind Sonic without interpolation lag. */
  resetCamera() {
    const wantedYaw = this.sideCamera ? (this.heading + Math.PI * 0.5) : (this.heading + Math.PI);
    this.camera.yaw = wantedYaw;
    this.camera.pitch = 0.06;
    const distance = this.sideCamera ? 8.5 : CAMERA_DISTANCE;
    const height = this.sideCamera ? 2.6 : CAMERA_HEIGHT;
    const focus = [this.position[0], this.position[1] + 0.3, this.position[2]];
    let wanted = [
      focus[0] + Math.sin(this.camera.yaw) * distance,
      focus[1] + height,
      focus[2] + Math.cos(this.camera.yaw) * distance
    ];
    wanted = cameraObstruction(this.scene,focus,wanted);
    const waterLevel = this.scene?.manifest?.water ?? -999;
    if (wanted[1] < waterLevel + 1.2) wanted[1] = waterLevel + 1.2;
    this.camera.position = wanted;
    this.camera.lookAt = [focus[0], focus[1] + 0.8, focus[2]];
  }
}

export function launcherDirection(object,angle) {
  const radians=angle*Math.PI/180;
  const v=[0,Math.sin(radians),-Math.cos(radians)];
  const q=object.rotation || [0,Math.sin((object.yaw||0)*Math.PI/360),0,Math.cos((object.yaw||0)*Math.PI/360)];
  const length=Math.hypot(...q)||1,[x,y,z,w]=q.map(v=>v/length);
  const t=[2*(y*v[2]-z*v[1]),2*(z*v[0]-x*v[2]),2*(x*v[1]-y*v[0])];
  return [v[0]+w*t[0]+y*t[2]-z*t[1],v[1]+w*t[1]+z*t[0]-x*t[2],v[2]+w*t[2]+x*t[1]-y*t[0]];
}
