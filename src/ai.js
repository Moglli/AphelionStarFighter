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

// Find nearest enemy battleship — battleships prioritise dueling each other.
function nearestEnemyBattleship(ship, ships) {
  let best = null, bestD2 = Infinity;
  for (const other of ships) {
    if (other.dead || other.side === ship.side) continue;
    if (other.klass !== "battleship") continue;
    const dx = other.pos.x - ship.pos.x;
    const dy = other.pos.y - ship.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = other; }
  }
  return best;
}

function nearestEnemyOfClass(ship, ships, klass) {
  let best = null, bestD2 = Infinity;
  for (const other of ships) {
    if (other.dead || other.side === ship.side) continue;
    if (other.klass !== klass) continue;
    const dx = other.pos.x - ship.pos.x;
    const dy = other.pos.y - ship.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = other; }
  }
  return best;
}

// Bombers hunt the biggest capital they can reach: battleship > cruiser >
// frigate. Other small craft are ignored as targets.
function pickBomberTarget(ship, ships) {
  const RANK = { battleship: 4, cruiser: 3, frigate: 2 };
  let best = null, bestRank = -1, bestD2 = Infinity;
  for (const o of ships) {
    if (o.dead || o.side === ship.side) continue;
    const rank = RANK[o.klass] || 0;
    if (rank === 0) continue;
    const dx = o.pos.x - ship.pos.x;
    const dy = o.pos.y - ship.pos.y;
    const d2 = dx * dx + dy * dy;
    if (rank > bestRank || (rank === bestRank && d2 < bestD2)) {
      bestRank = rank; bestD2 = d2; best = o;
    }
  }
  return best;
}

export function updateAI(ship, world, dt) {
  const c = ship.controller;

  // Battleships duel each other; bombers hunt capitals.
  let target = null;
  if (ship.klass === "battleship") {
    target = nearestEnemyBattleship(ship, world.ships);
  } else if (ship.klass === "bomber") {
    target = pickBomberTarget(ship, world.ships);
  }

  // Fighters peel off everything else when a bomber is on the field —
  // checked before pack target so even role-locked packs divert to
  // intercept the bigger threat.
  if (!target && ship.klass === "fighter") {
    const bomber = nearestEnemyOfClass(ship, world.ships, "bomber");
    if (bomber) target = bomber;
  }

  // Packed fighters share their pack's target so a pack engages as a wing.
  // (The pack target picker also prefers bombers — see game.js.)
  if (!target && ship.packId != null && world.packs) {
    const pack = world.packs.get(ship.packId);
    if (pack && pack.target && !pack.target.dead) target = pack.target;
  }
  if (!target) target = nearestEnemy(ship, world.ships);

  if (!target) {
    c.thrust = { x: 0, y: 0 };
    c.aim = null;
    c.firing = false;
    c.firingMissile = false;
    return;
  }

  if (ship.klass === "fighter" || ship.klass === "bomber") {
    flybyAI(ship, target, dt, world);
  } else if (ship.klass === "battleship") {
    battleshipAI(ship, target, dt, world);
  } else {
    orbitAI(ship, target, dt, world);
  }
}

// Steering force that pushes a capital ship away from any other capital it
// is getting too close to (friendly or enemy). Buffer is just the hulls
// plus a small margin, so engagement at orbit ranges is unaffected; only
// near-collisions are nudged apart.
function capitalSeparation(ship, ships) {
  let ax = 0, ay = 0;
  const myR = ship.spec.radius;
  for (const o of ships) {
    if (o.dead || o === ship) continue;
    if (o.klass === "fighter") continue;
    const dx = ship.pos.x - o.pos.x;
    const dy = ship.pos.y - o.pos.y;
    const sep = myR + o.spec.radius + 90;
    const d2 = dx * dx + dy * dy;
    if (d2 > sep * sep || d2 < 1e-6) continue;
    const d = Math.sqrt(d2);
    const strength = 1 - d / sep;
    ax += (dx / d) * strength;
    ay += (dy / d) * strength;
  }
  if (Math.abs(ax) < 1e-6 && Math.abs(ay) < 1e-6) return null;
  return { x: ax, y: ay };
}

function blendThrustWithSeparation(thrust, sep, weight) {
  if (!sep) return thrust;
  const tx = thrust.x + sep.x * weight;
  const ty = thrust.y + sep.y * weight;
  const l = Math.hypot(tx, ty);
  if (l <= 1e-6) return { x: 0, y: 0 };
  // Re-normalize so thrust magnitude doesn't exceed 1 (which would clip
  // back to maxSpeed inside the ship update anyway).
  return l > 1 ? { x: tx / l, y: ty / l } : { x: tx, y: ty };
}

// ---------------------------------------------------------------------------
// Pack cohesion / threat avoidance helpers (unchanged behaviour).
// ---------------------------------------------------------------------------
function packCohesion(ship, pack) {
  if (!pack || !pack.center) return null;
  const dx = pack.center.x - ship.pos.x;
  const dy = pack.center.y - ship.pos.y;
  const d = Math.hypot(dx, dy);
  const THRESHOLD = 300;
  if (d <= THRESHOLD || d < 1e-6) return null;
  return { x: dx / d, y: dy / d };
}

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
    const urgency = 1 - d / range;

    if (other.spec.firingMode === "broadside") {
      const arcCos = Math.cos(other.spec.broadsideArc || Math.PI / 4);
      const stbdX = fwdY, stbdY = -fwdX;
      const portDot = toUsX * portX + toUsY * portY;
      const stbdDot = toUsX * stbdX + toUsY * stbdY;
      if (portDot < arcCos && stbdDot < arcCos) continue;
      const myFwdX = Math.cos(ship.heading), myFwdY = Math.sin(ship.heading);
      const dotF = myFwdX * fwdX + myFwdY * fwdY;
      const sign = dotF >= 0 ? 1 : -1;
      ax += sign * fwdX * urgency;
      ay += sign * fwdY * urgency;
    } else {
      if (toUsX * fwdX + toUsY * fwdY < FORWARD_ARC_COS) continue;
      const portDot = toUsX * portX + toUsY * portY;
      const sign = portDot >= 0 ? 1 : -1;
      ax += sign * portX * urgency;
      ay += sign * portY * urgency;
    }
  }
  const aLen = Math.hypot(ax, ay);
  if (aLen < 1e-6) return null;
  return { x: ax / aLen, y: ay / aLen };
}

function tailDanger(ship, ships) {
  let ax = 0, ay = 0;
  const myFwdX = Math.cos(ship.heading), myFwdY = Math.sin(ship.heading);
  const TAIL_RANGE = 450;
  for (const other of ships) {
    if (other.dead || other.side === ship.side) continue;
    if (other.klass !== "fighter") continue;
    const dx = ship.pos.x - other.pos.x;
    const dy = ship.pos.y - other.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > TAIL_RANGE * TAIL_RANGE) continue;
    const d = Math.sqrt(d2);
    if (d < 1e-6) continue;
    const toUsX = dx / d, toUsY = dy / d;
    const otherFwdX = Math.cos(other.heading), otherFwdY = Math.sin(other.heading);
    if (toUsX * otherFwdX + toUsY * otherFwdY < 0.85) continue;
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

// ---------------------------------------------------------------------------
// Fighter behaviour.
// ---------------------------------------------------------------------------
function flybyAI(ship, target, dt, world) {
  const c = ship.controller;
  const s = ship.spec;

  if (ship.attackState === undefined) {
    ship.attackState = "approach";
    ship.breakSide = (ship.id % 2 === 0) ? 1 : -1;
    ship.breakTimer = 0;
    ship.approachTimer = 0;
  }

  const rel = V.sub(target.pos, ship.pos);
  const dist = V.len(rel);
  const dir = dist > 1e-6 ? { x: rel.x / dist, y: rel.y / dist } : { x: 1, y: 0 };
  const perp = { x: -dir.y, y: dir.x };

  const REGROUP_DIST = 600;
  const PASS_ZONE_DIST = 500;
  const MIN_BREAK_TIME = 1.2;
  const MAX_APPROACH_TIME = 12;

  if (ship.attackState === "approach") {
    ship.approachTimer += dt;
    const leadVec = leadAim(ship, target, s.weapon.projectileSpeed);
    c.thrust = { x: 0, y: 0 };
    c.aim = leadVec;
    const fwd = { x: Math.cos(ship.heading), y: Math.sin(ship.heading) };
    const aimNorm = V.norm(leadVec);
    const aligned = V.dot(fwd, aimNorm);
    c.firing = dist <= s.weapon.range && aligned > 0.92;

    const departing = (rel.x * ship.vel.x + rel.y * ship.vel.y) < 0;
    const inPassZone = dist < PASS_ZONE_DIST;
    const settled = ship.approachTimer > 0.5;
    if ((departing && inPassZone && settled) || ship.approachTimer > MAX_APPROACH_TIME) {
      ship.attackState = "break";
      ship.breakTimer = MIN_BREAK_TIME;
      ship.approachTimer = 0;
    }
  } else {
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
    const breakOverdue = ship.breakTimer <= -3.0;
    if ((minTimeMet && farEnough) || breakOverdue) {
      ship.attackState = "approach";
      ship.breakSide = -ship.breakSide;
      ship.approachTimer = 0;
    }
  }

  const pack = world && world.packs ? world.packs.get(ship.packId) : null;
  const cohesion = packCohesion(ship, pack);
  const danger = bigShipDanger(ship, world ? world.ships : []);
  const tail = tailDanger(ship, world ? world.ships : []);
  if (cohesion || danger || tail) {
    const aimN = V.norm(c.aim);
    let ax = aimN.x, ay = aimN.y;
    if (cohesion) { ax += cohesion.x * 0.35; ay += cohesion.y * 0.35; }
    if (danger)   { ax += danger.x   * 1.30; ay += danger.y   * 1.30; }
    if (tail)     { ax += tail.x     * 0.80; ay += tail.y     * 0.80; }
    c.aim = { x: ax, y: ay };
    if (danger) c.firing = false;
  }

  // AI-fired missile: launch at fat targets when the cooldowns are ready,
  // we're roughly nose-on, and the target is large enough to be worth one.
  c.firingMissile = false;
  if (s.missile && ship.missileCd <= 0 && ship.aiMissileCd <= 0) {
    const worthIt = (target.klass !== "fighter") || (target.spec.radius >= 40);
    if (worthIt && dist < s.missile.acquireRange * 0.9) {
      const fwd = { x: Math.cos(ship.heading), y: Math.sin(ship.heading) };
      const aimedAtTarget = (dir.x * fwd.x + dir.y * fwd.y) > 0.7;
      if (aimedAtTarget) {
        c.firingMissile = true;
        ship.aiMissileCd = s.aiMissileCooldown || s.missile.cooldown;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Battleship behaviour: rush enemy battleships nose-first; only turn to
// broadside once within barrage range.
// ---------------------------------------------------------------------------
function battleshipAI(ship, target, dt, world) {
  const c = ship.controller;
  const s = ship.spec;
  const rel = V.sub(target.pos, ship.pos);
  const dist = V.len(rel);
  const dir = dist > 1e-6 ? { x: rel.x / dist, y: rel.y / dist } : { x: 1, y: 0 };

  const barrageRange = s.weapon.range;
  const ENGAGE_DIST = barrageRange * 0.85;
  if (ship.battleshipMode === undefined) ship.battleshipMode = "rush";
  if (ship.battleshipMode === "rush" && dist <= ENGAGE_DIST) {
    ship.battleshipMode = "broadside";
  } else if (ship.battleshipMode === "broadside" && dist > barrageRange * 1.05) {
    ship.battleshipMode = "rush";
  }

  const sep = capitalSeparation(ship, world ? world.ships : []);

  if (ship.battleshipMode === "rush") {
    let thrust = { x: dir.x, y: dir.y };
    // Separation has a hard floor under rush — we still want to close the
    // distance, but not by ramming a friendly battleship along the way.
    thrust = blendThrustWithSeparation(thrust, sep, 0.9);
    c.thrust = thrust;
    c.aim = { x: rel.x, y: rel.y };
    c.firing = true;
    c.firingMissile = false;
    return;
  }

  const orbit = s.aiOrbit;
  let thrust;
  if (dist > orbit * 1.15) {
    thrust = dir;
  } else if (dist < orbit * 0.85) {
    thrust = { x: -dir.x, y: -dir.y };
  } else {
    const sign = (ship.id % 2 === 0) ? 1 : -1;
    thrust = { x: -dir.y * sign, y: dir.x * sign };
  }
  thrust = blendThrustWithSeparation(thrust, sep, 1.1);
  c.thrust = thrust;

  const perpA = { x: -dir.y, y: dir.x };
  const perpB = { x: dir.y, y: -dir.x };
  const fwd = { x: Math.cos(ship.heading), y: Math.sin(ship.heading) };
  c.aim = V.dot(fwd, perpA) >= V.dot(fwd, perpB) ? perpA : perpB;
  c.firing = true;
  c.firingMissile = false;
}

// ---------------------------------------------------------------------------
// Frigate / cruiser: orbit at preferred range. Heavy hulls hold position when
// in the orbit band; lighter and broadside hulls strafe.
// ---------------------------------------------------------------------------
function orbitAI(ship, target, dt, world) {
  const c = ship.controller;
  const s = ship.spec;
  const rel = V.sub(target.pos, ship.pos);
  const dist = V.len(rel);
  const dir = dist > 1e-6 ? { x: rel.x / dist, y: rel.y / dist } : { x: 1, y: 0 };
  const isBroadside = s.firingMode === "broadside";

  const orbit = s.aiOrbit;
  let thrust;
  if (dist > orbit * 1.15) {
    thrust = dir;
  } else if (dist < orbit * 0.85) {
    thrust = { x: -dir.x, y: -dir.y };
  } else {
    const shouldStrafe = isBroadside || ship.klass === "frigate";
    if (shouldStrafe) {
      const sign = (ship.id % 2 === 0) ? 1 : -1;
      thrust = { x: -dir.y * sign, y: dir.x * sign };
    } else {
      thrust = { x: 0, y: 0 };
    }
  }
  // Capitals nudge apart from each other so they don't clump on the same
  // target and ram hulls.
  const sep = capitalSeparation(ship, world ? world.ships : []);
  thrust = blendThrustWithSeparation(thrust, sep, 1.1);
  c.thrust = thrust;

  if (isBroadside) {
    const perpA = { x: -dir.y, y: dir.x };
    const perpB = { x: dir.y, y: -dir.x };
    const fwd = { x: Math.cos(ship.heading), y: Math.sin(ship.heading) };
    c.aim = V.dot(fwd, perpA) >= V.dot(fwd, perpB) ? perpA : perpB;
    c.firing = true;
  } else {
    const leadVec = leadAim(ship, target, s.weapon.projectileSpeed);
    c.aim = leadVec;
    const fwd = { x: Math.cos(ship.heading), y: Math.sin(ship.heading) };
    const aimNorm = V.norm(leadVec);
    const aligned = V.dot(fwd, aimNorm);
    c.firing = dist <= s.weapon.range && aligned > 0.9;
  }

  c.firingMissile = false;
}
