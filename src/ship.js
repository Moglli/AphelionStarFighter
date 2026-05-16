import { CLASSES, SIDES } from "./classes.js";
import * as V from "./vec.js";
import { createProjectile } from "./projectile.js";

let nextId = 1;

export function createShip({ klass, side, pos, heading = 0, controller }) {
  const spec = CLASSES[klass];
  return {
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
    controller, // mutable: { thrust, aim, firing }
    dead: false,
    isPlayer: false,
  };
}

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

  // Fire — branch by firing mode.
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

  if (ship.hp <= 0) ship.dead = true;
}

function fireForward(ship, world) {
  const w = ship.spec.weapon;
  const muzzles = w.muzzles || 1;
  const muzzleSpread = w.muzzleSpread || 0;
  const fwd = V.fromAngle(ship.heading);
  const side = { x: -fwd.y, y: fwd.x };

  for (let i = 0; i < muzzles; i++) {
    // Offset muzzles laterally (centered).
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
      color: w.projectileColor,
      side: ship.side,
      ownerId: ship.id,
    }));
  }
}

// Broadside ships fire automatically: each side independently fires whenever
// any enemy is within range AND inside the side's arc. No manual aim.
function updateBroadsideFire(ship, world) {
  const s = ship.spec;
  const w = s.weapon;
  const fwd = V.fromAngle(ship.heading);
  const sidePort = { x: -fwd.y, y: fwd.x };       // one side
  const sideStarboard = { x: fwd.y, y: -fwd.x };  // the other

  const arcCos = Math.cos(s.broadsideArc || Math.PI / 4);
  const range = w.range;
  const range2 = range * range;

  // Is any enemy inside this side's firing arc (and in range)?
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
    // Spread muzzles along the ship's LENGTH (forward axis) for broadsides.
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
      color: w.projectileColor,
      side: ship.side,
      ownerId: ship.id,
    }));
  }
}

export function drawShip(ctx, ship) {
  const s = ship.spec;
  const tint = SIDES[ship.side].primary;
  ctx.save();
  ctx.translate(ship.pos.x, ship.pos.y);
  ctx.rotate(ship.heading);

  // Hull shape varies by class.
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
    // battleship — long blocky hull
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

  // Broadside gun ports: small dots on each side, telegraphs the firing arcs.
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

  // Player indicator: pulsing ring.
  if (ship.isPlayer) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, s.radius + 6 + Math.sin(performance.now() / 200) * 1.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();

  // HP bar above ship (skip for fighters at full hp to reduce clutter).
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
