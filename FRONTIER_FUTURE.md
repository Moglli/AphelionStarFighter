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
- **Two concurrent Wars** at launch, each against a **different antagonist faction** (concepts TBD).
- **Tone:** Heroic offensive — Terran humanity on the attack. Treatment is **40K-style extreme xenophobia**: humanity supreme, alien life as existential threat to be purged. The player flies for an institution that views compromise with xenos as heresy.
- **Faction roster: full redo.** The current Terran/Reavers/Hegemony/Voidsworn/Thren palette is treated as placeholders. New Terran identity is a blank slate; new antagonist factions designed from scratch.
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

### 3.5 Run structure within a War — Hybrid (campaign + sortie)

Each War is structured as a **Wing Commander / Freespace-style campaign:**

- **Authored story missions** are the spine. They gate War progress: completing a story mission unlocks the next chapter of the War's narrative. These are hand-crafted, with named locations, briefings, and story beats.
- **Side sorties** are an open pool of repeatable missions (patrol, escort, bounty, recon, etc.) the player can fly between story beats — for credits, XP, and to grind toward the next command tier.
- A single run = jumping into the War, flying story or side missions back-to-back, until the pilot dies. On death, soft-reset to a new rookie pilot; story progress, upgrades, and command tier remain.

**Open:** What's the rough split — how many story missions per War, how big is the side-sortie pool, and how does the pool evolve as story chapters advance?

### 3.6 Command-tier unlocks

- **Primary path: career XP track.** Kills and mission completions grant career XP. Tiers unlock at thresholds. Pure time/skill investment.
- **Secondary path: paid commission (IAP).** Player can buy their next tier with real money. Revenue lever for the developer.

**Tuning constraint (load-bearing):** Career XP pacing has to satisfy two audiences simultaneously:
- A non-paying player must feel the grind is *fair and paced well* — never feel forced to pay.
- A paying player must feel that buying a commission *meaningfully accelerated* their experience and was worth it.

This means each tier should represent a clearly desirable jump in capability that takes a defined-but-non-trivial number of runs to earn naturally. We'll need to revisit XP rates and tier costs together once tiers and content are defined.

**Open:** Cosmetic / ship-skin IAPs alongside commissions? Other monetization vectors?

### 3.7 War rollover — career carries

When a War retires and a new one starts:

- War credits, ship upgrades, and command tier all **persist**. The pilot account is continuous.
- The rollover is **purely narrative** — the player's identity and capabilities carry forward into the new conflict.
- Implication: ship upgrades and credits are **universal**, not per-War. Upgrade shop content is shared across Wars.

### Open questions — core loop

- [ ] What two Wars ship at v1 (factions, conflict premise, defender vs invader framing)?
- [ ] How many story missions per War (rough size)?
- [ ] How does the side-sortie pool evolve as War chapters advance?
- [ ] Career XP curve — how many runs to go rookie → admiral, roughly?
- [ ] Other monetization (cosmetics, skins, ship variants)?
- [ ] How does "evolving story narrative" between patches look — do prior War outcomes affect future Wars (e.g. a faction that was defeated in War 1 doesn't appear in War 3)?

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
| 2026-05-30 | Run shape: hybrid campaign + sortie (Wing Commander style) | Authored story missions give immersion; side sorties give grindable replay |
| 2026-05-30 | Command tiers unlock via career XP **plus** IAP "buy commission" | Primary XP track is fair; IAP gives revenue lever — XP curve must satisfy both audiences |
| 2026-05-30 | War rollover: credits, upgrades, tier all carry. Universal, not per-War | Player career is continuous across Wars; new War is narrative, not mechanical reset |
| 2026-05-30 | Two launch Wars target two different antagonist factions | Maximum variety; each War distinct in enemy roster, tactics, story |
| 2026-05-30 | Tone: heroic offensive + 40K-style extreme xenophobia | Establishes the player's institutional perspective; defines all faction relationships |
| 2026-05-30 | Full faction redesign — current Terran/Reavers/Hegemony/Voidsworn/Thren are placeholders | Existing roster doesn't carry the new tone; cleaner slate, no half-fits |
| 2026-05-30 | Terran identity: Manifest-Destiny Republic (Starship Troopers vibe) | Clean propaganda voice; jingoistic, confident, civic-pride aesthetic |
| 2026-05-30 | Player POV: True believer | Briefings land sincerely; player and institution aligned; the moral weight sits with the player without irony |
| 2026-05-30 | Launch enemies: The Swarm (insectoid hive) + The Saurian Empire (reptilian warrior aristocracy) | Maximum tactical contrast: quantity-horror vs quality-duel. Two clean target archetypes for variety. |
| 2026-05-30 | Two launch Wars are two fronts of one Republic crusade | Lets us share a global meta-state ("Republic war effort"), reuse propaganda voice, and let the player move between Wars without narrative whiplash. |

---

## 7a. Combat-mechanics constraints (study summary)

> Findings from a deep read of the current battle code. These bound what enemy designs are cheap to ship vs. require new engine work.

**Existing capabilities (free to use):**
- 7 ship classes (fighter / bomber / frigate / cruiser / battleship / carrier / station). Each faction is a **race spec** in `src/races.js` that overrides per-class stats: HP, maxSpeed, turnRate, damage, cooldown, armor, etc. Whole classes can be omitted (Thren has no frigates/cruisers/battleships, just fighters/bombers/2 carriers).
- Roster scaling per act+column: `1 + (actIndex-1) × 0.5 + col × 0.08`. Battles open with strike-craft skirmishes and grow into capital brawls — confirms the "small to big" progression the user described.
- Captain traits modify AI numerically (`aiOrbitMul`, `weaponSpreadMul`, `pdCooldownMul`, `aiAggressionMul`, etc.). Easy hook for faction-specific behavior tuning.
- `neverSurrender = true` flag for boss/ace ships — Saurian aces and Brood-ships are already supported.
- Per-class wing stance system (engage / charge / standoff / hold / fallback). Faction defaults can preset these.
- Carrier replenishment rate is per-race tunable — Swarm brood-ships can hatch fighters faster than Terran carriers.
- Damage model: shields → armor → hull, with module destruction. Missiles bypass shields; torpedoes bypass shields + armor. Faction weapons can specialize.

**Engine constraints (would need new work):**
- **No environmental hazards.** No asteroids, debris obstacles, nebulae, fog-of-war, or sensor falloff. Wrecks are cosmetic — no collision. Open-space combat only.
- **No waves / reinforcements within a battle** (except the Act-5 boss exception). All ships spawn at battle start; no mid-fight spawn-from-source.
- **No special damage types** (EMP, cloak, boarding, salvage). All damage is kinetic/explosive.
- **Heading-locked ships** — no strafing. Combat is twitchy for fighters (3.2 rad/s turn), ponderous for capitals (BB at 0.15 rad/s = ~40s for a 180° turn).
- **No sensor / detection mechanics.** Players always see all ships in the arena. No "dread of the unknown" support out of the box.

**Race-distinct combat already proven:**
- Terran: balanced baseline.
- Reavers: 48 fighters @ 22HP, hyper-fast, fragile — already a "swarm" template.
- Hegemony: 18 fighters @ 52HP, heavy, slow, brutal — already a "quality" template.
- Thren: pure strike-craft + 2 mega-carriers, no mid-tier capitals — bio-swarm template.

### Implication for our two new factions

**Saurians** map naturally onto a Hegemony-derived template (quality, low count, hard-hitting) with heavy reliance on captain traits and `neverSurrender` aces. Fits the engine *today*.

**Swarm** can take two paths:
- **Path A (engine-fit):** Re-skin a Reavers/Thren-style template — huge fighter count, fragile, fast, brood-ship carriers that replenish at extreme rates. Atmospheric dread is delivered via *audio + comms + visual design*, not gameplay mechanics. Cheap to ship.
- **Path B (engine-extend):** Build environmental hazards (asteroid fields, debris obstacles, fog-of-war) so we can deliver the true "asteroid hunt" feel. Much more work; reusable for future factions too.

We'll pick a path below.

---

## 7. Faction design — work area

> Drafting space for the new faction roster. Decisions land in §6 once locked.

### 7.1 The Terran human empire — Manifest-Destiny Republic

**Identity:** A democratic-on-paper, jingoistic-in-practice human republic. **Service guarantees citizenship.** Humanity has decided the stars are its birthright; the rest of the galaxy is in the way. Starship Troopers / Heinlein tone — clean propaganda, civic pride, parade-ground confidence.

**Working name:** TBD. (Placeholder candidates: "Terran United Command", "Terran Republic", "Sol Republic". Pick at content-pass.)

**Voice / aesthetic:**
- **Propaganda-clean visual style** — recruitment posters, neon civic pride, lit-up parade hangars. The opposite of grimdark.
- **Bright confident briefings** — "Citizens. Your Republic asks of you a simple duty." Pep-talk cadence, even when the orders are brutal.
- **Patriotic comms chatter** — wingmates whoop, anthems on the comm, mission-end speeches.
- **Civic-religious overlay** — humanity treated as the rightful inheritor of the stars; xenos as obstacles to a manifest destiny.

**Player POV: True believer.**
- Player has bought the ideology in full. Briefings *hit*. Squadron banter is sincere, not ironic.
- Dialogue, mission narration, and HUD voice-lines all written from inside the worldview.
- Immersion strategy: the player isn't a cog or a cynic — they're the *hero* of their own crusade. The institution and the player are aligned. The contrast (and the design challenge) is that what feels heroic to the player is, by any external read, genocidal. The game doesn't flinch from that; it just doesn't make the player flinch either.

**Implications for content:**
- Briefings can be earnest and stirring. We don't need to undercut them.
- Faction relationships are binary: humans = us, xenos = them. No diplomatic middle ground.
- Dialogue/voice writing is straightforward: clear, confident, civic.

### 7.2 Launch antagonist A — The Swarm (insectoid hive)

**Identity:** Bio-organic alien hive. Mindless, voracious, incommunicable. Ships are grown, not built. They strip systems of biomass and move on. The Republic frames them as "locusts" — a natural disaster with a face.

**Working name:** TBD (placeholder: "The Brood").

**Why we fight them (in-fiction):** Existential. They eat worlds. No diplomacy is possible because there's no one to talk to. A perfect xenophobic target — easy to hate, no moral ambiguity.

**Combat feel — provisional direction (pending combat-mechanics study):**
- "Hunter becomes hunted" atmospheric pattern. Encounters often staged in dense terrain — asteroid belts, debris fields, dead-hulk graveyards.
- Drones nest in cover; player flushes them out room-by-room.
- Brood-ships are anchored deep, protected by environmental hazards.
- Slower-paced, environment-driven, exploration-tinged tension.
- Still no comms warfare — Swarm doesn't speak. Wing chatter carries the atmosphere instead (nervous wingmates, dread in their voices).
- *To verify against existing combat mechanics.*

### 7.3 Launch antagonist B — The Saurian Empire (proud reptilian warriors)

**Identity:** Ancient reptilian warrior aristocracy. Named champions, honor codes, banner-bearing ships. They see humanity as upstarts encroaching on stars that should be theirs. They are skilled, proud, and *equal* in ambition — the dark mirror of the Terran Republic.

**Working name:** TBD (placeholder: "The Var'sakh Dominion").

**Why we fight them (in-fiction):** Sovereignty. They claim systems the Republic wants. Unlike the Swarm, this is a war between two civilizations — but the Republic frames it as the necessary defeat of an arrogant xenos pretender.

**Combat feel — provisional direction (pending combat-mechanics study):**
- **Saurians map naturally onto the game's existing combat escalation pattern.** The game already opens with small strike-craft skirmishes and grows into capital engagements; the Saurian War leans into that — every fight is a step up the ladder, named flagships at the top.
- Capital duels as set-pieces: named banner-cruisers / battlecruisers with escort, friendly capital engages enemy capital while player handles fighter screen.
- Named captains on comms, banner heraldry on hulls, taunts and challenges in voice lines.
- *To verify and detail against existing combat mechanics.*

### 7.4 Future-faction palette — open

> Other antagonists / sub-factions to seed for future Wars. Synthetics, Resonant Choir, and others remain candidates for post-launch.
