import * as THREE from 'three';

// ---------------------------------------------------------------- geometry helpers
// three's color_fragment chunk only multiplies vColor when USE_COLOR is defined, i.e. when
// material.vertexColors is true — so instanceColor is silently ignored without both this flag
// and a real (white) color attribute to multiply against.
export function instanceColorable(geo) {
  const n = geo.attributes.position.count;
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  return geo;
}

// merge to non-indexed and concatenate — every shape here is flat-shaded, so only position matters
export function mergeGeos(gs) {
  const flat = gs.map(g => g.index ? g.toNonIndexed() : g);
  const total = flat.reduce((n, g) => n + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3);
  let off = 0;
  for (const g of flat) {
    pos.set(g.attributes.position.array, off * 3);
    nor.set(g.attributes.normal.array, off * 3);
    off += g.attributes.position.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return m;
}

// a low-poly blob — detail 0 keeps each one at 20 faces, which is the era-correct budget
export function lump(x, y, z, r, flatten) {
  const g = new THREE.IcosahedronGeometry(r, 0);
  g.scale(1, flatten, 0.92);
  g.translate(x, y, z);
  return g;
}

// the per-instance-colour flat-shaded mesh every scatter type wants
export function makeInstanced(geo, count, params = {}) {
  return new THREE.InstancedMesh(
    instanceColorable(geo),
    new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, flatShading: true, ...params }),
    count
  );
}
