// Column-major matrices and conservative bounds checks shared by render passes.
export function multiply(a, b) {
  const out = new Float32Array(16);
  for (let column=0;column<4;column++) for (let row=0;row<4;row++) {
    for (let k=0;k<4;k++) out[column*4+row] += a[k*4+row]*b[column*4+k];
  }
  return out;
}
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const normalize=v=>{const length=Math.hypot(...v)||1;return v.map(x=>x/length);};
export function lookAt(eye, target, up=[0,1,0]) {
  // OpenGL looks down -Z. Reversing this vector puts the shadow casters
  // behind the light's near plane even when their XY coordinates look right.
  const z=normalize(eye.map((value,i)=>value-target[i]));
  if(Math.abs(z[1])>.999) up=[0,0,1];
  const x=normalize(cross(up,z)),y=cross(z,x);
  return new Float32Array([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,
    -x.reduce((s,v,i)=>s+v*eye[i],0),-y.reduce((s,v,i)=>s+v*eye[i],0),-z.reduce((s,v,i)=>s+v*eye[i],0),1]);
}
export function orthographic(left,right,bottom,top,near,far) {
  return new Float32Array([2/(right-left),0,0,0,0,2/(top-bottom),0,0,0,0,-2/(far-near),0,
    -(right+left)/(right-left),-(top+bottom)/(top-bottom),-(far+near)/(far-near),1]);
}
export function boundsVisible(bounds, matrix) {
  if(!bounds) return true;
  // A box may straddle the screen even with every corner off-screen. Reject
  // only when all eight corners lie outside the same homogeneous clip plane.
  for(let axis=0;axis<3;axis++) for(const sign of [-1,1]) {
    const a=matrix[3]+sign*matrix[axis],b=matrix[7]+sign*matrix[4+axis];
    const c=matrix[11]+sign*matrix[8+axis],d=matrix[15]+sign*matrix[12+axis];
    const x=a>=0?bounds.max[0]:bounds.min[0];
    const y=b>=0?bounds.max[1]:bounds.min[1];
    const z=c>=0?bounds.max[2]:bounds.min[2];
    if(a*x+b*y+c*z+d<0) return false;
  }
  return true;
}
