export class MenuRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = this.gl = canvas.getContext('webgl2', {alpha: false, antialias: false, preserveDrawingBuffer: true});
    if (!gl) throw new Error('This browser could not create a WebGL 2 renderer.');
    const shader = (type, code) => {
      const s = gl.createShader(type); gl.shaderSource(s, code); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const program = this.program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, `#version 300 es
      layout(location=0) in vec2 p;
      layout(location=1) in vec2 uv;
      layout(location=2) in vec4 c;
      out vec2 texCoord; out vec4 tint;
      void main(){gl_Position=vec4(p*vec2(2.,-2.)+vec2(-1.,1.),0.,1.);texCoord=uv;tint=c;}`));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      in vec2 texCoord; in vec4 tint;
      uniform sampler2D atlas; out vec4 result;
      void main(){result=texture(atlas,texCoord)*tint;}`));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program); gl.uniform1i(gl.getUniformLocation(program, 'atlas'), 0);
    this.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (const [slot, size, offset] of [[0, 2, 0], [1, 2, 8], [2, 4, 16]]) {
      gl.enableVertexAttribArray(slot); gl.vertexAttribPointer(slot, size, gl.FLOAT, false, 32, offset);
    }
    gl.enable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    this.white = this.upload(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.drawCalls = 0;
  }
  upload(image, width, height) {
    const gl = this.gl, texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (image instanceof Uint8Array) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, image);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }
  begin() {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawCalls = 0;
  }
  draw(quads) {
    const gl = this.gl;
    for (const q of quads) {
      const [u0, v0, u1, v1] = q.uv;
      const uv = [[u0, v0], [u0, v1], [u1, v0], [u1, v1]];
      const data = [];
      for (const i of [0, 1, 2, 2, 1, 3]) data.push(...q.points[i], ...uv[i], ...q.colors[i]);
      gl.bindTexture(gl.TEXTURE_2D, q.texture || this.white);
      const filter = q.linear ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.blendFuncSeparate(gl.SRC_ALPHA, q.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STREAM_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this.drawCalls++;
    }
  }
}
