import { SIDES } from "./classes.js";
import { resolveSpec, deepMerge } from "./races.js";
import * as V from "./vec.js";
import { createProjectile, createMissile } from "./projectile.js";
import { getSprite, ENGINES, ENGINE_X, buildCells, killCellsForModule } from "./sprites.js";
import {
  buildModules, pdTurretToModuleName, podToModuleName, pickBomberAimModule,
} from "./modules.js";
import { events } from "./events.js";

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

export { HULLS };

export function createShip({ klass, race = "terran", side, pos, heading = 0, controller, specOverride = null, initialHpFrac = 1 }) {
  let spec = resolveSpec(race, klass);
  if (specOverride) spec = deepMerge(spec, specOverride);
  // Roguelite wounded-spawn: a capital that came out of the previous
  // battle at 42% hull spawns at 42% hull here. Shields/armor still
  // reset to max each match (their state isn't legible-to-the-player
  // mid-fight and persistence would only confuse readouts).
  const hpFrac = initialHpFrac > 0 && initialHpFrac <= 1 ? initialHpFrac : 1;
  const ship = {
    id: nextId++,
    klass,
    race,
    side,
    spec,
    pos: { ...pos },
    vel: { x: 0, y: 0 },
    heading,
    hp: spec.hp * hpFrac,
    hpMax: spec.hp,
    cooldown: 0,           // forward firing
    cooldownPort: 0,       // broadside: left side
    cooldownStarboard: 0,  // broadside: right side
    // Multi-stage salvo state. Only consulted when spec.weapon.salvo is
    // defined. Each shot in a salvo fires at the ship's *current* aim,
    // so a moving target gets traced through the burst. Salvo continues
    // independently of controller.firing — once committed, the volley
    // lands in full.
    salvoShotsLeft: 0,
    salvoShotTimer: 0,
    salvoPortShotsLeft: 0,
    salvoPortShotTimer: 0,
    salvoStbdShotsLeft: 0,
    salvoStbdShotTimer: 0,
    controller, // mutable: { thrust, aim, firing, firingMissile }
    dead: false,
    isPlayer: false,
    // Shield (always present; 0 if class has no shield spec).
    shield: spec.shield ? spec.shield.max : 0,
    shieldMax: spec.shield ? spec.shield.max : 0,
    shieldHitTimer: 0, // counts up since last hit; regen kicks in past regenDelay
    shieldFlash: 0,    // visual: brief brighten when hit
    shieldHits: [],    // localized arc flares from recent absorbs
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
    // Ring-cannon cooldowns (frigates have 4 mounts firing independently).
    ringCooldowns: spec.ringCannons ? new Array(spec.ringCannons.count).fill(0) : null,
    // Missile pod cooldowns.
    podCooldowns: spec.missilePods ? new Array(spec.missilePods.count).fill(0) : null,
    // Heavy laser cooldown.
    laserCd: 0,
    // Cannon magazine (only used when spec.weapon.capacity is set).
    weaponAmmo: spec.weapon && spec.weapon.capacity ? spec.weapon.capacity : 0,
    weaponReloading: false,
    weaponReloadTimer: 0,
    // Carrier replenishment cadence — counts down to the next launch.
    fighterLaunchCd: spec.replenish ? spec.replenish.fighter : 0,
    bomberLaunchCd: spec.replenish ? spec.replenish.bomber : 0,
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

  // Destructible cell overlay. Each cell sits in ship-local space and
  // dies in one or two hits within a damage-scaled radius (see
  // damageCellsInRadius in sprites.js / applyDamage in game.js). Cells
  // are bound to the nearest module so a module kill tears out a
  // matching cluster of pixels along with it.
  const grid = buildCells(klass, spec.radius);
  if (grid) {
    ship.cells = grid.cells;
    ship.cellW = grid.cellW;
    ship.cellH = grid.cellH;
    ship.cellHpMax = grid.cellHpMax;
    ship.cellHullCost = grid.cellHullCost;
    // Flat list of cells that have been destroyed — populated by
    // damageCellsInRadius / killCellsForModule and iterated in drawShip
    // instead of walking the full grid every frame looking for voids.
    ship.deadCells = [];
    if (ship.modules) {
      // For each module, bind every still-unbound live cell whose centre
      // sits inside the module's disc to that module. Multiple discs may
      // overlap; the first-touch-wins assignment keeps the binding
      // deterministic and means engines (added late by buildModules) don't
      // steal weapon-cluster cells.
      for (const m of ship.modules) {
        const mx = m.offset.x * spec.radius;
        const my = m.offset.y * spec.radius;
        const mr = m.radius * spec.radius;
        const mr2 = mr * mr;
        for (const cell of ship.cells) {
          if (cell.culled || cell.dead || cell.moduleName) continue;
          const dx = cell.lx - mx;
          const dy = cell.ly - my;
          if (dx * dx + dy * dy <= mr2) {
            cell.moduleName = m.name;
          }
        }
      }
    }
  } else {
    ship.cells = null;
  }

  return ship;
}

// ---------------------------------------------------------------------------
// Per-tick ship update.
// ---------------------------------------------------------------------------
export function updateShip(ship, dt, world) {
  const s = ship.spec;
  const c = ship.controller;

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
  } else if (ship.klass !== "station") {
    // Every combat ship — fighters, bombers, and now capitals — flies
    // at constant max speed in its heading direction. AIs steer
    // exclusively via c.aim; c.thrust is no longer consulted. This
    // unifies the movement model and makes capital paths much easier
    // to read on the minimap (no thrust-mediated jitter).
    ship.vel.x = Math.cos(ship.heading) * effMaxSpeed;
    ship.vel.y = Math.sin(ship.heading) * effMaxSpeed;
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
  // Tick down per-hit shield-arc flares — recorded in game.js
  // applyDamage when a shield absorbs a projectile. Each entry holds
  // an angle in ship-local space + a ttl; drop entries that age out
  // so the array stays bounded.
  if (ship.shieldHits && ship.shieldHits.length > 0) {
    for (let i = ship.shieldHits.length - 1; i >= 0; i--) {
      ship.shieldHits[i].ttl -= dt;
      if (ship.shieldHits[i].ttl <= 0) ship.shieldHits.splice(i, 1);
    }
  }
  if (ship.modules) {
    for (const m of ship.modules) {
      if (m.flash > 0) m.flash = Math.max(0, m.flash - dt * 4);
    }
  }

  // Primary weapon — branch by firing mode. "none" (carrier) has no
  // primary armament; PD and replenishment handle it.
  if (s.firingMode === "broadside") {
    ship.cooldownPort -= dt;
    ship.cooldownStarboard -= dt;
    updateBroadsideFire(ship, world, dt);
  } else if (s.firingMode === "ring") {
    // Ring-cannon frigates: cooldown decrement happens in the secondary
    // subsystems block below alongside PD; firing dispatch happens there
    // too. No primary-weapon work here.
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
    const hasAmmo = () => s.weapon.capacity == null || ship.weaponAmmo > 0;
    const consumeAmmo = () => {
      if (s.weapon.capacity != null) {
        ship.weaponAmmo -= 1;
        if (ship.weaponAmmo <= 0) {
          ship.weaponReloading = true;
          ship.weaponReloadTimer = s.weapon.reloadTime;
        }
      }
    };

    // Salvo continuation: keep stepping through a committed volley
    // regardless of the controller's firing flag. Aborts if the
    // magazine just ran dry.
    if (ship.salvoShotsLeft > 0) {
      ship.salvoShotTimer -= dt;
      if (ship.salvoShotTimer <= 0) {
        if (hasAmmo()) {
          fireForward(ship, world);
          consumeAmmo();
          ship.salvoShotsLeft -= 1;
          ship.salvoShotTimer = s.weapon.salvo.intraShotDelay;
          if (!hasAmmo()) ship.salvoShotsLeft = 0;
        } else {
          ship.salvoShotsLeft = 0;
        }
      }
    }

    // Start a new burst (or single shot) only when the previous cycle
    // has finished and the magazine has rounds.
    const canStart = c.firing && c.aim && ship.cooldown <= 0 && hasAmmo() && ship.salvoShotsLeft <= 0;
    if (canStart) {
      fireForward(ship, world);
      consumeAmmo();
      ship.cooldown = s.weapon.cooldown;
      if (s.weapon.salvo && hasAmmo()) {
        ship.salvoShotsLeft = s.weapon.salvo.shotsPerVolley - 1;
        ship.salvoShotTimer = s.weapon.salvo.intraShotDelay;
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
  if (ship.ringCooldowns) {
    for (let i = 0; i < ship.ringCooldowns.length; i++) {
      ship.ringCooldowns[i] = Math.max(0, ship.ringCooldowns[i] - dt);
    }
  }

  // Fighter missile launch (player or AI). One-shot — flag is always cleared
  // after evaluation so a press while cooling isn't queued indefinitely.
  if (s.missile && c.firingMissile) {
    if (ship.missileCd <= 0) {
      fireFighterMissile(ship, world);
      ship.missileCd = s.missile.cooldown;
    }
    c.firingMissile = false;
  }

  // Capital ship subsystems.
  if (s.pdCannons) updatePDFire(ship, world);
  if (s.ringCannons) updateRingFire(ship, world);
  if (s.missilePods) updateMissilePodFire(ship, world);
  if (s.heavyLaser) updateHeavyLaser(ship, world);
  if (s.replenish) updateReplenishment(ship, dt, world);

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
  events.emit("weaponFired", {
    x: ship.pos.x, y: ship.pos.y,
    kind: ship.klass, isPlayer: ship.isPlayer,
  });
}

// ---------------------------------------------------------------------------
// Broadside fire (battleship barrage cannons).
// ---------------------------------------------------------------------------
function updateBroadsideFire(ship, world, dt) {
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

  // Salvo continuation: each side has its own volley timer/counter, so
  // a fast-rotating battleship can chain bursts down both flanks. The
  // side recomputes its sideVec each shot because the ship may have
  // turned mid-volley.
  if (w.salvo) {
    if (ship.salvoPortShotsLeft > 0) {
      ship.salvoPortShotTimer -= dt;
      if (ship.salvoPortShotTimer <= 0) {
        const fwdNow = V.fromAngle(ship.heading);
        const sidePortNow = { x: -fwdNow.y, y: fwdNow.x };
        emitBroadside(ship, world, sidePortNow, fwdNow);
        ship.salvoPortShotsLeft -= 1;
        ship.salvoPortShotTimer = w.salvo.intraShotDelay;
      }
    }
    if (ship.salvoStbdShotsLeft > 0) {
      ship.salvoStbdShotTimer -= dt;
      if (ship.salvoStbdShotTimer <= 0) {
        const fwdNow = V.fromAngle(ship.heading);
        const sideStbdNow = { x: fwdNow.y, y: -fwdNow.x };
        emitBroadside(ship, world, sideStbdNow, fwdNow);
        ship.salvoStbdShotsLeft -= 1;
        ship.salvoStbdShotTimer = w.salvo.intraShotDelay;
      }
    }
  }

  if (portLive && ship.cooldownPort <= 0 && ship.salvoPortShotsLeft <= 0 && hasTargetInArc(sidePort)) {
    emitBroadside(ship, world, sidePort, fwd);
    ship.cooldownPort = w.cooldown;
    if (w.salvo) {
      ship.salvoPortShotsLeft = w.salvo.shotsPerVolley - 1;
      ship.salvoPortShotTimer = w.salvo.intraShotDelay;
    }
  }
  if (stbdLive && ship.cooldownStarboard <= 0 && ship.salvoStbdShotsLeft <= 0 && hasTargetInArc(sideStarboard)) {
    emitBroadside(ship, world, sideStarboard, fwd);
    ship.cooldownStarboard = w.cooldown;
    if (w.salvo) {
      ship.salvoStbdShotsLeft = w.salvo.shotsPerVolley - 1;
      ship.salvoStbdShotTimer = w.salvo.intraShotDelay;
    }
  }
}

function emitBroadside(ship, world, sideVec, fwd) {
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
  events.emit("weaponFired", {
    x: ship.pos.x, y: ship.pos.y,
    kind: ship.klass, isPlayer: ship.isPlayer,
  });
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

// ---------------------------------------------------------------------------
// Ring cannons (frigate). Four fixed mounts arranged at the cardinal
// points of the hull (front / starboard / aft / port). Each fires
// independently when an enemy lies inside its arc + range. Lead-aim
// is computed per cannon; the projectile is tagged fromKlass:"frigate"
// so the PD-vs-ship nerf doesn't apply.
// ---------------------------------------------------------------------------
const RING_MOUNT_FACINGS = [0, Math.PI / 2, Math.PI, -Math.PI / 2]; // front, stbd, aft, port

function ringMountOrigin(ship, i) {
  // Place each mount on the hull rim along its facing direction.
  const localAng = RING_MOUNT_FACINGS[i];
  const lx = Math.cos(localAng) * ship.spec.radius;
  const ly = Math.sin(localAng) * ship.spec.radius;
  const ca = Math.cos(ship.heading), sa = Math.sin(ship.heading);
  return {
    x: ship.pos.x + lx * ca - ly * sa,
    y: ship.pos.y + lx * sa + ly * ca,
  };
}

function pickRingTarget(ship, mountWorldAng, arc, range2, world) {
  // Mount points outward at `mountWorldAng`; an enemy is in arc when
  // the bearing from mount-to-enemy is within ±arc of that direction.
  // Picks the nearest enemy that satisfies both checks; missiles and
  // fighters are valid targets like any other.
  const cosArc = Math.cos(arc);
  let best = null, bestD2 = range2;
  for (const o of world.ships) {
    if (o.dead || o.side === ship.side) continue;
    const dx = o.pos.x - ship.pos.x;
    const dy = o.pos.y - ship.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > range2 || d2 < 1e-6) continue;
    const d = Math.sqrt(d2);
    const cosTheta = (dx * Math.cos(mountWorldAng) + dy * Math.sin(mountWorldAng)) / d;
    if (cosTheta < cosArc) continue;
    if (d2 < bestD2) { bestD2 = d2; best = o; }
  }
  return best;
}

function updateRingFire(ship, world) {
  const rc = ship.spec.ringCannons;
  const range2 = rc.range * rc.range;
  for (let i = 0; i < ship.ringCooldowns.length; i++) {
    if (ship.ringCooldowns[i] > 0) continue;
    const mountWorldAng = ship.heading + RING_MOUNT_FACINGS[i];
    const tgt = pickRingTarget(ship, mountWorldAng, rc.arc, range2, world);
    if (!tgt) continue;
    const origin = ringMountOrigin(ship, i);
    // Lead-aim — same linear prediction as PD.
    const tx = tgt.pos.x, ty = tgt.pos.y;
    const tvx = tgt.vel ? tgt.vel.x : 0;
    const tvy = tgt.vel ? tgt.vel.y : 0;
    const rx = tx - origin.x, ry = ty - origin.y;
    const tDist = Math.hypot(rx, ry);
    const tT = tDist / rc.projectileSpeed;
    const px = tx + tvx * tT, py = ty + tvy * tT;
    const ang = Math.atan2(py - origin.y, px - origin.x);
    const dir = V.fromAngle(ang);
    world.projectiles.push(createProjectile({
      pos: origin,
      vel: { x: dir.x * rc.projectileSpeed, y: dir.y * rc.projectileSpeed },
      damage: rc.damage,
      ttl: rc.range / rc.projectileSpeed,
      radius: rc.projectileRadius,
      color: rc.projectileColors[ship.side],
      side: ship.side,
      ownerId: ship.id,
      kind: "cannon",
      fromKlass: "frigate",
    }));
    ship.ringCooldowns[i] = rc.cooldown;
    events.emit("weaponFired", {
      x: origin.x, y: origin.y,
      kind: "frigate", isPlayer: ship.isPlayer,
    });
  }
}

function updatePDFire(ship, world) {
  const pd = ship.spec.pdCannons;
  const range2 = pd.range * pd.range;
  for (let i = 0; i < ship.pdCooldowns.length; i++) {
    if (ship.pdCooldowns[i] > 0) continue;
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
  // Admiral missile-hold: when the player has issued "hold missile
  // fire" for this ship's class, the pod cooldowns keep ticking (so
  // releasing the hold doesn't dump a stockpile) but no missiles
  // launch. Only the allied side honors directives — enemy fleets
  // run normal AI.
  if (world.directives && ship.side === "blue") {
    const dir = world.directives[ship.klass];
    if (dir && dir.missiles === "hold") return;
  }
  const pods = ship.spec.missilePods;
  // Pick one target per tick — pods on the same hull will spread out
  // naturally over time because each has its own cooldown phase.
  for (let i = 0; i < ship.podCooldowns.length; i++) {
    if (ship.podCooldowns[i] > 0) continue;
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
      targetModuleName,
      // Cluster config only set on classes that declare one (currently
      // battleships). The missile carries the spec through to bloom
      // time so updateMissile can split it on approach.
      cluster: pods.cluster || null,
    }));
    ship.podCooldowns[i] = pods.cooldown;
    events.emit("missileFired", {
      x: origin.x, y: origin.y,
      isPlayer: ship.isPlayer,
    });
  }
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// ---------------------------------------------------------------------------
// Fighter missile launcher (one-shot, manual or AI).
// ---------------------------------------------------------------------------
function fireFighterMissile(ship, world) {
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
  events.emit("missileFired", {
    x: origin.x, y: origin.y,
    isPlayer: ship.isPlayer,
  });
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
  // Capital-only target table: aircraft (fighter / bomber) are too small
  // and too cheap for a heavy laser to bother — they fall off the list
  // entirely and the beam holds fire until a real ship of the line
  // crosses the arc. PD turrets handle aircraft.
  const RANK = { station: 5, battleship: 4, carrier: 3.5, cruiser: 3, frigate: 2 };
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
  // A destroyed laser mount silences the beam for the rest of the match.
  if (ship.moduleByName && ship.moduleByName.laser && ship.moduleByName.laser.disabled) return;
  const l = ship.spec.heavyLaser;
  const target = pickLaserTarget(ship, world);
  if (!target) return;

  const fwd = V.fromAngle(ship.heading);
  const origin = {
    x: ship.pos.x + fwd.x * ship.spec.radius * 0.9,
    y: ship.pos.y + fwd.y * ship.spec.radius * 0.9,
  };
  if (!world.beams) world.beams = [];
  world.beams.push({
    origin,
    target,       // the beam tracks the target while alive
    range: l.range,
    // Sustained beam: total damage is spread across the beam's lifetime
    // by game.js (dps = damage / duration), applied each tick to the
    // target. Both fields are stored so the visual + damage layers can
    // each pick what they need.
    damage: l.damage,
    dps: l.damage / l.beamDuration,
    duration: l.beamDuration,
    ttl: l.beamDuration,
    color: l.beamColors[ship.side],
    side: ship.side,
    ownerId: ship.id,
    hit: null,
  });
  ship.laserCd = l.cooldown;
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

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
    // Subtle scratched plate — muted gray with a dark seam, no rim
    // halo. Reads as a chip in the armor without drawing the eye
    // away from the actual hole / module craters.
    ctx.fillStyle = "rgba(140,148,160,0.45)";
    ctx.strokeStyle = "rgba(20,24,32,0.55)";
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
    // Hull hole — sooty crater in the same visual language as a
    // destroyed module node: dark irregular bore, dark sooty rim,
    // optional charred inner ring for bigger holes. No bright orange
    // ring (that read as a "floating rind" hovering above the hull).
    // Dark sooty outer ring — subtle, just enough to seat the crater
    // in the hull surface.
    ctx.strokeStyle = "rgba(20,16,18,0.75)";
    ctx.lineWidth = Math.max(0.6, r * 0.18);
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.04, 0, Math.PI * 2);
    ctx.stroke();
    // Crater fill — irregular dark polygon.
    ctx.fillStyle = "rgba(0,0,0,0.92)";
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
    // Charred inner accent for larger craters — a slightly darker
    // off-centre disc that gives depth without painting a halo.
    if (r > 4) {
      ctx.fillStyle = "rgba(40,28,24,0.55)";
      ctx.beginPath();
      ctx.arc(r * 0.15, r * 0.1, r * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
// ---------------------------------------------------------------------------
// Module visual identity. Each kind draws a small distinctive sub-icon
// inside the module's hit disc so the player can read at a glance which
// systems are still online: a long forward barrel for laser, silo grid
// for missile launchers, perpendicular cannon row for broadsides, an
// animated turret for PD, a wide bay door for hangars, a single big
// tube for torpedoes. Engines stay minimal — the visible plume already
// identifies them.
//
// All draws happen in ship-local space; the caller has already done
// ctx.translate(ship.pos) + ctx.rotate(ship.heading). Inside this
// helper we further translate to (mx, my) so each icon can be written
// in module-local coordinates with the ship's +x forward axis.
function moduleKind(name) {
  if (name.startsWith("engine-")) return "engine";
  if (name.startsWith("pd-")) return "pd";
  if (name.startsWith("broadside-")) return "broadside";
  if (name.startsWith("missile-")) return "missile";
  if (name === "laser") return "laser";
  if (name === "hangar") return "hangar";
  if (name === "torpedo-bay") return "torpedo";
  return "unknown";
}

// Material palette — module body fill keyed by HP fraction. Each icon
// uses these so chip damage reads consistently across types.
function moduleBodyColor(frac) {
  if (frac > 0.66) return "rgba(170,200,225,0.85)";
  if (frac > 0.33) return "rgba(220,180,110,0.88)";
  return "rgba(230,120,80,0.92)";
}
function moduleAccentColor(frac) {
  // Slightly darker than the body — gives the icon internal depth.
  if (frac > 0.66) return "rgba(70,100,135,0.95)";
  if (frac > 0.33) return "rgba(120,80,40,0.95)";
  return "rgba(120,50,30,0.95)";
}

function drawLaserArt(ctx, mr, frac) {
  // Round base + long forward barrel + glowing red lens at the muzzle.
  const body = moduleBodyColor(frac);
  const accent = moduleAccentColor(frac);
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.arc(0, 0, mr * 0.95, 0, Math.PI * 2); ctx.fill();
  // Barrel: rectangle pointing in +x.
  const barrelLen = mr * 1.6;
  const barrelW = mr * 0.45;
  ctx.fillStyle = accent;
  ctx.fillRect(0, -barrelW / 2, barrelLen, barrelW);
  // Muzzle lens — small inset glowing red disc at the barrel tip.
  ctx.fillStyle = "rgba(255,80,50,0.95)";
  ctx.beginPath(); ctx.arc(barrelLen - mr * 0.18, 0, mr * 0.22, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,200,160,0.9)";
  ctx.beginPath(); ctx.arc(barrelLen - mr * 0.18, 0, mr * 0.09, 0, Math.PI * 2); ctx.fill();
}

function drawMissileArt(ctx, mr, facing, frac) {
  // Square casing + 2x2 grid of silo openings, optionally flipped to
  // point backward for missile-aft. The casing rotates with `facing`.
  ctx.save();
  ctx.rotate(facing);
  const body = moduleBodyColor(frac);
  const accent = moduleAccentColor(frac);
  ctx.fillStyle = body;
  const s = mr * 1.5;
  ctx.fillRect(-s / 2, -s / 2, s, s);
  // 2x2 silo openings.
  ctx.fillStyle = accent;
  const silo = mr * 0.32;
  const off = mr * 0.4;
  for (const dx of [-off, off]) for (const dy of [-off, off]) {
    ctx.beginPath(); ctx.arc(dx, dy, silo, 0, Math.PI * 2); ctx.fill();
  }
  // Inner gleam in each silo — a single bright dot suggests a warhead.
  ctx.fillStyle = "rgba(255,210,140,0.9)";
  for (const dx of [-off, off]) for (const dy of [-off, off]) {
    ctx.beginPath(); ctx.arc(dx, dy, silo * 0.35, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawBroadsideArt(ctx, mr, ySign, frac) {
  // Long casing parallel to the ship's spine (x-axis) with 3 cannon
  // barrels poking out perpendicular toward the hull's port/starboard
  // side. ySign is +1 (starboard) or -1 (port).
  const body = moduleBodyColor(frac);
  const accent = moduleAccentColor(frac);
  ctx.fillStyle = body;
  ctx.fillRect(-mr * 1.1, -mr * 0.45, mr * 2.2, mr * 0.9);
  // Three cannon barrels evenly along the casing.
  ctx.fillStyle = accent;
  const barrelW = mr * 0.28;
  const barrelLen = mr * 0.9;
  for (const xPos of [-mr * 0.7, 0, mr * 0.7]) {
    ctx.fillRect(xPos - barrelW / 2, ySign > 0 ? 0 : -barrelLen, barrelW, barrelLen);
    // Muzzle tip
    ctx.save();
    ctx.fillStyle = "rgba(40,30,30,0.95)";
    ctx.fillRect(xPos - barrelW / 2, ySign > 0 ? barrelLen - mr * 0.15 : -barrelLen, barrelW, mr * 0.15);
    ctx.restore();
  }
}

function drawPdArt(ctx, mr, ship, frac) {
  // Octagonal base + a small turret cap that rotates over time. Each
  // ship's turret has a unique phase (seeded by ship.id) so a swarm of
  // PD nests don't spin in lockstep.
  const body = moduleBodyColor(frac);
  const accent = moduleAccentColor(frac);
  // Base — octagon.
  ctx.fillStyle = body;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const x = Math.cos(a) * mr * 0.95;
    const y = Math.sin(a) * mr * 0.95;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  // Rotating turret cap.
  const t = performance.now() / 1000;
  const phase = ((ship.id || 0) * 0.37) % (Math.PI * 2);
  ctx.save();
  ctx.rotate(t * 1.5 + phase);
  ctx.fillStyle = accent;
  // Twin barrels.
  const bw = mr * 0.22, bl = mr * 1.1;
  ctx.fillRect(0, -mr * 0.35 - bw / 2, bl, bw);
  ctx.fillRect(0,  mr * 0.35 - bw / 2, bl, bw);
  // Dome cap.
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.arc(0, 0, mr * 0.45, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawHangarArt(ctx, mr, frac) {
  // Wide rectangular bay door opening forward, dark interior with a
  // single chevron arrow pointing out, yellow hazard strip along the
  // lip.
  const body = moduleBodyColor(frac);
  ctx.fillStyle = body;
  const w = mr * 1.9, h = mr * 1.4;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  // Bay interior — black void.
  ctx.fillStyle = "rgba(0,0,0,0.85)";
  ctx.fillRect(-w / 2 + mr * 0.18, -h / 2 + mr * 0.18, w - mr * 0.36, h - mr * 0.36);
  // Hazard stripe along the forward lip.
  ctx.fillStyle = "rgba(240,200,50,0.95)";
  ctx.fillRect(w / 2 - mr * 0.18, -h / 2, mr * 0.12, h);
  // Chevron pointing forward — single triangle.
  ctx.fillStyle = "rgba(220,230,255,0.85)";
  ctx.beginPath();
  ctx.moveTo(mr * 0.55, 0);
  ctx.lineTo(-mr * 0.2, -mr * 0.42);
  ctx.lineTo(-mr * 0.2, mr * 0.42);
  ctx.closePath();
  ctx.fill();
}

function drawTorpedoArt(ctx, mr, frac) {
  // Single large forward-facing tube with crosshair fins, glowing
  // inner ring suggesting an armed warhead.
  const body = moduleBodyColor(frac);
  const accent = moduleAccentColor(frac);
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.arc(0, 0, mr * 0.95, 0, Math.PI * 2); ctx.fill();
  // Cross-hair fins.
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(1, mr * 0.12);
  ctx.beginPath();
  ctx.moveTo(-mr * 0.85, 0); ctx.lineTo(mr * 0.85, 0);
  ctx.moveTo(0, -mr * 0.85); ctx.lineTo(0, mr * 0.85);
  ctx.stroke();
  // Tube opening — dark center.
  ctx.fillStyle = "rgba(20,10,15,0.95)";
  ctx.beginPath(); ctx.arc(0, 0, mr * 0.5, 0, Math.PI * 2); ctx.fill();
  // Inner glow.
  ctx.fillStyle = "rgba(120,200,255,0.65)";
  ctx.beginPath(); ctx.arc(0, 0, mr * 0.22, 0, Math.PI * 2); ctx.fill();
}

function drawEngineArt(ctx, mr, frac) {
  // Engines are visually carried by their plumes; the disc itself
  // just needs to look like a nozzle mouth — a thick dark ring.
  ctx.strokeStyle = moduleAccentColor(frac);
  ctx.lineWidth = Math.max(1.2, mr * 0.35);
  ctx.beginPath(); ctx.arc(0, 0, mr * 0.7, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "rgba(20,15,25,0.85)";
  ctx.beginPath(); ctx.arc(0, 0, mr * 0.45, 0, Math.PI * 2); ctx.fill();
}

function drawModuleArt(ctx, m, mx, my, mr, frac, ship) {
  ctx.save();
  ctx.translate(mx, my);
  switch (moduleKind(m.name)) {
    case "laser":     drawLaserArt(ctx, mr, frac); break;
    case "missile":   drawMissileArt(ctx, mr, m.name === "missile-aft" ? Math.PI : 0, frac); break;
    case "broadside": drawBroadsideArt(ctx, mr, m.offset.y >= 0 ? 1 : -1, frac); break;
    case "pd":        drawPdArt(ctx, mr, ship, frac); break;
    case "hangar":    drawHangarArt(ctx, mr, frac); break;
    case "torpedo":   drawTorpedoArt(ctx, mr, frac); break;
    case "engine":    drawEngineArt(ctx, mr, frac); break;
    default:
      ctx.fillStyle = moduleBodyColor(frac);
      ctx.beginPath(); ctx.arc(0, 0, mr, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
export function drawShip(ctx, ship, zoom = 1) {
  const s = ship.spec;
  const tint = SIDES[ship.side].primary;
  // Screen-pixel radius of this ship after the camera transform. Used to
  // gate cheap detail like module damage-stage chrome and wounded-cell
  // halos — far-zoomed-out ships in a 250-ship brawl drop those passes
  // to save fill-time on details the eye can't resolve at this scale.
  const screenRadius = s.radius * zoom;
  const detail = screenRadius >= 12;
  ctx.save();
  ctx.translate(ship.pos.x, ship.pos.y);
  ctx.rotate(ship.heading);

  ctx.strokeStyle = tint;
  ctx.fillStyle = SIDES[ship.side].accent;
  ctx.lineWidth = 2;

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

  // Destructible cell overlay — for every cell that's been killed by a
  // hit (or by losing its bound module), paint an opaque dark void.
  // This is what makes the silhouette visibly lose chunks: the
  // pre-rendered sprite stays pretty, but dead cells punch holes
  // through it. Drawn after scars so a chunk missing from the hull
  // covers any scar that used to sit there.
  if (ship.cells) {
    const cw = ship.cellW;
    const ch = ship.cellH;
    const halfW = cw / 2;
    const halfH = ch / 2;
    // Pad each cell by 1px so adjacent dead cells form a continuous
    // void instead of leaving thin sliver lines between them.
    const padW = cw + 1;
    const padH = ch + 1;
    // Dead cells via the per-ship cache — typically far smaller than
    // walking the full grid (~600 cells avg) each frame.
    if (ship.deadCells && ship.deadCells.length > 0) {
      ctx.fillStyle = "#000";
      for (const cell of ship.deadCells) {
        ctx.fillRect(cell.lx - halfW, cell.ly - halfH, padW, padH);
      }
    }
    // Wounded-cell halo intentionally removed: the prior rust overlay +
    // orange dot read as a "floating rind" hovering over the hull. Cells
    // now go straight from pristine sprite to punched-out void; the
    // hit-flash below + scar craters carry the damage feedback.
    // Bright rim around the freshest chip so a hit reads visibly even
    // before the chunk has finished tearing out.
    let anyFlash = false;
    for (const cell of ship.cells) {
      if (!cell.dead && cell.flash > 0.05) { anyFlash = true; break; }
    }
    if (anyFlash) {
      ctx.fillStyle = "rgba(255,200,90,0.85)";
      for (const cell of ship.cells) {
        if (cell.dead || cell.flash <= 0.05) continue;
        ctx.globalAlpha = Math.min(1, cell.flash);
        ctx.fillRect(cell.lx - halfW, cell.ly - halfH, cw, ch);
        cell.flash -= 0.08;
      }
      ctx.globalAlpha = 1;
    }
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
      ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Heavy laser muzzle on the bow.
  if (ship.spec.heavyLaser) {
    const laserDead = ship.moduleByName && ship.moduleByName.laser && ship.moduleByName.laser.disabled;
    ctx.fillStyle = laserDead ? "rgba(60,30,30,0.75)" : "#fff";
    ctx.beginPath();
    ctx.arc(s.radius * 0.95, 0, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Module markers. Each module renders a type-specific icon inside its
  // hit disc (laser barrel, missile silos, broadside cannons, PD turret,
  // hangar bay, torpedo tube, engine nozzle) so the player can read at
  // a glance which systems are still online. Progressive chip-damage
  // chrome paints over the icon as HP drops:
  //   stage 0 (>80% hp)  pristine icon
  //   stage 1 (>55% hp)  hairline crack chord across the disc
  //   stage 2 (>30% hp)  stage 1 + chipped rim wedge + darker inner
  //   stage 3 (>0%  hp)  red-hot core gradient (also drives smoke VFX)
  //   stage 4 (=0% hp)   crater + soot ring (disabled)
  // Crack/wedge/core only paint when this ship's screen radius is >=12px
  // — far-zoomed-out ships in a 250-ship brawl skip them.
  if (ship.modules) {
    for (const m of ship.modules) {
      const mx = m.offset.x * s.radius;
      const my = m.offset.y * s.radius;
      const mr = m.radius * s.radius * 0.85;
      if (m.disabled) {
        ctx.fillStyle = "rgba(0,0,0,0.85)";
        ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "rgba(120,60,40,0.7)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
        continue;
      }
      const frac = m.hp / m.hpMax;
      drawModuleArt(ctx, m, mx, my, mr, frac, ship);
      if (detail) {
        // Deterministic angle seed from the module name so cracks/wedges
        // sit in the same place each frame without storing per-module state.
        let seed = 0;
        for (let i = 0; i < m.name.length; i++) seed = (seed * 31 + m.name.charCodeAt(i)) | 0;
        const crackAng = (seed & 0xffff) / 0xffff * Math.PI;
        if (frac <= 0.80) {
          // Stage 1+: hairline crack across the disc.
          const cx = Math.cos(crackAng) * mr * 0.95;
          const cy = Math.sin(crackAng) * mr * 0.95;
          ctx.strokeStyle = "rgba(20,20,25,0.85)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(mx - cx, my - cy);
          ctx.lineTo(mx + cx, my + cy);
          ctx.stroke();
        }
        if (frac <= 0.55) {
          // Stage 2+: chipped wedge cut out of the rim + darker inner disc.
          ctx.fillStyle = "rgba(0,0,0,0.55)";
          ctx.beginPath();
          ctx.arc(mx, my, mr, crackAng + 1.9, crackAng + 2.5);
          ctx.lineTo(mx, my);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = "rgba(80,40,30,0.45)";
          ctx.beginPath(); ctx.arc(mx, my, mr * 0.55, 0, Math.PI * 2); ctx.fill();
        }
        if (frac <= 0.30) {
          // Stage 3: red-hot core showing through the breached casing.
          const g = ctx.createRadialGradient(mx, my, 0, mx, my, mr);
          g.addColorStop(0, "rgba(255,210,120,0.95)");
          g.addColorStop(0.45, "rgba(255,110,40,0.7)");
          g.addColorStop(1, "rgba(255,40,20,0)");
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.fill();
        }
      }
      if (m.flash > 0) {
        ctx.strokeStyle = "rgba(255,255,255," + m.flash.toFixed(2) + ")";
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.stroke();
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

  // Shield bubble. Visible when shield > 0, brighter on hit-flash.
  // Offset scales with hull radius so capital ships get a visible
  // stand-off bubble — a flat +6px hugs a battleship at 156px so
  // tightly it looks like an outline. Floor of 6px keeps the small
  // craft (fighter/bomber) bubble unchanged. Per-hit arc flares ride
  // on top so impacts read at the spot they actually land.
  if (ship.shieldMax > 0 && ship.shield > 0) {
    const frac = ship.shield / ship.shieldMax;
    const baseAlpha = 0.08 + 0.18 * frac;
    const alpha = Math.min(0.85, baseAlpha + ship.shieldFlash);
    // Bigger stand-off after the defensive buff pass — the bubble reads
    // as a wrap-around energy field instead of an outline. Floor of 8px
    // keeps small-craft bubbles visible without overpowering the hull.
    const shieldOffset = Math.max(8, s.radius * 0.22);
    const bubbleR = s.radius + shieldOffset;
    ctx.strokeStyle = "rgba(120, 220, 255, " + alpha.toFixed(3) + ")";
    ctx.lineWidth = 2 + ship.shieldFlash * 4;
    ctx.beginPath();
    ctx.arc(ship.pos.x, ship.pos.y, bubbleR, 0, Math.PI * 2);
    ctx.stroke();

    // Per-hit arc flare: a short, bright arc of the bubble centred
    // on the impact angle. Multiple recent hits stack so a missile
    // salvo lights up the shield from several directions at once.
    // Ship-local angle → world by rotating with ship.heading; render
    // in world space directly (we're outside the ctx.save/restore
    // of the rotated ship frame here).
    if (ship.shieldHits && ship.shieldHits.length > 0) {
      for (const h of ship.shieldHits) {
        const t = h.ttl / h.maxTtl; // 1 at fresh, → 0 at expire
        // Arc width shrinks as the flare ages; brightness too.
        const half = 0.35 * t + 0.10;
        const worldAng = ship.heading + h.ang;
        const a0 = worldAng - half;
        const a1 = worldAng + half;
        ctx.strokeStyle = "rgba(220, 245, 255, " + (0.85 * t).toFixed(3) + ")";
        ctx.lineWidth = 4 + 6 * t;
        ctx.beginPath();
        ctx.arc(ship.pos.x, ship.pos.y, bubbleR, a0, a1);
        ctx.stroke();
        // Inner brighter core line.
        ctx.strokeStyle = "rgba(255, 255, 255, " + (0.6 * t).toFixed(3) + ")";
        ctx.lineWidth = 1.5 + 2 * t;
        ctx.beginPath();
        ctx.arc(ship.pos.x, ship.pos.y, bubbleR, a0 + half * 0.3, a1 - half * 0.3);
        ctx.stroke();
      }
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
