import * as THREE from 'three';
import { WORLD, SEG, HMAX, WATER } from '../core/config.js';
import { fbm } from '../core/noise.js';
import { renderer, scene } from '../core/renderer.js';
import { heights } from './heightfield.js';

export let terrainGeo = null, terrain = null, ground = null;

// A 256px hand-painted tiling texture, the way a 2002 artist would have made it: high
// contrast clumps and speckle, no normal map, meant to be seen repeating.
function groundTexture(size = 256) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const x = i % size, y = (i / size) | 0;
    // two octaves at tile-wrapping frequencies + speckle = painted dirt
    const clump = fbm(x * 0.055, y * 0.055, 3);
    const fine  = fbm(x * 0.31, y * 0.31, 2);
    let v = 130 + clump * 190 + fine * 60 + Math.random() * 34;
    if (fine > 0.62) v += 38;                       // pebble highlights
    img.data[i * 4] = v * 1.04; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v * 0.9;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

// Geometry, texture and material only. The vertex data is deliberately *not* filled here —
// paintTerrain() runs after the settlement has terraced the height grid.
export function buildTerrain() {
  terrainGeo = new THREE.PlaneGeometry(WORLD, WORLD, SEG, SEG);
  terrainGeo.rotateX(-Math.PI / 2);
  ground = groundTexture();
  ground.repeat.set(360, 360);
  terrain = new THREE.Mesh(terrainGeo, new THREE.MeshLambertMaterial({ vertexColors: true, map: ground }));
  scene.add(terrain);
}

export function paintTerrain() {
  const pos = terrainGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, heights[i]);
  pos.needsUpdate = true;
  terrainGeo.computeVertexNormals();

  // vertex colours: shore / meadow / dirt slopes / pale stone, blended by height + slope
  const col = new Float32Array(pos.count * 3);
  const nrm = terrainGeo.attributes.normal;
  // Ascadian Isles: sage grass on the flats, warm adobe dirt on slopes, pale stone up top
  const sand = new THREE.Color(0xb0a075), grass = new THREE.Color(0x59683c),
        dry  = new THREE.Color(0x8a8351), rock  = new THREE.Color(0x8a7a63),
        stone = new THREE.Color(0xa39a86), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const h = pos.getY(i), slope = 1 - nrm.getY(i);
    const x = pos.getX(i), z = pos.getZ(i);
    const patch = fbm(x * 0.02, z * 0.02, 3);
    c.copy(grass).lerp(dry, THREE.MathUtils.clamp(patch * 1.5 - 0.3, 0, 1));
    c.lerp(sand, THREE.MathUtils.clamp((WATER + 2.5 - h) / 4, 0, 1));
    c.lerp(rock, THREE.MathUtils.clamp((slope - 0.16) / 0.28, 0, 1));
    c.lerp(stone, THREE.MathUtils.clamp((h - HMAX * 0.5) / 20, 0, 1));
    c.multiplyScalar(0.88 + fbm(x * 0.35, z * 0.35, 2) * 0.3);
    col.set([c.r, c.g, c.b], i * 3);
  }
  terrainGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}
