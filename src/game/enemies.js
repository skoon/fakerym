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
//
// Temperament is data too, and once you are near them it is the whole difference between the three:
//   wake    how close you must be before it notices you at all
//   leash   how far from its home it will pursue before giving up and walking back
//   threat  the pause it spends sizing you up before committing, with a pose of its own
//   pack    how many spawn together, sharing one home so they hunt as a litter
//   harry   circles at reach instead of walking into your face
// A mudcrab is territorial: it ignores you until 7 m, warns you, and never follows you more than
// 14 m from where it was. A nix-hound hunts in pairs, sees you from 38 m and harries. A kagouti
// sees you from 30 m, telegraphs, and follows you most of the way across the island.
export const ENEMY_TYPES = [
  { key: 'crab',    name: 'Mudcrab',   hp: 45,  dmg: 8,  speed: 4.8, xp: 25,  scale: 0.9, reach: 1.8, aim: 0.42,
    wake: 7,  leash: 14,  threat: 0.9, pack: 1,
    color: 0x6b5540, accent: 0x9a7346 },
  { key: 'hound',   name: 'Nix-Hound', hp: 80,  dmg: 14, speed: 6.4, xp: 45,  scale: 1.0, reach: 2.4, aim: 0.75,
    wake: 38, leash: 60,  threat: 0,   pack: 2, harry: true,
    color: 0x4f4a38, accent: 0x6f6750 },
  { key: 'kagouti', name: 'Kagouti',   hp: 190, dmg: 26, speed: 4.2, xp: 110, scale: 1.0, reach: 3.0, aim: 1.5,
    wake: 30, leash: 120, threat: 0.6, pack: 1,
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
function pickType() {
  return ENEMY_TYPES[Math.random() < 0.5 ? 0 : Math.random() < 0.72 ? 1 : 2];
}

// far enough out that a creature is met while travelling, never in your face
function farSpot(near) {
  return findSpot(60, () => ringSpot(near, 55, 90), s => {
    if (Math.abs(s.x) > WORLD * 0.46 || Math.abs(s.z) > WORLD * 0.46) return false;
    const h = heightAt(s.x, s.z);
    return h >= WATER + 1 && slopeAt(s.x, s.z) <= 0.5;
  });
}

// One creature at a spot. `home` is where its leash is measured from: the litter's spot when it
// spawned as part of a pack, otherwise its own. findSpot hands back a scratch object, so home is
// copied here rather than kept by reference.
function placeEnemy(type, spot, home = spot) {
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
    type, rig, mesh: g, home: new THREE.Vector3(home.x, 0, home.z),
    hp: type.hp, maxHp: type.hp, state: 'wander',
    dir: Math.random() * Math.PI * 2, timer: 0, atkCd: 0, alertT: 0, orbit: 0,
    dead: 0, flash: 0, phase: Math.random() * 6.283
  });
}

// One creature, used by the death path and the 260 m cull: replacements arrive alone, so the
// population can never grow.
export function spawnEnemy(near) {
  const type = pickType();
  const spot = farSpot(near);
  if (spot) placeEnemy(type, spot);
}

// The opening population, formed as litters so a nix-hound is met as a pair rather than alone.
// `count` is a target for how many are alive; a litter can nudge the total past it, never far.
// Litters are a spawn-time property — a slain hound comes back as a single creature — so a long
// session drifts towards solos. Keeping packs together needs a real spawn manager.
export function populateEnemies(near, count) {
  while (enemies.length < count) {
    const type = pickType();
    const home = farSpot(near);
    if (!home) return;
    const packHome = new THREE.Vector3(home.x, 0, home.z);
    placeEnemy(type, home, packHome);
    for (let p = 1; p < type.pack; p++) {
      const spot = findSpot(20, () => ringSpot(packHome, 2.5, 7), s =>
        Math.abs(s.x) < WORLD * 0.46 && Math.abs(s.z) < WORLD * 0.46 &&
        heightAt(s.x, s.z) >= WATER + 1 && slopeAt(s.x, s.z) <= 0.6);
      if (spot) placeEnemy(type, spot, packHome);
    }
  }
}

export function damageEnemy(e, amount) {
  e.hp -= amount;
  e.flash = 0.16;
  // a hit wakes anything, but a creature with a threat display warns before it commits
  if (e.state === 'wander') {
    if (e.type.threat > 0) { e.state = 'alert'; e.alertT = e.type.threat * 0.5; }
    else beginChase(e);
  }
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
    // claws up while it sizes you up: the only warning a mudcrab gives
    const raised = e.state === 'alert' ? 1 : 0;
    L.arms[0].rotation.x = -0.75 * raised;
    L.arms[1].rotation.x = -0.75 * raised;
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

  // the crouch is a kagouti's charge telegraph, held for the length of its threat
  const crouch = e.state === 'alert' ? 1 : 0;
  L.legs[0].rotation.x = Math.sin(e.phase) * (moving ? 0.5 : 0.03);
  L.legs[1].rotation.x = -Math.sin(e.phase) * (moving ? 0.5 : 0.03);
  L.arms[0].rotation.x = -Math.sin(e.phase) * (moving ? 0.42 : 0.06);
  L.arms[1].rotation.x = Math.sin(e.phase) * (moving ? 0.42 : 0.06);
  L.body.position.y = 1.35 + Math.abs(s) * (moving ? 0.05 : 0.012) - crouch * 0.1;
  L.head.rotation.x = -0.04 + Math.sin(e.phase * 0.5) * 0.07 + crouch * 0.3;
}

// ---------------------------------------------------------------- per-frame
// Committing starts the harrying circle on the bearing the creature already stands on, so it does
// not snap to the far side of the player on the first frame.
function beginChase(e) {
  e.state = 'chase';
  e.orbit = Math.atan2(e.mesh.position.x - player.pos.x, e.mesh.position.z - player.pos.z);
}

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

    // Only a wandering creature can be woken, inside its own `wake`. Once committed it stays
    // committed until it runs out of leash, which is what gives each type a different reach.
    if (e.state === 'wander' && player.hp > 0 && dist < e.type.wake) {
      if (e.type.threat > 0) { e.state = 'alert'; e.alertT = e.type.threat; }
      else beginChase(e);
    }

    const hx = m.position.x - e.home.x, hz = m.position.z - e.home.z;
    if (e.state === 'chase' && hx * hx + hz * hz > e.type.leash * e.type.leash) e.state = 'retreat';

    let speed = 0;
    if (e.state === 'chase') {
      if (dist <= e.type.reach && e.atkCd <= 0) {
        e.atkCd = 1.35;
        player.hp -= e.type.dmg * (1 - Math.min(0.4, player.level * 0.03));
        flashDamage();
        if (player.hp <= 0) {
          respawnPlayer();
          for (const o of enemies) { o.state = 'wander'; o.alertT = 0; }
        }
      } else if (e.type.harry && dist < e.type.reach * 2.2) {
        // harrying: circle just inside reach instead of walking into your face
        e.orbit += dt * 1.2;
        const r = e.type.reach * 0.85;
        const dx = player.pos.x + Math.cos(e.orbit) * r - m.position.x;
        const dz = player.pos.z + Math.sin(e.orbit) * r - m.position.z;
        if (dx * dx + dz * dz > 0.09) { m.rotation.y = Math.atan2(dx, dz); speed = e.type.speed; }
      } else if (dist > e.type.reach) {
        m.rotation.y = Math.atan2(toP.x, toP.z);
        speed = e.type.speed;
      } else {
        m.rotation.y = Math.atan2(toP.x, toP.z);
      }
    } else if (e.state === 'alert') {
      m.rotation.y = Math.atan2(toP.x, toP.z);
      e.alertT -= dt;
      if (e.alertT <= 0) beginChase(e);
      else if (dist > e.type.wake * 1.6) e.state = 'wander';
    } else if (e.state === 'retreat') {
      if (hx * hx + hz * hz < 1.4) { e.state = 'wander'; e.timer = 0; }
      else { m.rotation.y = Math.atan2(-hx, -hz); speed = e.type.speed * 0.75; }
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
