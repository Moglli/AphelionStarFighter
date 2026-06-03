/**
 * @file Blueprint format — canonical JSON shape, validator, serialize/parse.
 *
 * A Blueprint pairs a hull (race + klass) with a design (slot → component-id
 * map). Scenarios reference blueprints by `designId`; spawnRoster looks
 * the blueprint up and passes its design + paint into createShip — same
 * code path the persistent player ship already uses, so AI / physics /
 * render are untouched (CLAUDE.md: "Shipyard / design pipeline").
 *
 * Round-trip via the same fenced ```json convention as scenarios so
 * blueprints can be pasted into a Claude chat for tuning.
 */

import { migrateBlueprint } from "./migrations.js";
import { HULLS, COMPONENTS, defaultForSlot } from "../components.js";

export const LATEST_VERSION = 1;
export const BLUEPRINT_KIND = "blueprint";

const RACES = new Set(["terran", "reavers", "hegemony", "voidsworn", "thren", "brood", "vanguard", "saurian", "synthetic"]);
const KLASSES = new Set(["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier"]);

export function blankBlueprint(opts = {}) {
  const klass = opts.klass && KLASSES.has(opts.klass) ? opts.klass : "fighter";
  const hull = HULLS[klass] || HULLS.fighter;
  // Default modules: fill every slot the hull declares with its slot
  // default (matches the stock player ship for the chosen klass).
  const modules = {};
  for (const slot of hull.slots) {
    const d = defaultForSlot(slot);
    if (d) modules[slot] = d;
  }
  return {
    kind: BLUEPRINT_KIND,
    version: LATEST_VERSION,
    id: opts.id || `bp-${Date.now().toString(36)}`,
    name: opts.name || "New Blueprint",
    race: opts.race && RACES.has(opts.race) ? opts.race : "terran",
    klass,
    radiusScale: 1.0,
    design: {
      hull: klass,
      modules,
      name: opts.shipName || "",
      paintPrimary: null,
      paintTrim: null,
    },
    paint: { primary: null, accent: null },
  };
}

export function validateBlueprint(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["blueprint must be a JSON object"] };
  }
  if (raw.kind !== BLUEPRINT_KIND) {
    errors.push(`expected kind="${BLUEPRINT_KIND}", got ${JSON.stringify(raw.kind)}`);
  }
  if (typeof raw.version !== "number") {
    errors.push("version must be a number");
  } else if (raw.version > LATEST_VERSION) {
    errors.push(`unsupported version ${raw.version} (latest is ${LATEST_VERSION})`);
  }
  if (errors.length) return { ok: false, errors };

  let b;
  try {
    b = migrateBlueprint(raw);
  } catch (e) {
    return { ok: false, errors: [`migration failed: ${e.message}`] };
  }

  if (typeof b.id !== "string" || !b.id) errors.push("id must be a non-empty string");
  if (typeof b.name !== "string" || !b.name) b.name = "Untitled";

  if (!RACES.has(b.race)) {
    errors.push(`race must be one of [${[...RACES].join(", ")}]`);
    b.race = "terran";
  }
  if (!KLASSES.has(b.klass)) {
    errors.push(`klass must be one of [${[...KLASSES].join(", ")}]`);
    b.klass = "fighter";
  }
  if (typeof b.radiusScale !== "number") b.radiusScale = 1.0;
  // Clamp radiusScale to ±30% — beyond that the hull starts overlapping
  // its own modules and the AI's targeting picks up weird seams.
  b.radiusScale = Math.max(0.7, Math.min(1.3, b.radiusScale));

  // Design: must reference the same klass as the blueprint's hull entry.
  if (!b.design || typeof b.design !== "object") {
    b.design = { hull: b.klass, modules: {} };
  }
  if (b.design.hull !== b.klass) {
    // Forcing the design.hull to match the blueprint klass keeps the
    // designer's slot picker honest. Mismatched saves get repaired
    // silently — never error here, the data is salvageable.
    b.design.hull = b.klass;
  }
  if (!b.design.modules || typeof b.design.modules !== "object") b.design.modules = {};
  // Strip unknown component ids per slot; resolveDesignComponents falls
  // back to slot defaults at apply time so the spec stays well-formed.
  const hull = HULLS[b.klass];
  if (hull) {
    const cleaned = {};
    for (const slot of hull.slots) {
      const ref = b.design.modules[slot];
      if (typeof ref === "string" && COMPONENTS[ref] && COMPONENTS[ref].slots.includes(slot)) {
        cleaned[slot] = ref;
      }
    }
    b.design.modules = cleaned;
  }

  if (!b.paint || typeof b.paint !== "object") b.paint = { primary: null, accent: null };

  return { ok: errors.length === 0, errors, value: b };
}

export function serializeBlueprint(bp) {
  return "```json\n" + JSON.stringify(bp, null, 2) + "\n```";
}

export function parseBlueprint(input) {
  if (input && typeof input === "object") return validateBlueprint(input);
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
  return validateBlueprint(parsed);
}

function stripFence(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return m ? m[1] : text.trim();
}
