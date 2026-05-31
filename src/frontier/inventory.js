/**
 * @file Frontier inventory — stash + per-class loadouts over the save
 * (FRONTIER_FUTURE.md §9.6). The single funnel for mutating
 * frontier.stash / frontier.loadouts; all writes go through
 * saveStore.update.
 *
 * Model: the STASH is the full module inventory (one flat array of
 * module instances from loot.js). A LOADOUT maps slotKey → moduleId for
 * a class; equipped modules stay in the stash and are referenced by id.
 * Auto-salvage at the cap skips favorited AND equipped modules. Dropped
 * modules auto-equip into an empty matching slot (so loot matters before
 * the equip UI lands — a deliberate stopgap, see awardDrops).
 */

import { saveStore } from "../save.js";
import { bankCredits } from "./state.js";
import {
  rollDrop, salvageValue, computeLoadoutStats, SLOTS_BY_CLASS,
} from "./loot.js";

/** Shared finite stash cap (§9.6: ~50–100). */
export const STASH_CAP = 80;

/** Drops awarded per mission, by battle kind. Placeholder. */
const DROPS_BY_KIND = {
  sweep: 1, defense: 1, "capital-assault": 2, fleet: 2, surrender: 2, boss: 3,
};

function fblock(data) {
  // mergeWithDefaults guarantees the frontier block + arrays exist on
  // load; this is a defensive seed for a hand-built save.
  if (!data.frontier) data.frontier = {};
  const f = data.frontier;
  if (!Array.isArray(f.stash)) f.stash = [];
  if (!f.loadouts) f.loadouts = {};
  for (const k of Object.keys(SLOTS_BY_CLASS)) if (!f.loadouts[k]) f.loadouts[k] = {};
  return f;
}

/** Live stash array (snapshot ref — do not mutate; use the ops here). */
export function getStash() {
  return (saveStore.get().frontier && saveStore.get().frontier.stash) || [];
}

/** Loadout map (slotKey → moduleId) for a class. */
export function getLoadout(klass) {
  const f = saveStore.get().frontier;
  return (f && f.loadouts && f.loadouts[klass]) || {};
}

/** Find a module instance in the stash by id. */
export function moduleById(id) {
  return getStash().find((m) => m.id === id) || null;
}

/** True if a module id is equipped in ANY class loadout. */
export function isEquipped(id) {
  const f = saveStore.get().frontier;
  if (!f || !f.loadouts) return false;
  for (const klass of Object.keys(f.loadouts)) {
    const lo = f.loadouts[klass];
    for (const slot of Object.keys(lo)) if (lo[slot] === id) return true;
  }
  return false;
}

/** Resolved equipped module instances for a class (skips empty slots). */
export function loadoutModulesFor(klass) {
  const lo = getLoadout(klass);
  const stash = getStash();
  const byId = new Map(stash.map((m) => [m.id, m]));
  const out = [];
  for (const slot of Object.keys(lo)) {
    const m = byId.get(lo[slot]);
    if (m) out.push(m);
  }
  return out;
}

/** Aggregate combat multipliers for a class's equipped loadout. */
export function loadoutStatsFor(klass) {
  return computeLoadoutStats(loadoutModulesFor(klass));
}

/**
 * Add a module to the stash. Enforces the cap by auto-salvaging the
 * OLDEST non-favorite, non-equipped module(s) for credits.
 * @returns {number} credits gained from any auto-salvage
 */
export function addModule(mod) {
  if (!mod) return 0;
  let salvaged = 0;
  saveStore.update((data) => {
    const f = fblock(data);
    f.stash.push(mod);
    while (f.stash.length > STASH_CAP) {
      const idx = f.stash.findIndex((m) => !m.favorite && !_equippedIn(f, m.id));
      if (idx === -1) break; // everything is protected — let it overflow rather than nuke gear
      salvaged += salvageValue(f.stash[idx]);
      f.stash.splice(idx, 1);
    }
  });
  if (salvaged > 0) bankCredits(salvaged);
  return salvaged;
}

function _equippedIn(f, id) {
  for (const klass of Object.keys(f.loadouts || {})) {
    const lo = f.loadouts[klass];
    for (const slot of Object.keys(lo)) if (lo[slot] === id) return true;
  }
  return false;
}

/** Equip a stash module into its class's slot. Validates class+slot match. */
export function equip(klass, slot, moduleId) {
  let ok = false;
  saveStore.update((data) => {
    const f = fblock(data);
    const m = f.stash.find((x) => x.id === moduleId);
    if (!m || m.klass !== klass || m.slot !== slot) return;
    if (!f.loadouts[klass]) f.loadouts[klass] = {};
    f.loadouts[klass][slot] = moduleId;
    ok = true;
  });
  return ok;
}

/** Clear a loadout slot. */
export function unequip(klass, slot) {
  saveStore.update((data) => {
    const f = fblock(data);
    if (f.loadouts[klass]) delete f.loadouts[klass][slot];
  });
}

/** Salvage a module: remove from stash + any loadout, bank its value. */
export function salvage(moduleId) {
  let value = 0;
  saveStore.update((data) => {
    const f = fblock(data);
    const idx = f.stash.findIndex((m) => m.id === moduleId);
    if (idx === -1) return;
    value = salvageValue(f.stash[idx]);
    f.stash.splice(idx, 1);
    for (const klass of Object.keys(f.loadouts)) {
      const lo = f.loadouts[klass];
      for (const slot of Object.keys(lo)) if (lo[slot] === moduleId) delete lo[slot];
    }
  });
  if (value > 0) bankCredits(value);
  return value;
}

/** Toggle the favorite/lock flag (protects from auto-salvage). */
export function toggleFavorite(moduleId) {
  let state = false;
  saveStore.update((data) => {
    const f = fblock(data);
    const m = f.stash.find((x) => x.id === moduleId);
    if (m) { m.favorite = !m.favorite; state = m.favorite; }
  });
  return state;
}

/**
 * Award mission drops for the flown class. Rolls N modules (by battle
 * kind), adds them to the stash, and AUTO-EQUIPS each into an empty
 * matching slot — a deliberate stopgap so loot is impactful before the
 * manual equip UI ships. Returns the dropped modules for the summary.
 *
 * @param {string} klass        the class the player flew
 * @param {string} missionKind  battle kind (drop count)
 * @param {string} [source]     "mission" | "boss" (rarity weights)
 */
export function awardDrops(klass, missionKind, source = "mission") {
  const n = DROPS_BY_KIND[missionKind] || 1;
  const dropped = [];
  for (let i = 0; i < n; i++) {
    const mod = rollDrop({ klass, source });
    if (!mod) continue;
    addModule(mod);
    // Auto-equip into an empty slot of the matching class.
    const lo = getLoadout(klass);
    if (!lo[mod.slot]) equip(klass, mod.slot, mod.id);
    dropped.push(mod);
  }
  return dropped;
}

export { DROPS_BY_KIND };
