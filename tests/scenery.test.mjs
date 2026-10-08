import assert from 'node:assert/strict';
import test from 'node:test';
import {scatterGrass,grassSurface,isWater} from '../web/vegetation.mjs';
import {Companion} from '../web/companion.mjs';

test('water material flags reach the renderer even with opaque geometry slots',()=>{
  assert.equal(isWater({flags:8},0),true);
  assert.equal(isWater({flags:0},8),true);
  assert.equal(isWater({name:'sea_plant_tree',flags:6},2),false);
});
test('grass grows on lawns, not vegetation cards, roads or blended cliff materials',()=>{
  assert.equal(grassSurface({name:'kt_ground_RawnGrass01',flags:0}),true);
  for(const m of [{name:'stone_road',flags:0},{name:'myk_plant_grass01',flags:6},{name:'RawnGrass01',flags:1}])assert.equal(grassSurface(m),false);
});
test('scatter is deterministic, follows triangle height and stays inside its surface',()=>{
  const chunk={chunk:{name:'test'},positions:new Float32Array([0,2,0,0,4,10,10,2,0]),indices:new Uint16Array([0,1,2]),primitives:[{material:0,flags:0,indexStart:0,indexCount:3}]};
  const materials=[{name:'ground_grass',flags:0}];
  const data=scatterGrass(chunk,materials);
  assert.deepEqual(data,scatterGrass(chunk,materials));assert.ok(data.length>300);
  for(let i=0;i<data.length;i+=6){assert.ok(data[i]>=0&&data[i+2]>=0&&data[i]+data[i+2]<=10.00001);assert.ok(Math.abs(data[i+1]-(2+data[i+2]*.2))<1e-5);}
  assert.equal(scatterGrass(chunk,[{name:'pavement',flags:0}]).length,0);
  assert.equal(scatterGrass(chunk,materials,7).length,42);
});
test('Chip follows smoothly, takes the short heading turn and resets at checkpoints',()=>{
  const chip=new Companion(),player={position:[0,3,0],heading:Math.PI-.02,speed:0};
  chip.update(1/60,player);const before=[...chip.position];
  player.position[0]+=1;player.heading=-Math.PI+.02;
  chip.update(1/60,player);
  assert.ok(Math.hypot(...chip.position.map((p,i)=>p-before[i]))<.3);
  assert.ok(Math.abs(chip.heading-(Math.PI-.02))<.01);
  player.position=[1000,10,0];chip.update(1/60,player,true);
  assert.ok(Math.abs(chip.position[0]-1000)<2);assert.equal(chip.animation,'talk');
});
