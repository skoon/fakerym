import * as THREE from 'three';
import { camera, scene } from '../core/renderer.js';
import { heightAt } from '../world/heightfield.js';
import { player } from './player.js';
import { enemies, damageEnemy, centreOf, forEachLiving } from './enemies.js';

// ---------------------------------------------------------------- viewmodel: sword + off hand
export let viewmodel = null, sword = null, flameLight = null, flameOrb = null;

// The viewmodel shares the world camera, so its on-screen size is whatever the frustum makes of a
// sword held half a metre from the eye. It is laid out against that frustum instead — a fixed
// fraction of the frame height, pinned inside the right edge — which holds at any aspect ratio.
const VM = { depth: 0.62, height: 0.92, top: -0.06, right: 0.97 };
const VM_ROT = [0.32, -0.18, 0.22];
let vmBase = { x: 0.29, y: -0.31, z: -0.5, scale: 0.5 };

function layoutViewmodel() {
  if (!sword) return;
  const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * VM.depth;
  const halfW = halfH * camera.aspect;

  // measure the model at unit scale in viewmodel space, rotation included
  sword.position.set(0, 0, 0);
  sword.scale.setScalar(1);
  sword.rotation.set(VM_ROT[0], VM_ROT[1], VM_ROT[2]);
  viewmodel.updateMatrixWorld(true);
  const inv = viewmodel.matrixWorld.clone().invert();
  const box = new THREE.Box3(), tmp = new THREE.Box3();
  sword.traverse(o => {
    if (!o.isMesh) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    tmp.copy(o.geometry.boundingBox).applyMatrix4(inv.clone().multiply(o.matrixWorld));
    box.union(tmp);
  });

  const h = Math.max(1e-4, box.max.y - box.min.y);
  const s = (VM.height * halfH) / h;   // vertical size is a fixed fraction of the frame
  sword.scale.setScalar(s);
  sword.rotation.set(VM_ROT[0], VM_ROT[1], VM_ROT[2]);

  // Start from the model's box, then correct against the real projection: the corners sit at
  // different depths, so a single box-to-NDC guess leaves the blade either off the top or clipped
  // by the right edge. Two correction passes settle it at any aspect ratio.
  sword.position.set(VM.right * halfW - box.max.x * s, VM.top * halfH - box.max.y * s, -VM.depth);
  for (let pass = 0; pass < 2; pass++) {
    const p = projectedBounds();
    sword.position.x += (VM.right - p.maxX) * halfW;
    sword.position.y += (VM.top - p.maxY) * halfH;
  }
  sword.updateMatrixWorld(true);

  vmBase = { scale: s, x: sword.position.x, y: sword.position.y, z: sword.position.z };
}

// the viewmodel's real screen footprint, in NDC, from its projected bounding box
function projectedBounds() {
  const box = new THREE.Box3().setFromObject(sword);
  const v = new THREE.Vector3();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    v.set(x, y, z).project(camera);
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
  }
  return { minX, maxX, minY, maxY };
}

export function buildViewmodel() {
  viewmodel = new THREE.Group();
  camera.add(viewmodel);
  sword = new THREE.Group();
  {
    // Phong, not PBR — a specular highlight is all the metal cue the era had
    const steel = new THREE.MeshPhongMaterial({ color: 0x7d878f, specular: 0xb8c2c8, shininess: 60 });
    const leather = new THREE.MeshLambertMaterial({ color: 0x3a2a1c });
    const brass = new THREE.MeshPhongMaterial({ color: 0x7d6128, specular: 0xc9a24a, shininess: 40 });
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.9, 0.012), steel);
    blade.position.y = 0.55;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.038, 0.14, 4), steel);
    tip.position.y = 1.05; tip.rotation.y = Math.PI / 4;
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.035, 0.045), brass);
    guard.position.y = 0.09;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.024, 0.19, 8), leather);
    const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.033, 10, 8), brass);
    pommel.position.y = -0.1;
    sword.add(blade, tip, guard, grip, pommel);
  }
  sword.scale.setScalar(0.5);
  sword.position.set(0.3, -0.42, -0.74);
  sword.rotation.set(0.32, -0.18, 0.22);
  viewmodel.add(sword);
  layoutViewmodel();
  addEventListener('resize', layoutViewmodel);

  // off-hand flame, lit while casting
  flameLight = new THREE.PointLight(0xff8a2a, 0, 12, 2);
  flameLight.position.set(-0.3, -0.26, -0.45);
  viewmodel.add(flameLight);
  flameOrb = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xffb257, transparent: true, opacity: 0 })
  );
  flameOrb.position.copy(flameLight.position);
  viewmodel.add(flameOrb);
}

// ---------------------------------------------------------------- melee
const camDir = new THREE.Vector3(), hit = new THREE.Vector3();

export function startSwing() {
  if (player.attackCd <= 0 && player.stam >= 12) {
    player.swing = 0; player.hitDone = false; player.attackCd = 0.62; player.stam -= 12;
  }
}

export function swordSwing(dt) {
  if (player.attackCd > 0) player.attackCd -= dt;
  if (player.swing >= 0) {
    player.swing += dt / 0.45;
    const t = player.swing;
    if (t >= 1) { player.swing = -1; }
    // wind-up, slash, recover — offsets are relative to the laid-out base, and scaled with it so
    // the arc keeps its shape whatever size the frustum asked for
    const k = t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7;
    const u = vmBase.scale / 0.5;
    sword.rotation.set(VM_ROT[0] - k * 1.5, VM_ROT[1] + k * 1.2, VM_ROT[2] - k * 1.9);
    sword.position.set(vmBase.x - k * 0.34 * u, vmBase.y + k * 0.24 * u, vmBase.z - k * 0.22 * u);

    if (!player.hitDone && t > 0.32) {
      player.hitDone = true;
      camera.getWorldDirection(camDir);
      forEachLiving(e => {
        const v = centreOf(e, hit).sub(player.pos);
        const dist = v.length();
        if (dist > 3.0 + e.type.scale) return;
        if (v.normalize().dot(camDir) < 0.55) return;
        damageEnemy(e, 22 + player.level * 4 + Math.random() * 8);
      });
    }
  } else {
    sword.rotation.set(VM_ROT[0], VM_ROT[1], VM_ROT[2]);
    sword.position.set(vmBase.x, vmBase.y, vmBase.z);
  }
}

// ---------------------------------------------------------------- projectiles (flame)
export const bolts = [];
let boltGeo, boltMat;

export function initBolts() {
  boltGeo = new THREE.SphereGeometry(0.22, 12, 10);
  boltMat = new THREE.MeshBasicMaterial({ color: 0xffa03a, transparent: true });
}

export function castFlame() {
  if (player.mag < 18 || player.castCd > 0) return;
  player.mag -= 18; player.castCd = 0.5;
  const m = new THREE.Mesh(boltGeo, boltMat.clone());
  const light = new THREE.PointLight(0xff7a20, 6, 18, 2);
  m.add(light);
  camera.getWorldPosition(m.position);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  m.position.addScaledVector(dir, 0.7);
  scene.add(m);
  bolts.push({ mesh: m, vel: dir.clone().multiplyScalar(42), life: 3, boom: 0 });
}

export function updateBolts(dt) {
  for (let i = bolts.length - 1; i >= 0; i--) {
    const b = bolts[i];
    if (b.boom > 0) {
      b.boom += dt;
      b.mesh.scale.setScalar(1 + b.boom * 16);
      b.mesh.material.opacity = Math.max(0, 1 - b.boom * 3.2);
      b.mesh.children[0].intensity = Math.max(0, 14 - b.boom * 50);
      if (b.boom > 0.35) { scene.remove(b.mesh); bolts.splice(i, 1); }
      continue;
    }
    b.life -= dt;
    b.vel.y -= 6 * dt;
    b.mesh.position.addScaledVector(b.vel, dt);
    b.mesh.children[0].intensity = 6 + Math.sin(performance.now() * 0.02) * 2;

    let boom = b.life <= 0 || b.mesh.position.y < heightAt(b.mesh.position.x, b.mesh.position.z);
    if (!boom) boom = enemies.some(e => !e.dead && b.mesh.position.distanceTo(centreOf(e)) < 1.2 + e.type.scale);
    if (boom) {
      b.boom = 0.001;
      forEachLiving(e => {
        const d = b.mesh.position.distanceTo(centreOf(e));
        if (d < 5.5) damageEnemy(e, (34 + player.level * 5) * (1 - d / 7));
      });
    }
  }
  // off-hand flame glow follows cooldown
  const lit = Math.max(0, player.castCd / 0.5);
  flameLight.intensity = lit * 5;
  flameOrb.material.opacity = lit;
  flameOrb.scale.setScalar(0.7 + lit * 0.9);
}
