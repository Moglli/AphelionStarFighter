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

### 2026-05-22 — Frontier campaign story pass: career arc, 5 acts, promotions, run-end flavor

**What changed**

The Frontier roguelite was a faction-agnostic procedural skirmish-
chain. It now tells a **Terran officer's career story** from cadet to
admiral, in 5 acts, each one a rank-up. One defeat ends the career.

1. **Faction locked to Terran.** Run-setup screen rebuilt as "BEGIN
   CAREER" — Pilot Officer commission briefing, callsign text input,
   single TERRAN FRONTIER SERVICE card, REPORT FOR DUTY button. The
   old 4-card faction grid is gone; `_syncRunSetup` is a no-op now
   that the screen is static. `startNewRun(faction, seed, opts)`
   takes an optional `{callsign}`; randomly picks from a stock list
   if blank.
2. **3 acts → 5 acts.** `ACTS_PER_RUN: 3 → 5`. New per-act rank
   table `ACT_RANKS[1..5]`: Pilot Officer → Lieutenant → Lt Commander
   → Captain → Admiral, with a `promotionBlurb` line that drives the
   promotion screen.
3. **Starter fleet shrinks dramatically.** Old `STARTER_FLEET` =
   16 fighters + 3 bombers + 2 frigates + cruiser + carrier from
   minute one. New starter = 4 fighters, 0 bombers, **no capitals**
   — the player and 3 AI wingmen. Capitals join the line at act
   transitions via `PROMOTION_FLEET[act]`:
   - → Act 2: +1 frigate, +4 fighters, +1 bomber
   - → Act 3: +1 frigate +1 cruiser, +4 fighters, +2 bombers
   - → Act 4: +1 carrier +1 battleship, +6 fighters, +2 bombers
   - → Act 5: +1 battleship +1 carrier, +8 fighters, +3 bombers
4. **Named bosses per act.** `BOSSES[1..5]` table replaces the
   per-faction `BOSS_ROSTERS` keyed lookup. Each act's boss has a
   `name`, `description`, faction lock, and a **hand-tuned roster
   that bypasses `scaleRoster`** — the numbers in the table are
   exactly what the player faces, not a 1x baseline to multiply.
   Bosses: Crimson Talon (Reavers) → ITN Severance (Hegemony) →
   Black Auriga (Reavers) → ITN Eclipse (Voidsworn) →
   Apheliotrope (Voidsworn).
5. **Trash + elite per-act rosters.** `ACT_TRASH_BASE[act]` and
   `ACT_ELITE_BASE[act]` replace the single hardcoded `{fighter: 8,
   bomber: 2, frigate: 1}` shapes. Act 1 trash is pure small-craft
   (no frigates) because a fresh Pilot Officer with no capitals
   would be paste against a frigate at col 0. Act 5 trash has a
   battleship. Trash faction roll excludes Terran AND mostly
   excludes the boss faction (30% mix-in for familiarity).
6. **Act-tagged event cards.** `EVENT_CARDS` get an optional
   `actTags: [N, ...]` field. New per-rank cards added:
   - Act 1: `rookie-hazing`, `first-kill`
   - Acts 2-3: `convoy-distress`, `defector-captain`
   - Acts 3-4: `wounded-warlord` (stamps `run.flags.executedWoundedCapital`
     / `sparedWoundedCapital` for future Act 5 callbacks),
     `intel-drop`
   - Acts 4-5: `coalition-flagship`, `saboteur-aboard`
   - Act 5: `rally-the-fleet`
   `generateAct` filters cards by `actTags.includes(actIndex)`,
   falls back to the full pool only if no acted-tagged cards roll
   (which can't happen with the catalogue above, but defensive).
7. **Promotion screen between acts.** New DOM overlay
   `.menu-promotion` in `menus.js`. Auto-opens when `run.pendingPromotion`
   is non-null and the run-map overlay is showing. Shows new rank,
   title, blurb, and a bullet list of capitals/fighters/bombers
   joining the line. PROCEED button calls
   `onRunChoice("dismiss-promotion")` → `clearPendingPromotion`.
   `completeNode` stamps `pendingPromotion` via the new
   `applyPromotion(run, newAct)` helper, which mutates capitals +
   smallCraft AND returns a summary descriptor for the UI.
8. **Career-end summary panel.** Match-over panel now reads
   `game.runSummary` for Frontier matches. If the run ended (won or
   lost), it shows:
   - "WAR WON" or "CAREER ENDED"
   - `<rank> <callsign>` as the headline subject
   - Flavor blurb keyed on `run.endReason` (kia / fleet-lost /
     defeat / stranded / war-won) — `endReasonFlavor(run)` in
     `roguelite.js`
   - "Act X/5 · N jumps" progress line
   Instead of "DEFEAT / Tap to continue".
9. **Broader loss conditions.** `isRunOver(run)` now returns true if
   `run.endReason` is set OR (`capitals.length === 0` AND `act >= 2`).
   Act 1 special case: no capitals exist by design, so only a flagged
   endReason can end an Act 1 career. main.js's `matchEnded` handler
   tags `endReason`:
   - winner !== "blue" + player KIA → `kia`
   - winner !== "blue" + all capitals dead + act >= 2 → `fleet-lost`
   - winner !== "blue" + otherwise → `defeat`
   - winner === "blue" + player KIA (heroic last stand) → `kia`
10. **Memorial wall seed.** Save `meta.memorial` now grows by 1
    entry per Frontier win (callsign + rank + timestamp). Capped at
    10. Ready for a title-screen "Memorial" view in a follow-up.

**Files touched**

| File | What |
|---|---|
| `src/roguelite.js` | `ACTS_PER_RUN`: 3 → 5. `STARTER_FLEET` shrunk to fighter-only. New `PROMOTION_FLEET` table, `ACT_RANKS` rank ladder, `BOSSES` named-boss table, `ACT_TRASH_BASE` / `ACT_ELITE_BASE` per-act mob rosters. `DEFAULT_CALLSIGNS` pool. `startNewRun(faction, seed, opts)` takes `{callsign}` + initialises `pendingPromotion`/`endReason`/`flags`. `applyPromotion(run, newAct)` helper. `completeNode` calls it on boss-clear and stamps `pendingPromotion`. New exports: `clearPendingPromotion`, `endReasonFlavor`, `ACT_RANKS`. `isRunOver` broadened. `recordRunEnd(run, won, reason)` writes memorial entry on win. `generateAct`: per-act faction lock for boss, per-act trash shape, `actTags`-filtered event pool, bypasses `scaleRoster` for boss rosters. `EVENT_CARDS` gains 9 new rank-tagged cards. |
| `src/main.js` | Imports `clearPendingPromotion`, `endReasonFlavor`, `ACT_RANKS`. `handleRunChoice` routes `dismiss-promotion` + forwards `callsign` into `startNewRun`. `matchEnded` handler detects player-KIA via `game.ships.find(isPlayer).dead`, tags `run.endReason` for every defeat path. `runEnded` handler stashes `game.runSummary` for the match-over panel and runs `discardRun` on loss. |
| `src/game.js` | `startGame` clears `game.runSummary`. `restart` clears it too. |
| `src/hud.js` | `_syncMatchOver`: if `game.runSummary` is present on a Frontier match, render rank + callsign + flavor + progress instead of the generic VICTORY/DEFEAT headline. |
| `src/menus.js` | `_buildRunSetup` rewritten — static Terran-locked screen with briefing, callsign input, REPORT FOR DUTY. `_syncRunSetup` no-op'd. New `_buildPromotion` + `_syncPromotion` for the act-break overlay. `overlays` list extended with `"promotion"`. |
| `src/input.js` | New `showPromotion` flag. `_buildMenuState` auto-opens the promotion overlay when `run.pendingPromotion` is set and the run-map is up. `screenName` resolution + `hasSubOverlay` checks include `"promotion"`. `onPromotionDismiss` callback wired. `onRunSetupSelect` forwards `callsign` through to `onRunChoice("new-run", ...)`. |
| `style.css` | New `.runsetup-briefing`, `.runsetup-callsign-row`, `.runsetup-callsign-input`, `.runsetup-faction-card` for the rebuilt run-setup screen. New `.menu-promotion` + `.promotion-panel` + `.promotion-additions` block for the act-break overlay. |

**Design decisions / gotchas**

- **Single-defeat-ends-career** is enforced via `run.endReason` on
  any `winner !== "blue"` matchEnded for Frontier mode. Don't try to
  preserve the old "lose a battle, keep your run" rule — the story
  beats only work if defeat is final. The match-over panel's "Tap to
  return to home" copy reinforces this; on dismiss, `activeRun` is
  null and the menu shows "NEW CAMPAIGN" again.
- **`pendingPromotion` is one frame ahead of the UI.** `completeNode`
  stamps it synchronously inside the matchEnded handler, but the
  promotion overlay only auto-opens when `_buildMenuState` runs the
  next time the menu draws. Between those, the player taps the
  match-over panel → `restart(game)` → re-opens the run map. The
  promotion overlay then renders on top of the (new act's) starmap.
  Verified by Playwright: act-1 boss → act-2 starts, `pendingPromotion`
  contains `{ rank: "Lieutenant", title: "Flight Leader", added: {...} }`,
  fleet now has 1 frigate + 8 fighters + 1 bomber.
- **Per-act boss faction is locked, trash is random.** Boss faction
  per act: Reavers, Hegemony, Reavers, Voidsworn, Voidsworn. Trash
  rolls from the non-Terran pool with a 30% mix-in to the boss
  faction so the boss feels distinct when you finally meet them.
  If you ever add a 5th playable race, the trash pool excludes only
  `run.faction` — boss factions stay hardcoded.
- **Boss rosters bypass `scaleRoster`.** That used to multiply by
  `min(diffFor(act, lastCol), 2.5)`, which at act 5 was a 2.5× boost
  on top of already-tuned numbers — the Apheliotrope would have been
  35 fighters / 5 BBs at peak. Now the numbers in `BOSSES[act].roster`
  are exactly what spawns. If you want a harder Apheliotrope, edit
  the table.
- **Act 1 has no capitals on purpose.** This collides with the
  existing `isRunOver` rule (`capitals.length === 0`). New rule:
  capitals-empty triggers run-over only at act >= 2. Act 1 deaths
  are gated entirely by `run.endReason` set by main.js. The `kia`
  branch covers player KIA in Act 1 (the only way to lose Act 1
  short of running out of fuel).
- **`run.flags.executedWoundedCapital` is the seed for future
  Act 5 callbacks.** The `wounded-warlord` event card in Act 3-4
  stamps either `executedWoundedCapital` or `sparedWoundedCapital`.
  Act 5 event cards / boss flavor can read these to gate cameos,
  ally arrivals, or harder boss reinforcements. Wiring those into
  the run is a follow-up.
- **The carousel only shows steps 0 + 4 in Frontier mode** — same
  as before. The Run Setup screen sits behind the chip flow as a
  separate overlay, opened via the NEW CAMPAIGN button. The
  carousel auto-skip logic in `_visibleMainSteps` is unchanged.
- **`saveStore.mergeWithDefaults` does NOT migrate live runs.**
  Existing players mid-act-3 run will boot the new code with `act:3,
  graphs.length:3` and the OLD starter fleet still attached. The
  completeNode for act-3 boss will now apply `PROMOTION_FLEET[4]`
  (carrier + BB) and extend to act 4 → act 5 → war-won. Fleets will
  be larger than a fresh new-game run because the old starter was
  more generous, but no crash. If this turns out to be unbalanced,
  bump `CURRENT_SCHEMA_VERSION` and add a migration that wipes
  `roguelite.current`.
- **Memorial wall is bounded at 10.** Hot-streak save won't grow
  the metadata blob forever. The save migration treats `memorial`
  as additive via `mergeWithDefaults` deep-merge of `meta`.
- **Verified via Playwright** (Galaxy S9+ UA): NEW CAMPAIGN flow
  reaches BEGIN CAREER screen → enters callsign → starts run with
  exactly 4 fighters, 0 capitals, fuel 8, act 1 boss = "Crimson
  Talon" (Reavers) with roster `{fighter: 14, bomber: 3, frigate: 1}`.
  Boss-clear simulation: act 1 → act 2, fleet now has 1 frigate +
  8 fighters + 1 bomber, `pendingPromotion.rank === "Lieutenant"`,
  next-act boss = "ITN Severance" (Hegemony). Full 5-act win
  simulation completes the run, `meta.runsWon = 1`, `memorial[0] =
  {callsign:"ADMIRAL", rank:"Admiral"}`, perks auto-unlock. Death-
  flavor strings render correctly at every rank. `isRunOver` checks
  pass for: fresh act-1 (false), kia-act-1 (true), no-caps-act-2
  (true), has-cap-act-2 (false). No pageerrors.

### 2026-05-21 — Starfield zoom-fade + defensive minimap dead-ship filter

Star alpha fades from 1 at zoom ≥ 0.50 to 0 at zoom ≤ 0.22; zoomed-out
view sits on clean `#02030a` black. Minimap filter widened from
`!s.dead` to also drop `wreckSpawned` || `hp <= 0`.

- **Fade thresholds bracket DEFAULT_ZOOM and MIN_ZOOM.** 0.22 ≥ 0.15
  so the ramp completes before the zoom floor.
- **Background fill unconditional** — only stars fade.
- **`wreckSpawned` is the right defensive flag** — set the same
  tick the destruction burst fires, before the line-700 filter
  strips the ship from `game.ships`.

### 2026-05-21 — Escort fighters sortie on cap-relative threats

`ESCORT_ENGAGE_RANGE: 1700→3500`, `ESCORT_RECALL_RANGE: 2400→5000`.
Escorts now pick the nearest hostile to their *cap*, not to the
*fighter*, so they fan out to intercept anything closing on the
charge.

- **Cap-relative > escort-relative.** Distributes escorts across
  approach vectors instead of clustering on one side's closest
  contact.
- **3500u sized to longest threat reach** — BB main gun (~2000u),
  bomber pod (~1800u + 1200u closure), cluster bloom (~2400u
  standoff) all fit with margin.
- **Bomber-escort fighters get the same rule** because `escortOf`
  is set on both ring escorts and bomber escorts.
- **Free fighters unchanged** — gated on `ship.escortOf != null`.

### 2026-05-21 — Corner-stuck small craft + stall watchdog + in-match QUIT

Three connected fixes: (1) `enforceWallEscape` safety net blends
`wallAvoidance` for every fighter/bomber after the per-class AI
branches, so escort-station-ring and idle-no-target paths can't
strand a craft facing a wall. (2) `game.stallTimer` resets on every
`applyDamage`; >45 s with no damage force-ends the match (winner =
more live hulls, ties to red). (3) New QUIT pill in
`.battle-top-right` + Escape key drains `consumeQuitRequest()` in
main.js → `restart(game)`.

- **Safety net runs unconditionally for fighter/bomber.** Cheaper
  than predicting which AI branch forgot to apply wall avoidance.
  Capitals are excluded — their slower turn rate makes hard inward
  yanks visually wrong.
- **Stall ties go to red.** Player is blue; ties-to-player would
  let a corner-camp farm wins.
- **Escape = quit, no confirm.** Reversible (re-deploy is one tap).
- **`window.game` is the smoke-test hook**; Playwright tests in
  /tmp depend on it. Don't remove the export from main.js.

### 2026-05-21 — PLAY + Custom Match carousels + missile-pod anti-fighter purge

PLAY screen rebuilt as a 5-step carousel: MODE → MAP → FACTION →
FLEET → DEPLOY. Steps auto-skip per mode (Frontier shows just
MODE+DEPLOY = 2 dots, Custom skips FACTION+FLEET = 3 dots). Custom
Match overlay rebuilt as a 3-step carousel: FRIENDLY → ENEMY →
REVIEW. NEXT flips to a green DEPLOY on the last step. Separately:
`pickPodTarget` and missile `acquireMissileTarget` now skip
fighter+bomber when `fromKlass !== "fighter"`, so capital missile
pods stop massacring small craft. Fighter death burst clamps
intensity ≥ 0.95 and radius ≥ 16 for visible feedback.

- **`_resetOverlayState` gated on `_currentScreen !== name`** —
  `showScreen` runs every frame; without the gate the carousel
  pinned to step 0 forever.
- **Mode switch from a hidden step bounces to the first visible
  step** via `_syncMainMenuChips` → `_gotoMainStep(visible[0])`.
- **Pod filter is intentionally aggressive** — a frigate with no
  friendly capitals nearby will leave its pods idle rather than
  shred small craft. Ring cannons handle anti-fighter work.
- **Fighter missiles keep open re-acquire** because dogfight
  missiles should swap between enemy fighters mid-flight. Cluster
  *children* inherit parent's `fromKlass` (a capital) so they're
  filtered.

### 2026-05-21 — Cluster 160° cone + frigates dart + capital crowding

Cluster missiles burst into a 160° angular cone again (revert of
the line-spacing experiment): `cluster.childSpread = π * 160/180`.
6 children launch from parent position with headings spanning ±80°
off the target axis; outer warheads loop back via homing. Frigates
gain PD-aware orbit (`pdRange + 140` vs capitals, default vs small
craft) + `bigShipDanger` + new `allyAvoidance` blends. Capitals
(BB, cruiser, carrier) get `allyAvoidance` (weight 0.55–0.60) to
stop hulls drifting through each other.

- **`allyAvoidance` ignores fighters/bombers/stations.** A swarm
  of escorts would otherwise repel each other and never converge.
- **`bigShipDanger` excludes the frigate's own target** — without
  the exclude the frigate refuses to attack-run a BB because the
  target's PD push dominates steering.
- **Hard activation threshold `1.5 × max(myR, otherR)`** — without
  it two cruisers 600px apart would push slightly and never
  converge.
- **Total cluster damage still 144** (6 × 24).

### 2026-05-21 — Cruiser lead-aim + cluster line spread (precursor to 160°) + escort leash bump

Cruiser forward salvo now lead-aims via `aimPointFor(target)` and
fires on bow alignment with the lead direction (tolerance 0.88,
~±28°). Standoff = `aiOrbit × 0.7` so race overrides scale
proportionally. (Later same day: line spread reverted to angular
160° cone — see above entry.) `ESCORT_ENGAGE_RANGE: 900→1700`,
`ESCORT_RECALL_RANGE: 1400→2400` (later bumped to 3500/5000 — see
two entries above).

- **Lead-aim uses `aimPointFor`** so cruiser fire follows the
  capital module-priority ladder (PD → broadside → missile bay
  → laser → hangar).
- **Fire tolerance 0.88 still gates spectacular misses.** With
  salvo cooldown 1.8s the cruiser delivers ~1 full volley per
  orbit pass.

### 2026-05-21 — Broadside salvo aborts when the battery module dies mid-volley

`updateBroadsideFire`'s salvo-continuation block re-checks
`portLive`/`stbdLive` before each shot in the burst; failed check
clears `salvoPortShotsLeft` instead of firing. Other per-module
subsystems (PD, missile pods, heavy laser, engines, hangar) already
gate correctly — the audit came back clean.

- **Cooldown timers keep ticking on disabled modules** by design —
  partial repair (if ever shipped) wouldn't need to re-seed timers.
- **Broadside fire mode (`firingMode: "broadside"`) doesn't aim
  individual barrels** — hull rotates until target enters arc.
  Don't animate per-barrel tracking; it would lie about how the
  weapon works.

### 2026-05-21 — Custom Match supports multi-faction teams (up to 2 per side)

Custom Match overlay supports up to 2 factions per side for a true
4-faction setup. `+ ADD ALLY` / `+ ADD ENEMY` buttons add a second
team that auto-picks the first race not already on the side. New
data model: `customBlueTeams` / `customRedTeams` arrays of
`{race, counts}`; `consumeCustomRoster` emits both shapes (new
`blueTeams`/`redTeams` plus legacy `blue`/`red` mirrored from slot
0). `spawnRoster` resolves in order: multi-team → legacy single →
race-default.

- **Teams share spawn zone + side ID.** Both factions on blue spawn
  from `ARENA.spawn.blue` and are allies. True 4-corner FFA would
  need a side architecture rewrite.
- **Slot 0 can't be removed** — each side needs at least one
  faction or the spawn loop drops it entirely.
- **`consumeCustomRoster` deep-clones counts per team** because
  the overlay's DOM-edits would otherwise mutate the live roster
  shared with the game object.
- **Legacy single-race fields kept as mirrors of slot 0** for any
  code still reading them (HUD chrome, debug paths).

### 2026-05-21 — Tracking gun turrets + lasers bury into the hull

PD turrets store per-turret aim angle (`ship.pdAimAngles[i]`)
refreshed every tick from the lead-aim that already runs in
`updatePDFire`; draw layer renders base disc + rotated barrel +
muzzle tip. Heavy laser barrel tracks its target every tick (not
just when ready to fire) via `ship.laserAimAngle`, clamped to
`heavyLaser.arc`. Beam endpoint in `hud.js#endPoint` stops `targetR
* 0.5` short of centre so the beam visibly carves into the hull
silhouette.

- **PD aim updates on cooldown too** so barrels slew smoothly
  between shots.
- **Broadside cannons stay fixed perpendicular by design** — hull
  rotates until target enters arc; per-barrel tracking would
  misrepresent the weapon.
- **Laser barrel clamped to `heavyLaser.arc`** so it visibly tries
  to track but stops at the arc edge.

### 2026-05-21 — +2 missile launchers, cluster cruiser restored, umbrella bloom, bomber shield buff

All non-fighter missile carriers got +2 launchers (bomber 3→5,
frigate 1→3, cruiser 2→4, BB 4→6). Cruiser cluster pods re-added
(parent damage 110→60, child 30×4 = 120 bloom). Cluster bloom now
gates on (a) outside target PD range: `max(spec.bloomDistance,
target.pd.range + 60)`, and (b) clear of launcher hull:
`ownerDist ≥ owner.radius + 80`. Bloom VFX = two-ring shockwave +
fan of sparks along child cone + 4 lateral trim sparks. Bomber
shields 130/16 → 220/24 (regenDelay 2.2s unchanged).

- **PD-range slack is 60u** — round number that puts the bloom
  outside the densest PD bubble for every ship (PD ranges 400–560).
- **`hexToRgba` falls back to white** if a race ever uses non-hex
  pod colors — keeps shockwave painter safe.
- **Cluster child total damage 144** (6 × 24 after the 160° cone
  pass — see earlier entry).

### 2026-05-21 — BB cannon shells + FIRE button dead wiring + tap-to-inspect + escort split

Five user-reported issues fixed together: (1) BB `projectileSpeed
280→540`, `projectileRadius 10→8`; `drawProjectile` renders
shells ≥6 radius as oriented ellipses with bright leading tip.
(2) FIRE/SPC/CHARGE buttons had no DOM listeners since the DOM HUD
overhaul — wired pointerdown/up/cancel/leave on `#fire-btn`,
`#boost-btn`, `#missile-btn`. (3) Tap-to-inspect in spectate/admiral:
`_pendingTap` short-low-movement gesture sets `game.spectateTargetId`
via `consumeTap()` in main.js; target panel shows SHIELD → ARMOR →
HULL. (4) Escort spawn split into packs of 5 with separate
`packId`s. (5) Escort engage leash (later bumped — see above).

- **Tap shares right-half real estate with the right vstick** —
  when `selectActive` is true, onDown skips `right.start` on right-
  half touches. Mouse always counts as tap.
- **BB streak length `radius * 2.6`** — ~21px ellipse at radius 8;
  small enough that PD rounds (radius 3) still look like dots even
  if threshold drops.
- **Cruiser shell radius 7 also streaks** — intentional, cannon
  shells should read as tracers.

### 2026-05-21 — Admiral camera unmovable + battle HUD clutter

Three intertwined bugs from the COMMAND FLEET flow: (1) Canvas
`AdmiralPanel.handleClick` swallowed pointers in the entire bottom
half of the viewport even though the panel had moved to DOM —
left vstick couldn't capture. Dropped the dead interception.
(2) DOM admiral grid called `game.setPosture` / `game.setMissiles`
which were never defined — only the closure on `input.admiralPanel`.
Lifted closures into `game.setPosture` / `game.setMissiles`.
(3) New `_syncModeChrome` hides irrelevant HUD per mode (admiral
hides action cluster, aim stick, damage arcs, compass, reticle,
respawn, vitals, OBSERVING pill, right stick).

- **Canvas `AdmiralPanel` class is still dead code** — `layout()`
  still called, `setHooks` still wired. Deletion is a follow-up.
- **Mode chrome uses `display: none`, not `visibility: hidden`** —
  hidden buttons would otherwise still claim pointer events.
- **Left vstick stays on in admiral** — it's the camera-pan input.

### 2026-05-21 — DOM menu persisted on top of every non-Frontier mode

`StartMenu.hide()` (idempotent — gated on `_currentScreen !== null`)
added; `main.js#draw` calls it on every non-menu frame so
`menu-root` is torn down on the transition out of menu state.
Frontier was already correct because `_launchBattle` calls
`_menuSystem.hideAll()` synchronously before dispatching.

- **Hide wired in draw loop, not `startGame`.** `startGame` is
  shared by canvas-click, DOM-DEPLOY, post-battle restart, and the
  Frontier `enter-node` path — putting hide there would race with
  Frontier's `_launchBattle` cleanup.
- **Post-battle return works for free** — `restart` flips
  `game.state` back to `"menu"`, draw loop re-enters menu branch,
  `showScreen(_baseScreen)` re-mounts.

### 2026-05-21 — Main-menu restructure: HOME → PLAY → mode-relevant options

Three-level main menu: HOME (PLAY / SETTINGS / ABOUT hub) → PLAY
(mode picker + mode-relevant chips) → ABOUT. `input._baseScreen`
tri-state (`'home'|'main'|'about'`) tracks the base; overlays still
override. Energy bar + settings pill key off `name === 'main'`
instead of "any menu active". `_syncMainMenuChips` toggles
sections inline per mode (Frontier hides all extras, Custom hides
race+fleet+sliders).

- **Inline `display` toggle, not class swap** — keeps `.menu-screen`
  flex-column ordering stable.
- **Custom keeps MAP SIZE** because `_emitStart` reads
  `selectedSize` for it.
- **Post-battle re-open lands on the screen the user came from**
  (usually PLAY), not HOME.

### 2026-05-21 — Frontier flow: JUMP / stale closure / FLY teardown / event auto-advance

Four bugs in the Frontier loop: (1) JUMP was a no-op because
`StartMenu.draw` hid `menu-root` whenever `showRunMap` was true;
`hasSubOverlay = showResupply||showEvent||showBattleChoice` is now
lifted above the visibility gate. (2) `setStarmapCallbacks`
captured a stale `run` local; now re-reads `this.runState.run` at
click time. (3) FLY didn't tear down the starmap because
`startMenu.draw` stops firing once `game.state` flips to playing;
new `_launchBattle` helper synchronously hides `showRunMap`,
destroys starmap, hides `menu-root`, then dispatches `enter-node`.
(4) `onEventChoice` now dispatches `complete-node-noncombat` after
`apply-event` so the player actually advances.

- **`_launchBattle` order matters**: cleanup BEFORE dispatch
  because `enter-node` synchronously calls `startGame` which stops
  the draw loop calling `startMenu.draw`.
- **`.behind-canvas` toggle is dead** — `menu-root` z-15 already
  sits above starmap z-10; dropped from the draw path.
- **Canvas overlay stubs (`_drawResupply` / `_drawEvent` /
  `_drawBattleChoice`) are still alive in source** — unreachable
  via the DOM path; deletion is a follow-up.

### 2026-05-21 — Frontier launch: drop dead `makeGalaxy`, fix SVG className write

Two latent bugs from the DOM/CSS overhaul: (1) `_layoutRunSetup`
called `makeGalaxy(...)` which had been deleted; click handler
ReferenceError'd silently. (2) `updateStarmap` had a bare-name
`edgesSvg = control.edgesSvg` (no `let`/`const`) failing in module
strict mode, plus `edgeEl.path.className = ...` on an SVG `<path>`
which raises TypeError (`SVGElement.className` is a read-only
`SVGAnimatedString` getter).

- **SVG class writes must go through `setAttribute("class", ...)`
  or `classList`** — HTML `.className = ...` works fine, SVG
  doesn't. Future SVG `<g>`/`<circle>`/etc. will hit the same gotcha.
- **Run setup canvas paths left dead** — DOM scrim absorbs canvas
  clicks; rect-fallback is unreachable.

### 2026-05-21 — Real fix for startup black screen: restore `InputManager.layoutOverlays`

The DOM/CSS menu overhaul deleted `InputManager.layoutOverlays(viewW,
viewH)` but left the call site in `main.js#resize()`. `resize()`
fires synchronously during module init, BEFORE the RAF loop starts;
the missing method raised a TypeError at module top-level, no frame
ever painted. Restored as a 5-line method delegating to the still-
existing per-overlay `layout()` methods (missileBtn, fireBtn,
spectateBtn, startMenu, admiralPanel).

- **Per-overlay `layout()` methods still matter even with DOM HUD**
  — `onDown` still hit-tests canvas rects on those buttons. Don't
  delete them thinking "everything is DOM now."
- **`boostBtn` intentionally NOT in the layout list** — no
  `layout()` method; adding it would throw the same TypeError.
- **Companion fix in 3f9e997 (re-mount `startMenu.draw` in the
  draw loop) is still required** — both fixes together make the
  page actually work.

### 2026-05-20 — AI targets PD + weapon modules before hull

AI cannon aim now shifts onto live modules in priority order
(PD → broadside → missile bay/pod → torpedo → laser → hangar);
fighter targets and capitals with no live modules fall back to
centre. `pickAimModule` shared with bomber missile homing. New
`aimPointFor(target)` returns world-space aim; `leadAim` rebuilt
around it so every AI caller is module-aware for free.

- **Priority order matches `pickBomberAimModule`** — unifying
  means one place to retune.
- **Engines deliberately NOT in priority list** — rear-mounted,
  strafe angle usually clips something else first.
- **Focus fire is emergent.** Every ship picks the *first* live
  module — don't randomise inside `pickAimModule`.
- **Aim only, not target selection** — pack-role + proximity logic
  still picks WHICH ship to attack.
- **`pickAimModule` returns the module object** so callers can
  read `offset` without a second lookup.
- **`updateRingFire` (frigate ring cannons) also shifts onto the
  preferred module** when present.

### 2026-05-20 — Frontier UI overhaul: starmap + scrollable galaxy + emblem cards

Run map became a full-screen scrollable starmap with parallax stars,
procedural nebulae, per-type node art (battle stars, elite stars,
resupply planets, event anomalies, boss gas giants with faction-
tinted rings), curved Bezier travel routes with animated dashed-
flow shimmer, drag-to-pan with 4px tap-vs-drag threshold. Top HUD
strip (act badge, faction commander, credit/fuel chips), right
fleet panel with capital silhouettes + HP bars. Run Setup gained
galaxy backdrop + faction emblem cards.

- **Click deferred to pointer-up for run map only.** Sub-overlays
  (Battle Choice, Event, Resupply, Run Setup) still route on
  pointer-down — they're modal.
- **Drag threshold 4px (squared 16)** distinguishes tap vs pan.
- **Galaxy + node positions cached on `(run.seed, run.act)`** —
  changing acts mid-run regenerates both, each act feels like a
  new region.
- **Run Setup galaxy uses fixed seed (`0xfd00bea1`)** so the
  starscape stays consistent across opens. Don't randomise.
- **`drawFleetMarker` sits 38px ABOVE the current node** with a
  pip line down — keeps the marker from obscuring the star.

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
