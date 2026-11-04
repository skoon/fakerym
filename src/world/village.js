import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD, HMAX, WATER } from '../core/config.js';
import { scene } from '../core/renderer.js';
import { heightAt, slopeAt, flattenDisc, boxSpot, bestSpot } from './heightfield.js';

// ---------------------------------------------------------------- stone settlement
// Houses are assembled from the Retro Fantasy Kit (src/models/) on its 1 unit module grid, scaled up
// by MODULE so one module is a 3 m storey: a 9 m x 9 m townhouse, two storeys, slate roof.
//
// The kit is a tile kit: every piece is a whole module, and its roof pieces are complete 1 module
// gables (measured: ridge along local z, slopes falling to +-x). That means a house wider than one
// module cannot have a single ridge — a roof is always a run of gables. So the rooflines are varied
// the ways the kit actually allows: gable ends turned to the street, shallow gables running the
// other way, gables with a corner tower, and a flat crenellated top.
//
// The kit paints bricks, stone, timber, roof and detail on separate textures, so geometry is merged
// per MATERIAL across the whole town rather than per house: a few hundred pieces of kit become about
// seven meshes in total instead of several hundred draw calls.
const VILLAGE_R = 42;
const MODULE = 3;              // metres per kit unit
const STOREYS = 2;
const FRONT = 9;               // metres from the street centreline to a house front wall
const PER_SIDE = 5;
const SPACING = 13;            // metres between house centres along the row
const STEP_H = 0.2 * MODULE;   // the kit's floor-steps piece is 0.2 modules tall: that is the door sill

export const boxes = [];       // {x,z,yaw,hx,hz} — rotated AABBs the player is pushed out of
export const MAT = {};
export let village = null;
export let street = 0;

const lanterns = [];
const lampHeads = [];
const KIT_DIR = new URL('../models/Retro Fantasy Kit/Models/GLB format/', import.meta.url).href;
const KIT_PIECES = ['wall', 'wall-paint', 'wall-window', 'wall-door', 'roof', 'roof-side',
  'roof-edge', 'battlement', 'floor', 'tower-top', 'column-wood', 'fence-wood',
  'floor-steps', 'detail-barrel', 'detail-crate', 'detail-crate-small', 'bricks', 'ladder', 'barrels'];
const PIECES = new Map();      // name -> [{ geometry, matrix, matKey }]
const MATERIALS = new Map();   // material name -> THREE material, one per kit texture
const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

// Deterministic per-house variation. Decoration must not draw from the seeded Math.random stream:
// that stream is the world seed, and pulling extra numbers would move every tree and spawn point.
function hash(a, b) {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

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

// ---------------------------------------------------------------- the kit
// Each piece flattens to one entry per mesh: the geometry, the mesh's own matrix inside the GLB, and
// the name of the material it uses.
async function loadKit() {
  if (MATERIALS.size) return;
  const loader = new GLTFLoader();
  await Promise.all(KIT_PIECES.map(async name => {
    try {
      const gltf = await loader.loadAsync(KIT_DIR + encodeURIComponent(name) + '.glb');
      gltf.scene.updateMatrixWorld(true);
      const parts = [];
      gltf.scene.traverse(o => {
        if (!o.isMesh) return;
        const src = Array.isArray(o.material) ? o.material[0] : o.material;
        const key = src.name || 'default';
        if (!MATERIALS.has(key)) {
          // the kit ships MeshStandardMaterial; this project dropped PBR (no env map, plan.md)
          MATERIALS.set(key, new THREE.MeshLambertMaterial({ map: src.map || null }));
        }
        // merge requires one consistent indexing scheme, and the kit mixes them per piece
        const geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
        parts.push({ geo, matrix: o.matrixWorld.clone(), matKey: key });
      });
      PIECES.set(name, parts);
    } catch (err) {
      console.error(`[village] kit piece ${name} failed to load`, err);
    }
  }));
  if (!MATERIALS.size) MATERIALS.set('default', new THREE.MeshLambertMaterial({ color: 0x9a9384 }));
}

// Place one kit piece in module coordinates, appending its geometry to `out` under its material.
function addPiece(out, name, x, y, z, yaw = 0) {
  const parts = PIECES.get(name);
  if (!parts) return;
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(UP, yaw),
    ONE
  );
  for (const part of parts) {
    const geo = part.geo.clone();
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(m, part.matrix));
    let list = out.get(part.matKey);
    if (!list) { list = []; out.set(part.matKey, list); }
    list.push(geo);
  }
}

// Same, but with a full world matrix composed in front — used for the street furniture, which is
// placed in world metres rather than in a house's module space.
function emit(out, name, worldMatrix) {
  const parts = PIECES.get(name);
  if (!parts) return;
  for (const part of parts) {
    const geo = part.geo.clone();
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(worldMatrix, part.matrix));
    let list = out.get(part.matKey);
    if (!list) { list = []; out.set(part.matKey, list); }
    list.push(geo);
  }
}

// ---------------------------------------------------------------- house plans
// Footprint and roofline are chosen per house; the rhythm down the street is the plan cycle, so the
// town never has two identical neighbours. w x d are modules, the front face is +z.
const PLANS = [
  { w: 3, d: 3, roof: 'gables' },     // three gable ends turned to the street
  { w: 3, d: 3, roof: 'lowridge' },   // shallow gables, ridges running along the street
  { w: 3, d: 3, roof: 'tower' },      // gables plus a crenellated corner tower
  { w: 3, d: 2, roof: 'hip' },        // smaller house, roof hipped at the alley ends
  { w: 3, d: 3, roof: 'keep' },       // flat roof with a battlemented parapet
];

// A house in module coordinates, centred on the origin in x/z with its feet at y = 0. The +z face is
// the street face: door in the middle, windows on the flanks and the floor above.
function housePieces(plan, seed) {
  const { w, d } = plan;
  const out = new Map();
  const ox = (w - 1) / 2, oz = (d - 1) / 2;
  const mid = Math.floor(w / 2);

  for (let storey = 0; storey < STOREYS; storey++) {
    for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
      const onX = i === 0 || i === w - 1, onZ = j === 0 || j === d - 1;
      if (!onX && !onZ) continue;
      // the kit carries a module's door and window recess on its -z face, so each perimeter module
      // is turned to face outward — otherwise the fronts read as blank brick from the street
      const nx = i === 0 ? -1 : i === w - 1 ? 1 : 0;
      const nz = j === 0 ? -1 : j === d - 1 ? 1 : 0;
      const yaw = Math.atan2(-nx, -nz);

      let name = storey === 0 ? 'wall' : 'wall-window';
      if (storey === 0 && j === d - 1 && i === mid) name = 'wall-door';
      else if (storey === 0 && j === 0 && i === mid) name = 'wall-window';
      else if (hash(seed, i * 31 + j * 7 + storey * 101) < 0.28) name = storey === 0 ? 'wall-paint' : 'wall';
      addPiece(out, name, i - ox, storey, j - oz, yaw);
    }
  }

  roofPieces(out, plan, ox, oz, seed);
  return out;
}

function roofPieces(out, plan, ox, oz, seed) {
  const { w, d, roof } = plan;
  const y = STOREYS;

  if (roof === 'keep') {
    // flat stone roof with a battlemented parapet — the kit's battlement is 1 x 0.4 x 0.3 modules
    for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) addPiece(out, 'floor', i - ox, y, j - oz);
    for (let i = 0; i < w; i++) {
      addPiece(out, 'battlement', i - ox, y + 0.05, oz + 0.35);
      addPiece(out, 'battlement', i - ox, y + 0.05, -oz - 0.35, Math.PI);
    }
    for (let j = 0; j < d; j++) {
      addPiece(out, 'battlement', ox + 0.35, y + 0.05, j - oz, -Math.PI / 2);
      addPiece(out, 'battlement', -ox - 0.35, y + 0.05, j - oz, Math.PI / 2);
    }
    return;
  }

  if (roof === 'tower') {
    // a corner tower rises through the roof, so the cell it occupies has no gable
    const ti = w - 1, tj = 0;
    for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
      if (i === ti && j === tj) continue;
      addPiece(out, 'roof', i - ox, y, j - oz);
    }
    addPiece(out, 'wall', ti - ox, y, tj - oz);
    addPiece(out, 'wall-window', ti - ox, y + 1, tj - oz);
    addPiece(out, 'tower-top', ti - ox, y + 2, tj - oz);
    return;
  }

  if (roof === 'hip') {
    // ridge turned along the street, hipped ends in the alleys: roof-edge is the kit's tapering end
    for (let j = 0; j < d; j++) for (let i = 0; i < w; i++) {
      const end = i === 0 || i === w - 1;
      addPiece(out, end ? 'roof-edge' : 'roof', i - ox, y, j - oz, Math.PI / 2);
    }
    return;
  }

  if (roof === 'lowridge') {
    // the shallow half-height gable, turned so the slopes face the street
    for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
      addPiece(out, 'roof-side', i - ox, y, j - oz, Math.PI / 2);
    }
    return;
  }

  // 'gables': the kit's own stepped roofline, one gable end per module across the front
  for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) addPiece(out, 'roof', i - ox, y, j - oz);
}

// ---------------------------------------------------------------- street furniture
// Everything sits in the house's own module space, so it follows the front wall and the street angle.
// Props are the kit's own: a 3 m door step, barrels, crates, a rack, bricks, a ladder.
function dressHouse(buckets, M, plan, seed, footY) {
  const front = plan.d / 2;                       // front wall plane, module coords
  // the house stands on a plinth now, so the props sit at the ground line, not at the floor
  const at = (mx, mz, yaw = 0, y = footY + 0.02) => M.clone().multiply(new THREE.Matrix4().compose(
    new THREE.Vector3(mx, y, mz),
    new THREE.Quaternion().setFromAxisAngle(UP, yaw), ONE));

  if (hash(seed, 2) < 0.55) emit(buckets, 'detail-barrel', at(-1.2, front + 0.3, hash(seed, 21) * Math.PI));
  if (hash(seed, 3) < 0.55) emit(buckets, 'detail-crate', at(-1.0, front + 0.34, hash(seed, 22) * 0.6));
  if (hash(seed, 4) < 0.5) emit(buckets, 'detail-crate-small', at(-0.9, front + 0.62, 0.3));
  if (hash(seed, 5) < 0.45) emit(buckets, 'detail-barrel', at(1.25, front + 0.28, 0.5));
  if (hash(seed, 6) < 0.4) emit(buckets, 'barrels', at(1.15, front + 0.34, -Math.PI / 2));
  if (hash(seed, 7) < 0.35) emit(buckets, 'bricks', at(-1.3, front + 0.55, 0.4));
  if (hash(seed, 8) < 0.3) emit(buckets, 'ladder', at(-1.36, front - 0.06, 0));
  if (hash(seed, 9) < 0.3) emit(buckets, 'ladder', at(1.36, front - 0.06, 0));
}

export async function buildVillage() {
  await loadKit();
  // a rebuild must not stack a second set of collision boxes on the first
  boxes.length = 0;

  const buckets = new Map();
  const houseMatrix = (x, y, z, yaw) => new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(UP, yaw),
    new THREE.Vector3(MODULE, MODULE, MODULE));

  // two rows of houses facing a street, on the same random street axis
  street = Math.random() * Math.PI * 2;
  const ca = Math.cos(street), sa = Math.sin(street);

  const plinths = [];
  for (let i = 0; i < PER_SIDE * 2; i++) {
    const plan = PLANS[i % PLANS.length];
    const side = i < PER_SIDE ? 1 : -1;
    const along = (i % PER_SIDE - (PER_SIDE - 1) / 2) * SPACING + (Math.random() - 0.5) * 2;
    const hx = plan.w * 0.5 * MODULE, hz = plan.d * 0.5 * MODULE;

    // A house sits on the lowest of its four corners, and a site that steps more than half a metre
    // under the footprint is rejected. The FRONT line is fixed and the depth grows away from it, so
    // the street facade stays straight even though the houses are different sizes.
    for (let attempt = 0; attempt < 3; attempt++) {
      const off = side * (FRONT + hz + Math.random() * 1.6 - attempt * 0.8);
      const x = village.cx + ca * along - sa * off;
      const z = village.cz + sa * along + ca * off;
      const corners = [[x + hx, z + hz], [x - hx, z + hz], [x + hx, z - hz], [x - hx, z - hz]]
        .map(([px, pz]) => heightAt(px, pz));
      const lo = Math.min(...corners), hi = Math.max(...corners);
      if (lo < WATER + 1.5 || hi - lo > 0.6) continue;

      // the street face (+z) turns towards the middle of the street
      const yaw = Math.atan2(side * sa, -side * ca);
      // The floor sits one step-height above the ground, on a stone plinth, so the door sill meets the
      // top of the stoop instead of the ground sinking away under the threshold.
      const baseY = lo + STEP_H;
      const M = houseMatrix(x, baseY, z, yaw);
      const pieces = housePieces(plan, i);
      for (const [key, list] of pieces) {
        let bucket = buckets.get(key);
        if (!bucket) { bucket = []; buckets.set(key, bucket); }
        for (const geo of list) {
          geo.applyMatrix4(M);
          bucket.push(geo);
        }
      }
      const dx = Math.sin(yaw), dz = Math.cos(yaw);     // the house's own +z, in world space
      const groundFront = heightAt(x + dx * hz, z + dz * hz);
      dressHouse(buckets, M, plan, i, (groundFront - baseY) / MODULE);

      // the plinth is buried half a metre under the lowest corner, so it never floats on a slope.
      // Built in world metres: houseMatrix carries the kit's MODULE scale and would triple it.
      const plinthH = baseY - (lo - 0.5);
      plinths.push(new THREE.BoxGeometry(hx * 2 + 0.08, plinthH, hz * 2 + 0.08)
        .applyMatrix4(new THREE.Matrix4().compose(
          new THREE.Vector3(x, lo - 0.5 + plinthH / 2, z),
          new THREE.Quaternion().setFromAxisAngle(UP, yaw), ONE)));

      // The stoop: the kit's floor-steps is a wedge that ramps up towards local +z, so it is turned
      // to face the street and pushed back until its high edge is flush with the front wall.
      const sz = 0.5, sx = 0.62;
      const stepOff = hz + sz * MODULE * 0.5;
      const stepX = x + dx * stepOff, stepZ = z + dz * stepOff;
      const stepBottom = Math.min(lo, heightAt(stepX, stepZ)) - 0.05;
      // emit() places kit geometry in module units, so the scale has to carry MODULE as well
      emit(buckets, 'floor-steps', new THREE.Matrix4().compose(
        new THREE.Vector3(stepX, stepBottom, stepZ),
        new THREE.Quaternion().setFromAxisAngle(UP, yaw + Math.PI),
        new THREE.Vector3(sx * MODULE, ((baseY - stepBottom) / STEP_H) * MODULE, sz * MODULE)));
      // the collision box is this house's own footprint: walls are flush with the module grid, so
      // anything more than a centimetre of padding reads as an invisible wall you stop short of
      boxes.push({ x, z, yaw, hx: hx + 0.02, hz: hz + 0.02 });
      break;
    }
  }

  // rear garden fences, one run behind each row — the kit's fence panel is 3 m wide, 0.9 m tall
  for (const side of [1, -1]) {
    const yaw = Math.atan2(side * sa, -side * ca);
    for (let k = -1; k <= 1; k++) {
      const off = side * (FRONT + 15);
      const x = village.cx + ca * k * 9 - sa * off;
      const z = village.cz + sa * k * 9 + ca * off;
      const M = new THREE.Matrix4().compose(new THREE.Vector3(x, heightAt(x, z), z),
        new THREE.Quaternion().setFromAxisAngle(UP, yaw), new THREE.Vector3(MODULE, MODULE, MODULE));
      emit(buckets, 'fence-wood', M);
      boxes.push({ x, z, yaw, hx: 1.5, hz: 0.15 });
    }
  }

  // street lanterns: wooden posts from the kit (it has no lamp piece), lit by a small head
  const lampSpots = [];
  for (let i = -1; i <= 1; i++) {
    // offset off the street centreline: a lamp in the middle of the road blocks the view down it
    const x = village.cx + ca * i * 16 - sa * 3.6, z = village.cz + sa * i * 16 + ca * 3.6;
    const y = heightAt(x, z);
    // column-wood is 0.3 x 1 x 0.3 modules; this makes a 0.4 m wide, 4.5 m tall post
    const M = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromAxisAngle(UP, hash(i + 5, 3) * Math.PI),
      new THREE.Vector3(MODULE * 0.45, MODULE * 1.5, MODULE * 0.45));
    emit(buckets, 'column-wood', M);
    lampSpots.push({ x, y, z });
  }

  for (const [key, list] of buckets) {
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    scene.add(new THREE.Mesh(merged, MATERIALS.get(key) || MATERIALS.values().next().value));
  }

  // one grey plinth mesh for the whole town: the houses are lifted a step-height off the ground
  scene.add(new THREE.Mesh(mergeGeometries(plinths, false),
    new THREE.MeshLambertMaterial({ color: 0x8d8879 })));

  const headGeo = new THREE.BoxGeometry(0.34, 0.42, 0.34);
  const headMat = new THREE.MeshLambertMaterial({ color: 0xffd7a0, emissive: 0xffb26b, emissiveIntensity: 0 });
  for (const { x, y, z } of lampSpots) {
    boxes.push({ x, z, yaw: 0, hx: 0.2, hz: 0.2 });

    const head = new THREE.Mesh(headGeo, headMat);
    head.position.set(x, y + 4.5, z);
    scene.add(head);
    lampHeads.push(head);

    const light = new THREE.PointLight(0xffb26b, 0, 18, 2);
    light.position.set(x, y + 4.3, z);
    scene.add(light);
    lanterns.push(light);
  }
}

export function applyDayNight({ night }) {
  for (const l of lanterns) l.intensity = night * 9;
  for (const h of lampHeads) h.material.emissiveIntensity = night * 1.2;
}
