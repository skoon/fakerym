import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

// ---------------------------------------------------------------- world config
// Target: Morrowind (2002), Ascadian Isles. That means Lambert shading, no shadow maps,
// no image-based lighting, hand-painted tiling textures, and a hard fog wall ~140m out.
const WORLD = 900;          // world is WORLD x WORLD units, centered on origin
const SEG   = 384;          // terrain grid resolution
const HMAX  = 78;           // peak height
const WATER = 6.5;          // sea level
const DAY   = 300;          // seconds per full day/night cycle
const VIEW  = 140;          // draw distance the fog is tuned to hide

// ---------------------------------------------------------------- value noise
const hash = (x, y) => { const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return n - Math.floor(n); };
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, oct = 5) {
  let s = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += amp * vnoise(x * f, y * f); f *= 2.03; amp *= 0.5; }
  return s;
}
// ridged noise gives mountain spines instead of blobby hills
function ridge(x, y, oct = 4) {
  let s = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += amp * (1 - Math.abs(vnoise(x * f, y * f) * 2 - 1)); f *= 2.11; amp *= 0.5; }
  return s;
}

function rawHeight(x, z) {
  const nx = x / WORLD, nz = z / WORLD;
  const base   = fbm(nx * 5.5, nz * 5.5, 6) * 1.15 - 0.42;
  const mtn    = Math.pow(Math.max(0, ridge(nx * 3.1 + 40, nz * 3.1 + 40, 5) - 0.35), 1.8) * 2.6;
  const detail = fbm(nx * 34, nz * 34, 3) * 0.055 + fbm(nx * 78, nz * 78, 2) * 0.016;
  // fall off to sea at the map edge so the world reads as an island
  const d = Math.max(Math.abs(nx), Math.abs(nz)) * 2;
  const edge = 1 - Math.pow(Math.min(1, Math.max(0, (d - 0.72) / 0.28)), 1.6);
  return (base + mtn + detail) * HMAX * edge - 4;
}

// ---------------------------------------------------------------- renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
// linear, not filmic — ACES's shoulder desaturates highlights in a way 2002 hardware never did
renderer.toneMapping = THREE.LinearToneMapping;
renderer.toneMappingExposure = 1;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// density chosen so anything at VIEW metres is ~95% fogged out
const FOG_D = Math.sqrt(3) / VIEW;
scene.fog = new THREE.FogExp2(0x9db3a8, FOG_D);

const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.08, 900);
const viewRoot = new THREE.Object3D();          // yaw
const pitchRoot = new THREE.Object3D();         // pitch
viewRoot.add(pitchRoot); pitchRoot.add(camera);
scene.add(viewRoot);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- sky & light
const sky = new Sky();
sky.scale.setScalar(20000);
scene.add(sky);
sky.material.uniforms.turbidity.value = 6;
sky.material.uniforms.rayleigh.value = 2.2;
sky.material.uniforms.mieCoefficient.value = 0.005;
sky.material.uniforms.mieDirectionalG.value = 0.82;

// no shadow maps: Morrowind had none, and dropping them buys back the whole shadow pass
const sun = new THREE.DirectionalLight(0xffffff, 3);
scene.add(sun, sun.target);

// generous sky/ground ambient — with no shadows and no IBL this is what keeps undersides readable
const hemi = new THREE.HemisphereLight(0xbcd2e8, 0x6f6449, 0.6);
scene.add(hemi);

// stars — only visible once the sun drops
const starGeo = new THREE.BufferGeometry();
{
  const n = 2200, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(420);
    v.y = Math.abs(v.y);
    p.set([v.x, v.y, v.z], i * 3);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(p, 3));
}
const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ size: 2.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false }));
scene.add(stars);

const moon = new THREE.Mesh(new THREE.SphereGeometry(18, 24, 16), new THREE.MeshBasicMaterial({ color: 0xdfe6f2, fog: false }));
scene.add(moon);

// ---------------------------------------------------------------- terrain
// The height grid is built first and stood on its own, so the settlement can pick a site and
// level a terrace into it *before* the mesh, colours and normals are generated from it.
const STEP = WORLD / SEG;
const heights = new Float32Array((SEG + 1) * (SEG + 1));
for (let i = 0; i <= SEG; i++) for (let j = 0; j <= SEG; j++) {
  heights[i * (SEG + 1) + j] = rawHeight(-WORLD / 2 + j * STEP, -WORLD / 2 + i * STEP);
}

// bilinear sample of the same grid the mesh uses — collision matches what you see
function heightAt(x, z) {
  const gx = (x + WORLD / 2) / WORLD * SEG, gz = (z + WORLD / 2) / WORLD * SEG;
  const i0 = THREE.MathUtils.clamp(Math.floor(gz), 0, SEG - 1), j0 = THREE.MathUtils.clamp(Math.floor(gx), 0, SEG - 1);
  const fz = gz - i0, fx = gx - j0, w = SEG + 1;
  const h00 = heights[i0 * w + j0], h10 = heights[i0 * w + j0 + 1];
  const h01 = heights[(i0 + 1) * w + j0], h11 = heights[(i0 + 1) * w + j0 + 1];
  return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
}
function slopeAt(x, z) {
  const d = 2.5;
  return Math.max(Math.abs(heightAt(x + d, z) - heightAt(x - d, z)), Math.abs(heightAt(x, z + d) - heightAt(x, z - d))) / (2 * d);
}

// level a disc to one height, feathered at the rim so it reads as a terrace, not a crater
function flattenDisc(cx, cz, r, feather) {
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

const terrainGeo = new THREE.PlaneGeometry(WORLD, WORLD, SEG, SEG);
terrainGeo.rotateX(-Math.PI / 2);
function buildTerrain() {
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
const ground = groundTexture();
ground.repeat.set(360, 360);

const terrain = new THREE.Mesh(terrainGeo, new THREE.MeshLambertMaterial({ vertexColors: true, map: ground }));
scene.add(terrain);

// ---------------------------------------------------------------- water
const waterMat = new THREE.ShaderMaterial({
  transparent: true, fog: true,
  uniforms: {
    uTime: { value: 0 }, uDeep: { value: new THREE.Color(0x14332f) }, uShallow: { value: new THREE.Color(0x3c7a68) },
    uSky: { value: new THREE.Color(0x9db3a8) }, uSun: { value: new THREE.Vector3(0, 1, 0) },
    fogColor: { value: scene.fog.color }, fogDensity: { value: scene.fog.density }
  },
  vertexShader: /* glsl */`
    uniform float uTime;
    varying vec3 vW; varying float vFog;
    void main(){
      vec3 p = position;
      float w = sin(p.x*0.16 + uTime*1.1)*0.22 + sin(p.y*0.21 - uTime*0.8)*0.18 + sin((p.x+p.y)*0.07 + uTime*0.4)*0.3;
      p.z += w;
      vec4 wp = modelMatrix * vec4(p,1.0);
      vW = wp.xyz;
      vec4 mv = viewMatrix * wp;
      vFog = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform float uTime; uniform vec3 uDeep, uShallow, uSky, uSun, fogColor; uniform float fogDensity;
    varying vec3 vW; varying float vFog;
    void main(){
      vec3 V = normalize(cameraPosition - vW);
      // cheap analytic ripple normal
      vec3 N = normalize(vec3(
        sin(vW.x*0.9 + uTime*1.6)*0.09 + sin(vW.z*1.7 - uTime*1.1)*0.06,
        1.0,
        cos(vW.z*0.8 - uTime*1.3)*0.09 + sin(vW.x*1.5 + uTime*0.9)*0.06));
      float fres = pow(1.0 - max(dot(N,V),0.0), 3.0);
      float spec = pow(max(dot(reflect(-normalize(uSun), N), V), 0.0), 70.0);
      vec3 col = mix(uDeep, uShallow, 0.4 + 0.25*sin(vW.x*0.03+vW.z*0.03));
      // flatter than a modern water shader on purpose — 2002 water barely reflected
      col = mix(col, uSky, clamp(fres*0.75,0.0,0.55)) + spec * 0.9;
      float f = 1.0 - exp(-fogDensity*fogDensity*vFog*vFog);
      gl_FragColor = vec4(mix(col, fogColor, f), 0.86);
    }`
});
const water = new THREE.Mesh(new THREE.PlaneGeometry(WORLD * 1.6, WORLD * 1.6, 140, 140), waterMat);
water.rotation.x = -Math.PI / 2;
water.position.y = WATER;
scene.add(water);

// ---------------------------------------------------------------- Hlaalu settlement
// Flat-roofed adobe boxes with parapets, protruding roof beams, wooden balconies and
// external stairs. Exteriors only — the doors are scenery, there are no interior cells.
const VILLAGE_R = 42;
const boxes = [];   // {x,z,yaw,hx,hz} — rotated AABBs the player is pushed out of

// pick the flattest dry site we can find; buildings on a heightmap slope look terrible
const village = (() => {
  let best = null;
  for (let t = 0; t < 4000; t++) {
    const x = (Math.random() - 0.5) * WORLD * 0.6, z = (Math.random() - 0.5) * WORLD * 0.6;
    let worst = 0, minH = 1e9;
    for (let a = 0; a < 8; a++) {
      const ang = a / 8 * Math.PI * 2;
      for (const rr of [VILLAGE_R * 0.45, VILLAGE_R]) {
        const px = x + Math.cos(ang) * rr, pz = z + Math.sin(ang) * rr;
        worst = Math.max(worst, slopeAt(px, pz));
        minH = Math.min(minH, heightAt(px, pz));
      }
    }
    if (minH < WATER + 2.5 || heightAt(x, z) > HMAX * 0.32) continue;
    if (!best || worst < best.worst) best = { x, z, worst };
  }
  return { cx: best.x, cz: best.z, r: VILLAGE_R };
})();

// terrace the site, then generate the mesh from the edited height grid
const VILLAGE_Y = flattenDisc(village.cx, village.cz, VILLAGE_R * 0.82, 30);
buildTerrain();

function inVillage(x, z, pad = 0) {
  return Math.hypot(x - village.cx, z - village.cz) < village.r + pad;
}

const UNIT = new THREE.BoxGeometry(1, 1, 1);
const MAT = {
  stone:  new THREE.MeshLambertMaterial({ color: 0x8b8272, flatShading: true }),
  wood:   new THREE.MeshLambertMaterial({ color: 0x543f26 }),
  window: new THREE.MeshLambertMaterial({ color: 0x241c14 }),  // .emissive is driven by time of day
  lamp:   new THREE.MeshLambertMaterial({ color: 0xa89876 })   // unlit glass shouldn't read as a black ball
};
// same painted noise as the ground, tiled small — reads as weathered plaster on a wall
const stucco = ground.clone();
stucco.needsUpdate = true;
stucco.repeat.set(1, 1);
const ADOBE = [0xc0a87f, 0xb59c74, 0xc7b189, 0xad9569].map(c => new THREE.MeshLambertMaterial({ color: c, map: stucco }));

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

// lay the houses out in two rows facing a street
const street = Math.random() * Math.PI * 2;
const lanterns = [];
{
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

// ---------------------------------------------------------------- scatter: trees, rocks, grass
const obstacles = [];   // {x,z,r} — trees & rocks push the player out

// ponytail: every instance is submitted every frame even though fog hides everything past VIEW.
// ~1.9M tris in 8 draw calls, fine on a modern GPU. If it ever matters, sort instances into a
// coarse grid and set .count per frame from the cells within VIEW of the player.

// three's color_fragment chunk only multiplies vColor when USE_COLOR is defined, i.e. when
// material.vertexColors is true — so instanceColor is silently ignored without both this flag
// and a real (white) color attribute to multiply against.
function instanceColorable(geo) {
  const n = geo.attributes.position.count;
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  return geo;
}

function scatter(count, test, place) {
  let made = 0, tries = 0;
  while (made < count && tries < count * 60) {
    tries++;
    const x = (Math.random() - 0.5) * WORLD * 0.94, z = (Math.random() - 0.5) * WORLD * 0.94;
    const h = heightAt(x, z), s = slopeAt(x, z);
    if (test(h, s, x, z)) { place(x, h, z); made++; }
  }
  return made;
}

// merge to non-indexed and concatenate — every shape here is flat-shaded, so only position matters
function mergeGeos(gs) {
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
function lump(x, y, z, r, flatten) {
  const g = new THREE.IcosahedronGeometry(r, 0);
  g.scale(1, flatten, 0.92);
  g.translate(x, y, z);
  return g;
}

// --- trees: bent trunk under a broad lumpy canopy, not a conifer
const TREES = 3000;
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
const canopyMesh = new THREE.InstancedMesh(instanceColorable(canopyGeo),
  new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, flatShading: true }), TREES);
trunkMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
scene.add(trunkMesh, canopyMesh);
{
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const c = new THREE.Color(); let i = 0;
  scatter(TREES, (h, sl, x, z) => h > WATER + 1.2 && h < HMAX * 0.46 && sl < 0.42 && !inVillage(x, z, 4), (x, y, z) => {
    const sc = 0.75 + Math.random() * 0.85;
    p.set(x, y - 0.3, z); s.set(sc, sc * (0.85 + Math.random() * 0.4), sc);
    q.setFromEuler(new THREE.Euler(0, Math.random() * 7, 0));
    m.compose(p, q, s);
    trunkMesh.setMatrixAt(i, m); canopyMesh.setMatrixAt(i, m);
    const t = Math.random();
    // NB: setHSL defaults to the linear working space — pass sRGB or everything comes out pale
    // sage/olive, never a saturated forest green
    canopyMesh.setColorAt(i, c.setHSL(0.2 + t * 0.06, 0.24 + t * 0.16, 0.2 + t * 0.13, THREE.SRGBColorSpace));
    obstacles.push({ x, z, r: 0.75 * sc });
    i++;
  });
  trunkMesh.count = canopyMesh.count = i;
  trunkMesh.instanceMatrix.needsUpdate = canopyMesh.instanceMatrix.needsUpdate = true;
  if (canopyMesh.instanceColor) canopyMesh.instanceColor.needsUpdate = true;
}

// --- rocks (displaced icosahedra)
const ROCKS = 900;
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
const rockMesh = new THREE.InstancedMesh(instanceColorable(rockGeo),
  new THREE.MeshLambertMaterial({ color: 0x8f8168, vertexColors: true, flatShading: true }), ROCKS);
scene.add(rockMesh);
{
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const c = new THREE.Color(); let i = 0;
  scatter(ROCKS, (h, sl, x, z) => h > WATER - 2 && !inVillage(x, z, 2), (x, y, z) => {
    const sc = 0.5 + Math.pow(Math.random(), 2) * 3.4;
    p.set(x, y + sc * 0.25, z); s.set(sc, sc * (0.6 + Math.random() * 0.5), sc);
    q.setFromEuler(new THREE.Euler(Math.random() * 0.5, Math.random() * 7, Math.random() * 0.5));
    m.compose(p, q, s);
    rockMesh.setMatrixAt(i, m);
    const g = 0.55 + Math.random() * 0.45;
    rockMesh.setColorAt(i, c.setRGB(g, g * 0.97, g * 0.9, THREE.SRGBColorSpace));
    if (sc > 1.4) obstacles.push({ x, z, r: sc * 0.7 });
    i++;
  });
  rockMesh.count = i;
  rockMesh.instanceMatrix.needsUpdate = true;
  if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true;
}

// --- comberry bushes: three squashed lumps, the workhorse shrub of the Ascadian farmland
const BUSHES = 5200;
const bushGeo = instanceColorable(mergeGeos([
  lump(0, 0.42, 0, 0.62, 0.72), lump(0.42, 0.3, 0.18, 0.4, 0.7), lump(-0.3, 0.34, -0.28, 0.45, 0.68)
]));
const bushMesh = new THREE.InstancedMesh(bushGeo,
  new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, flatShading: true }), BUSHES);
scene.add(bushMesh);
{
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const c = new THREE.Color(); let i = 0;
  scatter(BUSHES, (h, sl, x, z) => h > WATER + 0.8 && h < HMAX * 0.44 && sl < 0.45 && !inVillage(x, z, 2), (x, y, z) => {
    const sc = 0.6 + Math.random() * 0.9;
    p.set(x, y, z); s.setScalar(sc);
    q.setFromEuler(new THREE.Euler(0, Math.random() * 7, 0));
    m.compose(p, q, s);
    bushMesh.setMatrixAt(i, m);
    const t = Math.random();
    bushMesh.setColorAt(i, c.setHSL(0.19 + t * 0.07, 0.3 + t * 0.2, 0.15 + t * 0.1, THREE.SRGBColorSpace));
    i++;
  });
  bushMesh.count = i;
  bushMesh.instanceMatrix.needsUpdate = true;
  if (bushMesh.instanceColor) bushMesh.instanceColor.needsUpdate = true;
}

// --- marshmerrow: tall pale reeds, waterline only
const REEDS = 7000;
const reedGeo = instanceColorable(mergeGeos(
  [0, 1, 2, 3, 4].map(k => {
    const g = new THREE.ConeGeometry(0.07, 1.5 + (k % 2) * 0.5, 3);
    g.rotateZ((k - 2) * 0.13);
    g.translate((k - 2) * 0.13, 0.85, (k % 3 - 1) * 0.11);
    return g;
  })
));
const reedMesh = new THREE.InstancedMesh(reedGeo,
  new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, flatShading: true, side: THREE.DoubleSide }), REEDS);
scene.add(reedMesh);
{
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const c = new THREE.Color(); let i = 0;
  scatter(REEDS, h => h > WATER - 1.2 && h < WATER + 1.4, (x, y, z) => {
    const sc = 0.7 + Math.random() * 0.8;
    p.set(x, y - 0.15, z); s.set(sc, sc * (0.8 + Math.random() * 0.6), sc);
    q.setFromEuler(new THREE.Euler(0, Math.random() * 7, 0));
    m.compose(p, q, s);
    reedMesh.setMatrixAt(i, m);
    const t = Math.random();
    reedMesh.setColorAt(i, c.setHSL(0.16 + t * 0.06, 0.3 + t * 0.15, 0.28 + t * 0.14, THREE.SRGBColorSpace));
    i++;
  });
  reedMesh.count = i;
  reedMesh.instanceMatrix.needsUpdate = true;
  if (reedMesh.instanceColor) reedMesh.instanceColor.needsUpdate = true;
}

// --- grass (tapered blades, wind in the vertex shader)
const GRASS = 240000;
const BLADE_H = 0.42;
const bladeGeo = new THREE.BufferGeometry();
{
  const w = 0.045, h = BLADE_H;
  bladeGeo.setAttribute('position', new THREE.Float32BufferAttribute([
    -w, 0, 0, w, 0, 0, w * 0.45, h * 0.6, 0,
    -w, 0, 0, w * 0.45, h * 0.6, 0, -w * 0.45, h * 0.6, 0,
    -w * 0.45, h * 0.6, 0, w * 0.45, h * 0.6, 0, 0, h, 0
  ], 3));
  bladeGeo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(27).fill(0).map((_, i) => i % 3 === 2 ? 1 : 0), 3));
  bladeGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, .6, 0, 0, 1, .6, 0, .6, 0, .6, 1, .6, .5, 1], 2));
}
// The world is 810,000 m² — no fixed instance budget can cover it at readable density.
// So the field is a TILE-sized patch that wraps around the player in the vertex shader,
// sampling terrain height from a data texture. Density stays constant wherever you stand.
const TILE = 200;   // must outrun the fog wall, or you can see the field end
const heightTex = new THREE.DataTexture(heights, SEG + 1, SEG + 1, THREE.RedFormat, THREE.FloatType);
heightTex.minFilter = heightTex.magFilter = THREE.NearestFilter;   // bilinear is done by hand below
heightTex.needsUpdate = true;

const grassGeo = new THREE.InstancedBufferGeometry();
grassGeo.setAttribute('position', bladeGeo.getAttribute('position'));
grassGeo.instanceCount = GRASS;
{
  const ip = new Float32Array(GRASS * 2), irs = new Float32Array(GRASS * 2), ic = new Float32Array(GRASS * 3);
  const c = new THREE.Color();
  for (let i = 0; i < GRASS; i++) {
    ip[i * 2] = Math.random() * TILE; ip[i * 2 + 1] = Math.random() * TILE;
    irs[i * 2] = Math.random() * Math.PI; irs[i * 2 + 1] = 0.65 + Math.random() * 0.75;
    const t = Math.random();
    // keep tufts close to the terrain colour underneath, or they read as black spikes
    c.setHSL(0.16 + t * 0.07, 0.22 + t * 0.16, 0.3 + t * 0.16, THREE.SRGBColorSpace);
    ic.set([c.r, c.g, c.b], i * 3);
  }
  grassGeo.setAttribute('iPos', new THREE.InstancedBufferAttribute(ip, 2));
  grassGeo.setAttribute('iRS', new THREE.InstancedBufferAttribute(irs, 2));
  grassGeo.setAttribute('iCol', new THREE.InstancedBufferAttribute(ic, 3));
}
grassGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

const grassMat = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  uniforms: {
    uHeight: { value: heightTex }, uPlayer: { value: new THREE.Vector3() }, uTime: { value: 0 },
    uTile: { value: TILE }, uWorld: { value: WORLD }, uSeg: { value: SEG },
    uWater: { value: WATER }, uTop: { value: HMAX * 0.44 },
    uVillage: { value: new THREE.Vector3(village.cx, village.cz, village.r) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color(1, 1, 1) },
    uAmb: { value: new THREE.Color(0.3, 0.35, 0.4) },
    fogColor: { value: new THREE.Color() }, fogDensity: { value: 0.002 }
  },
  vertexShader: /* glsl */`
    attribute vec2 iPos; attribute vec2 iRS; attribute vec3 iCol;
    uniform sampler2D uHeight;
    uniform vec3 uPlayer, uVillage;
    uniform float uTime, uTile, uWorld, uSeg, uWater, uTop;
    varying vec3 vCol; varying float vFog, vAO;

    float sampleH(vec2 xz){
      vec2 g = (xz + uWorld * 0.5) / uWorld * uSeg;
      vec2 b = floor(g), f = fract(g);
      float ts = 1.0 / (uSeg + 1.0);
      float h00 = texture2D(uHeight, (b + 0.5) * ts).r;
      float h10 = texture2D(uHeight, (b + vec2(1.0, 0.0) + 0.5) * ts).r;
      float h01 = texture2D(uHeight, (b + vec2(0.0, 1.0) + 0.5) * ts).r;
      float h11 = texture2D(uHeight, (b + vec2(1.0, 1.0) + 0.5) * ts).r;
      return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
    }

    void main(){
      // wrap this blade into the tile centred on the player
      vec2 xz = mod(iPos - uPlayer.xz + uTile * 0.5, uTile) - uTile * 0.5 + uPlayer.xz;
      float h = sampleH(xz);
      float slope = max(abs(sampleH(xz + vec2(2.5, 0.0)) - h), abs(sampleH(xz + vec2(0.0, 2.5)) - h)) / 2.5;

      // no grass in the sea, on cliffs, or above the treeline; fade the tile edge into fog
      float ok = step(uWater + 0.7, h) * step(h, uTop) * (1.0 - smoothstep(0.34, 0.55, slope));
      // trodden bare ground inside the settlement
      ok *= smoothstep(uVillage.z * 0.7, uVillage.z, distance(xz, uVillage.xy));
      float fade = 1.0 - smoothstep(uTile * 0.36, uTile * 0.48, length(xz - uPlayer.xz));
      float sc = iRS.y * ok * fade;

      float bend = position.y / ${BLADE_H};
      vec3 p = vec3(position.x, position.y * sc, position.z);
      float a = iRS.x;
      vec3 rp = vec3(p.x * cos(a) - p.z * sin(a), p.y, p.x * sin(a) + p.z * cos(a));
      float w = sin(uTime * 1.7 + xz.x * 0.35 + xz.y * 0.22) + 0.5 * sin(uTime * 3.1 + xz.x * 0.9);
      rp.x += w * bend * bend * 0.22 * sc;
      rp.z += w * bend * bend * 0.12 * sc;

      vec4 mv = viewMatrix * vec4(vec3(xz.x, h - 0.04, xz.y) + rp, 1.0);
      vAO = bend; vCol = iCol; vFog = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 uSunDir, uSunCol, uAmb, fogColor; uniform float fogDensity;
    varying vec3 vCol; varying float vFog, vAO;
    void main(){
      vec3 c = vCol * (uAmb + uSunCol * (0.35 + 0.65 * max(uSunDir.y, 0.0)));
      c *= 0.62 + 0.38 * vAO;                      // darker at the base = fake AO, reads as depth
      float f = 1.0 - exp(-fogDensity * fogDensity * vFog * vFog);
      gl_FragColor = vec4(mix(c, fogColor, f), 1.0);
    }`
});
const grassMesh = new THREE.Mesh(grassGeo, grassMat);
grassMesh.frustumCulled = false;
scene.add(grassMesh);

// ---------------------------------------------------------------- viewmodel: sword + off hand
const viewmodel = new THREE.Group();
camera.add(viewmodel);
const sword = new THREE.Group();
{
  // Phong, not PBR — a specular highlight is all the metal cue the era had
  const steel = new THREE.MeshPhongMaterial({ color: 0x7d878f, specular: 0xb8c2c8, shininess: 60 });
  const leather = new THREE.MeshLambertMaterial({ color: 0x3a2a1c });
  const brass = new THREE.MeshPhongMaterial({ color: 0x7d6128, specular: 0xc9a24a, shininess: 40 });
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.9, 0.012), steel);
  blade.position.y = 0.55;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.038, 0.14, 4), steel);
  tip.position.y = 1.05; tip.rotation.y = Math.PI / 4;
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.035, 0.045), brass);
  guard.position.y = 0.09;
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.024, 0.19, 8), leather);
  const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.033, 10, 8), brass);
  pommel.position.y = -0.1;
  sword.add(blade, tip, guard, grip, pommel);
}
sword.scale.setScalar(0.5);
sword.position.set(0.3, -0.42, -0.74);
sword.rotation.set(0.32, -0.18, 0.22);
viewmodel.add(sword);

// off-hand flame, lit while casting
const flameLight = new THREE.PointLight(0xff8a2a, 0, 12, 2);
flameLight.position.set(-0.3, -0.26, -0.45);
viewmodel.add(flameLight);
const flameOrb = new THREE.Mesh(
  new THREE.SphereGeometry(0.07, 12, 10),
  new THREE.MeshBasicMaterial({ color: 0xffb257, transparent: true, opacity: 0 })
);
flameOrb.position.copy(flameLight.position);
viewmodel.add(flameOrb);

// ---------------------------------------------------------------- player
const player = {
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
// start on the road just outside the settlement, looking down the street
{
  const a = street + Math.PI;
  const x = village.cx + Math.cos(a) * (VILLAGE_R + 8), z = village.cz + Math.sin(a) * (VILLAGE_R + 8);
  player.pos.set(x, heightAt(x, z) + 2, z);
}
let yaw = 0, pitch = 0, bobT = 0;

// ---------------------------------------------------------------- enemies
const ENEMY_TYPES = [
  { name: 'Mudcrab',   hp: 45,  dmg: 8,  speed: 4.8, xp: 25,  color: 0x6b5540, scale: 0.6, reach: 1.8 },
  { name: 'Nix-Hound', hp: 80,  dmg: 14, speed: 6.4, xp: 45,  color: 0x7a6c52, scale: 0.95, reach: 2.4 },
  { name: 'Kagouti',   hp: 190, dmg: 26, speed: 4.2, xp: 110, color: 0x8a7355, scale: 1.5, reach: 3.0 }
];
const enemies = [];

function makeEnemy(type) {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: type.color, flatShading: true });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.36, 0.9, 4, 10), mat);
  body.position.y = 1.0;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.29, 12, 10), mat);
  head.position.y = 1.82;
  const armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.62, 3, 6), mat);
  armL.position.set(-0.46, 1.15, 0);
  const armR = armL.clone(); armR.position.x = 0.46;
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffdd66 });
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), eyeMat);
  eyeL.position.set(-0.11, 1.86, 0.25);
  const eyeR = eyeL.clone(); eyeR.position.x = 0.11;
  g.add(body, head, armL, armR, eyeL, eyeR);
  g.scale.setScalar(type.scale);
  g.userData.limbs = { armL, armR, body };
  return g;
}

function spawnEnemy(near) {
  const type = ENEMY_TYPES[Math.random() < 0.5 ? 0 : Math.random() < 0.72 ? 1 : 2];
  for (let t = 0; t < 60; t++) {
    const a = Math.random() * Math.PI * 2, d = 55 + Math.random() * 90;
    const x = near.x + Math.cos(a) * d, z = near.z + Math.sin(a) * d;
    if (Math.abs(x) > WORLD * 0.46 || Math.abs(z) > WORLD * 0.46) continue;
    const h = heightAt(x, z);
    if (h < WATER + 1 || slopeAt(x, z) > 0.5) continue;
    const mesh = makeEnemy(type);
    mesh.position.set(x, h, z);
    scene.add(mesh);
    enemies.push({
      type, mesh, hp: type.hp, maxHp: type.hp, state: 'wander',
      dir: Math.random() * Math.PI * 2, timer: 0, atkCd: 0, dead: 0, flash: 0
    });
    return;
  }
}
for (let i = 0; i < 26; i++) spawnEnemy(player.pos);

// ---------------------------------------------------------------- loot
const loot = [];
const coinGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.04, 12);
const coinMat = new THREE.MeshStandardMaterial({ color: 0xd9ad3c, metalness: 1, roughness: 0.28, emissive: 0x3a2a06 });
const potGeo = new THREE.SphereGeometry(0.17, 10, 8);
const potMat = new THREE.MeshStandardMaterial({ color: 0xd4335a, roughness: 0.25, emissive: 0x400a18 });

function dropLoot(pos, richness) {
  const isPot = Math.random() < 0.28;
  const m = new THREE.Mesh(isPot ? potGeo : coinGeo, isPot ? potMat : coinMat);
  m.position.copy(pos).setY(heightAt(pos.x, pos.z) + 0.5);
  scene.add(m);
  loot.push({ mesh: m, kind: isPot ? 'potion' : 'gold', value: isPot ? 1 : 8 + Math.floor(Math.random() * richness) });
}

// ---------------------------------------------------------------- projectiles (flame)
const bolts = [];
const boltGeo = new THREE.SphereGeometry(0.22, 12, 10);
const boltMat = new THREE.MeshBasicMaterial({ color: 0xffa03a, transparent: true });

function castFlame() {
  if (player.mag < 18 || player.castCd > 0) return;
  player.mag -= 18; player.castCd = 0.5;
  const m = new THREE.Mesh(boltGeo, boltMat.clone());
  const light = new THREE.PointLight(0xff7a20, 6, 18, 2);
  m.add(light);
  camera.getWorldPosition(m.position);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  m.position.addScaledVector(dir, 0.7);
  scene.add(m);
  bolts.push({ mesh: m, vel: dir.clone().multiplyScalar(42), life: 3, boom: 0 });
}

// ---------------------------------------------------------------- HUD
const el = {
  hp: document.querySelector('#hp > i'), stam: document.querySelector('#stam > i'), mag: document.querySelector('#mag > i'),
  stats: document.getElementById('stats'), log: document.getElementById('log'),
  compass: document.querySelector('#compass .strip'), menu: document.getElementById('menu'),
  target: document.getElementById('target'), tname: document.querySelector('#target .tname'),
  tbar: document.querySelector('#target .tbar > i'), damage: document.getElementById('damage')
};
{
  const dirs = ['N', '·', 'NE', '·', 'E', '·', 'SE', '·', 'S', '·', 'SW', '·', 'W', '·', 'NW', '·'];
  el.compass.innerHTML = [...dirs, ...dirs, ...dirs].map(d => `<span class="tick">${d}</span>`).join('');
}
function say(msg) {
  const d = document.createElement('div');
  d.textContent = msg;
  el.log.appendChild(d);
  setTimeout(() => d.remove(), 4600);
  while (el.log.children.length > 6) el.log.firstChild.remove();
}
function flashDamage() {
  el.damage.style.opacity = 0.85;
  setTimeout(() => el.damage.style.opacity = 0, 120);
}

// ---------------------------------------------------------------- input
const keys = {};
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'KeyT') timeOfDay += 0.08;
  if (e.code === 'KeyR' && player.potions > 0 && player.hp < player.maxHp) {
    player.potions--; player.hp = Math.min(player.maxHp, player.hp + 45); say('Drank a healing potion.');
  }
});
addEventListener('keyup', e => keys[e.code] = false);

el.menu.addEventListener('click', () => renderer.domElement.requestPointerLock());
renderer.domElement.addEventListener('click', () => {
  if (document.pointerLockElement !== renderer.domElement) renderer.domElement.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  el.menu.classList.toggle('hidden', document.pointerLockElement === renderer.domElement);
});
addEventListener('mousemove', e => {
  if (document.pointerLockElement !== renderer.domElement) return;
  yaw -= e.movementX * 0.0022;
  pitch = THREE.MathUtils.clamp(pitch - e.movementY * 0.0022, -1.5, 1.5);
});
addEventListener('mousedown', e => {
  if (document.pointerLockElement !== renderer.domElement) return;
  if (e.button === 0 && player.attackCd <= 0 && player.stam >= 12) {
    player.swing = 0; player.hitDone = false; player.attackCd = 0.62; player.stam -= 12;
  }
  if (e.button === 2) castFlame();
});
addEventListener('contextmenu', e => e.preventDefault());

// ---------------------------------------------------------------- day/night
let timeOfDay = 0.28;   // 0 = midnight, 0.25 = dawn, 0.5 = noon
const sunDir = new THREE.Vector3();
const dayFog = new THREE.Color(0x9db3a8), duskFog = new THREE.Color(0xc98d5c), nightFog = new THREE.Color(0x101a1c);

function updateSky(dt) {
  timeOfDay = (timeOfDay + dt / DAY) % 1;
  const a = (timeOfDay - 0.25) * Math.PI * 2;
  sunDir.set(Math.cos(a) * 0.55, Math.sin(a), Math.cos(a) * 0.83).normalize();
  sky.material.uniforms.sunPosition.value.copy(sunDir);

  const elev = sunDir.y;                                   // -1 .. 1
  const dayness = THREE.MathUtils.smoothstep(elev, -0.12, 0.22);
  // warm horizon only while the sun is actually near it, else night looks orange
  const duskness = Math.max(0, 1 - Math.abs(elev) / 0.28) * THREE.MathUtils.smoothstep(elev, -0.16, 0.02);

  sun.position.copy(sunDir).multiplyScalar(150).add(player.pos);
  sun.target.position.copy(player.pos);
  sun.intensity = 2.2 * dayness;
  sun.color.setHSL(0.11 - duskness * 0.06, 0.35 * duskness + 0.05, 0.5 + 0.12 * dayness, THREE.SRGBColorSpace);

  hemi.intensity = 0.52 + 0.98 * dayness;
  hemi.color.setHSL(0.6, 0.5, 0.35 + 0.35 * dayness, THREE.SRGBColorSpace);

  const gu = grassMat.uniforms;
  gu.uSunDir.value.copy(sunDir);
  gu.uSunCol.value.copy(sun.color).multiplyScalar(0.4 + 0.9 * dayness);
  gu.uAmb.value.setRGB(0.1 + 0.34 * dayness, 0.12 + 0.38 * dayness, 0.13 + 0.32 * dayness);

  const fog = nightFog.clone().lerp(duskFog, duskness).lerp(dayFog, dayness * (1 - duskness * 0.6));
  scene.fog.color.copy(fog);
  scene.fog.density = FOG_D * (1 + 0.35 * (1 - dayness));
  renderer.toneMappingExposure = 0.37 + 0.66 * dayness;
  sky.material.uniforms.rayleigh.value = 0.9 + 2.4 * duskness;
  sky.material.uniforms.turbidity.value = 11 + 8 * duskness;   // hazy, not a crisp blue dome

  const night = 1 - dayness;
  for (const l of lanterns) l.intensity = night * 9;
  MAT.window.emissive.setRGB(night * 0.95, night * 0.56, night * 0.24);
  MAT.lamp.emissive.setRGB(night, night * 0.62, night * 0.3);

  stars.material.opacity = 1 - dayness;
  stars.position.copy(player.pos);
  stars.rotation.y = timeOfDay * Math.PI * 2;
  moon.position.copy(sunDir).multiplyScalar(-620).add(player.pos);
  moon.visible = sunDir.y < 0.1;

  waterMat.uniforms.uSun.value.copy(sunDir);
  waterMat.uniforms.uSky.value.copy(fog).lerp(new THREE.Color(0x74a6d8), dayness * 0.6);
}

// ---------------------------------------------------------------- movement & collision
const fwd = new THREE.Vector3(), right = new THREE.Vector3(), wish = new THREE.Vector3();

function movePlayer(dt) {
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

  viewRoot.position.copy(player.pos).add(new THREE.Vector3(0, bob, 0));
  viewRoot.rotation.y = yaw;
  pitchRoot.rotation.x = pitch;
  pitchRoot.rotation.z = sway * 0.35;
}

// ---------------------------------------------------------------- combat
const tmp = new THREE.Vector3(), camDir = new THREE.Vector3();

function swordSwing(dt) {
  if (player.attackCd > 0) player.attackCd -= dt;
  if (player.swing >= 0) {
    player.swing += dt / 0.45;
    const t = player.swing;
    if (t >= 1) { player.swing = -1; }
    // wind-up, slash, recover
    const k = t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7;
    sword.rotation.set(0.32 - k * 1.5, -0.18 + k * 1.2, 0.22 - k * 1.9);
    sword.position.set(0.29 - k * 0.34, -0.31 + k * 0.24, -0.5 - k * 0.22);

    if (!player.hitDone && t > 0.32) {
      player.hitDone = true;
      camera.getWorldDirection(camDir);
      for (const e of enemies) {
        if (e.dead) continue;
        tmp.copy(e.mesh.position).setY(e.mesh.position.y + 1.1).sub(player.pos);
        const dist = tmp.length();
        if (dist > 3.0 + e.type.scale) continue;
        if (tmp.normalize().dot(camDir) < 0.55) continue;
        damageEnemy(e, 22 + player.level * 4 + Math.random() * 8);
      }
    }
  } else {
    sword.rotation.set(0.32, -0.18, 0.22);
    sword.position.set(0.29, -0.31, -0.5);
  }
}

function damageEnemy(e, amount) {
  e.hp -= amount;
  e.flash = 0.16;
  e.state = 'chase';
  if (e.hp <= 0) {
    e.dead = 1;
    player.xp += e.type.xp;
    say(`${e.type.name} slain.  +${e.type.xp} xp`);
    dropLoot(e.mesh.position, e.type.xp);
    if (Math.random() < 0.4) dropLoot(e.mesh.position, e.type.xp);
    while (player.xp >= player.xpNext) {
      player.xp -= player.xpNext;
      player.level++;
      player.xpNext = Math.round(player.xpNext * 1.45);
      player.maxHp += 12; player.maxStam += 6; player.maxMag += 8;
      player.hp = player.maxHp; player.mag = player.maxMag;
      say(`— LEVEL ${player.level} —`);
    }
  }
}

function updateEnemies(dt) {
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    const m = e.mesh;

    if (e.dead) {
      e.dead += dt;
      m.rotation.x = Math.min(Math.PI / 2, e.dead * 3.4);
      m.position.y = heightAt(m.position.x, m.position.z) - Math.max(0, e.dead - 2.2) * 1.4;
      if (e.dead > 4) {
        m.traverse(o => { if (o.isMesh) o.material.dispose?.(); });
        scene.remove(m);
        enemies.splice(i, 1);
        spawnEnemy(player.pos);
      }
      continue;
    }

    const toP = tmp.copy(player.pos).sub(m.position);
    const dist = toP.length();

    // cull far enemies to keep the sim cheap, respawn near the player
    if (dist > 260) {
      scene.remove(m); enemies.splice(i, 1); spawnEnemy(player.pos); continue;
    }

    if (e.flash > 0) {
      e.flash = Math.max(0, e.flash - dt);
      m.children[0].material.emissive.setRGB(e.flash * 5, 0, 0);
    }

    e.timer -= dt; e.atkCd -= dt;
    const aggro = e.type === ENEMY_TYPES[2] ? 26 : 34;
    if (dist < aggro && player.hp > 0) e.state = 'chase';
    else if (dist > aggro * 1.8) e.state = 'wander';

    let speed = 0;
    if (e.state === 'chase') {
      m.rotation.y = Math.atan2(toP.x, toP.z);
      if (dist > e.type.reach) speed = e.type.speed;
      else if (e.atkCd <= 0) {
        e.atkCd = 1.35;
        player.hp -= e.type.dmg * (1 - Math.min(0.4, player.level * 0.03));
        flashDamage();
        if (player.hp <= 0) {
          player.hp = player.maxHp; player.stam = player.maxStam; player.mag = player.maxMag;
          player.gold = Math.floor(player.gold * 0.6);
          say('You have died. Somewhere, a hand reaches out — and your purse is lighter.');
          for (let r = 0; r < 2000; r++) {
            const x = (Math.random() - 0.5) * WORLD * 0.5, z = (Math.random() - 0.5) * WORLD * 0.5;
            if (heightAt(x, z) > WATER + 4 && slopeAt(x, z) < 0.2) { player.pos.set(x, heightAt(x, z) + 2, z); break; }
          }
          for (const o of enemies) o.state = 'wander';
        }
      }
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
      // limb swing while moving
      const t = performance.now() * 0.008 * (speed / e.type.speed);
      e.mesh.userData.limbs.armL.rotation.x = Math.sin(t) * 0.8;
      e.mesh.userData.limbs.armR.rotation.x = -Math.sin(t) * 0.8;
      e.mesh.userData.limbs.body.position.y = 1.0 + Math.abs(Math.sin(t)) * 0.06;
    }
    m.position.y = heightAt(m.position.x, m.position.z);
  }
}

function updateBolts(dt) {
  for (let i = bolts.length - 1; i >= 0; i--) {
    const b = bolts[i];
    if (b.boom > 0) {
      b.boom += dt;
      b.mesh.scale.setScalar(1 + b.boom * 16);
      b.mesh.material.opacity = Math.max(0, 1 - b.boom * 3.2);
      b.mesh.children[0].intensity = Math.max(0, 14 - b.boom * 50);
      if (b.boom > 0.35) { scene.remove(b.mesh); bolts.splice(i, 1); }
      continue;
    }
    b.life -= dt;
    b.vel.y -= 6 * dt;
    b.mesh.position.addScaledVector(b.vel, dt);
    b.mesh.children[0].intensity = 6 + Math.sin(performance.now() * 0.02) * 2;

    let boom = b.life <= 0 || b.mesh.position.y < heightAt(b.mesh.position.x, b.mesh.position.z);
    for (const e of enemies) {
      if (e.dead) continue;
      if (b.mesh.position.distanceTo(tmp.copy(e.mesh.position).setY(e.mesh.position.y + 1)) < 1.2 + e.type.scale) { boom = true; break; }
    }
    if (boom) {
      b.boom = 0.001;
      for (const e of enemies) {
        if (e.dead) continue;
        const d = b.mesh.position.distanceTo(tmp.copy(e.mesh.position).setY(e.mesh.position.y + 1));
        if (d < 5.5) damageEnemy(e, (34 + player.level * 5) * (1 - d / 7));
      }
    }
  }
  // off-hand flame glow follows cooldown
  const lit = Math.max(0, player.castCd / 0.5);
  flameLight.intensity = lit * 5;
  flameOrb.material.opacity = lit;
  flameOrb.scale.setScalar(0.7 + lit * 0.9);
}

function updateLoot(dt) {
  for (let i = loot.length - 1; i >= 0; i--) {
    const l = loot[i];
    l.mesh.rotation.y += dt * 2.2;
    l.mesh.position.y = heightAt(l.mesh.position.x, l.mesh.position.z) + 0.5 + Math.sin(performance.now() * 0.003 + i) * 0.08;
    const d = l.mesh.position.distanceTo(player.pos);
    if (d < 2.6 && (keys.KeyE || d < 1.4)) {
      if (l.kind === 'gold') { player.gold += l.value; say(`+${l.value} gold`); }
      else { player.potions++; say('Potion of Healing taken.'); }
      scene.remove(l.mesh); loot.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------- HUD update
let hudT = 0;
function updateHud(dt) {
  el.hp.style.width = (player.hp / player.maxHp * 100) + '%';
  el.stam.style.width = (player.stam / player.maxStam * 100) + '%';
  el.mag.style.width = (player.mag / player.maxMag * 100) + '%';

  const deg = ((-yaw * 180 / Math.PI) % 360 + 360) % 360;
  el.compass.style.transform = `translateX(${210 - deg / 22.5 * 60 - 60 * 8}px)`;

  hudT -= dt;
  if (hudT <= 0) {
    hudT = 0.2;
    const hh = Math.floor(timeOfDay * 24), mm = Math.floor((timeOfDay * 24 % 1) * 60);
    el.stats.innerHTML =
      `Level <b>${player.level}</b> &nbsp; xp <b>${Math.floor(player.xp)}/${player.xpNext}</b><br>` +
      `Gold <b>${player.gold}</b> &nbsp; Potions <b>${player.potions}</b> <span style="opacity:.5">(R)</span><br>` +
      `<span style="opacity:.65">${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} &nbsp; ` +
      `${Math.round(player.pos.x)}, ${Math.round(player.pos.y)}, ${Math.round(player.pos.z)}</span>`;
  }

  // targeted enemy readout
  camera.getWorldDirection(camDir);
  let best = null, bestDot = 0.985;
  for (const e of enemies) {
    if (e.dead) continue;
    tmp.copy(e.mesh.position).setY(e.mesh.position.y + 1.2).sub(player.pos);
    const d = tmp.length();
    if (d > 45) continue;
    const dot = tmp.normalize().dot(camDir);
    if (dot > bestDot) { bestDot = dot; best = e; }
  }
  if (best) {
    el.target.style.opacity = 1;
    el.tname.textContent = best.type.name;
    el.tbar.style.width = (Math.max(0, best.hp) / best.maxHp * 100) + '%';
  } else el.target.style.opacity = 0;
}

// debug hook — lets a headless browser drive the camera/clock for screenshots
globalThis.G = { player, enemies, scene, renderer, canopy: canopyMesh, terrain, sun, village, street, boxes,
  setTime: v => timeOfDay = v, look: (y, p) => { yaw = y; pitch = p; } };

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
let acc = 0;
say('The Ascadian Isles. Saltrice country, and the road to Balmora somewhere north.');

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  acc += dt;

  updateSky(dt);
  movePlayer(dt);
  swordSwing(dt);
  if (player.castCd > 0) player.castCd -= dt;
  updateEnemies(dt);
  updateBolts(dt);
  updateLoot(dt);
  updateHud(dt);

  waterMat.uniforms.uTime.value = acc;
  const gu = grassMat.uniforms;
  gu.uTime.value = acc;
  gu.uPlayer.value.copy(player.pos);
  gu.fogColor.value.copy(scene.fog.color);
  gu.fogDensity.value = scene.fog.density;

  renderer.render(scene, camera);
});
