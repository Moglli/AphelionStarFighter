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

export function updateAI(ship, world, dt) {
  const c = ship.controller;

  // Packed fighters share their pack's target so a pack engages as a wing.
  let target = null;
  if (ship.packId != null && world.packs) {
    const pack = world.packs.get(ship.packId);
    if (pack && pack.target && !pack.target.dead) target = pack.target;
  }
  if (!target) target = nearestEnemy(ship, world.ships);

  if (!target) {
    c.thrust = { x: 0, y: 0 };
    c.aim = null;
    c.firing = false;
    return;
  }

  if (ship.klass === "fighter") {
    flybyAI(ship, target, dt);
  } else {
    orbitAI(ship, target, dt);
  }
}

// Fighter behaviour: fly-by attack runs with curving breaks. The fighter
// approaches a target along an offset path (sweeping past the target's side),
// fires through the run, then when it begins to depart commits to a curving
// arc tangent to the target. Alternating `breakSide` between passes traces
// out a figure-8 pattern around the target.
function flybyAI(ship, target, dt) {
  const c = ship.controller;
  const s = ship.spec;

  // Per-ship state, lazily initialized.
  if (ship.attackState === undefined) {
    ship.attackState = "approach";
    ship.breakSide = (ship.id % 2 === 0) ? 1 : -1;
    ship.breakTimer = 0;
    ship.approachTimer = 0;
  }

  const rel = V.sub(target.pos, ship.pos);
  const dist = V.len(rel);
  const dir = dist > 1e-6 ? { x: rel.x / dist, y: rel.y / dist } : { x: 1, y: 0 };
  // Perpendicular (CCW); multiplied by breakSide for left/right.
  const perp = { x: -dir.y, y: dir.x };

  // Scale by target size so passes feel tight on fighters and grand on capitals.
  const PASS_OFFSET = target.spec.radius + 80;
  const REGROUP_DIST = 600;
  const PASS_ZONE_DIST = 500;   // must be at least this close to count as a pass
  const MIN_BREAK_TIME = 1.2;
  const MAX_APPROACH_TIME = 12; // failsafe: re-evaluate if approach drags

  if (ship.attackState === "approach") {
    ship.approachTimer += dt;

    // Aim point is offset to one side of the target — fighter curves in to
    // strafe past rather than dead-colliding.
    const offX = perp.x * PASS_OFFSET * ship.breakSide;
    const offY = perp.y * PASS_OFFSET * ship.breakSide;
    const apX = target.pos.x + offX - ship.pos.x;
    const apY = target.pos.y + offY - ship.pos.y;
    const apLen = Math.hypot(apX, apY);
    c.thrust = apLen > 1e-6 ? { x: apX / apLen, y: apY / apLen } : { x: 0, y: 0 };

    // Guns track the actual target (with lead) so the strafe pass scores hits.
    const leadVec = leadAim(ship, target, s.weapon.projectileSpeed);
    c.aim = leadVec;
    const fwd = { x: Math.cos(ship.heading), y: Math.sin(ship.heading) };
    const aimNorm = V.norm(leadVec);
    const aligned = V.dot(fwd, aimNorm);
    c.firing = dist <= s.weapon.range && aligned > 0.9;

    // Trigger break when the fighter has actually got close AND is now moving
    // away from the target (i.e., has passed it).
    const departing = (rel.x * ship.vel.x + rel.y * ship.vel.y) < 0;
    const inPassZone = dist < PASS_ZONE_DIST;
    const settled = ship.approachTimer > 0.5;
    if ((departing && inPassZone && settled) || ship.approachTimer > MAX_APPROACH_TIME) {
      ship.attackState = "break";
      ship.breakTimer = MIN_BREAK_TIME;
      ship.approachTimer = 0;
    }
  } else {
    // Break: thrust tangent to target on chosen side + a touch outward.
    // The momentum from the approach combined with this curve produces the
    // wide arcing breakaway.
    const tangX = perp.x * ship.breakSide;
    const tangY = perp.y * ship.breakSide;
    const outX = -dir.x;
    const outY = -dir.y;
    const bx = tangX * 1.0 + outX * 0.5;
    const by = tangY * 1.0 + outY * 0.5;
    const bLen = Math.hypot(bx, by);
    c.thrust = { x: bx / bLen, y: by / bLen };
    // Face where we're going so the turn looks smooth and we don't keep firing.
    c.aim = c.thrust;
    c.firing = false;

    ship.breakTimer -= dt;
    const minTimeMet = ship.breakTimer <= 0;
    const farEnough = dist > REGROUP_DIST;
    // Failsafe: if we've been breaking forever, just commit to a new pass.
    const breakOverdue = ship.breakTimer <= -3.0;
    if ((minTimeMet && farEnough) || breakOverdue) {
      ship.attackState = "approach";
      ship.breakSide = -ship.breakSide; // alternate -> figure-8
      ship.approachTimer = 0;
    }
  }
}

// Frigate / cruiser / battleship: orbit at preferred range. Heavy hulls hold
// position when in the orbit band; lighter and broadside hulls strafe.
function orbitAI(ship, target, dt) {
  const c = ship.controller;
  const s = ship.spec;
  const rel = V.sub(target.pos, ship.pos);
  const dist = V.len(rel);
  const dir = dist > 1e-6 ? { x: rel.x / dist, y: rel.y / dist } : { x: 1, y: 0 };
  const isBroadside = s.firingMode === "broadside";

  const orbit = s.aiOrbit;
  let thrust;
  if (dist > orbit * 1.15) {
    thrust = dir; // close in
  } else if (dist < orbit * 0.85) {
    thrust = { x: -dir.x, y: -dir.y }; // back off
  } else {
    const shouldStrafe = isBroadside || ship.klass === "frigate";
    if (shouldStrafe) {
      const sign = (ship.id % 2 === 0) ? 1 : -1;
      thrust = { x: -dir.y * sign, y: dir.x * sign };
    } else {
      thrust = { x: 0, y: 0 };
    }
  }
  c.thrust = thrust;

  if (isBroadside) {
    // Turn so a broadside (perpendicular axis) faces the target. Pick
    // whichever of the two perpendiculars is closer to current heading
    // to minimize rotation churn.
    const perpA = { x: -dir.y, y: dir.x };
    const perpB = { x: dir.y, y: -dir.x };
    const fwd = { x: Math.cos(ship.heading), y: Math.sin(ship.heading) };
    c.aim = V.dot(fwd, perpA) >= V.dot(fwd, perpB) ? perpA : perpB;
    // Broadside firing is gated by per-side arc check, not this flag.
    c.firing = true;
  } else {
    // Forward firing: aim with lead, fire when nose is on target.
    const leadVec = leadAim(ship, target, s.weapon.projectileSpeed);
    c.aim = leadVec;
    const fwd = { x: Math.cos(ship.heading), y: Math.sin(ship.heading) };
    const aimNorm = V.norm(leadVec);
    const aligned = V.dot(fwd, aimNorm);
    c.firing = dist <= s.weapon.range && aligned > 0.9;
  }
}
