/**
 * @file Scenario format — canonical JSON shape, validator, serialize/parse.
 *
 * A Scenario fully describes a battle the player can replay or paste into a
 * Claude chat: which factions on each side, what ships, where they start,
 * what orders, which map. Custom mode consumes the Scenario via
 * `game.scenario`; modes/custom.js + game.js#spawnRoster turn it into a
 * spawned roster + stamped orders.
 *
 * Format is versioned from day 1 (see `LATEST_VERSION`). Bump only on
 * incompatible *shape* changes — additive fields don't need a bump.
 * Round-trip via fenced markdown code block:
 *
 *     ```json
 *     { "kind": "scenario", "version": 1, ... }
 *     ```
 *
 * so users can paste either the raw JSON or the fenced block into a chat
 * and parseScenario will recover it.
 */

import { migrateScenario } from "./migrations.js";

export const LATEST_VERSION = 1;
export const SCENARIO_KIND = "scenario";

const RACES = new Set(["terran", "reavers", "hegemony", "voidsworn", "thren", "brood", "vanguard", "saurian", "synthetic"]);
const KLASSES = new Set(["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier"]);
const SIDES = new Set(["blue", "red"]);
const STANCES = new Set(["ENGAGE", "CHARGE", "STANDOFF", "STAND_OFF", "HOLD", "HOLD_POSITION", "FALLBACK", "FALL_BACK"]);
const PRIORITIES = new Set(["DEFAULT", "HUNT", "FOCUS"]);
const ASSIGNMENTS = new Set(["FREE_ROAM", "ESCORT", "GUARD_POINT"]);
const WIN_CONDITIONS = new Set(["eliminate", "survive", "capture"]);

/**
 * Build a blank, valid scenario. Useful for designer/import scaffolding.
 */
export function blankScenario(opts = {}) {
  return {
    kind: SCENARIO_KIND,
    version: LATEST_VERSION,
    id: opts.id || `scenario-${Date.now().toString(36)}`,
    name: opts.name || "New Scenario",
    notes: opts.notes || "",
    mapId: opts.mapId || "default-medium",
    blueTeams: [],
    redTeams: [],
    platforms: [],
    objectives: { winCondition: "eliminate", timeLimitSec: null },
    playerTeam: "blue",
    playerShip: { klass: "fighter", designId: null },
  };
}

/**
 * Validate a scenario. Returns { ok: boolean, errors: string[], value? }.
 * On `ok`, `value` is the normalized scenario (defaults filled in).
 * Migrations run first so a v0 scenario from an older save can still
 * pass.
 */
export function validateScenario(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["scenario must be a JSON object"] };
  }
  if (raw.kind !== SCENARIO_KIND) {
    errors.push(`expected kind="${SCENARIO_KIND}", got ${JSON.stringify(raw.kind)}`);
  }
  if (typeof raw.version !== "number") {
    errors.push("version must be a number");
  } else if (raw.version > LATEST_VERSION) {
    errors.push(`unsupported version ${raw.version} (latest is ${LATEST_VERSION})`);
  }
  if (errors.length) return { ok: false, errors };

  // Migrate (no-op for v1).
  let s;
  try {
    s = migrateScenario(raw);
  } catch (e) {
    return { ok: false, errors: [`migration failed: ${e.message}`] };
  }

  // Required string fields with sensible defaults.
  if (typeof s.id !== "string" || !s.id) errors.push("id must be a non-empty string");
  if (typeof s.name !== "string" || !s.name) s.name = "Untitled";
  if (typeof s.notes !== "string") s.notes = "";
  if (typeof s.mapId !== "string" || !s.mapId) s.mapId = "default-medium";

  // Teams.
  for (const sideKey of ["blueTeams", "redTeams"]) {
    if (!Array.isArray(s[sideKey])) {
      errors.push(`${sideKey} must be an array`);
      s[sideKey] = [];
      continue;
    }
    s[sideKey] = s[sideKey].map((t, ti) => validateTeam(t, sideKey, ti, errors));
  }

  // Platforms (Phase 4 — empty for now; just shape-check).
  if (s.platforms != null && !Array.isArray(s.platforms)) {
    errors.push("platforms must be an array");
    s.platforms = [];
  } else if (!s.platforms) {
    s.platforms = [];
  }

  // Objectives.
  if (!s.objectives || typeof s.objectives !== "object") {
    s.objectives = { winCondition: "eliminate", timeLimitSec: null };
  } else {
    const wc = s.objectives.winCondition;
    if (!WIN_CONDITIONS.has(wc)) {
      errors.push(`objectives.winCondition must be one of [${[...WIN_CONDITIONS].join(", ")}]`);
      s.objectives.winCondition = "eliminate";
    }
    if (s.objectives.timeLimitSec != null && typeof s.objectives.timeLimitSec !== "number") {
      errors.push("objectives.timeLimitSec must be a number or null");
      s.objectives.timeLimitSec = null;
    }
  }

  // Player team + ship.
  if (!SIDES.has(s.playerTeam)) {
    errors.push(`playerTeam must be one of [${[...SIDES].join(", ")}]`);
    s.playerTeam = "blue";
  }
  if (!s.playerShip || typeof s.playerShip !== "object") {
    s.playerShip = { klass: "fighter", designId: null };
  } else {
    if (!KLASSES.has(s.playerShip.klass)) {
      errors.push(`playerShip.klass must be one of [${[...KLASSES].join(", ")}]`);
      s.playerShip.klass = "fighter";
    }
    if (s.playerShip.designId != null && typeof s.playerShip.designId !== "string") {
      errors.push("playerShip.designId must be a string or null");
      s.playerShip.designId = null;
    }
  }

  return { ok: errors.length === 0, errors, value: s };
}

function validateTeam(t, sideKey, ti, errors) {
  const path = `${sideKey}[${ti}]`;
  if (!t || typeof t !== "object") {
    errors.push(`${path} must be an object`);
    return { race: "terran", ships: [] };
  }
  if (!RACES.has(t.race)) {
    errors.push(`${path}.race must be one of [${[...RACES].join(", ")}]`);
    t.race = "terran";
  }
  if (!Array.isArray(t.ships)) {
    errors.push(`${path}.ships must be an array`);
    t.ships = [];
  } else {
    t.ships = t.ships.map((row, ri) => validateShipRow(row, `${path}.ships[${ri}]`, errors));
  }
  return t;
}

function validateShipRow(row, path, errors) {
  if (!row || typeof row !== "object") {
    errors.push(`${path} must be an object`);
    return { klass: "fighter", count: 1 };
  }
  if (!KLASSES.has(row.klass)) {
    errors.push(`${path}.klass must be one of [${[...KLASSES].join(", ")}]`);
    row.klass = "fighter";
  }
  if (typeof row.count !== "number" || row.count < 1) {
    errors.push(`${path}.count must be a positive number`);
    row.count = 1;
  }
  row.count = Math.max(1, Math.floor(row.count));

  if (row.spawn) {
    const sp = row.spawn;
    if (typeof sp.x !== "number" || typeof sp.y !== "number") {
      errors.push(`${path}.spawn must have numeric x,y`);
      row.spawn = null;
    } else if (sp.spread != null && typeof sp.spread !== "number") {
      errors.push(`${path}.spawn.spread must be a number`);
      sp.spread = 200;
    }
  }

  if (row.stance != null) {
    const sn = normalizeStance(row.stance);
    if (!sn) {
      errors.push(`${path}.stance must be one of [${[...STANCES].join(", ")}]`);
      row.stance = null;
    } else {
      row.stance = sn;
    }
  }
  if (row.priority != null) {
    const p = String(row.priority).toUpperCase();
    if (!PRIORITIES.has(p)) {
      errors.push(`${path}.priority must be one of [${[...PRIORITIES].join(", ")}]`);
      row.priority = null;
    } else {
      row.priority = p;
    }
  }
  if (row.priorityClass != null && !KLASSES.has(row.priorityClass)) {
    errors.push(`${path}.priorityClass must be one of [${[...KLASSES].join(", ")}]`);
    row.priorityClass = null;
  }
  if (row.assignment != null) {
    const a = String(row.assignment).toUpperCase().replace(/\s+/g, "_");
    if (!ASSIGNMENTS.has(a)) {
      errors.push(`${path}.assignment must be one of [${[...ASSIGNMENTS].join(", ")}]`);
      row.assignment = null;
    } else {
      row.assignment = a;
    }
  }
  if (row.designId != null && typeof row.designId !== "string") {
    errors.push(`${path}.designId must be a string or null`);
    row.designId = null;
  }
  return row;
}

function normalizeStance(stance) {
  const s = String(stance).toUpperCase().replace(/\s+/g, "_");
  // STAND_OFF / STANDOFF / HOLD_POSITION / HOLD / FALL_BACK / FALLBACK are aliases.
  if (s === "STAND_OFF") return "STANDOFF";
  if (s === "HOLD_POSITION") return "HOLD";
  if (s === "FALL_BACK") return "FALLBACK";
  if (STANCES.has(s)) return s;
  return null;
}

/**
 * Serialize a scenario to a markdown fenced code block. The fence
 * (and the surrounding newlines) make it copy-paste safe in chat.
 */
export function serializeScenario(scenario) {
  const json = JSON.stringify(scenario, null, 2);
  return "```json\n" + json + "\n```";
}

/**
 * Parse a scenario from any of:
 *   - a raw JSON string
 *   - a markdown text containing a fenced ```json block
 *   - an already-parsed object
 * Returns the validate() result on success: { ok, errors, value }.
 */
export function parseScenario(input) {
  if (input && typeof input === "object") return validateScenario(input);
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
  return validateScenario(parsed);
}

function stripFence(text) {
  // Match a fenced JSON block (```json ... ``` or ``` ... ```). If absent,
  // return text unchanged so a raw JSON paste still parses.
  const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return m ? m[1] : text.trim();
}

/**
 * Map the new-shape stance/priority/assignment fields onto the
 * `wingCommand` shape ai.js#resolveOrders consumes. Returns null if
 * the row has no orders set.
 */
export function rowToWingCommand(row) {
  if (!row || (row.stance == null && row.priority == null && row.assignment == null)) {
    return null;
  }
  const STANCE_MAP = { ENGAGE: "engage", CHARGE: "charge", STANDOFF: "standoff", HOLD: "hold", FALLBACK: "fallback" };
  const PRIORITY_MAP = { DEFAULT: "default", HUNT: "hunt", FOCUS: "focus" };
  const ASSIGNMENT_MAP = { FREE_ROAM: "free", ESCORT: "escort", GUARD_POINT: "guard" };
  const cmd = {
    stance: STANCE_MAP[row.stance] || "engage",
    priority: PRIORITY_MAP[row.priority] || "default",
    assignment: ASSIGNMENT_MAP[row.assignment] || "free",
  };
  if (row.priorityClass) cmd.priorityClass = row.priorityClass;
  return cmd;
}
