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
