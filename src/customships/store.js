/**
 * @file Custom-ship store — list/get/save/delete via SaveStore.
 *
 * Mirrors blueprints/store.js: `customShips: []` is additive at the top of the
 * save blob (no schema bump — rides mergeWithDefaults verbatim). Every write
 * validates+repairs via format.js so storage only ever holds spawnable docs.
 *
 * Autosave: the editor calls `saveCustomShipDebounced(draft)` on each mutation;
 * the trailing-edge debounce coalesces a burst of edits into one SaveStore write
 * (localStorage JSON.stringify is the cost we're amortising).
 */

import { saveStore } from "../save.js";
import { validateCustomShip } from "./format.js";

export function listCustomShips() {
  const list = saveStore.get().customShips;
  return Array.isArray(list) ? list.slice() : [];
}

export function getCustomShip(id) {
  return listCustomShips().find((s) => s.id === id) || null;
}

export function saveCustomShip(ship) {
  // validate-and-repair: a draft mid-edit (e.g. no hull drawn yet) still saves,
  // with the tier fallback hull filled in — the editor reloads the repaired doc.
  const res = validateCustomShip(ship);
  const value = res.value;
  if (!value) throw new Error(`saveCustomShip: unsalvageable — ${res.errors.join("; ")}`);
  saveStore.update((d) => {
    if (!Array.isArray(d.customShips)) d.customShips = [];
    const idx = d.customShips.findIndex((s) => s.id === value.id);
    if (idx >= 0) d.customShips[idx] = value;
    else d.customShips.push(value);
  });
  return value;
}

export function deleteCustomShip(id) {
  let removed = false;
  saveStore.update((d) => {
    if (!Array.isArray(d.customShips)) return;
    const before = d.customShips.length;
    d.customShips = d.customShips.filter((s) => s.id !== id);
    removed = d.customShips.length !== before;
  });
  return removed;
}

// Trailing-edge debounce for editor autosave. One timer module-wide — the
// editor only drives one draft at a time.
let _saveTimer = null;
let _pendingErr = null;
export function saveCustomShipDebounced(ship, delayMs = 400) {
  if (typeof setTimeout !== "function") { saveCustomShip(ship); return; }
  if (_saveTimer) clearTimeout(_saveTimer);
  const snapshot = JSON.parse(JSON.stringify(ship));
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try { saveCustomShip(snapshot); _pendingErr = null; }
    catch (e) { _pendingErr = e; if (typeof console !== "undefined") console.warn("[customShips] autosave failed:", e.message); }
  }, delayMs);
}

export function flushCustomShipSave() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
}
