import { SIDES } from "./classes.js";
import { resolveSpec } from "./races.js";
import * as V from "./vec.js";
import { createProjectile, createMissile } from "./projectile.js";
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
  },
};

function getHull(race, klass) {
  return (HULLS[race] && HULLS[race][klass]) || HULLS.terran[klass];
}

export function createShip({ klass, race = "terran", side, pos, heading = 0, controller }) {
  const spec = resolveSpec(race, klass);
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
    // Missile state (single-shot weapons like the fighter's missile).
    missileCd: 0,
    aiMissileCd: 0,
    // PD turret cooldowns (one per turret).
    pdCooldowns: spec.pdCannons ? new Array(spec.pdCannons.count).fill(0) : null,
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
  };
  return ship;
}

// ---------------------------------------------------------------------------
// Per-tick ship update.
// ---------------------------------------------------------------------------
export function updateShip(ship, dt, world) {
  const s = ship.spec;
  const c = ship.controller;

  // Fighters and bombers use an aircraft flight model: velocity is locked
  // to nose direction at constant maxSpeed. They cannot strafe or
  // snap-turn — the only way to change direction is to bank (rotate
  // heading), which is turn-rate-limited.
  if (ship.klass === "fighter" || ship.klass === "bomber") {
    ship.vel.x = Math.cos(ship.heading) * s.maxSpeed;
    ship.vel.y = Math.sin(ship.heading) * s.maxSpeed;
  } else if (c.thrust && (c.thrust.x !== 0 || c.thrust.y !== 0)) {
    const t = V.clampLen(c.thrust, 1);
    ship.vel.x = t.x * s.maxSpeed;
    ship.vel.y = t.y * s.maxSpeed;
  } else if (ship.isPlayer) {
    // Player never decelerates — keep flying at maxSpeed in current
    // direction; fall back to heading when there's no prior velocity
    // (game start / respawn).
    const curLen = Math.hypot(ship.vel.x, ship.vel.y);
    if (curLen > 1e-6) {
      ship.vel.x = (ship.vel.x / curLen) * s.maxSpeed;
      ship.vel.y = (ship.vel.y / curLen) * s.maxSpeed;
    } else {
      ship.vel.x = Math.cos(ship.heading) * s.maxSpeed;
      ship.vel.y = Math.sin(ship.heading) * s.maxSpeed;
    }
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

  // Rotate heading toward aim direction at class turn rate.
  if (c.aim && (c.aim.x !== 0 || c.aim.y !== 0)) {
    const target = V.angle(c.aim);
    const delta = V.angleDelta(ship.heading, target);
    const step = Math.sign(delta) * Math.min(Math.abs(delta), s.turnRate * dt);
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

  // Primary weapon — branch by firing mode. "none" (carrier) has no
  // primary armament; PD and replenishment handle it.
  if (s.firingMode === "broadside") {
    ship.cooldownPort -= dt;
    ship.cooldownStarboard -= dt;
    updateBroadsideFire(ship, world);
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
    if (c.firing && c.aim && ship.cooldown <= 0 && hasAmmo) {
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

  if (ship.cooldownPort <= 0 && hasTargetInArc(sidePort)) {
    emitBroadside(ship, world, sidePort, fwd);
    ship.cooldownPort = w.cooldown;
  }
  if (ship.cooldownStarboard <= 0 && hasTargetInArc(sideStarboard)) {
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
  const RANK = { battleship: 4, cruiser: 3, frigate: 2, fighter: 1 };
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
  const RANK = { battleship: 4, cruiser: 3, frigate: 2, fighter: 1 };
  let bestRank = -1, bestD2 = Infinity, best = null;
  for (const o of world.ships) {
    if (o.dead || o.side === ship.side) continue;
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
    target,       // the beam tracks the target while alive
    range: l.range,
    damage: l.damage,
    ttl: l.beamDuration,
    color: l.beamColors[ship.side],
    side: ship.side,
    ownerId: ship.id,
    applied: false,
  });
  ship.laserCd = l.cooldown;
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------
export function drawShip(ctx, ship) {
  const s = ship.spec;
  // Cosmetic override for the player ship: equipped hull-skin tint
  // replaces the default Allied / Hostile color. Only the player ship
  // carries `ship.cosmetics`; everyone else falls through to side default.
  const tint = (ship.cosmetics && ship.cosmetics.hullTint)
    || SIDES[ship.side].primary;
  ctx.save();
  ctx.translate(ship.pos.x, ship.pos.y);
  ctx.rotate(ship.heading);

  ctx.strokeStyle = tint;
  ctx.fillStyle = SIDES[ship.side].accent;
  ctx.lineWidth = 2;

  // Hull silhouette — looked up per (race, klass).
  const poly = getHull(ship.race, ship.klass);
  ctx.beginPath();
  ctx.moveTo(poly[0][0] * s.radius, poly[0][1] * s.radius);
  for (let i = 1; i < poly.length; i++) {
    ctx.lineTo(poly[i][0] * s.radius, poly[i][1] * s.radius);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Carrier flight-deck stripe — a thin line down the centerline.
  if (ship.klass === "carrier") {
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(s.radius * 0.85, 0);
    ctx.lineTo(-s.radius * 0.85, 0);
    ctx.stroke();
  }

  // Broadside gun ports.
  if (ship.spec.firingMode === "broadside") {
    const w = ship.spec.weapon;
    const muzzles = w.muzzles || 1;
    const spread = w.muzzleSpread || 0;
    const offsetY = s.radius * 0.7;
    ctx.fillStyle = tint;
    for (let i = 0; i < muzzles; i++) {
      const lengthwise = muzzles === 1 ? 0 : ((i - (muzzles - 1) / 2) * spread);
      ctx.beginPath(); ctx.arc(lengthwise,  offsetY, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(lengthwise, -offsetY, 2.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  // PD turret stubs (visual dots on the ring).
  if (ship.spec.pdCannons) {
    ctx.fillStyle = "#fff";
    const n = ship.spec.pdCannons.count;
    const r = s.radius * 0.75;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Heavy laser muzzle on the bow.
  if (ship.spec.heavyLaser) {
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(s.radius * 0.95, 0, 4, 0, Math.PI * 2);
    ctx.fill();
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
  if (ship.shieldMax > 0 && ship.shield > 0) {
    const frac = ship.shield / ship.shieldMax;
    const baseAlpha = 0.08 + 0.18 * frac;
    const alpha = Math.min(0.85, baseAlpha + ship.shieldFlash);
    ctx.strokeStyle = "rgba(120, 220, 255, " + alpha.toFixed(3) + ")";
    ctx.lineWidth = 2 + ship.shieldFlash * 4;
    ctx.beginPath();
    ctx.arc(ship.pos.x, ship.pos.y, s.radius + 6, 0, Math.PI * 2);
    ctx.stroke();
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
