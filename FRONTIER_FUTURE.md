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

### 3.2 Career-tier progression (command scope + pilot class)

Player's career advancement is a **single XP track** that simultaneously unlocks two things at each tier: the **command scope** they can wield AND the **ship class** they can personally pilot. The piloting unlock lags one tier behind the command-scope unlock on average — you can pilot what you've earned the right to lead.

| Tier | Command scope | Pilotable ship classes |
| --- | --- | --- |
| 0 — Rookie | None | Fighter only |
| 1 — Wing Lead | Own fighter wing | Fighter |
| 2 — Strike Lead | All friendly fighters | Fighter, **Bomber** |
| 3 — Strike Group Lead | All strike craft (fighters + bombers) | + **Frigate** |
| 4 — Tactical Officer | Strike craft + frigates | + **Cruiser** |
| 5 — Captain | + cruisers, capitals | + **Battleship**, **Carrier** |
| 6+ — Commodore / Admiral | Full fleet | All classes |

The player picks **which class to pilot** per mission/run from those they've unlocked. The fighter remains a valid choice at admiral rank (agility matters); higher classes are heavier and slower but command more battlefield presence.

### 3.3 Soft-death meta-progression

- Pilot dies → run ends. Pilot identity is lost (next run is a fresh rookie pilot, narratively).
- **What persists:** war credits (banked at run-end), ship upgrades, command tier, War-state contributions, achievements.
- New run starts back in the active War with whatever upgrades and command tier the player has earned.

### 3.4 Currency model — single tier (war credits)

- **War credits** are the only currency. Earned from mission rewards, kill bounties, and auto-salvage of unwanted loot. Banked continuously — never lost on death.
- Spent at the Quartermaster shop, on premium chests (real-money chests payout in items, not credits), and on any future credit sinks (cosmetics, etc.).
- The earlier two-tier model (in-run credits + war credits) is **dropped**. With no fleet editability, no procedural events, and no mid-run port mechanics, the second-tier currency had no real role left.
- Universal — not per-War. Carries across War rollovers.
- The legacy `servicePoints` / Service Hall is sunset along with PERKS / TRAITS / BOONS / SERVICE_UPGRADES / EVENT_CARDS — its functional role is absorbed by the loot system and the command-tier track.

### 3.5 Run structure within a War — Hybrid (campaign + sortie)

Each War is structured as a **Wing Commander / Freespace-style campaign:**

- **Authored story missions** are the spine. They gate War progress: completing a story mission unlocks the next chapter of the War's narrative. These are hand-crafted, with named locations, briefings, and story beats.
- **Side sorties** are an open pool of repeatable missions (patrol, escort, bounty, recon, etc.) the player can fly between story beats — for credits, XP, and to grind toward the next command tier.
- A single run = jumping into the War, flying story or side missions back-to-back, until the pilot dies. On death, soft-reset to a new rookie pilot; story progress, upgrades, and command tier remain.

**Open:** What's the rough split — how many story missions per War, how big is the side-sortie pool, and how does the pool evolve as story chapters advance?

### 3.6 Career-tier unlocks

- **Primary path: career XP track.** Kills and mission completions grant career XP. Tiers unlock at thresholds. Pure time/skill investment.
- **Secondary path: paid commission (IAP).** Player can buy their next tier with real money. Revenue lever for the developer.

**Tuning constraint (load-bearing):** Career XP pacing has to satisfy two audiences simultaneously:
- A non-paying player must feel the grind is *fair and paced well* — never feel forced to pay.
- A paying player must feel that buying a commission *meaningfully accelerated* their experience and was worth it.

Each tier represents a clearly desirable jump (new pilotable class + broader command scope). We'll revisit XP rates and tier costs once content is in.

### 3.6a Monetization vectors

In addition to the **paid commission (tier-skip)** above, the IAP surface includes:

- **Cosmetic skins.** Ship paint jobs, banner placements, hull decals, contrail colors. Zero gameplay impact. Universally uncontroversial; revenue floor.
- **Loot boxes / premium chests.** Real-money chests that roll random modules at boosted rarity. **Carries regulatory risk** (BE/NL/AUS restrictions); implementation must include:
  - Disclosed odds (required in several jurisdictions and good practice everywhere)
  - Regional sales blocks where loot boxes are restricted
  - Pity timer / guaranteed-Rare-or-better floor after N chests
  - Free non-paid alternative path (already in place via mission drops + Quartermaster shop)
  - Age-appropriate rating

Not chosen (kept off the table): inventory expansion IAP; premium reroll/craft currency.

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

Legacy data tables (PERKS, TRAITS, BOONS, COMMANDER_PERKS, SERVICE_UPGRADES, EVENT_CARDS, ACT_RANKS) are **sunset**. Their functional roles are absorbed by:

- **Loot system (§9)** — Legendary affixes replace starter perks and stackable boons.
- **Career-tier track (§3.2 / §3.6)** — tier rewards replace in-run promotion picks.
- **Authored mission writing (§8)** — chapter scripts replace EVENT_CARDS.
- **Achievements** — survive as a parallel milestone system.

ACT_RANKS and BOSSES are effectively replaced by the per-War chapter structure and named-ace casting (§8).

### Open questions — content

- [ ] How does War state get visualized between runs (newsfeed, galaxy map, faction power tracker)?
- [ ] Achievement structure under the new model — what's tracked, what rewards?
- [ ] Career XP gain rates per mission type — how many runs to reach each tier?

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
| 2026-05-30 | Swarm combat: Path A (engine-fit reskin of Reavers/Thren template) | Ships now; engine-extension (environmental hazards) deferred to a later pass. Dread carried by audio/visual/dialogue. |
| 2026-05-30 | Saurian cultural distinctness: distinct silhouettes, distinct weapon systems, banner heraldry on capitals | Reads as alien at a glance; not just stat-overlays. Mid-fight voice deferred; pre-battle hails first. |
| 2026-05-30 | Launch Wars locked at concept level: Op Locust Wind (Brood) + Op Dragon's Jaw (Saurian) | 5-chapter spines + 8-mission sortie pools each; shared staging at Novus Spes; shared Republic officer cast. |
| 2026-05-30 | Game's voice = propaganda only. Reality lives in designer notes (§8.4), invisible to player | Preserves locked True Believer POV; future Wars can mine subtext as reveal arcs. |
| 2026-05-30 | Locust Wind CH4 = "Drown the hatchery" (kill brood-ships before Hive assault) | Engine has no rescue mechanic; thematic finality before the boss. |
| 2026-05-30 | Dragon's Jaw CH4 = force *DRAKAR-TSSOR* to strike colors; Varas escapes | Engine has capture-via-surrender, not boarding; preserves trophy moment & sets up CH5 hardliners. |
| 2026-05-30 | Dragon's Jaw CH5 = hardliner Houses (Drazn / Sk'rath) refuse armistice; player exterminates them | Engine has clean win/lose only; treaty-first / battle-second preserves political-spin angle and gives a real boss fight (Khelovar). |
| 2026-05-30 | Republic officer cast roles fixed: Kroger (admiral/propaganda voice), Brant (wing commander/briefer), Hale (squadron CO/flies), Tarsa (player's wingmate) | Standard rank stack. Names placeholder, ranks and roles canonical. |
| 2026-05-30 | Saurian Houses set: Tssor'kan / Sk'rath / Vael'ari / Drazn — each with banner sigil and named ace | Heraldry now has something to render; aces tied to House identities. Placeholder names. |
| 2026-05-30 | CH2 "setback" language in both Wars reframed as Pyrrhic victory, not loss | Player always wins missions to progress; the story-beat must read as "held the line at cost," not "lost." |
| 2026-05-30 | War credits spent on PERSONAL ships only; fleet ships not editable | Focused meta loop; Shipyard is the single upgrade surface; fleet quality grows passively with tier |
| 2026-05-30 | Upgrade structure: modular slot swap (Diablo-style) | Maximum replayability via build identity; most depth |
| 2026-05-30 | Loot depth: Full Diablo — rarity tiers + affix rolls + Legendary uniques | Endless loot chase; biggest engine work but biggest replay value |
| 2026-05-30 | Multi-class piloting: as tier climbs, player unlocks new ship classes to pilot; each has its own outfittable loadout | Fleet-of-pilotable-ships model; fighter remains valid at admiral rank |
| 2026-05-30 | Slot scheme: class-typed (each class has own slots; modules are class-specific drops) | Most depth per class; module families don't overlap |
| 2026-05-30 | Rarity tiers: Common / Uncommon / Rare / Epic / Legendary (standard ARPG palette) | Universally recognized; standard color codes |
| 2026-05-30 | Affix system: stat-roll ladder by rarity + 1 unique Legendary affix per Legendary | Classic build-defining hunt loop |
| 2026-05-30 | Drop sources: mission rewards + boss/ace drops + Republic Quartermaster shop | Three predictable sources; no mid-mission pickup loop (combat stays focused) |
| 2026-05-30 | Brood missions drop bio-tech modules — risk/reward effects, distinct alien aesthetic | Adds visual + mechanical variety; Brood is a meaningful drop source despite "no civilization" |
| 2026-05-30 | Pilot-class unlocks aligned with command tier (single XP track) | Intuitive; one progression motion |
| 2026-05-30 | IAP vectors beyond commission: cosmetic skins + premium loot chests | Cosmetics are revenue floor; loot boxes need guardrails (odds, regional blocks, pity timer) |
| 2026-05-30 | Inventory: one equipped loadout per ship class + shared finite stash + auto-salvage | No hoarding tax, no manual scrap chore; combat stays uncluttered |
| 2026-05-30 | Legacy systems sunset: PERKS / TRAITS / BOONS / COMMANDER_PERKS / SERVICE_UPGRADES / EVENT_CARDS deleted; ACHIEVEMENTS survive | Clean break; functional roles absorbed by loot system + command-tier track + authored missions |

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

**Combat feel — Path A (engine-fit, ship now):**

Reskin/extend the Reavers/Thren template. The Swarm is **mechanically a fragile-fast swarm** — huge fighter counts, anemic individual HP, hatched continuously from heavily-armored brood-ships (carriers tuned for very fast replenishment) and capped by an enormous hive-ship boss with thick armor and dense PD. Atmospheric dread is delivered through:

- Audio (no enemy comms; uneasy wing chatter; growing kill-count alarms; a percussive heart-beat track that intensifies as drones converge).
- Visual identity (organic ships with glow, pulse, blood spray on hit; debris that *twitches*).
- Wing-mate dialogue (rookies losing nerve, comms going quiet from killed wingmates).
- Battle Plan tension (player can't trust standoff range — drones close fast; commands rotate around brood-ship priority).

**Engine-extension (Path B) is deferred** — not killed, but not blocking v1. Environmental hazards (asteroid collision, debris fields, sensor falloff) remain a candidate for a later pass that would deepen Swarm missions and unlock variety for all future Wars.

**Provisional Swarm roster shape (Path A baseline, subject to revision):**

| Class | Count | Identity | Stats vs Terran baseline |
|---|---|---|---|
| Fighter (drone) | ~60 | Mindless, swarming, suicidal-aggressive (default `charge` stance) | HP 16 (−54%), maxSpeed 560 (+40%), low damage |
| Bomber (warrior) | ~12 | Slightly tougher, missile-bio-pods | HP 60, slower than Terran bomber, more pods |
| Brood-ship (carrier) | 3 | Hatch fighters every 4–6s; heavy armor, no offensive weapon | HP 1400, replenish ×3 the Terran rate |
| Hive-ship (battleship-equivalent boss) | 1 | Massive armored hull, dense PD, no offensive cannons — its *threat* is what it spawns | HP 2200, `neverSurrender` |
| Frigate / cruiser | — | Omitted (no "civilization-level" tech) | — |

(Numbers are placeholders to react to, not final.)

### 7.3 Launch antagonist B — The Saurian Empire (proud reptilian warriors)

**Identity:** Ancient reptilian warrior aristocracy. Named champions, honor codes, banner-bearing ships. They see humanity as upstarts encroaching on stars that should be theirs. They are skilled, proud, and *equal* in ambition — the dark mirror of the Terran Republic.

**Working name:** TBD (placeholder: "The Var'sakh Dominion").

**Why we fight them (in-fiction):** Sovereignty. They claim systems the Republic wants. Unlike the Swarm, this is a war between two civilizations — but the Republic frames it as the necessary defeat of an arrogant xenos pretender.

**Combat feel — fits existing engine cleanly:**

The Saurian War is the **quality** counterpart to the Swarm's quantity, and the game's existing escalation cadence (act × column scaling) already delivers exactly the rhythm we want: early Saurian fights are wing-vs-wing strike-craft duels; later fights are escorted-capital engagements; boss nodes are named flagships with `neverSurrender`.

- **Quality over quantity.** Fewer Saurian ships per battle than Terran, but each one significantly tougher and more skilled (captain traits dialed for tighter aim, lower spread, aggressive orbit).
- **Named aces in every act.** Boss nodes spawn a flagship with a named captain (e.g. "Var'sakh-Captain Thessek, banner of the Iron Tide"). `neverSurrender` already enforces death-or-victory.
- **Capital duels as set-pieces.** Late-act Saurian battles feature banner-cruisers/battlecruisers with escort screens. Friendly capitals duel enemy flagships while player + wing handle the fighter screen.
- **Comms warfare is *present*, but deferred for v1.** Saurians do speak — pre-battle hails are the priority (briefings, opening exchanges). Mid-fight taunts and dying-captain lines are a later content pass once the system is in.
- **Honor and surrender.** Saurians surrender at the existing thresholds (they're not mindless). Captured Saurian capitals become spoils of war — adds to the player's fleet. Reinforces the heroic-offensive vibe (we are humiliating an honor-bound culture by capturing their banners).

**Saurian cultural distinctness (visible in play):**

- **Distinct ship silhouettes** — sweeping, ornamented, predatory. Not just stat-overlays on Terran hulls. The visual language reads "alien, proud, ancient" at a glance.
- **House banner heraldry on capitals** — each Saurian frigate/cruiser/battleship/carrier displays a visible banner sigil on the hull. Players learn to recognize houses; trophies become collectible.
- **Distinct weapon systems** — Saurians don't fire the same missiles and cannons in different paint. Their weapons behave differently. (Specifics TBD — see open questions.)
- **Pre-battle voice/comms** — text/voice hails before engagement. Mid-fight chatter and death lines deferred to a later pass.

**Provisional Saurian roster shape (subject to revision):**

| Class | Count | Identity | Stats vs Terran baseline |
|---|---|---|---|
| Fighter | ~16 | Skilled pilots, heavy armor for a fighter | HP 50 (+43%), maxSpeed 360, damage 5.5 — Hegemony-like |
| Bomber | ~4 | Honor-strike, fewer but deadlier | HP 80, heavier pods |
| Frigate | ~5 | Honor-escort to capitals; named in late acts | Tough, slower than Terran frigate |
| Cruiser | ~2 | Banner-cruisers, named captains in late acts | Heavy armor, broadside-rich |
| Battleship | 1 | Each act-boss battle features one; named flagship at act-end | `neverSurrender`, +25% HP over Terran BB |
| Carrier | 1 | Banner-carrier, slow but defended | — |

(Numbers placeholder.)

### 7.4 Future-faction palette — open

> Other antagonists / sub-factions to seed for future Wars. Synthetics, Resonant Choir, and others remain candidates for post-launch.

---

## 8. Launch Wars — content draft

> Concept-level lock for the two launch Wars. Subject to writing/scripting refinement, but the structural beats, mission types, characters, and Houses are committed.

### 8.1 Republic officer cast (shared across both Wars)

Names are placeholders; ranks and roles are fixed. Both Wars use this cast.

- **High Admiral Marcus Kroger** — public face of the war effort. Appears in fleet-wide broadcasts and pre-deployment briefings. Confident, paternal, all-conquering. The propaganda voice incarnate. Rarely seen in-cockpit.
- **Commander Elise Brant** — wing commander running the player's deployment. Voice of in-mission briefings. No-nonsense, demanding, unflinchingly proud of her pilots. The player answers to her.
- **Captain Aris Hale** — squadron captain. Flies with the squadron, leads from the front. Charismatic, brave, pilot's-pilot. Vulnerable — sometimes endangered so the player has to act to save him.
- **Lieutenant Mira Tarsa** — the player's wingmate. Recently promoted, still earnest. The relatable comrade. Voice of mid-mission chatter and audience-surrogate emotion.

### 8.2 Op Locust Wind — the Brood War

#### Pitch

*"Citizens of the Frontier — a new threat to humanity's manifest destiny has been identified. The Brood, a monstrous alien swarm, is devouring its way across the frontier. They are mindless, voracious, and incommunicable, consuming entire star systems. The Republic has authorized a campaign of total war to exterminate this menace. Enlist today to become a hero of the frontier and secure humanity's rightful place in the galaxy."*

#### Geography

- **Staging system:** Novus Spes *(shared with Dragon's Jaw)*
- **Contested systems:** Bellum, Vorago, Rupes, Vastitas
- **Final target:** The Hive

#### Chapter spine

**CH1 — THE SWARM.** The Brood has been sighted at the edge of Republic space; a campaign of extermination is underway. Strike-craft patrols report massive alien presence in Bellum. The player flies early skirmishes against the swarm.
- *Type:* Fighter sweep — small skirmish
- *Beat:* The Brood is confirmed as an existential threat
- *NPCs:* Lt. Tarsa, Cmd. Brant

**CH2 — BROKEN LINE.** Brood forces overwhelm forward defenses and advance toward Novus Spes. All wings are ordered to hold the line in Vorago, buying time for reinforcements. The player must contain the swarm until heavier ships deploy.
- *Type:* Line defense (Defend mode) — medium skirmish
- *Beat:* The Republic holds the line at brutal cost; the swarm proves larger than projected and the war's true scale becomes clear
- *NPCs:* Capt. Hale

**CH3 — EXTERMINATUS.** With reinforcements in place, the Republic launches an aggressive counteroffensive in Rupes. The player leads strike groups against massive Brood-carriers, crippling their hatch capacity.
- *Type:* Capital assault — large skirmish
- *Beat:* The tide is stemmed; Republic morale surges
- *NPCs:* High Adm. Kroger

**CH4 — DROWN THE HATCHERY.** Republic intelligence locates the Brood's last surviving brood-ship cluster deep in Vastitas. The player leads a strike to destroy the swarm's reproductive infrastructure before the assault on the Hive can begin. No more drones will hatch.
- *Type:* Capital strike against multiple brood-ship objectives — fleet battle
- *Beat:* The Brood's ability to replenish ends; the path to the Hive is clear
- *NPCs:* Cmd. Brant, Capt. Hale

**CH5 — THE HIVE.** The Brood has retreated to their home system, where the massive Hive-ship continues to spawn drones. The player leads the final assault. The Hive must die.
- *Type:* Boss assault (Hive-ship as `neverSurrender` capital) — massive fleet battle
- *Beat:* The Hive is destroyed; the Brood is exterminated
- *NPCs:* High Adm. Kroger, Lt. Tarsa

#### Side-sortie pool (8)

1. **Swarm suppression** — clear drone clouds in contested systems
2. **Salvage escort** — protect civilian salvage crews working post-battle zones
3. **Decoy run** — engage drone packs while civilian transports break orbit
4. **Brood-ship strike** — destroy a Brood-carrier before its hatch cycle completes
5. **Listening post relief** — defend a Republic comms relay from a drone wave
6. **Burnt-system patrol** — pacify holdout drones in systems already declared "secure"
7. **Refugee convoy escort** — escort civilian transports out of contested zones
8. **Forward picket** — sortie ahead of a fleet's jump-point as early warning

#### Voice samples

*Opening briefing (CH1):* "Citizens of the Frontier, a new threat to humanity's manifest destiny has been identified. An alien swarm is consuming entire star systems at the edge of Republic space. Your orders are to contain this menace before it spreads. Report to the Bellum system and engage all hostile forces. By the Republic, we will prevail."

*Mid-mission wingmate chatter (Tarsa):* "They're everywhere! Keep in formation, and don't let them swarm you. For Earth!"

*End-of-chapter propaganda blast (Kroger):* "Citizens of the Republic! The Brood is no match for human courage and ingenuity. Your efforts have secured the frontier, and extermination of the alien menace is underway. Glory to the Republic!"

#### War culmination

The Hive is destroyed. The Brood is exterminated. The Republic secures the frontier and claims new systems for humanity. Recruitment surges as propaganda spreads the triumph. The galaxy is ready for the next stage of expansion.

### 8.3 Op Dragon's Jaw — the Saurian War

#### Pitch

*"Citizens of the Republic — a glorious campaign of expansion is underway! The Terran Republic has launched an offensive to secure contested frontier systems from the Var'sakh Dominion, an ancient empire that refuses to recognize humanity's rightful claim to the stars. The Saurians are a proud, warlike race, but they cannot withstand the might of the Republic. Enlist today and secure your place in history as we bring these contested systems under human control."*

#### Geography

- **Staging system:** Novus Spes *(shared with Locust Wind)*
- **Contested systems:** Var, Sskahl, Khel, Tazsa
- **Final target:** Zavat (Dominion core system; not their homeworld)

#### Saurian Houses & aces

| House | Banner sigil | Ace | Role |
| --- | --- | --- | --- |
| **House Tssor'kan** — "the Old Blood" | A great horned serpent coiled around a star | **Warlord Varas** | Commands all Dominion forces in the contested frontier. CH2/4 antagonist; escapes at CH4's end. |
| **House Sk'rath** — "the Iron Sun" | A barbed sun on black | **Zikorex** | Honored fleet-ace; defeated and his banner paraded at CH3. |
| **House Vael'ari** — "the Silver Talon" | A hooked talon over crescent | **Ssaik** | Defensive ace; bloodied at CH3. |
| **House Drazn** — "the Black Tide" | A crashing dark wave | **Khelovar** | Hardliner; refuses CH5's armistice. The CH5 boss — `neverSurrender`. |

#### Chapter spine

**CH1 — BOLD STRIKE.** The Republic invades Dominion space with a surprise attack on Var, one of the most resource-rich contested zones. The player joins an initial fighter sweep, engaging Dominion forces and capturing key positions before they can regroup.
- *Type:* Fighter sweep — small skirmish
- *Beat:* The Republic gains an early foothold in contested space
- *NPCs:* Lt. Tarsa, Cmd. Brant, Capt. Hale

**CH2 — SAURIAN HONOR.** Dominion forces rally under Warlord Varas and counterattack in Sskahl. The player must defend Republic positions against relentless Dominion assaults.
- *Type:* Line defense (Defend mode) — medium skirmish
- *Beat:* Dominion resistance is harder than briefed; the Republic adapts, but every advance is paid for in blood
- *NPCs:* Varas of House Tssor'kan, High Adm. Kroger

**CH3 — BROKEN BANNERS.** The Republic retaliates with a coordinated assault on Khel, targeting Dominion capitals and named aces. Strike groups break the Houses of Sk'rath and Vael'ari in successive engagements; Zikorex's banner is recovered as a trophy and paraded on Republic newsreels.
- *Type:* Capital assault + ace hunt — large skirmish
- *Beat:* Key Dominion Houses bloodied; Republic advances at heavy cost
- *NPCs:* Zikorex of House Sk'rath, Ssaik of House Vael'ari, High Adm. Kroger

**CH4 — HONORLESS FOES.** Dominion forces regroup for a stand at Tazsa, anchored by Warlord Varas's banner-cruiser *DRAKAR-TSSOR*. The player commands a task force to break the line and force the *DRAKAR-TSSOR* to strike its colors. Varas escapes in an honor-guard frigate as the flagship yields; he vows the war is not yet over.
- *Type:* Force-surrender (push enemy flagship to surrender thresholds — capture mechanic engages) — fleet battle
- *Beat:* Captured flagship becomes a Republic trophy; Varas survives to fight on
- *NPCs:* Varas of House Tssor'kan, Cmd. Brant

**CH5 — DRAGON'S JAW.** Broken and outnumbered, Varas sues for terms. The Republic accepts — the Dominion withdraws from all contested frontier systems in exchange for recognition of their core territory. Across the galaxy, the treaty is announced as Republic triumph. But Houses Drazn and Sk'rath refuse the armistice. They retreat to Zavat and prepare a last stand, intending to die rather than yield. The player leads the assault that ends them.
- *Type:* Boss assault (Khelovar of House Drazn as `neverSurrender` flagship captain) — massive fleet battle
- *Beat:* The hardliner Dominion factions are exterminated; the official treaty is celebrated; the war is "won"
- *NPCs:* Khelovar of House Drazn, High Adm. Kroger, Lt. Tarsa

#### Side-sortie pool (8)

1. **Banner challenge** — engage a named Dominion ace and recover their banner as trophy
2. **Convoy raid** — destroy Dominion supply lines
3. **Honor duel** — small wing-vs-wing skirmish in disputed space
4. **Deep-strike** — probe a Dominion patrol route; return with what you survive
5. **Force-surrender** — disable a Dominion capital to make it strike colors (captured)
6. **Propaganda escort** — escort Republic broadcast ships into contested space
7. **Banner hunt** — bounty contract on a specific House's capital
8. **Forward intercept** — ambush incoming Dominion reinforcements before they reach the front

#### Voice samples

*Opening briefing (CH1):* "Citizens of the Republic, a glorious campaign of expansion is underway! Your orders are to strike deep into contested territory and secure the Var system. Expect heavy resistance from an ancient foe that refuses to acknowledge humanity's rightful place among the stars. For Earth and the Republic!"

*Mid-mission wingmate chatter (Tarsa):* "They're not backing down! Keep in formation, and watch for those honor-guard formations. For Earth!"

*End-of-chapter propaganda blast (Kroger):* "Citizens of the Republic! The Saurian pretenders have been driven from our rightful frontier systems. Your courage has secured new resources for the Republic's continued expansion. Glory to the Republic!"

#### War culmination

The Treaty of Zavat is signed. The Dominion withdraws from all contested frontier systems, ceding them to Republic control. In exchange, the Republic formally recognizes Dominion sovereignty over their core systems, including Zavat. Republic propaganda celebrates total victory.

### 8.4 Designer notes — hidden meta-narrative

> **Internal-only context for the writing team. The player never sees this material.** The game's voice presents only the propaganda. Future Wars may surface elements of this subtext as reveal arcs.

**Op Dragon's Jaw — true context (player never sees):**

Both empires are expanding into the same resource-rich frontier systems. The Dominion actually settled several of these systems first, but the Republic's manifest-destiny ideology cannot accept alien territorial claims. The war is driven by genuine scarcity — rare elements and habitable worlds both empires need to sustain growth.

The "Treaty of Zavat" is an exhausted armistice dressed up as conquest. The Dominion withdraws from the frontier but keeps their homeworld and core systems. The Republic claims total victory because occupying Zavat would have been economically impossible. The Dominion survives, weakened but intact, nursing a grudge — setting the stage for future conflicts or uneasy alliances.

Briefings, voice lines, and propaganda blasts present the propaganda version as straight truth.

**Op Locust Wind — true context (player never sees):**

The Brood is not a natural disaster. Forward sensors recovered from the Hive carry data signatures inconsistent with known Brood biology — engineered, possibly by an as-yet-unidentified third party. Republic Intelligence sealed the analysis. The Brood will return; the truth of their origin is a future-War reveal.

---

## 9. Ship upgrades & loot system

> The meta-progression spending loop. War credits + dropped loot + Quartermaster shop all feed into outfitting the personal ships the player pilots. Soft-death roguelite spine — what death takes (the pilot) is small; what death leaves (the gear, the rank, the upgrades) is large.

### 9.1 Scope

- **Personal ships only.** War credits and loot upgrade ships the player personally pilots. Fleet ships (the wings and capitals under their command) are Republic-issued and not editable. Fleet quality grows passively with command tier.
- **Multi-class.** The player pilots a fleet of unlockable ship classes (see §3.2). Each class has its own loadout and its own item drops.

### 9.2 Equipment slots — per ship class

Each class has its own slot scheme. Modules are **class-typed** — a fighter cannon doesn't fit a frigate's ring-cannon array. Drops indicate which class they belong to.

| Class | Slots |
| --- | --- |
| Fighter | Cannon, Missile, Shield, Engine, Hull (5) |
| Bomber | Cannon, Missile Bay, Shield, Engine, Hull, PD Turret (6) |
| Frigate | Ring Cannon, Missile Bay, Shield, Engine, Hull, PD Array, Targeting (7) |
| Cruiser | Forward Cannon, Missile Bay, Shield, Engine, Hull, PD Array, Broadside, Targeting (8) |
| Battleship | Broadside Array, Missile Bay, Torpedo Tubes, Heavy Laser, Shield, Engine, Hull, PD Array, Targeting (9) |
| Carrier | Hangar, Missile Bay, Shield, Engine, Hull, PD Array, Targeting (7) |

These slot lists map directly onto the engine's existing per-class module system (`src/modules.js`).

### 9.3 Rarity tiers

Standard 5-tier ARPG palette.

| Tier | Color | Notes |
| --- | --- | --- |
| Common | gray | Base stats, no affixes |
| Uncommon | green | 1 stat affix |
| Rare | blue | 2 stat affixes |
| Epic | purple | 3 stat affixes |
| Legendary | orange | 4 stat affixes + **1 unique Legendary affix** (build-defining special effect) |

### 9.4 Affix system

- **Stat affixes** roll from a pool per slot (cannon affixes ≠ engine affixes). Examples for a cannon: +% damage, +% fire rate, +magazine size, +% accuracy, +% range, +% projectile speed.
- **Affix count scales by rarity** — Common = 0, Uncommon = 1, Rare = 2, Epic = 3, Legendary = 4 stat affixes.
- **Legendary uniques** are the hunt — special effects that enable specific builds. Example pool seeds: "Kills heal shield 2%", "Every 5th shot triple-bursts", "Range no longer falls off damage", "Missiles auto-fire on critical hit", "Shield regen doesn't pause when hit". Each Legendary item is named (e.g. *"Iron Hammer of Vorago"*) and tied to a specific unique effect.

### 9.5 Drop sources

Three concurrent sources. No mid-mission pickup loop — drops appear on the end-of-mission summary.

1. **Mission rewards.** Completing a chapter or side sortie awards a fixed-or-rolled drop. Predictable cadence; the loot bag IS the post-mission screen.
2. **Boss / ace drops.** Named enemies (Saurian aces, banner cruisers, the Hive-ship) drop unique items. Story-specific Legendaries hunted from specific bosses. "I need Khelovar to drop again."
3. **Republic Quartermaster shop.** Baseline shop where Common / Uncommon items are always available for credits. Rares and Epics rotate in. Lets unlucky players progress; gives credits a guaranteed sink. Tier-gated (only items for ship classes the player has unlocked).

**Brood drops — bio-tech tier:** Brood missions reward reverse-engineered bio-tech modules. Visually distinct from human gear (organic, pulsing, slightly horrible). Mechanically: high-risk/high-reward effects (e.g. "Bio-Plate: regenerates HP but ramping shield drain"; "Spore Pod: missiles spawn drone-clouds that explode after 3s"). Republic propaganda frames them as "spoils of science."

### 9.6 Inventory & stash

- **One equipped loadout per ship class.** When the player selects a class to pilot, they fly with whatever's currently equipped on that class.
- **Shared stash** (~50–100 modules, finite). Holds items across all ship classes.
- **Auto-salvage.** At end-of-mission, drops the player doesn't Keep or Stash auto-convert to credits. When the stash is full, oldest non-favorite items auto-salvage to make room. No manual scrap chore; no item-hoarding tax.
- **Favorite / lock flag** on stashed items prevents accidental auto-salvage.

No in-mission inventory mechanic — combat stays focused.

### 9.7 Quartermaster shop — structure

- **Static base stock.** Common and Uncommon items are permanent — always available at the same prices. Lets unlucky players reliably progress.
- **Rotating Rares and Epics.** Higher-rarity items rotate in on a refresh schedule (daily real-time OR per-chapter completion — pick one at implementation, leaning per-chapter to avoid clock-watching pressure).
- **Tier-gated.** Only items for ship classes the player has unlocked appear in the shop. No teasing what you can't yet pilot.
- **Drop-source relationship.** Most shop items are also droppable from missions; a small subset of Rare/Epic items are shop-exclusive (give the credit-grind path a unique reward).
- **Pricing curve.** Pricing tied to drop-rarity — Common cheap, Legendary not sold (Legendaries are drop-only or chest-only).

### 9.8 Loot box / premium chest structure

Three chest tiers, single-item rolls per chest:

| Chest | Price | Rarity weighting | Notes |
| --- | --- | --- | --- |
| Basic | Cheap | Common 50% / Uncommon 35% / Rare 12% / Epic 2.5% / Legendary 0.5% | Entry SKU; soft revenue floor |
| Premium | Mid | Uncommon 50% / Rare 30% / Epic 15% / Legendary 5% | Mid-spend SKU |
| Elite | Expensive | Rare 40% / Epic 40% / Legendary 18% / Mythic 2% (if introduced later) | Whale SKU; best Legendary odds |

(Odds are placeholder; pin at balance pass.)

**Pity timer:** every 10 chests of any tier rolls at least one Rare-or-better.

**Class-targeting:** chest rolls respect tier-gating (player can't roll a Cruiser cannon before unlocking Cruiser piloting); the system shifts the roll to a class they have access to.

**Required guardrails** (legal/regulatory; reiterated from §3.6a):
- Disclosed odds on every chest in-product.
- Regional sales blocks where loot boxes are restricted.
- The mission-drop + Quartermaster-shop path is clearly viable without chest purchases.
- Age-appropriate rating.

### 9.9 What the loot system replaces

### 9.8 IAP — loot boxes & cosmetics

In addition to commission-buying (§3.6):

- **Premium chests.** Real-money rolls at boosted rarity. Required guardrails:
  - Published odds.
  - Regional sales blocks where loot boxes are restricted (Belgium, Netherlands, others as they expand).
  - Pity timer: guaranteed Rare-or-better after N chests.
  - Non-paid alternative (mission drops + shop) clearly viable.
  - Age-appropriate rating compliance.
- **Cosmetic skins.** Paint, banner placement, hull decals, contrail colors. Zero gameplay impact. Revenue floor.

### 9.9 What the loot system replaces

The Diablo-style loot loop **absorbs and obsoletes** the following legacy systems:

- **PERKS** (run-init starter buffs) → Legendary uniques fill the same "build-defining buff" role.
- **TRAITS** (in-run promotion picks) → Tier rewards from command-tier track.
- **BOONS** (mid-run stackable buffs) → No longer applicable (no procedural events; authored missions instead).
- **COMMANDER_PERKS** (capital/wing-commander level-ups) → Fleet ships are not editable; passive growth with command tier instead.
- **SERVICE_UPGRADES** (meta-progression unlocks) → Loot system + command-tier track.
- **EVENT_CARDS** (procedural mid-run choices) → Authored mission writing.

Achievements survive as a parallel milestone system.

### Open questions — loot system

- [ ] Module families per slot — name pool, base stat curves (Pulse / Burst / Marksman / Scatter / Auto cannons, etc. for the Cannon slot, and equivalents for every other slot across every ship class).
- [ ] Affix pool — what specific affixes can roll on each slot type.
- [ ] Legendary unique pool — the special effects that define each Legendary item.
- [ ] Quartermaster refresh cadence and pricing.
- [ ] Loot box content / odds tables and pity-timer numbers.
- [ ] Cosmetic-skin catalog and pricing.
- [ ] Stash size and salvage credit values.
- [ ] How Brood bio-tech visually distinguishes from human gear (UI iconography + ship-mounted visual).
