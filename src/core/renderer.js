import * as THREE from 'three';
import { FOG_D } from './config.js';

// ---------------------------------------------------------------- renderer / scene
// These are built at import time rather than behind a build() call, and that is the ordering
// anchor for the whole seeded world: every module that constructs THREE objects imports this one,
// so ESM evaluates it first and three's UUID draws start from the same place every run.
export const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
// linear, not filmic — ACES's shoulder desaturates highlights in a way 2002 hardware never did
renderer.toneMapping = THREE.LinearToneMapping;
renderer.toneMappingExposure = 1;
document.body.appendChild(renderer.domElement);

export const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x9db3a8, FOG_D);

export const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.08, 900);
export const viewRoot = new THREE.Object3D();          // yaw
export const pitchRoot = new THREE.Object3D();         // pitch
viewRoot.add(pitchRoot); pitchRoot.add(camera);
scene.add(viewRoot);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
