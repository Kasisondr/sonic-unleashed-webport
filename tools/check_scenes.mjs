// Offline asset and spawn checks using the same controller ground query.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Player} from '../web/player.mjs';
import {LightField} from '../web/light-field.mjs';
const root=path.resolve('dist/probe');
const catalog=JSON.parse(fs.readFileSync(path.join(root,'game/catalog.json')));
const report=[];
function closest2D(p,a,b,c) {
  const area=(b[0]-a[0])*(c[1]-a[1])-(c[0]-a[0])*(b[1]-a[1]);
  if(Math.abs(area)>1e-8) {
    const w0=((b[0]-p[0])*(c[1]-p[1])-(c[0]-p[0])*(b[1]-p[1]))/area;
    const w1=((c[0]-p[0])*(a[1]-p[1])-(a[0]-p[0])*(c[1]-p[1]))/area;
    if(w0>=0&&w1>=0&&w0+w1<=1)return p;
  }
  let best,score=Infinity;
  for(const [u,v] of [[a,b],[b,c],[c,a]]) {
    const dx=v[0]-u[0],dz=v[1]-u[1],length=dx*dx+dz*dz;
    const t=length ? Math.max(0,Math.min(1,((p[0]-u[0])*dx+(p[1]-u[1])*dz)/length)) : 0;
    const q=[u[0]+t*dx,u[1]+t*dz],cost=(q[0]-p[0])**2+(q[1]-p[1])**2;
    if(cost<score){best=q;score=cost;}
  }
  // Move just inside the face to avoid ambiguous shared-edge ground hits.
  return [best[0]*.9999+(a[0]+b[0]+c[0])/3*.0001,best[1]*.9999+(a[1]+b[1]+c[1])/3*.0001];
}
for(const entry of catalog.scenes) {
  const m=JSON.parse(fs.readFileSync(path.join(root,entry.manifest)));
  const chunks=new Map(); let nearest=null; const spawn=m.browserSpawn || m.spawn;
  let checked=0;
  for(const spec of m.chunks) {
    const file=path.join(root,m.assetBase || 'game/',spec.file);
    assert.equal(fs.statSync(file).size,spec.bytes,file);
    const bytes=fs.readFileSync(file),v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    assert.equal(v.getUint32(0,true),0x32554753,file);
    const primitives=v.getUint32(4,true),count=v.getUint32(8,true),indexCount=v.getUint32(12,true);
    const at=16+primitives*24,end=at+count*36;
    assert.equal(end+indexCount*2,bytes.length,file);
    checked++;
    const x=spawn[0],z=spawn[2];
    if(x+80<spec.bounds.min[0]||x-80>spec.bounds.max[0]||z+80<spec.bounds.min[2]||z-80>spec.bounds.max[2])continue;
    const p=new Float32Array(count*3);
    for(let i=0;i<count;i++)for(let k=0;k<3;k++)p[i*3+k]=v.getFloat32(at+i*36+k*4,true);
    const indices=new Uint16Array(bytes.buffer.slice(bytes.byteOffset+end,bytes.byteOffset+end+indexCount*2));
    const triangles=[];
    for(let i=0;i<indexCount/3;i++) {
      const a=indices[i*3]*3,b=indices[i*3+1]*3,c=indices[i*3+2]*3;
      const ab=[p[b]-p[a],p[b+1]-p[a+1],p[b+2]-p[a+2]],ac=[p[c]-p[a],p[c+1]-p[a+1],p[c+2]-p[a+2]];
      const normal=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
      if(Math.abs(normal[1])/Math.hypot(...normal)>.6) {
        const point=closest2D([x,z],[p[a],p[a+2]],[p[b],p[b+2]],[p[c],p[c+2]]);
        const height=p[a+1]-(normal[0]*(point[0]-p[a])+normal[2]*(point[1]-p[a+2]))/normal[1];
        const cost=(point[0]-x)**2+(point[1]-z)**2+(height-spawn[1])**2;
        if(height<spawn[1]+15&&height>spawn[1]-40&&(!nearest||cost<nearest.cost))nearest={position:[point[0],height+.05,point[1]],cost};
      }
      if(x+3<Math.min(p[a],p[b],p[c])||x-3>Math.max(p[a],p[b],p[c])||z+3<Math.min(p[a+2],p[b+2],p[c+2])||z-3>Math.max(p[a+2],p[b+2],p[c+2]))continue;
      triangles.push(i);
    }
    const grid=new Map();
    for(let cx=Math.floor((x-3)/8);cx<=Math.floor((x+3)/8);cx++)for(let cz=Math.floor((z-3)/8);cz<=Math.floor((z+3)/8);cz++)grid.set(`${cx},${cz}`,triangles);
    chunks.set(spec.name,{bounds:spec.bounds,positions:p,indices,grid});
  }
  for(const material of m.materials)for(const field of ['texture','normalTexture','glossTexture','specularTexture']) {
    if(material[field])assert.ok(fs.existsSync(path.join(root,m.assetBase || 'game/','textures',material[field])),material[field]);
  }
  if(m.graphics?.lightField) {
    const spec=m.graphics.lightField,bytes=fs.readFileSync(path.join(root,m.assetBase || 'game/',spec.file));
    assert.equal(bytes.byteLength,spec.bytes);
    const field=new LightField(spec,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    assert.ok(field.sample(spawn).every(Number.isFinite),entry.id);
    assert.ok(field.shadow>=0 && field.shadow<=1.00001,entry.id);
  }
  for(const prop of Object.values(m.props))assert.ok(fs.existsSync(path.join(root,prop.file)),prop.file);
  if(m.audio)assert.ok(fs.existsSync(path.join(root,m.audio.url)),m.audio.url);
  const scene={chunks,manifest:m};const player=new Player(scene,spawn,m.yaw);
  const ground=player.ground(...[spawn[0],spawn[2],spawn[1]+1]);
  for(let frame=0;frame<20;frame++)player.update(1/60,{forward:false,steer:0,jump:false,boost:false,drift:0,lookY:0});
  assert.ok(player.position.every(Number.isFinite));
  if(!ground&&nearest&&nearest.cost<2500&&process.argv.includes('--repair-spawn')) {
    m.browserSpawn=nearest.position;
    m.spawnNote='Nearby terrain start for browser exploration; original scripted/object-supported start is not implemented.';
    fs.writeFileSync(path.join(root,entry.manifest),JSON.stringify(m));
    console.log(`Adjusted browser start: ${entry.title}, ${Math.sqrt(nearest.cost).toFixed(1)}m from original`);
  }
  report.push({id:entry.id,title:entry.title,chunks:checked,grounded:player.grounded,spawn:m.spawn,ground:ground?.y ?? null});
  console.log(`${player.grounded?'PASS':'NO FLOOR'} ${entry.title}: ${checked} chunks, floor ${ground?.y?.toFixed(2)??'missing'}`);
}
fs.writeFileSync('build/scene-checks.json',JSON.stringify(report,null,2));
const missing=report.filter(r=>r.ground===null);
console.log(`${report.length} scene assets validated; ${missing.length} spawn surfaces need attention.`);
if(missing.length)process.exitCode=1;
