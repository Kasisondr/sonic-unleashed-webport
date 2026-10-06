// Solid render triangles are a browser collision fallback until Havok is ported.
// A short swept sphere stack approximates Sonic's upright capsule. Substeps
// prevent thin walls being skipped at dash-panel speed; contacts retain sliding.
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub = (a,b) => [a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const add = (a,b,t) => [a[0]+b[0]*t,a[1]+b[1]*t,a[2]+b[2]*t];
export function closestTriangle(p,a,b,c) {
  const ab=sub(b,a),ac=sub(c,a),ap=sub(p,a),d1=dot(ab,ap),d2=dot(ac,ap);
  if(d1<=0&&d2<=0)return a;
  const bp=sub(p,b),d3=dot(ab,bp),d4=dot(ac,bp);
  if(d3>=0&&d4<=d3)return b;
  const vc=d1*d4-d3*d2;
  if(vc<=0&&d1>=0&&d3<=0)return add(a,ab,d1/(d1-d3));
  const cp=sub(p,c),d5=dot(ab,cp),d6=dot(ac,cp);
  if(d6>=0&&d5<=d6)return c;
  const vb=d5*d2-d1*d6;
  if(vb<=0&&d2>=0&&d6<=0)return add(a,ac,d2/(d2-d6));
  const va=d3*d6-d5*d4;
  if(va<=0&&(d4-d3)>=0&&(d5-d6)>=0)return add(b,sub(c,b),(d4-d3)/((d4-d3)+(d5-d6)));
  const den=va+vb+vc;
  if(Math.abs(den)<1e-12)return a;
  return add(add(a,ab,vb/den),ac,vc/den);
}

function candidates(scene,start,end,radius) {
  const result=[];
  const min=[Math.min(start[0],end[0])-radius,Math.min(start[1],end[1])-1.2,Math.min(start[2],end[2])-radius];
  const max=[Math.max(start[0],end[0])+radius,Math.max(start[1],end[1])+.4,Math.max(start[2],end[2])+radius];
  for(const chunk of scene.chunks.values()) {
    if(chunk.pending||!chunk.grid||!chunk.positions)continue;
    if(chunk.bounds&&min.some((v,i)=>v>chunk.bounds.max[i]||max[i]<chunk.bounds.min[i]))continue;
    const seen=new Set(),p=chunk.positions,ind=chunk.indices;
    for(let x=Math.floor(min[0]/8);x<=Math.floor(max[0]/8);x++)for(let z=Math.floor(min[2]/8);z<=Math.floor(max[2]/8);z++) {
      for(const tri of chunk.grid.get(`${x},${z}`)||[]) {
        if(seen.has(tri)||chunk.solidTriangles?.[tri]===0)continue;
        seen.add(tri);
        const a=Array.from(p.subarray(ind[tri*3]*3,ind[tri*3]*3+3));
        const b=Array.from(p.subarray(ind[tri*3+1]*3,ind[tri*3+1]*3+3));
        const c=Array.from(p.subarray(ind[tri*3+2]*3,ind[tri*3+2]*3+3));
        if(min.some((v,i)=>v>Math.max(a[i],b[i],c[i])||max[i]<Math.min(a[i],b[i],c[i])))continue;
        const ab=sub(b,a),ac=sub(c,a),n=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
        const length=Math.hypot(...n);
        if(length<1e-8)continue;
        result.push({a,b,c,n:n.map(v=>v/length)});
      }
    }
  }
  return result;
}

export function moveCapsule(scene,start,delta,velocity,radius=.32) {
  const end=add(start,delta,1),triangles=candidates(scene,start,end,radius+.05);
  const count=Math.max(1,Math.ceil(Math.hypot(...delta)/.22)),position=[...start];
  let wall=false,ceiling=false;
  for(let step=0;step<count;step++) {
    for(let i=0;i<3;i++)position[i]+=delta[i]/count;
    for(let iteration=0;iteration<3;iteration++) {
      let hit=false;
      for(const {a,b,c,n} of triangles) {
        // Walkable faces below the feet are handled by the terrain ground query.
        // Both windings occur in exports; distinguish ceilings by their height.
        if(Math.abs(n[1])>.65 && Math.max(a[1],b[1],c[1])<position[1]-.55)continue;
        for(const offset of [-.7,-.35,0]) {
          const center=[position[0],position[1]+offset,position[2]];
          const near=closestTriangle(center,a,b,c),v=sub(center,near),distance=Math.hypot(...v);
          if(distance>=radius)continue;
          let normal=distance>1e-7?v.map(q=>q/distance):[...n];
          if(distance<=1e-7&&dot(normal,delta)>0)normal=normal.map(q=>-q);
          // Do not turn a ground edge into an artificial step or a launch pad.
          if(normal[1]>.65)continue;
          const depth=radius-distance+.001;
          for(let i=0;i<3;i++)position[i]+=normal[i]*depth;
          const into=dot(velocity,normal);
          if(into<0)for(let i=0;i<3;i++)velocity[i]-=normal[i]*into;
          if(normal[1]<-.65)ceiling=true;else wall=true;
          hit=true;
        }
      }
      if(!hit)break;
    }
  }
  return {position,wall,ceiling};
}

// Camera sweep uses the same solids; return the earliest ray hit rather than
// lifting the camera above an entire building when it gets behind a wall.
export function cameraObstruction(scene,from,to) {
  const direction=sub(to,from);let best=1;
  for(const {a,b,c} of candidates(scene,from,to,.1)) {
    const ab=sub(b,a),ac=sub(c,a);
    const h=[direction[1]*ac[2]-direction[2]*ac[1],direction[2]*ac[0]-direction[0]*ac[2],direction[0]*ac[1]-direction[1]*ac[0]];
    const det=dot(ab,h);if(Math.abs(det)<1e-8)continue;
    const s=sub(from,a),u=dot(s,h)/det;if(u<0||u>1)continue;
    const q=[s[1]*ab[2]-s[2]*ab[1],s[2]*ab[0]-s[0]*ab[2],s[0]*ab[1]-s[1]*ab[0]];
    const v=dot(direction,q)/det;if(v<0||u+v>1)continue;
    const t=dot(ac,q)/det;if(t>.03&&t<best)best=t;
  }
  const distance=Math.hypot(...direction);
  return best<1?add(from,direction,Math.max(.05,best-.25/Math.max(distance,.001))):to;
}
