import * as V from "./vec.js";

// Find nearest enemy to a ship.
function nearestEnemy(ship, ships) {
  let best = null, bestD2 = Infinity;
  for (const other of ships) {
    if (other.dead || other.side === ship.side) continue;
    const dx = other.pos.x - ship.pos.x;
    const dy = other.pos.y - ship.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = other; }
  }
  return best;
}

// Lead a moving target so a projectile of `speed` will hit. Approximation
// (one iteration is plenty for our purposes).
function leadAim(shooter, target, speed) {
  const rel = V.sub(target.pos, shooter.pos);
  const dist = V.len(rel);
  const t = dist / speed;
  return {
    x: target.pos.x + target.vel.x * t - shooter.pos.x,
    y: target.pos.y + target.vel.y * t - shooter.pos.y,
  };
}

export function updateAI(ship, ships, dt) {
  const c = ship.controller;
  const s = ship.spec;
  const target = nearestEnemy(ship, ships);

  if (!target) {
    // Idle: drift, don't fire.
    c.thrust = { x: 0, y: 0 };
    c.aim = null;
    c.firing = false;
    return;
  }

  const rel = V.sub(target.pos, ship.pos);
  const dist = V.len(rel);
  const dir = dist > 1e-6 ? { x: rel.x / dist, y: rel.y / dist } : { x: 1, y: 0 };

  // Steering: orbit at preferred range. Approach if too far, back off if too close.
  const orbit = s.aiOrbit;
  let thrust;
  if (dist > orbit * 1.15) {
    thrust = dir; // close in
  } else if (dist < orbit * 0.85) {
    thrust = { x: -dir.x, y: -dir.y }; // back off
  } else {
    // Strafe perpendicular for fighters/frigates, hold for heavies.
    if (ship.klass === "fighter" || ship.klass === "frigate") {
      const sign = (ship.id % 2 === 0) ? 1 : -1;
      thrust = { x: -dir.y * sign, y: dir.x * sign };
    } else {
      thrust = { x: 0, y: 0 };
    }
  }
  c.thrust = thrust;

  // Aim with lead.
  const leadVec = leadAim(ship, target, s.weapon.projectileSpeed);
  c.aim = leadVec;

  // Fire when target is in range AND roughly in front of the ship's nose.
  const fwd = { x: Math.cos(ship.heading), y: Math.sin(ship.heading) };
  const aimNorm = V.norm(leadVec);
  const aligned = V.dot(fwd, aimNorm);
  c.firing = dist <= s.weapon.range && aligned > 0.9;
}
