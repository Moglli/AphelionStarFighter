/**
 * @file Custom-ship format — canonical JSON shape, validator, serialize/parse.
 *
 * A customShip is a FREE-FORM authored design doc (Ship Editor, dev-gated).
 * Unlike a Blueprint — which only re-skins a fixed hull by picking pre-built
 * components for declared slots — a customShip carries its OWN hull polygon,
 * arbitrary module placements with fully custom stats, and a new "mothership"
 * tier. `compileCustomShip` (compile.js) lowers this rich doc into the engine's
 * existing createShip shape (specOverride + design.hullPoly + moduleList +
 * cellOverride), so the entire fire/render/AI/damage pipeline runs unchanged.
 *
 * Round-trip via the same fenced ```json convention as blueprints/scenarios so
 * a doc can be pasted into a Claude chat for tuning. validate-and-REPAIR (never
 * hard-reject salvageable data) mirrors blueprints/format.js — a malformed hull
 * is normalised or falls back to a generated tier hull, not refused.
 *
 * Headless-safe: imports only shipgen.js (DOM-free) so the round-trip is
 * node-testable without a canvas.
 */

import { validateHull, generateHull, mulberry32 } from "../shipgen.js";

export const LATEST_VERSION = 1;
export const CUSTOM_SHIP_KIND = "customShip";

// Tiers a custom ship can be built at. Mirrors the engine klasses plus the
// new "mothership" super-capital. `compile.js#TIER_BASE_RADIUS` and
// sprites.js#CELL_GRID both must carry a matching entry for each tier.
export const TIERS = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier", "station", "mothership"];

const RACES = new Set(["terran", "reavers", "hegemony", "voidsworn", "thren", "brood", "vanguard", "saurian", "synthetic"]);

// Module types the editor can place. The compiler (compile.js) routes each
// onto its engine spec field + module name(s); see the mapping table there.
export const MODULE_TYPES = [
  "forwardGun",     // weapon / weaponExtras[] — module "gun"/"cannon"
  "ring",           // ringCannons — module "gun-array"
  "broadside",      // weapon + broadsideArc — modules "broadside-port/stbd-0..2"
  "heavyLaser",     // heavyLaser — modules "laser"/"laser-fore"+"laser-aft"
  "missilePod",     // missilePods — podToModuleName(...)
  "pd",             // pdCannons — modules "pd-0..N"
  "engine",         // modules "engine-0..N" (drives heading)
  "shieldGenerator",// shield — modules "shield-generator[-port/stbd]"
  "hangar",         // replenish — module "hangar"
];
const MODULE_TYPE_SET = new Set(MODULE_TYPES);

export const PROJECTILE_SHAPES = ["bolt", "dot", "lance", "blob"];
const SHAPE_SET = new Set(PROJECTILE_SHAPES);

// Per-type default module stats. Sane starting points the editor seeds when a
// fresh module is dropped; the stat panel then edits them. Kept conservative so
// an un-tuned drop still spawns + fires without dominating a sandbox match.
const MODULE_DEFAULTS = {
  forwardGun:      { hp: 40,  hullPenalty: 6,  armor: 0,    arc: null, stats: { damage: 6,  cooldown: 0.35, projectileSpeed: 720, range: 620, spread: 0.05, muzzles: 1 }, projectile: { color: null, shape: "bolt", size: 2.4 } },
  ring:            { hp: 60,  hullPenalty: 8,  armor: 0.1,  arc: Math.PI / 4, stats: { damage: 5,  cooldown: 0.5,  projectileSpeed: 680, range: 560, spread: 0.06, muzzles: 1 }, projectile: { color: null, shape: "bolt", size: 2.2 } },
  broadside:       { hp: 80,  hullPenalty: 10, armor: 0.15, arc: (25 * Math.PI) / 180, stats: { damage: 9, cooldown: 2.4, projectileSpeed: 640, range: 700, spread: 0.04, muzzles: 1 }, projectile: { color: null, shape: "bolt", size: 3.0 } },
  heavyLaser:      { hp: 90,  hullPenalty: 14, armor: 0.15, arc: Math.PI / 5, stats: { damage: 22, cooldown: 3.0, range: 820 }, projectile: { color: null, shape: "lance", size: 3.5 } },
  missilePod:      { hp: 50,  hullPenalty: 8,  armor: 0.1,  arc: null, stats: { damage: 30, cooldown: 4.0, projectileSpeed: 320, range: 1100, count: 1 }, projectile: { color: null, shape: "blob", size: 3.2 } },
  pd:              { hp: 24,  hullPenalty: 9,  armor: 0.1,  arc: null, stats: { damage: 2, cooldown: 0.18, projectileSpeed: 900, range: 280, count: 1 }, projectile: { color: null, shape: "dot", size: 1.6 } },
  engine:          { hp: 60,  hullPenalty: 18, armor: 0,    arc: null, stats: {}, projectile: null },
  shieldGenerator: { hp: 70,  hullPenalty: 12, armor: 0.1,  arc: null, stats: { shieldMax: 200, regen: 12, regenDelay: 4 }, projectile: null },
  hangar:          { hp: 80,  hullPenalty: 20, armor: 0.1,  arc: null, stats: { fighter: 6, bomber: 9 }, projectile: null },
};

function num(v, d) { return typeof v === "number" && isFinite(v) ? v : d; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Map a tier to a klass shipgen can generate a hull for (mothership has no
// generator profile of its own — borrow the carrier silhouette envelope).
function genKlassForTier(tier) {
  if (tier === "mothership") return "carrier";
  return TIERS.includes(tier) ? tier : "fighter";
}

// Deterministic, valid fallback hull for a tier (no Date.now/Math.random —
// seeded by tier index so a given tier always falls back to the same shape).
export function fallbackHull(tier) {
  const seed = (TIERS.indexOf(tier) + 1) * 2654435761;
  return generateHull(genKlassForTier(tier), { rng: mulberry32((seed >>> 0) || 1) });
}

export function blankCustomShip(opts = {}) {
  const tier = TIERS.includes(opts.tier) ? opts.tier : "fighter";
  const race = RACES.has(opts.race) ? opts.race : "terran";
  return {
    kind: CUSTOM_SHIP_KIND,
    version: LATEST_VERSION,
    id: opts.id || `cs-${Date.now().toString(36)}-${(Date.now() % 1000)}`,
    name: opts.name || "New Custom Ship",
    race,
    tier,
    // Multiplier on the tier's base radius. Lets the author scale a hull up to
    // mothership bulk or down to a strike-craft footprint. Clamped on validate.
    scaleMul: num(opts.scaleMul, 1.0),
    // Hull polygon in unit-hull space (~[-1,1]), CCW + y-symmetric. null until
    // the author draws one — validate fills the tier fallback.
    hullPoly: Array.isArray(opts.hullPoly) ? opts.hullPoly : null,
    // Central (post-block) hull HP + optional shield pool.
    hp: num(opts.hp, defaultHpForTier(tier)),
    shield: opts.shield == null ? null : num(opts.shield, null),
    // Per-cell defaults (block grid). cellOverrides is a sparse "r,c" → patch
    // map for hand-painted tougher/weaker zones.
    cellHp: num(opts.cellHp, 14),
    cellArmor: clamp(num(opts.cellArmor, 0.1), 0, 0.95),
    cellOverrides: opts.cellOverrides && typeof opts.cellOverrides === "object" ? opts.cellOverrides : {},
    modules: Array.isArray(opts.modules) ? opts.modules : [],
    // Test-fly spawn faces the nose away from the engine centroid.
    derivedHeadingFromEngines: opts.derivedHeadingFromEngines !== false,
    paintPrimary: opts.paintPrimary || null,
    paintTrim: opts.paintTrim || null,
  };
}

function defaultHpForTier(tier) {
  const HP = { fighter: 60, bomber: 90, frigate: 260, cruiser: 520, battleship: 1100, carrier: 1400, station: 1800, mothership: 4200 };
  return HP[tier] || 100;
}

// Repair one CustomModule in place; returns a cleaned copy or null to drop it.
function cleanModule(m) {
  if (!m || typeof m !== "object") return null;
  if (!MODULE_TYPE_SET.has(m.type)) return null;
  const def = MODULE_DEFAULTS[m.type];
  const ox = clamp(num(m.offset && m.offset.x, 0), -1.2, 1.2);
  const oy = clamp(num(m.offset && m.offset.y, 0), -1.2, 1.2);
  const stats = {};
  const srcStats = (m.stats && typeof m.stats === "object") ? m.stats : {};
  for (const k of Object.keys(def.stats)) stats[k] = num(srcStats[k], def.stats[k]);
  // Preserve any extra numeric stat fields the author added beyond the defaults.
  for (const k of Object.keys(srcStats)) {
    if (!(k in stats) && typeof srcStats[k] === "number" && isFinite(srcStats[k])) stats[k] = srcStats[k];
  }
  let projectile = null;
  if (def.projectile) {
    const p = (m.projectile && typeof m.projectile === "object") ? m.projectile : {};
    projectile = {
      color: typeof p.color === "string" ? p.color : null,
      shape: SHAPE_SET.has(p.shape) ? p.shape : def.projectile.shape,
      size: clamp(num(p.size, def.projectile.size), 0.5, 12),
    };
  }
  let arc = def.arc;
  if (m.arc === null) arc = null;
  else if (typeof m.arc === "number" && isFinite(m.arc)) arc = clamp(m.arc, 0.02, Math.PI);
  return {
    refId: typeof m.refId === "string" ? m.refId : null,
    // Optional author-given label (preserved across save/validate). null = use
    // the type label. Trimmed + length-capped so a pasted doc can't carry junk.
    name: typeof m.name === "string" && m.name.trim() ? m.name.trim().slice(0, 40) : null,
    type: m.type,
    offset: { x: ox, y: oy },
    hp: clamp(num(m.hp, def.hp), 1, 100000),
    hullPenalty: clamp(num(m.hullPenalty, def.hullPenalty), 0, 100000),
    armor: clamp(num(m.armor, def.armor), 0, 0.95),
    arc,
    stats,
    projectile,
  };
}

export function validateCustomShip(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["customShip must be a JSON object"] };
  }
  if (raw.kind !== CUSTOM_SHIP_KIND) {
    errors.push(`expected kind="${CUSTOM_SHIP_KIND}", got ${JSON.stringify(raw.kind)}`);
  }
  if (typeof raw.version !== "number") {
    errors.push("version must be a number");
  } else if (raw.version > LATEST_VERSION) {
    errors.push(`unsupported version ${raw.version} (latest is ${LATEST_VERSION})`);
  }
  if (errors.length) return { ok: false, errors };

  // Start from a blank so every field is well-formed, then overlay the raw doc
  // through the same clamps the editor uses — salvage, don't reject.
  const b = blankCustomShip({
    id: raw.id, name: raw.name, race: raw.race, tier: raw.tier,
    scaleMul: raw.scaleMul, hp: raw.hp, shield: raw.shield,
    cellHp: raw.cellHp, cellArmor: raw.cellArmor, cellOverrides: raw.cellOverrides,
    derivedHeadingFromEngines: raw.derivedHeadingFromEngines,
    paintPrimary: raw.paintPrimary, paintTrim: raw.paintTrim,
  });

  if (typeof b.id !== "string" || !b.id) { b.id = `cs-${Date.now().toString(36)}`; errors.push("id missing — generated"); }
  if (typeof b.name !== "string" || !b.name) b.name = "Untitled";
  if (!RACES.has(b.race)) { errors.push(`race must be one of [${[...RACES].join(", ")}]`); b.race = "terran"; }
  if (!TIERS.includes(b.tier)) { errors.push(`tier must be one of [${TIERS.join(", ")}]`); b.tier = "fighter"; }
  // Clamp scale; beyond ~3× the cell grid distorts and modules sprawl past the
  // hull. 0.4 floor keeps even a fighter-footprint mothership drawable.
  b.scaleMul = clamp(num(b.scaleMul, 1), 0.4, 3.0);
  b.hp = clamp(num(b.hp, defaultHpForTier(b.tier)), 1, 1e6);
  b.shield = b.shield == null ? null : clamp(num(b.shield, 0), 0, 1e6);
  b.cellHp = clamp(num(b.cellHp, 14), 1, 1e5);
  b.cellArmor = clamp(num(b.cellArmor, 0.1), 0, 0.95);

  // Hull polygon: validate against the engine hull contract; repair-or-fallback.
  // A bad/absent poly drops to the tier's generated fallback so the doc always
  // compiles to a spawnable ship (CLAUDE.md: generateHull self-validates).
  if (!Array.isArray(raw.hullPoly) || raw.hullPoly.length < 3) {
    b.hullPoly = fallbackHull(b.tier);
  } else {
    const poly = raw.hullPoly.map((p) => [num(p && p[0], 0), num(p && p[1], 0)]);
    const hullErrs = validateHull(poly);
    if (hullErrs.length === 0) {
      b.hullPoly = poly;
    } else {
      errors.push(`hullPoly invalid (${hullErrs.join("; ")}) — using tier fallback`);
      b.hullPoly = fallbackHull(b.tier);
    }
  }

  // Cell overrides: keep only well-formed "r,c" → {hp,armor} entries.
  const cleanOverrides = {};
  for (const key of Object.keys(b.cellOverrides || {})) {
    if (!/^\d+,\d+$/.test(key)) continue;
    const v = b.cellOverrides[key];
    if (!v || typeof v !== "object") continue;
    const patch = {};
    if (typeof v.hp === "number" && isFinite(v.hp)) patch.hp = clamp(v.hp, 1, 1e5);
    if (typeof v.armor === "number" && isFinite(v.armor)) patch.armor = clamp(v.armor, 0, 0.95);
    if (Object.keys(patch).length) cleanOverrides[key] = patch;
  }
  b.cellOverrides = cleanOverrides;

  // Modules: clean each, drop the irreparable.
  const rawModules = Array.isArray(raw.modules) ? raw.modules : [];
  b.modules = rawModules.map(cleanModule).filter(Boolean);
  if (b.modules.length !== rawModules.length) {
    errors.push(`${rawModules.length - b.modules.length} malformed module(s) dropped`);
  }

  b.derivedHeadingFromEngines = raw.derivedHeadingFromEngines !== false;
  b.paintPrimary = typeof raw.paintPrimary === "string" ? raw.paintPrimary : null;
  b.paintTrim = typeof raw.paintTrim === "string" ? raw.paintTrim : null;

  // `ok` reflects whether the doc was already clean; a repaired doc still
  // returns a usable `value` (same contract as validateBlueprint).
  return { ok: errors.length === 0, errors, value: b };
}

export function serializeCustomShip(cs) {
  return "```json\n" + JSON.stringify(cs, null, 2) + "\n```";
}

export function parseCustomShip(input) {
  if (input && typeof input === "object") return validateCustomShip(input);
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
  return validateCustomShip(parsed);
}

function stripFence(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return m ? m[1] : text.trim();
}

// Default module factory for the editor palette — a fresh, fully-formed module
// of `type` at `offset`, ready to drop into design.modules[].
export function blankModule(type, offset = { x: 0, y: 0 }) {
  const def = MODULE_DEFAULTS[type];
  if (!def) return null;
  return cleanModule({ type, offset, ...JSON.parse(JSON.stringify(def)) });
}

export { MODULE_DEFAULTS };
