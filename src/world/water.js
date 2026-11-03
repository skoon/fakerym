import * as THREE from 'three';
import { WORLD, WATER } from '../core/config.js';
import { scene } from '../core/renderer.js';
import { FOG_VERT, FOG_FRAG, fogUniforms } from '../core/shaders.js';

export let waterMat = null, water = null;

const SKY_TINT = new THREE.Color(0x74a6d8);

export function buildWater() {
  waterMat = new THREE.ShaderMaterial({
    transparent: true, fog: true,
    uniforms: {
      uTime: { value: 0 }, uDeep: { value: new THREE.Color(0x14332f) }, uShallow: { value: new THREE.Color(0x3c7a68) },
      uSky: { value: new THREE.Color(0x9db3a8) }, uSun: { value: new THREE.Vector3(0, 1, 0) },
      ...fogUniforms(scene.fog)
    },
    vertexShader: /* glsl */`
      uniform float uTime;
      varying vec3 vW; ${FOG_VERT}
      void main(){
        vec3 p = position;
        float w = sin(p.x*0.16 + uTime*1.1)*0.22 + sin(p.y*0.21 - uTime*0.8)*0.18 + sin((p.x+p.y)*0.07 + uTime*0.4)*0.3;
        p.z += w;
        vec4 wp = modelMatrix * vec4(p,1.0);
        vW = wp.xyz;
        vec4 mv = viewMatrix * wp;
        vFog = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime; uniform vec3 uDeep, uShallow, uSky, uSun;
      varying vec3 vW;
      ${FOG_FRAG}
      void main(){
        vec3 V = normalize(cameraPosition - vW);
        // cheap analytic ripple normal
        vec3 N = normalize(vec3(
          sin(vW.x*0.9 + uTime*1.6)*0.09 + sin(vW.z*1.7 - uTime*1.1)*0.06,
          1.0,
          cos(vW.z*0.8 - uTime*1.3)*0.09 + sin(vW.x*1.5 + uTime*0.9)*0.06));
        float fres = pow(1.0 - max(dot(N,V),0.0), 3.0);
        float spec = pow(max(dot(reflect(-normalize(uSun), N), V), 0.0), 70.0);
        vec3 col = mix(uDeep, uShallow, 0.4 + 0.25*sin(vW.x*0.03+vW.z*0.03));
        // flatter than a modern water shader on purpose — 2002 water barely reflected
        col = mix(col, uSky, clamp(fres*0.75,0.0,0.55)) + spec * 0.9;
        gl_FragColor = vec4(fogged(col), 0.86);
      }`
  });
  water = new THREE.Mesh(new THREE.PlaneGeometry(WORLD * 1.6, WORLD * 1.6, 140, 140), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER;
  scene.add(water);
}

export function applyDayNight({ sunDir, fogColor, dayness }) {
  waterMat.uniforms.uSun.value.copy(sunDir);
  waterMat.uniforms.uSky.value.copy(fogColor).lerp(SKY_TINT, dayness * 0.6);
}

export function setWaterTime(t) { waterMat.uniforms.uTime.value = t; }
