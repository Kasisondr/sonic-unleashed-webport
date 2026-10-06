// Original HE1 light-field tree. Layout follows SharpNeedle and HedgeGI.
// Spatial corner ordering in HedgeGI Math.h is X bit 4, Y bit 2, Z bit 1.
export class LightField {
  constructor(spec, buffer) {
    this.spec=spec; this.view=new DataView(buffer); this.bytes=new Uint8Array(buffer);
    for(const [name,stride] of [['cells',8],['probes',spec.probeStride],['indices',4]]) {
      const block=spec[name];
      if(!block||block.offset<0||block.offset+block.count*stride>buffer.byteLength) throw new Error(`Invalid light-field ${name}`);
    }
    this.colors=new Float32Array(24);this.shadow=1;
  }
  sample(position, colors=this.colors) {
    const {spec,view,bytes}=this,low=[...spec.bounds.min],high=[...spec.bounds.max];
    let cell=0,base=-1;
    for(let depth=0;depth<64;depth++) {
      if(cell>=spec.cells.count) throw new Error('Light-field cell index outside tree');
      const at=spec.cells.offset+cell*8,type=view.getUint32(at),index=view.getUint32(at+4);
      if(type===3){base=index;break;}
      if(type>2) throw new Error('Unknown light-field split axis');
      const middle=(low[type]+high[type])*.5;
      if(position[type]>=middle){low[type]=middle;cell=index+1;}
      else {high[type]=middle;cell=index;}
    }
    if(base<0||base+8>spec.indices.count) throw new Error('Invalid light-field leaf');
    const t=position.map((p,i)=>Math.max(0,Math.min(1,(p-low[i])/Math.max(1e-6,high[i]-low[i]))));
    colors.fill(0);let shadow=0;
    for(let corner=0;corner<8;corner++) {
      const weight=((corner&4)?t[0]:1-t[0])*((corner&2)?t[1]:1-t[1])*((corner&1)?t[2]:1-t[2]);
      const index=view.getUint32(spec.indices.offset+(base+corner)*4);
      if(index>=spec.probes.count) throw new Error('Light-field probe outside array');
      const at=spec.probes.offset+index*spec.probeStride;
      for(let i=0;i<24;i++) colors[i]+=((bytes[at+i]/255)**2)*weight;
      shadow+=(spec.probeStride>=25?bytes[at+24]/255:1)*weight;
    }
    this.shadow=shadow;return colors;
  }
}
