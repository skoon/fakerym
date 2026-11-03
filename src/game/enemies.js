import * as THREE from 'three';
import { WORLD, WATER } from '../core/config.js';
import { scene } from '../core/renderer.js';
import { heightAt, slopeAt, ringSpot, findSpot } from '../world/heightfield.js';
import { player, checkLevelUp, respawnPlayer } from './player.js';
import { dropLoot } from './loot.js';
import { contractKilled } from './contracts.js';
import { say, flashDamage } from '../ui/hud.js';

// ---------------------------------------------------------------- enemies
// Three creatures with three silhouettes: a low wide crab, a low long hound, a tall hunched
// kagouti. They differ in geometry, not just tint — that is the whole point of this file's shape.
// `aim` is where a hit lands (a crab is knee-high, a kagouti is shoulder-height above you).
export const ENEMY_TYPES = [
  { key: 'crab',    name: 'Mudcrab',   hp: 45,  dmg: 8,  speed: 4.8, xp: 25,  scale: 0.9, reach: 1.8, aim: 0.42, aggro: 34,
    color: 0x6b5540, accent: 0x9a7346 },
  { key: 'hound',   name: 'Nix-Hound', hp: 80,  dmg: 14, speed: 6.4, xp: 45,  scale: 1.0, reach: 2.4, aim: 0.75, aggro: 34,
    color: 0x4f4a38, accent: 0x6f6750 },
  { key: 'kagouti', name: 'Kagouti',   hp: 190, dmg: 26, speed: 4.2, xp: 110, scale: 1.0, reach: 3.0, aim: 1.5,  aggro: 26,
    color: 0x6b5a3e, accent: 0x3e3327 }
];
export const enemies = [];

const CENTRE = new THREE.Vector3(), TOP = new THREE.Vector3(), AIM = new THREE.Vector3();

// Where a hit lands on this creature — its `aim` height, not the mesh origin, which sits on the
// ground. Every combat and targeting test wants this point.
export function centreOf(e, out = CENTRE) {
  return out.copy(e.mesh.position).setY(e.mesh.position.y + e.type.aim);
}

export function forEachLiving(fn) {
  for (const e of enemies) { if (!e.dead) fn(e); }
}

// the enemy the crosshair is closest to holding, or null
export function pickTarget(from, dir) {
  let best = null, bestDot = 0.985;
  forEachLiving(e => {
    const v = centreOf(e, AIM).sub(from);
    const d = v.length();
    if (d > 45) return;
    const dot = v.normalize().dot(dir);
    if (dot > bestDot) { bestDot = dot; best = e; }
  });
  return best;
}

// ---------------------------------------------------------------- shared assets
// One set of geometries per creature type, built the first time that type is spawned and then
// borrowed by every rig of that type forever. Nothing in this section runs per spawn: that is
// what stops renderer.info.memory.geometries climbing. Materials are per-rig (two per rig,
// cloned once when the rig is built) so tint variation and the hit flash stay per-creature.
//
// Everything is built lazily rather than at module scope on purpose: constructing a THREE
// object draws a UUID from the seeded Math.random stream, and this module would then shift the
// world for every seed (see plan.md).
const assets = new Map();
let eyeGeo = null, eyeMat = null;
const CRAB_LEG_REST = -0.34;   // how far a crab's leg hangs below horizontal at rest

function sharedEye() {
  if (!eyeGeo) {
    eyeGeo = new THREE.SphereGeometry(0.055, 6, 5);
    eyeMat = new THREE.MeshBasicMaterial({ color: 0xffdd66 });
  }
}

function assetsFor(type) {
  let a = assets.get(type.key);
  if (a) return a;
  sharedEye();
  a = {
    geo: buildGeos(type.key),
    color: new THREE.Color(type.color),
    accent: new THREE.Color(type.accent)
  };
  assets.set(type.key, a);
  return a;
}

// --- geometry, one entry per body part, all sized at 1 unit = 1 metre with the rig standing on
// the origin. Parts that swing are parented to a zero-rotation pivot so animation maths is clean.
function buildGeos(key) {
  if (key === 'crab') {
    // low wide shell, claws out front, six stubby legs, eyes on stalks
    const shell = new THREE.SphereGeometry(0.6, 12, 8);
    shell.scale(1.5, 0.5, 1.05);
    const claw = new THREE.BoxGeometry(0.13, 0.13, 0.34); claw.translate(0, 0, 0.17);
    const pincer = new THREE.SphereGeometry(0.12, 7, 6); pincer.scale(0.9, 0.8, 1.5);
    // the leg hangs below its hip at rest, so the crab reads as standing rather than splayed flat
    const leg = new THREE.BoxGeometry(0.06, 0.06, 0.48); leg.translate(0, 0, 0.24);
    const stalk = new THREE.CylinderGeometry(0.026, 0.032, 0.2, 5);
    return { shell, claw, pincer, leg, stalk };
  }
  if (key === 'hound') {
    // low quadruped, long snout, thin legs, whippy tail
    const body = new THREE.CapsuleGeometry(0.24, 0.78, 4, 8); body.rotateX(Math.PI / 2);
    const neck = new THREE.CylinderGeometry(0.12, 0.16, 0.32, 6);
    const head = new THREE.BoxGeometry(0.22, 0.19, 0.26);
    const snout = new THREE.ConeGeometry(0.095, 0.56, 6); snout.rotateX(Math.PI / 2);
    const ear = new THREE.ConeGeometry(0.055, 0.24, 5);
    const leg = new THREE.CylinderGeometry(0.045, 0.05, 0.6, 5); leg.translate(0, -0.3, 0);
    const tail = new THREE.ConeGeometry(0.06, 0.5, 5); tail.rotateX(-1.2);
    return { body, neck, head, snout, ear, leg, tail };
  }
  // kagouti: tall, hunched, horned, heavy hind legs
  const body = new THREE.CapsuleGeometry(0.36, 0.85, 5, 10); body.rotateX(Math.PI / 2);
  const hump = new THREE.SphereGeometry(0.44, 10, 8); hump.scale(1, 0.85, 1.15);
  const neck = new THREE.CylinderGeometry(0.14, 0.2, 0.45, 6);
  const head = new THREE.BoxGeometry(0.28, 0.24, 0.4);
  const snout = new THREE.ConeGeometry(0.12, 0.3, 6); snout.rotateX(Math.PI / 2);
  const horn = new THREE.ConeGeometry(0.055, 0.46, 5);
  const leg = new THREE.CylinderGeometry(0.09, 0.12, 1.2, 6); leg.translate(0, -0.6, 0);
  const arm = new THREE.CylinderGeometry(0.055, 0.075, 0.65, 5); arm.translate(0, -0.32, 0);
  const tail = new THREE.ConeGeometry(0.08, 0.7, 6); tail.rotateX(-1.3);
  return { body, hump, neck, head, snout, horn, leg, arm, tail };
}

// ---------------------------------------------------------------- rigs
// A rig is the visual body: group + meshes + the two materials it owns. Rigs are pooled per
// type and re-used across respawns, so a rig is built at most once per creature on screen.
const pools = new Map();

function buildRig(type) {
  const A = assetsFor(type);
  const bodyMat = new THREE.MeshLambertMaterial({ color: A.color, flatShading: true });
  const accentMat = new THREE.MeshLambertMaterial({ color: A.accent, flatShading: true });
  const group = new THREE.Group();
  const limbs = { body: null, head: null, arms: [], legs: [], shell: null };
  const part = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent = group) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    parent.add(m);
    return m;
  };

  if (type.key === 'crab') {
    limbs.shell = part(A.geo.shell, bodyMat, 0, 0.32, 0);

    for (const side of [-1, 1]) {
      const claw = new THREE.Group();
      claw.position.set(side * 0.4, 0.28, 0.42);
      claw.rotation.y = side * 0.5;
      part(A.geo.claw, accentMat, 0, 0, 0, 0, 0, 0, claw);
      part(A.geo.pincer, accentMat, 0, 0, 0.4, 0, 0, 0, claw);
      group.add(claw);
      limbs.arms.push(claw);
    }
    for (const side of [-1, 1]) {
      for (const z of [-0.28, 0.02, 0.32]) {
        // hip sets the splay, swing carries the gait, so animating one never fights the other
        const hip = new THREE.Group();
        hip.position.set(side * 0.46, 0.24, z);
        hip.rotation.y = side * Math.PI / 2;
        const swing = new THREE.Group();
        swing.rotation.z = CRAB_LEG_REST;
        part(A.geo.leg, accentMat, 0, 0, 0, 0, 0, 0, swing);
        hip.add(swing);
        group.add(hip);
        limbs.legs.push(swing);
      }
      const stalk = part(A.geo.stalk, accentMat, side * 0.16, 0.5, 0.34);
      stalk.rotation.x = -0.25;
      part(eyeGeo, eyeMat, side * 0.16, 0.6, 0.37);
    }

  } else if (type.key === 'hound') {
    limbs.body = part(A.geo.body, bodyMat, 0, 0.7, 0);

    const head = new THREE.Group();
    head.position.set(0, 0.88, 0.55);
    part(A.geo.neck, bodyMat, 0, -0.04, 0.02, 0.85, 0, 0, head);
    part(A.geo.head, bodyMat, 0, 0.03, 0.19, 0, 0, 0, head);
    part(A.geo.snout, accentMat, 0, -0.02, 0.45, 0, 0, 0, head);
    part(A.geo.ear, accentMat, -0.085, 0.19, 0.17, -0.18, 0, 0.22, head);
    part(A.geo.ear, accentMat, 0.085, 0.19, 0.17, -0.18, 0, -0.22, head);
    part(eyeGeo, eyeMat, -0.075, 0.07, 0.28, 0, 0, 0, head);
    part(eyeGeo, eyeMat, 0.075, 0.07, 0.28, 0, 0, 0, head);
    group.add(head);
    limbs.head = head;

    for (const side of [-1, 1]) {
      for (const z of [0.38, -0.38]) {
        const leg = new THREE.Group();
        leg.position.set(side * 0.16, 0.62, z);
        part(A.geo.leg, accentMat, 0, 0, 0, 0, 0, 0, leg);
        group.add(leg);
        limbs.legs.push(leg);
      }
    }
    part(A.geo.tail, accentMat, 0, 0.78, -0.66);

  } else {
    limbs.body = part(A.geo.body, bodyMat, 0, 1.35, -0.1, -0.18, 0, 0);
    part(A.geo.hump, bodyMat, 0, 1.55, 0.3);

    const head = new THREE.Group();
    head.position.set(0, 1.62, 0.72);
    part(A.geo.neck, bodyMat, 0, -0.05, -0.04, 0.55, 0, 0, head);
    part(A.geo.head, bodyMat, 0, 0.08, 0.16, 0, 0, 0, head);
    part(A.geo.snout, accentMat, 0, 0.03, 0.38, 0, 0, 0, head);
    part(A.geo.horn, accentMat, -0.13, 0.3, 0.1, -0.2, 0, 0.35, head);
    part(A.geo.horn, accentMat, 0.13, 0.3, 0.1, -0.2, 0, -0.35, head);
    part(eyeGeo, eyeMat, -0.1, 0.12, 0.3, 0, 0, 0, head);
    part(eyeGeo, eyeMat, 0.1, 0.12, 0.3, 0, 0, 0, head);
    group.add(head);
    limbs.head = head;

    for (const side of [-1, 1]) {
      const hind = new THREE.Group();
      hind.position.set(side * 0.3, 1.25, -0.4);
      part(A.geo.leg, accentMat, 0, 0, 0, 0, 0, 0, hind);
      group.add(hind);
      limbs.legs.push(hind);

      const arm = new THREE.Group();
      arm.position.set(side * 0.28, 1.45, 0.5);
      part(A.geo.arm, accentMat, 0, 0, 0, 0, 0, 0, arm);
      group.add(arm);
      limbs.arms.push(arm);
    }
    part(A.geo.tail, accentMat, 0, 1.45, -0.8);
  }

  group.scale.setScalar(type.scale);
  return { type, group, mats: [bodyMat, accentMat], limbs };
}

function acquireRig(type) {
  let pool = pools.get(type.key);
  if (!pool) { pool = []; pools.set(type.key, pool); }
  const rig = pool.pop() || buildRig(type);
  scene.add(rig.group);
  return rig;
}

// Nothing is disposed here: the rig goes back on the pile with its geometries and materials
// intact, which is exactly what keeps a long session's GPU memory flat.
function releaseRig(rig) {
  scene.remove(rig.group);
  rig.group.rotation.set(0, 0, 0);   // clears the death tilt; spawn sets position and scale again
  pools.get(rig.type.key).push(rig);
}

// ---------------------------------------------------------------- spawning
export function spawnEnemy(near) {
  const type = ENEMY_TYPES[Math.random() < 0.5 ? 0 : Math.random() < 0.72 ? 1 : 2];
  const spot = findSpot(60, () => ringSpot(near, 55, 90), s => {
    if (Math.abs(s.x) > WORLD * 0.46 || Math.abs(s.z) > WORLD * 0.46) return false;
    const h = heightAt(s.x, s.z);
    return h >= WATER + 1 && slopeAt(s.x, s.z) <= 0.5;
  });
  if (!spot) return;

  const rig = acquireRig(type);
  const g = rig.group;
  g.position.set(spot.x, heightAt(spot.x, spot.z), spot.z);
  // per-creature variation lives on the rig's own material and scale, never in new geometry
  const tint = Math.random();
  rig.mats[0].color.copy(assetsFor(type).color).offsetHSL((tint - 0.5) * 0.03, (tint - 0.5) * 0.12, (tint - 0.5) * 0.09);
  rig.mats[0].emissive.setRGB(0, 0, 0);
  rig.mats[1].emissive.setRGB(0, 0, 0);
  const jitter = 0.94 + Math.random() * 0.12;
  g.scale.setScalar(type.scale * jitter);

  enemies.push({
    type, rig, mesh: g, hp: type.hp, maxHp: type.hp, state: 'wander',
    dir: Math.random() * Math.PI * 2, timer: 0, atkCd: 0, dead: 0, flash: 0,
    phase: Math.random() * 6.283
  });
}

export function damageEnemy(e, amount) {
  e.hp -= amount;
  e.flash = 0.16;
  e.state = 'chase';
  if (e.hp <= 0) {
    e.dead = 1;
    player.xp += e.type.xp;
    say(`${e.type.name} slain.  +${e.type.xp} xp`);
    contractKilled(e.type.name);
    dropLoot(e.mesh.position, e.type.xp);
    if (Math.random() < 0.4) dropLoot(e.mesh.position, e.type.xp);
    checkLevelUp();
  }
}

// ---------------------------------------------------------------- animation
// One gait per creature, driven from data on the enemy (phase, moving) rather than from
// performance.now(), so every creature is on its own beat and nothing allocates.
function animate(e, dt, moving) {
  const L = e.rig.limbs;
  e.phase += dt * (moving ? 6 + e.type.speed : 1.5);
  const s = Math.sin(e.phase);

  if (e.type.key === 'crab') {
    const amp = moving ? 0.4 : 0.06;
    L.arms[0].rotation.y = -0.5 + s * amp;
    L.arms[1].rotation.y = 0.5 - s * amp;
    for (let i = 0; i < L.legs.length; i++) {
      L.legs[i].rotation.z = CRAB_LEG_REST + Math.sin(e.phase + i * 1.7) * (moving ? 0.3 : 0.04);
    }
    L.shell.position.y = 0.32 + Math.abs(s) * (moving ? 0.02 : 0.006);
    return;
  }

  if (e.type.key === 'hound') {
    // diagonal gait: legs 0 and 3 together, 1 and 2 together
    for (let i = 0; i < 4; i++) {
      const ph = e.phase + (i === 0 || i === 3 ? 0 : Math.PI);
      L.legs[i].rotation.x = Math.sin(ph) * (moving ? 0.62 : 0.05);
    }
    L.body.position.y = 0.7 + Math.abs(s) * (moving ? 0.035 : 0.01);
    L.head.rotation.x = -0.06 + Math.sin(e.phase * 0.5) * 0.06;
    return;
  }

  L.legs[0].rotation.x = Math.sin(e.phase) * (moving ? 0.5 : 0.03);
  L.legs[1].rotation.x = -Math.sin(e.phase) * (moving ? 0.5 : 0.03);
  L.arms[0].rotation.x = -Math.sin(e.phase) * (moving ? 0.42 : 0.06);
  L.arms[1].rotation.x = Math.sin(e.phase) * (moving ? 0.42 : 0.06);
  L.body.position.y = 1.35 + Math.abs(s) * (moving ? 0.05 : 0.012);
  L.head.rotation.x = -0.04 + Math.sin(e.phase * 0.5) * 0.07;
}

// ---------------------------------------------------------------- per-frame
export function updateEnemies(dt) {
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    const m = e.mesh;

    if (e.dead) {
      e.dead += dt;
      m.rotation.x = Math.min(Math.PI / 2, e.dead * 3.4);
      m.position.y = heightAt(m.position.x, m.position.z) - Math.max(0, e.dead - 2.2) * 1.4;
      if (e.dead > 4) {
        releaseRig(e.rig);
        enemies.splice(i, 1);
        spawnEnemy(player.pos);
      }
      continue;
    }

    const toP = TOP.copy(player.pos).sub(m.position);
    const dist = toP.length();

    // cull far enemies to keep the sim cheap, respawn near the player
    if (dist > 260) {
      releaseRig(e.rig);
      enemies.splice(i, 1);
      spawnEnemy(player.pos);
      continue;
    }

    if (e.flash > 0) {
      e.flash = Math.max(0, e.flash - dt);
      const f = e.flash * 5;
      for (const mat of e.rig.mats) mat.emissive.setRGB(f, 0, 0);
    }

    e.timer -= dt; e.atkCd -= dt;
    const aggro = e.type.aggro;
    if (dist < aggro && player.hp > 0) e.state = 'chase';
    else if (dist > aggro * 1.8) e.state = 'wander';

    let speed = 0;
    if (e.state === 'chase') {
      m.rotation.y = Math.atan2(toP.x, toP.z);
      if (dist > e.type.reach) speed = e.type.speed;
      else if (e.atkCd <= 0) {
        e.atkCd = 1.35;
        player.hp -= e.type.dmg * (1 - Math.min(0.4, player.level * 0.03));
        flashDamage();
        if (player.hp <= 0) {
          respawnPlayer();
          for (const o of enemies) o.state = 'wander';
        }
      }
    } else {
      if (e.timer <= 0) { e.timer = 2 + Math.random() * 4; e.dir += (Math.random() - 0.5) * 2.4; }
      m.rotation.y = e.dir;
      speed = e.type.speed * 0.3;
    }

    if (speed > 0) {
      const nx = m.position.x + Math.sin(m.rotation.y) * speed * dt;
      const nz = m.position.z + Math.cos(m.rotation.y) * speed * dt;
      if (Math.abs(nx) < WORLD * 0.47 && Math.abs(nz) < WORLD * 0.47 && heightAt(nx, nz) > WATER - 1) {
        m.position.x = nx; m.position.z = nz;
      } else e.dir += 2.2;
    }
    animate(e, dt, speed > 0);
    m.position.y = heightAt(m.position.x, m.position.z);
  }
}
