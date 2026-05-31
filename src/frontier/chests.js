/**
 * @file Premium caches / loot boxes (FRONTIER_FUTURE.md §9.8).
 *
 * Three SKU tiers, single-item rolls, a pity timer (guaranteed
 * Rare-or-better every N chests), disclosed odds, and class-targeting
 * (rolls respect tier-gating — never a hull you can't pilot yet).
 *
 * MONETIZATION NOTE: the doc specs these as real-money IAP. There's no
 * payment backend in this build, so caches are bought with WAR CREDITS as
 * a placeholder currency — the regulated MECHANIC (weighted roll, pity,
 * odds disclosure, class-targeting) is the deliverable; swapping the
 * spend rail to IAP later is a one-function change (`payFor`). The free
 * progression path (mission drops + Quartermaster) is untouched, so
 * caches are never required — a §9.8 / §3.6a guardrail.
 */

import { saveStore } from "../save.js";
import { spendCredits, pilotableNow } from "./state.js";
import { addModule } from "./inventory.js";
import { rollModule, SLOTS_BY_CLASS, RARITIES, RARITY_BY_ID } from "./loot.js";

/** Rarity rank for the pity-floor comparison (common=0 … legendary=4). */
const RARITY_RANK = RARITIES.reduce((a, r, i) => { a[r.id] = i; return a; }, {});
const RARE_RANK = RARITY_RANK.rare;

/** Pity: a Rare-or-better is guaranteed at least once every N caches. */
export const PITY_INTERVAL = 10;

/**
 * Cache SKUs. `weights` are the disclosed drop odds (§9.8 — Mythic
 * deferred, so Elite's 2% Mythic is folded into Legendary). `price` is
 * the placeholder war-credit cost (premium-steep so caches are a
 * whale/credit-dump path, not the progression floor).
 * @type {{id:string,name:string,price:number,weights:Record<string,number>}[]}
 */
export const CHEST_TIERS = [
  { id: "basic",   name: "Basic Cache",   price: 500,
    weights: { common: 50, uncommon: 35, rare: 12, epic: 2.5, legendary: 0.5 } },
  { id: "premium", name: "Premium Cache", price: 1500,
    weights: { common: 0, uncommon: 50, rare: 30, epic: 15, legendary: 5 } },
  { id: "elite",   name: "Elite Cache",   price: 4000,
    weights: { common: 0, uncommon: 0, rare: 40, epic: 40, legendary: 20 } },
];
export const CHEST_BY_ID = CHEST_TIERS.reduce((a, c) => { a[c.id] = c; return a; }, {});

function rollRarity(weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const rar of RARITIES) {
    const w = weights[rar.id] || 0;
    r -= w;
    if (r <= 0 && w > 0) return rar.id;
  }
  // Fallback: highest-weighted non-zero tier.
  return Object.keys(weights).filter((k) => weights[k] > 0).pop() || "common";
}

/** Lowest Rare-or-better rarity offered by a cache (for the pity floor). */
function rareFloorFor(weights) {
  for (const rar of RARITIES) {
    if (RARITY_RANK[rar.id] >= RARE_RANK && (weights[rar.id] || 0) > 0) return rar.id;
  }
  return "rare";
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/**
 * Open a cache. Spends the price, rolls a single class-targeted module
 * (tier-gated), applies the pity floor, adds it to the stash.
 * @param {string} tierId
 * @returns {{ok:boolean, reason?:string, module?:object, pityHit?:boolean}}
 */
export function openChest(tierId) {
  const tier = CHEST_BY_ID[tierId];
  if (!tier) return { ok: false, reason: "no-tier" };
  if (!spendCredits(tier.price)) return { ok: false, reason: "poor" };

  // Pity: if this open would hit the interval without a Rare+ since the
  // last one, floor the roll to Rare-or-better.
  const f = saveStore.get().frontier;
  const pityCount = (f && f.chestPity) || 0;
  const pityDue = pityCount + 1 >= PITY_INTERVAL;

  let rarity = rollRarity(tier.weights);
  let pityHit = false;
  if (pityDue && RARITY_RANK[rarity] < RARE_RANK) {
    rarity = rareFloorFor(tier.weights);
    pityHit = true;
  }

  // Class-targeting: only roll for a class the player can currently pilot.
  const classes = pilotableNow();
  const klass = pick(classes);
  const slots = SLOTS_BY_CLASS[klass] || [];
  const slot = slots.length ? pick(slots).key : "hull";
  const mod = rollModule({ klass, slot, rarity, source: "chest" });
  if (!mod) return { ok: false, reason: "roll-failed" };

  // Update pity counter: reset on any Rare+, else increment.
  saveStore.update((data) => {
    if (!data.frontier) return;
    const got = RARITY_RANK[mod.rarity] >= RARE_RANK;
    data.frontier.chestPity = got ? 0 : ((data.frontier.chestPity || 0) + 1);
  });

  addModule(mod);
  return { ok: true, module: mod, pityHit };
}

/** UI view: SKUs with disclosed odds + affordability + pity progress. */
export function getChestsView() {
  const f = saveStore.get().frontier || {};
  const credits = f.warCredits || 0;
  const pityCount = f.chestPity || 0;
  const tiers = CHEST_TIERS.map((t) => {
    const total = Object.values(t.weights).reduce((a, b) => a + b, 0);
    const odds = RARITIES
      .filter((r) => (t.weights[r.id] || 0) > 0)
      .map((r) => ({
        rarity: r.id, label: r.label, color: r.color,
        pct: Math.round((t.weights[r.id] / total) * 1000) / 10,
      }));
    return { id: t.id, name: t.name, price: t.price, affordable: credits >= t.price, odds };
  });
  return {
    credits,
    tiers,
    pity: { count: pityCount, interval: PITY_INTERVAL, untilGuaranteed: Math.max(0, PITY_INTERVAL - pityCount) },
  };
}
