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
    flybyAI(ship, target, dt, world);
  } else {
    orbitAI(ship, target, dt);
  }
}

// Vector toward pack centroid when the ship has strayed from its packmates.
// Returns null when close enough — cohesion only kicks in past a threshold
// so it doesn't fight the dogfight.
function packCohesion(ship, pack) {
  if (!pack || !pack.center) return null;
  const dx = pack.center.x - ship.pos.x;
  const dy = pack.center.y - ship.pos.y;
  const d = Math.hypot(dx, dy);
  const THRESHOLD = 300;
  if (d <= THRESHOLD || d < 1e-6) return null;
  return { x: dx / d, y: dy / d };
}

// Avoidance vector when the ship is inside any enemy capital's firing arc.
// Broadside hulls (battleship): pushes toward the bow/stern axis the ship is
// already aimed at — fastest exit from the side arc.
// Forward-firing capitals (frigate, cruiser): pushes perpendicular to the
// enemy's bow, toward whichever beam the ship is already drifting onto — so
// fighters break out laterally instead of charging down the guns.
// Returns null when not in danger.
const FORWARD_ARC_HALF = Math.PI / 4;
const FORWARD_ARC_COS = Math.cos(FORWARD_ARC_HALF);
function bigShipDanger(ship, ships) {
  let ax = 0, ay = 0;
  for (const other of ships) {
    if (other.dead || other.side === ship.side) continue;
    if (other.klass === "fighter") continue;
    const range = other.spec.weapon.range;
    const dx = ship.pos.x - other.pos.x;
    const dy = ship.pos.y - other.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > range * range) continue;
    const d = Math.sqrt(d2);
    if (d < 1e-6) continue;
    const fwdX = Math.cos(other.heading), fwdY = Math.sin(other.heading);
    const toUsX = dx / d, toUsY = dy / d;
    const portX = -fwdY, portY = fwdX;
    const urgency = 1 - d / range; // 0 at fringe, 1 at center

    if (other.spec.firingMode === "broadside") {
      const arcCos = Math.cos(other.spec.broadsideArc || Math.PI / 4);
      const stbdX = fwdY, stbdY = -fwdX;
      const portDot = toUsX * portX + toUsY * portY;
      const stbdDot = toUsX * stbdX + toUsY * stbdY;
      if (portDot < arcCos && stbdDot < arcCos) continue;
      // In an arc — pick whichever bow/stern direction we're already aimed
      // toward; that exit is fastest with the limited turn rate.
      const myFwdX = Math.cos(ship.heading), myFwdY = Math.sin(ship.heading);
      const dotF = myFwdX * fwdX + myFwdY * fwdY;
      const sign = dotF >= 0 ? 1 : -1;
      ax += sign * fwdX * urgency;
      ay += sign * fwdY * urgency;
    } else {
      // Forward-firing capital: only dangerous inside the bow cone.
      if (toUsX * fwdX + toUsY * fwdY < FORWARD_ARC_COS) continue;
      const portDot = toUsX * portX + toUsY * portY;
      const sign = portDot >= 0 ? 1 : -1; // push further onto the beam we're already on
      ax += sign * portX * urgency;
      ay += sign * portY * urgency;
    }
  }
  const aLen = Math.hypot(ax, ay);
  if (aLen < 1e-6) return null;
  return { x: ax / aLen, y: ay / aLen };
}

// Tail evasion: an enemy fighter close behind with its nose lined up on us is
// about to land hits. Push perpendicular to their line of fire, biased to
// whichever side our velocity is already drifting — that's the cheapest jink.
// Returns null when nothing is tailing us.
function tailDanger(ship, ships) {
  let ax = 0, ay = 0;
  const myFwdX = Math.cos(ship.heading), myFwdY = Math.sin(ship.heading);
  const TAIL_RANGE = 450;
  for (const other of ships) {
    if (other.dead || other.side === ship.side) continue;
    if (other.klass !== "fighter") continue;
    const dx = ship.pos.x - other.pos.x; // them -> us
    const dy = ship.pos.y - other.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > TAIL_RANGE * TAIL_RANGE) continue;
    const d = Math.sqrt(d2);
    if (d < 1e-6) continue;
    const toUsX = dx / d, toUsY = dy / d;
    const otherFwdX = Math.cos(other.heading), otherFwdY = Math.sin(other.heading);
    // Their nose is pointed at us.
    if (toUsX * otherFwdX + toUsY * otherFwdY < 0.85) continue;
    // And they're behind us (us->them runs opposite our nose).
    if (toUsX * myFwdX + toUsY * myFwdY > -0.2) continue;
    const px = -toUsY, py = toUsX;
    const velDot = px * ship.vel.x + py * ship.vel.y;
    const sign = velDot >= 0 ? 1 : -1;
    const urgency = 1 - d / TAIL_RANGE;
    ax += sign * px * urgency;
    ay += sign * py * urgency;
  }
  const aLen = Math.hypot(ax, ay);
  if (aLen < 1e-6) return null;
  return { x: ax / aLen, y: ay / aLen };
}

// Fighter behaviour: fly-by attack runs with curving breaks. The fighter
// approaches a target along an offset path (sweeping past the target's side),
// fires through the run, then when it begins to depart commits to a curving
// arc tangent to the target. Alternating `breakSide` between passes traces
// out a figure-8 pattern around the target. Pack cohesion and big-ship
// danger avoidance modify the final aim direction.
function flybyAI(ship, target, dt, world) {
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

  const REGROUP_DIST = 600;
  const PASS_ZONE_DIST = 500;   // must be at least this close to count as a pass
  const MIN_BREAK_TIME = 1.2;
  const MAX_APPROACH_TIME = 12; // failsafe: re-evaluate if approach drags

  if (ship.attackState === "approach") {
    ship.approachTimer += dt;

    // Aim at the lead target. Heading rotates toward it at turnRate, and
    // the fighter's velocity is locked to its nose direction — so the
    // curving pursuit emerges from the turn-rate limit. At close range
    // bearing rotates faster than the fighter can bank, producing a
    // natural overshoot (the strafe pass).
    const leadVec = leadAim(ship, target, s.weapon.projectileSpeed);
    c.thrust = { x: 0, y: 0 }; // unused for fighters; kept tidy
    c.aim = leadVec;
    const fwd = { x: Math.cos(ship.heading), y: Math.sin(ship.heading) };
    const aimNorm = V.norm(leadVec);
    const aligned = V.dot(fwd, aimNorm);
    c.firing = dist <= s.weapon.range && aligned > 0.92;

    // Break when the fighter has gotten close AND is now moving away
    // from the target (i.e., it has passed).
    const departing = (rel.x * ship.vel.x + rel.y * ship.vel.y) < 0;
    const inPassZone = dist < PASS_ZONE_DIST;
    const settled = ship.approachTimer > 0.5;
    if ((departing && inPassZone && settled) || ship.approachTimer > MAX_APPROACH_TIME) {
      ship.attackState = "break";
      ship.breakTimer = MIN_BREAK_TIME;
      ship.approachTimer = 0;
    }
  } else {
    // Break: aim tangent to the target on the chosen side, biased outward,
    // so the fighter banks into a wide curving exit. Velocity follows nose
    // direction (turn-rate-limited), producing a smooth arc.
    const tangX = perp.x * ship.breakSide;
    const tangY = perp.y * ship.breakSide;
    const outX = -dir.x;
    const outY = -dir.y;
    const bx = tangX * 1.0 + outX * 0.5;
    const by = tangY * 1.0 + outY * 0.5;
    const bLen = Math.hypot(bx, by);
    c.thrust = { x: 0, y: 0 };
    c.aim = { x: bx / bLen, y: by / bLen };
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

  // Blend in pack cohesion + big-ship danger over the primary aim.
  // Cohesion is a soft pull toward packmates; danger is a strong push out
  // of broadside arcs. Magnitudes set the relative pull on heading angle.
  const pack = world && world.packs ? world.packs.get(ship.packId) : null;
  const cohesion = packCohesion(ship, pack);
  const danger = bigShipDanger(ship, world ? world.ships : []);
  if (cohesion || danger) {
    const aimN = V.norm(c.aim);
    let ax = aimN.x, ay = aimN.y;
    if (cohesion) { ax += cohesion.x * 0.35; ay += cohesion.y * 0.35; }
    if (danger)   { ax += danger.x   * 1.30; ay += danger.y   * 1.30; }
    c.aim = { x: ax, y: ay };
    // While dodging a broadside arc, stop firing — the nose isn't on target.
    if (danger) c.firing = false;
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
