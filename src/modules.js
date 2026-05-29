// Destructible ship subsystems.
//
// Every armed system on a ship is a targetable, destructible module —
// PD turrets, missile bays, broadside batteries, ring cannons, heavy
// laser, hangars, engines. A module's disc on the hull is both the
// visual indicator AND the hit zone: shots that land inside it drain
// the module's HP, and a 0-HP module goes permanently `disabled` and
// rips its `hullPenalty` from the central HP in one shot.
//
// PD turrets are per-turret: each visible PD nest on the hull rim is
// its own module (pd-0, pd-1, ...). That way a projectile that lands
// near a turret actually hits the turret's disc — previously the
// lumped pd-bow/pd-stern/etc modules sat at fixed inner positions
// while the turrets themselves rendered on a ring at radius 0.75,
// so PD was effectively un-destroyable in practice.
//
// Modules are built per-ship from the resolved spec (see buildModules)
// so a station node carrying only PD gets just per-turret pd-* +
// engines, while a battleship carrying laser+broadsides+missile-bays+
// PD gets the full set. The static LAYOUTS table is a per-class
// blueprint for non-PD modules; each entry's `requires` predicate is
// checked against the resolved spec to decide if it lands on this ship.

import { ENGINES, ENGINE_X } from "./sprites.js";

// HP / hullPenalty for one engine module, per class.
// Small craft engines bumped DOWN so a few solid cannon hits to the
// stern reliably crippled them — pairs with the engine-surrender rule
// in ship.js so disabled small craft strike colors instead of getting
// vaporized outright.
const ENGINE_MODULE = {
  fighter:    { hp:   8, hullPenalty:  5 },   // was 18 / 8
  bomber:     { hp:  18, hullPenalty: 10 },   // was 32 / 15
  frigate:    { hp:  50, hullPenalty: 20 },
  cruiser:    { hp:  50, hullPenalty: 18 },
  battleship: { hp:  60, hullPenalty: 18 },
  carrier:    { hp:  70, hullPenalty: 28 },
};

// Disc radius of an engine module (normalized to ship.spec.radius).
// Small-craft engines were 0.44/0.42 (a big stern hit zone), but on the
// short centreline of a fighter/bomber that huge disc collided with the
// (also-centreline) shield generator — and both are single modules that
// must stay on the axis for symmetry, so they can't dodge sideways. Sized
// down so all the centreline mounts tile the spine without overlapping.
const ENGINE_RADIUS = {
  fighter: 0.26, bomber: 0.26,                // was 0.44 / 0.42 (overlapped the shield)
  frigate: 0.26, cruiser: 0.18,
  battleship: 0.13, carrier: 0.20,
};

// Per-turret PD stats. One module is generated per turret at spawn
// time, positioned at the same ring location the visible turret
// renders at. Total HP across all turrets is roughly equivalent to
// the previous lumped PD modules (e.g. BB 10 × 24 = 240 ≈ old
// 2 × 120 = 240), so total time-to-disable is similar — the change
// is that hits now actually land on individual turrets instead of
// missing the lumped module disc entirely.
const PD_TURRET_MODULE = {
  bomber:     { hp: 18, hullPenalty:  7, radius: 0.18 },
  frigate:    { hp: 20, hullPenalty:  8, radius: 0.14 },
  cruiser:    { hp: 17, hullPenalty:  8, radius: 0.13 },
  battleship: { hp: 24, hullPenalty: 10, radius: 0.12 },
  carrier:    { hp: 20, hullPenalty:  9, radius: 0.12 },
  station:    { hp: 30, hullPenalty: 12, radius: 0.13 },
};

// Fallback distance from hull centre to a PD turret (normalized to
// spec.radius) when no hull polygon is supplied.
const PD_TURRET_RING = 0.75;

// Per-class module-radius scale. The combined disc area of a capital's
// modules used to exceed its hull area (battleship ~1.85×), so the upgraded
// (disc-filling) art read as one solid mass of overlapping hardware. These
// shrink every module's disc fraction so the modules tile the hull with
// gaps instead of overlapping; the matching hull-radius bumps in classes.js
// keep their ON-SCREEN size about the same (a bigger ship, same-size mounts,
// breathing room between them). Tuned against /tmp/aphel-overlap.mjs.
const MODULE_RADIUS_SCALE = {
  fighter:    0.80,
  bomber:     0.66,   // 4 centreline mounts on a short hull — must run small to tile without overlap
  frigate:    0.82,
  cruiser:    0.74,
  battleship: 0.68,
  carrier:    0.80,
  station:    1.00,
};
function moduleRadiusScale(klass) {
  const s = MODULE_RADIUS_SCALE[klass];
  return typeof s === "number" ? s : 1;
}

// Distance from hull centre to the hull silhouette EDGE along a ray at
// `angle` (radians, ship-local; +x is forward). For a simple polygon
// that contains the origin, the FIRST boundary crossing going outward is
// the silhouette edge along that bearing (correct even for concave hulls
// with sponsons/notches). Returns the ray parameter in unit-hull space
// (≈0..1); callers multiply by spec.radius. Falls back to PD_TURRET_RING
// if the ray somehow misses (degenerate polygon).
export function hullRayRadius(poly, angle) {
  if (!poly || poly.length < 3) return PD_TURRET_RING;
  const dx = Math.cos(angle), dy = Math.sin(angle);
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const A = poly[i], B = poly[(i + 1) % poly.length];
    const ex = B[0] - A[0], ey = B[1] - A[1];
    const det = ex * dy - dx * ey;
    if (Math.abs(det) < 1e-9) continue;          // ray parallel to edge
    const t = (ex * A[1] - A[0] * ey) / det;     // distance along ray
    const u = (dx * A[1] - A[0] * dy) / det;     // param along segment
    if (t > 1e-4 && u >= -1e-6 && u <= 1 + 1e-6 && t < best) best = t;
  }
  return best === Infinity ? PD_TURRET_RING : best;
}

// Seat PD turret `i` of `n` ON the hull EDGE, fully inside the silhouette.
// Turrets are distributed evenly by PERIMETER arc-length (so they ride
// the actual outline, following sponsons + steps), then each is inset
// from its edge along that edge's INWARD normal by the turret radius — so
// the disc is tangent to the real hull boundary from the inside and never
// pokes out, even on concave hulls. Half-step offset keeps turrets on
// edge spans rather than landing on vertices. Returns unit-hull {x, y};
// the SINGLE SOURCE OF TRUTH for the module disc (damage routing + turret
// art) and the firing origin (ship.js#pdTurretOffset reads the module).
export function pdTurretLocalOffset(poly, i, n, turretR) {
  return pdSeatAtFraction(poly, (i + 0.5) / n, turretR);
}

// Seat a turret at perimeter arc-fraction `frac` (0..1). Factored out of
// pdTurretLocalOffset so the PD placer can NUDGE a turret forward along the
// rim (advancing the fraction) when its even-spacing slot lands on top of a
// fixed module (a shield generator, an engine nozzle) — collision-avoided
// seating without abandoning the ride-the-outline scheme.
export function pdSeatAtFraction(poly, frac, turretR) {
  const N = poly.length;
  // Perimeter + per-segment lengths.
  let total = 0;
  const seg = new Array(N);
  for (let k = 0; k < N; k++) {
    const A = poly[k], B = poly[(k + 1) % N];
    seg[k] = Math.hypot(B[0] - A[0], B[1] - A[1]);
    total += seg[k];
  }
  let target = ((frac % 1) + 1) % 1 * total;
  for (let k = 0; k < N; k++) {
    if (target <= seg[k] || k === N - 1) {
      const A = poly[k], B = poly[(k + 1) % N];
      const t = seg[k] > 1e-9 ? target / seg[k] : 0;
      const px = A[0] + (B[0] - A[0]) * t;
      const py = A[1] + (B[1] - A[1]) * t;
      // Inward edge normal. All hull polygons are CCW, so (-dy, dx) is
      // always the inward normal — no centroid-direction flip needed.
      // The old flip based on dot(normal, -edgePoint) was wrong for
      // concave edges: it reversed the correct inward direction on reflex
      // notches, pushing those turrets outside the hull.
      let nx = -(B[1] - A[1]), ny = (B[0] - A[0]);
      const L = Math.hypot(nx, ny) || 1;
      nx /= L; ny /= L;
      // Inset by MORE than the disc radius: the visible turret art draws
      // rotating barrels that reach ~1.15× the disc radius from centre
      // (see drawPdArt), so seating the disc edge exactly on the boundary
      // still let the barrels sweep outside. 1.25× tucks the whole turret
      // — base + swinging barrels — inside the silhouette while the barrel
      // tips still kiss the rim, so PD reads as edge-mounted, not floating
      // off the hull.
      const inset = turretR * 1.25;
      return { x: px + nx * inset, y: py + ny * inset };
    }
    target -= seg[k];
  }
  return { x: 0, y: 0 };
}

// Per-class blueprint of NON-PD modules. PD is generated per-turret
// dynamically in buildModules.
const LAYOUTS = {
  fighter: [
    // Single nose-mounted gun. Disabling it silences the fighter's
    // forward cannon AND its missile launcher (treated as a single
    // bow armament compartment).
    { name: "gun",               offset: { x:  0.66, y:  0.00 }, radius: 0.32, hp:  16, hullPenalty:  8,
      requires: (s) => !!s.weapon && s.firingMode === "forward" },
    { name: "shield-generator",  offset: { x: -0.20, y:  0.00 }, radius: 0.20, hp:  14, hullPenalty:  6,
      requires: (s) => !!s.shield },
  ],
  bomber: [
    { name: "gun",               offset: { x:  0.72, y:  0.00 }, radius: 0.22, hp:  30, hullPenalty: 12,
      requires: (s) => !!s.weapon && s.firingMode === "forward" },
    { name: "missile-bay",       offset: { x: -0.05, y:  0.00 }, radius: 0.30, hp:  80, hullPenalty: 35,
      requires: (s) => !!s.missilePods },
    { name: "shield-generator",  offset: { x: -0.35, y:  0.00 }, radius: 0.22, hp:  50, hullPenalty: 22,
      requires: (s) => !!s.shield },
  ],
  frigate: [
    { name: "gun-array",         offset: { x:  0.40, y:  0.00 }, radius: 0.22, hp: 100, hullPenalty: 45,
      requires: (s) => !!s.ringCannons },
    { name: "missile-bay",       offset: { x: -0.30, y:  0.00 }, radius: 0.22, hp:  80, hullPenalty: 35,
      requires: (s) => !!s.missilePods },
    { name: "shield-generator-port", offset: { x: -0.10, y: -0.25 }, radius: 0.18, hp:  70, hullPenalty: 30,
      requires: (s) => !!s.shield },
    { name: "shield-generator-stbd", offset: { x: -0.10, y:  0.25 }, radius: 0.18, hp:  70, hullPenalty: 30,
      requires: (s) => !!s.shield },
  ],
  cruiser: [
    { name: "cannon",            offset: { x:  0.62, y:  0.00 }, radius: 0.22, hp: 200, hullPenalty: 80,
      requires: (s) => !!s.weapon && s.firingMode === "forward" },
    { name: "missile-bay",       offset: { x: -0.05, y:  0.00 }, radius: 0.26, hp: 140, hullPenalty: 70,
      requires: (s) => !!s.missilePods },
    { name: "shield-generator-port", offset: { x: -0.10, y: -0.30 }, radius: 0.20, hp: 130, hullPenalty: 55,
      requires: (s) => !!s.shield },
    { name: "shield-generator-stbd", offset: { x: -0.10, y:  0.30 }, radius: 0.20, hp: 130, hullPenalty: 55,
      requires: (s) => !!s.shield },
  ],
  battleship: [
    // Laser bays. Fore bay always present when the BB carries a beam
    // (single or array). Aft bay only appears when the design has 2+
    // beam groups equipped (Heavy Laser + Particle Cannon, or two of
    // either) so single-laser race-default BBs read identical to today.
    { name: "laser",             offset: { x:  0.72, y:  0.00 }, radius: 0.30, hp: 220, hullPenalty: 100,
      requires: (s) => !!s.heavyLaser && !(Array.isArray(s.heavyLaser) && s.heavyLaser.length >= 2) },
    { name: "laser-fore",        offset: { x:  0.55, y:  0.00 }, radius: 0.22, hp: 200, hullPenalty:  90,
      requires: (s) => Array.isArray(s.heavyLaser) && s.heavyLaser.length >= 2 },
    { name: "laser-aft",         offset: { x: -0.20, y:  0.00 }, radius: 0.20, hp: 200, hullPenalty:  90,
      requires: (s) => Array.isArray(s.heavyLaser) && s.heavyLaser.length >= 2 },
    { name: "missile-fwd",       offset: { x:  0.15, y:  0.00 }, radius: 0.27, hp: 160, hullPenalty:  80,
      requires: (s) => !!s.missilePods },
    { name: "missile-aft",       offset: { x: -0.45, y:  0.00 }, radius: 0.25, hp: 160, hullPenalty:  80,
      requires: (s) => !!s.missilePods },
    // Torpedo tubes — one per flank, forward section.
    { name: "torpedo-tube-port", offset: { x:  0.30, y: -0.45 }, radius: 0.22, hp: 140, hullPenalty: 60,
      requires: (s) => !!s.torpedoes },
    { name: "torpedo-tube-stbd", offset: { x:  0.30, y:  0.45 }, radius: 0.22, hp: 140, hullPenalty: 60,
      requires: (s) => !!s.torpedoes },
    // Shield generators — midships, inside the broadside batteries.
    { name: "shield-generator-port", offset: { x: -0.15, y: -0.42 }, radius: 0.22, hp: 180, hullPenalty: 80,
      requires: (s) => !!s.shield },
    { name: "shield-generator-stbd", offset: { x: -0.15, y:  0.42 }, radius: 0.22, hp: 180, hullPenalty: 80,
      requires: (s) => !!s.shield },
    // Three individual broadside cannons per side. Positioned to match the
    // muzzle-spread spacing (muzzleSpread=70, radius=156 → ±0.45 frac).
    // Each cannon is its own damageable module — losing one reduces output
    // on that flank without silencing the whole battery.
    { name: "broadside-port-0", offset: { x: -0.55, y: -0.70 }, radius: 0.22, hp: 70, hullPenalty: 35,
      requires: (s) => s.firingMode === "broadside" },
    { name: "broadside-port-1", offset: { x: -0.10, y: -0.70 }, radius: 0.22, hp: 70, hullPenalty: 35,
      requires: (s) => s.firingMode === "broadside" },
    { name: "broadside-port-2", offset: { x:  0.35, y: -0.70 }, radius: 0.22, hp: 70, hullPenalty: 35,
      requires: (s) => s.firingMode === "broadside" },
    { name: "broadside-stbd-0", offset: { x: -0.55, y:  0.70 }, radius: 0.22, hp: 70, hullPenalty: 35,
      requires: (s) => s.firingMode === "broadside" },
    { name: "broadside-stbd-1", offset: { x: -0.10, y:  0.70 }, radius: 0.22, hp: 70, hullPenalty: 35,
      requires: (s) => s.firingMode === "broadside" },
    { name: "broadside-stbd-2", offset: { x:  0.35, y:  0.70 }, radius: 0.22, hp: 70, hullPenalty: 35,
      requires: (s) => s.firingMode === "broadside" },
  ],
  carrier: [
    { name: "hangar",            offset: { x:  0.00, y:  0.00 }, radius: 0.34, hp: 300, hullPenalty: 150,
      requires: (s) => !!s.replenish },
    // Thren carrier (and any future carrier with a forward weapon).
    // Buff pass: cannon HP ×3 (280→840, hullPenalty 110→330) — the main
    // gun is meant to be tanky, surviving focus-fire to keep landing its
    // (now ×4 damage) rounds.
    { name: "cannon",            offset: { x:  0.74, y:  0.00 }, radius: 0.22, hp: 840, hullPenalty: 330,
      requires: (s) => !!s.weapon && s.firingMode === "forward" },
    { name: "missile-bay-fore",  offset: { x: -0.40, y:  0.30 }, radius: 0.22, hp: 220, hullPenalty: 90,
      requires: (s) => !!s.missilePods },
    { name: "missile-bay-aft",   offset: { x: -0.40, y: -0.30 }, radius: 0.22, hp: 220, hullPenalty: 90,
      requires: (s) => Array.isArray(s.missilePods) && s.missilePods.length >= 2 },
    { name: "shield-generator-port", offset: { x: -0.25, y: -0.32 }, radius: 0.22, hp: 200, hullPenalty: 90,
      requires: (s) => !!s.shield },
    { name: "shield-generator-stbd", offset: { x: -0.25, y:  0.32 }, radius: 0.22, hp: 200, hullPenalty: 90,
      requires: (s) => !!s.shield },
  ],
  station: [
    { name: "laser",             offset: { x:  0.45, y:  0.00 }, radius: 0.28, hp: 260, hullPenalty: 110,
      requires: (s) => !!s.heavyLaser },
    { name: "missile-bay",       offset: { x: -0.45, y:  0.00 }, radius: 0.26, hp: 200, hullPenalty:  85,
      requires: (s) => !!s.missilePods },
    { name: "shield-generator-port", offset: { x: -0.10, y: -0.35 }, radius: 0.22, hp: 240, hullPenalty: 100,
      requires: (s) => !!s.shield },
    { name: "shield-generator-stbd", offset: { x: -0.10, y:  0.35 }, radius: 0.22, hp: 240, hullPenalty: 100,
      requires: (s) => !!s.shield },
  ],
};

export const MODULES = LAYOUTS;

let _layoutAuditDone = false;
export function auditModuleLayout() {
  if (_layoutAuditDone) return;
  _layoutAuditDone = true;
  if (!(typeof import.meta !== "undefined" && import.meta.env && import.meta.env.DEV)) return;
  for (const klass of Object.keys(LAYOUTS)) {
    const mods = LAYOUTS[klass];
    for (let i = 0; i < mods.length; i++) {
      for (let j = i + 1; j < mods.length; j++) {
        const a = mods[i], b = mods[j];
        const dx = a.offset.x - b.offset.x;
        const dy = a.offset.y - b.offset.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const limit = 0.75 * (a.radius + b.radius);
        if (dist < limit) {
          console.warn(
            "[modules] overlap on " + klass + ": " + a.name + " <-> " + b.name +
            "  dist=" + dist.toFixed(3) + " limit=" + limit.toFixed(3)
          );
        }
      }
    }
  }
}
auditModuleLayout();

// Clone the template into per-ship runtime state at spawn. Iterates the
// per-class blueprint, includes only entries whose `requires` predicate
// matches the resolved spec, then appends one PD module per turret (at
// the turret's ring position) and one engine module per visible plume.
export function buildModules(klass, spec, poly = null, defaultArmor = 0) {
  const tmpl = LAYOUTS[klass] || [];
  const rScale = moduleRadiusScale(klass);
  const out = [];
  // Per-module armor (0..1 damage reduction). Inherited from the class
  // armor passed by createShip (which itself comes from FACTION_CELL_STATS
  // — heavier ships get tougher modules). A LAYOUTS entry can override
  // via `m.armor` for a specific super-hardened bay if needed.
  for (const m of tmpl) {
    if (m.requires && !m.requires(spec || {})) continue;
    out.push({
      name: m.name,
      offset: { x: m.offset.x, y: m.offset.y },
      radius: m.radius * rScale,
      hp: m.hp,
      hpMax: m.hp,
      armor: typeof m.armor === "number" ? m.armor : defaultArmor,
      hullPenalty: m.hullPenalty,
      disabled: false,
      flash: 0,
    });
  }
  // Engine modules FIRST (one per visible plume) so the PD placer below can
  // see + avoid them. Engines pulled inboard off the rim (×0.86) so the PD
  // perimeter ring isn't forced to share the stern with the nozzles.
  const engineCount = ENGINES[klass] || 0;
  const engineStats = ENGINE_MODULE[klass];
  if (engineCount > 0 && engineStats) {
    const ex = (ENGINE_X[klass] || -0.9) * 0.86;
    const spread = 1.05 * 0.78;
    const radius = (ENGINE_RADIUS[klass] || 0.15) * rScale;
    for (let i = 0; i < engineCount; i++) {
      const ey = engineCount === 1
        ? 0
        : ((i / (engineCount - 1)) - 0.5) * spread;
      out.push({
        name: "engine-" + i,
        offset: { x: ex, y: ey },
        radius,
        hp: engineStats.hp,
        hpMax: engineStats.hp,
        armor: defaultArmor,
        hullPenalty: engineStats.hullPenalty,
        disabled: false,
        flash: 0,
      });
    }
  }
  // Per-turret PD modules LAST, as MIRROR PAIRS about the long axis so the
  // point-defence screen reads symmetric port↔starboard. Half the turrets
  // are seated along the TOP half of the hull perimeter; each gets a twin
  // reflected to the bottom (same x, opposite y). An odd count puts the last
  // turret on the centreline at the bow. Final spacing/collision-avoidance
  // is done symmetrically by snapModulesSymmetric in createShip — here we
  // only emit symmetric starting positions (|y| clamped off-axis so the
  // pairing there never mistakes a near-centre turret for a lone one).
  if (spec && spec.pdCannons) {
    const stats = PD_TURRET_MODULE[klass] || PD_TURRET_MODULE.battleship;
    const n = spec.pdCannons.count;
    const pdR = stats.radius * rScale;
    const pairs = Math.floor(n / 2);
    let idx = 0;
    const emit = (x, y) => out.push({
      name: "pd-" + (idx++),
      offset: { x, y },
      radius: pdR,
      hp: stats.hp, hpMax: stats.hp,
      armor: defaultArmor,
      hullPenalty: stats.hullPenalty,
      disabled: false, flash: 0,
    });
    for (let i = 0; i < pairs; i++) {
      // Even arc fraction across the top half (0..0.5), avoiding the very
      // bow/stern tips where a mirror twin would collapse onto the axis.
      const frac = 0.04 + ((i + 0.5) / pairs) * 0.42;
      const off = poly
        ? pdSeatAtFraction(poly, frac, stats.radius)
        : { x: Math.cos(frac * Math.PI * 2) * PD_TURRET_RING,
            y: Math.sin(frac * Math.PI * 2) * PD_TURRET_RING };
      const py = Math.max(Math.abs(off.y), pdR + 0.04);   // keep clearly off-axis
      emit(off.x, py);
      emit(off.x, -py);
    }
    if (n % 2 === 1) {
      // Odd turret → bow centreline.
      const off = poly ? pdSeatAtFraction(poly, 0, stats.radius) : { x: PD_TURRET_RING, y: 0 };
      emit(off.x, 0);
    }
  }
  return out.length > 0 ? out : null;
}

// PD turret index → module name. With per-turret PD modules, every
// turret has its own dedicated module, so the mapping is 1:1.
export function pdTurretToModuleName(_klass, i, _n) {
  return "pd-" + i;
}

// Missile pod index → module name. Front half of pods → forward bay,
// rear half → aft bay (battleship). Cruisers route everything to the
// single torpedo bay; bomber/frigate/station to "missile-bay". This is
// the SINGLE-GROUP path; createShip uses a different routing for
// multi-group capital designs (each group → its own bay) and only
// falls back to this helper for legacy single-group loadouts.
export function podToModuleName(klass, i, n) {
  if (klass === "battleship") return i < Math.ceil(n / 2) ? "missile-fwd" : "missile-aft";
  if (klass === "cruiser")    return "torpedo-bay";
  if (klass === "bomber")     return "missile-bay";
  if (klass === "frigate")    return "missile-bay";
  if (klass === "carrier")    return "missile-bay-fore";   // legacy: single group → fore
  if (klass === "station")    return "missile-bay";
  return null;
}

// Forward-cannon module name per class — gating point for the
// fireForward path in ship.js. Returns null for classes that have no
// gun module (carriers, stations, and anything that fires via a
// non-forward mode).
export function forwardGunModuleName(klass) {
  if (klass === "fighter") return "gun";
  if (klass === "bomber")  return "gun";
  if (klass === "cruiser") return "cannon";
  // Thren carrier mounts a cruiser-grade bow cannon — same gating
  // module name. Other carriers don't carry a `cannon` module so the
  // moduleByName lookup safely returns undefined → gate is no-op.
  if (klass === "carrier") return "cannon";
  return null;
}

// World point (wx, wy) → ship-local frame (un-rotated by ship.heading).
export function worldToLocal(ship, wx, wy) {
  const dx = wx - ship.pos.x;
  const dy = wy - ship.pos.y;
  const c = Math.cos(-ship.heading);
  const s = Math.sin(-ship.heading);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

// Module's world-space center.
export function moduleWorldPos(ship, name) {
  const m = ship.moduleByName && ship.moduleByName[name];
  if (!m) return null;
  const R = ship.spec.radius;
  const lx = m.offset.x * R;
  const ly = m.offset.y * R;
  const c = Math.cos(ship.heading);
  const s = Math.sin(ship.heading);
  return {
    x: ship.pos.x + lx * c - ly * s,
    y: ship.pos.y + lx * s + ly * c,
  };
}

const HIT_INFLATE = 1.20;

export function findHitModuleLocal(ship, lx, ly) {
  if (!ship.modules) return null;
  const R = ship.spec.radius;
  let best = null, bestD2 = Infinity;
  for (const m of ship.modules) {
    if (m.disabled) continue;
    const mx = m.offset.x * R;
    const my = m.offset.y * R;
    const mr = m.radius * R * HIT_INFLATE;
    const dx = lx - mx, dy = ly - my;
    const d2 = dx * dx + dy * dy;
    if (d2 <= mr * mr && d2 < bestD2) {
      best = m; bestD2 = d2;
    }
  }
  return best;
}

export function findSplashModulesLocal(ship, lx, ly, blastWorld) {
  if (!ship.modules) return [];
  const R = ship.spec.radius;
  const out = [];
  for (const m of ship.modules) {
    if (m.disabled) continue;
    const mx = m.offset.x * R;
    const my = m.offset.y * R;
    const reach = m.radius * R * HIT_INFLATE + blastWorld;
    const dx = lx - mx, dy = ly - my;
    if (dx * dx + dy * dy <= reach * reach) out.push(m);
  }
  return out;
}

export function pickBomberAimModule(target) {
  const m = pickAimModule(target);
  return m ? m.name : null;
}

// Generic module-priority picker used by AI cannon aim. PD → broadside
// → primary gun → missile launchers → laser → hangar. PD comes first
// because destroying the screen materially changes the engagement;
// primary guns next because silencing them shortens the fight.
const AIM_PRIORITY = [
  "pd-",
  "broadside-",
  "cannon",
  "gun-array",
  "gun",
  "missile-",
  "missile-bay",
  "torpedo-bay",
  "laser",
  "hangar",
];
// Per-class aim priority override. Small craft (fighter, bomber) put
// engine FIRST — disabling the engine forces a surrender via the
// engine-only threshold in ship.js#updateShip (engineThreshold 0.5
// with 1 engine = any loss trips it). AI focusing the engine on small
// craft yields more captures / clean kills instead of stray hits.
const AIM_PRIORITY_BY_KLASS = {
  fighter: ["engine-", "gun", "missile-"],
  bomber:  ["engine-", "missile-", "gun", "pd-"],
};
export function pickAimModule(target) {
  if (!target || !target.modules) return null;
  const klassOrder = AIM_PRIORITY_BY_KLASS[target.klass];
  const order = klassOrder || AIM_PRIORITY;
  for (const prefix of order) {
    for (const m of target.modules) {
      if (m.disabled) continue;
      if (m.name === prefix || m.name.startsWith(prefix)) return m;
    }
  }
  // Fall back to the generic priority if a class-specific priority
  // missed (e.g. fighter with no engine module — shouldn't happen
  // but defensive).
  if (klassOrder) {
    for (const prefix of AIM_PRIORITY) {
      for (const m of target.modules) {
        if (m.disabled) continue;
        if (m.name === prefix || m.name.startsWith(prefix)) return m;
      }
    }
  }
  return null;
}

// Categorise a module name for the surrender check. OFFENSIVE includes
// primary cannons / broadside / lasers / missile bays / torpedoes.
// PD turrets are excluded — there are 10+ on a BB and they're support
// systems, not the primary armament. ENGINE is anything starting with
// "engine-". Hangar is its own thing (carriers).
function isOffensiveModule(name) {
  if (!name) return false;
  if (name === "gun") return true;
  if (name === "gun-array") return true;
  if (name === "cannon") return true;
  if (name.startsWith("broadside-")) return true;
  if (name.startsWith("laser")) return true;     // laser, laser-fore, laser-aft
  if (name.startsWith("missile-")) return true;  // missile-bay, missile-fwd, missile-aft, missile-bay-fore/aft
  if (name === "torpedo-bay") return true;
  if (name === "torpedo-tube-port" || name === "torpedo-tube-stbd") return true;
  return false;
}
function isEngineModule(name) {
  return !!(name && name.startsWith("engine-"));
}

/**
 * Survey a ship's module damage state for the surrender system. Returns
 * `{ weaponLoss, engineLoss }` as fractions in [0, 1]. Ships without
 * modules (small craft) return zeros — they're excluded from surrender
 * by the spec.surrender presence check upstream.
 */
export function moduleLossSurvey(ship) {
  if (!ship || !ship.modules || ship.modules.length === 0) {
    return { weaponLoss: 0, engineLoss: 0, weaponTotal: 0, engineTotal: 0 };
  }
  let weaponTotal = 0, weaponDisabled = 0;
  let engineTotal = 0, engineDisabled = 0;
  for (const m of ship.modules) {
    if (isOffensiveModule(m.name)) {
      weaponTotal++;
      if (m.disabled) weaponDisabled++;
    } else if (isEngineModule(m.name)) {
      engineTotal++;
      if (m.disabled) engineDisabled++;
    }
  }
  return {
    weaponLoss: weaponTotal ? weaponDisabled / weaponTotal : 0,
    engineLoss: engineTotal ? engineDisabled / engineTotal : 0,
    weaponTotal, engineTotal,
  };
}

export function moduleOffsetWorld(ship, module) {
  if (!ship || !module) return null;
  const R = ship.spec.radius;
  const lx = module.offset.x * R;
  const ly = module.offset.y * R;
  const c = Math.cos(ship.heading);
  const s = Math.sin(ship.heading);
  return {
    x: ship.pos.x + lx * c - ly * s,
    y: ship.pos.y + lx * s + ly * c,
  };
}
