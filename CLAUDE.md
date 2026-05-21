# CLAUDE.md — Session notes for Aphelion Star Fighter

This file records context for future Claude (or human) sessions: what
the project is, where things live, and what's been changed recently.
**When you make non-trivial changes in a session, append a new entry to
the Changelog at the bottom so the next session can pick up the
narrative.**

---

## Project at a glance

- **Aphelion Star Fighter** — 2D canvas space combat. The repo plans
  to ship to iOS/Android via Capacitor.
- **Stack**: Vite + vanilla JS (ES modules) + Capacitor. No
  TypeScript, no framework. Rendering is plain `CanvasRenderingContext2D`.
- **Entry points**:
  - `index.html` → loads `src/main.js`.
  - `src/main.js` — sets up canvas, fixed-timestep loop, draw order.
  - `src/game.js` — match lifecycle, damage rules, per-tick update.
- **Tooling**:
  - `npm run dev` — Vite dev server.
  - `npm run build` — production build → `dist/`.
  - `npm run cap:sync` — build + sync to native platforms.

## Module layout (`src/`)

| File | Role |
|---|---|
| `main.js` | RAF loop, canvas/camera, draw order. |
| `game.js` | `createGame`/`startGame`/`update`/`restart`, damage resolution, score, match-end logic. |
| `ship.js` | `createShip`, `updateShip` (movement + weapons), `drawShip`. Hull polygons + visual extras live here. |
| `ai.js` | Per-ship AI: target selection, throttle, fire decisions. |
| `projectile.js` | Cannon + missile entities, including homing missile logic. |
| `wreckage.js` | Persistent map litter — destroyed-ship hulks + impact debris. |
| `arena.js` | Arena bounds + starfield + map size presets. |
| `classes.js` | Base per-class ship specs + `SIDES` color palette. |
| `races.js` | Per-race overrides + rosters. `resolveSpec(race, klass)` deep-merges. |
| `input.js` | Touch/mouse/keyboard input, on-screen joysticks, start menu, hangar entry. |
| `hud.js` | In-game HUD (minimap, score, beams). |
| `audio.js` | Web Audio synth + event subscribers. |
| `events.js` | Tiny pub/sub bus shared across the game. |
| `save.js` | Versioned localStorage SaveStore (schema-migrated). |
| `cosmetics.js`, `hangar.js`, `progression.js` | Meta-progression + cosmetics. |
| `modes/{arena,waves,daily}.js` | Mode hooks: `setup`, `tick`, `checkEnd`. |
| `modes/index.js` | Mode registry. |
| `types.js` | JSDoc typedefs (no runtime exports). |
| `vec.js` | Tiny 2D vector helpers. |

## Key conventions

- **No framework.** Plain ES modules, exported functions, no classes
  unless there's clear lifecycle (e.g. `SaveStore`, `EventBus`,
  `StartMenu`, `InputManager`).
- **Comments**: the codebase favors `//` block comments above
  non-obvious logic, explaining *why* (gameplay intent, math
  reasoning, perf concerns) rather than *what*.
- **Event bus**: gameplay code in `game.js`/`ship.js` emits domain
  events (`weaponFired`, `hit`, `shipDestroyed`, etc). `audio.js`,
  `progression.js`, and others subscribe. Don't reach across modules
  directly — emit/subscribe.
- **Save schema**: `save.js` has `CURRENT_SCHEMA_VERSION` and a
  `MIGRATIONS` registry. `mergeWithDefaults` deep-merges so
  *additive* fields to `menuSelection` / `settings` / etc. don't
  need an explicit migration step. Bumping the version is only
  needed when the *shape* changes incompatibly.
- **Damage layers**: shield → armor (capitals only) → hull. Implemented
  in `applyDamage` in `game.js`. Missiles bypass shields. Lasers and
  fighter cannons cost only 50% from the shield bank. Armor wears at
  `spec.armor.wearRate`.
- **Fixed timestep**: `main.js` accumulates real time and steps
  `update(game, 1/60)` until the accumulator drains. Don't sleep, poll
  `performance.now()`, or assume `dt` varies wildly.
- **Coordinate space**: world is in pixels; arena bounds set by
  `setArenaSize`. Camera follows player (or spectate target) and is
  scaled by `ZOOM` (0.5) in `main.js`.
- **Hull polygons**: defined in `src/ship.js` as `HULLS[race][klass]`,
  vertex coords in unit space scaled by `spec.radius` at draw time.
  `getHull(race, klass)` is exported so `wreckage.js` can reuse them.
- **Ship state mutability**: `ship.controller` is updated each frame
  from input/AI; the rest of the ship is mutated by `updateShip`.
  Avoid stashing extra state on ships unless it has a clear owner.

## Render order (main.js draw)

1. Arena background + starfield.
2. Camera transform applied.
3. Arena bounds.
4. **Wrecks** (under live ships).
5. Live ships.
6. **Debris** (on top of ships).
7. Projectiles.
8. Beams (HUD module).
9. Restore transform; HUD; virtual sticks.

## Things to know before changing rendering

- All world-space draws happen inside the camera transform applied in
  `main.js#draw`. HUD draws after `ctx.restore()` so screen-space
  layout is unaffected by camera scale.
- `drawShip` applies its own `ctx.save/translate/rotate/restore` so
  per-ship sub-draws can use ship-local coords directly.
- `getHull(race, klass)` returns unit-space polygon vertices in
  `[[x, y], ...]` form, ranges roughly `[-1, 1]`. Multiply by
  `ship.spec.radius` to scale to world units.

## Subsystem cheat sheet

- **Carrier replenishment**: every `spec.replenish.fighter` and
  `spec.replenish.bomber` seconds, the carrier launches a new escort.
- **PD turrets**: ring of N positions on the hull (see
  `pdTurretOffset`); each picks: missile → bomber → fighter → nearest.
- **Pack AI**: `game.packs` is rebuilt each tick from ships with a
  matching `packId`. Each pack picks a target by role
  (`hunt-fighter`, `strike-capital`, `skirmish-frigate`), with bombers
  pulling rank over the role preference.

---

## Changelog

Newest entries first. When you make changes, add a section with date,
a one-line summary, file pointers, and any non-obvious decisions.

### 2026-05-21 — Custom Match supports multi-faction teams (all 4 factions, per-faction fleet sizes)

**What changed**

Map size and fleet size already flowed through `startGame` (the menu's
size chip drives `setArenaSize(mapW, mapH)`; the fleet chip drives
`game.fleetMul`, applied as `Math.round(count * mul)` for the
race-default rosters). Custom mode honored map size but explicitly
skipped `fleetMul` because the user-authored counts are the whole
point. That part was already correct — the only missing piece was
the inability to stage more than two factions on the same map.

Custom Match now supports **up to 2 factions per side** for a 4-
faction setup, each with its own per-class fleet counts.

- The single race chip + single slider block per side is replaced by
  a stack of "team blocks." Each block has its own race chip row
  (Terran / Reavers / Hegemony / Voidsworn), its own per-class
  sliders, and (for slot 2 onward) a remove button.
- `+ ADD ALLY` / `+ ADD ENEMY` buttons add a second faction to the
  side. The button auto-picks the first race not already on the side
  so a 2-tap path goes from "1v1 Terran vs Terran" to "all 4
  factions on the map."
- The overlay caps each side at 2 factions and hides the add button
  once it's full.
- Side and grand totals re-sum across all factions on the side.

**Data model.** `InputManager` now tracks `customBlueTeams` and
`customRedTeams` — arrays of `{race, counts}`. The legacy single-race
fields (`customAlliedRace`, `customHostileRace`, `customBlueCounts`,
`customRedCounts`) are kept as mirrors of the *first* team so any
code that still reads them (HUD chrome, debug paths) keeps working.

`consumeCustomRoster()` emits both shapes:

```js
{
  alliedRace, hostileRace,        // legacy: first team's race
  blue, red,                      // legacy: first team's counts
  blueTeams: [{race, counts}, ...],  // new
  redTeams:  [{race, counts}, ...],  // new
}
```

`game.js#spawnRoster` resolves in order:

1. `rosterOverride.blueTeams` / `redTeams` — multi-faction Custom mode.
2. `rosterOverride.blue` / `red` — legacy single-faction Custom, plus
   Roguelite's per-node manifest.
3. Race-default roster — every other mode.

Cases 1 + 2 still skip `fleetMul` (counts are authored). The Defend-
mode station uses the side's *primary* race (first team) for visual
identity.

**Files touched**

| File | What |
|---|---|
| `src/input.js` | Replaced `customBlueCounts`/`customRedCounts` with `customBlueTeams`/`customRedTeams` (arrays of `{race, counts}`); kept the old single-race fields as mirrors of slot 0. `consumeCustomRoster` emits `blueTeams`/`redTeams` alongside the legacy `blue`/`red`. `_buildMenuState` exposes the team arrays under `custom.blueTeams` / `custom.redTeams`. Callbacks `onCustomRaceSelect` and `onCustomSliderChange` now take a `teamIdx`; new `onCustomAddTeam(side)` and `onCustomRemoveTeam(side, idx)` wire the +/× buttons. |
| `src/menus.js` | Replaced the single-race custom overlay with a per-side team-list container + `+ ADD ALLY`/`+ ADD ENEMY` button. `_syncCustomMatch` reconciles the DOM team blocks to the team arrays each frame (tear extras, build missing, sync race-chip selection + sliders + totals). `_buildSliders` accepts a `teamIdx` and stamps it on the container so per-slider callbacks know which faction they're editing. |
| `src/modes/custom.js` | Forwards `blueTeams`/`redTeams` alongside the legacy `blue`/`red` when calling `spawnRoster`. |
| `src/game.js` | `spawnRoster` now iterates `blueTeams`/`redTeams` when present; each team contributes its race's counts via the existing per-class spawn paths (`spawnFighterPacks`, `spawnBomberPairs`, `spawnCapitalWithEscort`, default loop). Manifest matching for wounded Frontier capitals still draws from the blue side regardless of which team owns the cap. Defend-mode station uses the side's primary race. |
| `style.css` | New `.custom-team-block` block style (padded card, 1 px border), `.custom-team-header` row with the slot label + race name + remove pill, `.custom-team-races` chip row (flex with `min-width:60px` chips), `.custom-team-sliders` stacked slider container, `.custom-add-btn` dashed "+ ADD" button. |

**Design decisions / gotchas**

- **Teams share the same side spawn zone.** Both factions on the
  blue side spawn from `ARENA.spawn.blue` — they're allies. The AI
  side check (`o.side === ship.side`) is unchanged, so an ally
  faction never gets targeted by its own teammates. True 4-team
  (4-corner FFA) would require a side architecture rewrite that's
  out of scope.
- **2-faction-per-side cap matches the 4 available races.** With
  exactly 4 factions in the roster, "all 4 on the map" is 2-vs-2 at
  the limit. Going above 2 per side would require splitting one
  faction across teams, which doesn't make sense.
- **Add-button default pick is "first unused race on this side."**
  So `[Terran]` + `+ ADD ALLY` defaults the new slot to `Reavers`,
  not another `Terran`. The user can re-pick after.
- **Slot 0 can't be removed.** Each side must keep at least one
  faction or the spawn loop drops the side entirely. The remove
  pill is hidden (via `visibility: hidden`) on slot 0 so the
  removeBtn still occupies its column in the header grid.
- **`consumeCustomRoster` clones counts per team.** Without the
  clone, the overlay's DOM-edits would mutate the live roster
  passed into `startGame`, which is shared with the live game
  object. Cheap defensive copy.
- **Old `customBlueCounts`/`customRedCounts` still exist** because
  several render paths (per-slider sync, totals, the old menu
  layout's grand-total color band) still read them. Mirroring slot
  0 keeps backward compatibility cheap.
- **Verified via Playwright** (Galaxy S9+ UA): default Custom flow
  spawns 230 ships (Terran vs Terran). After tapping `+ ADD ALLY`
  and `+ ADD ENEMY` the same flow spawns 482 ships across `blue-
  terran` (115), `blue-reavers` (126), `red-terran` (115), and `red-
  reavers` (126) — all four factions on the map, per-faction fleet
  sizes preserved. No pageerrors.

### 2026-05-21 — Tracking gun turrets + lasers bury into the hull

**What changed**

Two visual requests:

1. **PD turrets now visibly track their target.** Previously every PD
   turret was rendered as a static white dot at its hull-ring offset,
   and the module-level cluster art spun on a per-ship phase that had
   nothing to do with what the turret was actually shooting. Each PD
   turret now stores its current world-space aim angle
   (`ship.pdAimAngles[i]`), updated every tick from the lead-aim
   calculation that already runs in `updatePDFire`. The draw layer
   renders a small base disc + a barrel rotated onto that aim
   (`localAim = pdAimAngles[i] - ship.heading`), with a tiny muzzle
   tip for the firing-end read.

2. **Heavy laser barrel tracks too.** `updateHeavyLaser` now picks a
   target every tick — not just when ready to fire — and stashes the
   world-space angle on `ship.laserAimAngle`. `drawLaserArt` rotates
   the barrel onto that angle (clamped to the spec's `heavyLaser.arc`
   so the gun can't whip past the firing cone). Cleared back to
   `null` when the laser module is destroyed.

3. **Laser beam buries into the hull instead of hitting centre.**
   `endPoint(beam)` in `hud.js` used to extend the beam to
   `target.pos` (the geometric centre of the ship). Now it stops
   `targetR * 0.5` short of centre — i.e. halfway between the
   leading hull edge and centre — so the beam visibly carves into
   the silhouette and doesn't drill clean through to a centre dot.

**Files touched**

| File | What |
|---|---|
| `src/ship.js` | `updatePDFire`: lazily allocates `ship.pdAimAngles[]`, updates every tick (even when on cooldown), and uses the same angle to fire. PD-turret draw block (drawShip body) replaces white dots with base disc + rotated barrel + muzzle tip; default aim points outward from the hull when no target has been picked. `updateHeavyLaser` runs `pickLaserTarget` every tick to refresh `ship.laserAimAngle` regardless of cooldown; clears the angle when the laser module is disabled. `drawLaserArt(ctx, mr, frac, ship)` rotates the barrel onto `laserAimAngle - ship.heading`, clamped to the spec arc. `drawModuleArt` now forwards `ship` into the laser case. |
| `src/hud.js` | `endPoint(beam)` returns `d - targetR * 0.5` along the beam vector instead of full `d` so the visual stops halfway into the hull. |

**Design decisions / gotchas**

- **PD turrets keep updating their aim even on cooldown.** Without
  this the barrels would freeze mid-track between shots; with it
  they slew smoothly. The render cost is one cached angle per turret
  per tick — negligible against the existing per-turret target pick.
- **Broadside cannons stay fixed perpendicular by design.** The
  `firingMode: "broadside"` ships don't aim individual barrels — the
  hull rotates until a target enters the broadside arc, then all
  guns on that side fire together. Animating the barrels to track
  individuals would lie about how the weapon actually works.
- **Laser barrel angle is clamped to `heavyLaser.arc`.** Without the
  clamp the barrel could swing 180° to point at a target behind the
  ship; with it the gun visibly "tries" to track but stops at the
  arc edge — the same constraint that gates the actual beam.
- **Bury constant is `radius * 0.5` not `radius * 0.85`.** Initial
  pass used 0.85 which only put the endpoint ~8 px past the edge of
  a 54 px frigate — barely visible. 0.5 puts the endpoint halfway
  to centre (27 px in), which reads clearly as the beam carving in
  on capitals (BB radius 156 → 78 px bury depth).
- **Verified via Playwright** (Galaxy S9+ UA, admiral mode): BBs
  spawn with `pdAimAngles.length = 10` matching `pdCannons.count`;
  the per-turret angle is no longer the initial 0 fill. First laser
  beam fired ~30 s in, targeting a frigate (radius 54) at distance
  2227 — beam endpoint computes to `d - 27 = 2200`, halfway into
  the hull as designed.

### 2026-05-21 — +2 missile launchers, cluster cruiser, umbrella bloom, bomber shield buff

**What changed**

Four balance + VFX requests:

1. **Every non-fighter missile carrier gets +2 launchers.**
   - bomber: 3 → 5
   - frigate: 1 → 3
   - cruiser: 2 → 4
   - battleship: 4 → 6
   (Carrier has no missilePods. Fighter has a single `missile`, not
   `missilePods` — left alone.)

2. **Cruiser cluster missiles restored.** The original 4bc4974 cruiser-
   refit shipped cluster pods; they were dropped in a later merge and
   the user remembered them. Re-added with cruiser-scale numbers:
   `bloomDistance: 360, childCount: 4, childSpread: 0.55, childSpeed:
   380, childTurnRate: 2.8, childTtl: 2.8, childDamage: 30,
   childRadius: 4, childHp: 1`. Parent damage dropped 110 → 60 so the
   bloom (4 × 30 = 120) is the optimal play instead of a point-blank
   ram.

3. **Cluster bloom now obeys two new rules.**
   - **Burst outside the target's PD range.** Effective bloom
     distance = `max(cluster.bloomDistance, target.spec.pdCannons.range
     + 60)`. The whole point of clustering is to overwhelm PD with
     multiple tracks — pre-fix, the BB cluster bloomed at 420u but
     BB PD reach was 560u, so the parent died entire before splitting.
   - **Point-blank launches wait until clear of the firing ship.**
     If the parent is still within `owner.radius + 80` of its
     launching ship, the bloom is held. Without this, an unlucky
     launch from inside the target's PD range would burst against
     the launcher's own hull.

4. **Umbrella bloom VFX.** Before the children spawn,
   `spawnClusterChildren` pushes:
   - A coloured outer shockwave (parent tint, size = parent.radius +
     6, growth 540 u/s, ttl 0.55 s).
   - A white inner shockwave (smaller, faster growth) — gives the
     bloom a two-ring opening read.
   - `max(10, childCount × 3)` sparks fanning along the children's
     heading cone (`spread × 1.4` half-angle) so the umbrella has
     "ribs" before the warheads start moving.
   - Four side-trim sparks shooting laterally for a cross-section pop.

5. **Bomber shields buffed.** Bombers were getting overrun before
   delivering a strike: `shield.max: 130 → 220, regen: 16 → 24`. The
   2.2 s regenDelay is unchanged.

**Files touched**

| File | What |
|---|---|
| `src/classes.js` | Bomber `shield.max` 130→220, `regen` 16→24, `missilePods.count` 3→5. Frigate `missilePods.count` 1→3. Cruiser `missilePods.count` 2→4 plus full `cluster` block restored (and `damage` 110→60 so the cluster is the right play). Battleship `missilePods.count` 4→6. |
| `src/projectile.js` | New `import { createShockwave, createSpark } from "./particles.js"`. Cluster-bloom branch now computes `effectiveBloom = max(spec, target.pdCannons.range + 60)` and gates on `clearedOwner = ownerDist >= owner.radius + 80`. `spawnClusterChildren` spawns the two-ring shockwave + cone of sparks + 4 lateral trim sparks before the warheads. Local `hexToRgba(hex, alpha)` helper expands `#rgb` and `#rrggbb` into the `rgba(r,g,b,` prefix the shockwave painter needs. |

**Design decisions / gotchas**

- **Cruiser re-armed with clusters, not just buffed.** The user said
  "cluster missiles from cruisers must balloon" — present-tense as if
  cruiser already shoots clusters. The repo's current main only had
  BB clusters; this restores the original cruiser-as-artillery role
  rather than treating the user's request as a typo for "battleship."
- **PD-range slack is 60 u.** A round number that puts the bloom
  just outside the densest PD bubble for every ship in the roster
  (PD ranges run 400–560). If you ever push a PD range past ~600 the
  cluster will bloom proportionally further out; that's load-bearing.
- **`clearedOwner` reads `owner.spec.radius`.** Stations and
  unconventional hulls might not have a `spec.radius`; default 60 u
  if missing — keeps the rule from no-oping into "bloom on launch"
  for any odd carrier.
- **Shockwave colour pipeline assumes `#hex` parent colours.**
  Every faction's `missilePods.colors` shipped today is a hex
  literal — `hexToRgba` falls back to white if it sees anything
  else, so adding an `hsl()` race override later won't crash.
- **Verified via Playwright** (Galaxy S9+ UA, admiral mode): bomber
  shield = 220/24, missile counts = 5/3/4/6 per class, cruiser has
  `cluster`, and after 15s of live combat the world held 28 cluster
  parents + 54 child warheads (i.e. blooms are firing). No
  pageerrors.

### 2026-05-21 — Battleship cannon shells + FIRE-button dead wiring + tap-to-inspect + escort leash

**What changed**

Five user-reported issues, all fixed in one pass:

1. **BB main shells looked like slow-moving orbs.** Speed was 280 (vs
   fighter 760 / cruiser 640) and the projectile renderer drew every
   non-missile as a perfect filled circle, so big radius + low speed
   read as "hovering plasma" rather than a heavy cannon round. Bumped
   `projectileSpeed` 280 → 540 (still slower than fighter, so the
   weight reads), shaved radius 10 → 8, and `drawProjectile` now
   renders shells of `radius >= 6` as ellipses oriented along the
   velocity vector with a bright leading tip — i.e. cannon tracers,
   not orbs.

2. **FIRE / SPC / CHARGE buttons did nothing.** Since the DOM/HUD
   overhaul (a6f0f28) the action-cluster has been visual-only — the
   `.action-cluster` div is `pointer-events: auto`, so the underlying
   canvas pointerdown never sees the tap, but **no DOM listeners
   were ever wired on the buttons**. The canvas-side `FireButton` /
   `MissileButton` / `BoostButton` hit-tests were dead code. Added
   pointerdown / up / cancel / leave handlers on each DOM button that
   drive `input.fireBtn.start / end` etc. — verified via Playwright
   that the FIRE button's `.pressed` class flips on hold and clears
   on release.

3. **Couldn't inspect ships in spectate / admiral.** Added a
   tap-to-select gesture: short, low-movement touch (≤8 px move, ≤
   400 ms) or mouse click commits a `_pendingTap`; main.js' frame
   loop converts the canvas-coord tap to world coords using
   `_lastCamera + (tap - viewW/2) / zoom` and finds the nearest live
   ship within `radius + 28/zoom` px world slack. Sets
   `game.spectateTargetId` so vitals + target panel re-key onto the
   tapped ship. The target panel now shows SHIELD → ARMOR → HULL in
   the same order damage resolves, and `pickFocusTarget` drops the
   capital-only filter in spectate so fighters/bombers are
   inspectable too.

4. **Fighter squads weren't capped at 5.** Cruiser/BB/carrier escorts
   were spawned in single packs of 10 / 10 / 15. Free fighter packs
   were already 5 via `FIGHTER_PACK_SIZE`. Split escort spawn into
   batches of 5 with separate `packId`s so a BB now flies 2 squads
   of 5, a carrier 3 squads of 5, frigate 1 squad of 5.

5. **Fighter escorts chased targets across the entire arena.** Added
   an escort leash in `updateAI`: a fighter with `escortOf` set only
   engages targets within `ESCORT_ENGAGE_RANGE` (900u) of its
   assigned capital, and recalls to a station ring around the cap
   when either the target wanders past 900u or the fighter itself
   drifts past `ESCORT_RECALL_RANGE` (1400u). With no engageable
   target, the escort flies a station ring (`cap.radius + 200`,
   per-ship phase offset) instead of going idle.

**Files touched**

| File | What |
|---|---|
| `src/classes.js` | BB barrage `weapon`: `projectileSpeed` 280→540, `projectileRadius` 10→8 (still bigger than cruiser 7, fighter 2). |
| `src/projectile.js` | `drawProjectile` branches on `radius >= 6`: oriented ellipse along `vel` plus a bright leading-tip overlay for cannon-tracer read. |
| `src/hud.js` | Constructor wires pointerdown/up/cancel/leave on `#fire-btn`, `#boost-btn` (hold-pattern) and `#missile-btn` (edge-trigger). `pickFocusTarget` returns spectate target without the `.modules` capital filter. `_syncTargetPanel` reorders bars to SHIELD → ARMOR → HULL and adds shield row. |
| `src/input.js` | Added `selectActive` / `_tapCandidate` / `_pendingTap` state; onDown opens tap-candidate when no button or stick claims the pointer; onMove cancels past 8 px; onUp commits within 400 ms. New `consumeTap()` clears + returns the pending tap. |
| `src/main.js` | Sets `input.selectActive` per frame (`game.spectating || game.admiralMode`). After the spectate-pan block, calls `input.consumeTap()` → world conversion → nearest-ship pick within `radius + 28/zoom` → sets `game.spectateTargetId` and relocks `spectateCamera`. |
| `src/game.js` | `spawnEscorts` splits the escort ring into packs of `FIGHTER_PACK_SIZE` (=5) with fresh `packId`s. |
| `src/ai.js` | `updateAI`: after the normal target pick, escort fighters drop targets >900u from the cap or when the fighter itself is >1400u from the cap. With no target, fly a station ring around the cap rather than idle. |

**Design decisions / gotchas**

- **Tap-to-select shares the right-half real estate with the
  (hidden) right vstick.** When `selectActive` is true, onDown skips
  `right.start` on touches that land in the right half. The left
  half still routes to the pan stick. Mouse clicks always count as
  taps because the existing onDown already returned before reaching
  the tap-candidate code if a HUD button claimed the click.
- **Escort station ring uses per-ship phase (`ship.id * 0.137`)** so
  five escorts don't pile onto the same point — they hold a coarse
  ring formation around the cap.
- **`escortOf` is cleared once the capital dies.** From that point
  the fighter behaves as a free fighter: nearest-bomber priority,
  then nearest enemy. Without this clear, escorts would station-keep
  around a dead pointer forever.
- **BB streak length is `radius * 2.6`.** At `projectileRadius: 8`
  that's a ~21 px ellipse — clearly elongated, but small enough that
  PD rounds at radius 3 still look like dots even if we ever bumped
  the threshold below 6.
- **The cruiser shell (`projectileRadius: 7`) is now also a streak.**
  Intentional — they're cannon shells too and the previous orb look
  hadn't aged well. Frigate (radius 3.5), fighter (2-4), PD (2-3),
  and missile-pod children (4) all stay below the threshold.
- **Verified via Playwright** (Galaxy S9+ UA): admiral mode spawns
  241 ships with max pack size = 5 (cap escorts split correctly).
  Center-screen tap relocked `spectateTargetId` from 1 → 65, target
  panel populated with shield/hull bars for a "Terran Fighter".
  FIRE button `.pressed` toggles on hold/release with no
  pageerrors.

### 2026-05-21 — Admiral camera unmovable + battle HUD clutter

**What changed**

Three intertwined HUD bugs surfaced under the new Frontier → COMMAND
FLEET flow:

1. **Admiral camera couldn't pan.** The canvas-drawn `AdmiralPanel`
   (input.js) lays out a ~772×138 rect centred at the bottom of the
   viewport and `onDown` calls its `handleClick` *before* the virtual
   sticks. `handleClick` returns `true` for *any* pointer inside the
   panel rect, even if it missed every control, to "swallow it so the
   spectate camera doesn't pan under it." Trouble is, the canvas
   panel is **never drawn anymore** — the HUD overhaul moved it to a
   DOM `.admiral-panel` under `#battle-root`. The orphaned hit-rect
   still claimed the entire bottom half of a 320px-wide phone, so the
   left virtual stick at `bottom:180px,left:10px` could never start a
   pointer-capture. Dropped the dead interception.

2. **DOM admiral panel buttons no-op'd.** `hud.js` calls
   `game.setPosture(klass, p)` / `game.setMissiles(klass, m)` from
   the rebuilt admiral grid, but those functions were never defined —
   they only ever existed as the closure-captured `_setPosture` /
   `_setMissiles` on `input.admiralPanel`. So the fleet-command grid
   rendered, was clickable, and quietly did nothing. Wired the same
   two closures onto `game` in main.js so both the (now dead) canvas
   panel and the live DOM panel drive the same directive setters.

3. **HUD layered 8+ widgets in the bottom half.** Even with the DOM
   admiral panel showing, the piloting chrome (action cluster, aim
   stick, damage arcs, compass, lock reticle, respawn timer, vitals
   bar) kept rendering — none of them gated on `game.spectating` or
   `game.admiralMode`. The bottom half of the screen was a stack of
   overlapping widgets that did nothing for an admiral. Added
   `_syncModeChrome` to BattleHUD that hides:

   - In **piloting** mode: nothing extra (everything stays).
   - In **spectate** (non-admiral): action cluster, aim stick, damage
     arcs, compass, lock reticle, respawn timer. Vitals stays —
     they're useful for the locked target.
   - In **admiral**: everything in the spectate list **plus** vitals
     and the `OBSERVING <ship>` pill. (Admiral is not "observing a
     ship," they're commanding the fleet — the pill was confusing
     and overlapped the target panel.)

   Repositioned mobile chrome: target panel → top-left, minimap →
   top-right, OBSERVING pill → top-centre under the SPECTATE pill.
   Bottom is now just the vitals bar (piloting/spectate) or the
   admiral panel (admiral), with the action cluster + right stick
   stacked along the right edge in piloting.

**Files touched**

| File | What |
|---|---|
| `src/input.js` | Removed the canvas `AdmiralPanel.handleClick` interception in `onDown`. (The `AdmiralPanel` class + its layout/hooks code are kept — Game still wires `setHooks`, and the class is still imported in main.js. Drop-it-entirely is a follow-up sweep.) |
| `src/main.js` | Lifted the `setPosture`/`setMissiles` closures into local consts; assigned `game.setPosture` / `game.setMissiles` so the DOM panel sees them. `input.admiralPanel.setHooks` still gets the same pair. |
| `src/hud.js` | New `_syncModeChrome(game)` runs first in `sync()`; gates `#action-cluster`, `#damage-indicator`, `#compass`, `#lock-reticle`, `#respawn-panel`, `#vitals-bar`, `#vstick-right`, `#spectate-pill` per piloting / spectate / admiral. |
| `style.css` | Mobile `.target-panel` → top-left (`top:12px; left:8px; bottom:auto`). Mobile `.minimap` → top-right (`top:56px; right:8px; bottom:auto`). `.spectate-pill` drops to `top:112px` on mobile so it doesn't overlap the target panel + battle-top-right row. |

**Design decisions / gotchas**

- **The canvas `AdmiralPanel` class is dead code.** Its `layout()` is
  still called by `layoutOverlays()` and `setHooks` still wires its
  setters, so deleting it cleanly is a follow-up. Right now it's
  cheap clutter — only the orphaned `handleClick` interception was
  load-bearing for the bug.
- **`game.setPosture` / `game.setMissiles` are functions, not data.**
  They aren't persisted in the run save, aren't part of `modeConfig`,
  and survive only as long as the game instance does — exactly the
  semantics we want for transient command bindings.
- **Mode-chrome gates use `display`, not `visibility`.** `visibility:
  hidden` keeps the element in flow and still claims pointer events;
  `display: none` actually removes it, which is what we want when
  the goal is "the user can't accidentally tap a hidden button."
- **Left vstick stays on in admiral mode.** It's the camera-pan input.
  The existing pan logic in `main.js` keys off `game.spectating`
  (which admiral also sets), so wiring is already there — the bug
  was that the canvas panel was eating the touches before they reached
  the stick.
- **Verified via Playwright** (Galaxy S9+ UA, 320×658): admiral mode
  hides action cluster / damage indicator / compass / reticle /
  vitals / right stick / OBSERVING pill (`display: none` on all);
  minimap relocates to (180, 56), target panel to (8, 12), admiral
  panel sits at bottom; clicking the FIGHTER → PRESS button flips
  `game.directives.fighter.posture` from `"free"` to `"press"` as
  expected.

### 2026-05-21 — DOM menu persisted on top of every non-Frontier mode

**What changed**

After tapping DEPLOY on Open Battle / Defend Station / Admiral / Custom,
the `menu-root` DOM (z-index 15) kept sitting on top of `#game` (z-5)
and `#battle-root` for the entire match — chips, START button, etc.
stayed clickable over the live battle.

Cause: `main.js#draw` only calls `input.startMenu.draw()` while
`game.state === "menu"`. The first time the user clicks DEPLOY,
`startGame` synchronously flips `game.state` to `"playing"`, the draw
loop drops out of the menu branch, and **`MenuSystem.showScreen` is
never called again** — so the previous frame's `menu-root` visibility
(`"visible"`) and the active screen class linger forever. Frontier
was unaffected because `_launchBattle` already calls
`_menuSystem.hideAll()` synchronously before dispatching `enter-node`;
the other modes had no equivalent.

Fix: added an idempotent `StartMenu.hide()` (delegates to
`_menuSystem.hideAll()` only when a screen is currently active, so
it's a no-op after the first call each match), and an `else` branch
in `main.js#draw` so every non-menu frame either no-ops or tears the
chrome down on the transition frame.

**Files touched**

| File | What |
|---|---|
| `src/input.js` | New `StartMenu.hide()` method right after `draw()`. Idempotent — checks `_menuSystem._currentScreen !== null` before calling `hideAll()`. |
| `src/main.js` | `if (game.state === "menu") input.startMenu.draw(...)` gets an `else input.startMenu.hide()` so the transition frame after `startGame` clears `menu-root`. |

**Design decisions / gotchas**

- **`hide()` is idempotent.** `hideAll()` itself iterates every screen
  to strip `.active`, which is cheap but unnecessary 60× per second.
  Gating on `_currentScreen !== null` makes only the transition frame
  do work; every subsequent in-battle frame returns immediately.
- **Hide is wired in the draw loop, not in `startGame`.** `startGame`
  is shared by canvas-click, DOM-DEPLOY, post-battle restart, and the
  Frontier `enter-node` path — putting hide there would race with the
  Frontier `_launchBattle` cleanup (which also destroys the starmap).
  Driving it from the draw loop's `game.state` check covers every
  mode with one rule.
- **Post-battle return works for free.** When the player taps after
  `matchOver`, `restart` flips `game.state` back to `"menu"`, the
  draw loop re-enters the menu branch, `startMenu.draw` runs, and
  `showScreen(_baseScreen)` re-mounts the PLAY screen. No special
  `wake-up` call needed.
- **Verified via Playwright** (Galaxy S9+ UA): all four non-Frontier
  modes now report `getComputedStyle(menu-root).visibility === "hidden"`
  after the deploy. Frontier flow still passes through HOME → PLAY →
  NEW CAMPAIGN → Terran → starmap → JUMP → FLY without regressions.

### 2026-05-21 — Main-menu restructure: HOME → PLAY → mode-relevant options

**What changed**

Old main menu was a single screen with four chip rows (MAP SIZE, GAME
MODE, FACTION, FLEET SIZE) plus a START button — same chrome regardless
of which mode was picked. Frontier showed irrelevant map/fleet options;
Custom showed irrelevant race/fleet (the custom overlay owns rosters).

New structure has clear levels:

1. **HOME** — top-level hub. Three buttons: **PLAY** (primary),
   **SETTINGS**, **ABOUT**. Energy bar + floating settings pill hide
   here (both are scoped to launching a match).
2. **PLAY** — the old main menu, now reached from HOME via a BACK
   arrow. GAME MODE chips always show. Other sections render
   conditionally:
   - Open Battle / Defend Station / Admiral → map size + faction + fleet
   - Frontier → none (faction + map come from the run)
   - Custom → map size only (rosters/races live in CONFIGURE overlay)
3. **ABOUT** — short description of the project + BACK.

`input.js` gained a `_baseScreen` state ("home" / "main" / "about");
overlays still take precedence in `draw`'s screen-name pick. Energy
bar + settings-pill visibility now key off `name === 'main'` instead
of "menu is active at all."

**Files touched**

| File | What |
|---|---|
| `src/menus.js` | New `_buildHome()` and `_buildAbout()`. `_buildMainMenu` gets a BACK button + title "PLAY" + `this._sectionEls` map. `_syncMainMenuChips` hides irrelevant sections per `selectedMode` (full hide for Frontier, race+fleet hide for Custom). `showScreen` gates pill visibility on `name === 'main'`. |
| `src/input.js` | `_baseScreen = 'home'` in constructor; `draw()` reads it as the default screen name. New callbacks `onHomePlay` / `onHomeAbout` / `onMainBack` / `onAboutBack` flip `_baseScreen`. Canvas-dim now fires for any base screen (`home` / `main` / `about`), not only `main`. |
| `style.css` | `.menu-home-nav` (vertical button stack), `.menu-home-play` (300px wide for the primary), `.menu-home-secondary` (220×44 for SETTINGS/ABOUT). `.menu-about-body` for the body copy. `.menu-back-btn` (absolute top-left chevron). |

**Design decisions / gotchas**

- **Sections show/hide via inline `display`, not class swap.** Keeps the
  flex-column ordering of `.menu-screen` stable and avoids reflow
  flicker when the user toggles between modes. Style toggle lives in
  `_syncMainMenuChips` so it runs every frame and self-heals after a
  programmatic mode change.
- **Custom keeps MAP SIZE.** `_emitStart` reads `selectedSize` for the
  custom path, so hiding the section would orphan an input. Custom
  hides race + fleet because the overlay overrides them.
- **`_baseScreen` is the only knob.** Resisted adding `showHome` /
  `showAbout` boolean pairs — the old `show*` flags are for overlays
  whose lifetime spans multiple frames and must be cleared. The home /
  main / about *base* is a tri-state pick; one variable, one source of
  truth.
- **No saved-run guard on PLAY label.** The DEPLOY / CONFIGURE /
  RESUME / NEW CAMPAIGN button already keys off `selectedMode` and the
  run-state, so the user lands on PLAY with the correct label regardless
  of which mode they last picked.
- **After a battle ends, `_baseScreen` is already 'main'.** Restart
  flips `game.state` back to "menu" and the next frame paints PLAY
  (where the user came from), not HOME. If you ever want a post-battle
  re-open to land on HOME instead, set `_baseScreen = 'home'` in
  `restart` or in the `matchEnded` handler.
- **Verified via Playwright** (Galaxy S9+ UA): home shows by default;
  PLAY/SETTINGS/ABOUT route correctly; section visibility matches the
  mode (Frontier hides all extras, Custom hides race+fleet, Open shows
  everything); BACK returns to home; full Frontier flow (HOME → PLAY →
  Frontier → NEW CAMPAIGN → Terran → starmap → JUMP → battleChoice →
  FLY) still completes with no pageerrors.

### 2026-05-21 — Frontier flow: JUMP-does-nothing, stale closure, FLY teardown, event auto-advance

**What changed**

Smoke-tested the full Frontier loop (NEW CAMPAIGN → faction → starmap →
jump → battle/event/resupply) and found four related bugs from the
DOM/CSS overhaul (a6f0f28). All fixed in this commit.

1. **JUMP did nothing.** Tapping a reachable node opened the jump
   confirmation, but tapping JUMP itself was a silent no-op. Cause:
   `StartMenu.draw` hid `menu-root` whenever `showRunMap` was true,
   so when `_routeNodeClick` flipped `showBattleChoice` (etc.) to
   true on JUMP, the DOM overlay screen never became visible. Fixed
   by lifting `hasSubOverlay = showResupply||showEvent||showBattleChoice`
   above the visibility gate and keeping `menu-root` shown when an
   overlay is up. The `behind-canvas` toggle that used to drop the
   starmap below the canvas for canvas-drawn overlays is now dead
   (`menu-root` z-15 already sits above starmap z-10) and was
   dropped from the draw path.
2. **Stale closure routed the wrong node.** `setStarmapCallbacks`
   captured the `run` local from `_layoutRunMap`'s first call. If a
   new run started (or — what bit us during testing — the act-graph
   changed underneath), `graph.nodes.find(id === nodeId)` returned a
   stale node, so a clicked event node could route through the
   battle-choice path with the previous run's roster. Fixed by
   re-reading `this.runState.run` inside the callback at click time,
   with the closure-captured `run` as a fallback.
3. **FLY INTO BATTLE didn't tear down the starmap.** The DOM
   `onBattleFly` / `onBattleCommand` callbacks dispatched
   `enter-node` (which synchronously calls `startGame`), then only
   cleared `showBattleChoice`. `showRunMap` stayed true and
   `_starmapControl` stayed alive — but once `game.state` flipped
   to `"playing"`, `startMenu.draw()` stopped firing (see
   `main.js#draw` at the `game.state === "menu"` gate), so the
   normal "destroy starmap when `showRunMap` is false" path in
   `draw` never ran. Net effect: `starmap-root` (z-10) sat above
   `#game` (z-5) for the entire battle. Added a `_launchBattle`
   helper that synchronously hides `showRunMap`, destroys the
   starmap, hides `menu-root`, then dispatches `enter-node` — both
   callbacks now route through it.
4. **Event-choice taps didn't advance the player.** The DOM
   `onEventChoice` only dispatched `apply-event` (effect on
   resources/fleet) but not `complete-node-noncombat` (mark visited
   and advance `nodePos`). The legacy canvas `_clickEvent` handler
   fires both — DOM dropped the second on the floor. Mirrored the
   canvas dispatch so the player advances to the event node after
   choosing.

**Files touched**

| File | What |
|---|---|
| `src/input.js` | (1) lifted `hasSubOverlay` above the `menu-root` show/hide branch and updated the gate; dropped the `.behind-canvas` toggle. (2) `setStarmapCallbacks`' `onNodeClick` now reads `this.runState.run` first, fallback to captured `run`. (3) added `_launchBattle(mode)` near `_endRunMapDrag`; `onBattleFly` / `onBattleCommand` both call it. (4) `onEventChoice` dispatches `complete-node-noncombat` after `apply-event`. |

**Design decisions / gotchas**

- **Canvas overlay stubs left in place.** `_drawResupply` / `_drawEvent`
  / `_drawBattleChoice` are still no-op stubs called from the draw
  loop. The legacy `_clickResupply` / `_clickEvent` / `_clickBattleChoice`
  methods are also still alive in source. None of them fire under
  the DOM path because the menu-scrim absorbs canvas pointers, but
  ripping them out is a separate sweep — out of scope for the
  launch fix.
- **`_launchBattle` runs the cleanup BEFORE the dispatch.** Order
  matters: `enter-node` synchronously calls `startGame`, which
  flips `game.state` to `"playing"` and stops the draw loop from
  calling `startMenu.draw`. If we cleared `showRunMap` *after*
  dispatch, the destroy-starmap branch in `draw` would never run.
- **Closure fallback on `currentRun ?? run` is deliberate.** If
  `this.runState.run` is null (e.g., abandon-run flushed it mid-
  click) we want SOMETHING to look up — the closure's `run` is
  better than a TypeError. The fallback hit only matters in races,
  not the normal play path.
- **Verified via Playwright** (Galaxy S9+ UA, multiple seeds): all
  four flows — event (apply + advance), resupply (continue +
  advance), battle (choice + back), battle (choice + FLY) — pass
  with no pageerrors. FLY confirmed by checking
  `getComputedStyle(menu-root).visibility === "hidden"`,
  `!document.getElementById("starmap-root")`, and HUD strings
  ("HULL", "SHIELD", "BATTLEFIELD") in body text.

### 2026-05-21 — Frontier mode launch: drop dead `makeGalaxy`, fix SVG className write

**What changed**

Tapping NEW CAMPAIGN never opened the run-setup screen. Two latent
bugs from the DOM/CSS overhaul (a6f0f28):

1. `StartMenu._layoutRunSetup` still called `makeGalaxy(...)` to build
   a canvas backdrop. `makeGalaxy` was deleted from `starmap.js` when
   the canvas starmap was rewritten as DOM/SVG — the symbol isn't
   imported and isn't exported anywhere. The click handler threw
   `ReferenceError`, `showRunSetup` never flipped to true, and the
   tap silently did nothing.
2. After picking a faction, `updateStarmap` threw twice:
   - `edgesSvg = control.edgesSvg;` (line 439) was a bare-name
     assignment with no `let`/`const`. In ES-module strict mode that
     reads as a global lookup, so the implicit global never existed
     and the line ReferenceError'd on the first edge build.
   - `edgeEl.path.setAttribute("d", ...)` was followed by
     `edgeEl.path.className = ...` on an SVG `<path>`. `SVGElement`'s
     `className` is a read-only `SVGAnimatedString` getter — setting
     it raises `TypeError`. SVG class writes have to go through
     `setAttribute("class", ...)` or `classList`.

After both: run setup opens, faction pick works, starmap mounts (16
nodes / 22 edges in the smoke test) and the Frontier campaign is
playable again.

**Files touched**

| File | What |
|---|---|
| `src/input.js` | Dropped the `_runSetupGalaxy = makeGalaxy(...)` block from `_layoutRunSetup`. The run setup is fully DOM-rendered; `_drawRunSetup` is already a stub and `_runSetupGalaxy` had no readers. |
| `src/starmap.js` | Replaced bare `edgesSvg = control.edgesSvg; edgesSvg.appendChild(path)` with `control.edgesSvg.appendChild(path)`. Replaced `edgeEl.path.className = ...` with `edgeEl.path.setAttribute("class", ...)`. |

**Design decisions / gotchas**

- **The other `.className = ...` sites in starmap.js are safe.** They
  all assign to HTML elements (`div`, `button`), where `className` is
  a writable string. Only the `<path>` (and any other SVG namespace
  element) needs `setAttribute("class", ...)`. If a future change
  adds an SVG `<g>`/`<circle>`/etc., the same gotcha applies.
- **Dead canvas paths left in `_layoutRunSetup` and `_clickRunSetup`
  on purpose.** The DOM scrim absorbs the canvas clicks, so the
  legacy rect-based fallback is unreachable from the primary flow.
  Removing it would be a separate "kill dead canvas menu code"
  sweep — out of scope for the launch fix.
- **Verified end-to-end via Playwright** (Galaxy S9+ UA): tap
  Frontier → tap NEW CAMPAIGN → faction-grid opens with 4 cards →
  tap Terran → `starmap-root` appears in the body, `.starmap-node`
  count = 16, `path.starmap-edge` count = 22, no pageerrors.

### 2026-05-21 — Real fix for the startup black screen: restore InputManager.layoutOverlays

**What changed**

The previous "Fix black screen on initial load" commit (3f9e997) added
an `input.startMenu.draw(...)` call to the draw loop, assuming the
menu DOM wasn't mounting because nothing was calling its draw method.
It treated the wrong symptom — the draw loop never ran at all.

The DOM/CSS menu overhaul (a6f0f28) deleted
`InputManager.layoutOverlays(viewW, viewH)` because the overlays moved
to DOM, but it left the call site in `main.js#resize()`. `resize()`
fires synchronously during module init (line 262, `resize()` after
the listener is attached), BEFORE the RAF loop starts. The missing
method raises a TypeError, the module top-level execution dies, and
no frame ever paints.

This was undetectable from grepping the live deployment because the
fix commit was authored *after* the breaking commit was already in
the wild — every user loading the page since the menu overhaul has
been hitting a black screen, regardless of cache state.

Restored `layoutOverlays` as a five-line method on `InputManager`
that delegates to the still-existing per-overlay `layout()` methods
(missileBtn, fireBtn, spectateBtn, startMenu, admiralPanel — same
list the original method had).

**Files touched**

| File | What |
|---|---|
| `src/input.js` | Re-added `layoutOverlays(viewW, viewH)` on `InputManager`. |

**Design decisions / gotchas**

- **The per-overlay `layout()` methods still matter even with the
  DOM HUD.** `onDown` still hit-tests canvas rects on
  `missileBtn`/`fireBtn`/`spectateBtn`/`boostBtn`. Without `layout()`
  calls those rects stay at `{x:0,y:0,w:90,h:60}` — i.e. they'd
  steal taps in the top-left corner of the canvas. Don't be tempted
  to delete the call thinking "everything is DOM now."
- **`boostBtn` is intentionally NOT in the layout list.** It has no
  `layout()` method (its rect is set elsewhere or unused). Adding
  it would throw the same TypeError.
- **Verification was done in a real browser (headless chromium via
  Playwright with a Samsung S24 UA + viewport)** — `bodyChildren`
  now includes `#menu-root` and `#battle-root`, `activeScreen`
  reads `main`, the DEPLOY button text is present. The earlier
  static-analysis pass missed this because the bug is a runtime
  TypeError at module top-level, not a logic bug in any of the
  branches that get drawn.
- **The 3f9e997 fix is still correct** in the narrow sense that
  `startMenu.draw` needed re-mounting after the DOM overhaul
  dropped `drawHUD` from the loop — once `resize()` stops throwing
  the menu draw call WILL fire. Don't revert it. The two fixes
  together are what makes the page actually work.
- **Cache impact**: served `src/main.js` has `Cache-Control:
  public, max-age=60`. Users hard-refresh or wait 60s, then a
  conditional request returns the fresh module. No deploy step
  needed beyond saving the file — `/play/starfighter/` serves
  directly from this working tree.

### 2026-05-20 — AI targets PD + weapon modules before hull

**What changed**

AI ships were sending cannon fire at the dead centre of capital
targets — visually clean but tactically pointless, since the
defensive modules (PD turrets, broadside batteries, missile bays)
sat untouched until the hull bar finally dropped. With the recent
HP_TIER_MUL pass + the defense buff, capital hulls take 90–150s to
chew through; the player wants module destruction to feel like the
shortcut, and AI fire that lands on hull only contributes to grind.

Now: any AI ship aiming a cannon at a target with live modules
shifts its aim onto the next live module, in priority order:
**PD → broadside → missile bay / pod → torpedo bay → laser → hangar.**
Engines are intentionally NOT in the priority — they're rear-mounted
and the natural strafe angle usually clips something else first.
Fighter targets and any capital with no live modules left fall back
to centre aim.

The targeting helper (`pickAimModule`) is shared with the existing
`pickBomberAimModule` so bomber missile homing keeps the same
behaviour for free. As soon as a module is destroyed all aiming
ships re-target the next one on the priority list — which produces
natural focus fire (everyone hits the same PD turret first, then
moves on once it's gone).

**Files touched**

| File | What |
|---|---|
| `src/modules.js` | New `pickAimModule(target)` returns the module object (not just name) for general AI use; `pickBomberAimModule` re-implemented as a thin wrapper. New `moduleOffsetWorld(ship, module)` returns the world-space anchor — same math as `moduleWorldPos` but takes the module reference directly so callers holding it from `pickAimModule` skip the name lookup. Aim priority extracted as `AIM_PRIORITY` constant. |
| `src/ai.js` | New `aimPointFor(target)` returns the world-space aim point (preferred module world position, or target centre). `leadAim` rebuilt around it so every AI ship calling leadAim (currently fighter strafing in `flybyAI`) automatically gets module-aware aim. Velocity-lead still uses target velocity, not module velocity — they're identical since modules ride with the ship. |
| `src/ship.js` | `updateRingFire` (frigate ring cannons) shifts its lead-aim onto the preferred module when present. PD turrets keep their existing dispatch — they target missiles + small craft, not modules. |

**Design decisions / gotchas**

- **Priority order matches `pickBomberAimModule`.** Bomber missile
  homing already used this ordering and the behaviour was good;
  unifying the helper means there's one place to retune. If you
  want fighter cannons to deprioritise PD (because PD has too
  little HP to be a worthwhile target), edit `AIM_PRIORITY` in
  modules.js — bomber missile aim will follow automatically.
- **Engines not in the priority list.** Adding engines would make
  fighters strafing from behind always aim at engine modules,
  which on capitals are clustered close to the centre anyway and
  feels less satisfying as a tactical choice. Players can still
  manually aim at engines.
- **Focus fire is emergent.** Every ship picks the *first* live
  module in the priority list. With ~50 fighters all looking at
  the same battleship, they all aim at the same PD turret until
  it dies, then all shift to the next. Don't add randomisation
  inside `pickAimModule` — the focus-fire pattern is the win.
- **Velocity lead is target.vel, not module.vel.** Modules ride
  with the ship; their world-space velocity is identical. The
  one frame of staleness from `aimPt` being computed before the
  velocity application is irrelevant at the leading time scale
  (<0.3 s for fighter rounds).
- **Aim only — not target selection.** AI ships still PICK their
  target via the existing pack-role / proximity logic. The module
  priority only kicks in once a target has been chosen. Don't try
  to make a fighter pick its target based on module presence;
  that would route fighters away from other fighters and break
  the existing escort / pack dynamics.
- **`pickAimModule` returns the module object so callers can read
  `offset` without a second lookup.** Don't change it to return
  just a name — that would force `moduleByName[name]` everywhere
  it's used in AI paths.
- **Battleship `rush` mode aim left unchanged.** BB rush sets
  heading at the target so the ship physically moves toward it.
  Module aim shifts heading by a few degrees, which is
  imperceptible at capital ranges. BB broadside fire is auto-arc
  dispatch — it doesn't lead a specific point. Carrier has no
  cannons. Cruiser is missile/laser artillery, not a cannon
  platform.

### 2026-05-20 — Frontier UI overhaul: starmap + scrollable galaxy + emblem cards

**What changed**

The roguelite UI shipped as flat geometric chips on a small centred
panel — the chart felt like a debug view, not a campaign. This pass
rewrites the campaign UI to read like an FTL-style sector chart:

1. **Full-screen scrollable starmap.** The run map fills the viewport
   instead of sitting in a 1100×720 panel. World rect is ~1.55×
   viewport so the player drags to pan around the chart. Parallax
   stars (3 depth layers) + 2-3 procedural nebula clouds tint the
   backdrop. Map opens centred on the player's current position.
2. **Node art per type.** Nodes render as celestial bodies — battle
   stars (red corona with faction-tinted glint ring), elite stars
   (same with rotating 4-point flare cross), resupply planets
   (blue-green with atmosphere halo), event anomalies (purple swirl
   with rotating arcs + `?`), boss gas giants with rings tinted by
   the boss faction. Locked nodes desaturate; reachable pulse softly;
   current node gets a "you-are-here" second pulse ring.
3. **Curved travel routes** (quadratic Bezier with seeded
   perpendicular bulge). The active route from the current node has
   an animated dashed-flow shimmer.
4. **Drag-to-pan.** Pointer-down anywhere on the map starts a
   pan-drag. Threshold of 4px distinguishes tap vs pan; a pan
   release skips node-click routing, a tap fires the click as
   before.
5. **Top HUD strip** with act badge, faction commander label, and
   credit/fuel chips with icons. Right-edge fleet panel rebuilt
   with per-class procedural ship silhouettes + HP bars +
   iconified small-craft rows.
6. **Fuel-cost chips** along reachable edges (red if you can't
   afford the jump, blue if you can).
7. **Run Setup redesign.** Galaxy backdrop + faction emblem cards
   (procedural sigil roundels — Terran 5-point star, Reavers
   skull-triangle, Hegemony cross, Voidsworn hexagram). Selected
   card scales gently and gets the faction-coloured stroke. War
   record trophy at the card foot.

**Files touched**

| File | What |
|---|---|
| `src/starmap.js` *(new)* | Procedural art module. `makeGalaxy(seed,w,h)` builds deterministic 3-layer starfield + nebula clouds. `drawGalaxy` paints with parallax. `nodePositionsFor` spreads col/row grid across world rect with seeded jitter. `drawCurvedEdge` quadratic Bezier with flow shimmer. `drawNodeArt` dispatches per node type. `drawFleetMarker` (wing silhouette). `drawFactionEmblem` (per-faction sigils). `clampPan` keeps pan within world bounds. |
| `src/input.js` | `_layoutRunMap` rewritten — full-screen world rect with cached galaxy + node positions keyed on `(run.seed, run.act)`. `_centerPanOnCurrent` so a fresh open centres on the player. `_drawRunMap` rewritten — galaxy backdrop, curved edges, node art, fleet marker, fuel-cost chips, top HUD strip. `_drawFleetPanel` rebuilt with capital silhouettes + HP bars. New `_drawCapitalGlyph` for per-class shapes. `_clickRunMap` converts pointer coords to world space. `_startRunMapDrag`/`_moveRunMapDrag`/`_endRunMapDrag` handle pan + drag-vs-tap distinction. `StartMenu.pointerMove`/`pointerUp` extended for the deferred-click flow. `_drawRunSetup`/`_layoutRunSetup` rewritten for galaxy + emblem cards. |

**Design decisions / gotchas**

- **Click is deferred to pointer-up for the run map only.** Sub-
  overlays (Battle Choice, Event, Resupply, Run Setup) still route
  clicks on pointer-down because they're modal and don't need
  drag detection. Don't unify the two paths.
- **Drag threshold is 4px (squared 16).** Below = tap, above = pan.
  Bump to 6-8 if testers report missed taps on phones.
- **Pan is clamped via `clampPan`** with 80px slack so edge stars
  remain visible at the limits.
- **Galaxy + node positions cached on `(run.seed, run.act)`.**
  Changing acts mid-run regenerates both — by design, each act
  feels like a new region.
- **Node-position jitter** uses 0.18 scale at entry/boss columns
  (anchors) and 0.45 in the middle (organic chart feel).
- **The legacy `_drawNodeIcon` method is now dead code** — left in
  place to keep the diff focused. Safe to delete in a follow-up.
- **`drawFactionEmblem` accepts hex OR rgba()** via the internal
  `factionRgba` normaliser. Add HSL handling there if a race ever
  uses one.
- **`drawFleetMarker` sits 38px ABOVE the current node** with a
  pip line down — keeps the marker from obscuring the star.
- **The Run Setup galaxy uses a fixed seed (`0xfd00bea1`)** so the
  starscape stays consistent across opens. Don't randomise it.
- **Boss ring system is a flat ellipse**, not a proper occluded
  ring. The occlusion trick tripled draw cost; current read is
  "obvious gas giant" which is enough.

---

## Earlier changelog (condensed)

Older entries collapsed to date + headline + key load-bearing gotchas.
For full context (what changed, files touched, verification steps),
see `git log` — every entry shipped as its own commit.

### 2026-05-20 — Frontier roguelite campaign (replaces 100-mission campaign)

FTL-style roguelite: branching node maps per act, 3 acts per run,
capital ships carry hull damage between battles, small craft drip-
replenish, two currencies (credits + fuel). Loss = all capitals
destroyed. Mid-run save/resume mandatory. Replaces `src/campaign.js`
with `src/roguelite.js` + `src/modes/roguelite.js`. Save schema v3.

- **Per-instance capital identity** via `runtimeInstanceId` stamped
  during spawn. Manifest is an ordered array popped by `spawnRoster`
  in declaration order; relies on `Object.entries(roster)` iterating
  capitals before small craft (V8 insertion-order spec).
- **Only hull persists**, not shields/armor — legible match to the
  run-map HP readout; persisting regenerating defenses would be
  invisible to the player.
- **`MODES.tick` and `MODES.checkEnd` were dead** before this entry;
  now wired in `update()`. The `matchEnded` event was also subscribed
  but never emitted — now emitted from `update()` on the edge,
  gated by `game._matchEndedEmitted`.
- **Boss-win clears the run synchronously.** `main.js`'s
  `matchEnded` handler snapshots `runRef` up front because the
  `runEnded` dispatch nulls out `activeRun` mid-flight.
- **Energy gate skipped for roguelite battles** — the run itself is
  the energy commitment. Frontier chip opens an overlay rather than
  calling `_emitStart`.
- **`unlockedFactions` is the 5th-race extensibility gate.** Adding
  a race is data-only: entry in `RACES` + key in
  `DEFAULT_SAVE.roguelite.meta.unlockedFactions`.
- **Tunables at top of `src/roguelite.js`**: `STARTER_FLEET`,
  `FIGHTER_DRIP`, `BOMBER_DRIP`, `REPAIR_RATE`.

### 2026-05-20 — Defensive systems buff pass: shields, armor, PD, stations

Shields ~1.6–1.8× higher max with faster regen. Capital armor max
~1.5–1.6× with lower wearRate. PD count/range/RoF bumped across the
line. Stations significantly buffed (base hp 600 → 950, radius 70 →
80). Station-node weapon templates (`PD_BASE`, `MISSILES_BASE`,
`LASER_BASE` in races.js) bumped so every race's stations inherit.
Shield bubble offset factor 0.18 → 0.22 (floor 6 → 8). PD turret
draw radius 2 → 3.

- **PD anti-ship multiplier `PD_VS_SHIP_MUL = 0.22` untouched.** PD
  buff is anti-missile, not anti-ship. If PD shreds fighters again,
  lower the multiplier — don't revert the damage values.
- **`PD_BASE` change affects every station** because all races layer
  mods on top. Per-race differentiation requires explicit overrides.
- **Capital fights are 90–150 s** after this + the HP_TIER_MUL pass.
  Module destruction is the practical accelerator.
- **Shield offset floor 6 → 8.** Fighters get a 9px bubble. Preserve
  the floor — small classes need it.

### 2026-05-20 — Procedural SFX + SFX mute + shield impact visual

Four SFX voices (`sfxCannon`/`sfxMissile`/`sfxHit`/`sfxExplosion`) on a
separate `sfxGain` bus from music. Gameplay events
(`weaponFired`/`missileFired`/`hit`/`shipDestroyed`) routed through
`main.js` with camera-attenuated volume. Shield impact = outward
ripple + localized arc flare on bubble (up to 6 active flares,
0.45 s fade, stored ship-local so they ride manoeuvring capitals).
Settings overlay grew an SFX toggle row.

- **`sfxGain` separate from music compressor** — the whole point of
  the per-bus mute is independent muting.
- **Per-frame voice budget = 6.** Events still fire (cheap), only
  first 6 hit synth each frame. Gates at audio layer, not events.
- **AI weapon SFX probability-gated at 35%.** Cheapest knob if SFX
  mix gets too noisy in big brawls.
- **Player events bypass attenuation** via `isPlayer: true`.
- **`shieldHits` bounded at 6**, older entries shift out.
- **`recordShieldHit` localizes by `-ship.heading`** so arcs ride
  with the turning ship. Don't store world angles.

### 2026-05-20 — Engine fire + hull venting VFX scaling with damage

Engine modules route through `spawnEnginePlumeVFX` — dark smoke +
flame jets backward along ship heading, severity ramps with HP.
Below 70% hull HP every ship emits hull-vent smoke from random
points; above ~55% severity it sparks fire. Module smoke/fire rates
roughly doubled (`DAMAGED_RATE` 3.5 → 7, `DISABLED_RATE` 12 → 22).

- **Engine vents backward**, not outward — drift along
  `ship.heading + π`. Reorient via per-engine vector, not in the
  spawner.
- **Hull vent points sampled per-frame**, not stored. For "this
  section breached" effects later, add `ship.ventPoints`.
- **No off-screen culling.** Poisson rate gate keeps spawn counts
  manageable; add culling only on real perf regression.
- **Severity formula `(0.70 - hpFrac) / 0.60`** linear, clamped.
  Keep trigger at 0.70 — earlier and ships look broken on scratch.
- **Engine severity floor 0.45** ensures damaged-state engines emit
  meaningful smoke, not barely-there puffs.

### 2026-05-20 — Pinch zoom + non-linear capital HP + crater-style hull damage

Pinch-zoom (touch) + scroll-wheel (desktop) in spectator + admiral
only, clamped `[0.15, 2.0]`, default 0.5. `HP_TIER_MUL` table
(fighter 1.0 → carrier/BB 4.5) applied AFTER race deep-merge in
`resolveSpec`. Floating rind/orange-rim hull-hole artwork replaced
with dark sooty craters matching destroyed-module visual language.
Armor-flake palette muted to gray.

- **Zoom only in spectator + admiral.** Piloting keeps default —
  aim feel depends on known scale. Don't bolt on without an opt-in.
- **Pinch baseline drops on finger lift** — next gesture starts
  fresh, otherwise zoom lurches on re-engage.
- **HP tier mul AFTER race deep-merge.** Hegemony BB 1500 / Reavers
  BB 770 preserved proportionally. For race-specific scaling, add
  `hpMul` to the race spec.
- **Cell-hull-cost NOT scaled.** Only ~14% of BB hull drainable via
  cells; rest drains directly in `applyDamage`. Visible damage
  outpaces HP bar drop on capitals — intentional.

### 2026-05-20 — Custom Match: slider-driven roster redesign

Custom Match overlay rebuilt: wider 460px panels, per-class sliders
replace +/− buttons (8px visible track, full-row hit zone, tap-to-snap
+ drag both supported), 1×4 race row, ALLIED/HOSTILE headers.

- **Tap-to-snap + drag are the same gesture.** Pointer-down inside
  hit-zone sets value AND opens drag.
- **Slider hit zone is row-tall**, not just the 8px track. Inflated
  hit-zone is why the redesign earns its keep.
- **`_customDrag` cleared on CANCEL/START/pointer-up.** Stale drag
  would re-engage on next open via cached row reference.
- **`pointerMove`/`pointerUp` only fire while `menuActive`** — early
  return is gated so virtual-stick handling is untouched.
- **Race chip click re-seeds counts** to the new race's default
  roster. Swap race FIRST, then tune.

### 2026-05-20 — HUD polish: unified panel chrome + spectator vitals

`drawPlayerHUD` → `drawVitalsPanel`, reused for spectated ships
(outside admiral mode — admiral panel owns the bottom). Match-over
+ respawn now in centered panels with the standard chrome.

- **Spectate vitals suppressed in admiral mode** via `!game.admiralMode`
  guard in `drawHUD`.
- **`drawVitalsPanel` only reads fields present on every ship.**
  Missile block double-gated on `missileBtn && ship.spec.missile`.
- **Border tint keyed on `ship.isPlayer`, not side** — captured/recycled
  ships should still read as "me".
- **Match-over panel accent uses `SIDES[winner].primary`** — red on
  loss is deliberate.

### 2026-05-20 — Custom Match: player-configurable per-side rosters + races

`startGame` now dispatches via `MODES[mode].setup` with
`{ spawnRoster, promotePlayer }` helpers. `spawnRoster(game,
rosterOverride)` accepts per-side overrides. Custom Match overlay
populates `game.customRoster`.

- **Mode dispatch is dispatch-or-fall-through, not dispatch-only.**
  Open/defend hit the legacy path. Don't refactor MODES to require a
  hook.
- **Fleet-size multiplier bypassed for custom + campaign** — counts
  are deliberate.
- **Per-class cap 60.** Raising melts phones; renderer fill-time
  budget is the real ceiling.
- **Overlay layout recomputed on open**, not on resize. Reopen
  fixes stale rects.

### 2026-05-20 — Multi-stage salvos for BB + cruiser; PD damage nerfed vs ships

PD damage scaled to `PD_VS_SHIP_MUL = 0.22` against ships when
`p.fromKlass === "pd"`. BB broadsides + cruiser forward gained
`salvo: { shotsPerVolley, intraShotDelay }` — burst at current aim
instead of single shells. Per-shot heading recomputed for tracking.

- **Salvo continues past `c.firing = false`** — committed-volley
  feel. AI swapping targets mid-burst still delivers the volley.
- **`updateBroadsideFire` recomputes `sideVec` each shot** so turning
  battleships don't spray glued at initial vector.
- **PD nerf keyed on `p.fromKlass === "pd"`.** Tag any new PD-class
  source with this — don't introduce a second multiplier.
- **Cooldown starts at volley start, not end.** Don't drop cooldown
  below `shotsPerVolley * intraShotDelay` — volleys overlap and
  double-fire.

### 2026-05-20 — Per-type module art + capital-scale shield standoff

Per-kind module icons (laser barrel + lens, missile silo grid,
broadside cannon row, animated dual-barrel PD turret, hangar bay
chevron, torpedo cross-hair, engine nozzle ring). Shield offset
`Math.max(6, s.radius * 0.18)` — capitals get +28–32 px standoff.

- **PD turret rotation uses `performance.now() + ship.id * 0.37`** —
  phase keeps a swarm from spinning in lockstep.
- **Damage chip chrome paints OVER icons** at low HP — intentional.
- **Shield floor 6px preserves small-craft bubble.** Don't lower
  below 4.

### 2026-05-20 — Bigger modules, chip-damage VFX, pixel hulls per class

All MODULES radii bumped ~35% so visible disc = hit zone. drawShip
render mult 0.55 → 0.85. 5 damage stages per module (pristine →
crack → wedge → red-hot → crater) with transition spark + smoke.
Cell grid 3-4× finer per class (`CELL_HP` fighter 1 → station 5,
`CELL_HULL_COST` fighter 0.25 → station 1.0). `damageCellsInRadius`
budget-based, inner-first. `deadCells[]` cache on each ship.

- **`cell.hpMax` no longer per-cell** — uniform via `ship.cellHpMax`.
- **Budget cap (`remaining * 1.2`) lives in `applyDamage`**, not
  `damageCellsInRadius`. Raising it lets beam ticks punch ribbons.
- **Damage-stage thresholds duplicated** in `drawShip` + `moduleStage()`
  — keep in lockstep.
- **Wounded-cell halo skips below `screenRadius < 12px`** — retune
  on camera ZOOM change, don't remove.
- **`auditModuleLayout()` dev-only** via `import.meta.env.DEV`.

### 2026-05-19 — Fighters/bombers stop dodging; per-capital fighter escorts; bombers flank

Fighter `danger` weight 1.95 → 0.55, bomber 2.20 → 0.85.
`bigShipDanger` excludes the current target. `MAX_APPROACH_TIME`
10 → 16 s; forced break-off on PD bubble entry removed. Per-capital
escorts via `ESCORT_SIZE` map (frigate 5, cruiser 10, BB 15, carrier
10). Bomber AI renamed `bomberStandoffAI` → `bomberFlankAI` —
perpendicular-aft flank slot.

- **Target-exclude is targeted.** Fighters still flinch from OTHER
  capitals. Don't fold new avoidance classes (mines, hazards) into
  this exclusion without thought.
- **No pack-leash on escorts.** The bomber IS the threat — chasing
  is correct. If you add a leash, use `escortOf` lookup.
- **`ESCORT_SIZE` in game.js is the single source.** Legacy
  `spec.escortSize` field is gone — don't reintroduce.
- **Fleet sizes balloon (~103 ships/side Terran, ~128 Hegemony).**
  Frame rate lever is `ESCORT_SIZE`, not the roster.
- **Bomber flank uses target heading where available** — target
  velocity would park bombers behind sliding cruisers.

### 2026-05-19 — Cruiser refit: long-range artillery (cluster + siege missiles + laser)

Cruiser dropped `weapon` + `firingMode: "forward"` entirely. Now:
2× cluster missile pods (split into 5 children on approach), 1×
siege missile (240 dmg, 18 s, hp 10), single bow heavy laser.
`aiOrbit: 880 → 1500`.

- **Cluster `missilePods.damage` is per CHILD now** (5 × 30 = 150).
- **Children home on parent's target**, spread is spatial only —
  forces multiple PD intercepts.
- **Children don't carry `.cluster`** — only pod-spawned missiles
  do. No recursive cluster.
- **Siege shares the `"missile"` subsystem gate** with cluster pods.
- **`s.weapon` may be undefined** (cruiser + carrier). AI code that
  touches `s.weapon.x` must guard.
- **AI orbit 1500** feels right at 4500–11000 px maps; shrink maps
  → dial it down.

### 2026-05-19 — Heavy laser is now a 3-second sustained beam; AI dodges it

BB heavy laser `beamDuration: 0.45 → 3.0`. Damage spreads as
`dps = damage / beamDuration`. Beam re-anchors to owner bow each
tick. Dies on owner death or laser-subsystem kill. AI dodges via
`beamAvoidance` overlay applied to every class.

- **Continuous damage routes through `applyDamage`** — same
  shield/armor/subsystem/hull pipeline as a cannon round.
- **Subsystem hits route through node closest to target centre** —
  almost always engine on a fleeing target. Intentional.
- **`beam.side` is the OWNER's side** — friendly avoidance skips via
  `beam.side === ship.side`.
- **AI force-clears `firing` on high urgency** — looks decisive,
  prevents re-acquiring beam-camped targets.
- **No path-prediction lookahead** — adds oscillation near beam
  edges. Don't add without verifying AI doesn't dither.

### 2026-05-19 — Destructible subsystem nodes (gun / engine / missile / laser)

Ships carry `subsystems` array — hit-routed nodes that disable
behaviors when destroyed (gun → cannons off, engine → drift,
missile → pods off, laser → beam off). PD turrets intentionally
excluded (swarm, not a node). `applyDamage` Step 3 absorbs into
node, overflow continues to hull.

- **Routing opt-in via aim** — player has to land in the hit-radius.
  AI aims at centre, so AI hits only graze nodes occasionally —
  deliberate player edge.
- **Overflow continues to hull** — killing blows aren't wasted on
  node HP. Avoids the spongy-ship trap.
- **`hpFrac` is fraction of `ship.hpMax`** — race HP overrides scale
  subsystem HP for free.
- **`hasWorkingSubsystem(ship, kind)` returns true if no nodes of
  that kind exist** (e.g. carrier has no `gun`). Always go through
  the helper.
- **Engine kill behavior differs by class** — aircraft coast
  (`vel *= 0.995`), capitals drift (`vel *= 0.99`).
- **Hit point comes from `applyDamage(... hitPos)`**. New callers
  MUST supply `hitPos` or the subsystem step bails.

### 2026-05-19 — Ship visuals, opponent picker, persistent wreckage

`src/wreckage.js` (new) — destroyed ships leave drifting fractured
hulks, damaging hits chip debris fragments. Both persist for the
match. Arena gained an OPPONENT picker (random + four races; muted
in waves/daily). Ships got engine plumes, race-accent spine,
cockpit/bridge markers, panel lines, HP-driven scorch marks.

- **Wreckage caps: 160 wrecks, 500 debris.** Oldest dropped on
  overflow. Don't age them out by time — persistence is intentional.
- **Hull-chunk splitter shares centroid as fan apex** — adjacent
  chunks share their edge so the union reproduces the silhouette.
  Last chunk wraps `poly[V % V] === poly[0]`.
- **`SIDES.blue.primary === "#5cf"`** (3-hex). `darken()` handles
  both 3- and 6-hex; don't assume 6.
- **Engine plume tint keyed on `ship.side`**, not race — team ID at
  a glance even if races mix later.
- **Battle scars use deterministic hash of `ship.id`** — stable
  frame-to-frame without storing scar state on the ship.
- **`mergeWithDefaults` deep-merges menuSelection/settings** — new
  additive fields don't need a schema bump.

---

<!-- Append new dated sections above this line. Keep entries terse. -->
