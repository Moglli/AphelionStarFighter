# Dev Features Plan — Dev Mode, Battle/Ship/Map/Platform Designers

> **Status (2026-06-03): PLANNED.** Verified against codebase; `npm run build`
> passes baseline. No code written yet. Authored as the contract for the next
> ~9 PRs.

Goal: tools to **play-test, balance-test, and design content** (battles, ships,
maps, defence platforms) inside the app. Designs export as JSON-in-fenced-code
so they round-trip through Claude chat sessions for iteration.

User decisions locked 2026-06-03:
- **Dev gate**: Settings toggle (visible to all players, off by default).
- **Export format**: JSON in markdown fenced code block (machine-parseable
  round-trip).
- **Defence platforms**: new entity type (not a stationary ship). Share
  damage/modules via factored utilities where cheap; keep the type boundary
  clean.

---

## Phase 0 — Dev Mode toggle + Playtest tools

**Smallest, unblocks everything else.** Settings toggle, hotkey overlay,
balance HUD piggybacking on the existing `game.battleStats` telemetry.

### Verified facts
- `save.js` `DEFAULT_SAVE.settings` (line 77) is the right home for
  `devMode: false`. **No schema bump** — `mergeWithDefaults` (line 238)
  deep-merges additive fields.
- `menus.js` `_buildSettingsOverlay` (line 1886) uses `.settings-rows` /
  `.settings-slider-row` markup. **`.settings-toggle` CSS already exists**
  (`style.css` lines 3725+, 5409+, 10760+) — on/off toggle, no new CSS
  needed. Add a `.settings-toggle-row` next to the slider rows.
- `game.js` already collects per-side **and** per-ship telemetry:
  `bstatRecordShot` (1578), `bstatRecordDamage` (1596), `bstatRecordKill`
  (1612), folded by `finalizeBattleStats` (1627). Per-ship record shape
  (1549): `{id, name, klass, side, isPlayer, kills, damageDealt,
  shotsFired, shotsHit, fate}`. **Balance HUD reads `game.battleStats`
  directly — no new instrumentation.**
- `applyDamage(ship, p, moduleTargets, particles, game)` (game.js:1710) is
  projectile-shaped, not generic. To track **damage taken per ship**, add
  one line at the existing telemetry block (1763–1766): also bump
  `bs.ships[ship.id].damageTaken += remaining`.

### New files
- `src/dev/devmode.js` — `isDev()`, dev state, `window.dev` hooks (Playwright
  probes), hotkey table.
- `src/dev/devoverlay.js` — DOM overlay (pause/step/heal/kill/spawn/swap-into,
  selected-ship inspector).
- `src/dev/balancehud.js` — canvas overlay reading `game.battleStats` →
  per-side DPS, hits, accuracy; TTK ladder by class; rolling 5s window.

### Modified
- `src/save.js` — add `settings.devMode: false` to defaults (no schema bump).
- `src/menus.js` — add `_buildDevToggleRow` in the settings overlay; reuse
  `.settings-toggle`.
- `src/main.js` — gate dev overlay/HUD render on `isDev()`; bind `~` (overlay),
  `\` (step one frame when paused), `[` `]` (speed down/up).
- `src/game.js` — extend per-ship rec with `damageTaken` (one line);
  add `game.simSpeed` (1.0 default) consumed by `update`.
- `src/input.js` — dev-only hotkey handlers.

### Dev overlay actions (gated on `isDev()`)
| Action | Hotkey | Effect |
|---|---|---|
| Pause / step | `~` toggle pause, `\` step | freezes `update`; one-frame advance |
| Speed slider | `[` / `]` | `game.simSpeed` ∈ {0.25, 0.5, 1, 2, 4} |
| Heal selected | button | restore hull/shield/modules to full |
| Kill selected | button | drives `applyDamage` with `Infinity` |
| Spawn ship | click-to-place | spawn race/klass/team picked in overlay |
| Invincible (self) | button | `ship._devGod = true` → `applyDamage` early-return |
| Force surrender | button | flip `surrendered` flag |
| Swap into ship | tap on minimap | hand control to AI / take over a hull |

### Balance HUD content
- Per-side panel: DPS, accuracy %, missiles fired, kills.
- Per-ship leaderboard (top 10 by damage dealt).
- TTK ladder: rolling list of recent kills with `(victimKlass, secsAlive)`.
- Selected-ship inspector (when dev overlay open): full stat dump from
  resolved spec.

### Acceptance
- Dev Mode off → zero new code paths run (single `isDev()` guard per call site).
- Dev Mode on, restart → toggle persists.
- Pause + step works; balance HUD updates every frame; TTK ladder populated.

### Risk
- `isDev()` must be cheap (read a cached bool, not the SaveStore each call).
  Cache at boot + on settings change.

---

## Phase 1 — Scenario format + Battle Designer

**The piece that enables chat-iteration.** Canonical Scenario JSON consumed by
Custom mode; a DOM editor to author it; copy-to-clipboard export wrapped in a
fenced code block.

### Verified facts
- `customMode.setup` (modes/custom.js:26) reads `game.customRoster`; falls
  back to default flow if absent. **Drop-in surface for the full Scenario.**
- `spawnRoster(game, rosterOverride)` (game.js:335) already prefers
  `blueTeams` / `redTeams` shape and falls back to `blue` / `red`. The
  scenario teams[] shape maps 1:1.
- `arena.js#setArenaSize(w,h)` (line 24) mutates the singleton in place;
  scenario-driven map switches just call it pre-`startGame`.
- `BATTLE_COMMANDS_SPEC.md` defines the 3-axis order vocab
  (Stance/Priority/Assignment) already wired through `ai.js#applyShipOrders`.
  Scenario reuses the same vocabulary verbatim per ship-group.

### Canonical Scenario JSON (v1)
```json
{
  "kind": "scenario",
  "version": 1,
  "id": "scenario-saurian-ambush",
  "name": "Saurian Ambush",
  "notes": "Test asymmetric vs heavy capital line",
  "mapId": "default-medium",
  "blueTeams": [
    { "race": "terran",
      "ships": [
        { "klass": "frigate", "count": 4,
          "spawn": { "x": 800, "y": 2500, "spread": 400 },
          "stance": "ENGAGE", "priority": "DEFAULT", "assignment": "FREE_ROAM",
          "designId": null }
      ]
    }
  ],
  "redTeams": [],
  "platforms": [],
  "objectives": { "winCondition": "eliminate", "timeLimitSec": null },
  "playerTeam": "blue",
  "playerShip": { "klass": "fighter", "designId": null }
}
```

### New files
- `src/scenario/format.js` — versioned schema, `validateScenario`,
  `serializeScenario`, `parseScenario`.
- `src/scenario/migrations.js` — empty-but-ready migration table (mirror of
  `save.js` MIGRATIONS pattern).
- `src/scenario/store.js` — `loadScenarios()` / `saveScenario()` /
  `deleteScenario()` via SaveStore.
- `src/dev/battle-designer.js` — DOM overlay editor.

### Modified
- `src/save.js` — add `scenarios: []` to defaults. **No schema bump**
  (additive top-level array; deep-merge leaves existing saves untouched).
- `src/modes/custom.js` — extend to consume a Scenario shape if
  `game.scenario` is set; legacy `customRoster` path unchanged.
- `src/game.js#spawnRoster` — extend to read `ships[i].spawn` (override
  spawn pos), `ships[i].stance/priority/assignment` (stamp orders at
  create time), `ships[i].designId` (Phase 2 hook — null until then).
- `src/main.js` — route the designer overlay → `game.scenario =` →
  `startGame(...custom)`.
- `src/menus.js` — "Battle Designer" entry in Dev menu, "Load Scenario"
  picker.

### Designer UI
1. **Map** dropdown (defaults until Phase 3; "Custom map…" placeholder).
2. **Blue / Red team builders** — race picker; add-ship rows with
   klass + count + designId picker.
3. **Mini-arena canvas** — drag-place each ship-group; dot = spawn center,
   ring = spread.
4. **Orders** — per-group Stance/Priority/Assignment chips reusing the
   existing Fleet Plan vocab.
5. **Platforms** placement (Phase 4-gated, grey until then).
6. **Test Play** → starts with this scenario; back-button returns to designer.
7. **Save / Save As / Export (clipboard) / Import (clipboard)**.

### Export / Import contract
- Export copies a single fenced block to clipboard:

  \```json
  { "kind": "scenario", "version": 1, ... }
  \```

- Import accepts the JSON object alone OR wrapped in fenced block; strips
  the fence, validates, shows a one-line "About to load: <name> — N blue
  ships, M red ships, K platforms" confirmation.

### Acceptance
- Author → Save → reload → Load → Test Play → byte-identical battle.
- Export → paste in chat → Claude reads it → answers balance questions.
- Import from chat-pasted block → Test Play.

### Risk
- Schema versioning matters from day 1. Even though v1 ships first, write
  the migration switch up front and refuse `version > LATEST`.

---

## Phase 2 — Ship Designer (Blueprints)

**Free-form ship editor producing named blueprints**, referenced by `designId`
in scenarios.

### Verified facts
- `components.js`: `DEFAULT_PLAYER_DESIGN` (621), `applyDesign` (662),
  `resolveDesignComponents` (639), `computeDeltas` (947) — full API exists.
- `resolveSpec` is a **shallow-merged ref** (CLAUDE.md line 73 hazard).
  `applyDesign` already clones-on-descent; blueprint application must use
  it — never mutate the returned spec directly.

### Blueprint JSON (v1)
```json
{
  "kind": "blueprint",
  "version": 1,
  "id": "bp-strike-frigate-a",
  "name": "Strike Frigate A",
  "race": "terran",
  "klass": "frigate",
  "radiusScale": 1.0,
  "design": { /* same shape as DEFAULT_PLAYER_DESIGN */ },
  "paint": { "primary": "#5af", "accent": "#fa3" }
}
```

### New files
- `src/dev/ship-designer.js` — DOM overlay editor + live preview canvas.

### Modified
- `src/save.js` — `blueprints: []` (additive, no schema bump).
- `src/components.js` — add `resolveBlueprintById(id)` and a
  `designToBlueprint`/`blueprintToDesign` pair.
- `src/game.js` / `src/ship.js` — when spawning from a scenario row with
  `designId`, look up the blueprint and pass `{design, paint}` to
  `createShip`.

### Designer UI
- Race + class pickers (auto-loads defaults).
- Live preview canvas: `drawShip` of a ghost ship via `buildModules` →
  real silhouette + module dots.
- Left rail: slot list, component picker, reuses `SLOT_VISUALS`.
- Right rail: **stat delta panel** from `computeDeltas` — DPS, HP, shield,
  speed vs. stock.
- `radiusScale` slider (0.7–1.3); >±10% flagged "non-standard size".
- Save / Save As / Export (single-blueprint fenced JSON) / Import.

### Acceptance
- Build blueprint → save → reference by `designId` in a Phase 1 scenario
  → ships spawn with design applied.
- Export → paste in chat → Claude reasons about stats; import back →
  identical preview.

### Risk
- The race+class spec is shared across all ships of that type. Blueprint
  application **must** go through the cloning `applyDesign` path. Cover
  with a unit-level Playwright probe before shipping.

---

## Phase 3 — Map Designer

**Edit map size, spawn zones, decor, platform placements; save as named maps.**

### Verified facts
- `arena.js` exports `ARENA`, `MAP_SIZES`, `setArenaSize` (24),
  `createStarfield` (33), `drawArena`, `drawArenaBounds`, `randomSpawnPos`.
- Decor / hazards do not exist yet — new rendering surface in `main.js`.

### Map JSON (v1)
```json
{
  "kind": "map",
  "version": 1,
  "id": "map-asteroid-belt",
  "name": "Asteroid Belt",
  "mapW": 9000, "mapH": 5400,
  "spawn": {
    "blue": { "x": 900, "y": 2700, "w": 1100, "h": 4500 },
    "red":  { "x": 8100,"y": 2700, "w": 1100, "h": 4500 }
  },
  "decor": [
    { "type": "asteroid", "x": 4500, "y": 2700, "r": 240, "rot": 0.3 }
  ],
  "hazards": [],
  "platforms": [
    { "platformId": "platform-turret-bastion", "x": 6500, "y": 2700, "faction": "red" }
  ]
}
```

### New files
- `src/dev/map-designer.js` — DOM overlay editor.
- `src/maps/registry.js` — built-in presets + user maps from SaveStore.
- `src/maps/decor.js` — decor draw functions (asteroid clusters, debris,
  nebula tufts). **Visual-only this phase** — no collision (flagged in UI).

### Modified
- `src/save.js` — `maps: []`.
- `src/arena.js` — extend `setArenaSize` to also accept a Map record;
  cache decor list on `ARENA.decor`.
- `src/main.js` — render decor between starfield and ships, hazards between
  ships and projectiles.
- `src/scenario/format.js` — `mapId` either resolves from registry or
  scenario can inline a `map: {...}` record.

### Designer UI
- Mini-arena canvas with drag-to-resize bounds + drag-to-move spawn rects.
- Tool palette: select / asteroid / spawn zone / platform.
- Snap-to-grid toggle (100u grid).
- Save / Save As / Export / Import.

### Acceptance
- Author map → reference by `mapId` in a scenario → battle plays on it
  with decor visible.
- Spawn rects validated to stay inside bounds (`validateMap`).

### Risk
- Decor is visual-only. If you later want collidable asteroids, that's
  a follow-up — the `decor[].collidable` field is reserved but ignored
  in this phase.

---

## Phase 4 — Defence Platforms (new entity type)

**Stationary defensive entities — new type, kept clean from ships.** Damage
+ modules factored as shared utilities to soften the cost of the separation.

### Verified facts
- `world.ships` is iterated in **45+ places**: `ai.js` (28 sites),
  `projectile.js` (4), `ship.js` (7), `rally.js` (1), plus spawn
  (`ship.js:1228`). Refactor seam: **add `world.combatTargets()`
  helper** that returns `[...world.ships, ...world.platforms]`; replace
  call sites in target-pickers only. Spawn/AAR/escort-id-lookup paths
  stay on `world.ships`.
- `applyDamage(ship, p, ...)` is projectile-shaped. **Extract** the
  shield/cell/module/hull cascade as `applyDamageTo(target, p, …)`
  accepting either a ship or platform (both expose
  `hull/maxHull/shield/maxShield/modules/side/id`). Both call sites end
  up calling the same utility — no behavior change for ships.
- `bstatRecordDamage` keys on `p.ownerId`. Platforms get their own ID
  range (`game.nextPlatformId`) that lives in the same `bs.ships` map
  for simplicity (rename to `bs.actors` in this phase if it helps).

### Platform runtime shape
```js
{
  id, kind: "platform", platformId, faction, side, // "blue" | "red"
  x, y, rot,                                       // rot fixed
  hull, maxHull, shield, maxShield,
  modules, weapons,                                // duck-types ship fields
  surrendered: false,                              // platforms never surrender
  dead: false,
  spec                                             // resolved blueprint
}
```

### Platform blueprint JSON (v1)
```json
{
  "kind": "platform-blueprint",
  "version": 1,
  "id": "platform-turret-bastion",
  "name": "Turret Bastion",
  "hullShape": "hex",
  "radius": 90,
  "maxHull": 4000, "maxShield": 2000,
  "modules": [
    { "slot": "turret-0", "x": 0.6, "y": 0.0,  "weapon": "heavy-cannon" },
    { "slot": "turret-1", "x":-0.6, "y": 0.0,  "weapon": "heavy-cannon" },
    { "slot": "pd-0",     "x": 0.0, "y": 0.5,  "weapon": "pd" }
  ],
  "aura": null
}
```

### New files
- `src/platforms.js` — `createPlatform`, `updatePlatform`, `drawPlatform`,
  `PLATFORM_HULL_SHAPES`.
- `src/platform-modules.js` — module layouts (turret cluster, missile silos,
  beam emitter, shield generator).
- `src/damage.js` — **extracted** shared utility `applyDamageTo(target, p,
  moduleTargets, particles, game)`. `game.js` re-exports as `applyDamage`
  for back-compat.
- `src/dev/platform-designer.js` — DOM overlay editor (mirror of ship-designer).

### Modified
- `src/game.js` — `game.platforms = []`; `updatePlatforms(game, dt)` in
  main update; render integrated in `main.js`. `world.combatTargets()`
  helper.
- `src/main.js` — draw platforms between wrecks and ships (they're terrain-like).
- `src/projectile.js` — `acquireMissileTarget` + cannon hit-tests iterate
  `world.combatTargets()`.
- `src/ai.js` — target-pickers use `world.combatTargets()`; `escortOf` /
  ally-avoidance / `world.ships.find(...)` lookups untouched.
- `src/save.js` — `platformBlueprints: []`.
- `src/sprites.js` — pre-render platform sprites (smaller cache, same pipeline).

### Platform variants to ship
1. **Turret Bastion** — multi-turret + PD.
2. **Missile Platform** — pods, long range, no PD.
3. **Beam Fortress** — one heavy laser, slow cooldown.
4. **Shield Generator** — no offense, aura shield-share to nearby allies.

### Designer UI
- Hull shape picker + radius.
- Module slot editor — drag dots on a unit-circle preview.
- Aura toggle + params.
- Stat preview (DPS, HP, shield, EHP).
- Save / Export / Import.

### Acceptance
- Platform blueprint → map references it → scenario plays with platforms
  shooting + being shot.
- Killing all platforms doesn't end the battle (they're not ships);
  `checkEnd` unchanged.

### Risks
- **Targeting audit is load-bearing.** Add `world.combatTargets()` and
  replace **only** target-picker call sites. Add a runtime invariant in
  tests: every projectile that finds a target must hit a ship OR platform,
  never neither.
- **Surrender invariant.** CLAUDE.md (line 117) requires every
  target-picker to skip `o.surrendered` independently. Platforms never
  surrender — `o.surrendered === false` always — so existing skip-checks
  are no-ops for them. No new invariant violation.

---

## Cross-cutting

### Storage
- All artifacts (`scenarios`, `blueprints`, `maps`, `platformBlueprints`)
  are top-level additive arrays in `DEFAULT_SAVE`. **No schema bump
  through Phase 4** — `mergeWithDefaults` (save.js:238) handles them.
- Every artifact carries `{ kind, version, id, name }` so the importer can
  route + reject incompatible versions.

### Export / Import
- Single canonical wrapping: a fenced ` ```json ... ``` ` block. Importer
  accepts:
  - Raw JSON object
  - Object wrapped in markdown fence
  - Multiple objects in a chat-message text (split on fences)
- Reject silently on bad shape; show a one-line error in the toast.

### DOM editors
- Reuse `menus.js` patterns. CSS overlay column-flex trap (CLAUDE.md
  line 78) applies. SVG class writes via `setAttribute` / `classList`,
  never `.className`.

### Changelog discipline
- Each phase's PR appends one `CLAUDE.md` Changelog entry — date,
  headline, and the load-bearing gotcha only (the spec-clone hazard,
  the targeting-loop audit, etc.).

### Test hooks
- `window.dev` exposed when `isDev()` for Playwright probes:
  `window.dev.pause()`, `.step()`, `.spawn({race,klass,team,x,y})`,
  `.snapshot()`. Don't remove — pair with the existing `window.game` /
  `window.input` / `window.saveStore` / `window.audio` hooks (CLAUDE.md
  line 21).

---

## PR sequence (~9 PRs)

| # | Subject | Files touched |
|---|---|---|
| 0a | Dev mode toggle + `isDev()` + balance HUD | save.js, menus.js, main.js, game.js, dev/* |
| 0b | Dev overlay (pause/step/heal/kill/spawn) | dev/devoverlay.js, input.js, main.js |
| 1a | Scenario format + custom mode extension (no UI) | scenario/*, modes/custom.js, game.js, save.js |
| 1b | Battle Designer overlay + export/import | dev/battle-designer.js, menus.js |
| 2 | Ship Designer + blueprints | dev/ship-designer.js, components.js, save.js |
| 3 | Map Designer + decor render | dev/map-designer.js, maps/*, arena.js, main.js, save.js |
| 4a | Extract `applyDamageTo` (ship-only, no behavior change) | damage.js, game.js |
| 4b | Platform entity + AI/projectile integration | platforms.js, game.js, ai.js, projectile.js, main.js |
| 4c | Platform Designer | dev/platform-designer.js, save.js |

---

## Verified-fact appendix (2026-06-03)

| Claim | Evidence |
|---|---|
| Build is clean | `npm run build` → 5.88s, 0 errors |
| `DEFAULT_SAVE.settings` is the toggle home | save.js:77 |
| `.settings-toggle` CSS exists | style.css:3725, 5409, 10760 |
| `bstatRecordDamage` is the telemetry surface | game.js:1596 |
| Per-ship rec has `{kills, damageDealt, shotsFired, shotsHit, fate}` | game.js:1549 |
| `applyDamage(ship, p, ...)` is projectile-shaped | game.js:1710 |
| `customMode` reads `game.customRoster` | modes/custom.js:26 |
| `spawnRoster` prefers `blueTeams`/`redTeams` | game.js:335–346 |
| `arena.js#setArenaSize(w,h)` mutates the singleton | arena.js:24 |
| `DEFAULT_PLAYER_DESIGN` is frozen | components.js:621 |
| `applyDesign` + `computeDeltas` exist | components.js:662, 947 |
| `world.ships` iterated 45+ places | grep across src/ |
| `mergeWithDefaults` handles additive top-level keys | save.js:238 + CLAUDE.md "Save schema" |

---

## Open follow-ups (out of scope until later phases land)

- Collidable decor / hazards (Phase 3 ships visual-only first).
- Objectives beyond `eliminate` (escort, survive-N-secs, capture-X) —
  shape reserved in Scenario JSON.
- Inline scenario export of full Map + Blueprints (vs id-references) for
  fully self-contained sharing.
- Net-play / shared scenario library — explicitly NOT in scope; everything
  is local-first.
