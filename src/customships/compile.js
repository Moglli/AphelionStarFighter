/**
 * @file compileCustomShip — lowers a free-form customShip doc into the engine's
 * existing createShip shape so the whole fire/render/AI/damage pipeline runs
 * unchanged.
 *
 * Output:
 *   { klass, race, specOverride, moduleList, cellOverride,
 *     design: { hullPoly, paintPrimary, paintTrim }, heading }
 *
 * Spawn it with:
 *   createShip({ klass, race, side, pos, heading, controller,
 *                specOverride, moduleList, cellOverride, design })
 *
 * Design rules (load-bearing — see ship.js / classes.js):
 *  - resolveSpec(race, "mothership") returns {} (no base class), so specOverride
 *    must be a COMPLETE, self-contained spec — every movement + weapon field.
 *  - createShip deep-merges specOverride onto the resolved base. To stop a base
 *    class's weapon systems leaking onto a custom ship that didn't place them,
 *    every weapon-system key is set explicitly — to the authored object or to
 *    `null` (deepMerge: a null mods value REPLACES the base). Weapon sub-fields
 *    (salvo/capacity/cluster/...) are likewise always present so a base sub-key
 *    can't survive the merge.
 *  - All specOverride objects are FRESH literals built here (spec-poison guard,
 *    CLAUDE.md "Spec mutation hazard") — never references into a shared spec.
 *  - createShip calls applyDesign(spec, design); our design has no `hull` field
 *    so applyDesign early-returns (no-op) — it only carries hullPoly + paint.
 *
 * Headless-safe: only pulls buildCustomModules from modules.js (which is itself
 * import-safe in node — its sprites.js DOM use is function-local).
 */

import { buildCustomModules } from "../modules.js";
import { scaledCellGrid } from "../sprites.js";

// Tier → base hull radius (px, at scaleMul 1) + movement profile. Radii mirror
// classes.js so a non-scaled custom ship matches its tier's footprint; the new
// "mothership" tier is a super-capital (bigger + slower than a carrier).
const TIER_BASE = {
  fighter:    { radius: 24,  maxSpeed: 400, accel: 700, drag: 0.985, turnRate: 3.2,  color: "#9cf" },
  bomber:     { radius: 28,  maxSpeed: 220, accel: 350, drag: 0.985, turnRate: 1.6,  color: "#cdf" },
  frigate:    { radius: 62,  maxSpeed: 150, accel: 220, drag: 0.99,  turnRate: 1.0,  color: "#bdf" },
  cruiser:    { radius: 106, maxSpeed: 80,  accel: 130, drag: 0.992, turnRate: 0.4,  color: "#aaf" },
  battleship: { radius: 184, maxSpeed: 35,  accel: 50,  drag: 0.994, turnRate: 0.15, color: "#88f" },
  carrier:    { radius: 208, maxSpeed: 45,  accel: 60,  drag: 0.994, turnRate: 0.18, color: "#9bf" },
  // turnRate is the HULL slew (not movement — station is maxSpeed 0). Bumped
  // from a near-frozen 0.06 to 0.6 so a station-tier ship used as a defence
  // STRUCTURE can actually traverse to bring forward guns / broadside flanks
  // onto a shifting threat axis (PD turrets + ring mounts aim independently of
  // the hull, so they never needed it; forward/broadside do). ~5s per 180°.
  station:    { radius: 80,  maxSpeed: 0,   accel: 0,   drag: 1,     turnRate: 0.6,  color: "#9bf" },
  mothership: { radius: 360, maxSpeed: 28,  accel: 40,  drag: 0.995, turnRate: 0.10, color: "#8af" },
};

export const TIER_BASE_RADIUS = Object.fromEntries(
  Object.keys(TIER_BASE).map((t) => [t, TIER_BASE[t].radius]),
);

const DEFAULT_BOLT_COLORS = { blue: "#7df", red: "#fb8" };
const DEFAULT_MISSILE_COLORS = { blue: "#9cf", red: "#fa6" };
const DEFAULT_BEAM_COLORS = { blue: "#9ef", red: "#fc7" };

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function num(v, d) { return typeof v === "number" && isFinite(v) ? v : d; }

// Cooldown from either explicit `cooldown` or a `rofPerSec` rate.
function cooldownOf(stats, dflt) {
  if (typeof stats.cooldown === "number" && stats.cooldown > 0) return stats.cooldown;
  if (typeof stats.rofPerSec === "number" && stats.rofPerSec > 0) return 1 / stats.rofPerSec;
  return dflt;
}

// A single bolt color → a {blue,red} pair the engine indexes by ship.side.
function boltColors(projectile, fallback) {
  const c = projectile && typeof projectile.color === "string" ? projectile.color : null;
  return c ? { blue: c, red: c } : { ...fallback };
}
function projRadius(projectile, dflt) {
  return projectile && typeof projectile.size === "number" ? projectile.size : dflt;
}

// Build a COMPLETE forward/broadside weapon spec (every sub-key present so a
// base class's weapon sub-fields can't leak through deepMerge).
function makeWeaponSpec(m, firingMode) {
  const s = m.stats || {};
  const p = m.projectile;
  return {
    firingMode,
    damage: Math.max(0.01, num(s.damage, 5)),
    cooldown: cooldownOf(s, 0.4),
    projectileSpeed: num(s.projectileSpeed, 700),
    range: num(s.range, 600),
    spread: num(s.spread, 0.05),
    muzzles: Math.max(1, Math.round(num(s.muzzles, 1))),
    muzzleSpread: num(s.muzzleSpread, 0),
    projectileRadius: projRadius(p, 3),
    projectileColors: boltColors(p, DEFAULT_BOLT_COLORS),
    // Forward-mount firing arc (half-angle). Only forward guns read spec.arc in
    // the fire path (fireForwardWeapon); broadsides use spec.broadsideArc and
    // ignore this. null → no arc gate (fires straight ahead like a stock gun).
    arc: (firingMode === "forward" && typeof m.arc === "number") ? m.arc : null,
    // Explicit nulls — without these a battleship-tier base could leak salvo /
    // magazine onto an authored single-shot gun via deepMerge.
    salvo: null,
    capacity: null,
    reloadTime: null,
  };
}

export function compileCustomShip(design) {
  const tier = TIER_BASE[design.tier] ? design.tier : "fighter";
  const base = TIER_BASE[tier];
  const scaleMul = clamp(num(design.scaleMul, 1), 0.4, 3.0);
  const radius = Math.max(8, base.radius * scaleMul);

  const modules = Array.isArray(design.modules) ? design.modules : [];
  const byType = (t) => modules.filter((m) => m && m.type === t);

  // ---- Primary weapons (forward + broadside → ship.weapons[]) ----
  // Each forward gun is an INDEPENDENT mount → its own weapon entry (a BB with
  // two bow cannons fires both on separate cooldowns). All broadside modules,
  // by contrast, are ONE battery → a SINGLE broadside weapon entry: the fire
  // path reads every live broadside-* module for muzzle origins, so one weapon
  // per module would loose the whole battery N times per tick (double-fire).
  const forwardMods = byType("forwardGun");
  const broadsideMods = byType("broadside");
  const weaponSpecs = [];
  for (const m of forwardMods) weaponSpecs.push(makeWeaponSpec(m, "forward"));
  if (broadsideMods.length) weaponSpecs.push(makeWeaponSpec(broadsideMods[0], "broadside"));
  const primaryWeapon = weaponSpecs.length ? weaponSpecs[0] : null;
  const weaponExtras = weaponSpecs.length > 1 ? weaponSpecs.slice(1) : null;

  // ---- Ring cannons (independent subsystem) ----
  const ringMods = byType("ring");
  let ringCannons = null;
  if (ringMods.length) {
    const s = ringMods[0].stats || {};
    const p = ringMods[0].projectile;
    ringCannons = {
      count: ringMods.length,
      damage: Math.max(0.01, num(s.damage, 5)),
      cooldown: cooldownOf(s, 0.5),
      projectileSpeed: num(s.projectileSpeed, 680),
      range: num(s.range, 560),
      arc: num(ringMods[0].arc, Math.PI / 4),
      projectileRadius: projRadius(p, 2.2),
      projectileColors: boltColors(p, DEFAULT_BOLT_COLORS),
    };
  }

  // ---- Heavy lasers (scalar for one, array for many) ----
  const laserMods = byType("heavyLaser");
  const laserGroups = laserMods.map((m) => {
    const s = m.stats || {};
    return {
      damage: Math.max(0.01, num(s.damage, 22)),
      cooldown: cooldownOf(s, 3.0),
      range: num(s.range, 820),
      arc: num(m.arc, Math.PI / 5),
      beamDuration: num(s.beamDuration, 2.5),
      beamColors: (m.projectile && typeof m.projectile.color === "string")
        ? { blue: m.projectile.color, red: m.projectile.color }
        : { ...DEFAULT_BEAM_COLORS },
    };
  });
  const heavyLaser = laserGroups.length === 0 ? null : (laserGroups.length === 1 ? laserGroups[0] : laserGroups);

  // ---- Missile pods (scalar for one group, array for many) ----
  const podMods = byType("missilePod");
  const podGroups = podMods.map((m) => {
    const s = m.stats || {};
    const p = m.projectile;
    return {
      count: Math.max(1, Math.round(num(s.count, 1))),
      damage: Math.max(0.01, num(s.damage, 30)),
      cooldown: cooldownOf(s, 4.0),
      projectileSpeed: num(s.projectileSpeed, 320),
      range: num(s.range, 1100),
      ttl: num(s.ttl, num(s.range, 1100) / num(s.projectileSpeed, 320) + 1),
      turnRate: num(s.turnRate, 2.0),
      hp: Math.max(1, Math.round(num(s.hp, 3))),
      radius: num(s.radius, 6),
      acquireRange: num(s.acquireRange, num(s.range, 1100) + 400),
      bypassShield: true,
      blastRadius: num(s.blastRadius, 24),
      colors: (p && typeof p.color === "string") ? { blue: p.color, red: p.color } : { ...DEFAULT_MISSILE_COLORS },
      cluster: null,
    };
  });
  const missilePods = podGroups.length === 0 ? null : (podGroups.length === 1 ? podGroups[0] : podGroups);

  // ---- Point defence ----
  const pdMods = byType("pd");
  let pdCannons = null;
  if (pdMods.length) {
    const s = pdMods[0].stats || {};
    const p = pdMods[0].projectile;
    pdCannons = {
      count: pdMods.length,
      damage: Math.max(0.01, num(s.damage, 2)),
      cooldown: cooldownOf(s, 0.18),
      projectileSpeed: num(s.projectileSpeed, 900),
      range: num(s.range, 280),
      projectileRadius: projRadius(p, 1.6),
      projectileColors: boltColors(p, { blue: "#cef", red: "#fda" }),
    };
  }

  // ---- Hangar / replenishment ----
  const hangarMods = byType("hangar");
  let replenish = null;
  if (hangarMods.length) {
    const s = hangarMods[0].stats || {};
    replenish = { fighter: num(s.fighter, 18), bomber: num(s.bomber, 36) };
  }

  // ---- Shield (pool from doc; generators scale it at runtime) ----
  const shieldMods = byType("shieldGenerator");
  let shield = null;
  if (design.shield != null || shieldMods.length) {
    let max = num(design.shield, 0);
    if (!max) for (const m of shieldMods) max += num(m.stats && m.stats.shieldMax, 0);
    if (max > 0) {
      const s0 = (shieldMods[0] && shieldMods[0].stats) || {};
      shield = { max, regen: num(s0.regen, 12), regenDelay: num(s0.regenDelay, 4) };
    }
  }

  // ---- firingMode (root stance — AI/render/turret-init read this) ----
  let firingMode = "none";
  if (forwardMods.length) firingMode = "forward";
  else if (broadsideMods.length) firingMode = "broadside";
  else if (ringMods.length) firingMode = "ring";

  // Complete, self-contained spec. Every weapon system is set explicitly (object
  // or null) so nothing from the tier's base class survives unintentionally.
  const specOverride = {
    hp: Math.max(1, num(design.hp, 100)),
    radius,
    maxSpeed: base.maxSpeed,
    accel: base.accel,
    drag: base.drag,
    turnRate: base.turnRate,
    color: base.color,
    firingMode,
    weapon: primaryWeapon,
    weaponExtras,
    ringCannons,
    heavyLaser,
    missilePods,
    pdCannons,
    replenish,
    shield,
    // Systems with no editor module type — null so a base class (e.g. the
    // battleship's torpedoes / fighter's intercept missile) can't leak through.
    missile: null,
    torpedoes: null,
    armor: null,
  };
  if (firingMode === "broadside" || broadsideMods.length) {
    const arc = num(broadsideMods[0] && broadsideMods[0].arc, (25 * Math.PI) / 180);
    specOverride.broadsideArc = arc;
    specOverride.broadsideTraverse = 1.4;
  }

  // ---- Runtime modules (authored placements → engine module names) ----
  const moduleList = buildCustomModules(design, specOverride, design.hullPoly);

  // ---- Cell toughness + scale-aware grid ----
  // `grid` scales the tier's base cell grid by scaleMul so block SIZE stays
  // constant as the hull scales (a 2× ship gets 2× blocks, same size — not
  // 2×-bigger blocks). The editor preview uses the same scaledCellGrid, so what
  // you author matches what you fly.
  const cellOverride = {
    cellHp: num(design.cellHp, 14),
    cellArmor: clamp(num(design.cellArmor, 0.1), 0, 0.95),
    overrides: (design.cellOverrides && typeof design.cellOverrides === "object") ? design.cellOverrides : {},
    grid: scaledCellGrid(tier, scaleMul, design.race || "terran"),
  };

  // ---- Spawn heading: nose points OPPOSITE the engine centroid ----
  let heading = 0;
  const engineMods = byType("engine");
  if (design.derivedHeadingFromEngines !== false && engineMods.length) {
    let cx = 0, cy = 0;
    for (const m of engineMods) { cx += (m.offset && m.offset.x) || 0; cy += (m.offset && m.offset.y) || 0; }
    cx /= engineMods.length; cy /= engineMods.length;
    if (cx !== 0 || cy !== 0) heading = Math.atan2(-cy, -cx);
  }

  return {
    klass: tier,
    race: design.race || "terran",
    specOverride,
    moduleList,
    cellOverride,
    design: {
      hullPoly: design.hullPoly,
      paintPrimary: design.paintPrimary || null,
      paintTrim: design.paintTrim || null,
    },
    heading,
  };
}
