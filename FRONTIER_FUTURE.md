# Frontier — Future Development Plan

> Living design doc. Captures the direction we want Frontier (roguelite career mode) to evolve, scoped to **core loop & structure** and **content & systems**. Updated iteratively as decisions firm up.

**Status:** Drafting — open questions, no commitments yet.

---

## 1. Current state (baseline)

Recap of what Frontier is today (for reference — pulled from code):

- **Mode key:** `roguelite` (UI label: "Frontier"). Lives mostly in `src/roguelite.js` (8,612 lines), `src/modes/roguelite.js` (per-match config), `src/starmap.js` (node UI), `src/save.js` (persistence v3).
- **Run shape:** 5 acts × 6-column branching node lattice (combat spine + ~0.5 detours per col + act-boss).
- **Node types:** battle, elite, event (choice card), resupply (shop), boss.
- **Economy:** Credits (recruit/repair/refuel), Fuel (1/jump, capped at 8, topped up at promotion).
- **Officer:** Faction + callsign + starter perk at run-init; picks 1 of 3 traits at each promotion (max 4).
- **Fleet:** Capitals (named, leveled, commander perks) + small craft (fighter/bomber pools that replenish) + captured craft (no respawn).
- **Battle Plan:** Pre-flight wing assignment, commands (free/hold/press/defend-capital/target-class), commander perks.
- **Reputation:** Per-faction [-100..+100]; influences enemy scaling + allied reinforcement chance.
- **Permadeath:** One defeat OR a failed KIA roll ends the run. Survival check 60% base, -18% per death, 5% floor.
- **Meta:** Service Hall (servicePoints from boss kills + run wins → permanent upgrades), unlockedPerks, achievements, warProgress per faction.

### Extensibility surface (data tables in `roguelite.js`)

| Table | Approx. line | Entries | Drives |
| --- | --- | --- | --- |
| `PERKS` | 6050 | ~15 | Starter perks (run-init buffs) |
| `TRAITS` | 5929 | ~10 | Promotion-pick officer traits |
| `COMMANDER_PERKS` | 924 | ~8 | Capital/wing commander level-up picks |
| `BOONS` | 5869 | ~12 | Mid-run stackable buffs |
| `SERVICE_UPGRADES` | 1218 | ~6 | Meta-progression permanent unlocks |
| `EVENT_CARDS` | 2754 | ~50 | Choice-card events |
| `ACHIEVEMENTS` | 1038 | ~? | Milestone unlocks |
| `ACT_RANKS` / `BOSSES` / `RIVAL_NAME_POOLS` | 1729+ | — | Story/flavor |

---

## 2. Goals & non-goals

> *(To be filled in as we decide what we're actually trying to achieve.)*

### What we want Frontier to feel like

- _TBD_

### Non-goals (things we explicitly aren't changing)

- _TBD_

---

## 3. Core loop & structure changes

> *(Acts, node maps, fuel, promotions, survival, run length, branching, pacing.)*

### Open questions

- _TBD_

### Decisions

- _TBD_

---

## 4. Content & systems changes

> *(Perks, traits, events, boons, commander perks, service upgrades, achievements — what's added, removed, restructured.)*

### Open questions

- _TBD_

### Decisions

- _TBD_

---

## 5. Out-of-scope (for now)

- Battle layer changes (wings, AI, boss phases) — covered separately if/when we get to it.
- Meta-progression UI / persistence schema overhaul — same.

---

## 6. Decision log

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-05-30 | Focus future planning on core loop + content systems | User scoping; battle/UI deferred |
