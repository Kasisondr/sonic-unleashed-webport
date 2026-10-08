// WebGL2 scene: streams the exported terrain chunks and draws sky and props.
import {Rig} from './pose.mjs';
import {Postprocess} from './postprocess.mjs';
import {Companion} from './companion.mjs';
import {isWater, scatterGrass} from './vegetation.mjs';
import {multiply, lookAt, orthographic, boundsVisible} from './render-math.mjs';
import {LightField} from './light-field.mjs';

const CHUNK_MAGIC = 0x32554753;
const VERTEX_BYTES = 36, VERTEX_FLOATS = 9;
const TERRAIN_VERTEX = `#version 300 es
layout(location=0) in vec3 position;
layout(location=1) in vec2 texCoord;
layout(location=2) in vec4 color;
layout(location=3) in vec3 normal;
uniform mat4 viewProjection;
uniform mat4 model;
uniform vec3 cameraPosition;
out vec2 uv;
out vec4 vertexColor;
out vec3 surfaceNormal;
out float distanceFromCamera;
out vec3 worldPosition;
void main() {
  vec4 world = model * vec4(position, 1.0);
  uv = texCoord;
  vertexColor = color;
  surfaceNormal = mat3(model) * normal;
  distanceFromCamera = length(world.xyz - cameraPosition);
  worldPosition = world.xyz;
  gl_Position = viewProjection * world;
}`;

const TERRAIN_FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
in vec4 vertexColor;
in vec3 surfaceNormal;
in float distanceFromCamera;
in vec3 worldPosition;
uniform sampler2D albedo;
uniform sampler2D shadowMap;
uniform sampler2D normalMap;
uniform sampler2D glossMap;
uniform sampler2D specularMap;
uniform vec3 materialDiffuse;
uniform vec3 materialAmbient;
uniform vec3 materialSpecular;
uniform vec3 materialEmissive;
uniform vec4 powerGlossLevel;
uniform float materialOpacity;
uniform float hasNormal;
uniform float hasGloss;
uniform float hasSpecular;
uniform vec3 giColors[8];
uniform float hasGI;
uniform float probeShadow;
uniform vec3 ambientOffsetUp;
uniform vec3 ambientOffsetDown;
uniform int pointCount;
uniform vec4 pointPositions[8];
uniform vec4 pointColors[8];
uniform vec3 cameraForward;
uniform vec4 fogParams;
uniform vec4 scatteringParams;
uniform vec3 scatteringColor;
uniform float scatteringDepthScale;
uniform mat4 lightViewProjection;
uniform vec3 sunDirection;
uniform vec3 sunColor;
uniform vec3 cameraPosition;
uniform vec3 skyColor;
uniform vec3 ambientUp;
uniform vec3 ambientDown;
uniform float fogDensity;
uniform float alphaTest;
uniform float unlit;
uniform float shadowStrength;
uniform vec4 tint;
out vec4 result;

/**
 * Compare this fragment's depth in the sun's clip space against the shadow
 * map, softened with a small rotated-poisson tap pattern so shadow edges do
 * not stair-step. Anything outside the map is simply lit.
 */
float sunShadow(vec3 world) {
  vec4 light = lightViewProjection * vec4(world, 1.0);
  vec3 projected = (light.xyz / light.w) * 0.5 + 0.5;
  if (projected.z < 0.0 || projected.z > 1.0 || projected.x < 0.0 || projected.x > 1.0
      || projected.y < 0.0 || projected.y > 1.0) return 1.0;
  float bias = max(0.0016 * (1.0 - dot(normalize(surfaceNormal), sunDirection)), 0.0004);
  vec2 texel = 1.0 / vec2(textureSize(shadowMap, 0));
  float reference = projected.z - bias;
  float lit = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 offset = vec2(float(i & 1), float(i >> 1)) * 2.0 - 1.0;
    float depth = texture(shadowMap, projected.xy + offset * texel * 1.6).r;
    lit += step(reference, depth);
  }
  return mix(1.0, lit * 0.25, shadowStrength);
}

vec3 surfaceLightingNormal(vec3 n) {
  if(hasNormal < .5) return n;
  vec2 xy=texture(normalMap,uv).rg*2.0-1.0;
  vec3 map=vec3(xy,sqrt(max(0.0,1.0-dot(xy,xy))));
  vec3 dp1=dFdx(worldPosition),dp2=dFdy(worldPosition);
  vec2 duv1=dFdx(uv),duv2=dFdy(uv);
  vec3 p2=cross(dp2,n),p1=cross(n,dp1);
  vec3 t=p2*duv1.x+p1*duv2.x,b=p2*duv1.y+p1*duv2.y;
  float lengthSquared=max(dot(t,t),dot(b,b));
  if(lengthSquared<1e-12) return n;
  float scale=inversesqrt(lengthSquared);
  return normalize(mat3(t*scale,b*scale,n)*map);
}

vec3 indirectLight(vec3 normal) {
  vec3 offset=mix(ambientOffsetDown,ambientOffsetUp,normal.y*.5+.5);
  if(hasGI < .5) return mix(ambientDown,ambientUp,normal.y*.5+.5)+offset;
  vec3 colour=vec3(0.0);float total=0.0;
  for(int i=0;i<8;i++) {
    vec3 d=normalize(vec3((i&4)==0?-1.0:1.0,(i&2)==0?-1.0:1.0,(i&1)==0?-1.0:1.0));
    float w=max(0.0,dot(normal,d));colour+=giColors[i]*w;total+=w;
  }
  return colour/max(total,1e-6)+offset;
}

void main() {
  vec4 texel = texture(albedo, uv);
  if (texel.a <= alphaTest) discard;
  vec3 normal = surfaceLightingNormal(normalize(surfaceNormal));
  if (!gl_FrontFacing) normal = -normal;

  float shadow = sunShadow(worldPosition)*probeShadow;
  float sun = max(dot(normal, sunDirection), 0.0) * shadow;

  vec3 direct = sunColor * sun;
  vec3 eye = normalize(cameraPosition - worldPosition);
  vec3 halfVec = normalize(eye + sunDirection);
  float exponent=clamp(powerGlossLevel.x,1.0,1024.0),intensity=powerGlossLevel.z;
  if(hasGloss>.5) {
    float gloss=texture(glossMap,uv).r;
    exponent=clamp(gloss*powerGlossLevel.y*500.0,1.0,1024.0);
    intensity=gloss*powerGlossLevel.z*5.0;
  }
  vec3 specular=materialSpecular*intensity;
  if(hasSpecular>.5) specular*=texture(specularMap,uv).rgb;
  vec3 highlight=sunColor*pow(max(0.0,dot(normal,halfVec)),exponent)*shadow*specular;
  for(int i=0;i<8;i++) {
    if(i>=pointCount) break;
    vec3 delta=pointPositions[i].xyz-worldPosition;float distance=length(delta);
    float falloff=1.0-smoothstep(pointColors[i].w,pointPositions[i].w,distance);
    vec3 light=delta/max(distance,1e-6);
    direct+=pointColors[i].rgb*max(dot(normal,light),0.0)*falloff;
    highlight+=pointColors[i].rgb*pow(max(dot(normal,normalize(eye+light)),0.0),exponent)*specular*falloff;
  }
  vec3 base=pow(max(texel.rgb,vec3(0.0)),vec3(2.2))*vertexColor.rgb*tint.rgb;
  vec3 lit=base*(indirectLight(normal)*materialAmbient+direct*materialDiffuse)+highlight+materialEmissive;
  lit = mix(lit, base, unlit);
  if(fogParams.w>.5) {
    // HE1 scattering math from HedgeGI SceneEffect.cpp; source parameters
    // determine density, phase and range rather than one global fog colour.
    float depth=max(dot(worldPosition-cameraPosition,cameraForward)-fogParams.x,0.0);
    depth=clamp(depth/max(fogParams.y-fogParams.x,1e-5),0.0,1.0)*scatteringDepthScale;
    float ray=scatteringParams.x,mie=scatteringParams.y,g=scatteringParams.z;
    float transmission=exp(-depth*(ray+mie));
    float cosine=dot(sunDirection,eye);
    float phase=ray*3.0/(16.0*3.14159265)*(cosine*cosine+1.0)
      +mie/(4.0*3.14159265)*(1.0-g)*(1.0-g)/pow(max(g*g+1.0-2.0*g*cosine,1e-5),1.5);
    lit=lit*transmission+scatteringColor*(1.0-transmission)*phase/max(ray+mie,1e-5)*scatteringParams.w;
  } else {
    float fog=1.0-exp(-pow(distanceFromCamera*fogDensity,2.0));
    lit=mix(lit,pow(skyColor,vec3(2.2)),clamp(fog,0.0,1.0));
  }
  result=vec4(pow(max(lit,vec3(0.0)),vec3(1.0/2.2)),texel.a*vertexColor.a*tint.a*materialOpacity);
}`;

/** Depth-only pass that fills the sun's shadow map. */
const SHADOW_VERTEX = `#version 300 es
layout(location=0) in vec3 position;
layout(location=1) in vec2 texCoord;
layout(location=2) in vec4 color;
layout(location=4) in vec4 blendIndices;
layout(location=5) in vec4 blendWeights;
uniform mat4 lightViewProjection;
uniform mat4 model;
uniform sampler2D boneTexture;
out vec2 shadowUV;
out float shadowAlpha;
mat4 bone(int index) {
  int at = index * 4;
  return mat4(texelFetch(boneTexture, ivec2(at + 0, 0), 0),
              texelFetch(boneTexture, ivec2(at + 1, 0), 0),
              texelFetch(boneTexture, ivec2(at + 2, 0), 0),
              texelFetch(boneTexture, ivec2(at + 3, 0), 0));
}
void main() {
  shadowUV = texCoord;
  shadowAlpha = color.a;
  mat4 skin = mat4(1.0);
  if (blendWeights.x + blendWeights.y + blendWeights.z + blendWeights.w > 0.0) {
    float total = dot(blendWeights, vec4(1.0));
    vec4 weights = blendWeights / max(total, 1e-4);
    skin = bone(int(blendIndices.x)) * weights.x + bone(int(blendIndices.y)) * weights.y
         + bone(int(blendIndices.z)) * weights.z + bone(int(blendIndices.w)) * weights.w;
  }
  gl_Position = lightViewProjection * (model * (skin * vec4(position, 1.0)));
}`;

const SHADOW_FRAGMENT = `#version 300 es
precision highp float;
in vec2 shadowUV;
in float shadowAlpha;
uniform sampler2D albedo;
uniform float alphaTest;
void main() {
  if (texture(albedo, shadowUV).a * shadowAlpha <= alphaTest) discard;
}`;

// Sonic's mesh: same surface shading, plus four blend weights resolved through
// a bone texture that the rig fills with one skinning matrix per bone.
const SKINNED_VERTEX = `#version 300 es
layout(location=0) in vec3 position;
layout(location=1) in vec2 texCoord;
layout(location=2) in vec4 color;
layout(location=3) in vec3 normal;
layout(location=4) in vec4 blendIndices;
layout(location=5) in vec4 blendWeights;
uniform mat4 viewProjection;
uniform mat4 model;
uniform vec3 cameraPosition;
uniform sampler2D boneTexture;
out vec2 uv;
out vec4 vertexColor;
out vec3 surfaceNormal;
out float distanceFromCamera;
out vec3 worldPosition;
mat4 bone(int index) {
  int at = index * 4;
  return mat4(texelFetch(boneTexture, ivec2(at + 0, 0), 0),
              texelFetch(boneTexture, ivec2(at + 1, 0), 0),
              texelFetch(boneTexture, ivec2(at + 2, 0), 0),
              texelFetch(boneTexture, ivec2(at + 3, 0), 0));
}
void main() {
  float total = dot(blendWeights, vec4(1.0));
  vec4 weights = blendWeights / max(total, 1e-4);
  mat4 skin = bone(int(blendIndices.x)) * weights.x + bone(int(blendIndices.y)) * weights.y
            + bone(int(blendIndices.z)) * weights.z + bone(int(blendIndices.w)) * weights.w;
  vec4 world = model * (skin * vec4(position, 1.0));
  uv = texCoord;
  vertexColor = color;
  surfaceNormal = mat3(model) * (mat3(skin) * normal);
  distanceFromCamera = length(world.xyz - cameraPosition);
  worldPosition = world.xyz;
  gl_Position = viewProjection * world;
}`;

const SKY_VERTEX = `#version 300 es
layout(location=0) in vec3 position;
uniform mat4 viewProjection;
out vec3 direction;
void main() {
  direction = position;
  gl_Position = viewProjection * vec4(position, 1.0);
}`;

const SKY_FRAGMENT = `#version 300 es
precision highp float;
in vec3 direction;
uniform sampler2D skyTexture;
uniform sampler2D skyLayer;
uniform vec3 skyColor;
uniform float hasTexture;
uniform float hasLayer;
out vec4 result;
void main() {
  if (hasTexture > 0.5) {
    vec3 point = normalize(direction);
    float u = atan(point.z, point.x) / 6.2831853 + 0.5;
    float v = clamp(point.y * 0.5 + 0.5, 0.0, 1.0);
    vec2 uv = vec2(u, 1.0 - v);
    vec3 colour = texture(skyTexture, uv).rgb;
    // The disc's sky has a second layer the Sky shader blends over the base
    // dome; here it adds the moving cloud layer at the dome's own scale.
    if (hasLayer > 0.5) {
      vec4 layer = texture(skyLayer, uv * vec2(1.0, 2.0));
      colour = mix(colour, layer.rgb, layer.a * 0.85);
    }
    result = vec4(colour, 1.0);
  } else {
    result = vec4(skyColor, 1.0);
  }
}`;

// Dedicated Mediterranean sea shader: multi-wave Gerstner displacement, sun glints, Fresnel sky reflection
const WATER_VERTEX = `#version 300 es
layout(location=0) in vec3 position;
layout(location=1) in vec2 texCoord;
layout(location=2) in vec4 color;
layout(location=3) in vec3 normal;
uniform mat4 viewProjection;
uniform mat4 model;
uniform vec3 cameraPosition;
uniform float time;
out vec2 uv;
out vec3 worldPosition;
out vec3 vertexNormal;
out float distanceFromCamera;
out float waveHeight;
void main() {
  vec4 world = model * vec4(position, 1.0);
  uv = texCoord;
  float t = time * 1.6;
  float w1 = sin(world.x * 0.14 + t * 1.3) * cos(world.z * 0.12 + t * 0.9) * 0.28;
  float w2 = sin(world.x * 0.26 - t * 1.5 + world.z * 0.20) * 0.15;
  float w3 = cos(world.x * 0.05 + world.z * 0.07 + t * 0.6) * 0.32;
  float wave = w1 + w2 + w3;
  world.y += wave;
  waveHeight = wave;
  worldPosition = world.xyz;
  vertexNormal = mat3(model) * normal;
  distanceFromCamera = length(world.xyz - cameraPosition);
  gl_Position = viewProjection * world;
}`;

const WATER_FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
in vec3 worldPosition;
in vec3 vertexNormal;
in float distanceFromCamera;
in float waveHeight;
uniform vec3 sunDirection;
uniform vec3 sunColor;
uniform vec3 cameraPosition;
uniform vec3 skyColor;
uniform float time;
uniform float fogDensity;
uniform sampler2D sceneColor;
uniform sampler2D sceneDepth;
uniform vec2 viewportSize;
float linearDepth(float depth){return (.3*4200.0)/(4200.0-depth*(4200.0-.3));}
out vec4 result;
void main() {
  float t = time * 1.8;
  vec2 p = worldPosition.xz * 0.2;
  float dX = cos(p.x * 2.5 + t) * 0.14 + cos(p.x * 5.2 - t * 1.3 + p.y * 3.1) * 0.09;
  float dZ = sin(p.y * 2.5 + t * 1.2) * 0.14 + sin(p.y * 5.0 + t * 1.4 - p.x * 2.8) * 0.08;
  vec3 N = normalize(vec3(-dX, 1.0, -dZ));
  if (!gl_FrontFacing) N = -N;

  vec3 V = normalize(cameraPosition - worldPosition);
  vec3 L = normalize(sunDirection);
  vec3 H = normalize(V + L);

  vec3 shallowTurquoise = vec3(0.09, 0.78, 0.88);
  vec3 deepAzure = vec3(0.02, 0.24, 0.54);
  float crest = clamp((waveHeight + 0.35) / 0.7, 0.0, 1.0);
  vec3 waterColor = mix(deepAzure, shallowTurquoise, crest * 0.65 + 0.15);

  float sunDiff = max(0.0, dot(N, L));
  vec3 directSun = sunColor * sunDiff * 0.55;
  vec3 ambientSky = mix(deepAzure, skyColor, 0.45);

  float fresnel = clamp(pow(1.0 - max(0.0, dot(N, V)), 3.8), 0.0, 1.0);
  vec3 reflection = mix(skyColor, vec3(0.88, 0.95, 1.0), fresnel);

  float spec1 = pow(max(0.0, dot(N, H)), 72.0) * 1.8;
  float spec2 = pow(max(0.0, dot(N, H)), 240.0) * 3.5;
  vec3 specular = sunColor * (spec1 + spec2);

  float foamNoise = sin(worldPosition.x * 1.6 + t * 2.2) * cos(worldPosition.z * 1.6 - t * 1.7);
  float foam = smoothstep(0.32, 0.62, waveHeight + foamNoise * 0.14);
  vec3 foamColor = vec3(0.95, 0.98, 1.0);

  vec2 screenUV=gl_FragCoord.xy/viewportSize;
  float thickness=max(0.0,linearDepth(texture(sceneDepth,screenUV).r)-linearDepth(gl_FragCoord.z));
  vec2 refractUV=clamp(screenUV+N.xz*.012*min(thickness*.2,1.0),vec2(.001),vec2(.999));
  if(texture(sceneDepth,refractUV).r < gl_FragCoord.z) refractUV=screenUV;
  vec3 submerged=texture(sceneColor,refractUV).rgb;
  float shore=(1.0-smoothstep(.15,1.6,thickness))*(.65+.35*sin(worldPosition.x*2.0+worldPosition.z*1.4-t*2.0));
  foam=max(foam*.3,shore);
  vec3 finalColor = mix(waterColor * (ambientSky + directSun), reflection, fresnel * 0.7);
  finalColor = mix(submerged,finalColor,1.0-exp(-thickness*.22));
  finalColor += specular;
  finalColor = mix(finalColor, foamColor, foam * 0.5);

  float fog = 1.0 - exp(-pow(distanceFromCamera * fogDensity, 2.0));
  finalColor = mix(finalColor, skyColor, clamp(fog, 0.0, 1.0));

  float alpha = 1.0;
  result = vec4(finalColor, alpha);
}`;

// Instanced 3D grass & wildflower shader with real-time wind wave sway
const GRASS_VERTEX = `#version 300 es
layout(location=0) in vec3 position;
layout(location=1) in vec2 texCoord;
layout(location=2) in float isFlower;
layout(location=3) in vec3 instancePos;
layout(location=4) in vec3 instanceParams;

uniform mat4 viewProjection;
uniform vec3 cameraPosition;
uniform float time;

out vec2 uv;
out float heightFrac;
out float flower;
out float flowerColorIndex;
out vec3 worldPos;
out float distanceFromCamera;

void main() {
  float scale = instanceParams.x;
  float rot = instanceParams.y;
  flowerColorIndex = instanceParams.z;
  flower = isFlower;
  heightFrac = texCoord.y;
  uv = texCoord;

  float cr = cos(rot), sr = sin(rot);
  vec3 local = position * scale;
  vec3 rotated = vec3(local.x * cr - local.z * sr, local.y, local.x * sr + local.z * cr);
  vec3 world = instancePos + rotated;

  float swayFactor = pow(texCoord.y, 1.4);
  float windWave = sin(time * 3.2 + world.x * 0.35 + world.z * 0.25) * 0.22
                 + sin(time * 5.5 + world.x * 0.8) * 0.08;
  world.x += windWave * swayFactor * 1.5;
  world.z += windWave * 0.6 * swayFactor * 1.5;

  worldPos = world;
  distanceFromCamera = length(world - cameraPosition);
  gl_Position = viewProjection * vec4(world, 1.0);
}`;

const GRASS_FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
in float heightFrac;
in float flower;
in float flowerColorIndex;
in vec3 worldPos;
in float distanceFromCamera;

uniform vec3 sunDirection;
uniform vec3 sunColor;
uniform vec3 skyColor;
uniform float fogDensity;

out vec4 result;

void main() {
  if (distanceFromCamera > 76.0) discard;
  if (flower > 0.5) {
    if (flowerColorIndex < 0.5) discard;
    vec3 petal = (flowerColorIndex > 1.5) ? vec3(0.98, 0.98, 1.0) : vec3(1.0, 0.88, 0.22);
    if (length(uv - vec2(0.5, 0.5)) < 0.25 && flowerColorIndex > 1.5) petal = vec3(1.0, 0.78, 0.1);
    float fog = 1.0 - exp(-pow(distanceFromCamera * fogDensity, 2.0));
    result = vec4(mix(petal, skyColor, clamp(fog, 0.0, 1.0)), 1.0);
    return;
  }

  vec3 baseGreen = vec3(0.12, 0.34, 0.08);
  vec3 tipGreen = vec3(0.48, 0.82, 0.16);
  vec3 color = mix(baseGreen, tipGreen, heightFrac);
  float sun = max(0.0, dot(vec3(0.0, 1.0, 0.0), normalize(sunDirection)));
  color *= (mix(vec3(0.32, 0.38, 0.25), skyColor * 0.65, 0.5) + sunColor * sun * 0.46);
  float blade = abs(uv.x - 0.5);
  if (blade > mix(0.5, 0.06, heightFrac)) discard;
  color *= 0.88 + 0.12 * sin(worldPos.x * 1.7 + worldPos.z * 2.1);

  float fog = 1.0 - exp(-pow(distanceFromCamera * fogDensity, 2.0));
  vec3 lit = mix(color, skyColor, clamp(fog, 0.0, 1.0));
  result = vec4(lit, 1.0);
}`;

const STAR_VERTEX = `#version 300 es
layout(location=0) in vec2 quad;
uniform mat4 viewProjection;
uniform vec3 center;
uniform vec3 cameraRight;
uniform vec3 cameraUp;
uniform float scale;
uniform float rotation;
out vec2 starUV;
void main() {
  starUV = quad;
  float cr = cos(rotation), sr = sin(rotation);
  vec2 rot = vec2(quad.x * cr - quad.y * sr, quad.x * sr + quad.y * cr);
  vec3 world = center + (cameraRight * rot.x + cameraUp * rot.y) * scale;
  gl_Position = viewProjection * vec4(world, 1.0);
}`;

const STAR_FRAGMENT = `#version 300 es
precision highp float;
in vec2 starUV;
uniform vec4 starColor;
out vec4 result;
void main() {
  vec2 p = abs(starUV);
  float crossGleam = max(max(1.0 - p.x * 4.0, 0.0) * max(1.0 - p.y * 1.2, 0.0),
                         max(1.0 - p.y * 4.0, 0.0) * max(1.0 - p.x * 1.2, 0.0));
  float core = clamp(1.0 - length(starUV) * 2.2, 0.0, 1.0);
  float sparkle = max(crossGleam, core);
  if (sparkle <= 0.04) discard;
  result = vec4(starColor.rgb * sparkle * 1.6, sparkle * starColor.a);
}`;

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** Set a vec3 uniform on whichever program is currently bound. */
function gl3(gl, location, value) {
  if (location) gl.uniform3f(location, value[0], value[1], value[2]);
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

function program(gl, vertex, fragment) {
  const result = gl.createProgram();
  gl.attachShader(result, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(result, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(result);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result));
  return result;
}

/** Column-major placement: yaw rotation, extra spin about Y, then a uniform scale. */
function placement(position, yawDegrees, scale, spin) {
  const angle = (yawDegrees || 0) * Math.PI / 180 + spin;
  const cosine = Math.cos(angle) * scale, sine = Math.sin(angle) * scale;
  return new Float32Array([
    cosine, 0, -sine, 0,
    0, scale, 0, 0,
    sine, 0, cosine, 0,
    position[0], position[1], position[2], 1]);
}

export class Scene {
  constructor(canvas, manifest) {
    this.canvas = canvas;
    this.manifest = manifest;
    const gl = this.gl = canvas.getContext('webgl2', {alpha: false, antialias: true, powerPreference: 'high-performance'});
    if (!gl) throw new Error('This browser could not create a WebGL 2 renderer.');
    this.terrain = program(gl, TERRAIN_VERTEX, TERRAIN_FRAGMENT);
    this.skinned = program(gl, SKINNED_VERTEX, TERRAIN_FRAGMENT);
    this.skyProgram = program(gl, SKY_VERTEX, SKY_FRAGMENT);
    this.shadowProgram = program(gl, SHADOW_VERTEX, SHADOW_FRAGMENT);
    // The stage's own sky texture tells us where the sun is; see prepare_sky.py.
    const sourceLight=manifest.graphics?.lights?.find(light=>light.type==='directional');
    const sun = sourceLight?.direction ? normalize(sourceLight.direction.map(value=>-value)) : (manifest.sky?.sun?.direction || [0.35, 0.72, 0.6]);
    this.sunColor=sourceLight?.color || [1,1,1];
    this.sunDirection = new Float32Array(sun);
    this.shadowExtent = 78;
    this.lightViewProjection = new Float32Array(16);
    this.uniforms = {
      viewProjection: gl.getUniformLocation(this.terrain, 'viewProjection'),
      model: gl.getUniformLocation(this.terrain, 'model'),
      cameraPosition: gl.getUniformLocation(this.terrain, 'cameraPosition'),
      albedo: gl.getUniformLocation(this.terrain, 'albedo'),
      sunDirection: gl.getUniformLocation(this.terrain, 'sunDirection'),
      sunColor: gl.getUniformLocation(this.terrain, 'sunColor'),
      skyColor: gl.getUniformLocation(this.terrain, 'skyColor'),
      ambientUp: gl.getUniformLocation(this.terrain, 'ambientUp'),
      ambientDown: gl.getUniformLocation(this.terrain, 'ambientDown'),
      fogDensity: gl.getUniformLocation(this.terrain, 'fogDensity'),
      alphaTest: gl.getUniformLocation(this.terrain, 'alphaTest'),
      unlit: gl.getUniformLocation(this.terrain, 'unlit'),
      tint: gl.getUniformLocation(this.terrain, 'tint'),
      shadowMap: gl.getUniformLocation(this.terrain, 'shadowMap'),
      lightViewProjection: gl.getUniformLocation(this.terrain, 'lightViewProjection'),
      shadowStrength: gl.getUniformLocation(this.terrain, 'shadowStrength'),
    };
    this.skinUniforms = {
      viewProjection: gl.getUniformLocation(this.skinned, 'viewProjection'),
      model: gl.getUniformLocation(this.skinned, 'model'),
      cameraPosition: gl.getUniformLocation(this.skinned, 'cameraPosition'),
      albedo: gl.getUniformLocation(this.skinned, 'albedo'),
      sunDirection: gl.getUniformLocation(this.skinned, 'sunDirection'),
      sunColor: gl.getUniformLocation(this.skinned, 'sunColor'),
      skyColor: gl.getUniformLocation(this.skinned, 'skyColor'),
      ambientUp: gl.getUniformLocation(this.skinned, 'ambientUp'),
      ambientDown: gl.getUniformLocation(this.skinned, 'ambientDown'),
      fogDensity: gl.getUniformLocation(this.skinned, 'fogDensity'),
      alphaTest: gl.getUniformLocation(this.skinned, 'alphaTest'),
      unlit: gl.getUniformLocation(this.skinned, 'unlit'),
      tint: gl.getUniformLocation(this.skinned, 'tint'),
      boneTexture: gl.getUniformLocation(this.skinned, 'boneTexture'),
      shadowMap: gl.getUniformLocation(this.skinned, 'shadowMap'),
      lightViewProjection: gl.getUniformLocation(this.skinned, 'lightViewProjection'),
      shadowStrength: gl.getUniformLocation(this.skinned, 'shadowStrength'),
    };
    this.shadowUniforms = {
      lightViewProjection: gl.getUniformLocation(this.shadowProgram, 'lightViewProjection'),
      model: gl.getUniformLocation(this.shadowProgram, 'model'),
      boneTexture: gl.getUniformLocation(this.shadowProgram, 'boneTexture'),
      albedo: gl.getUniformLocation(this.shadowProgram, 'albedo'),
      alphaTest: gl.getUniformLocation(this.shadowProgram, 'alphaTest'),
    };
    this.rig = null;
    this.boneTexture = null;
    this.shadowTarget = null;
    this.shadowSize = 2048;
    gl.useProgram(this.terrain);
    gl.uniform1i(this.uniforms.albedo, 0);
    gl.uniform1i(this.uniforms.shadowMap, 2);
    gl.uniform3fv(this.uniforms.sunDirection, this.sunDirection);
    gl.uniform3f(this.uniforms.sunColor, 1.35, 1.28, 1.18);
    gl.uniform3f(this.uniforms.ambientUp, 0.60, 0.72, 0.90);
    gl.uniform3f(this.uniforms.ambientDown, 0.42, 0.38, 0.32);
    gl.uniform3f(this.uniforms.skyColor, 0.55, 0.72, 0.88);
    gl.uniform1f(this.uniforms.fogDensity, 0.0022);
    gl.uniform1f(this.uniforms.shadowStrength, 1);
    gl.useProgram(this.skinned);
    gl.uniform1i(this.skinUniforms.albedo, 0);
    gl.uniform1i(this.skinUniforms.boneTexture, 1);
    gl.uniform1i(this.skinUniforms.shadowMap, 2);
    gl.uniform3fv(this.skinUniforms.sunDirection, this.sunDirection);
    gl.uniform3f(this.skinUniforms.sunColor, 1.35, 1.28, 1.18);
    gl.uniform3f(this.skinUniforms.ambientUp, 0.60, 0.72, 0.90);
    gl.uniform3f(this.skinUniforms.ambientDown, 0.42, 0.38, 0.32);
    gl.uniform3f(this.skinUniforms.skyColor, 0.55, 0.72, 0.88);
    gl.uniform1f(this.skinUniforms.fogDensity, 0.0022);
    gl.uniform1f(this.skinUniforms.shadowStrength, 1);

    this.initializeMaterials(this.terrain,this.uniforms);
    this.initializeMaterials(this.skinned,this.skinUniforms);
    gl.useProgram(this.skyProgram);
    gl.uniform1i(gl.getUniformLocation(this.skyProgram, 'skyTexture'), 0);
    gl.uniform1i(gl.getUniformLocation(this.skyProgram, 'skyLayer'), 1);
    gl.useProgram(this.shadowProgram);
    gl.uniform1i(this.shadowUniforms.albedo, 0);
    gl.uniform1i(this.shadowUniforms.boneTexture, 1);

    this.postprocess = new Postprocess(gl);
    this.waterProgram = program(gl, WATER_VERTEX, WATER_FRAGMENT);
    this.waterUniforms = {
      viewProjection: gl.getUniformLocation(this.waterProgram, 'viewProjection'),
      model: gl.getUniformLocation(this.waterProgram, 'model'),
      cameraPosition: gl.getUniformLocation(this.waterProgram, 'cameraPosition'),
      sunDirection: gl.getUniformLocation(this.waterProgram, 'sunDirection'),
      sunColor: gl.getUniformLocation(this.waterProgram, 'sunColor'),
      skyColor: gl.getUniformLocation(this.waterProgram, 'skyColor'),
      time: gl.getUniformLocation(this.waterProgram, 'time'),
      fogDensity: gl.getUniformLocation(this.waterProgram, 'fogDensity'),
    };
    for (const name of ['sceneColor','sceneDepth','viewportSize']) this.waterUniforms[name]=gl.getUniformLocation(this.waterProgram,name);
    this.grassProgram = program(gl, GRASS_VERTEX, GRASS_FRAGMENT);
    this.grassUniforms = {
      viewProjection: gl.getUniformLocation(this.grassProgram, 'viewProjection'),
      cameraPosition: gl.getUniformLocation(this.grassProgram, 'cameraPosition'),
      sunDirection: gl.getUniformLocation(this.grassProgram, 'sunDirection'),
      sunColor: gl.getUniformLocation(this.grassProgram, 'sunColor'),
      skyColor: gl.getUniformLocation(this.grassProgram, 'skyColor'),
      time: gl.getUniformLocation(this.grassProgram, 'time'),
      fogDensity: gl.getUniformLocation(this.grassProgram, 'fogDensity'),
    };
    this.starProgram = program(gl, STAR_VERTEX, STAR_FRAGMENT);
    this.starUniforms = {
      viewProjection: gl.getUniformLocation(this.starProgram, 'viewProjection'),
      center: gl.getUniformLocation(this.starProgram, 'center'),
      cameraRight: gl.getUniformLocation(this.starProgram, 'cameraRight'),
      cameraUp: gl.getUniformLocation(this.starProgram, 'cameraUp'),
      scale: gl.getUniformLocation(this.starProgram, 'scale'),
      rotation: gl.getUniformLocation(this.starProgram, 'rotation'),
      starColor: gl.getUniformLocation(this.starProgram, 'starColor'),
    };

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    this.white = this.upload(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.chunks = new Map();
    this.textures = new Map();
    this.samplers = new Map();
    this.pointLights=(manifest.graphics?.lights || []).filter(light=>light.type==='point');
    this.prefabs = new Map();
    this.props = [];
    this.objects = [];
    this.propModels = null;
    this.stats = {chunks: 0, drawCalls: 0, triangles: 0, loading: 0};
    this.skyMesh = null;
    this.skyTexture = null;
    this.skyLayer = null;
    this.streamDistance = 320;
    this.keepDistance = 460;
    this.onChunkLoaded = null;
    this.createGrass();
    this.createStarMesh();
  }

  initializeMaterials(program,uniforms) {
    const gl=this.gl;
    for(const name of ['normalMap','glossMap','specularMap','materialDiffuse','materialAmbient','materialSpecular',
      'materialEmissive','powerGlossLevel','materialOpacity','hasNormal','hasGloss','hasSpecular','hasGI','probeShadow',
      'ambientOffsetUp','ambientOffsetDown','pointCount','cameraForward','fogParams','scatteringParams',
      'scatteringColor','scatteringDepthScale']) uniforms[name]=gl.getUniformLocation(program,name);
    for(const name of ['giColors','pointPositions','pointColors']) uniforms[name]=gl.getUniformLocation(program,`${name}[0]`);
    gl.useProgram(program);
    gl.uniform1i(uniforms.normalMap,3);gl.uniform1i(uniforms.glossMap,4);gl.uniform1i(uniforms.specularMap,5);
    gl.uniform3fv(uniforms.sunColor,this.sunColor);gl.uniform1f(uniforms.probeShadow,1);
    const ambient=this.manifest.graphics?.ambient || {};
    gl.uniform3fv(uniforms.ambientUp,ambient.up || [.25,.25,.25]);
    gl.uniform3fv(uniforms.ambientDown,ambient.down || [.25,.25,.25]);
    gl.uniform3fv(uniforms.ambientOffsetUp,ambient.offsetUp || [0,0,0]);
    gl.uniform3fv(uniforms.ambientOffsetDown,ambient.offsetDown || [0,0,0]);
    const graphics=this.manifest.graphics || {},fog=graphics.fog;
    const scatter=graphics.effectParameters?.LightScattering?.LightScattering;
    gl.uniform4f(uniforms.fogParams,fog?.near || 0,fog?.far || 1000,fog?.density || 0,scatter?1:0);
    gl.uniform3fv(uniforms.scatteringColor,fog?.color || [0,0,0]);
    gl.uniform1f(uniforms.scatteringDepthScale,fog?.scatteringScale || 0);
    gl.uniform4f(uniforms.scatteringParams,scatter?.['ms_Ray_Mie_Ray2_Mie2.x'] || 0,
      scatter?.['ms_Ray_Mie_Ray2_Mie2.y'] || 0,scatter?.ms_G || 0,scatter?.['ms_FarNearScale.w'] || 0);
    this.bindMaterial(uniforms,{},new Map());
  }

  sampler(channel) {
    const gl=this.gl,u=channel?.wrapU || 0,v=channel?.wrapV || 0,key=`${u},${v}`;
    if(this.samplers?.has(key))return this.samplers.get(key);
    const sampler=gl.createSampler(),modes=[gl.REPEAT,gl.MIRRORED_REPEAT,gl.CLAMP_TO_EDGE,gl.CLAMP_TO_EDGE,gl.CLAMP_TO_EDGE];
    gl.samplerParameteri(sampler,gl.TEXTURE_WRAP_S,modes[u] ?? gl.REPEAT);
    gl.samplerParameteri(sampler,gl.TEXTURE_WRAP_T,modes[v] ?? gl.REPEAT);
    gl.samplerParameteri(sampler,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
    gl.samplerParameteri(sampler,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    this.samplers?.set(key,sampler);return sampler;
  }

  bindMaterial(uniforms,material,cache=this.textureCache) {
    const gl=this.gl;
    const values=material.gpuValues ||= {
      diffuse:new Float32Array((material.diffuseColor || [1,1,1]).slice(0,3)),
      ambient:new Float32Array((material.ambientColor || [1,1,1]).slice(0,3)),
      specular:new Float32Array((material.specularColor || [0,0,0]).slice(0,3)),
      emissive:new Float32Array((material.emissiveColor || [0,0,0]).slice(0,3)),
    };
    gl.uniform3fv(uniforms.materialDiffuse,values.diffuse);
    gl.uniform3fv(uniforms.materialAmbient,values.ambient);
    gl.uniform3fv(uniforms.materialSpecular,values.specular);
    gl.uniform3fv(uniforms.materialEmissive,values.emissive);
    gl.uniform4fv(uniforms.powerGlossLevel,material.powerGlossLevel || [50,0,0,0]);
    gl.uniform1f(uniforms.materialOpacity,material.opacity ?? 1);
    for(const [unit,usage,file,flag] of [[0,'diffuse',material.texture,null],[3,'normal',material.normalTexture,'hasNormal'],
      [4,'gloss',material.glossTexture,'hasGloss'],[5,'specular',material.specularTexture,'hasSpecular']]) {
      const channel=material.textureChannels?.[usage]?.[0];
      const supported=(channel?.texcoord ?? 0)===0;
      const texture=supported?cache?.get(file):null;
      gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,texture || this.white || null);
      // Initial program setup precedes texture/sampler creation.
      if(this.samplers)gl.bindSampler(unit,this.sampler(channel));
      if(flag)gl.uniform1f(uniforms[flag],texture?1:0);
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  bindLighting(uniforms,position,camera,stored=null) {
    const gl=this.gl;
    const target=camera.target || this.playerPosition || position;
    gl.uniform3fv(uniforms.cameraForward,normalize(target.map((value,i)=>value-camera.position[i])));
    let sample=stored;
    if(!sample) {
      const colors=this.lightField ? new Float32Array(this.lightField.sample(position)) : null;
      sample={colors,shadow:this.lightField?.shadow ?? 1,pointPositions:new Float32Array(32),pointColors:new Float32Array(32)};
      const distance=light=>Math.hypot(light.position[0]-position[0],light.position[1]-position[1],light.position[2]-position[2]);
      const lights=[...(this.pointLights || [])].sort((a,b)=>distance(a)-distance(b));
      sample.pointCount=Math.min(lights.length,8);
      for(let i=0;i<sample.pointCount;i++) {
        sample.pointPositions.set([...lights[i].position,Math.max(lights[i].range[3],lights[i].range[2]+.001)],i*4);
        sample.pointColors.set([...lights[i].color,lights[i].range[2]],i*4);
      }
    }
    gl.uniform1f(uniforms.hasGI,sample.colors?1:0);
    gl.uniform1f(uniforms.probeShadow,sample?.shadow ?? 1);
    if(sample.colors)gl.uniform3fv(uniforms.giColors,sample.colors);
    gl.uniform1i(uniforms.pointCount,sample.pointCount);
    gl.uniform4fv(uniforms.pointPositions,sample.pointPositions);gl.uniform4fv(uniforms.pointColors,sample.pointColors);
    return sample;
  }

  createStarMesh() {
    const gl = this.gl;
    const quad = new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);
    this.starMesh = {vao, count: 4, buffer: vbo};
  }

  createGrass() {
    const gl = this.gl;
    const vertices = [];
    const indices = [];

    const addQuad = (angle, w, h) => {
      const c = Math.cos(angle) * (w * 0.5), s = Math.sin(angle) * (w * 0.5);
      const baseIdx = vertices.length / 6;
      vertices.push(-c, 0, -s, 0, 0, 0);
      vertices.push( c, 0,  s, 1, 0, 0);
      vertices.push(-c * 0.35, h, -s * 0.35, 0, 1, 0);
      vertices.push( c * 0.35, h,  s * 0.35, 1, 1, 0);
      indices.push(baseIdx, baseIdx + 1, baseIdx + 2, baseIdx + 1, baseIdx + 3, baseIdx + 2);
    };

    addQuad(0, 0.48, 0.68);
    addQuad(Math.PI / 3, 0.44, 0.64);
    addQuad(Math.PI * 2 / 3, 0.46, 0.70);

    const flowerIdx = vertices.length / 6;
    const fh = 0.60, fw = 0.14;
    vertices.push(-fw, fh, -fw, 0, 0, 1);
    vertices.push( fw, fh, -fw, 1, 0, 1);
    vertices.push(-fw, fh,  fw, 0, 1, 1);
    vertices.push( fw, fh,  fw, 1, 1, 1);
    indices.push(flowerIdx, flowerIdx + 1, flowerIdx + 2, flowerIdx + 1, flowerIdx + 3, flowerIdx + 2);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);

    const stride = 6 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 20);

    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

    this.maxGrassInstances = 22000;
    this.grassInstanceData = new Float32Array(this.maxGrassInstances * 6);
    this.grassInstanceVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.grassInstanceVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.grassInstanceData.byteLength, gl.DYNAMIC_DRAW);

    const instStride = 6 * 4;
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, instStride, 0);
    gl.vertexAttribDivisor(3, 1);

    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 3, gl.FLOAT, false, instStride, 12);
    gl.vertexAttribDivisor(4, 1);

    gl.bindVertexArray(null);

    this.grassMesh = {vao, indexCount: indices.length, buffers: [vbo, ibo, this.grassInstanceVbo]};
    this.grassCount = 0;
    this.grassGenerated = false;
  }

  updateGrass(playerPos) {
    if (!playerPos) return;
    const key = `${Math.floor(playerPos[0]/5)},${Math.floor(playerPos[2]/5)},${this.chunks.size},${this.stats.loading}`;
    if (key === this.grassRegion) return;
    this.grassRegion = key;
    const nearby = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.pending) continue;
      chunk.grass ??= scatterGrass(chunk, this.manifest.materials);
      for (let at = 0; at < chunk.grass.length; at += 6) {
        const d = Math.hypot(chunk.grass[at]-playerPos[0],chunk.grass[at+2]-playerPos[2]);
        if (d < 72) nearby.push({data: chunk.grass, at, d});
      }
    }
    nearby.sort((a,b)=>a.d-b.d);
    this.grassCount = Math.min(nearby.length, this.maxGrassInstances);
    for (let i=0;i<this.grassCount;i++) {
      const {data,at}=nearby[i];
      this.grassInstanceData.set(data.subarray(at,at+6),i*6);
    }
    const gl=this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER,this.grassInstanceVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER,0,this.grassInstanceData.subarray(0,this.grassCount*6));
    this.stats.grass = this.grassCount;
  }

  drawGrass(camera, time) {
    if (!this.grassMesh || this.grassCount === 0) return;
    const gl = this.gl;
    gl.useProgram(this.grassProgram);
    gl.uniformMatrix4fv(this.grassUniforms.viewProjection, false, camera.matrix);
    gl.uniform3fv(this.grassUniforms.cameraPosition, camera.position);
    gl.uniform3fv(this.grassUniforms.sunDirection, this.sunDirection);
    gl.uniform3fv(this.grassUniforms.sunColor, this.sunColor);
    const sky = this.skyColour || [0.55, 0.72, 0.88];
    gl.uniform3fv(this.grassUniforms.skyColor, sky);
    gl.uniform1f(this.grassUniforms.time, time);
    gl.uniform1f(this.grassUniforms.fogDensity, 0.0022);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.grassMesh.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, this.grassMesh.indexCount, gl.UNSIGNED_SHORT, 0, this.grassCount);
    gl.bindVertexArray(null);
    gl.enable(gl.CULL_FACE);
    this.stats.drawCalls++;
  }

  upload(image, width, height) {
    const gl = this.gl, texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (image instanceof Uint8Array) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, image);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }

  async texture(name, base = this.manifest.assetBase || "game/") {
    if (!name) return this.white;
    const key = `${base}textures/${name}`;
    if (this.textures.has(key)) return this.textures.get(key);
    const promise = (async () => {
      try {
        const response = await fetch(`${base}textures/${name}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const image = await createImageBitmap(await response.blob(), {premultiplyAlpha: 'none', colorSpaceConversion: 'none'});
        const texture = this.upload(image); image.close(); return texture;
      } catch (error) {
        // A single unreadable texture must not stop the stage from running.
        console.warn(`texture ${name} unavailable`, error);
        return this.white;
      }
    })();
    this.textures.set(key, promise);
    return promise;
  }

  /**
   * Load the stage's own sky dome and both of its texture layers. The layers
   * live beside the terrain textures under game/textures, so they go through
   * the same cache the rest of the stage uses.
   */
  async loadSky() {
    const manifest = this.manifest.sky;
    if (!manifest) return;
    if (manifest.file) {
      const response = await fetch(`${this.manifest.assetBase || "game/"}${manifest.file}`);
      const buffer = await response.arrayBuffer();
      const view = new DataView(buffer);
      const vertexCount = view.getUint32(8, true);
      const indexCount = view.getUint32(12, true);
      const vertexOffset = 16 + view.getUint32(4, true) * 24;
      const indexOffset = vertexOffset + vertexCount * 24;
      const mesh = this.createMesh(new Float32Array(buffer, vertexOffset, vertexCount * 6),
        new Uint16Array(buffer, indexOffset, indexCount), 24);
      mesh.indexCount = indexCount;
      this.skyMesh = mesh;
    }
    const layers = Object.values(manifest.layers || {});
    if (!layers.length && manifest.texture) layers.push({file: manifest.texture});
    if (layers.length) {
      this.skyTexture = await this.texture(layers[0].file);
      // Only a genuinely transparent second layer is composited; blending two
      // opaque renders of the same dome just washes the sky out.
      const overlay = layers.find(layer => layer !== layers[0] && layer.overlay);
      if (overlay) this.skyLayer = await this.texture(overlay.file);
      // Fog has to meet the dome exactly, so take the horizon's own colour.
      const average = await this.horizonColour(layers[0].file);
      // Applied in draw(), where the owning program is the one bound.
      if (average) this.skyColour = average;
    }
  }

  /** Mean colour of the sky layer's horizon band, used for distance fog. */
  async horizonColour(file) {
    try {
      const response = await fetch(`${this.manifest.assetBase || "game/"}textures/${file}`);
      const image = await createImageBitmap(await response.blob());
      const canvas = document.createElement('canvas');
      canvas.width = 32; canvas.height = 16;
      const context = canvas.getContext('2d', {willReadFrequently: true});
      context.drawImage(image, 0, 0, 32, 16);
      const {data} = context.getImageData(0, 0, 32, 16);
      image.close();
      // Row 13 of 16 sits just under the horizon in this dome's mapping.
      let r = 0, g = 0, b = 0, count = 0;
      for (let y = 12; y < 15; y++) {
        for (let x = 0; x < 32; x++) {
          const at = (y * 32 + x) * 4;
          r += data[at]; g += data[at + 1]; b += data[at + 2];
          count++;
        }
      }
      return [r / count / 255, g / count / 255, b / count / 255];
    } catch (error) {
      console.warn('sky horizon colour unavailable', error);
      return null;
    }
  }

  /**
   * Build an orthographic light matrix that frames the player, so the sun's
   * shadow map stays tight enough to keep real detail near Sonic.
   */
  updateLightMatrix(centre) {
    const sun = this.sunDirection;
    const extent = this.shadowExtent;
    const distance = extent * 2.4;
    const eye = [centre[0] + sun[0] * distance, centre[1] + sun[1] * distance, centre[2] + sun[2] * distance];
    const view = lookAt(eye, centre);
    const projection = orthographic(-extent, extent, -extent, extent, 0.1, distance * 2.2);
    this.lightViewProjection = multiply(projection, view);
  }

  /** Allocate the depth-only target the sun's shadows are rendered into. */
  shadowFramebuffer() {
    const gl = this.gl;
    if (this.shadowTarget) return this.shadowTarget;
    const size = this.shadowSize;
    const depth = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, depth);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Shadow framebuffer is incomplete.');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.shadowTarget = {framebuffer, depth, size};
    return this.shadowTarget;
  }

  /**
   * Render the terrain and Sonic into the sun's shadow map. Called once per
   * frame before the colour pass.
   */
  renderShadows(centre, characterMatrix) {
    const gl = this.gl;
    const target = this.shadowFramebuffer();
    this.updateLightMatrix(centre);
    // The colour pass leaves the depth texture bound on unit 2; a texture that
    // is also the current framebuffer's attachment is a feedback loop, so drop
    // every unit before drawing into it.
    for (const unit of [0, 1, 2]) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    // The shadow pass reads the same skinning matrices as the colour pass.
    if (this.rig && this.boneTexture) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.boneTexture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.rig.count * 4, 1, gl.RGBA, gl.FLOAT, this.rig.skin);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.size, target.size);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(2.5, 4);
    gl.useProgram(this.shadowProgram);
    gl.uniformMatrix4fv(this.shadowUniforms.lightViewProjection, false, this.lightViewProjection);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.boneTexture || this.white);
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    gl.uniformMatrix4fv(this.shadowUniforms.model, false, identity);
    for (const chunk of this.chunks.values()) {
      if (chunk.pending || !boundsVisible(chunk.bounds, this.lightViewProjection)) continue;
      gl.bindVertexArray(chunk.vao);
      for (const primitive of chunk.primitives) {
        // Water and blended glass do not cast opaque rectangle shadows.
        if ((primitive.flags & 1) || isWater(this.manifest.materials[primitive.material],primitive.flags)) continue;
        const material = this.manifest.materials[primitive.material] || {};
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.textureCache?.get(material.texture) || this.white);
        gl.uniform1f(this.shadowUniforms.alphaTest, primitive.flags & 2 ? (material.alphaThreshold ?? .4) : -1);
        if (primitive.flags & 4) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
        gl.drawElements(gl.TRIANGLES, primitive.indexCount, gl.UNSIGNED_SHORT, primitive.indexStart * 2);
      }
    }
    if (this.character && characterMatrix) {
      gl.bindVertexArray(this.character.vao);
      gl.uniformMatrix4fv(this.shadowUniforms.model, false, characterMatrix);
      for (const primitive of this.character.primitives) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.character.textures[primitive.material] || this.white);
        gl.uniform1f(this.shadowUniforms.alphaTest, .3);
        gl.enable(gl.CULL_FACE);
        gl.drawElements(gl.TRIANGLES, primitive.indexCount, gl.UNSIGNED_SHORT, primitive.indexStart * 2);
      }
    }
    gl.bindVertexArray(null);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.enable(gl.CULL_FACE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Upload one exported geometry buffer (same container as the terrain chunks). */
  async loadGeometry(url, stride = VERTEX_BYTES, skinned = false) {
    const binary = await (await fetch(url)).arrayBuffer();
    const view = new DataView(binary);
    if (view.getUint32(0, true) !== CHUNK_MAGIC) throw new Error(`Bad model file ${url}`);
    const primitiveCount = view.getUint32(4, true);
    const vertexCount = view.getUint32(8, true);
    const indexCount = view.getUint32(12, true);
    const primitives = [];
    for (let index = 0; index < primitiveCount; index++) {
      const base = 16 + index * 24;
      primitives.push({
        material: view.getUint32(base, true), flags: view.getUint32(base + 4, true),
        indexStart: view.getUint32(base + 8, true), indexCount: view.getUint32(base + 12, true),
        vertexStart: view.getUint32(base + 16, true), vertexCount: view.getUint32(base + 20, true),
      });
    }
    const vertexOffset = 16 + primitiveCount * 24;
    const indexOffset = vertexOffset + vertexCount * stride;
    const vertices = new Float32Array(binary.slice(vertexOffset, indexOffset));
    const indices = new Uint16Array(binary.slice(indexOffset, indexOffset + indexCount * 2));
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const vertexBuffer = gl.createBuffer(), indexBuffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    for (const [location, size, offset] of [[0, 3, 0], [1, 2, 12]]) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
    }
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, stride, 20);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, stride, 24);
    if (skinned) {
      // Four blend slots (indices into the mesh bone table) and their weights.
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, false, stride, 36);
      gl.enableVertexAttribArray(5);
      gl.vertexAttribPointer(5, 4, gl.UNSIGNED_BYTE, true, stride, 40);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return {vao, primitives, triangles: indexCount / 3, buffers: [vertexBuffer, indexBuffer]};
  }

  /** Load Sonic: bind-pose geometry plus his material list and textures. */
  async loadCharacter() {
    const response = await fetch('game/sonic.json');
    if (!response.ok) return null;
    const character = await response.json();
    const geometry = await this.loadGeometry(character.file, VERTEX_BYTES + 8, true);
    const textures = await Promise.all(character.materials.map(material =>
      material.texture ? this.texture(material.texture, "game/") : this.white));
    const textureCache=await this.materialTextures(character.materials,'game/');
    this.character = Object.assign(geometry, {materials: character.materials, textures, textureCache, manifest: character});
    this.ball = this.createBall();
    return this.character;
  }

  /** Load the baked disc animations and give the rig its bone texture. */
  async loadRig() {
    if (!this.character) return null;
    const response = await fetch('game/sonic_anims.json');
    if (!response.ok) return null;
    const manifest = await response.json();
    // sonic_anims.json records a root-relative path, like sonic.json does.
    const data = await (await fetch(manifest.file)).arrayBuffer();
    // A short read would silently pose the rig from uninitialised memory.
    if (manifest.bytes && data.byteLength !== manifest.bytes) {
      throw new Error(`animation buffer is ${data.byteLength} bytes, expected ${manifest.bytes}`);
    }
    this.rig = new Rig(manifest, this.character.manifest, data);
    const gl = this.gl;
    this.boneTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.boneTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.rig.count * 4, 1, 0, gl.RGBA, gl.FLOAT, this.rig.skin);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return this.rig;
  }

  async loadCompanion() {
    const response = await fetch('game/chip.json');
    if (!response.ok) return null;
    const manifest = await response.json();
    const geometry = await this.loadGeometry(manifest.file,44,true);
    const animations = await (await fetch('game/chip_anims.json')).json();
    const data = await (await fetch(animations.file)).arrayBuffer();
    if (data.byteLength !== animations.bytes) throw new Error('Truncated Chip animation bank');
    const rig = new Rig(animations,manifest,data);
    const textureCache = await this.materialTextures(manifest.materials,'game/');
    const gl = this.gl, boneTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,boneTexture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,rig.count*4,1,0,gl.RGBA,gl.FLOAT,rig.skin);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    this.companion = Object.assign(geometry,{manifest,rig,textureCache,boneTexture,follow:new Companion()});
    return this.companion;
  }

  drawCompanion(camera, dt, player, talking) {
    const chip = this.companion;
    if (!chip) return;
    const follow = chip.follow.update(dt,player,talking);
    chip.rig.update(dt,follow.animation);
    const gl=this.gl, u=this.skinUniforms;
    gl.useProgram(this.skinned);
    gl.uniformMatrix4fv(u.viewProjection,false,camera.matrix);
    gl.uniformMatrix4fv(u.model,false,placement(follow.position,follow.heading*180/Math.PI,1,0));
    gl.uniformMatrix4fv(u.lightViewProjection,false,this.lightViewProjection);
    gl.uniform3fv(u.cameraPosition,camera.position);
    gl3(gl,u.skyColor,this.skyColour || [.55,.72,.88]);
    this.bindLighting(u,follow.position,camera);
    gl.uniform4f(u.tint,1,1,1,1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D,chip.boneTexture);
    gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,chip.rig.count*4,1,gl.RGBA,gl.FLOAT,chip.rig.skin);
    gl.bindVertexArray(chip.vao);
    for (const primitive of chip.primitives) {
      const material=chip.manifest.materials[primitive.material];
      this.bindMaterial(u,material,chip.textureCache);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D,chip.textureCache.get(material.texture)||this.white);
      gl.uniform1f(u.alphaTest,.03);
      gl.uniform1f(u.unlit,material.shader?.startsWith('IgnoreLight') ? 1 : 0);
      if (material.flags&1) {gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);}
      gl.disable(gl.CULL_FACE);
      gl.drawElements(gl.TRIANGLES,primitive.indexCount,gl.UNSIGNED_SHORT,primitive.indexStart*2);
      gl.depthMask(true);gl.disable(gl.BLEND);gl.enable(gl.CULL_FACE);
      this.stats.drawCalls++;
    }
    gl.bindVertexArray(null);
    this.stats.companion=follow.animation;
  }

  /** Load the set-data prop models (rings, springs, dash panels, goal ring). */
  async loadProps() {
    this.propModels = new Map();
    for (const [role, spec] of Object.entries(this.manifest.props || {})) {
      try {
        this.propModels.set(role, Object.assign(await this.loadGeometry(spec.file), {scale: spec.scale}));
      } catch (error) {
        console.warn(`prop ${role} failed`, error);
      }
    }
    this.objects = (this.manifest.objects || []).filter(object => this.propModels.has(object.kind)).map(object =>
      Object.assign({}, object, {collected: false, phase: Math.random() * Math.PI * 2}));
    return this.objects.length;
  }

  /** Draw the set-data props: rings spin, springs and panels sit still. */
  drawObjects(camera, time) {
    if (!this.objects || !this.objects.length || !this.propModels) return;
    const gl = this.gl;
    gl.useProgram(this.terrain);
    gl.uniformMatrix4fv(this.uniforms.viewProjection, false, camera.matrix);
    gl.uniform3fv(this.uniforms.cameraPosition, camera.position);
    this.bindLighting(this.uniforms,this.playerPosition || camera.position,camera);
    gl.uniform1f(this.uniforms.unlit, 1.0);
    gl.uniform1f(this.uniforms.alphaTest, -1.0);
    gl.uniform4f(this.uniforms.tint, 1, 1, 1, 1);
    for (const [role, model] of this.propModels) {
      const objects = this.objects.filter(object => object.kind === role && !object.collected);
      if (!objects.length) continue;
      gl.bindVertexArray(model.vao);
      const gold = role === 'ring' || role === 'superring' || role === 'goal';
      gl.uniform1f(this.uniforms.unlit, gold ? 0.2 : 1.0);
      gl.uniform4f(this.uniforms.tint, 1, 1, 1, 1);
      for (const object of objects) {
        const p = object.position, eye = camera.position;
        if (Math.hypot(p[0]-eye[0], p[1]-eye[1], p[2]-eye[2]) > (gold ? 140 : 220)) continue;
        const m = camera.matrix;
        const w = m[3]*p[0]+m[7]*p[1]+m[11]*p[2]+m[15];
        const x = m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12];
        const y = m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13];
        if (w < -4 || Math.abs(x) > w+4 || Math.abs(y) > w+4) continue;
        const spin = gold ? time * 1.4 + object.phase : 0;
        gl.uniformMatrix4fv(this.uniforms.model, false, placement(object.position, object.yaw, model.scale, spin));
        for (const primitive of model.primitives) {
          const material = this.manifest.materials[primitive.material] || {};
          this.bindMaterial(this.uniforms,material);
          const texture = material.texture && this.textureCache ? this.textureCache.get(material.texture) : null;
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, texture || this.white);
          gl.drawElements(gl.TRIANGLES, primitive.indexCount, gl.UNSIGNED_SHORT, primitive.indexStart * 2);
          this.stats.drawCalls++;
          this.stats.triangles += primitive.indexCount / 3;
        }
      }
    }
    gl.bindVertexArray(null);
    gl.uniform1f(this.uniforms.unlit, 0.0);
    this.drawRingSparkles(camera, time);
  }

  drawRingSparkles(camera, time) {
    if (!this.starMesh || !this.objects) return;
    const gl = this.gl;
    const m = camera.matrix;
    const right = [m[0], m[4], m[8]];
    const up = [m[1], m[5], m[9]];
    const lenR = Math.hypot(right[0], right[1], right[2]) || 1;
    const lenU = Math.hypot(up[0], up[1], up[2]) || 1;
    const cRight = [right[0] / lenR, right[1] / lenR, right[2] / lenR];
    const cUp = [up[0] / lenU, up[1] / lenU, up[2] / lenU];

    gl.useProgram(this.starProgram);
    gl.uniformMatrix4fv(this.starUniforms.viewProjection, false, camera.matrix);
    gl.uniform3fv(this.starUniforms.cameraRight, cRight);
    gl.uniform3fv(this.starUniforms.cameraUp, cUp);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.starMesh.vao);

    for (const object of this.objects) {
      if (object.collected) continue;
      if (object.kind !== 'ring' && object.kind !== 'superring') continue;
      const p = object.position, eye = camera.position;
      const dist = Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
      if (dist > 75) continue;

      for (let s = 0; s < 3; s++) {
        const seed = object.phase + s * 2.094;
        const orbitTime = time * 2.8 + seed;
        const radius = 0.55 + Math.sin(orbitTime * 1.5) * 0.15;
        const sx = p[0] + Math.cos(orbitTime) * radius;
        const sy = p[1] + 0.45 + Math.sin(orbitTime * 2.2) * 0.25;
        const sz = p[2] + Math.sin(orbitTime) * radius;

        const pulse = 0.4 + 0.6 * Math.abs(Math.sin(time * 6.0 + seed));
        const scale = 0.35 * pulse;
        const rot = time * 3.5 + seed;

        gl.uniform3f(this.starUniforms.center, sx, sy, sz);
        gl.uniform1f(this.starUniforms.scale, scale);
        gl.uniform1f(this.starUniforms.rotation, rot);
        gl.uniform4f(this.starUniforms.starColor, 1.3, 1.15, 0.45, pulse);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }

    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
  }

  /** Low-poly unit sphere used for Sonic's spin ball while he is airborne. */
  createBall() {
    const rings = 14, segments = 20;
    const count = (rings + 1) * (segments + 1);
    const buffer = new ArrayBuffer(count * VERTEX_BYTES);
    const data = new DataView(buffer);
    for (let ring = 0; ring <= rings; ring++) {
      const phi = ring / rings * Math.PI;
      for (let segment = 0; segment <= segments; segment++) {
        const theta = segment / segments * Math.PI * 2;
        const at = (ring * (segments + 1) + segment) * VERTEX_BYTES;
        const x = Math.sin(phi) * Math.cos(theta), y = Math.cos(phi), z = Math.sin(phi) * Math.sin(theta);
        data.setFloat32(at, x, true); data.setFloat32(at + 4, y, true); data.setFloat32(at + 8, z, true);
        data.setFloat32(at + 12, segment / segments, true); data.setFloat32(at + 16, ring / rings, true);
        for (let byte = 20; byte < 24; byte++) data.setUint8(at + byte, 255);
        data.setFloat32(at + 24, x, true); data.setFloat32(at + 28, y, true); data.setFloat32(at + 32, z, true);
      }
    }
    const indices = [];
    for (let ring = 0; ring < rings; ring++) {
      for (let segment = 0; segment < segments; segment++) {
        const a = ring * (segments + 1) + segment, b = a + segments + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    return this.createMesh(new Float32Array(buffer), new Uint16Array(indices), VERTEX_BYTES);
  }

  createMesh(vertexArray, indexArray, stride) {
    const gl = this.gl, vao = gl.createVertexArray(), buffer = gl.createBuffer(), elements = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertexArray, gl.STATIC_DRAW);
    for (const [location, size, offset] of [[0, 3, 0], [1, 2, 12], [2, 4, 20], [3, 3, 24]]) {
      gl.enableVertexAttribArray(location);
      if (location === 2) gl.vertexAttribPointer(location, size, gl.UNSIGNED_BYTE, true, stride, offset);
      else gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elements);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexArray, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return {vao, vertexCount: vertexArray.byteLength / stride, indexCount: indexArray.length,
            triangles: indexArray.length / 3, buffers: [buffer, elements]};
  }

  /** Load one exported chunk file: primitives, collisions grids and GPU buffers. */
  async chunk(chunk) {
    const response = await fetch(`${this.manifest.assetBase || "game/"}${chunk.file}`);
    const buffer = await response.arrayBuffer();
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== CHUNK_MAGIC) throw new Error(`Bad chunk file ${chunk.file}`);
    const primitiveCount = view.getUint32(4, true);
    const vertexCount = view.getUint32(8, true);
    const indexCount = view.getUint32(12, true);
    const primitives = [];
    for (let index = 0; index < primitiveCount; index++) {
      const base = 16 + index * 24;
      primitives.push({
        material: view.getUint32(base, true), flags: view.getUint32(base + 4, true),
        indexStart: view.getUint32(base + 8, true), indexCount: view.getUint32(base + 12, true),
        vertexStart: view.getUint32(base + 16, true), vertexCount: view.getUint32(base + 20, true),
      });
    }
    const vertexOffset = 16 + primitiveCount * 24;
    const indexOffset = vertexOffset + vertexCount * VERTEX_BYTES;
    if (indexOffset + indexCount * 2 > buffer.byteLength) throw new Error(`Truncated chunk ${chunk.file}`);
    // Vertices stay interleaved for the GPU; positions are copied out for collision.
    const vertices = new Float32Array(buffer.slice(vertexOffset, indexOffset));
    const indices = new Uint16Array(buffer.slice(indexOffset, indexOffset + indexCount * 2));
    const positions = new Float32Array(vertexCount * 3);
    for (let index = 0; index < vertexCount; index++) {
      const source = index * VERTEX_FLOATS;
      positions[index * 3] = vertices[source];
      positions[index * 3 + 1] = vertices[source + 1];
      positions[index * 3 + 2] = vertices[source + 2];
    }
    // Spatial hash of triangles so collision only tests nearby geometry.
    const grid = new Map(), cell = 8;
    const solidTriangles = new Uint8Array(indexCount/3);
    for (const primitive of primitives) {
      const material=this.manifest.materials[primitive.material] || {};
      const name=`${material.name || ''} ${material.shader || ''}`;
      // Vegetation cards and water surfaces are visuals, not solid walls.
      const solid=!(primitive.flags & 3) && !isWater(material,primitive.flags) && !/water|leaf|leaves|foliage|flower|glass/i.test(name);
      if(solid)solidTriangles.fill(1,primitive.indexStart/3,(primitive.indexStart+primitive.indexCount)/3);
    }
    for (let triangle = 0; triangle < indexCount / 3; triangle++) {
      const a = indices[triangle * 3] * 3, b = indices[triangle * 3 + 1] * 3, c = indices[triangle * 3 + 2] * 3;
      const minX = Math.floor(Math.min(positions[a], positions[b], positions[c]) / cell);
      const maxX = Math.floor(Math.max(positions[a], positions[b], positions[c]) / cell);
      const minZ = Math.floor(Math.min(positions[a + 2], positions[b + 2], positions[c + 2]) / cell);
      const maxZ = Math.floor(Math.max(positions[a + 2], positions[b + 2], positions[c + 2]) / cell);
      if (!Number.isFinite(minX + maxX + minZ + maxZ)) continue;
      if ((maxX - minX + 1) * (maxZ - minZ + 1) > 4096) continue;
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          const key = `${x},${z}`;
          const bucket = grid.get(key);
          if (bucket) bucket.push(triangle); else grid.set(key, [triangle]);
        }
      }
    }
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const vertexBuffer = gl.createBuffer(), indexBuffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERTEX_BYTES, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, VERTEX_BYTES, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, VERTEX_BYTES, 20);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, VERTEX_BYTES, 24);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return {vao, primitives, triangles: indexCount / 3, vertexCount, indices, positions, grid, solidTriangles, bounds: chunk.bounds,
            buffers: [vertexBuffer, indexBuffer]};
  }

  async update(camera, position) {
    if (!this.skyMesh) await this.loadSky();
    const wanted = this.manifest.chunks.filter(chunk => {
      const min = chunk.bounds.min, max = chunk.bounds.max;
      const dx = Math.max(min[0] - position[0], 0, position[0] - max[0]);
      const dz = Math.max(min[2] - position[2], 0, position[2] - max[2]);
      return Math.hypot(dx, dz) < this.streamDistance;
    });
    for (const chunk of wanted) {
      if (this.chunks.has(chunk.name)) continue;
      if (this.stats.loading >= 4) break;
      this.chunks.set(chunk.name, {pending: true});
      this.stats.loading++;
      this.chunk(chunk).then(mesh => {
        mesh.chunk = chunk;
        this.chunks.set(chunk.name, mesh);
        this.stats.loading--;
        this.updateGrass(position);
        if (this.onChunkLoaded) this.onChunkLoaded(chunk, mesh);
      }).catch(error => {
        this.chunks.delete(chunk.name);
        this.stats.loading--;
        console.error(`Chunk ${chunk.name} failed`, error);
      });
    }
    for (const [name, chunk] of this.chunks) {
      const target = this.manifest.chunks.find(candidate => candidate.name === name);
      if (!target) continue;
      const min = target.bounds.min, max = target.bounds.max;
      const dx = Math.max(min[0] - position[0], 0, position[0] - max[0]);
      const dz = Math.max(min[2] - position[2], 0, position[2] - max[2]);
      if (Math.hypot(dx, dz) > this.keepDistance && !chunk.pending) {
        this.release(chunk);
        this.chunks.delete(name);
      }
    }
    this.updateGrass(position);
  }

  release(chunk) {
    const gl = this.gl;
    if (chunk.vao) gl.deleteVertexArray(chunk.vao);
    if (chunk.buffers) chunk.buffers.forEach(buffer => gl.deleteBuffer(buffer));
  }

  draw(camera, options = {}) {
    const gl = this.gl;
    const time = options.time ?? performance.now() / 1000;
    const width = this.canvas.width, height = this.canvas.height;
    this.postprocess.begin(width,height);
    gl.viewport(0, 0, width, height);
    const sky = this.skyColour || [0.55, 0.72, 0.88];
    gl.clearColor(sky[0], sky[1], sky[2], 1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (this.skyMesh) {
      gl.useProgram(this.skyProgram);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(this.skyMesh.vao);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.skyProgram, 'viewProjection'), false, camera.skyMatrix);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.skyTexture || this.white);
      gl.uniform1f(gl.getUniformLocation(this.skyProgram, 'hasTexture'), this.skyTexture ? 1 : 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.skyLayer || this.white);
      gl.uniform1f(gl.getUniformLocation(this.skyProgram, 'hasLayer'), this.skyLayer ? 1 : 0);
      gl3(gl, gl.getUniformLocation(this.skyProgram, 'skyColor'), sky);
      gl.drawElements(gl.TRIANGLES, this.skyMesh.indexCount, gl.UNSIGNED_SHORT, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.enable(gl.CULL_FACE);
      gl.depthMask(true);
    }
    gl.useProgram(this.terrain);
    gl.uniformMatrix4fv(this.uniforms.viewProjection, false, camera.matrix);
    gl.uniform3fv(this.uniforms.cameraPosition, camera.position);
    // The sun's shadow map, sampled on unit 2 by both surface programs.
    if (this.shadowTarget) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.shadowTarget.depth);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.uniformMatrix4fv(this.uniforms.lightViewProjection, false, this.lightViewProjection);
    gl3(gl, this.uniforms.skyColor, sky);
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    this.stats.drawCalls = 0;
    this.stats.triangles = 0;
    this.stats.chunks = 0;
    this.stats.water = 0;
    const waterDraws = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.pending || !boundsVisible(chunk.bounds, camera.matrix)) continue;
      const centre=chunk.bounds.min.map((value,i)=>(value+chunk.bounds.max[i])*.5);
      chunk.lighting=this.bindLighting(this.uniforms,centre,camera,chunk.lighting);
      this.stats.chunks++;
      gl.bindVertexArray(chunk.vao);
      for (const primitive of chunk.primitives) {
        const water = isWater(this.manifest.materials[primitive.material], primitive.flags);
        if (water) {waterDraws.push({chunk,primitive});continue;}
        const material = this.manifest.materials[primitive.material] || {};
        this.bindMaterial(this.uniforms,material);
        const texture = material.texture ? this.textureCache?.get(material.texture) : null;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture || this.white);
        gl.uniformMatrix4fv(this.uniforms.model, false, identity);
        const blended = Boolean(primitive.flags & 1);
        gl.uniform1f(this.uniforms.alphaTest, blended ? 0.02 : (primitive.flags & 2 ? (material.alphaThreshold ?? .4) : -1.0));
        gl.uniform1f(this.uniforms.unlit, 0.0);
        gl.uniform4f(this.uniforms.tint, 1, 1, 1, 1);
        if (primitive.flags & 4) gl.disable(gl.CULL_FACE);
        if (blended) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
          gl.disable(gl.CULL_FACE);
        }
        gl.drawElements(gl.TRIANGLES, primitive.indexCount, gl.UNSIGNED_SHORT, primitive.indexStart * 2);
        this.stats.drawCalls++;
        this.stats.triangles += primitive.indexCount / 3;
        if (blended) {
          gl.depthMask(true);
          gl.disable(gl.BLEND);
          gl.enable(gl.CULL_FACE);
        }
        gl.enable(gl.CULL_FACE);
      }
    }
    gl.bindVertexArray(null);
    this.drawWater(camera,time,waterDraws);
    this.drawGrass(camera, time);
  }

  drawWater(camera,time,draws) {
    if (!draws.length) return;
    const gl=this.gl,u=this.waterUniforms,opaque=this.postprocess.snapshot();
    gl.useProgram(this.waterProgram);
    gl.uniformMatrix4fv(u.viewProjection,false,camera.matrix);
    gl.uniformMatrix4fv(u.model,false,placement([0,0,0],0,1,0));
    gl.uniform3fv(u.cameraPosition,camera.position);
    gl.uniform3fv(u.sunDirection,this.sunDirection);
    gl.uniform3fv(u.sunColor,this.sunColor);
    gl.uniform3fv(u.skyColor,this.skyColour || [.55,.72,.88]);
    gl.uniform1f(u.time,time);gl.uniform1f(u.fogDensity,.0022);
    gl.uniform2f(u.viewportSize,this.canvas.width,this.canvas.height);
    gl.activeTexture(gl.TEXTURE6);gl.bindTexture(gl.TEXTURE_2D,opaque.color);gl.uniform1i(u.sceneColor,6);
    gl.activeTexture(gl.TEXTURE7);gl.bindTexture(gl.TEXTURE_2D,opaque.depth);gl.uniform1i(u.sceneDepth,7);
    gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.disable(gl.CULL_FACE);
    for(const {chunk,primitive} of draws){
      gl.bindVertexArray(chunk.vao);
      gl.drawElements(gl.TRIANGLES,primitive.indexCount,gl.UNSIGNED_SHORT,primitive.indexStart*2);
      this.stats.drawCalls++;this.stats.water++;this.stats.triangles+=primitive.indexCount/3;
    }
    gl.disable(gl.BLEND);gl.enable(gl.CULL_FACE);gl.bindVertexArray(null);gl.activeTexture(gl.TEXTURE0);
  }

  present() {this.postprocess.present();}

  /** Draw Sonic: his skinned model, or the fallback spin ball. */
  drawCharacter(camera, matrix, spinning) {
    const character = this.character;
    if (!character) return;
    const gl = this.gl;
    const rigged = Boolean(this.rig) && !spinning;
    const uniforms = rigged ? this.skinUniforms : this.uniforms;
    gl.useProgram(rigged ? this.skinned : this.terrain);
    gl.uniformMatrix4fv(uniforms.viewProjection, false, camera.matrix);
    gl.uniform3fv(uniforms.cameraPosition, camera.position);
    gl.uniformMatrix4fv(uniforms.lightViewProjection, false, this.lightViewProjection);
    const chrSky = this.skyColour || [0.55, 0.72, 0.88];
    gl3(gl, uniforms.skyColor, chrSky);
    this.bindLighting(uniforms,[matrix[12],matrix[13]+.7,matrix[14]],camera);
    if (this.shadowTarget) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.shadowTarget.depth);
    }
    gl.uniformMatrix4fv(uniforms.model, false, matrix);
    gl.uniform1f(uniforms.unlit, 0);
    gl.activeTexture(gl.TEXTURE0);
    if (spinning && this.ball) {
      gl.bindVertexArray(this.ball.vao);
      gl.bindTexture(gl.TEXTURE_2D, this.white);
      gl.uniform1f(uniforms.alphaTest, -1.0);
      gl.uniform4f(uniforms.tint, 0.16, 0.34, 1.0, 1);
      gl.drawElements(gl.TRIANGLES, this.ball.indexCount, gl.UNSIGNED_SHORT, 0);
      this.stats.drawCalls++;
      this.stats.triangles += this.ball.triangles;
      gl.bindVertexArray(null);
      return;
    }
    if (rigged) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.boneTexture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.rig.count * 4, 1, gl.RGBA, gl.FLOAT, this.rig.skin);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.bindVertexArray(character.vao);
    // Sonic's eyes and mouth use alpha cut-outs, so always test alpha a little.
    gl.uniform1f(uniforms.alphaTest, 0.3);
    gl.uniform4f(uniforms.tint, 1, 1, 1, 1);
    for (const primitive of character.primitives) {
      this.bindMaterial(uniforms,character.materials[primitive.material] || {},character.textureCache);
      gl.bindTexture(gl.TEXTURE_2D, character.textures[primitive.material] || this.white);
      gl.drawElements(gl.TRIANGLES, primitive.indexCount, gl.UNSIGNED_SHORT, primitive.indexStart * 2);
      this.stats.drawCalls++;
      this.stats.triangles += primitive.indexCount / 3;
    }
    gl.bindVertexArray(null);
  }

  /** Resolve every referenced texture up front so drawing stays synchronous. */
  async prepareTextures() {
    this.textureCache=await this.materialTextures(this.manifest.materials,this.manifest.assetBase || 'game/');
    const spec=this.manifest.graphics?.lightField;
    if(spec && !this.manifest.graphics?.ambient?.ignoreData) {
      const response=await fetch(`${this.manifest.assetBase || 'game/'}${spec.file}`);
      if(!response.ok)throw new Error(`Original light field unavailable: ${response.status}`);
      this.lightField=new LightField(spec,await response.arrayBuffer());
    }
  }

  async materialTextures(materials,base) {
    const names=new Set();
    for(const material of materials)for(const key of ['texture','normalTexture','glossTexture','specularTexture']) {
      if(material[key])names.add(material[key]);
    }
    return new Map(await Promise.all([...names].map(async name=>[name,await this.texture(name,base)])));
  }
}
