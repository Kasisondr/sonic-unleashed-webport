// Modest bloom for the browser renderer; this is not the original HDR pipeline.
const vertex = `#version 300 es
out vec2 uv;
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.0-1.0,0,1);}`;
const fragment = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D image;
uniform sampler2D glow;
uniform vec2 stepSize;
uniform int mode;
out vec4 result;
void main(){
  vec3 color=texture(image,uv).rgb;
  if(mode==0){
    // Preserve the source lighting; only spread the brightest highlights.
    color=max(color-vec3(.76),vec3(0))*1.25;
  } else if(mode==1){
    color*=.227027;
    color+=(texture(image,uv+stepSize*1.384615).rgb+texture(image,uv-stepSize*1.384615).rgb)*.316216;
    color+=(texture(image,uv+stepSize*3.230769).rgb+texture(image,uv-stepSize*3.230769).rgb)*.070270;
  } else {color+=texture(glow,uv).rgb*.24;}
  result=vec4(color,1);
}`;

export class Postprocess {
  constructor(gl) {
    this.gl=gl;
    this.program=gl.createProgram();
    for(const [type,source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]) {
      const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(this.program,shader);gl.deleteShader(shader);
    }
    gl.linkProgram(this.program);
    if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(this.program));
    this.uniforms=Object.fromEntries(['image','glow','stepSize','mode'].map(n=>[n,gl.getUniformLocation(this.program,n)]));
    this.vao=gl.createVertexArray();
  }
  target(width,height,depth=false) {
    const gl=this.gl, framebuffer=gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
    const texture=(format,type,attachment)=>{
      const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);
      gl.texImage2D(gl.TEXTURE_2D,0,format,width,height,0,format===gl.RGBA8 ? gl.RGBA : gl.DEPTH_COMPONENT,type,null);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,format===gl.RGBA8 ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,format===gl.RGBA8 ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,attachment,gl.TEXTURE_2D,t,0);return t;
    };
    const color=texture(gl.RGBA8,gl.UNSIGNED_BYTE,gl.COLOR_ATTACHMENT0);
    const depthTexture=depth ? texture(gl.DEPTH_COMPONENT24,gl.UNSIGNED_INT,gl.DEPTH_ATTACHMENT) : null;
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Scene framebuffer incomplete');
    return {framebuffer,color,depth:depthTexture,width,height};
  }
  begin(width,height) {
    const gl=this.gl;
    if(this.scene?.width!==width || this.scene?.height!==height){
      for(const t of [this.scene,this.opaque,this.a,this.b])if(t){gl.deleteFramebuffer(t.framebuffer);gl.deleteTexture(t.color);if(t.depth)gl.deleteTexture(t.depth);}
      this.scene=this.target(width,height,true);this.opaque=this.target(width,height,true);
      this.a=this.target(Math.max(1,Math.ceil(width/4)),Math.max(1,Math.ceil(height/4)));
      this.b=this.target(this.a.width,this.a.height);
    }
    // Drop any previous presentation samplers before attaching their images.
    for(const unit of [0,1,6,7]){gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,null);}
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.scene.framebuffer);
  }
  snapshot() {
    const gl=this.gl,{width:w,height:h}=this.scene;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER,this.scene.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,this.opaque.framebuffer);
    gl.blitFramebuffer(0,0,w,h,0,0,w,h,gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT,gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.scene.framebuffer);
    return this.opaque;
  }
  pass(target,image,mode,step=[0,0],glow=null) {
    const gl=this.gl,u=this.uniforms;
    gl.bindSampler(0,null);gl.bindSampler(1,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,target?.framebuffer || null);
    gl.viewport(0,0,target?.width || this.scene.width,target?.height || this.scene.height);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,image);
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,glow);
    gl.uniform1i(u.image,0);gl.uniform1i(u.glow,1);gl.uniform1i(u.mode,mode);gl.uniform2fv(u.stepSize,step);
    gl.drawArrays(gl.TRIANGLES,0,3);
  }
  present() {
    const gl=this.gl;
    gl.disable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.disable(gl.BLEND);gl.depthMask(false);
    gl.useProgram(this.program);gl.bindVertexArray(this.vao);
    this.pass(this.a,this.scene.color,0);
    this.pass(this.b,this.a.color,1,[1/this.a.width,0]);
    this.pass(this.a,this.b.color,1,[0,1/this.a.height]);
    this.pass(null,this.scene.color,2,[0,0],this.a.color);
    gl.activeTexture(gl.TEXTURE0);gl.bindVertexArray(null);gl.depthMask(true);gl.enable(gl.DEPTH_TEST);gl.enable(gl.CULL_FACE);
  }
}
