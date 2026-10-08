// Browser companion behaviour, using the disc's Chip model and animations.
export class Companion {
  update(dt, player, talking = false) {
    const heading = player.heading;
    const side = [Math.cos(heading), 0, -Math.sin(heading)];
    const forward = [Math.sin(heading), 0, Math.cos(heading)];
    const target = player.position.map((p,i)=>p+side[i]*1.05-forward[i]*1.15);
    target[1] += .35;
    if (!this.position || Math.hypot(...target.map((p,i)=>p-this.position[i])) > 22) {
      this.position = [...target];
      this.heading = heading;
    }
    const amount = 1-Math.exp(-Math.max(0,dt)*7);
    for (let i=0;i<3;i++) this.position[i]+=(target[i]-this.position[i])*amount;
    const angle = Math.atan2(Math.sin(heading-this.heading),Math.cos(heading-this.heading));
    this.heading += angle * amount;
    this.animation = talking ? 'talk' : Math.abs(player.speed)>22 ? 'fast' : Math.abs(player.speed)>2 ? 'move' : 'idle';
    return this;
  }
}
