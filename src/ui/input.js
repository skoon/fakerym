import * as THREE from 'three';
import { renderer } from '../core/renderer.js';
import { menuEl } from './hud.js';

// ---------------------------------------------------------------- input
export const keys = {};
export const look = { yaw: 0, pitch: 0 };

// Actions are injected rather than imported so this module stays free of game state:
// { attack, cast, drink, passTime, interact }.
export function initInput(actions) {
  const menu = menuEl();

  addEventListener('keydown', e => {
    keys[e.code] = true;
    if (e.code === 'KeyT') actions.passTime();
    if (e.code === 'KeyR') actions.drink();
    if (e.code === 'KeyE') actions.interact?.();
  });
  addEventListener('keyup', e => keys[e.code] = false);

  // The simulation is paused until the pointer is captured, so a refused capture would otherwise
  // look like a dead button. Say so instead of leaving the player clicking at nothing.
  const hint = document.querySelector('#menu .hint');
  const begin = () => {
    const p = renderer.domElement.requestPointerLock();
    if (p && p.catch) p.catch(() => { if (hint) hint.textContent = 'Mouse capture was refused — click again, or allow pointer lock for this page.'; });
  };
  menu.addEventListener('click', begin);
  renderer.domElement.addEventListener('click', () => {
    if (document.pointerLockElement !== renderer.domElement) renderer.domElement.requestPointerLock();
  });
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === renderer.domElement;
    menu.classList.toggle('hidden', locked);
    if (locked && hint) hint.textContent = '';
  });
  addEventListener('mousemove', e => {
    if (document.pointerLockElement !== renderer.domElement) return;
    look.yaw -= e.movementX * 0.0022;
    look.pitch = THREE.MathUtils.clamp(look.pitch - e.movementY * 0.0022, -1.5, 1.5);
  });
  addEventListener('mousedown', e => {
    if (document.pointerLockElement !== renderer.domElement) return;
    if (e.button === 0) actions.attack();
    if (e.button === 2) actions.cast();
  });
  addEventListener('contextmenu', e => e.preventDefault());
}
