/**
 * @file Scenario store — list/save/delete via SaveStore.
 *
 * Scenarios live as an additive top-level `scenarios: []` array in the
 * save blob (no schema bump — rides mergeWithDefaults). All accessors
 * validate via format.js so a malformed scenario can't land in storage.
 */

import { saveStore } from "../save.js";
import { validateScenario } from "./format.js";

/** Return a defensive copy of the saved scenarios list. */
export function listScenarios() {
  const list = saveStore.get().scenarios;
  return Array.isArray(list) ? list.slice() : [];
}

/** Look up one scenario by id; returns null if not present. */
export function getScenario(id) {
  return listScenarios().find((s) => s.id === id) || null;
}

/**
 * Save (insert or replace by id). Validates the scenario; throws on
 * invalid shape. Returns the normalized value that landed in storage.
 */
export function saveScenario(scenario) {
  const res = validateScenario(scenario);
  if (!res.ok) {
    throw new Error(`saveScenario: invalid — ${res.errors.join("; ")}`);
  }
  saveStore.update((d) => {
    if (!Array.isArray(d.scenarios)) d.scenarios = [];
    const idx = d.scenarios.findIndex((s) => s.id === res.value.id);
    if (idx >= 0) d.scenarios[idx] = res.value;
    else d.scenarios.push(res.value);
  });
  return res.value;
}

/** Delete by id; returns true if a scenario was removed. */
export function deleteScenario(id) {
  let removed = false;
  saveStore.update((d) => {
    if (!Array.isArray(d.scenarios)) return;
    const before = d.scenarios.length;
    d.scenarios = d.scenarios.filter((s) => s.id !== id);
    removed = d.scenarios.length !== before;
  });
  return removed;
}
