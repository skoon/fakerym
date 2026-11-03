// ---------------------------------------------------------------- seeded rng
// Overriding the global is deliberate: ~40 call sites plus three's own UUIDs all draw from one
// stream, so the same seed replays the same world without threading a generator through everything.
// Same seed => same world only because the call order is fixed; adding a Math.random() call during
// world build shifts every later draw. ?seed=N to reproduce a world, G.seed to read the current one.
//
// This module must be evaluated before anything else draws. `core/config.js` imports it for that
// side effect and every other module imports config, so ESM ordering guarantees it.
export const SEED = Number(new URLSearchParams(location.search).get('seed')) || (Date.now() & 0x7fffffff);

Math.random = (a => () => {
  a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
})(SEED | 0);
