# Fakerym — remaining work

Ordered by how much each does for "this reads as Morrowind" per unit of effort.
Nothing here is started. See `plan.md` for what already exists.

## Recognition — biggest visual return

- [ ] **Silt strider platform.** The single most recognizable Vvardenfell silhouette. A raised
      wooden dock and the shell itself; static is fine, it does not need to walk.
- [ ] **NPCs on the street.** Even a handful of idle-and-stroll figures changes a village from a
      diorama into a place. Reuse the creature state machine; needs a humanoid mesh and a walk cycle.
- [ ] **A second settlement type.** Redoran (crab-shell domes) or Telvanni (mushroom towers) would
      prove the architecture generator generalizes beyond boxes.
- [ ] **Roads between locations.** Hard part is suppressing grass along an arbitrary path — the
      shader currently only knows about one circular exclusion. A signed-distance list of segments
      passed as a uniform array would cover it.

## Architecture and interiors

- [ ] **Interior cells.** Doors are scenery today. Needs a decision first: separate scene swapped on
      entry (Morrowind-accurate, easy) versus real interior geometry in the same scene (harder,
      allows windows that see out).
- [ ] **Walkable roofs.** Collision is horizontal push-out only, so the external stairs lead nowhere
      and jumping onto a roof falls through. Needs a top-surface height test against `boxes`.
- [ ] **Window frames and recesses.** Currently flat dark rectangles sitting on the wall plane.
- [ ] **A Dwemer ruin.** Self-contained, barely touches the exterior world, and comes with its own
      lighting problem to solve. Good isolated chunk of work.

## Systems

- [ ] **Save/load.** `localStorage` is enough for player state; the world now rebuilds exactly from
      `G.seed`, so a save is that seed plus player state.
- [x] **Seeded RNG.** `Math.random` is replaced in `src/core/rng.js` with mulberry32, so every
      call site and three's own UUIDs draw from one stream. `?seed=N` reproduces a world, `G.seed`
      reads the current one. Verified: same seed gives identical village site, street angle, tree
      instance matrices and enemy spawns; a different seed does not.
- [ ] **Audio.** Footsteps keyed to surface, wind, water, combat, and the day/night ambient bed.
      Nothing exists at all right now.
- [ ] **Inventory and equipment.** There is a gold count and a potion count; no inventory screen, no
      swappable weapons or armour.
- [x] **Contract spine.** `src/game/contracts.js`: notice board, slay/fetch/travel shapes,
      compass waypoint, tier escalation, pay at the board. Verified end to end.
- [ ] **Dialogue and NPCs to talk to.** The board is a prop, not a person; nobody speaks.
- [ ] **Cliff racers.** Flying enemies need vertical pathing, which the current ground-clamped AI
      cannot express. Also: iconic.

## Performance and correctness

- [ ] **Per-instance culling.** ~1.9M triangles submitted every frame with fog hiding most of it.
      Sort instances into a coarse grid, set `.count` per frame from cells within `VIEW`. The
      `ponytail:` comment in `src/world/flora.js` names this.
- [ ] **Measure actual frame time on a real GPU.** Every performance statement so far is inference —
      the only renderer this has run on is SwiftShader, which tells us nothing about real throughput.
- [ ] **Grass tile popping check.** The wrap is continuous in theory; worth confirming at speed
      while sprinting downhill that no blade visibly jumps.
- [ ] **Enemy/terrain interpenetration.** Creatures are clamped to terrain height with no obstacle
      collision at all — they walk through trees and buildings.
- [ ] **Night readability.** Brightened once already. Still worth a pass with fresh eyes on whether
      it is atmospheric or merely dark.
