/**
 * @file Blueprint migrations — versioned shape upgrades.
 *
 * Stub for now; v1 is the first shipped version. Adding v2 mirrors the
 * scenario migration pattern:
 *
 *   const MIGRATIONS = { 1: (b) => ({ ...b, version: 2, /* shape change */ }) };
 */

import { LATEST_VERSION } from "./format.js";

const MIGRATIONS = {};

export function migrateBlueprint(blueprint) {
  if (!blueprint || typeof blueprint !== "object") {
    throw new Error("migrateBlueprint: input must be an object");
  }
  let cur = blueprint;
  while (typeof cur.version === "number" && cur.version < LATEST_VERSION) {
    const step = MIGRATIONS[cur.version];
    if (!step) {
      throw new Error(`no migration from v${cur.version} to v${cur.version + 1}`);
    }
    cur = step(cur);
  }
  return cur;
}
