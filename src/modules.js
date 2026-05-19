// Capital-ship destructible subsystems.
//
// Battleships, carriers, and cruisers carry a list of modules — each
// one a turret cluster, broadside battery, missile bay, hangar, or
// heavy-laser mount. Modules have their own HP and a position on the
// ship's local frame. Targeted damage that lands on a module's disc
// drains that module's HP independently of the central hull. When a
// module reaches 0 HP it becomes permanently `disabled` and drains its
// `hullPenalty` from the ship's central HP in one shot — so stripping
// modules accelerates the kill rather than replacing it.
//
// Offsets and radii are normalized to spec.radius (same convention as
// hull polygons): offset.x of 0.7 means 70% of the ship's radius along
// its forward axis.

export const MODULES = {
  battleship: [
    { name: "laser",          offset: { x:  0.70, y:  0.00 }, radius: 0.22, hp: 220, hullPenalty: 100 },
    { name: "missile-fwd",    offset: { x:  0.20, y:  0.00 }, radius: 0.20, hp: 160, hullPenalty: 80  },
    { name: "missile-aft",    offset: { x: -0.40, y:  0.00 }, radius: 0.20, hp: 160, hullPenalty: 80  },
    { name: "broadside-port", offset: { x: -0.10, y: -0.70 }, radius: 0.24, hp: 200, hullPenalty: 100 },
    { name: "broadside-stbd", offset: { x: -0.10, y:  0.70 }, radius: 0.24, hp: 200, hullPenalty: 100 },
    { name: "pd-bow",         offset: { x:  0.50, y:  0.40 }, radius: 0.22, hp: 120, hullPenalty: 50  },
    { name: "pd-stern",       offset: { x: -0.55, y:  0.40 }, radius: 0.22, hp: 120, hullPenalty: 50  },
  ],
  carrier: [
    { name: "hangar",         offset: { x:  0.00, y:  0.00 }, radius: 0.32, hp: 300, hullPenalty: 150 },
    { name: "pd-port",        offset: { x:  0.10, y: -0.55 }, radius: 0.26, hp: 140, hullPenalty: 60  },
    { name: "pd-stbd",        offset: { x:  0.10, y:  0.55 }, radius: 0.26, hp: 140, hullPenalty: 60  },
  ],
  cruiser: [
    { name: "broadside-port", offset: { x: -0.10, y: -0.65 }, radius: 0.22, hp: 150, hullPenalty: 70 },
    { name: "broadside-stbd", offset: { x: -0.10, y:  0.65 }, radius: 0.22, hp: 150, hullPenalty: 70 },
    { name: "torpedo-bay",    offset: { x:  0.25, y:  0.00 }, radius: 0.20, hp: 140, hullPenalty: 70 },
    { name: "pd-cluster",     offset: { x: -0.55, y:  0.00 }, radius: 0.25, hp: 100, hullPenalty: 50 },
  ],
};

// Clone the template into per-ship runtime state at spawn.
export function buildModules(klass) {
  const tmpl = MODULES[klass];
  if (!tmpl) return null;
  return tmpl.map((m) => ({
    name: m.name,
    offset: { x: m.offset.x, y: m.offset.y },
    radius: m.radius,
    hp: m.hp,
    hpMax: m.hp,
    hullPenalty: m.hullPenalty,
    disabled: false,
    flash: 0, // visual hit-flash; decays each frame
  }));
}

// PD turret index → module name. PD turrets sit on a ring around the
// hull at angle (i/n)*2π; we group them by quadrant.
export function pdTurretToModuleName(klass, i, n) {
  const a = (i / n) * Math.PI * 2;
  if (klass === "battleship") return Math.cos(a) >= 0 ? "pd-bow"  : "pd-stern";
  if (klass === "carrier")    return Math.sin(a) >= 0 ? "pd-stbd" : "pd-port";
  if (klass === "cruiser")    return "pd-cluster";
  return null;
}

// Missile pod index → module name. Front half of pods → forward bay,
// rear half → aft bay (battleship). Cruisers route everything to the
// single torpedo bay.
export function podToModuleName(klass, i, n) {
  if (klass === "battleship") return i < Math.ceil(n / 2) ? "missile-fwd" : "missile-aft";
  if (klass === "cruiser")    return "torpedo-bay";
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

// Module's world-space center (offset rotated by ship.heading). Returns
// null only if the module doesn't exist on this ship — disabled modules
// still have a position so VFX spawners can keep emitting smoke / fire
// from the crater.
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

// Closest alive module whose disc contains a ship-local point.
export function findHitModuleLocal(ship, lx, ly) {
  if (!ship.modules) return null;
  const R = ship.spec.radius;
  let best = null, bestD2 = Infinity;
  for (const m of ship.modules) {
    if (m.disabled) continue;
    const mx = m.offset.x * R;
    const my = m.offset.y * R;
    const mr = m.radius * R;
    const dx = lx - mx, dy = ly - my;
    const d2 = dx * dx + dy * dy;
    if (d2 <= mr * mr && d2 < bestD2) {
      best = m; bestD2 = d2;
    }
  }
  return best;
}

// All alive modules within `blastWorld` world-units of a ship-local hit
// point. Used to spread missile splash damage across adjacent modules.
export function findSplashModulesLocal(ship, lx, ly, blastWorld) {
  if (!ship.modules) return [];
  const R = ship.spec.radius;
  const out = [];
  for (const m of ship.modules) {
    if (m.disabled) continue;
    const mx = m.offset.x * R;
    const my = m.offset.y * R;
    const reach = m.radius * R + blastWorld;
    const dx = lx - mx, dy = ly - my;
    if (dx * dx + dy * dy <= reach * reach) out.push(m);
  }
  return out;
}

// Bomber AI: pick which module to home a missile at on a capital. Order
// of preference: PD first (clear the screen), then missiles, then
// broadsides, then anything else still alive. Returns module name or
// null if target has no modules / all dead.
export function pickBomberAimModule(target) {
  if (!target || !target.modules) return null;
  const order = ["pd-", "broadside-", "missile-", "torpedo-bay", "laser", "hangar"];
  for (const prefix of order) {
    for (const m of target.modules) {
      if (m.disabled) continue;
      if (m.name === prefix || m.name.startsWith(prefix)) return m.name;
    }
  }
  return null;
}
