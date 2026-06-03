/**
 * @file Built-in map presets.
 *
 * Hard-coded read-only maps that always appear in the registry so the
 * Battle Designer's MAP dropdown is never empty even on a fresh save.
 * Mirror the same JSON shape as user-authored maps so the resolver can
 * treat them identically.
 *
 * Naming: "default-*" reserved for built-ins; user-authored ids are the
 * `map-<timestamp>` pattern produced by blankMap().
 */

import { LATEST_VERSION, MAP_KIND } from "./format.js";

function preset(id, name, mapW, mapH) {
  return {
    kind: MAP_KIND,
    version: LATEST_VERSION,
    id,
    name,
    mapW,
    mapH,
    spawn: {
      blue: { x: mapW * 0.10, y: mapH / 2, w: mapW * 0.13, h: mapH * 0.84 },
      red:  { x: mapW * 0.90, y: mapH / 2, w: mapW * 0.13, h: mapH * 0.84 },
    },
    decor: [],
    hazards: [],
    platforms: [],
    _builtin: true,
  };
}

export const BUILTIN_MAPS = [
  preset("default-small",  "Default · Small",  4500, 3200),
  preset("default-medium", "Default · Medium", 7000, 5000),
  preset("default-large",  "Default · Large", 11000, 7800),
];

export const DEFAULT_MAP_ID = "default-medium";
