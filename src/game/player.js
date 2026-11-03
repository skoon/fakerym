import * as THREE from 'three';
import { WORLD, WATER } from '../core/config.js';
import { viewRoot, pitchRoot } from '../core/renderer.js';
import { heightAt, slopeAt, boxSpot, findSpot } from '../world/heightfield.js';
import { boxes, street } from '../world/village.js';
import { obstacles } from '../world/flora.js';
import { keys, look } from '../ui/input.js';
import { say } from '../ui/hud.js';

// ---------------------------------------------------------------- player
export const player = {
  pos: new THREE.Vector3(0, 0, 0),
  vel: new THREE.Vector3(),
  onGround: false,
  hp: 100, maxHp: 100,
  stam: 100, maxStam: 100,
  mag: 100, maxMag: 100,
  level: 1, xp: 0, xpNext: 100, gold: 0, potions: 1,
  swing: -1,          // >=0 while swinging
  hitDone: false,
  attackCd: 0, castCd: 0, hurtCd: 0
};

let bobT = 0;

// start on the road just outside the settlement, looking down the street
export function spawnPlayer(village) {
  const a = street + Math.PI;
  const x = village.cx + Math.cos(a) * (village.r + 8), z = village.cz + Math.sin(a) * (village.r + 8);
  player.pos.set(x, heightAt(x, z) + 2, z);
}

export function drinkPotion() {
  if (player.potions > 0 && player.hp < player.maxHp) {
    player.potions--; player.hp = Math.min(player.maxHp, player.hp + 45); say('Drank a healing potion.');
  }
}

export function checkLevelUp() {
  while (player.xp >= player.xpNext) {
    player.xp -= player.xpNext;
    player.level++;
    player.xpNext = Math.round(player.xpNext * 1.45);
    player.maxHp += 12; player.maxStam += 6; player.maxMag += 8;
    player.hp = player.maxHp; player.mag = player.maxMag;
    say(`— LEVEL ${player.level} —`);
  }
}

export function respawnPlayer() {
  player.hp = player.maxHp; player.stam = player.maxStam; player.mag = player.maxMag;
  player.gold = Math.floor(player.gold * 0.6);
  say('You have died. Somewhere, a hand reaches out — and your purse is lighter.');
  const spot = findSpot(2000, () => boxSpot(WORLD * 0.5),
    s => heightAt(s.x, s.z) > WATER + 4 && slopeAt(s.x, s.z) < 0.2);
  if (spot) player.pos.set(spot.x, heightAt(spot.x, spot.z) + 2, spot.z);
}

// ---------------------------------------------------------------- movement & collision
const fwd = new THREE.Vector3(), right = new THREE.Vector3(), wish = new THREE.Vector3();
const bobOff = new THREE.Vector3();

export function movePlayer(dt) {
  const yaw = look.yaw;
  const sprinting = keys.ShiftLeft && player.stam > 1;
  const speed = (sprinting ? 9.5 : 5.2) * (player.pos.y < WATER ? 0.55 : 1);

  fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  right.set(Math.cos(yaw), 0, -Math.sin(yaw));
  wish.set(0, 0, 0);
  if (keys.KeyW) wish.add(fwd);
  if (keys.KeyS) wish.sub(fwd);
  if (keys.KeyD) wish.add(right);
  if (keys.KeyA) wish.sub(right);
  const moving = wish.lengthSq() > 0;
  if (moving) wish.normalize().multiplyScalar(speed);

  if (sprinting && moving) player.stam -= 18 * dt;
  else player.stam = Math.min(player.maxStam, player.stam + 14 * dt);
  player.mag = Math.min(player.maxMag, player.mag + 5.5 * dt);
  player.stam = Math.max(0, player.stam);

  // horizontal: snappy accel, no ice skating
  player.vel.x = THREE.MathUtils.damp(player.vel.x, wish.x, 14, dt);
  player.vel.z = THREE.MathUtils.damp(player.vel.z, wish.z, 14, dt);

  const swimming = player.pos.y < WATER - 0.4;
  player.vel.y -= (swimming ? 4 : 26) * dt;
  if (swimming) player.vel.y = Math.max(player.vel.y, -1.6);
  if (keys.Space && (player.onGround || swimming)) player.vel.y = swimming ? 3.2 : 9.0;

  player.pos.addScaledVector(player.vel, dt);

  // push out of trees and boulders
  for (const o of obstacles) {
    const dx = player.pos.x - o.x, dz = player.pos.z - o.z;
    const rr = o.r + 0.45, d2 = dx * dx + dz * dz;
    if (d2 < rr * rr && d2 > 1e-6) {
      const d = Math.sqrt(d2), push = (rr - d) / d;
      player.pos.x += dx * push; player.pos.z += dz * push;
    }
  }

  // push out of walls: into box space, clamp to the nearest face, back to world
  for (const b of boxes) {
    const dx = player.pos.x - b.x, dz = player.pos.z - b.z;
    const cy = Math.cos(b.yaw), sy = Math.sin(b.yaw);
    let lx = dx * cy + dz * sy, lz = -dx * sy + dz * cy;
    const ex = b.hx + 0.45, ez = b.hz + 0.45;
    if (Math.abs(lx) < ex && Math.abs(lz) < ez) {
      if (ex - Math.abs(lx) < ez - Math.abs(lz)) lx = Math.sign(lx || 1) * ex;
      else lz = Math.sign(lz || 1) * ez;
      player.pos.x = b.x + lx * cy - lz * sy;
      player.pos.z = b.z + lx * sy + lz * cy;
    }
  }

  // ground
  const g = heightAt(player.pos.x, player.pos.z) + 1.72;
  if (player.pos.y <= g) { player.pos.y = g; player.vel.y = Math.max(0, player.vel.y); player.onGround = true; }
  else player.onGround = false;

  const lim = WORLD * 0.48;
  player.pos.x = THREE.MathUtils.clamp(player.pos.x, -lim, lim);
  player.pos.z = THREE.MathUtils.clamp(player.pos.z, -lim, lim);

  // head bob
  const spd = Math.hypot(player.vel.x, player.vel.z);
  bobT += dt * spd * 1.35;
  const bob = player.onGround ? Math.sin(bobT) * 0.045 * Math.min(1, spd / 6) : 0;
  const sway = player.onGround ? Math.cos(bobT * 0.5) * 0.03 * Math.min(1, spd / 6) : 0;

  viewRoot.position.copy(player.pos).add(bobOff.set(0, bob, 0));
  viewRoot.rotation.y = yaw;
  pitchRoot.rotation.x = look.pitch;
  pitchRoot.rotation.z = sway * 0.35;
}
