import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { DAY, FOG_D } from '../core/config.js';
import { renderer, scene } from '../core/renderer.js';

export let sky = null, sun = null, hemi = null, stars = null, moon = null;

// ---------------------------------------------------------------- sky & light
export function buildSky() {
  sky = new Sky();
  sky.scale.setScalar(20000);
  scene.add(sky);
  sky.material.uniforms.turbidity.value = 6;
  sky.material.uniforms.rayleigh.value = 2.2;
  sky.material.uniforms.mieCoefficient.value = 0.005;
  sky.material.uniforms.mieDirectionalG.value = 0.82;

  // no shadow maps: Morrowind had none, and dropping them buys back the whole shadow pass
  sun = new THREE.DirectionalLight(0xffffff, 3);
  scene.add(sun, sun.target);

  // generous sky/ground ambient — with no shadows and no IBL this is what keeps undersides readable
  hemi = new THREE.HemisphereLight(0xbcd2e8, 0x6f6449, 0.6);
  scene.add(hemi);

  // stars — only visible once the sun drops
  const starGeo = new THREE.BufferGeometry();
  {
    const n = 2200, p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(420);
      v.y = Math.abs(v.y);
      p.set([v.x, v.y, v.z], i * 3);
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(p, 3));
  }
  stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ size: 2.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false }));
  scene.add(stars);

  moon = new THREE.Mesh(new THREE.SphereGeometry(18, 24, 16), new THREE.MeshBasicMaterial({ color: 0xdfe6f2, fog: false }));
  scene.add(moon);
}

// ---------------------------------------------------------------- day/night
let timeOfDay = 0.28;   // 0 = midnight, 0.25 = dawn, 0.5 = noon
export const getTime = () => timeOfDay;
export const setTime = v => { timeOfDay = v; };
export const addTime = d => { timeOfDay += d; };

const sunDir = new THREE.Vector3();
const dayFog = new THREE.Color(0x9db3a8), duskFog = new THREE.Color(0xc98d5c), nightFog = new THREE.Color(0x101a1c);
const fogMix = new THREE.Color();

// Drives the sky, the two lights, the fog, exposure, the stars and the moon, then hands the
// derived state back so the modules that own the other time-of-day surfaces (village lamps,
// grass lighting, water tint) can apply it themselves. Keeps this file from importing half
// the project the way the original single updateSky did.
export function updateDayNight(dt, playerPos) {
  timeOfDay = (timeOfDay + dt / DAY) % 1;
  const a = (timeOfDay - 0.25) * Math.PI * 2;
  sunDir.set(Math.cos(a) * 0.55, Math.sin(a), Math.cos(a) * 0.83).normalize();
  sky.material.uniforms.sunPosition.value.copy(sunDir);

  const elev = sunDir.y;                                   // -1 .. 1
  const dayness = THREE.MathUtils.smoothstep(elev, -0.12, 0.22);
  // warm horizon only while the sun is actually near it, else night looks orange
  const duskness = Math.max(0, 1 - Math.abs(elev) / 0.28) * THREE.MathUtils.smoothstep(elev, -0.16, 0.02);

  sun.position.copy(sunDir).multiplyScalar(150).add(playerPos);
  sun.target.position.copy(playerPos);
  sun.intensity = 2.2 * dayness;
  sun.color.setHSL(0.11 - duskness * 0.06, 0.35 * duskness + 0.05, 0.5 + 0.12 * dayness, THREE.SRGBColorSpace);

  hemi.intensity = 0.52 + 0.98 * dayness;
  hemi.color.setHSL(0.6, 0.5, 0.35 + 0.35 * dayness, THREE.SRGBColorSpace);

  fogMix.copy(nightFog).lerp(duskFog, duskness).lerp(dayFog, dayness * (1 - duskness * 0.6));
  scene.fog.color.copy(fogMix);
  scene.fog.density = FOG_D * (1 + 0.35 * (1 - dayness));
  renderer.toneMappingExposure = 0.37 + 0.66 * dayness;
  sky.material.uniforms.rayleigh.value = 0.9 + 2.4 * duskness;
  sky.material.uniforms.turbidity.value = 11 + 8 * duskness;   // hazy, not a crisp blue dome

  const night = 1 - dayness;
  stars.material.opacity = night;
  stars.position.copy(playerPos);
  stars.rotation.y = timeOfDay * Math.PI * 2;
  moon.position.copy(sunDir).multiplyScalar(-620).add(playerPos);
  moon.visible = sunDir.y < 0.1;

  return { sunDir, sunColor: sun.color, dayness, duskness, night, fogColor: fogMix };
}
