/**
 * @file Cosmetics catalog — placeholder entries for Phase 2 equip flow.
 *
 * Each cosmetic has a slot, an ID, a label, and a small payload of
 * render data the renderer can read (e.g. `tint` hex for hull skins).
 * The catalog ships with a handful of "starter" cosmetics owned by
 * default, so the hangar UI has something to equip before the Phase 3
 * shop populates the inventory.
 *
 * Phase 3 will extend this catalog with paid SKUs and wire each entry
 * to a RevenueCat entitlement.
 */

/** @typedef {import("./types.js").CosmeticSlot} CosmeticSlot */

export const COSMETICS = {
  // Hull skins — override SIDES[side].primary tint for the player ship.
  "hull_default":      { slot: "hullSkin",     label: "Default Allied", tint: null },
  "hull_crimson":      { slot: "hullSkin",     label: "Crimson Vow",    tint: "#f55" },
  "hull_emerald":      { slot: "hullSkin",     label: "Emerald Spire",  tint: "#6f9" },
  "hull_violet":       { slot: "hullSkin",     label: "Violet Aphelion",tint: "#b6f" },

  // Engine trails — placeholder for Phase 3 (renderer hook deferred).
  "trail_default":     { slot: "engineTrail",  label: "Default",        color: null },
  "trail_aurora":      { slot: "engineTrail",  label: "Aurora",         color: "#9fe" },

  // Weapon FX — placeholder.
  "weaponfx_default":  { slot: "weaponFX",     label: "Default",        color: null },
  "weaponfx_amber":    { slot: "weaponFX",     label: "Amber Lance",    color: "#fb6" },

  // Audio packs — placeholder; Phase 3 swaps in sample-based audio.
  "audio_default":     { slot: "audioPack",    label: "Default",        pack: null },
};

/** Cosmetics owned by all new accounts so the hangar isn't empty. */
export const DEFAULT_INVENTORY = [
  "hull_default", "hull_crimson", "hull_emerald", "hull_violet",
  "trail_default", "trail_aurora",
  "weaponfx_default", "weaponfx_amber",
  "audio_default",
];

/** All slot keys in display order. */
export const SLOT_ORDER = ["hullSkin", "engineTrail", "weaponFX", "audioPack"];

export const SLOT_LABELS = {
  hullSkin:    "Hull Skin",
  engineTrail: "Engine Trail",
  weaponFX:    "Weapon FX",
  audioPack:   "Audio Pack",
};

/**
 * Resolve an equipped cosmetic id to its catalog entry. Falls back to a
 * minimal stub if the id is missing (e.g. from a future content patch
 * the client hasn't seen yet).
 */
export function resolveCosmetic(id) {
  if (!id) return null;
  return COSMETICS[id] || { slot: "unknown", label: id, tint: null };
}

/** Group an inventory list by slot for the hangar UI. */
export function groupBySlot(inventory) {
  const groups = { hullSkin: [], engineTrail: [], weaponFX: [], audioPack: [] };
  for (const id of inventory) {
    const c = COSMETICS[id];
    if (!c) continue;
    if (!groups[c.slot]) groups[c.slot] = [];
    groups[c.slot].push({ id, ...c });
  }
  return groups;
}
