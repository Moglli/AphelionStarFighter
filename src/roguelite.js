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
import { applyTierScalingToRoster, getPlayerTier } from "./shipyard.js";

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
export const COLS_PER_ACT = 6;   // 0=entry, 5=boss; 1..4 are the COMBAT spine.
                                 // Green nodes (event/resupply) are detours at
                                 // col+0.5 between spine columns — see generateAct.
export const ROWS_PER_ACT = 5;   // wider so each column has more slots (was 4)

// Repair drip per node travelled. Capital hull% creeps back toward 1.0
// even without visiting a resupply. Bumped to 0.10 so a wounded
// capital recovers ~10% per jump — Frontier is meant to be hard, not
// punishing in the no-comeback way.
const REPAIR_RATE = 0.10;

// Small-craft drip — fractional credits accumulate; floored at spawn time.
// 1.2 = ~+1 fighter per jump on average; 0.65 = ~+2 bombers every 3 jumps.
// Cranked up so the player's wing rebuilds visibly between engagements.
const FIGHTER_DRIP = 1.2;
const BOMBER_DRIP = 0.65;

// Hard caps so a late-run snowball doesn't melt the renderer.
const MAX_FIGHTERS = 60;
const MAX_BOMBERS = 20;

// Fuel — a depleting resource the player MUST manage. Each map edge
// costs 1 fuel; clearing combat nodes no longer refunds it (that made
// fuel grow over a run — elites +2 / boss +5 outpaced the -1/jump
// drain, so fuel never bit). Now fuel only comes back from:
//   - the act-transition REFIT (top-up to a baseline, see applyPromotion)
//   - resupply detour nodes (buy fuel with credits)
//   - a handful of event choices (+1/+2)
// So fuel trends DOWN within an act and detour-heavy routes can strand
// a careless pilot — the intended tension.
export const STARTER_FUEL = 10;
export const FUEL_PER_EDGE = 1;
// Act-transition refit: returning to friendly space for the promotion
// tops fuel up to this baseline (never reduces it). Keeps fuel a
// per-act resource without letting it snowball.
const ACT_REFIT_FUEL = 8;
const FUEL_PER_REFUEL_CREDIT = 8; // 8 credits = 1 fuel (was 10)

// Repair cost per missing-HP-fraction — softened so a wounded fleet
// can actually be patched mid-act on a typical credit budget.
const REPAIR_COST = {
  frigate: 20,
  cruiser: 40,
  battleship: 70,
  carrier: 80,
};

// Small-craft recruit costs (credits) — cheaper so the player can
// actually rebuild after a bad battle.
const RECRUIT_COST = { fighter: 20, bomber: 56 }; // 4× — small craft are scarce now

// ---------------------------------------------------------------------------
// Procedural capital ship names + captains. Every capital in the run's
// fleet gets a name (e.g. "ITN Iron Verdict") and a captain (rank + surname)
// at creation time. Surfaces in the fleet panel + dossier and is referenced
// by battle banter / aftermath logs.
// ---------------------------------------------------------------------------
const CAP_PREFIXES = ["ITN", "ITN", "ITN", "TCV", "CSV"]; // Coalition spread, ITN dominant
const CAP_NAME_PARTS_A = [
  "Iron", "Black", "Verity", "Silent", "Distant", "Long", "Sable", "Ardent",
  "Stalwart", "Lonely", "Resolute", "Indomitable", "Sundered", "Patient",
  "Bright", "Hollow", "Vagrant", "Mercy", "Last", "Witness",
];
const CAP_NAME_PARTS_B = [
  "Verdict", "Witness", "Banner", "Lyre", "Cinder", "Garrison", "Question",
  "Promise", "Burden", "Reply", "Echo", "Argument", "Hour", "Standard",
  "Letter", "Sentinel", "Mark", "Light", "Crossing", "Ledger",
];
const CAPTAIN_RANKS_BY_KLASS = {
  frigate:    ["Lt. Cmdr.", "Lt. Cmdr.", "Cmdr."],
  cruiser:    ["Cmdr.", "Cmdr.", "Capt."],
  battleship: ["Capt.", "Capt.", "Cmdr."],
  carrier:    ["Capt.", "Cmdr."],
};
const CAPTAIN_SURNAMES = [
  "Dane", "Vance", "Holst", "Iverra", "Marrok", "Soren", "Korr",
  "Beladi", "Astren", "Quill", "Vehl", "Dassen", "Olsten", "Caldera",
  "Reyne", "Mistral", "Halvorsen", "Tessen", "Yarrow", "Vasik",
  "Pelletier", "Aksel", "Brann", "Hoth", "Esquival",
];

// Generate "ITN Iron Verdict" or "TCV Sable Banner" style ship names.
function rollCapitalName(rng) {
  const prefix = CAP_PREFIXES[Math.floor(rng() * CAP_PREFIXES.length)];
  const a = CAP_NAME_PARTS_A[Math.floor(rng() * CAP_NAME_PARTS_A.length)];
  const b = CAP_NAME_PARTS_B[Math.floor(rng() * CAP_NAME_PARTS_B.length)];
  return `${prefix} ${a} ${b}`;
}

// Generate "Capt. Iverra" style names. Rank pool depends on the capital's
// class so a frigate doesn't end up commanded by a Captain.
function rollCapitalCaptain(rng, klass) {
  const ranks = CAPTAIN_RANKS_BY_KLASS[klass] || ["Cmdr."];
  const rank = ranks[Math.floor(rng() * ranks.length)];
  const surname = CAPTAIN_SURNAMES[Math.floor(rng() * CAPTAIN_SURNAMES.length)];
  return `${rank} ${surname}`;
}

// Captain personality traits — small flavor tags applied at capital
// creation. Surfaced in the fleet panel under the captain's name and
// referenced by dispatches + banter for character. Read-only flavor —
// no mechanical effects, just texture.
const CAPTAIN_TRAITS = [
  { key: "cautious",       label: "Cautious",       blurb: "Holds the line. Will not be hurried." },
  { key: "aggressive",     label: "Aggressive",     blurb: "Burns hot. Asks forgiveness, not permission." },
  { key: "veteran",        label: "Veteran",        blurb: "Has seen it before. Will see it again." },
  { key: "devout",         label: "Devout",         blurb: "Carries a Reader's letter in the breast pocket." },
  { key: "academic",       label: "Academic",       blurb: "Quotes pre-war doctrine. Wins arguments." },
  { key: "stoic",          label: "Stoic",          blurb: "Speaks once per watch. Always worth hearing." },
  { key: "ascetic",        label: "Ascetic",        blurb: "Doesn't drink. Doesn't gamble. Reads scripture between jumps." },
  { key: "popular",        label: "Popular",        blurb: "Crew would follow them anywhere. They have." },
  { key: "haunted",        label: "Haunted",        blurb: "Lost their last command. Still flying." },
  { key: "by-the-book",    label: "By the Book",    blurb: "Logs every action. Cites every regulation." },
  // Never-surrender — ship fights to the last hull plate. The surrender
  // check in ship.js#updateShip gates off when ship.captain.neverSurrender
  // is truthy. Tagged on enemy commanders + can roll on player capitals.
  { key: "never-surrender", label: "Never Surrender", blurb: "Last round into the last gun. No quarter asked, none given.", neverSurrender: true },
];

function rollCaptainTrait(rng) {
  return CAPTAIN_TRAITS[Math.floor(rng() * CAPTAIN_TRAITS.length)];
}

// Captain trait → combat-behavior effects. Applied at spawn time
// in spawnCapital. Each effect is a small spec mutation that makes
// the trait actually FEEL different in battle, not just flavor text.
// Lookup keyed by trait key. Effects compose with captain HP bonus
// (level-based) so a Legendary Aggressive captain stacks both.
//
// Surfaced in the captain detail panel as a "BATTLE EFFECT" line
// so the player knows what they're getting from each personality.
export const CAPTAIN_TRAIT_EFFECTS = {
  "aggressive":  { aiOrbitMul: 0.75, effectLabel: "Closes to bayonet range — orbit -25%" },
  "cautious":    { aiOrbitMul: 1.30, effectLabel: "Holds standoff — orbit +30%" },
  "veteran":     { weaponSpreadMul: 0.80, effectLabel: "Tighter shot pattern — spread -20%" },
  "devout":      { shieldRegenMul: 1.20, effectLabel: "Steady hand — shield regen +20%" },
  "academic":    { pdCooldownMul: 0.85, effectLabel: "Faster PD response — PD cooldown -15%" },
  "stoic":       { engineSlewMul: 0.85, effectLabel: "Crisp manoeuvre — turn rate +15%" },
  "ascetic":     { fuelEfficiency: 0.5, effectLabel: "Lighter on fuel — next jump fuel-free 50%" },
  "popular":     { allyMoraleBuff: true, effectLabel: "Wing morale — nearby fighters fire 10% faster" },
  "haunted":     { weaponDamageMul: 1.10, effectLabel: "Knows what they're shooting at — damage +10%" },
  "by-the-book": { armorWearMul: 0.85, effectLabel: "Crew discipline — armor wears 15% slower" },
};

// Pre-battle fleet doctrine. Player picks one of three stances on the
// battle-choice screen; the doctrine threads through modeConfig and
// applies AI mods to every blue capital at spawn time. Stacks with
// captain trait effects.
//
// PRESS    — close range, more damage, less avoidance
// HOLD     — stand off, shields stronger, more cautious
// SKIRMISH — balanced (default)
//
// Doctrine effects are also surfaced in the battle-choice UI as a
// little "DOCTRINE" chip + description so the player knows what
// they're committing to.
export const FLEET_DOCTRINES = {
  "press": {
    label: "PRESS",
    description: "Close range. Damage +10%, orbit -25%, less danger-avoidance.",
    color: "#f86",
    capital: { aiOrbitMul: 0.75, weaponDamageMul: 1.10, dangerWeightMul: 0.7 },
  },
  "hold": {
    label: "HOLD",
    description: "Stand-off. Shields +15%, regen +20%, orbit +35%.",
    color: "#aef",
    capital: { aiOrbitMul: 1.35, shieldMaxMul: 1.15, shieldRegenMul: 1.20 },
  },
  "skirmish": {
    label: "SKIRMISH",
    description: "Balanced. Turn rate +10%, neutral damage profile.",
    color: "#9d9",
    capital: { engineSlewMul: 1.10 },
  },
};

// Capital ship variants (Tier 40). At each promotion, the player
// picks between 2 variants of the new capital. Each variant has a
// distinctive stat profile + a flavor name. Applied at spawn time
// via applyVariantEffects so the choice actually plays differently.
//
// Shape: { key, label, blurb, applyToSpec(spec) }
export const CAPITAL_VARIANTS = {
  frigate: [
    {
      key: "heavy",
      label: "Heavy",
      blurb: "Reinforced hull. Slower turn rate.",
      applyToSpec: (s) => {
        s.hp = (s.hp || 0) * 1.20;
        if (typeof s.turnRate === "number") s.turnRate *= 0.90;
      },
    },
    {
      key: "hunter",
      label: "Hunter",
      blurb: "Tighter cannon spread + 10% damage.",
      applyToSpec: (s) => {
        if (s.weapon) {
          s.weapon = { ...s.weapon };
          if (typeof s.weapon.damage === "number") s.weapon.damage *= 1.10;
          if (typeof s.weapon.spread === "number") s.weapon.spread *= 0.80;
        }
      },
    },
  ],
  cruiser: [
    {
      key: "siege",
      label: "Siege",
      blurb: "+15% cannon damage. -10% top speed.",
      applyToSpec: (s) => {
        if (s.weapon) {
          s.weapon = { ...s.weapon, damage: (s.weapon.damage || 0) * 1.15 };
        }
        if (typeof s.maxSpeed === "number") s.maxSpeed *= 0.90;
      },
    },
    {
      key: "skirmisher",
      label: "Skirmisher",
      blurb: "+15% top speed. -5% hull.",
      applyToSpec: (s) => {
        if (typeof s.maxSpeed === "number") s.maxSpeed *= 1.15;
        s.hp = (s.hp || 0) * 0.95;
      },
    },
  ],
  battleship: [
    {
      key: "bulwark",
      label: "Bulwark",
      blurb: "+20% shields. +10% shield regen.",
      applyToSpec: (s) => {
        if (s.shield) {
          s.shield = {
            ...s.shield,
            max: (s.shield.max || 0) * 1.20,
            regen: (s.shield.regen || 0) * 1.10,
          };
        }
      },
    },
    {
      key: "aggressor",
      label: "Aggressor",
      blurb: "+12% main-gun damage. +8% PD damage.",
      applyToSpec: (s) => {
        if (s.weapon) {
          s.weapon = { ...s.weapon, damage: (s.weapon.damage || 0) * 1.12 };
        }
        if (s.pdCannons) {
          s.pdCannons = { ...s.pdCannons, damage: (s.pdCannons.damage || 0) * 1.08 };
        }
      },
    },
  ],
  carrier: [
    {
      key: "hangar",
      label: "Hangar",
      blurb: "Replenishes 25% faster — wings cycle quicker.",
      applyToSpec: (s) => {
        if (s.replenish) {
          s.replenish = {
            ...s.replenish,
            fighter: (s.replenish.fighter || 1) * 0.75,
            bomber: (s.replenish.bomber || 1) * 0.75,
          };
        }
      },
    },
    {
      key: "patrol",
      label: "Patrol",
      blurb: "+25% PD damage + range. Defensive carrier.",
      applyToSpec: (s) => {
        if (s.pdCannons) {
          s.pdCannons = {
            ...s.pdCannons,
            damage: (s.pdCannons.damage || 0) * 1.25,
            range: (s.pdCannons.range || 0) * 1.10,
          };
        }
      },
    },
  ],
};

// Apply variant patches at spawn. Mutates spec in place; callers
// should clone first (game.js#spawnCapital already does for traits).
export function applyCapitalVariantEffects(ship, variantKey) {
  if (!ship || !ship.spec || !variantKey) return;
  const list = CAPITAL_VARIANTS[ship.klass] || [];
  const variant = list.find((v) => v.key === variantKey);
  if (variant && variant.applyToSpec) {
    try { variant.applyToSpec(ship.spec); } catch (_e) { /* noop */ }
  }
}

// Get variant options for a class — drives the promotion overlay
// picker. Returns the array (might be empty for unknown classes).
export function variantsForKlass(klass) {
  return CAPITAL_VARIANTS[klass] || [];
}

// In-battle captain comms (Tier 39). Each capital's named captain
// fires short, personality-tinted radio lines when significant
// things happen to their ship — shields drop, hull crosses thresholds,
// first kill, sibling capital lost. Detection happens in game.js,
// line selection happens here.
//
// Shape: TEMPLATES[trigger] = { default: [line, line, ...], <traitKey>: [line, ...] }
// Lines accept `${captain}`, `${ship}`, `${other}` substitutions.
const CAPTAIN_COMMS_TEMPLATES = {
  "shields-down": {
    default:    ["Shields down!", "Shields gone!", "Shield bank's blown!"],
    aggressive: ["Shields down — pressing through!", "Lost the bubble, still on target!"],
    cautious:   ["Shields are gone. Pulling back tight.", "Bubble's down — give me a screen."],
    veteran:    ["Shields gone. Hold formation.", "No bubble. We've done this before."],
    haunted:    ["I've been here before.", "The bubble pops the same every time."],
    devout:     ["The shields are gone. The Choir hears us.", "Unshielded. Steady on."],
    stoic:      ["Shields down.", "Bubble's gone."],
    "by-the-book": ["Shields down. Logging the failure.", "Bubble offline. Repair queue pending."],
  },
  "hull-50": {
    default:    ["Taking heavy fire!", "Hull's catching it!"],
    aggressive: ["Hull's halfway. Don't slow down!", "Half hull — push them!"],
    cautious:   ["Hull at fifty. Requesting screen.", "Down to half. Recommend repositioning."],
    veteran:    ["Half hull. Keep cycling shields.", "Holding. Down to fifty."],
    haunted:    ["Hull half gone. Same as last time.", "Half. Half. Half."],
    devout:     ["The hull half-broken. The Choir hears."],
    popular:    ["Half hull but the crew's holding!", "Down to fifty — they're with me!"],
  },
  "hull-25": {
    default:    ["Hull critical!", "I'm in trouble!", "She's coming apart!"],
    aggressive: ["Hull cracked — I'm staying in.", "Quarter hull. I'm still in the fight."],
    cautious:   ["Critical damage. Permission to withdraw.", "Hull's done — pulling out."],
    veteran:    ["Critical. Tighten up around me.", "Quarter hull. Don't waste it."],
    haunted:    ["I'm in trouble.", "This is how it goes."],
    devout:     ["Critical. The Choir calls."],
    "by-the-book": ["Hull critical. Following damage-control protocols."],
  },
  "first-kill": {
    default:    ["Splash one!", "Target down!", "Confirmed kill!"],
    aggressive: ["GOT them!", "Splash one — more!"],
    cautious:   ["Target confirmed down.", "One down. Stay sharp."],
    veteran:    ["Splash one. Keep cycling targets."],
    haunted:    ["One more.", "Another tally for the wall."],
    devout:     ["The Choir takes one.", "One returned to the dark."],
  },
  "friendly-down": {
    default:    ["{other} is gone!", "We've lost {other}!", "{other} is down..."],
    aggressive: ["{other}'s gone — make them pay!", "Avenge {other}!"],
    cautious:   ["{other} is down. Closing the gap.", "Lost {other}. Tightening formation."],
    veteran:    ["{other} is gone. Crews knew the risk.", "{other} is down. Re-form on me."],
    haunted:    ["{other} is gone. As I feared.", "Another name."],
    devout:     ["{other} returns to the dark. The Choir takes them gladly.", "We commit {other} to the silence."],
    popular:    ["{other} is gone — for them, push harder!"],
  },
  "victory": {
    default:    ["Field is ours.", "Engagement clear.", "All hostiles down."],
    aggressive: ["TOLD you we could take them.", "Field's clear. Press for the next."],
    cautious:   ["Engagement over. Damage report incoming."],
    veteran:    ["Field clear. Reset the lines."],
    devout:     ["The Choir is quieter for the day."],
  },
};

// Pick a line for a (trigger, captain trait, optional substitutions).
// Returns the rendered string, or null if no template matches.
export function pickCaptainCommLine(trigger, traitKey, vars) {
  const block = CAPTAIN_COMMS_TEMPLATES[trigger];
  if (!block) return null;
  let pool = block[traitKey] || block.default;
  if (!pool || pool.length === 0) pool = block.default;
  if (!pool || pool.length === 0) return null;
  // Use a simple Math.random — these are flavor lines, no need for
  // determinism. The flicker would be more noticeable than the variation.
  const line = pool[Math.floor(Math.random() * pool.length)];
  if (!vars) return line;
  // Templates use {name} substitution (e.g. "{other} is gone").
  return line.replace(/\{(\w+)\}/g, (_, k) => vars[k] || "");
}

// Per-capital behavior override (Tier 37). Set via the captain
// detail panel; overrides the fleet-wide doctrine for THIS specific
// ship. Defaults to null = use fleet doctrine.
export const CAPITAL_BEHAVIORS = {
  "press":   { label: "PRESS",  description: "Close-quarters — orbit -25%, +10% damage." },
  "hold":    { label: "HOLD",   description: "Stand-off — orbit +35%, shields +15%." },
  "flank":   { label: "FLANK",  description: "Wide orbit, approach from the quarter — +20% turn rate." },
  "screen":  { label: "SCREEN", description: "Stay near other capitals — +25% shield regen, slower." },
  "default": { label: "FLEET",  description: "Follows the fleet doctrine for this battle." },
};

// Behavior → spec patch. Applied at spawnCapital if cap.behavior is
// set; takes precedence over the fleet doctrine.
const BEHAVIOR_EFFECTS = {
  "press":   { aiOrbitMul: 0.75, weaponDamageMul: 1.10 },
  "hold":    { aiOrbitMul: 1.35, shieldMaxMul: 1.15 },
  "flank":   { aiOrbitMul: 1.20, engineSlewMul: 1.20 },
  "screen":  { aiOrbitMul: 0.90, shieldRegenMul: 1.25, engineSlewMul: 0.90 },
};

export function applyBehaviorEffects(ship, behaviorKey) {
  if (!ship || !ship.spec || !behaviorKey || behaviorKey === "default") return;
  const eff = BEHAVIOR_EFFECTS[behaviorKey];
  if (!eff) return;
  if (eff.aiOrbitMul && typeof ship.spec.aiOrbit === "number") {
    ship.spec.aiOrbit = ship.spec.aiOrbit * eff.aiOrbitMul;
  }
  if (eff.weaponDamageMul && ship.spec.weapon && typeof ship.spec.weapon.damage === "number") {
    ship.spec.weapon = { ...ship.spec.weapon, damage: ship.spec.weapon.damage * eff.weaponDamageMul };
  }
  if (eff.shieldMaxMul && ship.spec.shield && typeof ship.spec.shield.max === "number") {
    ship.spec.shield = { ...ship.spec.shield, max: ship.spec.shield.max * eff.shieldMaxMul };
  }
  if (eff.shieldRegenMul && ship.spec.shield && typeof ship.spec.shield.regen === "number") {
    ship.spec.shield = { ...ship.spec.shield, regen: ship.spec.shield.regen * eff.shieldRegenMul };
  }
  if (eff.engineSlewMul && typeof ship.spec.turnRate === "number") {
    ship.spec.turnRate = ship.spec.turnRate * eff.engineSlewMul;
  }
  ship.shipBehavior = behaviorKey;
}

// Commit a player's variant pick to a capital. Called from the
// promotion overlay's variant picker (Tier 40).
export function selectCapitalVariant(run, instanceId, variantKey) {
  if (!run || !Array.isArray(run.capitals)) return false;
  const cap = run.capitals.find((c) => c.instanceId === instanceId);
  if (!cap) return false;
  const list = variantsForKlass(cap.klass);
  if (!list.find((v) => v.key === variantKey)) return false;
  cap.variant = variantKey;
  saveRun(run);
  return true;
}

// Set a per-capital behavior override. Called from the UI.
export function setCapitalBehavior(run, instanceId, behavior) {
  if (!run || !Array.isArray(run.capitals)) return false;
  const cap = run.capitals.find((c) => c.instanceId === instanceId);
  if (!cap) return false;
  if (behavior === "default" || !behavior) {
    delete cap.behavior;
  } else if (CAPITAL_BEHAVIORS[behavior]) {
    cap.behavior = behavior;
  } else {
    return false;
  }
  saveRun(run);
  return true;
}

/**
 * Battle Plan wing command setter. `wing` is "fighter" or "bomber";
 * `command` is one of "hold" / "free" / "press". Persists to the run
 * so the next time modes/roguelite.js#setup runs, the wing's posture
 * carries through into game.directives. LEGACY — single class-wide
 * command. Multi-wing API is below (setWingDetail, addWing, etc.).
 */
export function setWingCommand(run, wing, command) {
  if (!run) return false;
  if (command !== "hold" && command !== "free" && command !== "press") return false;
  if (wing === "fighter") run.fighterWingCommand = command;
  else if (wing === "bomber") run.bomberWingCommand = command;
  else return false;
  saveRun(run);
  return true;
}

// ---- Multi-wing API ------------------------------------------------
// Each wing is `{ id, name, count, command: { kind, target? } }`.
// Wing arrays live on run.fighterWings / run.bomberWings. Helpers
// keep auto-naming + count clamping consistent.

const WING_NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"];

// Strike-craft wing bounds. A wing must have between MIN and MAX ships.
// Smaller than MIN is below a viable formation (a single craft is just a
// loose escort, not a wing). Larger than MAX is hard to manage on screen
// and dilutes the per-wing command. UI button enable-state mirrors these
// in menus.js (− disabled at MIN, + disabled at MAX, NEW WING disabled
// when no source wing has ≥ MIN×2).
export const WING_MIN_COUNT = 2;
export const WING_MAX_COUNT = 5;

// ---- Wing commanders ----------------------------------------------
// Each wing is led by a named pilot — "Lt. 'Reaper' Vex" style. The
// commander carries a trait that subtly modifies their wing's ships
// in battle (assignWingsToSpawned applies the effect to each
// spawned ship.spec). Read-only state on the wing object; lives as
// long as the wing exists.

const WING_RANKS = ["Lt.", "Lt.", "Lt.", "Capt."]; // mostly Lieutenant
const WING_CALLSIGNS = [
  "Reaper", "Talon", "Ghost", "Phoenix", "Saber", "Viper",
  "Razor", "Specter", "Maverick", "Wraith", "Hawk", "Falcon",
  "Sentinel", "Atlas", "Nova", "Echo", "Bishop", "Rook",
  "Jester", "Cinder", "Vector", "Hammer", "Anvil", "Kestrel",
  "Marrow", "Dust", "Halo", "Husk", "Cipher", "Drift",
];
// Reuse CAPTAIN_SURNAMES (defined above) for commander surnames so
// the family tree of names stays coherent across the run.

// Wing commander traits. Effects applied per-ship in
// assignWingsToSpawned, mutating spec/state directly (cloning the
// spec first so other wings aren't poisoned).
const WING_COMMANDER_TRAITS = [
  { key: "hotshot",   label: "Hotshot",   blurb: "Always fastest off the line.",
    effect: { speedMul: 1.12, effectLabel: "Wing speed +12%" } },
  { key: "marksman",  label: "Marksman",  blurb: "Three shots, three kills.",
    effect: { damageMul: 1.15, effectLabel: "Weapon damage +15%" } },
  { key: "iron-skin", label: "Iron-Skin", blurb: "Hull plating tested in the worst of it.",
    effect: { hpMul: 1.20, effectLabel: "Hull HP +20%" } },
  { key: "wolfpack",  label: "Wolfpack",  blurb: "Fights as one. Strikes as one.",
    effect: { turnMul: 1.15, effectLabel: "Turn rate +15%" } },
  { key: "vanguard",  label: "Vanguard",  blurb: "First into the breach. Every time.",
    effect: { speedMul: 1.08, damageMul: 1.08, effectLabel: "Speed +8%, damage +8%" } },
  { key: "veteran",   label: "Veteran",   blurb: "Has flown longer than most have lived.",
    effect: { hpMul: 1.10, damageMul: 1.08, effectLabel: "Hull +10%, damage +8%" } },
  { key: "ace",       label: "Ace",       blurb: "Twenty-plus confirmed. Counting.",
    effect: { damageMul: 1.25, effectLabel: "Weapon damage +25%" } },
  { key: "steady",    label: "Steady",    blurb: "Won't break formation, won't break promise.",
    effect: { engineHpMul: 1.50, effectLabel: "Engine HP +50% (resists surrender)" } },
];

/**
 * Roll a new wing commander. Returns `{ rank, callsign, surname,
 * name, traitKey, traitLabel, blurb, effect, effectLabel }`. RNG
 * arg is the same seeded `rng` used elsewhere so commanders are
 * deterministic across save/reload of the same run.
 */
export function rollWingCommander(rng) {
  const rank = WING_RANKS[Math.floor(rng() * WING_RANKS.length)];
  const callsign = WING_CALLSIGNS[Math.floor(rng() * WING_CALLSIGNS.length)];
  const surname = CAPTAIN_SURNAMES[Math.floor(rng() * CAPTAIN_SURNAMES.length)];
  const trait = WING_COMMANDER_TRAITS[Math.floor(rng() * WING_COMMANDER_TRAITS.length)];
  return {
    rank, callsign, surname,
    name: `${rank} "${callsign}" ${surname}`,
    traitKey: trait.key,
    traitLabel: trait.label,
    blurb: trait.blurb,
    effect: trait.effect,
    effectLabel: trait.effect.effectLabel,
  };
}

/** Apply a wing commander's trait effect to a spawned ship. Clones
 * the spec + nested weapon/engine state before mutating so other
 * wings (and the race-cached spec) aren't poisoned. */
export function applyWingCommanderEffect(ship, commander) {
  if (!ship || !commander || !commander.effect) return;
  const e = commander.effect;
  // Clone spec + nested weapon so we can mutate without poisoning
  // the race-cached resolved spec (shared by every other ship of
  // the same race + klass).
  ship.spec = { ...ship.spec };
  if (e.speedMul && ship.spec.maxSpeed) {
    ship.spec.maxSpeed = ship.spec.maxSpeed * e.speedMul;
  }
  if (e.turnMul && ship.spec.turnRate) {
    ship.spec.turnRate = ship.spec.turnRate * e.turnMul;
  }
  if (e.damageMul && ship.spec.weapon && ship.spec.weapon.damage) {
    ship.spec.weapon = { ...ship.spec.weapon };
    ship.spec.weapon.damage = ship.spec.weapon.damage * e.damageMul;
  }
  if (e.hpMul) {
    ship.hpMax = ship.hpMax * e.hpMul;
    ship.hp = ship.hp * e.hpMul;
  }
  if (e.engineHpMul && ship.modules) {
    for (const m of ship.modules) {
      if (m.name && m.name.startsWith("engine")) {
        m.hpMax = m.hpMax * e.engineHpMul;
        m.hp = m.hpMax;
      }
    }
  }
}

function wingArrayFor(run, craft) {
  if (craft === "fighter") return run.fighterWings;
  if (craft === "bomber")  return run.bomberWings;
  return null;
}
function craftTotalFor(run, craft) {
  if (craft === "fighter") return run.smallCraft?.fighter || 0;
  if (craft === "bomber")  return run.smallCraft?.bomber  || 0;
  return 0;
}

/** Pick the next unused wing letter. Used for new-wing auto-naming. */
function nextWingName(wings) {
  const taken = new Set(wings.map((w) => w.name));
  for (const n of WING_NAMES) if (!taken.has(n)) return n;
  return "Wing-" + (wings.length + 1);
}

/**
 * Add a new wing to a craft type. Pulls WING_MIN_COUNT ships from the
 * largest existing wing (so the new wing starts at exactly the min
 * viable size, and the source wing keeps ≥ WING_MIN_COUNT). Returns
 * the new wing or null if no wing has enough ships to split.
 */
export function addWing(run, craft) {
  if (!run) return null;
  const wings = wingArrayFor(run, craft);
  if (!wings) return null;
  // Source must keep WING_MIN_COUNT AFTER giving up WING_MIN_COUNT to
  // the new wing → needs at least WING_MIN_COUNT × 2.
  const pull = WING_MIN_COUNT;
  wings.sort((a, b) => b.count - a.count);
  const source = wings.find((w) => w.count >= pull * 2);
  if (!source) return null;
  source.count -= pull;
  const newWing = {
    id: `${craft}-${nextWingName(wings).charAt(0)}-${Date.now() % 100000}`,
    name: nextWingName(wings),
    count: pull,
    command: { kind: "free" },
    // Each new wing gets a fresh procedural commander. addWing is
    // user-driven (UI click) so Math.random is fine — these aren't
    // seed-replayable like starter wings.
    commander: rollWingCommander(Math.random),
  };
  wings.push(newWing);
  saveRun(run);
  return newWing;
}

/** Remove a wing; its ships fold back into the first remaining wing. */
export function removeWing(run, craft, wingId) {
  if (!run) return false;
  const wings = wingArrayFor(run, craft);
  if (!wings || wings.length <= 1) return false;  // keep at least one
  const idx = wings.findIndex((w) => w.id === wingId);
  if (idx < 0) return false;
  const removed = wings.splice(idx, 1)[0];
  // Return ships to the first remaining wing (or to a fresh default if needed)
  wings[0].count += removed.count;
  saveRun(run);
  return true;
}

/**
 * Adjust a wing's ship count by `delta` (positive grows, negative shrinks).
 * Clamps the target wing to [WING_MIN_COUNT, WING_MAX_COUNT]. Refuses
 * the move if it would push the source/destination outside those
 * bounds. Returns true on success, false if refused.
 *
 * Grow: pulls from the largest other wing (which must keep
 * WING_MIN_COUNT after giving up the ships).
 * Shrink: returns ships to the largest other wing.
 */
export function adjustWingCount(run, craft, wingId, delta) {
  if (!run) return false;
  const wings = wingArrayFor(run, craft);
  if (!wings) return false;
  const wing = wings.find((w) => w.id === wingId);
  if (!wing) return false;
  if (delta === 0) return true;
  if (delta > 0) {
    // Refuse if growing would push past max.
    if (wing.count + delta > WING_MAX_COUNT) return false;
    // Pre-check: do other wings have enough surplus above min to give?
    const others = wings.filter((w) => w.id !== wingId);
    const totalSurplus = others.reduce(
      (s, o) => s + Math.max(0, o.count - WING_MIN_COUNT), 0
    );
    if (totalSurplus < delta) return false;
    // Pull from largest-surplus wing first.
    others.sort((a, b) => (b.count - WING_MIN_COUNT) - (a.count - WING_MIN_COUNT));
    let need = delta;
    for (const o of others) {
      if (need <= 0) break;
      const take = Math.min(o.count - WING_MIN_COUNT, need);
      if (take <= 0) continue;
      o.count -= take;
      wing.count += take;
      need -= take;
    }
  } else {
    // Refuse if shrinking would push below min.
    if (wing.count + delta < WING_MIN_COUNT) return false;
    const take = Math.min(wing.count - WING_MIN_COUNT, -delta);
    if (take <= 0) return false;
    wing.count -= take;
    const others = wings.filter((w) => w.id !== wingId);
    if (others.length > 0) {
      others.sort((a, b) => b.count - a.count);
      others[0].count += take;
    }
  }
  saveRun(run);
  return true;
}

/** Set a wing's command (kind + optional target). */
export function setWingDetail(run, craft, wingId, command) {
  if (!run) return false;
  const wings = wingArrayFor(run, craft);
  if (!wings) return false;
  const wing = wings.find((w) => w.id === wingId);
  if (!wing) return false;
  wing.command = command || { kind: "free" };
  saveRun(run);
  return true;
}

/**
 * Re-balance wings if total small craft changed (e.g. resupply bought
 * more fighters; one wing's count exceeds the total). Idempotent —
 * safe to call on every battle setup. Adds excess ships to the first
 * wing; if total drops below sum, shrinks proportionally.
 */
export function rebalanceWings(run, craft) {
  if (!run) return;
  const wings = wingArrayFor(run, craft);
  if (!wings || wings.length === 0) {
    // Initialize a default wing if none exist (e.g. older saves)
    const total = craftTotalFor(run, craft);
    if (craft === "fighter") run.fighterWings = [{ id: "fighter-A", name: "Alpha", count: total, command: { kind: "free" } }];
    else if (craft === "bomber") run.bomberWings = [{ id: "bomber-A", name: "Alpha", count: total, command: { kind: "free" } }];
    return;
  }
  // Validate defend-capital targets — clear stale ones so the user's
  // intent isn't silently misrouted to the wrong capital (assignEscortPacks
  // would otherwise auto-assign a default escort, masking the bug).
  const liveCapIds = new Set((run.capitals || []).map((c) => c.instanceId));
  for (const w of wings) {
    if (w.command && w.command.kind === "defend-capital"
        && w.command.target != null && !liveCapIds.has(w.command.target)) {
      w.command = { kind: "free" };
    }
  }
  const total = craftTotalFor(run, craft);
  let sum = wings.reduce((s, w) => s + w.count, 0);
  if (sum === total) return;
  if (sum < total) {
    wings[0].count += (total - sum);
  } else {
    // Shrink proportionally
    const ratio = total / sum;
    for (const w of wings) w.count = Math.floor(w.count * ratio);
    // Round-off — put any remainder into the first wing
    sum = wings.reduce((s, w) => s + w.count, 0);
    wings[0].count += (total - sum);
  }
}

// Apply a doctrine's per-capital effects. Called from spawnCapital
// AFTER the captain trait effects so doctrine compounds on top.
export function applyDoctrineEffects(ship, doctrineKey) {
  if (!ship || !ship.spec || !doctrineKey) return;
  const doc = FLEET_DOCTRINES[doctrineKey];
  if (!doc || !doc.capital) return;
  const c = doc.capital;
  if (c.aiOrbitMul && typeof ship.spec.aiOrbit === "number") {
    ship.spec.aiOrbit = ship.spec.aiOrbit * c.aiOrbitMul;
  }
  if (c.weaponDamageMul && ship.spec.weapon && typeof ship.spec.weapon.damage === "number") {
    ship.spec.weapon = { ...ship.spec.weapon, damage: ship.spec.weapon.damage * c.weaponDamageMul };
  }
  if (c.shieldMaxMul && ship.spec.shield && typeof ship.spec.shield.max === "number") {
    ship.spec.shield = { ...ship.spec.shield, max: ship.spec.shield.max * c.shieldMaxMul };
    // Also scale current shield so the ship spawns at proportional level.
    if (typeof ship.shield === "number") ship.shield = ship.shield * c.shieldMaxMul;
  }
  if (c.shieldRegenMul && ship.spec.shield && typeof ship.spec.shield.regen === "number") {
    ship.spec.shield = { ...ship.spec.shield, regen: ship.spec.shield.regen * c.shieldRegenMul };
  }
  if (c.engineSlewMul && typeof ship.spec.turnRate === "number") {
    ship.spec.turnRate = ship.spec.turnRate * c.engineSlewMul;
  }
  // Stamp the doctrine on the ship so AI can read it (danger weight
  // mul, e.g. PRESS pushes through PD bubbles harder).
  ship.battleDoctrine = doctrineKey;
}

// Apply a captain trait's combat effects to a freshly-spawned capital.
// Mutates ship.spec values in place. Called from game.js#spawnCapital
// after createShip + the level-HP bonus.
export function applyCaptainTraitEffects(ship, traitKey) {
  if (!ship || !ship.spec) return;
  const eff = CAPTAIN_TRAIT_EFFECTS[traitKey];
  if (!eff) return;
  // aiOrbit multiplier (close-range / stand-off behavior).
  if (eff.aiOrbitMul && typeof ship.spec.aiOrbit === "number") {
    ship.spec.aiOrbit = ship.spec.aiOrbit * eff.aiOrbitMul;
  }
  // Weapon spread (accuracy).
  if (eff.weaponSpreadMul && ship.spec.weapon && typeof ship.spec.weapon.spread === "number") {
    ship.spec.weapon = { ...ship.spec.weapon, spread: ship.spec.weapon.spread * eff.weaponSpreadMul };
  }
  // Shield regen.
  if (eff.shieldRegenMul && ship.spec.shield && typeof ship.spec.shield.regen === "number") {
    ship.spec.shield = { ...ship.spec.shield, regen: ship.spec.shield.regen * eff.shieldRegenMul };
  }
  // PD cooldown.
  if (eff.pdCooldownMul && ship.spec.pdCannons && typeof ship.spec.pdCannons.cooldown === "number") {
    ship.spec.pdCannons = { ...ship.spec.pdCannons, cooldown: ship.spec.pdCannons.cooldown * eff.pdCooldownMul };
  }
  // Turn rate / slew (engineSlewMul shrinks the turn timeconst).
  if (eff.engineSlewMul && typeof ship.spec.turnRate === "number") {
    ship.spec.turnRate = ship.spec.turnRate / eff.engineSlewMul;
  }
  // Armor wear rate.
  if (eff.armorWearMul && ship.spec.armor && typeof ship.spec.armor.wearRate === "number") {
    ship.spec.armor = { ...ship.spec.armor, wearRate: ship.spec.armor.wearRate * eff.armorWearMul };
  }
  // Damage multiplier (haunted captain).
  if (eff.weaponDamageMul && ship.spec.weapon && typeof ship.spec.weapon.damage === "number") {
    ship.spec.weapon = { ...ship.spec.weapon, damage: ship.spec.weapon.damage * eff.weaponDamageMul };
  }
  // Flag for AI/HUD to detect this ship's morale aura (popular captain).
  if (eff.allyMoraleBuff) {
    ship.captainMoraleAura = true;
  }
}

// Captain XP / level progression. Capitals earn XP every engagement
// they survive (+more for elites and bosses). Crossing a level
// threshold grants a title + a small hull bonus applied at spawn.
const CAPTAIN_LEVEL_THRESHOLDS = [0, 3, 8, 16, 28]; // XP needed for level N+1
const CAPTAIN_TITLES = ["", "Veteran", "Accomplished", "Decorated", "Legendary"];

export function captainLevelFor(xp) {
  let lvl = 1;
  for (let i = 0; i < CAPTAIN_LEVEL_THRESHOLDS.length; i++) {
    if (xp >= CAPTAIN_LEVEL_THRESHOLDS[i]) lvl = i + 1;
  }
  return Math.min(5, lvl);
}

export function captainTitleFor(level) {
  return CAPTAIN_TITLES[Math.min(CAPTAIN_TITLES.length - 1, level - 1)] || "";
}

// XP threshold for the NEXT level (for the XP bar). Returns null when
// the captain is already at the cap.
export function captainNextThreshold(level) {
  if (level >= CAPTAIN_LEVEL_THRESHOLDS.length) return null;
  return CAPTAIN_LEVEL_THRESHOLDS[level];
}

// HP multiplier from level — 5% per level above 1, capped at +20%.
// Applied at spawn time so a level-3 captain's frigate spawns with
// 10% more HP than a level-1 captain's frigate of the same class.
export function captainHpMul(level) {
  return 1 + 0.05 * Math.max(0, Math.min(4, level - 1));
}

// ---------------------------------------------------------------------------
// Commander perks (shared by capital captains AND wing commanders). Every
// commander gains XP per battle, levels up on the captain thresholds, and
// at each milestone level (COMMANDER_PERK_LEVELS) earns ONE perk pick —
// chosen by the player in the run-map dossier from a rolled draw. Perks
// patch the spawned ship's spec, so a perk on a capital captain buffs that
// capital, and a perk on a wing commander buffs every ship in that wing.
//
// Each perk's `apply(ship)` clones spec/nested state before mutating (the
// resolveSpec shared-ref hazard) so it never poisons other ships.
// ---------------------------------------------------------------------------
export const COMMANDER_PERKS = {
  gunnery:    { name: "Gunnery Doctrine", blurb: "+15% weapon damage.",
    apply: (s) => { if (s.spec.weapon) { s.spec = { ...s.spec }; s.spec.weapon = { ...s.spec.weapon, damage: (s.spec.weapon.damage || 0) * 1.15 }; } } },
  rapidcycle: { name: "Rapid Cycle", blurb: "+15% rate of fire.",
    apply: (s) => { if (s.spec.weapon && s.spec.weapon.cooldown) { s.spec = { ...s.spec }; s.spec.weapon = { ...s.spec.weapon, cooldown: s.spec.weapon.cooldown / 1.15 }; } } },
  reinforced: { name: "Reinforced Hull", blurb: "+18% hull integrity.",
    apply: (s) => { s.hpMax = (s.hpMax || 0) * 1.18; s.hp = Math.min(s.hpMax, (s.hp || s.hpMax) * 1.18); } },
  shielded:   { name: "Hardened Shields", blurb: "+25% shield strength.",
    apply: (s) => { if (s.spec.shield) { s.spec = { ...s.spec }; s.spec.shield = { ...s.spec.shield, max: (s.spec.shield.max || 0) * 1.25 }; s.shieldMax = s.spec.shield.max; s.shield = s.spec.shield.max; } } },
  afterburn:  { name: "Afterburners", blurb: "+15% top speed.",
    apply: (s) => { if (s.spec.maxSpeed) { s.spec = { ...s.spec }; s.spec.maxSpeed = s.spec.maxSpeed * 1.15; } } },
  evasive:    { name: "Evasive Maneuvers", blurb: "+20% turn rate.",
    apply: (s) => { if (s.spec.turnRate) { s.spec = { ...s.spec }; s.spec.turnRate = s.spec.turnRate * 1.20; } } },
  marksman:   { name: "Marksman", blurb: "+12% projectile speed (tighter aim).",
    apply: (s) => { if (s.spec.weapon && s.spec.weapon.projectileSpeed) { s.spec = { ...s.spec }; s.spec.weapon = { ...s.spec.weapon, projectileSpeed: s.spec.weapon.projectileSpeed * 1.12 }; } } },
  ace:        { name: "Ace Pilot", blurb: "+8% damage and +8% speed.",
    apply: (s) => { s.spec = { ...s.spec }; if (s.spec.weapon) s.spec.weapon = { ...s.spec.weapon, damage: (s.spec.weapon.damage || 0) * 1.08 }; if (s.spec.maxSpeed) s.spec.maxSpeed = s.spec.maxSpeed * 1.08; } },
};
// Levels that grant a perk pick (1 each → up to 4 picks over a full career).
const COMMANDER_PERK_LEVELS = [2, 3, 4, 5];

// Apply an array of perk keys to a freshly-spawned ship (capital or wing).
export function applyCommanderPerks(ship, perks) {
  if (!ship || !ship.spec || !Array.isArray(perks)) return;
  for (const key of perks) {
    const p = COMMANDER_PERKS[key];
    if (p && p.apply) { try { p.apply(ship); } catch (_e) { /* skip bad perk */ } }
  }
}

// Roll up to `n` distinct perk keys the commander doesn't already own.
function rollPerkDraw(ownedKeys, rng, n = 3) {
  const owned = new Set(ownedKeys || []);
  const pool = Object.keys(COMMANDER_PERKS).filter((k) => !owned.has(k));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

// Ensure a commander-like object (capital captain record OR wing.commander)
// carries the shared progression fields.
function ensureCommanderProgress(c) {
  if (!c) return;
  if (!Array.isArray(c.perks)) c.perks = [];
  if (typeof c.xp !== "number") c.xp = 0;
  if (typeof c.level !== "number") c.level = captainLevelFor(c.xp);
  if (typeof c.pendingPerks !== "number") c.pendingPerks = 0;
}

// Award XP to one commander; queue a perk pick on each milestone level
// crossed. Returns true if the commander leveled up.
function awardXpToCommander(c, gain, rng) {
  ensureCommanderProgress(c);
  const before = captainLevelFor(c.xp);
  c.xp += gain;
  c.level = captainLevelFor(c.xp);
  for (let lvl = before + 1; lvl <= c.level; lvl++) {
    if (COMMANDER_PERK_LEVELS.includes(lvl)) c.pendingPerks += 1;
  }
  if (c.pendingPerks > 0 && (!c.perkDraw || c.perkDraw.length === 0)) {
    c.perkDraw = rollPerkDraw(c.perks, rng);
  }
  return c.level > before;
}

// Total un-spent perk picks across the whole fleet (capitals + wings).
// The dossier surfaces this as a badge so the player knows to go choose.
export function commanderPendingPicks(run) {
  let n = 0;
  for (const cap of (run.capitals || [])) n += (cap.pendingPerks || 0);
  for (const w of [...(run.fighterWings || []), ...(run.bomberWings || [])]) {
    if (w.commander) n += (w.commander.pendingPerks || 0);
  }
  return n;
}

// Spend a pending perk pick. `ref` = { kind:"capital", id } or
// { kind:"wing", craft, wingId }. Pushes the perk, decrements the pending
// counter, and rolls a fresh draw if the commander still has picks owed.
export function pickCommanderPerk(run, ref, perkKey) {
  if (!run || !ref || !COMMANDER_PERKS[perkKey]) return false;
  let c = null;
  if (ref.kind === "capital") {
    c = (run.capitals || []).find((x) => x.instanceId === ref.id);
  } else if (ref.kind === "wing") {
    const wings = ref.craft === "bomber" ? run.bomberWings : run.fighterWings;
    const w = (wings || []).find((x) => x.id === ref.wingId);
    c = w && w.commander;
  }
  if (!c) return false;
  ensureCommanderProgress(c);
  if (c.pendingPerks <= 0) return false;
  if (!c.perkDraw || !c.perkDraw.includes(perkKey)) return false;
  if (c.perks.includes(perkKey)) return false;
  c.perks.push(perkKey);
  c.pendingPerks -= 1;
  c.perkDraw = c.pendingPerks > 0 ? rollPerkDraw(c.perks, Math.random) : null;
  saveRun(run);
  return true;
}

// ---------------------------------------------------------------------------
// Achievements (Tier 43) — cross-run milestones with service-point
// rewards + a permanent badge in the player profile. Checked at
// recordRunEnd time; newly-unlocked entries are stamped onto
// meta.unlockedAchievements and surfaced as a toast in the end-screen.
//
// `condition(run, meta, won)` runs INSIDE the saveStore.update callback
// after stats are committed, so it can read final stats from `run`
// AND historical meta state. Return true to unlock.
// ---------------------------------------------------------------------------

export const ACHIEVEMENTS = [
  {
    id: "first-blood",
    name: "First Blood",
    description: "Complete your first Frontier career.",
    icon: "★",
    reward: 5,
    condition: (run, meta, won) => (meta.runsCompleted || 0) >= 1,
  },
  {
    id: "war-won",
    name: "War's End",
    description: "Win the Frontier Wars — clear all 5 acts.",
    icon: "♛",
    reward: 25,
    condition: (run, meta, won) => won,
  },
  {
    id: "unbroken-line",
    name: "Unbroken Line",
    description: "Win a campaign without losing a capital.",
    icon: "▣",
    reward: 30,
    condition: (run, meta, won) => won && (run.stats && run.stats.shipsLost &&
      ((run.stats.shipsLost.frigate || 0) +
       (run.stats.shipsLost.cruiser || 0) +
       (run.stats.shipsLost.battleship || 0) +
       (run.stats.shipsLost.carrier || 0)) === 0),
  },
  {
    id: "legendary-captain",
    name: "Legendary Captain",
    description: "Bring a captain to level 5 during a career.",
    icon: "✦",
    reward: 15,
    condition: (run, meta, won) => (run.capitals || []).some((c) => (c.level || 1) >= 5),
  },
  {
    id: "ace-hunter",
    name: "Ace Hunter",
    description: "Kill 5 named aces / rivals in a single career.",
    icon: "⚔",
    reward: 10,
    condition: (run, meta, won) => (run.stats && run.stats.rivalsDefeated) >= 5,
  },
  {
    id: "rich-officer",
    name: "Rich Officer",
    description: "Earn 1000+ credits in a single career.",
    icon: "$",
    reward: 8,
    condition: (run, meta, won) => (run.stats && run.stats.creditsEarned || 0) >= 1000,
  },
  {
    id: "long-jump",
    name: "Long Jump",
    description: "Clear 40+ nodes in a single career.",
    icon: "→",
    reward: 8,
    condition: (run, meta, won) => (run.stats && run.stats.nodesCleared || 0) >= 40,
  },
  {
    id: "kill-streak",
    name: "Kill Streak",
    description: "Destroy 100+ ships in a single career.",
    icon: "↯",
    reward: 12,
    condition: (run, meta, won) => {
      const k = run.stats && run.stats.shipsKilled;
      if (!k) return false;
      return Object.values(k).reduce((a, b) => a + b, 0) >= 100;
    },
  },
  {
    id: "all-rivals-down",
    name: "Clean Slate",
    description: "Win a career with all rivals defeated.",
    icon: "✕",
    reward: 15,
    condition: (run, meta, won) => won &&
      (run.rivals || []).every((r) => r.status === "defeated"),
  },
  {
    id: "boon-collector",
    name: "Boon Collector",
    description: "Acquire 10+ boons in a single career.",
    icon: "◆",
    reward: 10,
    condition: (run, meta, won) => (run.stats && run.stats.boonsAcquired || 0) >= 10,
  },
  {
    id: "contract-runner",
    name: "Contract Runner",
    description: "Complete 5 cargo contracts in a single career.",
    icon: "▤",
    reward: 10,
    condition: (run, meta, won) => (run.stats && run.stats.contractsCompleted || 0) >= 5,
  },
  {
    id: "story-teller",
    name: "Story Teller",
    description: "Resolve a procedural story arc to its final stage.",
    icon: "📖",
    reward: 10,
    condition: (run, meta, won) =>
      (run.arcs || []).some((a) => a.stageIndex >= 2),
  },
  {
    id: "veteran-fleet",
    name: "Veteran Fleet",
    description: "Have 3+ capitals at level 3+ simultaneously.",
    icon: "★★★",
    reward: 15,
    condition: (run, meta, won) =>
      (run.capitals || []).filter((c) => (c.level || 1) >= 3).length >= 3,
  },
  {
    id: "five-careers",
    name: "Career Officer",
    description: "Complete 5 Frontier careers (win or loss).",
    icon: "▰",
    reward: 12,
    condition: (run, meta, won) => (meta.runsCompleted || 0) >= 5,
  },
  {
    id: "ten-wars-won",
    name: "Decorated",
    description: "Win 3 Frontier Wars across your career.",
    icon: "✠",
    reward: 30,
    condition: (run, meta, won) => (meta.runsWon || 0) >= 3,
  },
  {
    id: "service-spender",
    name: "Investor",
    description: "Buy 3 ranks of Service Hall upgrades.",
    icon: "🏛",
    reward: 8,
    condition: (run, meta, won) => {
      const ranks = meta.serviceUpgrades || {};
      const total = Object.values(ranks).reduce((a, b) => a + b, 0);
      return total >= 3;
    },
  },
];

// Check for newly-completed achievements. Returns array of unlocked
// ids stamped this call (used by the UI for the toast).
function checkAchievementUnlocks(meta, run, won) {
  if (!meta.unlockedAchievements) meta.unlockedAchievements = [];
  const unlocked = new Set(meta.unlockedAchievements);
  const newlyUnlocked = [];
  for (const ach of ACHIEVEMENTS) {
    if (unlocked.has(ach.id)) continue;
    let pass = false;
    try { pass = !!ach.condition(run, meta, won); } catch (_e) { pass = false; }
    if (!pass) continue;
    meta.unlockedAchievements.push(ach.id);
    meta.servicePoints = (meta.servicePoints || 0) + (ach.reward || 0);
    newlyUnlocked.push(ach.id);
  }
  return newlyUnlocked;
}

// Helper for UI: get the count of unlocked vs total for a profile chip.
export function achievementProgress(meta) {
  const unlocked = (meta && meta.unlockedAchievements || []).length;
  return { unlocked, total: ACHIEVEMENTS.length };
}

// ---------------------------------------------------------------------------
// Service Hall — meta-progression (Tier 38). Earn service points per
// run (boss kills, level-5 captains, war wins) and spend on permanent
// upgrades that apply at every future run start.
//
// Shape: { key, name, description, maxRank, cost(rank) → points, apply(rank, run) }
// `apply` is called from startNewRun after the base setup so each
// upgrade can mutate the fresh run.
// ---------------------------------------------------------------------------

export const SERVICE_UPGRADES = {
  "reserve-fighters": {
    name: "Reserve Fighters",
    description: "Career starts with +1 fighter per rank.",
    maxRank: 5,
    cost: (rank) => 3 + rank * 2, // ranks 1-5: 5, 7, 9, 11, 13
    apply: (rank, run) => {
      if (rank > 0) run.smallCraft.fighter = (run.smallCraft.fighter || 0) + rank;
    },
  },
  "reserve-bombers": {
    name: "Reserve Bombers",
    description: "Career starts with +1 bomber per rank.",
    maxRank: 3,
    cost: (rank) => 6 + rank * 2,
    apply: (rank, run) => {
      if (rank > 0) run.smallCraft.bomber = (run.smallCraft.bomber || 0) + rank;
    },
  },
  "treasury": {
    name: "Treasury",
    description: "Career starts with +25 credits per rank.",
    maxRank: 4,
    cost: (rank) => 4 + rank * 2,
    apply: (rank, run) => {
      if (rank > 0) run.resources.credits = (run.resources.credits || 0) + rank * 25;
    },
  },
  "fuel-allotment": {
    name: "Fuel Allotment",
    description: "Career starts with +1 fuel per rank.",
    maxRank: 4,
    cost: (rank) => 4 + rank * 2,
    apply: (rank, run) => {
      if (rank > 0) run.resources.fuel = (run.resources.fuel || 0) + rank;
    },
  },
  "captain-lineage": {
    name: "Captain Lineage",
    description: "Future starter capitals begin at level 2 per rank (max +2).",
    maxRank: 2,
    cost: (rank) => 8 + rank * 3,
    apply: (rank, run) => {
      if (rank <= 0) return;
      const xpBoost = rank * 4; // enough to push to level 2 (3 XP) or 3 (8 XP)
      for (const cap of (run.capitals || [])) {
        cap.xp = (cap.xp || 0) + xpBoost;
        cap.level = captainLevelFor(cap.xp);
      }
    },
  },
  "frontier-veterancy": {
    name: "Frontier Veterancy",
    description: "Start each run with a random small-craft boon already applied.",
    maxRank: 1,
    cost: () => 15,
    apply: (rank, run) => {
      if (rank <= 0) return;
      // Pick a random "small-craft" boon that doesn't require capitals.
      const safe = ["tracer-rounds", "extended-magazines", "kinetic-rounds", "precog-targeting", "rapid-pods"];
      const pool = safe.filter((k) => !(run.boons || []).some((b) => b.key === k));
      if (pool.length === 0) return;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      const boon = BOON_TABLE.find((b) => b.key === pick);
      if (boon) run.boons.push({ ...boon });
    },
  },
};

// Apply all purchased upgrades to a fresh run. Called from startNewRun
// AFTER the base fleet + perk is set up so upgrades stack on top.
function applyServiceUpgrades(meta, run) {
  if (!meta || !meta.serviceUpgrades) return;
  for (const key of Object.keys(SERVICE_UPGRADES)) {
    const rank = meta.serviceUpgrades[key] || 0;
    if (rank <= 0) continue;
    const def = SERVICE_UPGRADES[key];
    if (def && def.apply) {
      try { def.apply(rank, run); } catch (_e) { /* ignore */ }
    }
  }
}

// Award service points based on run outcome. Called from recordRunEnd.
function awardServicePoints(meta, run, won) {
  if (!meta) return 0;
  let earned = 0;
  // Base: 1 point per run completed (win OR loss).
  earned += 1;
  // Bonus per boss killed.
  const bossesKilled = (run.stats && run.stats.bossesKilled) || 0;
  earned += bossesKilled;
  // Bonus per level-5 captain alive at run end.
  const legendaryCaps = (run.capitals || []).filter((c) => (c.level || 1) >= 5).length;
  earned += legendaryCaps * 2;
  // Big bonus for winning the war.
  if (won) earned += 5;
  meta.servicePoints = (meta.servicePoints || 0) + earned;
  return earned;
}

// Buy one rank of an upgrade. Returns the new rank, or null on failure
// (max rank reached, not enough points).
export function buyServiceUpgrade(key) {
  const def = SERVICE_UPGRADES[key];
  if (!def) return null;
  let result = null;
  saveStore.update((d) => {
    if (!d.roguelite.meta.serviceUpgrades) d.roguelite.meta.serviceUpgrades = {};
    const cur = d.roguelite.meta.serviceUpgrades[key] || 0;
    if (cur >= def.maxRank) return;
    const cost = def.cost(cur + 1);
    if ((d.roguelite.meta.servicePoints || 0) < cost) return;
    d.roguelite.meta.servicePoints -= cost;
    d.roguelite.meta.serviceUpgrades[key] = cur + 1;
    result = cur + 1;
  });
  return result;
}

// Reset all upgrades (refunds points). For a future "respec" feature.
export function refundServiceUpgrades() {
  let refunded = 0;
  saveStore.update((d) => {
    const ranks = d.roguelite.meta.serviceUpgrades || {};
    for (const key of Object.keys(ranks)) {
      const def = SERVICE_UPGRADES[key];
      if (!def) continue;
      for (let r = 1; r <= ranks[key]; r++) refunded += def.cost(r);
      ranks[key] = 0;
    }
    d.roguelite.meta.servicePoints = (d.roguelite.meta.servicePoints || 0) + refunded;
  });
  return refunded;
}

// Rename a capital's ship name or captain. Called from the
// captain-detail overlay's rename inputs. Trims + caps length so
// the player can't blow out the save with a 10kB ship name.
export function renameCapital(run, instanceId, fields) {
  if (!run || !Array.isArray(run.capitals)) return false;
  const cap = run.capitals.find((c) => c.instanceId === instanceId);
  if (!cap) return false;
  const clean = (s) => String(s || "").trim().slice(0, 40);
  if (fields.name !== undefined) {
    const n = clean(fields.name);
    if (n) cap.name = n;
  }
  if (fields.captain !== undefined) {
    const n = clean(fields.captain);
    if (n) cap.captain = n;
  }
  saveRun(run);
  return true;
}

// Award XP to all surviving capitals after a battle. Threshold
// crossings stamp a log entry so the player sees the progression.
function awardCaptainXp(run, node) {
  let xpGain = 1;
  if (node) {
    if (node.type === "elite") xpGain = 3;
    if (node.type === "boss")  xpGain = 6;
  }
  // Seeded RNG so the rolled perk draws are stable across save/reload.
  const seed = (((run.seed >>> 0) ^ ((run.visitedNodeIds || []).length * 2017)) >>> 0) || 1;
  const rng = mulberry32(seed);
  // Capital captains.
  for (const cap of (run.capitals || [])) {
    if (awardXpToCommander(cap, xpGain, rng)) {
      appendRunLog(run, "promotion",
        `${cap.captain || cap.klass} earned the ${captainTitleFor(cap.level)} commendation aboard ${cap.name || cap.klass}.`);
    }
  }
  // Wing commanders (fighter + bomber wings) — same shared progression.
  for (const w of [...(run.fighterWings || []), ...(run.bomberWings || [])]) {
    if (!w.commander) continue;
    if (awardXpToCommander(w.commander, xpGain, rng)) {
      appendRunLog(run, "promotion",
        `${w.commander.name} made ${captainTitleFor(w.commander.level)} leading ${w.name} Wing.`);
    }
  }
}

// Wrap a fresh capital with procedural identity. Used by startNewRun
// (starter fleet) + applyPromotion (per-act additions). The instanceId
// is assigned by the caller; everything else is fresh.
function makeNamedCapital(klass, instanceId, rng, race = null) {
  const trait = rollCaptainTrait(rng);
  return {
    klass,
    hpFrac: 1.0,
    instanceId,
    name: rollCapitalName(rng),
    captain: rollCapitalCaptain(rng, klass),
    captainTrait: trait.key,
    captainTraitLabel: trait.label,
    captainTraitBlurb: trait.blurb,
    // Race the hull spawns as. null = the player's allied race (Terran
    // in Frontier). Captured ships keep their original enemy race so a
    // captured Reaver frigate spawns as a Reaver frigate (hull + sprite
    // + spec), just flying on the blue side.
    race: race || null,
    xp: 0,
    level: 1,
  };
}

// Coalition pilot name pool — Coalition Star Service callsigns are
// short and punchy (one syllable, often a noun). Used for battlefield-
// promotion pilots that join the line after a successful engagement.
const COALITION_PILOT_CALLSIGNS = [
  "STORK", "BEACON", "ASH", "VIPER", "CORVID", "SLATE", "OWL", "FANG",
  "HALO", "PYRE", "NOVA", "RUNE", "BLINK", "TIGER", "ECHO", "MOTH",
  "RAVEN", "QUARTZ", "STRIDE", "WICK", "SABLE", "ARROW", "GHOST",
  "HERON", "BISHOP", "VANE", "FLINT", "REED", "SCRIBE", "EAGLE",
];
const COALITION_PILOT_RANKS = ["Ens.", "Lt.", "Lt.", "Lt. Cmdr."];
function rollPilotName(rng) {
  const callsign = COALITION_PILOT_CALLSIGNS[Math.floor(rng() * COALITION_PILOT_CALLSIGNS.length)];
  return `"${callsign}"`;
}
function rollPilotFull(rng) {
  const rank = COALITION_PILOT_RANKS[Math.floor(rng() * COALITION_PILOT_RANKS.length)];
  const surname = CAPTAIN_SURNAMES[Math.floor(rng() * CAPTAIN_SURNAMES.length)];
  return `${rank} ${surname}`;
}

// Battlefield promotion archetypes — each one is a procedural reward
// "moment" stamped after an engagement. The reward is a ship grant
// (fighter / bomber / rarely frigate) plus optional credits and an
// optional named pilot that joins the wing roster.
//
// Shape: { type, weight, requires(report, run), apply(rng, report, run) → {headline, body, reward, pilot} }
// Body lines are functions that receive (pilot, reward) so they can
// reference the actual rolled count in prose ("Three canopies, full
// magazines.") — keeps the flavor accurate across the variance band.
//
// `weight` is the relative roll weight; `requires` gates each archetype
// to specific battle outcomes (e.g. "salvage" only fires after a fight
// where the enemy lost capitals).

// Spell numeric counts in prose (1→"one", 2→"two", ...). Falls back to
// digits past 8 so an unusually big roll still reads.
function spellCount(n) {
  return ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"][n] || String(n);
}
function pluralize(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
function rollInt(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

const PROMOTION_ARCHETYPES = [
  // Recruit — a Coalition wing pilot ferries in. Default fallback.
  // Variable: rolls 2-4 fighters. Body references the actual rolled
  // count so prose stays accurate ("Two canopies" vs "Four canopies").
  {
    type: "recruit",
    weight: 4,
    requires: () => true,
    apply: (rng, _report, _run) => {
      const fighters = rollInt(rng, 2, 4);
      return {
        headline: "WING REINFORCEMENT",
        body: (pilot, reward) =>
          `${pilot} reports in with a flight from the Coalition holding pattern. ${spellCount(reward.fighter).charAt(0).toUpperCase()}${spellCount(reward.fighter).slice(1)} canopies, full magazines.`,
        reward: { fighter: fighters },
        withPilot: true,
      };
    },
  },
  // Salvage — gut a wreck for refit fighters. Fires when the enemy
  // lost at least 3 small craft or any capital.
  {
    type: "salvage",
    weight: 3,
    requires: (report) => {
      const killed = report.killed || {};
      const smallKills = (killed.fighter || 0) + (killed.bomber || 0);
      const capKills = (killed.frigate || 0) + (killed.cruiser || 0) + (killed.battleship || 0) + (killed.carrier || 0);
      return smallKills >= 3 || capKills >= 1;
    },
    apply: (rng, report, _run) => {
      // Variable: base 1-3 fighters, +1 per 4 small kills (max +2),
      // +1 per cap kill (max +2). Big scraps yield bigger salvage.
      const killed = report.killed || {};
      const smallKills = (killed.fighter || 0) + (killed.bomber || 0);
      const capKills = (killed.frigate || 0) + (killed.cruiser || 0) + (killed.battleship || 0) + (killed.carrier || 0);
      const fighters = Math.min(6,
        rollInt(rng, 1, 3) + Math.min(2, Math.floor(smallKills / 4)) + Math.min(2, capKills));
      const credits = rollInt(rng, 12, 28) + capKills * 8;
      return {
        headline: "SALVAGE OPERATION",
        body: (_pilot, reward) =>
          `Recovery team strips hostile hulks for parts. ${pluralize(reward.fighter, "refit fighter")} brought back online, plus ${reward.credits} credits in the till.`,
        reward: { fighter: fighters, credits },
        withPilot: false,
      };
    },
  },
  // Volunteer bomber pilots — fires on heavier battles. A dropped
  // pod-runner shows up with a wingmate.
  {
    type: "volunteer-bomber",
    weight: 2,
    requires: (report) => {
      const killed = report.killed || {};
      const capKills = (killed.frigate || 0) + (killed.cruiser || 0) + (killed.battleship || 0);
      return capKills >= 1;
    },
    apply: (rng, _report, _run) => {
      // Variable: 1-3 bombers + 0-2 escort fighters.
      const bombers = rollInt(rng, 1, 3);
      const fighters = rollInt(rng, 0, 2);
      return {
        headline: "VOLUNTEERS",
        body: (pilot, reward) => {
          const bLine = pluralize(reward.bomber, "bomber");
          const fLine = reward.fighter > 0
            ? `, plus ${pluralize(reward.fighter, "fighter")} riding escort`
            : "";
          return `${pilot} walks aboard with ${bLine}${fLine} from a stranded group. Asks where the pod racks are.`;
        },
        reward: { bomber: bombers, fighter: fighters },
        withPilot: true,
      };
    },
  },
  // Battlefield commission — RARE. A pilot is bumped to wing-lead and
  // brings a frigate refit + a fresh wing with them.
  {
    type: "commission",
    weight: 1,
    requires: (report, run) => {
      const killed = report.killed || {};
      const capKills = (killed.cruiser || 0) + (killed.battleship || 0);
      // Only after a real capital scrap, and only if the run has at
      // least one capital already (the line is real).
      return capKills >= 1 && (run.capitals || []).length >= 1;
    },
    apply: (rng, _report, _run) => {
      const pilot = rollPilotFull(rng);
      // Variable: 2-4 fighters + 0-2 bombers + 30-55 credits.
      const fighters = rollInt(rng, 2, 4);
      const bombers = rollInt(rng, 0, 2);
      const credits = rollInt(rng, 30, 55);
      return {
        headline: "BATTLEFIELD COMMISSION",
        body: (_pilot, reward) => {
          const wing = reward.bomber > 0
            ? `${pluralize(reward.fighter, "fighter")} and ${pluralize(reward.bomber, "bomber")}`
            : pluralize(reward.fighter, "fighter");
          return `${pilot} earns a frigate command for the breach. A surplus hull is signed over before the dust settles. ${wing} follow.`;
        },
        reward: { frigate: 1, fighter: fighters, bomber: bombers, credits },
        withPilot: false,
        bonusCapital: { klass: "frigate", captain: pilot },
      };
    },
  },
  // Commendation — credit bonus + fighters. Fires on clean wins
  // (no blue losses).
  {
    type: "commendation",
    weight: 2,
    requires: (report) => {
      const lost = report.lost || {};
      const totalLost = Object.values(lost).reduce((a, b) => a + b, 0);
      return totalLost === 0;
    },
    apply: (rng, _report, _run) => {
      // Variable: 2-4 fighters + 30-60 credits.
      const fighters = rollInt(rng, 2, 4);
      const credits = rollInt(rng, 30, 60);
      return {
        headline: "CITED FOR EFFICIENCY",
        body: (_pilot, reward) =>
          `Coalition Command notes a clean engagement. Hazard pay cleared (${reward.credits} cr) and ${pluralize(reward.fighter, "replacement fighter")} cycled in from the holding pattern.`,
        reward: { fighter: fighters, credits },
        withPilot: false,
      };
    },
  },
  // Defector — Hegemony pilot folds in with a wing. Fires on Hegemony-
  // faction battles.
  {
    type: "defector",
    weight: 2,
    requires: (report, run, node) => {
      return node && node.faction === "hegemony";
    },
    apply: (rng, _report, _run) => {
      const pilot = rollPilotFull(rng);
      // Variable: 2-4 captured Hegemony interceptors.
      const fighters = rollInt(rng, 2, 4);
      return {
        headline: "DEFECTION",
        body: (_pilot, reward) =>
          `${pilot} flies onto your line with ${pluralize(reward.fighter, "captured Hegemony interceptor")}. Insignia hidden, hands shaking.`,
        reward: { fighter: fighters },
        withPilot: false,
        rosterEntry: { name: pilot, role: "Defected pilot", tone: "ally" },
      };
    },
  },
  // Quiet step — wingmate transfer. Variable: 1-3 pilots filtering in.
  {
    type: "transfer",
    weight: 3,
    requires: () => true,
    apply: (rng, _report, _run) => {
      const fighters = rollInt(rng, 1, 3);
      return {
        headline: "TRANSFER ORDER",
        body: (pilot, reward) => {
          if (reward.fighter === 1) {
            return `${pilot} files in from Carrier flight ops. Spotted, briefed, in your wing.`;
          }
          const partnerCount = reward.fighter - 1;
          const partners = partnerCount === 1
            ? "their wingmate"
            : `${spellCount(partnerCount)} wingmates`;
          return `${pilot} and ${partners} file in from Carrier flight ops. Spotted, briefed, in your wing.`;
        },
        reward: { fighter: fighters },
        withPilot: true,
      };
    },
  },
];

// Pick a promotion archetype. Filters by `requires`, then weighted-
// random. Returns a normalized promotion object with rendered text.
function rollBattlefieldPromotion(run, node, report) {
  // Derive an RNG seed from run state + visited count so the same
  // node-clear shows the same promotion across re-syncs.
  const visitedCount = (run.visitedNodeIds || []).length;
  const seed = ((run.seed >>> 0) ^ (visitedCount * 1009) ^ ((node && node.id) || 0)) >>> 0;
  const localRng = mulberry32(seed || 1);

  const eligible = PROMOTION_ARCHETYPES.filter((a) => {
    try { return a.requires(report, run, node); }
    catch { return false; }
  });
  if (eligible.length === 0) {
    return {
      type: "recruit",
      headline: "WING REINFORCEMENT",
      body: "A fresh pilot reports in.",
      reward: { fighter: 1 },
      pilot: null,
    };
  }
  const totalWeight = eligible.reduce((a, b) => a + b.weight, 0);
  let pick = localRng() * totalWeight;
  let chosen = eligible[0];
  for (const a of eligible) {
    pick -= a.weight;
    if (pick <= 0) { chosen = a; break; }
  }

  const result = chosen.apply(localRng, report, run);
  // Reinforcements halved (tighter fleet economy now that craft cost 4×).
  // Done BEFORE the body is rendered so the prose count matches the
  // reward. Floor of 1 keeps a fired reinforcement from reading as zero;
  // a 0-count slot (e.g. escort fighters that didn't roll) stays 0.
  if (result.reward) {
    if (result.reward.fighter) result.reward.fighter = Math.max(1, Math.round(result.reward.fighter / 2));
    if (result.reward.bomber) result.reward.bomber = Math.max(1, Math.round(result.reward.bomber / 2));
  }
  const pilot = result.withPilot ? rollPilotFull(localRng) : null;
  // Body is a function (pilot, reward) so it can reference the
  // actual rolled count in prose ("Three canopies" vs "Two canopies").
  const renderedBody = typeof result.body === "function"
    ? result.body(pilot || "A wing pilot", result.reward || {})
    : (result.body || "");
  return {
    type: chosen.type,
    headline: result.headline,
    body: renderedBody,
    reward: result.reward || {},
    pilot,
    rosterEntry: result.rosterEntry || (pilot ? { name: pilot, role: "Wing pilot", tone: "ally" } : null),
    bonusCapital: result.bonusCapital || null,
  };
}

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
    title: "Fresh Wings",
    intro: "An active patrol sector and a clean slate. Command wants competence and your ship back in one piece.",
    promotionBlurb: null,
  },
  2: {
    rank: "Lieutenant",
    title: "Flight Leader",
    intro: "Lieutenant's bars. You route the local sector now, and you answer for whatever gets through it.",
    promotionBlurb: "For holding the outer fuel corridors against Reaver raiders. The frigate Sparrowhawk is attached to your flight.",
  },
  3: {
    rank: "Lt. Commander",
    title: "Strike Group Lead",
    intro: "A strike group of your own — capital frames and squadrons that live or die on your timing.",
    promotionBlurb: "For containing the border incursions when the line should have broken. A second frigate and the cruiser Andolin come under your command.",
  },
  4: {
    rank: "Captain",
    title: "Line Commander",
    intro: "Captain. This colonial sector turns on what you decide next — and you've just learned who's really running the war.",
    promotionBlurb: "For pulling intelligence out of a fight that should have killed you. The carrier Halcyon and battleship Iron Resolve are yours.",
  },
  5: {
    rank: "Admiral",
    title: "Fleet Command",
    intro: "Admiral. The outer colonies have one line left, and you're standing on it. One jump, one enemy.",
    promotionBlurb: "For command when there was no one left to command. The battleship Last Argument and carrier Sky-of-Iron join the line.",
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
    description: "Crimson Talon — a mining hull the Reavers bolted guns onto. Scrap-cannons that only work up close, a screen of fast interceptors, and a captain who'd rather ram than miss. Kill the engines first.",
    roster: { fighter: 14, bomber: 3, frigate: 1 },
  },
  2: {
    name: "ITN Severance",
    faction: "hegemony",
    description: "ITN Severance has parked across our jump lane and called it 'neutral security.' Heavy deflection plating, cold railgun crews, and a Hegemony captain who shells border colonies for practice. There's nothing left to say to her.",
    roster: { fighter: 10, bomber: 2, frigate: 2, cruiser: 1 },
  },
  3: {
    name: "Black Auriga",
    faction: "reavers",
    description: "The Black Auriga — a Terran cruiser the Reavers captured and turned. Still carries her Coalition missile racks, now wired to scavenged thermal boosters. She's hunting your strike group. We put our own iron down.",
    roster: { fighter: 18, bomber: 4, frigate: 2, cruiser: 1 },
  },
  4: {
    name: "ITN Eclipse",
    faction: "voidsworn",
    description: "First contact. The Eclipse was a Hegemony hull once — something gutted it and rebuilt the inside. It runs silent and fires a pulse that takes shields apart like they were never there.",
    roster: { fighter: 12, bomber: 4, frigate: 2, cruiser: 2, battleship: 1, carrier: 1 },
  },
  5: {
    name: "Apheliotrope",
    faction: "voidsworn",
    description: "The Apheliotrope, and the War-Queen aboard it. A living dreadnought that bends space around itself and flies a hundred drone-minds at once. Past her, there's nothing. The war ends here.",
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

// Per-act narrative preamble. Shown as a full-screen card at the
// start of each act — fresh run for Act 1, post-promotion for the
// rest. Reads like a war-bulletin paragraph framing what's at stake
// before the player tilts at the starmap. `flagLine(run)` returns
// an optional fourth line that reflects player choices so the
// briefing feels responsive across runs.
// ---------------------------------------------------------------------------
// Procedural rivals. At run start we roll 1-2 named adversaries drawn from
// faction-specific name templates + motivation pool. Rivals get slotted into
// elite encounters across the relevant acts; defeating one stamps its
// `status = "defeated"` flag, leaving it as a dossier memorial. Spared
// rivals can reappear in later acts via story-arc event cards.
//
// Shape: { id, name, faction, klass, motivation, actsActive: [act,...], status }
//   id          unique per run, stable across saves
//   actsActive  acts where this rival can roll into elite slots
//   status      "active" | "defeated" | "spared"
// ---------------------------------------------------------------------------

const RIVAL_NAME_POOLS = {
  reavers: {
    nicknames: ["Scrap", "Bone", "Black", "Iron", "Slag", "Carrion", "Razor", "Sump", "Hound", "Cinder"],
    surnames: ["Vekt", "Marrow", "Sovak", "Kell", "Drey", "Hask", "Vor", "Tane", "Skel", "Quell"],
    epithets: ["the Cleaver", "Bone-Pick", "the Unmasked", "Six-Eye", "the Patient", "Slipline"],
    style: "nickname",
  },
  hegemony: {
    ranks: ["Lt.", "Lt. Cmdr.", "Cmdr.", "Captain", "Sub-Lt."],
    surnames: ["Vassik", "Mirek", "Halse", "Tessen", "Korr", "Beladi", "Olsten", "Vehl", "Sereval", "Astren"],
    epithets: [],
    style: "rank-surname",
  },
  voidsworn: {
    titles: ["Adept", "Choir-master", "Sworn", "Voidcaller", "Censor", "Reader"],
    voidNames: ["Vael", "Esh", "Ner", "Thiol", "Sehl", "Yev", "Hax", "Oth", "Mira", "Surek"],
    epithets: ["of the Choir", "of the Long Silence", "Three-Tongue", "the Listener"],
    style: "title-name",
  },
  terran: {
    ranks: ["Lt.", "Capt.", "Cmdr."],
    surnames: ["Dane", "Holst", "Marrok", "Vance", "Soren", "Iverra"],
    epithets: [],
    style: "rank-surname",
  },
};

const RIVAL_MOTIVATIONS = {
  reavers: [
    "kin-debt sworn after a colony burn",
    "warlord's bounty under your callsign",
    "stolen Coalition transponder grudge",
    "trophy-hunt — your wing is the trophy",
  ],
  hegemony: [
    "ordered to neutralize a Coalition ace",
    "personal duel from a Hegemony academy washout",
    "doctrinal grudge over a Coalition broadcast",
    "tasked with proving Hegemony tactical superiority",
  ],
  voidsworn: [
    "marked you in the rite-book at a depth you cannot read",
    "hunts callsigns that survive first contact",
    "claims your hull will sing for the Choir",
    "carries a script with your name three times",
  ],
  terran: [
    "rival from your old squadron, jealousy gone septic",
    "veteran who blames you for an old friendly-fire incident",
  ],
};

const RIVAL_KLASS_PREFS = {
  reavers:   ["fighter", "fighter", "frigate", "cruiser"],
  hegemony:  ["frigate", "cruiser", "cruiser", "battleship"],
  voidsworn: ["cruiser", "battleship", "carrier", "frigate"],
  terran:    ["fighter", "frigate"],
};

const RIVAL_ACTS = {
  // Faction → list of acts where this rival is "active" enough to slot
  // into elite encounters. Reavers + Hegemony are early-mid war; Voidsworn
  // surface from Act 4 onward.
  reavers:   [1, 2, 3, 5],
  hegemony:  [2, 3, 4],
  voidsworn: [4, 5],
  terran:    [2, 3],
};

function rollRivalName(rng, faction) {
  const pool = RIVAL_NAME_POOLS[faction] || RIVAL_NAME_POOLS.reavers;
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  switch (pool.style) {
    case "nickname": {
      const useEpithet = pool.epithets.length > 0 && rng() < 0.30;
      if (useEpithet && rng() < 0.5) {
        return `${pick(pool.surnames)} ${pick(pool.epithets)}`;
      }
      return `"${pick(pool.nicknames)}" ${pick(pool.surnames)}`;
    }
    case "rank-surname":
      return `${pick(pool.ranks)} ${pick(pool.surnames)}`;
    case "title-name": {
      const useEpithet = pool.epithets.length > 0 && rng() < 0.40;
      const base = `${pick(pool.titles)} ${pick(pool.voidNames)}`;
      return useEpithet ? `${base} ${pick(pool.epithets)}` : base;
    }
    default:
      return "Unknown Threat";
  }
}

// Build a single rival entry. `faction` and `id` are required; the rest is
// rolled from the pools. The caller decides how many to roll and which
// factions — `startNewRun` rolls 2 by default (one early-war, one late-war).
function generateRival(rng, id, faction) {
  const klassList = RIVAL_KLASS_PREFS[faction] || RIVAL_KLASS_PREFS.reavers;
  const motivList = RIVAL_MOTIVATIONS[faction] || [];
  return {
    id,
    name: rollRivalName(rng, faction),
    faction,
    klass: klassList[Math.floor(rng() * klassList.length)],
    motivation: motivList[Math.floor(rng() * motivList.length)] || "unknown agenda",
    actsActive: [...(RIVAL_ACTS[faction] || [])],
    status: "active",
  };
}

// Roll a default-shape set of rivals: one early-war (Reaver or Hegemony),
// one late-war (Voidsworn). The rng is the same per-run mulberry32 used
// by act generation so the rival roster is deterministic per seed.
function generateRivalRoster(rng) {
  const earlyFaction = rng() < 0.55 ? "reavers" : "hegemony";
  const rivals = [
    generateRival(rng, "r1", earlyFaction),
    generateRival(rng, "r2", "voidsworn"),
  ];
  return rivals;
}

// Pull a still-active rival who can slot into the given act, or null.
// Used by generateAct to override the ace slot with a rival. Picks
// uniformly across matching active rivals — important when rivals'
// active-act sets overlap (e.g. a Reaver r1 + Voidsworn r2 both
// matching act 5). Defeated/spared rivals are excluded.
function findRivalForAct(run, actIndex, rng) {
  if (!run.rivals || run.rivals.length === 0) return null;
  const matches = run.rivals.filter(
    (r) => r.status === "active" && r.actsActive.includes(actIndex),
  );
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const pickRng = rng || Math.random;
  return matches[Math.floor(pickRng() * matches.length)];
}

// ---------------------------------------------------------------------------
// Inter-act radio dispatches. After the preamble dismisses, a short
// procedural transmission surfaces — a CO update, a friend hailing in,
// a Reaver intercept, or a Voidsworn signal. No choices; just a beat.
//
// Templates have `condition(run, act)` so flag-aware ones fire when the
// run state matches. `pickDispatch` picks one (or returns null) at boss-
// clear time and stashes onto `run.pendingDispatch`.
// ---------------------------------------------------------------------------

const DISPATCH_TEMPLATES = [
  // --- Frontier story-pass dispatches (act-gated + flag-gated). ---
  {
    speaker: "command",
    eyebrow: "INCOMING TRANSMISSION · SECTOR COMMAND",
    body: (run) => `Pilot Officer ${run.callsign}, your sector assignments are logged. Establish a clear perimeter and neutralize any raider signatures on sight. Out.`,
    condition: (run, act) => act === 1,
  },
  {
    speaker: "intel",
    eyebrow: "SECURE DATA CHANNEL · INTEL",
    body: (run) => `Be advised, ${run.callsign}. We are tracking unusual capital-class energy signatures near the Hegemony border lines. Keep your fleet tight.`,
    condition: (run, act) => act === 2,
  },
  {
    speaker: "friend",
    eyebrow: "SQUADRON LINK · SPARROWHAWK",
    body: (run) => `Hey, ${run.callsign}. Captain Voss is breathing down our necks today. Make sure your fighter wings are green before we cross the jump threshold.`,
    condition: (run, act) => act === 2 && run.flags.voss !== "antagonized",
  },
  {
    speaker: "enemy",
    eyebrow: "FREQUENCY INTERCEPT · REAVER CLAN",
    body: () => `Look at this Coalition convoy. Stretched out, thin, and totally soft. We are going to rip that lead ship apart and melt down the scrap metal.`,
    condition: (run, act) => act === 1 || act === 2,
  },
  {
    speaker: "command",
    eyebrow: "PRIORITY FLASH · ADMIRALTY",
    body: (run) => `Lieutenant Commander ${run.callsign}, the rogue cruiser Black Auriga has broken through the 3rd defense perimeter. Intercept and destroy at all costs.`,
    condition: (run, act) => act === 3,
  },
  {
    speaker: "friend",
    eyebrow: "TACTICAL CHANNEL · CARRIER HALCYON",
    body: (run) => `We're in position, ${run.callsign}. Our bombers move the moment you call the target.`,
    condition: (run, act) => act >= 3 && !!run.flags.coalitionFleet,
  },
  {
    speaker: "hegemony",
    eyebrow: "OPEN BROADCAST · HEGEMONY COMMAND",
    body: () => `This sector is under Imperial security administration. Coalition vessels without a registered visa will be fired on. There is no second warning.`,
    condition: (run, act) => act === 2 || act === 3,
  },
  {
    speaker: "intel",
    eyebrow: "ENCRYPTED BURST · INTEL",
    body: (run) => `Captain ${run.callsign}, those weren't pirate hulls. The debris from your last fight is full of alloy that isn't in any human catalogue. Watch yourself.`,
    condition: (run, act) => act === 4 && !run.flags.knowsVoidsworn,
  },
  {
    speaker: "voidsworn",
    eyebrow: "UNKNOWN SIGNATURE · THE CHOIR",
    body: () => `Such small things, clinging to your metal shells. The song is ending, Terrans. You will join the silence soon enough.`,
    condition: (run, act) => act >= 4 && !!run.flags.knowsVoidsworn,
  },
  {
    speaker: "command",
    eyebrow: "SUPREME COMMAND · OLYMPUS",
    body: (run) => `Admiral ${run.callsign}, you're the last command left standing in 4-G. Whatever you have to do out there, it's authorized.`,
    condition: (run, act) => act === 5,
  },
  {
    speaker: "friend",
    eyebrow: "TACTICAL NETWORK · BATTLESHIP IRON RESOLVE",
    body: () => `Main guns are hot, Admiral. Take point. We'll follow you into whatever she is.`,
    condition: (run, act) => act === 5 && !!run.flags.coalitionFleet,
  },
  {
    speaker: "intel",
    eyebrow: "QUANTUM INTERCEPT · ARCHIVE",
    body: () => `It checks out. Nine years of this war, all of it to pull our fleets off the core worlds. We were looking the wrong way the whole time.`,
    condition: (run, act) => act === 4 || act === 5,
  },
  {
    speaker: "enemy",
    eyebrow: "BROADCAST · BLACK AURIGA",
    body: () => `Coalition fleet, this is Captain Mara Voss. Your empire left us out here to die on the vine. Now, we are coming back to collect our due.`,
    condition: (run, act) => act === 3 && run.flags.voss === "antagonized",
  },
  {
    speaker: "friend",
    eyebrow: "NURSE FRIGATE · COALITION MED",
    body: (run) => `Your wingman's stable and back in a cockpit, ${run.callsign}. They've been telling the whole ready room they owe you one.`,
    condition: (run, act) => act >= 2 && !!run.flags.wingmanRescued,
  },
  {
    speaker: "hegemony",
    eyebrow: "DIPLOMATIC CORE · SECURE LINE",
    body: () => `We are prepared to offer you an official commission in the Imperial Service, Commander. Why burn out here for a dying bureaucracy?`,
    condition: (run, act) => act === 3 && !!run.flags.hegDefector,
  },
  {
    speaker: "intel",
    eyebrow: "URGENT TRANSMISSION · INTERNAL AFFAIRS",
    body: () => `Your recent operational actions violate standard engagement codes, Officer. A formal board of inquiry will await you after this deployment.`,
    condition: (run, act) => act >= 3 && !!run.flags.warCriminalStart,
  },

  // Universal Command beats.
  {
    speaker: "command",
    eyebrow: "INCOMING TRANSMISSION · COMMAND",
    body: (run) => `${run.callsign}, this is Frontier Command. The line held. Press the advantage.`,
    condition: () => true,
  },
  {
    speaker: "command",
    eyebrow: "INCOMING TRANSMISSION · COMMAND",
    body: (run) => `Coalition logistics confirmed your jump corridor. We have one extra day of fuel reserve. Use it.`,
    condition: (run) => run.resources && run.resources.fuel <= 4,
  },
  {
    speaker: "command",
    eyebrow: "INCOMING TRANSMISSION · COMMAND",
    body: () => "Tactical assessment in. The frontier has changed shape in the last cycle. Adapt.",
    condition: (run, act) => act >= 3,
  },

  // Friend / wingman beats.
  {
    speaker: "friend",
    eyebrow: "TIGHT-BEAM · WING ONE",
    body: (run) => `${run.flags.wingmanRescued || "Wing one"} flying close. The drinks I owe you are getting expensive.`,
    condition: (run) => run.flags && run.flags.wingmanRescued,
  },
  {
    speaker: "friend",
    eyebrow: "TIGHT-BEAM · OLD HAND",
    body: () => "A veteran from your academy class signals. They watched the boss kill on the strategic net. They thought you were dead two years ago.",
    condition: (run, act) => act === 3 || act === 4,
  },

  // Defector arc beats.
  {
    speaker: "ally",
    eyebrow: "ENCRYPTED CHANNEL · CONTACT",
    body: (run) => `${run.flags.defectorTrusted || "Your contact"} confirms the next sector is thinly held. Don't ask how they know.`,
    condition: (run) => run.flags && run.flags.defectorTrusted,
  },

  // Coalition support beats.
  {
    speaker: "command",
    eyebrow: "FLEETWIDE · COALITION",
    body: () => "Coalition battle group standing up. Your name's on the operations order. Don't waste the briefing.",
    condition: (run) => run.flags && run.flags.coalitionFleet,
  },

  // Reaver intercept beats.
  {
    speaker: "intercept",
    eyebrow: "INTERCEPTED HAIL · OPEN BAND",
    body: () => "Reaver chatter on open band, encrypted poorly. They are not coordinating — they are arguing.",
    condition: (run, act) => act <= 3,
  },
  {
    speaker: "intercept",
    eyebrow: "INTERCEPTED HAIL · BOUNTY POSTED",
    body: (run) => `Reaver bounty board updated: ${run.callsign}, alive if possible. They double the rate for "intact transponders".`,
    condition: (run) => run.flags && (run.flags.vendettaIgnored || run.flags.executedWoundedCapital),
  },

  // Voidsworn beats.
  {
    speaker: "voidsworn",
    eyebrow: "SIGNAL · CHOIR FRAGMENT",
    body: () => "A Voidsworn carrier-band signal cuts your comms for three seconds. Your callsign repeats in the static, in a voice you cannot place.",
    condition: (run, act) => act >= 4 && (!run.flags || !run.flags.knowsVoidsworn),
  },
  {
    speaker: "voidsworn",
    eyebrow: "SIGNAL · CHOIR FRAGMENT",
    body: () => "The Voidsworn signal is clearer now. You parse two words — your callsign and a number — before the band closes.",
    condition: (run, act) => act >= 4 && run.flags && run.flags.knowsVoidsworn,
  },

  // Engineering / logistics beats.
  {
    speaker: "engineering",
    eyebrow: "FLEET ENGINEERING",
    body: (run) => {
      const cap = (run.capitals || []).find((c) => c.hpFrac < 0.7);
      if (cap) {
        return `${cap.name || "Damaged capital"} reports hull-fracture stabilized. They want a quiet jump.`;
      }
      return "Engineering reports all systems within tolerance. Crews are tired but the line is green.";
    },
    condition: (run) => run.capitals && run.capitals.length > 0,
  },
  // Captain personality dispatches — pick up on the trait of a random
  // capital and surface it as flavor. Adds character to the named fleet.
  {
    speaker: "command",
    eyebrow: "FLEET CHATTER",
    body: (run) => {
      const cap = (run.capitals || []).find((c) => c.captainTrait === "aggressive");
      return cap ? `${cap.captain} on ${cap.name} broke formation early. Logged. Tolerated.` : "";
    },
    condition: (run) => (run.capitals || []).some((c) => c.captainTrait === "aggressive"),
  },
  {
    speaker: "command",
    eyebrow: "FLEET CHATTER",
    body: (run) => {
      const cap = (run.capitals || []).find((c) => c.captainTrait === "cautious");
      return cap ? `${cap.captain} on ${cap.name} requested permission to hold formation tighter. Granted.` : "";
    },
    condition: (run) => (run.capitals || []).some((c) => c.captainTrait === "cautious"),
  },
  {
    speaker: "command",
    eyebrow: "FLEET CHATTER",
    body: (run) => {
      const cap = (run.capitals || []).find((c) => c.captainTrait === "veteran");
      return cap ? `${cap.captain} on ${cap.name} flew this corridor in the last war. Their notes are sharper than the briefing.` : "";
    },
    condition: (run) => (run.capitals || []).some((c) => c.captainTrait === "veteran"),
  },
  {
    speaker: "voidsworn",
    eyebrow: "FLEET CHATTER",
    body: (run) => {
      const cap = (run.capitals || []).find((c) => c.captainTrait === "haunted");
      return cap ? `${cap.captain} on ${cap.name} keeps the bridge dark on long jumps. Their crew has stopped asking.` : "";
    },
    condition: (run, act) => act >= 4 && (run.capitals || []).some((c) => c.captainTrait === "haunted"),
  },
  {
    speaker: "engineering",
    eyebrow: "FLEET ENGINEERING",
    body: () => "Fuel reclamation up 4%. Whoever rewired the rectifiers is getting a commendation.",
    condition: (run) => run.resources && run.resources.fuel >= 5,
  },

  // Tribunal beats.
  {
    speaker: "command",
    eyebrow: "JAG · OBSERVATION",
    body: () => "Tribunal observer keeps a tab on your transponder. They have asked twice for your action log. Frame it well.",
    condition: (run) => run.flags && run.flags.warCriminalStart,
  },

  // Memorial / grief beats.
  {
    speaker: "friend",
    eyebrow: "CHAPLAIN'S LOG",
    body: () => "A chaplain at Ironholm reads names aloud at sunset. Yours is on the survival list. Some of your wing's are not.",
    condition: (run, act) => act === 4 || act === 5,
  },

  // Quiet-flavor beats (low priority — picked as fallback).
  {
    speaker: "command",
    eyebrow: "INCOMING TRANSMISSION",
    body: () => "Comms band is quiet. The Frontier is large; the war is not everywhere at once.",
    condition: () => true,
    flavor: true,
  },
  {
    speaker: "engineering",
    eyebrow: "DECK CHATTER",
    body: () => "A mechanic asks if you'll sign their helmet. You sign it.",
    condition: () => true,
    flavor: true,
  },
];

// Pick one dispatch for the given act. Returns null if none eligible —
// caller treats that as "no transmission this break". Picker is run+act
// deterministic so re-renders of the overlay show the same line.
export function pickDispatch(run, act) {
  if (!run) return null;
  const eligible = DISPATCH_TEMPLATES.filter((d) => {
    try { return d.condition(run, act); }
    catch { return false; }
  });
  const context = eligible.filter((d) => !d.flavor);
  const flavor = eligible.filter((d) => d.flavor);
  const pool = context.length > 0 ? context : flavor;
  if (pool.length === 0) return null;
  const seed = ((run.seed >>> 0) ^ (act * 9173)) >>> 0;
  const pickRng = mulberry32(seed || 1);
  const chosen = pool[Math.floor(pickRng() * pool.length)];
  const resolve = (v) => typeof v === "function" ? v(run) : v;
  return {
    act,
    speaker: chosen.speaker,
    eyebrow: chosen.eyebrow,
    text: resolve(chosen.body),
  };
}

export const ACT_PREAMBLES = {
  1: {
    eyebrow: "FRONTIER WARS · YEAR 9 · ACT I",
    title: "A Posting at the Edge",
    lines: [
      "Sector 4-G: loose radiation, burned-out colonies, bad jumps. Welcome to the edge.",
      "The Reavers are hitting the fuel lines in formation now. Pirates don't fly in formation.",
      "You're a fresh Pilot Officer. Keep your wing fueled, and watch the Hegemony 'observers' sitting on the line.",
    ],
    flagLine: (run) => run.flags.warCriminalStart
      ? "Your record came out here with you. Command reads your telemetry like a charge sheet."
      : "Your record's clean. Out here that lasts about a week.",
  },
  2: {
    eyebrow: "FRONTIER WARS · YEAR 9 · ACT II",
    title: "ACT II — Distant Friction",
    lines: [
      "Lieutenant's bars, and a frigate to lose. The border skirmishes are stacking up faster than Command will admit.",
      "Hegemony envoys have landed in-sector, escorted by iron cruisers. Cordial words, locked firing solutions.",
      "They call it regional stability. Their guns are ranged on our beacons.",
    ],
    flagLine: (run) => run.flags.voss === "antagonized"
      ? "Captain Mara Voss filed a memo on your conduct. It is not short."
      : null,
  },
  3: {
    eyebrow: "FRONTIER WARS · YEAR 9 · ACT III",
    title: "ACT III — The Broken Line",
    lines: [
      "Lieutenant Commander. A strike group is yours, and the line is coming apart under it.",
      "The Reavers punched through the outer grid with heavy ordnance they had no business owning.",
      "And they're running their comms through a Coalition cruiser. One of ours, turned.",
    ],
    flagLine: (run) => run.flags.wingmanRescued
      ? `Word from the med frigate: ${run.flags.wingmanRescued} is cleared for a cockpit again.`
      : "The missing-in-action list gets longer every cycle.",
  },
  4: {
    eyebrow: "FRONTIER WARS · YEAR 9 · ACT IV",
    title: "ACT IV — The Silent Architect",
    lines: [
      "Captain, the war's a lie. The signals under all of it don't belong to anyone human.",
      "Something has been feeding the Reavers and steering the Hegemony from the dark for years.",
      "They call themselves the Choir. We're calling them Voidsworn. They want us bled to nothing.",
    ],
    flagLine: (run) => run.flags.knowsVoidsworn
      ? "The decrypts hold up. The Voidsworn have been seeding this war for a decade."
      : "We're chasing something in the comms logs. It's been there the whole time.",
  },
  5: {
    eyebrow: "FRONTIER WARS · YEAR 9 · ACT V",
    title: "ACT V — Aphelion Horizon",
    lines: [
      "Admiral. The Fleet is shattered or out of position. What's left is you.",
      "The Voidsworn armada jumped straight into the rim's primary system. No warning, no screen.",
      "The War-Queen is broadcasting on every band we have. Stand by your guns.",
    ],
    flagLine: (run) => run.flags.coalitionFleet
      ? "What's left of the 4th Frontier Fleet has formed up on your flag."
      : "No one's coming. Make it count anyway.",
  },
};

// Per-act elite roster — punchier than trash, smaller than boss.
const ACT_ELITE_BASE = {
  1: { fighter: 4, bomber: 2, frigate: 1 },
  2: { fighter: 4, bomber: 2, frigate: 1, cruiser: 1 },
  3: { fighter: 6, bomber: 2, frigate: 2, cruiser: 1 },
  4: { fighter: 6, bomber: 3, frigate: 1, cruiser: 1, battleship: 1 },
  5: { fighter: 8, bomber: 3, frigate: 2, cruiser: 2, battleship: 1 },
};

// Named aces — per-act pool of distinctive elite encounters. A
// fraction of elite nodes (ACE_CHANCE) roll a random ace from the
// matching act tier. Picking an ace overrides node.faction +
// node.roster with the ace's bespoke values, so the encounter feels
// hand-authored rather than a stat-bumped trash wave.
//
// `roster` is consumed at 1x — bypassed by scaleRoster, mirroring
// BOSSES — so the table values are exactly what the player faces.
// Keep them between trash and boss in absolute power.
const ACE_CHANCE = 0.55;
export const ACT_ACES = {
  1: [
    {
      name: "\"Slag\" Vekan",
      faction: "reavers",
      description: "Reaver pirate flying a fighter rebuilt from gunship scrap. Loud and erratic.",
      roster: { fighter: 5, bomber: 1, frigate: 1 },
    },
    {
      name: "Lt. Kress",
      faction: "hegemony",
      description: "Hegemony scout, methodical patrol pattern. Reports your position in real time.",
      roster: { fighter: 4, bomber: 2, frigate: 1 },
    },
  ],
  2: [
    {
      name: "The Banshee",
      faction: "reavers",
      description: "Laughs on open comms while firing. Three of her wingmen survive on average.",
      roster: { fighter: 6, bomber: 2, frigate: 1, cruiser: 1 },
    },
    {
      name: "Cmdr. Halse",
      faction: "hegemony",
      description: "Crisp-uniform veteran. Cancels overlaps before they form.",
      roster: { fighter: 4, bomber: 1, frigate: 2, cruiser: 1 },
    },
  ],
  3: [
    {
      name: "Ironjaw",
      faction: "reavers",
      description: "Carries trophy plating from three Terran captains. Hull is a confession.",
      roster: { fighter: 7, bomber: 3, frigate: 2, cruiser: 1 },
    },
    {
      name: "Cmdr. Tessen",
      faction: "hegemony",
      description: "Logistics officer turned tactical. Reads your supply lines like an open book.",
      roster: { fighter: 5, bomber: 2, frigate: 2, cruiser: 1, battleship: 1 },
    },
  ],
  4: [
    {
      name: "Black-Tongue",
      faction: "voidsworn",
      description: "Wears scavenged Sparrowhawk paint. The mockery is the message.",
      roster: { fighter: 7, bomber: 3, frigate: 1, cruiser: 2, battleship: 1 },
    },
    {
      name: "Adept Yev",
      faction: "voidsworn",
      description: "Speaks only in scripture. Battle hymn audible eight thousand meters out.",
      roster: { fighter: 9, bomber: 2, frigate: 2, cruiser: 2, battleship: 1 },
    },
  ],
  5: [
    {
      name: "Voidcaller Sehl",
      faction: "voidsworn",
      description: "Apheliotrope's lash. Survived sky-tomb three times. Won't be a fourth.",
      roster: { fighter: 8, bomber: 4, frigate: 2, cruiser: 2, battleship: 1 },
    },
    {
      name: "The Quiet Captain",
      faction: "voidsworn",
      description: "Voice never logged. Pattern never repeats. Carrier-led, never seen alone.",
      roster: { fighter: 10, bomber: 3, frigate: 2, cruiser: 1, carrier: 1 },
    },
  ],
};

// ---------------------------------------------------------------------------
// Battle banter — comms snippets shown on the battle-choice briefing.
// Each entry has a `condition(run, node)` that decides if it can roll,
// a `speaker` tag for UI styling, and a `text` template (string or fn).
// `pickBattleBanter` returns up to 2 entries per battle; one of them may
// be flavor-only (always-eligible), the other is condition-gated.
//
// New lines belong in BATTLE_BANTER. Adding a tag-only line is cheap;
// add a condition only when you want the line gated.
// ---------------------------------------------------------------------------

const BATTLE_BANTER = [
  // --- Frontier story-pass banter (act + faction + flag gated). ---
  { speaker: "command", text: "All fighters, maintain defensive formation. Do not chase targets past the primary flak perimeter.",
    condition: (run, node) => run.act === 1 },
  { speaker: "reavers", text: "Break their line! Tear down their communication masts and drag their fighters into the scrap yard!",
    condition: (run, node) => node.faction === "reavers" },
  { speaker: "hegemony", text: "Stand down. This is a lawful security action. Surrender your ships and no one has to file a casualty report.",
    condition: (run, node) => node.faction === "hegemony" },
  { speaker: "wingman", text: "I've got an enemy bandit sitting right on my tail! I can't shake them! Requesting immediate support!",
    condition: (run, node) => node.type === "battle" && !run.flags.wingmanRescued },
  { speaker: "wingman", text: (run) => `Form up on my wing, ${run.callsign}. Let's show these raider bastards how the Frontier Service handles business.`,
    condition: (run, node) => node.type === "battle" && !!run.flags.wingmanRescued },
  { speaker: "intercept", text: "Hostile capital frame is target locked. All bombers, deliver your heavy munitions payload now!",
    condition: (run, node) => node.type === "boss" },
  { speaker: "reavers", text: "You killed my wing-mate at the outer jump gate! I'm going to carve your callsign into my hull!",
    condition: (run, node) => node.type === "boss" && run.act === 1 },
  { speaker: "hegemony", text: "The Terran Coalition is an outdated relic. Your colonial sectors now belong to the Empire.",
    condition: (run, node) => node.type === "boss" && run.act === 2 },
  { speaker: "intercept", text: "The Black Auriga is turning its main batteries directly toward our lead carrier hull! Move, move!",
    condition: (run, node) => node.type === "boss" && run.act === 3 },
  { speaker: "voidsworn", text: "The flesh screams so loudly. Silence will wash over this system. The Choir commands it.",
    condition: (run, node) => node.faction === "voidsworn" || (run.act === 4 && node.type === "boss") },
  { speaker: "voidsworn", text: "We are the Apheliotrope. We are the final note of the song. Dissolve into the dark.",
    condition: (run, node) => run.act === 5 && node.type === "boss" },
  { speaker: "command", text: "Concentrate fire on the central glowing core! Their bio-shields are dipping on that vector!",
    condition: (run, node) => run.act >= 4 && node.faction === "voidsworn" },
  { speaker: "hegemony", text: "You should have accepted our agent's deal when you had the chance. Now, look at your burning fleet.",
    condition: (run, node) => node.faction === "hegemony" && !!run.flags.sa_spyglass_declined },
  { speaker: "reavers", text: "Those are our codeframes on your guns! Who sold us out?! I'll find him after I find you!",
    condition: (run, node) => node.faction === "reavers" && !!run.flags.sa_broker_overclocked },
  { speaker: "command", text: "The ship bulkheads are holding under the alien pressure wave. Keep the engines firing at full thrust!",
    condition: (run, node) => run.act === 5 && !!run.flags.sa_discipline_cleared },
  { speaker: "voidsworn", text: "We hear the acoustic echoes inside your computers. You invited us straight into your home.",
    condition: (run, node) => node.faction === "voidsworn" && !!run.flags.sa_choir_infected },

  // Boss-fight lines.
  { speaker: "command", text: "Apheliotrope's lash is on the line. Make it the last one.",
    condition: (run, node) => node.type === "boss" && run.act === 5 },
  { speaker: "command", text: "Eclipse signature confirmed. Mind the carrier — it deploys past visual.",
    condition: (run, node) => node.type === "boss" && run.act === 4 },
  { speaker: "wingman", text: "I've got your six. Don't make me write the letter, sir.",
    condition: (run, node) => node.type === "boss" && run.act >= 3 },
  { speaker: "command", text: "Severance is here for the line officers. Don't be one when she leaves.",
    condition: (run, node) => node.type === "boss" && run.act === 2 },
  { speaker: "command", text: "Crimson Talon's the easy fight. He just doesn't know it yet.",
    condition: (run, node) => node.type === "boss" && run.act === 1 },

  // Ace-intercept lines.
  { speaker: "command", text: "Ace pilot, named target. Coalition rules of engagement do not apply.",
    condition: (run, node) => !!node.aceName && !node.rivalId },
  { speaker: "wingman", text: "I'll draw fire. You get the kill.",
    condition: (run, node) => !!node.aceName },

  // Rival-specific lines (rivalId present means it's a procedural marked target).
  { speaker: "command", text: (run, node) => `Marked target on intercept. Your callsign is in their flight plan.`,
    condition: (run, node) => !!node.rivalId },
  { speaker: "wingman", text: "They came for you specifically. Make it personal.",
    condition: (run, node) => !!node.rivalId },

  // Faction-flavor lines on bosses + aces.
  { speaker: "voidsworn", text: "The Choir reads your transponder.",
    condition: (run, node) => node.faction === "voidsworn" && (node.type === "boss" || !!node.aceName) },
  { speaker: "intercept", text: "Reaver chatter on open band. They are not coordinating.",
    condition: (run, node) => node.faction === "reavers" && node.type === "battle" },

  // Resource warnings.
  { speaker: "command", text: "Fuel reads tight. If this fight stretches we will have to abandon assets to RTB.",
    condition: (run, node) => run.resources && run.resources.fuel <= 2 && run.act >= 2 },
  { speaker: "command", text: "Capital strength is critical. Lose one more and the line breaks.",
    condition: (run, node) => run.capitals && run.capitals.length <= 1 && run.act >= 3 },

  // Vendetta arc callbacks.
  { speaker: "intercept", text: "Reaver bounty acknowledged. They want this one clean.",
    condition: (run, node) => run.flags && run.flags.vendettaIgnored && node.faction === "reavers" },
  { speaker: "wingman", text: "The vendetta-sworn is in this wave. Stay tight.",
    condition: (run, node) => run.flags && run.flags.vendettaHunted && node.faction === "reavers" },

  // Ally support callbacks.
  { speaker: "ally", text: "Coalition wing is en route. Hold the line.",
    condition: (run, node) => run.flags && run.flags.coalitionFleet && node.type === "boss" },
  { speaker: "wingman", text: (run) => `${run.flags && run.flags.wingmanRescued ? run.flags.wingmanRescued : "Wingman"} reports ready.`,
    condition: (run, node) => run.flags && run.flags.wingmanRescued },

  // Intel hooks (bossWeakened, knowsVoidsworn).
  { speaker: "command", text: "Forward intel: target is running below strength. Press them.",
    condition: (run, node) => run.flags && run.flags.bossWeakened && (node.type === "boss" || !!node.aceName) },
  { speaker: "command", text: "Voidsworn signal patterns parsed. Your spread will hit better today.",
    condition: (run, node) => run.flags && run.flags.knowsVoidsworn && node.faction === "voidsworn" },

  // Tribunal / warCriminalStart callbacks.
  { speaker: "command", text: "Tribunal observer is reading this fight. Earn the file.",
    condition: (run, node) => run.flags && run.flags.warCriminalStart },

  // Defector arc callbacks.
  { speaker: "ally", text: (run) => {
      const name = (run.flags && run.flags.defectorTrusted) || "Your contact";
      return `${name} is feeding live targeting. The reads are good.`;
    },
    condition: (run, node) => run.flags && run.flags.defectorTrusted && node.type === "boss" },

  // Always-eligible flavor (low priority — picked only as the second slot).
  { speaker: "wingman", text: "Wing is green. Call it.", condition: () => true, flavor: true },
  { speaker: "command", text: "Comms clean. We're listening.", condition: () => true, flavor: true },
  { speaker: "wingman", text: "Engines hot. Awaiting your mark.", condition: () => true, flavor: true },
  { speaker: "intercept", text: "Their formation hasn't decided what kind of fight this is.", condition: () => true, flavor: true },
  { speaker: "command", text: "Win or run. Either way, win.", condition: () => true, flavor: true },
];

// Pick up to 2 banter entries for this battle. Priority is:
//   1. The highest-priority context line (non-flavor) that passes condition.
//   2. One flavor line at random.
// We resolve `text` against the run+node before returning so the
// caller renders ready-to-display strings.
export function pickBattleBanter(run, node) {
  if (!run || !node) return [];
  const eligible = BATTLE_BANTER.filter((b) => {
    try { return b.condition(run, node); }
    catch { return false; }
  });
  const context = eligible.filter((b) => !b.flavor);
  const flavor = eligible.filter((b) => b.flavor);
  const out = [];
  const seed = (run.seed ^ (node.id || 0)) >>> 0;
  const localRng = mulberry32(seed || 1);
  const resolve = (txt) => typeof txt === "function" ? txt(run, node) : txt;
  if (context.length > 0) {
    const pick = context[Math.floor(localRng() * context.length)];
    out.push({ speaker: pick.speaker, text: resolve(pick.text) });
  }
  if (flavor.length > 0 && out.length < 2) {
    const pick = flavor[Math.floor(localRng() * flavor.length)];
    out.push({ speaker: pick.speaker, text: resolve(pick.text) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Procedural story arcs. Each arc is a 3-stage questline whose stages
// live in EVENT_CARDS with `arcKey` + `arcStage` metadata. At run start,
// `seedRunArcs` picks 1-2 arcs into `run.arcs`. When generating an
// event node, generateAct prefers arc cards over generic events if any
// active arc has its next stage available for this act.
//
// Arc cards advance the arc's stageIndex in their `apply` via
// `advanceArc(run, arcKey)`. That gates the next stage's precondition.
//
// Arcs are PROCEDURAL because the slot data (npc name, ship name) is
// rolled at seed time from the rival/name pools, so two runs with the
// same arc tell the same beats with different names.
// ---------------------------------------------------------------------------

const ARC_DEFINITIONS = {
  "defector": {
    title: "The Defector",
    description: "A Hegemony pilot offers intel. Whether you trust them shapes the late war.",
    slot: (rng) => ({
      npcName: rollRivalName(rng, "hegemony"),
      shipName: "ITN " + ["Vector", "Garnet", "Lyre", "Cinder", "Tessellate"][Math.floor(rng() * 5)],
    }),
  },
  "vendetta": {
    title: "The Vendetta",
    description: "A surviving Reaver swears your callsign onto their blade.",
    slot: (rng) => ({
      npcName: rollRivalName(rng, "reavers"),
    }),
  },
  "lost-carrier": {
    title: "The Lost Carrier",
    description: "A distress beacon from a Coalition carrier that was logged destroyed.",
    slot: (rng) => ({
      shipName: "ITN " + ["Hyperion", "Marrow", "Sablework", "Verity", "Foretold"][Math.floor(rng() * 5)],
    }),
  },
  "choir-relic": {
    title: "The Choir's Eye",
    description: "A Voidsworn relic falls into your possession. Study it, or be rid of it.",
    slot: (rng) => ({
      npcName: rollRivalName(rng, "voidsworn"),
    }),
  },
  "sa_spyglass": {
    title: "Project Spyglass",
    description: "A deep-space Hegemony intelligence asset is monitoring local fleet movements.",
    slot: (rng) => {
      const names = ["Vane", "Kore", "Tariq"];
      const ships = ["Vector", "Garnet", "Lyre"];
      return {
        npcName: names[Math.floor(rng() * names.length)],
        shipName: "ITN " + ships[Math.floor(rng() * ships.length)],
      };
    },
  },
  "sa_vanguard_ghost": {
    title: "The Ghost of Year 3",
    description: "Investigate a high-frequency tracking beacon from an old, missing Coalition patrol group.",
    slot: (rng) => ({
      shipName: "CSV " + ["Venture", "Dauntless", "Stalwart"][Math.floor(rng() * 3)],
      sectorNum: Math.floor(rng() * 800) + 100,
    }),
  },
  "sa_reaver_broker": {
    title: "The Scrap Broker",
    description: "A black-market Reaver tech-merchant is looking to trade forbidden military codeframes.",
    slot: (rng) => ({
      npcName: ["Skar", "Zane", "Triggs"][Math.floor(rng() * 3)],
      stationName: "Outpost " + ["9-B", "Omega", "Rust-Mile"][Math.floor(rng() * 3)],
    }),
  },
  "sa_choir_echo": {
    title: "The Harmonic Resonance",
    description: "Your ship components are experiencing unexplained acoustic vibrations and power drains.",
    slot: (rng) => ({
      frequency: (rng() * 400 + 100).toFixed(2) + " MHz",
      component: ["Comms Array", "Hyperdrive Core", "Shield Matrix"][Math.floor(rng() * 3)],
    }),
  },
  "sa_iron_discipline": {
    title: "The Iron Inspector",
    description: "A strict Logistics Adjutant from High Command is auditing fleet efficiency.",
    slot: (rng) => ({
      npcName: "Adjutant " + ["Vance", "Kroll", "Sterling"][Math.floor(rng() * 3)],
      shuttleName: "CSV " + ["Audit", "Lexicon", "Veritas"][Math.floor(rng() * 3)],
    }),
  },
};

// Pick 1-2 arcs at run start. Each entry stores its slot data and a
// stageIndex (0 = first stage unfired). Arcs are seed-deterministic.
function seedRunArcs(rng) {
  const keys = Object.keys(ARC_DEFINITIONS);
  // Always at least one, occasionally two.
  const count = rng() < 0.55 ? 1 : 2;
  const shuffled = [...keys].sort(() => rng() - 0.5);
  return shuffled.slice(0, count).map((key) => ({
    key,
    stageIndex: 0,
    slot: ARC_DEFINITIONS[key].slot(rng),
  }));
}

// Called by arc-card `apply` callbacks to step the arc forward. Reads
// the arc by key and bumps stageIndex by 1. If the arc has no more
// stages, it stays at the final index — precondition checks won't
// match anymore.
function advanceArc(run, arcKey) {
  if (!run.arcs) return;
  const arc = run.arcs.find((a) => a.key === arcKey);
  if (arc) arc.stageIndex = arc.stageIndex + 1;
}

// Arc precondition helper — true if the run has the named arc active
// at exactly the requested stage. Used inside event card precondition
// callbacks to gate them to the right point in the questline.
function isArcAt(run, arcKey, stageIndex) {
  if (!run || !run.arcs) return false;
  return run.arcs.some((a) => a.key === arcKey && a.stageIndex === stageIndex);
}

// Read arc slot data (NPC name, ship name, etc.) into a card body /
// title. Cards use this in their text via inline substitution.
function arcSlot(run, arcKey) {
  if (!run || !run.arcs) return {};
  const arc = run.arcs.find((a) => a.key === arcKey);
  return (arc && arc.slot) || {};
}

// Force-close any arc stage whose actTags window has passed. Called
// on every act transition (boss clear) so a player who skipped event
// nodes in cols 1-2 still gets the arc beats — just narrated as
// off-screen resolution log entries instead of a card choice. Without
// this, arcs would silently stall and the player would never see the
// payoff for choices they made earlier in the run.
function closeOrphanedArcStages(run, completedAct) {
  if (!run || !Array.isArray(run.arcs)) return;
  for (const arc of run.arcs) {
    // Find the currently-pending stage card for this arc.
    const card = EVENT_CARDS.find(
      (c) => c.arcKey === arc.key && c.arcStage === arc.stageIndex,
    );
    if (!card) continue;
    const maxTag = (card.actTags || []).reduce((a, b) => Math.max(a, b), 0);
    if (maxTag <= 0) continue;
    // If we just cleared the last act in the window, the arc never
    // got to fire. Force-apply the first eligible option as a remote
    // resolution, then advance the arc.
    if (maxTag <= completedAct) {
      // Card titles + bodies may be functions (dynamic via arcSlot).
      // Resolve to a string before logging so the log doesn't read
      // as a function source.
      const titleStr = typeof card.title === "function" ? card.title(run) : (card.title || arc.key);
      const opt = card.options.find((o) => !o.precondition || o.precondition(run))
               || card.options[0];
      if (opt) {
        try {
          const result = opt.apply(run);
          appendRunLog(run, "arc", `${titleStr} resolves off-screen. ${result || ""}`.trim());
        } catch (_e) {
          appendRunLog(run, "arc", `${titleStr} resolves off-screen.`);
        }
      }
    }
  }
}

// Event card catalogue. Each card has 2-3 buttons. Each button's `apply`
// receives the live run and mutates it directly; the controller persists
// after every node clear.
//
// `actTags` (optional) filters which acts a card can roll on. Absent
// means "any act". Used to seed rank-appropriate flavor — rookie
// hazing cards in Act 1, war-hero cameos in Act 5, etc.
//
// `arcKey` + `arcStage` (optional): marks a card as part of a procedural
// story arc. `precondition` is set so the card only rolls when the run's
// arc is at the matching stage. Card text reads slot data via `arcSlot`
// at render time, so two runs with the same arc see different NPC names.
export const EVENT_CARDS = [
  // ===================================================================
  // Story-arc + standalone cards (Frontier story pass). Arc stages are
  // gated by isArcAt; standalone cards by actTags. See ARC_DEFINITIONS.
  // ===================================================================

  // --- ARC: sa_spyglass ---
  {
    id: "sa-spyglass-0", arcKey: "sa_spyglass", arcStage: 0, actTags: [1, 2],
    precondition: (run) => isArcAt(run, "sa_spyglass", 0),
    title: "The Shadowing Cruiser",
    body: (run) => {
      const slot = arcSlot(run, "sa_spyglass");
      return `The Hegemony scout vessel ${slot.shipName}, commanded by Agent ${slot.npcName}, is trailing your fleet just outside weapon range. They offer a secure data link.`;
    },
    options: [
      {
        label: "Accept the data link (+40 credits)",
        apply: (run) => {
          run.resources.credits += 40;
          run.flags.sa_spyglass_deal = true;
          advanceArc(run, "sa_spyglass");
          return "You take the feed. The credits are real. So is the sense of being watched.";
        },
      },
      {
        label: "Jam their sensors (1 Fuel)",
        apply: (run) => {
          run.resources.fuel = Math.max(0, run.resources.fuel - 1);
          run.flags.sa_spyglass_declined = true;
          advanceArc(run, "sa_spyglass");
          return "You burn fuel to blind their arrays. They peel off into the dark.";
        },
      },
    ],
  },
  {
    id: "sa-spyglass-1", arcKey: "sa_spyglass", arcStage: 1, actTags: [2, 3],
    precondition: (run) => isArcAt(run, "sa_spyglass", 1),
    title: "The Encrypted Grid",
    body: (run) => {
      const slot = arcSlot(run, "sa_spyglass");
      return run.flags.sa_spyglass_deal
        ? `The feed from ${slot.shipName} points to a hidden Reaver weapon depot. It also carries a Hegemony tracking routine buried under the data.`
        : `${slot.shipName} turns up on your sweeps again — this time broadcasting your coordinates to every raider band in range.`;
    },
    options: [
      {
        label: "Use the data to raid the depot (+4 Fighters)",
        precondition: (run) => !!run.flags.sa_spyglass_deal,
        apply: (run) => {
          run.smallCraft.fighter = Math.min(60, run.smallCraft.fighter + 4);
          run.flags.sa_spyglass_trusted = true;
          advanceArc(run, "sa_spyglass");
          return "The depot's abandoned. You pull flyable fighters out of it — and the tracer stays live in your network.";
        },
      },
      {
        label: "Purge the tracker from your systems",
        precondition: (run) => !!run.flags.sa_spyglass_deal,
        apply: (run) => {
          run.flags.sa_spyglass_secured = true;
          advanceArc(run, "sa_spyglass");
          return "Your comms officer scrubs the routine. The depot coordinates go with it. Clean network, empty hands.";
        },
      },
      {
        label: "Hunt the scout ship down",
        precondition: (run) => !!run.flags.sa_spyglass_declined,
        apply: (run) => {
          run.flags.sa_spyglass_hunted = true;
          advanceArc(run, "sa_spyglass");
          return "A short, ugly fight and they run. They won't be selling your position for a while.";
        },
      },
    ],
  },
  {
    id: "sa-spyglass-2", arcKey: "sa_spyglass", arcStage: 2, actTags: [3, 4],
    precondition: (run) => isArcAt(run, "sa_spyglass", 2),
    title: "Spyglass Payoff",
    body: (run) => {
      const slot = arcSlot(run, "sa_spyglass");
      if (run.flags.sa_spyglass_trusted) return `The tracer cuts both ways. Hegemony ships drop out of warp to 'assist' — and to take operational authority while they're here.`;
      if (run.flags.sa_spyglass_secured) return `Your clean network catches a Hegemony transmission they didn't mean you to hear. It's about something moving out past the rim.`;
      return `Agent ${slot.npcName} sends one last message before leaving the sector for good: something is coming, and it's bigger than any of this.`;
    },
    options: [
      {
        label: "Comply for security (+20% lead-capital hull)",
        precondition: (run) => !!run.flags.sa_spyglass_trusted && run.capitals.length > 0,
        apply: (run) => {
          if (run.capitals.length > 0) run.capitals[0].hpFrac = Math.min(1.0, run.capitals[0].hpFrac + 0.2);
          advanceArc(run, "sa_spyglass");
          return "Hegemony mechanics patch up your lead ship, but they copy your navigation logs.";
        },
      },
      {
        label: "Analyze the alien data logs",
        precondition: (run) => !!run.flags.sa_spyglass_secured,
        apply: (run) => {
          run.flags.knowsVoidsworn = true;
          advanceArc(run, "sa_spyglass");
          return "The logs are full of hull plans for ships no shipyard ever built. Organic. The Choir is real.";
        },
      },
      {
        label: "Dismiss the warning and salvage their buoy (+30 credits)",
        apply: (run) => {
          run.resources.credits += 30;
          advanceArc(run, "sa_spyglass");
          return "You strip the buoy for scrap and move on. The stars stay quiet. For now.";
        },
      },
    ],
  },

  // --- ARC: sa_vanguard_ghost ---
  {
    id: "sa-ghost-0", arcKey: "sa_vanguard_ghost", arcStage: 0, actTags: [1, 2],
    precondition: (run) => isArcAt(run, "sa_vanguard_ghost", 0),
    title: "The Old Beacon",
    body: (run) => {
      const slot = arcSlot(run, "sa_vanguard_ghost");
      return `Your navigation array locks onto a military emergency beacon transmitting from a dead sector. It matches the signature of ${slot.shipName}, missing since Year 3.`;
    },
    options: [
      {
        label: "Investigate the coordinates (1 Fuel)",
        apply: (run) => {
          run.resources.fuel = Math.max(0, run.resources.fuel - 1);
          run.flags.sa_ghost_investigated = true;
          advanceArc(run, "sa_vanguard_ghost");
          return "You drop out of warp near a dense debris field. The beacon is close.";
        },
      },
      {
        label: "Ignore the old signal",
        apply: (run) => {
          advanceArc(run, "sa_vanguard_ghost");
          advanceArc(run, "sa_vanguard_ghost");
          advanceArc(run, "sa_vanguard_ghost");
          return "You leave the dead patrol to the dark. There's a war to fight today.";
        },
      },
    ],
  },
  {
    id: "sa-ghost-1", arcKey: "sa_vanguard_ghost", arcStage: 1, actTags: [2, 3],
    precondition: (run) => isArcAt(run, "sa_vanguard_ghost", 1),
    title: "The Venture's Logbook",
    body: (run) => {
      const slot = arcSlot(run, "sa_vanguard_ghost");
      return `You find the frozen frame of ${slot.shipName}. There are no weapon marks on the hull. The flight logs show the crew intentionally overloaded their own reactor after hearing a 'melodic hum' from Sector ${slot.sectorNum}.`;
    },
    options: [
      {
        label: "Download the acoustic telemetry data",
        apply: (run) => {
          run.flags.sa_ghost_has_hum = true;
          advanceArc(run, "sa_vanguard_ghost");
          return "You copy the recording. Whatever it is, it keeps time.";
        },
      },
      {
        label: "Purge the corrupted drive logs",
        apply: (run) => {
          run.flags.sa_ghost_purged = true;
          advanceArc(run, "sa_vanguard_ghost");
          return "You wipe the drive before whatever's on it spreads. Some things shouldn't be archived.";
        },
      },
    ],
  },
  {
    id: "sa-ghost-2", arcKey: "sa_vanguard_ghost", arcStage: 2, actTags: [3, 4, 5],
    precondition: (run) => isArcAt(run, "sa_vanguard_ghost", 2),
    title: "The Echoing Frequency",
    body: (run) => run.flags.sa_ghost_has_hum
      ? "On a quiet shift the dead ship's recording starts playing itself across your internal comms. No one queued it."
      : "You run the old patrol's hull data against your own ships. The metal matches nothing in the catalog.",
    options: [
      {
        label: "Decode the hum — it matches Voidsworn signatures",
        precondition: (run) => !!run.flags.sa_ghost_has_hum,
        apply: (run) => {
          run.flags.knowsVoidsworn = true;
          advanceArc(run, "sa_vanguard_ghost");
          return "You match the hum to the dead crew's last logs. It's a targeting hymn — and it isn't human.";
        },
      },
      {
        label: "Scrap the remaining data profiles (+50 credits)",
        apply: (run) => {
          run.resources.credits += 50;
          advanceArc(run, "sa_vanguard_ghost");
          return "You sell the salvaged flight data to a logistics hub and put the dead ship behind you.";
        },
      },
    ],
  },

  // --- ARC: sa_reaver_broker ---
  {
    id: "sa-broker-0", arcKey: "sa_reaver_broker", arcStage: 0, actTags: [1, 2, 3],
    precondition: (run) => isArcAt(run, "sa_reaver_broker", 0),
    title: "The Illegal Blueprint",
    body: (run) => {
      const slot = arcSlot(run, "sa_reaver_broker");
      return `A transmission clears your encryption firewall. It is a Reaver deserter named ${slot.npcName} operating from ${slot.stationName}. They are offering stolen fleet codeframes.`;
    },
    options: [
      {
        label: "Buy the codeframes (Cost: 30 credits)",
        precondition: (run) => run.resources.credits >= 30,
        apply: (run) => {
          run.resources.credits -= 30;
          run.flags.sa_broker_hired = true;
          advanceArc(run, "sa_reaver_broker");
          return "You download an unverified blueprint array for heavy capital ship weapon modifications.";
        },
      },
      {
        label: "Report their coordinates to High Command",
        apply: (run) => {
          run.flags.sa_broker_arrested = true;
          advanceArc(run, "sa_reaver_broker");
          return "You forward the coordinates. Fleet security dispatches an enforcement detail immediately.";
        },
      },
    ],
  },
  {
    id: "sa-broker-1", arcKey: "sa_reaver_broker", arcStage: 1, actTags: [2, 3, 4],
    precondition: (run) => isArcAt(run, "sa_reaver_broker", 1),
    title: "Overclocking the Matrix",
    body: (run) => run.flags.sa_broker_hired
      ? "The stolen codeframes work — too well. Your engineering grids run hot enough to scare the crew that signed off on them."
      : "A courier brings a commendation from High Command for turning in the dealer. The paperwork is its own reward, apparently.",
    options: [
      {
        label: "Overclock weapon systems (Cost: 1 Bomber)",
        precondition: (run) => !!run.flags.sa_broker_hired && run.smallCraft.bomber >= 1,
        apply: (run) => {
          run.smallCraft.bomber -= 1;
          run.flags.sa_broker_overclocked = true;
          advanceArc(run, "sa_reaver_broker");
          return "You strip a bomber's core to feed the main guns. They hit harder now. The bomber doesn't fly again.";
        },
      },
      {
        label: "Run the codeframes at stable parameters",
        precondition: (run) => !!run.flags.sa_broker_hired,
        apply: (run) => {
          run.flags.sa_broker_stable = true;
          advanceArc(run, "sa_reaver_broker");
          return "You keep only the gains that won't cook the reactor. Modest, and they hold.";
        },
      },
      {
        label: "Claim the official reward (+20 credits, +1 Fuel)",
        precondition: (run) => !!run.flags.sa_broker_arrested,
        apply: (run) => {
          run.resources.credits += 20;
          run.resources.fuel += 1;
          advanceArc(run, "sa_reaver_broker");
          return "The fleet drops off ordnance and fresh fuel as a thank-you.";
        },
      },
    ],
  },
  {
    id: "sa-broker-2", arcKey: "sa_reaver_broker", arcStage: 2, actTags: [3, 4, 5],
    precondition: (run) => isArcAt(run, "sa_reaver_broker", 2),
    title: "Broker's Legacy",
    body: (run) => {
      if (run.flags.sa_broker_overclocked) return "Mid-patrol the modified grid redlines — then dumps the surge into a defensive field instead of your reactor. Luck, not design.";
      if (run.flags.sa_broker_stable) return "The codeframes settle into your targeting computers without complaint.";
      return "The enforcement detail you tipped off sends an escort to ride your line for a while.";
    },
    options: [
      {
        label: "Divert energy to strike craft (+3 Fighters)",
        precondition: (run) => !!run.flags.sa_broker_overclocked,
        apply: (run) => {
          run.smallCraft.fighter = Math.min(60, run.smallCraft.fighter + 3);
          advanceArc(run, "sa_reaver_broker");
          return "The discharge floods the launch bays. You scramble extra fighters straight off it.";
        },
      },
      {
        label: "Deploy precise targeting data (+1 Bomber)",
        precondition: (run) => !!run.flags.sa_broker_stable,
        apply: (run) => {
          run.smallCraft.bomber = Math.min(20, run.smallCraft.bomber + 1);
          advanceArc(run, "sa_reaver_broker");
          return "The targeting profile's good enough to justify building another bomber around it.";
        },
      },
      {
        label: "Accept temporary tactical escorts (+15 credits)",
        apply: (run) => {
          run.resources.credits += 15;
          advanceArc(run, "sa_reaver_broker");
          return "The escort detail leaves a stipend for the trouble.";
        },
      },
    ],
  },

  // --- ARC: sa_choir_echo ---
  {
    id: "sa-choir-0", arcKey: "sa_choir_echo", arcStage: 0, actTags: [2, 3],
    precondition: (run) => isArcAt(run, "sa_choir_echo", 0),
    title: "The Acoustic Anomaly",
    body: (run) => {
      const slot = arcSlot(run, "sa_choir_echo");
      return `Your engineering chief reports a steady hum coming off the ${slot.component}, holding at ${slot.frequency}. Nothing aboard will dampen it.`;
    },
    options: [
      {
        label: "Isolate and monitor the frequency",
        apply: (run) => {
          run.flags.sa_choir_monitored = true;
          advanceArc(run, "sa_choir_echo");
          return "You set a continuous log on it. The resonance has a cadence — almost like voices.";
        },
      },
      {
        label: "Insulate the component with heavy shields (Cost: 20 cr)",
        precondition: (run) => run.resources.credits >= 20,
        apply: (run) => {
          run.resources.credits -= 20;
          run.flags.sa_choir_shielded = true;
          advanceArc(run, "sa_choir_echo");
          return "You pack the housing until it's quiet. Engineering goes back to normal. Mostly.";
        },
      },
    ],
  },
  {
    id: "sa-choir-1", arcKey: "sa_choir_echo", arcStage: 1, actTags: [3, 4],
    precondition: (run) => isArcAt(run, "sa_choir_echo", 1),
    title: "The Dreamers",
    body: (run) => run.flags.sa_choir_monitored
      ? "The deckhands watching the frequency are all dreaming the same thing — a dark star. They're getting slower. Quieter."
      : "The insulation holds. Then the same signature comes back off a nearby asteroid field, louder than before.",
    options: [
      {
        label: "Let the crew continue their research logs",
        precondition: (run) => !!run.flags.sa_choir_monitored,
        apply: (run) => {
          run.flags.sa_choir_infected = true;
          advanceArc(run, "sa_choir_echo");
          return "The files balloon — page after page of geometry that doesn't follow human math.";
        },
      },
      {
        label: "Quarantine the affected personnel immediately",
        precondition: (run) => !!run.flags.sa_choir_monitored,
        apply: (run) => {
          run.flags.sa_choir_contained = true;
          advanceArc(run, "sa_choir_echo");
          return "You seal the subsystem and reassign the crew. The dreams stop. So does any record of them.";
        },
      },
      {
        label: "Investigate the asteroid echoes (+1 Fuel)",
        precondition: (run) => !!run.flags.sa_choir_shielded,
        apply: (run) => {
          run.resources.fuel += 1;
          advanceArc(run, "sa_choir_echo");
          return "It's a reflection off a hydrogen pocket in a thermal vent. You tap it for fuel and tell yourself that's all it was.";
        },
      },
    ],
  },
  {
    id: "sa-choir-2", arcKey: "sa_choir_echo", arcStage: 2, actTags: [4, 5],
    precondition: (run) => isArcAt(run, "sa_choir_echo", 2),
    title: "The Choir's Embrace",
    body: (run) => (run.flags.sa_choir_infected && run.flags.knowsVoidsworn)
      ? "The geometry your crew transcribed is the formation pattern of the Voidsworn armada now closing on you. It was a map the whole time."
      : "The resonance finally dies, leaving a crystalline residue caked into the filters.",
    options: [
      {
        label: "Upload the geometry to targeting systems (+2 Bombers)",
        precondition: (run) => !!run.flags.sa_choir_infected && !!run.flags.knowsVoidsworn,
        apply: (run) => {
          run.smallCraft.bomber = Math.min(20, run.smallCraft.bomber + 2);
          advanceArc(run, "sa_choir_echo");
          return "Your bombers can read the alien vanguard's warp pattern now. They'll get inside it.";
        },
      },
      {
        label: "Refine the structural residue for components (+40 credits)",
        apply: (run) => {
          run.resources.credits += 40;
          advanceArc(run, "sa_choir_echo");
          return "You scrape the crystal out of the filters and sell it. No one asks what it is.";
        },
      },
    ],
  },

  // --- ARC: sa_iron_discipline ---
  {
    id: "sa-discipline-0", arcKey: "sa_iron_discipline", arcStage: 0, actTags: [2, 3],
    precondition: (run) => isArcAt(run, "sa_iron_discipline", 0),
    title: "The Surprise Audit",
    body: (run) => {
      const slot = arcSlot(run, "sa_iron_discipline");
      return `The shuttle ${slot.shuttleName} drops out of warp and requests docking clearance. ${slot.npcName} is aboard to run an unannounced efficiency audit on your fleet.`;
    },
    options: [
      {
        label: "Enforce strict regulatory compliance",
        apply: (run) => {
          run.flags.sa_discipline_strict = true;
          advanceArc(run, "sa_iron_discipline");
          return "You have the crew open every locker and lay out every fuel log. By the book, line by line.";
        },
      },
      {
        label: "Offer an 'operational hospitality' stipend (Cost: 20 cr)",
        precondition: (run) => run.resources.credits >= 20,
        apply: (run) => {
          run.resources.credits -= 20;
          run.flags.sa_discipline_pragmatic = true;
          advanceArc(run, "sa_iron_discipline");
          return "The inspector spends the audit admiring your wardroom and never opens the weapon logs.";
        },
      },
    ],
  },
  {
    id: "sa-discipline-1", arcKey: "sa_iron_discipline", arcStage: 1, actTags: [3, 4],
    precondition: (run) => isArcAt(run, "sa_iron_discipline", 1),
    title: "The Disciplinary Review",
    body: (run) => {
      const slot = arcSlot(run, "sa_iron_discipline");
      return run.flags.sa_discipline_strict
        ? `${slot.npcName} flags three minor discrepancies and, grudgingly, your devotion to the regulations.`
        : `${slot.npcName} signs a clean review and leaves. Your crew can move things around again.`;
    },
    options: [
      {
        label: "Request additional standard munitions (+2 Fighters)",
        precondition: (run) => !!run.flags.sa_discipline_strict,
        apply: (run) => {
          run.smallCraft.fighter = Math.min(60, run.smallCraft.fighter + 2);
          run.flags.sa_discipline_cleared = true;
          advanceArc(run, "sa_iron_discipline");
          return "Going by the book earns you a resupply voucher. Cash it before someone reconsiders.";
        },
      },
      {
        label: "Use the clean report to requisition fuel (+2 Fuel)",
        precondition: (run) => !!run.flags.sa_discipline_pragmatic,
        apply: (run) => {
          run.resources.fuel += 2;
          run.flags.sa_discipline_blackmarket = true;
          advanceArc(run, "sa_iron_discipline");
          return "With the inspectors looking the other way, a fuel transport quietly tops off your tanks.";
        },
      },
    ],
  },
  {
    id: "sa-discipline-2", arcKey: "sa_iron_discipline", arcStage: 2, actTags: [4, 5],
    precondition: (run) => isArcAt(run, "sa_iron_discipline", 2),
    title: "The Inspector's Report",
    body: (run) => run.flags.sa_discipline_cleared
      ? "Your clean logs move your strike group up the list for reinforcements."
      : "The loose books from earlier give your engineers room to do work no one signed off on.",
    options: [
      {
        label: "Accept the priority fleet reinforcement (+1 Bomber)",
        precondition: (run) => !!run.flags.sa_discipline_cleared,
        apply: (run) => {
          run.smallCraft.bomber = Math.min(20, run.smallCraft.bomber + 1);
          advanceArc(run, "sa_iron_discipline");
          return "A fresh bomber off the line is delivered to your hangar.";
        },
      },
      {
        label: "Reinforce capital bulkheads (+20% lead-capital hull)",
        precondition: (run) => run.capitals.length > 0,
        apply: (run) => {
          if (run.capitals.length > 0) run.capitals[0].hpFrac = Math.min(1.0, run.capitals[0].hpFrac + 0.2);
          advanceArc(run, "sa_iron_discipline");
          return "Your crew welds extra plating over the lead ship's spine, from metal that isn't on any manifest.";
        },
      },
      {
        label: "Convert excess records to scrap value (+30 credits)",
        apply: (run) => {
          run.resources.credits += 30;
          advanceArc(run, "sa_iron_discipline");
          return "You sell off outdated logistics records on the side for quick credits.";
        },
      },
    ],
  },

  // --- Standalone act-tagged cards ---
  {
    id: "sa-standalone-1", actTags: [1, 2],
    title: "The Floating Armory",
    body: "An abandoned Coalition freighter drifts dark and quiet. The cargo seals are blown wide open.",
    options: [
      { label: "Salvage standard fighter hulls (+2 Fighters)", apply: (run) => { run.smallCraft.fighter = Math.min(60, run.smallCraft.fighter + 2); return "Your deck crew pulls two flyable fighter frames out of the hold."; } },
      { label: "Drain the primary fuel manifolds (+1 Fuel)", apply: (run) => { run.resources.fuel += 1; return "You siphon a clean capsule of fuel before the wreck drifts off."; } },
    ],
  },
  {
    id: "sa-standalone-2", actTags: [1, 2, 3],
    title: "The Hegemony Border Toll",
    body: "A Hegemony barge slides across the jump gate and demands a 'navigation maintenance tax' to let you through.",
    options: [
      { label: "Pay the required transaction fee (Cost: 20 credits)", precondition: (run) => run.resources.credits >= 20, apply: (run) => { run.resources.credits -= 20; return "The barge drops its weapon locks and sends the jump keys. Robbery with paperwork."; } },
      { label: "Circumnavigate the gate entirely (Cost: 1 Fuel)", precondition: (run) => run.resources.fuel >= 1, apply: (run) => { run.resources.fuel -= 1; return "You burn the fuel and slip around their patrol the long way."; } },
    ],
  },
  {
    id: "sa-standalone-3", actTags: [1, 2, 3],
    title: "The Reaver Defector's Request",
    body: "A scarred Reaver pilot in an escape pod begs asylum, and offers up the coordinates of a soft transport convoy to buy it.",
    options: [
      { label: "Trust their intel and raid the lane (+40 credits)", apply: (run) => { run.resources.credits += 40; run.flags.hegDefector = true; return "The intel's good. You take a fat Reaver supply haul; the pilot's gone by morning."; } },
      { label: "Turn them over to the nearest penal colony (+1 Fuel)", apply: (run) => { run.resources.fuel += 1; return "The colonial magistrate thanks you for going by the book and hands over a fuel barrel."; } },
    ],
  },
  {
    id: "sa-standalone-4", actTags: [2, 3],
    title: "The Damaged Vanguard",
    body: "A friendly Coalition frigate limps across your path, chewed up by missile fire and out of everything that fixes a hull.",
    options: [
      { label: "Provide engineering assistance (Cost: 20 credits)", precondition: (run) => run.resources.credits >= 20, apply: (run) => { run.resources.credits -= 20; run.flags.coalitionFleet = true; return "Their captain salutes over the link and says they won't forget it. People rarely do, out here."; } },
      { label: "Offer emergency flight fuel (Cost: 1 Fuel)", precondition: (run) => run.resources.fuel >= 1, apply: (run) => { run.resources.fuel -= 1; run.smallCraft.fighter = Math.min(60, run.smallCraft.fighter + 1); return "They trade a spare fighter out of their hangar for the fuel to limp home."; } },
      { label: "Wish them luck and secure your own line", apply: () => "You hold your heading. Out here the math doesn't leave much room for charity." },
    ],
  },
  {
    id: "sa-standalone-5", actTags: [2, 3, 4],
    title: "The Thren Hive Fragment",
    body: "A dead Thren bio-ship drifts past your flagship, still glowing faintly somewhere deep inside its open ribs.",
    options: [
      { label: "Harvest the organic material for resale (+35 credits)", apply: (run) => { run.resources.credits += 35; return "Your hazard team cuts chemical nodes out of the frame and sells them to a colony lab."; } },
      { label: "Incinerate the hull from orbit", apply: () => "You burn it to ash before anyone asks what it might be carrying." },
    ],
  },
  {
    id: "sa-standalone-6", actTags: [2, 3],
    title: "The Automated Relic",
    body: "Sensors flag a pre-war satellite turning slow and silent. Its data banks are ancient, and still reading.",
    options: [
      { label: "Extract the navigational star maps (+1 Fuel)", apply: (run) => { run.resources.fuel += 1; return "The old orbital data hides a couple of sub-warp shortcuts nobody's used in years."; } },
      { label: "Scrap the satellite's core processor (+15 credits)", apply: (run) => { run.resources.credits += 15; return "You strip the palladium contacts and bank them."; } },
    ],
  },
  {
    id: "sa-standalone-7", actTags: [3, 4],
    title: "The Rogue Comm Station",
    body: "There's a comm station buried in a hollowed-out comet, off every registry, pushing encrypted military traffic.",
    options: [
      { label: "De-crypt the broadcast stream", apply: (run) => { run.flags.knowsVoidsworn = true; return "The traffic plots something enormous moving in the deep dark. Whatever the Choir is, it's been listening the whole time."; } },
      { label: "Shatter the comet with heavy ordnance", apply: () => "One kinetic strike and the comet's gone. Whatever it was saying, it stops." },
    ],
  },
  {
    id: "sa-standalone-8", actTags: [3, 4],
    title: "The Stranded Fleet Courier",
    body: "A Coalition intelligence courier sits dead in space with a cooked hyperdrive, carrying something High Command wants badly.",
    options: [
      { label: "Tow the courier vessel to safety (Cost: 1 Fuel)", precondition: (run) => run.resources.fuel >= 1, apply: (run) => { run.resources.fuel -= 1; run.resources.credits += 50; return "You haul them to the next outpost. The courier pays well for the lift."; } },
      { label: "Transfer their secure files electronically", apply: (run) => { run.flags.bossWeakened = true; return "You pull their files through your mainframe. The enemy dispositions ahead suddenly look a lot less mysterious."; } },
    ],
  },
  {
    id: "sa-standalone-9", actTags: [3],
    title: "The Black Auriga's Trail",
    body: "You come on a burning merchant caravan. The last distress call names the attacker: the rogue cruiser Black Auriga.",
    options: [
      { label: "Follow the thermal warp signature", apply: (run) => { run.flags.vendettaHunted = true; return "You lock onto the drive trail. The stolen cruiser has a head start and nothing else."; } },
      { label: "Prioritize salvaging the survivors (+20 credits)", apply: (run) => { run.resources.credits += 20; run.flags.vendettaIgnored = true; return "You stop to pull survivors out of the fire. The Auriga slips deeper into the nebula while you do."; } },
    ],
  },
  {
    id: "sa-standalone-10", actTags: [4, 5],
    title: "The Void-Matter Fissure",
    body: "You drop out of warp onto an open rift, tearing the local asteroids apart one at a time.",
    options: [
      { label: "Analyze the rift's non-human origin (+1 Bomber)", precondition: (run) => !!run.flags.knowsVoidsworn, apply: (run) => { run.smallCraft.bomber = Math.min(20, run.smallCraft.bomber + 1); return "The gravity readings off the rift sharpen your bombers' run profiles."; } },
      { label: "Skirt the anomaly carefully (Cost: 1 Fuel)", precondition: (run) => run.resources.fuel >= 1, apply: (run) => { run.resources.fuel -= 1; return "You burn extra fuel to give the rift a wide berth and keep the fleet in one piece."; } },
    ],
  },
  {
    id: "sa-standalone-11", actTags: [4, 5],
    title: "The Mutinous Core",
    body: "The alien threat is grinding the crew down. A handful of technicians have barricaded themselves in the engine room.",
    options: [
      { label: "Resolve the dispute with a pragmatic compromise", apply: (run) => { run.resources.credits = Math.max(0, run.resources.credits - 15); return "You promise hazard pay at the next port. They don't believe you, but they go back to work."; } },
      { label: "Vent the auxiliary corridors to break the seal", apply: (run) => { run.flags.warCriminalStart = true; if (run.capitals.length > 0) run.capitals[0].hpFrac = Math.max(0.1, run.capitals[0].hpFrac - 0.1); return "You flood the maintenance tubes with nitrogen. The mutiny ends inside a minute. Not everyone walks out."; } },
    ],
  },
  {
    id: "sa-standalone-12", actTags: [4, 5],
    title: "The Shattered Colony Ship",
    body: "A civilian colony transport hangs dead ahead, cut clean in half by a beam that didn't waste a second shot.",
    options: [
      { label: "Scan for any signs of human life (+1 Fighter)", apply: (run) => { run.smallCraft.fighter = Math.min(60, run.smallCraft.fighter + 1); return "You find one live pod. The scout inside has flown this frontier longer than you have."; } },
      { label: "Salvage remaining life support fuel (+1 Fuel)", apply: (run) => { run.resources.fuel += 1; return "You pump the wreck's auxiliary lines dry before it drifts off."; } },
    ],
  },
  {
    id: "sa-standalone-13", actTags: [5],
    title: "The Lost Supply Depot",
    body: "A bunker buried in a dead moon answers your old security code. Inside: logistics frames no one's touched in years.",
    options: [
      { label: "Requisition full munitions payload (+3 Fighters, +1 Bomber)", apply: (run) => { run.smallCraft.fighter = Math.min(60, run.smallCraft.fighter + 3); run.smallCraft.bomber = Math.min(20, run.smallCraft.bomber + 1); return "The loader arms run unattended, racking fresh strike craft straight onto your tracks."; } },
      { label: "Empty the station's strategic cash reserve (+60 credits)", apply: (run) => { run.resources.credits += 60; return "You move the bunker's old reserve straight into operations."; } },
    ],
  },
  {
    id: "sa-standalone-14", actTags: [5],
    title: "The War-Queen's Broadcast",
    body: "Apheliotrope's voice comes through every speaker on the ship at once. The volume controls do nothing.",
    options: [
      { label: "Broadcast a defiant military counter-signal", apply: () => "You jam the Coalition march over her frequency. The crew picks it up. The static breaks." },
      { label: "Cut power to the main comms array entirely", apply: () => "You kill the comms array fleet-wide. The deck goes silent, and stays yours." },
    ],
  },

  {
    id: "derelict-freighter",
    title: "Derelict Freighter",
    body: "A drifting hulk hangs in the dark. Salvage rights are unclear.",
    options: [
      {
        label: "Salvage plating (+20% hull on a random capital)",
        apply: (run) => {
          if (run.capitals.length === 0) return "Fleet empty.";
          const idx = Math.floor(safeRng(run) * run.capitals.length);
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
          const cs = names[Math.floor(safeRng(run) * names.length)];
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
          const cs = names[Math.floor(safeRng(run) * names.length)];
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
          const idx = Math.floor(safeRng(run) * run.capitals.length);
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
          // The old grudge can resurface. Burned-bridge fires later.
          scheduleFollowup(run, "burned-bridge-followup", 5, "voss-briefing");
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
          run.capitals.push(makeNamedCapital("frigate", run.nextInstanceId++, Math.random));
          run.capitals.push(makeNamedCapital("cruiser", run.nextInstanceId++, Math.random));
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
          const idx = Math.floor(safeRng(run) * run.capitals.length);
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
          run.capitals.push(makeNamedCapital("frigate", run.nextInstanceId++, Math.random));
          run.capitals.push(makeNamedCapital("frigate", run.nextInstanceId++, Math.random));
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
            const idx = Math.floor(safeRng(run) * run.capitals.length);
            run.capitals[idx].hpFrac = Math.max(0.05, run.capitals[idx].hpFrac - 0.25);
            return `Charges detonate on the ${run.capitals[idx].klass}. They got the last laugh.`;
          } else {
            run.capitals.push(makeNamedCapital("cruiser", run.nextInstanceId++, Math.random));
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
  // -------------------------------------------------------------------------
  // Procedural story-arc stages. Each one is gated by `precondition` so it
  // only rolls when run.arcs has the matching arc at the matching stage.
  // `apply` callbacks call `advanceArc(run, arcKey)` to move the arc on.
  // Card titles/bodies are functions of run so they read the procedural
  // slot data (NPC names, ship names) at render time.
  // -------------------------------------------------------------------------

  // === "The Defector" — 3 stages ==========================================
  {
    id: "arc-defector-1",
    arcKey: "defector", arcStage: 0,
    actTags: [1, 2],
    precondition: (run) => isArcAt(run, "defector", 0),
    title: () => "Encrypted Hail",
    body: (run) => {
      const s = arcSlot(run, "defector");
      return `${s.npcName} hails from a damaged Hegemony patrol. They claim to want out and offer fleet positions in exchange for refuge.`;
    },
    options: [
      {
        label: "Trust them. Give them safe passage.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.defectorTrusted = arcSlot(run, "defector").npcName;
          run.resources.credits += 10;
          advanceArc(run, "defector");
          return "They will remember. Intel pending.";
        },
      },
      {
        label: "Detain them. Sell them up the chain.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.defectorBetrayed = arcSlot(run, "defector").npcName;
          run.resources.credits += 80;
          advanceArc(run, "defector");
          return "Credits in. They were not surprised.";
        },
      },
      {
        label: "Refuse. Let them run.",
        apply: (run) => {
          // Arc fizzles — advance past all stages so it stops rolling.
          if (run.arcs) {
            const arc = run.arcs.find((a) => a.key === "defector");
            if (arc) arc.stageIndex = 99;
          }
          return "They drift away. The signal cuts mid-word.";
        },
      },
    ],
  },
  {
    id: "arc-defector-2",
    arcKey: "defector", arcStage: 1,
    actTags: [3, 4],
    precondition: (run) => isArcAt(run, "defector", 1),
    title: () => "The Defector Reports",
    body: (run) => {
      const s = arcSlot(run, "defector");
      if (run.flags && run.flags.defectorTrusted) {
        return `${s.npcName} sends a tight-beam packet from deep Hegemony space. They have a route through a Voidsworn picket line. The data is dense.`;
      }
      return `Reaver chatter intercepts ${s.npcName}'s execution order. Whatever you sold to your contact, the Hegemony bought it back at a premium. The Reavers know your route.`;
    },
    options: [
      {
        label: "Act on the intel.",
        precondition: (run) => run.flags && run.flags.defectorTrusted,
        apply: (run) => {
          run.flags.bossWeakened = true;
          run.flags.knowsVoidsworn = true;
          advanceArc(run, "defector");
          return "The Coalition gets there first. Score one.";
        },
      },
      {
        label: "Brace for harassment.",
        precondition: (run) => run.flags && run.flags.defectorBetrayed,
        apply: (run) => {
          run.resources.fuel = Math.max(0, run.resources.fuel - 2);
          advanceArc(run, "defector");
          return "The Reaver intercept costs you fuel. The lesson is free.";
        },
      },
    ],
  },
  {
    id: "arc-defector-3",
    arcKey: "defector", arcStage: 2,
    actTags: [4, 5],
    precondition: (run) => isArcAt(run, "defector", 2),
    title: () => "End of the Wire",
    body: (run) => {
      const s = arcSlot(run, "defector");
      if (run.flags && run.flags.defectorTrusted) {
        return `${s.npcName} arrives with a Hegemony cruiser flying Coalition colors. They want to fight at your side for the finale.`;
      }
      return `${s.npcName} appears on intercept vectors. They are not asking questions this time.`;
    },
    options: [
      {
        label: "Welcome them aboard.",
        precondition: (run) => run.flags && run.flags.defectorTrusted,
        apply: (run) => {
          run.flags.coalitionFleet = true;
          run.smallCraft.fighter = Math.min(MAX_FIGHTERS, run.smallCraft.fighter + 4);
          advanceArc(run, "defector");
          return "Their wing folds into yours. They fly the lead.";
        },
      },
      {
        label: "Engage and end it.",
        precondition: (run) => run.flags && run.flags.defectorBetrayed,
        apply: (run) => {
          run.resources.credits += 60;
          advanceArc(run, "defector");
          return "It ends quickly. Their last word is your name, said clearly.";
        },
      },
    ],
  },

  // === "The Vendetta" — 3 stages ===========================================
  {
    id: "arc-vendetta-1",
    arcKey: "vendetta", arcStage: 0,
    actTags: [1, 2],
    precondition: (run) => isArcAt(run, "vendetta", 0),
    title: () => "A Reaver Who Lived",
    body: (run) => {
      const s = arcSlot(run, "vendetta");
      return `Survey wreckage from your last patrol. One pilot lived: ${s.npcName}. Their broadcast contains your callsign and a vow.`;
    },
    options: [
      {
        label: "Hunt them now.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.vendettaHunted = true;
          run.resources.fuel = Math.max(0, run.resources.fuel - 1);
          advanceArc(run, "vendetta");
          return "You waste one fuel running them down. They escape with a smaller crew.";
        },
      },
      {
        label: "Ignore the broadcast.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.vendettaIgnored = true;
          advanceArc(run, "vendetta");
          return "The signal fades. You hope.";
        },
      },
    ],
  },
  {
    id: "arc-vendetta-2",
    arcKey: "vendetta", arcStage: 1,
    actTags: [3, 4],
    precondition: (run) => isArcAt(run, "vendetta", 1),
    title: () => "The Bounty Spreads",
    body: (run) => {
      const s = arcSlot(run, "vendetta");
      if (run.flags && run.flags.vendettaHunted) {
        return `${s.npcName} has put a smaller bounty on you, having seen what you can do. Reaver patrols thin near your routes.`;
      }
      return `${s.npcName}'s bounty has matured. Every Reaver in this sector is watching your transponder.`;
    },
    options: [
      {
        label: "Acknowledge the pressure.",
        apply: (run) => {
          if (run.flags && run.flags.vendettaIgnored) {
            run.flags.bossWeakened = false;
            run.resources.credits = Math.max(0, run.resources.credits - 20);
            advanceArc(run, "vendetta");
            return "The bounty bites. You pay in tribute, not coin.";
          }
          run.flags = run.flags || {};
          run.flags.veteranIntel = true;
          advanceArc(run, "vendetta");
          return "Coalition intel reads the bounty's edges. You see them coming.";
        },
      },
    ],
  },
  {
    id: "arc-vendetta-3",
    arcKey: "vendetta", arcStage: 2,
    actTags: [5],
    precondition: (run) => isArcAt(run, "vendetta", 2),
    title: () => "The Vow Closes",
    body: (run) => {
      const s = arcSlot(run, "vendetta");
      return `${s.npcName} has joined the Apheliotrope's screen. They are not fighting for the Voidsworn. They are fighting for you.`;
    },
    options: [
      {
        label: "Make it personal.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.vendettaResolved = true;
          run.resources.credits += 40;
          advanceArc(run, "vendetta");
          return "You will know them by their flight pattern. Make the meeting count.";
        },
      },
    ],
  },

  // === "The Lost Carrier" — 3 stages =======================================
  {
    id: "arc-carrier-1",
    arcKey: "lost-carrier", arcStage: 0,
    actTags: [1, 2],
    precondition: (run) => isArcAt(run, "lost-carrier", 0),
    title: () => "Beacon From a Ghost",
    body: (run) => {
      const s = arcSlot(run, "lost-carrier");
      return `A Coalition distress beacon repeats from a dead drift point. The transponder reads ${s.shipName} — a carrier logged destroyed eleven months ago.`;
    },
    options: [
      {
        label: "Investigate the beacon.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.carrierBeaconChecked = true;
          run.resources.fuel = Math.max(0, run.resources.fuel - 1);
          advanceArc(run, "lost-carrier");
          return "You burn one fuel for the detour. The wreck is intact and cold.";
        },
      },
      {
        label: "Mark and continue.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.carrierBeaconSkipped = true;
          if (run.arcs) {
            const arc = run.arcs.find((a) => a.key === "lost-carrier");
            if (arc) arc.stageIndex = 99;
          }
          return "You log the position and burn through. Someone else's problem.";
        },
      },
    ],
  },
  {
    id: "arc-carrier-2",
    arcKey: "lost-carrier", arcStage: 1,
    actTags: [3, 4],
    precondition: (run) => isArcAt(run, "lost-carrier", 1),
    title: () => "What the Carrier Held",
    body: (run) => {
      const s = arcSlot(run, "lost-carrier");
      return `Salvage analysis on ${s.shipName} comes back. The hull is rewired with components you do not recognize. Voidsworn signatures, dated before first contact.`;
    },
    options: [
      {
        label: "Pass the data to Coalition intel.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.knowsVoidsworn = true;
          run.resources.credits += 30;
          advanceArc(run, "lost-carrier");
          return "Coalition R&D begins reverse-engineering. They send you credits and silence.";
        },
      },
      {
        label: "Keep the data quiet.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.carrierSecret = true;
          advanceArc(run, "lost-carrier");
          return "You carry the file in a locked drawer. It feels heavier than its mass.";
        },
      },
    ],
  },
  {
    id: "arc-carrier-3",
    arcKey: "lost-carrier", arcStage: 2,
    actTags: [4, 5],
    precondition: (run) => isArcAt(run, "lost-carrier", 2),
    title: () => "The Carrier Returns",
    body: (run) => {
      const s = arcSlot(run, "lost-carrier");
      return `${s.shipName} is in the Apheliotrope's escort line, flying Voidsworn colors. Whatever they did to her, they finished the job.`;
    },
    options: [
      {
        label: "Destroy the ghost.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.bossWeakened = true;
          advanceArc(run, "lost-carrier");
          return "The Apheliotrope's screen will be thinner. Push for the kill.";
        },
      },
    ],
  },

  // === "The Choir's Eye" — 2 stages ========================================
  {
    id: "arc-choir-1",
    arcKey: "choir-relic", arcStage: 0,
    actTags: [3, 4],
    precondition: (run) => isArcAt(run, "choir-relic", 0),
    title: () => "Voidsworn Reliquary",
    body: (run) => {
      const s = arcSlot(run, "choir-relic");
      return `A boarding party recovers a black-glass slab from a downed Voidsworn frigate. ${s.npcName}'s sigil is etched on it. The slab hums.`;
    },
    options: [
      {
        label: "Study it.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.knowsVoidsworn = true;
          advanceArc(run, "choir-relic");
          return "The hum forms words you almost recognize. The slab goes cold.";
        },
      },
      {
        label: "Sell it to Hegemony intel.",
        apply: (run) => {
          run.resources.credits += 80;
          if (run.arcs) {
            const arc = run.arcs.find((a) => a.key === "choir-relic");
            if (arc) arc.stageIndex = 99;
          }
          return "Their courier collects it without opening it. The credits clear.";
        },
      },
    ],
  },
  {
    id: "arc-choir-2",
    arcKey: "choir-relic", arcStage: 1,
    actTags: [5],
    precondition: (run) => isArcAt(run, "choir-relic", 1),
    title: () => "Reading the Eye",
    body: (run) => {
      return "The slab's hum returns at the jump point. You understand it now: a Voidsworn keystone phrase, a name for the Apheliotrope's bridge.";
    },
    options: [
      {
        label: "Use the name.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.bossWeakened = true;
          run.flags.choirNameSpoken = true;
          advanceArc(run, "choir-relic");
          return "Their comms stutter. The lash hits less true.";
        },
      },
    ],
  },

  // ===== Mysteries, gambles, and lore (Tier 21) ===========================
  {
    id: "salvaged-engineer",
    title: "Lifepod Beacon",
    body: "A Coalition lifepod drifts in your jump corridor. Engineer's name on the manifest. They're alive — barely.",
    actTags: [1, 2, 3],
    options: [
      {
        label: "Bring her aboard.",
        apply: (run) => {
          addPassenger(run, "wounded-engineer");
          run.resources.credits += 5;
          // Followup: a saved pilot may return on a later jump with a
          // wing in tow. ~3 jumps out.
          scheduleFollowup(run, "saved-pilot-returns", 3, "salvaged-engineer");
          return "Field repairs already start before you've finished thawing her out.";
        },
      },
      {
        label: "Mark the pod and continue.",
        apply: (run) => {
          run.resources.credits += 20;
          return "You log the position. SAR will retrieve. Probably.";
        },
      },
    ],
  },
  {
    id: "captured-reaver",
    title: "Reaver in the Brig",
    body: "Boarding party retrieves a Reaver mid-rank from a downed gunship. They want to talk. Loudly.",
    actTags: [2, 3, 4],
    options: [
      {
        label: "Let them talk. Take notes.",
        apply: (run) => {
          addPassenger(run, "reaver-intel");
          return "Intel passes Coalition encryption an hour after. You believe most of it.";
        },
      },
      {
        label: "Hand them to the JAG officer.",
        apply: (run) => {
          run.resources.credits += 60;
          run.flags = run.flags || {};
          run.flags.geneva = true;
          // A Hegemony smuggler hears about your handling and remembers.
          scheduleFollowup(run, "smuggler-gift", 4, "captured-reaver");
          return "Bounty paid out the next morning. Geneva looks the other way.";
        },
      },
      {
        label: "Execute. Make an example.",
        apply: (run) => {
          run.resources.credits += 90;
          run.flags = run.flags || {};
          run.flags.warCriminalStart = true;
          return "Word travels. So does the case file.";
        },
      },
    ],
  },
  {
    id: "stranded-merc",
    title: "Stranded Merc",
    body: "A mercenary fighter pilot signals from a tumbling rig. Their contract holder is dead. They'll fly your wing if you spring the credits.",
    actTags: [2, 3, 4],
    options: [
      {
        label: "Hire them.",
        apply: (run) => {
          if (run.resources.credits >= 25) {
            run.resources.credits -= 25;
            addPassenger(run, "mercenary-pilot");
            return "They unstrap and fly out alongside you. Free fighters for two jumps.";
          }
          return "Credits short. They wave from the wreck.";
        },
      },
      {
        label: "Wave them off.",
        apply: () => "They drift past, hand still raised.",
      },
    ],
  },
  {
    id: "field-medic",
    title: "Coalition Medic",
    body: "A Coalition flight surgeon transfers in unannounced. Documents in order. Bedside manner suspicious. Helpful nonetheless.",
    actTags: [1, 2, 3],
    options: [
      {
        label: "Welcome aboard.",
        apply: (run) => {
          addPassenger(run, "field-medic");
          return "Drip recovery doubles within the hour.";
        },
      },
    ],
  },
  {
    id: "gambling-tables",
    title: "Off-Books Game",
    body: "A trio of off-duty engineers run a card table in the carrier hangar. Anyone can sit in. The deck is suspect but the credits are real.",
    actTags: [1, 2, 3, 4],
    options: [
      {
        label: "Play conservative.",
        apply: (run) => {
          if (run.resources.credits >= 10) {
            run.resources.credits -= 10;
            const win = safeRng(run) < 0.55;
            if (win) {
              run.resources.credits += 30;
              return "You leave 20 credits up. The deck wasn't quite as crooked as advertised.";
            }
            return "Down ten. The deck was exactly as advertised.";
          }
          return "Pockets too thin. You buy a coffee and watch.";
        },
      },
      {
        label: "Push hard.",
        apply: (run) => {
          if (run.resources.credits >= 30) {
            run.resources.credits -= 30;
            const win = safeRng(run) < 0.40;
            if (win) {
              run.resources.credits += 100;
              return "Big pot. The engineers scowl but pay out clean.";
            }
            // The cheats remember faces. Schedule a callback.
            scheduleFollowup(run, "rigged-card-shark", 2, "gambling-tables");
            return "Cleaned out. You walk back to your quarters slow. Someone watched closely.";
          }
          return "Not enough credits to play big. You step away.";
        },
      },
      {
        label: "Walk away.",
        apply: () => "A wiser bet than most.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Event followup cards (Tier 23) — never roll randomly. They're only
  // pulled when scheduleFollowup primed them and the player lands on an
  // event node. Each has a `precondition: () => false` so the random
  // event pool skips them.
  // -------------------------------------------------------------------------
  {
    id: "rigged-card-shark",
    title: "The Mark Returns",
    body: "The card-shark from the hangar table catches up with you on this jump. They want a rematch. They brought friends.",
    actTags: [1, 2, 3, 4, 5],
    precondition: () => false,
    options: [
      {
        label: "Pay them off (40 credits).",
        apply: (run) => {
          if (run.resources.credits >= 40) {
            run.resources.credits -= 40;
            return "They take the credits, take their friends, leave. The hangar's quieter.";
          }
          run.resources.credits = 0;
          return "You hand over everything. They consider it a down payment.";
        },
      },
      {
        label: "Refuse. Let the security detail handle it.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.warCriminalStart = true;
          return "Security removes them. Quietly. Doesn't bear thinking about.";
        },
      },
    ],
  },
  {
    id: "smuggler-gift",
    title: "Smuggler's Tribute",
    body: "A Hegemony smuggler you helped passes word that they cleared their ledger. A crate arrives unannounced.",
    actTags: [2, 3, 4, 5],
    precondition: () => false,
    options: [
      {
        label: "Crack the crate.",
        apply: (run) => {
          const roll = run.rng ? safeRng(run) : Math.random();
          if (roll < 0.45) {
            run.resources.credits += 60;
            return "Pure credits. They paid in full.";
          }
          if (roll < 0.80) {
            addPassenger(run, "field-medic");
            return "A field medic inside. They wave hello. The smuggler thought you might need them.";
          }
          run.smallCraft.fighter = Math.min(MAX_FIGHTERS, run.smallCraft.fighter + 2);
          return "Two refit fighters in cryo. They're warm by morning.";
        },
      },
    ],
  },
  {
    id: "burned-bridge-followup",
    title: "Old Friend",
    body: "A name from your past walks aboard. Last time you saw them, you didn't part well. They're not here to fight.",
    actTags: [3, 4, 5],
    precondition: () => false,
    options: [
      {
        label: "Hear them out.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.veteranIntel = true;
          run.resources.credits += 30;
          return "They share intel that costs the Reavers a patrol. The credits are a token.";
        },
      },
      {
        label: "Send them away again.",
        apply: () => "They nod. They expected as much. The door closes harder this time.",
      },
    ],
  },
  // ===== Cargo contract offers (Tier 24) ==================================
  {
    id: "supply-contract",
    title: "Coalition Logistics Request",
    body: "A Coalition courier hands you a sealed crate and an iris-scanned order. Deliver to any resupply depot in 4 jumps. The pay is real.",
    actTags: [1, 2, 3],
    options: [
      {
        label: "Accept the contract.",
        apply: (run) => {
          if (offerContract(run, "coalition-supplies")) {
            return "Crate stowed in cargo bay 3. The clock starts at your next jump.";
          }
          return "Your contract dossier is already full. The courier withdraws.";
        },
      },
      {
        label: "Refuse politely.",
        apply: () => "The courier doesn't argue. They've heard worse.",
      },
    ],
  },
  {
    id: "prisoner-contract",
    title: "Prisoner Transfer Order",
    body: "Coalition military police drop a restrained Hegemony prisoner aboard. Get them to a depot in 3 jumps. They are not friendly.",
    actTags: [2, 3, 4],
    options: [
      {
        label: "Accept transfer.",
        apply: (run) => {
          if (offerContract(run, "hegemony-prisoner")) {
            return "Prisoner locked in the brig. Three jumps. The countdown is loud.";
          }
          return "Brig full of paperwork. The MPs leave with their guest.";
        },
      },
      {
        label: "Decline.",
        apply: () => "MPs leave looking unimpressed.",
      },
    ],
  },
  {
    id: "medic-evac-contract",
    title: "Medical Evacuation",
    body: "A field medic transport docks emergency-side. One pilot in critical condition. Two jumps to a depot or they don't make it.",
    actTags: [2, 3, 4],
    options: [
      {
        label: "Take the evac.",
        apply: (run) => {
          if (offerContract(run, "field-medic-evac")) {
            return "They are stable on cryo. Push hard for the next depot.";
          }
          return "Logistics says you're carrying too much already.";
        },
      },
      {
        label: "Refuse and warn another fleet element.",
        apply: () => "Comms relays the request. A faster ship picks them up.",
      },
    ],
  },
  {
    id: "reliquary-contract",
    title: "R&D Pickup",
    body: "Coalition R&D sends a sealed Voidsworn reliquary for transport to the act-finale boss zone. The pay is exceptional. The crate hums.",
    actTags: [3, 4],
    precondition: (run) => run.flags && run.flags.knowsVoidsworn,
    options: [
      {
        label: "Accept the carry.",
        apply: (run) => {
          if (offerContract(run, "voidsworn-artifact")) {
            return "Reliquary stowed in cargo bay 1, behind two seals. Don't open the seals.";
          }
          return "R&D withdraws the offer with a frown.";
        },
      },
      {
        label: "Refuse on safety grounds.",
        apply: (run) => {
          run.resources.credits += 10;
          return "R&D pays a small cancellation fee. The reliquary leaves with a different courier.";
        },
      },
    ],
  },

  // ===== Anomaly events (Tier 26) =========================================
  // Voidsworn-flavored late-act encounters. Tagged anomaly:true so future
  // UI can theme them distinctly. Acts 3-5 only.
  {
    id: "anomaly-mirror-pilot",
    title: "Mirror Pilot",
    body: "Your wing sensors paint a fighter flying parallel — your hull number, your callsign, your trajectory. They don't respond to hail. They turn off when you turn off.",
    actTags: [3, 4, 5],
    anomaly: true,
    options: [
      {
        label: "Follow them.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.knowsVoidsworn = true;
          run.resources.credits += 25;
          return "You break formation. The mirror pilot doesn't. They vanish at the jump point, leaving telemetry data that reads in two languages.";
        },
      },
      {
        label: "Open fire on them.",
        apply: (run) => {
          run.smallCraft.fighter = Math.max(0, run.smallCraft.fighter - 1);
          run.flags = run.flags || {};
          run.flags.knowsVoidsworn = true;
          return "Your shot lands. Your fighter loses one of its own from the formation. The mirror pilot was never there.";
        },
      },
      {
        label: "Hold formation and look away.",
        apply: () => "When you look back, they're gone. Your hull number reads correctly. Probably.",
      },
    ],
  },
  {
    id: "anomaly-empty-station",
    title: "The Empty Station",
    body: "A Coalition supply station, sealed and intact, drifts on the edge of the jump corridor. No transponder. No crew. Lights still on inside.",
    actTags: [3, 4, 5],
    anomaly: true,
    options: [
      {
        label: "Board.",
        apply: (run) => {
          run.resources.credits += 80;
          run.resources.fuel += 2;
          run.flags = run.flags || {};
          run.flags.knowsVoidsworn = true;
          return "Crates are full. Beds are made. The log ends mid-sentence. You take everything and burn the rest.";
        },
      },
      {
        label: "Mark it and continue.",
        apply: () => "Coordinates logged. SAR will investigate. SAR does not investigate.",
      },
    ],
  },
  {
    id: "anomaly-loop",
    title: "Telemetry Loop",
    body: "Your jump cycle runs three minutes longer than the corridor allows. Engineering reports nothing wrong. Your callsign appears twice on the manifest.",
    actTags: [4, 5],
    anomaly: true,
    options: [
      {
        label: "Acknowledge and proceed.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.knowsVoidsworn = true;
          addPassenger(run, "voidsworn-prisoner");
          return "A second copy of the manifest stamps onto the records. The second you doesn't speak. You acquire knowledge you cannot place.";
        },
      },
      {
        label: "Force a recalculation.",
        apply: (run) => {
          run.resources.fuel = Math.max(0, run.resources.fuel - 1);
          return "Engineering burns a fuel cell forcing the system to recompute. The two manifests collapse into one. The strange three minutes does not reappear.";
        },
      },
    ],
  },
  {
    id: "anomaly-phantom-wing",
    title: "Phantom Wing",
    body: "Four Coalition fighters in pre-war paint dock without authorization. Their pilots' files predate the war. They salute, then ask where to refuel.",
    actTags: [3, 4, 5],
    anomaly: true,
    options: [
      {
        label: "Refuel them. Fold them into the wing.",
        apply: (run) => {
          run.smallCraft.fighter = Math.min(MAX_FIGHTERS, run.smallCraft.fighter + 4);
          run.flags = run.flags || {};
          run.flags.knowsVoidsworn = true;
          return "Four fighters join. They fly the older pattern. Their pod-rounds register as out-of-spec on every readout.";
        },
      },
      {
        label: "Refuse to board them.",
        apply: (run) => {
          run.resources.credits += 30;
          return "They turn and jump out. Their last broadcast logs as your own callsign, returning the call you didn't make.";
        },
      },
    ],
  },
  {
    id: "anomaly-binary-priest",
    title: "Binary Priest",
    body: "A Voidsworn Reader hails on open band. They are unarmed. They are alone. They want to know what you plan to do at the Apheliotrope.",
    actTags: [4, 5],
    anomaly: true,
    options: [
      {
        label: "Tell them the plan.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.bossWeakened = true;
          run.flags.knowsVoidsworn = true;
          return "They listen, then offer one sentence in reply: 'You will be there. I will not.' The Apheliotrope is now slightly less prepared.";
        },
      },
      {
        label: "Refuse to speak.",
        apply: (run) => {
          run.resources.credits += 40;
          return "They wait sixty seconds in silence. Then they shut down their drive. You log the kill anyway.";
        },
      },
      {
        label: "Open fire.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.warCriminalStart = true;
          return "The Reader does not dodge. The hit is clean. Your file gains another paragraph.";
        },
      },
    ],
  },
  {
    id: "anomaly-pre-echo",
    title: "Pre-Echo",
    body: "Comms catches a Coalition distress call. The transponder belongs to a ship that hasn't been built yet. It uses your callsign.",
    actTags: [4, 5],
    anomaly: true,
    options: [
      {
        label: "Respond.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.knowsVoidsworn = true;
          run.resources.credits += 50;
          return "The signal cuts mid-sentence. Engineering finds a credit transfer in your accounts from a sender ID with no record. They mark it pending.";
        },
      },
      {
        label: "Ignore.",
        apply: () => "The signal repeats three times, then stops. You don't ever hear it again.",
      },
    ],
  },
  {
    id: "anomaly-still-pilot",
    title: "The Pilot Who Won't Wake",
    body: "A wing pilot returns from a routine sortie but won't unstrap. Eyes open. Reading lights on. They will not respond.",
    actTags: [3, 4, 5],
    anomaly: true,
    options: [
      {
        label: "Field-evac them.",
        apply: (run) => {
          run.smallCraft.fighter = Math.max(0, run.smallCraft.fighter - 1);
          addPassenger(run, "field-medic");
          return "Medics handle it quietly. Fleet morale dips. A field medic asks to stay on for the next few jumps.";
        },
      },
      {
        label: "Leave them in the cockpit. They might come back.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.knowsVoidsworn = true;
          return "They sit there for three watches, then suddenly stand up and walk to their quarters. They never speak about it. The cockpit reads normal on every check after.";
        },
      },
    ],
  },
  {
    id: "anomaly-cargo-ghost",
    title: "Cargo Ghost",
    body: "A sealed cargo bay reports cycling air. Nothing has been added. Nothing has been removed. The seal is original.",
    actTags: [3, 4, 5],
    anomaly: true,
    options: [
      {
        label: "Open the bay.",
        apply: (run) => {
          const roll = run.rng ? safeRng(run) : Math.random();
          if (roll < 0.5) {
            run.resources.credits += 60;
            return "Eight unmarked crates sit on the deck. Inside: pure pre-war credit ingots. Coalition R&D will not ask questions.";
          }
          run.smallCraft.fighter = Math.max(0, run.smallCraft.fighter - 1);
          run.flags = run.flags || {};
          run.flags.knowsVoidsworn = true;
          return "The cargo bay is empty. A pilot is missing. The seal was never broken from the inside.";
        },
      },
      {
        label: "Leave it sealed.",
        apply: () => "Engineering re-routes the air loop. The cycling stops. Nobody opens the bay for the rest of the deployment.",
      },
    ],
  },

  {
    id: "saved-pilot-returns",
    title: "Your Wing Returns",
    body: "A pilot you fished out of a lifepod jumps in unannounced. Same canopy, fresh paint, a wing of three behind them.",
    actTags: [3, 4, 5],
    precondition: () => false,
    options: [
      {
        label: "Welcome them onto the line.",
        apply: (run) => {
          run.smallCraft.fighter = Math.min(MAX_FIGHTERS, run.smallCraft.fighter + 4);
          run.flags = run.flags || {};
          run.flags.wingmanRescued = run.flags.wingmanRescued || "DELPHI";
          return "Four fighters fold in. The line tightens.";
        },
      },
    ],
  },
  {
    id: "bomber-instructor",
    title: "Veteran Pod-Runner",
    body: "A retired bomber commander wanders into the briefing room and offers training. Says it's been a slow retirement.",
    actTags: [3, 4],
    options: [
      {
        label: "Take the lessons.",
        apply: (run) => {
          addPassenger(run, "bomber-instructor");
          return "Pod racks reorganized in the first watch. Bomber drip up.";
        },
      },
      {
        label: "Politely decline.",
        apply: () => "They nod, take a coffee, leave.",
      },
    ],
  },
  {
    id: "lore-fragment",
    title: "Old Coalition Drone",
    body: "A drone in pre-war Coalition paint drifts into your scope. Its black box contains a war diary entry from before first contact.",
    actTags: [3, 4, 5],
    options: [
      {
        label: "Read the entry.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.knowsVoidsworn = true;
          return "The diary mentions \"unfamiliar carrier silhouettes\" — six months before official first contact.";
        },
      },
      {
        label: "Sell the drone.",
        apply: (run) => {
          run.resources.credits += 35;
          return "Coalition intel pays well for the wreck.";
        },
      },
    ],
  },
  {
    id: "voidsworn-prisoner",
    title: "Voidsworn Survivor",
    body: "A boarding action recovers a Voidsworn adept, still breathing under the helm. They are willing to whisper, for a price.",
    actTags: [4, 5],
    precondition: (run) => run.flags && run.flags.knowsVoidsworn,
    options: [
      {
        label: "Listen.",
        apply: (run) => {
          addPassenger(run, "voidsworn-prisoner");
          return "Their whispers warp the comms band. Next intercept will read clearer.";
        },
      },
      {
        label: "Vent the brig.",
        apply: (run) => {
          run.resources.credits += 20;
          run.flags = run.flags || {};
          run.flags.warCriminalStart = true;
          return "The Coalition does not log the body. JAG does.";
        },
      },
    ],
  },
  {
    id: "salvaged-fighter",
    title: "Frozen Fighter",
    body: "A pristine pre-war Coalition fighter drifts intact. The pilot's hibernation pod is still cycling.",
    actTags: [2, 3, 4],
    options: [
      {
        label: "Refit and fly.",
        apply: (run) => {
          run.smallCraft.fighter = Math.min(MAX_FIGHTERS, run.smallCraft.fighter + 3);
          return "Three jumps of refit later, the airframe is back on the line.";
        },
      },
      {
        label: "Sell the cyrocrystal.",
        apply: (run) => {
          run.resources.credits += 75;
          return "Coalition R&D pays gold for the cryo cores. Quietly.";
        },
      },
    ],
  },
  {
    id: "chaplain-visit",
    title: "Field Chaplain",
    body: "A Coalition chaplain rides out to bless the ship before its next deep jump. The crew lines up regardless of belief.",
    actTags: [2, 3, 4, 5],
    options: [
      {
        label: "Accept the blessing.",
        apply: (run) => {
          addPassenger(run, "field-chaplain");
          return "Morale lifts visibly. The chaplain stays for three jumps.";
        },
      },
      {
        label: "Postpone.",
        apply: () => "The chaplain nods, asks to ride along anyway. You refuse.",
      },
    ],
  },

  // ========================================================================
  // Tier 29 — 15 new cards: reputation-gated, fleet-aware, lore drops
  // ========================================================================

  // --- Reputation-gated cards ---------------------------------------------
  {
    id: "coalition-commendation",
    title: "Fleet Citation",
    body: "Coalition Command files a formal citation in your name. The ceremony is brief — the war doesn't pause — but the credits clear and the file thickens.",
    actTags: [2, 3, 4, 5],
    precondition: (run) => getReputation(run, "coalition") >= 60,
    options: [
      {
        label: "Accept with grace.",
        apply: (run) => {
          run.resources.credits += 70;
          shiftReputation(run, "coalition", 10);
          return "Your file gains a medal you cannot pin to a flight suit. The credits clear in the next watch.";
        },
      },
      {
        label: "Decline. Send the credits to a memorial fund.",
        apply: (run) => {
          shiftReputation(run, "coalition", 20);
          return "Word spreads through Coalition ranks. The Service notes the gesture.";
        },
      },
    ],
  },
  {
    id: "coalition-cold-shoulder",
    title: "Cold Shoulder",
    body: "Coalition supply chain reports your last requisition lost in transit. They are sorry. They are not sorry.",
    actTags: [2, 3, 4, 5],
    precondition: (run) => getReputation(run, "coalition") <= -30,
    options: [
      {
        label: "Submit a formal complaint.",
        apply: (run) => {
          shiftReputation(run, "coalition", 10);
          return "A logistics officer responds three jumps later. They apologize, marginally.";
        },
      },
      {
        label: "Bypass them. Buy from the gray market.",
        apply: (run) => {
          if (run.resources.credits >= 30) {
            run.resources.credits -= 30;
            run.smallCraft.fighter = Math.min(MAX_FIGHTERS, run.smallCraft.fighter + 2);
            return "Two fighters arrive in pre-war Coalition paint. Don't ask. They fly fine.";
          }
          return "Pockets too thin for the gray market. You make do.";
        },
      },
    ],
  },
  {
    id: "reaver-bounty-spike",
    title: "Bounty Posted",
    body: "Reaver bands post your callsign with a renewed reward. Every fuel station on the rim now flags your transponder.",
    actTags: [3, 4, 5],
    precondition: (run) => getReputation(run, "reavers") <= -60,
    options: [
      {
        label: "Run dark for the next jump.",
        apply: (run) => {
          if (run.resources.fuel >= 1) {
            run.resources.fuel -= 1;
            return "You burn the spare fuel masking your transponder. The bounty cools — for now.";
          }
          return "No spare fuel to mask the signal. The bounty grows.";
        },
      },
      {
        label: "Press the kill list harder.",
        apply: (run) => {
          shiftReputation(run, "reavers", -10);
          run.resources.credits += 40;
          return "You log three more Reaver kills publicly. They double the bounty.";
        },
      },
    ],
  },
  {
    id: "hegemony-defection-offer",
    title: "Quiet Offer",
    body: "A Hegemony intermediary suggests, off the record, that your service might be valued under different colors. They mention a number.",
    actTags: [3, 4],
    precondition: (run) => getReputation(run, "hegemony") >= 30 && getReputation(run, "coalition") <= 10,
    options: [
      {
        label: "Refuse and report.",
        apply: (run) => {
          shiftReputation(run, "coalition", 25);
          shiftReputation(run, "hegemony", -30);
          return "Coalition counter-intel handles the contact. Your file gains a commendation.";
        },
      },
      {
        label: "Take the credits. Stay Coalition.",
        apply: (run) => {
          run.resources.credits += 100;
          shiftReputation(run, "coalition", -10);
          return "The money clears. Coalition oversight asks two pointed questions. You answer carefully.";
        },
      },
      {
        label: "Walk away. Say nothing.",
        apply: () => "The intermediary nods. The conversation never happened.",
      },
    ],
  },

  // --- Fleet-aware cards (need capitals) ----------------------------------
  {
    id: "capital-mutiny-rumor",
    title: "Bridge Rumor",
    body: "A junior officer reports whispers from a capital's crew quarters. Not mutiny — but the captain has been distant.",
    actTags: [3, 4, 5],
    precondition: (run) => (run.capitals || []).length >= 2,
    options: [
      {
        label: "Address the captain directly.",
        apply: (run) => {
          shiftReputation(run, "coalition", 5);
          return "You walk the deck. The captain meets your eye. The whispers stop within a watch.";
        },
      },
      {
        label: "Reshuffle assignments.",
        apply: (run) => {
          if (run.capitals.length > 0) {
            const cap = run.capitals[run.capitals.length - 1];
            cap.captain = rollCapitalCaptain(Math.random, cap.klass);
            return `${cap.name || cap.klass} now flies under ${cap.captain}. The whispers stop.`;
          }
          return "No capitals to reshuffle.";
        },
      },
      {
        label: "Let it pass.",
        apply: () => "Crews handle their own. Mostly.",
      },
    ],
  },
  {
    id: "carrier-engineering-pitch",
    title: "Carrier Engineering",
    body: "A flight chief on your carrier pitches a manual retune of the hangar racks. Says they can squeeze 20% more cycle rate out of a refit.",
    actTags: [4, 5],
    precondition: (run) => (run.capitals || []).some((c) => c.klass === "carrier"),
    options: [
      {
        label: "Authorize the retune.",
        apply: (run) => {
          if (run.resources.credits >= 30) {
            run.resources.credits -= 30;
            // Add a temporary engineer passenger for sustained drip boost.
            addPassenger(run, "field-medic");
            return "Engineering team rolls up sleeves. Drip rate up across the fleet for three jumps.";
          }
          return "Pockets too thin. The chief shrugs.";
        },
      },
      {
        label: "Schedule it for after the war.",
        apply: () => "The chief jots it down. They do not believe you.",
      },
    ],
  },
  {
    id: "battleship-broadside-drill",
    title: "Broadside Drill",
    body: "A battleship CO requests permission to run live-fire drills at the next jump. Their crew is sharp; they want it sharper.",
    actTags: [3, 4, 5],
    precondition: (run) => (run.capitals || []).some((c) => c.klass === "battleship"),
    options: [
      {
        label: "Authorize the drill.",
        apply: (run) => {
          if (run.resources.fuel >= 1) {
            run.resources.fuel -= 1;
            run.flags = run.flags || {};
            run.flags.bossWeakened = true;
            return "Drill burns one fuel but the next engagement will read crisp.";
          }
          return "No fuel to spare. The CO understands.";
        },
      },
      {
        label: "Decline. Conserve munitions.",
        apply: () => "The CO salutes. The crew remains sharp. Probably.",
      },
    ],
  },
  {
    id: "capital-honor-duel",
    title: "An Old Score",
    body: "One of your capital captains requests permission to duel — not literally — a Hegemony cruiser CO they served with at the academy. Old grudge.",
    actTags: [3, 4],
    precondition: (run) => (run.capitals || []).length >= 3,
    options: [
      {
        label: "Authorize. Personal honor matters.",
        apply: (run) => {
          shiftReputation(run, "hegemony", -15);
          if (run.capitals.length > 0) {
            const cap = run.capitals[0];
            cap.hpFrac = Math.max(0.3, cap.hpFrac - 0.2);
            return `${cap.name || "Your flagship"} returns with hull damage and a story. Honor served.`;
          }
          return "Honor served.";
        },
      },
      {
        label: "Forbid. There's a war on.",
        apply: (run) => {
          shiftReputation(run, "coalition", 5);
          return "The captain accepts the order. They never bring it up again.";
        },
      },
    ],
  },

  // --- Late-act lore drops ------------------------------------------------
  {
    id: "war-archive",
    title: "Coalition Archive Fragment",
    body: "A black-stamped folder slides across your desk. Pre-war reconnaissance footage. The carriers in the frame have markings nobody catalogued.",
    actTags: [4, 5],
    options: [
      {
        label: "Study the footage.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.knowsVoidsworn = true;
          run.flags.bossWeakened = true;
          return "Pattern recognition flags six matches in the Apheliotrope's escort screen. Targeting solutions update.";
        },
      },
      {
        label: "Forward it up the chain.",
        apply: (run) => {
          shiftReputation(run, "coalition", 15);
          run.resources.credits += 30;
          return "Coalition Intelligence appreciates your initiative. Filed and forgotten.";
        },
      },
    ],
  },
  {
    id: "binary-poem",
    title: "Binary Poem",
    body: "A junior comms officer hands you a datapad. Voidsworn transmissions decoded as text. The Reader translated them as poetry. They asked if you wanted to read it.",
    actTags: [4, 5],
    precondition: (run) => run.flags && run.flags.knowsVoidsworn,
    options: [
      {
        label: "Read the poem.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.choirNameSpoken = true;
          run.flags.bossWeakened = true;
          return "You read aloud, despite yourself. The words sit in your throat for hours. The next jump reads quieter.";
        },
      },
      {
        label: "Delete the file.",
        apply: (run) => {
          shiftReputation(run, "coalition", 10);
          return "The officer nods. They expected as much. The pad is wiped.";
        },
      },
    ],
  },
  {
    id: "auriga-trophy",
    title: "Auriga's Trophy",
    body: "Salvage from Black Auriga's wreckage includes a trophy — Coalition captain's bars from a ship logged lost twenty years ago. The serial number is familiar.",
    actTags: [4, 5],
    precondition: (run) => run.flags && (run.flags.executedWoundedCapital || run.flags.sparedWoundedCapital),
    options: [
      {
        label: "Return the bars to the captain's family.",
        apply: (run) => {
          shiftReputation(run, "coalition", 20);
          return "The family thanks you in a brief letter. Coalition press picks up the story. Your file gains a paragraph.";
        },
      },
      {
        label: "Keep them.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.warCriminalStart = true;
          run.resources.credits += 40;
          return "The bars sit in your desk drawer. JAG never asks. You're never sure if that's worse.";
        },
      },
    ],
  },

  // --- Passenger interaction ----------------------------------------------
  {
    id: "passenger-bonding",
    title: "Carry Conversation",
    body: "Your passengers have started talking among themselves in the mess. Whatever they're discussing, the mood lifts visibly.",
    actTags: [2, 3, 4, 5],
    precondition: (run) => (run.passengers || []).length >= 2,
    options: [
      {
        label: "Eavesdrop.",
        apply: (run) => {
          run.resources.credits += 15;
          shiftReputation(run, "coalition", 5);
          return "They're trading recipes. You give the cook a credit bonus to make whatever the engineer's grandmother used to.";
        },
      },
      {
        label: "Leave them to it.",
        apply: () => "Some moments are not yours.",
      },
    ],
  },
  {
    id: "passenger-betrayal",
    title: "Locked Door",
    body: "One of your passengers refuses to come out of their quarters for the third shift. The lock is internal. They have stopped responding.",
    actTags: [3, 4, 5],
    precondition: (run) => (run.passengers || []).length >= 1,
    options: [
      {
        label: "Force the door.",
        apply: (run) => {
          if (run.passengers && run.passengers.length > 0) {
            const removed = run.passengers.shift();
            return `${removed.name} is gone. The room is empty. Hatch unlatched from inside. Nobody saw them leave.`;
          }
          return "Door opens to an empty room.";
        },
      },
      {
        label: "Respect their privacy.",
        apply: (run) => {
          if (run.passengers && run.passengers.length > 0) {
            run.passengers[0].jumpsLeft = Math.min(run.passengers[0].jumpsLeft + 1, 5);
            return "Three jumps later, they emerge. They eat in silence and stay aboard longer than expected.";
          }
          return "The room stays sealed.";
        },
      },
    ],
  },

  // --- Misc story beats ---------------------------------------------------
  {
    id: "civilian-evac",
    title: "Civilian Convoy",
    body: "Three civilian transports request escort through your jump corridor. They're carrying refugees. Their fuel is critically low.",
    actTags: [2, 3, 4],
    options: [
      {
        label: "Escort them. Share the burn.",
        apply: (run) => {
          if (run.resources.fuel >= 2) {
            run.resources.fuel -= 2;
            shiftReputation(run, "coalition", 25);
            return "You arrive light on fuel but heavy on goodwill. Coalition press covers it. The Service approves.";
          }
          return "You can't spare the fuel. The transports turn back. You don't ask what happens to them.";
        },
      },
      {
        label: "Wave them through. Stay on schedule.",
        apply: (run) => {
          shiftReputation(run, "coalition", -10);
          return "They pass without escort. Two of three reach Coalition space. The Service notes it.";
        },
      },
      {
        label: "Charge them for the escort.",
        apply: (run) => {
          run.resources.credits += 50;
          shiftReputation(run, "coalition", -25);
          return "They pay in pre-war scrip and unfamiliar promises. Your accounts read clean. Your file does not.";
        },
      },
    ],
  },
  {
    id: "abandoned-coalition-base",
    title: "Forgotten Outpost",
    body: "A Coalition forward base, abandoned mid-deployment two years ago. Records list it as decommissioned. The lights are still on.",
    actTags: [3, 4, 5],
    options: [
      {
        label: "Salvage what's left.",
        apply: (run) => {
          run.resources.credits += 60;
          run.resources.fuel += 2;
          shiftReputation(run, "coalition", -5);
          return "Quartermaster's office is empty. The fuel reserves are full. Coalition accounting will not enjoy the audit.";
        },
      },
      {
        label: "Report the active status.",
        apply: (run) => {
          shiftReputation(run, "coalition", 20);
          run.resources.credits += 15;
          return "A reactivation order goes through the next day. The base is back on the books. Coalition notes your professionalism.";
        },
      },
      {
        label: "Set the self-destruct.",
        apply: (run) => {
          run.flags = run.flags || {};
          run.flags.warCriminalStart = true;
          run.resources.credits += 30;
          return "The base lights wink out as you jump. Coalition tracks the silence by morning. They ask questions you do not answer.";
        },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Temporary passengers — short-duration buffs that ride for N jumps
// then expire. Granted from event-card outcomes (and a few resupply
// quirks). Each entry stacks; effects compose multiplicatively.
//
// Shape: { key, name, description, jumpsLeft, kind, tone }
//   key      stable ID
//   kind     a slot tag — at most one passenger of each kind active
//   jumpsLeft decremented at every node clear via tickPassengers
// ---------------------------------------------------------------------------

const PASSENGER_TYPES = {
  "wounded-engineer": {
    name: "Wounded Engineer",
    description: "Half-price repairs for the next 3 jumps. They work between sutures.",
    kind: "engineer",
    duration: 3,
    tone: "ally",
    effects: { repairMul: 0.5 },
  },
  "field-medic": {
    name: "Field Medic",
    description: "Pilots recover faster — small craft drip +50% for 3 jumps.",
    kind: "medic",
    duration: 3,
    tone: "ally",
    effects: { dripMul: 1.5 },
  },
  "mercenary-pilot": {
    name: "Mercenary Pilot",
    description: "Two jumps of free fighter recruits from their old network.",
    kind: "merc",
    duration: 2,
    tone: "ally",
    effects: { freeFighterPerJump: 1 },
  },
  "reaver-intel": {
    name: "Captured Reaver",
    description: "Talked. Battle payouts +30% for 4 jumps.",
    kind: "intel",
    duration: 4,
    tone: "intel",
    effects: { creditMul: 1.30 },
  },
  "bomber-instructor": {
    name: "Bomber Instructor",
    description: "Pod-runners ride briefer cooldowns — bomber drip +75% for 3 jumps.",
    kind: "instructor",
    duration: 3,
    tone: "ally",
    effects: { bomberDripMul: 1.75 },
  },
  "voidsworn-prisoner": {
    name: "Voidsworn Prisoner",
    description: "Whispers next-jump fleet positions. Next battle reward upgraded.",
    kind: "intel",
    duration: 1,
    tone: "intel",
    effects: { rewardUpgrade: true },
  },
  "field-chaplain": {
    name: "Field Chaplain",
    description: "Steady hand at the lectern. Promotion log entries read clearer for 3 jumps.",
    kind: "chaplain",
    duration: 3,
    tone: "note",
    effects: {},
  },
};

// Add a passenger to the run. If a passenger of the same `kind` is
// already aboard, the new one replaces it (the field engineer doesn't
// stack with another engineer — they job-share). Returns true if added.
export function addPassenger(run, key) {
  const def = PASSENGER_TYPES[key];
  if (!def) return false;
  if (!Array.isArray(run.passengers)) run.passengers = [];
  // Same-kind passenger: replace (refresh) instead of stacking.
  const idx = run.passengers.findIndex((p) => p.kind === def.kind);
  const entry = {
    key,
    name: def.name,
    description: def.description,
    kind: def.kind,
    tone: def.tone,
    jumpsLeft: def.duration,
    effects: { ...def.effects },
  };
  if (idx >= 0) run.passengers[idx] = entry;
  else run.passengers.push(entry);
  return true;
}

// Decrement jumpsLeft for every passenger and drop expired ones.
// Called from tickInterNode (every node clear). Per-jump effects
// (free fighter, drip bonuses) are applied here too.
function tickPassengers(run) {
  if (!Array.isArray(run.passengers) || run.passengers.length === 0) return;
  const survivors = [];
  for (const p of run.passengers) {
    // Per-jump free-fighter (mercenary).
    if (p.effects && p.effects.freeFighterPerJump) {
      run.smallCraft.fighter = Math.min(
        MAX_FIGHTERS,
        run.smallCraft.fighter + p.effects.freeFighterPerJump,
      );
    }
    p.jumpsLeft -= 1;
    if (p.jumpsLeft > 0) survivors.push(p);
    else {
      // Passenger disembarked. Log a one-liner so the memoir captures it.
      appendRunLog(run, "note", `${p.name} disembarked. Their contract ran its course.`);
    }
  }
  run.passengers = survivors;
}

// Read aggregated multipliers from active passengers. Each effect
// stacks multiplicatively across all active passengers.
export function passengerRepairMul(run) {
  let m = 1;
  for (const p of (run && run.passengers) || []) {
    if (p.effects && p.effects.repairMul) m *= p.effects.repairMul;
  }
  return m;
}
export function passengerCreditMul(run) {
  let m = 1;
  for (const p of (run && run.passengers) || []) {
    if (p.effects && p.effects.creditMul) m *= p.effects.creditMul;
  }
  return m;
}
export function passengerFighterDripMul(run) {
  let m = 1;
  for (const p of (run && run.passengers) || []) {
    if (p.effects && p.effects.dripMul) m *= p.effects.dripMul;
  }
  return m;
}
export function passengerBomberDripMul(run) {
  let m = 1;
  for (const p of (run && run.passengers) || []) {
    if (p.effects && p.effects.bomberDripMul) m *= p.effects.bomberDripMul;
    if (p.effects && p.effects.dripMul)       m *= p.effects.dripMul;
  }
  return m;
}

// ---------------------------------------------------------------------------
// Procedural resupply vendors. Each resupply node rolls a vendor
// archetype that controls inventory bias (which boons offered), price
// modifiers (multipliers on the base prices), and a flavor pitch.
// Some vendors offer unique services unavailable elsewhere.
//
// Vendor is stamped onto `node.vendor` at generate time so it's
// stable across re-syncs and save/load.
// ---------------------------------------------------------------------------

const VENDOR_NAME_POOLS = {
  quartermaster: ["Q.M. Halsen", "Q.M. Vehl", "Q.M. Tessen", "Q.M. Caldera", "Q.M. Brann"],
  blackmarket:   ["Mox", "\"Crooked\" Ren", "Vaska", "\"Easy\" Aksel", "Sereval"],
  engineer:      ["Chief Iverra", "Chief Marrok", "Chief Olsten", "Chief Korr"],
  salvager:      ["\"Rust\" Quill", "\"Scrap\" Dane", "\"Hook\" Vasik", "\"Slug\" Hoth"],
  priest:        ["Reader Beladi", "Reader Astren", "Reader Mistral", "Reader Yarrow"],
};

const VENDOR_ARCHETYPES = [
  {
    key: "quartermaster",
    label: "Coalition Quartermaster",
    weight: 3,
    pricing: { fuel: 1.00, fighter: 1.00, bomber: 1.00, repair: 1.00, boon: 1.00 },
    inventoryBias: null, // full pool
    pitch: "Coalition stamp on every crate. Prices are book rate.",
    color: "#9df",
  },
  {
    key: "blackmarket",
    label: "Black Market Dealer",
    weight: 2,
    pricing: { fuel: 1.20, fighter: 1.30, bomber: 1.30, repair: 1.10, boon: 0.65 },
    inventoryBias: ["tracer-rounds", "extended-magazines", "rapid-pods", "kinetic-rounds", "siege-bombardment"],
    pitch: "I don't sign anything. Boons run cheap, hulls run dear.",
    color: "#f8a",
    extraBoonCount: 1,
  },
  {
    key: "engineer",
    label: "Field Engineer",
    weight: 2,
    pricing: { fuel: 1.00, fighter: 1.00, bomber: 1.00, repair: 0.50, boon: 1.10 },
    inventoryBias: ["reinforced-prows", "reactive-plating", "hardened-cores", "fortified-bridge", "hangar-overdrive"],
    pitch: "Bring me your wounded hulls. I'll have them flying before sundown.",
    color: "#fc6",
    serviceTag: "Half-price repairs",
  },
  {
    key: "salvager",
    label: "Wreck Salvager",
    weight: 2,
    pricing: { fuel: 0.85, fighter: 0.75, bomber: 0.90, repair: 1.00, boon: 1.20 },
    inventoryBias: ["trauma-wing", "reinforced-prows", "ion-coils"],
    pitch: "Pulled this lot from a Reaver hulk. Fighters cheap, boons honest.",
    color: "#ac9",
    serviceTag: "Cheap small craft",
  },
  {
    key: "priest",
    label: "Wandering Reader",
    weight: 1,
    pricing: { fuel: 1.00, fighter: 1.00, bomber: 1.00, repair: 1.00, boon: 1.00 },
    inventoryBias: ["precog-targeting", "long-range-pods", "trauma-wing", "point-defense-array"],
    pitch: "The Choir speaks even here. Pick a refit; let it speak through you.",
    color: "#c8f",
    serviceTag: "Voidsworn-touched inventory",
  },
];

// Pick a vendor archetype (weighted), assign a procedural name + roll
// the inventory window. Returns a self-contained vendor descriptor
// that's stamped on the resupply node at generate time.
function rollVendor(rng) {
  const total = VENDOR_ARCHETYPES.reduce((a, b) => a + b.weight, 0);
  let pick = rng() * total;
  let archetype = VENDOR_ARCHETYPES[0];
  for (const a of VENDOR_ARCHETYPES) {
    pick -= a.weight;
    if (pick <= 0) { archetype = a; break; }
  }
  const names = VENDOR_NAME_POOLS[archetype.key] || ["Vendor"];
  const name = names[Math.floor(rng() * names.length)];
  return {
    key: archetype.key,
    name,
    label: archetype.label,
    pricing: archetype.pricing,
    pitch: archetype.pitch,
    color: archetype.color,
    serviceTag: archetype.serviceTag || null,
    inventoryBias: archetype.inventoryBias,
    extraBoonCount: archetype.extraBoonCount || 0,
  };
}

// Build a vendor's per-visit boon offer. Most vendors offer 2 boons;
// black-market vendors get an extra slot (3). Inventory bias narrows
// the pool; "null" bias means draw from the whole BOON_TABLE. Vendor
// offers are also filtered by `usableFromAct` so a player with no
// capitals doesn't see capital-only boons at a Coalition quartermaster.
function rollVendorOffer(vendor, run, rng) {
  const ownedKeys = new Set((run.boons || []).map((b) => b.key));
  const act = (run && run.act) || 1;
  const pool = (vendor.inventoryBias
    ? BOON_TABLE.filter((b) => vendor.inventoryBias.includes(b.key))
    : BOON_TABLE
  ).filter((b) => !ownedKeys.has(b.key))
   .filter((b) => (b.usableFromAct || 1) <= act);
  const slots = 2 + (vendor.extraBoonCount || 0);
  const shuffled = [...pool].sort(() => rng() - 0.5);
  const offers = shuffled.slice(0, slots);
  return offers;
}

// Boon refits available at resupply nodes. Costs 1 fuel each.
// Mechanical effects come from BOON_EFFECTS below — anything in this
// table without an entry there is text-only flavor.
//
// `usableFromAct` is the earliest act this boon meaningfully helps
// the player. Vendors filter their offers by `(act >= usableFromAct)`
// so Act 1 doesn't push capital-only boons at a player with no
// capitals. Defaults to 1 (always useful).
export const BOON_TABLE = [
  { key: "reinforced-prows",   desc: "Capitals: +10% hull",              usableFromAct: 2 },
  { key: "tracer-rounds",      desc: "Small craft: cannon cooldown -15%",usableFromAct: 1 },
  { key: "extended-magazines", desc: "Fighter cannon: +25% magazine",    usableFromAct: 1 },
  { key: "long-range-pods",    desc: "Bomber pods: +15% range",          usableFromAct: 2 },
  { key: "fortified-bridge",   desc: "Player ship: +20% HP",             usableFromAct: 1 },
  { key: "reactive-plating",   desc: "Capitals: armor wears 30% slower", usableFromAct: 3 },
  { key: "precog-targeting",   desc: "All ships: cannon spread -25%",    usableFromAct: 1 },
  { key: "hangar-overdrive",   desc: "Carrier: replenishment 40% faster",usableFromAct: 4 },
  { key: "trauma-wing",        desc: "Instant: repair one capital to 100%", usableFromAct: 2 },
  { key: "kinetic-rounds",     desc: "Small craft: cannon damage +15%",  usableFromAct: 1 },
  { key: "siege-bombardment",  desc: "Cruiser & battleship: cannon damage +15%", usableFromAct: 3 },
  { key: "point-defense-array",desc: "Capitals: PD damage +30%",         usableFromAct: 2 },
  { key: "hardened-cores",     desc: "Capitals: +20% shields",           usableFromAct: 2 },
  { key: "rapid-pods",         desc: "Bomber pods: 25% faster cooldown", usableFromAct: 2 },
  { key: "ion-coils",          desc: "Capitals: +12% top speed",         usableFromAct: 2 },
];

// Declarative per-class spec patches. `klass` is either an actual
// ship class (fighter / bomber / frigate / cruiser / battleship /
// carrier) OR the alias "capital" which matches frigate+cruiser+
// battleship+carrier. `path` is the dotted spec field, `mul` is the
// multiplier applied to the leaf number. `applyBoonPatches` walks
// the active boon list and stacks every matching effect onto the
// resolved spec at createShip time.
//
// Boons that DON'T fit this mould (Trauma Wing — instant effect at
// apply, EW Suite / Tracer Streams — damage-side hooks) are handled
// separately. They don't appear here.
export const BOON_EFFECTS = {
  "reinforced-prows":   [{ klass: "capital",    path: ["hp"],                    mul: 1.10 }],
  "tracer-rounds":      [
    { klass: "fighter", path: ["weapon", "cooldown"], mul: 0.85 },
    { klass: "bomber",  path: ["weapon", "cooldown"], mul: 0.85 },
  ],
  "extended-magazines": [{ klass: "fighter",    path: ["weapon", "capacity"],    mul: 1.25 }],
  "long-range-pods":    [{ klass: "bomber",     path: ["missilePods", "range"],  mul: 1.15 }],
  "reactive-plating":   [{ klass: "capital",    path: ["armor", "wearRate"],     mul: 0.70 }],
  "precog-targeting":   [
    { klass: "fighter",    path: ["weapon", "spread"], mul: 0.75 },
    { klass: "bomber",     path: ["weapon", "spread"], mul: 0.75 },
    { klass: "frigate",    path: ["ringCannons", "spread"], mul: 0.75 },
    { klass: "cruiser",    path: ["weapon", "spread"], mul: 0.75 },
    { klass: "battleship", path: ["weapon", "spread"], mul: 0.75 },
  ],
  "hangar-overdrive":   [
    { klass: "carrier", path: ["replenish", "fighter"], mul: 0.60 },
    { klass: "carrier", path: ["replenish", "bomber"],  mul: 0.60 },
  ],
  "kinetic-rounds":     [
    { klass: "fighter", path: ["weapon", "damage"], mul: 1.15 },
    { klass: "bomber",  path: ["weapon", "damage"], mul: 1.15 },
  ],
  "siege-bombardment":  [
    { klass: "cruiser",    path: ["weapon", "damage"], mul: 1.15 },
    { klass: "battleship", path: ["weapon", "damage"], mul: 1.15 },
  ],
  "point-defense-array":[{ klass: "capital", path: ["pdCannons", "damage"], mul: 1.30 }],
  "hardened-cores":     [{ klass: "capital", path: ["shield", "max"],       mul: 1.20 }],
  "rapid-pods":         [{ klass: "bomber",  path: ["missilePods", "cooldown"], mul: 0.75 }],
  "ion-coils":          [{ klass: "capital", path: ["maxSpeed"],            mul: 1.12 }],
};

const CAPITAL_CLASSES = new Set(["frigate", "cruiser", "battleship", "carrier"]);

// Traits that affect fleet-wide ship specs (not just the player).
// Same declarative shape as BOON_EFFECTS. Keyed by trait key so the
// applier can look them up from run.traits in one pass. Most traits
// only patch the player ship via playerOverride; this table holds
// the exceptions.
export const TRAIT_FLEET_EFFECTS = {
  "drill-sergeant": [
    { klass: "carrier", path: ["replenish", "fighter"], mul: 0.85 },
    { klass: "carrier", path: ["replenish", "bomber"],  mul: 0.85 },
  ],
};

// Apply fleet-wide trait patches at ship-creation. Same walker as
// applyBoonPatches; just keyed off TRAIT_FLEET_EFFECTS instead.
//
// Spec nodes (e.g. spec.replenish) returned by resolveSpec may still
// reference the cached CLASSES definitions when the race has no
// override for that subtree. Mutating them in place would poison
// every future ship. Clone each node on the way down so we only
// touch fresh copies.
export function applyTraitFleetPatches(spec, traitKeys, klass) {
  if (!traitKeys || traitKeys.length === 0) return spec;
  const aliases = new Set([klass]);
  if (CAPITAL_CLASSES.has(klass)) aliases.add("capital");
  for (const k of traitKeys) {
    const effects = TRAIT_FLEET_EFFECTS[k];
    if (!effects) continue;
    for (const e of effects) {
      if (!aliases.has(e.klass)) continue;
      let node = spec;
      for (let i = 0; i < e.path.length - 1; i++) {
        const seg = e.path[i];
        if (!node || typeof node[seg] !== "object" || node[seg] === null) { node = null; break; }
        node[seg] = { ...node[seg] };
        node = node[seg];
      }
      if (!node) continue;
      const leaf = e.path[e.path.length - 1];
      if (typeof node[leaf] === "number") node[leaf] = node[leaf] * e.mul;
    }
  }
  return spec;
}

// Apply every active boon's relevant patches onto a per-class spec.
// Mutates the spec in place (createShip clones via resolveSpec, so
// each ship gets its own copy to mutate). Patches that target the
// "capital" alias fire for any of the four capital classes; class-
// specific patches only fire on exact match. Missing path nodes are
// skipped silently — Reactive Plating against a class with no armor
// just no-ops instead of throwing.
export function applyBoonPatches(spec, boons, klass) {
  if (!boons || boons.length === 0) return spec;
  const aliases = new Set([klass]);
  if (CAPITAL_CLASSES.has(klass)) aliases.add("capital");
  for (const b of boons) {
    const effects = BOON_EFFECTS[b.key];
    if (!effects) continue;
    for (const e of effects) {
      if (!aliases.has(e.klass)) continue;
      let node = spec;
      for (let i = 0; i < e.path.length - 1; i++) {
        const k = e.path[i];
        if (!node || typeof node[k] !== "object" || node[k] === null) { node = null; break; }
        // Clone-on-descent so we don't mutate cached CLASSES/RACES
        // subtrees that resolveSpec passed through by reference.
        node[k] = { ...node[k] };
        node = node[k];
      }
      if (!node) continue;
      const leaf = e.path[e.path.length - 1];
      if (typeof node[leaf] === "number") {
        node[leaf] = node[leaf] * e.mul;
      }
    }
  }
  return spec;
}

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
  "bulkheads": {
    name: "Bulkheads",
    desc: "+25% player hull HP",
    playerOverride: (base) => ({
      hp: Math.round((base.hp || 35) * 1.25),
    }),
  },
  "marksman": {
    name: "Marksman",
    desc: "+15% projectile speed",
    playerOverride: (base) => ({
      weapon: { projectileSpeed: (base.weapon && base.weapon.projectileSpeed || 760) * 1.15 },
    }),
  },
  "lightning-reflexes": {
    name: "Lightning Reflexes",
    desc: "-20% cannon cooldown",
    playerOverride: (base) => ({
      weapon: { cooldown: (base.weapon && base.weapon.cooldown || 0.18) * 0.80 },
    }),
  },
  // Drill Sergeant — affects the carrier the player commands. Uses a
  // fleet-flag rather than playerOverride so the buildModeConfig path
  // can apply it to every blue-side carrier at spawn time. The
  // resolver in game.js#startGame patches spec.replenish.fighter/bomber
  // when `_fleetFlags.drillSergeant` is set on the playerSpecOverride.
  "drill-sergeant": {
    name: "Drill Sergeant",
    desc: "Carrier replenishment 15% faster",
    fleetFlag: "drillSergeant",
  },
  // Quartermaster — multiplies credit grants by 1.25. payoutFor in
  // roguelite.js stacks this on top of any active perk's
  // creditMultiplier so traits + perks compound. Event-card
  // payouts go through run.resources.credits +=N directly and
  // don't see this multiplier — keep the trait gated to node clears
  // (battle / elite / boss payouts) so the effect is consistent.
  "quartermaster": {
    name: "Quartermaster",
    desc: "+25% credits from battle clears",
    creditMultiplier: 1.25,
  },
  // Survivor — heal the most-wounded capital to full at each
  // promotion. The applyPromotion path calls promotionEffect if
  // present after fleet additions but before bulletin generation.
  "survivor": {
    name: "Survivor",
    desc: "Heal most-wounded capital at each promotion",
    promotionEffect: (run) => {
      const wounded = (run.capitals || []).filter((c) => c.hpFrac < 1);
      if (wounded.length === 0) return;
      wounded.sort((a, b) => a.hpFrac - b.hpFrac);
      wounded[0].hpFrac = 1.0;
    },
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
  // safeRng(run) without re-seeding. The PRNG state is intentionally NOT
  // persisted — node graphs are; per-event rolls aren't recoverable
  // and shouldn't be.
  run.rng = mulberry32(run.seed);
  // Back-compat: older saves stored single-string `fighterWingCommand`
  // / `bomberWingCommand`. Upgrade to the multi-wing data model lazily
  // — a missing wings array gets a single default wing with the
  // legacy command (or "free") carried over.
  if (!Array.isArray(run.fighterWings)) {
    run.fighterWings = [{
      id: "fighter-A", name: "Alpha",
      count: run.smallCraft?.fighter || 0,
      command: { kind: run.fighterWingCommand || "free" },
    }];
  }
  if (!Array.isArray(run.bomberWings)) {
    run.bomberWings = [{
      id: "bomber-A", name: "Alpha",
      count: run.smallCraft?.bomber || 0,
      command: { kind: run.bomberWingCommand || "free" },
    }];
  }
  // Back-compat: wings created before commanders shipped have no
  // commander field. Roll one lazily so old runs get pilots too.
  // Uses Math.random — these aren't seed-replayable but neither is
  // the old data they're being attached to.
  for (const w of run.fighterWings) {
    if (!w.commander) w.commander = rollWingCommander(Math.random);
  }
  for (const w of run.bomberWings) {
    if (!w.commander) w.commander = rollWingCommander(Math.random);
  }
  // Back-compat: capturedCraft added later — old saves lack it.
  if (!Array.isArray(run.capturedCraft)) run.capturedCraft = [];
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
  const capitals = STARTER_FLEET.capitals.map(
    (c) => makeNamedCapital(c.klass, nextInstanceId++, rng),
  );

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
    // Captured enemy small craft — `{ race, klass }` entries that keep
    // their original race (sprite/spec) and fly blue. Separate from
    // smallCraft so the race survives respawn. Capitals carry race on
    // their own object in run.capitals.
    capturedCraft: [],
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
    // Stamped at run start (Act 1) and at each promotion. UI reads it
    // and pops the act-intro overlay before letting the player onto
    // the starmap. Cleared by `clearPendingPreamble`.
    pendingPreamble: null,
    // Procedural inter-act radio dispatch — short transmission shown
    // AFTER the preamble dismisses. Cleared by `clearPendingDispatch`.
    pendingDispatch: null,
    // Chronological career log — short entries appended at major
    // moments (boss kills, rival defeats, arc resolutions). Surfaces
    // on the fleet panel and feeds the end-of-run memoir.
    log: [],
    endReason: null,
    flags: {},
    // Procedurally generated named rivals — see RIVAL_NAME_POOLS,
    // RIVAL_MOTIVATIONS. Two by default (one early-war faction, one
    // Voidsworn). Slotted into elite encounters across their active
    // acts and surfaced in the dossier sidebar.
    rivals: generateRivalRoster(rng),
    // Procedural story arcs seeded at run start. 1-2 arcs from
    // ARC_DEFINITIONS, each with slot data filled at seed time.
    // Stage events live in EVENT_CARDS gated by isArcAt preconditions.
    arcs: seedRunArcs(rng),
    // Temporary passengers — short-duration buffs that ride for
    // N jumps then expire. See PASSENGER_TYPES + addPassenger.
    passengers: [],
    // Pending followup events. Choices in earlier event cards
    // schedule downstream cards to fire N jumps later via
    // scheduleFollowup; tickInterNode counts them down.
    pendingFollowups: [],
    // Cargo contracts — meta-goals layered on top of the run.
    // Picked up at events, delivered at target node types, reward
    // credits/boons/ships. Failed contracts decay to "failed".
    contracts: [],
    // Per-faction reputation [-100, +100]. Starts: friendly with
    // Coalition, neutral with Hegemony, hostile with Reavers + Voidsworn.
    reputation: initReputation(),
    // Running totals tracked across the career. Updated at every
    // completeNode + captureBattleOutcome + buy* + arc resolution.
    // Surfaced live by the STATS overlay and snapshotted at
    // recordRunEnd into the memorial entry.
    stats: initRunStats(),
    // Shipyard meta-progression tally (Phase 2). Counts enemy kills
    // by class + boss/node clears, converted to credits at run-end.
    // See src/shipyard.js#computeRunPayout.
    killTally: { fighter: 0, bomber: 0, frigate: 0, cruiser: 0, battleship: 0, carrier: 0, station: 0 },
    bossesDefeated: 0,
    nodesCleared: 0,
    // Player ship tier (0=fighter, 5=carrier). Locked at run start
    // from the persisted Shipyard design. Enemy rosters scale around
    // this — see applyTierScalingToRoster in shipyard.js. Stored on
    // the run so the value is stable even if the player mutates their
    // design mid-run via the Shipyard (which they currently can't,
    // but defensive against future flows).
    playerTier: getPlayerTier(),
    // Number of times the player ship has been destroyed THIS run.
    // Each death rolls a survival check (game.js); failure stamps
    // run.endReason = "kia". Survival % drops 18% per death so a
    // careless pilot eventually runs out of luck — see the in-game
    // respawn block in game.js.
    playerDeaths: 0,
    // Battle Plan wing arrays. Each wing: { id, name, count, command:
    // { kind, target } }. `count` is how many of that craft type go
    // into this wing; the sum across wings should ≤ total small
    // craft (any remainder uses default AI / spawns wingless).
    //
    // Command kinds:
    //   "free"           — default AI (no override)
    //   "hold"           — pull to fleet centre, no fire
    //   "press"          — close-range aggressive
    //   "defend-capital" — escort + intercept threats to target capital
    //                       (target = capital.runtimeInstanceId number)
    //   "target-class"   — focus fire enemy class
    //                       (target = enemy klass string, e.g. "bomber")
    //
    // Default: one wing per craft type holding all ships, command free.
    fighterWings: [{ id: "fighter-A", name: "Alpha", count: STARTER_FLEET.fighter, command: { kind: "free" }, commander: rollWingCommander(rng) }],
    bomberWings:  [{ id: "bomber-A",  name: "Alpha", count: STARTER_FLEET.bomber,  command: { kind: "free" }, commander: rollWingCommander(rng) }],
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
          run.capitals.push(makeNamedCapital(c.klass, run.nextInstanceId++, rng));
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

  // Stamp the act-1 (or whatever the perk skipped to) preamble. UI
  // pops the overlay before showing the starmap on first open.
  run.pendingPreamble = buildPreamble(run, run.act);
  // Stamp the act-1 dispatch — shown AFTER the preamble is dismissed.
  run.pendingDispatch = pickDispatch(run, run.act);
  // Apply Service Hall meta-upgrades to the fresh run (Tier 38).
  // Runs AFTER perk apply so upgrade ranks stack additively on top.
  applyServiceUpgrades(meta, run);
  // Opening log entry — first beat of the career memoir.
  appendRunLog(run, "note", `Commissioned as Pilot Officer ${callsign}. ${run.rivals && run.rivals.length > 0 ? "Marked targets logged." : ""}`.trim());

  saveRun(run);
  events.emit("runStarted", { faction, seed: s });
  return run;
}

// Build a preamble snapshot for a given act. Resolves the static
// table + the flag-conditional line at call time so the snapshot
// reflects the run's current state.
function buildPreamble(run, act) {
  const entry = ACT_PREAMBLES[act];
  if (!entry) return null;
  const lines = [...entry.lines];
  const flagLine = entry.flagLine ? entry.flagLine(run) : null;
  if (flagLine) lines.push(flagLine);
  // Tier line — only stamp when the player has upgraded past Fighter,
  // so the baseline experience reads identical to the pre-Shipyard
  // game. Higher tiers get a sentence acknowledging the matched escort.
  if (run && run.playerTier && run.playerTier > 0) {
    const tierName = ["Fighter", "Bomber", "Frigate", "Cruiser", "Battleship", "Carrier"][run.playerTier] || "";
    lines.push(`Enemy forces have matched your ${tierName.toUpperCase()}-class deployment.`);
  }
  return {
    act,
    eyebrow: entry.eyebrow,
    title: entry.title,
    lines,
  };
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

  // Player-ship tier scaling — Frontier enemies scale around the
  // hull tier the player has purchased between runs. Same act + col
  // numbers, more (and bigger) enemies as the player's hull grows.
  const tier = (run && typeof run.playerTier === "number") ? run.playerTier : 0;

  // Column 0: single entry node — always a light battle.
  const startId = nodes.length;
  nodes.push({
    id: startId, col: 0, row: Math.floor(ROWS_PER_ACT / 2),
    type: "battle",
    faction: pickTrashFaction(),
    roster: applyTierScalingToRoster(scaleRoster(trashBase, diffFor(actIndex, 0)), tier, false),
  });

  // --- Detour-graph model -------------------------------------------------
  // The SPINE is combat: columns 1..SPINE_END are battle/elite nodes the
  // player MUST fight through to reach the boss — there is NO path that
  // skips them. GREEN nodes (event/resupply) are DETOURS placed BETWEEN
  // spine columns (at col + 0.5). Taking a detour is an extra jump (+fuel)
  // that rejoins the spine WITHOUT skipping a fight — so green nodes EXTEND
  // the act instead of shortcutting it. (Previously every node advanced one
  // column toward the boss, so 3 events = skip 3 fights at no cost.)
  const SPINE_END = COLS_PER_ACT - 2;   // last combat column before the boss
  const bossCol   = COLS_PER_ACT - 1;

  // Distinct, spread rows for `count` nodes in a column (act-rng shuffle).
  const pickRows = (count) => {
    const all = [];
    for (let r = 0; r < ROWS_PER_ACT; r++) all.push(r);
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all.slice(0, Math.min(count, all.length)).sort((a, b) => a - b);
  };

  // Build a combat node (battle/elite) with faction + roster + optional ace.
  const makeCombatNode = (col, row) => {
    let type = "battle";
    if (col >= 2) {
      const eliteChance = col >= 4 ? 0.35 : col === 3 ? 0.25 : 0.12;
      if (rng() < eliteChance) type = "elite";
    }
    const node = { id: nodes.length, col, row, type };
    node.faction = pickTrashFaction();
    const base = type === "elite" ? eliteBase : trashBase;
    node.roster = applyTierScalingToRoster(scaleRoster(base, diffFor(actIndex, col)), tier, false);
    // Elite nodes can roll a named ace / procedural rival (same logic as
    // before). Rival takes priority over the hand-authored ace.
    if (type === "elite" && rng() < ACE_CHANCE) {
      const rival = findRivalForAct(run, actIndex, rng);
      if (rival && rng() < 0.55) {
        const acePool = ACT_ACES[actIndex];
        const ab = acePool && acePool[0] ? acePool[0].roster : { fighter: 5, bomber: 2, frigate: 1 };
        node.aceName = rival.name;
        node.aceDescription = `Procedural rival. Motivation: ${rival.motivation}.`;
        node.faction = rival.faction;
        node.roster = applyTierScalingToRoster({ ...ab }, tier, false);
        node.rivalId = rival.id;
      } else {
        const acePool = ACT_ACES[actIndex];
        if (acePool && acePool.length > 0) {
          const ace = acePool[Math.floor(rng() * acePool.length)];
          node.aceName = ace.name;
          node.aceDescription = ace.description;
          node.faction = ace.faction;
          node.roster = applyTierScalingToRoster({ ...ace.roster }, tier, false);
        }
      }
    }
    nodes.push(node);
    return node;
  };

  // Build a detour node (event or resupply). Resupply biased to later gaps
  // (player has credits to spend by then).
  const makeDetourNode = (col, row, allowResupply) => {
    const kind = (allowResupply && rng() < 0.45) ? "resupply" : "event";
    const node = { id: nodes.length, col, row, type: kind };
    if (kind === "resupply") {
      node.vendor = rollVendor(rng);
    } else {
      // Act-tagged + precondition-gated event pool, arc stages preferred.
      const pool = EVENT_CARDS.filter(
        (c) => (!c.actTags || c.actTags.includes(actIndex))
            && (!c.precondition || c.precondition(run)),
      );
      const arcPool = pool.filter((c) => c.arcKey);
      const sourcePool = arcPool.length > 0 ? arcPool : pool;
      const chosen = sourcePool.length > 0
        ? sourcePool[Math.floor(rng() * sourcePool.length)]
        : EVENT_CARDS[Math.floor(rng() * EVENT_CARDS.length)];
      node.eventId = chosen.id;
      if (chosen.arcKey) { node.arcKey = chosen.arcKey; node.arcStage = chosen.arcStage; }
    }
    nodes.push(node);
    return node;
  };

  // Spine combat columns: 2-3 combat nodes each, on spread rows.
  const spineByCol = {};
  for (let col = 1; col <= SPINE_END; col++) {
    const count = 2 + (rng() < 0.55 ? 1 : 0);
    spineByCol[col] = pickRows(count).map((row) => makeCombatNode(col, row));
  }

  // Boss node — hand-tuned roster at 1x (NOT scaled by diffFor), tier
  // class-additions in full with the dampened qty bump.
  const bossId = nodes.length;
  nodes.push({
    id: bossId, col: bossCol, row: Math.floor(ROWS_PER_ACT / 2),
    type: "boss",
    faction: bossFaction,
    bossName: bossEntry.name,
    bossDescription: bossEntry.description,
    roster: applyTierScalingToRoster({ ...bossEntry.roster }, tier, true),
  });

  // Detour nodes — gap C sits between col C and col C+1 (placed at col+0.5).
  // ~78% of gaps get a detour; ~22% of those get a second.
  const detourByGap = {};
  for (let C = 0; C <= SPINE_END; C++) {
    detourByGap[C] = [];
    if (rng() < 0.78) {
      const dcount = rng() < 0.22 ? 2 : 1;
      for (const row of pickRows(dcount)) {
        detourByGap[C].push(makeDetourNode(C + 0.5, row, C >= 2));
      }
    }
  }

  // --- Edges --------------------------------------------------------------
  const addEdge = (fromId, toId) => edges.push({ fromId, toId, fuelCost: FUEL_PER_EDGE });
  const connectNearest = (fromNode, targets, max) => {
    if (!targets || targets.length === 0) return;
    const sorted = [...targets].sort(
      (a, b) => Math.abs(a.row - fromNode.row) - Math.abs(b.row - fromNode.row),
    );
    for (const t of sorted.slice(0, max)) addEdge(fromNode.id, t.id);
  };

  const startNode = nodes[startId];
  // Each layer C (0=start, 1..SPINE_END=spine) connects forward to the next
  // spine column (or boss), directly AND optionally via a detour in gap C.
  for (let C = 0; C <= SPINE_END; C++) {
    const fromNodes = (C === 0) ? [startNode] : spineByCol[C];
    const nextSpine = (C + 1 <= SPINE_END) ? spineByCol[C + 1] : [nodes[bossId]];
    const detours = detourByGap[C] || [];
    // Start opens onto ALL col-1 nodes + all gap-0 detours (full first
    // choice); other columns connect to the nearest 1-2 forward targets.
    const directMax = (C === 0) ? nextSpine.length : 2;
    for (const fn of fromNodes) {
      connectNearest(fn, nextSpine, directMax);
      if (detours.length > 0) connectNearest(fn, detours, (C === 0) ? detours.length : 1);
    }
    // Detours rejoin the spine: each → nearest 1-2 next-spine (or boss) nodes.
    for (const d of detours) connectNearest(d, nextSpine, 2);
  }

  // Reachability fix-up: every spine node (col >= 2), every detour, and the
  // boss must have ≥1 inbound edge. If missing, connect from the nearest
  // node in the integer column to its immediate left.
  const inbound = new Set(edges.map((e) => e.toId));
  for (const n of nodes) {
    if (n.col <= 1 || inbound.has(n.id)) continue;
    const leftCol = Number.isInteger(n.col) ? n.col - 1 : Math.floor(n.col);
    const sources = nodes.filter((m) => m.col === leftCol);
    if (sources.length === 0) continue;
    const nearest = sources.slice().sort(
      (a, b) => Math.abs(a.row - n.row) - Math.abs(b.row - n.row),
    )[0];
    addEdge(nearest.id, n.id);
    inbound.add(n.id);
  }

  return { actIndex, nodes, edges, startNode: startId, bossNode: bossId, bossFaction };
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
  // Blue fleet can be MULTI-RACE: native craft + capitals fly the
  // player's allied race (Frontier = run.faction = "terran"), while
  // captured ships keep their original enemy race. Group every blue
  // asset by race into `blueTeams` so spawnRoster spawns each race's
  // ships with the correct hull / sprite / spec.
  const alliedRace = run.faction || "terran";
  const byRace = {}; // race -> { fighter, bomber, frigate, ... }
  const addTo = (race, klass, n) => {
    if (n <= 0) return;
    byRace[race] = byRace[race] || {};
    byRace[race][klass] = (byRace[race][klass] || 0) + n;
  };
  // Native small craft (the replenishing pool).
  addTo(alliedRace, "fighter", run.smallCraft.fighter || 0);
  addTo(alliedRace, "bomber", run.smallCraft.bomber || 0);
  // Captured small craft — each keeps its own race.
  for (const c of (run.capturedCraft || [])) {
    addTo(c.race || alliedRace, c.klass, 1);
  }
  // Capitals — native (race null) fly allied; captured carry their race.
  for (const cap of run.capitals) {
    addTo(cap.race || alliedRace, cap.klass, 1);
  }
  // Allied race team must be FIRST so promotePlayer recycles a native
  // fighter for the player ship (player always flies their own design).
  const races = Object.keys(byRace).sort(
    (a, b) => (a === alliedRace ? -1 : b === alliedRace ? 1 : 0),
  );
  const blueTeams = races.map((r) => ({ race: r, counts: byRace[r] }));
  // Legacy single-roster blue (allied race only) for any consumer that
  // still reads cfg.blue. Mirrors the allied team's counts.
  const blueRoster = byRace[alliedRace] ? { ...byRace[alliedRace] } : {};

  // Ordered manifest for per-instance wounded spawns. Race-aware so a
  // wounded native frigate and a captured (different-race) frigate each
  // pop the right hpFrac + instanceId. `race` null = allied.
  const capitalsManifest = run.capitals.map((c) => ({
    klass: c.klass,
    hpFrac: c.hpFrac,
    instanceId: c.instanceId,
    race: c.race || null,
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

  // Phase 1 — reputation shapes the battle (shared preview helper so
  // the Battle Plan readout matches what spawns). Allied reinforcements
  // spawn BLUE (tagged + spawned separately in modes/roguelite.js so
  // they don't persist). Grudge scales a Marked enemy faction's roster.
  const { reinforcements, grudge } = battleReputationPreview(run, node);
  const redRoster = grudge ? scaleRoster(node.roster, grudge.mul) : node.roster;

  return {
    blue: blueRoster,
    // Multi-race blue fleet (native + captured). spawnRoster prefers
    // blueTeams when present, falling back to the single `blue` roster.
    blueTeams,
    red: redRoster,
    hostileRace: node.faction,
    // Allied reinforcements (rep >= Friendly) + grudge (Marked enemy).
    // modes/roguelite.js spawns the reinforcements as a tagged pass;
    // the Battle Plan previews both.
    reinforcements,
    grudge,
    battleMode,
    capitalsManifest,
    playerSpecOverride,
    // Boons stack onto every BLUE ship's spec at spawn time via
    // applyBoonPatches. Game.js stashes this on game.activeBoons so
    // every spawnX path can pass it through to createShip.
    activeBoons: (run.boons || []).slice(),
    // Trait keys that have fleet-wide spec effects (e.g. Drill
    // Sergeant's carrier replenish). Applied via applyTraitFleetPatches
    // alongside applyBoonPatches at ship-creation.
    activeFleetTraits: (run.traits || []).slice(),
    // Pre-battle doctrine (Tier 34). Picked on the battle-choice
    // screen; threaded through to spawnCapital so every blue capital
    // spawns with doctrine effects layered on top of captain traits.
    battleDoctrine: run.battleDoctrine || "skirmish",
    // Bookkeeping for capturer.
    run,
    node,
  };
}

// ---------------------------------------------------------------------------
// Post-battle: walk live ships, write HP back into run.capitals.
// ---------------------------------------------------------------------------

export function captureBattleOutcome(run, game) {
  // Snapshot pre-battle small-craft counts so we can compute deltas
  // for the after-action reward chips.
  const preFighters = run.smallCraft.fighter;
  const preBombers = run.smallCraft.bomber;
  const won = game.winner === "blue";

  // Build a quick lookup of alive blue capitals by instanceId. Surrendered
  // ally capitals count as "alive" — if we win the match they stay in
  // the fleet (struck colors, towed home).
  const aliveById = new Map();
  for (const s of game.ships) {
    if (s.side !== "blue" || !s.runtimeInstanceId) continue;
    if (s.dead) continue;
    aliveById.set(s.runtimeInstanceId, s);
  }

  // Drop destroyed capitals; update hpFrac on survivors. Surrendered
  // ally ships are kept if we won; if we lost they're considered lost
  // (the surrender doesn't save them when the engagement collapses).
  const survivors = [];
  const lostCapitals = [];
  for (const cap of run.capitals) {
    const live = aliveById.get(cap.instanceId);
    if (!live) {
      lostCapitals.push({ klass: cap.klass, name: cap.name, captain: cap.captain });
      continue;
    }
    if (live.surrendered && !won) {
      // Surrendered + we lost = ship captured by the enemy. Mark as lost.
      lostCapitals.push({ klass: cap.klass, name: cap.name, captain: cap.captain, capturedByEnemy: true });
      continue;
    }
    cap.hpFrac = Math.max(0, Math.min(1, live.hp / live.hpMax));
    survivors.push(cap);
  }
  run.capitals = survivors;

  // Count surviving small craft, split by race. Native craft (allied
  // race) feed run.smallCraft (the replenishing pool); captured craft
  // (any other race) are rebuilt into run.capturedCraft so their race
  // persists to the next battle. The player ship is a fighter but
  // respawns each battle — don't count it as a fleet asset.
  const alliedRace = run.faction;
  let nativeFighters = 0, nativeBombers = 0;
  const survivingCaptured = [];
  for (const s of game.ships) {
    if (s.dead || s.side !== "blue" || s.isPlayer) continue;
    // Allied reinforcements are one-battle support — they never join
    // the persistent fleet (native pool or captured list).
    if (s.alliedReinforcement) continue;
    const isNative = (s.race === alliedRace);
    if (s.klass === "fighter") {
      if (isNative) {
        // Escort fighters (escortOf set) are tied to a capital — their
        // accounting is implicit in capital survival; count only loose.
        if (!s.escortOf) nativeFighters++;
      } else {
        survivingCaptured.push({ race: s.race, klass: "fighter" });
      }
    } else if (s.klass === "bomber") {
      if (isNative) nativeBombers++;
      else survivingCaptured.push({ race: s.race, klass: "bomber" });
    }
  }
  run.smallCraft.fighter = nativeFighters;
  run.smallCraft.bomber = nativeBombers;
  // Rebuild captured-craft list from THIS battle's blue survivors.
  // Newly-surrendered enemy craft are appended below.
  run.capturedCraft = survivingCaptured;

  // Capture surrendered enemy ships if we won. They join the player's
  // fleet for the next battle, KEEPING their original race — a captured
  // Reaver fighter stays a Reaver fighter (hull / sprite / spec), it
  // just flies on the blue side. Capitals go into run.capitals (with
  // a `race` field); small craft append to run.capturedCraft as
  // `{ race, klass }` entries (separate from the native smallCraft pool
  // so the race is preserved through respawn).
  const capturedReport = [];
  if (won) {
    for (const s of game.ships) {
      if (s.dead || !s.surrendered || s.side !== "red") continue;
      const race = s.race || "unknown";
      if (s.klass === "frigate" || s.klass === "cruiser" || s.klass === "battleship" || s.klass === "carrier") {
        // Capital — procedural name + captain, race preserved.
        const newCap = makeNamedCapital(s.klass, run.nextInstanceId++, run.rng || mulberry32(run.seed), race);
        newCap.hpFrac = Math.max(0.4, Math.min(1, s.hp / s.hpMax));  // wounded but alive
        newCap.captured = true;
        newCap.capturedAt = Date.now();
        newCap.capturedFrom = race;
        run.capitals.push(newCap);
        capturedReport.push({ klass: s.klass, name: newCap.name, race });
      } else if (s.klass === "fighter" || s.klass === "bomber") {
        // Small craft — track race + klass; spawns blue next battle.
        run.capturedCraft.push({ race, klass: s.klass });
        capturedReport.push({ klass: s.klass, name: `${race} ${s.klass}`, race });
      }
    }
    if (capturedReport.length > 0) {
      run._capturedThisBattle = capturedReport;
      // Career-log entry for the captured ships.
      appendRunLog(run, "capture", `Captured ${capturedReport.length} surrendered craft: ${capturedReport.map(c => c.name).join(", ")}`);
    }
  }

  // Award XP to all surviving capitals (drop happens above; survivors
  // are now in run.capitals). XP scales with node type.
  awardCaptainXp(run, game.pendingNode || null);

  // After-action report. The match-over panel (Frontier mode) reads
  // this to display lost/killed/promotion. Reward is a procedural
  // "battlefield promotion" — a flavored beat instead of a flat
  // numeric drop. See rollBattlefieldPromotion + PROMOTION_ARCHETYPES.
  const tallies = game.tallies || { blue: {}, red: {} };
  // Roll the engagement tally into the run's career stats. Per-class.
  const stats = ensureStats(run);
  for (const k of Object.keys(tallies.red || {})) {
    stats.shipsKilled[k] = (stats.shipsKilled[k] || 0) + (tallies.red[k] || 0);
  }
  for (const k of Object.keys(tallies.blue || {})) {
    stats.shipsLost[k] = (stats.shipsLost[k] || 0) + (tallies.blue[k] || 0);
  }
  const pendingNode = game.pendingNode || null;
  const partialReport = {
    lost: { ...tallies.blue },
    killed: { ...tallies.red },
    lostCapitals,
  };
  const promo = rollBattlefieldPromotion(run, pendingNode, partialReport);

  // Apply the promotion's reward to the run state.
  if (promo.reward.fighter) {
    run.smallCraft.fighter = Math.min(MAX_FIGHTERS, run.smallCraft.fighter + promo.reward.fighter);
  }
  if (promo.reward.bomber) {
    run.smallCraft.bomber = Math.min(MAX_BOMBERS, run.smallCraft.bomber + promo.reward.bomber);
  }
  if (promo.reward.credits) {
    run.resources.credits += promo.reward.credits;
  }
  // Battlefield commission grants a frigate. Use the promotion's
  // captain (named via the archetype) instead of rolling a fresh one.
  if (promo.bonusCapital) {
    const cap = makeNamedCapital(promo.bonusCapital.klass, run.nextInstanceId++, Math.random);
    if (promo.bonusCapital.captain) cap.captain = promo.bonusCapital.captain;
    run.capitals.push(cap);
  }

  // Wing roster — accumulate named pilots from promotions so the
  // dossier shows the player's growing wing. Cap at 12 entries
  // (oldest shifts out) so it stays readable mid-late run.
  if (promo.rosterEntry) {
    if (!Array.isArray(run.wingRoster)) run.wingRoster = [];
    run.wingRoster.push(promo.rosterEntry);
    if (run.wingRoster.length > 12) {
      run.wingRoster.splice(0, run.wingRoster.length - 12);
    }
  }

  run.lastBattleReport = {
    ...partialReport,
    promo,
    reward: promo.reward,
    captured: capturedReport,
    smallCraftBefore: { fighter: preFighters, bomber: preBombers },
    smallCraftAfter: { fighter: run.smallCraft.fighter, bomber: run.smallCraft.bomber },
  };

  // Append a one-liner to the career log so the memoir reflects the
  // body count + the promotion. Two entries: the engagement line
  // (numbers) and the promotion line (flavor).
  const totalKilled = Object.values(run.lastBattleReport.killed)
    .reduce((a, b) => a + b, 0);
  const totalLost = Object.values(run.lastBattleReport.lost)
    .reduce((a, b) => a + b, 0);
  if (totalKilled > 0 || totalLost > 0) {
    appendRunLog(run, "note", `Engagement: ${totalKilled} destroyed, ${totalLost} lost.`);
  }
  if (promo && promo.body) {
    appendRunLog(run, "promotion", `${promo.headline}. ${promo.body}`);
  }
}

// ---------------------------------------------------------------------------
// Node-clear flow: tick drips, pay out, advance position, transition acts.
// ---------------------------------------------------------------------------

export function completeNode(run, nodeId) {
  const node = nodeAt(run, nodeId);
  if (!node) return;

  run.visitedNodeIds.push(nodeId);
  // Stats counters — tracked per-node-type so the end-run page reads
  // "X battles cleared, Y events resolved" etc.
  const stats = ensureStats(run);
  stats.nodesCleared++;
  // Shipyard meta-tally (Phase 2): every cleared node pays a small
  // flat bonus; boss clears add a bigger lump in the payout formula.
  // Default to 0 if older save loaded without the field.
  run.nodesCleared = (run.nodesCleared || 0) + 1;
  if (node.type === "boss") {
    run.bossesDefeated = (run.bossesDefeated || 0) + 1;
  }
  if (node.type === "battle")        stats.battlesCleared++;
  else if (node.type === "elite")    stats.elitesCleared++;
  else if (node.type === "boss")     stats.bossesKilled++;
  else if (node.type === "event")    stats.eventsResolved++;
  else if (node.type === "resupply") stats.resupplyVisits++;
  // Track fuel burned (paid at jump time so the edge cost is now
  // already subtracted from resources.fuel; the count goes here).
  stats.fuelBurned += 1;

  // The fuel cost was paid at jump time (see enterNode below). The drip
  // and payout happen on clear.
  const creditsBefore = run.resources.credits;
  tickInterNode(run);
  payoutFor(node, run);
  const creditsGained = run.resources.credits - creditsBefore;
  if (creditsGained > 0) stats.creditsEarned += creditsGained;
  // Contract resolution — check if this node satisfies any active
  // contract target (e.g. delivering supplies at a resupply node).
  resolveContractsOnNode(run, node);

  // Reputation shifts — clearing a node hits the enemy faction's
  // standing and slightly boosts Coalition rep (the Service notes
  // engagements). Bosses sink rep harder than trash nodes.
  if (node.faction && node.faction !== "terran") {
    let factionDelta = -3;
    if (node.type === "elite") factionDelta = -6;
    if (node.type === "boss")  factionDelta = -25;
    shiftReputation(run, node.faction, factionDelta);
    // Coalition gains a small bump on every cleared engagement.
    if (node.type === "battle" || node.type === "elite") {
      shiftReputation(run, "coalition", 1);
    }
    if (node.type === "boss") {
      shiftReputation(run, "coalition", 6);
    }
  }

  // Procedural rival follow-up: clearing an elite node tagged with a
  // rivalId marks that rival defeated. Story-arc cards + dossier entries
  // read off this status. Rivals defeated mid-act stop spawning in
  // later acts of the same run.
  if (node.rivalId && run.rivals) {
    const rival = run.rivals.find((r) => r.id === node.rivalId);
    if (rival && rival.status === "active") {
      rival.status = "defeated";
      rival.defeatedAct = run.act;
      run.flags = run.flags || {};
      run.flags[`rivalDown_${rival.id}`] = rival.name;
      appendRunLog(run, "rival", `Killed ${rival.name} in Act ${run.act}. Marked target down.`);
      stats.rivalsDefeated++;
    }
  } else if (node.aceName) {
    appendRunLog(run, "ace", `Cleared ${node.aceName}'s intercept in Act ${run.act}.`);
  }

  run.nodePos = nodeId;
  run.pendingNode = null;

  // Boss clear → act transition (or run completion on final act).
  if (node.type === "boss") {
    const bossEntry = BOSSES[run.act];
    if (bossEntry) {
      appendRunLog(run, "boss", `Closed Act ${run.act} — ${bossEntry.name} down.`);
    }
    if (run.act >= ACTS_PER_RUN) {
      // Run complete — record meta, clear the run, fire the event.
      // The match-over panel ("Tap to return to fleet") handles the
      // UI dismissal; refresh() will then see no active run and the
      // menu reverts to "NEW RUN".
      appendRunLog(run, "promotion", `War concluded. Career closes with honors.`);
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
    // Close any arc stages whose actTags window we just left without
    // firing — the player gets the off-screen resolution as a log
    // entry. Runs BEFORE the act bumps so completedAct is the act we
    // just left.
    closeOrphanedArcStages(run, run.act);
    const promotion = applyPromotion(run, newAct);
    run.act = newAct;
    const nextGraph = generateAct(run, run.act);
    run.graphs.push(nextGraph);
    run.nodePos = nextGraph.startNode;
    run.visitedNodeIds = [nextGraph.startNode];
    run.pendingPromotion = promotion;
    // Stamp the next act's preamble. UI shows it AFTER the promotion
    // overlay so the sequence reads: boss clear → promotion celebration
    // → war-state briefing → dispatch → starmap.
    run.pendingPreamble = buildPreamble(run, newAct);
    run.pendingDispatch = pickDispatch(run, newAct);
    appendRunLog(run, "promotion", `Promoted to ${ACT_RANKS[newAct] && ACT_RANKS[newAct].rank ? ACT_RANKS[newAct].rank : `Act ${newAct} rank`}.`);
    stats.promotionsEarned++;
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
  // Act-transition REFIT — returning to friendly space for the
  // promotion tops fuel up to the baseline (never reduces it). This is
  // the main between-acts refuel now that combat clears no longer
  // refund fuel; within an act fuel only drains.
  if (run.resources) {
    run.resources.fuel = Math.max(run.resources.fuel || 0, ACT_REFIT_FUEL);
  }
  // Per-trait promotion hooks fire before the new-fleet additions so
  // Survivor heals the wounded capitals BEFORE the rank-up's fresh
  // capitals join the line (otherwise the new full-hp ships would
  // dilute the "most wounded" pick).
  for (const k of (run.traits || [])) {
    const t = TRAITS[k];
    if (t && t.promotionEffect) t.promotionEffect(run);
  }
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
    const cap = makeNamedCapital(c.klass, run.nextInstanceId++, Math.random);
    run.capitals.push(cap);
    // Variant pick (Tier 40) — addedCapitals carries the variant
    // options for the promotion overlay to render. Player's pick is
    // committed via selectCapitalVariant. Until then the capital has
    // no variant (spawns at baseline).
    const variants = variantsForKlass(cap.klass);
    addedCapitals.push({
      klass: c.klass,
      name: cap.name,
      captain: cap.captain,
      instanceId: cap.instanceId,
      variants: variants.map((v) => ({ key: v.key, label: v.label, blurb: v.blurb })),
    });
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
    const j = i + Math.floor(safeRng(run) * (pool.length - i));
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

// Dismiss the act-intro preamble overlay. Called from UI when the
// player taps PROCEED on the war-state briefing.
export function clearPendingPreamble(run) {
  if (!run) return;
  run.pendingPreamble = null;
  saveRun(run);
}

// Dismiss the inter-act dispatch overlay. Called from UI when the
// player taps ACKNOWLEDGE on the transmission screen.
export function clearPendingDispatch(run) {
  if (!run) return;
  run.pendingDispatch = null;
  saveRun(run);
}

// Append a single line to the career log. `kind` is a category tag
// used by the UI to tint the row (boss / rival / arc / promotion /
// note); `text` is the line itself. Cap the log at 80 entries — the
// memoir end-screen wouldn't read past that anyway and we don't want
// the save blob to grow unbounded.
const MAX_LOG_ENTRIES = 80;
export function appendRunLog(run, kind, text) {
  if (!run || !text) return;
  if (!Array.isArray(run.log)) run.log = [];
  run.log.push({ act: run.act, kind, text });
  if (run.log.length > MAX_LOG_ENTRIES) {
    run.log.splice(0, run.log.length - MAX_LOG_ENTRIES);
  }
}

// Apply the cost of jumping to a node BEFORE entering it. Called by
// main.js when the player picks a battle / event / resupply destination.
// ---------------------------------------------------------------------------
// Run stats — chronological totals tracked over the career. Surfaced
// live in the STATS overlay (run.stats) and snapshotted into the
// memorial entry at recordRunEnd. Read-only in UI; mutated by the
// completeNode / captureBattleOutcome / buy* helpers.
// ---------------------------------------------------------------------------

function initRunStats() {
  return {
    nodesCleared: 0,
    battlesCleared: 0,
    elitesCleared: 0,
    bossesKilled: 0,
    eventsResolved: 0,
    resupplyVisits: 0,
    shipsKilled: { fighter: 0, bomber: 0, frigate: 0, cruiser: 0, battleship: 0, carrier: 0, station: 0 },
    shipsLost:   { fighter: 0, bomber: 0, frigate: 0, cruiser: 0, battleship: 0, carrier: 0, station: 0 },
    creditsEarned: 0,
    creditsSpent: 0,
    fuelBurned: 0,
    boonsAcquired: 0,
    repairsPurchased: 0,
    recruitsHired: 0,
    contractsCompleted: 0,
    contractsFailed: 0,
    rivalsDefeated: 0,
    promotionsEarned: 0,
    jumpEncounters: 0,
    arcsCompleted: 0,
  };
}

// Lazy-initialize stats on old saves that pre-date this field.
function ensureStats(run) {
  if (!run.stats) run.stats = initRunStats();
  return run.stats;
}

// run.rng is a function set at startNewRun via mulberry32, but it's
// dropped by JSON serialization on save/load. Any code path that
// fires AFTER a save/reload must go through this safe roller — it
// re-derives a deterministic-ish stream from run.seed + current
// node position, or falls back to Math.random if neither exists.
export function safeRng(run) {
  // Direct invocation — never recurses through safeRng itself.
  if (run && typeof run.rng === "function") return run.rng();
  if (run && typeof run.seed === "number") {
    // Lazy: rebuild rng on the run so subsequent calls in the same
    // node are stable. Cheap mulberry32 seeded by seed+visited-count.
    const visited = (run.visitedNodeIds || []).length;
    run.rng = mulberry32(((run.seed >>> 0) ^ (visited * 1009)) >>> 0);
    return run.rng();
  }
  return Math.random();
}

// Helper: bucket a kill/loss into stats. Side: "blue" = ours (loss),
// "red" = enemy (kill). Class is the ship class string.
export function recordCasualty(run, side, klass) {
  if (!run || !klass) return;
  const stats = ensureStats(run);
  const bucket = side === "blue" ? stats.shipsLost : stats.shipsKilled;
  bucket[klass] = (bucket[klass] || 0) + 1;
}

// Helper: track credits earned (positive) or spent (negative-as-spent).
export function recordCredits(run, deltaEarned, deltaSpent) {
  if (!run) return;
  const stats = ensureStats(run);
  if (deltaEarned > 0) stats.creditsEarned += deltaEarned;
  if (deltaSpent > 0) stats.creditsSpent += deltaSpent;
}

// ---------------------------------------------------------------------------
// Faction reputation — per-faction standing across the run. Each
// value lives in [-100, +100] with 0 neutral. Shifts with battles
// (kills sink rep with that faction), event choices (binary swings),
// and bosses (large negative). Surfaced in the dossier and used by
// downstream systems: vendor price nudges, special event preconditions,
// banter callbacks.
// ---------------------------------------------------------------------------

const REPUTATION_FACTIONS = ["coalition", "hegemony", "reavers", "voidsworn"];

function initReputation() {
  return { coalition: 30, hegemony: 0, reavers: -10, voidsworn: -10 };
}

// Shift a faction's reputation by `delta`, clamped to [-100, +100].
// Logs a one-liner if the shift crosses a notable threshold so the
// player notices reputation actually moved.
export function shiftReputation(run, faction, delta) {
  if (!run || !faction || !delta) return;
  if (!run.reputation) run.reputation = initReputation();
  if (!REPUTATION_FACTIONS.includes(faction)) return;
  const before = run.reputation[faction] || 0;
  const after = Math.max(-100, Math.min(100, before + delta));
  run.reputation[faction] = after;
  // Threshold crossings: ±50 is "marked" territory. Log the moment.
  const labels = {
    coalition: "Coalition",
    hegemony: "Hegemony",
    reavers: "Reaver",
    voidsworn: "Voidsworn",
  };
  if (before < 50 && after >= 50) {
    appendRunLog(run, "note", `${labels[faction]} forces now consider you a known ally.`);
  } else if (before > -50 && after <= -50) {
    appendRunLog(run, "note", `${labels[faction]} forces have flagged your transponder.`);
  } else if (before <= -50 && after > -50) {
    appendRunLog(run, "note", `${labels[faction]} flag dropped from your file.`);
  }
}

// Helper: read current reputation for a faction (defaults to 0).
export function getReputation(run, faction) {
  if (!run || !run.reputation) return 0;
  return run.reputation[faction] || 0;
}

// Convert raw reputation to a one-word standing label for UI.
export function reputationLabel(value) {
  if (value >= 70)  return "Allied";
  if (value >= 30)  return "Friendly";
  if (value >= -10) return "Neutral";
  if (value >= -50) return "Hostile";
  return "Marked";
}

// Battle credit multiplier from reputation. High Coalition rep means
// better contracts → small payout bump. Low Coalition rep penalises
// (you're shopping at gray markets). Stacks with traits/perks.
function reputationCreditMul(run) {
  const c = getReputation(run, "coalition");
  if (c >= 70) return 1.15;
  if (c >= 30) return 1.05;
  if (c <= -50) return 0.85;
  if (c <= -10) return 0.95;
  return 1;
}

// Vendor price modifier. Higher Coalition rep = cheaper at Coalition
// quartermasters. Higher Reaver/Voidsworn enmity = pricier (no one
// likes the bounty pilot).
function reputationVendorMul(run, vendorKey) {
  const c = getReputation(run, "coalition");
  if (vendorKey === "quartermaster") {
    if (c >= 50) return 0.90;
    if (c <= -30) return 1.10;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Phase 1 — reputation drives battle composition. Friendly factions
// (rep >= 30) send ships that fight on the player's side; factions the
// player is Marked with (rep <= -50) throw heavier resistance.
// ---------------------------------------------------------------------------

// Reputation faction -> ship race for spawned reinforcements. Coalition
// support flies Terran (the player's own service); the others field
// their own hulls.
const FACTION_RACE = {
  coalition: "terran",
  hegemony: "hegemony",
  reavers: "reavers",
  voidsworn: "voidsworn",
};

// Allied reinforcement contingent by reputation tier. null below
// Friendly (30). Scales with standing so a deep alliance fields a real
// wing, not a token gesture.
function alliedReinforcementFor(rep) {
  if (rep >= 90) return { fighter: 3, bomber: 1, frigate: 1 };
  if (rep >= 70) return { fighter: 3, bomber: 1 };
  if (rep >= 50) return { fighter: 2 };
  if (rep >= 30) return { fighter: 1 };
  return null;
}

// Enemy-roster multiplier when the player is Marked with that faction.
// They commit heavier resistance to a known, hunted threat.
function grudgeMultiplierFor(rep) {
  if (rep <= -80) return 1.4;
  if (rep <= -50) return 1.25;
  return 1;
}

// Allied reinforcements for a battle at `node`. Returns
// `[{ faction, race, fighter?, bomber?, frigate? }]`. Excludes the
// node's own enemy faction (they won't help you fight themselves).
// Exported so the Battle Plan pre-flight screen can preview the
// inbound support.
export function alliedReinforcementsForBattle(run, node) {
  const out = [];
  for (const fac of REPUTATION_FACTIONS) {
    // Coalition is the player's OWN service (Terran). Its standing
    // pays out in credits + vendor pricing (reputationCreditMul /
    // reputationVendorMul), not reinforcements — terran support would
    // be visually identical to native fighters and muddy the fleet.
    // The reinforcement mechanic is about winning OVER the rival
    // factions (Hegemony / Reavers / Voidsworn) so they fight beside
    // you in their own hulls.
    if (fac === "coalition") continue;
    const race = FACTION_RACE[fac];
    if (!race) continue;
    if (node && (node.faction === fac || node.faction === race)) continue;
    const reinf = alliedReinforcementFor(getReputation(run, fac));
    if (!reinf) continue;
    out.push({ faction: fac, race, ...reinf });
  }
  return out;
}

// Single source of truth for how reputation reshapes a battle:
// allied reinforcements + grudge. Used by buildModeConfig (to apply)
// AND the Battle Plan menu state (to preview). Keeping it one function
// guarantees the preview matches what actually spawns.
export function battleReputationPreview(run, node) {
  const reinforcements = alliedReinforcementsForBattle(run, node);
  let grudge = null;
  if (node && node.faction) {
    const enemyRep = getReputation(run, node.faction);
    const gm = grudgeMultiplierFor(enemyRep);
    if (gm > 1) grudge = { faction: node.faction, rep: enemyRep, mul: gm };
  }
  return { reinforcements, grudge };
}

// ---------------------------------------------------------------------------
// Cargo contracts — a meta-objective layer. An event card can offer
// the player a contract: carry this cargo to a target node type
// within N jumps, claim a reward. Contracts run in parallel to the
// main story arcs.
//
// Shape: { key, name, description, cargo, target, deadline, reward,
//          status: "active" | "delivered" | "failed", pickedUpAt }
//   target = { type: "resupply" | "boss" | "battle", faction?: string }
//   reward = { credits?, fighter?, bomber?, boonKey?, capital? }
// ---------------------------------------------------------------------------

const CONTRACT_DEFS = {
  "coalition-supplies": {
    name: "Coalition Resupply",
    description: "Deliver coded supplies to any resupply depot within 4 jumps.",
    cargo: "Sealed Coalition supply crate",
    target: { type: "resupply" },
    deadline: 4,
    reward: { credits: 80 },
    failPenalty: { credits: -30 },
  },
  "hegemony-prisoner": {
    name: "Prisoner Transfer",
    description: "Hand a Hegemony prisoner over at the next resupply node. Limit 3 jumps — they're shouting.",
    cargo: "Hegemony prisoner (confined)",
    target: { type: "resupply" },
    deadline: 3,
    reward: { credits: 60, boonKey: null },
    failPenalty: { credits: -20 },
  },
  "field-medic-evac": {
    name: "Medical Evac",
    description: "Get the wounded medic to the next resupply depot within 2 jumps. They are stable. For now.",
    cargo: "Critical-condition medical evacuee",
    target: { type: "resupply" },
    deadline: 2,
    reward: { credits: 40, fighter: 2 },
    failPenalty: { credits: 0 },
    failDeath: true, // log a fallen note on failure
  },
  "voidsworn-artifact": {
    name: "Sealed Reliquary",
    description: "Bring the Voidsworn relic to the act-finale boss. Coalition R&D wants it on-site.",
    cargo: "Voidsworn reliquary, sealed",
    target: { type: "boss" },
    deadline: 8,
    reward: { credits: 150, boonKey: "precog-targeting" },
    failPenalty: { credits: 0 },
  },
};

// Offer a contract — adds it to run.contracts as active. Called from
// event card apply callbacks. Caps total active contracts at 2 so the
// dossier doesn't read as a logistics screen.
export function offerContract(run, defKey) {
  const def = CONTRACT_DEFS[defKey];
  if (!def) return false;
  if (!Array.isArray(run.contracts)) run.contracts = [];
  if (run.contracts.filter((c) => c.status === "active").length >= 2) return false;
  run.contracts.push({
    key: defKey,
    name: def.name,
    description: def.description,
    cargo: def.cargo,
    target: { ...def.target },
    deadline: def.deadline,
    jumpsLeft: def.deadline,
    reward: { ...def.reward },
    failPenalty: { ...(def.failPenalty || {}) },
    failDeath: !!def.failDeath,
    status: "active",
    pickedUpAt: (run.visitedNodeIds || []).length,
  });
  return true;
}

// Tick deadlines; expire any contract whose deadline runs out.
function tickContracts(run) {
  if (!Array.isArray(run.contracts) || run.contracts.length === 0) return;
  for (const c of run.contracts) {
    if (c.status !== "active") continue;
    c.jumpsLeft = Math.max(0, c.jumpsLeft - 1);
    if (c.jumpsLeft === 0) {
      c.status = "failed";
      if (c.failPenalty && c.failPenalty.credits) {
        run.resources.credits = Math.max(0, run.resources.credits + c.failPenalty.credits);
      }
      appendRunLog(run, "note", `Contract failed: ${c.name}. The cargo is now your problem.`);
      ensureStats(run).contractsFailed++;
    }
  }
}

// Check whether the just-completed node satisfies any active contract.
// Called from completeNode. Resolves contracts in-order; multiple can
// resolve on the same node but each cargo is consumed once.
function resolveContractsOnNode(run, node) {
  if (!Array.isArray(run.contracts) || run.contracts.length === 0) return;
  for (const c of run.contracts) {
    if (c.status !== "active") continue;
    if (c.target.type !== node.type) continue;
    if (c.target.faction && node.faction !== c.target.faction) continue;
    c.status = "delivered";
    if (c.reward.credits) run.resources.credits += c.reward.credits;
    if (c.reward.fighter) {
      run.smallCraft.fighter = Math.min(MAX_FIGHTERS, run.smallCraft.fighter + c.reward.fighter);
    }
    if (c.reward.bomber) {
      run.smallCraft.bomber = Math.min(MAX_BOMBERS, run.smallCraft.bomber + c.reward.bomber);
    }
    if (c.reward.boonKey) {
      const boon = BOON_TABLE.find((b) => b.key === c.reward.boonKey);
      if (boon && !run.boons.find((b) => b.key === boon.key)) {
        run.boons.push({ key: boon.key, desc: boon.desc });
      }
    }
    appendRunLog(run, "promotion", `Contract delivered: ${c.name}. Payment cleared.`);
    ensureStats(run).contractsCompleted++;
  }
}

// ---------------------------------------------------------------------------
// Event followups. An event-card choice can schedule a downstream card
// to fire `jumpsUntilFire` jumps later. tickInterNode counts it down;
// once primed, the next event node the player lands on swaps its
// eventId to the followup. Multiple followups queue (FIFO).
//
// Shape: { key, eventId, jumpsUntilFire, sourceFlavor }
// ---------------------------------------------------------------------------

export function scheduleFollowup(run, eventId, jumpsUntilFire, sourceFlavor = "") {
  if (!run || !eventId) return;
  if (!Array.isArray(run.pendingFollowups)) run.pendingFollowups = [];
  run.pendingFollowups.push({
    key: eventId + "@" + (run.visitedNodeIds || []).length,
    eventId,
    jumpsUntilFire: Math.max(1, jumpsUntilFire | 0),
    sourceFlavor: sourceFlavor || "",
  });
}

// Auto-fire grace window: once a followup is primed (jumpsUntilFire
// hits 0), it has FOLLOWUP_GRACE more jumps to land on an event node.
// If the player avoids events past that, the followup fires
// "remotely" via auto-apply so the player gets the payoff regardless.
const FOLLOWUP_GRACE = 3;

function tickFollowups(run) {
  if (!Array.isArray(run.pendingFollowups) || run.pendingFollowups.length === 0) return;
  const survivors = [];
  for (const f of run.pendingFollowups) {
    if (f.jumpsUntilFire > 0) {
      f.jumpsUntilFire -= 1;
      survivors.push(f);
      continue;
    }
    // Primed. Increment the grace counter; auto-fire when it expires.
    f.primedFor = (f.primedFor || 0) + 1;
    if (f.primedFor >= FOLLOWUP_GRACE) {
      // Auto-fire: pick the first option that passes its precondition
      // (the "default branch"), apply it, log a one-liner. The player
      // doesn't get a choice but they get closure.
      const card = eventCardById(f.eventId);
      if (card) {
        const titleStr = typeof card.title === "function" ? card.title(run) : (card.title || f.eventId);
        const opt = card.options.find((o) => !o.precondition || o.precondition(run))
                 || card.options[0];
        if (opt) {
          try {
            const result = opt.apply(run);
            appendRunLog(run, "note", `Remote: ${titleStr}. ${result || ""}`.trim());
          } catch (_e) {
            appendRunLog(run, "note", `Remote: ${titleStr} resolved off-screen.`);
          }
        }
      }
      // Drop the followup; don't keep it.
      continue;
    }
    survivors.push(f);
  }
  run.pendingFollowups = survivors;
}

// Pull (and remove) the first primed followup (jumpsUntilFire <= 0).
// Called when the player lands on an event node so that node uses
// the followup card instead of its originally-rolled eventId.
export function consumePrimedFollowup(run) {
  if (!Array.isArray(run.pendingFollowups) || run.pendingFollowups.length === 0) return null;
  const idx = run.pendingFollowups.findIndex((f) => f.jumpsUntilFire <= 0);
  if (idx < 0) return null;
  const [followup] = run.pendingFollowups.splice(idx, 1);
  return followup;
}

// ---------------------------------------------------------------------------
// Mid-jump random encounters — short flavored beats fired between
// nodes. ~30% chance per jump. Each encounter has a condition, weight,
// and an apply() that mutates the run (small +/- credits, fuel, crew
// reactions). UI surfaces as a one-tap overlay via run.pendingJumpEncounter.
// ---------------------------------------------------------------------------

const JUMP_ENCOUNTER_CHANCE = 0.32;

const JUMP_ENCOUNTERS = [
  {
    key: "asteroid-field",
    weight: 4,
    headline: "ASTEROID FIELD",
    speaker: "engineering",
    condition: () => true,
    apply: (run, _rng) => ({
      body: "Pilot threads a tight asteroid line. Two days saved on the burn. Maintenance fee paid in nerves.",
      reward: { credits: 0 },
      log: "Threaded asteroid field. Saved fuel.",
      effects: () => { run.resources.fuel += 1; },
    }),
  },
  {
    key: "solar-storm",
    weight: 3,
    headline: "SOLAR FLARE",
    speaker: "command",
    condition: (run) => run.resources.fuel >= 2,
    apply: (run, _rng) => ({
      body: "A flare from the binary catches the fleet sideways. Engineering vents fuel to bleed off radiation.",
      reward: { fuel: -1 },
      log: "Solar flare bled a fuel cell.",
      effects: () => { run.resources.fuel = Math.max(0, run.resources.fuel - 1); },
    }),
  },
  {
    key: "coalition-supply-drop",
    weight: 2,
    headline: "COURIER DROP",
    speaker: "command",
    condition: () => true,
    apply: (run, _rng) => ({
      body: "A Coalition courier rendezvous drops a supply crate at the midpoint. Credits inside, no questions.",
      reward: { credits: 30 },
      log: "Coalition courier dropped credits.",
      effects: () => { run.resources.credits += 30; },
    }),
  },
  {
    key: "wreck-salvage",
    weight: 3,
    headline: "DRIFTING WRECK",
    speaker: "engineering",
    condition: () => true,
    apply: (run, _rng) => ({
      body: "A husk drifts past on slow rotation. Boarding team strips it on the fly.",
      reward: { credits: 15 },
      log: "Salvaged a drifting hulk.",
      effects: () => { run.resources.credits += 15; },
    }),
  },
  {
    key: "ghost-ship",
    weight: 2,
    headline: "GHOST CONTACT",
    speaker: "intercept",
    condition: (run, act) => act >= 3,
    apply: (run, rng) => ({
      body: "Sensors paint a contact that vanishes when you look at it. Nothing on second sweep. Comms band hums.",
      reward: {},
      log: "Ghost contact on the jump. Nothing on second sweep.",
      effects: () => {
        run.flags = run.flags || {};
        // 50% chance the ghost contact tips the player toward Voidsworn
        // knowledge — using the local rng so it's seed-deterministic.
        if (!run.flags.knowsVoidsworn && rng() < 0.5) {
          run.flags.knowsVoidsworn = true;
        }
      },
    }),
  },
  {
    key: "fuel-leak",
    weight: 2,
    headline: "FUEL LEAK",
    speaker: "engineering",
    condition: (run) => run.resources.fuel >= 2,
    apply: (run, _rng) => ({
      body: "Aft fuel cell rupture mid-burn. Engineering crews patch it under load.",
      reward: { fuel: -1 },
      log: "Aft fuel cell ruptured mid-jump.",
      effects: () => { run.resources.fuel = Math.max(0, run.resources.fuel - 1); },
    }),
  },
  {
    key: "wingmate-banter",
    weight: 3,
    headline: "WING CHATTER",
    speaker: "wingman",
    condition: () => true,
    apply: (run, _rng) => {
      const msgs = [
        "Wing one cracks a joke about the briefing officer. Morale ticks up.",
        "Your second-seat starts a card game in the back of the canopy. Loses.",
        "Comms catches one of your wingmen humming a Coalition lullaby. The band stays open.",
        "Tail-gunner tells the same joke for the fifth jump. It still lands.",
      ];
      return {
        body: msgs[Math.floor(Math.random() * msgs.length)],
        reward: {},
        log: "Wing banter on the long jump.",
        effects: () => {},
      };
    },
  },
  {
    key: "hegemony-patrol",
    weight: 2,
    headline: "HEGEMONY PATROL",
    speaker: "intercept",
    condition: (run, act) => act >= 2 && act <= 4,
    apply: (run, _rng) => ({
      body: "A Hegemony picket cruiser tracks your transponder for ten minutes, then turns off. Pretense maintained.",
      reward: {},
      log: "Hegemony patrol tracked us. They blinked first.",
      effects: () => {},
    }),
  },
  {
    key: "reaver-decoy",
    weight: 2,
    headline: "REAVER DECOY",
    speaker: "intercept",
    condition: (run, act) => act <= 3,
    apply: (run, _rng) => ({
      body: "A Reaver decoy buoy chirps an ambush warning. False positive. Pilots are sharper for it.",
      reward: {},
      log: "Reaver decoy buoy. Sharpened the wing.",
      effects: () => {},
    }),
  },
  {
    key: "lost-pilot",
    weight: 2,
    headline: "BEACON IN THE DARK",
    speaker: "ally",
    condition: () => true,
    apply: (run, _rng) => ({
      body: "A lone Coalition fighter signals from outside the jump corridor. Damaged, alone, alive. You wave them in.",
      reward: { fighter: 1 },
      log: "Picked up a stray Coalition pilot.",
      effects: () => {
        run.smallCraft.fighter = Math.min(MAX_FIGHTERS, run.smallCraft.fighter + 1);
      },
    }),
  },
  {
    key: "voidsworn-static",
    weight: 1,
    headline: "CHOIR STATIC",
    speaker: "voidsworn",
    condition: (run, act) => act >= 4,
    apply: (run, _rng) => ({
      body: "Voidsworn carrier-band cuts in for three seconds. Your callsign repeats, recursively.",
      reward: {},
      log: "Voidsworn signal mid-jump. They know us.",
      effects: () => {
        run.flags = run.flags || {};
        run.flags.knowsVoidsworn = true;
      },
    }),
  },
  {
    key: "engine-tuning",
    weight: 2,
    headline: "DEEP-JUMP TUNING",
    speaker: "engineering",
    condition: () => true,
    apply: (run, _rng) => ({
      body: "Long jump gives engineering time to tune the drive. Burn efficiency up.",
      reward: { credits: 10 },
      log: "Engine tuning credit cleared.",
      effects: () => { run.resources.credits += 10; },
    }),
  },
];

// Roll a mid-jump encounter. Returns null if the dice don't hit or no
// archetype is eligible. The picker is run+node deterministic so the
// same jump always shows the same beat.
export function rollJumpEncounter(run, fromNodeId, toNodeId) {
  if (!run) return null;
  const visited = (run.visitedNodeIds || []).length;
  // Skip the first jump (player just got off the briefing) and any
  // jump that lands on a boss node (the boss approach is dramatic
  // enough already).
  if (visited === 0) return null;
  const toNode = nodeAt(run, toNodeId);
  if (toNode && toNode.type === "boss") return null;

  const seed = ((run.seed >>> 0) ^ (fromNodeId * 7457) ^ (toNodeId * 6151)) >>> 0;
  const localRng = mulberry32(seed || 1);
  if (localRng() > JUMP_ENCOUNTER_CHANCE) return null;

  const act = run.act || 1;
  const eligible = JUMP_ENCOUNTERS.filter((e) => {
    try { return e.condition(run, act); }
    catch { return false; }
  });
  if (eligible.length === 0) return null;
  const total = eligible.reduce((a, b) => a + b.weight, 0);
  let pick = localRng() * total;
  let chosen = eligible[0];
  for (const e of eligible) {
    pick -= e.weight;
    if (pick <= 0) { chosen = e; break; }
  }
  const result = chosen.apply(run, localRng);
  if (result.effects) {
    try { result.effects(); } catch (_e) {}
  }
  if (result.log) {
    appendRunLog(run, "note", result.log);
  }
  ensureStats(run).jumpEncounters++;
  return {
    key: chosen.key,
    headline: chosen.headline,
    speaker: chosen.speaker,
    body: result.body,
    reward: result.reward || {},
  };
}

export function clearPendingJumpEncounter(run) {
  if (!run) return;
  run.pendingJumpEncounter = null;
  saveRun(run);
}

export function enterNode(run, nodeId) {
  const edges = reachableEdges(run);
  const edge = edges.find((e) => e.toId === nodeId);
  if (!edge) return false;
  if (run.resources.fuel < edge.fuelCost) return false;
  run.resources.fuel -= edge.fuelCost;
  run.pendingNode = nodeId;
  // Mid-jump encounter — ~32% chance of a brief flavor beat with a
  // small reward/penalty. Applied immediately to run state; UI shows
  // an overlay via run.pendingJumpEncounter before the node flow.
  const enc = rollJumpEncounter(run, edge.fromId, nodeId);
  if (enc) run.pendingJumpEncounter = enc;
  saveRun(run);
  return true;
}

function tickInterNode(run) {
  for (const cap of run.capitals) {
    cap.hpFrac = Math.min(1, cap.hpFrac + REPAIR_RATE);
  }
  const fDripMul = passengerFighterDripMul(run);
  const bDripMul = passengerBomberDripMul(run);
  run.replenishBuffer.fighter += FIGHTER_DRIP * fDripMul;
  run.replenishBuffer.bomber += BOMBER_DRIP * bDripMul;
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

  // Tick down active temporary passengers AFTER the drip — per-jump
  // bonuses (free-fighter mercenary) apply to THIS jump's clear too.
  tickPassengers(run);
  // Tick pending event followups — primed ones (jumpsUntilFire <= 0)
  // are consumed when the player next lands on an event node.
  tickFollowups(run);
  // Tick cargo contracts — decrement deadlines; expire failures.
  tickContracts(run);
}

function payoutFor(node, run) {
  const meta = loadMeta();
  const perk = meta.activePerkKey ? PERKS[meta.activePerkKey] : null;
  let creditsMul = perk && perk.creditMultiplier ? perk.creditMultiplier : 1;
  // Trait stack: every owned trait with a creditMultiplier compounds
  // multiplicatively (Quartermaster +25% becomes ×1.25; with the
  // Logistics perk's ×1.20 the player gets ×1.50 total).
  for (const k of (run.traits || [])) {
    const t = TRAITS[k];
    if (t && t.creditMultiplier) creditsMul *= t.creditMultiplier;
  }
  // Passenger stack — Captured Reaver buffs payouts +30% etc.
  creditsMul *= passengerCreditMul(run);
  // Reputation: high Coalition standing = better contract pay; low
  // Coalition standing = gray-market discount on payouts.
  creditsMul *= reputationCreditMul(run);

  // Payout multipliers: Battle 0.9; elite 1.6; boss 2.0. Combat clears
  // pay CREDITS only — no fuel refund (that's what made fuel snowball
  // instead of deplete). Fuel comes back at the act-transition refit +
  // resupply nodes + a few events.
  if (node.type === "battle") {
    run.resources.credits += Math.round(rosterValue(node.roster) * 0.9 * creditsMul);
  } else if (node.type === "elite") {
    run.resources.credits += Math.round(rosterValue(node.roster) * 1.6 * creditsMul);
  } else if (node.type === "boss") {
    run.resources.credits += Math.round(rosterValue(node.roster) * 2.0 * creditsMul);
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

// Vendor pricing modifiers. main.js passes the active resupply node
// so we can read `node.vendor.pricing.<kind>` and scale base cost.
// Falls back to 1.0× when no vendor (legacy / non-procedural paths).
function vendorMul(vendor, kind, run) {
  if (!vendor || !vendor.pricing) return 1;
  const base = vendor.pricing[kind] || 1;
  // Layer reputation discount on top of vendor's base pricing.
  return base * reputationVendorMul(run, vendor.key);
}

export function buyRepair(run, instanceId, vendor) {
  const cap = run.capitals.find((c) => c.instanceId === instanceId);
  if (!cap) return false;
  // Repair cost is base × vendor pricing × passenger multiplier
  // (wounded-engineer halves it). Vendor pricing now layers
  // reputation modifier on top.
  const cost = Math.round(repairCostFor(cap) * vendorMul(vendor, "repair", run) * passengerRepairMul(run));
  if (run.resources.credits < cost) return false;
  run.resources.credits -= cost;
  cap.hpFrac = 1;
  const stats = ensureStats(run);
  stats.creditsSpent += cost;
  stats.repairsPurchased++;
  saveRun(run);
  return true;
}

export function buyRecruit(run, klass, vendor) {
  const baseCost = RECRUIT_COST[klass];
  if (!baseCost) return false;
  const cost = Math.round(baseCost * vendorMul(vendor, klass, run));
  if (run.resources.credits < cost) return false;
  if (klass === "fighter" && run.smallCraft.fighter >= MAX_FIGHTERS) return false;
  if (klass === "bomber" && run.smallCraft.bomber >= MAX_BOMBERS) return false;
  run.resources.credits -= cost;
  run.smallCraft[klass] += 1;
  const stats = ensureStats(run);
  stats.creditsSpent += cost;
  stats.recruitsHired++;
  saveRun(run);
  return true;
}

export function buyRefuel(run, units = 1, vendor) {
  const cost = Math.round(units * FUEL_PER_REFUEL_CREDIT * vendorMul(vendor, "fuel", run));
  if (run.resources.credits < cost) return false;
  run.resources.credits -= cost;
  run.resources.fuel += units;
  const stats = ensureStats(run);
  stats.creditsSpent += cost;
  saveRun(run);
  return true;
}

export function applyBoon(run, boonKey) {
  const boon = BOON_TABLE.find((b) => b.key === boonKey);
  if (!boon) return false;
  if (run.resources.fuel < 1) return false;
  // Trauma Wing is an INSTANT-effect boon — it doesn't add to
  // run.boons (no per-battle apply needed). Picks the most-wounded
  // capital and restores it to full hull. If the fleet has no
  // capitals or all are at full, the boon is refused so the player
  // doesn't waste fuel.
  if (boonKey === "trauma-wing") {
    const wounded = run.capitals.filter((c) => c.hpFrac < 1);
    if (wounded.length === 0) return false;
    wounded.sort((a, b) => a.hpFrac - b.hpFrac);
    wounded[0].hpFrac = 1.0;
    run.resources.fuel -= 1;
    ensureStats(run).boonsAcquired++;
    saveRun(run);
    return true;
  }
  run.resources.fuel -= 1;
  run.boons.push({ ...boon });
  ensureStats(run).boonsAcquired++;
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
  // Rival closure — any still-active rival at run end gets a fate
  // stamped + a log entry. Without this they'd hang as "active" in
  // the memorial dossier, which reads as unfinished story.
  for (const r of (run.rivals || [])) {
    if (r.status !== "active") continue;
    if (won) {
      r.status = "escaped";
      appendRunLog(run, "rival", `${r.name} escaped into the void. The bounty list keeps their name.`);
    } else {
      r.status = "outlived-you";
      appendRunLog(run, "rival", `${r.name} outlived you. Their motivation will find another callsign.`);
    }
  }
  // Pending followups at run end also get a remote-fire pass — same
  // grace mechanic, just immediate. The player should never see
  // "Story threads remain unresolved" in the memoir.
  if (Array.isArray(run.pendingFollowups)) {
    for (const f of run.pendingFollowups) {
      const card = eventCardById(f.eventId);
      if (!card) continue;
      const titleStr = typeof card.title === "function" ? card.title(run) : (card.title || f.eventId);
      const opt = card.options.find((o) => !o.precondition || o.precondition(run))
               || card.options[0];
      if (opt) {
        try {
          const result = opt.apply(run);
          appendRunLog(run, "note", `Remote: ${titleStr}. ${result || ""}`.trim());
        } catch (_e) { /* ignore */ }
      }
    }
    run.pendingFollowups = [];
  }
  // Any unresolved arcs also get one last closure pass — across all
  // remaining acts so an arc that fizzled in Act 2 still narrates
  // its consequence by the end-screen.
  closeOrphanedArcStages(run, ACTS_PER_RUN);
  saveStore.update((d) => {
    d.roguelite.meta.runsCompleted += 1;
    // Award Service Hall points (Tier 38). Points are spent later
    // in the Service Hall UI on permanent upgrades.
    const earned = awardServicePoints(d.roguelite.meta, run, won);
    if (earned > 0) {
      appendRunLog(run, "promotion", `Service points awarded: ${earned}. Available in the Service Hall.`);
    }
    // Achievement check (Tier 43). Award badges + bonus service
    // points for any newly-unlocked achievements. Stamp the list
    // on game.lastAchievements via the run for the end-screen toast.
    const unlocked = checkAchievementUnlocks(d.roguelite.meta, run, won);
    if (unlocked.length > 0) {
      run._achievementsUnlocked = unlocked;
      for (const id of unlocked) {
        const ach = ACHIEVEMENTS.find((a) => a.id === id);
        if (ach) {
          appendRunLog(run, "promotion", `Achievement: ${ach.name}. ${ach.description}`);
        }
      }
    }
    // Memorial entry — both wins AND losses are recorded so the
    // title-screen wall reads as a full career roll, not just an
    // honor roll. Cap at 10 entries; oldest shifts out on overflow.
    const memorial = d.roguelite.meta.memorial || [];
    // Snapshot the career log (last 12 entries) onto the memorial
    // entry so the memorial wall + end-screen can show what actually
    // happened in this run, not just the epitaph one-liner.
    const logSnapshot = Array.isArray(run.log)
      ? run.log.slice(-12).map((l) => ({ act: l.act, kind: l.kind, text: l.text }))
      : [];
    memorial.unshift({
      callsign: run.callsign || "",
      rank: won
        ? (ACT_RANKS[ACTS_PER_RUN] || {}).rank || "Admiral"
        : (ACT_RANKS[run.act] || {}).rank || "Officer",
      result: won ? "won" : "lost",
      timestamp: Date.now(),
      epitaph: writeEpitaph(run, won),
      log: logSnapshot,
      // Final run stats snapshot for the end-run page + memorial wall.
      stats: run.stats ? JSON.parse(JSON.stringify(run.stats)) : null,
      durationMs: run.startedAtMs ? (Date.now() - run.startedAtMs) : 0,
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
// buildNpcRoster — surface named people the player has met (or burned) on the
// run map sidebar. Drives the "DOSSIER" panel under the boon list. Read-only;
// the entries are derived from run.flags so they auto-update as event cards
// resolve. Sort order is roughly intro-order via a stable severity tier.
// ---------------------------------------------------------------------------
//
// Returns: array of { name, role, tone, detail } objects.
//   tone: "ally" | "rival" | "intel" | "memorial" | "note"
//
// New entries belong here, not duplicated in the UI layer — the starmap just
// renders whatever this returns. If a future event card adds a named NPC
// flag, add the corresponding mapping below.
export function buildNpcRoster(run) {
  if (!run || !run.flags) return [];
  const out = [];
  const f = run.flags;

  if (f.wingmanRescued) {
    out.push({
      name: f.wingmanRescued,
      role: "Wing One",
      tone: "ally",
      detail: "Pulled from a downed lifepod. Owes you.",
    });
  }
  if (f.voss === "served-under") {
    out.push({
      name: "Captain Voss",
      role: "Mentor",
      tone: "ally",
      detail: "Old CO. Coalition assets answer when she calls.",
    });
  } else if (f.voss === "antagonized") {
    out.push({
      name: "Captain Voss",
      role: "Rival",
      tone: "rival",
      detail: "Burned the bridge. She remembers.",
    });
  }
  if (f.hegDefector) {
    out.push({
      name: "Cdr. Sereval",
      role: "Defector",
      tone: "intel",
      detail: "Hegemony turncoat. Feeds you weak-points.",
    });
  }
  if (f.coalitionCarrier) {
    out.push({
      name: "ITN Stalwart",
      role: "Allied carrier",
      tone: "ally",
      detail: "Coalition flag. Reinforces on call.",
    });
  }
  if (f.coalitionFleet) {
    out.push({
      name: "Coalition Battle Group",
      role: "Allied fleet",
      tone: "ally",
      detail: "Stands up beside you on the Apheliotrope run.",
    });
  }
  if (f.executedWoundedCapital) {
    out.push({
      name: "Reaver Vendetta",
      role: "Blood debt",
      tone: "rival",
      detail: "Executed their wounded. They will remember.",
    });
  }
  if (f.sparedWoundedCapital) {
    out.push({
      name: "Spared Warlord",
      role: "Reluctant favor",
      tone: "note",
      detail: "Limped home. Might return the kindness — or not.",
    });
  }
  if (f.knowsVoidsworn) {
    out.push({
      name: "Voidsworn Lore",
      role: "Forbidden text",
      tone: "intel",
      detail: "You read what the Hegemony banned. It changes targeting.",
    });
  }
  if (f.bossWeakened) {
    out.push({
      name: "Next Boss",
      role: "Damaged",
      tone: "intel",
      detail: "Intel says they are running below strength.",
    });
  }
  if (f.warCriminalStart) {
    out.push({
      name: "Tribunal File",
      role: "Pending charges",
      tone: "rival",
      detail: "JAG has an open case under your callsign.",
    });
  }
  if (f.geneva) {
    out.push({
      name: "Geneva Accord",
      role: "Signatory",
      tone: "note",
      detail: "Vow taken. Reaver mercy expected.",
    });
  }
  if (f.griefShown) {
    out.push({
      name: "Fleet Memory",
      role: "Pilots remember",
      tone: "memorial",
      detail: "You broke the line. The squadrons noticed.",
    });
  }
  if (f.veteranIntel) {
    out.push({
      name: "Veteran Sources",
      role: "Network",
      tone: "intel",
      detail: "Old hands feed you reads on the next jump.",
    });
  }

  // Procedural rivals — active rivals show as "Marked Target" with their
  // motivation under the name. Defeated rivals stay as memorials so the
  // dossier reads as a kill log over time.
  for (const r of (run.rivals || [])) {
    if (r.status === "active") {
      out.push({
        name: r.name,
        role: "Marked target",
        tone: "rival",
        detail: r.motivation.charAt(0).toUpperCase() + r.motivation.slice(1) + ".",
      });
    } else if (r.status === "defeated") {
      out.push({
        name: r.name,
        role: `Down · Act ${r.defeatedAct || "?"}`,
        tone: "memorial",
        detail: "Killed in action. Their motivation died with them.",
      });
    }
  }

  // Wing roster — named Coalition pilots accumulated via battlefield
  // promotions. Newest first; up to 6 shown so the panel stays readable.
  const roster = (run.wingRoster || []).slice(-6).reverse();
  for (const entry of roster) {
    out.push({
      name: entry.name,
      role: entry.role || "Wing pilot",
      tone: entry.tone || "ally",
      detail: entry.detail || "Joined the wing after a battle promotion.",
    });
  }

  // Temporary passengers — riding for N jumps, then disembark.
  for (const p of (run.passengers || [])) {
    out.push({
      name: p.name,
      role: `Aboard · ${p.jumpsLeft} jump${p.jumpsLeft === 1 ? "" : "s"} left`,
      tone: p.tone || "intel",
      detail: p.description || "",
    });
  }

  // Active cargo contracts — surfaced as "intel" tone with the deadline.
  for (const c of (run.contracts || [])) {
    if (c.status !== "active") continue;
    out.push({
      name: c.name,
      role: `Contract · ${c.jumpsLeft} jump${c.jumpsLeft === 1 ? "" : "s"} left`,
      tone: "intel",
      detail: c.description || "",
    });
  }

  // Faction standings — surface all four so the player can see the
  // system from run start. Tone reads as ally/rival/note depending on
  // the current value so the colour spread is informative even at
  // neutral values.
  if (run.reputation) {
    const labels = {
      coalition: "Coalition",
      hegemony: "Hegemony",
      reavers: "Reavers",
      voidsworn: "Voidsworn",
    };
    for (const f of REPUTATION_FACTIONS) {
      const v = run.reputation[f] || 0;
      out.push({
        name: labels[f],
        role: `${reputationLabel(v)} · ${v > 0 ? "+" : ""}${v}`,
        tone: v >= 30 ? "ally" : (v <= -30 ? "rival" : "note"),
        detail: `Standing with the ${labels[f]}.`,
      });
    }
  }
  return out;
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
