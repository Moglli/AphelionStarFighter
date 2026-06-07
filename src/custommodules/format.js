/**
 * @file Custom-module library format — a reusable, named module record.
 *
 * A library module is a saved CustomModule MINUS placement (`offset`) and the
 * back-reference (`refId`) — i.e. the portable stat/projectile recipe. The Ship
 * Editor's palette lists these alongside the built-in types; dropping one onto a
 * hull stamps a placed module (`{ ...record, refId: record.id, offset }`).
 *
 * Reuses customships/format.js#blankModule + cleanModule semantics so a library
 * record's stats validate by exactly the same clamps as an embedded module.
 * Headless-safe (only pulls the DOM-free format module).
 */

import { blankModule, MODULE_TYPES, validateCustomShip } from "../customships/format.js";

export const LATEST_VERSION = 1;
export const CUSTOM_MODULE_KIND = "customModule";
const TYPE_SET = new Set(MODULE_TYPES);

export function blankCustomModule(opts = {}) {
  const type = TYPE_SET.has(opts.type) ? opts.type : "forwardGun";
  const placed = blankModule(type, { x: 0, y: 0 }); // fully-formed stats/projectile
  return {
    kind: CUSTOM_MODULE_KIND,
    version: LATEST_VERSION,
    id: opts.id || `cm-${Date.now().toString(36)}-${(Date.now() % 1000)}`,
    name: opts.name || "New Module",
    type,
    hp: placed.hp,
    hullPenalty: placed.hullPenalty,
    armor: placed.armor,
    arc: placed.arc,
    stats: placed.stats,
    projectile: placed.projectile,
  };
}

export function validateCustomModule(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["customModule must be a JSON object"] };
  if (raw.kind !== CUSTOM_MODULE_KIND) errors.push(`expected kind="${CUSTOM_MODULE_KIND}", got ${JSON.stringify(raw.kind)}`);
  if (typeof raw.version === "number" && raw.version > LATEST_VERSION) errors.push(`unsupported version ${raw.version}`);
  if (!TYPE_SET.has(raw.type)) errors.push(`type must be one of [${MODULE_TYPES.join(", ")}]`);
  if (errors.length) return { ok: false, errors };

  // Round-trip the stat block through the embedded-module cleaner by wrapping it
  // in a throwaway customShip — guarantees the library record clamps identically
  // to a placed module, with zero duplicated clamp logic.
  const probe = validateCustomShip({
    kind: "customShip", version: 1, tier: "fighter",
    modules: [{ type: raw.type, offset: { x: 0, y: 0 }, hp: raw.hp, hullPenalty: raw.hullPenalty, armor: raw.armor, arc: raw.arc, stats: raw.stats, projectile: raw.projectile }],
  });
  const cleaned = (probe.value && probe.value.modules[0]) || blankModule(raw.type, { x: 0, y: 0 });

  return {
    ok: true,
    errors,
    value: {
      kind: CUSTOM_MODULE_KIND,
      version: LATEST_VERSION,
      id: typeof raw.id === "string" && raw.id ? raw.id : `cm-${Date.now().toString(36)}`,
      name: typeof raw.name === "string" && raw.name ? raw.name : "Untitled Module",
      type: raw.type,
      hp: cleaned.hp,
      hullPenalty: cleaned.hullPenalty,
      armor: cleaned.armor,
      arc: cleaned.arc,
      stats: cleaned.stats,
      projectile: cleaned.projectile,
    },
  };
}

// Library record → a placed CustomModule for design.modules[]. Stamps refId so
// the editor can show "from library" provenance; stats are copied by value so
// per-placement tweaks don't mutate the shared library record.
export function instantiateLibraryModule(record, offset = { x: 0, y: 0 }) {
  const res = validateCustomModule(record);
  const r = res.value || blankCustomModule(record);
  return {
    refId: r.id,
    type: r.type,
    offset: { x: offset.x, y: offset.y },
    hp: r.hp,
    hullPenalty: r.hullPenalty,
    armor: r.armor,
    arc: r.arc,
    stats: JSON.parse(JSON.stringify(r.stats)),
    projectile: r.projectile ? JSON.parse(JSON.stringify(r.projectile)) : null,
  };
}
