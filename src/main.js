import * as THREE from 'three';
import { SEED } from './core/rng.js';
import { renderer, scene, camera } from './core/renderer.js';

import { buildHeightfield } from './world/heightfield.js';
import { buildTerrain, paintTerrain, terrain } from './world/terrain.js';
import { buildSky, updateDayNight, getTime, setTime, addTime, sun } from './world/daynight.js';
import { buildWater, setWaterTime, applyDayNight as waterLight } from './world/water.js';
import { planVillage, buildVillage, boxes, street, applyDayNight as villageLight } from './world/village.js';
import { buildFlora, canopyMesh } from './world/flora.js';
import { buildGrass, syncGrass, applyDayNight as grassLight } from './world/grass.js';

import { player, spawnPlayer, movePlayer, drinkPotion } from './game/player.js';
import { enemies, populateEnemies, updateEnemies, pickTarget, ENEMY_TYPES, loadCreatureModels } from './game/enemies.js';
import { initContracts, updateContracts, interact as useBoard, waypointOf, contractView } from './game/contracts.js';
import { buildViewmodel, startSwing, swordSwing, castFlame, initBolts, updateBolts } from './game/combat.js';
import { initLoot, updateLoot } from './game/loot.js';

import { initHud, updateHud, say } from './ui/hud.js';
import { initInput, look } from './ui/input.js';

// ---------------------------------------------------------------- world build
// This sequence IS the seeded-world contract. Every three.js object carries a UUID drawn from the
// same Math.random stream the world generator uses, so reordering these calls — or slipping a new
// one in between — changes the world for every existing seed. Add new build steps at the end.
buildSky();
buildHeightfield();
buildTerrain();                    // geometry, ground texture and material only
buildWater();
const village = planVillage();     // picks a site and terraces the height grid
paintTerrain();                    // ...so the mesh is generated from the *edited* grid
await buildVillage();               // kit models are GLBs, so this is the one async build step
buildFlora();
buildGrass(village);
buildViewmodel();
spawnPlayer(village);
// The creature bodies are GLBs. Parsing them draws THREE object UUIDs too, so it happens here in the
// build sequence rather than racing the spawn loop from inside enemies.js.
await loadCreatureModels();
populateEnemies(player.pos, 26);
initLoot();
initBolts();
initContracts(village, {
  street,
  typeNames: ENEMY_TYPES.map(t => t.name),
  locateEnemy: name => {
    let best = null, bestD = Infinity;
    for (const e of enemies) {
      if (e.dead || e.type.name !== name) continue;
      const d = e.mesh.position.distanceToSquared(player.pos);
      if (d < bestD) { bestD = d; best = e.mesh.position; }
    }
    return best;
  }
});

initHud();
initInput({
  attack: startSwing,
  cast: castFlame,
  drink: drinkPotion,
  passTime: () => addTime(0.08),
  interact: useBoard
});

// debug hook — lets a headless browser drive the camera/clock for screenshots
globalThis.G = { seed: SEED, player, enemies, scene, renderer, canopy: canopyMesh, terrain, sun, village, street, boxes,
  setTime: v => setTime(v), look: (y, p) => { look.yaw = y; look.pitch = p; } };

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
const camDir = new THREE.Vector3();

let acc = 0;
say('The Ascadian Isles. Saltrice country, and the road to Balmora somewhere north.');

// The simulation only runs while the pointer is captured: before the player clicks in, and again
// whenever they press Esc, the world is a still frame — no clock, no aggro, no HP loss.
const isPlaying = () => document.pointerLockElement === renderer.domElement;

renderer.setAnimationLoop(() => {
  // always pull the delta, so time spent paused is not applied as one huge step on resume
  const dt = Math.min(clock.getDelta(), 0.05);
  const playing = isPlaying();

  if (playing) {
    acc += dt;

    const light = updateDayNight(dt, player.pos);
    grassLight(light);
    villageLight(light);
    waterLight(light);

    movePlayer(dt);
    swordSwing(dt);
    if (player.castCd > 0) player.castCd -= dt;
    updateEnemies(dt);
    updateBolts(dt);
    updateLoot(dt);
    updateContracts(dt);
    setWaterTime(acc);
    syncGrass(acc, player.pos, scene.fog);
  }

  // the HUD still describes the frame in front of the player, frozen or not
  camera.getWorldDirection(camDir);
  updateHud(dt, { player, target: pickTarget(player.pos, camDir), yaw: look.yaw, timeOfDay: getTime(),
    contract: contractView(), waypoint: waypointOf() });

  renderer.render(scene, camera);
});
