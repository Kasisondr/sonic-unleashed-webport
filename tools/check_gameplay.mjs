import fs from 'node:fs';
import assert from 'node:assert/strict';
import {isWater} from '../web/vegetation.mjs';
import {Player} from '../web/player.mjs';
const root='dist/probe/',m=JSON.parse(fs.readFileSync(root+'game/stage.json')),chunks=new Map();
for(const spec of m.chunks){
 const data=fs.readFileSync(root+(m.assetBase||'game/')+spec.file),v=new DataView(data.buffer,data.byteOffset,data.byteLength);
 const primitives=v.getUint32(4,true),count=v.getUint32(8,true),indexCount=v.getUint32(12,true),at=16+primitives*24,end=at+count*36;
 const p=new Float32Array(count*3);for(let i=0;i<count;i++)for(let k=0;k<3;k++)p[i*3+k]=v.getFloat32(at+i*36+k*4,true);
 const indices=new Uint16Array(data.buffer.slice(data.byteOffset+end,data.byteOffset+end+indexCount*2)),grid=new Map(),solidTriangles=new Uint8Array(indexCount/3);
 for(let i=0;i<primitives;i++){const offset=16+i*24,material=m.materials[v.getUint32(offset,true)]||{};if(!(v.getUint32(offset+4,true)&3)&&!isWater(material,v.getUint32(offset+4,true))&&!/water|leaf|leaves|foliage|flower|glass/i.test(`${material.name} ${material.shader}`))solidTriangles.fill(1,v.getUint32(offset+8,true)/3,(v.getUint32(offset+8,true)+v.getUint32(offset+12,true))/3);}
 for(let i=0;i<indexCount/3;i++){const a=indices[i*3]*3,b=indices[i*3+1]*3,c=indices[i*3+2]*3;
 const minX=Math.floor(Math.min(p[a],p[b],p[c])/8),maxX=Math.floor(Math.max(p[a],p[b],p[c])/8),minZ=Math.floor(Math.min(p[a+2],p[b+2],p[c+2])/8),maxZ=Math.floor(Math.max(p[a+2],p[b+2],p[c+2])/8);
 if((maxX-minX+1)*(maxZ-minZ+1)>4096)continue;
 for(let x=minX;x<=maxX;x++)for(let z=minZ;z<=maxZ;z++){const key=`${x},${z}`;if(!grid.has(key))grid.set(key,[]);grid.get(key).push(i);}}
 chunks.set(spec.name,{positions:p,indices,grid,solidTriangles,bounds:spec.bounds});}
const scene={chunks,manifest:m},neutral={forward:true,steer:0,boost:false,drift:0,jump:false,lookY:0};
const checks=[];
for(const id of ['2351','2355'])for(const hz of [30,60])for(const boost of [false,true]) {
 const board=m.objects.find(o=>o.kind==='jumpboard'&&o.name===id);
 assert.ok(board,`Missing original board ${id}`);
 const player=new Player(scene,board.position,0);player.position[1]=board.position[1]+1.1;
 player.activateLauncher(board,boost);
 let landed=false;
 for(let i=0;i<hz*4;i++) {
  player.update(1/hz,{...neutral,boost});
  if(player.grounded) {landed=true;break;}
 }
 assert.ok(landed,`Board ${id} at ${hz}Hz failed to land`);
 assert.ok(Math.hypot(player.position[0]-board.position[0],player.position[2]-board.position[2])>25,`Board ${id} returned to its launch island`);
 checks.push({board:id,hz,boost,landed:player.position});
}
for(const route of m.guidedRoutes.filter(r=>/path00[13]@/.test(r.id))) {
 const first=route.points[0],next=route.points[1],heading=Math.atan2(next[0]-first[0],next[2]-first[2]);
 const player=new Player(scene,first,heading*180/Math.PI+90);player.position=first.map((v,i)=>v+(i===1?1.1:0));
 player.speed=70;player.camera.yaw=heading+Math.PI;
 let attached=false,finished=false,peak=player.position[1];
 for(let i=0;i<1800;i++) {
  player.update(1/60,neutral);peak=Math.max(peak,player.position[1]);
  if(player.routes.active){attached=true;assert.ok(Math.abs(Math.atan2(Math.sin(player.camera.yaw-heading-Math.PI),Math.cos(player.camera.yaw-heading-Math.PI)))<.02,'Loop rotated camera');}
  else if(attached){finished=true;break;}
  assert.ok(player.position.every(Number.isFinite));
 }
 assert.ok(finished,`Route ${route.id} did not finish`);
 checks.push({route:route.id,finished,peak,position:player.position});
}
fs.writeFileSync('build/gameplay-checks.json',JSON.stringify(checks,null,2));
console.log(JSON.stringify(checks,null,2));
