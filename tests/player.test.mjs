import test from 'node:test';
import assert from 'node:assert/strict';
import {Player} from '../web/player.mjs';
function floor(height=0) {
  const positions=new Float32Array([-100,height,-100,100,height,-100,-100,height,100,100,height,100]);
  const indices=new Uint16Array([0,1,2,1,3,2]),grid=new Map();
  for(let x=-13;x<=13;x++)for(let z=-13;z<=13;z++)grid.set(`${x},${z}`,[0,1]);
  return {manifest:{spawn:[0,height,0],deadHeight:-260},chunks:new Map([['floor',{positions,indices,grid,bounds:{min:[-100,height,-100],max:[100,height,100]}}]])};
}
const neutral={forward:false,steer:0,boost:false,drift:0,jump:false,lookY:0};
test('run and boost move across solid terrain, then jump returns to it',()=>{
  const player=new Player(floor(),[0,0,0],90);
  for(let i=0;i<20;i++)player.update(1/60,neutral);
  assert.ok(player.grounded);
  for(let i=0;i<120;i++)player.update(1/60,{...neutral,forward:true,boost:true});
  assert.ok(player.position[2]>25);
  assert.ok(player.grounded);
  player.update(1/60,{...neutral,jump:true});
  let peak=player.position[1];
  for(let i=0;i<150;i++){player.update(1/60,neutral);peak=Math.max(peak,player.position[1]);}
  assert.ok(peak>2.5);assert.ok(player.grounded);
});
test('a stage below -260 does not repeatedly respawn',()=>{
  const scene=floor(-282),player=new Player(scene,scene.manifest.spawn,90);
  for(let i=0;i<120;i++)player.update(1/60,neutral);
  assert.ok(player.grounded);assert.ok(!player.fell);
  assert.ok(Math.abs(player.position[1]-(-282+1.1))<1e-5);
});
test('standing still on a slope does not accelerate Sonic along an arbitrary heading',()=>{
  const scene=floor(),player=new Player(scene,scene.manifest.spawn,90);
  for(let i=0;i<20;i++)player.update(1/60,neutral);
  player.groundNormal=[.7,.7,0];
  for(let i=0;i<60;i++)player.update(1/60,neutral);
  assert.equal(player.speed,0);
});
test('source board rotation directs a jump and preserves its impulse against air steering',()=>{
  const player=new Player(floor(),[0,0,0],90);
  const board={kind:'jumpboard',rotation:[0,Math.sin(Math.PI/8),0,Math.cos(Math.PI/8)],launch:{ImpulseSpeedOnNormal:40,OutOfControl:1.2}};
  assert.ok(player.activateLauncher(board));
  const heading=player.heading,speed=player.speed;
  for(let i=0;i<40;i++)player.update(1/60,{...neutral,steer:1,forward:true});
  assert.equal(player.heading,heading);assert.equal(player.speed,speed);
  assert.ok(player.position[0]<-10&&player.position[2]<-10);
});
test('an unchanged-camera mode keeps the view behind Sonic after many negative turns',()=>{
  const player=new Player(floor(),[0,0,0],90);
  player.heading=-100*Math.PI*2+.4;player.in2DMode=true;player.sideCamera=false;
  for(let i=0;i<240;i++)player.update(1/60,neutral);
  const error=Math.atan2(Math.sin(player.camera.yaw-player.heading-Math.PI),Math.cos(player.camera.yaw-player.heading-Math.PI));
  assert.ok(Math.abs(error)<.001);assert.ok(player.camera.position.every(Number.isFinite));
});
test('a vertical loop follows its source route without rolling or flipping the camera',()=>{
  const points=Array.from({length:129},(_,i)=>{const t=i/128*Math.PI*2;return [0,5-5*Math.cos(t),-5*Math.sin(t)];});
  const scene=floor();scene.manifest.guidedRoutes=[{id:'loop',points}];
  const player=new Player(scene,[0,0,0],270);player.speed=20;player.camera.yaw=player.heading+Math.PI;
  let peak=0,sawRoute=false;
  for(let i=0;i<95;i++){
    player.update(1/60,{...neutral,forward:true});peak=Math.max(peak,player.position[1]);
    if(player.routes.active){sawRoute=true;assert.ok(Math.abs(Math.sin(player.camera.yaw))<.001);}
  }
  assert.ok(sawRoute);assert.ok(peak>10);assert.equal(player.routes.active,null);
});
