/**
 * @file Custom-module library store — list/get/save/delete via SaveStore.
 *
 * Mirrors blueprints/store.js: `customModules: []` is additive at the top of
 * the save blob (no schema bump — rides mergeWithDefaults verbatim). All writes
 * validate via format.js so a malformed record can't land in storage.
 */

import { saveStore } from "../save.js";
import { validateCustomModule } from "./format.js";

export function listCustomModules() {
  const list = saveStore.get().customModules;
  return Array.isArray(list) ? list.slice() : [];
}

export function getCustomModule(id) {
  return listCustomModules().find((m) => m.id === id) || null;
}

export function saveCustomModule(record) {
  const res = validateCustomModule(record);
  if (!res.ok) {
    throw new Error(`saveCustomModule: invalid — ${res.errors.join("; ")}`);
  }
  saveStore.update((d) => {
    if (!Array.isArray(d.customModules)) d.customModules = [];
    const idx = d.customModules.findIndex((m) => m.id === res.value.id);
    if (idx >= 0) d.customModules[idx] = res.value;
    else d.customModules.push(res.value);
  });
  return res.value;
}

export function deleteCustomModule(id) {
  let removed = false;
  saveStore.update((d) => {
    if (!Array.isArray(d.customModules)) return;
    const before = d.customModules.length;
    d.customModules = d.customModules.filter((m) => m.id !== id);
    removed = d.customModules.length !== before;
  });
  return removed;
}
