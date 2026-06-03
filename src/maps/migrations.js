/**
 * @file Map migrations — versioned shape upgrades.
 *
 * Stub for v1. Mirrors the scenario/blueprint migration pattern: a
 * MIGRATIONS map keyed on the source version returns the next-version
 * shape (see src/scenario/migrations.js for the prototype).
 */

import { LATEST_VERSION } from "./format.js";

const MIGRATIONS = {};

export function migrateMap(map) {
  if (!map || typeof map !== "object") {
    throw new Error("migrateMap: input must be an object");
  }
  let cur = map;
  while (typeof cur.version === "number" && cur.version < LATEST_VERSION) {
    const step = MIGRATIONS[cur.version];
    if (!step) {
      throw new Error(`no migration from v${cur.version} to v${cur.version + 1}`);
    }
    cur = step(cur);
  }
  return cur;
}
