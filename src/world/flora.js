import * as THREE from 'three';
import { WATER, HMAX } from '../core/config.js';
import { scene } from '../core/renderer.js';
import { fbm } from '../core/noise.js';
import { lump, mergeGeos, makeInstanced } from '../core/geometry.js';
import { scatter } from './heightfield.js';
import { inVillage } from './village.js';

// ---------------------------------------------------------------- scatter: trees, rocks, grass
export const obstacles = [];   // {x,z,r} — trees & rocks push the player out
export let canopyMesh = null;

// ponytail: every instance is submitted every frame even though fog hides everything past VIEW.
// ~1.9M tris in 8 draw calls, fine on a modern GPU. If it ever matters, sort instances into a
// coarse grid and set .count per frame from the cells within VIEW of the player.

const TREES = 3000, ROCKS = 900, BUSHES = 5200, REEDS = 7000;

// All four scatter types are the same loop: draw a spot, accept it, write a matrix (and usually a
// colour) into every mesh that shares the placement. Only the middle — the per-instance transform
// and tint — differs, so that is all a caller supplies. Meshes whose material has vertexColors get
// the instance colour; the tree trunks, which do not, are skipped.
function fillInstances(meshes, budget, test, place) {
  const put = { p: new THREE.Vector3(), s: new THREE.Vector3(), q: new THREE.Quaternion(), c: new THREE.Color() };
  const m = new THREE.Matrix4();
  let i = 0;
  scatter(budget, test, (x, y, z) => {
    place(put, x, y, z);
    m.compose(put.p, put.q, put.s);
    for (const mesh of meshes) {
      mesh.setMatrixAt(i, m);
      if (mesh.material.vertexColors) mesh.setColorAt(i, put.c);
    }
    i++;
  });
  for (const mesh of meshes) {
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}

export function buildFlora() {
  buildTrees();
  buildRocks();
  buildBushes();
  buildReeds();
}

// --- trees: bent trunk under a broad lumpy canopy, not a conifer
function buildTrees() {
  const trunkGeo = new THREE.CylinderGeometry(0.15, 0.42, 4.3, 6, 4);
  {
    // lean the trunk so the trees look grown rather than placed
    const p = trunkGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const t = (p.getY(i) + 2.15) / 4.3;
      p.setX(i, p.getX(i) + t * t * 0.55);
      p.setZ(i, p.getZ(i) + t * t * 0.2);
    }
    trunkGeo.computeVertexNormals();
    trunkGeo.translate(0, 2.15, 0);
  }
  const canopyGeo = mergeGeos([
    lump(0.55, 4.7, 0.2, 2.35, 0.62),
    lump(1.85, 4.1, 0.45, 1.55, 0.66),
    lump(-0.75, 4.35, -0.65, 1.7, 0.6),
    lump(0.75, 5.5, -0.25, 1.45, 0.58)
  ]);

  const trunkMesh = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x5a4630, flatShading: true }), TREES);
  canopyMesh = makeInstanced(canopyGeo, TREES);
  trunkMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  scene.add(trunkMesh, canopyMesh);

  fillInstances([trunkMesh, canopyMesh], TREES,
    (h, sl, x, z) => h > WATER + 1.2 && h < HMAX * 0.46 && sl < 0.42 && !inVillage(x, z, 4),
    (put, x, y, z) => {
      const sc = 0.75 + Math.random() * 0.85;
      put.p.set(x, y - 0.3, z); put.s.set(sc, sc * (0.85 + Math.random() * 0.4), sc);
      put.q.setFromEuler(new THREE.Euler(0, Math.random() * 7, 0));
      const t = Math.random();
      // NB: setHSL defaults to the linear working space — pass sRGB or everything comes out pale
      // sage/olive, never a saturated forest green
      put.c.setHSL(0.2 + t * 0.06, 0.24 + t * 0.16, 0.2 + t * 0.13, THREE.SRGBColorSpace);
      obstacles.push({ x, z, r: 0.75 * sc });
    });
}

// --- rocks (displaced icosahedra)
function buildRocks() {
  const rockGeo = new THREE.IcosahedronGeometry(1, 1);
  {
    const p = rockGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, i);
      v.multiplyScalar(0.72 + fbm(v.x * 2 + 9, v.z * 2 + 3, 3) * 0.75);
      p.setXYZ(i, v.x, v.y * 0.78, v.z);
    }
    rockGeo.computeVertexNormals();
  }
  const rockMesh = makeInstanced(rockGeo, ROCKS, { color: 0x8f8168 });
  scene.add(rockMesh);

  fillInstances([rockMesh], ROCKS,
    (h, sl, x, z) => h > WATER - 2 && !inVillage(x, z, 2),
    (put, x, y, z) => {
      const sc = 0.5 + Math.pow(Math.random(), 2) * 3.4;
      put.p.set(x, y + sc * 0.25, z); put.s.set(sc, sc * (0.6 + Math.random() * 0.5), sc);
      put.q.setFromEuler(new THREE.Euler(Math.random() * 0.5, Math.random() * 7, Math.random() * 0.5));
      const g = 0.55 + Math.random() * 0.45;
      put.c.setRGB(g, g * 0.97, g * 0.9, THREE.SRGBColorSpace);
      if (sc > 1.4) obstacles.push({ x, z, r: sc * 0.7 });
    });
}

// --- comberry bushes: three squashed lumps, the workhorse shrub of the Ascadian farmland
function buildBushes() {
  const bushMesh = makeInstanced(mergeGeos([
    lump(0, 0.42, 0, 0.62, 0.72), lump(0.42, 0.3, 0.18, 0.4, 0.7), lump(-0.3, 0.34, -0.28, 0.45, 0.68)
  ]), BUSHES);
  scene.add(bushMesh);

  fillInstances([bushMesh], BUSHES,
    (h, sl, x, z) => h > WATER + 0.8 && h < HMAX * 0.44 && sl < 0.45 && !inVillage(x, z, 2),
    (put, x, y, z) => {
      const sc = 0.6 + Math.random() * 0.9;
      put.p.set(x, y, z); put.s.setScalar(sc);
      put.q.setFromEuler(new THREE.Euler(0, Math.random() * 7, 0));
      const t = Math.random();
      put.c.setHSL(0.19 + t * 0.07, 0.3 + t * 0.2, 0.15 + t * 0.1, THREE.SRGBColorSpace);
    });
}

// --- marshmerrow: tall pale reeds, waterline only
function buildReeds() {
  const reedMesh = makeInstanced(mergeGeos(
    [0, 1, 2, 3, 4].map(k => {
      const g = new THREE.ConeGeometry(0.07, 1.5 + (k % 2) * 0.5, 3);
      g.rotateZ((k - 2) * 0.13);
      g.translate((k - 2) * 0.13, 0.85, (k % 3 - 1) * 0.11);
      return g;
    })
  ), REEDS, { side: THREE.DoubleSide });
  scene.add(reedMesh);

  fillInstances([reedMesh], REEDS,
    h => h > WATER - 1.2 && h < WATER + 1.4,
    (put, x, y, z) => {
      const sc = 0.7 + Math.random() * 0.8;
      put.p.set(x, y - 0.15, z); put.s.set(sc, sc * (0.8 + Math.random() * 0.6), sc);
      put.q.setFromEuler(new THREE.Euler(0, Math.random() * 7, 0));
      const t = Math.random();
      put.c.setHSL(0.16 + t * 0.06, 0.3 + t * 0.15, 0.28 + t * 0.14, THREE.SRGBColorSpace);
    });
}
