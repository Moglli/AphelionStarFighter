/**
 * @file Blueprints store — list/save/delete via SaveStore.
 *
 * Mirrors scenario/store.js: `blueprints: []` is additive at the top of
 * the save blob (no schema bump). All accessors validate via format.js so
 * a malformed blueprint can't land in storage.
 */

import { saveStore } from "../save.js";
import { validateBlueprint } from "./format.js";

export function listBlueprints() {
  const list = saveStore.get().blueprints;
  return Array.isArray(list) ? list.slice() : [];
}

export function getBlueprint(id) {
  return listBlueprints().find((b) => b.id === id) || null;
}

export function saveBlueprint(blueprint) {
  const res = validateBlueprint(blueprint);
  if (!res.ok) {
    throw new Error(`saveBlueprint: invalid — ${res.errors.join("; ")}`);
  }
  saveStore.update((d) => {
    if (!Array.isArray(d.blueprints)) d.blueprints = [];
    const idx = d.blueprints.findIndex((b) => b.id === res.value.id);
    if (idx >= 0) d.blueprints[idx] = res.value;
    else d.blueprints.push(res.value);
  });
  return res.value;
}

export function deleteBlueprint(id) {
  let removed = false;
  saveStore.update((d) => {
    if (!Array.isArray(d.blueprints)) return;
    const before = d.blueprints.length;
    d.blueprints = d.blueprints.filter((b) => b.id !== id);
    removed = d.blueprints.length !== before;
  });
  return removed;
}
