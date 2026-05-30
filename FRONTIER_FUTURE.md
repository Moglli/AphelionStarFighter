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

## 2. North-star vision

Frontier becomes a **galaxy-wide war drama** with a live, evolving meta-narrative. The current 5-act "officer career" structure is removed. The mode is reframed around **Wars** — hand-authored, story-driven, time-limited conflicts that rotate as the galactic story progresses.

### Pillars

1. **Story first.** The thin "jump → fight → next" loop is the core problem. Every War must deliver authored narrative, characters, and stakes — not just procedural skirmishes.
2. **Meaningful choices.** Currently absent. Wars, command tier, ship upgrades, and within-run decisions all need to actually matter.
3. **Identity through play.** Faction + opening choices should produce visibly different runs.
4. **Live galaxy.** Wars come and go; the universe state advances over the lifetime of the game.

### Launch scope (v1 of the new system)

- **One playable race:** Terrans only (other races deferred — design should not preclude them).
- **Two concurrent Wars** at launch (concepts TBD).
- **Career progression** that unlocks player command scope over many runs (see §3).
- **Two-tier currency:** in-run credits + war credits (see §3).
- **Soft-death roguelite meta:** ship upgrades and war credits persist; each death starts a new rookie pilot in the same War.

### Non-goals (deferred, not killed)

- Multiplayer / shared global war state.
- Other playable races.
- Battle-layer mechanics (wing AI, boss phases, weapon balance) — handled separately.
- Persistence-schema overhaul beyond what these features require.

---

## 3. Core loop & structure — direction so far

### 3.1 War as the top-level unit

- A **War** is an authored, time-bounded conflict the player engages with (defending or invading a specific faction).
- Wars rotate **hybrid-style:** story advances globally per-patch (devs ship new Wars and retire old ones); within a patch, multiple Wars are live concurrently and the player picks which to engage with.
- Frontier's old run-setup (faction + callsign + starter perk) is replaced by **War selection** as the entry point.

**Open:** What two Wars ship at launch? (See §3 open questions.)

### 3.2 Career-tier command progression

Player's **command scope unlocks gradually over many runs**, replacing the in-run rank/promotion ladder. Tiers (rough, to be refined):

| Tier | Player can control |
| --- | --- |
| 0 — Rookie | Their own fighter only. No orders to anyone. |
| 1 — Wing Lead | Command **one fighter wing** (their own). |
| 2 — Strike Lead | Command **all friendly fighters**. |
| 3 — Strike Group Lead | Command **all strike craft** (fighters + bombers). |
| 4 — Tactical Officer | Strike craft + **frigates**. |
| 5+ — Captain / Commodore / Admiral | Progressively cruisers, capitals, full fleet. |

**Open:** What unlocks each tier — banked war credits, accolade thresholds, story-mission completion, or hybrid? Do tiers reset per-War or carry across all Wars?

### 3.3 Soft-death meta-progression

- Pilot dies → run ends. Pilot identity is lost (next run is a fresh rookie pilot, narratively).
- **What persists:** war credits (banked at run-end), ship upgrades, command tier, War-state contributions, achievements.
- New run starts back in the active War with whatever upgrades and command tier the player has earned.

### 3.4 Currency model — two tiers

- **In-run credits:** used mid-run (recruits, repairs, refuels — whatever the new run-internal economy is). Lost on death.
- **War credits:** banked at run-end, spent **between runs** on ship upgrades. Persist through death.
- Current `servicePoints` / Service Hall is folded into the War-credit upgrade shop (or removed).

**Open:** Are war credits per-War (lost when the War rotates out) or cross-War (universal currency)? Same question for ship upgrades.

### 3.5 Run structure within a War

> *(How the 5-act starmap maps to the new model — totally open.)*

**Open:** Does each War have its own multi-mission campaign (starmap-like)? Or is each run a single sortie / mission? Or is a War a long thread of varied missions with branching?

### Open questions — core loop

- [ ] What two Wars ship at v1 (factions, conflict premise, defender vs invader framing)?
- [ ] What unlocks each command tier?
- [ ] Do command tiers persist across Wars or reset?
- [ ] War credits and ship upgrades — per-War or universal?
- [ ] What does a single run look like structurally inside a War? (starmap? linear missions? freeform?)
- [ ] What does "evolving story narrative" between patches look like operationally — do prior War outcomes affect future Wars?

---

## 4. Content & systems — direction so far

Existing data tables (PERKS, TRAITS, BOONS, COMMANDER_PERKS, SERVICE_UPGRADES, EVENT_CARDS, ACHIEVEMENTS, ACT_RANKS, BOSSES) will need to be re-evaluated against the new framing. Some likely survive (re-themed); some are obsoleted by tier/upgrade systems.

### Open questions — content

- [ ] What categories of ship upgrades exist? (weapons / hull / engines / electronics / consumables?) How many tiers each?
- [ ] How do we deliver in-run immersion — briefings, named NPCs, comms chatter, debriefs, persistent characters across runs?
- [ ] Do EVENT_CARDS survive in some form, or is in-run story handled via authored mission scripts now?
- [ ] What's the role (if any) of perks/traits/boons under the new model?
- [ ] How does War state get visualized between runs (newsfeed, galaxy map, faction power tracker)?
- [ ] What replaces the achievements system, or do achievements remain a parallel system?

### Decisions

- _Pending_

---

## 5. Out-of-scope (for now)

- Battle-layer changes (wing AI, weapons, boss phases).
- Other playable races.
- Multiplayer / shared world state.
- Detailed persistence-schema work (we'll specify when content lands).

---

## 6. Decision log

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-05-30 | Focus future planning on core loop + content systems | User scoping; battle/UI deferred |
| 2026-05-30 | Replace 5-act officer career with seasonal "Wars" framing | Existing arc fails to deliver immersion or meaningful choices; war framing gives authored stakes |
| 2026-05-30 | Launch scope: Terrans only, 2 concurrent Wars | Keep v1 ship-able; design must allow future races |
| 2026-05-30 | Player scope: solo pilot → gradually unlocks fleet command across runs | Replaces in-run promotions with career meta-progression; gives long-term identity arc |
| 2026-05-30 | War rotation: hybrid (per-patch story, concurrent live Wars within a patch) | Devs control narrative cadence; player gets choice within a window |
| 2026-05-30 | Currency: two tiers — in-run credits + banked war credits | Preserves mid-run economy; gives meta-progression a clean currency |
| 2026-05-30 | Death is soft — war credits and upgrades persist | Classic roguelite-meta; keeps each run meaningful but loss-tolerant |
