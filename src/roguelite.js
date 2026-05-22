/**
 * @file Roguelite "Frontier" campaign — run-state, procgen, encounter
 * resolution. Replaces the legacy linear-mission campaign.
 *
 * One run is a series of acts (3 in v1); each act is a procgen node
 * graph the player traverses. Capital ships persist between battles
 * with carried-over hull damage; small craft (fighters / bombers) are
 * consumables that auto-replenish at a drip rate. Two currencies:
 *   credits — frequent, spent on repairs / recruits.
 *   fuel    — scarce, consumed when jumping between nodes.
 *
 * Public surface (consumed by main.js and input.js):
 *   loadRun()                         → live run, or null
 *   loadMeta()                        → cross-run meta
 *   startNewRun(faction, seed?)       → fresh run, persisted; returns it
 *   abandonRun()                      → clear current run; returns nothing
 *   nodeAt(run, nodeId)               → graph node lookup
 *   currentNode(run)                  → node at run.nodePos
 *   reachableEdges(run)               → array of { fromId, toId, fuelCost }
 *   canEnter(run, nodeId)             → boolean
 *   buildModeConfig(run, node, mode)  → object passed to startGame
 *   captureBattleOutcome(run, game)   → walk game.ships after a battle, write
 *                                       hpFrac back into run.capitals, count
 *                                       small craft, tick inter-node drip
 *   completeNode(run, nodeId)         → mark visited, advance run.nodePos,
 *                                       hand out payouts, transition acts
 *   buyRepair(run, instanceId)        → spend credits, set hpFrac = 1
 *   buyRecruit(run, klass)            → spend credits, +1 small craft
 *   buyRefuel(run, units)             → spend credits, +N fuel
 *   applyBoonChoice(run, boonKey)     → push boon, mutate run
 *   isRunOver(run)                    → boolean (no capitals alive)
 *   recordRunEnd(won, faction)        → meta mutations + emit runEnded
 *
 * Battle flow is owned by main.js: it calls captureBattleOutcome on
 * matchEnded, then completeNode to advance. The mode dispatch lives in
 * src/modes/roguelite.js — it reads game.modeConfig (set inside
 * startGame) and configures spectator/admiral state.
 */

import { saveStore } from "./save.js";
import { events } from "./events.js";
import { RACES, RACE_KEYS } from "./races.js";

// ---------------------------------------------------------------------------
// Tunable constants. Lifted to module scope so a balance pass is
// one-stop. If something here gets nudged, re-run the verification
// flow in /root/.claude/plans/i-want-to-plan-cosmic-taco.md.
// ---------------------------------------------------------------------------
// 5 acts mirrors the 5 ranks of the Terran officer career — Pilot
// Officer → Lieutenant → Lt Commander → Captain → Admiral. Each
// boss-clear promotes the player and bolts new capitals onto the
// fleet via PROMOTION_FLEET[act].
export const ACTS_PER_RUN = 5;
export const COLS_PER_ACT = 6;   // 0=entry, 5=boss; 1..4 are picks
export const ROWS_PER_ACT = 4;

// Repair drip per node travelled. Capital hull% creeps back toward 1.0
// even without visiting a resupply.
const REPAIR_RATE = 0.06;

// Small-craft drip — fractional credits accumulate; floored at spawn time.
// 0.5 = +1 fighter every 2 nodes; 0.25 = +1 bomber every 4 nodes.
const FIGHTER_DRIP = 0.5;
const BOMBER_DRIP = 0.25;

// Hard caps so a late-run snowball doesn't melt the renderer.
const MAX_FIGHTERS = 60;
const MAX_BOMBERS = 20;

// Fuel — each edge costs 1. Starter is 8, refuel at resupply nodes,
// boss kills refund 4. Most events award 0-1 fuel.
export const STARTER_FUEL = 8;
export const FUEL_PER_EDGE = 1;
const FUEL_PER_BOSS = 4;
const FUEL_PER_REFUEL_CREDIT = 10; // 10 credits = 1 fuel

// Repair cost per missing-HP-fraction. A battleship at 30% HP costs
// 70 of cost-per-class to fix.
const REPAIR_COST = {
  frigate: 30,
  cruiser: 60,
  battleship: 100,
  carrier: 120,
};

// Small-craft recruit costs (credits).
const RECRUIT_COST = { fighter: 8, bomber: 20 };

// Career starter fleet — what a Pilot Officer ships out with on day
// one. Just the player's fighter and three AI wingmen. No capitals.
// The fleet grows act-by-act via PROMOTION_FLEET below.
const STARTER_FLEET = {
  fighter: 4,
  bomber: 0,
  capitals: [],
};

// Promotion bonuses appended to the fleet on each act-break (boss
// clear). Indexed by the act being entered, so PROMOTION_FLEET[2]
// applies when Act 1's boss is cleared and the player promotes to
// Lieutenant. Act 1 has no entry — it's the starter.
const PROMOTION_FLEET = {
  2: { fighter: 4, bomber: 1, capitals: [{ klass: "frigate" }] },
  3: { fighter: 4, bomber: 2, capitals: [{ klass: "frigate" }, { klass: "cruiser" }] },
  4: { fighter: 6, bomber: 2, capitals: [{ klass: "carrier" }, { klass: "battleship" }] },
  5: { fighter: 8, bomber: 3, capitals: [{ klass: "battleship" }, { klass: "carrier" }] },
};

// Officer rank progression. Drives the promotion-screen blurb and the
// HUD "rank pill" on the run map. Each act = one rank.
export const ACT_RANKS = {
  1: {
    rank: "Pilot Officer",
    title: "Just Got My Wings",
    intro: "You took your wings yesterday. The Frontier Service needs warm bodies in cockpits and you're the warmest one available.",
    promotionBlurb: null, // no promo into act 1 — it's the starting rank
  },
  2: {
    rank: "Lieutenant",
    title: "Flight Leader",
    intro: "They gave you a flight to lead and a frigate to ride with. Try not to get her killed.",
    promotionBlurb: "Frontier Command logs your first solo command kill. You're promoted to Lieutenant — a frigate, the *Sparrowhawk*, is attached to your flight.",
  },
  3: {
    rank: "Lt. Commander",
    title: "Strike Group Foxtrot",
    intro: "Strike Group Foxtrot is yours. Two frigates and a cruiser. Try to come back with all three.",
    promotionBlurb: "You're promoted to Lieutenant Commander. Strike Group Foxtrot — a second frigate and the cruiser *Andolin* — falls under your command.",
  },
  4: {
    rank: "Captain",
    title: "Task Force Vanguard",
    intro: "A carrier. A battleship. The war just got a lot heavier — and you've just learned who's really running it.",
    promotionBlurb: "Captain's bars. The carrier *Halcyon* and the battleship *Iron Resolve* are placed under your command. Intelligence briefs you on a new threat: the Voidsworn have been seeding this war from the shadows.",
  },
  5: {
    rank: "Admiral",
    title: "Fleet Command",
    intro: "Fleet Command. One last jump, one last enemy. Make the brass proud — or make them mourn.",
    promotionBlurb: "Fleet Admiral. The second battleship *Last Argument* and the carrier *Sky-of-Iron* are added to the line. The Voidsworn War-Queen waits at the end of this act. Bring her down.",
  },
};

// Per-act named boss. faction is the *boss* faction (not the trash-mob
// faction — those still roll random per node). roster is hand-tuned
// at a 1x multiplier; the scaling factor in scaleRoster is bypassed
// for boss nodes so these numbers are what the player actually faces.
export const BOSSES = {
  1: {
    name: "Crimson Talon",
    faction: "reavers",
    description: "A Reaver ace flying a stolen corvette. Made his name burning lone-pilot patrols.",
    roster: { fighter: 14, bomber: 3, frigate: 1 },
  },
  2: {
    name: "ITN Severance",
    faction: "hegemony",
    description: "A Hegemony cruiser captain with a flag for surgical strikes on border colonies.",
    roster: { fighter: 10, bomber: 2, frigate: 2, cruiser: 1 },
  },
  3: {
    name: "Black Auriga",
    faction: "reavers",
    description: "A captured Terran cruiser, retrofitted by a Reaver warlord. Your name is on her hull.",
    roster: { fighter: 18, bomber: 4, frigate: 2, cruiser: 1 },
  },
  4: {
    name: "ITN Eclipse",
    faction: "voidsworn",
    description: "A Voidsworn dreadnought. First contact with the true enemy — cold, silent, methodical.",
    roster: { fighter: 12, bomber: 4, frigate: 2, cruiser: 2, battleship: 1, carrier: 1 },
  },
  5: {
    name: "Apheliotrope",
    faction: "voidsworn",
    description: "The Voidsworn War-Queen aboard their flagship. Beyond her: nothing.",
    roster: { fighter: 14, bomber: 5, frigate: 3, cruiser: 2, battleship: 2, carrier: 1 },
  },
};

// Per-act base trash-mob roster. Trash nodes (non-boss, non-elite)
// roll their *faction* at random (excluding terran) but pull their
// shape from this table — i.e. Act 1 fights are always small-craft
// affairs regardless of who's flying them, because that's what a
// freshly-winged Pilot Officer realistically faces.
const ACT_TRASH_BASE = {
  1: { fighter: 5, bomber: 1 },
  2: { fighter: 7, bomber: 2, frigate: 1 },
  3: { fighter: 9, bomber: 2, frigate: 1, cruiser: 1 },
  4: { fighter: 11, bomber: 3, frigate: 2, cruiser: 1 },
  5: { fighter: 12, bomber: 4, frigate: 2, cruiser: 2, battleship: 1 },
};

// Per-act elite roster — punchier than trash, smaller than boss.
const ACT_ELITE_BASE = {
  1: { fighter: 4, bomber: 2, frigate: 1 },
  2: { fighter: 4, bomber: 2, frigate: 1, cruiser: 1 },
  3: { fighter: 6, bomber: 2, frigate: 2, cruiser: 1 },
  4: { fighter: 6, bomber: 3, frigate: 1, cruiser: 1, battleship: 1 },
  5: { fighter: 8, bomber: 3, frigate: 2, cruiser: 2, battleship: 1 },
};

// Event card catalogue. Each card has 2-3 buttons. Each button's `apply`
// receives the live run and mutates it directly; the controller persists
// after every node clear.
//
// `actTags` (optional) filters which acts a card can roll on. Absent
// means "any act". Used to seed rank-appropriate flavor — rookie
// hazing cards in Act 1, war-hero cameos in Act 5, etc.
export const EVENT_CARDS = [
  {
    id: "derelict-freighter",
    title: "Derelict Freighter",
    body: "A drifting hulk hangs in the dark. Salvage rights are unclear.",
    options: [
      {
        label: "Salvage plating (+20% hull on a random capital)",
        apply: (run) => {
          if (run.capitals.length === 0) return "Fleet empty.";
          const idx = Math.floor(run.rng() * run.capitals.length);
          const cap = run.capitals[idx];
          cap.hpFrac = Math.min(1, cap.hpFrac + 0.20);
          return `Plating welded onto ${cap.klass}.`;
        },
      },
      {
        label: "Strip for parts (+40 credits)",
        apply: (run) => { run.resources.credits += 40; return "+40 credits."; },
      },
      { label: "Leave it alone", apply: () => "Course corrected." },
    ],
  },
  {
    id: "defector-squadron",
    title: "Defector Squadron",
    body: "Two enemy fighters break formation, signaling surrender.",
    options: [
      {
        label: "Accept defectors (+3 fighters)",
        apply: (run) => {
          run.smallCraft.fighter = Math.min(MAX_FIGHTERS, run.smallCraft.fighter + 3);
          return "+3 fighters.";
        },
      },
      {
        label: "Order pursuit (+1 fuel)",
        apply: (run) => { run.resources.fuel += 1; return "+1 fuel."; },
      },
    ],
  },
  {
    id: "distress-beacon",
    title: "Distress Beacon",
    body: "A civilian transmitter loops a panicked plea on open channel.",
    options: [
      {
        label: "Investigate (+1 bomber, -1 fuel)",
        apply: (run) => {
          if (run.resources.fuel < 1) return "Insufficient fuel.";
          run.resources.fuel -= 1;
          run.smallCraft.bomber = Math.min(MAX_BOMBERS, run.smallCraft.bomber + 1);
          return "Civilians extracted; one bomber pilot signed on.";
        },
      },
      {
        label: "Ignore (-1 morale doesn't exist; +0 net)",
        apply: () => "Channel muted.",
      },
    ],
  },
  {
    id: "salvage-yard",
    title: "Salvage Yard",
    body: "Skiffs pick over a battlefield. Trade with them?",
    options: [
      {
        label: "Buy fuel (-20 credits, +2 fuel)",
        apply: (run) => {
          if (run.resources.credits < 20) return "Insufficient credits.";
          run.resources.credits -= 20;
          run.resources.fuel += 2;
          return "+2 fuel.";
        },
      },
      {
        label: "Sell salvage (+25 credits)",
        apply: (run) => { run.resources.credits += 25; return "+25 credits."; },
      },
      { label: "Decline", apply: () => "Bypassed." },
    ],
  },
  {
    id: "veteran-engineer",
    title: "Veteran Engineer",
    body: "A free-lance engineer offers to retrofit a single capital.",
    options: [
      {
        label: "Reinforce all capitals (+12% hull each)",
        apply: (run) => {
          for (const c of run.capitals) c.hpFrac = Math.min(1, c.hpFrac + 0.12);
          return "Hull reinforced across the fleet.";
        },
      },
      {
        label: "Take a boon (+1 reinforced-prows boon)",
        apply: (run) => {
          run.boons.push({ key: "reinforced-prows", desc: "Capitals: small hull bonus" });
          return "Boon added.";
        },
      },
    ],
  },
  {
    id: "pirate-ambush",
    title: "Pirate Ambush",
    body: "Three light corvettes spring from an asteroid shadow. Lose ships fighting them off — or pay them off.",
    options: [
      {
        label: "Fight (-1 random fighter, +30 credits)",
        apply: (run) => {
          if (run.smallCraft.fighter > 0) run.smallCraft.fighter -= 1;
          run.resources.credits += 30;
          return "Pirates broken; tribute claimed.";
        },
      },
      {
        label: "Pay them off (-30 credits)",
        apply: (run) => {
          if (run.resources.credits < 30) return "Insufficient credits.";
          run.resources.credits -= 30;
          return "Course resumed unopposed.";
        },
      },
    ],
  },

  // ---- Act 1: rookie-pilot flavor ----------------------------------------
  {
    id: "rookie-hazing",
    title: "Hazing",
    body: "Your wingmen want to know if you can stick a hard burn through an unmarked debris field. The veterans are watching.",
    actTags: [1],
    options: [
      {
        label: "Push the throttle (+1 fighter joins your flight)",
        apply: (run) => {
          run.smallCraft.fighter = Math.min(MAX_FIGHTERS, run.smallCraft.fighter + 1);
          return "You scraped through. They give you a callsign.";
        },
      },
      {
        label: "Refuse the dare (+10 credits, no respect)",
        apply: (run) => { run.resources.credits += 10; return "They'll remember."; },
      },
    ],
  },
  {
    id: "first-kill",
    title: "First Confirmed Kill",
    body: "Your gun-cam just confirmed it — that Reaver fighter you splashed last node was a known ace. The flight wants to celebrate.",
    actTags: [1],
    options: [
      {
        label: "Share the bottle (+1 fuel — drinks loosen jump nerves)",
        apply: (run) => { run.resources.fuel += 1; return "You toast the kill."; },
      },
      {
        label: "Sober up — the war's not over (+15 credits, journal entry)",
        apply: (run) => { run.resources.credits += 15; return "You stay sharp."; },
      },
    ],
  },
  {
    id: "wingman-down",
    title: "Wingman Down",
    body: "Your wingmate punched out over hostile space and is broadcasting on a dying transponder. The window to recover them is short.",
    actTags: [1],
    options: [
      {
        label: "Divert to recover (-1 fuel — earns a debt for later)",
        apply: (run) => {
          if (run.resources.fuel < 1) return "No fuel to divert. Note them KIA.";
          run.resources.fuel -= 1;
          // Stamp the callsign of the rescued pilot — Act 5 cameo
          // reads this flag and brings them back as a relief wing.
          const names = ["TIGER", "FOX", "RAVEN", "HOUND", "SABRE"];
          const cs = names[Math.floor(run.rng() * names.length)];
          run.flags.wingmanRescued = cs;
          return `${cs} owes you their life. They'll remember.`;
        },
      },
      {
        label: "Hire a privateer to recover (-30 credits)",
        apply: (run) => {
          if (run.resources.credits < 30) return "Insufficient credits — no contractor will move.";
          run.resources.credits -= 30;
          const names = ["TIGER", "FOX", "RAVEN", "HOUND", "SABRE"];
          const cs = names[Math.floor(run.rng() * names.length)];
          run.flags.wingmanRescued = cs;
          return `${cs} owes you their life. They'll remember.`;
        },
      },
      {
        label: "Note them KIA — keep the schedule",
        apply: () => "You jump on time. Their family will be told.",
      },
    ],
  },
  {
    id: "pilots-lounge",
    title: "Pilot's Lounge",
    body: "Off-duty, you overhear a senior pilot telling a war story you're not cleared to hear. The intel could be useful — or get you written up.",
    actTags: [1],
    options: [
      {
        label: "Listen carefully (flag: veteran intel for Act 3+)",
        apply: (run) => {
          run.flags.veteranIntel = true;
          return "You file every detail away.";
        },
      },
      {
        label: "Stand a round of drinks (+15 credits in tips)",
        apply: (run) => { run.resources.credits += 15; return "You make friends. They make change."; },
      },
      {
        label: "Slip out quietly",
        apply: () => "No one notices you leave. Smart.",
      },
    ],
  },
  {
    id: "drill-officer",
    title: "Drill Officer's Evaluation",
    body: "Wing Commander Sato pulls you aside. 'Your scores are good. Take the harder course — or skate.'",
    actTags: [1],
    options: [
      {
        label: "Take the harder course (+1 trait choice next promotion)",
        apply: (run) => {
          // Consumed by rollTraitDraw at the next applyPromotion.
          run.flags.bonusTraitNext = true;
          return "Sato nods. \"Don't disappoint me.\"";
        },
      },
      {
        label: "Coast through (+30 credits hazard pay)",
        apply: (run) => { run.resources.credits += 30; return "Easy money. Easy reputation."; },
      },
    ],
  },

  // ---- Act 2: frigate-captain / border-defense flavor --------------------
  {
    id: "convoy-distress",
    title: "Convoy in Distress",
    body: "A Terran civilian convoy is taking fire two jumps off your route. Your frigate captain leaves the call to you.",
    actTags: [2, 3],
    options: [
      {
        label: "Divert and protect (-1 fuel, +30 credits gratitude)",
        apply: (run) => {
          if (run.resources.fuel < 1) return "No fuel to divert.";
          run.resources.fuel -= 1;
          run.resources.credits += 30;
          return "Civilians saved. Word travels.";
        },
      },
      {
        label: "Stay the course (mission first)",
        apply: () => "You hear the chatter cut off mid-jump.",
      },
    ],
  },
  {
    id: "defector-captain",
    title: "Defector Captain",
    body: "A Hegemony frigate captain wants to come over the line. He'll bring his ship — and his crew.",
    actTags: [2, 3],
    options: [
      {
        label: "Accept defection (boon: +12% hull on a random capital, +2 fighters)",
        apply: (run) => {
          if (run.capitals.length === 0) {
            run.smallCraft.fighter = Math.min(MAX_FIGHTERS, run.smallCraft.fighter + 2);
            return "Crew folded into your wings. No capital to bolt his hull to.";
          }
          const idx = Math.floor(run.rng() * run.capitals.length);
          run.capitals[idx].hpFrac = Math.min(1, run.capitals[idx].hpFrac + 0.12);
          run.smallCraft.fighter = Math.min(MAX_FIGHTERS, run.smallCraft.fighter + 2);
          return "Frigate parts welded onto the line. Pilots added.";
        },
      },
      {
        label: "Report him to Hegemony fleet (+40 credits intel bounty)",
        apply: (run) => { run.resources.credits += 40; return "He doesn't make the jump."; },
      },
    ],
  },
  {
    id: "voss-briefing",
    title: "Captain Voss's Briefing",
    body: "Captain Mara Voss of the *Sparrowhawk* calls you aboard. 'You'll be flying screen for me this op. I run a tight ship — don't be late.'",
    actTags: [2],
    options: [
      {
        label: "Accept the role gladly",
        apply: (run) => {
          // Act 5 cameo card reads this flag — Voss returns with extra
          // frigates if the player served under her cleanly.
          run.flags.voss = "served-under";
          return "Voss runs a tight ship. You'll fly screen for her.";
        },
      },
      {
        label: "Push back — 'I'm a fighter pilot, not a guard dog'",
        apply: (run) => {
          run.flags.voss = "antagonized";
          return "Voss's eyes narrow. \"We'll see how that attitude survives.\"";
        },
      },
      {
        label: "Defer the decision (no flag set)",
        apply: () => "You sleep on it. Voss notices.",
      },
    ],
  },
  {
    id: "junior-defector",
    title: "Hegemony Junior Defector",
    body: "A Hegemony pilot, barely older than you, surrenders mid-engagement. He's young, scared, and wants out of the war.",
    actTags: [2],
    options: [
      {
        label: "Recruit him (+1 fighter, intel for Act 3)",
        apply: (run) => {
          run.smallCraft.fighter = Math.min(MAX_FIGHTERS, run.smallCraft.fighter + 1);
          run.flags.hegDefector = true;
          return "He joins your wing. Quiet kid. Fast hands.";
        },
      },
      {
        label: "Send him to interrogation (+25 credits intel bounty)",
        apply: (run) => { run.resources.credits += 25; return "Fleet command takes him from there."; },
      },
      {
        label: "Let him eject and drift",
        apply: () => "He gives a small salute as he tumbles away.",
      },
    ],
  },
  {
    id: "captured-pirate",
    title: "Captured Reaver Ace",
    body: "You disabled a Reaver corvette. Its captain — a brutal pirate ace called Cinder — is now your prisoner. The next call is on your record.",
    actTags: [2, 3],
    options: [
      {
        label: "Interrogate by the book (+1 fuel intel route)",
        apply: (run) => {
          run.resources.fuel += 1;
          run.flags.geneva = true;
          return "She gives up a smuggler's lane in exchange for a deal.";
        },
      },
      {
        label: "Hand to military police (+25 credits bounty)",
        apply: (run) => { run.resources.credits += 25; return "They cuff her and walk her off."; },
      },
      {
        label: "Execute on the spot (+40 credits, marks your record)",
        apply: (run) => {
          run.resources.credits += 40;
          run.flags.warCriminalStart = true;
          return "She doesn't make it to trial. Someone took video.";
        },
      },
    ],
  },

  // ---- Act 3: warlord hunt / hard-choices flavor -------------------------
  {
    id: "black-auriga-sighting",
    title: "Black Auriga Sighted",
    body: "Scouts confirm the Black Auriga at the next anchor. Your intel officer can leak a feint to draw her shields down — but it'll cost a wingman to sell.",
    actTags: [3],
    options: [
      {
        label: "Order the feint (boss -20% HP, -1 fighter)",
        apply: (run) => {
          if (run.smallCraft.fighter < 1) return "No fighter to spare. Order rescinded.";
          run.smallCraft.fighter -= 1;
          run.flags.bossWeakened = true;
          return "The feint lands. Your wingman doesn't.";
        },
      },
      {
        label: "Refuse — fight her hot",
        apply: () => "No tricks. Just guns.",
      },
    ],
  },
  {
    id: "defector-carrier",
    title: "Carrier Defects",
    body: "A wounded Hegemony carrier sends an encrypted defection signal. They'll fly under your colors for one battle — if you cover the hull-patch bill.",
    actTags: [3],
    options: [
      {
        label: "Accept (-30 credits, coalition carrier flag set)",
        apply: (run) => {
          if (run.resources.credits < 30) return "Insufficient credits — no deal.";
          run.resources.credits -= 30;
          run.flags.coalitionCarrier = true;
          return "Carrier alongside. They'll fight when called.";
        },
      },
      {
        label: "Decline — fleet stays Terran",
        apply: () => "You watch them limp into the dark.",
      },
    ],
  },
  {
    id: "memorial-service",
    title: "Memorial Service",
    body: "Frontier Command holds a memorial for crew lost since you took command. You're expected on the dais.",
    actTags: [3],
    options: [
      {
        label: "Speak stoic and brief (+25 credits in goodwill)",
        apply: (run) => { run.resources.credits += 25; return "The brass approve. The fleet salutes."; },
      },
      {
        label: "Show grief — let your fleet see the cost",
        apply: (run) => { run.flags.griefShown = true; return "Your pilots remember you broke the line."; },
      },
      {
        label: "Skip the service — you have work to do",
        apply: (run) => { run.flags.skippedMemorial = true; return "The dais waits without you."; },
      },
    ],
  },
  {
    id: "wounded-warlord",
    title: "Wounded Capital",
    body: "A crippled Reaver cruiser drifts before you, its bridge gutted. The warlord's lieutenant signals surrender.",
    actTags: [3, 4],
    options: [
      {
        label: "Execute the kill (+50 credits, sets a tone)",
        apply: (run) => {
          run.resources.credits += 50;
          run.flags = run.flags || {};
          run.flags.executedWoundedCapital = true;
          return "No survivors. The line moves on.";
        },
      },
      {
        label: "Take prisoners (+1 fuel, intel feeds Act 5 allies)",
        apply: (run) => {
          run.resources.fuel += 1;
          run.flags = run.flags || {};
          run.flags.sparedWoundedCapital = true;
          return "Prisoners aboard. Their intel will surface later.";
        },
      },
    ],
  },
  {
    id: "intel-drop",
    title: "Encrypted Intel Drop",
    body: "An anonymous cipher hits your comm — coordinates, fleet movements, a name you weren't supposed to know.",
    actTags: [3, 4],
    options: [
      {
        label: "Act on it (+30 credits, +1 fuel — well-routed jumps)",
        apply: (run) => {
          run.resources.credits += 30;
          run.resources.fuel += 1;
          return "Intel pays off twice over.";
        },
      },
      {
        label: "Forward it to fleet command (+40 credits)",
        apply: (run) => { run.resources.credits += 40; return "Command thanks you in dispatches."; },
      },
    ],
  },

  // ---- Act 4: fleet-command / Voidsworn-reveal flavor --------------------
  {
    id: "voidsworn-manifesto",
    title: "The Voidsworn Manifesto",
    body: "An intercepted Voidsworn broadcast frames the Frontier Wars as a trap your government walked you into. Your intel officer thinks it's propaganda. Your gut is less sure.",
    actTags: [4],
    options: [
      {
        label: "Disregard it — focus on the fight",
        apply: () => "You file it under Voidsworn psy-ops.",
      },
      {
        label: "Study it carefully (intel for Act 5)",
        apply: (run) => {
          run.flags.knowsVoidsworn = true;
          return "You map the Voidsworn supply chain. Act 5 will know what to hit.";
        },
      },
    ],
  },
  {
    // Coalition rallying card — only fires if the player served under
    // Voss in Act 2. Calls back to the early choice with a hard
    // reinforcement reward, making the Voss flag a long-term payoff.
    id: "hegemony-coalition",
    title: "Hegemony Coalition",
    body: "Word from the Hegemony admiralty: Captain Voss vouches for you. A coalition task force is offering one-time fire support for the Eclipse engagement.",
    actTags: [4],
    precondition: (run) => run.flags && run.flags.voss === "served-under",
    options: [
      {
        label: "Accept the alliance (+1 frigate, +1 cruiser)",
        apply: (run) => {
          // Pre-Act-5 capitals are folded into the persistent fleet so
          // the next battle's roster includes them.
          run.capitals.push({ klass: "frigate", hpFrac: 1.0, instanceId: run.nextInstanceId++ });
          run.capitals.push({ klass: "cruiser", hpFrac: 1.0, instanceId: run.nextInstanceId++ });
          run.flags.coalitionFleet = true;
          return "Voss's word held weight. Coalition holds.";
        },
      },
      {
        label: "Decline — the Frontier Service stands alone",
        apply: () => "The Hegemony respects the refusal. Quietly.",
      },
    ],
  },
  {
    id: "coalition-flagship",
    title: "Coalition Signal",
    body: "A Hegemony task force, formerly your enemy, wants to fold under your command for the next jump.",
    actTags: [4, 5],
    options: [
      {
        label: "Accept the alliance (boon: reinforced-prows for the fleet)",
        apply: (run) => {
          for (const c of run.capitals) c.hpFrac = Math.min(1, c.hpFrac + 0.10);
          run.boons.push({ key: "reinforced-prows", desc: "Capitals: small hull bonus" });
          return "Coalition holds. Hulls reinforced.";
        },
      },
      {
        label: "Refuse — Terran fleet only (+60 credits paid for the slight)",
        apply: (run) => { run.resources.credits += 60; return "Hegemony withdraws. Insult paid."; },
      },
    ],
  },
  {
    id: "saboteur-aboard",
    title: "Saboteur Aboard",
    body: "Your carrier's chief reports an unaccounted Voidsworn-tagged cipher running through the comms. Internal hunt or shrug it off?",
    actTags: [4, 5],
    options: [
      {
        label: "Hunt them down (-20 credits sweep cost, no risk)",
        apply: (run) => {
          if (run.resources.credits < 20) return "Insufficient credits — sweep aborted.";
          run.resources.credits -= 20;
          return "Saboteur caught and spaced.";
        },
      },
      {
        label: "Trust your crew (random capital takes -15% hull)",
        apply: (run) => {
          if (run.capitals.length === 0) return "No capitals at risk.";
          const idx = Math.floor(run.rng() * run.capitals.length);
          run.capitals[idx].hpFrac = Math.max(0.05, run.capitals[idx].hpFrac - 0.15);
          return `A charge detonated on the ${run.capitals[idx].klass}.`;
        },
      },
    ],
  },

  // ---- Act 5: war-finale flavor ------------------------------------------
  {
    // Voss-cameo — Voss returns to fly the final engagement with you
    // if you served under her in Act 2. The reward is two frigates
    // attached to the run's persistent fleet.
    id: "voss-cameo",
    title: "Voss Returns",
    body: "A signal lights from the Sparrowhawk: \"Heard you needed an old friend on your wing. Mara out.\"",
    actTags: [5],
    precondition: (run) => run.flags && run.flags.voss === "served-under",
    options: [
      {
        label: "Welcome her in (+2 frigates)",
        apply: (run) => {
          run.capitals.push({ klass: "frigate", hpFrac: 1.0, instanceId: run.nextInstanceId++ });
          run.capitals.push({ klass: "frigate", hpFrac: 1.0, instanceId: run.nextInstanceId++ });
          return "The Sparrowhawk slots into formation. The line tightens.";
        },
      },
      {
        label: "Tell her to sit this one out",
        apply: () => "Voss respects the call. She watches from the dark.",
      },
    ],
  },
  {
    // Wounded-warlord callback — fires only if the Act 3 wounded-
    // warlord choice flagged executed/spared. Different consequence
    // depending on which flag was set; the player has no choice here,
    // they're reaping what they sowed.
    id: "wounded-warlord-returns",
    title: "The Warlord's Reckoning",
    body: "Black Auriga's lieutenant has resurfaced — and they remember what you did to their captain.",
    actTags: [5],
    precondition: (run) => run.flags && (run.flags.executedWoundedCapital || run.flags.sparedWoundedCapital),
    options: [
      {
        label: "Face it",
        apply: (run) => {
          if (run.flags.executedWoundedCapital) {
            if (run.capitals.length === 0) return "No fleet to retaliate against — fleet already broken.";
            const idx = Math.floor(run.rng() * run.capitals.length);
            run.capitals[idx].hpFrac = Math.max(0.05, run.capitals[idx].hpFrac - 0.25);
            return `Charges detonate on the ${run.capitals[idx].klass}. They got the last laugh.`;
          } else {
            run.capitals.push({ klass: "cruiser", hpFrac: 1.0, instanceId: run.nextInstanceId++ });
            run.smallCraft.fighter = Math.min(MAX_FIGHTERS, run.smallCraft.fighter + 3);
            return "Auriga's lieutenant pledges to you. Old debts, paid.";
          }
        },
      },
    ],
  },
  {
    // The last letter — narrative beat before the final boss. Pure
    // flavor, no mechanical effect. Sometimes the right call is to
    // give the player a quiet moment.
    id: "the-last-letter",
    title: "The Last Letter",
    body: "Frontier Command opens a private channel: write home before the final engagement. Most officers do.",
    actTags: [5],
    options: [
      {
        label: "Write to family",
        apply: () => "You compose a careful letter. The signal goes out.",
      },
      {
        label: "Write to a fallen wingmate's family",
        apply: () => "You write the harder letter. It will mean something to someone.",
      },
      {
        label: "Skip it — there's still work",
        apply: () => "You close the channel. The fleet still flies.",
      },
    ],
  },
  {
    id: "rally-the-fleet",
    title: "Rally the Fleet",
    body: "The entire Frontier Service waits on your speech. The next jump is the last one.",
    actTags: [5],
    options: [
      {
        label: "Speak from the heart (boon: +20% player ship HP for the run)",
        apply: (run) => {
          run.boons.push({ key: "fortified-bridge", desc: "Player ship: +20% HP" });
          return "Pilots cheer. Your fighter is reinforced.";
        },
      },
      {
        label: "Read the prepared lines (+50 credits, +2 fuel)",
        apply: (run) => {
          run.resources.credits += 50;
          run.resources.fuel += 2;
          return "Functional. Resources allocated.";
        },
      },
    ],
  },
];

// Boon refits available at resupply nodes. Costs 1 fuel each.
export const BOON_TABLE = [
  { key: "reinforced-prows",   desc: "Capitals: small hull bonus" },
  { key: "tracer-rounds",      desc: "Small craft fire faster" },
  { key: "extended-magazines", desc: "Fighter cannon: +25% mag" },
  { key: "long-range-pods",    desc: "Bomber pods: +15% range" },
  { key: "fortified-bridge",   desc: "Player ship: +20% HP" },
];

// Officer traits — per-run choice earned at each promotion. The
// promotion overlay rolls a 3-trait draw from this pool (minus
// already-owned traits) and the player picks one. Traits stack: by
// Act 5 a successful career holds 4 (one per promotion).
//
// All Tier-1 traits patch the player fighter spec via
// `playerOverride(baseSpec)` returning a partial that game.js's
// `_traitKeys` resolver deep-merges onto playerSpecOverride. Future
// tiers add fleet-flag and credit-multiplier traits.
export const TRAITS = {
  "steady-hand": {
    name: "Steady Hand",
    desc: "+10% player projectile damage",
    playerOverride: (base) => ({
      weapon: { damage: (base.weapon && base.weapon.damage || 9) * 1.10 },
    }),
  },
  "trauma-surgeon": {
    name: "Trauma Surgeon",
    desc: "+25% player shield regen",
    playerOverride: (base) => ({
      shield: { regen: (base.shield && base.shield.regen || 9) * 1.25 },
    }),
  },
  "reckless": {
    name: "Reckless",
    desc: "+15% turn rate, -10% shield max",
    playerOverride: (base) => ({
      turnRate: (base.turnRate || 3.2) * 1.15,
      shield: { max: Math.round((base.shield && base.shield.max || 30) * 0.90) },
    }),
  },
  "defensive-driver": {
    name: "Defensive Driver",
    desc: "+20% shield max, -5% damage",
    playerOverride: (base) => ({
      shield: { max: Math.round((base.shield && base.shield.max || 30) * 1.20) },
      weapon: { damage: (base.weapon && base.weapon.damage || 9) * 0.95 },
    }),
  },
  "eagle-eyes": {
    name: "Eagle Eyes",
    desc: "+20% weapon range, tighter spread",
    playerOverride: (base) => ({
      weapon: {
        range:  (base.weapon && base.weapon.range  || 560) * 1.20,
        spread: (base.weapon && base.weapon.spread || 0.05) * 0.85,
      },
    }),
  },
  "iron-hull": {
    name: "Iron Hull",
    desc: "+15% player hull HP",
    playerOverride: (base) => ({
      hp: Math.round((base.hp || 35) * 1.15),
    }),
  },
};

// Trait draw size for promotion overlay. 3 by default; trait-related
// perks (a future tier) may bump this so high-skill players see more
// options per pick.
const TRAIT_DRAW_SIZE = 3;

// Captain perks unlocked between runs. activePerkKey can hold one at a time.
//
// Hook patterns each perk can carry:
//   applyToFleet(fleet)      — patch starter-fleet counts.
//   playerOverride(base)     — patch the player ship spec.
//   creditMultiplier         — number scaling credit gains.
//   creditsBonus             — flat credit grant at run start.
//   traitDrawBonus           — +N trait choices at every promotion.
//   startAct                 — start the career partway up the rank ladder.
//   unlockCondition(meta)    — gate for whether the perk shows on the
//                              BEGIN CAREER chip row.
export const PERKS = {
  "aggressive-engineer": {
    name: "Aggressive Engineer",
    desc: "+2 starter fighters",
    unlockCondition: (meta) => meta.runsCompleted >= 1,
    applyToFleet: (fleet) => { fleet.fighter += 2; },
  },
  "logistics": {
    name: "Logistics",
    desc: "+20% credits from all sources",
    unlockCondition: (meta) => meta.runsCompleted >= 3,
    creditMultiplier: 1.2,
  },
  "ace-pilot": {
    name: "Ace Pilot",
    desc: "Player ship: +15% turn rate",
    unlockCondition: (meta) => meta.runsWon >= 1,
    playerOverride: (base) => ({ turnRate: base.turnRate * 1.15 }),
  },
  // Resource bonus — straightforward starter-credits grant.
  "wealthy-family": {
    name: "Wealthy Family",
    desc: "Start with +100 credits",
    unlockCondition: (meta) => meta.runsCompleted >= 2,
    creditsBonus: 100,
  },
  // Trait-system bonus — every promotion's trait draw gets one extra
  // option, so a 4-act career sees +4 choices total instead of just
  // bumping a single promotion (drill-officer event card does that).
  "decorated-pilot": {
    name: "Decorated Pilot",
    desc: "+1 trait choice at every promotion",
    unlockCondition: (meta) => meta.runsCompleted >= 5,
    traitDrawBonus: 1,
  },
  // Structural bonus — skip the Pilot Officer act, start as a Lieutenant
  // with Act 2's promotion fleet already attached. Saves ~10 minutes
  // of opening grind for veteran players.
  "war-college-top": {
    name: "War College, Top of Class",
    desc: "Start at Lieutenant (Act 2) with a frigate command",
    unlockCondition: (meta) => meta.runsWon >= 2,
    startAct: 2,
  },
};

// Mulberry32 PRNG. 12 lines, no dependencies. Reproducible from a seed
// so reloading a mid-run save regenerates the same act graph.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Save accessors.
// ---------------------------------------------------------------------------

export function loadRun() {
  const block = saveStore.get().roguelite;
  if (!block || !block.current) return null;
  const run = block.current;
  // Re-attach a PRNG bound to the persisted seed so callers can use
  // run.rng() without re-seeding. The PRNG state is intentionally NOT
  // persisted — node graphs are; per-event rolls aren't recoverable
  // and shouldn't be.
  run.rng = mulberry32(run.seed);
  return run;
}

export function loadMeta() {
  return saveStore.get().roguelite.meta;
}

function saveRun(run) {
  saveStore.update((d) => {
    // Strip the non-serialisable rng before write.
    const { rng: _omit, ...persistable } = run;
    d.roguelite.current = persistable;
  });
  saveStore.flush();
}

function clearRun() {
  saveStore.update((d) => { d.roguelite.current = null; });
  saveStore.flush();
}

// ---------------------------------------------------------------------------
// Run lifecycle.
// ---------------------------------------------------------------------------

// Default callsign pool — picked when the player doesn't supply one.
// Pulled from a stock list of "feels military" handles. Players who
// care can override via startNewRun({ callsign: "..." }).
const DEFAULT_CALLSIGNS = [
  "ECHO", "SABRE", "VECTOR", "TALON", "AXIOM",
  "ORION", "HALO", "RAVEN", "SPECTRE", "VANGUARD",
];

export function startNewRun(faction, seed = null, opts = {}) {
  const s = seed != null ? (seed >>> 0) : (Math.floor(Math.random() * 0xffffffff) >>> 0);
  const meta = loadMeta();
  const rng = mulberry32(s);

  // BEGIN CAREER screen picks the starter perk via `opts.perkKey` (or
  // `null` for no perk). Persist it onto meta so buildModeConfig +
  // promotePlayer pull from the same source. Validate against PERKS
  // so a stale key from an old save can't poison the apply chain.
  if (opts && opts.perkKey !== undefined) {
    const validKey = (opts.perkKey && PERKS[opts.perkKey]) ? opts.perkKey : null;
    meta.activePerkKey = validKey;
    saveStore.update((d) => { d.roguelite.meta.activePerkKey = validKey; });
  }

  // Starter fleet — fixed by design (option locked in: fresh per run).
  // Active perk may patch counts (e.g. aggressive-engineer +2 fighters).
  const fleet = { fighter: STARTER_FLEET.fighter, bomber: STARTER_FLEET.bomber };
  const perk = meta.activePerkKey ? PERKS[meta.activePerkKey] : null;
  if (perk && perk.applyToFleet) perk.applyToFleet(fleet);
  // Wealthy Family + similar — flat credits at run start.
  const startingCredits = (perk && perk.creditsBonus) ? perk.creditsBonus : 0;

  let nextInstanceId = 1;
  const capitals = STARTER_FLEET.capitals.map((c) => ({
    klass: c.klass,
    hpFrac: 1.0,
    instanceId: nextInstanceId++,
  }));

  const callsign = (opts && opts.callsign)
    ? String(opts.callsign).toUpperCase().slice(0, 12)
    : DEFAULT_CALLSIGNS[Math.floor(rng() * DEFAULT_CALLSIGNS.length)];

  const run = {
    seed: s,
    faction,
    callsign,
    act: 1,
    nodePos: 0,
    visitedNodeIds: [],
    graphs: [],
    capitals,
    nextInstanceId,
    smallCraft: { fighter: fleet.fighter, bomber: fleet.bomber },
    replenishBuffer: { fighter: 0, bomber: 0 },
    resources: { credits: startingCredits, fuel: STARTER_FUEL },
    boons: [],
    // Per-run trait picks earned at each promotion. Acts 1→2, 2→3,
    // 3→4, 4→5 each grant one; max 4 across a successful career.
    // Trait effects (player-spec patches, fleet flags, credit
    // multipliers) come from the TRAITS table — see buildModeConfig.
    traits: [],
    battleMode: "fly",
    pendingNode: null,
    pendingPromotion: null,
    endReason: null,
    flags: {},
    startedAtMs: Date.now(),
    rng,
  };

  // Generate Act 1 immediately so the run-map overlay has something
  // to draw on first open.
  run.graphs.push(generateAct(run, 1));
  run.nodePos = run.graphs[0].startNode;

  // War College, Top of Class — perk lets veteran players skip the
  // Pilot Officer opening. Apply Act 2's promotion fleet
  // synchronously and advance the run to Act 2's graph. The Act 1
  // graph is left in place for the memorial / history view but the
  // player never walks it. Trait pick is intentionally NOT triggered
  // here (no choice yet) — first promotion is normally Act 2→3.
  if (perk && perk.startAct && perk.startAct > 1) {
    const targetAct = Math.min(perk.startAct, ACTS_PER_RUN);
    for (let a = 2; a <= targetAct; a++) {
      const fleet = PROMOTION_FLEET[a];
      if (fleet) {
        for (const c of fleet.capitals || []) {
          run.capitals.push({ klass: c.klass, hpFrac: 1.0, instanceId: run.nextInstanceId++ });
        }
        run.smallCraft.fighter = Math.min(MAX_FIGHTERS, run.smallCraft.fighter + (fleet.fighter || 0));
        run.smallCraft.bomber  = Math.min(MAX_BOMBERS,  run.smallCraft.bomber  + (fleet.bomber  || 0));
      }
      // Generate the act graph and step the run pointer onto its
      // start node.
      run.act = a;
      const g = generateAct(run, a);
      run.graphs.push(g);
      run.nodePos = g.startNode;
      run.visitedNodeIds = [g.startNode];
    }
  }

  saveRun(run);
  events.emit("runStarted", { faction, seed: s });
  return run;
}

export function abandonRun() {
  const run = loadRun();
  if (run) {
    events.emit("runEnded", { run, won: false, reason: "abandoned" });
  }
  clearRun();
}

// ---------------------------------------------------------------------------
// Procgen — node graph per act.
// ---------------------------------------------------------------------------

function generateAct(run, actIndex) {
  // Re-seed per act so regenerating any single act is deterministic
  // and act-2 doesn't drift if the player reloads mid-act-1.
  const rng = mulberry32((run.seed + actIndex * 7919) >>> 0);

  const nodes = [];
  const edges = [];

  // Per-act boss is hand-curated — name, faction, and roster come
  // from the BOSSES table so the narrative arc is consistent.
  const bossEntry = BOSSES[actIndex] || BOSSES[1];
  const bossFaction = bossEntry.faction;
  // Trash-mob faction roll excludes Terran (the player) and the
  // *boss faction* most of the time, so the boss feels distinct
  // when you finally meet them. 30% of trash nodes still pull
  // from the boss faction to seed familiarity.
  const trashCandidates = RACE_KEYS.filter((k) => k !== run.faction);
  const pickTrashFaction = () => {
    const off = trashCandidates.filter((k) => k !== bossFaction);
    if (off.length === 0) return bossFaction;
    return rng() < 0.30
      ? bossFaction
      : off[Math.floor(rng() * off.length)];
  };

  // Trash + elite rosters come from per-act tables, scaled by
  // column position so deeper-into-the-act nodes feel beefier.
  const trashBase  = ACT_TRASH_BASE[actIndex]  || ACT_TRASH_BASE[1];
  const eliteBase  = ACT_ELITE_BASE[actIndex]  || ACT_ELITE_BASE[1];

  // Column 0: single entry node — always a light battle.
  const startId = nodes.length;
  nodes.push({
    id: startId, col: 0, row: Math.floor(ROWS_PER_ACT / 2),
    type: "battle",
    faction: pickTrashFaction(),
    roster: scaleRoster(trashBase, diffFor(actIndex, 0)),
  });

  // Columns 1..COLS_PER_ACT-2: candidate slots, picked by type table.
  // Track Resupply-per-row so no path can dodge all combat.
  const resupplyInRow = new Array(ROWS_PER_ACT).fill(0);

  for (let col = 1; col < COLS_PER_ACT - 1; col++) {
    for (let row = 0; row < ROWS_PER_ACT; row++) {
      // ~75% slot occupancy in mid columns so the map breathes.
      if (rng() > 0.75 && col !== 1 && col !== COLS_PER_ACT - 2) continue;
      const type = pickNodeType(col, rng, resupplyInRow[row]);
      if (type === "resupply") resupplyInRow[row]++;
      const node = {
        id: nodes.length, col, row, type,
      };
      if (type === "battle" || type === "elite") {
        node.faction = pickTrashFaction();
        const base = type === "elite" ? eliteBase : trashBase;
        node.roster = scaleRoster(base, diffFor(actIndex, col));
      } else if (type === "event") {
        // Filter the event pool to cards tagged for this act (or
        // untagged — those are universal). Cards may also declare a
        // `precondition(run)` callback — flag-gated callbacks like
        // "Voss returns" only roll when run.flags satisfies them.
        // Fall back to the full untagged pool if nothing rolls.
        const pool = EVENT_CARDS.filter(
          (c) => (!c.actTags || c.actTags.includes(actIndex))
              && (!c.precondition || c.precondition(run)),
        );
        const chosen = pool.length > 0
          ? pool[Math.floor(rng() * pool.length)]
          : EVENT_CARDS[Math.floor(rng() * EVENT_CARDS.length)];
        node.eventId = chosen.id;
      }
      nodes.push(node);
    }
  }

  // Final column: single named boss node. All reachable col-
  // (COLS_PER_ACT-2) nodes converge on it via the edge pass below.
  // Boss rosters are hand-tuned at 1x — NOT scaled by diffFor — so
  // the per-act numbers in BOSSES are exactly what the player faces.
  const bossId = nodes.length;
  nodes.push({
    id: bossId, col: COLS_PER_ACT - 1, row: Math.floor(ROWS_PER_ACT / 2),
    type: "boss",
    faction: bossFaction,
    bossName: bossEntry.name,
    bossDescription: bossEntry.description,
    roster: { ...bossEntry.roster },
  });

  // Edge construction: for each node, pick 1-2 destinations in the
  // next column with same-row bias. Boss column converges all incoming.
  for (const n of nodes) {
    if (n.col >= COLS_PER_ACT - 1) continue;
    const targetCol = n.col + 1;
    const candidatesNextCol = nodes.filter((m) => m.col === targetCol);
    if (candidatesNextCol.length === 0) continue;
    if (targetCol === COLS_PER_ACT - 1) {
      // Convergence column — everyone funnels to the boss.
      edges.push({ fromId: n.id, toId: bossId, fuelCost: FUEL_PER_EDGE });
      continue;
    }
    // Pick a primary (closest row) and optionally a secondary.
    const sorted = [...candidatesNextCol].sort(
      (a, b) => Math.abs(a.row - n.row) - Math.abs(b.row - n.row),
    );
    const primary = sorted[0];
    edges.push({ fromId: n.id, toId: primary.id, fuelCost: FUEL_PER_EDGE });
    // Branching: 50% chance of a second outgoing edge to a near-row.
    if (sorted.length > 1 && rng() < 0.5) {
      const secondary = sorted[1];
      // Skip if it crosses an existing edge from a different row sharing
      // this column. Quick heuristic — picks the simpler shape.
      if (!edgeCrosses(edges, n, secondary, nodes)) {
        edges.push({ fromId: n.id, toId: secondary.id, fuelCost: FUEL_PER_EDGE });
      }
    }
  }

  return { actIndex, nodes, edges, startNode: startId, bossNode: bossId, bossFaction };
}

function edgeCrosses(existing, fromNode, toNode, allNodes) {
  // Two edges cross if their (fromRow, toRow) pairs interleave between
  // the same two columns. Light StS-style heuristic.
  for (const e of existing) {
    const a = allNodes.find((n) => n.id === e.fromId);
    const b = allNodes.find((n) => n.id === e.toId);
    if (!a || !b) continue;
    if (a.col !== fromNode.col || b.col !== toNode.col) continue;
    if (a.id === fromNode.id) continue;
    const aRows = [a.row, b.row].sort((x, y) => x - y);
    const fRows = [fromNode.row, toNode.row].sort((x, y) => x - y);
    if (aRows[0] < fRows[0] && aRows[1] > fRows[0] && aRows[1] < fRows[1]) return true;
    if (fRows[0] < aRows[0] && fRows[1] > aRows[0] && fRows[1] < aRows[1]) return true;
  }
  return false;
}

function pickNodeType(col, rng, resupplyCountInRow) {
  const r = rng();
  // Per-column distribution table (mirrors the plan):
  //   1-2:   70 Battle / 15 Event / 15 Resupply
  //   3:     50 Battle / 20 Elite / 20 Event / 10 Resupply
  //   4:     30 Battle / 30 Elite / 15 Event / 25 Resupply
  let table;
  if (col <= 2) {
    table = [["battle", 0.70], ["event", 0.85], ["resupply", 1.00]];
  } else if (col === 3) {
    table = [["battle", 0.50], ["elite", 0.70], ["event", 0.90], ["resupply", 1.00]];
  } else {
    table = [["battle", 0.30], ["elite", 0.60], ["event", 0.75], ["resupply", 1.00]];
  }
  for (const [kind, threshold] of table) {
    if (r <= threshold) {
      // ≤1 Resupply per row across all columns — prevents pure-resupply paths.
      if (kind === "resupply" && resupplyCountInRow >= 1) return "battle";
      return kind;
    }
  }
  return "battle";
}

function diffFor(actIndex, col) {
  return 1 + (actIndex - 1) * 0.5 + col * 0.08;
}

function scaleRoster(base, mul) {
  const out = {};
  for (const k of Object.keys(base)) {
    if (base[k] <= 0) continue;
    out[k] = Math.max(1, Math.round(base[k] * mul));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Graph queries.
// ---------------------------------------------------------------------------

export function currentGraph(run) {
  return run.graphs[run.act - 1] || null;
}

export function nodeAt(run, nodeId) {
  const g = currentGraph(run);
  if (!g) return null;
  return g.nodes.find((n) => n.id === nodeId) || null;
}

export function currentNode(run) {
  return nodeAt(run, run.nodePos);
}

export function reachableEdges(run) {
  const g = currentGraph(run);
  if (!g) return [];
  return g.edges.filter((e) => e.fromId === run.nodePos);
}

export function canEnter(run, nodeId) {
  if (run.nodePos === nodeId) return false;
  const reachable = reachableEdges(run);
  for (const e of reachable) {
    if (e.toId === nodeId) {
      return run.resources.fuel >= e.fuelCost;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Building the per-battle config that startGame consumes.
// ---------------------------------------------------------------------------

export function buildModeConfig(run, node, battleMode) {
  // Build per-side rosters by counting capitals + small craft.
  const blueRoster = countCapitals(run.capitals);
  blueRoster.fighter = run.smallCraft.fighter;
  blueRoster.bomber = run.smallCraft.bomber;
  // Strip zero entries so spawnRoster's loop doesn't fire on them.
  for (const k of Object.keys(blueRoster)) {
    if (blueRoster[k] <= 0) delete blueRoster[k];
  }

  // Ordered manifest for per-instance wounded spawns.
  const capitalsManifest = run.capitals.map((c) => ({
    klass: c.klass,
    hpFrac: c.hpFrac,
    instanceId: c.instanceId,
  }));

  // Player ship override from active perk (boons only patch capitals /
  // currencies — perks are the player-ship lever).
  const meta = loadMeta();
  const perk = meta.activePerkKey ? PERKS[meta.activePerkKey] : null;
  let playerSpecOverride = null;
  if (perk && perk.playerOverride) {
    // perk.playerOverride is a function that takes the base spec — but
    // we don't have it here. Stash the perk key and resolve in
    // promotePlayer if needed. For v1, encode the patch directly by
    // calling with a sentinel object. Simpler: just pass the perk key
    // through; spawnRoster won't read it.
    playerSpecOverride = { _perkKey: meta.activePerkKey };
  }

  // The "fortified-bridge" boon stacks on the player ship.
  const hasBridge = run.boons.some((b) => b.key === "fortified-bridge");
  if (hasBridge) {
    playerSpecOverride = playerSpecOverride || {};
    playerSpecOverride._fortifiedBridge = true;
  }

  // Officer traits earned at promotions — stamp the key list onto
  // playerSpecOverride. startGame walks `_traitKeys` and applies each
  // TRAITS[k].playerOverride patch against the resolved fighter spec.
  if (run.traits && run.traits.length > 0) {
    playerSpecOverride = playerSpecOverride || {};
    playerSpecOverride._traitKeys = [...run.traits];
  }

  return {
    blue: blueRoster,
    red: node.roster,
    hostileRace: node.faction,
    battleMode,
    capitalsManifest,
    playerSpecOverride,
    // Bookkeeping for capturer.
    run,
    node,
  };
}

function countCapitals(capitals) {
  const out = {};
  for (const c of capitals) {
    out[c.klass] = (out[c.klass] || 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Post-battle: walk live ships, write HP back into run.capitals.
// ---------------------------------------------------------------------------

export function captureBattleOutcome(run, game) {
  // Build a quick lookup of alive blue capitals by instanceId.
  const aliveById = new Map();
  for (const s of game.ships) {
    if (s.dead || s.side !== "blue" || !s.runtimeInstanceId) continue;
    aliveById.set(s.runtimeInstanceId, s);
  }

  // Drop destroyed capitals; update hpFrac on survivors.
  const survivors = [];
  for (const cap of run.capitals) {
    const live = aliveById.get(cap.instanceId);
    if (!live) continue; // destroyed — drop from run
    cap.hpFrac = Math.max(0, Math.min(1, live.hp / live.hpMax));
    survivors.push(cap);
  }
  run.capitals = survivors;

  // Count surviving small craft. Player ship is a fighter; don't count
  // it as a fleet asset — it respawns each battle.
  let liveFighters = 0, liveBombers = 0;
  for (const s of game.ships) {
    if (s.dead || s.side !== "blue" || s.isPlayer) continue;
    if (s.klass === "fighter" && !s.escortOf) liveFighters++;
    else if (s.klass === "bomber") liveBombers++;
  }
  // Escort fighters (s.escortOf set) are tied to a capital — when the
  // capital dies, the escort is gone with it. Their accounting is implicit
  // in capital survival; count only "loose" fighters.
  run.smallCraft.fighter = liveFighters;
  run.smallCraft.bomber = liveBombers;
}

// ---------------------------------------------------------------------------
// Node-clear flow: tick drips, pay out, advance position, transition acts.
// ---------------------------------------------------------------------------

export function completeNode(run, nodeId) {
  const node = nodeAt(run, nodeId);
  if (!node) return;

  run.visitedNodeIds.push(nodeId);
  // The fuel cost was paid at jump time (see enterNode below). The drip
  // and payout happen on clear.
  tickInterNode(run);
  payoutFor(node, run);

  run.nodePos = nodeId;
  run.pendingNode = null;

  // Boss clear → act transition (or run completion on final act).
  if (node.type === "boss") {
    if (run.act >= ACTS_PER_RUN) {
      // Run complete — record meta, clear the run, fire the event.
      // The match-over panel ("Tap to return to fleet") handles the
      // UI dismissal; refresh() will then see no active run and the
      // menu reverts to "NEW RUN".
      run.endReason = "war-won";
      recordRunEnd(run, true);
      clearRun();
      return;
    }
    // Promote: append PROMOTION_FLEET to the carried-over fleet, then
    // spin up the next act graph and stash a pending-promotion record
    // so the UI can show the rank-up celebration before opening the
    // next starmap.
    const newAct = run.act + 1;
    const promotion = applyPromotion(run, newAct);
    run.act = newAct;
    const nextGraph = generateAct(run, run.act);
    run.graphs.push(nextGraph);
    run.nodePos = nextGraph.startNode;
    run.visitedNodeIds = [nextGraph.startNode];
    run.pendingPromotion = promotion;
  }

  saveRun(run);
  events.emit("nodeCleared", { node, run });
}

// Append the new act's PROMOTION_FLEET to the run's persistent fleet
// and return a snapshot describing what was added (used by the
// promotion screen). Also rolls a trait draw — 3 random unowned
// traits the player picks from before dismissing the overlay — and
// generates a 3-line war-news bulletin for the inter-act story beat.
function applyPromotion(run, newAct) {
  const fleet = PROMOTION_FLEET[newAct];
  const rankInfo = ACT_RANKS[newAct] || {};
  const traitDraw = rollTraitDraw(run);
  const bulletin = generateBulletin(run, newAct);
  if (!fleet) {
    return {
      newAct,
      rank: rankInfo.rank || "",
      title: rankInfo.title || "",
      blurb: rankInfo.promotionBlurb || "",
      added: { fighter: 0, bomber: 0, capitals: [] },
      traitDraw,
      selectedTraitKey: null,
      bulletin,
    };
  }
  const addedCapitals = [];
  for (const c of fleet.capitals || []) {
    const cap = { klass: c.klass, hpFrac: 1.0, instanceId: run.nextInstanceId++ };
    run.capitals.push(cap);
    addedCapitals.push({ klass: c.klass });
  }
  const addF = fleet.fighter || 0;
  const addB = fleet.bomber || 0;
  run.smallCraft.fighter = Math.min(MAX_FIGHTERS, run.smallCraft.fighter + addF);
  run.smallCraft.bomber  = Math.min(MAX_BOMBERS,  run.smallCraft.bomber  + addB);
  return {
    newAct,
    rank: rankInfo.rank || "",
    title: rankInfo.title || "",
    blurb: rankInfo.promotionBlurb || "",
    added: { fighter: addF, bomber: addB, capitals: addedCapitals },
    // Trait draw: the player picks one chip in the overlay; the
    // selected key is stamped here, and clearPendingPromotion adds it
    // to run.traits.
    traitDraw,
    selectedTraitKey: null,
    bulletin,
  };
}

// One-line epitaph stamped on a memorial entry. Calls back to the
// player's choices via run.flags + endReason so completed careers
// read distinctly on the title-screen wall. Win epitaphs honor the
// rank; loss epitaphs lean into the reason ("KIA on the Apheliotrope
// approach", "Court-martialed after Black Auriga", etc.).
function writeEpitaph(run, won) {
  const callsign = run.callsign || "OFFICER";
  if (won) {
    if (run.flags && run.flags.warCriminalStart) {
      return `Won the war. Tribunal pending — ${callsign}'s record is sealed.`;
    }
    if (run.flags && run.flags.wingmanRescued) {
      return `Ended the war with ${run.flags.wingmanRescued} on her wing.`;
    }
    if (run.flags && run.flags.voss === "served-under") {
      return `Voss's protégé. Hung the Apheliotrope's banner from the Sparrowhawk's mast.`;
    }
    return `Closed the Frontier Wars. The Apheliotrope fell.`;
  }
  // Loss epitaphs keyed on endReason.
  switch (run.endReason) {
    case "kia":
      return `KIA, Act ${run.act}. Failed to return from the jump.`;
    case "fleet-lost":
      return `Lost the fleet in Act ${run.act}. Court-martial deferred.`;
    case "stranded":
      return `Stranded between jumps. Search-and-rescue found nothing.`;
    case "defeat":
      return `Cashiered after Act ${run.act}. The Service does not forgive.`;
    default:
      return `Career closed, Act ${run.act}. Reason undocumented.`;
  }
}

// 3-line war-status news bulletin shown at the top of the promotion
// overlay. Mixes a generic per-act headline, a personalised line
// using the player's callsign + new rank, and a flag-conditional
// flourish that calls back to choices the player has made (Voss
// briefing, wingman rescue, wounded warlord, etc.). Each line is
// stamped onto the promotion record at boss-clear time so the
// overlay can render without re-reading run state.
function generateBulletin(run, newAct) {
  const callsign = run.callsign || "OFFICER";
  const newRank = (ACT_RANKS[newAct] || {}).rank || "Officer";
  const prevBoss = BOSSES[newAct - 1];
  const lines = [];
  // Line 1: per-act war headline. Different for each rank-up.
  const HEAD = {
    2: `Frontier wire: Reaver raids down 18% along the Outer Reach after the ${prevBoss ? prevBoss.name : "first"} sortie.`,
    3: "Frontier wire: Hegemony forces probing the Mid-Reach. Two convoys lost this cycle.",
    4: "Frontier wire: Voidsworn ships sighted spinward. Threat assessment escalated to Tier 1.",
    5: "Frontier wire: War council convened. Total Mobilization Order signed at dawn.",
  };
  lines.push(HEAD[newAct] || "Frontier wire: hostilities continue along the border.");
  // Line 2: personalised citation by rank.
  const CITATION = {
    2: `Service bulletin: ${newRank} ${callsign} cited for valor in single-pilot engagement.`,
    3: `Service bulletin: ${newRank} ${callsign} assigned to special operations.`,
    4: `Service bulletin: ${newRank} ${callsign} given task-force command. Fleet assembling at Outer Anchor.`,
    5: `Service bulletin: ${newRank} ${callsign} confirmed for the Apheliotrope engagement.`,
  };
  lines.push(CITATION[newAct] || `Service bulletin: ${newRank} ${callsign} continues frontier duty.`);
  // Line 3: flag-conditional. Reads the run's recorded choices and
  // calls them back so the news feels responsive. Falls back to a
  // generic line when no flags are set.
  const f = run.flags || {};
  if (newAct === 3 && f.voss === "served-under") {
    lines.push("Wire pickup: Capt. Voss aboard the Sparrowhawk confirms two kills along the same line, credits 'a quick learner from her old wing.'");
  } else if (newAct === 4 && f.executedWoundedCapital) {
    lines.push("Wire pickup: Black Auriga's hull recovered. Tribunal opens next cycle.");
  } else if (newAct === 4 && f.sparedWoundedCapital) {
    lines.push("Wire pickup: Black Auriga reportedly resurfaced spinward. Coalition watching.");
  } else if (newAct === 5 && f.wingmanRescued) {
    lines.push(`Wire pickup: ${f.wingmanRescued}'s wing reports to ${callsign} for final engagement. Repayment in kind.`);
  } else if (newAct === 5 && f.warCriminalStart) {
    lines.push("Wire pickup: Officer review board has flagged your file. War-crimes tribunal pending.");
  } else if (newAct === 5 && f.hegDefector) {
    lines.push("Wire pickup: Hegemony defector now flies under coalition colors. Light squadron attached.");
  } else if (newAct === 3 && f.geneva) {
    lines.push("Wire pickup: Reaver smuggler's lane mapped — Mid-Reach jumps shaved by one parsec.");
  } else if (newAct === 3 && f.veteranIntel) {
    lines.push("Wire pickup: Anonymous source provides tactical breakdown of Hegemony cruiser doctrine.");
  } else {
    lines.push("Wire pickup: Frontier Service maintains operational readiness.");
  }
  return lines;
}

// Roll N random trait keys from the TRAITS pool, excluding traits the
// player already owns. When the unowned pool is smaller than the draw
// size we return as many as exist.
//
// Two bonus sources stack:
//   - `flags.bonusTraitNext` (Act 1 drill-officer event card) — single-
//     use, consumed on the next promotion.
//   - Active perk's `traitDrawBonus` (e.g. Decorated Pilot +1) —
//     permanent for the career.
function rollTraitDraw(run) {
  const owned = new Set(run.traits || []);
  const available = Object.keys(TRAITS).filter((k) => !owned.has(k));
  let size = TRAIT_DRAW_SIZE;
  if (run.flags && run.flags.bonusTraitNext) {
    size += 1;
    run.flags.bonusTraitNext = false;
  }
  // Stack the active perk's permanent draw bonus.
  const meta = loadMeta();
  const perk = meta && meta.activePerkKey ? PERKS[meta.activePerkKey] : null;
  if (perk && perk.traitDrawBonus) size += perk.traitDrawBonus;
  // Fisher-Yates partial shuffle — only need first N.
  const picks = [];
  const pool = [...available];
  const n = Math.min(size, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(run.rng() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
    picks.push(pool[i]);
  }
  return picks;
}

// UI hook: player clicked a trait chip on the promotion overlay.
// Stores the selection on the pendingPromotion record; the actual
// run.traits append happens at dismissal so re-picks are allowed
// while the overlay is open.
export function selectPromotionTrait(run, traitKey) {
  if (!run || !run.pendingPromotion) return;
  if (!TRAITS[traitKey]) return;
  // Must be in the rolled draw — guards against tampered save / stale
  // chip click.
  if (!run.pendingPromotion.traitDraw.includes(traitKey)) return;
  run.pendingPromotion.selectedTraitKey = traitKey;
  saveRun(run);
}

// UI hook: dismissing the promotion modal calls this. If a trait was
// picked, append it to the run's permanent trait list. Acts with no
// available traits (e.g. when the pool runs dry) dismiss without
// requiring a pick.
export function clearPendingPromotion(run) {
  if (!run) return;
  const promo = run.pendingPromotion;
  if (promo && promo.selectedTraitKey && TRAITS[promo.selectedTraitKey]) {
    run.traits = run.traits || [];
    if (!run.traits.includes(promo.selectedTraitKey)) {
      run.traits.push(promo.selectedTraitKey);
    }
  }
  run.pendingPromotion = null;
  saveRun(run);
}

// Apply the cost of jumping to a node BEFORE entering it. Called by
// main.js when the player picks a battle / event / resupply destination.
export function enterNode(run, nodeId) {
  const edges = reachableEdges(run);
  const edge = edges.find((e) => e.toId === nodeId);
  if (!edge) return false;
  if (run.resources.fuel < edge.fuelCost) return false;
  run.resources.fuel -= edge.fuelCost;
  run.pendingNode = nodeId;
  saveRun(run);
  return true;
}

function tickInterNode(run) {
  for (const cap of run.capitals) {
    cap.hpFrac = Math.min(1, cap.hpFrac + REPAIR_RATE);
  }
  run.replenishBuffer.fighter += FIGHTER_DRIP;
  run.replenishBuffer.bomber += BOMBER_DRIP;
  const addFighters = Math.floor(run.replenishBuffer.fighter);
  const addBombers = Math.floor(run.replenishBuffer.bomber);
  run.smallCraft.fighter = Math.min(
    MAX_FIGHTERS, run.smallCraft.fighter + addFighters,
  );
  run.smallCraft.bomber = Math.min(
    MAX_BOMBERS, run.smallCraft.bomber + addBombers,
  );
  run.replenishBuffer.fighter -= addFighters;
  run.replenishBuffer.bomber -= addBombers;
}

function payoutFor(node, run) {
  const meta = loadMeta();
  const perk = meta.activePerkKey ? PERKS[meta.activePerkKey] : null;
  const creditsMul = perk && perk.creditMultiplier ? perk.creditMultiplier : 1;

  if (node.type === "battle") {
    run.resources.credits += Math.round(rosterValue(node.roster) * 0.6 * creditsMul);
  } else if (node.type === "elite") {
    run.resources.credits += Math.round(rosterValue(node.roster) * 1.2 * creditsMul);
    run.resources.fuel += 1;
  } else if (node.type === "boss") {
    run.resources.credits += Math.round(rosterValue(node.roster) * 1.5 * creditsMul);
    run.resources.fuel += FUEL_PER_BOSS;
  }
  // Resupply + event payouts are handled by their own UI flows
  // (buyRepair, applyEventChoice, etc).
}

const ROSTER_VALUE = {
  fighter: 4, bomber: 8, frigate: 18,
  cruiser: 35, battleship: 65, carrier: 60,
};

function rosterValue(roster) {
  let v = 0;
  for (const [klass, n] of Object.entries(roster)) {
    v += (ROSTER_VALUE[klass] || 1) * n;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Resupply transactions.
// ---------------------------------------------------------------------------

export function repairCostFor(cap) {
  const base = REPAIR_COST[cap.klass] || 30;
  return Math.ceil(base * (1 - cap.hpFrac));
}

export function buyRepair(run, instanceId) {
  const cap = run.capitals.find((c) => c.instanceId === instanceId);
  if (!cap) return false;
  const cost = repairCostFor(cap);
  if (run.resources.credits < cost) return false;
  run.resources.credits -= cost;
  cap.hpFrac = 1;
  saveRun(run);
  return true;
}

export function buyRecruit(run, klass) {
  const cost = RECRUIT_COST[klass];
  if (!cost) return false;
  if (run.resources.credits < cost) return false;
  if (klass === "fighter" && run.smallCraft.fighter >= MAX_FIGHTERS) return false;
  if (klass === "bomber" && run.smallCraft.bomber >= MAX_BOMBERS) return false;
  run.resources.credits -= cost;
  run.smallCraft[klass] += 1;
  saveRun(run);
  return true;
}

export function buyRefuel(run, units = 1) {
  const cost = units * FUEL_PER_REFUEL_CREDIT;
  if (run.resources.credits < cost) return false;
  run.resources.credits -= cost;
  run.resources.fuel += units;
  saveRun(run);
  return true;
}

export function applyBoon(run, boonKey) {
  const boon = BOON_TABLE.find((b) => b.key === boonKey);
  if (!boon) return false;
  if (run.resources.fuel < 1) return false;
  run.resources.fuel -= 1;
  run.boons.push({ ...boon });
  saveRun(run);
  return true;
}

// ---------------------------------------------------------------------------
// Event-card resolution.
// ---------------------------------------------------------------------------

export function eventCardById(eventId) {
  return EVENT_CARDS.find((c) => c.id === eventId) || null;
}

export function applyEventChoice(run, eventId, choiceIndex) {
  const card = eventCardById(eventId);
  if (!card) return null;
  const choice = card.options[choiceIndex];
  if (!choice) return null;
  const result = choice.apply(run);
  saveRun(run);
  return result || "";
}

// ---------------------------------------------------------------------------
// Run-over check + run-end recording.
// ---------------------------------------------------------------------------

export function isRunOver(run) {
  // Career-end rules:
  //  - All capitals destroyed (Acts 2+).
  //  - Player KIA (signalled by main.js setting run.endReason = "kia").
  //  - Battle lost (signalled by main.js setting run.endReason = "defeat").
  //  - Fuel-stranded: no fuel, no affordable refuel — career ends in
  //    the void between jumps. Stamps `endReason = "stranded"` so the
  //    summary panel pulls the matching flavor text.
  //  - Act 1 special case: no capitals exist, so a wiped fighter wing
  //    with the player ship gone is "stranded" — treat as KIA.
  if (run.endReason) return true;
  if (run.capitals.length === 0 && run.act >= 2) return true;
  if (isStranded(run)) {
    run.endReason = "stranded";
    return true;
  }
  return false;
}

// Stranded check: 0 fuel + every outgoing edge unaffordable + can't
// buy fuel at the current node. Boss/end-of-act nodes have no
// outgoing edges (handled by the early return so a 0-fuel boss-win
// state doesn't trip the check). Refuel at a resupply node needs
// at least one fuel unit's worth of credits.
function isStranded(run) {
  if (run.resources.fuel > 0) return false;
  const edges = reachableEdges(run);
  if (edges.length === 0) return false; // boss / end-of-act terminal
  if (edges.some((e) => run.resources.fuel >= e.fuelCost)) return false;
  // Last chance: refuel at a resupply node.
  const g = currentGraph(run);
  const node = g && g.nodes.find((n) => n.id === run.nodePos);
  const refuelCost = 30; // resupply UI's fuel package; mirrors the menu price
  if (node && node.type === "resupply" && run.resources.credits >= refuelCost) return false;
  return true;
}

// Death-flavor text for the run-summary screen. Keyed on the
// run.endReason set by main.js on the matchEnded edge. Falls back
// to a generic line if the reason is unknown.
export function endReasonFlavor(run) {
  const rank = (ACT_RANKS[run.act] || {}).rank || "Officer";
  const reason = run.endReason || "wiped";
  switch (reason) {
    case "kia":
      return `Killed in action. ${rank} ${run.callsign || ""} failed to return from the jump.`.trim();
    case "fleet-lost":
      return `${rank} ${run.callsign || ""} court-martialed. The fleet was lost with all hands.`.trim();
    case "defeat":
      return `${rank} ${run.callsign || ""} cashiered. The Frontier Service does not forgive defeat.`.trim();
    case "stranded":
      return `${rank} ${run.callsign || ""} stranded between jumps. Search-and-rescue found nothing.`.trim();
    case "war-won":
      return `The Frontier Wars ended on this jump. Admiral ${run.callsign || ""} retired in glory.`.trim();
    default:
      return "Career concluded.";
  }
}

// Called from main.js after a defeat. Records meta progress + emits
// runEnded; the controller then calls clearRun().
export function recordRunEnd(run, won, reason = null) {
  if (reason && !run.endReason) run.endReason = reason;
  saveStore.update((d) => {
    d.roguelite.meta.runsCompleted += 1;
    // Memorial entry — both wins AND losses are recorded so the
    // title-screen wall reads as a full career roll, not just an
    // honor roll. Cap at 10 entries; oldest shifts out on overflow.
    const memorial = d.roguelite.meta.memorial || [];
    memorial.unshift({
      callsign: run.callsign || "",
      rank: won
        ? (ACT_RANKS[ACTS_PER_RUN] || {}).rank || "Admiral"
        : (ACT_RANKS[run.act] || {}).rank || "Officer",
      result: won ? "won" : "lost",
      timestamp: Date.now(),
      epitaph: writeEpitaph(run, won),
    });
    d.roguelite.meta.memorial = memorial.slice(0, 10);
    if (won) {
      d.roguelite.meta.runsWon += 1;
      const g = run.graphs[run.act - 1];
      if (g && g.bossFaction) {
        d.roguelite.meta.warProgress[g.bossFaction] =
          (d.roguelite.meta.warProgress[g.bossFaction] || 0) + 1;
      }
    }
    // Unlock perks whose conditions are now met.
    const meta = d.roguelite.meta;
    for (const key of Object.keys(PERKS)) {
      if (meta.unlockedPerks.includes(key)) continue;
      if (PERKS[key].unlockCondition(meta)) meta.unlockedPerks.push(key);
    }
  });
  saveStore.flush();
  events.emit("runEnded", {
    run, won,
    reason: run.endReason || (won ? "completed" : "wiped"),
    flavor: endReasonFlavor(run),
  });
}

export function discardRun() {
  clearRun();
}

// ---------------------------------------------------------------------------
// Debug + dev helpers (visible on window.roguelite for console smoke tests).
// ---------------------------------------------------------------------------

export const ROGUELITE_DEBUG = {
  generateAct,
  mulberry32,
  rosterValue,
  REPAIR_RATE, FIGHTER_DRIP, BOMBER_DRIP,
  MAX_FIGHTERS, MAX_BOMBERS,
};

if (typeof window !== "undefined") {
  window.roguelite = { loadRun, loadMeta, startNewRun, abandonRun, ROGUELITE_DEBUG };
}
