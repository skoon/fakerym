import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { WORLD, WATER } from '../core/config.js';
import { scene } from '../core/renderer.js';
import { heightAt, slopeAt, ringSpot, findSpot } from '../world/heightfield.js';
import { player, checkLevelUp, respawnPlayer } from './player.js';
import { dropLoot } from './loot.js';
import { contractKilled } from './contracts.js';
import { say, flashDamage } from '../ui/hud.js';

// ---------------------------------------------------------------- enemies
// Three creatures with three silhouettes, and the bodies are no longer built here: they are skinned
// voxel models from the Monsters kit in `src/models/`. This file keeps the mapping from creature to
// model and the mapping from behaviour to animation clip; nothing else knows the models exist.
// `aim` is where a hit lands (a crab is knee-high, a kagouti is shoulder-height above you), and it
// has to agree with the model, which is why `modelH` normalises each body to a known height.
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
  { key: 'crab',    name: 'Mudcrab',   model: 'MON-032', modelH: 0.62,
    hp: 45,  dmg: 8,  speed: 4.8, xp: 25,  scale: 0.9, reach: 1.8, aim: 0.42,
    wake: 7,  leash: 14,  threat: 0.9, pack: 1,
    color: 0x6b5540 },
  { key: 'hound',   name: 'Nix-Hound', model: 'MON-037', modelH: 0.95,
    hp: 80,  dmg: 14, speed: 6.4, xp: 45,  scale: 1.0, reach: 2.4, aim: 0.75,
    wake: 38, leash: 60,  threat: 0,   pack: 2, harry: true,
    color: 0x4f4a38 },
  { key: 'kagouti', name: 'Kagouti',   model: 'MON-036', modelH: 1.72,
    hp: 190, dmg: 26, speed: 4.2, xp: 110, scale: 1.0, reach: 3.0, aim: 1.5,
    wake: 30, leash: 120, threat: 0.6, pack: 1,
    color: 0x6b5a3e }
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

// ---------------------------------------------------------------- models
// Loaded once, before anything spawns: `main.js` awaits `loadCreatureModels()`. Each rig gets a
// SkeletonUtils clone — a plain Object3D.clone would leave every clone sharing one skeleton, so
// they would all animate as the same animal — with its own material clones, which is what keeps
// per-creature tint and the hit flash per-creature. Geometries are shared by every clone, so the
// pool below still holds renderer.info.memory.geometries flat.
//
// Clips come out of the GLB named `MON-032__Idle`, `MON-032__Walk` and so on; only the part after
// the double underscore means anything here.
const MODEL_DIR = new URL('../models/voxel-starter-kit-monsters-all/GLB/Models/', import.meta.url).href;
const gltfLoader = new GLTFLoader();
const models = new Map();

export async function loadCreatureModels() {
  const ids = [...new Set(ENEMY_TYPES.map(t => t.model))];
  await Promise.all(ids.map(async id => {
    try {
      const gltf = await gltfLoader.loadAsync(`${MODEL_DIR}${id}.glb`);
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const clips = new Map();
      for (const clip of gltf.animations) clips.set(clip.name.slice(clip.name.lastIndexOf('__') + 2), clip);
      models.set(id, { scene: gltf.scene, clips, minY: box.min.y, height: box.max.y - box.min.y });
    } catch (err) {
      // A missing model must not take the world down with it — see the placeholder in buildRig.
      console.error(`[enemies] ${id} failed to load; falling back to a block body`, err);
    }
  }));
}

// The kit ships MeshStandardMaterial, and this project dropped PBR on purpose (plan.md): no
// environment map exists here, so metalness has nothing to reflect and reads as flat black. Lambert
// with the same colour is the era-correct equivalent, and it supports the emissive the hit flash
// and the models' own eye glow use.
function toLambert(src) {
  if (src.isMeshLambertMaterial) return src.clone();
  const m = new THREE.MeshLambertMaterial({
    name: src.name,
    color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
    map: src.map || null
  });
  if (src.emissive) m.emissive.copy(src.emissive);
  return m;
}

// ---------------------------------------------------------------- rigs
// A rig is the visual body: group + cloned model + its own materials + its animation mixer. Rigs
// are pooled per type and re-used across respawns, so a rig is built at most once per creature on
// screen.
const pools = new Map();

function buildRig(type) {
  const group = new THREE.Group();
  const rig = {
    type, group, model: null, mixer: null, actions: null, current: null,
    mats: [], skin: [], baseColor: [], emissive: []
  };

  const glb = models.get(type.model);
  if (!glb) {
    // An invisible enemy that still hits you is worse than an ugly one.
    const h = type.modelH * type.scale;
    const mat = new THREE.MeshLambertMaterial({ color: type.color, flatShading: true });
    const body = new THREE.Mesh(new THREE.BoxGeometry(h * 0.7, h, h * 1.3), mat);
    body.position.y = h * 0.5;
    group.add(body);
    rig.mats.push(mat);
    rig.emissive.push(mat.emissive.clone());
    return rig;
  }

  const model = cloneSkinned(glb.scene);
  model.traverse(o => {
    if (o.name.startsWith('Collision')) { o.visible = false; return; }   // simplified proxies
    if (!o.isMesh) return;
    const wasArray = Array.isArray(o.material);
    const out = (wasArray ? o.material : [o.material]).map(src => {
      const mat = toLambert(src);
      rig.mats.push(mat);
      rig.emissive.push(mat.emissive.clone());
      // eyes glow on their own and must not be tinted with the hide
      if (!/eye/i.test(mat.name)) { rig.skin.push(mat); rig.baseColor.push(mat.color.clone()); }
      return mat;
    });
    o.material = wasArray ? out : out[0];
  });

  // Normalise: every creature is authored at 1 unit = 1 m but the models are not the same size, so
  // each is scaled to its type's height and dropped so its feet sit on the group origin.
  const s = (type.modelH * type.scale) / glb.height;
  model.scale.multiplyScalar(s);
  model.position.y = -glb.minY * s;
  group.add(model);
  rig.model = model;

  if (glb.clips.size) {
    rig.mixer = new THREE.AnimationMixer(model);
    rig.actions = {};
    for (const [name, clip] of glb.clips) rig.actions[name] = rig.mixer.clipAction(clip);
  }
  return rig;
}

function acquireRig(type) {
  let pool = pools.get(type.key);
  if (!pool) { pool = []; pools.set(type.key, pool); }
  const rig = pool.pop() || buildRig(type);
  scene.add(rig.group);
  return rig;
}

// Nothing is disposed here: the rig goes back on the pile with its model, materials and clips
// intact, which is exactly what keeps a long session's GPU memory flat.
function releaseRig(rig) {
  scene.remove(rig.group);
  rig.group.rotation.set(0, 0, 0);          // clears the placeholder body's death tilt
  if (rig.model) rig.model.rotation.set(0, 0, 0);
  if (rig.mixer) { rig.mixer.stopAllAction(); rig.current = null; }
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
  // per-creature variation lives on the rig's own material clones, never in new geometry. The base
  // colour is kept because a pooled rig is re-tinted for every creature that borrows it.
  const tint = Math.random();
  for (let i = 0; i < rig.skin.length; i++) {
    rig.skin[i].color.copy(rig.baseColor[i])
      .offsetHSL((tint - 0.5) * 0.03, (tint - 0.5) * 0.12, (tint - 0.5) * 0.09);
  }
  for (let i = 0; i < rig.mats.length; i++) rig.mats[i].emissive.copy(rig.emissive[i]);
  if (rig.model) rig.model.rotation.set(0, 0, 0);
  const jitter = 0.94 + Math.random() * 0.12;
  g.scale.setScalar(jitter);

  playClip(rig, 'Idle', 0);

  enemies.push({
    type, rig, mesh: g, home: new THREE.Vector3(home.x, 0, home.z),
    hp: type.hp, maxHp: type.hp, state: 'wander',
    dir: Math.random() * Math.PI * 2, timer: 0, atkCd: 0, alertT: 0, orbit: 0,
    dead: 0, flash: 0, swing: 0
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
// Behaviour picks a clip; the clip owns the pose. `fade` is a crossfade so a creature changing its
// mind at the edge of its wake does not snap between two poses.
const FADE = 0.18;

function playClip(rig, name, fade = FADE) {
  if (!rig.actions) return;
  const next = rig.actions[name];
  if (!next || rig.current === name) return;
  const prev = rig.current ? rig.actions[rig.current] : null;
  next.reset();
  if (name === 'Death' || name === 'Attack01') {
    next.setLoop(THREE.LoopOnce, 1);
    next.clampWhenFinished = true;
  } else {
    next.setLoop(THREE.LoopRepeat, Infinity);
  }
  next.setEffectiveWeight(1).play();
  if (prev && prev !== next) { prev.fadeOut(fade); next.fadeIn(fade); }
  rig.current = name;
}

// The kit has no "sizing you up" clip, so the threat display is the idle held slowed down with the
// body reared back — the same telegraph the procedural bodies had, expressed on the model. It is
// subtler than a hand-posed skeleton; a real threat clip would be better.
function animate(e, dt, moving, speed) {
  const rig = e.rig;
  if (!rig.mixer) return;

  if (rig.model) {
    const rear = e.state === 'alert' ? -0.14 : 0;
    const r = rig.model.rotation;
    r.x += (rear - r.x) * Math.min(1, dt * 10);
  }

  // an attack is a one-shot: it plays to the end before locomotion gets the body back
  if (e.swing > 0) { e.swing -= dt; rig.mixer.update(dt); return; }

  const ratio = speed / e.type.speed;
  const name = !moving ? 'Idle' : ratio > 0.55 ? 'Run' : 'Walk';
  playClip(rig, name);
  const act = rig.actions && rig.actions[rig.current];
  // in-place locomotion: the clip has to run at the creature's real ground speed or the feet slide
  if (act && moving) act.setEffectiveTimeScale(THREE.MathUtils.clamp(ratio / (name === 'Run' ? 1 : 0.3), 0.7, 1.6));
  rig.mixer.update(dt);
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
      if (e.dead === 1) playClip(e.rig, 'Death', 0.12);
      e.dead += dt;
      // the Death clip owns the collapse; only the block placeholder has to be tipped over by hand
      if (!e.rig.actions) m.rotation.x = Math.min(Math.PI / 2, e.dead * 3.4);
      m.position.y = heightAt(m.position.x, m.position.z) - Math.max(0, e.dead - 2.2) * 1.4;
      if (e.rig.mixer) e.rig.mixer.update(dt);
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
      for (let k = 0; k < e.rig.mats.length; k++) {
        const base = e.rig.emissive[k];
        e.rig.mats[k].emissive.setRGB(base.r + f, base.g, base.b);
      }
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
        e.swing = 0.83;                 // Attack01 is 0.83 s long
        playClip(e.rig, 'Attack01', 0.1);
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
    animate(e, dt, speed > 0, speed);
    m.position.y = heightAt(m.position.x, m.position.z);
  }
}
