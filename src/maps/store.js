/**
 * @file Map store + registry — user maps from SaveStore unioned with built-in
 * presets.
 *
 * Mirrors scenario/store.js + adds the registry behaviour: list() returns
 * built-ins followed by user maps so Battle Designer's MAP dropdown always
 * has something. get(id) checks both halves. save/delete only touch the
 * user list — built-ins are read-only.
 */

import { saveStore } from "../save.js";
import { validateMap } from "./format.js";
import { BUILTIN_MAPS } from "./presets.js";

export function listUserMaps() {
  const list = saveStore.get().maps;
  return Array.isArray(list) ? list.slice() : [];
}

/** All maps the designer + scenario picker see — builtins first, then user. */
export function listAllMaps() {
  return [...BUILTIN_MAPS, ...listUserMaps()];
}

/** Built-in OR user. Returns null when the id doesn't resolve. */
export function getMap(id) {
  return listAllMaps().find((m) => m.id === id) || null;
}

export function saveMap(map) {
  const res = validateMap(map);
  if (!res.ok) {
    throw new Error(`saveMap: invalid — ${res.errors.join("; ")}`);
  }
  if (res.value.id.startsWith("default-")) {
    throw new Error(`saveMap: "${res.value.id}" is reserved for built-in presets`);
  }
  saveStore.update((d) => {
    if (!Array.isArray(d.maps)) d.maps = [];
    const idx = d.maps.findIndex((m) => m.id === res.value.id);
    if (idx >= 0) d.maps[idx] = res.value;
    else d.maps.push(res.value);
  });
  return res.value;
}

export function deleteMap(id) {
  let removed = false;
  saveStore.update((d) => {
    if (!Array.isArray(d.maps)) return;
    const before = d.maps.length;
    d.maps = d.maps.filter((m) => m.id !== id);
    removed = d.maps.length !== before;
  });
  return removed;
}
