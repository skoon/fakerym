// ---------------------------------------------------------------- HUD
// Deliberately a leaf: it imports nothing from game/ or world/ and is handed the state it draws.
// That is what keeps enemies.js free to import say()/flashDamage() without a cycle.
const el = {};
let hudT = 0;
// half the compass's on-screen width: the strip is centred on it and the marker is offset from it,
// so both follow the element when the window narrows instead of assuming a 420px strip
let compassHalfW = 210;

function measureCompass() {
  if (el.compassBox) compassHalfW = (el.compassBox.clientWidth || 420) / 2;
}

export function initHud() {
  el.hp = document.querySelector('#hp > i');
  el.stam = document.querySelector('#stam > i');
  el.mag = document.querySelector('#mag > i');
  el.stats = document.getElementById('stats');
  el.log = document.getElementById('log');
  el.compass = document.querySelector('#compass .strip');
  el.compassBox = document.getElementById('compass');
  el.menu = document.getElementById('menu');
  el.target = document.getElementById('target');
  el.tname = document.querySelector('#target .tname');
  el.tbar = document.querySelector('#target .tbar > i');
  el.damage = document.getElementById('damage');
  el.obj = document.getElementById('objective');
  el.olabel = document.querySelector('#objective .olabel');
  el.otitle = document.querySelector('#objective .otitle');
  el.oline = document.querySelector('#objective .oline');
  el.ohint = document.querySelector('#objective .ohint');
  el.wp = document.querySelector('#compass .wp');

  const dirs = ['N', '·', 'NE', '·', 'E', '·', 'SE', '·', 'S', '·', 'SW', '·', 'W', '·', 'NW', '·'];
  el.compass.innerHTML = [...dirs, ...dirs, ...dirs].map(d => `<span class="tick">${d}</span>`).join('');

  measureCompass();
  addEventListener('resize', measureCompass);
}

export function say(msg) {
  const d = document.createElement('div');
  d.textContent = msg;
  el.log.appendChild(d);
  setTimeout(() => d.remove(), 4600);
  while (el.log.children.length > 6) el.log.firstChild.remove();
}

export function flashDamage() {
  el.damage.style.opacity = 0.85;
  setTimeout(() => el.damage.style.opacity = 0, 120);
}

export const menuEl = () => el.menu;

export function updateHud(dt, { player, target, yaw, timeOfDay, contract, waypoint }) {
  el.hp.style.width = (player.hp / player.maxHp * 100) + '%';
  el.stam.style.width = (player.stam / player.maxStam * 100) + '%';
  el.mag.style.width = (player.mag / player.maxMag * 100) + '%';

  // One tick is 60px = 22.5°. The strip is positioned so the middle block's N sits under the
  // compass centre at due north, and a marker n ticks clockwise lands at centre + n * 60 — the
  // same mapping, at whatever width the strip happens to be.
  const deg = ((-yaw * 180 / Math.PI) % 360 + 360) % 360;
  el.compass.style.transform = `translateX(${compassHalfW - 990 - deg / 22.5 * 60}px)`;

  if (waypoint) {
    // bearing to the objective in the same units as the strip: yaw 0 faces -Z, which is north
    const dx = waypoint.x - player.pos.x, dz = waypoint.z - player.pos.z;
    const bearing = ((-Math.atan2(-dx, -dz) * 180 / Math.PI) % 360 + 360) % 360;
    const delta = ((bearing - deg + 540) % 360) - 180;
    el.wp.style.display = 'block';
    el.wp.style.left = (compassHalfW + delta / 22.5 * 60) + 'px';
    el.wp.style.opacity = Math.abs(delta) > 62 ? '0.18' : '1';
  } else el.wp.style.display = 'none';

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

  if (contract) {
    el.obj.style.display = 'block';
    el.olabel.textContent = contract.label;
    el.otitle.textContent = contract.title;
    el.oline.textContent = contract.line;
    el.ohint.textContent = contract.prompt ? `[E]  ${contract.prompt}` : '';
  } else el.obj.style.display = 'none';

  // targeted enemy readout
  if (target) {
    el.target.style.opacity = 1;
    el.tname.textContent = target.type.name;
    el.tbar.style.width = (Math.max(0, target.hp) / target.maxHp * 100) + '%';
  } else el.target.style.opacity = 0;
}
