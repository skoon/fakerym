import * as THREE from 'three';
import { WORLD, SEG, WATER, HMAX, TILE } from '../core/config.js';
import { scene } from '../core/renderer.js';
import { FOG_VERT, FOG_FRAG, fogUniforms, syncFog } from '../core/shaders.js';
import { createHeightTexture } from './heightfield.js';

// ---------------------------------------------------------------- grass
// Tapered blades, wind in the vertex shader.
const GRASS = 240000;
const BLADE_H = 0.42;

export let grassMat = null, grassMesh = null;

export function buildGrass(village) {
  const bladeGeo = new THREE.BufferGeometry();
  {
    const w = 0.045, h = BLADE_H;
    bladeGeo.setAttribute('position', new THREE.Float32BufferAttribute([
      -w, 0, 0, w, 0, 0, w * 0.45, h * 0.6, 0,
      -w, 0, 0, w * 0.45, h * 0.6, 0, -w * 0.45, h * 0.6, 0,
      -w * 0.45, h * 0.6, 0, w * 0.45, h * 0.6, 0, 0, h, 0
    ], 3));
    bladeGeo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(27).fill(0).map((_, i) => i % 3 === 2 ? 1 : 0), 3));
    bladeGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, .6, 0, 0, 1, .6, 0, .6, 0, .6, 1, .6, .5, 1], 2));
  }

  // The world is 810,000 m² — no fixed instance budget can cover it at readable density.
  // So the field is a TILE-sized patch that wraps around the player in the vertex shader,
  // sampling terrain height from a data texture. Density stays constant wherever you stand.
  const heightTex = createHeightTexture();

  const grassGeo = new THREE.InstancedBufferGeometry();
  grassGeo.setAttribute('position', bladeGeo.getAttribute('position'));
  grassGeo.instanceCount = GRASS;
  {
    const ip = new Float32Array(GRASS * 2), irs = new Float32Array(GRASS * 2), ic = new Float32Array(GRASS * 3);
    const c = new THREE.Color();
    for (let i = 0; i < GRASS; i++) {
      ip[i * 2] = Math.random() * TILE; ip[i * 2 + 1] = Math.random() * TILE;
      irs[i * 2] = Math.random() * Math.PI; irs[i * 2 + 1] = 0.65 + Math.random() * 0.75;
      const t = Math.random();
      // keep tufts close to the terrain colour underneath, or they read as black spikes
      c.setHSL(0.16 + t * 0.07, 0.22 + t * 0.16, 0.3 + t * 0.16, THREE.SRGBColorSpace);
      ic.set([c.r, c.g, c.b], i * 3);
    }
    grassGeo.setAttribute('iPos', new THREE.InstancedBufferAttribute(ip, 2));
    grassGeo.setAttribute('iRS', new THREE.InstancedBufferAttribute(irs, 2));
    grassGeo.setAttribute('iCol', new THREE.InstancedBufferAttribute(ic, 3));
  }
  grassGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  grassMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      uHeight: { value: heightTex }, uPlayer: { value: new THREE.Vector3() }, uTime: { value: 0 },
      uTile: { value: TILE }, uWorld: { value: WORLD }, uSeg: { value: SEG },
      uWater: { value: WATER }, uTop: { value: HMAX * 0.44 },
      uVillage: { value: new THREE.Vector3(village.cx, village.cz, village.r) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color(1, 1, 1) },
      uAmb: { value: new THREE.Color(0.3, 0.35, 0.4) },
      ...fogUniforms(scene.fog)
    },
    vertexShader: /* glsl */`
      attribute vec2 iPos; attribute vec2 iRS; attribute vec3 iCol;
      uniform sampler2D uHeight;
      uniform vec3 uPlayer, uVillage;
      uniform float uTime, uTile, uWorld, uSeg, uWater, uTop;
      varying vec3 vCol; varying float vAO;
      ${FOG_VERT}

      float sampleH(vec2 xz){
        vec2 g = (xz + uWorld * 0.5) / uWorld * uSeg;
        vec2 b = floor(g), f = fract(g);
        float ts = 1.0 / (uSeg + 1.0);
        float h00 = texture2D(uHeight, (b + 0.5) * ts).r;
        float h10 = texture2D(uHeight, (b + vec2(1.0, 0.0) + 0.5) * ts).r;
        float h01 = texture2D(uHeight, (b + vec2(0.0, 1.0) + 0.5) * ts).r;
        float h11 = texture2D(uHeight, (b + vec2(1.0, 1.0) + 0.5) * ts).r;
        return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
      }

      void main(){
        // wrap this blade into the tile centred on the player
        vec2 xz = mod(iPos - uPlayer.xz + uTile * 0.5, uTile) - uTile * 0.5 + uPlayer.xz;
        float h = sampleH(xz);
        float slope = max(abs(sampleH(xz + vec2(2.5, 0.0)) - h), abs(sampleH(xz + vec2(0.0, 2.5)) - h)) / 2.5;

        // no grass in the sea, on cliffs, or above the treeline; fade the tile edge into fog
        float ok = step(uWater + 0.7, h) * step(h, uTop) * (1.0 - smoothstep(0.34, 0.55, slope));
        // trodden bare ground inside the settlement
        ok *= smoothstep(uVillage.z * 0.7, uVillage.z, distance(xz, uVillage.xy));
        float fade = 1.0 - smoothstep(uTile * 0.36, uTile * 0.48, length(xz - uPlayer.xz));
        float sc = iRS.y * ok * fade;

        float bend = position.y / ${BLADE_H};
        vec3 p = vec3(position.x, position.y * sc, position.z);
        float a = iRS.x;
        vec3 rp = vec3(p.x * cos(a) - p.z * sin(a), p.y, p.x * sin(a) + p.z * cos(a));
        float w = sin(uTime * 1.7 + xz.x * 0.35 + xz.y * 0.22) + 0.5 * sin(uTime * 3.1 + xz.x * 0.9);
        rp.x += w * bend * bend * 0.22 * sc;
        rp.z += w * bend * bend * 0.12 * sc;

        vec4 mv = viewMatrix * vec4(vec3(xz.x, h - 0.04, xz.y) + rp, 1.0);
        vAO = bend; vCol = iCol; vFog = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSunDir, uSunCol, uAmb;
      varying vec3 vCol; varying float vAO;
      ${FOG_FRAG}
      void main(){
        vec3 c = vCol * (uAmb + uSunCol * (0.35 + 0.65 * max(uSunDir.y, 0.0)));
        c *= 0.62 + 0.38 * vAO;                      // darker at the base = fake AO, reads as depth
        gl_FragColor = vec4(fogged(c), 1.0);
      }`
  });

  grassMesh = new THREE.Mesh(grassGeo, grassMat);
  grassMesh.frustumCulled = false;
  scene.add(grassMesh);
}

export function applyDayNight({ sunDir, sunColor, dayness }) {
  const gu = grassMat.uniforms;
  gu.uSunDir.value.copy(sunDir);
  gu.uSunCol.value.copy(sunColor).multiplyScalar(0.4 + 0.9 * dayness);
  gu.uAmb.value.setRGB(0.1 + 0.34 * dayness, 0.12 + 0.38 * dayness, 0.13 + 0.32 * dayness);
}

export function syncGrass(t, playerPos, fog) {
  grassMat.uniforms.uTime.value = t;
  grassMat.uniforms.uPlayer.value.copy(playerPos);
  syncFog(grassMat, fog);
}
