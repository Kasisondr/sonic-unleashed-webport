import test from 'node:test';
import assert from 'node:assert/strict';
import {moveCapsule,cameraObstruction} from '../web/collision.mjs';
function surface(vertices,indices=[0,1,2,1,3,2]) {
  const positions=new Float32Array(vertices.flat()),grid=new Map();
  for(let x=-2;x<=2;x++)for(let z=-2;z<=2;z++)grid.set(`${x},${z}`,[0,1]);
  return {chunks:new Map([['solid',{positions,indices:new Uint16Array(indices),grid}]])};
}
test('a thin wall stops a 100m/s sweep while preserving sliding movement',()=>{
  const scene=surface([[-10,-2,2],[10,-2,2],[-10,8,2],[10,8,2]]);
  const velocity=[40,0,100],hit=moveCapsule(scene,[0,1.1,0],[2,0,5],velocity);
  assert.ok(hit.wall);assert.ok(hit.position[2]<1.69);
  assert.ok(hit.position[0]>1.9);assert.ok(Math.abs(velocity[2])<1e-6);
});
test('a low ceiling cancels upward velocity without pushing Sonic through it',()=>{
  const scene=surface([[-10,2,-10],[10,2,-10],[-10,2,10],[10,2,10]]);
  const velocity=[0,20,0],hit=moveCapsule(scene,[0,1.1,0],[0,2,0],velocity);
  assert.ok(hit.ceiling);assert.ok(hit.position[1]<1.69);assert.equal(velocity[1],0);
});
test('camera shortens its boom at a wall, and decorative triangles are excluded',()=>{
  const scene=surface([[-10,-2,2],[10,-2,2],[-10,8,2],[10,8,2]]);
  assert.ok(cameraObstruction(scene,[0,1,0],[0,1,4])[2]<2);
  scene.chunks.get('solid').solidTriangles=new Uint8Array(2);
  assert.deepEqual(cameraObstruction(scene,[0,1,0],[0,1,4]),[0,1,4]);
});
