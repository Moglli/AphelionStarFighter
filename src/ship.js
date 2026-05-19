import { SIDES } from "./classes.js";
import { resolveSpec, RACES } from "./races.js";
import * as V from "./vec.js";
import { createProjectile, createMissile } from "./projectile.js";
import { events } from "./events.js";
import { buildCells } from "./sprites.js";
import { resolveSpec, deepMerge } from "./races.js";
import * as V from "./vec.js";
import { createProjectile, createMissile } from "./projectile.js";
import { getSprite, ENGINES, ENGINE_X } from "./sprites.js";
import {
  buildModules, pdTurretToModuleName, podToModuleName, pickBomberAimModule,
} from "./modules.js";

let nextId = 1;

// Hull polygons per [race][klass]. Vertices are scaled by ship.spec.radius
// at draw time. Each race has its own visual language:
//   Terran   — utilitarian: triangles, trapezoids, hexagons.
//   Reavers  — angular, asymmetric, predatory spikes.
//   Hegemony — blocky, slabby, armored rectangles.
//   Voidsworn — sleek crescents and swept-wing curves.
const HULLS = {
  terran: {
    fighter:    [[1.0, 0], [-0.7, 0.8], [-0.4, 0], [-0.7, -0.8]],
    bomber:     [[1.0, 0], [0.3, 0.55], [-0.4, 0.95], [-0.85, 0.55], [-0.6, 0],
                 [-0.85, -0.55], [-0.4, -0.95], [0.3, -0.55]],
    frigate:    [[1.0, 0], [0.3, 0.7], [-0.9, 0.6], [-0.9, -0.6], [0.3, -0.7]],
    cruiser:    [[1.0, 0], [0.5, 0.8], [-0.6, 0.9], [-1.0, 0.4],
                 [-1.0, -0.4], [-0.6, -0.9], [0.5, -0.8]],
    battleship: [[1.0, 0], [0.7, 0.6], [-0.2, 0.7], [-0.4, 0.95], [-1.0, 0.7],
                 [-1.0, -0.7], [-0.4, -0.95], [-0.2, -0.7], [0.7, -0.6]],
    carrier:    [[1.0, 0.32], [0.55, 0.55], [-0.85, 0.6], [-1.0, 0.4],
                 [-1.0, -0.4], [-0.85, -0.6], [0.55, -0.55], [1.0, -0.32]],
    // Hexagonal modular bunker — reads as a starbase segment.
    station:    [[1.0, 0.0], [0.5, 0.85], [-0.5, 0.85], [-1.0, 0.0],
                 [-0.5, -0.85], [0.5, -0.85]],
  },
  reavers: {
    // Hooked dart with re-entrant tail.
    fighter:    [[1.0, 0], [-0.2, 0.35], [-0.55, 0.9], [-0.4, 0.3], [-0.2, 0],
                 [-0.4, -0.3], [-0.55, -0.9], [-0.2, -0.35]],
    // Scorpion carapace with claw stubs.
    bomber:     [[1.0, 0], [0.5, 0.4], [0.1, 0.9], [-0.5, 0.95], [-0.7, 0.5],
                 [-0.45, 0], [-0.7, -0.5], [-0.5, -0.95], [0.1, -0.9], [0.5, -0.4]],
    // Pincer profile — twin claws at the rear.
    frigate:    [[1.0, 0], [0.5, 0.5], [0.2, 0.85], [-0.3, 0.65], [-0.9, 0.55],
                 [-0.7, 0.2], [-0.55, 0], [-0.7, -0.2], [-0.9, -0.55],
                 [-0.3, -0.65], [0.2, -0.85], [0.5, -0.5]],
    // Wedge with side blades.
    cruiser:    [[1.0, 0], [0.7, 0.4], [0.2, 0.9], [-0.4, 0.95], [-0.85, 0.5],
                 [-0.65, 0.18], [-1.0, 0], [-0.65, -0.18], [-0.85, -0.5],
                 [-0.4, -0.95], [0.2, -0.9], [0.7, -0.4]],
    // Spiked dreadnought — multiple swept facets.
    battleship: [[1.0, 0], [0.85, 0.38], [0.5, 0.85], [0.0, 0.7], [-0.4, 0.95],
                 [-0.8, 0.55], [-1.0, 0.2], [-0.85, 0], [-1.0, -0.2],
                 [-0.8, -0.55], [-0.4, -0.95], [0.0, -0.7], [0.5, -0.85], [0.85, -0.38]],
    // Long predator hull with hangars.
    carrier:    [[1.0, 0.3], [0.6, 0.45], [0.1, 0.7], [-0.4, 0.65], [-0.9, 0.55],
                 [-1.0, 0.35], [-1.0, -0.35], [-0.9, -0.55], [-0.4, -0.65],
                 [0.1, -0.7], [0.6, -0.45], [1.0, -0.3]],
    // 8-point spiked star — bristling carapace.
    station:    [[1.0, 0.0], [0.45, 0.45], [0.0, 1.0], [-0.45, 0.45],
                 [-1.0, 0.0], [-0.45, -0.45], [0.0, -1.0], [0.45, -0.45]],
  },
  hegemony: {
    // Armored gunship — chamfered slab.
    fighter:    [[1.0, 0], [0.7, 0.6], [-0.3, 0.85], [-0.75, 0.6],
                 [-0.75, -0.6], [-0.3, -0.85], [0.7, -0.6]],
    // Fat brick with bomb bays.
    bomber:     [[1.0, 0.4], [0.7, 0.8], [-0.6, 0.85], [-1.0, 0.5],
                 [-1.0, -0.5], [-0.6, -0.85], [0.7, -0.8], [1.0, -0.4]],
    // Rectangular hull with side turrets.
    frigate:    [[1.0, 0.3], [0.8, 0.6], [-0.85, 0.6], [-0.95, 0.3],
                 [-0.95, -0.3], [-0.85, -0.6], [0.8, -0.6], [1.0, -0.3]],
    // Blocky wedge with thick aft.
    cruiser:    [[1.0, 0], [0.85, 0.5], [0.4, 0.9], [-0.7, 0.9], [-1.0, 0.5],
                 [-1.0, -0.5], [-0.7, -0.9], [0.4, -0.9], [0.85, -0.5]],
    // Massive brick with deep ridges.
    battleship: [[1.0, 0.4], [0.9, 0.7], [0.4, 0.9], [-0.5, 0.95], [-0.9, 0.7],
                 [-1.0, 0.4], [-1.0, -0.4], [-0.9, -0.7], [-0.5, -0.95],
                 [0.4, -0.9], [0.9, -0.7], [1.0, -0.4]],
    // Huge cube with internal hangars.
    carrier:    [[1.0, 0.35], [0.9, 0.55], [0.3, 0.6], [-0.9, 0.6], [-1.0, 0.4],
                 [-1.0, -0.4], [-0.9, -0.6], [0.3, -0.6], [0.9, -0.55], [1.0, -0.35]],
    // Chamfered square fortress block — armored slab.
    station:    [[1.0, 0.6], [0.6, 1.0], [-0.6, 1.0], [-1.0, 0.6],
                 [-1.0, -0.6], [-0.6, -1.0], [0.6, -1.0], [1.0, -0.6]],
  },
  voidsworn: {
    // Needle with swept wings.
    fighter:    [[1.0, 0], [0.4, 0.25], [-0.3, 0.75], [-0.7, 0.5],
                 [-0.5, 0], [-0.7, -0.5], [-0.3, -0.75], [0.4, -0.25]],
    // Crescent body with energy emitters.
    bomber:     [[1.0, 0], [0.7, 0.5], [-0.2, 0.95], [-0.8, 0.7], [-0.6, 0.3],
                 [-0.4, 0], [-0.6, -0.3], [-0.8, -0.7], [-0.2, -0.95], [0.7, -0.5]],
    // Elegant arrowhead.
    frigate:    [[1.0, 0], [0.5, 0.55], [-0.6, 0.7], [-0.95, 0.4], [-0.7, 0],
                 [-0.95, -0.4], [-0.6, -0.7], [0.5, -0.55]],
    // Graceful curve.
    cruiser:    [[1.0, 0], [0.6, 0.7], [-0.3, 0.95], [-0.9, 0.65], [-0.95, 0.3],
                 [-0.7, 0], [-0.95, -0.3], [-0.9, -0.65], [-0.3, -0.95], [0.6, -0.7]],
    // Swept-wing dreadnought.
    battleship: [[1.0, 0], [0.85, 0.4], [0.3, 0.85], [-0.6, 0.95], [-0.95, 0.5],
                 [-1.0, 0], [-0.95, -0.5], [-0.6, -0.95], [0.3, -0.85], [0.85, -0.4]],
    // Long crescent with central spine.
    carrier:    [[1.0, 0.25], [0.7, 0.55], [-0.4, 0.7], [-0.95, 0.55], [-1.0, 0.3],
                 [-0.8, 0], [-1.0, -0.3], [-0.95, -0.55], [-0.4, -0.7], [0.7, -0.55],
                 [1.0, -0.25]],
    // Rune-cut hexagon — clean outer hex with bevelled inner mouths.
    station:    [[1.0, 0.0], [0.7, 0.5], [0.35, 0.5], [0.0, 1.0],
                 [-0.35, 0.5], [-0.7, 0.5], [-1.0, 0.0], [-0.7, -0.5],
                 [-0.35, -0.5], [0.0, -1.0], [0.35, -0.5], [0.7, -0.5]],
  },
};

export function getHull(race, klass) {
  return (HULLS[race] && HULLS[race][klass]) || HULLS.terran[klass];
}

// ---------------------------------------------------------------------------
// Subsystem nodes — destructible weapon/engine emplacements that sit on the
// hull. A projectile hit can route into a subsystem instead of straight to
// hull HP; subsystems absorb damage up to their pool, and overflow falls
// through to hull. Destroying a node disables the corresponding behavior
// (engine kills propulsion; gun/missile/laser kill the matching weapon).
//
// `kind` is one of: "gun" | "engine" | "missile" | "laser".
//   - gun:     forward / broadside cannons.
//   - engine:  primary propulsion. Capitals stop dead; aircraft drift.
//   - missile: missile-pod launchers (capital) or fighter missile rack.
//   - laser:   heavy battleship beam emitter.
//
// Layout coords are in unit hull space ([-1, 1] roughly), same as HULLS.
// `hpFrac` is the fraction of ship.hpMax that the node soaks before dying.
// `r` is the local hit-radius in unit hull space.
// ---------------------------------------------------------------------------
const SUBSYSTEM_LAYOUTS = {
  fighter: [
    { kind: "engine", x: -0.55, y:  0.00, r: 0.30, hpFrac: 0.30 },
    { kind: "gun",    x:  0.55, y:  0.00, r: 0.28, hpFrac: 0.25 },
  ],
  bomber: [
    { kind: "engine",  x: -0.65, y:  0.00, r: 0.30, hpFrac: 0.30 },
    { kind: "missile", x:  0.25, y:  0.00, r: 0.30, hpFrac: 0.30 },
  ],
  frigate: [
    { kind: "engine", x: -0.75, y:  0.00, r: 0.30, hpFrac: 0.35 },
    { kind: "gun",    x:  0.55, y:  0.00, r: 0.28, hpFrac: 0.30 },
  ],
  cruiser: [
    { kind: "engine",  x: -0.80, y:  0.00, r: 0.30, hpFrac: 0.35 },
    // Bow laser turret replaces the old forward gun.
    { kind: "laser",   x:  0.65, y:  0.00, r: 0.22, hpFrac: 0.25 },
    { kind: "missile", x: -0.20, y:  0.55, r: 0.22, hpFrac: 0.20 },
    { kind: "missile", x: -0.20, y: -0.55, r: 0.22, hpFrac: 0.20 },
  ],
  battleship: [
    { kind: "engine",  x: -0.85, y:  0.00, r: 0.28, hpFrac: 0.35 },
    { kind: "laser",   x:  0.85, y:  0.00, r: 0.22, hpFrac: 0.30 },
    { kind: "gun",     x: -0.20, y:  0.65, r: 0.20, hpFrac: 0.20 },
    { kind: "gun",     x: -0.20, y: -0.65, r: 0.20, hpFrac: 0.20 },
    { kind: "missile", x:  0.25, y:  0.55, r: 0.18, hpFrac: 0.15 },
    { kind: "missile", x:  0.25, y: -0.55, r: 0.18, hpFrac: 0.15 },
  ],
  carrier: [
    { kind: "engine", x: -0.85, y:  0.00, r: 0.30, hpFrac: 0.35 },
  ],
};

export function createSubsystems(klass, hpMax) {
  const layout = SUBSYSTEM_LAYOUTS[klass];
  if (!layout) return [];
  return layout.map((n) => {
    const hp = Math.max(8, Math.round(n.hpFrac * hpMax));
    return {
      kind: n.kind,
      x: n.x,
      y: n.y,
      r: n.r,
      hp,
      hpMax: hp,
      destroyed: false,
      flash: 0,  // visual: brief brighten after a hit
    };
  });
}

// Restore all subsystems to full health. Called when the player ship
// is recycled by promotePlayer so respawn doesn't inherit prior damage.
export function resetSubsystems(ship) {
  if (!ship.subsystems) return;
  for (const node of ship.subsystems) {
    node.hp = node.hpMax;
    node.destroyed = false;
    node.flash = 0;
  }
}

// True if the ship has any subsystem of the given kind (working or not).
// Used by the renderer to suppress legacy decorations whose position
// would collide with the destructible node visual.
function shipHasSubsystem(ship, kind) {
  if (!ship.subsystems) return false;
  for (const node of ship.subsystems) {
    if (node.kind === kind) return true;
  }
  return false;
}

// True if the ship has at least one working subsystem of the given kind
// (or if no subsystems of that kind are defined for this class, so the
// behavior should remain enabled by default).
export function hasWorkingSubsystem(ship, kind) {
  if (!ship.subsystems || ship.subsystems.length === 0) return true;
  let foundAny = false;
  for (const node of ship.subsystems) {
    if (node.kind !== kind) continue;
    foundAny = true;
    if (!node.destroyed) return true;
  }
  return !foundAny;
}

// Find the closest non-destroyed subsystem whose hit-radius contains the
// given world-space hit point. Returns null if no node is in range.
// Hit-radius is in WORLD units (node.r * ship.spec.radius), so big nodes
// on big hulls are easier to land on.
export function findHitSubsystem(ship, hitPos) {
  if (!ship.subsystems || ship.subsystems.length === 0) return null;
  // Rotate hit point into ship-local space.
  const dx = hitPos.x - ship.pos.x;
  const dy = hitPos.y - ship.pos.y;
  const ca = Math.cos(-ship.heading);
  const sa = Math.sin(-ship.heading);
  const lx = dx * ca - dy * sa;
  const ly = dx * sa + dy * ca;
  const r = ship.spec.radius;
  let best = null;
  let bestD2 = Infinity;
  for (const node of ship.subsystems) {
    if (node.destroyed) continue;
    const nx = node.x * r;
    const ny = node.y * r;
    const nr = node.r * r;
    const ddx = lx - nx;
    const ddy = ly - ny;
    const d2 = ddx * ddx + ddy * ddy;
    if (d2 <= nr * nr && d2 < bestD2) {
      bestD2 = d2;
      best = node;
    }
  }
  return best;
}

export function createShip({ klass, race = "terran", side, pos, heading = 0, controller }) {
  const spec = resolveSpec(race, klass);
export { HULLS };

export function createShip({ klass, race = "terran", side, pos, heading = 0, controller, specOverride = null }) {
  let spec = resolveSpec(race, klass);
  if (specOverride) spec = deepMerge(spec, specOverride);
  const ship = {
    id: nextId++,
    klass,
    race,
    side,
    spec,
    pos: { ...pos },
    vel: { x: 0, y: 0 },
    heading,
    hp: spec.hp,
    hpMax: spec.hp,
    cooldown: 0,           // forward firing
    cooldownPort: 0,       // broadside: left side
    cooldownStarboard: 0,  // broadside: right side
    controller, // mutable: { thrust, aim, firing, firingMissile }
    dead: false,
    isPlayer: false,
    // Shield (always present; 0 if class has no shield spec).
    shield: spec.shield ? spec.shield.max : 0,
    shieldMax: spec.shield ? spec.shield.max : 0,
    shieldHitTimer: 0, // counts up since last hit; regen kicks in past regenDelay
    shieldFlash: 0,    // visual: brief brighten when hit
    // Armor plating (big ships only). Never regenerates. Sits between
    // shield and hull and absorbs damage at spec.armor.wearRate.
    armor: spec.armor ? spec.armor.max : 0,
    armorMax: spec.armor ? spec.armor.max : 0,
    armorFlash: 0,     // visual: brief flash when armor takes a hit
    // Persistent battle damage marks, painted on top of the hull sprite.
    // Each entry: { lx, ly, size, kind: "armor-flake" | "hull-hole", seed }.
    // Positions are in ship-local (world units), so they rotate with the
    // ship. Sustained fire on the same spot grows an existing scar instead
    // of stacking new ones (see addImpactScar in game.js).
    scars: [],
    // Missile state (single-shot weapons like the fighter's missile).
    missileCd: 0,
    aiMissileCd: 0,
    // PD turret cooldowns (one per turret).
    pdCooldowns: spec.pdCannons ? new Array(spec.pdCannons.count).fill(0) : null,
    // Missile pod cooldowns.
    podCooldowns: spec.missilePods ? new Array(spec.missilePods.count).fill(0) : null,
    // Siege missile cooldowns (one entry per launcher). Same plumbing as
    // podCooldowns but for the cruiser's single heavy mass-driver.
    siegeCooldowns: spec.siegeMissile ? new Array(spec.siegeMissile.count).fill(0) : null,
    // Heavy laser cooldown.
    laserCd: 0,
    // Cannon magazine (only used when spec.weapon.capacity is set).
    weaponAmmo: spec.weapon && spec.weapon.capacity ? spec.weapon.capacity : 0,
    weaponReloading: false,
    weaponReloadTimer: 0,
    // Carrier replenishment cadence — counts down to the next launch.
    fighterLaunchCd: spec.replenish ? spec.replenish.fighter : 0,
    bomberLaunchCd: spec.replenish ? spec.replenish.bomber : 0,
    // Destructible subsystem nodes (PD turrets, missile pods, heavy laser).
    // Built from the spec — each entry has a local hull offset, its own
    // hp pool, and a `dead` flag. Hit detection in game.js checks these
    // before the hull, and fire updates skip dead modules.
    modules: buildModules(spec),
    // Visible scorch / crater decals at ship-local positions, recorded
    // every time the hull or armor takes a hit. Capped to keep render
    // cost predictable on long-lived capitals.
    damageMarks: [],
    // Whole-ship flash on hit — peaks at 1, decays in updateShip. Painted
    // as a white wash over the hull silhouette in drawShip.
    hitFlash: 0,
    // Drifting smoke/fire particles emitted from damaged hulls. Each
    // puff carries its own local position, velocity, age, ttl, and kind
    // ("smoke" | "ember"). Aged in updateShip and culled when expired.
    puffs: [],
    // Time accumulator for the "smoldering" emitter — heavily damaged
    // ships passively belch a smoke puff every PUFF_INTERVAL seconds.
    puffCd: 0,
    // Short-lived sparks (module hits, big explosions). Same shape as
    // puffs but drawn brighter and shorter ttl.
    sparks: [],
    // Persistent fires — anchored at hull breach points. Each fire has
    // its own ttl and keeps belching smoke and embers as it burns. Spawned
    // when a cell is destroyed; rendered as a flickering orange plume.
    fires: [],
    // Pixel-cell sprite: an array of small destructible squares that
    // make up the visible silhouette. Each cell can be hit and removed
    // independently, so the ship literally "chews" away during combat
    // long before its hp pool runs out.
    sprite: buildCells(klass),
    // Destructible weapon/engine nodes on the hull. See SUBSYSTEM_LAYOUTS.
    subsystems: createSubsystems(klass, spec.hp),
  };
  // Bind module-mount cells to the actual destructible module instances
  // so dropping a PD/pod/laser module also drops its mount cell.
  if (ship.sprite && ship.modules) {
    bindModuleCells(ship);
    // Capital subsystem modules: nullable list of destructible parts.
    // Populated for battleship / carrier / cruiser; other classes stay null
    // and route damage straight to hull as before.
    modules: buildModules(klass),
    moduleByName: null,
    pdTurretModules: null,
    podModules: null,
  };
  if (ship.modules) {
    ship.moduleByName = {};
    for (const m of ship.modules) ship.moduleByName[m.name] = m;
    // Pre-compute per-turret and per-pod module lookups so subsystem
    // updates don't have to map angles → modules every tick.
    if (spec.pdCannons) {
      const n = spec.pdCannons.count;
      ship.pdTurretModules = new Array(n);
      for (let i = 0; i < n; i++) {
        ship.pdTurretModules[i] = pdTurretToModuleName(klass, i, n);
      }
    }
    if (spec.missilePods) {
      const n = spec.missilePods.count;
      ship.podModules = new Array(n);
      for (let i = 0; i < n; i++) {
        ship.podModules[i] = podToModuleName(klass, i, n);
      }
    }
  }
  return ship;
}

// Pair each module-mount cell with its module by kind + index. After
// this, a dead module zaps its mount cell and a destroyed mount cell
// kills the module — they share the same fate.
function bindModuleCells(ship) {
  for (const cell of ship.sprite.cells) {
    if (!cell.moduleKind) continue;
    const m = ship.modules.find(
      (mod) => mod.kind === cell.moduleKind && mod.index === cell.moduleIndex,
    );
    if (m) cell.module = m;
  }
}

// Cap on persistent damage decals per ship. Once exceeded, the oldest
// mark is dropped — keeps draw work bounded and prevents visual mush.
const MAX_DAMAGE_MARKS = 24;

// Convert a world-space hit point to ship-local coordinates and append
// a decal. Called from game.js's damage path so any hit that erodes
// armor or hull leaves a visible scar.
export function recordDamageMark(ship, worldX, worldY, layer, amount) {
  if (!ship.damageMarks) ship.damageMarks = [];
  const ca = Math.cos(-ship.heading), sa = Math.sin(-ship.heading);
  const dx = worldX - ship.pos.x;
  const dy = worldY - ship.pos.y;
  ship.damageMarks.push({
    lx: dx * ca - dy * sa,
    ly: dx * sa + dy * ca,
    layer, // "armor" or "hull"
    // Visual size scales with both the damage of the round and the size
    // of the hull, so a fighter cannon plinks a small dot on a battleship
    // while a torpedo carves a bigger crater.
    r: Math.max(3, Math.min(ship.spec.radius * 0.24, 3 + amount * 0.08)),
    age: 0,
  });
  if (ship.damageMarks.length > MAX_DAMAGE_MARKS) {
    ship.damageMarks.shift();
  }
}

function buildModules(spec) {
  const out = [];
  if (spec.pdCannons) {
    const n = spec.pdCannons.count;
    const r = spec.radius * 0.75;
    const hp = Math.max(10, Math.round(spec.radius * 0.4));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      out.push({
        kind: "pd", index: i,
        lx: Math.cos(a) * r, ly: Math.sin(a) * r,
        radius: Math.max(6, spec.radius * 0.09),
        hp, hpMax: hp, dead: false, flash: 0,
      });
    }
  }
  if (spec.missilePods) {
    const n = spec.missilePods.count;
    const hp = Math.max(20, Math.round(spec.radius * 0.6));
    for (let i = 0; i < n; i++) {
      const offset = (n === 1) ? 0 : ((i - (n - 1) / 2) * (spec.radius * 0.35));
      const sideSign = i % 2 === 0 ? 1 : -1;
      out.push({
        kind: "pod", index: i,
        lx: offset, ly: sideSign * spec.radius * 0.55,
        radius: Math.max(7, spec.radius * 0.1),
        hp, hpMax: hp, dead: false, flash: 0,
      });
    }
  }
  if (spec.heavyLaser) {
    const hp = Math.max(40, Math.round(spec.radius * 0.9));
    out.push({
      kind: "laser", index: 0,
      lx: spec.radius * 0.95, ly: 0,
      radius: Math.max(8, spec.radius * 0.11),
      hp, hpMax: hp, dead: false, flash: 0,
    });
  }
  return out;
}

function moduleDead(ship, kind, index) {
  if (!ship.modules) return false;
  for (const m of ship.modules) {
    if (m.kind === kind && m.index === index) return m.dead;
  }
  return false;
}

// Parse a #rgb / #rrggbb color string to a [r,g,b] triple.
function hexToRgb(hex) {
  if (!hex || hex[0] !== "#") return [255, 255, 255];
  if (hex.length === 4) {
    return [
      parseInt(hex[1] + hex[1], 16),
      parseInt(hex[2] + hex[2], 16),
      parseInt(hex[3] + hex[3], 16),
    ];
  }
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

// Mix the base hull color toward a charred dark-red as hp drops. A
// fully-healthy ship returns the original color; a near-dead one is
// dark and red-shifted so it reads as "wrecked" at a glance.
function damageTint(hex, hullFrac) {
  const [r, g, b] = hexToRgb(hex);
  // Damaged blend target: dark crimson (#3a0a08).
  const tr = 58, tg = 10, tb = 8;
  // Curve: keep the original color until ~80% hp, then ramp toward dark.
  const t = Math.max(0, Math.min(1, (0.8 - hullFrac) / 0.8));
  const nr = Math.round(r * (1 - t) + tr * t);
  const ng = Math.round(g * (1 - t) + tg * t);
  const nb = Math.round(b * (1 - t) + tb * t);
  return `rgb(${nr},${ng},${nb})`;
}

// Render queued smoke puffs in world space behind the ship. Puffs anchor
// to ship-local coords and ride the hull's rotation.
function drawPuffs(ctx, ship) {
  const ca = Math.cos(ship.heading), sa = Math.sin(ship.heading);
  for (const p of ship.puffs) {
    const wx = ship.pos.x + p.lx * ca - p.ly * sa;
    const wy = ship.pos.y + p.lx * sa + p.ly * ca;
    const t = p.age / p.ttl;
    const a = Math.max(0, 1 - t);
    // Smoke = grey/dim cloud that grows; ember = orange that fades fast.
    const radius = p.size * (1 + t * 2.6);
    ctx.save();
    if (p.kind === "ember") {
      ctx.globalAlpha = a * 0.9;
      const g = ctx.createRadialGradient(wx, wy, 0, wx, wy, radius);
      g.addColorStop(0, "rgba(255,200,90,0.9)");
      g.addColorStop(0.5, "rgba(220,90,30,0.55)");
      g.addColorStop(1, "rgba(40,8,4,0)");
      ctx.fillStyle = g;
    } else if (p.kind === "vent") {
      // Pressurised gas: bright white-cyan jet that expands fast and fades.
      // Distinct silhouette from soft grey smoke — reads as atmosphere
      // venting from a breach.
      ctx.globalAlpha = a * 0.75;
      const g = ctx.createRadialGradient(wx, wy, 0, wx, wy, radius);
      g.addColorStop(0, "rgba(235,250,255,0.95)");
      g.addColorStop(0.45, "rgba(170,210,235,0.55)");
      g.addColorStop(1, "rgba(120,150,180,0)");
      ctx.fillStyle = g;
    } else {
      ctx.globalAlpha = a * 0.55;
      const g = ctx.createRadialGradient(wx, wy, 0, wx, wy, radius);
      g.addColorStop(0, "rgba(70,55,50,0.85)");
      g.addColorStop(1, "rgba(30,20,20,0)");
      ctx.fillStyle = g;
    }
    ctx.beginPath();
    ctx.arc(wx, wy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// Render queued sparks in world space — bright tiny streaks oriented
// along velocity for a "shrapnel" feel.
function drawSparks(ctx, ship) {
  const ca = Math.cos(ship.heading), sa = Math.sin(ship.heading);
  for (const p of ship.sparks) {
    const wx = ship.pos.x + p.lx * ca - p.ly * sa;
    const wy = ship.pos.y + p.lx * sa + p.ly * ca;
    // Velocity in world space too — rotate the spark vector by heading.
    const vx = p.vx * ca - p.vy * sa;
    const vy = p.vx * sa + p.vy * ca;
    const t = p.age / p.ttl;
    const a = Math.max(0, 1 - t);
    const len = 4 + (1 - t) * 8;
    const speed = Math.hypot(vx, vy) || 1;
    const tailX = wx - (vx / speed) * len;
    const tailY = wy - (vy / speed) * len;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = `rgba(255,${Math.round(180 + 60 * a)},80,${0.85 * a})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(wx, wy);
    ctx.stroke();
    ctx.restore();
  }
}

// Tunables for the secondary damage FX. PUFF_INTERVAL controls how often
// a heavily damaged ship belches smoke; SPARK_LIFETIME and PUFF_LIFETIME
// bound how long each particle lingers. MAX_PARTICLES caps work per ship.
const PUFF_INTERVAL = 0.18;
const PUFF_LIFETIME = 1.6;
const SPARK_LIFETIME = 0.55;
const MAX_PARTICLES = 28;

// Push a smoke/ember/vent puff anchored to a ship-local point. Drifts
// outward with a small random velocity and fades out over its lifetime.
// Vent puffs use a tighter, faster jet so atmosphere escape reads
// distinct from smoldering smoke.
export function emitPuff(ship, lx, ly, kind = "smoke", dir = null) {
  if (!ship.puffs) ship.puffs = [];
  if (ship.puffs.length >= MAX_PARTICLES) ship.puffs.shift();
  const isVent = kind === "vent";
  // Vents shoot outward fast; smoke/embers drift slow.
  const speed = isVent
    ? 90 + Math.random() * 60
    : 18 + Math.random() * 22;
  let vx, vy;
  if (dir && (dir.x !== 0 || dir.y !== 0)) {
    // Bias along provided direction with mild spread.
    const baseA = Math.atan2(dir.y, dir.x);
    const spread = (Math.random() - 0.5) * (isVent ? 0.4 : 1.0);
    vx = Math.cos(baseA + spread) * speed;
    vy = Math.sin(baseA + spread) * speed;
  } else {
    const a = Math.random() * Math.PI * 2;
    vx = Math.cos(a) * speed;
    vy = Math.sin(a) * speed;
  }
  const ttl = isVent
    ? PUFF_LIFETIME * 0.35 * (0.7 + Math.random() * 0.6)
    : PUFF_LIFETIME * (0.7 + Math.random() * 0.6);
  ship.puffs.push({
    lx, ly,
    vx, vy,
    age: 0, ttl,
    size: isVent ? 3 + Math.random() * 3 : 4 + Math.random() * 4,
    kind,
  });
}

// Spark burst — emits N short-lived bright streaks from a hit location.
// Used for module destruction and other "snap" feedback moments.
export function emitSparks(ship, lx, ly, n = 6) {
  if (!ship.sparks) ship.sparks = [];
  for (let i = 0; i < n; i++) {
    if (ship.sparks.length >= MAX_PARTICLES * 2) ship.sparks.shift();
    const a = Math.random() * Math.PI * 2;
    const sp = 90 + Math.random() * 110;
    ship.sparks.push({
      lx, ly,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      age: 0, ttl: SPARK_LIFETIME * (0.6 + Math.random() * 0.7),
      size: 2 + Math.random() * 2,
    });
  }
}

// Max simultaneous fires per ship — caps draw + emission cost for
// heavily-damaged capitals that have taken many hull breaches.
const MAX_FIRES = 12;

// Spawn a persistent fire at the given ship-local point. Burns for
// FIRE_LIFETIME seconds, throwing off periodic embers + smoke while alive.
export function emitFire(ship, lx, ly, lifeMul = 1) {
  if (!ship.fires) ship.fires = [];
  if (ship.fires.length >= MAX_FIRES) ship.fires.shift();
  const life = (2.5 + Math.random() * 2.5) * lifeMul;
  ship.fires.push({
    lx, ly,
    age: 0, ttl: life, lifeMax: life,
    size: 5 + Math.random() * 3,
    emitCd: 0,
    // Per-fire phase offset so the cluster doesn't pulse in lockstep.
    phase: Math.random() * Math.PI * 2,
  });
}

// Render persistent fires anchored to the ship hull. Each fire is a
// flickering radial gradient with a brighter inner core; the radius is
// modulated by the fire's own phase so a cluster of fires reads as live
// flame, not static dots.
function drawFires(ctx, ship) {
  if (!ship.fires || ship.fires.length === 0) return;
  const ca = Math.cos(ship.heading), sa = Math.sin(ship.heading);
  const t = performance.now() / 1000;
  for (const f of ship.fires) {
    const wx = ship.pos.x + f.lx * ca - f.ly * sa;
    const wy = ship.pos.y + f.lx * sa + f.ly * ca;
    const fadeIn = Math.min(1, f.age / 0.25);
    const fadeOut = Math.min(1, (f.ttl - f.age) / 0.6);
    const life = Math.max(0, Math.min(1, Math.min(fadeIn, fadeOut)));
    const flick = 0.75 + 0.35 * Math.sin(t * 18 + f.phase)
                       + 0.18 * Math.sin(t * 31 + f.phase * 2.3);
    const r = f.size * flick;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.9 * life;
    const g = ctx.createRadialGradient(wx, wy, 0, wx, wy, r * 2.4);
    g.addColorStop(0,   "rgba(255,240,180,0.95)");
    g.addColorStop(0.3, "rgba(255,160,60,0.75)");
    g.addColorStop(0.7, "rgba(200,60,20,0.35)");
    g.addColorStop(1,   "rgba(60,10,4,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(wx, wy, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
    // Bright inner core
    ctx.globalAlpha = life;
    const gi = ctx.createRadialGradient(wx, wy, 0, wx, wy, r);
    gi.addColorStop(0, "rgba(255,255,235,0.95)");
    gi.addColorStop(1, "rgba(255,160,60,0)");
    ctx.fillStyle = gi;
    ctx.beginPath();
    ctx.arc(wx, wy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// Advance and cull all of a ship's transient FX particles. Called from
// updateShip each tick.
function tickParticles(ship, dt) {
  if (ship.puffs && ship.puffs.length > 0) {
    for (const p of ship.puffs) {
      p.age += dt;
      p.lx += p.vx * dt;
      p.ly += p.vy * dt;
      // Vent jets bleed momentum faster than smoke (gas dissipates),
      // smoke billows then slows.
      const drag = p.kind === "vent" ? 0.82 : 0.92;
      p.vx *= drag;
      p.vy *= drag;
    }
    ship.puffs = ship.puffs.filter((p) => p.age < p.ttl);
  }
  if (ship.sparks && ship.sparks.length > 0) {
    for (const p of ship.sparks) {
      p.age += dt;
      p.lx += p.vx * dt;
      p.ly += p.vy * dt;
      p.vx *= 0.88;
      p.vy *= 0.88;
    }
    ship.sparks = ship.sparks.filter((p) => p.age < p.ttl);
  }
  if (ship.fires && ship.fires.length > 0) {
    for (const f of ship.fires) {
      f.age += dt;
      f.emitCd -= dt;
      if (f.emitCd <= 0) {
        f.emitCd = 0.12 + Math.random() * 0.08;
        // Each fire keeps pushing out a thin trickle of smoke + ember
        // while alive, so the persistent flame reads as a live source
        // rather than a static decal.
        emitPuff(ship, f.lx + (Math.random() - 0.5) * 2,
                       f.ly + (Math.random() - 0.5) * 2, "smoke");
        if (Math.random() < 0.6) {
          emitPuff(ship, f.lx, f.ly, "ember");
        }
      }
    }
    ship.fires = ship.fires.filter((f) => f.age < f.ttl);
  }
}

// Destroy every cell whose center falls inside the given local-space
// radius. Returns the count of cells removed plus any modules that
// went down with them (so game.js can fire the matching events / FX).
// Also lights a fire at the breach center and emits a brief vent jet so
// the hit reads as a real puncture, not just missing pixels.
export function damageCellsInRadius(ship, lx, ly, radius) {
  if (!ship.sprite) return { count: 0, modulesDestroyed: [] };
  const r2 = radius * radius;
  let count = 0;
  const modulesDestroyed = [];
  const killed = [];
  for (const cell of ship.sprite.cells) {
    if (cell.dead) continue;
    if (cell.module && cell.module.dead) { cell.dead = true; continue; }
    const dx = cell.lx - lx;
    const dy = cell.ly - ly;
    if (dx * dx + dy * dy <= r2) {
      cell.dead = true;
      count++;
      killed.push(cell);
      if (cell.module && !cell.module.dead) {
        cell.module.dead = true;
        cell.module.hp = 0;
        modulesDestroyed.push(cell.module);
      }
    }
  }
  if (count > 0) {
    // One fire per breach (size-scaled chance so small plinks don't
    // litter the hull with flames). Anchor at the centroid of the
    // destroyed cluster so persistent fires line up with the visible hole.
    if (Math.random() < Math.min(0.9, 0.35 + count * 0.18)) {
      let cx = 0, cy = 0;
      for (const c of killed) { cx += c.lx; cy += c.ly; }
      cx /= killed.length; cy /= killed.length;
      emitFire(ship, cx, cy);
    }
    // Vent jet — bursts of pressurised gas escaping the new hole. A
    // couple of puffs angled outward from the ship center give the
    // breach a "blowing out" feel.
    const outX = lx, outY = ly;
    const outLen = Math.hypot(outX, outY) || 1;
    const dir = { x: outX / outLen, y: outY / outLen };
    const ventCount = 2 + Math.min(4, count);
    for (let i = 0; i < ventCount; i++) {
      emitPuff(ship, lx, ly, "vent", dir);
    }
  }
  return { count, modulesDestroyed };
}

// Connected-component analysis on the live cell grid. If the hull has
// been split into multiple disconnected pieces, every cell outside the
// largest piece is marked dead (along with any module bound to it).
// Returns { dropped, totalLive } where `dropped` is the count of cells
// shed in this call — game.js uses that to bill proportional hp damage
// and spawn the matching FX.
export function pruneDisconnectedCells(ship) {
  if (!ship.sprite) return { dropped: 0, totalLive: 0, droppedCells: [] };
  const live = [];
  for (const c of ship.sprite.cells) {
    if (c.dead) continue;
    if (c.module && c.module.dead) continue;
    live.push(c);
  }
  if (live.length === 0) return { dropped: 0, totalLive: 0, droppedCells: [] };

  // Index live cells by grid (row, col) so neighbor lookup is O(1).
  const map = new Map();
  const keyOf = (r, c) => r * 1024 + c;
  for (const c of live) map.set(keyOf(c.row, c.col), c);

  // Flood-fill from each unvisited cell to build components.
  const visited = new Set();
  const components = [];
  for (const seed of live) {
    const seedKey = keyOf(seed.row, seed.col);
    if (visited.has(seedKey)) continue;
    const comp = [];
    const queue = [seed];
    visited.add(seedKey);
    while (queue.length) {
      const cur = queue.pop();
      comp.push(cur);
      const neigh = [
        [cur.row - 1, cur.col],
        [cur.row + 1, cur.col],
        [cur.row, cur.col - 1],
        [cur.row, cur.col + 1],
      ];
      for (const [nr, nc] of neigh) {
        const nk = keyOf(nr, nc);
        const n = map.get(nk);
        if (n && !visited.has(nk)) {
          visited.add(nk);
          queue.push(n);
        }
      }
    }
    components.push(comp);
  }

  if (components.length <= 1) {
    return { dropped: 0, totalLive: live.length, droppedCells: [] };
  }

  // Keep the largest component; jettison everything else.
  let largest = components[0];
  for (const c of components) if (c.length > largest.length) largest = c;

  const droppedCells = [];
  for (const comp of components) {
    if (comp === largest) continue;
    for (const cell of comp) {
      cell.dead = true;
      droppedCells.push(cell);
      if (cell.module && !cell.module.dead) {
        cell.module.dead = true;
        cell.module.hp = 0;
      }
    }
  }
  return { dropped: droppedCells.length, totalLive: live.length, droppedCells };
}

// Multiply each RGB channel by `factor` (0..1) — used for darkening
// heavy-hull cells so structural plates read differently.
function darken(color, factor) {
  const m = /rgb\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/.exec(color);
  if (!m) return color;
  const r = Math.max(0, Math.min(255, Math.round(+m[1] * factor)));
  const g = Math.max(0, Math.min(255, Math.round(+m[2] * factor)));
  const b = Math.max(0, Math.min(255, Math.round(+m[3] * factor)));
  return `rgb(${r},${g},${b})`;
}

// Render every live cell of the sprite. Dead cells are skipped, so the
// silhouette literally shows the chunks that have been chewed away.
function drawSpriteCells(ctx, ship, tint, fill) {
  const sp = ship.sprite;
  const cs = sp.cellSize;
  const half = cs / 2;
  const heavyFill = darken(fill, 0.78);
  for (const cell of sp.cells) {
    if (cell.dead) continue;
    if (cell.module && cell.module.dead) continue;
    let color;
    switch (cell.kind) {
      case "hull": color = fill; break;
      case "hull_heavy": color = heavyFill; break;
      case "bridge": color = tint; break;
      case "engine": color = "#f96"; break;
      case "pd_mount":
      case "pod_mount":
      case "laser_mount": {
        const f = cell.module ? Math.min(1, cell.module.flash || 0) : 0;
        const ch = Math.round(220 + 35 * f);
        color = `rgb(${ch},${ch},${ch})`;
        break;
      }
      default: color = fill;
    }
    ctx.fillStyle = color;
    ctx.fillRect(cell.lx - half, cell.ly - half, cs, cs);
  }
}

// Outer radius of the shield bubble in world units. Must match the
// circle drawn in drawShip — fighters and bombers project a tight 6px
// shell while capitals project a much larger envelope. Used both to
// render and to compute the collision radius when shields are up so
// projectiles stop at the visible bubble instead of passing through to
// the hull.
export function shieldRadius(ship) {
  const r = ship.spec.radius;
  if (ship.klass === "fighter" || ship.klass === "bomber") {
    return r + 6;
  }
  return r * 1.35 + 18;
}

// World-space position of a module — applies ship rotation + position.
export function moduleWorldPos(ship, m) {
  const ca = Math.cos(ship.heading), sa = Math.sin(ship.heading);
  return {
    x: ship.pos.x + m.lx * ca - m.ly * sa,
    y: ship.pos.y + m.lx * sa + m.ly * ca,
  };
}

// ---------------------------------------------------------------------------
// Per-tick ship update.
// ---------------------------------------------------------------------------
export function updateShip(ship, dt, world) {
  const s = ship.spec;
  const c = ship.controller;

  // Combat ships use an aircraft flight model: velocity is locked to nose
  // direction at constant maxSpeed. They cannot strafe or snap-turn —
  // the only way to change direction is to bank (rotate heading), which
  // is turn-rate-limited. Capitals share this model with fighters/bombers
  // so the bigger hulls commit to a flight path and can't pivot in place.
  // Carriers are the one exception — they keep the older thrust model so
  // their "stay back and screen with PD" behavior still works.
  if (ship.klass !== "carrier") {
    ship.vel.x = Math.cos(ship.heading) * s.maxSpeed;
    ship.vel.y = Math.sin(ship.heading) * s.maxSpeed;
  // Engine module gating — each visible plume is its own targetable
  // module (engine-0 .. engine-N-1). Lose half your engines, fly at half
  // speed. Lose them all and the ship goes dead in the water (drifting
  // velocity exponentially decays).
  let aliveEngines = 0, totalEngines = 0;
  if (ship.modules) {
    for (const m of ship.modules) {
      if (m.name[0] === "e" && m.name.startsWith("engine")) {
        totalEngines++;
        if (!m.disabled) aliveEngines++;
      }
    }
  }
  const engineFrac = totalEngines > 0 ? aliveEngines / totalEngines : 1;
  const engineDead = totalEngines > 0 && aliveEngines === 0;
  const effMaxSpeed = s.maxSpeed * engineFrac;

  // Fighters and bombers use an aircraft flight model: velocity is locked
  // to nose direction at constant maxSpeed. They cannot strafe or
  // snap-turn — the only way to change direction is to bank (rotate
  // heading), which is turn-rate-limited.
  if (engineDead) {
    // Half-life ~0.45s — visibly drifts a beat, then stops.
    const decay = Math.exp(-1.5 * dt);
    ship.vel.x *= decay;
    ship.vel.y *= decay;
  } else if (ship.klass === "fighter" || ship.klass === "bomber") {
    ship.vel.x = Math.cos(ship.heading) * effMaxSpeed;
    ship.vel.y = Math.sin(ship.heading) * effMaxSpeed;
  } else if (c.thrust && (c.thrust.x !== 0 || c.thrust.y !== 0)) {
  // Subsystem gates — read once per tick so the rest of update can branch
  // cheaply. Ships without a subsystem of a kind treat it as "working".
  const engineOk = hasWorkingSubsystem(ship, "engine");
  const gunOk = hasWorkingSubsystem(ship, "gun");
  const missileOk = hasWorkingSubsystem(ship, "missile");
  const laserOk = hasWorkingSubsystem(ship, "laser");

  // Fighters and bombers use an aircraft flight model: velocity is locked
  // to nose direction at constant maxSpeed. They cannot strafe or
  // snap-turn — the only way to change direction is to bank (rotate
  // heading), which is turn-rate-limited. With engines blown, they coast
  // and slowly decay so a kill becomes inevitable.
  if (ship.klass === "fighter" || ship.klass === "bomber") {
    if (engineOk) {
      ship.vel.x = Math.cos(ship.heading) * s.maxSpeed;
      ship.vel.y = Math.sin(ship.heading) * s.maxSpeed;
    } else {
      // Drift with mild drag.
      ship.vel.x *= 0.995;
      ship.vel.y *= 0.995;
    }
  } else if (engineOk && c.thrust && (c.thrust.x !== 0 || c.thrust.y !== 0)) {
    const t = V.clampLen(c.thrust, 1);
    ship.vel.x = t.x * s.maxSpeed;
    ship.vel.y = t.y * s.maxSpeed;
  } else if (engineOk && ship.isPlayer) {
    // Player never decelerates — keep flying at maxSpeed in current
    ship.vel.x = t.x * effMaxSpeed;
    ship.vel.y = t.y * effMaxSpeed;
  } else if (ship.isPlayer) {
    // Player never decelerates — keep flying at effMaxSpeed in current
    // direction; fall back to heading when there's no prior velocity
    // (game start / respawn).
    const curLen = Math.hypot(ship.vel.x, ship.vel.y);
    if (curLen > 1e-6) {
      ship.vel.x = (ship.vel.x / curLen) * effMaxSpeed;
      ship.vel.y = (ship.vel.y / curLen) * effMaxSpeed;
    } else {
      ship.vel.x = Math.cos(ship.heading) * effMaxSpeed;
      ship.vel.y = Math.sin(ship.heading) * effMaxSpeed;
    }
  } else if (!engineOk) {
    // Engine down — coast with drag instead of snap-stopping so the wreck
    // keeps drifting from its last burn.
    ship.vel.x *= 0.99;
    ship.vel.y *= 0.99;
  } else {
    ship.vel.x = 0;
    ship.vel.y = 0;
  }

  ship.pos.x += ship.vel.x * dt;
  ship.pos.y += ship.vel.y * dt;

  // Arena bounds: clamp + zero velocity component into wall.
  const b = world.arena.bounds;
  if (ship.pos.x < b.minX + s.radius) { ship.pos.x = b.minX + s.radius; if (ship.vel.x < 0) ship.vel.x = 0; }
  if (ship.pos.x > b.maxX - s.radius) { ship.pos.x = b.maxX - s.radius; if (ship.vel.x > 0) ship.vel.x = 0; }
  if (ship.pos.y < b.minY + s.radius) { ship.pos.y = b.minY + s.radius; if (ship.vel.y < 0) ship.vel.y = 0; }
  if (ship.pos.y > b.maxY - s.radius) { ship.pos.y = b.maxY - s.radius; if (ship.vel.y > 0) ship.vel.y = 0; }

  // Rotate heading toward aim direction. Turn rate scales with the
  // fraction of engines still alive: lose half your engines, turn at
  // half speed. When every engine is gone we still allow 15% residual
  // RCS so the silhouette can slowly drift its attitude.
  if (c.aim && (c.aim.x !== 0 || c.aim.y !== 0)) {
    const target = V.angle(c.aim);
    const delta = V.angleDelta(ship.heading, target);
    const turnScale = engineDead ? 0.15 : Math.max(0.15, engineFrac);
    const step = Math.sign(delta) * Math.min(Math.abs(delta), s.turnRate * turnScale * dt);
    ship.heading += step;
  }

  // Shield regeneration: only after shieldRegenDelay seconds since last hit.
  if (s.shield) {
    ship.shieldHitTimer += dt;
    if (ship.shieldHitTimer >= s.shield.regenDelay && ship.shield < ship.shieldMax) {
      ship.shield = Math.min(ship.shieldMax, ship.shield + s.shield.regen * dt);
    }
  }
  if (ship.shieldFlash > 0) ship.shieldFlash = Math.max(0, ship.shieldFlash - dt * 4);
  if (ship.armorFlash > 0) ship.armorFlash = Math.max(0, ship.armorFlash - dt * 4);
  if (ship.hitFlash > 0) ship.hitFlash = Math.max(0, ship.hitFlash - dt * 3);
  if (ship.modules) {
    for (const m of ship.modules) {
      if (m.flash > 0) m.flash = Math.max(0, m.flash - dt * 5);
    }
  }
  // Heavily damaged ships smolder on their own — emit a passive smoke
  // puff at a random hull point when hp is under 60%. As hp drops the
  // cadence accelerates and embers replace smoke; below 25% a fresh
  // fire occasionally ignites somewhere on the hull, so a near-dead
  // ship is visibly burning even between hits.
  ship.puffCd = (ship.puffCd || 0) - dt;
  const hullFrac = ship.hp / ship.hpMax;
  if (hullFrac < 0.6 && ship.puffCd <= 0 && s.radius > 14) {
    ship.puffCd = PUFF_INTERVAL * (0.35 + hullFrac);
    const a = Math.random() * Math.PI * 2;
    const r = s.radius * (0.2 + Math.random() * 0.6);
    const lx = Math.cos(a) * r, ly = Math.sin(a) * r;
    emitPuff(ship, lx, ly, hullFrac < 0.3 ? "ember" : "smoke");
    // Critical hp: occasionally ignite a new fire on an existing dead
    // cell so the burn locations look authentic.
    if (hullFrac < 0.25 && Math.random() < 0.18 && ship.sprite) {
      const dead = ship.sprite.cells.filter((c) => c.dead);
      if (dead.length > 0) {
        const c = dead[Math.floor(Math.random() * dead.length)];
        // Cap simultaneous active fires by skipping when full.
        if (!ship.fires || ship.fires.length < MAX_FIRES) {
          emitFire(ship, c.lx, c.ly, 0.7);
        }
      }
    }
  }
  tickParticles(ship, dt);
  if (ship.modules) {
    for (const m of ship.modules) {
      if (m.flash > 0) m.flash = Math.max(0, m.flash - dt * 4);
    }
  }

  // Primary weapon — branch by firing mode. "none" (carrier) has no
  // primary armament; PD and replenishment handle it. Cooldowns still
  // tick down with the gun destroyed (so it'd be ready instantly if
  // somehow repaired in a future update), but the actual fire-emission
  // is gated on gunOk.
  if (s.firingMode === "broadside") {
    ship.cooldownPort -= dt;
    ship.cooldownStarboard -= dt;
    if (gunOk) updateBroadsideFire(ship, world);
  } else if (s.firingMode === "forward") {
    ship.cooldown -= dt;
    // Magazine reload: when empty, the timer ticks down and then refills.
    if (s.weapon.capacity != null && ship.weaponReloading) {
      ship.weaponReloadTimer -= dt;
      if (ship.weaponReloadTimer <= 0) {
        ship.weaponAmmo = s.weapon.capacity;
        ship.weaponReloading = false;
        ship.weaponReloadTimer = 0;
      }
    }
    const hasAmmo = s.weapon.capacity == null || ship.weaponAmmo > 0;
    if (gunOk && c.firing && c.aim && ship.cooldown <= 0 && hasAmmo) {
      fireForward(ship, world);
      ship.cooldown = s.weapon.cooldown;
      if (s.weapon.capacity != null) {
        ship.weaponAmmo -= 1;
        if (ship.weaponAmmo <= 0) {
          ship.weaponReloading = true;
          ship.weaponReloadTimer = s.weapon.reloadTime;
        }
      }
    }
  }

  // Secondary subsystems.
  ship.missileCd = Math.max(0, ship.missileCd - dt);
  ship.aiMissileCd = Math.max(0, ship.aiMissileCd - dt);
  ship.laserCd = Math.max(0, ship.laserCd - dt);
  if (ship.pdCooldowns) {
    for (let i = 0; i < ship.pdCooldowns.length; i++) {
      ship.pdCooldowns[i] = Math.max(0, ship.pdCooldowns[i] - dt);
    }
  }
  if (ship.podCooldowns) {
    for (let i = 0; i < ship.podCooldowns.length; i++) {
      ship.podCooldowns[i] = Math.max(0, ship.podCooldowns[i] - dt);
    }
  }
  if (ship.siegeCooldowns) {
    for (let i = 0; i < ship.siegeCooldowns.length; i++) {
      ship.siegeCooldowns[i] = Math.max(0, ship.siegeCooldowns[i] - dt);
    }
  }

  // Fighter missile launch (player or AI). One-shot — flag is always cleared
  // after evaluation so a press while cooling isn't queued indefinitely.
  // Gated on the missile subsystem so a fighter that's lost its rack
  // can't fire even though missileCd ticked through.
  if (s.missile && c.firingMissile) {
    if (missileOk && ship.missileCd <= 0) {
      fireFighterMissile(ship, world);
      ship.missileCd = s.missile.cooldown;
    }
    c.firingMissile = false;
  }

  // Capital ship subsystems. PD turrets aren't on the destructible
  // subsystem list (kept as a swarm so partial damage still mounts a
  // partial defence); missile pods + heavy laser are.
  if (s.pdCannons) updatePDFire(ship, world);
  if (s.missilePods && missileOk) updateMissilePodFire(ship, world);
  if (s.siegeMissile && missileOk) updateSiegeMissileFire(ship, world);
  if (s.heavyLaser && laserOk) updateHeavyLaser(ship, world);
  if (s.replenish) updateReplenishment(ship, dt, world);

  // Decay subsystem hit-flashes.
  if (ship.subsystems) {
    for (const node of ship.subsystems) {
      if (node.flash > 0) node.flash = Math.max(0, node.flash - dt * 4);
    }
  }

  if (ship.hp <= 0) ship.dead = true;
}

// ---------------------------------------------------------------------------
// Carrier replenishment: every spec.replenish.fighter seconds launch one
// fighter, every spec.replenish.bomber seconds launch one bomber. With the
// bomber cycle at 2x the fighter cycle, the launch ratio is 2:1.
// ---------------------------------------------------------------------------
function updateReplenishment(carrier, dt, world) {
  // A destroyed hangar freezes both production lines — the carrier's
  // strategic role ends without killing the ship.
  if (carrier.moduleByName && carrier.moduleByName.hangar && carrier.moduleByName.hangar.disabled) return;
  carrier.fighterLaunchCd -= dt;
  carrier.bomberLaunchCd -= dt;
  if (carrier.fighterLaunchCd <= 0) {
    launchReplacement(carrier, world, "fighter");
    carrier.fighterLaunchCd = carrier.spec.replenish.fighter;
  }
  if (carrier.bomberLaunchCd <= 0) {
    launchReplacement(carrier, world, "bomber");
    carrier.bomberLaunchCd = carrier.spec.replenish.bomber;
  }
}

function launchReplacement(carrier, world, klass) {
  const fwd = V.fromAngle(carrier.heading);
  const lateralVec = { x: -fwd.y, y: fwd.x };
  const lateralSign = Math.random() < 0.5 ? -1 : 1;
  const offset = carrier.spec.radius + 30;
  const lat = 30 + Math.random() * 60;
  const pos = {
    x: carrier.pos.x + fwd.x * offset + lateralVec.x * lateralSign * lat,
    y: carrier.pos.y + fwd.y * offset + lateralVec.y * lateralSign * lat,
  };
  const heading = carrier.heading + (Math.random() - 0.5) * 0.4;
  const ship = createShip({
    klass,
    race: carrier.race,
    side: carrier.side,
    pos,
    heading,
    controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
  });
  world.ships.push(ship);
}

// ---------------------------------------------------------------------------
// Forward fire (fighters, frigates, cruisers).
// ---------------------------------------------------------------------------
function fireForward(ship, world) {
  events.emit("weaponFired", { ship, kind: "cannon" });
  const w = ship.spec.weapon;
  const muzzles = w.muzzles || 1;
  const muzzleSpread = w.muzzleSpread || 0;
  const fwd = V.fromAngle(ship.heading);
  const side = { x: -fwd.y, y: fwd.x };

  for (let i = 0; i < muzzles; i++) {
    const lateral = muzzles === 1 ? 0 : ((i - (muzzles - 1) / 2) * muzzleSpread);
    const origin = {
      x: ship.pos.x + fwd.x * (ship.spec.radius + 4) + side.x * lateral,
      y: ship.pos.y + fwd.y * (ship.spec.radius + 4) + side.y * lateral,
    };
    const spread = (Math.random() - 0.5) * 2 * w.spread;
    const dir = V.fromAngle(ship.heading + spread);
    const vel = {
      x: dir.x * w.projectileSpeed + ship.vel.x * 0.3,
      y: dir.y * w.projectileSpeed + ship.vel.y * 0.3,
    };
    world.projectiles.push(createProjectile({
      pos: origin,
      vel,
      damage: w.damage,
      ttl: w.range / w.projectileSpeed,
      radius: w.projectileRadius,
      color: w.projectileColors[ship.side],
      side: ship.side,
      ownerId: ship.id,
      kind: "cannon",
      fromKlass: ship.klass,
    }));
  }
}

// ---------------------------------------------------------------------------
// Broadside fire (battleship barrage cannons).
// ---------------------------------------------------------------------------
function updateBroadsideFire(ship, world) {
  const s = ship.spec;
  const w = s.weapon;
  const fwd = V.fromAngle(ship.heading);
  const sidePort = { x: -fwd.y, y: fwd.x };       // one side
  const sideStarboard = { x: fwd.y, y: -fwd.x };  // the other

  const arcCos = Math.cos(s.broadsideArc || Math.PI / 4);
  const range = w.range;
  const range2 = range * range;

  const hasTargetInArc = (sideVec) => {
    for (const other of world.ships) {
      if (other.dead || other.side === ship.side) continue;
      const dx = other.pos.x - ship.pos.x;
      const dy = other.pos.y - ship.pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > range2 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const cosAng = (dx / d) * sideVec.x + (dy / d) * sideVec.y;
      if (cosAng >= arcCos) return true;
    }
    return false;
  };

  // Disabled-broadside-battery modules silence their side's volley.
  const portMod = ship.moduleByName && ship.moduleByName["broadside-port"];
  const stbdMod = ship.moduleByName && ship.moduleByName["broadside-stbd"];
  const portLive = !portMod || !portMod.disabled;
  const stbdLive = !stbdMod || !stbdMod.disabled;

  if (portLive && ship.cooldownPort <= 0 && hasTargetInArc(sidePort)) {
    emitBroadside(ship, world, sidePort, fwd);
    ship.cooldownPort = w.cooldown;
  }
  if (stbdLive && ship.cooldownStarboard <= 0 && hasTargetInArc(sideStarboard)) {
    emitBroadside(ship, world, sideStarboard, fwd);
    ship.cooldownStarboard = w.cooldown;
  }
}

function emitBroadside(ship, world, sideVec, fwd) {
  events.emit("weaponFired", { ship, kind: "broadside" });
  const w = ship.spec.weapon;
  const muzzles = w.muzzles || 1;
  const muzzleSpread = w.muzzleSpread || 0;
  const baseAngle = Math.atan2(sideVec.y, sideVec.x);

  for (let i = 0; i < muzzles; i++) {
    const lengthwise = muzzles === 1 ? 0 : ((i - (muzzles - 1) / 2) * muzzleSpread);
    const origin = {
      x: ship.pos.x + sideVec.x * (ship.spec.radius + 4) + fwd.x * lengthwise,
      y: ship.pos.y + sideVec.y * (ship.spec.radius + 4) + fwd.y * lengthwise,
    };
    const spread = (Math.random() - 0.5) * 2 * w.spread;
    const dir = { x: Math.cos(baseAngle + spread), y: Math.sin(baseAngle + spread) };
    const vel = {
      x: dir.x * w.projectileSpeed + ship.vel.x * 0.3,
      y: dir.y * w.projectileSpeed + ship.vel.y * 0.3,
    };
    world.projectiles.push(createProjectile({
      pos: origin,
      vel,
      damage: w.damage,
      ttl: w.range / w.projectileSpeed,
      radius: w.projectileRadius,
      color: w.projectileColors[ship.side],
      side: ship.side,
      ownerId: ship.id,
      kind: "cannon",
      fromKlass: ship.klass,
    }));
  }
}

// ---------------------------------------------------------------------------
// Point-defence cannons.
// Each turret independently picks the highest-priority target:
//   1) missile in range
//   2) bomber in range  (their pods are the next wave of inbound missiles)
//   3) fighter in range
//   4) nearest enemy in range
// ---------------------------------------------------------------------------
function pdTurretOffset(ship, i) {
  // Spread turrets around the hull as a ring.
  const n = ship.pdCooldowns.length;
  const ang = (i / n) * Math.PI * 2;
  const r = ship.spec.radius * 0.75;
  // Rotate with the ship heading so turrets ride the hull.
  const ca = Math.cos(ship.heading), sa = Math.sin(ship.heading);
  const lx = Math.cos(ang) * r;
  const ly = Math.sin(ang) * r;
  return {
    x: ship.pos.x + lx * ca - ly * sa,
    y: ship.pos.y + lx * sa + ly * ca,
  };
}

function pickPDTarget(turretPos, range2, side, world) {
  let bestMissile = null, bestMissileD2 = range2;
  let bestBomber = null,  bestBomberD2 = range2;
  let bestFighter = null, bestFighterD2 = range2;
  let bestAny = null,     bestAnyD2 = range2;

  for (const p of world.projectiles) {
    if (p.dead || p.kind !== "missile" || p.side === side) continue;
    const dx = p.pos.x - turretPos.x;
    const dy = p.pos.y - turretPos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestMissileD2) { bestMissileD2 = d2; bestMissile = p; }
  }
  if (bestMissile) return bestMissile;

  for (const o of world.ships) {
    if (o.dead || o.side === side) continue;
    const dx = o.pos.x - turretPos.x;
    const dy = o.pos.y - turretPos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > range2) continue;
    if (o.klass === "bomber" && d2 < bestBomberD2) {
      bestBomberD2 = d2; bestBomber = o;
    }
    if (o.klass === "fighter" && d2 < bestFighterD2) {
      bestFighterD2 = d2; bestFighter = o;
    }
    if (d2 < bestAnyD2) { bestAnyD2 = d2; bestAny = o; }
  }
  return bestBomber || bestFighter || bestAny;
}

function updatePDFire(ship, world) {
  const pd = ship.spec.pdCannons;
  const range2 = pd.range * pd.range;
  for (let i = 0; i < ship.pdCooldowns.length; i++) {
    if (ship.pdCooldowns[i] > 0) continue;
    if (moduleDead(ship, "pd", i)) continue;
    // Skip turrets whose owning module has been knocked out.
    if (ship.pdTurretModules) {
      const modName = ship.pdTurretModules[i];
      const mod = modName && ship.moduleByName[modName];
      if (mod && mod.disabled) continue;
    }
    const origin = pdTurretOffset(ship, i);
    const tgt = pickPDTarget(origin, range2, ship.side, world);
    if (!tgt) continue;
    // Lead-aim: simple linear prediction.
    const tx = tgt.pos.x, ty = tgt.pos.y;
    const tvx = tgt.vel ? tgt.vel.x : 0;
    const tvy = tgt.vel ? tgt.vel.y : 0;
    const rx = tx - origin.x, ry = ty - origin.y;
    const tDist = Math.hypot(rx, ry);
    const tT = tDist / pd.projectileSpeed;
    const px = tx + tvx * tT, py = ty + tvy * tT;
    const ang = Math.atan2(py - origin.y, px - origin.x);
    const dir = V.fromAngle(ang);
    world.projectiles.push(createProjectile({
      pos: origin,
      vel: { x: dir.x * pd.projectileSpeed, y: dir.y * pd.projectileSpeed },
      damage: pd.damage,
      ttl: pd.range / pd.projectileSpeed,
      radius: pd.projectileRadius,
      color: pd.projectileColors[ship.side],
      side: ship.side,
      ownerId: ship.id,
      kind: "cannon",
      fromKlass: "pd",
    }));
    ship.pdCooldowns[i] = pd.cooldown;
  }
}

// ---------------------------------------------------------------------------
// Missile pods (capitals): each pod cycles independently.
// Picks the largest enemy in range; falls back to nearest.
// ---------------------------------------------------------------------------
function pickPodTarget(ship, world, acquireRange) {
  const RANK = { station: 5, battleship: 4, carrier: 3.5, cruiser: 3, frigate: 2, fighter: 1 };
  const r2Max = acquireRange * acquireRange;
  let bestRank = -1, bestD2 = Infinity, best = null;
  for (const o of world.ships) {
    if (o.dead || o.side === ship.side) continue;
    const dx = o.pos.x - ship.pos.x;
    const dy = o.pos.y - ship.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2Max) continue;
    const rank = RANK[o.klass] || 0;
    if (rank > bestRank || (rank === bestRank && d2 < bestD2)) {
      bestRank = rank; bestD2 = d2; best = o;
    }
  }
  return best;
}

function updateMissilePodFire(ship, world) {
  const pods = ship.spec.missilePods;
  // Pick one target per tick — pods on the same hull will spread out
  // naturally over time because each has its own cooldown phase.
  for (let i = 0; i < ship.podCooldowns.length; i++) {
    if (ship.podCooldowns[i] > 0) continue;
    if (moduleDead(ship, "pod", i)) continue;
    // Skip pods whose missile bay is disabled.
    if (ship.podModules) {
      const modName = ship.podModules[i];
      const mod = modName && ship.moduleByName[modName];
      if (mod && mod.disabled) continue;
    }
    const target = pickPodTarget(ship, world, pods.acquireRange);
    if (!target) continue;
    // Pod position: distributed along the hull length.
    const n = ship.podCooldowns.length;
    const offset = (n === 1) ? 0 : ((i - (n - 1) / 2) * (ship.spec.radius * 0.35));
    const fwd = V.fromAngle(ship.heading);
    const sideV = { x: -fwd.y, y: fwd.x };
    // Alternate pods to port / starboard.
    const sideSign = i % 2 === 0 ? 1 : -1;
    const origin = {
      x: ship.pos.x + fwd.x * offset + sideV.x * sideSign * ship.spec.radius * 0.55,
      y: ship.pos.y + fwd.y * offset + sideV.y * sideSign * ship.spec.radius * 0.55,
    };
    // Launch heading: outward, biased toward target.
    const toT = Math.atan2(target.pos.y - origin.y, target.pos.x - origin.x);
    const outward = ship.heading + sideSign * (Math.PI / 2);
    const launchHeading = lerpAngle(outward, toT, 0.4);

    const colors = pods.colors || { blue: "#fff", red: "#fc8" };
    const missile = createMissile({
    // Bombers home onto a specific defensive module first (PD, then
    // broadsides, then anything else) so a strike wave actively peels
    // a capital's screen before chewing into hull.
    const targetModuleName = ship.klass === "bomber"
      ? pickBomberAimModule(target)
      : null;
    world.projectiles.push(createMissile({
      pos: origin,
      heading: launchHeading,
      damage: pods.damage,
      ttl: pods.ttl,
      radius: pods.radius,
      color: colors[ship.side],
      side: ship.side,
      ownerId: ship.id,
      speed: pods.projectileSpeed,
      turnRate: pods.turnRate,
      hp: pods.hp,
      fromKlass: ship.klass,
      acquireRange: pods.acquireRange,
      initialTarget: target,
    });
    // Tag cluster behaviour onto the missile so updateProjectile can
    // bloom it into children on approach. Other classes' pods leave
    // this undefined and behave as plain torpedoes.
    if (pods.cluster) missile.cluster = pods.cluster;
    world.projectiles.push(missile);
      targetModuleName,
    }));
    ship.podCooldowns[i] = pods.cooldown;
    events.emit("weaponFired", { ship, kind: "missile" });
  }
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// ---------------------------------------------------------------------------
// Siege missile launcher — the cruiser's heavy single-mass warhead.
// Fires from the bow on its own (long) cooldown, gated on the missile
// subsystem. Tough HP and big radius so PD has to spend a salvo on it.
// ---------------------------------------------------------------------------
function updateSiegeMissileFire(ship, world) {
  const sm = ship.spec.siegeMissile;
  for (let i = 0; i < ship.siegeCooldowns.length; i++) {
    if (ship.siegeCooldowns[i] > 0) continue;
    const target = pickPodTarget(ship, world, sm.acquireRange);
    if (!target) continue;
    const fwd = V.fromAngle(ship.heading);
    const origin = {
      x: ship.pos.x + fwd.x * (ship.spec.radius + 8),
      y: ship.pos.y + fwd.y * (ship.spec.radius + 8),
    };
    const colors = sm.colors || { blue: "#fff", red: "#fc8" };
    world.projectiles.push(createMissile({
      pos: origin,
      heading: ship.heading,
      damage: sm.damage,
      ttl: sm.ttl,
      radius: sm.radius,
      color: colors[ship.side],
      side: ship.side,
      ownerId: ship.id,
      speed: sm.projectileSpeed,
      turnRate: sm.turnRate,
      hp: sm.hp,
      fromKlass: ship.klass,
      acquireRange: sm.acquireRange,
      initialTarget: target,
    }));
    ship.siegeCooldowns[i] = sm.cooldown;
    events.emit("weaponFired", { ship, kind: "missile" });
  }
}

// ---------------------------------------------------------------------------
// Fighter missile launcher (one-shot, manual or AI).
// ---------------------------------------------------------------------------
function fireFighterMissile(ship, world) {
  events.emit("weaponFired", { ship, kind: "missile" });
  const m = ship.spec.missile;
  // Find a target: nearest enemy within acquireRange. AI doesn't bother
  // firing without one; player can fire anyway (acquireRange wide enough).
  let target = null;
  let bestD2 = m.acquireRange * m.acquireRange;
  for (const o of world.ships) {
    if (o.dead || o.side === ship.side) continue;
    const dx = o.pos.x - ship.pos.x;
    const dy = o.pos.y - ship.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; target = o; }
  }

  const fwd = V.fromAngle(ship.heading);
  const origin = {
    x: ship.pos.x + fwd.x * (ship.spec.radius + 6),
    y: ship.pos.y + fwd.y * (ship.spec.radius + 6),
  };
  world.projectiles.push(createMissile({
    pos: origin,
    heading: ship.heading,
    damage: m.damage,
    ttl: m.ttl,
    radius: m.radius,
    color: ship.side === "blue" ? "#cef" : "#fc8",
    side: ship.side,
    ownerId: ship.id,
    speed: m.projectileSpeed,
    turnRate: m.turnRate,
    hp: m.hp,
    fromKlass: ship.klass,
    acquireRange: m.acquireRange,
    initialTarget: target,
  }));
}

// ---------------------------------------------------------------------------
// Heavy laser (battleship). Instant-hit beam in a forward arc.
// Spawns a beam record in world.beams; damage is applied in game.js.
// ---------------------------------------------------------------------------
function pickLaserTarget(ship, world) {
  const l = ship.spec.heavyLaser;
  const range2 = l.range * l.range;
  const arcCos = Math.cos(l.arc);
  const fwd = V.fromAngle(ship.heading);
  // Heavy lasers are reserved for capital-class targets — wasting a
  // 4-second cooldown on a fighter or bomber is a poor trade.
  const RANK = { battleship: 4, cruiser: 3, frigate: 2, carrier: 4 };
  const RANK = { station: 5, battleship: 4, carrier: 3.5, cruiser: 3, frigate: 2, fighter: 1 };
  let bestRank = -1, bestD2 = Infinity, best = null;
  for (const o of world.ships) {
    if (o.dead || o.side === ship.side) continue;
    if (o.klass === "fighter" || o.klass === "bomber") continue;
    const dx = o.pos.x - ship.pos.x;
    const dy = o.pos.y - ship.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > range2 || d2 < 1e-6) continue;
    const d = Math.sqrt(d2);
    const cosA = (dx / d) * fwd.x + (dy / d) * fwd.y;
    if (cosA < arcCos) continue;
    const rank = RANK[o.klass] || 0;
    if (rank > bestRank || (rank === bestRank && d2 < bestD2)) {
      bestRank = rank; bestD2 = d2; best = o;
    }
  }
  return best;
}

function updateHeavyLaser(ship, world) {
  if (ship.laserCd > 0) return;
  if (moduleDead(ship, "laser", 0)) return;
  // A destroyed laser mount silences the beam for the rest of the match.
  if (ship.moduleByName && ship.moduleByName.laser && ship.moduleByName.laser.disabled) return;
  const l = ship.spec.heavyLaser;
  const target = pickLaserTarget(ship, world);
  if (!target) return;
  events.emit("weaponFired", { ship, kind: "laser" });

  const fwd = V.fromAngle(ship.heading);
  const origin = {
    x: ship.pos.x + fwd.x * ship.spec.radius * 0.9,
    y: ship.pos.y + fwd.y * ship.spec.radius * 0.9,
  };
  if (!world.beams) world.beams = [];
  world.beams.push({
    origin,
    target,                                  // beam re-acquires target each tick
    range: l.range,
    // Damage budget for the whole beam, plus a per-second rate so the
    // damage tick can stay frame-rate independent. dps × ttl ≈ damage.
    damage: l.damage,
    dps: l.damage / l.beamDuration,
    duration: l.beamDuration,
    ttl: l.beamDuration,
    color: l.beamColors[ship.side],
    side: ship.side,
    ownerId: ship.id,
    hit: null,                               // updated each tick with current impact point
  });
  ship.laserCd = l.cooldown;
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

// Per-class engine port positions in unit hull space. Each port emits a
// thrust plume that flickers slightly per frame; together they give a
// sense of which way the ship is facing at a glance.
const ENGINE_PORTS = {
  fighter:    [[-0.65, 0.45], [-0.65, -0.45]],
  bomber:     [[-0.78, 0.45], [-0.78, -0.45], [-0.6, 0]],
  frigate:    [[-0.88, 0.45], [-0.88, -0.45], [-0.85, 0]],
  cruiser:    [[-0.95, 0.55], [-0.95, -0.55], [-0.92, 0.2], [-0.92, -0.2]],
  battleship: [[-0.95, 0.55], [-0.95, -0.55], [-0.95, 0.25], [-0.95, -0.25], [-0.93, 0]],
  carrier:    [[-0.95, 0.3], [-0.95, -0.3], [-0.92, 0.12], [-0.92, -0.12]],
};

// Cockpit or bridge marker per class. Small ships get a front canopy;
// capitals get an aft bridge tower. Coords are in unit hull space.
const COCKPIT = {
  fighter:    { x:  0.30, y: 0, r: 0.16, shape: "round" },
  bomber:     { x:  0.20, y: 0, r: 0.18, shape: "round" },
  frigate:    { x: -0.20, y: 0, w: 0.30, h: 0.30, shape: "tower" },
  cruiser:    { x: -0.30, y: 0, w: 0.40, h: 0.40, shape: "tower" },
  battleship: { x: -0.10, y: 0, w: 0.45, h: 0.50, shape: "tower" },
  carrier:    { x: -0.55, y: 0, w: 0.35, h: 0.40, shape: "tower" },
};

// Trace the hull silhouette into the current path (no fill/stroke).
function tracedHull(ctx, poly, r) {
  ctx.beginPath();
  ctx.moveTo(poly[0][0] * r, poly[0][1] * r);
  for (let i = 1; i < poly.length; i++) {
    ctx.lineTo(poly[i][0] * r, poly[i][1] * r);
  }
  ctx.closePath();
}

// Engine plumes — drawn before the hull so the hull's rear edge crisply
// occludes the front of the plume. Plume length and brightness scale
// with current speed so dead-stopped capitals don't blast exhaust.
function drawEnginePlume(ctx, ship) {
  const ports = ENGINE_PORTS[ship.klass];
  if (!ports) return;
  // No flame from a destroyed engine — the wreck render handles the
  // smouldering aftermath separately.
  if (!hasWorkingSubsystem(ship, "engine")) return;
  const r = ship.spec.radius;
  const speed = Math.hypot(ship.vel.x, ship.vel.y);
  const speedFrac = ship.spec.maxSpeed > 0 ? Math.min(1, speed / ship.spec.maxSpeed) : 0;
  if (speedFrac < 0.05) return;
  // Each ship flickers with its own phase so a swarm doesn't pulse in lockstep.
  const flicker = 0.85 + 0.15 * Math.sin(performance.now() * 0.012 + ship.id * 0.7);
  // Allied ships burn cool blue; hostile burn red — same hue as the side tint.
  const baseColor = ship.side === "blue" ? [120, 220, 255] : [255, 150, 100];
  const len = r * (0.5 + 0.7 * speedFrac) * flicker;
  const halfThick = Math.max(2, r * 0.08);

  ctx.save();
  ctx.translate(ship.pos.x, ship.pos.y);
  ctx.rotate(ship.heading);
  for (const [px, py] of ports) {
    const x = px * r;
    const y = py * r;
    // Outer halo: large soft fade.
    const grad = ctx.createLinearGradient(x, y, x - len, y);
    grad.addColorStop(0, `rgba(${baseColor[0]},${baseColor[1]},${baseColor[2]},0.7)`);
    grad.addColorStop(1, `rgba(${baseColor[0]},${baseColor[1]},${baseColor[2]},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x, y - halfThick);
    ctx.lineTo(x - len, y);
    ctx.lineTo(x, y + halfThick);
    ctx.closePath();
    ctx.fill();
    // Bright inner core.
    ctx.fillStyle = `rgba(255,255,255,${(0.55 * flicker).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(x, y - halfThick * 0.5);
    ctx.lineTo(x - len * 0.55, y);
    ctx.lineTo(x, y + halfThick * 0.5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// Faint panel lines + race-accent spine. Caller must set up the hull
// clip path so strokes don't leak past the silhouette.
function drawHullDetails(ctx, ship, raceAccent) {
  const r = ship.spec.radius;
  // Panel lines: 1 transverse stripe for fighters/bombers, 2 for capitals.
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = 1;
  const transverseX = (ship.klass === "fighter" || ship.klass === "bomber")
    ? [-0.15]
    : [-0.4, 0.1, 0.5];
  for (const tx of transverseX) {
    ctx.beginPath();
    ctx.moveTo(tx * r, -r);
    ctx.lineTo(tx * r,  r);
    ctx.stroke();
  }
  // Race-accent spine: thin colored line down the centerline, gives a
  // strong visual cue for race ID even when zoomed out.
  ctx.strokeStyle = raceAccent;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-r * 0.9, 0);
  ctx.lineTo( r * 0.9, 0);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// Cockpit canopy (small ships) or bridge tower (capitals). Race accent
// color so all four races are individually identifiable.
function drawCockpit(ctx, ship, raceAccent) {
  const cfg = COCKPIT[ship.klass];
  if (!cfg) return;
  const r = ship.spec.radius;
  ctx.save();
  if (cfg.shape === "round") {
    // Dark socket + bright glass canopy on top.
    ctx.fillStyle = "rgba(10,15,25,0.85)";
    ctx.beginPath();
    ctx.arc(cfg.x * r, cfg.y * r, cfg.r * r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = raceAccent;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(cfg.x * r, cfg.y * r, cfg.r * r * 0.65, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  } else {
    // Rectangular bridge tower with a lit window stripe.
    const hw = cfg.w * 0.5 * r;
    const hh = cfg.h * 0.5 * r;
    ctx.fillStyle = "rgba(15,20,30,0.9)";
    ctx.fillRect(cfg.x * r - hw, cfg.y * r - hh, cfg.w * r, cfg.h * r);
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.lineWidth = 1;
    ctx.strokeRect(cfg.x * r - hw, cfg.y * r - hh, cfg.w * r, cfg.h * r);
    // Window band — race-accent slit.
    ctx.fillStyle = raceAccent;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(cfg.x * r - hw + 1, cfg.y * r - hh * 0.25, cfg.w * r - 2, hh * 0.4);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// Per-subsystem-kind visual identity. Color carries kind ID; shape
// reinforces it so colorblind players can still distinguish gun /
// missile / laser / engine nodes.
const SUBSYSTEM_COLOR = {
  gun:     "#fc6",
  missile: "#c8f",
  laser:   "#fff",
  engine:  "#7df",
};

// Draw destructible subsystem nodes on the hull. Healthy nodes glow in
// their kind's color and tighten in tone as they take damage; destroyed
// nodes go dark with a flickering ember and a sooty crater. Players
// (and AI by stray fire) can deliberately aim at these to disable a
// specific weapon or the engine.
function drawSubsystems(ctx, ship) {
  if (!ship.subsystems || ship.subsystems.length === 0) return;
  const r = ship.spec.radius;
  const now = performance.now();
  for (const node of ship.subsystems) {
    const x = node.x * r;
    const y = node.y * r;
    const nr = node.r * r;
    if (node.destroyed) {
      drawDestroyedNode(ctx, x, y, nr, node.kind, now, ship.id);
    } else {
      drawHealthyNode(ctx, x, y, nr, node);
    }
  }
}

function drawHealthyNode(ctx, x, y, nr, node) {
  const color = SUBSYSTEM_COLOR[node.kind] || "#fff";
  const dmg = 1 - node.hp / node.hpMax;
  // Brightness softens as the node takes damage; hit-flash brightens.
  const alpha = Math.min(1, (0.55 - 0.25 * dmg) + node.flash);
  ctx.save();
  ctx.globalAlpha = alpha;
  // Dark socket so the node reads against any hull tint.
  ctx.fillStyle = "rgba(8,12,18,0.7)";
  ctx.beginPath();
  ctx.arc(x, y, nr * 0.95, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  if (node.kind === "missile") {
    // Capsule pod: rounded rectangle with a cap.
    const w = nr * 1.1, h = nr * 0.7;
    ctx.beginPath();
    ctx.moveTo(x - w * 0.4, y - h * 0.5);
    ctx.lineTo(x + w * 0.4, y - h * 0.5);
    ctx.lineTo(x + w * 0.55, y);
    ctx.lineTo(x + w * 0.4, y + h * 0.5);
    ctx.lineTo(x - w * 0.4, y + h * 0.5);
    ctx.closePath();
    ctx.fill();
  } else if (node.kind === "gun") {
    // Stubby barrel: thin rectangle.
    ctx.fillRect(x - nr * 0.5, y - nr * 0.3, nr * 1.1, nr * 0.6);
  } else if (node.kind === "laser") {
    // Cross + bright core: focused emitter.
    ctx.beginPath();
    ctx.moveTo(x - nr * 0.85, y); ctx.lineTo(x + nr * 0.85, y);
    ctx.moveTo(x, y - nr * 0.85); ctx.lineTo(x, y + nr * 0.85);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, nr * 0.4, 0, Math.PI * 2);
    ctx.fill();
  } else { // engine
    // Trapezoidal nozzle opening to the rear (-x direction).
    ctx.beginPath();
    ctx.moveTo(x + nr * 0.35, y - nr * 0.55);
    ctx.lineTo(x + nr * 0.35, y + nr * 0.55);
    ctx.lineTo(x - nr * 0.55, y + nr * 0.8);
    ctx.lineTo(x - nr * 0.55, y - nr * 0.8);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawDestroyedNode(ctx, x, y, nr, kind, now, shipId) {
  // Sooty crater.
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.85)";
  ctx.beginPath();
  ctx.arc(x, y, nr * 0.95, 0, Math.PI * 2);
  ctx.fill();
  // Cracks radiating outward — deterministic per (shipId, kind).
  ctx.strokeStyle = "rgba(60,40,25,0.9)";
  ctx.lineWidth = 1;
  const kindSeed = kind === "engine" ? 1 : kind === "gun" ? 2 : kind === "missile" ? 3 : 4;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + shipId * 0.31 + kindSeed * 0.7;
    const len = nr * (0.7 + 0.25 * Math.sin(shipId * 2.3 + i));
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  // Ember glow that flickers — read as ongoing damage.
  const flicker = 0.5 + 0.5 * Math.sin(now * 0.008 + shipId * 0.7 + kindSeed);
  ctx.globalAlpha = 0.55 * flicker;
  ctx.fillStyle = "#f63";
  ctx.beginPath();
  ctx.arc(x, y, nr * 0.35, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.9 * flicker;
  ctx.fillStyle = "#fc6";
  ctx.beginPath();
  ctx.arc(x, y, nr * 0.18, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Deterministic scorch marks that fade in as the hull takes damage.
// Positions seeded from ship.id so a given ship's scars are stable
// across frames even though we don't carry per-ship state for them.
function drawBattleScars(ctx, ship) {
  const dmgFrac = 1 - (ship.hp / ship.hpMax);
  if (dmgFrac <= 0.25) return;
  const r = ship.spec.radius;
  const maxMarks = ship.klass === "fighter" || ship.klass === "bomber" ? 3 : 7;
  const count = Math.min(maxMarks, Math.floor(dmgFrac * maxMarks * 1.5));
  ctx.fillStyle = "rgba(8,10,16,0.7)";
  for (let i = 0; i < count; i++) {
    // Cheap deterministic hash from (ship.id, i).
    const h1 = Math.sin(ship.id * 12.9898 + i * 78.233) * 43758.5453;
    const h2 = Math.sin(ship.id * 39.346  + i * 11.135) * 24634.6345;
    const u = h1 - Math.floor(h1);
    const v = h2 - Math.floor(h2);
    const sx = (u * 1.6 - 0.8) * r;
    const sy = (v * 1.4 - 0.7) * r;
    const size = 1.5 + ((u + v) % 1) * 2.5;
    ctx.beginPath();
    ctx.arc(sx, sy, size, 0, Math.PI * 2);
// Live engine glow / thrust plumes. Each plume corresponds to its own
// targetable engine module (engine-0, engine-1, ...). A plume's
// intensity scales with its module's HP — bright when healthy, dim and
// jittery near death, fully extinguished when that module is destroyed
// (the module-marker pass then paints the crater over the dead nozzle).
function drawEnginePlumes(ctx, ship) {
  const klass = ship.klass;
  const count = ENGINES[klass] || 0;
  if (count <= 0) return;
  const R = ship.spec.radius;
  const side = ship.side;

  const ex = (ENGINE_X[klass] || -0.9) * R;
  const glowHi = side === "blue" ? "rgba(140,210,255," : "rgba(255,180,100,";
  const glowMid = side === "blue" ? "rgba(80,170,255,"  : "rgba(255,130,60,";
  const glowR = R * (klass === "fighter" ? 0.18 : 0.14);
  for (let i = 0; i < count; i++) {
    // Per-plume gating: read this engine module's state.
    const eng = ship.moduleByName && ship.moduleByName["engine-" + i];
    if (eng && eng.disabled) continue;
    let intensity = 1;
    if (eng) {
      const frac = eng.hp / eng.hpMax;
      intensity = 0.35 + frac * 0.65;
      if (frac < 0.4) intensity *= 0.7 + Math.random() * 0.3;
    }
    const yOff = count === 1 ? 0 : ((i / (count - 1)) - 0.5) * R * 1.05;
    const g = ctx.createRadialGradient(ex, yOff, 0, ex, yOff, glowR * 2.4);
    g.addColorStop(0.0, glowHi + (0.95 * intensity).toFixed(3) + ")");
    g.addColorStop(0.45, glowMid + (0.50 * intensity).toFixed(3) + ")");
    g.addColorStop(1.0, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(ex, yOff, glowR * 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(240,250,255," + (0.95 * intensity).toFixed(3) + ")";
    ctx.beginPath();
    ctx.arc(ex + R * 0.02, yOff, glowR * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Paint one persistent battle scar inside the ship's rotated frame.
// "armor-flake" reads as a chipped/scratched plate (light irregular
// patch), "hull-hole" as a dark gouge with a hot rim. Both are drawn
// from a deterministic seed so the silhouette doesn't flicker frame to
// frame even though we re-generate the polygon path on every draw.
function drawScar(ctx, sc) {
  const r = sc.size;
  if (r <= 0.2) return;
  ctx.save();
  ctx.translate(sc.lx, sc.ly);
  ctx.rotate(sc.seed * Math.PI * 2);
  if (sc.kind === "armor-flake") {
    // Light scratched-metal chip — bright patch with a dark seam.
    ctx.fillStyle = "rgba(190,190,200,0.55)";
    ctx.strokeStyle = "rgba(30,30,40,0.7)";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    const n = 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const nr = r * (0.6 + 0.55 * Math.sin(sc.seed * 13.7 + i * 2.3));
      const x = Math.cos(a) * nr;
      const y = Math.sin(a) * nr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    // Hull hole — hot orange rim, dark irregular bore.
    ctx.strokeStyle = "rgba(255,130,50,0.7)";
    ctx.lineWidth = Math.max(0.8, r * 0.25);
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.05, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(0,0,0,0.88)";
    ctx.beginPath();
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const nr = r * (0.65 + 0.45 * Math.sin(sc.seed * 17.1 + i * 3.1));
      const x = Math.cos(a) * nr;
      const y = Math.sin(a) * nr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
// ---------------------------------------------------------------------------
export function drawShip(ctx, ship) {
  const s = ship.spec;
  // Cosmetic override for the player ship: equipped hull-skin tint
  // replaces the default Allied / Hostile color. Only the player ship
  // carries `ship.cosmetics`; everyone else falls through to side default.
  const tint = (ship.cosmetics && ship.cosmetics.hullTint)
    || SIDES[ship.side].primary;

  // Smoke first — drawn in world space behind the ship body so puffs
  // appear to billow out from under the hull.
  if (ship.puffs && ship.puffs.length > 0) {
    drawPuffs(ctx, ship);
  }
  const raceAccent = (RACES[ship.race] && RACES[ship.race].accent) || tint;

  // Engine plumes are drawn first so the hull occludes their forward
  // edge and the exhaust appears to flow from behind the ship.
  drawEnginePlume(ctx, ship);

  ctx.save();
  ctx.translate(ship.pos.x, ship.pos.y);
  ctx.rotate(ship.heading);

  // Damage tint: as hp drops, fill color shifts toward a darkened,
  // red-shifted version of the accent. At full hp it's the original;
  // at 0 it's heavily charred. This is the "ship has been chewed up"
  // signal you can read from across the screen.
  const hullFrac = Math.max(0, ship.hp / ship.hpMax);
  const fill = damageTint(SIDES[ship.side].accent, hullFrac);

  ctx.strokeStyle = tint;
  ctx.fillStyle = fill;
  ctx.lineWidth = 2;

  // Hull rendering: either the new pixel-cell sprite (chewable) or the
  // legacy race polygon for any class that hasn't been spritified yet.
  if (ship.sprite) {
    drawSpriteCells(ctx, ship, tint, fill);
  } else {
    const poly = getHull(ship.race, ship.klass);
    ctx.beginPath();
    ctx.moveTo(poly[0][0] * s.radius, poly[0][1] * s.radius);
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(poly[i][0] * s.radius, poly[i][1] * s.radius);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // Whole-hull hit flash — white wash over every live cell (or, for
  // legacy non-sprite ships, the polygon silhouette).
  if (ship.hitFlash > 0) {
    ctx.save();
    ctx.globalAlpha = Math.min(0.85, ship.hitFlash * 0.85);
    ctx.fillStyle = "#fff";
    if (ship.sprite) {
      const cs = ship.sprite.cellSize;
      const half = cs / 2;
      for (const cell of ship.sprite.cells) {
        if (cell.dead) continue;
        if (cell.module && cell.module.dead) continue;
        ctx.fillRect(cell.lx - half, cell.ly - half, cs, cs);
      }
    } else {
      const poly = getHull(ship.race, ship.klass);
      ctx.beginPath();
      ctx.moveTo(poly[0][0] * s.radius, poly[0][1] * s.radius);
      for (let i = 1; i < poly.length; i++) {
        ctx.lineTo(poly[i][0] * s.radius, poly[i][1] * s.radius);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  // Hull silhouette — looked up per (race, klass).
  const poly = getHull(ship.race, ship.klass);
  tracedHull(ctx, poly, s.radius);
  ctx.fill();
  ctx.stroke();

  // Interior detail layers — panel lines, spine, battle scars. All
  // clipped to the hull so strokes don't bleed past the silhouette.
  ctx.save();
  tracedHull(ctx, poly, s.radius);
  ctx.clip();
  drawHullDetails(ctx, ship, raceAccent);
  drawBattleScars(ctx, ship);
  ctx.restore();

  // Cockpit / bridge marker — drawn on top of the hull, unclipped, so
  // tower silhouettes can protrude slightly past the hull edge.
  drawCockpit(ctx, ship, raceAccent);

  // Carrier flight-deck stripe — a thin line down the centerline.
  if (ship.klass === "carrier") {
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1.5;
  // Hull — pre-rendered schematic sprite (panels + shading + glow + outline).
  // Falls back to a flat polygon if the sprite cache isn't ready (eg. tests).
  const sprite = getSprite(ship.race, ship.klass, ship.side);
  if (sprite) {
    const scale = s.radius / sprite.baseRadius;
    const half = sprite.halfExtent * scale;
    ctx.drawImage(sprite.canvas, -half, -half, half * 2, half * 2);
  } else {
    const poly = getHull(ship.race, ship.klass);
    ctx.beginPath();
    ctx.moveTo(poly[0][0] * s.radius, poly[0][1] * s.radius);
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(poly[i][0] * s.radius, poly[i][1] * s.radius);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // Damage rendering — three stages, in this order:
  //   1. Armor scorches (cosmetic paint, clipped to silhouette).
  //   2. Hull breaches: actually cut holes through the hull pixels via
  //      destination-out so you can see the void where the plating used
  //      to be. The clip path keeps the cut bounded to the silhouette.
  //   3. Glowing red rim around each breach (normal compositing on top).
  //
  // Sprite-cell ships handle visible hull destruction directly via
  // missing cells, so this block only runs on legacy polygon ships.
  if (!ship.sprite && ship.damageMarks && ship.damageMarks.length > 0) {
    const poly = getHull(ship.race, ship.klass);
    // Stage 1 — armor scorches.
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(poly[0][0] * s.radius, poly[0][1] * s.radius);
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(poly[i][0] * s.radius, poly[i][1] * s.radius);
    }
    ctx.closePath();
    ctx.clip();
    for (const m of ship.damageMarks) {
      if (m.layer !== "armor") continue;
      // Multi-ring scorch: dark soot center with a tan singe ring so it
      // reads as burned plating rather than a clean dot.
      ctx.fillStyle = "rgba(20,12,6,0.7)";
      ctx.beginPath();
      ctx.arc(m.lx, m.ly, m.r * 0.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(190,140,90,0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(m.lx, m.ly, m.r * 1.3, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // Stage 2 — actual hull pixel destruction. destination-out converts
    // affected pixels to transparent, so the canvas background shows
    // through (looks like space punched through the hull).
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(poly[0][0] * s.radius, poly[0][1] * s.radius);
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(poly[i][0] * s.radius, poly[i][1] * s.radius);
    }
    ctx.closePath();
    ctx.clip();
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";
    for (const m of ship.damageMarks) {
      if (m.layer !== "hull") continue;
      const cutR = m.r * 1.9;
      // Jagged crater: punch the central hole, then a ring of smaller
      // adjacent bites so the edge isn't a perfect circle.
      ctx.beginPath();
      ctx.arc(m.lx, m.ly, cutR, 0, Math.PI * 2);
      ctx.fill();
      // Deterministic spatter — use the mark's position as the seed so
      // the same crater renders the same shape every frame.
      const seed = (Math.abs(Math.floor(m.lx * 37 + m.ly * 91))) % 360;
      for (let k = 0; k < 5; k++) {
        const a = ((seed + k * 72) * Math.PI) / 180;
        const ox = Math.cos(a) * cutR * 0.75;
        const oy = Math.sin(a) * cutR * 0.75;
        ctx.beginPath();
        ctx.arc(m.lx + ox, m.ly + oy, cutR * 0.65, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // Stage 3 — red-hot rim. Stroke on top in normal compositing so it
    // outlines the now-empty hole. Two rings: bright inner and softer
    // outer glow.
    for (const m of ship.damageMarks) {
      if (m.layer !== "hull") continue;
      const cutR = m.r * 1.9;
      ctx.strokeStyle = "rgba(255,120,40,0.9)";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(m.lx, m.ly, cutR * 1.08, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,200,90,0.45)";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(m.lx, m.ly, cutR * 1.55, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Broadside gun ports — small dots at port/starboard. Sprite ships
  // already encode their structure in cells; the extra dots clutter
  // the silhouette and are skipped.
  if (!ship.sprite && ship.spec.firingMode === "broadside") {
  // Engine plumes — drawn live so they can dim with engine module HP and
  // black out entirely when the engine module is destroyed. Reads
  // ship.moduleByName.engine if present (added for every mobile class).
  // Stations have no engine entry; their ENGINES[klass] is 0 so this
  // is a no-op for them.
  drawEnginePlumes(ctx, ship);

  // Persistent battle damage — armor flakes and hull holes accumulated
  // from incoming fire. Drawn inside the rotated frame so they ride with
  // the hull. Holes grow under sustained nearby fire (game.js merges
  // nearby impacts into the same scar instead of stacking new ones).
  if (ship.scars && ship.scars.length > 0) {
    for (const sc of ship.scars) drawScar(ctx, sc);
  }

  // Broadside gun ports. Each side dims when its battery module is dead.
  if (ship.spec.firingMode === "broadside") {
    const w = ship.spec.weapon;
    const muzzles = w.muzzles || 1;
    const spread = w.muzzleSpread || 0;
    const offsetY = s.radius * 0.7;
    const portDead = ship.moduleByName && ship.moduleByName["broadside-port"] && ship.moduleByName["broadside-port"].disabled;
    const stbdDead = ship.moduleByName && ship.moduleByName["broadside-stbd"] && ship.moduleByName["broadside-stbd"].disabled;
    for (let i = 0; i < muzzles; i++) {
      const lengthwise = muzzles === 1 ? 0 : ((i - (muzzles - 1) / 2) * spread);
      ctx.fillStyle = stbdDead ? "rgba(60,30,20,0.7)" : tint;
      ctx.beginPath(); ctx.arc(lengthwise,  offsetY, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = portDead ? "rgba(60,30,20,0.7)" : tint;
      ctx.beginPath(); ctx.arc(lengthwise, -offsetY, 2.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Subsystem nodes — PD turrets, missile pods, heavy laser. A dead
  // module gets its hull mounting blown out (destination-out punches a
  // real hole) with a glowing rim; a live one is drawn as a bright dot
  // that whitens on flash and reddens as it loses hp.
  //
  // Sprite-cell ships render modules as cells (P/M/L glyphs in the
  // grid), so this block only runs on legacy polygon ships.
  if (!ship.sprite && ship.modules) {
    const poly = getHull(ship.race, ship.klass);
    // Pass 1 — carve mounting holes for dead modules.
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(poly[0][0] * s.radius, poly[0][1] * s.radius);
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(poly[i][0] * s.radius, poly[i][1] * s.radius);
    }
    ctx.closePath();
    ctx.clip();
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";
    for (const m of ship.modules) {
      if (!m.dead) continue;
      const cutR = (m.kind === "laser" ? 6 : m.kind === "pod" ? 5 : 4);
  // PD turret stubs — dim when their owning cluster module is destroyed.
  if (ship.spec.pdCannons) {
    const n = ship.spec.pdCannons.count;
    const r = s.radius * 0.75;
    for (let i = 0; i < n; i++) {
      let alive = true;
      if (ship.pdTurretModules && ship.moduleByName) {
        const mod = ship.moduleByName[ship.pdTurretModules[i]];
        if (mod && mod.disabled) alive = false;
      }
      ctx.fillStyle = alive ? "#fff" : "rgba(60,40,30,0.75)";
      const a = (i / n) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(m.lx, m.ly, cutR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Pass 2 — rims for dead, bright dots for live.
    for (const m of ship.modules) {
      const size = m.kind === "laser" ? 4 : m.kind === "pod" ? 3 : 2;
      if (m.dead) {
        const cutR = (m.kind === "laser" ? 6 : m.kind === "pod" ? 5 : 4);
        ctx.strokeStyle = "rgba(255,90,30,0.75)";
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.arc(m.lx, m.ly, cutR * 1.05, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const hpFrac = m.hp / m.hpMax;
        const flash = Math.min(1, m.flash);
        const r = Math.round(220 + 35 * flash);
        const g = Math.round(220 + 35 * flash - 120 * (1 - hpFrac));
        const b = Math.round(220 + 35 * flash - 120 * (1 - hpFrac));
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath();
        ctx.arc(m.lx, m.ly, size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  // Heavy laser muzzle on the bow. Suppressed when the ship has a
  // destructible laser subsystem at the same location — the subsystem
  // node renders its own emitter glyph.
  if (ship.spec.heavyLaser && !shipHasSubsystem(ship, "laser")) {
    ctx.fillStyle = "#fff";
  // Heavy laser muzzle on the bow.
  if (ship.spec.heavyLaser) {
    const laserDead = ship.moduleByName && ship.moduleByName.laser && ship.moduleByName.laser.disabled;
    ctx.fillStyle = laserDead ? "rgba(60,30,30,0.75)" : "#fff";
    ctx.beginPath();
    ctx.arc(s.radius * 0.95, 0, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Destructible subsystem nodes — drawn after the legacy decorations
  // so the destructible emplacements overlay any static muzzle/port
  // glyphs that share a position with them.
  drawSubsystems(ctx, ship);
  // Module markers. Alive modules show a faint accent disc that hue-shifts
  // toward red as HP drops; destroyed modules show a black crater + soot
  // ring. Hit flashes briefly outline the module in white. Markers are
  // drawn inside the rotated frame so their (offset.x, offset.y) align
  // with the hull geometry.
  if (ship.modules) {
    for (const m of ship.modules) {
      const mx = m.offset.x * s.radius;
      const my = m.offset.y * s.radius;
      const mr = m.radius * s.radius * 0.55;
      if (m.disabled) {
        ctx.fillStyle = "rgba(0,0,0,0.85)";
        ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "rgba(120,60,40,0.7)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      } else {
        const frac = m.hp / m.hpMax;
        const color = frac > 0.66 ? "rgba(180,220,255,0.45)"
                    : frac > 0.33 ? "rgba(255,220,140,0.65)"
                                  : "rgba(255,140,90,0.78)";
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.fill();
        if (m.flash > 0) {
          ctx.strokeStyle = "rgba(255,255,255," + m.flash.toFixed(2) + ")";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }
  }

  // Player indicator.
  if (ship.isPlayer) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, s.radius + 6 + Math.sin(performance.now() / 200) * 1.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();

  // Sparks — drawn in world space on top of the hull. Bright, short-lived
  // streaks for shrapnel feel.
  if (ship.sparks && ship.sparks.length > 0) {
    drawSparks(ctx, ship);
  }

  // Persistent fires anchored to hull breaches. Drawn after sparks so
  // bright flame cores sit on top of debris flashes, and after the hull
  // so the flame plume isn't masked by hull pixels.
  if (ship.fires && ship.fires.length > 0) {
    drawFires(ctx, ship);
  }

  // Shield bubble. Visible when shield > 0, brighter on hit-flash.
  // Capital hulls (frigate and up) project a much larger bubble around
  // their silhouette so the shield reads as a distinct envelope; small
  // craft keep a tight 6-px shell that hugs the body.
  if (ship.shieldMax > 0 && ship.shield > 0) {
    const frac = ship.shield / ship.shieldMax;
    const baseAlpha = 0.08 + 0.18 * frac;
    const alpha = Math.min(0.85, baseAlpha + ship.shieldFlash);
    const isSmallCraft = ship.klass === "fighter" || ship.klass === "bomber";
    const bubbleR = isSmallCraft
      ? s.radius + 6
      : s.radius * 1.35 + 18;
    ctx.strokeStyle = "rgba(120, 220, 255, " + alpha.toFixed(3) + ")";
    ctx.lineWidth = 2 + ship.shieldFlash * 4;
    ctx.beginPath();
    ctx.arc(ship.pos.x, ship.pos.y, bubbleR, 0, Math.PI * 2);
    ctx.stroke();
    // Faint inner glow for capitals so the bigger bubble isn't a thin
    // distant ring — fills in the depth.
    if (!isSmallCraft) {
      const innerR = s.radius * 1.18 + 10;
      ctx.strokeStyle = "rgba(120, 220, 255, " + (alpha * 0.4).toFixed(3) + ")";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(ship.pos.x, ship.pos.y, innerR, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // HP bar (with an armor strip stacked above for capitals).
  const showHp = ship.hp < ship.hpMax;
  const showArmor = ship.armorMax > 0 && ship.armor < ship.armorMax;
  if (showHp || showArmor) {
    const w = s.radius * 2.4;
    const h = 3;
    const x = ship.pos.x - w / 2;
    let y = ship.pos.y - s.radius - 10;
    if (showArmor) {
      ctx.fillStyle = "#321";
      ctx.fillRect(x, y, w, h);
      // Tint shifts toward red as the plates strip away.
      const frac = ship.armor / ship.armorMax;
      const hit = Math.min(1, ship.armorFlash);
      ctx.fillStyle = hit > 0.5 ? "#fda" : (frac > 0.4 ? "#c93" : "#c63");
      ctx.fillRect(x, y, w * frac, h);
      y -= h + 1;
    }
    if (showHp) {
      ctx.fillStyle = "#400";
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "#4f6";
      ctx.fillRect(x, y, w * (ship.hp / ship.hpMax), h);
    }
  }
}

// ---------------------------------------------------------------------------
// Wreckage — persistent debris chunks spawned when a ship is destroyed.
//
// At kill time the surviving cells of the sprite are partitioned into a
// handful of clusters (Voronoi-ish by nearest seed). Each cluster becomes
// a free-floating wreck with its own pos/vel/heading/angVel, inherits the
// hull tint darkened to a charred grey, and carries its own particle
// systems so it burns and smokes for a few seconds before settling into
// a static husk that stays on the map.
// ---------------------------------------------------------------------------

const WRECK_DRAG = 0.985;
const WRECK_ROT_DRAG = 0.985;
const WRECK_BURN_TIME = 4.0;
const WRECK_MAX_PARTICLES = 18;
const WRECK_MIN_VEL = 4;          // below this we stop integrating motion

export function createWreckageChunks(ship) {
  if (!ship.sprite) return [];
  const liveCells = [];
  for (const c of ship.sprite.cells) {
    if (c.dead) continue;
    if (c.module && c.module.dead) continue;
    liveCells.push(c);
  }
  if (liveCells.length === 0) return [];

  // Pick chunk count by hull size — fighters fragment into 1-2 pieces,
  // capitals into 4-6. Clamp to live cell count so tiny survivors don't
  // create empty chunks.
  const ideal = Math.round(Math.sqrt(liveCells.length) / 1.4);
  const chunkCount = Math.max(1, Math.min(6, Math.min(liveCells.length, ideal)));

  // Seed each chunk with a random live cell.
  const seeds = [];
  const seedSet = new Set();
  let attempts = 0;
  while (seeds.length < chunkCount && attempts < liveCells.length * 4) {
    const idx = Math.floor(Math.random() * liveCells.length);
    if (seedSet.has(idx)) { attempts++; continue; }
    seedSet.add(idx);
    seeds.push(liveCells[idx]);
  }

  // Assign every live cell to the nearest seed (squared distance).
  const groups = seeds.map(() => []);
  for (const cell of liveCells) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < seeds.length; i++) {
      const dx = cell.lx - seeds[i].lx;
      const dy = cell.ly - seeds[i].ly;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD) { bestD = d2; best = i; }
    }
    groups[best].push(cell);
  }

  const cs = ship.sprite.cellSize;
  const ca = Math.cos(ship.heading), sa = Math.sin(ship.heading);
  const baseTint = (ship.cosmetics && ship.cosmetics.hullTint)
    || SIDES[ship.side].primary;
  const baseFill = SIDES[ship.side].accent;

  const chunks = [];
  for (const group of groups) {
    if (group.length === 0) continue;

    // Centroid of the chunk in ship-local coords.
    let lcx = 0, lcy = 0;
    for (const c of group) { lcx += c.lx; lcy += c.ly; }
    lcx /= group.length; lcy /= group.length;

    // World-space pivot for the wreck.
    const wcx = ship.pos.x + lcx * ca - lcy * sa;
    const wcy = ship.pos.y + lcx * sa + lcy * ca;

    // Build re-centered cell list with stable rendering info.
    const cells = group.map((c) => ({
      lx: c.lx - lcx,
      ly: c.ly - lcy,
      kind: c.kind,
    }));

    // Outward impulse: kick the chunk away from the ship center along
    // its centroid vector, plus a bit of noise. Inherit some of the
    // ship's own velocity so wrecks coast with the formation.
    const outLen = Math.hypot(lcx, lcy) || 1;
    const outX = lcx / outLen, outY = lcy / outLen;
    // Rotate the outward vector into world space.
    const wOutX = outX * ca - outY * sa;
    const wOutY = outX * sa + outY * ca;
    const burst = 70 + Math.random() * 110;
    const inheritVel = 0.4;
    const vx = ship.vel.x * inheritVel + wOutX * burst
              + (Math.random() - 0.5) * 60;
    const vy = ship.vel.y * inheritVel + wOutY * burst
              + (Math.random() - 0.5) * 60;
    const angVel = (Math.random() - 0.5) * 3.5;

    chunks.push({
      pos: { x: wcx, y: wcy },
      vel: { x: vx, y: vy },
      heading: ship.heading,
      angVel,
      cells,
      cellSize: cs,
      tint: baseTint,
      fill: baseFill,
      age: 0,
      burnTime: WRECK_BURN_TIME * (0.7 + Math.random() * 0.6),
      smokeCd: 0,
      fireCd: 0,
      puffs: [],
      // A few persistent fires randomly placed across the chunk.
      fires: makeWreckFires(cells),
      // Once moving slowly enough we freeze the wreck in place so old
      // debris doesn't drift forever and accumulate float error.
      settled: false,
    });
  }
  return chunks;
}

function makeWreckFires(cells) {
  const fires = [];
  if (cells.length === 0) return fires;
  const fireCount = Math.min(3, Math.max(1, Math.floor(cells.length / 14)));
  for (let i = 0; i < fireCount; i++) {
    const c = cells[Math.floor(Math.random() * cells.length)];
    fires.push({
      lx: c.lx, ly: c.ly,
      age: 0,
      ttl: WRECK_BURN_TIME * (0.6 + Math.random() * 0.8),
      size: 3.5 + Math.random() * 2.5,
      phase: Math.random() * Math.PI * 2,
      emitCd: 0,
    });
  }
  return fires;
}

// Advance a single wreck chunk one tick. Decays motion via drag, ages
// fires + puffs, emits new smoke/embers while burning, and settles when
// motion drops below the minimum velocity threshold.
export function updateWreck(w, dt, bounds) {
  w.age += dt;

  if (!w.settled) {
    w.pos.x += w.vel.x * dt;
    w.pos.y += w.vel.y * dt;
    w.heading += w.angVel * dt;

    // Drag in *time-correct* form: pow(drag, dt*60) approximates a per-frame
    // multiplier across variable dt. Stays stable at any tick rate.
    const dragT = Math.pow(WRECK_DRAG, dt * 60);
    const rotDragT = Math.pow(WRECK_ROT_DRAG, dt * 60);
    w.vel.x *= dragT;
    w.vel.y *= dragT;
    w.angVel *= rotDragT;

    // Soft arena clamp — bounce gently so debris doesn't escape the map.
    if (bounds) {
      if (w.pos.x < bounds.minX) { w.pos.x = bounds.minX; w.vel.x = Math.abs(w.vel.x) * 0.3; }
      if (w.pos.x > bounds.maxX) { w.pos.x = bounds.maxX; w.vel.x = -Math.abs(w.vel.x) * 0.3; }
      if (w.pos.y < bounds.minY) { w.pos.y = bounds.minY; w.vel.y = Math.abs(w.vel.y) * 0.3; }
      if (w.pos.y > bounds.maxY) { w.pos.y = bounds.maxY; w.vel.y = -Math.abs(w.vel.y) * 0.3; }
    }

    if (Math.hypot(w.vel.x, w.vel.y) < WRECK_MIN_VEL && Math.abs(w.angVel) < 0.05) {
      w.settled = true;
      w.vel.x = 0; w.vel.y = 0; w.angVel = 0;
    }
  }

  // Burning phase: keep emitting smoke + fire embers for a while, then
  // taper off into a quiet husk.
  const burning = w.age < w.burnTime;
  if (burning) {
    w.smokeCd -= dt;
    if (w.smokeCd <= 0) {
      w.smokeCd = 0.14 + Math.random() * 0.12;
      // Pick a random cell to anchor a smoke puff.
      if (w.cells.length > 0 && w.puffs.length < WRECK_MAX_PARTICLES) {
        const c = w.cells[Math.floor(Math.random() * w.cells.length)];
        pushWreckPuff(w, c.lx, c.ly, "smoke");
        if (Math.random() < 0.5) pushWreckPuff(w, c.lx, c.ly, "ember");
      }
    }
  }

  // Age puffs.
  for (const p of w.puffs) {
    p.age += dt;
    p.lx += p.vx * dt;
    p.ly += p.vy * dt;
    p.vx *= 0.92;
    p.vy *= 0.92;
  }
  if (w.puffs.length > 0) {
    w.puffs = w.puffs.filter((p) => p.age < p.ttl);
  }

  // Age fires.
  for (const f of w.fires) {
    f.age += dt;
    f.emitCd -= dt;
    if (f.emitCd <= 0 && w.puffs.length < WRECK_MAX_PARTICLES) {
      f.emitCd = 0.14 + Math.random() * 0.10;
      pushWreckPuff(w, f.lx + (Math.random() - 0.5) * 2,
                       f.ly + (Math.random() - 0.5) * 2, "smoke");
      if (Math.random() < 0.6) pushWreckPuff(w, f.lx, f.ly, "ember");
    }
  }
  if (w.fires.length > 0) {
    w.fires = w.fires.filter((f) => f.age < f.ttl);
  }
}

function pushWreckPuff(w, lx, ly, kind) {
  const a = Math.random() * Math.PI * 2;
  const sp = 14 + Math.random() * 18;
  w.puffs.push({
    lx, ly,
    vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
    age: 0, ttl: PUFF_LIFETIME * (0.8 + Math.random() * 0.6),
    size: 3.5 + Math.random() * 3,
    kind,
  });
}

// Render a wreck chunk: charred cells + smoke puffs + live fires.
export function drawWreck(ctx, w) {
  // Smoke under the wreck.
  if (w.puffs.length > 0) {
    const ca = Math.cos(w.heading), sa = Math.sin(w.heading);
    for (const p of w.puffs) {
      const wx = w.pos.x + p.lx * ca - p.ly * sa;
      const wy = w.pos.y + p.lx * sa + p.ly * ca;
      const t = p.age / p.ttl;
      const a = Math.max(0, 1 - t);
      const radius = p.size * (1 + t * 2.6);
      ctx.save();
      if (p.kind === "ember") {
        ctx.globalAlpha = a * 0.85;
        const g = ctx.createRadialGradient(wx, wy, 0, wx, wy, radius);
        g.addColorStop(0, "rgba(255,200,90,0.9)");
        g.addColorStop(0.5, "rgba(220,90,30,0.55)");
        g.addColorStop(1, "rgba(40,8,4,0)");
        ctx.fillStyle = g;
      } else {
        ctx.globalAlpha = a * 0.55;
        const g = ctx.createRadialGradient(wx, wy, 0, wx, wy, radius);
        g.addColorStop(0, "rgba(60,48,42,0.85)");
        g.addColorStop(1, "rgba(25,18,18,0)");
        ctx.fillStyle = g;
      }
      ctx.beginPath();
      ctx.arc(wx, wy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // Hull cells — charred render. Each cell type is darkened heavily so
  // the wreck reads as burnt-out scrap rather than a working ship.
  ctx.save();
  ctx.translate(w.pos.x, w.pos.y);
  ctx.rotate(w.heading);
  const cs = w.cellSize;
  const half = cs / 2;
  // Persistent fires gradually char everything further; mix toward black.
  const charFrac = Math.min(1, w.age / 1.5);
  const tintCharred = blendToBlack(w.tint, 0.55 + 0.25 * charFrac);
  const fillCharred = blendToBlack(w.fill, 0.65 + 0.25 * charFrac);
  const heavyCharred = blendToBlack(w.fill, 0.78 + 0.18 * charFrac);
  for (const c of w.cells) {
    let color;
    switch (c.kind) {
      case "hull":       color = fillCharred; break;
      case "hull_heavy": color = heavyCharred; break;
      case "bridge":     color = tintCharred; break;
      case "engine":     color = "#311"; break;
      case "pd_mount":
      case "pod_mount":
      case "laser_mount":
        color = "#444";
        break;
      default: color = fillCharred;
    }
    ctx.fillStyle = color;
    ctx.fillRect(c.lx - half, c.ly - half, cs, cs);
  }
  ctx.restore();

  // Fires sit on top of the charred hull.
  if (w.fires.length > 0) {
    const ca = Math.cos(w.heading), sa = Math.sin(w.heading);
    const t = performance.now() / 1000;
    for (const f of w.fires) {
      const wx = w.pos.x + f.lx * ca - f.ly * sa;
      const wy = w.pos.y + f.lx * sa + f.ly * ca;
      const fadeIn = Math.min(1, f.age / 0.25);
      const fadeOut = Math.min(1, (f.ttl - f.age) / 0.6);
      const life = Math.max(0, Math.min(1, Math.min(fadeIn, fadeOut)));
      const flick = 0.75 + 0.35 * Math.sin(t * 18 + f.phase)
                         + 0.18 * Math.sin(t * 31 + f.phase * 2.3);
      const r = f.size * flick;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.9 * life;
      const g = ctx.createRadialGradient(wx, wy, 0, wx, wy, r * 2.4);
      g.addColorStop(0,   "rgba(255,240,180,0.95)");
      g.addColorStop(0.3, "rgba(255,160,60,0.75)");
      g.addColorStop(0.7, "rgba(200,60,20,0.35)");
      g.addColorStop(1,   "rgba(60,10,4,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(wx, wy, r * 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = life;
      const gi = ctx.createRadialGradient(wx, wy, 0, wx, wy, r);
      gi.addColorStop(0, "rgba(255,255,235,0.95)");
      gi.addColorStop(1, "rgba(255,160,60,0)");
      ctx.fillStyle = gi;
      ctx.beginPath();
      ctx.arc(wx, wy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

function blendToBlack(color, t) {
  // Accept hex or rgb() strings; lerp each channel toward 0.
  let r, g, b;
  if (color && color[0] === "#") {
    const rgb = hexToRgb(color);
    r = rgb[0]; g = rgb[1]; b = rgb[2];
  } else {
    const m = /rgb\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/.exec(color);
    if (!m) return color;
    r = +m[1]; g = +m[2]; b = +m[3];
  }
  const tt = Math.max(0, Math.min(1, t));
  const nr = Math.round(r * (1 - tt));
  const ng = Math.round(g * (1 - tt));
  const nb = Math.round(b * (1 - tt));
  return `rgb(${nr},${ng},${nb})`;
}
