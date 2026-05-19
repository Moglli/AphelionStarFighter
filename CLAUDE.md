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

### 2026-05-19 — Heavy laser is now a 3-second sustained beam; AI dodges it

**What changed**

The battleship heavy laser used to apply its full damage instantly
and linger for ~0.4 s as decoration. It is now a sustained beam:
damage spreads evenly across 3 s (`dps = damage / beamDuration`),
the beam re-anchors to the owner's bow each tick so it tracks the
firing ship, and it dies early if the owner dies or loses its laser
subsystem mid-fire. AI ships now compute a perpendicular escape
vector when they wander into an enemy beam's danger corridor and
blend it into their aim (aircraft) or thrust (capitals).

**Files touched**

| File | What |
|---|---|
| `src/classes.js` | Battleship `heavyLaser.beamDuration: 0.45 → 3.0`. Cooldown unchanged at 5.0 → recovery window between beams is 2 s. Comment added clarifying the dps formula. |
| `src/races.js` | Voidsworn `heavyLaser.cooldown: 4.0 → 4.5` so the recovery window after a 3 s beam is still ~1.5 s (their dps is higher anyway). |
| `src/ship.js` | `updateHeavyLaser` now writes `dps`, `duration`, and `hit: null` on the beam record; drops the `applied: false` flag. |
| `src/game.js` | `applyAndAgeBeams` rewritten: every tick re-anchors the beam origin to the live owner's bow, deals `beam.dps * dt` damage if the target is in range, and kills the beam (`ttl = 0`) when the owner is dead or has lost its laser subsystem. Uses the existing `hasWorkingSubsystem` helper now imported from `ship.js`. |
| `src/hud.js` | `drawBeams` reads `beam.duration` (not the old 0.45 magic constant) for its alpha curve and adds a small per-frame width jitter so the sustained beam reads as "live". |
| `src/ai.js` | New `beamAvoidance(ship, beams)` + `applyBeamAvoidance(ship, world)` overlay. Called at the end of `updateAI` for every class (including carriers and idle ships with no target). Aircraft blend the escape vector into `c.aim` and stop firing while inside the danger window; capitals add it to `c.thrust` so they sidestep. |

**Design decisions / gotchas**

- **Continuous damage uses `applyDamage`**. Each tick the beam routes
  through the same shield/armor/subsystem/hull pipeline as a single
  cannon round; the subsystem step still works because `hitPos` is
  the target's current position. This means a sustained beam slowly
  bleeds the shield, then armor, then nodes, which feels right.
- **Subsystem hits during a beam**. Because the impact point is the
  target's centre, hits route through whichever node is closest to
  the centre. That's almost always the engine on a fleeing target,
  which is intentional — a 3-second beam on the engine is a clean
  way to immobilise a capital.
- **Beam dies on owner death OR laser-node kill**. Don't add new
  paths that keep the beam alive past these conditions — the
  player's main counter to a battleship's beam is destroying the
  laser node mid-fire and they need to see the beam cut.
- **`beam.side` is the OWNER's side**. The avoidance check skips
  friendly beams via `beam.side === ship.side`. Don't switch this
  to target side or you'll have allies dodging their own fleet's
  beams.
- **AI overrides on high urgency**. When a beam is about to clip an
  aircraft, `firing` is force-cleared so the AI doesn't keep its
  guns hot while breaking off — looks more decisive and prevents
  it from re-acquiring the same beam-camped target.
- **No path-prediction lookahead**. Avoidance uses current position
  only. Capitals are slow enough that a one-frame lookahead doesn't
  buy much, and aircraft turn fast enough to escape with a ramping
  blend. Don't add motion-prediction without checking that AI ships
  don't oscillate near beam edges.

**How to verify**

```bash
npm install
npm run build        # production build — should succeed
npm run dev          # opens Vite dev server
```

In-game:
- Pick **arena**, race **Terran**, opponent **Voidsworn**, fly as
  **Battleship**. Their battleship will fire a sustained white-blue
  beam at you. It should last ~3 s and track you across the field.
- Watch friendly fighters near a Voidsworn beam: they should turn
  away from the beam line and skip firing while crossing it.
- Disable the enemy battleship's laser node (bow cross glyph): the
  beam should cut out immediately if you destroy it mid-fire.
- Park a friendly cruiser broadside-on to the beam line: it should
  drift sideways out of the corridor on its own.

### 2026-05-19 — Destructible subsystem nodes (gun / engine / missile / laser)

**What changed**

Ships now carry destructible `subsystems`: an array of nodes glued to
the hull at fixed local positions. A projectile hit that lands within
a node's hit-radius routes damage into the node first; overflow falls
through to hull. Destroying a node disables the corresponding
behavior:

- **gun** destroyed → forward fire / broadside cannons stop emitting.
- **engine** destroyed → capitals dead-stop, fighters/bombers coast
  on residual momentum with light drag (sitting ducks, but still
  pointable so they can fight back).
- **missile** destroyed → missile pods + fighter missile rack go cold.
- **laser** destroyed → battleship heavy laser refuses to fire.
- PD turrets are intentionally NOT on the subsystem list (they're a
  swarm; killing the whole ring would feel binary). Each PD turret
  still has its own cooldown as before.

Each node has its own glyph + color (gun yellow rectangle, missile
magenta capsule, laser white cross, engine cyan nozzle) and a
brightness that softens with damage. Destroyed nodes draw as a sooty
crater with radiating cracks and a flickering ember.

**Files touched**

| File | What |
|---|---|
| `src/ship.js` | `SUBSYSTEM_LAYOUTS` table + `createSubsystems`, `resetSubsystems`, `hasWorkingSubsystem`, `findHitSubsystem`. `updateShip` reads gates once per tick and branches movement + firing on them. `drawEnginePlume` skips when engines are destroyed. New `drawSubsystems` + `drawHealthyNode` + `drawDestroyedNode` render the nodes after legacy decorations so they sit on top. Legacy heavy-laser muzzle dot is suppressed when a laser subsystem exists at the same spot. |
| `src/game.js` | `applyDamage` gains a Step 3: subsystem absorption between armor and hull. Overflow continues to hull. Emits `subsystemDestroyed` on kill; the existing `hit` event now also fires with `layer: "subsystem"`. `promotePlayer` calls `resetSubsystems` so a recycled candidate ship comes out whole. `spawnHitDebris` accepts the new layer. |
| `src/types.js` | `HitLayer` gains `"subsystem"`. New `SubsystemKind` typedef. `EventPayloads.subsystemDestroyed` documented. |

**Design decisions / gotchas**

- **Routing is opt-in via aim.** The player has to land hits on the
  node's hit-radius to disable it; spread fire still wears down hull
  as before. AI ships aim at ship center, so AI hits only graze
  subsystems occasionally — a deliberate edge for the player.
- **Overflow continues to hull.** A killing blow that lands on a
  node spends the node's remaining HP first, then bleeds through.
  This avoids the "spongy ship" trap where focusing fire on a node
  becomes a TTK-extending mistake.
- **`hpFrac` is a fraction of `ship.hpMax`**, so race overrides that
  change ship HP also scale subsystem HP without separate balancing.
- **`hasWorkingSubsystem(ship, kind)` returns true if no nodes of
  that kind exist.** A carrier has only an `engine` node — so
  asking about its `gun` returns true and PD/replenishment continue
  to work. Do not check `kind` directly; always go through the helper.
- **Engine kill behavior** differs by ship class. Aircraft (fighter,
  bomber) coast with `vel *= 0.995` so they slow gradually and
  remain pointable. Capitals snap-stop is replaced with `vel *= 0.99`
  so the wreck keeps drifting from its last burn. Aircraft model
  branch is still chosen first; the engineOk gate is inside it.
- **Hit point comes from `applyDamage(... hitPos)`**. The two callers
  (cannon-on-ship in update, beam-on-ship in beam-application) pass
  `p.pos` and the target's current position respectively. Don't add
  a third caller without supplying `hitPos`; the subsystem step bails
  out without it.

**How to verify**

```bash
npm install
npm run build        # production build — should succeed
npm run dev          # opens Vite dev server
```

In-game (arena mode, pick Battleship as your ship):
- Find an enemy battleship/carrier and aim at its rear-most node:
  the engine glyph should flicker on impact. After enough hits the
  node goes black with an ember and the ship stops moving.
- Aim at the front laser-cross: after destruction it stops firing
  its heavy beam.
- Aim at the side capsule (missile pod): after destruction the ship
  stops launching missiles.
- Strafe a fighter with cannon: small chance of clipping its tiny
  engine node, after which it drifts and decelerates.

### 2026-05-19 — Ship visuals, opponent picker, persistent wreckage

**What changed**

1. **Persistent map litter** — destroyed ships now leave a charred,
   fractured hull on the map that drifts and spins to rest. Damaging
   hits (to armor or hull, not shield) chip small debris fragments
   off the impact point. Both kinds persist for the remainder of the
   match.

2. **Opponent picker for arena mode** — start menu has a new OPPONENT
   row: Random (legacy behavior) + the four races. Waves/Daily ignore
   the choice (they pick their own hostiles), and the row renders
   muted in those modes.

3. **Ship visual enhancements** — engine plumes, race-accent spine
   stripes, cockpit/bridge markers (per class), faint panel lines,
   and HP-driven scorch marks. Plumes pulse per-ship with a phase
   tied to `ship.id` so a swarm doesn't strobe in lockstep, and they
   scale with speed so stopped capitals don't blast exhaust.

**Files touched**

| File | What |
|---|---|
| `src/wreckage.js` *(new)* | `createWreck`, `createDebrisBurst`, update + draw, hull-chunk splitter, MAX caps. |
| `src/ship.js` | Exported `getHull`. Rewrote `drawShip` to add engine plumes, panel lines, spine, cockpit/bridge tower, battle scars. Added `ENGINE_PORTS` and `COCKPIT` tables and helper functions. Imported `RACES` for accent colors. |
| `src/game.js` | Added `game.wrecks` and `game.debris` arrays (cleared in `startGame`/`restart`). `applyDamage` now sheds debris on hull/armor hits; `handleShipDestroyed` pushes a wreck + outward debris shower. Per-tick `updateWreck`/`updateDebris`. Added `game.opponentRace` from `opts.opponent`. |
| `src/main.js` | Draws wrecks under ships, debris over ships. |
| `src/modes/arena.js` | `setup` honors `game.opponentRace`; falls back to random. |
| `src/input.js` | Added OPPONENT chip row + `selectedOpponent` state + persist/emit. Tightened menu inter-row spacing so the extra row still fits in a 600px-tall viewport. `_drawChip` gained a `dim` parameter for the disabled state. |
| `src/save.js` | `menuSelection.opponent: "random"` added to defaults. `mergeWithDefaults` already deep-merges menuSelection, so no schema bump needed. |

**Design decisions / gotchas**

- **Wreckage caps**: 160 wrecks, 500 debris. On overflow, oldest are
  dropped (`array.splice(0, ...)`). Don't try to age them out by
  time — the user explicitly wants persistence.
- **Hull-chunk splitter** in `wreckage.js` shares the centroid as a
  fan apex. Adjacent chunks share their shared edge so the union of
  pieces (before they drift) exactly reproduces the original hull
  silhouette. The last chunk wraps `poly[V % V] === poly[0]` so the
  silhouette closes.
- **`SIDES.blue.primary === "#5cf"`** (3-hex shorthand). `darken()`
  in `wreckage.js` handles both 3- and 6-hex forms; do not assume
  6-hex when reading side palette colors.
- **Engine plume tint** is keyed off `ship.side`, not race — so
  team identity reads at a glance even if races mix on a team in
  the future.
- **Battle scars** use a deterministic hash of `ship.id` so positions
  are stable frame-to-frame without storing scar state on the ship.
- **Menu layout math**: each row gap is `chipH + rowGap + 8` = 74 px.
  Total menu height from title → start-button bottom is ~494 px.
  `titleY` clamps at 48 so a 600-tall viewport still fits.
- **Save migrations**: `mergeWithDefaults` adds missing keys to
  `menuSelection`/`settings`/etc., so new additive fields don't need
  a schema bump. Reserve the version bump for structural changes.

**How to verify**

```bash
npm install
npm run build        # production build — should succeed
npm run dev          # opens Vite dev server
```

In-game:
- Pick arena mode, pick any opponent race, START.
- Shoot a fighter: small fragments chip off, hull disintegrates into
  2 chunks on death and drifts.
- Shoot a capital: 3–4 chunks split apart on death; many more
  fragments shower out.
- Take damage on your own hull: scorch marks accumulate.
- Try waves/daily: OPPONENT row should be muted and unclickable.

---

<!-- Append new dated sections above this line. Keep entries terse. -->
