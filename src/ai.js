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
  // Carriers have their own passive routine — no target hunt, no orbit.
  if (ship.klass === "carrier") {
    carrierAI(ship, world);
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
    return;
  }

  if (ship.klass === "fighter") {
    flybyAI(ship, target, dt, world);
  } else if (ship.klass === "bomber") {
    bomberFlankAI(ship, target, dt, world);
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
// `excludeTarget` is the ship the caller is *trying* to attack — it must
// not contribute to its own avoidance push, otherwise the attacker arcs
// wide instead of committing. Other capitals nearby still apply normally.
function bigShipDanger(ship, ships, excludeTarget = null) {
  let ax = 0, ay = 0;
  for (const other of ships) {
    if (other.dead || other.side === ship.side) continue;
    if (other.klass === "fighter") continue;
    if (other === ship) continue;
    if (other === excludeTarget) continue;

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
// Wall-avoidance steering. Heading-locked classes (fighter / bomber)
// can't strafe away from a wall they've drifted into — the boundary
// clamp in ship.js just zeroes the velocity component pushing into
// the wall, so they end up sliding along it ("hugging") until the AI
// happens to point them somewhere else.
//
// Returns a normalised vector pointing back toward the centre of the
// arena, weighted by proximity to each wall, or null when the ship
// has plenty of clearance. The caller blends this into c.aim so the
// nose actively turns away from the wall.
function wallAvoidance(ship, bounds) {
  if (!bounds) return null;
  const s = ship.spec;
  // Engage well before the ship reaches the clamp distance so the
  // slow turn rate has time to bring the nose around. A fighter
  // moving 380 px/s with a ~3 rad/s turn rate clears ~125 px during
  // a 90-degree pivot; pad to ~3x ship.radius so the avoidance
  // overlap region is generous.
  const pad = Math.max(180, s.radius * 6);
  let nx = 0, ny = 0;
  // Each wall contributes a vector pointing inward with magnitude
  // proportional to how close we are. Closer = stronger pull.
  const dxMin = ship.pos.x - bounds.minX;
  const dxMax = bounds.maxX - ship.pos.x;
  const dyMin = ship.pos.y - bounds.minY;
  const dyMax = bounds.maxY - ship.pos.y;
  if (dxMin < pad) nx += (pad - dxMin) / pad;       // push +x (right)
  if (dxMax < pad) nx -= (pad - dxMax) / pad;       // push -x (left)
  if (dyMin < pad) ny += (pad - dyMin) / pad;       // push +y (down)
  if (dyMax < pad) ny -= (pad - dyMax) / pad;       // push -y (up)
  const len = Math.hypot(nx, ny);
  if (len < 0.05) return null;
  // Return a steering vector whose magnitude reflects the worst-case
  // proximity so flybyAI can scale the blend weight to match how
  // pinned the ship is.
  return { x: nx / len, y: ny / len, strength: Math.min(1, len) };
}

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
  // engagement. Pass-zone widened correspondingly. MAX_APPROACH_TIME is
  // intentionally long: fighters should commit to the attack run rather
  // than peel off after a few seconds. The break-off still triggers
  // naturally on a fly-through, this is just the safety timeout.
  const REGROUP_DIST = 850;
  const PASS_ZONE_DIST = 600;
  const MIN_BREAK_TIME = 1.0;
  const MAX_APPROACH_TIME = 16;

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
    // Break off only when we've actually flown past the target, or as a
    // safety timeout. PD exposure used to force a break too, but that's
    // what made fighters spend most of their lives circling instead of
    // pressing the attack — shields can soak a pass through PD.
    if ((departing && inPassZone && settled)
        || ship.approachTimer > MAX_APPROACH_TIME) {
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
    const farEnough = dist > REGROUP_DIST;
    const breakOverdue = ship.breakTimer <= -2.0;
    if ((minTimeMet && farEnough) || breakOverdue) {
      ship.attackState = "approach";
      ship.breakSide = -ship.breakSide;
      ship.approachTimer = 0;
    }
  }

  const pack = world && world.packs ? world.packs.get(ship.packId) : null;
  const cohesion = packCohesion(ship, pack);
  // Exclude the current target from danger: a fighter committing to a run
  // on a battleship shouldn't be pushed back out by that same battleship's
  // PD/laser envelope. Other capitals nearby still push normally.
  const danger = bigShipDanger(ship, world ? world.ships : [], target);
  const tail = tailDanger(ship, world ? world.ships : []);
  const wall = wallAvoidance(ship, world && world.arena ? world.arena.bounds : null);
  if (cohesion || danger || tail || wall) {
    const aimN = V.norm(c.aim);
    let ax = aimN.x, ay = aimN.y;
    if (cohesion) { ax += cohesion.x * 0.35; ay += cohesion.y * 0.35; }
    // Avoidance weight dialled way down: fighters were spending most of
    // their lives swinging wide of every capital, never engaging. Other
    // capitals (not the target) still push, just gently.
    if (danger)   { ax += danger.x   * 0.55; ay += danger.y   * 0.55; }
    if (tail)     { ax += tail.x     * 0.80; ay += tail.y     * 0.80; }
    // Wall avoidance dominates when the ship is close to a boundary.
    // Strength is the worst-case proximity (0..1); we scale it up so
    // a pinned fighter snaps the nose inward instead of sliding along.
    if (wall)     {
      const w = 2.2 * wall.strength;
      ax += wall.x * w;
      ay += wall.y * w;
    }
    c.aim = { x: ax, y: ay };
    // Used to clear c.firing whenever any danger was present, but that
    // left fighters silently coasting through firing solutions on the
    // very capital they were attacking. Approach-state already gates
    // firing on alignment + range; break-state already cleared c.firing
    // above. No extra suppression needed here.
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
// Bomber behaviour: flank the target instead of holding standoff dead
// ahead. The bomber picks a side relative to the target's current facing
// (ID-parity for consistency) and aims for a slot offset perpendicular
// to the target's nose — so the strike comes in from the broadside, not
// down the target's gun arc. Pods auto-fire on any target inside
// acquireRange (see updateMissilePodFire in ship.js), so the flank
// approach still delivers full payload. Once in the flank slot, the
// bomber faces the target so its forward gun + pod launch geometry can
// engage.
// ---------------------------------------------------------------------------
function bomberFlankAI(ship, target, dt, world) {
  const c = ship.controller;
  const s = ship.spec;

  const rel = V.sub(target.pos, ship.pos);
  const dist = V.len(rel);
  const dir = dist > 1e-6 ? { x: rel.x / dist, y: rel.y / dist } : { x: 1, y: 0 };

  const pods = s.missilePods;
  const podRange = pods ? pods.range : 1700;
  // Stay just inside pod range so missiles can lock, but well inside the
  // wider standoff of the old AI — bombers are supposed to PRESS in from
  // the flank, not loiter at the back fence.
  const STANDOFF = Math.min(podRange * 0.80, 1350);

  // Per-bomber consistent side. Use target heading when it has one;
  // small craft (fighters) can move erratically so fall back to the
  // relative bearing for them.
  const flankSign = (ship.id % 2 === 0) ? 1 : -1;
  const useTargetHeading = target.klass !== "fighter";
  let fwdTx, fwdTy;
  if (useTargetHeading) {
    fwdTx = Math.cos(target.heading);
    fwdTy = Math.sin(target.heading);
  } else {
    // For a fighter target, "flank" = come in perpendicular to OUR
    // approach bearing.
    fwdTx = dir.x;
    fwdTy = dir.y;
  }
  // Perpendicular to target's forward, sign-chosen.
  const perpTx = -fwdTy * flankSign;
  const perpTy =  fwdTx * flankSign;

  // Flank slot: mostly to the side, biased slightly aft so we approach
  // from the target's quarter rather than its nose. Aft bias also keeps
  // bombers out of forward-firing primary arcs.
  const slotX = target.pos.x + perpTx * STANDOFF - fwdTx * STANDOFF * 0.25;
  const slotY = target.pos.y + perpTy * STANDOFF - fwdTy * STANDOFF * 0.25;
  const toSlotX = slotX - ship.pos.x;
  const toSlotY = slotY - ship.pos.y;
  const distToSlot = Math.hypot(toSlotX, toSlotY);

  let aim;
  if (distToSlot > 280) {
    // Get to the flank slot first — heading-locked flight means aiming
    // there IS flying there.
    aim = { x: toSlotX, y: toSlotY };
  } else if (dist < STANDOFF * 0.6) {
    // We've blown through the slot and are now too close. Back off along
    // the flank vector so we don't drift into the PD bubble.
    aim = { x: -dir.x + perpTx * 0.6, y: -dir.y + perpTy * 0.6 };
  } else {
    // In the slot — face the target so forward gun + pod launch geometry
    // line up on it.
    aim = { x: rel.x, y: rel.y };
  }

  c.thrust = { x: 0, y: 0 };
  c.aim = aim;

  // Bombers' light gun has range ~600 — way inside enemy primary
  // weapon envelopes. Fire it when nose-on, in range, and not stacked
  // up inside any PD bubble.
  const fwd = { x: Math.cos(ship.heading), y: Math.sin(ship.heading) };
  const aimNorm = V.norm(aim);
  const aligned = V.dot(fwd, aimNorm);
  const inPd = insideEnemyPDRange(ship, world ? world.ships : []);
  c.firing = !inPd && dist <= s.weapon.range && aligned > 0.85
          && V.dot(fwd, dir) > 0.7;
  c.firingMissile = false;

  // Threat avoidance — but the *target* is excluded from danger. Bombers
  // were dialling themselves out of engagement on every capital they
  // tried to attack; now they only flinch from OTHER capitals nearby.
  const pack = world && world.packs ? world.packs.get(ship.packId) : null;
  const cohesion = packCohesion(ship, pack);
  const danger = bigShipDanger(ship, world ? world.ships : [], target);
  const tail = tailDanger(ship, world ? world.ships : []);
  const wall = wallAvoidance(ship, world && world.arena ? world.arena.bounds : null);
  if (cohesion || danger || tail || wall) {
    const aimN = V.norm(c.aim);
    let ax = aimN.x, ay = aimN.y;
    if (cohesion) { ax += cohesion.x * 0.30; ay += cohesion.y * 0.30; }
    if (danger)   { ax += danger.x   * 0.85; ay += danger.y   * 0.85; }
    if (tail)     { ax += tail.x     * 0.80; ay += tail.y     * 0.80; }
    if (wall)     {
      const w = 2.6 * wall.strength;
      ax += wall.x * w;
      ay += wall.y * w;
    }
    c.aim = { x: ax, y: ay };
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
