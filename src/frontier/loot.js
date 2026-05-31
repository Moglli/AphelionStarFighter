/**
 * @file Loot engine for the new Frontier (FRONTIER_FUTURE.md §9).
 *
 * Diablo-style modular loot: class-typed modules drop into a shared
 * stash, get equipped into per-class loadout slots, and roll rarity +
 * affixes. This module is PURE — data tables + roll functions + the
 * stat-aggregation pure function. Persistence + equip/salvage live in
 * inventory.js; in-battle application lives in modes/frontier.js.
 *
 * Stat model: affixes carry a `stat` + a fractional `value` (+8% = 0.08).
 * Only a subset of stats are wired to combat TODAY (APPLIED_STATS); the
 * rest still roll, display, and persist so the data is forward-compatible
 * with later combat integration. Legendary uniques are flavor/effect
 * descriptors not yet wired to the battle layer (documented as future).
 *
 * Numbers (ranges, weights, salvage values) are PLACEHOLDER tuning.
 */

// ---- Rarity ---------------------------------------------------------------

/** @type {{id:string,label:string,color:string,affixCount:number,salvage:number}[]} */
export const RARITIES = [
  { id: "common",    label: "Common",    color: "#9aa3ad", affixCount: 0, salvage: 10 },
  { id: "uncommon",  label: "Uncommon",  color: "#4caf50", affixCount: 1, salvage: 25 },
  { id: "rare",      label: "Rare",      color: "#3d7fe0", affixCount: 2, salvage: 60 },
  { id: "epic",      label: "Epic",      color: "#a45cf0", affixCount: 3, salvage: 150 },
  { id: "legendary", label: "Legendary", color: "#f0902c", affixCount: 4, salvage: 400 },
];
export const RARITY_BY_ID = RARITIES.reduce((a, r) => { a[r.id] = r; return a; }, {});

/** Rarity roll weights per drop source. */
const RARITY_WEIGHTS = {
  mission: { common: 50, uncommon: 32, rare: 13, epic: 4, legendary: 1 },
  boss:    { common: 15, uncommon: 35, rare: 30, epic: 15, legendary: 5 },
  shop:    { common: 60, uncommon: 30, rare: 8,  epic: 2,  legendary: 0 },
};

// ---- Slots per class (§9.2) ----------------------------------------------
// Each slot: { key, label, cat }. `cat` selects the affix pool + how the
// stat folds into the combat multipliers. Module DROPS are class-typed —
// a fighter cannon doesn't fit a frigate's ring cannon.

/** @type {Record<string, {key:string,label:string,cat:string}[]>} */
export const SLOTS_BY_CLASS = {
  fighter: [
    { key: "cannon",  label: "Cannon",  cat: "weapon" },
    { key: "missile", label: "Missile", cat: "missile" },
    { key: "shield",  label: "Shield",  cat: "shield" },
    { key: "engine",  label: "Engine",  cat: "engine" },
    { key: "hull",    label: "Hull",    cat: "hull" },
  ],
  bomber: [
    { key: "cannon",     label: "Cannon",     cat: "weapon" },
    { key: "missileBay", label: "Missile Bay", cat: "missile" },
    { key: "shield",     label: "Shield",     cat: "shield" },
    { key: "engine",     label: "Engine",     cat: "engine" },
    { key: "hull",       label: "Hull",       cat: "hull" },
    { key: "pdTurret",   label: "PD Turret",  cat: "pd" },
  ],
  frigate: [
    { key: "ringCannon", label: "Ring Cannon", cat: "weapon" },
    { key: "missileBay", label: "Missile Bay", cat: "missile" },
    { key: "shield",     label: "Shield",      cat: "shield" },
    { key: "engine",     label: "Engine",      cat: "engine" },
    { key: "hull",       label: "Hull",        cat: "hull" },
    { key: "pdArray",    label: "PD Array",    cat: "pd" },
    { key: "targeting",  label: "Targeting",   cat: "targeting" },
  ],
  cruiser: [
    { key: "forwardCannon", label: "Forward Cannon", cat: "weapon" },
    { key: "missileBay",    label: "Missile Bay",    cat: "missile" },
    { key: "shield",        label: "Shield",         cat: "shield" },
    { key: "engine",        label: "Engine",         cat: "engine" },
    { key: "hull",          label: "Hull",           cat: "hull" },
    { key: "pdArray",       label: "PD Array",       cat: "pd" },
    { key: "broadside",     label: "Broadside",      cat: "weapon" },
    { key: "targeting",     label: "Targeting",      cat: "targeting" },
  ],
  battleship: [
    { key: "broadsideArray", label: "Broadside Array", cat: "weapon" },
    { key: "missileBay",     label: "Missile Bay",     cat: "missile" },
    { key: "torpedoTubes",   label: "Torpedo Tubes",   cat: "weapon" },
    { key: "heavyLaser",     label: "Heavy Laser",     cat: "weapon" },
    { key: "shield",         label: "Shield",          cat: "shield" },
    { key: "engine",         label: "Engine",          cat: "engine" },
    { key: "hull",           label: "Hull",            cat: "hull" },
    { key: "pdArray",        label: "PD Array",        cat: "pd" },
    { key: "targeting",      label: "Targeting",       cat: "targeting" },
  ],
  carrier: [
    { key: "hangar",     label: "Hangar",      cat: "hangar" },
    { key: "missileBay", label: "Missile Bay", cat: "missile" },
    { key: "shield",     label: "Shield",      cat: "shield" },
    { key: "engine",     label: "Engine",      cat: "engine" },
    { key: "hull",       label: "Hull",        cat: "hull" },
    { key: "pdArray",    label: "PD Array",    cat: "pd" },
    { key: "targeting",  label: "Targeting",   cat: "targeting" },
  ],
};

/** Slot definition lookup by (class, slotKey). */
export function slotDef(klass, slotKey) {
  const list = SLOTS_BY_CLASS[klass] || [];
  return list.find((s) => s.key === slotKey) || null;
}

// ---- Affix pools by slot category ----------------------------------------
// stat: the field the affix modifies. applied stats fold into combat
// multipliers (APPLIED_STATS); the rest are stored/displayed only for now.

/** Combat stats actually applied in battle today. */
export const APPLIED_STATS = new Set(["hp", "shield", "speed", "turn", "damage", "fireRate", "missileDamage"]);

const AFFIX_POOLS = {
  weapon: [
    { key: "dmg",   label: "Damage",          stat: "damage",   min: 0.05, max: 0.15 },
    { key: "rof",   label: "Fire Rate",       stat: "fireRate", min: 0.04, max: 0.12 },
    { key: "rng",   label: "Range",           stat: "range",    min: 0.05, max: 0.12 },
    { key: "vel",   label: "Projectile Speed", stat: "projSpeed", min: 0.05, max: 0.15 },
  ],
  missile: [
    { key: "mdmg",  label: "Missile Damage",  stat: "missileDamage", min: 0.06, max: 0.16 },
    { key: "blast", label: "Blast Radius",    stat: "blastRadius",   min: 0.05, max: 0.12 },
    { key: "ammo",  label: "Ammo Capacity",   stat: "ammo",          min: 0.10, max: 0.25 },
  ],
  shield: [
    { key: "shp",   label: "Shield Capacity", stat: "shield",     min: 0.06, max: 0.16 },
    { key: "sregen", label: "Shield Regen",   stat: "shieldRegen", min: 0.08, max: 0.20 },
  ],
  engine: [
    { key: "spd",   label: "Top Speed",  stat: "speed", min: 0.04, max: 0.10 },
    { key: "trn",   label: "Turn Rate",  stat: "turn",  min: 0.05, max: 0.12 },
  ],
  hull: [
    { key: "hp",    label: "Hull Integrity", stat: "hp",    min: 0.06, max: 0.16 },
    { key: "armor", label: "Armor",          stat: "armor", min: 0.03, max: 0.08 },
  ],
  pd: [
    { key: "pdrof", label: "PD Fire Rate", stat: "pdRate",  min: 0.06, max: 0.15 },
    { key: "pdrng", label: "PD Range",     stat: "pdRange", min: 0.05, max: 0.12 },
  ],
  targeting: [
    { key: "aim",   label: "Aim Stability", stat: "aim",      min: 0.04, max: 0.10 },
    { key: "lock",  label: "Lock Speed",    stat: "lockSpeed", min: 0.06, max: 0.15 },
  ],
  hangar: [
    { key: "repl",  label: "Replenish Rate", stat: "replenish", min: 0.06, max: 0.15 },
    { key: "cap",   label: "Bay Capacity",   stat: "capacity",  min: 0.08, max: 0.20 },
  ],
};

// ---- Module families (name pools per category) ----------------------------

const FAMILIES = {
  weapon:    ["Pulse", "Burst", "Marksman", "Scatter", "Auto"],
  missile:   ["Hornet", "Javelin", "Swarm", "Lance"],
  shield:    ["Aegis", "Bulwark", "Halo", "Veil"],
  engine:    ["Ion", "Thruster", "Afterburn", "Drift"],
  hull:      ["Plate", "Carapace", "Bastion", "Weave"],
  pd:        ["Sentry", "Flak", "Picket"],
  targeting: ["Tracker", "Oracle", "Lockstep"],
  hangar:    ["Roost", "Brood-bay", "Flightdeck"],
};
const SLOT_NOUN = {
  weapon: "Cannon", missile: "Pod", shield: "Generator", engine: "Drive",
  hull: "Plating", pd: "Battery", targeting: "Array", hangar: "Bay",
};

/** Named Legendary uniques. Effects are FUTURE-WIRED (flavor today). */
export const LEGENDARY_UNIQUES = [
  { key: "kills-heal-shield", label: "Iron Hammer of Vorago", desc: "Kills restore 2% shield." },
  { key: "fifth-shot-burst",  label: "Triphammer",            desc: "Every 5th shot triple-bursts." },
  { key: "no-falloff",        label: "Long Reach",            desc: "Range no longer reduces damage." },
  { key: "crit-missiles",     label: "Wrath Protocol",        desc: "Critical hits auto-fire a missile." },
  { key: "regen-uninterrupted", label: "Unbroken Veil",       desc: "Shield regen doesn't pause when hit." },
];

// ---- Roll helpers ---------------------------------------------------------

let _idc = 0;
function genId() {
  _idc += 1;
  return `m${_idc}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rollRange(min, max) { return Math.round((min + Math.random() * (max - min)) * 1000) / 1000; }

function rollRarity(source = "mission") {
  const w = RARITY_WEIGHTS[source] || RARITY_WEIGHTS.mission;
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const rar of RARITIES) {
    r -= (w[rar.id] || 0);
    if (r <= 0) return rar.id;
  }
  return "common";
}

/** Roll N distinct affixes from a category pool. */
function rollAffixes(cat, count) {
  const pool = AFFIX_POOLS[cat] || AFFIX_POOLS.weapon;
  const chosen = [];
  const used = new Set();
  // Sample without replacement; if count exceeds the pool, allow repeats
  // of distinct stats is impossible — cap at pool size.
  const n = Math.min(count, pool.length);
  while (chosen.length < n) {
    const a = pool[Math.floor(Math.random() * pool.length)];
    if (used.has(a.key)) continue;
    used.add(a.key);
    chosen.push({
      key: a.key, label: a.label, stat: a.stat,
      value: rollRange(a.min, a.max),
      applied: APPLIED_STATS.has(a.stat),
    });
  }
  return chosen;
}

/**
 * Roll a single module for a specific class + slot.
 * @param {Object} o
 * @param {string} o.klass
 * @param {string} o.slot       slot key
 * @param {string} [o.rarity]   forced rarity id (else rolled by source)
 * @param {string} [o.source]   "mission" | "boss" | "shop"
 */
export function rollModule({ klass, slot, rarity, source = "mission" }) {
  const def = slotDef(klass, slot);
  if (!def) return null;
  const rar = rarity && RARITY_BY_ID[rarity] ? rarity : rollRarity(source);
  const rarObj = RARITY_BY_ID[rar];
  const fam = pick(FAMILIES[def.cat] || FAMILIES.weapon);
  const noun = SLOT_NOUN[def.cat] || "Module";
  const affixes = rollAffixes(def.cat, rarObj.affixCount);
  let unique = null;
  let name = `${fam} ${noun}`;
  if (rar === "legendary") {
    unique = pick(LEGENDARY_UNIQUES);
    name = unique.label;
  }
  return {
    id: genId(),
    klass, slot: def.key, slotLabel: def.label, cat: def.cat,
    family: fam, rarity: rar, name,
    affixes, unique,
    salvageValue: rarObj.salvage,
    favorite: false,
  };
}

/**
 * Roll a drop for a class: random slot of that class + rarity by source.
 * @param {Object} o
 * @param {string} o.klass
 * @param {string} [o.source]
 */
export function rollDrop({ klass, source = "mission" }) {
  const slots = SLOTS_BY_CLASS[klass];
  if (!slots || !slots.length) return null;
  const slot = pick(slots).key;
  return rollModule({ klass, slot, source });
}

/** Salvage credit value for a module. */
export function salvageValue(mod) {
  return (mod && mod.salvageValue) || (mod && RARITY_BY_ID[mod.rarity] && RARITY_BY_ID[mod.rarity].salvage) || 0;
}

/**
 * Aggregate equipped modules into combat multipliers. Only APPLIED_STATS
 * are returned; each is `1 + Σ(affix.value)` across equipped modules.
 * @param {Object[]} modules  equipped module instances
 * @returns {{hp:number,shield:number,speed:number,turn:number,damage:number,fireRate:number,missileDamage:number}}
 */
export function computeLoadoutStats(modules) {
  const mult = { hp: 1, shield: 1, speed: 1, turn: 1, damage: 1, fireRate: 1, missileDamage: 1 };
  for (const m of (modules || [])) {
    if (!m || !m.affixes) continue;
    for (const a of m.affixes) {
      if (mult[a.stat] !== undefined) mult[a.stat] += a.value;
    }
  }
  // Round for clean display / deterministic comparison.
  for (const k of Object.keys(mult)) mult[k] = Math.round(mult[k] * 1000) / 1000;
  return mult;
}
