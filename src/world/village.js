import * as THREE from 'three';
import { WORLD, HMAX, WATER } from '../core/config.js';
import { scene } from '../core/renderer.js';
import { heightAt, slopeAt, flattenDisc, boxSpot, bestSpot } from './heightfield.js';
import { ground } from './terrain.js';

// ---------------------------------------------------------------- Hlaalu settlement
// Flat-roofed adobe boxes with parapets, protruding roof beams, wooden balconies and
// external stairs. Exteriors only — the doors are scenery, there are no interior cells.
const VILLAGE_R = 42;

export const boxes = [];      // {x,z,yaw,hx,hz} — rotated AABBs the player is pushed out of
export const MAT = {};        // .window and .lamp take an emissive ramp from the day/night cycle
export let village = null;
export let street = 0;

const lanterns = [];
let UNIT = null, ADOBE = null;

// pick the flattest dry site we can find; buildings on a heightmap slope look terrible,
// then terrace it. Must run before the terrain mesh is painted from the height grid.
export function planVillage() {
  const best = bestSpot(4000, () => boxSpot(WORLD * 0.6), s => {
    let worst = 0, minH = 1e9;
    for (let a = 0; a < 8; a++) {
      const ang = a / 8 * Math.PI * 2;
      for (const rr of [VILLAGE_R * 0.45, VILLAGE_R]) {
        const px = s.x + Math.cos(ang) * rr, pz = s.z + Math.sin(ang) * rr;
        worst = Math.max(worst, slopeAt(px, pz));
        minH = Math.min(minH, heightAt(px, pz));
      }
    }
    if (minH < WATER + 2.5 || heightAt(s.x, s.z) > HMAX * 0.32) return null;
    return worst;
  });

  village = { cx: best.x, cz: best.z, r: VILLAGE_R };
  flattenDisc(village.cx, village.cz, VILLAGE_R * 0.82, 30);
  return village;
}

export function inVillage(x, z, pad = 0) {
  return Math.hypot(x - village.cx, z - village.cz) < village.r + pad;
}

function slab(w, h, d, x, y, z, mat) {
  const m = new THREE.Mesh(UNIT, mat);
  m.scale.set(w, h, d); m.position.set(x, y, z);
  return m;
}

// a real box (not a scaled unit cube) so the plaster gets UVs proportional to the wall
function wall(w, h, d, x, y, z, mat) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w * 0.34, uv.getY(i) * h * 0.34);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  return m;
}

function makeHouse() {
  const g = new THREE.Group();
  const adobe = ADOBE[(Math.random() * ADOBE.length) | 0];
  const w = 5 + Math.random() * 3.5, d = 4.5 + Math.random() * 3, h = 3.2 + Math.random() * 1.3;

  g.add(slab(w + 0.5, 2.8, d + 0.5, 0, -1.1, 0, MAT.stone));      // buried plinth hides slope gaps
  g.add(slab(w + 0.22, 0.55, d + 0.22, 0, 0.26, 0, MAT.stone));    // base course
  g.add(wall(w, h, d, 0, h / 2, 0, adobe));
  g.add(slab(w + 0.55, 0.5, d + 0.55, 0, h + 0.16, 0, adobe));     // roof parapet

  // vigas — roof beams poking through the wall, the signature adobe detail
  const beams = 3 + ((Math.random() * 3) | 0);
  for (let i = 0; i < beams; i++) {
    const x = -w / 2 + (i + 1) * w / (beams + 1);
    g.add(slab(0.17, 0.17, d + 1.1, x, h - 0.22, 0, MAT.wood));
  }

  g.add(slab(1.05, 2.05, 0.16, 0, 1.02, d / 2 + 0.03, MAT.wood));  // door (scenery)
  for (const sx of [-1, 1]) g.add(slab(0.62, 0.62, 0.13, sx * w * 0.28, h * 0.66, d / 2 + 0.04, MAT.window));
  g.add(slab(0.13, 0.62, 0.62, -w / 2 - 0.04, h * 0.66, 0, MAT.window));

  if (Math.random() < 0.55) {                                      // second storey, offset
    const w2 = w * 0.66, d2 = d * 0.66, ox = (Math.random() - 0.5) * (w - w2) * 0.8;
    g.add(wall(w2, 2.7, d2, ox, h + 1.85, -(d - d2) * 0.25, adobe));
    g.add(slab(w2 + 0.45, 0.42, d2 + 0.45, ox, h + 3.35, -(d - d2) * 0.25, adobe));
    g.add(slab(0.55, 0.55, 0.12, ox, h + 1.95, -(d - d2) * 0.25 + d2 / 2 + 0.04, MAT.window));
  }

  if (Math.random() < 0.5) {                                       // balcony + railing
    const bz = d / 2 + 0.75;
    g.add(slab(w * 0.85, 0.18, 1.5, 0, h + 0.3, bz, MAT.wood));
    g.add(slab(w * 0.85, 0.1, 0.1, 0, h + 1.1, bz + 0.7, MAT.wood));
    for (let i = 0; i < 5; i++) g.add(slab(0.1, 0.8, 0.1, -w * 0.42 + i * w * 0.21, h + 0.7, bz + 0.7, MAT.wood));
    g.add(slab(0.22, 0.22, 0.22, -w * 0.42, h - 0.5, bz + 0.7, MAT.wood));
  }

  if (Math.random() < 0.4) {                                       // external stair to the roof
    for (let i = 0; i < 7; i++) g.add(slab(1.2, 0.28, 0.55, w / 2 + 0.7, 0.28 + i * 0.5, -d / 2 + 0.4 + i * 0.5, MAT.wood));
  }

  g.userData.footprint = { hx: w / 2, hz: d / 2 };
  return g;
}

export function buildVillage() {
  UNIT = new THREE.BoxGeometry(1, 1, 1);
  MAT.stone  = new THREE.MeshLambertMaterial({ color: 0x8b8272, flatShading: true });
  MAT.wood   = new THREE.MeshLambertMaterial({ color: 0x543f26 });
  MAT.window = new THREE.MeshLambertMaterial({ color: 0x241c14 });  // .emissive is driven by time of day
  MAT.lamp   = new THREE.MeshLambertMaterial({ color: 0xa89876 });  // unlit glass shouldn't read as a black ball

  // same painted noise as the ground, tiled small — reads as weathered plaster on a wall
  const stucco = ground.clone();
  stucco.needsUpdate = true;
  stucco.repeat.set(1, 1);
  ADOBE = [0xc0a87f, 0xb59c74, 0xc7b189, 0xad9569].map(c => new THREE.MeshLambertMaterial({ color: c, map: stucco }));

  // lay the houses out in two rows facing a street
  street = Math.random() * Math.PI * 2;
  const ca = Math.cos(street), sa = Math.sin(street);
  for (let i = 0; i < 14; i++) {
    const along = (i % 7 - 3) * 13.5 + (Math.random() - 0.5) * 4;
    const side = i < 7 ? 1 : -1;
    const off = side * (9.5 + Math.random() * 3.5);
    const x = village.cx + ca * along - sa * off;
    const z = village.cz + sa * along + ca * off;
    if (heightAt(x, z) < WATER + 1.5 || slopeAt(x, z) > 0.3) continue;

    const house = makeHouse();
    const yaw = street + (side > 0 ? Math.PI : 0) + (Math.random() - 0.5) * 0.25;
    house.position.set(x, heightAt(x, z) - 0.25, z);
    house.rotation.y = yaw;
    scene.add(house);
    const f = house.userData.footprint;
    boxes.push({ x, z, yaw, hx: f.hx, hz: f.hz });
  }

  // street lanterns — the only light sources after dark
  for (let i = -1; i <= 1; i++) {
    const x = village.cx + ca * i * 16, z = village.cz + sa * i * 16;
    const y = heightAt(x, z);
    const post = slab(0.18, 3.2, 0.18, x, y + 1.6, z, MAT.wood);
    const glass = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), MAT.lamp);
    glass.position.set(x, y + 3.35, z);
    const light = new THREE.PointLight(0xffb26b, 0, 16, 2);
    light.position.copy(glass.position);
    scene.add(post, glass, light);
    lanterns.push(light);
  }
}

export function applyDayNight({ night }) {
  for (const l of lanterns) l.intensity = night * 9;
  MAT.window.emissive.setRGB(night * 0.95, night * 0.56, night * 0.24);
  MAT.lamp.emissive.setRGB(night, night * 0.62, night * 0.3);
}
