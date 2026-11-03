import * as THREE from 'three';
import { WORLD, WATER, HMAX } from '../core/config.js';
import { scene } from '../core/renderer.js';
import { heightAt, slopeAt, ringSpot, findSpot } from '../world/heightfield.js';
import { boxes } from '../world/village.js';
import { obstacles } from '../world/flora.js';
import { player } from './player.js';
import { say } from '../ui/hud.js';

// ---------------------------------------------------------------- contracts
// One owner for all contract state: the offer on the board, the one you accepted, its progress,
// and the item it might have put in the world. Nothing else in the game holds a contract flag —
// enemies.js calls contractKilled() when a creature dies, the HUD is handed a view to draw, and
// main.js wires the two together. That keeps the loop readable from this file alone.
//
// There is no save system in this project, so contracts live for the session only. Reloading the
// page starts you at tier 1 again.

const SHAPES = ['slay', 'fetch', 'travel'];
const ITEMS = ['Dwemer gear', 'ash statue', 'comberry crate'];
const PLURAL = { 'Mudcrab': 'Mudcrabs', 'Nix-Hound': 'Nix-Hounds', 'Kagouti': 'Kagoutis' };

const state = {
  board: null,        // { x, z }
  offer: null,        // generated, not yet accepted
  active: null,       // the contract being worked
  near: false,
  item: null,         // { mesh, baseY } — the fetch objective, a real object in the world
  locateEnemy: null,  // injected: (typeName) => {x,z} | null
  typeNames: []
};

let itemGeo = null, itemMat = null;

// ---------------------------------------------------------------- setup
// Called at the end of the world build, so the extra Math.random draws (and three's UUIDs)
// cannot shift the world for a given seed. See plan.md.
export function initContracts(village, { street, typeNames, locateEnemy }) {
  state.locateEnemy = locateEnemy;
  state.typeNames = typeNames;
  const ca = Math.cos(street), sa = Math.sin(street);
  const along = -5, off = 3.2;                       // on the street edge, clear of the house rows
  const x = village.cx + ca * along - sa * off;
  const z = village.cz + sa * along + ca * off;
  const yaw = Math.atan2(village.cx - x, village.cz - z);   // face the middle of the street

  state.board = { x, z };
  buildBoard(x, heightAt(x, z), z, yaw);
  boxes.push({ x, z, yaw, hx: 1.2, hz: 0.22 });       // reuse the village's collision

  state.offer = generateContract(1);
}

function buildBoard(x, y, z, yaw) {
  const wood = new THREE.MeshLambertMaterial({ color: 0x4a3520, flatShading: true });
  const paper = new THREE.MeshLambertMaterial({ color: 0xd8c9a0, emissive: 0x1a1610 });
  const g = new THREE.Group();

  const post = new THREE.BoxGeometry(0.13, 2.3, 0.13);
  for (const side of [-1, 1]) {
    const p = new THREE.Mesh(post, wood);
    p.position.set(side * 0.85, 1.15, 0);
    g.add(p);
  }
  const plank = new THREE.Mesh(new THREE.BoxGeometry(2.05, 1.15, 0.09), wood);
  plank.position.set(0, 1.78, 0);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(2.25, 0.14, 0.2), wood);
  cap.position.set(0, 2.42, 0);
  g.add(plank, cap);

  // a few notices pinned to it, so it reads as a board rather than a fence
  const sheet = new THREE.PlaneGeometry(0.34, 0.44);
  for (let i = 0; i < 4; i++) {
    const n = new THREE.Mesh(sheet, paper);
    n.position.set(-0.62 + i * 0.42, 1.78 + (i % 2 ? 0.16 : -0.1), 0.06);
    n.rotation.z = (i % 2 ? 1 : -1) * 0.06;
    g.add(n);
  }

  g.position.set(x, y, z);
  g.rotation.y = yaw;
  scene.add(g);
}

// ---------------------------------------------------------------- contract generation
// Shapes cycle by tier, so the first three contracts are one of each and the player learns the
// whole vocabulary immediately. Every tier after that is the same shapes, further out and worth
// more, with the slay targets stepping up Mudcrab -> Nix-Hound -> Kagouti.
function rewardFor(shape, tier) {
  const base = { slay: 60, fetch: 80, travel: 55 }[shape];
  return Math.round(base * (1 + 0.35 * (tier - 1)) / 5) * 5;
}

function generateContract(tier) {
  const shape = SHAPES[(tier - 1) % 3];
  const step = Math.floor((tier - 1) / 3);
  const reward = rewardFor(shape, tier);

  if (shape === 'slay') {
    const typeName = state.typeNames[Math.min(state.typeNames.length - 1, step)];
    const need = 3 + Math.min(3, step);
    return {
      tier, shape, typeName, need, have: 0, done: false, reward,
      spot: spotAt(70, 170),
      title: `Slay ${need} ${PLURAL[typeName] || typeName}`
    };
  }

  if (shape === 'fetch') {
    const item = ITEMS[step % ITEMS.length];
    const near = 90 + step * 15, far = 155 + step * 30;
    return {
      tier, shape, item, done: false, reward,
      spot: spotAt(near, far, h => h > WATER + 3),
      title: `Recover the ${item}`
    };
  }

  const near = 120 + step * 30;
  const spot = spotAt(near, near + 60);
  const label = travelLabel(spot.x, spot.z);
  return {
    tier, shape, spot, label, done: false, reward,
    title: `Reach ${label}`
  };
}

// A real place on the real heightfield: dry, walkable, inside the island, and not inside a tree.
function spotAt(minD, maxD, accept) {
  const s = findSpot(500, () => ringSpot(state.board, minD, maxD - minD), p => {
    if (Math.abs(p.x) > WORLD * 0.46 || Math.abs(p.z) > WORLD * 0.46) return false;
    const h = heightAt(p.x, p.z);
    if (h < WATER + 2 || slopeAt(p.x, p.z) > 0.4) return false;
    if (accept && !accept(h)) return false;
    for (const o of obstacles) {
      const dx = p.x - o.x, dz = p.z - o.z, r = o.r + 1.2;
      if (dx * dx + dz * dz < r * r) return false;
    }
    return true;
  });
  // fall back to a point just outside the village rather than failing the whole contract
  return s ? { x: s.x, z: s.z } : { x: state.board.x + 60, z: state.board.z };
}

// Named after what the terrain actually is there, so the name is never a lie
function travelLabel(x, z) {
  const h = heightAt(x, z);
  if (h < WATER + 9) return 'the shore';
  if (h > HMAX * 0.42) return 'the high ridge';
  return 'the dry flats';
}

// ---------------------------------------------------------------- accepting and paying
export function interact() {
  if (!state.board || !state.near) return false;

  if (state.active && state.active.done) { payOut(state.active); return true; }
  if (state.active) { say('Finish the contract you are already carrying.'); return true; }
  if (state.offer) { acceptOffer(); return true; }
  return false;
}

function acceptOffer() {
  state.active = state.offer;
  state.offer = null;
  if (state.active.shape === 'fetch') spawnItem(state.active);
  say(`Contract taken: ${state.active.title}.`);
}

function payOut(c) {
  player.gold += c.reward;
  say(`Contract complete. +${c.reward} gold.`);

  if (state.item) { scene.remove(state.item.mesh); state.item = null; }
  state.active = null;
  state.offer = generateContract(c.tier + 1);
  say(`Next contract posted: ${state.offer.title}.`);
}

// ---------------------------------------------------------------- the fetch objective
// A real object at a real place: you find it, it disappears when you take it, and the waypoint
// then points back at the board to hand it in.
function spawnItem(c) {
  if (!itemGeo) {
    itemGeo = new THREE.TorusGeometry(0.28, 0.1, 6, 10);
    itemMat = new THREE.MeshLambertMaterial({ color: 0xc9a24a, emissive: 0x2e2308 });
  }
  const mesh = new THREE.Mesh(itemGeo, itemMat);
  const y = heightAt(c.spot.x, c.spot.z) + 0.55;
  mesh.position.set(c.spot.x, y, c.spot.z);
  mesh.rotation.x = Math.PI / 2;
  scene.add(mesh);
  state.item = { mesh, baseY: y };
}

// ---------------------------------------------------------------- events
// Called from the enemy death path — this is the real kill event, not a poll.
export function contractKilled(typeName) {
  const a = state.active;
  if (!a || a.done || a.shape !== 'slay' || a.typeName !== typeName) return;
  a.have++;
  if (a.have >= a.need) {
    a.have = a.need;
    a.done = true;
    say(`${a.title} — done. Return to the notice board.`);
  }
}

// ---------------------------------------------------------------- per frame
export function updateContracts(dt) {
  if (!state.board) return;
  const px = player.pos.x, pz = player.pos.z;
  state.near = Math.hypot(px - state.board.x, pz - state.board.z) < 4.5;

  const a = state.active;

  if (state.item) {
    const it = state.item;
    it.mesh.rotation.z += dt * 1.4;
    it.mesh.position.y = it.baseY + Math.sin(performance.now() * 0.002) * 0.08;
    if (a && a.shape === 'fetch' && !a.done) {
      const dx = px - it.mesh.position.x, dz = pz - it.mesh.position.z;
      if (dx * dx + dz * dz < 2.2 * 2.2) {
        scene.remove(it.mesh);
        state.item = null;
        a.done = true;
        say(`${a.item} recovered. Return to the notice board.`);
      }
    }
  }

  if (a && !a.done && a.shape === 'travel') {
    if (Math.hypot(px - a.spot.x, pz - a.spot.z) < 14) {
      a.done = true;
      say(`You reach ${a.label}. Return to the notice board.`);
    }
  }
}

// ---------------------------------------------------------------- views for the HUD
// The HUD draws what it is handed; all wording and state lives here.
export function contractView() {
  if (!state.board) return null;
  const px = player.pos.x, pz = player.pos.z;

  if (state.active) {
    const a = state.active;
    let line;
    if (a.done) line = 'Return to the notice board';
    else if (a.shape === 'slay') line = `${a.have} / ${a.need} slain`;
    else line = `${Math.max(1, Math.round(Math.hypot(px - a.spot.x, pz - a.spot.z)))} m away`;

    let prompt = null;
    if (a.done && state.near) prompt = `Collect ${a.reward} gold`;
    return { label: `CONTRACT ${a.tier}`, title: a.title, line, prompt };
  }

  if (state.offer) {
    return {
      label: 'ON OFFER',
      title: state.offer.title,
      line: 'Posted on the notice board',
      prompt: state.near ? 'Accept contract' : null
    };
  }
  return null;
}

// Where the compass marker should point, on the real world position of the objective.
export function waypointOf() {
  if (!state.board) return null;
  const a = state.active;
  if (!a || a.done) return { x: state.board.x, z: state.board.z };
  if (a.shape === 'slay') {
    const near = state.locateEnemy(a.typeName);
    return near ? { x: near.x, z: near.z } : { x: a.spot.x, z: a.spot.z };
  }
  return { x: a.spot.x, z: a.spot.z };
}
