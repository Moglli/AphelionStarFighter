// =============================================================================
// shipgen.js — procedural ship generation.
//
// Pure, deterministic, side-effect-free. Builds two things from the EXISTING
// content:
//   1. LOADOUTS — a `design` object (hull + per-slot component ids) chosen from
//      the component catalog by ARCHETYPE, gated by act/tier cost ceilings. The
//      output is exactly the shape applyDesign()/createShip() already consume,
//      so a generated loadout drives the AI and renders identically to the
//      stock player design — no special-casing downstream.
//   2. HULLS — a randomized silhouette polygon honouring the strict hull
//      contract (see validateHull). Stashed on `design.hullPoly`; createShip
//      routes it through the geometry pipeline in place of getHull(race,klass).
//
// Determinism: every random draw comes from a seeded mulberry32 stream
// (shipRng(runSeed, nodeId, salt)), so re-entering a campaign node after a
// save/reload regenerates byte-identical ships. NO Date.now()/performance.now()
// (game.js forbids them for reproducibility).
//
// This module is the reusable core a future player ship-builder sits on top of:
// generateLoadout(pool=ownedComponents), generateHull, validateHull, and the
// design.hullPoly override are all the builder needs.
// =============================================================================

import { HULLS, COMPONENTS, defaultForSlot } from "./components.js";

// -----------------------------------------------------------------------------
// Seeded RNG. Identical algorithm to roguelite.js#mulberry32 (kept local so
// shipgen.js has no dependency on the campaign module — the builder can import
// it standalone). Same algorithm ⇒ same stream ⇒ reproducible.
// -----------------------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Compose a stable per-ship stream from the run seed + node id + a per-ship
// salt (the roster slot index). Distinct primes keep the three inputs from
// aliasing so two ships in the same node get independent streams.
export function shipRng(runSeed, nodeId, salt = 0) {
  const s = (((runSeed >>> 0) ^ (((nodeId | 0) * 2654435761) >>> 0) ^ (((salt | 0) * 40503) >>> 0)) >>> 0) || 1;
  return mulberry32(s);
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
function rngPick(arr, rng) { return arr[Math.floor(rng() * arr.length) % arr.length]; }
function rngRange(rng, lo, hi) { return lo + rng() * (hi - lo); }

// -----------------------------------------------------------------------------
// Hull contract validator. Returns [] when valid, else a list of reasons.
// Encodes the exact invariants the geometry pipeline relies on:
//   buildCells (sprites.js) culls via an even-odd point-in-hull ray-cast and
//   derives the cell-grid height from max|y|; pdSeatAtFraction (modules.js)
//   needs CCW winding for its inward normal; snapModulesSymmetric needs
//   y-symmetry. Also a dev guard over the hand-authored HULLS in ship.js.
// -----------------------------------------------------------------------------
export function validateHull(poly) {
  const errs = [];
  if (!Array.isArray(poly) || poly.length < 3) { errs.push("need >=3 vertices"); return errs; }

  // Winding. The authored HULLS in ship.js all have a POSITIVE shoelace area
  // (verified) — that is this game's "CCW" convention (modules.js treats
  // (-dy,dx) as the inward normal under it). Require the same sign.
  let area2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    area2 += a[0] * b[1] - b[0] * a[1];
  }
  if (area2 <= 0) errs.push(`winding not CCW (shoelace ${(area2 / 2).toFixed(3)} <= 0)`);

  // Y-symmetry: every off-axis vertex must have a mirror [x,-y]. Required by
  // snapModulesSymmetric (port↔starboard module pairing).
  const EPS = 2e-3;
  for (const [x, y] of poly) {
    if (Math.abs(y) < EPS) continue; // on-axis vertices self-mirror
    const ok = poly.some(([x2, y2]) => Math.abs(x2 - x) < EPS && Math.abs(y2 + y) < EPS);
    if (!ok) { errs.push(`vertex [${x.toFixed(3)},${y.toFixed(3)}] has no y-mirror`); break; }
  }

  // Must contain the origin (ray/perimeter assumptions in pointInHull +
  // pdSeatAtFraction). Use the same even-odd test the renderer uses.
  if (!pointInHullLocal(poly, 0, 0)) errs.push("does not contain origin");

  // Bounds. max|y| feeds buildCells' cell-grid height (halfYUnit); >1 makes the
  // grid huge. max|x| should stay within the unit box.
  let maxAbsY = 0, maxAbsX = 0;
  for (const [x, y] of poly) { maxAbsY = Math.max(maxAbsY, Math.abs(y)); maxAbsX = Math.max(maxAbsX, Math.abs(x)); }
  if (maxAbsY > 0.96) errs.push(`max|y| ${maxAbsY.toFixed(2)} > 0.96`);
  if (maxAbsX > 1.001) errs.push(`max|x| ${maxAbsX.toFixed(2)} > 1.0`);

  // No degenerate (near-zero-length) edges — they break PD arc-length seating.
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-4) { errs.push(`zero-length edge at ${i}`); break; }
  }

  // Simple polygon: no non-adjacent edge pair may cross. The ray-cast cull
  // assumes a simple polygon.
  if (selfIntersects(poly)) errs.push("self-intersecting");

  return errs;
}

// Even-odd point-in-polygon (copy of sprites.js#pointInHull, kept local so this
// module is canvas/DOM-free and importable in a headless harness).
function pointInHullLocal(poly, px, py) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function segInter(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-12) return false; // parallel/collinear → treat as non-crossing
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}
function selfIntersects(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a1 = poly[i], a2 = poly[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i) continue;
      if (j === (i + 1) % n) continue;          // adjacent (shares a2)
      if ((j + 1) % n === i) continue;          // adjacent (shares a1)
      if (segInter(a1, a2, poly[j], poly[(j + 1) % n])) return true;
    }
  }
  return false;
}

// -----------------------------------------------------------------------------
// Hull silhouette generation.
//
// Strategy that is VALID BY CONSTRUCTION: emit the top (+y) edge as a function
// of strictly-decreasing x from the nose [1,0] to an on-axis tail [tailX,0],
// then mirror it to the bottom (-y). Because x is monotonic along each edge and
// the two edges never share a y-sign except at the two on-axis endpoints, the
// polygon is always simple, y-symmetric, origin-containing, and (with the
// authored vertex order) positive-shoelace CCW. validateHull + retry + a
// zero-jitter fallback are belt-and-suspenders.
// -----------------------------------------------------------------------------
const ENVELOPE = {
  fighter:    { maxY: 0.52, tailX: -0.95, stations: 7 },
  bomber:     { maxY: 0.58, tailX: -0.96, stations: 8 },
  frigate:    { maxY: 0.50, tailX: -0.95, stations: 8 },
  cruiser:    { maxY: 0.50, tailX: -1.00, stations: 9 },
  battleship: { maxY: 0.70, tailX: -1.00, stations: 11 },
  carrier:    { maxY: 0.62, tailX: -1.00, stations: 9 },
};

// Per-style shaping of the half-height profile. All keep x monotonic (no
// backward hooks) so validity is preserved.
const HULL_STYLES = ["needle", "delta", "slab", "barbed"];

function buildHullAttempt(klass, style, rng, jitterScale) {
  const env = ENVELOPE[klass] || ENVELOPE.frigate;
  const maxY = style === "needle" ? env.maxY * 0.82 : style === "slab" ? Math.min(0.94, env.maxY * 1.12) : env.maxY;
  const nStations = clamp(env.stations + Math.round(rngRange(rng, -1, 2)), 5, 13);
  const x0 = 0.82, tailX = env.tailX;
  const span = x0 - tailX;
  const top = [[1.0, 0.0]];
  for (let i = 0; i < nStations; i++) {
    // strictly-decreasing x with sub-step jitter (kept < half the spacing so
    // monotonicity — hence simplicity — is guaranteed).
    const base = i / (nStations - 1);             // 0..1 nose→tail
    const xJit = (rng() - 0.5) * (span / nStations) * 0.5;
    const x = x0 - base * span + xJit;
    // half-height profile: 0 at nose, peak mid-body, taper to tail.
    let u = base;                                  // 0 nose .. 1 tail
    let shape = Math.pow(Math.sin(Math.PI * Math.min(0.999, Math.max(0.001, u))), style === "slab" ? 0.5 : style === "needle" ? 1.25 : 0.8);
    if (style === "delta") shape = Math.pow(u, 0.7); // widest at the tail (delta wing)
    let y = maxY * shape;
    if (style === "barbed") y *= 1 + ((i % 2 === 0) ? 0.18 : -0.12); // sawtooth flanks
    y *= 1 + (rng() - 0.5) * 0.22 * jitterScale;
    y = clamp(y, 0.05, maxY);
    top.push([x, y]);
  }
  const tail = [tailX, 0.0];
  // poly = nose, top(+y, x decreasing), tail tip, bottom(-y, x increasing).
  const poly = [...top, tail];
  for (let i = top.length - 1; i >= 1; i--) poly.push([top[i][0], -top[i][1]]);
  return poly;
}

export function generateHull(klass, { rng, style = null } = {}) {
  const st = style || rngPick(HULL_STYLES, rng);
  for (let attempt = 0; attempt < 8; attempt++) {
    const poly = buildHullAttempt(klass, st, rng, 1 - attempt * 0.1);
    if (validateHull(poly).length === 0) return poly;
  }
  // Guaranteed-valid fallback: zero jitter, conservative envelope.
  return buildHullAttempt(klass, "delta", () => 0.5, 0);
}

// -----------------------------------------------------------------------------
// Loadout generation.
//
// ARCHETYPES weight slot CATEGORIES; ACT_GATING caps absolute power per act via
// component COST (which already ranks components within a slot — no schema
// change). Picks one component per hull slot; always falls back to the slot
// default so no ship is ever missing a weapon.
// -----------------------------------------------------------------------------
export const ARCHETYPES = {
  "glass-cannon": { weapon: 3.0, missile: 1.2, shield: 0.4, armor: 0.2, engine: 1.5, pd: 0.5, hangar: 1 },
  "brawler":      { weapon: 2.0, missile: 1.0, shield: 1.5, armor: 1.8, engine: 0.8, pd: 1.2, hangar: 1 },
  "missile-boat": { weapon: 0.8, missile: 3.0, shield: 1.0, armor: 1.0, engine: 0.9, pd: 1.0, hangar: 1 },
  "tank":         { weapon: 1.0, missile: 0.8, shield: 2.5, armor: 2.5, engine: 0.6, pd: 1.8, hangar: 1 },
  "interceptor":  { weapon: 1.5, missile: 1.5, shield: 0.8, armor: 0.3, engine: 3.0, pd: 0.6, hangar: 1 },
};

// act/tier (0..5) → per-slot cost ceiling + a running total budget. Cost is the
// power proxy: 0 = stock default, climbing to endgame exotics. Tune freely —
// data only, no code change.
export const ACT_GATING = {
  0: { slotCostCap:  900, totalBudget:  2500 },
  1: { slotCostCap: 1500, totalBudget:  4000 },
  2: { slotCostCap: 2800, totalBudget:  9000 },
  3: { slotCostCap: 4500, totalBudget: 18000 },
  4: { slotCostCap: 6500, totalBudget: 32000 },
  5: { slotCostCap: 9000, totalBudget: 60000 },
};

// Which archetypes suit each class (a glass-cannon carrier makes no sense).
const KLASS_ARCHETYPES = {
  fighter:    ["interceptor", "glass-cannon", "brawler"],
  bomber:     ["missile-boat", "glass-cannon", "interceptor"],
  frigate:    ["brawler", "tank", "interceptor"],
  cruiser:    ["glass-cannon", "missile-boat", "brawler"],
  battleship: ["tank", "brawler", "missile-boat"],
  carrier:    ["tank", "brawler"],
};
const ARCHETYPE_STYLE = {
  "glass-cannon": "needle", "interceptor": "needle",
  "brawler": "delta", "missile-boat": "delta",
  "tank": "slab",
};

export function pickArchetypeFor(klass, rng) {
  const pool = KLASS_ARCHETYPES[klass] || Object.keys(ARCHETYPES);
  return rngPick(pool, rng);
}
function styleFor(archetype, rng) {
  // 70% the archetype's signature style, 30% a wildcard for silhouette variety.
  if (rng() < 0.7 && ARCHETYPE_STYLE[archetype]) return ARCHETYPE_STYLE[archetype];
  return rngPick(HULL_STYLES, rng);
}

function weightedPick(cands, rng, weights) {
  // weight = archetype-category weight × (1 + cost bias), so favoured
  // categories lean toward pricier (stronger) options and disfavoured ones
  // stay cheap. Never zero — every candidate keeps a chance.
  let total = 0;
  const ws = cands.map((c) => {
    const w = Math.max(0.05, (weights[c.category] != null ? weights[c.category] : 1) * (1 + c.cost / 2000));
    total += w;
    return w;
  });
  let r = rng() * total;
  for (let i = 0; i < cands.length; i++) { r -= ws[i]; if (r <= 0) return cands[i]; }
  return cands[cands.length - 1];
}

/**
 * Generate a design (hull + per-slot component ids) for a class.
 *   actOrTier  0..5 — gates component cost.
 *   archetype  one of ARCHETYPES (defaults to a class-appropriate roll).
 *   pool       optional array of allowed component ids (e.g. the player's owned
 *              set for the future builder). null = full catalog (campaign enemies).
 * Returns the exact shape applyDesign() consumes. Emits only string ids in a
 * fresh object — never touches COMPONENTS/specs, so it can't poison shared refs.
 */
export function generateLoadout(klass, { actOrTier = 1, rng, archetype = "brawler", pool = null } = {}) {
  const hull = HULLS[klass];
  if (!hull) return { hull: "fighter", modules: {}, name: null, paintPrimary: null, paintTrim: null };
  const weights = ARCHETYPES[archetype] || ARCHETYPES.brawler;
  const gate = ACT_GATING[clamp(actOrTier | 0, 0, 5)];
  const catalogIds = pool || Object.keys(COMPONENTS);
  const modules = {};
  let spent = 0;
  for (const slot of hull.slots) {
    const cands = catalogIds
      .map((id) => COMPONENTS[id])
      .filter((c) => c && c.slots.includes(slot) && c.cost <= gate.slotCostCap && spent + c.cost <= gate.totalBudget);
    if (cands.length === 0) { modules[slot] = defaultForSlot(slot); continue; }
    const pick = weightedPick(cands, rng, weights);
    modules[slot] = pick.id;
    spent += pick.cost;
  }
  return { hull: klass, modules, name: null, paintPrimary: null, paintTrim: null };
}

// -----------------------------------------------------------------------------
// Names — Vanguard-flavoured. Seeded so a ship's name is stable across reloads.
// -----------------------------------------------------------------------------
const NAME_PREFIX = ["Hollow", "Cipher", "Null", "Wraith", "Severance", "Pale", "Cind", "Vex", "Mourn", "Gaunt", "Rend", "Hush"];
const NAME_SUFFIX = ["-7", "-IX", " Prime", " Echo", " Reverie", " Maw", " Vigil", " Knell", " Spur", " Coil", " Shard", " Veil"];
export function rollGeneratedName(rng, klass) {
  return rngPick(NAME_PREFIX, rng) + rngPick(NAME_SUFFIX, rng);
}

/**
 * One-call full ship: { design, hullPoly, name, archetype }. The hullPoly is
 * stashed on the design (the override carrier read by createShip).
 */
export function generateShip(klass, { runSeed = 1, nodeId = 0, salt = 0, actOrTier = 1, archetype = null, randomHull = true, pool = null } = {}) {
  const rng = shipRng(runSeed, nodeId, salt);
  const arche = archetype || pickArchetypeFor(klass, rng);
  const design = generateLoadout(klass, { actOrTier, rng, archetype: arche, pool });
  const hullPoly = randomHull ? generateHull(klass, { rng, style: styleFor(arche, rng) }) : null;
  const name = rollGeneratedName(rng, klass);
  if (hullPoly) design.hullPoly = hullPoly;
  return { design, hullPoly, name, archetype: arche };
}
