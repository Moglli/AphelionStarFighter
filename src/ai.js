import * as V from "./vec.js";

const RALLY_ARRIVAL_RADIUS = 220;
const RALLY_ARRIVAL_RADIUS_SQ = RALLY_ARRIVAL_RADIUS * RALLY_ARRIVAL_RADIUS;

function rallyArrived(ship) {
  const t = ship.rallyTarget;
  if (!t) return true;
  const dx = ship.pos.x - t.x;
  const dy = ship.pos.y - t.y;
  return dx * dx + dy * dy <= RALLY_ARRIVAL_RADIUS_SQ;
}

// Steer the ship toward its rally target. Aircraft (fighter/bomber)
// lock velocity to heading, so we only need to set aim. Capitals get
// thrust set directly. Weapons hold fire during transit — the order is
// "move there", not "engage". Once arrived, ai.js restores normal logic.
function applyRally(ship) {
  const c = ship.controller;
  const dx = ship.rallyTarget.x - ship.pos.x;
  const dy = ship.rallyTarget.y - ship.pos.y;
  const d = Math.hypot(dx, dy) || 1;
  const nx = dx / d, ny = dy / d;
  c.aim = { x: nx, y: ny };
  c.thrust = (ship.klass === "fighter" || ship.klass === "bomber")
    ? { x: 0, y: 0 }            // aircraft model carries them forward at maxSpeed
    : { x: nx, y: ny };
  c.firing = false;
  c.firingMissile = false;
}

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

// Bombers hunt the biggest capital they can reach. Stations outrank every
// mobile capital because they're the strategic objective.
function pickBomberTarget(ship, ships) {
  const RANK = { station: 5, battleship: 4, carrier: 3.5, cruiser: 3, frigate: 2 };
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
  // Rally order overrides normal AI: ship heads straight for the
  // designated point, ignoring targets, until it arrives. Restored to
  // normal hunt logic once inside the arrival radius.
  if (ship.rallyTarget) {
    if (rallyArrived(ship)) {
      ship.rallyTarget = null;
    } else {
      applyRally(ship);
      return;
    }
  }

  // Carriers have their own passive routine — no target hunt, no orbit.
  if (ship.klass === "carrier") {
    carrierAI(ship, world);
    applyBeamAvoidance(ship, world);
    return;
  }
  // Station nodes are immobile — they only update aim (slow tracking) so
  // heavy-laser arcs and missile-pod launch geometry follow the action.
  if (ship.klass === "station") {
    stationAI(ship, world);
    return;
  }

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
    applyBeamAvoidance(ship, world);
    return;
  }

  if (ship.klass === "fighter") {
    flybyAI(ship, target, dt, world);
  } else if (ship.klass === "bomber") {
    bomberStandoffAI(ship, target, dt, world);
  } else if (ship.klass === "battleship") {
    battleshipAI(ship, target, dt, world);
  } else {
    orbitAI(ship, target, dt, world);
  }

  // Overlay: dodge enemy heavy-laser beams. Runs after each class's
  // normal steering so the avoidance vector wins in the danger window.
  applyBeamAvoidance(ship, world);
}

// ---------------------------------------------------------------------------
// Beam dodging. Heavy lasers are sustained for ~3 seconds; for that
// window, the line from beam.origin to its tracked target is a hazard
// corridor for any non-friendly ship. We compute a perpendicular escape
// vector when the ship is inside the corridor, then blend it into the
// existing controller — aim for aircraft (heading turns away), thrust
// for capitals (sidestep).
// ---------------------------------------------------------------------------
const BEAM_DANGER_RADIUS = 280;

function beamAvoidance(ship, beams) {
  if (!beams || beams.length === 0) return null;
  let ax = 0, ay = 0;
  let highestUrgency = 0;
  for (const beam of beams) {
    if (beam.side === ship.side) continue;        // friendly beam — ignore
    if (beam.ttl <= 0) continue;
    if (!beam.target || beam.target.dead) continue;
    const ox = beam.origin.x, oy = beam.origin.y;
    const dx = beam.target.pos.x - ox;
    const dy = beam.target.pos.y - oy;
    const blen = Math.hypot(dx, dy);
    if (blen < 1e-6) continue;
    const bx = dx / blen, by = dy / blen;
    // Project ship onto the beam line (axis through origin, direction (bx,by)).
    const relX = ship.pos.x - ox;
    const relY = ship.pos.y - oy;
    const proj = relX * bx + relY * by;
    // Outside the beam's longitudinal range? Not at risk.
    const segLen = Math.min(beam.range, blen + 150);
    if (proj < -50 || proj > segLen) continue;
    const perpX = relX - proj * bx;
    const perpY = relY - proj * by;
    const perpDist = Math.hypot(perpX, perpY);
    if (perpDist > BEAM_DANGER_RADIUS) continue;
    // Closer to the line ⇒ stronger push. Multiply by remaining beam
    // life so a beam about to time out gets less weight.
    const lifeFrac = beam.duration > 0 ? (beam.ttl / beam.duration) : 1;
    const urgency = (1 - perpDist / BEAM_DANGER_RADIUS) * (0.35 + 0.65 * lifeFrac);
    if (urgency > highestUrgency) highestUrgency = urgency;
    if (perpDist < 1e-3) {
      // Sitting on the line — pick the perpendicular side deterministically.
      const sign = (ship.id % 2 === 0) ? 1 : -1;
      ax += -by * urgency * sign;
      ay +=  bx * urgency * sign;
    } else {
      ax += (perpX / perpDist) * urgency;
      ay += (perpY / perpDist) * urgency;
    }
  }
  if (Math.abs(ax) < 1e-6 && Math.abs(ay) < 1e-6) return null;
  const aLen = Math.hypot(ax, ay);
  return { x: ax / aLen, y: ay / aLen, urgency: highestUrgency };
}

function applyBeamAvoidance(ship, world) {
  if (!world || !world.beams) return;
  const avoid = beamAvoidance(ship, world.beams);
  if (!avoid) return;
  const c = ship.controller;
  const u = avoid.urgency;
  // Aircraft (fighter, bomber) turn out of the beam by re-aiming. Strong
  // urgency wholly overrides the previous aim; mild urgency blends.
  if (ship.klass === "fighter" || ship.klass === "bomber") {
    const w = 1.0 + 1.5 * u;
    let ax = (c.aim && (c.aim.x || c.aim.y)) ? c.aim.x : 0;
    let ay = (c.aim && (c.aim.x || c.aim.y)) ? c.aim.y : 0;
    const aLen = Math.hypot(ax, ay) || 1;
    ax /= aLen; ay /= aLen;
    c.aim = { x: ax + avoid.x * w, y: ay + avoid.y * w };
    // Stop dumping fire forward while we duck the beam.
    if (u > 0.5) c.firing = false;
  } else {
    // Capitals add sidestep to their thrust vector. Weighted so even a
    // strafing cruiser tilts away from the beam line.
    const tx = (c.thrust && c.thrust.x) || 0;
    const ty = (c.thrust && c.thrust.y) || 0;
    const w = 1.2 + 1.8 * u;
    const sx = tx + avoid.x * w;
    const sy = ty + avoid.y * w;
    const sLen = Math.hypot(sx, sy);
    c.thrust = sLen > 1 ? { x: sx / sLen, y: sy / sLen } : { x: sx, y: sy };
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
    // Only capitals push each other apart. Small craft pass through.
    if (o.klass === "fighter" || o.klass === "bomber") continue;
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

// Per-class threat scale — small craft treat a battleship as much more
// dangerous than a frigate even before checking specific weapon ranges.
const KLASS_THREAT = {
  battleship: 2.4, carrier: 1.8, station: 2.2,
  cruiser: 1.6, frigate: 1.0, bomber: 0.5,
};
const FORWARD_ARC_COS_WIDE = Math.cos(Math.PI / 3); // 60° half-angle

// Aggregate danger vector for a small craft. Each enemy contributes a
// push proportional to its threat radius (PD, missile pods, heavy laser,
// primary weapon) and weighted by class. Returned as a unit vector —
// the magnitude information is lost on normalization, so the caller has
// to weight the blend. Returns null if no enemy is exerting pressure.
//
// Specifically considered:
//   - PD: radial repulsion (PD fires in all directions). The dominant
//     small-craft threat at short range.
//   - Missile pods: long-range radial repulsion (missiles home).
//   - Heavy laser: forward-cone push perpendicular to the beam axis.
//   - Primary weapon (cannon / barrage): broadside ships get a
//     PREDICTIVE push along the threat's forward axis whenever the
//     small craft is broadly perpendicular, not only once already in
//     the arc — broadside ships are rotating to bring their guns to
//     bear and the small craft has at most a second or two before
//     being in the kill zone. Forward-firing ships push laterally
//     when the craft is in the wider 60° nose arc.
function bigShipDanger(ship, ships) {
  let ax = 0, ay = 0;
  for (const other of ships) {
    if (other.dead || other.side === ship.side) continue;
    if (other.klass === "fighter") continue;
    // Some capitals (cruisers, carriers) carry no primary weapon —
    // their danger is from missiles / laser handled elsewhere, so
    // skip them here rather than crashing on a missing weapon spec.
    if (!other.spec.weapon) continue;
    const range = other.spec.weapon.range;
    if (other === ship) continue;

    const dx = ship.pos.x - other.pos.x;
    const dy = ship.pos.y - other.pos.y;
    const d2 = dx * dx + dy * dy;
    const d = Math.sqrt(d2);
    if (d < 1e-6) continue;
    const toUsX = dx / d, toUsY = dy / d;
    const fwdX = Math.cos(other.heading), fwdY = Math.sin(other.heading);
    const portX = -fwdY, portY = fwdX;
    const klassMul = KLASS_THREAT[other.klass] || 1.0;

    let pushX = 0, pushY = 0;
    const spec = other.spec;

    // 1. PD point-defence — small-craft killer at 380-480 range.
    //    Bias is radial (PD has a 360° arc) with a buffer past the
    //    nominal range so AI starts peeling off BEFORE entering it.
    if (spec.pdCannons) {
      const pdR = spec.pdCannons.range * 1.25;
      if (d < pdR) {
        const u = (1 - d / pdR);
        const w = u * u * 1.5;
        pushX += toUsX * w;
        pushY += toUsY * w;
      }
    }

    // 2. Missile pods — long-range homing. Radial again because they
    //    track. Softer weight than PD since flares / dodging works.
    if (spec.missilePods) {
      const mR = spec.missilePods.range;
      if (d < mR) {
        const u = 1 - d / mR;
        pushX += toUsX * u * 0.55;
        pushY += toUsY * u * 0.55;
      }
    }

    // 3. Heavy laser — instant hit, fatal damage. Push perpendicular
    //    if we're in its forward firing arc.
    if (spec.heavyLaser) {
      const lR = spec.heavyLaser.range;
      if (d < lR) {
        const arc = spec.heavyLaser.arc || Math.PI * 0.55;
        const arcCos = Math.cos(arc);
        if (toUsX * fwdX + toUsY * fwdY > arcCos) {
          const u = 1 - d / lR;
          const portDot = toUsX * portX + toUsY * portY;
          const sign = portDot >= 0 ? 1 : -1;
          pushX += sign * portX * u * 1.6;
          pushY += sign * portY * u * 1.6;
        }
      }
    }

    // 4. Primary cannon / barrage. Only present on ships with a real
    //    weapon (carriers and stations may have none).
    const w = spec.weapon;
    if (w && w.range && d < w.range) {
      const u = 1 - d / w.range;
      if (spec.firingMode === "broadside") {
        // Broadside ships rotate to bring beams onto a target. Push
        // along their forward axis whenever the small craft is roughly
        // perpendicular — get to the bow or stern, not the broadside.
        const arcCos = Math.cos(spec.broadsideArc || Math.PI / 4);
        const stbdX = fwdY, stbdY = -fwdX;
        const portDot = toUsX * portX + toUsY * portY;
        const stbdDot = toUsX * stbdX + toUsY * stbdY;
        const lateralExposure = Math.max(Math.abs(portDot), Math.abs(stbdDot));
        const inArc = portDot >= arcCos || stbdDot >= arcCos;
        if (lateralExposure > 0.25 || inArc) {
          // Sign: shove toward the closer fore/aft cap.
          const myFwdX = Math.cos(ship.heading), myFwdY = Math.sin(ship.heading);
          const dotF = myFwdX * fwdX + myFwdY * fwdY;
          const sign = dotF >= 0 ? 1 : -1;
          const boost = inArc ? 2.0 : 0.7; // hard push if already in arc
          pushX += sign * fwdX * u * boost;
          pushY += sign * fwdY * u * boost;
        }
      } else if (spec.firingMode === "forward") {
        // 60° half-cone — wider than the old 45° check, since forward
        // ships also rotate to track and there's no benefit to lingering
        // in the cone.
        if (toUsX * fwdX + toUsY * fwdY > FORWARD_ARC_COS_WIDE) {
          const portDot = toUsX * portX + toUsY * portY;
          const sign = portDot >= 0 ? 1 : -1;
          pushX += sign * portX * u * 1.3;
          pushY += sign * portY * u * 1.3;
        }
      }
    }

    ax += pushX * klassMul;
    ay += pushY * klassMul;
  }
  const aLen = Math.hypot(ax, ay);
  if (aLen < 1e-6) return null;
  return { x: ax / aLen, y: ay / aLen };
}

// Quick query: is `ship` inside ANY enemy capital's PD bubble (with a
// buffer)? Used by fighters to force a break-off when they've drifted
// too deep into PD range, and by bombers to suppress gun runs that
// would commit them to lethal proximity.
function insideEnemyPDRange(ship, ships) {
  for (const other of ships) {
    if (other.dead || other.side === ship.side) continue;
    if (!other.spec.pdCannons) continue;
    const r = other.spec.pdCannons.range * 1.1;
    const dx = other.pos.x - ship.pos.x;
    const dy = other.pos.y - ship.pos.y;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
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

  // Regroup distance pushed out so the break-off actually clears the
  // capital's PD bubble (max PD range ~480) and a chunk of broadside
  // engagement. Pass-zone widened correspondingly.
  const REGROUP_DIST = 950;
  const PASS_ZONE_DIST = 600;
  const MIN_BREAK_TIME = 1.2;
  const MAX_APPROACH_TIME = 10;

  const inPdZone = insideEnemyPDRange(ship, world ? world.ships : []);

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
    // Force break-off if we've drifted into PD range — we either fired
    // and are now in lethal proximity, or we never had a shot lined up
    // and there's no point staying.
    if ((departing && inPassZone && settled)
        || ship.approachTimer > MAX_APPROACH_TIME
        || (inPdZone && settled)) {
      ship.attackState = "break";
      ship.breakTimer = MIN_BREAK_TIME;
      ship.approachTimer = 0;
    }
  } else {
    const tangX = perp.x * ship.breakSide;
    const tangY = perp.y * ship.breakSide;
    const outX = -dir.x;
    const outY = -dir.y;
    const bx = tangX * 1.0 + outX * 0.7;
    const by = tangY * 1.0 + outY * 0.7;
    const bLen = Math.hypot(bx, by);
    c.thrust = { x: 0, y: 0 };
    c.aim = { x: bx / bLen, y: by / bLen };
    c.firing = false;

    ship.breakTimer -= dt;
    const minTimeMet = ship.breakTimer <= 0;
    const farEnough = dist > REGROUP_DIST && !inPdZone;
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
    // Avoidance weight is high because heading-locked fighters can't
    // strafe — turning IS dodging, and slow turn-rate means we need
    // sharp commit to actually get out of the kill zone in time.
    if (danger)   { ax += danger.x   * 1.95; ay += danger.y   * 1.95; }
    if (tail)     { ax += tail.x     * 0.80; ay += tail.y     * 0.80; }
    c.aim = { x: ax, y: ay };
    // Suppress firing when avoiding heavy fire. Bombers' missile pods
    // auto-fire elsewhere — they keep delivering payload while running.
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
// Bomber behaviour: standoff orbit at the outer edge of missile-pod
// range. Pods auto-fire on any target inside acquireRange (see
// updateMissilePodFire in ship.js), so the bomber can deliver its full
// payload without committing to a fly-through that would put it inside
// enemy PD bubbles and primary-weapon arcs. Heading-locked flight
// model still applies: the bomber points along an orbit tangent
// in the sweet spot, retreats if it drifts inside the standoff band,
// closes if too far. Threat avoidance overrides the orbit when any
// heavy ship's weapon envelope creeps onto the bomber.
// ---------------------------------------------------------------------------
function bomberStandoffAI(ship, target, dt, world) {
  const c = ship.controller;
  const s = ship.spec;

  const rel = V.sub(target.pos, ship.pos);
  const dist = V.len(rel);
  const dir = dist > 1e-6 ? { x: rel.x / dist, y: rel.y / dist } : { x: 1, y: 0 };
  const perp = { x: -dir.y, y: dir.x };

  // Pod range is the upper bound — sit just inside it so missiles
  // can lock but the bomber stays clear of enemy guns.
  const pods = s.missilePods;
  const podRange = pods ? pods.range : 1700;
  const STANDOFF = Math.min(podRange * 0.92, 1600);
  const DEAD_BAND = 200;

  let aim;
  if (dist > STANDOFF + DEAD_BAND) {
    aim = dir; // close
  } else if (dist < STANDOFF - DEAD_BAND) {
    aim = { x: -dir.x, y: -dir.y }; // back off
  } else {
    // Sweet spot — orbit tangentially. Use ship-id parity for a
    // consistent direction so the bomber doesn't oscillate.
    const orbitSign = (ship.id % 2 === 0) ? 1 : -1;
    aim = { x: perp.x * orbitSign, y: perp.y * orbitSign };
  }

  c.thrust = { x: 0, y: 0 };
  c.aim = aim;

  // Bombers' light gun has range ~600 — way inside enemy primary
  // weapon envelopes. Fire it only when nose-on AND in range AND not
  // sitting inside any PD bubble. In standoff this almost never
  // triggers, which is fine: the auto-firing pods are the real damage.
  const fwd = { x: Math.cos(ship.heading), y: Math.sin(ship.heading) };
  const aimNorm = V.norm(aim);
  const aligned = V.dot(fwd, aimNorm);
  const inPd = insideEnemyPDRange(ship, world ? world.ships : []);
  c.firing = !inPd && dist <= s.weapon.range && aligned > 0.85
          && V.dot(fwd, dir) > 0.7;
  c.firingMissile = false;

  // Threat avoidance — same blend as fighter, but the avoidance weight
  // is even higher because bombers are slower, sluggish to turn, and
  // expensive to lose.
  const pack = world && world.packs ? world.packs.get(ship.packId) : null;
  const cohesion = packCohesion(ship, pack);
  const danger = bigShipDanger(ship, world ? world.ships : []);
  const tail = tailDanger(ship, world ? world.ships : []);
  if (cohesion || danger || tail) {
    const aimN = V.norm(c.aim);
    let ax = aimN.x, ay = aimN.y;
    if (cohesion) { ax += cohesion.x * 0.30; ay += cohesion.y * 0.30; }
    if (danger)   { ax += danger.x   * 2.20; ay += danger.y   * 2.20; }
    if (tail)     { ax += tail.x     * 0.80; ay += tail.y     * 0.80; }
    c.aim = { x: ax, y: ay };
    if (danger) c.firing = false;
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
// Frigate / cruiser: forward-firing capitals are on the fighter-flight
// model now (velocity locked to heading), so the old "stop in the orbit
// band and strafe" plan made them ram. They now use a flyby pattern —
// approach with lead aim, then break to one side when they pass through
// or run out the approach timer — tuned with longer windows than
// fighters to account for slow turn rates. Broadside hulls (battleship)
// keep their dedicated AI branch; this function only handles
// forward-firing capitals.
// ---------------------------------------------------------------------------
function orbitAI(ship, target, dt, world) {
  const c = ship.controller;
  const s = ship.spec;
  const rel = V.sub(target.pos, ship.pos);
  const dist = V.len(rel);
  const dir = dist > 1e-6 ? { x: rel.x / dist, y: rel.y / dist } : { x: 1, y: 0 };
  const isBroadside = s.firingMode === "broadside";

  if (isBroadside) {
    // Broadside ship — aim perpendicular so velocity (locked to heading)
    // strafes alongside the target instead of into it.
    const sep = capitalSeparation(ship, world ? world.ships : []);
    let thrust = { x: -dir.y, y: dir.x };
    thrust = blendThrustWithSeparation(thrust, sep, 1.1);
    c.thrust = thrust;
    const perpA = { x: -dir.y, y: dir.x };
    const perpB = { x: dir.y, y: -dir.x };
    const fwd = { x: Math.cos(ship.heading), y: Math.sin(ship.heading) };
    c.aim = V.dot(fwd, perpA) >= V.dot(fwd, perpB) ? perpA : perpB;
    c.firing = true;
    c.firingMissile = false;
    return;
  } else if (s.weapon) {
    const leadVec = leadAim(ship, target, s.weapon.projectileSpeed);
    c.aim = leadVec;
    const fwd = { x: Math.cos(ship.heading), y: Math.sin(ship.heading) };
    const aimNorm = V.norm(leadVec);
    const aligned = V.dot(fwd, aimNorm);
    c.firing = dist <= s.weapon.range && aligned > 0.9;
  } else {
    // No primary cannon (artillery cruiser). Just face the target so
    // bow-mount weapons (heavy laser, missile pods, siege missile)
    // align on it. Missile / laser fire is handled inside updateShip.
    c.aim = { x: rel.x, y: rel.y };
    c.firing = false;
  }

  // Forward-firing flyby pattern. Init state once.
  if (ship.attackState === undefined) {
    ship.attackState = "approach";
    ship.breakSide = (ship.id % 2 === 0) ? 1 : -1;
    ship.breakTimer = 0;
    ship.approachTimer = 0;
  }

  // Tuned for slower capitals — much longer cycles than fighters.
  const REGROUP_DIST = Math.max(1400, s.aiOrbit * 1.3);
  const PASS_ZONE_DIST = Math.max(700, s.radius * 6);
  const MIN_BREAK_TIME = 4.0;
  const MAX_APPROACH_TIME = 24;

  // Lead-aim toward the target's predicted position; in break mode swing
  // aim hard to the side so the ship peels off instead of ramming.
  const leadVec = leadAim(ship, target, s.weapon.projectileSpeed);
  const fwd = { x: Math.cos(ship.heading), y: Math.sin(ship.heading) };

  if (ship.attackState === "approach") {
    ship.approachTimer += dt;
    c.thrust = { x: 0, y: 0 }; // ignored under fighter flight model
    c.aim = leadVec;
    const aimNorm = V.norm(leadVec);
    const aligned = V.dot(fwd, aimNorm);
    c.firing = dist <= s.weapon.range && aligned > 0.88;

    const departing = (rel.x * ship.vel.x + rel.y * ship.vel.y) < 0;
    const inPassZone = dist < PASS_ZONE_DIST;
    const settled = ship.approachTimer > 1.5;
    if ((departing && inPassZone && settled) || ship.approachTimer > MAX_APPROACH_TIME) {
      ship.attackState = "break";
      ship.breakTimer = MIN_BREAK_TIME;
      ship.approachTimer = 0;
    }
  } else {
    // Break: aim perpendicular to the threat axis with a small "away"
    // bias so the capital drifts out instead of orbiting back through.
    const tangX = -dir.y * ship.breakSide;
    const tangY =  dir.x * ship.breakSide;
    const outX = -dir.x;
    const outY = -dir.y;
    const bx = tangX * 1.0 + outX * 0.35;
    const by = tangY * 1.0 + outY * 0.35;
    const bLen = Math.hypot(bx, by) || 1;
    c.thrust = { x: 0, y: 0 };
    c.aim = { x: bx / bLen, y: by / bLen };
    c.firing = false;

    ship.breakTimer -= dt;
    const minTimeMet = ship.breakTimer <= 0;
    const farEnough = dist > REGROUP_DIST;
    const breakOverdue = ship.breakTimer <= -5.0;
    if ((minTimeMet && farEnough) || breakOverdue) {
      ship.attackState = "approach";
      ship.breakSide = -ship.breakSide;
      ship.approachTimer = 0;
    }
  }

  // Push aim further off-axis when a friendly capital sits on the same
  // line — keeps frigates from stacking noses into the same target.
  const sep = capitalSeparation(ship, world ? world.ships : []);
  if (sep) {
    const aimN = V.norm(c.aim);
    c.aim = {
      x: aimN.x + sep.x * 0.5,
      y: aimN.y + sep.y * 0.5,
    };
  }
}

// ---------------------------------------------------------------------------
// Carrier behaviour: no offensive weapons, no target hunt. Faces the action
// so the PD wall covers the threat axis, retreats from approaching enemy
// capitals, and stays out of friendly capitals' way via separation.
// ---------------------------------------------------------------------------
function carrierAI(ship, world) {
  const c = ship.controller;
  c.firing = false;
  c.firingMissile = false;

  // Face the nearest enemy so PD turrets get usable target geometry.
  const enemy = nearestEnemy(ship, world.ships);
  c.aim = enemy
    ? { x: enemy.pos.x - ship.pos.x, y: enemy.pos.y - ship.pos.y }
    : null;

  // Retreat from approaching enemy capitals. Small craft are PD's job.
  let threat = null, threatD2 = Infinity;
  for (const o of world.ships) {
    if (o.dead || o.side === ship.side) continue;
    if (o.klass === "fighter" || o.klass === "bomber") continue;
    const dx = o.pos.x - ship.pos.x;
    const dy = o.pos.y - ship.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < threatD2) { threatD2 = d2; threat = o; }
  }
  let thrust = { x: 0, y: 0 };
  if (threat) {
    const SAFE_DIST = 1500;
    const d = Math.sqrt(threatD2);
    if (d > 1e-6 && d < SAFE_DIST) {
      thrust = {
        x: (ship.pos.x - threat.pos.x) / d,
        y: (ship.pos.y - threat.pos.y) / d,
      };
    }
  }
  const sep = capitalSeparation(ship, world.ships);
  thrust = blendThrustWithSeparation(thrust, sep, 1.1);
  c.thrust = thrust;
}

// ---------------------------------------------------------------------------
// Station nodes: immobile, no thrust. Heading rotates slowly (per the
// class's small turnRate) to keep heavy-laser arcs and missile-pod launch
// geometry pointed at the nearest threat.
// ---------------------------------------------------------------------------
function stationAI(ship, world) {
  const c = ship.controller;
  c.thrust = { x: 0, y: 0 };
  c.firing = false;
  c.firingMissile = false;
  const enemy = nearestEnemy(ship, world.ships);
  c.aim = enemy
    ? { x: enemy.pos.x - ship.pos.x, y: enemy.pos.y - ship.pos.y }
    : null;
}
