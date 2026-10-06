import test from 'node:test';
import assert from 'node:assert/strict';
import {lookAt,orthographic,multiply,boundsVisible} from '../web/render-math.mjs';
test('the player and nearby terrain lie inside the shadow light clip volume',()=>{
  const centre=[-859,69,-53],sun=[.4,.8,.2],extent=78,distance=extent*2.4;
  const eye=centre.map((x,i)=>x+sun[i]*distance);
  const matrix=multiply(orthographic(-extent,extent,-extent,extent,.1,distance*2.2),lookAt(eye,centre));
  const clip=[0,1,2].map(row=>centre.reduce((sum,v,i)=>sum+matrix[i*4+row]*v,matrix[12+row]));
  assert.ok(clip.every(value=>Math.abs(value)<1),JSON.stringify(clip));
  assert.ok(boundsVisible({min:centre.map(x=>x-1),max:centre.map(x=>x+1)},matrix));
});
test('conservative bounds culling keeps intersecting boxes and rejects fully hidden ones',()=>{
  const matrix=orthographic(-10,10,-10,10,1,100);
  assert.equal(boundsVisible({min:[-30,-30,-10],max:[30,30,-5]},matrix),true);
  assert.equal(boundsVisible({min:[11,-1,-10],max:[12,1,-5]},matrix),false);
  assert.equal(boundsVisible({min:[-1,-1,2],max:[1,1,3]},matrix),false);
});
