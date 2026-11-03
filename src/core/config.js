import './rng.js';   // side effect only: installs the seeded Math.random before anything can draw

// ---------------------------------------------------------------- world config
// Target: Morrowind (2002), Ascadian Isles. That means Lambert shading, no shadow maps,
// no image-based lighting, hand-painted tiling textures, and a hard fog wall ~140m out.
export const WORLD = 900;          // world is WORLD x WORLD units, centered on origin
export const SEG   = 384;          // terrain grid resolution
export const HMAX  = 78;           // peak height
export const WATER = 6.5;          // sea level
export const DAY   = 300;          // seconds per full day/night cycle
export const VIEW  = 140;          // draw distance the fog is tuned to hide

export const STEP  = WORLD / SEG;            // spacing between height samples
export const FOG_D = Math.sqrt(3) / VIEW;    // density puts anything at VIEW metres ~95% fogged out
export const TILE  = 200;                    // grass tile; must outrun the fog wall or you see it end
