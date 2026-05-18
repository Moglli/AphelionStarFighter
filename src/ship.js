import { CLASSES, SIDES } from "./classes.js";
import * as V from "./vec.js";
import { createProjectile, createMissile } from "./projectile.js";

let nextId = 1;

export function createShip({ klass, side, pos, heading = 0, controller }) {
  const spec = CLASSES[klass];
  const ship = {
    id: nextId++,
    klass,
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
    // Missile state (single-shot weapons like the fighter's missile).
    missileCd: 0,
    aiMissileCd: 0,
    // PD turret cooldowns (one per turret).
    pdCooldowns: spec.pdCannons ? new Array(spec.pdCannons.count).fill(0) : null,
    // Missile pod cooldowns.
    podCooldowns: spec.missilePods ? new Array(spec.missilePods.count).fill(0) : null,
    // Heavy laser cooldown.
    laserCd: 0,
  };
  return ship;
}

// ---------------------------------------------------------------------------
// Per-tick ship update.
// ---------------------------------------------------------------------------
export function updateShip(ship, dt, world) {
  const s = ship.spec;
  const c = ship.controller;

  // Fighters use an aircraft flight model: velocity is locked to nose
  // direction at constant maxSpeed. They cannot strafe or snap-turn — the
  // only way to change direction is to bank (rotate heading), which is
  // turn-rate-limited.
  if (ship.klass === "fighter") {
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

  // Primary weapon — branch by firing mode.
  if (s.firingMode === "broadside") {
    ship.cooldownPort -= dt;
    ship.cooldownStarboard -= dt;
    updateBroadsideFire(ship, world);
  } else {
    ship.cooldown -= dt;
    if (c.firing && c.aim && ship.cooldown <= 0) {
      fireForward(ship, world);
      ship.cooldown = s.weapon.cooldown;
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

  if (ship.hp <= 0) ship.dead = true;
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
//   2) fighter in range
//   3) nearest enemy in range
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
    if (o.klass === "fighter" && d2 < bestFighterD2) {
      bestFighterD2 = d2; bestFighter = o;
    }
    if (d2 < bestAnyD2) { bestAnyD2 = d2; bestAny = o; }
  }
  return bestFighter || bestAny;
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

    world.projectiles.push(createMissile({
      pos: origin,
      heading: launchHeading,
      damage: pods.damage,
      ttl: pods.ttl,
      radius: pods.radius,
      color: ship.side === "blue" ? "#fff" : "#fc8",
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
  const tint = SIDES[ship.side].primary;
  ctx.save();
  ctx.translate(ship.pos.x, ship.pos.y);
  ctx.rotate(ship.heading);

  ctx.strokeStyle = tint;
  ctx.fillStyle = SIDES[ship.side].accent;
  ctx.lineWidth = 2;

  ctx.beginPath();
  if (ship.klass === "fighter") {
    ctx.moveTo(s.radius, 0);
    ctx.lineTo(-s.radius * 0.7, s.radius * 0.8);
    ctx.lineTo(-s.radius * 0.4, 0);
    ctx.lineTo(-s.radius * 0.7, -s.radius * 0.8);
  } else if (ship.klass === "frigate") {
    ctx.moveTo(s.radius, 0);
    ctx.lineTo(s.radius * 0.3, s.radius * 0.7);
    ctx.lineTo(-s.radius * 0.9, s.radius * 0.6);
    ctx.lineTo(-s.radius * 0.9, -s.radius * 0.6);
    ctx.lineTo(s.radius * 0.3, -s.radius * 0.7);
  } else if (ship.klass === "cruiser") {
    ctx.moveTo(s.radius, 0);
    ctx.lineTo(s.radius * 0.5, s.radius * 0.8);
    ctx.lineTo(-s.radius * 0.6, s.radius * 0.9);
    ctx.lineTo(-s.radius, s.radius * 0.4);
    ctx.lineTo(-s.radius, -s.radius * 0.4);
    ctx.lineTo(-s.radius * 0.6, -s.radius * 0.9);
    ctx.lineTo(s.radius * 0.5, -s.radius * 0.8);
  } else {
    ctx.moveTo(s.radius, 0);
    ctx.lineTo(s.radius * 0.7, s.radius * 0.6);
    ctx.lineTo(-s.radius * 0.2, s.radius * 0.7);
    ctx.lineTo(-s.radius * 0.4, s.radius * 0.95);
    ctx.lineTo(-s.radius, s.radius * 0.7);
    ctx.lineTo(-s.radius, -s.radius * 0.7);
    ctx.lineTo(-s.radius * 0.4, -s.radius * 0.95);
    ctx.lineTo(-s.radius * 0.2, -s.radius * 0.7);
    ctx.lineTo(s.radius * 0.7, -s.radius * 0.6);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

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

  // HP bar.
  if (ship.hp < ship.hpMax) {
    const w = s.radius * 2.4;
    const h = 3;
    const x = ship.pos.x - w / 2;
    const y = ship.pos.y - s.radius - 10;
    ctx.fillStyle = "#400";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#4f6";
    ctx.fillRect(x, y, w * (ship.hp / ship.hpMax), h);
  }
}
