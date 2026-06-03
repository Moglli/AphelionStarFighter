/**
 * @file Scenario migrations — versioned shape upgrades.
 *
 * Stub for now; v1 is the first shipped version so there is nothing to
 * migrate. Adding a v2 looks like:
 *
 *   const MIGRATIONS = {
 *     1: (s) => { ...turn v1 into v2, set s.version = 2... return s; },
 *   };
 *
 * Always migrate forward in single steps so each transform has a single,
 * legible shape boundary. Mirrors the save.js MIGRATIONS pattern.
 */

import { LATEST_VERSION } from "./format.js";

const MIGRATIONS = {
  // 1: (s) => ({ ...s, version: 2, /* shape change */ }),
};

export function migrateScenario(scenario) {
  if (!scenario || typeof scenario !== "object") {
    throw new Error("migrateScenario: input must be an object");
  }
  let cur = scenario;
  while (typeof cur.version === "number" && cur.version < LATEST_VERSION) {
    const step = MIGRATIONS[cur.version];
    if (!step) {
      throw new Error(`no migration from v${cur.version} to v${cur.version + 1}`);
    }
    cur = step(cur);
  }
  return cur;
}
