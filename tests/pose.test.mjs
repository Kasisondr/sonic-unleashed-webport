import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {Rig} from '../web/pose.mjs';
const identity = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
function synthetic() {
  const q = Math.SQRT1_2, stride = 14, buffer = new ArrayBuffer(28), data = new DataView(buffer);
  const values = [[0,0,q,q,0,0,0],[q,0,0,q,1,0,0]];
  values.forEach((v,b) => v.forEach((x,k) => data.setInt16(b*stride+k*2,Math.round(x*(k<4?32767:2048)),true)));
  return new Rig({bones:2,stride,positionScale:2048,quaternionScale:32767,parents:[-1,0],order:[0,1],
    animations:{idle:{offset:0,frames:1,duration:1,loop:true}}}, {bones:[{transform:identity},{transform:identity}]}, buffer);
}
test('parent rotation places the child and precedes its local rotation', () => {
  const rig = synthetic(); rig.update(1,'idle');
  assert.ok(Math.abs(rig.worldT[3])<1e-4);
  assert.ok(Math.abs(rig.worldT[4]-1)<1e-4);
  // Rz(90) * Rx(90) maps child Y to world Z, unlike Rx * Rz.
  assert.ok(Math.abs(rig.skin[16+6]-1)<1e-4);
});
test('skin applies inverse bind before animated world placement', () => {
  const rig=synthetic(); rig.bind[12]=2; rig.update(1,'idle');
  assert.ok(Math.abs(rig.skin[12])<1e-4);
  assert.ok(Math.abs(rig.skin[13]-2)<1e-4);
});
const available = fs.existsSync('dist/probe/game/sonic_anims.bin');
test('all exported poses keep Sonic and his fingers within character bounds', {skip:!available}, () => {
  const c=JSON.parse(fs.readFileSync('dist/probe/game/sonic.json'));
  const a=JSON.parse(fs.readFileSync('dist/probe/game/sonic_anims.json'));
  const raw=fs.readFileSync('dist/probe/game/sonic_anims.bin');
  const rig=new Rig(a,c,raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength));
  const mesh=fs.readFileSync('dist/probe/game/sonic.bin'),dv=new DataView(mesh.buffer,mesh.byteOffset,mesh.byteLength);
  const count=dv.getUint32(8,true),start=16+dv.getUint32(4,true)*24;
  for(const [name,spec] of Object.entries(a.animations)) {
    for (const sample of [0,.25,.5,.75,.99]) {
      rig.state=name;rig.time=sample*spec.duration;rig.fade=0;rig.update(0,name);
      const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
      for(let v=0;v<count;v++) {
        const at=start+v*44,p=[0,1,2].map(k=>dv.getFloat32(at+k*4,true));
        const w=[0,1,2,3].map(k=>dv.getUint8(at+40+k)),total=w.reduce((a,b)=>a+b,0);
        assert.ok(total>0);
        const out=[0,0,0];
        for(let k=0;k<4;k++) {
          const b=dv.getUint8(at+36+k)*16;
          for(let d=0;d<3;d++)out[d]+=(rig.skin[b+d]*p[0]+rig.skin[b+4+d]*p[1]+rig.skin[b+8+d]*p[2]+rig.skin[b+12+d])*w[k]/total;
        }
        out.forEach((value,d)=>{assert.ok(Number.isFinite(value),name);low[d]=Math.min(low[d],value);high[d]=Math.max(high[d],value);});
      }
      high.forEach((value,d)=>assert.ok(value-low[d]<1.8,`${name} axis ${d} is stretched: ${value-low[d]}`));
      if(name==='ball')assert.ok(high[1]-low[1]<.85,'Ball pose should be compact');
    }
  }
});

test('all exported Chip flight and talk poses keep his limbs and wings bounded', {skip:!fs.existsSync('dist/probe/game/chip_anims.bin')}, () => {
  const c=JSON.parse(fs.readFileSync('dist/probe/game/chip.json'));
  const a=JSON.parse(fs.readFileSync('dist/probe/game/chip_anims.json'));
  const raw=fs.readFileSync('dist/probe/game/chip_anims.bin');
  const rig=new Rig(a,c,raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength));
  const mesh=fs.readFileSync('dist/probe/game/chip.bin'),dv=new DataView(mesh.buffer,mesh.byteOffset,mesh.byteLength);
  const count=dv.getUint32(8,true),start=16+dv.getUint32(4,true)*24;
  for(const [name,spec] of Object.entries(a.animations)) {
    for (const sample of [0,.25,.5,.75,.99]) {
      rig.state=name;rig.time=sample*spec.duration;rig.fade=0;rig.update(0,name);
      const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
      for(let v=0;v<count;v++) {
        const at=start+v*44,p=[0,1,2].map(k=>dv.getFloat32(at+k*4,true));
        const w=[0,1,2,3].map(k=>dv.getUint8(at+40+k)),total=w.reduce((a,b)=>a+b,0);
        assert.ok(total>0);
        const out=[0,0,0];
        for(let k=0;k<4;k++) {
          const b=dv.getUint8(at+36+k)*16;
          for(let d=0;d<3;d++)out[d]+=(rig.skin[b+d]*p[0]+rig.skin[b+4+d]*p[1]+rig.skin[b+8+d]*p[2]+rig.skin[b+12+d])*w[k]/total;
        }
        out.forEach((value,d)=>{assert.ok(Number.isFinite(value),name);low[d]=Math.min(low[d],value);high[d]=Math.max(high[d],value);});
      }
      high.forEach((value,d)=>assert.ok(value-low[d]<1.4,`${name} axis ${d} is stretched: ${value-low[d]}`));
      if(name==='ball')assert.ok(high[1]-low[1]<.85,'Ball pose should be compact');
    }
  }
});
