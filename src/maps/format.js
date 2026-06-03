/**
 * @file Map format — canonical JSON shape, validator, serialize/parse.
 *
 * A Map records the arena geometry a scenario plays on: overall size,
 * per-side spawn zones, decor (visual-only this phase), hazards (reserved
 * — empty until a later PR), and platform placements (Phase 4 — empty
 * until that PR). Custom mode + the scenario probe look the map up via
 * `mapId` and pass the record to `applyMap(map)` in arena.js before the
 * spawn loop runs.
 *
 * Format is versioned from day 1 (LATEST_VERSION). Round-trip via the
 * same fenced ```json convention as scenarios and blueprints.
 */

import { migrateMap } from "./migrations.js";

export const LATEST_VERSION = 1;
export const MAP_KIND = "map";

// Clamp ranges. Aphelion ships fly inside an arena bounded by these —
// going outside breaks `randomSpawnPos` and the camera follow.
const MAP_W_MIN = 3000, MAP_W_MAX = 18000;
const MAP_H_MIN = 2200, MAP_H_MAX = 12000;

export function blankMap(opts = {}) {
  const mapW = clamp(opts.mapW || 7000, MAP_W_MIN, MAP_W_MAX);
  const mapH = clamp(opts.mapH || 5000, MAP_H_MIN, MAP_H_MAX);
  return {
    kind: MAP_KIND,
    version: LATEST_VERSION,
    id: opts.id || `map-${Date.now().toString(36)}`,
    name: opts.name || "New Map",
    mapW,
    mapH,
    // Proportional spawn rectangles matching arena.js's defaults (10%
    // from the edge, 13% wide, 84% tall) so the layout reads the same
    // at every map size.
    spawn: {
      blue: defaultSpawn(mapW, mapH, "blue"),
      red:  defaultSpawn(mapW, mapH, "red"),
    },
    decor: [],
    hazards: [],
    platforms: [],
  };
}

function defaultSpawn(w, h, side) {
  const x = side === "blue" ? w * 0.10 : w * 0.90;
  return { x, y: h / 2, w: w * 0.13, h: h * 0.84 };
}

export function validateMap(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["map must be a JSON object"] };
  }
  if (raw.kind !== MAP_KIND) {
    errors.push(`expected kind="${MAP_KIND}", got ${JSON.stringify(raw.kind)}`);
  }
  if (typeof raw.version !== "number") {
    errors.push("version must be a number");
  } else if (raw.version > LATEST_VERSION) {
    errors.push(`unsupported version ${raw.version} (latest is ${LATEST_VERSION})`);
  }
  if (errors.length) return { ok: false, errors };

  let m;
  try {
    m = migrateMap(raw);
  } catch (e) {
    return { ok: false, errors: [`migration failed: ${e.message}`] };
  }

  if (typeof m.id !== "string" || !m.id) errors.push("id must be a non-empty string");
  if (typeof m.name !== "string" || !m.name) m.name = "Untitled";

  if (typeof m.mapW !== "number" || m.mapW <= 0) {
    errors.push(`mapW must be a positive number in [${MAP_W_MIN}, ${MAP_W_MAX}]`);
    m.mapW = 7000;
  }
  if (typeof m.mapH !== "number" || m.mapH <= 0) {
    errors.push(`mapH must be a positive number in [${MAP_H_MIN}, ${MAP_H_MAX}]`);
    m.mapH = 5000;
  }
  m.mapW = clamp(m.mapW, MAP_W_MIN, MAP_W_MAX);
  m.mapH = clamp(m.mapH, MAP_H_MIN, MAP_H_MAX);

  if (!m.spawn || typeof m.spawn !== "object") {
    m.spawn = { blue: defaultSpawn(m.mapW, m.mapH, "blue"), red: defaultSpawn(m.mapW, m.mapH, "red") };
  } else {
    for (const side of ["blue", "red"]) {
      m.spawn[side] = validateSpawn(m.spawn[side], side, m.mapW, m.mapH, errors);
    }
  }

  // Decor: visual-only this phase. Each entry: { type, x, y, r, rot? }.
  if (!Array.isArray(m.decor)) {
    if (m.decor != null) errors.push("decor must be an array");
    m.decor = [];
  } else {
    m.decor = m.decor.map((d, i) => validateDecor(d, i, errors, m.mapW, m.mapH));
  }

  // Hazards + platforms: reserved for later phases. Shape-check only.
  if (!Array.isArray(m.hazards)) {
    if (m.hazards != null) errors.push("hazards must be an array");
    m.hazards = [];
  }
  if (!Array.isArray(m.platforms)) {
    if (m.platforms != null) errors.push("platforms must be an array");
    m.platforms = [];
  }

  return { ok: errors.length === 0, errors, value: m };
}

function validateSpawn(zone, side, mapW, mapH, errors) {
  if (!zone || typeof zone !== "object") {
    errors.push(`spawn.${side} must be an object`);
    return defaultSpawn(mapW, mapH, side);
  }
  const out = {
    x: clampNum(zone.x, 0, mapW, mapW * (side === "blue" ? 0.10 : 0.90)),
    y: clampNum(zone.y, 0, mapH, mapH / 2),
    w: clampNum(zone.w, 200, mapW, mapW * 0.13),
    h: clampNum(zone.h, 200, mapH, mapH * 0.84),
  };
  // Validate that the spawn rect stays inside the bounds. If it doesn't
  // we clamp + warn — the scenario is salvageable, just sub-optimal.
  const halfW = out.w / 2, halfH = out.h / 2;
  if (out.x - halfW < 0 || out.x + halfW > mapW) {
    errors.push(`spawn.${side} rectangle extends outside mapW`);
    out.x = Math.max(halfW, Math.min(mapW - halfW, out.x));
  }
  if (out.y - halfH < 0 || out.y + halfH > mapH) {
    errors.push(`spawn.${side} rectangle extends outside mapH`);
    out.y = Math.max(halfH, Math.min(mapH - halfH, out.y));
  }
  return out;
}

function validateDecor(d, i, errors, mapW, mapH) {
  if (!d || typeof d !== "object") {
    errors.push(`decor[${i}] must be an object`);
    return { type: "asteroid", x: 0, y: 0, r: 100, rot: 0 };
  }
  const type = d.type === "asteroid" ? "asteroid" : "asteroid"; // only one type for now
  const x = clampNum(d.x, 0, mapW, mapW / 2);
  const y = clampNum(d.y, 0, mapH, mapH / 2);
  const r = clampNum(d.r, 30, 600, 120);
  const rot = typeof d.rot === "number" ? d.rot : Math.random() * Math.PI * 2;
  return { type, x, y, r, rot };
}

function clampNum(v, lo, hi, fallback) {
  if (typeof v !== "number" || Number.isNaN(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function serializeMap(m) {
  return "```json\n" + JSON.stringify(m, null, 2) + "\n```";
}

export function parseMap(input) {
  if (input && typeof input === "object") return validateMap(input);
  if (typeof input !== "string") {
    return { ok: false, errors: ["input must be a string or object"] };
  }
  const stripped = stripFence(input);
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    return { ok: false, errors: [`JSON parse failed: ${e.message}`] };
  }
  return validateMap(parsed);
}

function stripFence(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return m ? m[1] : text.trim();
}
