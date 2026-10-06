import test from 'node:test';
import assert from 'node:assert/strict';
import {LightField} from '../web/light-field.mjs';
function fixture() {
  const buffer=new ArrayBuffer(8+8*25+8*4),view=new DataView(buffer);
  view.setUint32(0,3);view.setUint32(4,0);
  for(let corner=0;corner<8;corner++) {
    for(let i=0;i<24;i++)view.setUint8(8+corner*25+i,corner*30);
    view.setUint8(8+corner*25+24,255);
    view.setUint32(208+corner*4,corner);
  }
  return new LightField({bounds:{min:[0,0,0],max:[1,1,1]},cells:{offset:0,count:1},probes:{offset:8,count:8},indices:{offset:208,count:8},probeStride:25},buffer);
}
test('light-field interpolation uses original X4 Y2 Z1 corners and squared colours',()=>{
  const field=fixture();
  assert.ok(Math.abs(field.sample([1,0,0])[0]-(120/255)**2)<1e-6);
  assert.ok(Math.abs(field.sample([0,0,1])[0]-(30/255)**2)<1e-6);
  assert.ok(Math.abs(field.sample([.5,.5,.5])[0]-Array.from({length:8},(_,i)=>(i*30/255)**2).reduce((a,b)=>a+b)/8)<1e-6);
  assert.equal(field.shadow,1);
});
test('corrupt light-field pointers are rejected rather than producing NaN lighting',()=>{
  assert.throws(()=>new LightField({cells:{offset:100,count:1}},new ArrayBuffer(8)),/Invalid/);
  const field=fixture();field.view.setUint32(208,999);
  assert.throws(()=>field.sample([0,0,0]),/outside array/);
});
