# CLAUDE.md — Session notes for Aphelion Star Fighter

Context for future Claude/human sessions: what the project is, where
things live, the load-bearing gotchas, and a condensed change history.
**When you make non-trivial changes, append a Changelog entry** — date
+ headline + only the *non-obvious* gotchas. No file lists, no
verification logs, no methodology asides; `git log` has those.

---

## Project at a glance

- **Aphelion Star Fighter** — 2D canvas space combat, shipping to
  iOS/Android via Capacitor.
- **Stack**: Vite + vanilla JS (ES modules) + Capacitor. No TypeScript,
  no framework. `CanvasRenderingContext2D` for rendering; DOM+CSS
  overlays for UI.
- **Entry points**: `index.html` → `src/main.js` (canvas, fixed-step
  loop, draw order) → `src/game.js` (match lifecycle, damage, update).
- **Tooling**: `npm run dev`, `npm run build`, `npm run cap:sync`.
- **Test hooks**: `window.game`, `window.input`, `window.saveStore`,
  `window.audio` exposed for Playwright probes (`/tmp/aphel-*.mjs`).
  Don't remove them.

## Module layout (`src/`)

| File | Role |
|---|---|
| `main.js` | RAF loop, canvas/camera, draw order, event→audio wiring, run-choice routing. |
| `game.js` | `createGame`/`startGame`/`update`/`restart`, `spawnRoster`, `applyDamage`, surrender/capture, spectate, match-end. |
| `ship.js` | `createShip`, `updateShip` (movement + all weapon fire paths), `drawShip`, `HULLS[race][klass]`, `getHull`. |
| `ai.js` | Per-ship AI: target/aim, throttle, fire, escort leash, admiral posture, pack/carrier AI. |
| `classes.js` | Base per-class specs + `SIDES` palette. |
| `races.js` | Per-race overrides + rosters. `resolveSpec(race, klass)` deep-merges. |
| `modules.js` | Destructible module layouts (`buildModules(klass, spec, poly)`), per-turret PD, aim priority. |
| `components.js` | Shipyard library, `applyDesign`, multi-mount aggregation, `computeDeltas`, `SLOT_VISUALS`. |
| `shipyard.js` | Credit economy (`computeRunPayout`/`bankRunPayout`), buy/equip/setHull/paint, tier scaling. |
| `ship-icons.js` | `classIconSvg` — SVG silhouettes from hull polygons. |
| `projectile.js` | Cannon + missile entities, homing + cluster-bloom. |
| `particles.js` | Impact/damage VFX. |
| `sprites.js` | Pre-rendered hull sprites; cell grid (`buildCells`), `snapOffsetToLiveCell`, `snapModulesSymmetric`, `projectileBlockHit`. |
| `wreckage.js` | Persistent hulks + impact debris. |
| `arena.js` | Arena bounds, starfield, map presets. |
| `input.js` | Touch/mouse/keyboard, virtual sticks, menu-state builder, overlay flags + callbacks. |
| `menus.js` | DOM menu/overlay rendering (`StartMenu`). |
| `starmap.js` | Frontier run-map: scrollable starmap, node art, tab bar, fleet/dossier panels. |
| `hud.js` | In-game HUD (minimap, vitals, target panel, action cluster, AAR). |
| `audio.js` | Web Audio synth — procedural SFX voices + UI tap audio. |
| `events.js` | Pub/sub bus (Set-backed). |
| `save.js` | Versioned localStorage SaveStore (`CURRENT_SCHEMA_VERSION`, `MIGRATIONS`, `mergeWithDefaults`). |
| `roguelite.js` | Frontier campaign: run state, acts, detour-graph, events, traits/boons, capture, reputation. |
| `modes/*.js` | Mode hooks: `setup`/`tick`/`checkEnd`. `modes/index.js` is the registry. |
| `energy.js` | F2P energy/stamina gating. |
| `rally.js` | Minimap rally-point command layer. |
| `cosmetics.js`, `hangar.js`, `progression.js` | Meta-progression + cosmetics. |
| `types.js`, `vec.js` | JSDoc typedefs; 2D vector helpers. |

## Key conventions

- **No framework.** Plain ES modules; classes only for clear lifecycle.
- **Comments explain *why***, above non-obvious logic.
- **Event bus, not cross-module reach.** Gameplay emits domain events;
  `audio.js`, `progression.js`, `main.js` subscribe.
- **Save schema**: additive fields ride `mergeWithDefaults` (deep-merge).
  Bump version only on incompatible *shape* changes. `unlockedFactions`,
  `ownedComponents`, `ownedHulls` union-merge.
- **Damage layers**: shield → armor (capitals only) → module → hull.
  Missiles bypass shields; lasers + fighter cannons cost 50% from shield.
  Module step routes hits to nearest node; overflow continues to hull.
- **Fixed timestep**: `update(game, 1/60)`. No `performance.now()` polling.
- **Coordinate space**: world in pixels; camera `ZOOM=0.5`. Pinch/scroll
  zoom only in spectate + admiral.
- **Spec mutation hazard**: `resolveSpec` returns **shallow-merged refs**.
  Per-ship patches (`applyWingCommanderEffect`, `applyBoonPatches`,
  `applyTraitFleetPatches`, `applyDesign`, captain traits, perks) **must
  clone on descent** (`spec.x = {...spec.x}`) before mutating, or they
  poison every other ship of that race/class.
- **CSS overlay trap**: every `.menu-screen.active` overlay with a
  centered panel needs explicit `flex-direction: column` (base rule
  is `display:flex` with no direction → row). Recurring bug. Global
  `box-sizing: border-box` reset at top of `style.css`.
- **SVG class writes**: use `setAttribute("class", …)` / `classList`,
  never `.className` (read-only on SVG elements).

## Render order (`main.js#draw`)

Bg + starfield → camera xform → arena bounds → wrecks → ships → debris
→ projectiles → beams → restore → HUD → virtual sticks.

- World draws inside camera transform; HUD after `ctx.restore()`.
- `drawShip` owns its save/translate/rotate/restore.
- `getHull(race, klass)` → unit-space polygon (~[-1,1]); scale by
  `spec.radius`. Hull polygons are CCW + y-symmetric.

## Subsystem cheat sheet

- **Modules**: `buildModules(klass, spec, poly)` walks per-class
  `LAYOUTS` with `requires(spec)` predicates — pass the **fully
  resolved** spec (race + override + boons + traits + design). Every
  subsystem (gun, cannon, broadside-{port,stbd}-{0..2}, laser-{fore,aft},
  missile-*, hangar, torpedo-tube-*, shield-generator-*, engine-N,
  per-turret pd-N) gates its fire path on its module.
- **Multi-mount weapons**: `spec.weapon` stays **scalar** (primary, read
  by ai/hud/game/roguelite); extra mounts go in `spec.weaponExtras[]`.
  `spec.missilePods`/`spec.heavyLaser` accept scalar OR array;
  createShip flattens to `ship.weapons[]`/`podSpecs[]`/`laserSpecs[]`
  with per-mount state + legacy aliases (`ship.cooldown`, etc.).
- **Carrier replenishment**: launches an escort every
  `spec.replenish.{fighter,bomber}` sec; reinforcements inherit boons.
- **Pack AI**: `game.packs` rebuilt each tick from `packId`. Bombers
  outrank role pref. Escort leash (`escortOf`) covers fighters + bombers;
  picks threats relative to escorted capital.
- **Surrender/capture**: capitals strike at (≥75% weapons + ≥65% blocks)
  OR (≥50% engines + ≤35% hull) — added blocks-loss gate prevents
  weapon-loss-only surrender, hullThreshold prevents engine-only
  surrender of a healthy armed capital. Small craft surrender on
  engine-only. `neverSurrender` flag opts out. Surrendered =
  untargetable + drifts; **every target-picker must skip `o.surrendered`
  independently** (no chokepoint). Pre-locked missiles still land on
  surrendered ships (no immortality from in-flight ordnance); only NEW
  acquisitions skip hulks. Frontier captures surrendered enemy capitals
  preserving race.
- **Player/commander model (Frontier)**: NO respawn. Death drops to
  spectate; `game.playerKIA` (failed survival roll) is the *only* KIA
  signal — never sniff ship state. Voluntary spectate hands ship to AI;
  `exitSpectate` re-takes if alive, else eliminated — never spawns fresh.

## Shipyard / design pipeline

- Persistent player ship built between runs from in-run credits
  (`KILL_VALUES` + node/act/boss/war-won bonuses). `DEFAULT_PLAYER_DESIGN`
  === stock Terran fighter byte-for-byte. `createShip(..., {design,
  boons, fleetTraits})` applies design last. `promotePlayer` reads
  `design.hull` to spawn at any class. **`promotePlayer` is idempotent**
  — legacy modes double-called it and span ghost fighters.
- Tier scaling: enemy quantity + class scale with player tier
  (`applyTierScalingToRoster`); bosses get class ensures but damped
  quantity. `run.playerTier` locked at run start.
- **Shipyard blueprint** derives dot positions from `buildModules`
  (single source of truth, post-snap), grouping by category (weapon/
  missile/pd/engine/hangar). Abstract slots (shield, armor) fall back
  to `SLOT_VISUALS`.

## Frontier campaign (`roguelite.js`)

- Terran officer career: 5 acts = 5 ranks. One defeat ends the run
  (`run.endReason` set on any non-blue `matchEnded`). Starter fleet is
  tiny (4 fighters, no capitals); capitals join via `PROMOTION_FLEET[act]`.
- **Detour-graph acts**: `COLS_PER_ACT=6`. Combat spine (cols 1..4,
  mandatory) + green detours at fractional cols (+0.5, extra jump/fuel).
  Boss bypasses `scaleRoster`.
- **Fuel** drains 1/jump in-act, no combat refund; `applyPromotion`
  tops to `ACT_REFIT_FUEL=8` (Math.max, never `+=`). `isStranded` ends
  the run on 0 fuel + no affordable edge.
- **Reputation**: `battleReputationPreview` is the single source for
  preview + spawn. Allied reinforcements (rival faction at Friendly+)
  spawn blue tagged `alliedReinforcement` — **must not persist**
  (recount skips them). Grudge scales red roster. Coalition excluded.
- **Wings**: per-class multi-wing, bounds 2–5. Commands (free/hold/
  press/defend-capital/target-class) stamped on spawned ships, drive
  ai.js. Named commanders carry stat-mutating traits.
- **Commander perks**: capitals + wing commanders share one XP/level
  track. `COMMANDER_PERK_LEVELS=[2,3,4,5]` grant one pick each from
  `COMMANDER_PERKS` (8 perks). Picks spent in COMMANDERS dossier tab;
  applied at spawn via `applyCommanderPerks` (clone-on-descent).
- **Event-choice results** show resource-delta panel; stamp
  `_lastEventResult` *after* `refresh()`.

---

## Changelog (condensed)

Newest first. Date + headline + load-bearing gotcha only.

### 2026-06-07 (Free-Form Custom Ship Editor — dev-gated authoring + test-fly)
- **A free-form `customShip` doc (src/customships/format.js) is lowered by a
  pure `compileCustomShip` (compile.js) into createShip's existing shape
  (specOverride + design.hullPoly + moduleList + cellOverride), so the whole
  fire/render/AI/damage pipeline is reused unchanged.** Engine edits are all
  additive + opt-in: createShip gained `moduleList`/`cellOverride` params,
  `modules: moduleList ?? buildModules(...)`, and a new `mothership` tier in
  sprites.js CELL_GRID/CELL_HULL_COST. New save arrays `customShips` /
  `customModules` ride mergeWithDefaults' `...loaded` spread — no schema bump.
- **GOTCHA — snapModulesSymmetric is SKIPPED for custom layouts** (`if
  (!moduleList) snap…`). The author's exact module offsets must survive to
  test-fly; the symmetry snap would pair/move them. The cell-binding loop below
  it still runs (it only tags `moduleName`, never moves a module), so module
  kills still tear out the right block cluster. This was the #1 risk.
- **GOTCHA — `resolveSpec(race,"mothership")` returns `{}`** (no base CLASSES
  entry), so the compiler's specOverride must be a COMPLETE self-contained spec.
  It also sets EVERY weapon system explicitly — authored object or `null` — and
  fills weapon sub-fields (salvo/capacity/cluster) so a tier base class can't
  leak a phantom weapon through deepMerge onto a ship that didn't place it.
- **GOTCHA — weapon FIRING is spec-driven; modules are destructible gates.**
  An ABSENT module doesn't suppress fire (`!mod || !mod.disabled`) — EXCEPT
  broadside, which needs live `broadside-{port,stbd}-N` modules for muzzle
  origins. So all broadside modules compile to ONE weapon entry fed by N
  position modules; one-weapon-per-module would loose the whole battery N×/tick.
  Forward guns are independent mounts → one weapon each. Per-weapon
  `projectileColors:{blue,red}` is mandatory (createProjectile indexes by side).
- **Test-fly** threads `playerModuleList`/`playerCellOverride` through
  modeConfig → startGame → promotePlayer → createShip. Both reset to null on
  every match start, so a test-flown custom ship never leaks into campaign play.
  TEST FLY does NOT start a match directly — it ARMS the compiled ship
  (`main.js#_pendingTestFly`) and opens the real custom-battle configurator
  (`input.startMenu.showCustom`), so the player picks opponents/roster/map. The
  menu start handler injects the armed ship's player params into the next
  match's modeConfig and clears the arm; a disarm guard drops it if the player
  closes the configurator without starting (no leak into a later normal match).
  Editor opens from a dev-gated MORE-panel row via the event bus
  (`events.emit("dev:openShipEditor")`); probe surface `window.dev.editor()` +
  `window.customShip`. Forward-gun `spec.arc` gate in fireForwardWeapon is the
  only behavioural change to an existing fire path (no-op unless arc set).
- **GOTCHA — block SIZE is held constant under scaleMul, not block COUNT.**
  `sprites.js#scaledCellGrid(klass, scaleMul)` grows cols/rows with scaleMul so
  cell px size (`R*2/cols`) stays fixed — a 2× custom hull gets 2× the blocks,
  same size, not 2×-bigger blocks. buildCells gained an opt-in `gridOverride`
  (null → per-class CELL_GRID, zero regression); the compiler bakes the scaled
  grid into `cellOverride.grid`, createShip passes it to buildCells, and the
  editor preview uses the SAME helper so what you author matches what you fly.
  scaleMul 1 returns the tier grid exactly. Capped 140×84 so a 3× super-capital
  can't explode the cell count.

### 2026-06-03 (fix: Dev Mode tools were unreachable — no on-screen route + broken overlay mount)
- **Two bugs left every Dev Mode feature (Battle/Ship/Map/Platform designers +
  sim controls) inaccessible.** (1) The DevOverlay only opened via the `~`
  KEYBOARD key — but the game is touch-first (Capacitor, no keyboard), so
  flipping Dev Mode in Settings surfaced nothing. (2) `DevOverlay._mount()`
  called bare `host.appendChild(el)` instead of `this.host` (`host` is a
  constructor param, out of method scope) → ReferenceError on construction, so
  the overlay never mounted even via `~`. Both had to be fixed; the FAB alone
  would still have hit the mount crash.
- **Fix**: `devoverlay.js` `host`→`this.host`. `main.js` adds a touch `#dev-fab`
  launcher (`_ensureDevFab`/`_updateDevFab`) shown whenever `isDev()`;
  `applyDevMode(on)` now shows the overlay immediately + toggles the FAB, and a
  boot `_updateDevFab()` restores it for a persisted flag. New `.dev-fab` style
  (z 41, above the overlay's z 40 so it stays tappable). GOTCHA: the FAB is the
  ONLY access path on mobile — the `~`/`\`/`[` `]` hotkeys don't exist on touch.
  Verified touch-emulated, served like prod: enable → DEV ▸ → overlay with all
  4 designer routes → SHIP DESIGNER opens; 0 page errors.

### 2026-06-03 (Defence platforms — PR-4 of DEV_FEATURES_PLAN.md)
- **`game.platforms[]` is a separate array from `game.ships`** —
  ships' escort/AAR/surrender/pack loops never see platforms, so a
  Brood capital's escort assignment can't accidentally try to leash
  a turret bastion, and an enemy fleet's surrender count isn't
  diluted by a platform that "never strikes colors."
- **Platforms duck-type the ship damage interface.** A platform
  carries `pos / vel / heading / side / spec.radius / hp / hpMax /
  shield / shieldMax / shieldFlash / shieldHitTimer / shieldHits /
  scars / dead / surrendered / cells=null / modules=null / klass=
  "station"`. `applyDamage` (game.js:1710) walks the shield → cell →
  module → hull cascade unchanged — the cell + module branches
  short-circuit on `cells===null`/`modules===null`, falling through
  to direct `hp -= remaining`. Saves a damage-extraction refactor
  that would have touched every projectile + beam path.
- **Targeting uses a `enemies = ships + platforms` snapshot** built
  once per `updateAI` invocation. ALL other `world.ships` reads
  (escort id lookups, ally avoidance, FOCUS resolve, pack target
  cache) keep using `world.ships` directly — platforms never appear
  in those passes. `acquireMissileTarget` + the missile-by-id
  re-lookup in `projectile.js#updateMissile` use the same combined
  snapshot so missiles can lock and re-acquire onto platforms.
- **Projectile hit-test added a platform pass** after the ship pass.
  Cannon and missile rounds prefer the first ship they overlap; a
  miss falls through to scan platforms. Both kinds dead-end the
  projectile.
- **Platform IDs start at 100000** so `bs.ships[platform.id]` in
  battle telemetry can't collide with ship ids. AAR roster snapshot
  (`tickBattleStats`) still iterates `game.ships`, so platforms only
  appear in stats when they're hit (lazy `bstatShip` ensure path).
- **Map → platform spawn**: `applyMap` caches `map.platforms[]` on
  `ARENA.platforms`; `spawnMapPlatforms` runs at the end of
  `startGame` after the roster + fleet plan, instantiating each
  via `createPlatform({ platformId, side, x, y, faction })`. Vanilla
  skirmishes drop `ARENA.platforms = []` in `setArenaSize`, same
  cleanup the decor list rides on.

### 2026-06-03 (Map Designer — PR-3 of DEV_FEATURES_PLAN.md)
- **`applyMap(map)` is the single seam** that gets called before every
  scenario spawn. Sets `ARENA.width / height / bounds / spawn.{blue,red}`
  and stamps `ARENA.decor`. The legacy `setArenaSize(w, h)` path stays
  intact + now also **clears `ARENA.decor`** — otherwise a vanilla
  skirmish run after a custom scenario would inherit asteroids from
  the previous match.
- **Built-in map presets union with user maps** at the registry layer
  (`maps/store.js#listAllMaps`). `default-small` / `default-medium`
  / `default-large` are read-only — `saveMap` refuses any id with the
  `default-` prefix. The Battle Designer's MAP dropdown is therefore
  never empty even on a fresh save.
- **Spawn rects are clamped, not rejected.** `validateMap` flags
  out-of-bounds spawn rectangles as errors *and* clamps them so the
  scenario is still playable — refusing to load a 99%-correct map
  because one rect is 50u outside the bounds would be a worse UX than
  the auto-repair. The Map Designer's preview canvas reflects the
  clamped values immediately.
- **Decor is visual-only this phase.** `drawDecor` paints irregular
  polygons (seeded from `(x, y, r)` so they don't shimmer) between
  arena bounds and wrecks. No collision wiring — flagged in the
  changelog so the Phase-4 platform integration knows to skip decor
  in line-of-sight + collision passes.
- **Mini-arena drag-place uses inverse transform.** Click-to-place
  on the preview canvas inverts the same `scale + offset` the renderer
  used so the spawned asteroid lands at the world point under the
  cursor. The SELECT tool reverses that for click-to-remove with a
  generous pick radius (map width × 1.2%).

### 2026-06-03 (Ship Designer + Blueprints — PR-2 of DEV_FEATURES_PLAN.md)
- **Blueprints reuse the persistent-design pipeline** — `bp.design` is
  the same shape as `DEFAULT_PLAYER_DESIGN`, so spawn-side resolution is
  `getBlueprint(id) → {design, paint}` → `createShip({design, ...})`.
  No new AI/physics/render paths. `resolveBlueprintDesign` in game.js
  defensive-clones the design's modules map before handing it to
  createShip — the existing `applyDesign` inside createShip already
  clones-on-descent, so the chain doesn't poison the shared race+class
  spec (verified at PR-2 land with a smoke test that reads
  `baseSpec.ringCannons.damage` before/after applying a Heavy Ring
  Array design — value unchanged).
- **Per-row designId flows through spawnRoster.** `spawnFighterPacks`,
  `spawnBomberPairs`, `spawnCapital` now take an optional `design`
  arg. For fighter/bomber the design is taken from the FIRST queued
  row of that klass (multi-blueprint fighter rows in one team would
  need per-ship plumbing — deferred); for capitals, each spawnCapital
  call gets its own row → design, which is the primary use case for
  blueprints anyway.
- **Designer compares against stock**, not slot-by-slot deltas.
  `computeBlueprintComparison(baseSpec, design, stockDesign)` and
  `stockDesignForKlass(klass)` are the new components.js exports the
  three-column UI reads from. The "vs stock" panel shows current value
  + delta per field with better/worse tint — pure read-only on the
  resolved spec; no side effects.
- **Live preview is the game's pipeline.** Canvas reads
  `resolveSpec(race, klass)` → `applyDesign(spec, design)` →
  `buildModules(klass, spec, poly)` and renders the same module dots
  the engine produces. Shield/armor (abstract slots without a physical
  module) are drawn from `SLOT_VISUALS` so every slot the player
  picked is visible in the preview.
- **Battle Designer ship rows gained a blueprint dropdown** filtered
  by klass — frigate rows only see frigate blueprints. Klass change
  re-renders just the dropdown (the rest of the row's state holds).
- **No save schema bump.** `blueprints: []` rides
  `mergeWithDefaults` like every other Phase-1+ additive top-level
  array.

### 2026-06-03 (Battle Designer overlay — PR-1b of DEV_FEATURES_PLAN.md)
- **Fullscreen DOM authoring overlay** that wraps the PR-1a primitives:
  meta + two-column blue/red team builders + scenario library + Save /
  Test Play / Export / Import. Editor state lives in `this._draft` — a
  **defensive clone** of validated scenarios; SaveStore writes go through
  `saveScenario(this._draft)` which re-validates so a malformed draft
  can't escape the panel. `loadDraft` and `show()` re-clone to prevent
  the editor and the saved record from sharing references.
- **Clipboard has a textarea fallback** (`execCommand("copy")`). iOS
  Capacitor webviews + non-secure-context browsers block
  `navigator.clipboard.writeText`; the textarea-select path covers
  them. On read failure (most webviews block `readText` entirely) the
  importer falls back to `window.prompt` so users can paste a fenced
  block by hand.
- **Designer launches from the dev overlay** via an `openBattleDesigner`
  deps callback, not a direct import — keeps `devoverlay.js` decoupled
  from `battle-designer.js` and lets `main.js` own the lifecycle. Probe
  surface: `window.dev.designer()` lazy-creates + returns the instance.
- **Stance/priority/assignment chips emit `null`** (rendered as "—") when
  unset so validate() leaves the row's wingCommand at vanilla defaults
  instead of stamping an `engage/default/free` override that would mask
  a per-class admiral directive. Authoring a row with all axes left at
  "—" plays exactly like an un-commanded ship.

### 2026-06-03 (Scenario format + Custom-mode extension — PR-1a of DEV_FEATURES_PLAN.md)
- **Canonical Scenario JSON (`src/scenario/format.js`)** is the contract
  every later designer + the chat round-trip share. `kind: "scenario",
  version: 1` is mandatory so the importer can route + reject; bump
  version only on incompatible *shape* changes (additive fields ride
  the validator's defaults). `serializeScenario` emits a fenced
  \`\`\`json block; `parseScenario` accepts raw JSON, just-the-block, OR
  a chat message that contains the block — strip-on-import means
  scenarios paste cleanly out of and back into chat. Stance aliases
  (`STAND OFF` / `STANDOFF` / `STAND_OFF`) all normalize to one
  canonical form so hand-edited JSON keeps round-tripping.
- **Migrations stub up front (`src/scenario/migrations.js`).** Empty
  switch today but the function exists so `validateScenario` already
  funnels through it; adding a v2 is one MIGRATIONS entry, no
  refactor.
- **`customMode` now reads `game.scenario` first**, legacy
  `customRoster` second. Scenario teams → `blueTeams`/`redTeams`
  shape with a sidecar `rows` array carrying per-row spawn hints +
  orders + designId. spawnRoster's helper queue (`buildRowQueues`)
  pops one entry per spawn so per-ship metadata lands 1:1 even on
  multi-row rosters that share a klass.
- **`applyShipOrders` is no longer blue-only.** Pre-PR-1a the
  early-return at the top of the function dropped every red-side
  order — fine when only the admiral commanded the fleet, but
  scenario authoring needs both sides to honour CHARGE / STANDOFF /
  HOLD / FALLBACK to choreograph encounters. The body is symmetric
  apart from one `sideCentroid(world, "blue", ship)` call which is
  now `sideCentroid(world, ship.side, ship)`. FOCUS priority stays
  blue-only (it's by design tied to the admiral's tap).
- **No save schema bump.** `scenarios: []` is additive at the top of
  `DEFAULT_SAVE`; rides `mergeWithDefaults` like every other additive
  field per the existing "Save schema" convention.
- **`window.scenario` probe.** Mirrors `window.dev` / `window.game`
  hooks: `format`, `store`, plus `play(input)` that takes a JSON
  object / raw string / fenced block, validates, sets `game.scenario`,
  and kicks `startGame(…, "custom", …)`. Tests + console smoke can
  drive the format with zero DOM work — the Battle Designer overlay
  (PR-1b) wraps the same primitives.

### 2026-06-03 (Dev overlay — PR-0b of DEV_FEATURES_PLAN.md)
- **Pause/step/speed/heal/kill/invuln/surrender/spawn — all from a single
  DOM panel.** `game.paused` / `game.stepOnce` / `game.simSpeed` are read
  by main.js's catch-up loop. Pause drains the accumulator without
  ticking so the wall clock doesn't snap forward on resume; stepOnce
  fires exactly one fixed tick (paused → tick → paused). `simSpeed`
  scales `accum += delta * simSpeed` at the source instead of fiddling
  the loop budget — keeps the fixed-step contract intact for sim
  determinism. Hotkeys are window-level + gated on `isDev()`; pointer
  selection runs at capture phase on the canvas listener and
  stopPropagation's only if the overlay actually consumed the click, so
  the gameplay input layer keeps every non-dev click.
- **`_devGod` early-return at the top of `applyDamage`** so an invincible
  ship pays one truthy check per hit (the flag is absent on every other
  ship in the world). HEAL clears modules, cells, surrendered, and
  resets hp/shield to max. KILL hardkills via `s.hp = 0` plus
  `coreCell.dead = true` for cell-based hulls.
- **Spawn coord transform** mirrors main.js#draw exactly:
  `world = (screen - viewCenter) / zoom + camera`. The overlay reads
  camera/zoom/view via getter callbacks from main.js — no globals.
  Spawned ships face the enemy centroid and are clamped 50u inside the
  arena bounds.

### 2026-06-03 (Dev Mode + balance HUD — PR-0a of DEV_FEATURES_PLAN.md)
- **Settings toggle gates a per-frame balance HUD.** New
  `src/dev/devmode.js` owns an `_devCached` boolean exposed via
  `isDev()` / `setDev(on)` and a `window.dev` probe. Critical: `isDev()`
  is read from per-frame draw paths — it must NOT touch saveStore.
  `main.js` does the SaveStore read ONCE at boot (`setDev(!!st.devMode)`)
  and re-caches via `applyDevMode` whenever the toggle fires; persistence
  rides the same path as the music/SFX `applyMute*` helpers. The Settings
  patch shape gained `devMode: boolean`; `_buildSettingsOverlay`
  (menus.js) adds a `.settings-toggle` row reusing existing CSS;
  `_syncSettings` mirrors `st.devMode` onto the toggle via the existing
  `_syncToggle` helper. Save schema is unchanged — `settings.devMode:
  false` rides `mergeWithDefaults` (additive field, no version bump).
- **Balance HUD piggybacks on `game.battleStats`** rather than adding
  parallel instrumentation. The per-ship rec gained `damageTaken`;
  `bstatRecordDamage` now takes the victim ship so the lazy ensure path
  also runs for hulls that take damage before they're seen by
  `tickBattleStats` (reinforcements / carrier replenishment). One-line
  change to the existing `applyDamage` telemetry block, drawn LAST in
  main.js#draw so it overlays the HUD; off-path early-returns when
  `isDev()` is false.

### 2026-06-01 (fix: battles cut short mid-fight)
- **The 90s hard battle cap (added in the balance pass) was firing during
  live fights**, ending them by fleet-strength with ships still actively
  on both sides — felt abrupt/wrong ("battles ending while there are
  still ships on the map"). Root cause: my original "capital battles
  never resolve" read was a SIM ARTIFACT (the harness only ran 60s). They
  DO resolve by elimination on their own — sim-measured natural max ≈
  280s for a huge AI fleet siege (far less with a player). Raised
  MAX_BATTLE_SECONDS 90 → 420 so it's a true last-resort backstop well
  above the natural max — battles now end by ELIMINATION, not a timer.
  Verified in-UI: Saurian-capital + Brood-fleet both end with the loser
  fully wiped (red 0), none hit the cap.
  - Unchanged (intended, NOT this bug): a battle ends when one side has no
    non-surrendered, non-player ships — so a win can leave SURRENDERED
    enemy hulks drifting (the surrender/capture mechanic), and the
    player's side loses if its whole AI fleet dies even while the player
    lives. Flag for revisit only if that reads wrong in play.

### 2026-06-01 (dramatically distinct per-faction hull silhouettes)
- **Every faction now has a fundamentally different hull SHAPE language**,
  not the same dart re-skinned. New parametric silhouette system in
  ship.js (`_FACTION_SIL` profile fns + `_CLASS_HULL` sizes +
  `buildFactionTop`), built through the existing `mk()` mirror so output
  is always valid (CCW, y-symmetric, origin-contained, ≤0.96 bounds). A
  post-`HULLS` loop OVERWRITES the hand-authored fighter→carrier hulls for
  all 7 non-procedural races (Synthetics stays fully procedural; the
  radial station hulls are kept as authored).
  - Signatures: Terran ARROWHEAD · Reavers BARBED (sawtooth flanks) ·
    Hegemony SLAB BRICK (width 1.55, blunt) · Voidsworn NEEDLE/CRESCENT
    (width 0.58) · Thren MANTA DISC (width 1.45, blunt) · Brood BEETLE
    (blunt, bulbous) · Saurian RAPTOR (aft-swept). Fighter half-height
    spans 0.32 (Voidsworn) → 0.84 (Hegemony) — a 2.6× width range.
  - GOTCHA: y is clamped to [0.05, 0.93] so wide factions (Hegemony/Thren
    × capital maxY × 1.5 width) can't exceed validateHull's 0.96 ceiling —
    they flat-top into a brick/disc instead, which is the intended read.
  - Constraint honoured: hulls MUST stay y-symmetric (snapModulesSymmetric)
    + contain the origin (pdSeat/cell raycast), so distinction comes from
    profile/width/nose-bluntness, not asymmetry.
  Verified: 42/42 generated hulls pass validateHull; combat smoke spawns
  32 ships all with modules correctly seated on the new shapes, 0 render
  errors; hull sheet confirms dramatic cross-faction distinction.

### 2026-06-01 (per-faction VFX: modules, projectiles, missiles)
- **Each faction now has visually + thematically distinct modules,
  projectiles, and missiles. PURELY COSMETIC** — damage/radius/speed/ttl/
  homing/PD-interception all unchanged.
- **Modules** (ship.js): 3 new `drawFactionFlair` branches so all 8 are
  distinct — brood `spore` (pulsing luminous sacs), saurian `heraldic`
  (gilt House chevrons + boss), synthetics `circuit` (right-angle traces
  to glowing nodes); existing terran/hegemony/reavers/voidsworn/thren
  flairs kept. (Body colour/trim were already per-faction.)
- **Projectiles + missiles** (projectile.js): added a `race` field to
  createProjectile/createMissile, threaded `ship.race` at all 7 ship.js
  fire sites + `parent.race` on cluster-bloom children. New
  PROJECTILE_STYLE / MISSILE_STYLE tables + `drawFactionRound` /
  rewritten `drawMissile` dispatch a per-faction silhouette+palette:
  terran tracer, reaver shard, hegemony gold slug, voidsworn lance, thren
  pellet, brood spore-glob, saurian bronze bolt, synth digital diamond;
  missiles get matching bodies + faction-tinted exhaust trail/glow.
  - GOTCHA: draws key on `p.race` (stamped at fire), since `drawProjectile`
    only receives the projectile, not the world — can't look up the owner.
  - SCOPE: capital shells (BB/cruiser/carrier) keep their existing
    klass-specific art (rare on screen, already distinctive) — not
    faction-tinted. Easy follow-up if wanted.
  Verified: FX sheet renders 8 distinct projectiles + 8 distinct missiles
  (close pairs brood/thren, saurian/hegemony, terran/synth deliberately
  differentiated); live combat draw loop 0 errors; createProjectile/
  Missile retain damage+homing fields.

### 2026-06-01 (Frontier balance pass — sim-driven)
- **Battles now always resolve, bounded + fairly** (game.js). The 45s
  stall watchdog only trips on a NO-DAMAGE lull (its timer resets on
  every hit), so continuously-trading capital/swarm fights ground on for
  100-150s+ with no upper bound. Added a **90s hard cap
  (MAX_BATTLE_SECONDS) on a non-resetting `game.matchClock`** that
  resolves by remaining FLEET STRENGTH (Σ live, non-surrendered hull HP)
  — fairer than the stall's ship-count/tie→red, and NOT flagged as a
  stall (reads as a normal earned VICTORY/DEFEAT). Benefits all modes.
- **Frontier rosters rebalanced** (mission.js BASE_ROSTERS) per the doc's
  "player wins missions to progress": the Republic is a favored SPEARHEAD
  (blue gets the battleship + heavier line; red's extra cruiser/carrier
  trimmed). Old rosters gave RED the heavier fleet → 0-18 AI wipes for
  the player's side. Brood `FACTION_RED_MUL.fighter` 1.6→1.4 (VERY
  sensitive: 1.3 = pushover, 1.5+ = unwinnable flood).
- **Method**: built a headless AI-vs-AI sim harness (`/tmp/aphel-balance
  .mjs`) using the REAL `rostersForBattle` — Terran(blue) vs each faction
  × {sweep, capital-assault, fleet} × 18 sims, resolving via the new cap.
  Iterated rosters until win rates landed in a healthy band (pure-AI,
  before the player's piloting/command tips winnable fights):
    Brood   — sweep 18-0 (drones can't dogfight), capital 9-9, fleet 5-13 (swarm siege)
    Saurian — sweep 3-15 (elite duelists), capital 11-7, fleet 9-9
    Synth   — sweep 9-9, capital 8-10, fleet 12-6
  No more 0-18 wipes; strong per-faction character; competitive midfields.
- Verified in-UI (fresh-page launches): Brood/Saurian sweep+capital+fleet
  all resolve at the 90s cap, 0 page errors. NOTE: AI-vs-AI battles tend
  to grind to the cap (passive fleets); a real player ends them sooner.
  If playtest feel wants snappier capital fights, lower the cap or raise
  DPS / cut shield-regen — left as a follow-up lever.

### 2026-05-31 (new faction: The Assembly — ALL ships procedural)
- **New race `synthetics` ("The Assembly")** — a self-forging machine
  intelligence whose EVERY combat class gets a procedurally-generated
  hull (no two ships alike). Built entirely on the existing generic
  procedural-hull path — `shipgen.js` core UNCHANGED. Registration mirrors
  Brood/Saurian (races.js stats+roster, ship.js FACTION_SHIELD/MODULE/
  MODULE_STYLE, sprites.js FACTION_CELL_STATS/BLOCK_PALETTE/applyRaceBaseFill)
  EXCEPT it has NO hand-authored HULLS — `proceduralHulls` lists all 6
  combat classes, so createShip rolls each via generateHull.
  - Mechanical niche: cold + RESILIENT via FAST-REGENERATING shields
    (machine self-repair, regen 14–34) rather than armor/numbers —
    distinct from Hegemony armor / Voidsworn mega-shields / Brood swarm.
    Cyan-steel aesthetic (icy machine-cyan accent, brushed-steel block
    palette, circuit-sheen base fill, octagon/panel modules).
  - This is the "all-random faction" the proceduralHulls hook was
    designed for — confirms the design goal: a fully-random faction is
    just a race entry + `proceduralHulls: [all classes]`, zero core or
    createShip change. (Station omitted from the list — no generateHull
    envelope; falls back to canonical, never seen in a War.)
  - Available in skirmish/custom now (auto-included in RACE_KEYS); not yet
    tied to a Frontier War — ready to drop into one.
  Verified: 24/24 node (all 6 classes flagged+spawn valid procedural hulls
  + cell grids; two cruisers distinct; shielded w/ fast regen; other races
  unaffected) + browser sheet render of 6 classes × 2 instances = 12
  DISTINCT hulls, 0 errors. Screenshot confirms machined cyan-steel
  silhouettes, all unique.

### 2026-05-31 (procedural hulls wired in — Brood-ships randomized)
- **shipgen.js (the dormant 2026-05-30 procedural-ship core) is now wired
  to live ships, via a GENERIC, faction-data-driven path** — the core
  module itself was NOT modified (a fully-random faction is coming; the
  hook must stay reusable).
- **Brood are now fighters + brood-ships ONLY** (dropped the hive/
  battleship per owner: "they only have fighters and brood ships").
  roster `{ fighter: 74, carrier: 6 }`; `mission.js FACTION_FIELDS.brood`
  allow = `{fighter,carrier}` (bomber/frigate→fighter, cruiser/battleship
  →carrier). **Brood-ships (carriers) get a UNIQUE procedurally-generated
  hull each**; drones keep the fixed organic fighter hull. Still shieldless.
- **The generic hook** (reusable for the future all-random faction):
  - `createShip` resolves its hull polygon ONCE with priority
    `design.hullPoly` (explicit override) → procedural roll (if
    `isProceduralHull(race,klass)`) → canonical `getHull`. The chosen
    `poly` is threaded to BOTH `buildModules` and `buildCells` (which
    gained an optional `polyOverride` arg) and stored as `ship.hullPoly`;
    `drawShip` + the strike-craft block outline prefer `ship.hullPoly`.
  - WHICH ships are procedural is pure faction DATA: `RACES[race]
    .proceduralHulls` (a class list) + `races.js#isProceduralHull`. The
    future all-random faction just lists all its classes — zero core /
    createShip change. (Procedural LOADOUTS — shipgen's `generateLoadout`
    — are NOT wired yet; only hull APPEARANCE, which is what was asked.)
  - **GOTCHA: `buildCells` derived the hull internally from
    `getHull(race,klass)`** (not a passed poly) — it's the real visual
    path for cell ships (carriers render as a cell grid culled to the
    hull). Had to add the `polyOverride` param or the random silhouette
    wouldn't actually render. `buildModules` already took the poly as an
    arg.
  - Hull seeded by `mulberry32(ship.id)` → distinct per ship, render-
    stable, no Date.now/Math.random. `generateHull` self-validates
    against the hull contract + falls back, so a bad roll can't poison
    geometry.
  Verified: 19/19 node (50 generated carrier hulls all pass validateHull;
  brood carriers distinct + shieldless + cells + modules placed; brood
  fighter/saurian carrier stay canonical; roster + war filter
  fighter/carrier-only) + browser fleet smoke (5 brood-ships → 5 DISTINCT
  hulls, all shieldless, red = fighter/carrier only, 134 detonations, 0
  errors). Screenshot confirms varied organic brood-ship silhouettes.

### 2026-05-31 (Brood = pure swarm — no bombers/frigates/cruisers)
- **The Brood now fields ONLY drones (fighters), brood-ships (carriers),
  and the hive (battleship).** Removed the bomber/frigate/cruiser spec
  overrides from `races.js`; race roster → `{ fighter: 74, battleship: 1,
  carrier: 5 }`; carrier `replenish` hatches fighters only.
  - **GOTCHA 1 (carrier bomber hatch): `replenish` DEEP-MERGES over the
    base carrier** (which has `bomber: 36`), so omitting `bomber` let the
    base value survive and brood-ships kept hatching bombers ~36s in. Must
    set `replenish: { fighter: 4.5, bomber: 0 }` explicitly. `ship.js`
    `updateReplenishment` now gates each line on `rep.X > 0`.
  - **GOTCHA 2 (the war uses GENERIC rosters): the Frontier mission
    rosters (`mission.js BASE_ROSTERS`) are faction-agnostic** and include
    frigate/cruiser/etc., so the race roster alone doesn't stop them in a
    War. New `FACTION_FIELDS` filter (`applyFactionFields`) folds a
    faction's disallowed classes into substitutes BEFORE spawn — Brood:
    bomber/frigate → fighter, cruiser → brood-ship (carrier). Saurian
    unrestricted (fields the full line).
  Verified: 11/11 (every battle kind's brood red roster excludes
  bomber/frigate/cruiser; saurian keeps them) + a 40s in-war smoke with
  brood-ships actively hatching — red stayed fighter/carrier only,
  `everBomber/Frigate/Cruiser` all false, 0 errors.
- **Hosting**: the public URL (`…/claude/play/starfighter/`) is served by
  `/root/mypage/server.py`'s `play_starfighter` route straight from
  `/root/aphelionstarfighter/` (raw vanilla-ES-module source, default
  `index.html` → relative `src/main.js`). So source edits go LIVE with no
  build/copy — players just need a hard refresh (src files are
  un-hashed, so the browser module cache must be busted). `dist/` is NOT
  what's served.

### 2026-05-31 (menu route — FRONTIER = new War mode; legacy → Classic)
- **The prominent play-hub "FRONTIER" card now opens the NEW War mode**
  (Brood/Saurian); the legacy roguelite moved to a "CLASSIC CAMPAIGN"
  card below it (still fully playable, run-state intact). Fixes the
  user-facing confusion that the main Frontier button opened the old
  roguelite (Terran-fighter enemies). The new mode itself was always
  correct — it was purely a routing/discoverability issue.
- **Zero callback rewiring needed** — `onPlayHubFrontier`→legacy and
  `onPlayHubFrontierWars`→new were already correct. Just reordered +
  relabeled the two `_buildPlayHub` cards: the `#playhub-frontier-wars`
  card became the prominent "FRONTIER" (RECOMMENDED, DEPLOY, gets the
  `playhub-card-frontier` hero styling); `#playhub-frontier` became
  "CLASSIC CAMPAIGN" (LEGACY/CLASSIC tag). `_syncPlayHub` still drives
  the legacy card's RESUME/Act/callsign + NEW CAREER secondary — correct,
  since that card IS the legacy one (its id is unchanged).
  - NOTE: home hero "FRONTIER" card still routes to the play hub (`onHomePlay`)
    — unchanged, so the play hub (and thus Classic Campaign + skirmish/
    custom) stays reachable; only the card the player taps to enter a
    Frontier mode changed which mode is prominent.
  Verified: play-hub card order [FRONTIER(DEPLOY)→new hub, CLASSIC
  CAMPAIGN(START)→legacy runSetup, Skirmish, Custom]; FRONTIER click sets
  showFrontierHub, CLASSIC click sets showRunSetup; 0 errors. Screenshot
  confirms layout.

### 2026-05-31 (Brood faction — shieldless, armor + hull only)
- **The Brood now have NO energy shields on any class** — they survive on
  living-chitin armor (per-cell `FACTION_CELL_STATS.brood`) + raw hull
  mass alone, fitting the organic-hive identity. Set `shield: null` on all
  6 brood classes in `races.js`.
  - **GOTCHA: `shield: null` (not `{max:0}`) is required, and EVERY class
    needs it.** (1) The base class spec has a shield, and `resolveSpec`
    deep-merges race over base — `deepMerge` assigns `null` straight
    through (line 555-556), so null actually clears it; `{max:0}` would
    leave `spec.shield` truthy. (2) The shield-generator modules gate on
    `!!spec.shield` (modules.js), so only a falsy shield drops them —
    `{max:0}` would keep vestigial shield-gen modules on a 0-shield hull.
    (3) The brood cruiser previously had NO shield key → it was silently
    inheriting the base cruiser shield; it needed the explicit null too.
  - Effect: `shieldMax`/`shield` = 0, no shield-generator modules, and
    every incoming hit routes straight to the block/armor/hull path
    (brood are permanently "shield-down"). Saurian shields untouched.
  Verified: 27/27 (all 6 brood classes shieldMax 0 + spec.shield null + 0
  shield-gen modules; saurian fighter/BB still shielded w/ modules) + a
  900-tick Locust Wind smoke (all brood shieldMax 0, brood taking hull/
  armor damage, 0 errors).

### 2026-05-31 (new Frontier — premium caches / loot boxes §9.8)
- **Last core deliverable.** `frontier/chests.js`: 3 SKU tiers
  (Basic/Premium/Elite) with the §9.8 rarity weights, single-item rolls,
  a pity timer (Rare-or-better guaranteed every `PITY_INTERVAL=10`,
  counter `frontier.chestPity` resets on ANY Rare+ — natural or forced),
  class-targeting (rolls only `pilotableNow()` classes), and disclosed
  odds. Hub ◇ CACHES bottom sheet (5th sheet): SKU cards w/ color-coded
  odds + OPEN button, an ACQUIRED reveal banner for the just-opened item,
  pity-progress line, and a free-path disclosure note.
  - **MONETIZATION NOTE: no payment backend exists, so caches spend WAR
    CREDITS as a placeholder** (premium-steep: 500/1500/4000). The
    regulated MECHANIC (weighted roll + pity + odds disclosure +
    class-targeting + free-path-intact guardrail) is the deliverable;
    swapping the spend rail to real IAP later is one function
    (`chests.js` calls `spendCredits` — replace with `payFor`). Mythic
    tier (§9.8 Elite 2%) deferred → folded into Legendary.
  - Save: `frontier.chestPity: 0` (number; spread-preserved, no guard
    needed). The 5 hub bottom sheets (editor/shop/citations/newsreel/
    chests) remain mutually exclusive — each open nulls the other four.
  Verified: 13/13 node tests (odds sum 100, affordability, deduct+stash,
  tier-gating fighter-only at rookie, pity floors to Rare+ on the 10th +
  resets, elite natural-Rare+ resets) + browser (open → reveal "Afterburn
  Drive", −1500cr, stash+1, odds/pity/disclosure shown), 0 errors.
- **ALL FRONTIER_FUTURE.md core deliverables are now implemented.** Built
  this session (newest first): caches §9.8 · newsreel+ribbon §10 ·
  pilot-class/fleet-command deploy §3.2 · faction greeble+heraldry §7/§8 ·
  real Brood+Saurian races §7 · achievements+decorations §11 · post-battle
  WAR SPOILS · Quartermaster §9.7 · loadout editor · loot engine+inventory
  §9 · playable hub+menu route · data/persistence spine §3. Still
  deferred (battle-layer, out of §-scope): Legendary unique EFFECTS wired
  into combat (data rolls + displays, just inert) — needs crit/range-
  falloff systems that don't exist. All `frontier` work is enemy-only /
  additive; legacy `roguelite` mode untouched; save v4.

### 2026-05-30 (new Frontier — newsreel + war-state ribbon §10)
- **Story-first immersion layer.** `frontier/newsreel.js`: ~8 authored
  Kroger/Brant propaganda segments per War (chapter-completion +
  kill-milestone), each keyed to a DERIVABLE trigger (per-War chapters /
  kills / war-won — same metrics shape as achievements). `checkNewsreel()`
  unlocks into `frontier.newsreel` (id list, unlock order) at the end of
  `resolveMissionOutcome` → `outcome.newTransmissions`; surfaced as an
  `INCOMING TRANSMISSION` block on the result screen (hud) AND a hub
  ▶ NEWSREEL bottom sheet (latest-first feed + locked-count teaser).
  New save field `frontier.newsreel: []` (array-guarded in
  mergeWithDefaults; no schema bump).
- **War-state ribbon** (§10.3) in the hub's selected-War detail: a
  chapter-spine strip (done/next/locked nodes) + `completionPct` + total
  kill count, computed in `_buildFrontierHubMenuState`.
  - GOTCHA: the hub signature only keyed on `fh.wars` (which omits the
    kill ledger), so killCount changes alone wouldn't re-render — added
    `swr:[completionPct,killCount,warCompleted]` + `nr:fh.newsreel` to the
    sig so the ribbon/feed refresh.
  - The four hub bottom sheets (editor / shop / citations / newsreel) are
    mutually exclusive — every open-callback nulls the other three on
    `_frontierSel`.
  Verified: 8/8 node tests + browser (win → transmission on spoils;
  ribbon shows 1/5 done + "20% · 10 down"; NEWSREEL feed plays the
  segment + "+11 classified" footer), 0 errors.

### 2026-05-30 (new Frontier — pilot-class deploy + fleet command)
- **The command-tier track is now exercised in battle.** Two things:
  (1) confirmed capital PILOTING already worked (the hub picks a
  pilotClass → `buildMissionConfig` sets `playerDesign={hull:pilotClass}`
  → `promotePlayer` spawns that hull) — it was just never reachable since
  rookies only unlock fighter. (2) NEW **FLEET COMMAND** option: a tier-
  gated deploy choice that launches admiral mode instead of piloting.
- `career.js#COMMAND_MIN_TIER=3` (Strike Group Lead) + `canCommand(xp)`;
  `state.js#canCommandNow()`. The hub pilot row gains a `⚑ FLEET COMMAND`
  chip when unlocked (`fh-cmd-chip`, blue); picking a hull clears command
  mode and vice-versa. `_frontierSel.commandMode` rides the launch payload
  as `command`.
- `mission.js`: `command` flag → `battleMode:"command"`, `playerDesign`/
  `loadoutStats` nulled (no player ship). `modes/frontier.js` setup now
  branches: command → set `spectating+admiralMode+directives+
  spectateCamera` BEFORE spawnRoster (so it skips promotePlayer and the
  fleet flies on AI), mirroring the legacy roguelite command branch; fly
  → spawn + promotePlayer + applyLoadoutToShip as before. `main.js`
  already set `input.admiralActive` from `game.admiralMode` post-launch.
  - NOTE: in command mode `resolveMissionOutcome`'s `playerKIA` is always
    false (`!admiralMode && playerKIA`), so an admiral only soft-dies on a
    LOSS, never from ship death — correct (you're not in a cockpit).
    Loot drops still target `fc.pilotClass` (the last-picked hull).
  Verified (browser, 0 errors): at Captain tier all 6 classes pilotable +
  command chip shown; piloting cruiser → player ship klass "cruiser";
  FLEET COMMAND → admiral mode (no player ship, spectating, 12 blue on AI,
  full directive panel). Screenshots of both.

### 2026-05-30 (new Frontier — per-faction greeble + Saurian heraldry)
- **Brood + Saurian now have visible in-game hull signatures** beyond the
  silhouette/color from the prior slice. Brood: bioluminescent
  compound-eye glow cluster at the bow. Saurian: dorsal bronze ridge
  crest + **House banner heraldry on capitals** (§8.3 committed feature) —
  a sigil disc amidships, one House per capital class so a fleet shows a
  spread: frigate=Vael'ari hooked-talon, cruiser=Sk'rath barbed-sun,
  battleship=Tssor'kan horned-serpent, carrier=Drazn crashing-wave.
- **LOAD-BEARING GOTCHA: in-game ships render from the BLOCK CANVAS, not
  the schematic sprite.** Every class in `CELL_GRID` (fighter→carrier)
  draws via `ship.blockCanvas` (cell grid); the prebaked schematic sprite
  (where `drawRaceDetails` greeble + `applyRaceBaseFill` live) is ONLY the
  no-cell fallback (stations / classes absent from CELL_GRID). So race
  greeble added to `drawRaceDetails` is INVISIBLE in normal play. The
  identity overlay that actually shows is a NEW `drawBlockRaceDetails`
  pass at the end of `rebuildBlockCanvas` (sprites.js), drawn on top of
  the cells. (The drawRaceDetails brood/saurian branches were kept anyway
  for the fallback + future icon paths — harmless, just rarely hit.)
  - The overlay translates to the ship's local origin (`halfX+1,halfY+1`)
    and draws in radius-space; `drawSaurianSigil(bctx,house,R)` is shared
    between the sprite path and the block path.
  - Heraldry/eyes sit UNDER the shield bubble (same as Thren spine nodes),
    so they read once shields drop — hull shape + faction color carry
    identity while shields are up.
  Verified: faction sprite-sheet render (brood green organic + eye-glow;
  saurian bronze + crest + capital sigils) + 1200-tick two-faction combat
  smoke exercising block rebuilds under damage — 0 errors.

### 2026-05-30 (new Frontier — real Brood + Saurian factions §7)
- **The two Frontier antagonists are now real races** (were placeholder-
  mapped to reavers/hegemony). `races.js` gains `brood` ("The Brood",
  fragile-fast organic swarm — 16hp/605spd drones, 4.5s carrier
  replenish, dense-PD/no-gun hive battleship) and `saurian` ("Var'sakh
  Dominion", quality — 50hp shielded fighters, +HP armored capitals).
  `frontier/wars.js#FACTION_RACE` now points brood→brood, saurian→saurian
  (the ONLY line to change if these specs are retuned). Enemy-only:
  deliberately NOT added to unlockedRaces/Factions/warProgress/custom-
  picker/reputation — they spawn red-side via the Frontier mission
  bridge. (RACE_KEYS auto-includes them, so sprites prebake + they're
  also selectable in skirmish/custom — harmless.)
- **Distinct silhouettes** via a new `ship.js#mk()` half-profile hull
  generator: author only the top edge (nose→tail, y≥0, x strictly
  decreasing) and mk mirrors the lower edge to GUARANTEE y-symmetry +
  terran-matching winding — a new hull can't ship self-intersecting or
  wrong-wound. HULLS.brood = organic manta/beetle curves; HULLS.saurian
  = swept predatory rakes (6 classes each; station omitted → terran
  fallback, never spawned in Frontier).
  - **GOTCHA: mk() handles an off-axis nose** (carriers start `[1,0.06]`
    for a blunt flight-deck prow) — if `top[0].y≈0` it drops the nose
    from the mirror (shared vertex), else it mirrors the whole edge so
    the nose closes as an edge. Initially missed this → carriers failed
    the y-symmetry check. Also `slice()` before `reverse()` so mk never
    mutates the caller's array.
- **Visual identity**: added brood/saurian to FACTION_SHIELD,
  FACTION_MODULE, MODULE_STYLE (ship.js — brood bio/green organic,
  saurian bronze/ornate octagon), FACTION_CELL_STATS + BLOCK_PALETTE
  (sprites.js — brood fragile-drones/tanky-hive, saurian hardened
  across the board), and `applyRaceBaseFill` branches (brood chitin
  carapace bands + toxic sheen; saurian bronze war-plate + jade keel).
  All faction maps fall back to terran for unknown keys — used the
  CORRECT keys (`brood`/`saurian`) everywhere incl. BLOCK_PALETTE (the
  one with the legacy `reaver`-vs-`reavers` bug).
  Verified: 24/24 hull validity (winding+symmetry) + resolveSpec merges
  + browser launch of both Wars (THE BROOD: 16hp drones, organic hulls;
  VAR'SAKH DOMINION: 50hp fighters, swept hulls; correct roster/target-
  panel labels), combat ticks clean, 0 errors. FOLLOW-UP (deferred):
  per-race greeble in drawRaceDetails (currently only base-fill identity);
  Saurian House banner heraldry on capitals; mid-fight comms voice.

### 2026-05-30 (new Frontier — achievements + decorations §11)
- **Pure-flavor milestone system** (FRONTIER_FUTURE.md §11 — no XP/loot/
  IAP cross-contamination). `frontier/achievements.js`: 14 achievements
  across combat/career/build, ALL derivable from existing frontier state
  (kills ledger, career tier, per-War chapters, equipped loadouts) — no
  new counters. `checkAchievements()` recomputes the earned set + unlocks
  newly-satisfied ones into `frontier.unlockedAchievements` +
  `frontier.decorations` (idempotent), called at the end of
  `resolveMissionOutcome` (after rewards/kills bank). New decorations
  surface on the result screen (`renderDecorationsAwardedHTML`, shown
  win OR loss — a defeat can still cross a kill milestone); a hub
  ✦ CITATIONS bottom sheet (third sheet, mutually exclusive with the
  loadout editor + Quartermaster) shows all 14 grouped by category,
  earned (gold AWARDED) vs locked (desc + live "x/100" progress).
  - GOTCHA: the three hub bottom sheets (editor / shop / citations) are
    mutually exclusive — each open-callback nulls the other two
    (`editSlot`/`shopOpen`/`citationsOpen` on `_frontierSel`).
  - NOTE: confirmed the loot-slice in-battle kill ledger works — the
    probe's "11/100" Centurion progress = ~10 red deaths emitting
    `shipDestroyed` → `frontierState.recordKill` during the battle + 1
    manual. (Synthesising fake `shipDestroyed` events in a probe WITHOUT
    x/y throws in audio.sfxExplosion — use `window.frontier.recordKill`
    to tick the ledger in tests, not raw events.)
  Verified: 9/9 node tests (unlock/idempotent/progress/view) + browser
  (win awards first-blood + baptism on spoils; CITATIONS shows 2/14), 0
  errors.

### 2026-05-30 (new Frontier — post-battle WAR SPOILS screen)
- **Mission rewards + loot drops now surface on the match-over screen**
  (were landing silently in the stash). `hud.js#renderFrontierSpoilsHTML`
  renders a WAR SPOILS block (XP/credits chips, PROMOTED chip, then loot
  cards with rarity color + slot tag + affixes + EQUIPPED/STASHED badge),
  prepended above the standard battle report in `_syncMatchOver`'s new
  `game.mode === "frontier"` branch. Title/subtitle made frontier-aware:
  VICTORY / DEFEAT / "PILOT LOST" (soft-death) with a carries-forward
  subtitle.
- **Data flow**: `state.js` completeChapter/Sortie now return
  `xpGained`/`creditsGained`/`promoted`; `mission.js#resolveMissionOutcome`
  builds a render-ready `outcome.rewards` + `outcome.drops` (mapped to a
  plain view — does NOT leak live stash module refs to the HUD — with
  `equipped` captured at award time, before the player can touch the
  loadout). hud imports `RARITY_BY_ID` from `frontier/loot.js` for colors.
  - GOTCHA: relies on the same timing guarantee as `lastBattleReport` —
    the `matchEnded` subscriber (sets `game.frontierOutcome`) runs
    synchronously inside `update()`, before the HUD's `draw` builds the
    once-per-match panel, so the data is present on frame 1. Spoils only
    render on a win (`outcome.won`); losses show title/subtitle only.
  Verified (browser, 0 errors): forced win → panel shows VICTORY +
  spoils block + 2 reward chips + 1 drop card with EQUIPPED badge.

### 2026-05-30 (new Frontier — Quartermaster shop)
- **Credit sink + reliable progression floor** (FRONTIER_FUTURE.md §9.7).
  `frontier/shop.js`: persisted stock (`frontier.shop`) with a STATIC
  section (Common/Uncommon, infinite restock — buying mints a fresh
  stash copy, listing stays) and a ROTATING section (Rare/Epic, one-off,
  consumed on buy). Legendaries NOT sold. Tier-gated to `pilotableNow()`
  classes. Prices by rarity (80/200/600/1500). Reached via a
  ⚒ QUARTERMASTER button in the hub → a bottom sheet (same pattern as the
  loadout editor; second `#frontier-shop` host, mutually exclusive with
  the editor). New `state.js#spendCredits` (affordability-checked deduct).
  - **GOTCHA: stock refreshes on a KEY, not a timer** — `refreshKeyFor` =
    total chapters-completed across wars + sorted unlocked-classes sig.
    `ensureShop` regenerates only when the key changes (chapter clear or
    a tier-up unlocking a new class), matching §9.7's per-chapter,
    no-FOMO-clock decision.
  - **GOTCHA: `ensureShop` has a read-only fast path** — it runs every
    frame while the sheet is open (built in `_buildFrontierHubMenuState`),
    so it only calls `saveStore.update` when actually regenerating;
    otherwise a debounced write would fire every frame.
  - **GOTCHA: buy is spend-first** — `spendCredits` is the atomic
    affordability gate (no deduction on failure); only then is a fresh
    module minted into the stash and rotating stock pruned.
  Verified: 15/15 node tests (tier-gating, static/rotating rarity split,
  no-legendary, price-by-rarity, broke→fail, buy deduct+stash+restock,
  rotating-consume, chapter-clear reroll) + browser probe (open → 8
  cards → buy drops credits/grows stash/static restocks → close), 0 errors.

### 2026-05-30 (new Frontier — manual loadout editor UI)
- **Loot is now fully interactive: tap any loadout slot in the hub to
  open a bottom-sheet editor** listing every stash module valid for that
  (class, slot) — EQUIP / UNEQUIP / SALVAGE (banks credits) / ★favorite,
  with the equipped item pinned top and the rest sorted rarity-desc.
  Auto-equip-on-drop (prior slice) stays as the zero-touch default; this
  adds deliberate choice + salvage + favorite-locking.
- **Implementation**: `menus.js` adds a `#frontier-editor` host
  (position:absolute over the `position:relative` `.menu-frontier`
  screen) rendered from `menuState.frontierHub.editor`; loadout rows are
  now `<button data-fh-slot>`; the existing delegated `_onFrontierHubClick`
  gained the editor actions (checked FIRST since the sheet overlays the
  body). `input.js` `_frontierSel.editSlot` drives it + 6 callbacks
  (editSlot toggle / close / equip / unequip / salvage / favorite); the
  `editor` payload (candidates filtered by class+slot, sorted via
  `RARITY_ORDER`) is built in `_buildFrontierHubMenuState`.
  - GOTCHA: `onFrontierHubEditSlot` TOGGLES (tap same slot = close), and
    equip/unequip read `_frontierSel.editSlot` rather than a DOM-threaded
    slot — equip auto-closes the sheet, unequip leaves it open.
  - GOTCHA: editor changes ride the hub's signature diff (`ed: fh.editor`
    in the sig) so the sheet re-renders in-place; selecting a different
    pilot class clears `editSlot` (different slot set).
  Verified via real DOM clicks (0 errors): open → 3 candidates, epic
  sorted top → EQUIP sets loadout + damage mult 1.2 + auto-close →
  UNEQUIP clears → ★ toggles → SALVAGE banks +60cr & shrinks stash →
  CLOSE hides sheet.

### 2026-05-30 (new Frontier — Diablo-style loot system core)
- **Modular loot engine + inventory wired end-to-end** (FRONTIER_FUTURE.md
  §9). New `frontier/loot.js` (pure: 5 rarity tiers, per-class slot defs
  §9.2, per-category affix pools, module families, Legendary uniques,
  `rollModule`/`rollDrop`/`computeLoadoutStats`) + `frontier/inventory.js`
  (stash + per-class loadouts over the existing save `frontier.stash`/
  `loadouts` — NO schema bump; mergeWithDefaults already preserved them).
  Mission win → `awardDrops` (boss source when neverSurrender); equipped
  loadout multipliers applied to the player ship in battle; hub shows a
  per-class loadout panel + stat summary + stash count.
- **GOTCHA: loot stats are applied POST-SPAWN in `modes/frontier.js`,
  NOT via playerSpecOverride.** `createShip` runs `applyDesign` AFTER the
  specOverride deep-merge, and applyDesign re-stamps default component
  stats over every slot — so any weapon/hull values injected via
  specOverride get clobbered. `applyLoadoutToShip` scales the live ship's
  cached fields after spawn: hpMax/hp, shieldMax/shieldBaseMax/shield,
  and CLONES the shared spec + each `ship.weapons[i].spec` before
  scaling maxSpeed/turnRate/damage/cooldown (spec-poison hazard — the
  resolved race spec is shared across all ships of that race/class).
  Verified: +50% hull → hp 35→53, +50% dmg → weapon 4→6.
- **GOTCHA: `computeLoadoutStats` only aggregates APPLIED_STATS**
  (hp/shield/speed/turn/damage/fireRate/missileDamage) into `1+Σaffix`
  multipliers. Other rolled affixes (range, armor, PD, targeting, etc.)
  and ALL Legendary unique effects still roll/display/persist but are
  flavor-only today — forward-compatible data for later combat wiring.
- **GOTCHA (stopgap): dropped modules AUTO-EQUIP into an empty matching
  slot** (`awardDrops`) so loot is impactful before the manual equip UI
  ships. Auto-salvage at `STASH_CAP=80` skips favorited AND equipped
  modules (`_equippedIn` guard) — never nukes worn/locked gear; overflows
  rather than destroy protected items if everything is protected.
- Drops awarded at match END use PRE-battle loadout stats (snapshotted in
  `buildMissionConfig` at launch) — you fly with what you had; new drops
  apply next mission. NOT yet: manual equip/swap UI, Quartermaster shop,
  premium chests, Legendary effects in combat, per-class drops beyond the
  flown class.

### 2026-05-30 (new Frontier — playable hub UI + menu route)
- **The new War-based Frontier is now reachable + playable from the
  menu** (no longer console-only). New play-hub card "FRONTIER: WARS
  (BETA)" (`#playhub-frontier-wars`, separate from the legacy Frontier
  card) → a new full-screen DOM overlay `menu-frontier` (the Pilot's-
  Lounge-lite hub): career header (rank/tier/XP bar/war credits), War
  selector (2 cards), the selected War's chapter spine (done ✓ / next ▶
  flyable / locked 🔒) + 8-sortie board, a pilot-class picker (from
  `pilotableNow()`), and a LAUNCH footer. Full loop verified: select →
  launch → battle → win banks chapter+credits+XP → CONTINUE returns to
  the hub; v3→v4 migration + the legacy roguelite flow untouched.
- **Architecture** (mirrors the Fleet Plan overlay): `menus.js`
  `_buildFrontierHub`/`_syncFrontierHub` (signature-diffed, scrollTop
  preserved) + ONE delegated `_onFrontierHubClick` (data-fh-war /
  data-fh-mission[+mtype] / data-fh-pilot). `input.js`: `showFrontierHub`
  flag + screenName-chain entry, `_frontierSel` selection (persists
  across opens), `_buildFrontierHubMenuState` (reads frontier/state.js),
  hub callbacks, `consumeFrontierLaunch()`. `main.js` menu branch drains
  the launch (startNewPilot if none + `launchFrontierMission` + chrome)
  and returns to the hub on match-end/quit for `mode === "frontier"`.
- **GOTCHA (load-bearing, cost an hour): a `return;` inside the menu
  branch of `frame()` breaks the RAF loop.** `frame()` only reschedules
  via `requestAnimationFrame(frame)` at its BOTTOM — any early `return`
  after a launch kills the animation loop (match never advances, input
  flags never drain). The legacy roguelite `return` survives only
  because its path "should never fire." The frontier launch fires every
  time, so it must NOT return — gate the rest with
  `const choice = fl ? null : consumeStart()` and fall through.
- **GOTCHA: switching War in the hub clears the selected mission** (its
  id belongs to the other War's spine/pool) — `onFrontierHubSelectWar`
  nulls `missionType`/`missionId`.
- **GOTCHA: hub is a pure DOM overlay** — unlike runMap/runSetup it needs
  NO `_layout*` canvas method; opening is just `showFrontierHub = true`.
  Added `frontierHub` to the `overlays` scrim list in `showScreen`.
- Reused `.battleplan-back`/`.battleplan-launch-btn` chrome; new
  `.menu-frontier` screen honours the flex-direction:column + min-height:0
  scroll trap (Republic amber theme vs Fleet Plan's blue). NOT yet:
  loot, capital command-mode piloting, real faction art, result screen
  beyond the shared battle report.

### 2026-05-30 (new War-based Frontier — data + persistence spine)
- **First slice of the FRONTIER_FUTURE.md redesign: a parallel `frontier`
  mode + `src/frontier/` namespace, built ALONGSIDE the legacy 8.6k-line
  `roguelite.js` (untouched).** The two coexist; the menu route still
  points at roguelite until the new mode is playable. New files:
  `frontier/career.js` (single XP→tier track, 0–6, tier derived from XP —
  NOT stored), `frontier/wars.js` (the two launch Wars as data: Op Locust
  Wind / Op Dragon's Jaw, chapter spines + 8-sortie pools), `frontier/
  state.js` (read/write funnel over the save's `frontier` block),
  `frontier/mission.js` (mission→battle bridge + outcome resolver),
  `modes/frontier.js` (mode hooks, registered key `frontier`, NOT in
  MODE_KEYS).
  - **Save schema v4** (`save.js`): additive `frontier` block (careerXp,
    warCredits, unlockedClasses, per-class loadouts, stash, per-War
    progress, live `run`, decorations/trophies/achievements). Migration
    v3→v4 seeds it; mergeWithDefaults deep-merges (unions `wars` keys +
    `unlockedClasses`, preserves `run`/arrays verbatim). Legacy
    `roguelite` block preserved untouched — verified on a synthetic v3
    save.
  - **GOTCHA: commandTier is NEVER stored — it's a pure function of
    careerXp** (`career.js#tierForXp`). Read tier/unlocks via
    `state.js#currentTier`/`pilotableNow`, never a saved field, so they
    can't drift from the XP they track.
  - **GOTCHA: soft-death banks XP/credits CONTINUOUSLY** (grantXp/
    bankCredits write straight to meta), so a pilot loss never costs
    earned progress — `killPilot` only nulls the live `run`. Verified:
    a loss soft-kills the pilot while careerXp persists.
  - **GOTCHA: chapter completion only advances the War spine if it's the
    NEXT uncompleted chapter** (`completeChapter` guards on
    `nextChapter`); out-of-order / re-flown chapters still pay
    XP+credits but don't push the story. (The spine probe's
    `winAdvanced:0` for a directly-launched ch3 is this guard firing,
    not a bug.)
  - **GOTCHA: new factions are PLACEHOLDER-mapped to existing races** in
    `wars.js#FACTION_RACE` (brood→reavers, saurian→hegemony — the §7a
    engine-fit templates). When the real Brood/Saurian races land in
    `races.js`, change ONLY that map. `raceForFaction` falls through to
    the key itself so a real race keyed under its own name Just Works.
  - **Wiring**: `main.js` imports the bridge, adds a `matchEnded` →
    `resolveMissionOutcome` subscriber (banks reward / soft-kills) + a
    Frontier kill-ledger `shipDestroyed` subscriber (note: `recordKill`
    is ALSO a shipyard.js export already imported — the frontier one is
    reached via `frontierState.recordKill`), and exposes a `window.
    frontier` test surface (launch + state reads). NOT yet built:
    Pilot's Lounge UI, menu route, loot system, command/admiral piloting
    for capitals (all fly-mode today), real faction art. Verified: 30/30
    node logic checks; browser probe launches a capital-assault chapter
    (13 blue / 17 red incl. brood fighter boost), player spawns, 600
    ticks zero throws; win banks XP+credits, loss soft-kills cleanly;
    v3→v4 migration preserves legacy roguelite state.

### 2026-05-29 (spectator/admiral camera — pan/zoom bug sweep)
- **Fixed buggy map panning in spectate/command, plus a sweep of the whole
  spectator/admiral camera.** Ten verified fixes across input.js / main.js /
  game.js / hud.js:
  - **Pinch also panned** (S1): a finger during a 2-finger pinch was promoted
    to a `_panDrag` and fed `_pendingPanDelta`, so zoom dragged the camera.
    Fix: pan accumulation + promotion are gated on `_touches.size < 2`, and a
    2nd finger landing in onDown now nulls `_panDrag`/`_tapCandidate`/
    `_pendingPanDelta`. **GOTCHA: mouse leaves `_touches` empty (size 0), so
    the `< 2` guard doesn't disable desktop grab-pan.**
  - **Forked pan model** (S2): the left vstick was never gated/hidden in
    spectate, so left-half = velocity stick-pan, right-half = 1:1 grab-pan,
    and left-half ships were untappable. Fix: gate the left stick on
    `!selectActive` (input.js) + hide `#vstick-left` when not piloting
    (hud.js) → one grab-pan model everywhere. **GOTCHA: desktop keeps
    continuous pan via the keyboard (WASD) thrust source, which is separate
    from the touch stick — don't remove the thrust→pan path in main.js.**
  - **`_tapCandidate` single-slot clobber** (S3): a 2nd finger overwrote the
    1st candidate. Fix: only the FIRST finger seeds it (`!this._tapCandidate
    && _touches.size < 2`).
  - **3→2 finger lift left a stale `_pinchPrevDist`** → zoom jump. Fix: re-seed
    the baseline when dropping to exactly two touches (onUp).
  - **Locked camera snapped to a stale/auto-recycled ship on target death.**
    Fix: draw() mirrors the live locked target into `spectateCamera` each
    frame, so death-recycle / null-target falls back to the last-seen spot.
  - **`zoom` (a main.js module-level var, NOT on game) never reset between two
    consecutive spectate/admiral matches.** Fix: `zoom = DEFAULT_ZOOM` after
    each `startGame` call site (both launch paths already call
    `resetForNewMatch`).
  - **Wheel zoom accumulated while piloting/in-menu** (nothing drains it there)
    → dumped as a jump on the first spectate frame. Fix: the wheel handler
    only accumulates when `selectActive`.
  - **Pan/pinch/zoom accumulators leaked across matches + spectate↔pilot
    toggles.** Fix: new `input.clearCameraGestures()` (clears `_panDrag/
    _pendingPanDelta/_pendingZoomDelta/_touches/_pinchPrevDist`), called from
    `resetForNewMatch` and on both the spectate + admiral toggles.
  - **tap-select / cycleSpectate / pickSpectateInitial / focus-reticle locked
    onto surrendered hulks** (untargetable drifting wrecks the AI ignores).
    Fix: `!s.surrendered` skips, matching the codebase-wide convention.
  - **Zoom gate was `spectating||admiralMode` while pan/tap + draw camera were
    `spectating` only.** Unified everything on `game.spectating` (every admiral
    path sets it true) so the subsystem can't diverge.
  - LEFT (deliberate): pinch zooms toward screen-centre, not the gesture
    midpoint (a polish nicety, not the reported bug) — see sweep finding #19
    if revisiting.
  Verified at runtime (Playwright, real skirmish→spectate, driving the input
  handlers directly): 10/10 — pinch yields zoom-delta + zero pan-delta;
  left-half drag grab-pans without starting the stick; clean tap still selects;
  3→2 reseed exact; resetForNewMatch clears all gesture state; tap-select skips
  a surrendered hulk. NOTE: piloting is byte-for-byte unchanged (selectActive
  is false while piloting, so the new `!selectActive` stick gate is a no-op there).

### 2026-05-29 (fighters/bombers ignored live admiral commands)
- **Mid-battle admiral orders now reach strike craft.** The live admiral
  panel writes per-class to `game.directives[klass]`, but `ai.js#resolveOrders`
  gives a ship's `wingCommand` PRECEDENCE over the class directive — and
  `applyFleetPlan` stamps a `wingCommand` on every fighter/bomber at spawn
  (capitals get none; they're driven purely by the directive). So a live
  STANCE / FOCUS change never reached strike craft: they kept obeying their
  stale pre-battle wing order. Capitals worked, fighters/bombers "ignored
  commands".
  - **FIX:** `setPosture`/`setPriority` (main.js) now also call
    `propagateOrderToWings(klass, axis, value)` — pushing the changed axis
    onto every commandable blue ship of that class that HAS a `wingCommand`,
    so the live order supersedes the wing plan. Capitals (no wingCommand) are
    skipped — the directive already drives them. MISSILES needs no propagation
    (ship.js reads `world.directives[klass].missiles` directly, bypassing
    wingCommand, so it already reached strike craft).
  - GOTCHA: a legacy Frontier `wingCommand` is `{kind,…}` (no `.stance`), and
    `resolveOrders` only reads the new axes once `.stance` is present — so
    `propagateOrderToWings` normalises a legacy command to new-shape (mapping
    `kind`→stance) before setting the axis, or the write would be silently
    ignored.
  - GOTCHA: only a SUBSET of fighters carry a wingCommand (the player's ship,
    carrier-launched reinforcements, and distribution remainders have none) —
    those obey via the directive path. So a correct fix had to cover BOTH:
    propagate to wingCommand-bearers AND leave the directive set for the rest.
  Verified at runtime (Playwright, real skirmish): a live FALL BACK flips
  101/101 wingCommand fighters to stance `fallback` + sets the directive;
  CHARGE aims 101/101 at the enemy mass while FALL BACK turns 83% away
  (combat-independent heading proof); FOCUS propagates; frigates keep no
  wingCommand and obey via the directive.

### 2026-05-29 (Battle Plan / Fleet Plan couldn't scroll)
- **The pre-battle planner screens (`.menu-battleplan` + `.menu-fleetplan`)
  now scroll.** They're flex-column children of the fixed, vertically-centred
  `.menu-root`, but had NO height bound — so they grew to their full content
  height, overflowed the centred viewport (clipping top + bottom with no
  scroll), and `.battleplan-body { flex:1; overflow-y:auto }` never had a
  bounded parent to scroll within. On a tall fleet the WINGS section + LAUNCH
  button were unreachable.
  - **GOTCHA (the actual fix):** bind both screens to `height: 100%` +
    `max-height: 100%` (of the fixed `inset:0` menu-root — use `100%`, NOT
    `100vh`, to avoid the iOS dynamic-toolbar gap) AND add `min-height: 0` to
    `.battleplan-body`. The `min-height:0` is the classic flexbox-scroll trap:
    a `flex:1` child won't shrink below its content's min-content size without
    it, so `overflow-y:auto` never engages and the body pushes the screen
    past the viewport instead of scrolling internally. Both are required.
  - Also fixed `.fleetplan-header`: the Fleet Plan markup uses class
    `fleetplan-header` but the flex row styling only targeted
    `.battleplan-header`, so its children stacked vertically (~123px tall
    header). Shared the `.battleplan-header` rule (+ its `h2`) with
    `.fleetplan-header` → compact 65px row like the Frontier Battle Plan.
  - NOTE: a Playwright probe that measures layout synchronously right after
    `showScreen()` reads the footer ~6px low — that's the `menu-fade-in`
    entrance animation's `translateY(6px)` first frame, not a layout bug;
    disable animation or wait 200ms to measure the resting layout.
  Verified: real Fleet Plan + Battle Plan at 390px wide — screen fits the
  viewport, body scrolls to reveal the WINGS section, LAUNCH footer stays
  pinned + fully visible.

### 2026-05-29 (interactive end-of-battle report)
- **The match-over report is now interactive instead of tap-to-dismiss.**
  Four tappable tabs (Overview / Fleets / Capitals / Strike), tap-to-expand
  capital + strike-craft rows (detail card: allegiance/class/kills/damage/
  accuracy/fate + flagship note), scrollable panel, and an explicit
  CONTINUE / RETURN button. Applies to ALL modes (the tabbed
  `renderBattleReportHTML` output is shared by the skirmish/custom panel,
  the Frontier per-battle AAR, and the career-summary screen).
  - **LOAD-BEARING: the report builds ONCE per match.** `_syncMatchOver`
    runs every frame; a new `this._matchOverBuilt` guard makes it render the
    panel only on the first `matchOver` frame and leave it alone after —
    otherwise the per-frame innerHTML rebuild would wipe the player's tab
    choice / expanded rows / scroll position. Reset to false in the
    `!matchOver` branch so the next match rebuilds. Safe because
    `finalizeBattleStats` (game.battleReport) + the matchEnded/runEnded
    handlers (lastBattleReport/runSummary) all run synchronously during
    `update()`, before the HUD's `draw`, so the data is present on frame 1.
  - **GOTCHA: the old tap-anywhere dismiss is GONE.** Removed the
    window-level `pointerdown` listener in main.js (it fired on taps landing
    ON the panel, so you couldn't scroll/tab/expand). Advancing is now the
    HUD CONTINUE button (sets `input.matchAdvanceRequested`, drained by
    `consumeMatchAdvance()` in the frame loop) OR the Enter key — both
    drained every frame so no stale flag lingers.
  - **GOTCHA: one delegated click handler** on `#matchover-panel`
    (`_onMatchOverClick`) handles the button (`data-mo-action`), tabs
    (`data-mo-tab`/`data-mo-pane`), and row expand (`data-mo-expand`) via
    `e.target.closest(...)`. Delegation is required because the report body
    is innerHTML-rebuilt per match — per-element listeners would orphan.
    The panel element itself is stable, so its listener + the static
    CONTINUE button persist.
  - **GOTCHA (keyboard): the panel keydown handler MUST `stopPropagation()`**
    when it activates a control. The global window keydown listener
    (input.js) traps + `preventDefault`s Enter/Space (firing keys) AND Enter
    drives the advance via `consumeEnterPress()`. Without stopPropagation, a
    focused tab/row would be dead (stolen native activation) and Enter would
    dismiss the report. So Enter/Space on a panel control is handled in the
    panel keydown (activate + preventDefault + stopPropagation); Enter with
    focus OUTSIDE a control still bubbles to the window handler and advances
    (intended shortcut). Click + keydown share `_activateReportControl(el)`;
    the expand toggle is gated to the row HEADER (`[data-mo-expand] >
    [role=button]`) so tapping inside an open detail to read it doesn't
    collapse the row.
  - **GOTCHA: `.matchover-panel` needs `pointer-events: auto`** (battle-root
    is `pointer-events:none`) or every tab/row/button tap falls through to
    the canvas. Collapsed capital row is `caret | name | kills | fate`
    (class/damage/accuracy moved to the expand detail) so names don't
    ellipsis on a phone. `game.js` finalize now stamps `shotsFired`/
    `shotsHit` on each `report.capitals` entry for the accuracy line.
  Verified at runtime (Playwright, 0 page errors): 29 checks across custom +
  Frontier-per-battle + career-summary — tab switching, expand/collapse,
  tap-on-body does NOT dismiss, CONTINUE tears down the match, correct
  per-mode button labels.

### 2026-05-29 (fighter weapons nerfed vs capitals)
- **Fighter cannon + fighter missile do reduced damage to capital-class
  hulls.** Two new per-TARGET-klass tables in `game.js`
  (`FIGHTER_CANNON_VS_CAPITAL_MUL`, `FIGHTER_MISSILE_VS_CAPITAL_MUL`,
  keyed frigate/cruiser/battleship/carrier/station; cannon
  0.5/0.35/0.25/0.3/0.3, missile 0.5/0.38/0.25/0.3/0.28 — deeper the
  bigger the hull) applied in `applyDamage` right after the
  `antiCraftBonus` block. Fighters now harass capitals but can't grind
  one down; bombers stay the anti-capital weapon. Implements the "weak
  vs capital armor" the fighter-missile spec always claimed.
  - GOTCHA: tables key on the TARGET's klass and have NO fighter/bomber
    keys, so they're mutually exclusive with the `antiCraftBonus` ×1.3
    and the ×3 `FIGHTER_CANNON_VS_BOMBER_MUL` (those only fire vs
    fighter/bomber targets) — a given target klass triggers exactly one
    branch, no double-dip. Unmapped klass → `!= null` guard → full
    damage (no NaN).
  - GOTCHA: gate is `p.fromKlass === "fighter"` (NOT `ownerKlass`). PD
    rounds are `fromKlass:"pd"`, frigate guns `"frigate"`, bomber/capital
    ordnance + the BB laser beam their own klass — all correctly
    excluded. Multiplier is proportional, so per-race fighter cannon
    (3.6–5) / missile (26–36) overrides all scale down uniformly.
  - GOTCHA: applied BEFORE `bstatRecordDamage` + the shield/cell/module/
    hull cascade (same region as `PD_VS_SHIP_MUL`), so telemetry AND
    every damage layer see the reduced value. Fighter-missile blast/cell-
    chew happens INSIDE the one `applyDamage` call — no separate AoE pass
    to bypass the mul.
  Verified: clean build + 4-lens adversarial review (completeness /
  gating false-pos&neg / interaction / numeric) — `applyDamage` is the
  sole projectile-damage chokepoint, all fighter cannon/missile rounds
  stamp `fromKlass:"fighter"`, no leak past the nerf.

### 2026-05-29 (tighter battle-plan commands — 3-axis orders)
- **Fleet directives became three orthogonal axes** (see
  `BATTLE_COMMANDS_SPEC.md`): STANCE (engage/charge/standoff/hold/fallback),
  TARGET PRIORITY (default/hunt‹class›/focus), ASSIGNMENT (free/escort‹class›),
  plus the orthogonal missiles free/hold. Replaces the old 3-posture
  (hold/free/press) + 5-kind wing model.
  - **Behavior** (`ai.js`): `applyAdmiralPosture` → `applyShipOrders(ship,
    world, target)` implements the 5 stances. ENGAGE = no-op (class AI);
    CHARGE = aim straight at target/enemy-centroid; STAND OFF = kite at
    `effectiveRange` (back-pedal <0.85R, close >R, orbit between); HOLD
    POSITION = anchor (escorted cap, else `ship.holdAnchor` captured on first
    hold) + defend within `HOLD_RADIUS+R`, return if pulled off, never pursue;
    FALL BACK = retreat to the fleet REAR (allied centroid pushed away from
    enemy centroid) + cease fire. `resolveOrders` reads `ship.wingCommand`
    (new `.stance` shape OR legacy `.kind` mapped forward) else the per-class
    `game.directives[klass]` (also legacy-`.posture` tolerant).
  - **FOCUS is now opt-in** (was a blanket pin): only ships whose resolved
    priority is `focus` follow `game.focusTargetId`. The admiral panel's
    **ALL FOCUS** master restores the old "whole fleet piles on the tap"
    on demand. GOTCHA: a bare admiral tap no longer makes untagged ships
    converge — tag classes FOCUS (or hit ALL FOCUS) first.
  - **ESCORT now works for any class** (`ai.js` escort leash de-gated from
    fighter/bomber-only) — "frigates screen the battleship". `fleetcommand.js`
    stamps `escortOf` from `escortKlass` per-class AND per-wing; FREE ROAM
    preserves the auto-escort (no default-plan nerf — same rule as the earlier
    escort-parity fix), so there's no explicit un-leash (the STANCE governs
    movement regardless).
  - **target-class/defend-capital wings no longer overridden by class HOLD**
    — those map to HUNT/ESCORT which keep DEFAULT stance, so they pursue
    their task. (This subsumed an earlier fix.)
  - **Carriers/stations are NOT commandable** — they return before the stance
    layer in `updateAI`; excluded from the Fleet Plan capital rows (they
    still appear in the live admiral grid as a no-op, pre-existing).
  - **UI**: NEW 3-axis chip pickers in the Fleet Plan (`menus.js
    _syncFleetPlan`/`_fpOrderControls`, one delegated `_onFleetPlanClick`) —
    capital class rows (frigate/cruiser/battleship) + per-wing rows, each with
    STANCE/TARGET(+hunt sub)/POSITION(+escort sub), a section missile toggle.
    Live admiral panel: 5 stance buttons + per-class FOCUS toggle + ALL FOCUS
    master. `main.js` `setPosture` now writes `.stance`; new `setPriority`.
  - GOTCHA: the directive shape changed (`{posture,missiles}` →
    `{stance,missiles,priority,priorityClass,assignment,escortKlass}`).
    Directives are transient (re-init each match), so no save migration.
    `ESCORT_SIZE` is now exported from game.js (preview escort-bump math).
  Verified: per-stance behavior (CHARGE closes, STAND-OFF holds range, escort
  leashes capitals), FOCUS gating (focus cruisers converge on the tap),
  full match with a rich plan runs clean (no NaN, 0 throws). FOLLOW-UP: bring
  the 3-axis UI to the Frontier Battle Plan overlay (still legacy chips,
  mapped forward).

### 2026-05-29 (bug-review fix pass)
- **Eight bug fixes from a high-effort review of the directives work +
  core gameplay.** (1) **Wave Survival instant-loss**: `waves.js#checkEnd`
  sniffed `isPlayer`, but TAKE COMMAND/spectate clears it (hull gets
  `wasPlayerShip`) → match forfeited the instant you opened admiral view.
  Now matches `isPlayer || wasPlayerShip`. (2) **Admiral stuck state**:
  the SPECTATE pill stayed live in admiral ("RETURN TO FIELD"); clicking
  it retook the ship but left `admiralMode` on → piloting with no
  controls. `_syncModeChrome` now hides `#spectate-btn` in admiral
  (RESUME PILOT is the sole return path). (3) **Multi-beam laser
  immortality**: the in-flight-beam owner-check read `moduleByName.laser`,
  but `heavyLaser` arrays of ≥2 build `laser-fore`/`laser-aft` and have NO
  `laser` module → beams never died after both bays were shot off. Now
  scans `owner.modules` for any live `laser*` emitter. (4) **Player death
  had no wreck/explosion/loss-tally**: the death block called
  `enterSpectate` (which filters the player husk) BEFORE the wreck/tally/
  telemetry passes. Deferred the spectate hand-off to AFTER those passes
  (`if (playerEliminated && !spectating) enterSpectate` post-kill-pass) —
  GOTCHA: relies on enterSpectate setting `spectating` so the guard fires
  once; voluntary spectate/exit-elimination never hit it (they leave
  `spectating` true or never set `playerEliminated` while not spectating).
  (5) **Wing target-class/defend-capital overridden by class HOLD**:
  `applyAdmiralPosture` fell through to the class-wide posture for those
  kinds, so a class HOLD pulled a "hunt cruisers" wing off-task. Those two
  kinds now early-return (their own target-pref/escort AI drives them).
  (6) **Fleet Plan preview counts wrong**: previewed `fleetMul` even for
  skirmish (which forces `mul=1` at spawn via its race-only customRoster)
  → showed up to 3× the real fleet; and omitted the escort-demand fighter
  bump. `_resolveFleetPreview` now mirrors spawnRoster exactly (`mul = cr
  ? 1 : fleetMul`; escort bump only when `!cr` and base fighters exist —
  needed `export ESCORT_SIZE` from game.js). (7) **Stale plan targets**:
  `_fleetPlanState` persists across opens; a defend-capital/target-class
  target from a prior battle could name an absent class. `_openFleetPlan`
  now `_sanitizeFleetPlan`s — prunes targets not in the upcoming battle to
  "free". (8) **C-hotkey** could drop an eliminated pilot into admiral
  (HUD pill was hidden but the key wasn't gated) — TAKE COMMAND branch now
  also requires `!playerEliminated`. Plus defensive `speed > 0` guards on
  the `leadAim` (ai.js) + `updateMissile` (projectile.js) divides (no
  current spec triggers NaN, but a malformed component patch would). LEFT
  (design calls, reported not fixed): Frontier KIA roll is skipped when
  the hull dies under AI after a voluntary hand-off (may be intended
  "ejected safely"); Frontier "free" wing clears escort while generic
  modes preserve it; Battle Plan / Fleet Plan remain forked (shared CSS,
  duplicated JS). Verified: full custom match to completion (5888 ticks,
  no NaN, 0 throws) + targeted probes for each fix.

### 2026-05-29
- **Battle directives in ALL modes — pre-battle Fleet Plan overlay +
  mid-battle admiral toggle.** Frontier's fleet-direction system is now
  available in every mode (skirmish/custom/open/defend/arena/waves/
  daily/admiral). The behaviour + data pipeline was already built (a
  prior uncommitted session): `fleetcommand.js#applyFleetPlan` stamps a
  transient `fleetPlan` (per-class `classDirectives` + ad-hoc fighter/
  bomber `wings`) onto the spawned blue fleet, `game.js:207` inits
  `game.directives` for every mode, and `game.js:328` calls
  `applyFleetPlan` post-spawn when `modeConfig.fleetPlan` is present —
  ALL wired end-to-end already. This pass added the missing UI + the
  missing input method:
  (1) **NEW generic `menu-fleetplan` overlay** (separate from Frontier's
  run-coupled Battle Plan — do NOT merge them). `_buildFleetPlan`/
  `_syncFleetPlan` in menus.js mirror the Battle Plan DOM-screen pattern
  but read a `run`-free `menuState.fleetPlan` and use ONE delegated click
  handler (`_onFleetPlanClick`) because the body is innerHTML-rebuilt on
  every plan change (per-element listeners would leak). Reuses the
  `bp-*`/`battleplan-*` CSS classes; only the `.menu-fleetplan` screen
  rule + a few `.fp-*` classes are new. CSS flex-direction trap honoured
  (`.menu-fleetplan` gets explicit `flex-direction: column !important`).
  (2) **ALWAYS shown pre-battle.** `_emitStart`'s body split into
  `_buildLaunchParams()`; every non-Frontier launch path (onStart non-
  custom branch, onCustomStart, onSkirmishStart, + the two canvas-click
  starts) now calls `_openFleetPlan(params)` instead of emitting. LAUNCH
  (`onFleetPlanLaunch`) assembles the plan onto `justStarted.fleetPlan`;
  main.js:844 already forwards `choice.fleetPlan` → modeConfig. The plan
  state (`_fleetPlanState`) lives on StartMenu and PERSISTS in-memory
  across opens (no save-schema change). GOTCHA: opening from the custom
  editor leaves `showCustom` set so BACK reveals it again — `fleetPlan`
  sits ABOVE `custom` in the screenName chain; `onFleetPlanLaunch` clears
  both. `consumeCustomRoster` clones (doesn't destroy) so re-entry is
  safe. Wing counts shown are a PREVIEW (`distributeByWeight` on the
  resolved pool); the real split runs at spawn on the actual fleet.
  Enemy preview is null for modes that randomise the hostile race in
  `mode.setup` (arena/open/daily) → overlay shows a "randomised at
  launch" note instead of a wrong roster.
  (3) **Mid-battle admiral toggle was BROKEN — fixed.** main.js:878
  called `input.consumeAdmiralToggle()` which **never existed** (same
  unfinished session) — it threw every gameplay frame, silently killing
  the RAF loop's admiral path. Added `consumeAdmiralToggle()` (C key +
  `_admiralToggleEdge` flag) + a HUD "TAKE COMMAND / RESUME PILOT" pill
  (`#command-btn`, sets the edge flag like the SPECTATE pill sets
  `spectateBtn.justPressed`). `_syncModeChrome` shows it except in
  standalone admiral mode + after elimination, and flips the label when
  admiral was entered via the toggle (`game._admiralByToggle`). Verified
  via Playwright: overlay renders (6 class rows, 18 posture chips, 4
  missile toggles, wings + sub-pickers), LAUNCH assembles the plan, all
  100 blue fighters get `wingCommand` stamped, a full match with hold/
  press/target-class/defend + missile-hold runs to 66s with ZERO throws,
  and TAKE COMMAND→RESUME PILOT round-trips cleanly. Plan doc:
  `PLAN_DIRECTIVES_ALL_MODES.md`.
  GOTCHA (escort parity): `applyFleetPlan` only stamps the BLUE side, so a
  "free" wing now intentionally LEAVES `escortOf` as `assignEscortPacks`
  set it (was: cleared for all non-defend wings). Otherwise a do-nothing
  default plan stripped the blue fighters' auto-escort leash while red
  kept theirs — a one-sided nerf just for routing through the overlay.
  Only hold/press/target-class clear escortOf now; defend-capital sets
  it; free preserves it. Verified default-plan escort count ≈ vanilla.

### 2026-05-28
- **HUD roster fixes + in-depth end-of-battle report.** Three things.
  (1) **Surrendered ships no longer counted active.** `countBySide` +
  the minimap "units" count gated only on `!s.dead`; added
  `&& !s.surrendered` (surrendered = untargetable drifting hulks, out
  of the fight). (2) **Mobile roster overlap.** The two side-strips
  stack at top:6 / top:34 on `max-width:767px`, but each row is ~38px
  tall → they overlapped ~10px. Bumped `.side-right` to `top:48px`
  (desktop/tablet were never overlapping — checked widths). (3) **NEW:
  full battle report (all modes)** via new `game.battleStats`
  telemetry → `game.battleReport`, rendered by `renderBattleReportHTML`
  in the match-over panel (appended below the Frontier AAR / career
  summary; sole content in skirmish/custom/open/defend). Tracks per
  side+class committed/lost/surrendered/survived, kills, damage dealt,
  shots+accuracy, missiles, duration, MVP, per-capital lines (name,
  K/dmg, fate), strike-craft aggregate. Instrumentation: shots counted
  once in the projectile loop (`_statSeen`, PD excluded from accuracy);
  damage+hits+last-damager stamped in `applyDamage` (laser path now
  threads `beam.ownerId`/`beam.side` so beam kills attribute); kills/
  losses in a `_statDead` death pass (separate from the wreck loop,
  which skips stations). GOTCHA: per-class buckets are derived from
  per-ship **terminal `fate`** in finalize, NOT incremental counters —
  a ship can surrender then be over-killed by in-flight ordnance, so
  incremental surrendered+lost double-counted (committed ≠ sum). fate
  flips surrendered→lost on death (death pass runs after the surrender
  pass), giving exactly one bucket per hull. Verified via Playwright:
  full skirmish to matchOver, committed === survived+lost+surrendered
  both sides, panel renders, 0 throws.

### 2026-05-28
- **Thren carrier (capital) buff pass.** Four coupled changes to the
  Thren bio-carrier — the race's only capital. (1) Bow cannon damage
  ×4 (55→220) and projectile speed ×1.3 (560→728) in `races.js`.
  (2) Cannon *module* HP ×3 (280→840, hullPenalty 110→330) in
  `modules.js` — the gun is meant to tank focus-fire. (3) Block size
  restored to default while keeping the radius-440 hull: new
  `CELL_GRID_OVERRIDES` in `sprites.js` gives `thren.carrier` a 96×52
  grid (2× the shared 48×26). GOTCHA: the radius bump (220→440)
  doubled `cellW = R*2/cols`, so blocks rendered 2× normal; doubling
  the grid cancels it exactly (cellW 9.17px, same as pre-bump). Side
  effect is ~4× the cell count (1248→4992 pre-cull) ⇒ the carrier is
  much tankier (per-cell HP unchanged) — intended, on-theme with the
  buff, but watch perf with 2 carriers/side and re-check surrender %s
  if they feel off (block-loss is ratio-based so thresholds hold).
  Override keys on `(race, klass)` so other carriers are untouched.

### 2026-05-28
- **Spectate HUD cleanup — target-panel label + vitals-bar gate.**
  Two display bugs reading wrong from the screenshot:
  (1) **Target panel header showed hardcoded red "MARKED"** on every
  observed ship — including allies. The label was a static string in
  the panel's innerHTML and never updated. Cached the ref as
  `#target-label` and updated `_syncTargetPanel` to set the text from
  `SIDES[ship.side].name` ("ALLIED" / "HOSTILE") and the color from
  `palette.primary` (cyan / red). Inline style.color overrides the
  hardcoded `color: #f66` in `.target-label`. Future: if a per-ship
  rival/marked flag lands, swap to "MARKED" in red as a special case.
  (2) **Bottom vitals bar showed during spectate** — the `_syncVitals`
  flow correctly falls back to the spectated ship when the player is
  dead, but the bottom vitals strip showing the locked target's shield
  at 100% read as "the player is alive at full shields" while the
  player is in fact KIA. The target panel on the left already shows
  the shield + module readouts of the spectated ship, so the bottom
  bar is redundant. `_syncModeChrome` now hides `#vitals-bar` outside
  piloting (was: hidden only in admiral). Verified at 412×800 mobile
  size: target label reads "ALLIED" in cyan when spectating a friendly
  frigate; vitals bar is hidden. (Side-strip count visibility was also
  checked — counts are present + visible in the DOM for both rows;
  the screenshot's apparent "missing FRIENDLY counts" was a misread.)

### 2026-05-28
- **Fighter accuracy buff vs strike craft (bombers + fighters).**
  Three coupled changes so fighters actually land shots in dogfights
  instead of spraying:
  (1) **`leadAim` iterates twice.** The one-shot estimate
  (`t = dist / speed`) ignored how target motion changes the time-
  to-target — fine for slow capitals, poor for fighters chasing
  fighters/bombers at 250-500 u/s. Now estimates t against the
  predicted future position once, then re-estimates t at THAT
  point. Converges inside ~5% of the analytic solution for typical
  engagement geometry. Used by fighter approach + cruiser/frigate
  cannon — both get the buff for free.
  (2) **Tighter fire-alignment when target is small.** Fighter
  approach state's `c.firing` gate goes from `aligned > 0.92`
  (≈23° cone) to `aligned > 0.94` (≈20° cone) when `target.klass`
  is fighter/bomber. Hard enough to bias shots ON the silhouette;
  not so hard that fighters never fire (an earlier 0.96 was too
  restrictive — fighters only got 4 shots off per fighter per 10s).
  Sets `c.aimingAtSmall = true` on the controller so the fire path
  can see the tag.
  (3) **Spread halved when `c.aimingAtSmall`.** Fighter cannons
  carry `spread: 0.05` rad → ±2.9° random angular offset per shot
  → ±25u scatter at 500u range, wider than a fighter's hit radius
  (~24u). The fire code in `updateShip`'s primary-weapon loop
  reads `ship.controller.aimingAtSmall` and applies `spreadMul =
  0.5` to the spread, halving the cone. Cleared in the break-state
  branch so a fighter coasting away doesn't keep the tag.
  Verified: 8v8 fighter-vs-bomber, 10s sim — 42 cannon shots
  fired, 26 detonated on contact (vs ttl expiry) = **72.2% on-
  contact hit rate**, 2 bombers killed. Capital cannons targeting
  small craft keep their normal spread (the AI flag is only set by
  the fighter approach state). GOTCHA: `c.aimingAtSmall` is on
  the per-ship controller — the fire path reads it via
  `ship.controller.aimingAtSmall`, so any future AI type that
  fires cannons at small craft (e.g. frigate ring battery) would
  need its own flag-stash to opt in.

### 2026-05-28
- **Block damage = alive-till-dead; ship-armor bar GONE; per-block +
  per-module armor.** Three coupled changes that simplify the damage
  read and push toughness down to the structures that take the hit.
  (1) **Cells render at full brightness until they die** — the old
  `bright = 0.30 + frac*0.70` in `cellFillColor` tinted cells darker
  as their hp dropped, communicating damage as a wounded-hull
  texture. Removed: surviving cells stay at full faction-tinted
  color, dead cells just wink out. The momentary impact ember
  (cell.flash drawn in ship.js) stays as transient feedback. Also
  optimised `damageCellsInRadius`: `ship.blockDirty` now only flips
  when a cell actually dies (was every hp tick), so the block-canvas
  rebuild fires once per cell death instead of per damage event.
  (2) **Ship-level armor REMOVED.** Dropped `ship.armor` /
  `ship.armorMax` / `ship.armorFlash`, the Step 2 armor cascade in
  `applyDamage`, and the armor bar above the hull in `drawShip`.
  `spec.armor` entries in classes.js are now inert (kept rather
  than ripped out to avoid touching every spec). Replaced the
  `ship.spec.armorMax > 0` capital-detection proxy (used to scale
  module-death VFX + SFX intensity) with an explicit klass check.
  (3) **Per-cell + per-module armor (0..1 reduction).** Cells now
  carry their own `armor` field (initialized from `FACTION_CELL_STATS`
  — heavy capitals get higher per-cell armor than strike craft;
  read by `damageCellsInRadius` so each cell applies its own
  reduction). `buildModules` accepts a `defaultArmor` parameter and
  stamps each module with `armor` (a LAYOUTS entry can override per-
  module via `m.armor`). `applyDamage`'s module step reduces
  incoming `dmg * weight` by `(1 - module.armor)` before subtracting
  from module hp. armor-piercing ordnance (torpedoes) skips both
  layers. GOTCHA: balance shifted — previously capitals had TWO
  layers (ship-level armor at wearRate 0.5 AND per-cell armor 0.3
  via `ship.cellArmor`), now just one (per-cell). Effective damage
  reduction dropped, so capitals take more cell damage than before;
  tune `FACTION_CELL_STATS[race][klass].armor` higher if cell
  attrition feels too fast. GOTCHA: `cellArmor` on the build-cells
  result is still set (for any callers reading it) but no longer
  used by damageCellsInRadius — that reads per-cell `cell.armor`.
  Verified: damage sheet (5 classes × 3 damage levels) shows full
  brightness surviving cells, no armor bar; 10s combat smoke (232
  ships → 52 eliminated, 815 detonations, 39 cells dead, zero
  throws). Clean build.

### 2026-05-28
- **Projectile impact snaps onto the actual block / bubble.** Logic
  was already correct (block-test gate allowed pass-through of dead
  cells when shield was down), but VISUALS spawned at `p.pos` — the
  projectile's last-step world position. Two failure modes that read
  as "weapons stop at the undamaged hull": (1) **shield down +
  half-destroyed hull**: the projectile's current position could be
  just barely overlapping a live cell (broad-phase circle is bigger
  than the polygon, so projectile is in empty space within the
  circle), so `spawnHitSparks` / scar / hit-event landed outside the
  cell. (2) **shield up**: broad-phase impact is at `spec.radius + 4`
  but the bubble visual is drawn at `spec.radius + max(12, R*0.40)`
  — projectile flashed INSIDE the bubble (40-70u inside on a BB).
  Fix in two parts:
  (a) New `projectileBlockHitCell` (sprites.js) — same disc-vs-live-
  cell test as `projectileBlockHit` but returns the CLOSEST live
  cell intersected (or null). Legacy boolean wrapper kept.
  (b) game.js collision now snaps `p.pos` BEFORE `applyDamage`:
  shield-down hits → snap to the hit cell's world centre (cell.lx/ly
  rotated by ship heading + ship.pos); shield-up hits → snap to the
  bubble's surface (`spec.radius + shieldOffset`). All downstream
  visuals (sparks, scars, hit events, missile blast origin) now land
  on the visible structure or the visible bubble — never in empty
  space outside the polygon. Pass-through over dead/culled cells
  still works (returning `null` cell → `continue` skips this ship).
  GOTCHA: applyAndAgeBeams already ray-marches to the first live
  block when shield is down and synthesises `pos:{x:hitX,y:hitY}` on
  the damage event, so beams are untouched — they were already doing
  the right thing. Verified: 3-scenario probe (live cell snap, dead-
  cell pass-through, shield-bubble snap) all pass; 10-second combat
  smoke (296 ships → 74 eliminated, 859 detonations, 200 cells dead)
  with zero throws. Clean build.

### 2026-05-28
- **SFX cutout fixed via concurrent-voice cap; heavy guns louder;
  laser beam silenced.** Three changes in audio.js:
  (1) **Concurrent voice ceiling**: per-frame budget capped NEW voice
  *creation* but didn't limit how many voices were CONCURRENTLY live.
  Each `_burst`/`_tone` lives ~0.1-0.5s; broadside `_gunReport`
  spawns 3-4 sub-voices each. In sustained brawls concurrent count
  climbed past the iOS / Capacitor WebKit ~32 simultaneous-source
  ceiling — beyond that the browser drops new voices silently
  ("SFX cuts out mid-game"). Added `_liveVoices` counter:
  `_disconnectOnEnd` increments on creation + decrements (idempotent
  via `cleaned` flag) on source `onended`. `_sfxOk` gates new voices
  against the count: heavy gate at `>=_maxLiveVoices-4` (room for a
  full 3-4 sub-voice heavy burst); light gate at `>=_maxLiveVoices-8`
  (wider berth so a heavy call landing in the same frame still has
  slots). `_maxLiveVoices = 28`. Verified 20s marathon stress
  (heavy guns + light chatter every frame): peak live count 28,
  428 of 429 heavy calls played, ctx stays "running" throughout,
  drains cleanly post-stress. Also reset count on `start()` so
  stale state from a backgrounded run doesn't carry over.
  (2) **Heavy weapons louder**: broadside v 1.6→2.1 (+ thump peak
  0.5→0.7), heavycannon 1.5→1.9, cruisercannon 1.5→1.8. Increased
  reverb sends (0.36→0.42 broadside, 0.30→0.34 heavy, 0.22→0.26
  cruiser) so the big guns ring out further. Safe to bump now that
  the voice cap means each heavy shot gets its own slot instead of
  stacking-and-ducking the limiter.
  (3) **Laser beam SILENT**: `sfxBeam` is a no-op. The 3s sustained
  oscillator stack (4 oscillators × beam duration) was the worst
  offender for the iOS node-cap breach — multiple BB lasers + a
  carrier or two in flight = 12+ persistent oscillators eating
  slots. Visual is loud enough. GOTCHA: function preserved (not
  deleted) so the main.js event subscriber doesn't need a gate.
  GOTCHA: each `_gunReport` calls `_sfxOk(heavy)` ONCE but spawns
  multiple `_burst`/`_tone` sub-voices internally — that's why the
  gate has to leave room for the whole burst, not just one slot.

### 2026-05-28
- **Strike-craft visibility + sleeker silhouettes.** Two-part fix
  for "fighters/bombers are hard to see and look bulbous". (1) Added
  a baked-on silhouette outline to the block-canvas builder
  (`rebuildBlockCanvas`, sprites.js): for `klass==="fighter"||"bomber"`
  it traces the hull polygon as a thick dark halo (R*0.16) then a
  side-tinted line (R*0.08) on top — strike-craft now read as
  stencilled icons against the starfield instead of dissolving into
  the projectile noise. Capitals skipped — their sheer cell mass is
  its own silhouette. Sprite outline got the same double-stroke
  treatment for the sprite path (used by stations + fallback).
  (2) Redesigned all 10 strike-craft polygons (fighter/bomber × 5
  races) in `ship.js#HULLS`: needle prows, hard-swept wings pinned
  to the centreline mid-body, distinct twin-engine block aft with a
  centerline exhaust notch. Max|y| pulled from 0.70-0.95 down to
  0.50-0.64 — they now read as darts, not fans. Faction identity
  preserved (Terran clean, Reaver barbed/forked, Hegemony stepped
  armour, Voidsworn needle, Thren organic manta). (3) **Thren
  radius bump** (races.js): Thren fighter `radius` 8→16, bomber
  15→22. The 2026-05-27 strike-craft enlargement (fighter 14→24,
  bomber 16→28) was applied to `CLASSES` in classes.js but Thren
  overrides the radius in races.js, so the enlargement skipped them
  — Thren strike craft stayed 1/3 the size of the rest, invisible at
  default zoom. Bumped to keep them visibly smaller than others
  ("slippery" identity preserved) but no longer dots. GOTCHAS:
  (1) New polygons are y-symmetric + CCW (probe checks signed-area
  sign consistency across all 10); (2) all 45 modules across the
  10 craft sit on a live cell (collision-aware snap); (3) cellH
  derives from `max(0.70, max|y|)`, so the narrower hulls don't
  shrink the cell grid — cells past the polygon are culled
  individually by the ray-cast point-in-hull test. Net is a smaller
  hitbox (fewer live cells) which buffs strike-craft survivability
  slightly — acceptable, the user wanted sleeker silhouettes; if
  this reads as too tanky in playtest, drop cell HP modestly.
  Self-intersection trap: an early Thren polygon zigzagged at the
  tail (x went out-in-out) which made the point-in-hull test
  unreliable — kept monotonic y rises + clean tail closure.

### 2026-05-28
- **NEW CAREER from home + play hub (mid-run).** Previously the home
  hero card and play-hub Frontier card only routed to RESUME when a
  run was active — to start fresh you had to enter the run map and
  use the overflow ABANDON. Added a secondary CTA on both surfaces
  (`#home-cta-secondary` un-hidden as "NEW CAREER";
  `#playhub-frontier-new` "+ NEW CAREER") that opens a confirm
  overlay (`menu-newcareer-confirm`, `_buildNewCareerConfirm`)
  showing the active officer's rank + callsign + act. CONFIRM
  dispatches `onRunChoice("abandon-run")` (synchronous via main.js
  `refresh()` → setRoguelite, so `runState.run` is null before the
  next line runs) then opens run setup. CANCEL just hides the
  overlay. Wired via four new menu callbacks: `onHomeNewCareer`,
  `onPlayHubNewCareer`, `onNewCareerConfirm`, `onNewCareerCancel`.
  Menu-state plumbing follows the existing overlay pattern
  (`showNewCareerConfirm` flag → screenName chain + `hasSubOverlay`
  + `_buildMenuState.newCareerConfirm` payload + sync). GOTCHA:
  remembered the CLAUDE.md flex-direction trap — extended the
  `.menu-promotion, .menu-preamble, …` selector to include
  `.menu-newcareer-confirm`. Without it the overlay panel would
  render as a row instead of a column.

### 2026-05-27
- **Projectile collision is block-based, not circle-based.** New
  `projectileBlockHit` requires a shot to overlap a live cell before
  `applyDamage` — except when shields are up (bubble = circle). Shield-
  bypassing missiles always use block test. Beam impact ray-marches to
  first live block when shield down. Tightens collision on intact thin
  hulls too (intended). Gate: `shieldUp = shieldMax>0 && shield>0`.
- **Cruiser cannon arc widened to ±90°** via `cannonArc: π/2` on
  `CLASSES.cruiser`. `cannonTurnRate` default 0.7 rad/s.
- **Battleship broadsides traverse ±25° per side** (50° arc).
  `slewBroadsideAim` keeps per-side `broadsideAimPort/Stbd`; muzzle
  ORIGINS still on the beam (flank-mounted), only direction + barrel
  art rotate. Nautical-name crosswise pairing holds: +y-flank guns
  (`broadside-stbd-*`) fire the PORT beam.
- **Strike craft enlarged.** Fighter r 14→24, bomber 16→28 — crosses
  `detail` LOD threshold. R-invariant for overlap (offsets + radii both
  scale with R).
- **Module placement port↔starboard symmetric.** `buildModules` emits
  PD as MIRROR PAIRS about long axis. New `snapModulesSymmetric`
  (sprites.js) pairs off-axis modules, pins centreline + lone-off-axis
  to axis, snaps +y member to nearest clear block (y-symmetric polygons
  guarantee mirror clears). Lone off-axis modules are pinned to
  centreline (a solitary off-axis mount is itself asymmetric).
- **Module overlap fix; capitals enlarged.** Module disc area exceeded
  hull area; fix via per-class `MODULE_RADIUS_SCALE` (fighter 0.90…
  battleship 0.68…station 1.0), PD builds LAST with collision-aware
  `pdSeatAtFraction`, engines build before PD. `snapOffsetToLiveCell`
  is collision-aware (threads `placed[]` + `selfR`). Capital radii
  bumped (frigate 54→62, cruiser 90→106, BB 156→184, carrier 180→208)
  — purely cosmetic re: overlap (R-invariant), but a real gameplay
  change (bigger hitboxes/collision).
- **Module art overhaul — per-faction 3D hardware.** Shared toolkit in
  ship.js (`drawModuleBase`, `modShapePath`, `drawRivets`,
  `drawFactionFlair`, `energyGlow`, `drawBarrel`, `modPulse`). Per-
  faction `MODULE_STYLE`. **Gotchas**: (1) `FACTION_SHIELD`/`FACTION_MODULE`
  key was `reaver` not `reavers` — every Reaver module was falling
  back to Terran blue; (2) `moduleKind` now prefix-matches `laser*`/
  `torpedo*`/`shield-generator*`; (3) gradient/rivet/flair gated on
  `detail` (screenRadius≥12).
- **Every module sits on a live ship block.** Three independent
  placement systems disagreed: (1) cell grid `cellH` now derives from
  hull's true max|y| (floored at 0.70 so Terran is byte-for-byte
  unchanged — `rows` count untouched to avoid HP/balance drift);
  (2) `snapOffsetToLiveCell` pulls stray module offsets onto nearest
  live cell (PD + broadside read `offset` so this is gameplay-relevant
  for them; gun/cannon/missile/laser/torpedo spawn from spec+heading
  so it's visual-only); (3) PD turret ART now reads
  `moduleByName["pd-"+i].offset` (was a fixed 0.75R ring).
  Pre-existing bug fixed: `pdTurretOffset` called `pdTurretToModuleName(i)`
  with one arg, sig is `(klass, i, n)` → silently fell back to ring for
  the whole game.
- **Missile redesign + hull block culling.** `buildCells` uses ray-cast
  even-odd polygon test (was ellipse); culled cells excluded from
  damage/draw/count. Every class gains `shield-generator[-port/-stbd]`
  — destroying one halves `shieldMax`. BB gets `torpedoes` spec
  (armorPiercing + bypassShield + blastRadius:65); `updateTorpedoFire`
  in ship.js. All missiles carry `blastRadius`. Fighter missiles get
  `antiCraftBonus:1.3` vs fighter/bomber. Carrier gains 3 light pods
  for self-defence. **Surrender hardened**: disarmed condition now
  requires `weaponLoss≥threshold AND blockLoss≥0.65`. HUD strips
  shield numeric + armor bar (block grid is the readout). **Gotcha**:
  `ship.totalLiveCells` must be >0 for block-loss % to work; null grid
  → block-loss gate always false → surrender blocked.

### 2026-05-26
- **PD inward-normal flip removed.** Hull polygons are CCW so inward
  normal is unconditionally `(-dy, dx)`; the centroid-direction
  heuristic mis-classified concave/sponson edges and pushed those
  turrets outside the hull.
- **Per-cannon broadside modules.** Each side is now 3 individual
  modules (`broadside-{port,stbd}-{0,1,2}`, hp:70 each) instead of one
  battery, positioned by `mod.offset.x * R`. **Surrender math**: BB now
  has 9 offensive modules — killing all 6 broadsides alone is 67% (not
  75% threshold), needs another system gone too.
- **Broadside gate was crosswise.** Side vectors are screen-space:
  `sidePort` points to +y flank but `broadside-port` sits at offset
  y:-0.70 (nautical name = opposite sense). Pair fire side with disc
  physically ON that flank: `sidePort ↔ broadside-stbd`. PD rounds are
  also `kind:"cannon"` (with `fromKlass:"pd"`) — filter on that.
- **Broadside salvo aborts if target leaves the arc / dies mid-volley.**
  Was only re-checking battery module per shot, not target presence.
- **Surrendered ships still take in-flight damage.** Removed blanket
  early-return from `applyDamage`. Missiles set `targetId` at LAUNCH;
  `updateMissile`'s lock-retention only drops `dead`/same-side, NOT
  surrendered → pre-locked missiles land. `acquireMissileTarget` skips
  surrendered, so NEW acquisitions ignore hulks.
- **Fighters counter bombers (3× cannon damage).**
  `FIGHTER_CANNON_VS_BOMBER_MUL=3` applied to `remaining` before layer
  cascade. Cannon only (missiles/PD excluded). Net vs shield is 3×0.5
  = 1.5× base (the prior fighter-vs-shield 0.5 still applies on top).
- **Capitals no longer surrender on engine loss alone at full hull.**
  Engine-trigger now also requires `hull ≤ hullThreshold` (capital: 0.35).
  Disarmed path unchanged. Small craft (no `hullThreshold`) still
  surrender engine-only.

### 2026-05-25
- **Clickable commander dossier rows.** `captaindetail` overlay
  generalised via `kind:capital|wing` field; `_wingDetailRef` on
  input.js. **Gotcha**: live DOM menu is `input.startMenu._menuSystem`;
  callbacks at `_menuSystem._callbacks`, not `startMenu._callbacks`
  (null) — probes must poke the former.
- **Scrollable campaign overlays + captured craft in AAR.**
  `.overlay-panel` gets `max-height:90vh; overflow-y:auto`. AAR shows
  CAPTURED column — `roguelite.js` now copies
  `run._capturedThisBattle` into `lastBattleReport.captured` (hoisted
  out of `if(won)` block).
- **Frontier economy + commander tuning.** Small-craft recruit ×4
  (`RECRUIT_COST` fighter 5→20, bomber 14→56); resupply UI hardcodes
  base prices (`input.js#baseFighter`/`baseBomber`) — must stay in
  sync. Post-engagement reinforcements halved. **Fuel-spend bug**:
  resupplyState was missing `fuel` so all boon rows showed disabled.
  Shared commander perk system (see Frontier section).
- **Story content pass + editorial sweep.** 5 new 3-stage arcs in
  `ARC_DEFINITIONS`, all ids `sa-`/`sa_` prefixed (no collisions).
  `BOSSES[n].description` edited FIELD-BY-FIELD — never replace whole
  object (would nuke rosters).
- **Blueprint derives from buildModules.** Schematic dots now match
  in-game mount positions. Categories with no physical mount fall back
  to `SLOT_VISUALS` (shield = bubble, armor = layer, fighter missile
  = fires from gun).
- **SaveStore flushes on `visibilitychange`.** Mobile/Capacitor often
  fires `visibilitychange` but not `pagehide`/`beforeunload`; pending
  debounced write was lost on app kill → equips reverted on relaunch.
- **PD inset bumped to `turretR * 1.25`** to account for swinging
  barrel art (~1.15× disc radius). Disc-tangent inset alone wasn't
  enough.
- **Edge-mounted guns + PD framework.** `pdTurretLocalOffset(poly, i,
  n, turretR)` distributes turrets by perimeter arc-length, insets
  along inward normal. `buildModules(klass, spec, poly)` stores as
  module offset (single source of truth — ship.js reads it). Forward
  guns pushed to bow edge. Shield stand-off widened to `max(12, r*0.40)`.
- **Hull silhouette revamp — all 5 factions.** Per-faction identity
  preserved (Reaver barbed, Hegemony stepped armour, Voidsworn spear-
  prow, Thren left organic). Collision/modules use spec.radius +
  fractional offsets, NOT vertices → purely visual. Two hull tables:
  shape lives ONLY in `ship.js` HULLS[race][klass]; `components.js`
  HULLS is stats/slots only.
- **Shipyard preview → blueprint schematic.** SVG draughting plate
  (cyan grid, registration ticks, dimension callouts, title block).
  Slot labels replaced with numbered callout balloons + 2-col legend.
- **App icon = exact in-game Terran fighter** (`public/app-icon.svg`).

### 2026-05-25 (audio)
- **SFX cut out via shared-compressor ducking, not node leak.** Live-
  node cleanup is correct. One shared `DynamicsCompressor` (-14/6/
  0.18s) clamped the entire mix ~8–13 dB sustained. Fix: dedicated
  `sfxComp` limiter on SFX path only (-9/8/0.06s release) + retune
  shared `compressor` into a gentle master safety limiter (-3/8/0.08s)
  + trim redundant broadside `_thump`. **Gotcha**: judge compressor by
  SUSTAINED reduction (median), not inter-sample peaks.
- **SFX node leak fix.** `_disconnectOnEnd(source, nodes)` hooks
  `source.onended` to disconnect the full chain. Wired into `_burst`/
  `_tone`/`sfxBeam`/music voices/`sfxUiTap`. Uses `source.onended=`
  not `addEventListener` — don't add a second consumer.
- **WW2-artillery palette.** Global SFX low-pass @2400Hz hard tone
  ceiling. `_gunReport(size 0..1)`, `_impactThud`, `_detonation` =
  rolling thunder. Removed every highpass burst, every Q≥4 bandpass,
  every >600Hz oscillator. Music hi-hat (7kHz, separate music bus) is
  the only remaining >2.5kHz source.
- **Heavy capital cannons louder.** Loudness order broadside >
  heavycannon ≈ cruisercannon ≫ autocannon.
- **Separate music + SFX volume sliders.** Dedicated `musicGain` bus;
  `master` is a fixed global trim (`MASTER_TRIM=0.32`) never touched
  by mute/volume. `musicVolume`/`sfxVolume` persisted in save schema.
- **Pause-on-hide.** `visibilitychange` sets `paused` flag (frame loop
  early-returns) + `audio.suspendAll()`. On show: reset `last`/`accum`
  (no time jump) + `audio.resumeCtx()` + force `musicWasPlaying=false`.

### Earlier 2026-05 (rollup)
- **Home SKIRMISH + CUSTOM tiles routed correctly** (were both →
  onHomePlay). Live menu = `input.startMenu._menuSystem._callbacks`.
- **"Ghost fighter" fix — `promotePlayer` is idempotent.**
  `spawnRoster` already calls it; legacy mode setups (`custom.js`,
  `arena.js`, `daily.js`, `waves.js`) called it again → two `isPlayer`
  ships. Early-return if a live player ship exists.
- **Commander model (Frontier): spectate→AI, death=no respawn.**
  `RESPAWN_SECONDS` removed. `playerKIA`/`playerEliminated`/
  `playerDeathResolved`. matchEnded KIA = `!isAdmiral && !!playerKIA`
  (never ship-sniff).
- **Fuel actually depletes.** No combat/elite/boss refunds.
  `ACT_REFIT_FUEL=8` Math.max top-up between acts only.
- **Detour-graph act map.** Greens extend acts (extra jump), not
  shortcut. Combat spine + fractional-col detours.
- **Event-choice feedback.** Stamp `_lastEventResult` AFTER `refresh()`.
- **Faction relations Phase 1.** `battleReputationPreview` single
  source. Allied reinforcements tagged + non-persistent. Coalition
  excluded.

### 2026-05-24
- **Captured ships keep their race.** Multi-race blue fleet via
  `blueTeams`. **Recount-before-capture ordering is load-bearing.**
- **Surrender-targeting bug sweep.** 7 more target loops gained
  `o.surrendered` skip. `enemyHullProximity` intentionally still
  avoids surrendered hulks (physical obstacle).
- **Variable post-engagement reinforcements.** Per-archetype rolled;
  salvage scales with kills (capped).
- **Named wing commanders + traits.** `applyWingCommanderEffect` must
  clone `spec` + `spec.weapon` before mutating.
- **Wing size bounds 2–5.** User-action constraints, not data
  invariants — `rebalanceWings` doesn't enforce.
- **Multi-wing system.** Per-ship command supersedes class directive.
  Escort leash extended to bombers; stale defend-capital → free.
- **Battle Plan pre-flight overlay.** Wing commands map to existing
  `game.directives`.
- **Small-craft engine surrender + AI engine focus.**
  `AIM_PRIORITY_BY_KLASS` keys on target.klass.
- **Surrender + capture mechanic.** Per-class `spec.surrender`. PD
  excluded from weapon-loss count. Match-end "alive" requires
  `!surrendered`.
- **Frontier survival check.** 60% start, −18%/death, 5% floor.
  `Math.random` (anti-save-scum). KIA → run ends.
- **BOOST button wired.** AI never sets boost flag. Boost spec cloned
  per-instance.
- **Per-mount weapons + carrier bay split.** Endgame beam components
  stamp `heavyLaser.beamColors` (not `.color`) — would crash beam render.
- **Procedural starmap node variety.** Hue-rotate scoped to colored
  parts; scale baked into bob keyframe.

### 2026-05-23
- **Shipyard MVP + economy + tier scaling.** Default design = stock
  fighter byte-for-byte. Frontier resume bug: `onPlayHubFrontier`
  needs `_layoutRunMap`/`_layoutRunSetup`.
- **Custom/Skirmish regression.** `selectedMode` wasn't stamped
  `"custom"` when opening overlay → `customRoster` dropped. Skirmish
  routes via `mode:"custom"` with races-only roster.
- **Thren = 5th faction.** Fighter/bomber/carrier only; carrier carries
  forward cannon (`cannonAimAngle` init extended to carrier;
  `carrierAI` face+fire branch).
- **Per-turret PD modules + module-gate audit.** Every subsystem gates
  its fire path. `buildModules` now takes resolved spec.

### 2026-05-22 (Frontier campaign + content tiers)
- **Frontier campaign story pass.** 5 acts/ranks, named bosses (bypass
  `scaleRoster`), one-defeat career, memorial wall. Promotion
  auto-open gate moved above sync gate in `input.js#draw` (was
  chicken-and-egg).
- **Tiers 1–18**: officer traits at promotion (chained effective-spec
  stacking), event cards w/ preconditions, declarative boon
  spec-patches (`BOON_EFFECTS`, clone-on-descent), 12-trait pool,
  story arcs, capital ship names+captains, career log + memoir.
- **Mechanical depth**: fuel-stranded detection, phased Act-5 boss
  reinforcement waves.

### 2026-05-21
- **Corner-stuck + stall watchdog.** `enforceWallEscape`; 45s
  no-damage force-ends match (ties→red, player is blue).
- **PLAY + Custom Match carousels.** Mode-relevant step auto-skip
  via `_resetOverlayState` gated on screen change. Capital missile
  pods skip fighters/bombers when `fromKlass !== "fighter"`.
- **Cluster 160° cone + frigates dart + capital crowding.**
  `allyAvoidance` on capitals, ignores small craft.
- **Custom Match multi-faction teams.** `customBlueTeams`/
  `customRedTeams`; `spawnRoster` resolves multi→legacy→race-default.
- **Tracking gun turrets + lasers bury into hull.** Per-turret aim
  angle; beam endpoint stops short of centre.
- **Admiral camera unmovable fix.** Dead canvas
  `AdmiralPanel.handleClick` swallowed pointers; lifted `setPosture`/
  `setMissiles` onto `game`.
- **DOM menu teardown** on every non-Frontier mode (`StartMenu.hide()`
  in draw loop, not startGame).
- **Frontier flow fixes**: JUMP no-op (visibility gate lifted above
  `hasSubOverlay`), stale `run` closure (re-read at click),
  `_launchBattle` cleans up before dispatch.
- **Startup black screen** — restored `InputManager.layoutOverlays`
  (called in resize() before RAF; missing method threw at module-init).
- **AI targets PD + weapon modules before hull** via `pickAimModule`/
  `aimPointFor`. Engines excluded from priority. Aim only — not
  target selection.

### 2026-05-19/20 (foundations)
- **Frontier roguelite** replaces old 100-mission campaign (save
  schema v3). Per-instance capital identity via `runtimeInstanceId`;
  only hull persists between battles. `unlockedFactions` is the
  5th-race extensibility gate.
- **Defensive buff pass.** `PD_VS_SHIP_MUL=0.22` — PD buff is
  anti-missile, not anti-ship.
- **Procedural SFX** (separate `sfxGain` bus); per-frame voice budget
  6; AI weapon SFX 35% gated.
- **Pinch zoom** (spectate/admiral only) + **non-linear capital HP**
  (`HP_TIER_MUL` applied after race merge) + crater hull damage.
- **Multi-stage salvos** (BB broadside + cruiser forward); salvo
  continues past `c.firing=false`; recompute heading per shot.
- **Bigger modules + per-class pixel hulls.** 5 damage stages; cell
  grid per class; budget-based `damageCellsInRadius`.
- **Cruiser refit → long-range artillery.** `s.weapon` may be
  undefined (cruiser/carrier) — guard it.
- **Heavy laser = 3s sustained beam.** Damage spread as dps; AI dodges
  via `beamAvoidance`; beam re-anchors to owner bow each tick.
- **Destructible subsystem nodes.** Routing opt-in via aim; overflow
  continues to hull; callers must supply `hitPos` to `applyDamage`.
- **Persistent wreckage** (`wreckage.js`; caps 160 wrecks / 500
  debris; deterministic scar hash of `ship.id`).
