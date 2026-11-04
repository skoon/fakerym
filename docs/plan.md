# Fakerym — what exists so far

A first-person open-world RPG in Three.js, art-targeted at **Morrowind (2002), Ascadian Isles**.

## Why Morrowind and not Skyrim

The project started aimed at Skyrim/Oblivion. That target is not reachable in a browser — it
represents roughly a hundred developer-years and tens of gigabytes of authored assets on a native
engine, so no amount of iteration closes the gap and a "is it AAA yet" loop has no exit condition.

Morrowind is a different proposition. It is Xbox-era: characters of 300–1000 triangles, 256×256
hand-painted textures, no normal maps, no PBR, no real-time shadows, and a famously short draw
distance hidden behind fog. Those are all things WebGL does comfortably. Losing a blind side-by-side
against Morrowind is a bug to fix, not a law of physics — which makes it a target worth aiming at.

The pivot **removed** more than it added: PMREM image-based lighting, PCF soft shadow maps, all
`MeshStandardMaterial` PBR, ACES filmic tone mapping, and a 4000-unit draw distance all went away.

## Layout

| File | Purpose |
|---|---|
| `index.html` | Canvas, HUD markup and CSS, import map, title screen. 84 lines. |
| `src/main.js` | World build order, debug hook, frame loop. |
| `src/core/` | `rng` (seeded Math.random), `config` (world constants), `noise`, `renderer` (renderer/scene/camera), `geometry` (instancing helpers), `shaders` (fog GLSL shared by water and grass). |
| `src/world/` | `heightfield` (grid, sampling, placement), `terrain`, `daynight` (sky/sun/fog), `water`, `village`, `flora`, `grass`. |
| `src/game/` | `player` (state, movement, collision), `enemies`, `combat` (viewmodel, sword, flame bolts), `loot`. |
| `src/ui/` | `hud`, `input`. |

`src/main.js` owns the build sequence, and that sequence is load-bearing — see *Systems → Terrain*
and *Known ceilings* below. World modules export `build*()` functions rather than running at import
time so the order is stated in one place instead of being implied by import order.

No build step and no dependencies to install. `three@0.170.0` is pulled from jsdelivr via an import
map. **It must be served over HTTP** — ES modules do not load from `file://`:

```
cd /mnt/d/source/fakerym && python3 -m http.server 8123
```

## World constants

```
WORLD 900   world is 900×900 units, centred on the origin
SEG   384   terrain grid resolution (385² height samples)
HMAX  78    peak height          WATER 6.5   sea level
DAY   300   seconds per full day/night cycle
VIEW  140   draw distance; FOG_D = √3 / VIEW puts ~95% fog at that range
```

## Systems

### Terrain
Value-noise fbm for the base, ridged noise for mountain spines, two detail octaves, and an edge
falloff that drops the rim into the sea so the map reads as an island.

The pipeline is ordered deliberately: **the height grid is generated first and stands on its own**,
then the settlement picks a site and levels a terrace into that grid, and only then are the mesh
positions, normals and vertex colours generated from it. `heightAt` (bilinear) and `slopeAt` read
the same grid, so collision, grass placement and building placement all agree with what is drawn,
including inside the terrace.

Vertex colours blend shore / sage meadow / dry patches / adobe dirt on slopes / pale stone at
altitude, modulated by a low-frequency patch noise. Over that sits a 256px procedural "hand-painted"
ground texture — clumps, speckle and pebble highlights — tiled 360×, meant to be seen repeating.

### Grass
810,000 m² cannot be covered by any fixed instance budget, so the field is a 200 m tile of 240,000
blades that **wraps around the player in the vertex shader**. Density is constant wherever you
stand. Terrain height comes from a `DataTexture` of the height grid, sampled with hand-written
bilinear filtering (four `texture2D` taps at `NearestFilter`, because float textures are not
linearly filterable). The shader rejects blades below the waterline, above the treeline, on slopes
steeper than ~0.34, and inside the settlement radius — the last of which gives trodden bare ground
for free. Wind is a two-frequency sine on a squared bend factor; a vertical gradient fakes ambient
occlusion at the base. The tile is deliberately wider than the fog wall so its edge is never visible.

### Flora and scatter
3,000 trees (bent tapered trunk under four flat lumpy canopy blobs — broadleaf, not conifer),
900 displaced-icosahedron rocks, 5,200 comberry bushes, 7,000 marshmerrow reeds pinned to the
waterline. All instanced, all excluded from the settlement footprint. Trees and larger rocks push
cylinders into the `obstacles` array for collision.

### Settlement
A medieval stone village of ten houses in two rows facing a street on a random axis. Each house is
assembled from the Retro Fantasy Kit on its 1 unit module grid and scaled so one module is a 3 m
storey: two storeys of brick wall modules with timber courses, a door module facing the street,
window modules on the flanks and above, and a slate roof. Front walls sit on a fixed line and the
depth grows away from it, so houses of different sizes keep a straight facade.

Rooflines cycle through five plans, because the kit forces the shape of the problem: its roof pieces
are complete 1 module gables (ridge along local z), so a house wider than one module *cannot* have a
single ridge and is always a run of gables. What the kit does allow is orientation and pitch —
stepped gable ends turned to the street, shallow half-height gables with the ridges running along the
street, roofs hipped at the alley ends with the kit's `roof-edge` tapers, a corner tower rising
through the roof under a `tower-top` cap, and a flat `floor` slab ringed with `battlement`s.

Every house stands on a 0.6 m grey plinth rather than sinking into the terrain, which puts the floor at
the top of its stoop. The stoop is the kit's `floor-steps`: that piece is a wedge whose high edge is
on its local +z, so it is turned to face the street and pushed back until that edge is flush with the
front wall — the ramp then descends to the ground and the sill meets the top step.

Street furniture is kit geometry too — barrels, crates, a barrel rack, brick piles and ladders against
the front walls, and `fence-wood` runs behind both rows — all placed at the ground line rather than at
the raised floor. Every house's props sit in its own module space, so they follow the front wall and
the street angle.
Nothing decorative draws from the seeded `Math.random` stream — variation comes from a hash of the
house index, so decoration cannot shift the trees, rocks or spawn points.

The kit paints bricks, stone, timber roof and details on separate textures, so geometry is merged
per material across the whole town: several hundred pieces of kit become about eight meshes rather
than as many draw calls. The site search and terracing are unchanged.

Wall collision is rotated-AABB push-out, and each box is the house's own footprint plus 2 cm — the
walls are flush with the module grid, so a larger margin reads as an invisible wall you stop short of.

The site is chosen by sampling slope and height on two rings and keeping the flattest dry candidate,
then `flattenDisc` levels it with a feathered rim. Wall collision is rotated-AABB push-out: transform
the player into box space, clamp to the nearest face, transform back.

Three street lanterns stand on kit `column-wood` posts, each with a `PointLight` and a small emissive
head whose intensity ramps with the day/night cycle, so the street lights up after dark. Walls and
windows do not glow; only the lamp heads do.

### Lighting and sky
One directional light plus one hemisphere light, Lambert shading throughout, linear tone mapping.
No shadow maps and no IBL — both era-correct and considerably cheaper. The sky is three's `Sky`
shader with turbidity pushed up for haze; sun elevation drives light colour and intensity, fog
colour and density, exposure, star opacity and the moon. Warm horizon tint is gated on the sun
actually being near the horizon, or night renders orange.

### Gameplay
First-person controller with damped acceleration, sprint on stamina, jump, swimming, head bob and
sway, cylinder and box collision. Melee is a swing animation with a cone hit test; the flame spell
is a gravity-affected bolt with a 5.5 m splash. The three creature bodies are skinned voxel models
from the Monsters kit (`src/models/`): MON-032 cave crab, MON-037 thorn hound, MON-036 boulder
beast, scaled to a per-type height so `aim` heights and the cone hit tests still line up. Each rig
is a `SkeletonUtils` clone with its own material clones and its own `AnimationMixer`, and behaviour
picks a clip (`Idle` / `Walk` / `Run` / `Attack01` / `Death`) rather than posing limbs by hand.
Three creature types (Mudcrab, Nix-Hound, Kagouti)
wander, wake, size you up with a threat display, chase as far as a leash around their home, retreat
and attack, culling and respawning around the player. Temperament is data on `ENEMY_TYPES`: the
mudcrab is territorial (notices you at 7 m, never follows you more than 14 m from its home), the
nix-hound spawns in pairs and harries you in circles, the kagouti telegraphs a crouch and follows
you 120 m. Loot, gold, potions, XP
and levelling (`xpNext × 1.45` per level, +12 max HP). HUD has health/stamina/magicka bars, a
compass strip, a target readout and a message log.

`src/game/contracts.js` is the content layer: a notice board on the village street offers one
contract at a time, cycling slay / fetch / travel and escalating each tier. Progress comes from
real events — the enemy death path calls `contractKilled`, the fetch item is a real object at a
real heightfield spot, travel resolves a named landmark from the terrain. Payout generates the
next contract. One owner of all contract state; there is no save, so it resets on reload.

## Verification

There is no browser in this environment, so headless Chromium (plus one locally extracted
`libasound2`) renders the game under SwiftShader via `playwright-core`, driven by a `globalThis.G`
debug hook that exposes the player, the clock and the camera angles. Every visual claim in this
document came from a screenshot, not from reading the code.

Three real bugs were caught that way and are worth remembering:

1. **`instanceColor` is silently ignored** unless the material has `vertexColors: true` *and* the
   geometry carries a `color` attribute. three's `color_fragment` chunk only multiplies `vColor`
   under `USE_COLOR`, which is defined from `material.vertexColors` — `USE_INSTANCING_COLOR` alone
   sets the varying in the vertex shader and nothing reads it. Every per-tree and per-rock colour
   was being discarded. `instanceColorable()` adds the white attribute this requires.
2. **`setHSL` and `setRGB` default to the linear working space**, not sRGB. Every hand-picked
   colour was rendering far brighter than intended, which read as a washed-out scene. Pass
   `THREE.SRGBColorSpace` explicitly. `setHex` does convert, which is why literals looked right and
   HSL did not.
3. **Metal renders black without an environment map.** Fixed at the time with PMREM; moot now, since
   the Morrowind pivot dropped PBR entirely and the sword is Phong.

## Known ceilings

- Creature bodies are the kit's voxel models at 700–2,500 triangles each, and the kit has no
  dedicated threat-display clip, so the `alert` pose is the idle held slowed down and reared back.
- Villager models are downloaded but unused: villagers need an NPC system that does not exist.
- No per-instance culling. Everything is submitted every frame even though fog hides it past 140 m —
  ~1.9M triangles in 8 draw calls. Fine on a modern GPU, wasteful. Marked with a `ponytail:` comment
  in `src/world/flora.js` naming the upgrade path.
- Roofs are not walkable; collision is horizontal push-out only.
- No interiors — doors are scenery.
- One settlement in the world.
- No persistence; no audio.
- Seeding works by replacing the global `Math.random`, so it holds only while world build order is
  fixed — adding a `Math.random()` call mid-build shifts every later draw and changes the world for
  a given seed. Three's own object UUIDs draw from the same stream, so *constructing* a THREE object
  out of order counts too: that is why `src/core/renderer.js` is the only module that builds
  anything at import time, and why the sequence in `src/main.js` must be appended to, not reordered.
  Fine for reproducing a bug, not a stable world ID across versions.
