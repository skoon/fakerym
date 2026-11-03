import * as THREE from 'three';
import { WORLD, SEG, HMAX, WATER, STEP } from '../core/config.js';
import { fbm, ridge } from '../core/noise.js';

// ---------------------------------------------------------------- terrain heights
// The height grid is built first and stands on its own, so the settlement can pick a site and
// level a terrace into it *before* the mesh, colours and normals are generated from it.
export function rawHeight(x, z) {
  const nx = x / WORLD, nz = z / WORLD;
  const base   = fbm(nx * 5.5, nz * 5.5, 6) * 1.15 - 0.42;
  const mtn    = Math.pow(Math.max(0, ridge(nx * 3.1 + 40, nz * 3.1 + 40, 5) - 0.35), 1.8) * 2.6;
  const detail = fbm(nx * 34, nz * 34, 3) * 0.055 + fbm(nx * 78, nz * 78, 2) * 0.016;
  // fall off to sea at the map edge so the world reads as an island
  const d = Math.max(Math.abs(nx), Math.abs(nz)) * 2;
  const edge = 1 - Math.pow(Math.min(1, Math.max(0, (d - 0.72) / 0.28)), 1.6);
  return (base + mtn + detail) * HMAX * edge - 4;
}

export const heights = new Float32Array((SEG + 1) * (SEG + 1));

export function buildHeightfield() {
  for (let i = 0; i <= SEG; i++) for (let j = 0; j <= SEG; j++) {
    heights[i * (SEG + 1) + j] = rawHeight(-WORLD / 2 + j * STEP, -WORLD / 2 + i * STEP);
  }
}

// bilinear sample of the same grid the mesh uses — collision matches what you see
export function heightAt(x, z) {
  const gx = (x + WORLD / 2) / WORLD * SEG, gz = (z + WORLD / 2) / WORLD * SEG;
  const i0 = THREE.MathUtils.clamp(Math.floor(gz), 0, SEG - 1), j0 = THREE.MathUtils.clamp(Math.floor(gx), 0, SEG - 1);
  const fz = gz - i0, fx = gx - j0, w = SEG + 1;
  const h00 = heights[i0 * w + j0], h10 = heights[i0 * w + j0 + 1];
  const h01 = heights[(i0 + 1) * w + j0], h11 = heights[(i0 + 1) * w + j0 + 1];
  return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
}

export function slopeAt(x, z) {
  const d = 2.5;
  return Math.max(Math.abs(heightAt(x + d, z) - heightAt(x - d, z)), Math.abs(heightAt(x, z + d) - heightAt(x, z - d))) / (2 * d);
}

// level a disc to one height, feathered at the rim so it reads as a terrace, not a crater
export function flattenDisc(cx, cz, r, feather) {
  const reach = r + feather;
  const j0 = Math.max(0, Math.floor((cx - reach + WORLD / 2) / STEP)), j1 = Math.min(SEG, Math.ceil((cx + reach + WORLD / 2) / STEP));
  const i0 = Math.max(0, Math.floor((cz - reach + WORLD / 2) / STEP)), i1 = Math.min(SEG, Math.ceil((cz + reach + WORLD / 2) / STEP));
  let sum = 0, n = 0;
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const x = -WORLD / 2 + j * STEP, z = -WORLD / 2 + i * STEP;
    if (Math.hypot(x - cx, z - cz) <= r) { sum += heights[i * (SEG + 1) + j]; n++; }
  }
  const target = Math.max(WATER + 2.2, sum / Math.max(1, n));
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const x = -WORLD / 2 + j * STEP, z = -WORLD / 2 + i * STEP;
    const k = 1 - THREE.MathUtils.smoothstep(Math.hypot(x - cx, z - cz), r, reach);
    const idx = i * (SEG + 1) + j;
    heights[idx] += (target - heights[idx]) * k;
  }
  return target;
}

// the grass shader samples terrain height on the GPU; NearestFilter because float textures are
// not linearly filterable, so the bilinear tap is done by hand in the shader
export function createHeightTexture() {
  const t = new THREE.DataTexture(heights, SEG + 1, SEG + 1, THREE.RedFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------- placement
// Every spot search in the game is the same shape: draw a candidate, reject it on height or
// slope, try again. Only the sampling distribution and the accept/score rule differ.
const SPOT = { x: 0, z: 0 };

export function boxSpot(spread) {
  SPOT.x = (Math.random() - 0.5) * spread;
  SPOT.z = (Math.random() - 0.5) * spread;
  return SPOT;
}

export function ringSpot(near, min, span) {
  const a = Math.random() * Math.PI * 2, d = min + Math.random() * span;
  SPOT.x = near.x + Math.cos(a) * d;
  SPOT.z = near.z + Math.sin(a) * d;
  return SPOT;
}

// first candidate the test accepts, or null. The returned object is reused — copy what you keep.
export function findSpot(tries, sample, accept) {
  for (let t = 0; t < tries; t++) {
    const s = sample();
    if (accept(s)) return s;
  }
  return null;
}

// lowest-scoring candidate over the whole budget; score returns null to reject outright
export function bestSpot(tries, sample, score) {
  let best = null, bestScore = Infinity;
  for (let t = 0; t < tries; t++) {
    const s = sample();
    const v = score(s);
    if (v === null || !(v < bestScore)) continue;
    bestScore = v;
    best = { x: s.x, z: s.z };
  }
  return best;
}

// place `count` things, giving up after count*60 rejected draws
export function scatter(count, test, place) {
  let made = 0, tries = 0;
  while (made < count && tries < count * 60) {
    tries++;
    const s = boxSpot(WORLD * 0.94);
    const h = heightAt(s.x, s.z), sl = slopeAt(s.x, s.z);
    if (test(h, sl, s.x, s.z)) { place(s.x, h, s.z); made++; }
  }
  return made;
}
