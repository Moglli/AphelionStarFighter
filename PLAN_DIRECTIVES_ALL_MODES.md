# Plan — Battle Directives in All Modes

**Goal (verbatim intent):** On Frontier, players can direct/organise how their
fleet behaves in battle and give pre-battle directives & orders. Port this to
**all game modes**. In battle, players can toggle to **admiral view** to dish
out mid-battle directives. Players can give an **in-depth pre-battle plan**.
Granularity is **per class**, and strike-craft (fighter/bomber) form **wings
with their own directives**.

---

## Architecture reality (as of 2026-05-29)

The behavior layer is *already* mode-agnostic. The remaining work is almost
entirely **pre-battle UI + per-mode wiring**, not engine work.

| Capability | Status | Where |
|---|---|---|
| `game.directives` (per-class posture/missiles) init for ALL modes | ✅ done | `game.js:207` |
| `applyAdmiralPosture` honours per-class directive + per-ship `wingCommand` | ✅ done | `ai.js:339` |
| Missile-hold gate per class | ✅ done | `ship.js:1785` |
| `target-class` aim pref + `escortOf` escort leash | ✅ done | `ai.js:136,193` |
| Run-free fleet-plan layer (`makeDefaultFleetPlan`/`distributeByWeight`/`applyFleetPlan`) | ✅ done (uncommitted) | `fleetcommand.js` |
| `applyFleetPlan` called after spawn when `modeConfig.fleetPlan` present | ✅ done | `game.js:328` |
| Mid-battle TAKE COMMAND / RESUME PILOT toggle | ✅ done | `main.js:879` |
| Admiral DOM panel (per-class grid, master HOLD/FREE/PRESS, missiles, focus-fire) | ✅ done | `hud.js:368,1333` |
| **Non-Frontier modes PRODUCE a `fleetPlan`** | ❌ missing | — |
| **Generic pre-battle Fleet Plan overlay (not `run`-coupled)** | ❌ missing | Battle Plan is Frontier-only: `menus.js:2252`, reads `run` |
| **Launch flow inserts a plan step for arena/waves/daily/custom/skirmish** | ❌ missing | they go menu→`_emitStart`→`startGame` |
| **Admiral toggle verified/usable in every mode** | ⚠️ unverified | toggle exists; needs per-mode check |

Frontier keeps its richer `run`-coupled system (named commanders, traits,
perks, captured craft). The generic path is the lean sibling for the other
modes. **Do not merge them** — `roguelite.js#assignWingsToSpawned` stays;
`fleetcommand.js#applyFleetPlan` is the all-modes path.

---

## Decisions (2026-05-29)
- **Overlay**: NEW generic `menu-fleetplan` overlay, separate from Frontier's
  run-coupled Battle Plan. Frontier's screen stays untouched.
- **Launch flow**: ALWAYS show the Fleet Plan screen before each non-Frontier
  match (LAUNCH button proceeds). No silent quick-launch.

## Status: SHIPPED (2026-05-29)
All 7 stages complete + verified via Playwright. Stage 1 (data/behavior) and
the main.js forwarding were already built by a prior session; this pass built
the UI (Stages 2–4, 6), fixed the missing `consumeAdmiralToggle` (Stage 5),
and verified everything (Stage 7). Persistence is in-memory only (no
save-schema change). See CLAUDE.md changelog 2026-05-29.

## The 7 stages

### Stage 1 — Run-free fleet-command data + behavior layer  ✅ (already built)
`fleetcommand.js` + the existing ai/ship hooks. **Remaining:** sanity-verify
`applyFleetPlan` actually fires when a plan is supplied (write a probe that
stamps a plan and asserts `ship.wingCommand`/`game.directives` on spawned blue
craft). No new code expected unless the probe finds a gap.

### Stage 2 — Generic pre-battle roster model (Enemy Forces + Your Fleet)
A mode-agnostic builder that, given the *pending* launch config (selected
mode, allied/hostile race, `customRoster`/`customBlue/RedTeams`, fleetMul),
computes:
- **Enemy Forces**: `[{klass, count}]` + faction emblem(s) — from red
  race-default roster, or `customRedTeams`.
- **Your Fleet**: `[{klass, count}]` for blue — from blue race-default roster
  or `customBlueTeams`, plus the player's designed hull.
Mirror Frontier's `enemyRoster`/`capitals` shape so the overlay renderer can be
shared. Source data: `rosterForRace` (`input.js:510`), `customBlueTeams`/
`customRedTeams` (`input.js:684`), `RACES[].roster`.

### Stage 3 — Generic "Fleet Plan" pre-battle overlay (all modes)
New overlay `menu-fleetplan` (sibling of `menu-battleplan`), or a parametrized
fork of `_buildBattlePlan`/`_syncBattlePlan` that reads the Stage-2 model
instead of `run`. Sections:
1. **ENEMY FORCES** (read-only preview).
2. **YOUR FLEET — per-class directives**: posture (HOLD/FREE/PRESS) + missiles
   (FREE/HOLD) chip per class present in the blue fleet → writes
   `plan.classDirectives[klass]`.
3. **STRIKE-CRAFT WINGS** (Stage 6).
Buttons: BACK (→ menu), LAUNCH (→ stamp plan + start). **CSS trap:** add
`.menu-fleetplan` to the flex-direction-column selector list in `style.css`
(base `.menu-screen.active` is `display:flex` with no direction = row).

### Stage 4 — Wire the plan into every mode's launch flow
Insert the overlay between the menu START decision and `startGame`:
- Skirmish/Arena/Waves/Daily: `onStart`/`_emitStart` (`input.js:962`) opens the
  Fleet Plan overlay instead of emitting immediately; LAUNCH stashes the built
  plan into `justStarted.fleetPlan` then emits.
- Custom: after `onCustomStart` builds the roster, route through the overlay.
- `startGame` copies `justStarted.fleetPlan` → `game.modeConfig.fleetPlan` so
  the existing `game.js:328` hook stamps it. Verify each mode's `setup` runs
  spawn before the `applyFleetPlan` hook (it does — hook is post-`spawnRoster`
  in `startGame`, after `mode.setup`). Provide a SKIP/quick-launch path
  (default plan = `makeDefaultFleetPlan()`) so players who don't care aren't
  forced through it.

### Stage 5 — Mid-battle admiral directives in all modes
The toggle + DOM panel already exist. Work:
- Confirm the TAKE COMMAND button surfaces in arena/waves/daily/custom (HUD
  shows it only when a player ship exists — verify per mode).
- Ensure `enterSpectate`/`exitSpectate` round-trips correctly in each mode
  (Frontier has the no-respawn commander model; generic modes may differ).
- Verify per-class posture, missile toggle, master buttons, and focus-fire all
  mutate live AI in a non-Frontier match.
- Edge: Admiral mode (`modes/admiral.js`) already starts in admiral view — make
  sure the mid-battle path doesn't double-handle it.

### Stage 6 — Strike-craft wings UI (per-class, multiple wings)
In the Fleet Plan overlay, let fighters & bombers split into multiple wings
(Alpha/Bravo/…, bounded like Frontier's 2–5), each with its own command:
`free | hold | press | defend-capital | target-class` (+ target sub-picker:
capital KLASS for defend, enemy KLASS for target-class). Weight/count split is
already handled by `distributeByWeight`. Writes `plan.wings.{fighter,bomber}`.
Reuse Frontier's wing-row renderer (`menus.js:2408`) where possible. Mid-battle:
wings are honoured automatically (per-ship `wingCommand` already drives ai.js).

### Stage 7 — Persistence, polish, verification
- Persist the last-used fleet plan per mode (optional save field via
  `mergeWithDefaults`; bump schema only if shape-incompatible — additive ride
  is fine).
- CSS/layout polish for the new overlay on mobile widths.
- Playwright probes: (a) build a plan in skirmish → assert spawned blue wings
  carry `wingCommand` + class directives applied; (b) mid-battle TAKE COMMAND
  in arena mutates a posture and AI responds; (c) wings split + defend-capital
  leashes to the right capital. Zero throws, clean build.
- Append CLAUDE.md changelog entry (non-obvious gotchas only).

---

## Load-bearing gotchas (carry forward)
- **Don't merge the two wing systems.** Frontier = `assignWingsToSpawned`
  (run-coupled); all-modes = `applyFleetPlan` (transient). They share the AI
  behavior layer, nothing else.
- **`applyFleetPlan` runs post-spawn** in `startGame` (`game.js:328`), AFTER
  `mode.setup`. Modes must finish spawning in setup (they do).
- **Player ship is never wing-commanded** — `applyFleetPlan` excludes
  `s.isPlayer` (it flies on direct input).
- **CSS flex-direction trap** — every new `.menu-screen.active` overlay needs
  explicit `flex-direction: column`.
- **Spec-clone-on-descent** — any per-ship spec mutation must clone before
  write (not relevant to directives, which are per-ship `wingCommand`, but
  watch if a wing applies a stat tweak later).
- **Frontier still owns the richer overlay** — generic overlay must not read
  `run`; it reads the pending launch config only.
