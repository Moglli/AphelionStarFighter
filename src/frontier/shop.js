/**
 * @file Republic Quartermaster shop (FRONTIER_FUTURE.md §9.7).
 *
 * Spends war credits on modules. Two sections:
 *   - STATIC  — Common/Uncommon, always available, infinite restock.
 *               The reliable progression floor + a guaranteed credit sink.
 *   - ROTATING — Rare/Epic, limited one-off buys, refreshed on chapter
 *               completion (§9.7 leans per-chapter, not a real-time clock,
 *               to avoid FOMO pressure). Legendaries are NOT sold (drop /
 *               chest only).
 *
 * Stock is PERSISTED (frontier.shop) and regenerated only when the
 * refresh key changes (total chapters completed + unlocked classes), so
 * prices/items are stable across hub opens within a window. Tier-gated:
 * only stocks classes the player can currently pilot.
 *
 * Prices are PLACEHOLDER tuning.
 */

import { saveStore } from "../save.js";
import { spendCredits, pilotableNow } from "./state.js";
import { addModule } from "./inventory.js";
import { rollModule, SLOTS_BY_CLASS, RARITY_BY_ID } from "./loot.js";

/** Buy price by rarity. Legendary intentionally absent (not sold). */
export const SHOP_PRICES = { common: 80, uncommon: 200, rare: 600, epic: 1500 };

const ROTATING_COUNT = 4;
const STATIC_PER_CLASS = 4; // 2 common + 2 uncommon across random slots

let _buyc = 0;

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/** Refresh key: stock rerolls when chapters-completed OR unlocked classes change. */
function refreshKeyFor(f, classes) {
  let chapters = 0;
  for (const w of Object.values(f.wars || {})) chapters += (w.chaptersCompleted || 0);
  return `${chapters}|${classes.slice().sort().join(",")}`;
}

function priced(mod) {
  return { ...mod, price: SHOP_PRICES[mod.rarity] || 0 };
}

/** Generate a fresh stock set for the given unlocked classes. */
function generateStock(classes) {
  const staticStock = [];
  for (const klass of classes) {
    const slots = SLOTS_BY_CLASS[klass] || [];
    if (!slots.length) continue;
    for (let i = 0; i < STATIC_PER_CLASS; i++) {
      const rarity = i < 2 ? "common" : "uncommon";
      const slot = pick(slots).key;
      const m = rollModule({ klass, slot, rarity, source: "shop" });
      if (m) staticStock.push(priced(m));
    }
  }
  const rotating = [];
  for (let i = 0; i < ROTATING_COUNT; i++) {
    const klass = pick(classes);
    const slots = SLOTS_BY_CLASS[klass] || [];
    if (!slots.length) continue;
    // Rotating leans Rare with an Epic minority.
    const rarity = Math.random() < 0.7 ? "rare" : "epic";
    const m = rollModule({ klass, slot: pick(slots).key, rarity, source: "shop" });
    if (m) rotating.push(priced(m));
  }
  return { staticStock, rotating };
}

/**
 * Ensure shop stock exists + matches the current refresh window. Mutates
 * + persists when it (re)generates. Returns the live shop block.
 */
export function ensureShop() {
  const f = saveStore.get().frontier;
  if (!f) return null;
  const classes = pilotableNow();
  const key = refreshKeyFor(f, classes);
  // Fast path: no write when stock is current (this runs every frame
  // while the shop sheet is open — avoid scheduling a write per frame).
  if (!f.shop || f.shop.key !== key) {
    const { staticStock, rotating } = generateStock(classes);
    saveStore.update((data) => { data.frontier.shop = { key, staticStock, rotating }; });
  }
  return saveStore.get().frontier.shop;
}

/** UI view of the shop: affordability flags + current credits. */
export function getShopView() {
  const shop = ensureShop();
  const credits = (saveStore.get().frontier || {}).warCredits || 0;
  const view = (m, section) => ({
    id: m.id, name: m.name, klass: m.klass, slot: m.slot, slotLabel: m.slotLabel,
    rarity: m.rarity, color: (RARITY_BY_ID[m.rarity] || {}).color || "#9aa3ad",
    price: m.price, affordable: credits >= m.price, section,
    affixes: (m.affixes || []).map((a) => ({ label: a.label, value: a.value, applied: a.applied })),
    unique: m.unique ? m.unique.desc : null,
  });
  return {
    credits,
    staticStock: (shop.staticStock || []).map((m) => view(m, "static")),
    rotating: (shop.rotating || []).map((m) => view(m, "rotating")),
  };
}

/**
 * Buy a shop item by id. Static items restock (a fresh copy goes to the
 * stash, the listing stays); rotating items are removed on purchase.
 * @returns {{ok:boolean, reason?:string, module?:object}}
 */
export function buyItem(itemId) {
  const shop = ensureShop();
  if (!shop) return { ok: false, reason: "no-shop" };
  const inStatic = (shop.staticStock || []).find((m) => m.id === itemId);
  const inRot = (shop.rotating || []).find((m) => m.id === itemId);
  const item = inStatic || inRot;
  if (!item) return { ok: false, reason: "gone" };

  // Spend first (atomic affordability check). No deduction on failure.
  if (!spendCredits(item.price)) return { ok: false, reason: "poor" };

  // Mint a fresh stash instance (new id, no price field).
  _buyc += 1;
  const { price, ...rest } = item;
  const mod = { ...rest, id: `buy_${item.id}_${_buyc}`, favorite: false };
  addModule(mod);

  // Rotating stock is consumed; static restocks (listing persists).
  if (inRot) {
    saveStore.update((data) => {
      const f = data.frontier;
      if (f && f.shop) f.shop.rotating = f.shop.rotating.filter((m) => m.id !== itemId);
    });
  }
  return { ok: true, module: mod };
}
