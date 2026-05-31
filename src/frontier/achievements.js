/**
 * @file Achievements + military decorations (FRONTIER_FUTURE.md §11).
 *
 * A parallel milestone system — PURE FLAVOR reward (no XP / loot / IAP
 * cross-contamination, §11.2). Each unlock awards a named decoration
 * displayed on the Pilot's-Lounge citations wall. Categories: combat /
 * career / build mastery (no hidden/lore at v1).
 *
 * Every achievement is DERIVABLE from existing frontier state (the kills
 * ledger, career tier, per-War chapter progress, equipped loadouts) — no
 * new counters to maintain. `checkAchievements()` recomputes the earned
 * set and unlocks any newly-satisfied ones into the save
 * (`frontier.unlockedAchievements` + `frontier.decorations`).
 */

import { saveStore } from "../save.js";
import { tierForXp } from "./career.js";
import { RARITY_BY_ID, SLOTS_BY_CLASS } from "./loot.js";

/**
 * @typedef {Object} Achievement
 * @property {string} id
 * @property {string} name        Decoration name (citation)
 * @property {string} desc
 * @property {"combat"|"career"|"build"} category
 * @property {(c:any)=>boolean} test       Earned predicate over the metrics ctx
 * @property {(c:any)=>string} [progress]  Optional "x/y" progress label while locked
 */

/** @type {Achievement[]} */
export const ACHIEVEMENTS = [
  // --- Combat ---
  { id: "first-blood", name: "Citation for Valor", desc: "Destroy your first enemy.", category: "combat",
    test: (c) => c.totalKills >= 1 },
  { id: "centurion", name: "Centurion's Mark", desc: "Destroy 100 enemies.", category: "combat",
    test: (c) => c.totalKills >= 100, progress: (c) => `${Math.min(c.totalKills, 100)}/100` },
  { id: "thousand-cuts", name: "Scourge of the Frontier", desc: "Destroy 1,000 enemies.", category: "combat",
    test: (c) => c.totalKills >= 1000, progress: (c) => `${Math.min(c.totalKills, 1000)}/1000` },
  { id: "hammer-of-brood", name: "Hammer of the Brood", desc: "Exterminate 500 Brood.", category: "combat",
    test: (c) => c.broodKills >= 500, progress: (c) => `${Math.min(c.broodKills, 500)}/500` },
  { id: "dragonslayer", name: "Dragonslayer", desc: "Slay 200 Saurian war-craft.", category: "combat",
    test: (c) => c.saurianKills >= 200, progress: (c) => `${Math.min(c.saurianKills, 200)}/200` },

  // --- Career ---
  { id: "commissioned", name: "Commission of the Republic", desc: "Reach the rank of Wing Lead.", category: "career",
    test: (c) => c.tier >= 1 },
  { id: "strike-leader", name: "Strike Leader's Wings", desc: "Reach the rank of Strike Lead.", category: "career",
    test: (c) => c.tier >= 2 },
  { id: "captaincy", name: "Captain's Commission", desc: "Reach the rank of Captain.", category: "career",
    test: (c) => c.tier >= 5 },
  { id: "flag-officer", name: "Admiralty Star", desc: "Reach the rank of Commodore.", category: "career",
    test: (c) => c.tier >= 6 },
  { id: "baptism", name: "Baptism of Fire", desc: "Complete your first story chapter.", category: "career",
    test: (c) => c.chaptersTotal >= 1 },
  { id: "exterminator", name: "Order of Extermination", desc: "Win Op Locust Wind.", category: "career",
    test: (c) => c.warsWon.includes("locust-wind") },
  { id: "conqueror", name: "Conqueror of the Dominion", desc: "Win Op Dragon's Jaw.", category: "career",
    test: (c) => c.warsWon.includes("dragons-jaw") },

  // --- Build mastery ---
  { id: "kitted-out", name: "Quartermaster's Commendation", desc: "Fully equip every slot on a ship class.", category: "build",
    test: (c) => c.anyClassFull },
  { id: "legend-bearer", name: "Legend in the Making", desc: "Equip a Legendary module.", category: "build",
    test: (c) => c.legendaryEquipped },
];

export const ACHIEVEMENTS_BY_ID = ACHIEVEMENTS.reduce((a, x) => { a[x.id] = x; return a; }, {});

/** Compute the metrics context from a frontier save block. */
function metricsFor(f) {
  const wars = f.wars || {};
  let totalKills = 0;
  const warKills = {};
  for (const [warId, w] of Object.entries(wars)) {
    let n = 0;
    for (const v of Object.values(w.kills || {})) n += v;
    warKills[warId] = n;
    totalKills += n;
  }
  let chaptersTotal = 0;
  const warsWon = [];
  for (const [warId, w] of Object.entries(wars)) {
    chaptersTotal += (w.chaptersCompleted || 0);
    if (w.completed) warsWon.push(warId);
  }
  // Build-mastery checks over equipped loadouts.
  const loadouts = f.loadouts || {};
  const stash = f.stash || [];
  const byId = new Map(stash.map((m) => [m.id, m]));
  let anyClassFull = false;
  let legendaryEquipped = false;
  for (const [klass, lo] of Object.entries(loadouts)) {
    const slots = SLOTS_BY_CLASS[klass];
    if (!slots) continue;
    let filled = 0;
    for (const s of slots) {
      const id = lo[s.key];
      if (!id) continue;
      filled += 1;
      const m = byId.get(id);
      if (m && m.rarity === "legendary") legendaryEquipped = true;
    }
    if (slots.length > 0 && filled === slots.length) anyClassFull = true;
  }
  return {
    totalKills,
    broodKills: warKills["locust-wind"] || 0,
    saurianKills: warKills["dragons-jaw"] || 0,
    tier: tierForXp(f.careerXp || 0).tier,
    chaptersTotal,
    warsWon,
    anyClassFull,
    legendaryEquipped,
  };
}

/** Earned achievement ids for a frontier block (pure). */
export function earnedIds(f) {
  const c = metricsFor(f);
  return ACHIEVEMENTS.filter((a) => { try { return a.test(c); } catch (_e) { return false; } }).map((a) => a.id);
}

/**
 * Recompute earned achievements and unlock any newly-satisfied ones.
 * Adds the id to `frontier.unlockedAchievements` and a decoration
 * `{id,name}` to `frontier.decorations`. Idempotent.
 * @returns {Achievement[]} newly unlocked this call (for the result screen)
 */
export function checkAchievements() {
  const newly = [];
  saveStore.update((data) => {
    const f = data.frontier;
    if (!f) return;
    if (!Array.isArray(f.unlockedAchievements)) f.unlockedAchievements = [];
    if (!Array.isArray(f.decorations)) f.decorations = [];
    const have = new Set(f.unlockedAchievements);
    for (const id of earnedIds(f)) {
      if (have.has(id)) continue;
      have.add(id);
      f.unlockedAchievements.push(id);
      const ach = ACHIEVEMENTS_BY_ID[id];
      f.decorations.push({ id, name: ach ? ach.name : id });
      if (ach) newly.push(ach);
    }
  });
  return newly;
}

/**
 * UI view: every achievement with earned state + a progress label while
 * locked. Grouped order is the table order; callers can group by
 * `category`.
 */
export function achievementsView() {
  const f = saveStore.get().frontier || {};
  const c = metricsFor(f);
  const have = new Set(f.unlockedAchievements || []);
  return ACHIEVEMENTS.map((a) => ({
    id: a.id, name: a.name, desc: a.desc, category: a.category,
    earned: have.has(a.id),
    progress: (!have.has(a.id) && a.progress) ? a.progress(c) : null,
  }));
}
