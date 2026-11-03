import * as THREE from 'three';
import { scene } from '../core/renderer.js';
import { heightAt } from '../world/heightfield.js';
import { keys } from '../ui/input.js';
import { say } from '../ui/hud.js';
import { player } from './player.js';

// ---------------------------------------------------------------- loot
export const loot = [];
let coinGeo, coinMat, potGeo, potMat;

export function initLoot() {
  coinGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.04, 12);
  coinMat = new THREE.MeshStandardMaterial({ color: 0xd9ad3c, metalness: 1, roughness: 0.28, emissive: 0x3a2a06 });
  potGeo = new THREE.SphereGeometry(0.17, 10, 8);
  potMat = new THREE.MeshStandardMaterial({ color: 0xd4335a, roughness: 0.25, emissive: 0x400a18 });
}

export function dropLoot(pos, richness) {
  const isPot = Math.random() < 0.28;
  const m = new THREE.Mesh(isPot ? potGeo : coinGeo, isPot ? potMat : coinMat);
  m.position.copy(pos).setY(heightAt(pos.x, pos.z) + 0.5);
  scene.add(m);
  loot.push({ mesh: m, kind: isPot ? 'potion' : 'gold', value: isPot ? 1 : 8 + Math.floor(Math.random() * richness) });
}

export function updateLoot(dt) {
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
