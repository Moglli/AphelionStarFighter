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
    cooldown: 0,
    controller, // mutable: { thrust, aim, firing }
    dead: false,
    isPlayer: false,
  };
}

export function updateShip(ship, dt, world) {
  const s = ship.spec;
  const c = ship.controller;

  // Thrust accelerates ship along stick direction; independent of heading.
  if (c.thrust && (c.thrust.x !== 0 || c.thrust.y !== 0)) {
    const t = V.clampLen(c.thrust, 1);
    ship.vel.x += t.x * s.accel * dt;
    ship.vel.y += t.y * s.accel * dt;
  }
  // Drag per tick (frame-rate independent enough at fixed 60Hz).
  ship.vel.x *= s.drag;
  ship.vel.y *= s.drag;
  ship.vel = V.clampLen(ship.vel, s.maxSpeed);

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

  // Fire.
  ship.cooldown -= dt;
  if (c.firing && c.aim && ship.cooldown <= 0) {
    fire(ship, world);
    ship.cooldown = s.weapon.cooldown;
  }

  if (ship.hp <= 0) ship.dead = true;
}

function fire(ship, world) {
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
