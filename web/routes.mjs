// Browser guidance over original SV centreline samples, including vertical loops.
export class GuidedRoutes {
  constructor(routes=[]) {
    this.routes=routes.map(route=>{
      const lengths=[0];
      for(let i=1;i<route.points.length;i++)lengths.push(lengths[i-1]+Math.hypot(...route.points[i].map((v,k)=>v-route.points[i-1][k])));
      return {...route,lengths,total:lengths.at(-1)};
    });
    this.active=null;this.cooldown=0;
  }
  attach(position,speed,heading,dt) {
    this.cooldown=Math.max(0,this.cooldown-dt);
    if(this.active||this.cooldown>0||speed<8)return;
    let best=null;
    const feet=[position[0],position[1]-1.1,position[2]];
    for(const route of this.routes)for(let i=0;i<route.points.length-1;i++) {
      const a=route.points[i],b=route.points[i+1],d=b.map((v,k)=>v-a[k]),l2=d.reduce((s,v)=>s+v*v,0);
      if(l2<1e-8)continue;
      const t=Math.max(0,Math.min(1,feet.reduce((s,v,k)=>s+(v-a[k])*d[k],0)/l2));
      const q=a.map((v,k)=>v+d[k]*t),distance=Math.hypot(...feet.map((v,k)=>v-q[k]));
      // Enter at the route entrance or where a loop becomes steep. Ordinary
      // terrain remains freely steerable; adjacent/overhead paths do not snap.
      if(distance>2.8||(i>8&&Math.abs(d[1])/Math.sqrt(l2)<.4))continue;
      const alignment=(Math.sin(heading)*d[0]+Math.cos(heading)*d[2])/Math.hypot(d[0],d[2]);
      if(Number.isFinite(alignment)&&alignment<.25)continue;
      if(!best||distance<best.distance)best={route,s:route.lengths[i]+Math.sqrt(l2)*t,distance};
    }
    if(best)this.active={...best,heading};
  }
  advance(dt,speed,jump) {
    if(!this.active)return null;
    if(jump){this.active=null;this.cooldown=.8;return null;}
    const active=this.active,route=active.route;
    active.s=Math.min(route.total,active.s+Math.max(12,speed)*dt);
    let i=0;
    // Route files are modest; preserve the last segment rather than rescan.
    i=active.index||0;
    while(i<route.points.length-2&&route.lengths[i+1]<active.s)i++;
    active.index=i;
    const a=route.points[i],b=route.points[i+1],length=route.lengths[i+1]-route.lengths[i];
    const t=length?Math.min(1,(active.s-route.lengths[i])/length):0;
    const tangent=b.map((v,k)=>(v-a[k])/(length||1));
    const position=a.map((v,k)=>v+(b[k]-v)*t);position[1]+=1.1;
    if(active.s>=route.total){this.active=null;this.cooldown=.8;}
    return {position,tangent,cameraHeading:active.heading};
  }
}
