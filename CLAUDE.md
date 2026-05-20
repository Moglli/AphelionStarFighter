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

### 2026-05-20 — Frontier roguelite campaign (replaces 100-mission campaign)

**What changed**

The old linear 100-mission campaign (`src/campaign.js`, persistent
6-upgrade fighter) is replaced with a **Slay-the-Spire / FTL-style
roguelite**: branching node maps per act, 3 acts per run, capital
ships carry hull damage between battles, small craft (fighters /
bombers) auto-replenish at a drip rate, two currencies (credits +
fuel — fuel gates inter-node jumps). The four existing factions are
the warring opposition (faction set is data-driven so adding a 5th
is purely an entry in `RACES`).

Locked design rules:
- Loss condition: run ends when ALL capital ships are destroyed
  (frigate / cruiser / battleship / carrier). Losing a single battle
  is survivable.
- Fresh starter fleet each new run; surviving ships do NOT carry over
  between runs. Meta-progression unlocks perks + records war progress
  per faction.
- 3 acts × ~16-22 reachable nodes (~45-60 min). Mid-run save/resume
  is mandatory — every act graph is cached on saveStore so a browser
  reload picks up exactly where the player left off.
- At each Battle / Elite / Boss node the player picks FLY (pilot a
  fighter) or COMMAND (admiral posture, no piloted ship).

**Files touched**

| File | What |
|---|---|
| `src/roguelite.js` *(new)* | Core: run-state lifecycle, Mulberry32 PRNG, per-act procgen (6 × 4 candidate slots, type table per column, ≤1 resupply per row), encounter resolution, capital persistence, inter-node drip (REPAIR_RATE 6%, FIGHTER_DRIP 0.5, BOMBER_DRIP 0.25), boon table, 6 event cards, 3 captain perks, 4 hand-curated boss rosters, meta-progression. Exports the public surface main.js + input.js consume. |
| `src/modes/roguelite.js` *(new)* | Mode descriptor. Setup hook reads `game.modeConfig` and switches between fly vs command (admiral spectator camera + directives). |
| `src/modes/index.js` | Registered `rogueliteMode` in `MODES`. |
| `src/save.js` | Schema v3. Added `roguelite: { meta, current }` block to `DEFAULT_SAVE`. v2→v3 migration drops the legacy `aphelion.campaign.v1` localStorage key. `mergeWithDefaults` deep-merges `roguelite.meta` so future perk additions ship without a migration bump. |
| `src/ship.js` | `createShip` accepts `initialHpFrac` so wounded capitals respawn at the previous battle's hull%. Shields/armor still reset to max each match. |
| `src/game.js` | Renamed `startGame`'s `campaign` param to `modeConfig`. Wired `MODES.tick` and `MODES.checkEnd` in `update()` (they were defined on mode objects but never invoked before). `spawnRoster` pops the next manifest entry per blue capital klass and passes `wounded` into `spawnCapitalWithEscort`. `spawnCapitalWithEscort` accepts `wounded`, stamps `runtimeInstanceId` on the capital so the run controller can map it back to its slot. Emits `matchEnded` event on the edge `matchOver` flips true. Resolves perk + bridge-boon sentinels on `playerSpecOverride` before promotePlayer. |
| `src/main.js` | Replaced all campaign imports/wiring with the roguelite controller. `setRoguelite(state, onChoice)` plumbs run state into StartMenu. Handles every overlay action (`new-run`, `abandon-run`, `enter-node`, `enter-node-and-complete`, `complete-node-noncombat`, `buy-repair`/`-recruit`/`-refuel`, `apply-boon`, `apply-event`). Subscribes to `matchEnded` for capital-hp carryover and run-over check; subscribes to `runEnded` for cleanup. Tap-to-restart after a roguelite battle auto-reopens the run map. |
| `src/input.js` | Dropped campaign UI (`UPGRADES` import, `upgradeRects`, `setCampaign`, `onPurchase`, the upgrade-tile grid). Renamed `campaign` chip to `roguelite` / "Frontier" in `MODE_OPTIONS`. Added 5 new overlays — Run Setup (faction picker), Run Map (node graph + fleet panel + currencies), Resupply (repair / recruit / refuel / boon refits), Event (card with 2-3 choices), Battle Choice (FLY vs COMMAND). Click routing intercepts every roguelite overlay before chip rows; START label flips to NEW RUN / RESUME RUN. |
| `src/hud.js` | `drawMatchOverPanel` swapped campaign-specific text for roguelite-aware: "NODE CLEARED" / "FLEET LOSSES", "Tap to return to fleet". |
| `src/progression.js` | Added `runEnded` listener that toasts the run outcome. Meta-progression bookkeeping itself lives in `roguelite.js`'s `recordRunEnd`. |
| `src/campaign.js` *(deleted)* | Replaced by `src/roguelite.js`. |

**Design decisions / gotchas**

- **Per-instance capital identity.** `playerSpecOverride` is a single
  patch; persistent per-ship damage needed per-instance state. The
  manifest is an ordered array `[{ klass, hpFrac, instanceId }, ...]`
  popped by `spawnRoster` in declaration order. Each spawned capital
  gets a `runtimeInstanceId` stamped on it so `captureBattleOutcome`
  can match the live ship back to its slot in `run.capitals` after
  the match. Don't introduce a second consumer of the manifest
  without re-deriving its order from `run.capitals` — the popping
  pattern relies on `Object.entries(roster)` iterating capitals
  before fighters/bombers (insertion order, guaranteed by V8 spec).
- **Only hull persists, not shields/armor.** Shields regenerate
  every frame in combat — persisting shield state would be invisible
  to the player. Armor wear isn't restored mid-match anyway;
  persisting would make capitals progressively softer in opaque
  ways. Hull persistence is legible: "my battleship is at 42%"
  matches the run-map readout exactly.
- **`MODES.tick` and `MODES.checkEnd` were dead.** They were
  documented in `arena.js`'s mode contract but never invoked in
  `update()`. Wiring them is defensive — modes that pass `null`
  (every existing mode) are untouched. The waves mode's `checkEnd`
  now actually fires.
- **`matchEnded` event was being subscribed to but never emitted.**
  `progression.js:160-182` already listens for it. Now emitted from
  `update()` on the edge `matchOver` first flips true, gated by
  `game._matchEndedEmitted` so it fires exactly once per match.
- **Boss-win clears the run synchronously inside `completeNode`.**
  `recordRunEnd(run, true)` + `clearRun()` happen before the
  function returns. `main.js`'s `matchEnded` handler snapshots the
  run reference up front (`runRef`) because the synchronous
  `runEnded` dispatch can null out `activeRun` mid-flight.
- **Resupply nodes pay fuel on CONTINUE, not on opening the
  overlay.** Player can back out without committing — purchases
  inside the overlay (which DO debit credits) are still "real" so
  they don't get refunded. Stacking purchases by repeatedly opening
  the resupply without continuing is not exploitable since each
  purchase costs the same.
- **Energy gate is skipped for roguelite battles.** Each run is the
  energy-equivalent commitment; per-node battles don't drain the
  meter. The Frontier chip's START click opens an overlay rather
  than calling `_emitStart`, so the existing `spendEnergy` path in
  `main.js` never fires for roguelite.
- **`unlockedFactions` is the 5th-race extensibility gate.** All
  four current factions are pre-populated. Adding a 5th race is a
  data-only change: drop a new entry into `RACES`, append its key
  to `DEFAULT_SAVE.roguelite.meta.unlockedFactions`, optionally add
  a `BOSS_ROSTERS` entry. The run-setup overlay reads the unlocked
  list dynamically, so the new chip appears automatically.
- **Tunable constants.** Top of `src/roguelite.js`. If the
  early-act starter fleet feels too generous, edit `STARTER_FLEET`.
  If small craft replenish too fast/slow, edit `FIGHTER_DRIP` /
  `BOMBER_DRIP`. If capitals heal too fast between nodes, drop
  `REPAIR_RATE`.

**How to verify**

```bash
npm install
npm run build      # production build — should succeed
npm run dev        # vite dev server
```

In-game:
- Open menu → pick `Frontier` chip → click `NEW RUN`. Setup overlay
  appears with the four faction chips. Pick `Terran`, click `BEGIN`.
- Run-map overlay opens. Act 1 graph shows ~16-22 nodes across 6
  columns. Right panel shows starter fleet (2 frigate / 1 cruiser /
  1 carrier / 16 fighter / 3 bomber) + 0 credits + 8 fuel.
- Click the entry node → Battle Choice modal pops. Click `FLY` → a
  Terran fighter spawns; the enemy fleet matches the node's
  assigned faction.
- Take damage on a friendly battleship (spectate-cycle on `V`,
  let the AI take hits, or fly into the fight). Win the battle.
- "NODE CLEARED" panel appears. Tap to dismiss → run map reopens.
  The just-cleared node is dimmed; reachable next nodes light up.
  The damaged capital's HP bar shows its reduced %. Fuel -1.
- Pick a Resupply node when one becomes available. Repair a damaged
  capital (cost ≈ `100 × (1 - hpFrac)` credits for a battleship).
  Recruit fighters. Refuel. Hit `CONTINUE`.
- Pick an Event node. Card appears with 2-3 buttons. Pick one —
  mutation applies, returns to map.
- Beat the Act 1 boss → fresh Act 2 graph generated.
- **Reload the browser tab** at the run-map screen. Confirm the run
  resumes at the same node with same graph, fleet HPs, currencies.
- Let your capitals all die → "FLEET LOSSES" panel → tap → back to
  the main menu, Frontier chip now reads `NEW RUN` again.
- Complete Act 3 boss → `meta.runsCompleted++`, `runsWon++`,
  `warProgress[bossFaction]++`. Reload page; counters persist.

### 2026-05-20 — Custom Match: slider-driven roster redesign

**What changed**

The Custom Match overlay was cramped (320px panels, 6 rows of
`[−] [count] [+]` micro-buttons) and slow to use — 60 taps to max a
single class. Rebuilt as a wider, two-panel layout with proper sliders
per class.

1. **Sliders replace the +/- pair.** Each per-class row is now
   `[icon] Name | track-with-thumb | count`. Track is touch-friendly
   (8px visible, full-row hit zone), gradient fill picks up the side
   colour (blue/red), tick marks every 10 ships, thumb grows when
   actively dragged. Tap-to-snap and tap-drag both supported.
2. **Wider panels** — 460px each (down to 280 on narrow viewports)
   instead of 320. Gap between panels tightened from 40 → 24. Overall
   overlay is ~990px on desktop vs the old ~700px.
3. **Header strip per side** — `ALLIED / HOSTILE` label + currently
   selected race name + tagline on a single line, with a side-tinted
   accent rule along the outer edge of each panel that mirrors the
   in-match roster strips.
4. **Race row collapsed to 1×4** instead of 2×2, so picking a race is
   a single horizontal scan rather than reading a grid.
5. **Title + subtitle** ("PICK RACE · DRAG SLIDERS TO SET FLEET") and
   a colour-graded combined totals line above the buttons. CANCEL/START
   buttons match the main menu's gradient/red-pill language.

**Files touched**

| File | What |
|---|---|
| `src/input.js` | New `CLASS_GLYPHS` lookup. `_customDrag` state on the menu. `_layoutCustomOverlay` rewritten — wider, with `track.hitX/Y/W/H` plus visible track rect, per-side `panel` + `header` rects, `_customTotalsY` for the combined readout. `_drawCustomOverlay` + `_drawCustomSide` rewritten in the new chrome language. New `_drawRaceMiniChip`, `_drawClassSliderRow`. `_clickCustomOverlay` now starts a slider drag via `_tryStartSliderDrag`/`_applySliderValue`. New `StartMenu.pointerMove`/`pointerUp` called from `InputManager.onMove`/`onUp` while `menuActive` so a held drag keeps adjusting. |

**Design decisions / gotchas**

- **Tap-to-snap + drag are the same gesture.** Pointer-down inside
  the track hit-zone both sets the value AND opens a drag, so a
  user dragging across a track doesn't have to first land on the
  thumb. If you ever add a "hold for fine-grain" mode, make the
  drag-open behavior conditional or it'll fight the new gesture.
- **Slider hit zone is a row-tall band, not the visible 8px track.**
  `track.hitX/hitY/hitW/hitH` extends 4px on each side and the full
  row height vertically. Trying to drop a fingertip on an 8px
  visible track on a phone is hopeless; the inflated hit zone is
  why this redesign earns its keep.
- **`_customDrag` is cleared on CANCEL, START, and pointer-up.**
  Don't add a path that closes the overlay without clearing it —
  a stale drag would re-engage the next time the overlay opens
  if the same slider rects survived a relayout (and they do; the
  layout function regenerates rects from scratch but the drag
  object holds a *reference* to the previous row).
- **`pointerMove`/`pointerUp` only fire while `menuActive`.** Don't
  hoist them out — gameplay relies on the virtual-stick `move`/`end`
  branches inside the same handlers. The early-return in onMove/onUp
  is gated on `menuActive` so live-game stick handling is untouched.
- **Min panel width 280.** Below that the track shrinks below ~70px
  and sliders become unusable. The overlay will overflow viewports
  narrower than ~610 in landscape; the codebase targets
  landscape/iPad-class anyway. If portrait-phone is a real surface,
  the next pass is to stack the two panels vertically instead.
- **Race chip click still re-seeds counts** to the new race's
  default roster — unchanged from the previous version. Players who
  want to keep their slider values across a race swap should swap
  race FIRST, then tune.
- **Subtitle text claims "DRAG SLIDERS".** If you ever change the
  interaction (e.g., add a +/- back), update the subtitle too — it's
  a discoverability cue, not just decoration.

**How to verify**

```bash
npm install
npm run build        # production build — should succeed
npm run dev          # vite dev server
```

In-game:
- Open menu → Custom → CONFIGURE…. Overlay now spans ~990px on
  desktop, with bigger panels and clear ALLIED / HOSTILE headers.
- Drag a slider thumb — count updates as the thumb moves; thumb
  grows slightly while dragged.
- Tap anywhere on a slider's row (not just the thumb) — the count
  snaps to that x. A continued drag keeps adjusting.
- Tap a different race chip — counts re-seed to that race's roster,
  sliders snap to the new values.
- Push two sliders past 30 ships — the combined-totals line goes
  amber once total exceeds 200, hot orange past 400.

### 2026-05-20 — HUD polish: unified panel chrome + spectator vitals

**What changed**

The previous pass left several panels on the old chrome (full-width
black strips, no border): target panel, match-over, respawn timer.
Also, spectating a fighter/bomber showed *no* HP info anywhere — the
target panel requires modules, and the bottom vitals only ran for the
alive player. Five coordinated fixes:

1. **`drawPlayerHUD` → `drawVitalsPanel`.** Same chrome, now reused
   for the spectated ship. The bottom shield/hull/gun strip now
   appears for either (a) the alive player or (b) the spectated ship
   (outside admiral mode — see below). Spectate border picks up the
   side colour so the camera identity reinforces.
2. **Match-over screen** is now a centered ~540px card with a
   winner-tinted border and a 3px accent rule across the top, instead
   of a full-width black strip across the middle of the screen.
   Soft full-screen dim (`rgba(2,8,18,0.55)`) sits behind the card.
3. **Respawn prompt** is now a small centered pill at `y=110` with
   "RESPAWN IN" label + countdown, matching the panel chrome.
4. **Target panel** picked up `rgba(8,16,28,0.85)` bg + a side-tinted
   accent rule at the top to match the side strip pattern.
5. **Admiral panel** stroke weight bumped from 2 → 1.5 to match
   every other HUD panel (consistency, not visibility).

**Files touched**

| File | What |
|---|---|
| `src/hud.js` | `drawHUD` dispatch rewritten — `player ? vitals : spectating ? vitals(target) : respawn`. New `drawVitalsPanel`, `drawRespawnPanel`, `drawMatchOverPanel`. `drawTargetPanel` chrome unified; accent rule added. |
| `src/input.js` | `AdmiralPanel.draw` lineWidth 2 → 1.5 + bg alpha 0.88 → 0.85. |

**Design decisions / gotchas**

- **Spectate vitals are suppressed in admiral mode.** The admiral
  panel owns the bottom strip there. The top spectate ID pill still
  shows so the camera identity is clear. If you ever move the
  admiral panel off the bottom, drop the `!game.admiralMode` guard
  in `drawHUD`.
- **`drawVitalsPanel` reads only fields present on every ship**
  (`shieldMax`, `shield`, `hp`, `hpMax`, `spec.weapon.capacity`,
  `weaponAmmo`, `weaponReloading`, `weaponReloadTimer`,
  `spec.missile.cooldown`, `missileCd`). Safe for any ship; missile
  block is double-gated on `missileBtn && ship.spec.missile` so the
  spectator path (null button) skips it.
- **Border tint is keyed on `ship.isPlayer`, not on side.** Player
  ship is always blue, but the *intent* is "is this me?". Don't
  switch to `side === "blue"` — it'd repaint a captured/recycled
  red ship's vitals as neutral.
- **Target panel kept at bottom-left** — overlaps with the admiral
  panel left column on narrow viewports (admiral panel is ~772px
  centered; target panel is 296px wide at x=16). Pre-existing; not
  in scope for this pass. Fix would be to retag target panel to
  top-left under the roster strip when `admiralMode` is on.
- **Match-over panel accent uses `SIDES[winner].primary`** — when
  hostile wins, the card's accent goes red, which is the deliberate
  read. Don't switch to a neutral colour "for politeness"; the
  player loss state should feel different from a win.

**How to verify**

```bash
npm install
npm run build        # production build — should succeed
npm run dev          # vite dev server
```

In-game:
- Start an open battle, die to a battleship: bottom shows a small
  centered "RESPAWN IN X.Xs" pill (not bare floating text).
- Press V to spectate a friendly **fighter** (no modules): bottom
  shows the vitals panel with that fighter's shield / hull / gun
  ammo. The spectate ID pill at the top names them; the bottom
  pill identifies their state.
- Press N/B to cycle to a **battleship**: vitals show its shield
  (much larger) + hull, target panel at bottom-left lists its
  modules, both panels coexist without overlap.
- Win the match: a centered card with a 2px green-blue border +
  "ALLIED VICTORY" appears, not a full-width black strip. Lose
  the match: same card with red border and "HOSTILE VICTORY".
- Start an **admiral match**: bottom strip is the admiral panel
  (with a thinner 1.5px border matching the rest). Spectating a
  ship still shows the top ID pill but no second vitals panel
  underneath the admiral panel.

### 2026-05-20 — Custom Match: player-configurable per-side rosters + races

**What changed**

`modes/custom.js` existed as a stub but had no UI to populate
`game.customRoster`, and `startGame` never consulted the MODES
registry — it just called `spawnRoster(game)` directly. This pass
finishes the integration:

1. **`startGame` now dispatches via `MODES[mode].setup`** with
   `{ spawnRoster, promotePlayer }` helpers. Existing modes (open,
   defend, campaign) keep working because they fall through the
   default branch when no hook is registered; `custom` provides
   its own setup which overrides hostile/allied race and passes a
   roster override into `spawnRoster`.
2. **`spawnRoster(game, rosterOverride)`** now accepts an
   optional `{ blue, red }` roster map. Resolution order: explicit
   override > campaign rosters > race-defined defaults. Custom
   and campaign both skip the fleet-size multiplier (their counts
   are deliberate).
3. **Custom Match overlay** in the start menu: a 4th mode chip
   ("Custom"). Selecting it flips the main START button to
   "CONFIGURE…", which opens a side-by-side configurator:
   - Two panels (ALLIED / HOSTILE), each with a 2×2 race chip
     grid (Terran / Reavers / Hegemony / Voidsworn) and six
     per-class counter rows (fighter / bomber / frigate / cruiser
     / battleship / carrier) with [−] [count] [+] buttons.
   - Changing a side's race re-seeds that side's counts from the
     race's default roster, so the player has a meaningful
     starting point.
   - Per-class cap of 60 to prevent runaway counts melting the
     phone. A live total at the bottom turns orange past 400
     total ships as a visual warning.
   - CANCEL closes the overlay; START emits the roster bundle
     through the normal `_emitStart` path and launches the match.

**Files touched**

| File | What |
|---|---|
| `src/game.js` | Import `MODES`. `startGame` accepts a `customRoster` arg, sets `game.customRoster`, and dispatches via `MODES[mode].setup` when present. `spawnRoster(game, rosterOverride = null)` takes per-side overrides; resolution order updated; fleet multiplier skipped when override or campaign is active. |
| `src/modes/custom.js` | Setup hook now applies both `cr.alliedRace` and `cr.hostileRace`, falls back to random hostile if unset, and stops trying to pass a non-existent `game.playerKlass` arg to `promotePlayer`. Module-level JSDoc updated to document the `customRoster` shape. |
| `src/input.js` | New `MODE_OPTIONS` entry for "custom". Added `CUSTOM_CLASSES`, `CUSTOM_MAX_PER_CLASS`, `rosterForRace()`, `totalShipCount()`, `classDisplayName()` helpers. New StartMenu state for the overlay (`showCustom`, `customAlliedRace`, `customHostileRace`, `customBlueCounts`, `customRedCounts`, `customRects`). New methods: `consumeCustomRoster`, `_layoutCustomOverlay`, `_drawCustomOverlay`, `_drawCustomSide`, `_clickCustomOverlay`. Click routing intercepts overlay clicks; START label flips to "CONFIGURE…" in custom mode; `_emitStart` bundles the custom roster when applicable. `layout()` records last viewW/H so the overlay can size itself on open. |
| `src/main.js` | `startGame` call threads `choice.customRoster` through as the new last arg. |

**Design decisions / gotchas**

- **Mode dispatch is dispatch-or-fall-through, not dispatch-only.**
  Existing modes without a `setup` hook still hit the legacy
  `spawnRoster(game)` path. Don't refactor MODES to require a
  hook — open/defend deliberately use the default.
- **Race chip re-seeds counts.** Intentional. Players who want
  to keep the previous count when swapping race should change
  race FIRST, then tune. If this becomes annoying, gate it
  behind a separate "Reset to default" button rather than
  removing the re-seed.
- **Per-class cap of 60.** A double-sided custom match with all
  six classes at 60 = 360 base, plus escorts puts you past 500
  ships before the player. Phones start to chug. Don't raise
  the cap without also tuning the renderer's fill-time budget.
- **Fleet-size multiplier deliberately bypassed for custom.**
  The counts the player typed in are the counts they get; no
  surprise doubling from a leftover "Huge" chip selection.
- **Player class is always fighter.** Future enhancement could
  add a player-class picker to the overlay; for now the existing
  campaign/skirmish convention holds. When adding, set
  `game.playerKlass` and pass it to `promotePlayer`.
- **`game.playerKlass` is referenced by `custom.js` design
  comments but not currently used.** Stub left in for the
  picker future-work; if you remove it, also remove the JSDoc
  hint.
- **Overlay layout is recomputed on every open**, not on
  resize. Resizing the window while the overlay is open will
  leave its rects stale. Closing + reopening fixes it; not worth
  a resize hook for an interaction this brief.

**How to verify**

```bash
npm install
npm run build        # production build — should succeed
npm run dev          # vite dev server
```

In-game:
- Open the menu; the GAME MODE row now has four chips ending in
  "Custom". Select Custom — the START button reads "CONFIGURE…".
- Click CONFIGURE… — the overlay opens with two side panels.
  Swap the HOSTILE race chip to a different race — the counts on
  that side re-seed to the new race's default roster.
- Hit + on Battleship for the ALLIED side a few times; the count
  display + the bottom total update.
- Click START — the match launches with exactly those counts
  (plus per-capital escort fighters — see `ESCORT_SIZE` in
  game.js).

### 2026-05-20 — Multi-stage salvos for BB + cruiser; PD damage nerfed vs ships

**What changed**

Two coordinated balance/feel passes:

1. **PD nerfed vs ships.** Point-defence cannons were doing full
   damage to anything that wandered into the bubble — a frigate's
   4-cannon bank (6 dmg × 4 / 0.26s ≈ 92 dps) shredded fighters in
   well under a second, and capitals chipped each other to death
   passively when they drifted close. `applyDamage` now scales
   incoming PD-cannon damage to `PD_VS_SHIP_MUL = 0.22` (22% of
   listed). PD's anti-missile role is unaffected — that's
   resolved in projectile-vs-projectile collision, not via
   `applyDamage`.

2. **BB + cruiser main guns are now multi-stage salvos.** Both
   primary weapons gained a `salvo: { shotsPerVolley, intraShotDelay }`
   field. Each cycle now fires a tight burst at the ship's current
   aim instead of a single shell. Per-shot damage is lower so the
   headline number is the volley weight, not the individual hit:
   - **Battleship broadside**: 3 muzzles × 3 shots = 9 shells per
     side per 4.0 s cycle, 0.15 s between shells, 50 dmg/shell.
     Per-side DPS ≈ 112 (up from ~81 of the old single-shell), but
     concentrated into 0.45 s bursts so missing the firing window
     hurts more.
   - **Cruiser forward**: 2 muzzles × 4 shots = 8 shells per 1.8 s
     cycle, 0.10 s between shells, 18 dmg/shell. DPS ≈ 80
     (vs ~70 prior).

Once a salvo is committed it runs to completion regardless of
`controller.firing`, so AI ships that swap targets mid-burst still
land the full volley. Each shot uses the ship's *current* heading,
so a salvo tracks a moving target through the burst.

**Files touched**

| File | What |
|---|---|
| `src/classes.js` | Cruiser + battleship `weapon` blocks got a `salvo` field and rebalanced damage/cooldown. Comments updated to call out the salvo profile. |
| `src/ship.js` | `createShip` initializes `salvoShotsLeft`/`salvoShotTimer` (forward) and per-side variants for broadside. Forward-fire loop refactored to step a salvo independent of `c.firing`. `updateBroadsideFire` now takes `dt` and steps port/starboard salvos independently, recomputing the side vector each shot to track ship rotation mid-volley. |
| `src/game.js` | `applyDamage` scales incoming damage by `PD_VS_SHIP_MUL = 0.22` when `p.fromKlass === "pd"`. Constant lifted to module scope with rationale comment. |

**Design decisions / gotchas**

- **Salvo continues past `c.firing` going false.** Intentional —
  matches the "committed volley" feel. AI ships that abort a target
  mid-burst still deliver the salvo. If a future mechanic needs
  a true abort (e.g. EMP), zero out `salvoShotsLeft` directly.
- **`updateBroadsideFire` recomputes `sideVec` each salvo shot.**
  A turning battleship would otherwise spray its volley at the
  initial side vector, looking glued. Don't cache `sidePort/sideStarboard`
  across shots.
- **PD nerf is keyed on `p.fromKlass === "pd"`.** Set in
  `updatePDFire` in ship.js. If you ever add another cannon source
  that should share the nerf (e.g. a deck-mounted plinker), tag
  it with `fromKlass: "pd"` rather than introducing a second
  multiplier.
- **Cooldown is set when the salvo *starts*, not when it ends.**
  So `cooldown = 4.0s` actually means "next volley starts ~4s
  after this one's first shell" — total cycle = cooldown only if
  cooldown > burst duration. Both current values satisfy that
  (4.0 > 0.45, 1.8 > 0.4). Don't drop a cooldown below
  `shotsPerVolley * intraShotDelay` or volleys will overlap and
  the salvo state will double-fire.
- **Magazine consumption is per-shot.** Forward path consumes one
  round per salvo shot. If a reload kicks mid-volley, the rest
  of the volley aborts (`salvoShotsLeft = 0`). Cruiser doesn't
  have a magazine cap so this branch is dormant for now, but the
  behaviour is correct for any future cap.
- **Race overrides deep-merge.** Reavers' cruiser overrides
  `weapon: { damage: 20, cooldown: 0.65 }` — the new `salvo`
  field is preserved from the base spec via `resolveSpec`. If
  you want a race to drop the salvo entirely, set
  `salvo: null` in the override.

**How to verify**

```bash
npm install
npm run build        # should succeed
npm run dev          # vite dev server
```

In-game:
- Spectate a battleship in arena: each broadside fires a visible
  burst of ~9 shells over ~0.5 s, then pauses ~3.5 s before the
  next volley on that side. Port + starboard cycle independently.
- Spectate a cruiser: forward guns chatter in tight 4-shot
  bursts on a ~1.8 s cycle.
- Fly a fighter through a frigate's PD bubble: you should be
  able to make a full strafing pass without dying — PD now plinks
  rather than shreds.
- Watch a missile salvo crossing PD range: missiles still die at
  the original rate — the nerf doesn't touch PD's anti-missile
  effectiveness (that resolves before `applyDamage` runs).

### 2026-05-20 — Per-type module art + capital-scale shield standoff

**What changed**

Modules were still rendering as flat colored discs after the
chip-damage rework — readable but lacked identity. And the shield
bubble used a fixed `+6px` offset that hugged a battleship's hull
so tightly it looked like an outline.

1. **Per-type module art.** Each module kind now renders a distinct
   icon inside its hit disc so the player can tell at a glance what
   they're targeting: a long forward barrel + glowing lens for
   `laser`, a 2x2 silo grid (rotated 180° for `missile-aft`) for
   missile launchers, a casing with three perpendicular cannon
   barrels for `broadside-port/stbd`, an animated dual-barrel
   turret on an octagonal base for `pd-*`, a hazard-striped bay
   door with a launch chevron for `hangar`, a tube with cross-hair
   fins and inner glow for `torpedo-bay`, and a dark nozzle ring
   for `engine-*` (the visible plume already identifies it). The
   icon orientation respects the module's position on the hull —
   broadside cannons point outward, missile-fwd silos point
   forward, etc.
2. **Capital-scale shield bubble.** Shield offset now scales with
   hull radius: `Math.max(6, s.radius * 0.18)`. Fighters and
   bombers keep the existing 6px floor; capitals get a clear
   stand-off (battleship +28px, carrier +32px) so the bubble
   reads as a *bubble* instead of an outline.

**Files touched**

| File | What |
|---|---|
| `src/ship.js` | Added `moduleKind()` classifier, `moduleBodyColor()` / `moduleAccentColor()` HP-keyed palettes, and seven `drawXArt()` helpers (laser, missile, broadside, pd, hangar, torpedo, engine). `drawModuleArt()` dispatches by kind. The existing chip-damage stages (crack chord, wedge cut, red-hot core) now paint *over* the icon. Shield arc offset switched from flat `+6` to `Math.max(6, s.radius * 0.18)`. |

**Design decisions / gotchas**

- **All icons drawn in ship-local coords centered on the module.**
  `drawModuleArt` does its own `ctx.save / translate(mx,my) /
  restore` so each `drawXArt` helper writes in module-local space
  with the ship's +x forward axis. Chip-damage chrome stays in
  ship-local space at `(mx, my)` so it composites correctly.
- **PD turret rotation uses `performance.now()` + ship.id phase.**
  A swarm of 50 PD nests would otherwise spin in lockstep and look
  mechanical. The phase is `ship.id * 0.37` rad — coprime enough
  with the rotation period to avoid clustering.
- **Cell-grid wounded halo and module icons both ignore detail
  gating intentionally for the icon body.** Only the chip-damage
  CHROME (cracks/wedge/red-hot core) is gated on
  `screenRadius >= 12px`. The icon shape itself draws at any zoom
  — it's the primary visual differentiator and roughly the same
  cost as the old single disc.
- **Shield offset floor of 6px preserves small-craft bubble.**
  Don't lower the floor below 4 or fighters lose their visible
  shield ring entirely.
- **Damage chrome obscures icons on critically damaged modules.**
  This is intentional — a module showing a red-hot core glow
  should *not* still look like a clean laser barrel. If you add
  more icon detail later (e.g. cooling fins, ammo counters), keep
  it in the base layer so it gets covered by the same chrome.

**How to verify**

```bash
npm install
npm run build        # production build — should succeed
npm run dev          # vite dev server
```

In-game:
- Pick arena, START, spectate (`V`) onto a battleship: laser barrel
  visible up front, port/starboard broadsides with cannon rows, four
  engine nozzles aft, two PD turrets that visibly rotate over time.
- Spectate a carrier: the hangar bay shows a yellow-striped lip
  and a chevron pointing forward.
- Spectate a cruiser: the central torpedo-bay shows the cross-hair
  fins + inner glow.
- For all capitals: the shield bubble is now visibly outside the
  hull, not hugging it.

### 2026-05-20 — Bigger modules, chip-damage VFX, pixel hulls per class

**What changed**

Damage feedback was hard to read: tiny module discs that didn't
match their hit zones, and a one-shot-per-cell hull grid that meant
fighters and battleships eroded at the same rate. Three coordinated
passes:

1. **Modules bigger + targetable.** Every static module in
   `MODULES` got its radius bumped ~35% so the disc you see is
   the hit zone you're aiming at. The drawShip render multiplier
   went from `0.55` to `0.85` for the same reason — the visible
   disc was previously much smaller than the underlying hit
   radius. A dev-only `auditModuleLayout()` runs once at module
   load and `console.warn`s if any two discs overlap by more than
   25% of their combined radii (gated on `import.meta.env.DEV`
   so prod pays nothing).

2. **Progressive chip-damage states on modules.** Modules now
   render across 5 visual stages tied to HP fraction:
   `0` pristine → `1` hairline crack chord (>55%) → `2` chipped
   wedge + darker inner (>30%) → `3` red-hot core radial gradient
   (>0%) → `4` existing crater + soot ring (disabled). Crossing
   into a worse stage fires a one-shot extra spark burst plus
   continuous-smoke puff so the transition reads as a discrete
   event rather than a slow color drift. Capital module deaths
   now use `intensity=1.4` on `spawnDestructionBurst` (bigger
   shockwave, more sparks/debris) so they feel dramatic vs.
   fighter engine pops.

3. **Pixel-based hulls with per-class HP.** The destructible cell
   grid resolution roughly 4x finer (battleship 16×8 → 40×22,
   cruiser 14×7 → 32×18, fighter 6×4 → 12×8, etc.) so chunks chew
   out at a believable "pixel" scale. Each cell now carries a
   class-scaled HP (`CELL_HP`: fighter 1, frigate 2, cruiser 3,
   BB/carrier 4, station 5) and a `CELL_HULL_COST` per kill
   (fighter 0.25 → station 1.0) that deducts from `ship.hp` so
   the HP bar erodes smoothly with the silhouette.
   `damageCellsInRadius` was rewritten to take a damage *budget*
   that drills inner-cells-first (chip on small hits, tight
   chunks on big hits) and is capped at 1.2× remaining damage by
   the caller. A `deadCells[]` cache on each ship lets `drawShip`
   render voids without walking the full grid each frame; a new
   "wounded-cell halo" pass paints a translucent rust overlay +
   orange dot at hp=1 on alive-but-damaged cells (only when the
   ship's screen radius >=12px, to skip cost on far zoom).

**Files touched**

| File | What |
|---|---|
| `src/modules.js` | All MODULES radii bumped ~35%; offsets nudged to clear overlap. Added `auditModuleLayout()` + one-shot self-call. |
| `src/sprites.js` | `CELL_GRID` rows/cols 3-4x finer per class. New `CELL_HP` + `CELL_HULL_COST` tables. `buildCells` returns `cellHpMax`/`cellHullCost`. `damageCellsInRadius` rewritten: budget-based, inner-first bucket pass, pushes to `ship.deadCells`, drains `ship.hp` by `cellHullCost` per kill. `killCellsForModule` also pushes to `deadCells` and zeros `cell.hp`. |
| `src/ship.js` | `createShip` stashes `cellHpMax`, `cellHullCost`, empty `deadCells[]` on the ship. `drawShip(ctx, ship, zoom)` gained a `zoom` arg + `detail` gate; module render uses 0.85 multiplier + progressive chip stages; dead-cells iterate `ship.deadCells` cache; wounded-cell halo overlay for damaged-but-alive cells. |
| `src/main.js` | Passes `ZOOM` through to `drawShip` so the detail-gate has accurate screen radius. |
| `src/game.js` | `applyDamage` passes `remaining * 1.2` budget to `damageCellsInRadius`; tracks module damage-stage transitions via new `moduleStage()` helper and fires spark+smoke on cross; capital module deaths use `intensity=1.4` on the burst. |
| `src/particles.js` | `spawnDestructionBurst(..., intensity=1)` scales shockwave growth, spark count, debris count. |

**Design decisions / gotchas**

- **`cell.hpMax` no longer stored per-cell** — uniform across a
  ship, kept on `ship.cellHpMax`. If you add a future per-cell
  modifier (e.g., armored prow), reintroduce it as a field on
  the cell, but never as `hpMax` (that'd shadow the ship
  convention used elsewhere for module/ship HP).
- **Budget cap is in `applyDamage` (`remaining * 1.2`),
  NOT in `damageCellsInRadius`.** The 1.2 leaves a small spill
  margin so a hit that lands one pixel off-centre still drains
  the expected number of cells. If you raise this, beam ticks
  will start punching ribbons straight through capitals.
- **Damage-stage thresholds are duplicated** in `drawShip`
  (visual) and `moduleStage()` (transition VFX) — keep them in
  lockstep. Worth extracting into a shared helper if a third
  consumer appears.
- **Wounded-cell halo skips at `screenRadius < 12px`** — a 250-
  ship brawl on a phone otherwise grinds in fill-time on tints
  the eye can't see. If you change the camera ZOOM, retune this
  threshold rather than removing it.
- **`auditModuleLayout()` runs once at module load** and
  self-suppresses outside Vite dev builds via
  `import.meta.env.DEV`. Confirmed zero overlaps after the
  current radius bumps — but if you tweak offsets, watch the
  dev console.

**How to verify**

```bash
npm install
npm run build        # production build — should succeed
npm run dev          # vite dev server
```

In-game:
- Pick arena, START, and spectate-cycle (`V`) to a battleship.
- Fire at the prow: pixels chip out at the impact point in
  small clusters (1 cell on glancing fighter rounds, 5-10 on
  heavier shots). HP bar drains in lockstep.
- Aim at a named module (laser, broadside, PD): the disc you
  see *is* the hit zone. Watch the disc develop a crack, then
  a wedge cut, then a red-hot core as it nears destruction;
  each stage transition fires a spark + smoke puff.
- Watch a capital ship die: module deaths produce noticeably
  bigger shockwaves than fighter-engine pops.

### 2026-05-19 — Fighters/bombers stop dodging; per-capital fighter escorts; bombers flank

**What changed**

Fighters and bombers were spending most of every match avoiding the
fight: the `bigShipDanger` push from any non-fighter enemy outweighed
the fighter's commit-on-target logic, and a forced break-off triggered
the instant they drifted into any PD bubble. Three coordinated changes:

1. **Target exempted from danger.** `bigShipDanger` now takes an
   `excludeTarget` argument and skips it in the push aggregation, so a
   fighter committing a run on a battleship is no longer pushed back
   out by that same battleship's PD/missile/laser envelope. Other
   capitals nearby still contribute normally. Both `flybyAI` (fighter)
   and `bomberFlankAI` (bomber) pass their current target.
2. **Lower avoidance weights + commit longer.** Fighter `danger` blend
   weight 1.95 → 0.55, bomber 2.20 → 0.85. Fighter `MAX_APPROACH_TIME`
   10 → 16 s and the "force break-off if inside any PD bubble" branch
   is gone — shields can soak a strafing pass. Fighter approach also
   no longer suppresses `c.firing` on any danger reading.
3. **Per-capital fighter escorts.** Every escortable capital
   (frigate, cruiser, battleship, carrier) now spawns with a
   class-sized fighter escort: frigate 5, cruiser 10, battleship 15,
   carrier 10. Escorts share a `packId` and use `packRole:
   "hunt-fighter"`; the existing pack-target picker upgrades to a
   bomber when one shows up so escorts will peel to intercept strike
   bombers heading for their charge.

Bombers also got a flank rewrite: instead of orbiting tangentially at
the outer edge of pod range, each bomber picks a flank side (ID parity)
and flies to a slot offset perpendicular-and-slightly-aft of the
target's nose. Once in the slot, the bomber faces the target so its
pod launch geometry and forward gun line up. STANDOFF dropped from
~1500 → ~1350 since the flank approach takes them out of the worst of
the gun arc anyway.

**Files touched**

| File | What |
|---|---|
| `src/ai.js` | `bigShipDanger(ship, ships, excludeTarget)` accepts an exclusion. `flybyAI` passes `target`, drops the inPdZone-forced break-off, drops the firing-suppress on danger, bumps approach timeout to 16 s, lowers REGROUP_DIST + MIN_BREAK_TIME, danger weight 1.95 → 0.55. `bomberStandoffAI` renamed to `bomberFlankAI`; rewritten to fly to a perpendicular-aft flank slot, then face target. Bomber danger weight 2.20 → 0.85, also excludes target. `updateAI` dispatch updated to call `bomberFlankAI`. |
| `src/game.js` | `ESCORT_SIZE` map added. `spawnCapitalWithEscort(game, klass, side, race, zone, facing)` replaces `spawnCarrierWithEscort` and handles all escortable classes uniformly. Escort ring radius widened so 15 fighters around a battleship don't overlap at spawn. Escorts tagged with `escortOf: capital.id` for future HUD/debug. Old per-spec `escortSize` lookup is gone — `ESCORT_SIZE[klass]` is the single source of truth. |

**Design decisions / gotchas**

- **Target-exclude is targeted, not blanket.** Fighters/bombers still
  flinch from OTHER capitals near the kill zone — they just don't
  push themselves out of their own engagement. If you ever add a
  third class of avoidance (mines, hazards, etc.), don't fold it
  into the same exclusion without thinking about whether the
  excluded ship counts.
- **Pack-leashing intentionally NOT added.** Escorts can drift far
  from their charge to chase a bomber. That's the right call —
  the bomber IS the threat to the capital. If you add a leash
  later (e.g., return to the escorted capital after the chase),
  set it via `escortOf` lookup, not by hand-tagging each escort.
- **Single source of truth for escort sizes.** The legacy
  `spec.escortSize` field (carrier class + Reaver/Voidsworn carrier
  overrides) has been removed; `ESCORT_SIZE` in `game.js` is the
  only place to tune squadron sizes. Don't reintroduce a per-spec
  field — keep the map central.
- **Fleet sizes balloon.** Terran arena spawn is now ~103 ships per
  side (vs. ~38 before), Hegemony ~128. If frame rate becomes a
  problem on lower-end devices, the first lever is `ESCORT_SIZE`,
  not the roster — the escort fighters are the bulk of the new
  ship count.
- **Bomber flank uses target heading where available.** Capitals
  have a meaningful heading; fighters don't (they pivot constantly),
  so for fighter targets the flank vector falls back to the
  bomber-to-target bearing. Don't try to use target velocity —
  capitals drift sideways during broadside fire and you'll get
  bombers parking behind a sliding cruiser.

**How to verify**

```bash
npm install
npm run build        # production build — should succeed
npm run dev          # opens Vite dev server
```

In-game:
- Pick arena vs **Hegemony** (heaviest fleet). Each enemy battleship
  should be surrounded by 15 fighters, each cruiser by 10. Watch the
  minimap — both sides should clash in the middle within seconds
  instead of orbiting their own spawn zones.
- Park yourself in spectate near an enemy battleship. Allied fighters
  should commit straight through PD range to make firing passes, not
  arc wide every time. They'll still break off on a fly-through.
- Watch an allied bomber engage an enemy battleship: it should curve
  in from the broadside, not loiter directly ahead of the bow.
  Missile pods auto-fire as before.

### 2026-05-19 — Cruiser refit: long-range artillery (cluster + siege missiles + laser)

**What changed**

The cruiser is no longer a "strike cruiser" with heavy forward guns.
It is now a long-range artillery platform: no primary cannon, three
new weapon systems, and an expanded engagement range.

- **Cluster missiles** (×2 pods): each missile flies out long-range
  and, on approach to its target (within `cluster.bloomDistance`),
  splits into 5 smaller homing warheads that fan out by
  `cluster.childSpread` rad and all home back onto the parent's
  target. Children are hp 1 — PD picks some off, but spreading them
  forces multiple intercepts.
- **Siege missile** (×1 launcher): a single, slow, high-mass warhead.
  240 damage, 18 s cooldown, hp 10 so PD has to commit a salvo.
  Devastates unarmored hulls; armor's `wearRate` blunts it a lot
  against capitals.
- **Single-mount heavy laser**: same machinery as the battleship's
  beam, scaled down — 90 dmg over 2 s, 1700 range, 40% arc.
- **Engagement range bumped**: `aiOrbit: 1500` (was 880) so cruisers
  sit far back as artillery rather than knife-fighting.
- **firingMode**: `"none"` (was `"forward"`) — no primary gun. The
  `weapon` spec field is gone entirely.

**Files touched**

| File | What |
|---|---|
| `src/classes.js` | Cruiser block rewritten: dropped `weapon`, dropped `firingMode: "forward"`, added `siegeMissile`, added `missilePods.cluster`, added `heavyLaser`. Comments updated. |
| `src/races.js` | Reavers' cruiser override no longer touches `weapon` (it didn't exist anymore) — replaced with `missilePods.cooldown/damage` and `siegeMissile.cooldown/damage` overrides so they keep their aggressive-artillery profile. Hegemony's `missilePods.count: 3` and Voidsworn's overrides still merge cleanly. |
| `src/projectile.js` | `updateMissile` now checks `m.cluster` first and calls new `spawnClusterChildren(parent, target, world)` to fan out N missiles toward the same target. Children inherit `parent.fromKlass` but not `.cluster` so they don't bloom again. |
| `src/ship.js` | `createShip` adds `siegeCooldowns` (parallel to `podCooldowns`). `updateShip` ticks them, gates `updateSiegeMissileFire` on `missileOk`. New `updateSiegeMissileFire(ship, world)` launches a single bow missile per cooldown cycle. `updateMissilePodFire` now stamps the spec's `cluster` config onto each launched missile. Cruiser `SUBSYSTEM_LAYOUTS` entry drops the `gun` node and adds a `laser` node at the bow. |
| `src/ai.js` | `bigShipDanger` skips ships with no `spec.weapon` (cruisers + carriers) instead of crashing. `orbitAI` adds an `else if (s.weapon)` branch + a no-weapon fallback that just faces the target so missile / laser arcs align on it. |

**Design decisions / gotchas**

- **Cluster missile damage budget**: `missilePods.damage` is per
  CHILD warhead now (was per missile). 5 × 30 = 150 if all hit. PD
  / evasion reduces that, so cluster is balanced against single
  torpedoes by being harder to fully intercept.
- **Children home on the parent's target.** Not on independent
  targets — that would dilute damage. Spread is purely spatial
  (different headings) so they cover area against a moving target
  and force PD to engage multiple incoming tracks.
- **Children don't carry `.cluster`.** Only missiles spawned by
  `updateMissilePodFire` get tagged. If you ever want recursive
  cluster (children of children), set it explicitly inside
  `spawnClusterChildren` — but probably don't.
- **Siege missile is its own subsystem state path** (`siegeCooldowns`,
  `updateSiegeMissileFire`). It shares the `"missile"` subsystem
  gate with the cluster pods — destroy any one of the cruiser's
  missile nodes and BOTH systems are affected proportionally
  (only when all missile nodes are dead do they both stop).
- **`s.weapon` may be undefined.** Carriers always lacked it; the
  cruiser now also lacks it. AI code that touches `s.weapon.x`
  must guard. The two places that did (`bigShipDanger`,
  `orbitAI`) are fixed; the broadside path in `updateShip` still
  branches on `firingMode === "broadside"` so cruisers skip both
  forward and broadside paths.
- **Reavers' override removed `weapon`** because the cluster /
  siege override pattern is now the canonical way to differentiate
  races' cruiser fits. Don't reintroduce a `weapon` override unless
  you also flip `firingMode` back.
- **AI orbit at 1500**: feels right at current map sizes
  (4500–11000 px wide). If you shrink maps, cruisers may sit
  outside the play area unless this is dialled down.

**How to verify**

```bash
npm install
npm run build        # production build — should succeed
npm run dev          # opens Vite dev server
```

In-game:
- Arena vs **Hegemony** (their cruisers get a 3rd cluster pod).
  Watch the cruiser line: they should hang well back and rain
  cluster missiles that visibly fan out into 5 smaller warheads
  as they near their target.
- Get hit by a siege missile in a fighter: should one-shot. Get
  hit by one in a heavily-armored battleship: armor wear should
  soak most of it.
- Destroy a cruiser's bow laser node: the cruiser stops firing
  its beam but keeps launching missiles.

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
