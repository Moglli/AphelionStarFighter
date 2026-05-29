import * as V from "./vec.js";
import { pickAimModule, moduleOffsetWorld } from "./modules.js";

// Find nearest enemy to a ship.
function nearestEnemy(ship, ships) {
  let best = null, bestD2 = Infinity;
  for (const other of ships) {
    if (other.dead || other.surrendered || other.side === ship.side) continue;
    const dx = other.pos.x - ship.pos.x;
    const dy = other.pos.y - ship.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = other; }
  }
  return best;
}

// Pick the world-space aim point for `target`. When the target carries
// modules (capitals + bombers — basically anything bigger than a
// fighter) the AI prioritises the next live module in the PD →
// broadside → missile → laser order so cannons chew through screening
// + weapon systems before going for hull. Falls back to target.pos
// for fighters and any target with no live modules left.
function aimPointFor(target) {
  if (!target) return null;
  const mod = pickAimModule(target);
  if (mod) {
    const wpos = moduleOffsetWorld(target, mod);
    if (wpos) return wpos;
  }
  return target.pos;
}

// Lead a moving target so a projectile of `speed` will hit. Aim point
// is module-aware via `aimPointFor` so strafing fighters / frigates
// lead the PD turret or weapon bay they're chewing rather than the
// hull centroid. TWO iterations: the first estimate of time-to-target
// is based on current distance, but if the target is moving toward
// (or away from) the shooter, the projected future position is at a
// different distance — so we re-estimate t against the predicted
// future position. Single iteration was fine for slow capitals but
// missed fast strike craft (fighters chasing fighters / bombers at
// 250-500 u/s), where the lead point shifts noticeably between
// iterations. Two iterations converge inside ~5% of the analytic
// solution for typical engagement geometry — enough that fighters
// reliably score hits.
function leadAim(shooter, target, speed) {
  const aimPt = aimPointFor(target);
  const dx0 = aimPt.x - shooter.pos.x;
  const dy0 = aimPt.y - shooter.pos.y;
  // Guard a zero/negative/NaN projectile speed (malformed spec or component
  // patch): a divide here would put NaN into the aim vector → ship.heading →
  // ship.pos, corrupting the ship and any pack centroid it feeds. Fall back
  // to no-lead (aim straight at the point).
  if (!(speed > 0)) return { x: dx0, y: dy0 };
  let t = Math.hypot(dx0, dy0) / speed;
  // Second iteration: predict where the target will be at t1, recompute
  // time-to-that-point. Converges for targets slower than the projectile.
  const px1 = aimPt.x + target.vel.x * t;
  const py1 = aimPt.y + target.vel.y * t;
  t = Math.hypot(px1 - shooter.pos.x, py1 - shooter.pos.y) / speed;
  return {
    x: aimPt.x + target.vel.x * t - shooter.pos.x,
    y: aimPt.y + target.vel.y * t - shooter.pos.y,
  };
}

function nearestEnemyOfClass(ship, ships, klass) {
  let best = null, bestD2 = Infinity;
  for (const other of ships) {
    if (other.dead || other.surrendered || other.side === ship.side) continue;
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
    if (o.dead || o.surrendered || o.side === ship.side) continue;
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

  // Resolve this ship's standing orders once (stance handled later in
  // applyShipOrders; the TARGET PRIORITY axis is applied here).
  const orders = resolveOrders(ship, world);
  const priority = (orders && orders.priority) || "default";

  // FOCUS priority — ships tagged FOCUS pile onto the admiral's live focus
  // target (set by tapping an enemy in admiral view). Only FOCUS-tagged
  // ships follow it now (was: every blue ship) so the order is a tight,
  // opt-in "all guns on my call" rather than a blanket pin. Bombers still
  // refuse a fighter focus (wasted pods).
  let target = null;
  if (priority === "focus" && ship.side === "blue" && world.focusTargetId != null) {
    const focus = world.ships.find((o) => o.id === world.focusTargetId);
    if (focus && !focus.dead && !focus.surrendered && focus.side !== ship.side) {
      if (ship.klass === "bomber") {
        if (focus.klass !== "fighter") target = focus;
      } else {
        target = focus;
      }
    }
  }

  // HUNT priority — soft preference for a specific enemy klass over the
  // per-class default. Falls through to the normal pickers when no live
  // enemy of that klass is on the field.
  if (!target && priority === "hunt" && orders && orders.priorityClass) {
    const preferred = nearestEnemyOfClass(ship, world.ships, orders.priorityClass);
    if (preferred) target = preferred;
  }

  // Battleships duel each other; if no enemy battleship is on the
  // field they pick the next-largest live target. Cruisers prefer
  // the largest enemy with missile-pod weight in mind. Bombers hunt
  // capitals.
  if (!target && ship.klass === "battleship") {
    target = pickBattleshipTarget(ship, world.ships);
  } else if (!target && ship.klass === "cruiser") {
    target = pickCruiserTarget(ship, world.ships);
  } else if (!target && ship.klass === "bomber") {
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

  // Escort leash: fighters stamped with `escortOf` (set at spawn time
  // by spawnEscorts) only engage targets within ESCORT_ENGAGE_RANGE of
  // their assigned capital. Anything past that gets dropped and the
  // ship falls through to the return-to-station path below. Without
  // this, fighter escorts happily chased enemies across the entire
  // arena and left their capital naked. History:
  //   - originally 900/1400  (too clingy — escorts barely sortied)
  //   - bumped to  1700/2400 (still too tight: capital pod range is
  //     1700-1800 and BB main is 2000+, so a threat fully in weapon
  //     range was already inside the leash by the time escorts moved)
  //   - now      3500/5000  (escorts proactively peel off to meet
  //     approaching threats — pod / main-gun bubbles around the cap
  //     no longer outreach the screen). Recall gives the fighter
  //     headroom to chase a bit past engage range before the leash
  //     yanks it back.
  const ESCORT_ENGAGE_RANGE = 3500;
  const ESCORT_RECALL_RANGE = 5000;
  let escortCap = null;
  // Escort leash runs for ANY class now (ESCORT is a valid order for
  // capitals too — e.g. frigates screening a battleship). Stamped via
  // `escortOf` at spawn (fleetcommand/roguelite) or auto-assigned for
  // fighter packs. The carrier/station classes already returned above.
  if (ship.escortOf != null && world.ships) {
    escortCap = world.ships.find((o) => o.id === ship.escortOf && !o.dead) || null;
    if (!escortCap) {
      ship.escortOf = null; // assigned capital is gone; free fighter
    } else {
      // Escort target priority: pick the nearest hostile to the *cap*
      // (not to ourselves) inside the engage bubble. That way escorts
      // sortie out to meet approaching threats from any direction —
      // including threats that a specific escort wasn't the closest
      // friendly to. Falls back to the nearest-to-me target picked
      // earlier if nothing is inside the leash. Bombers escorting
      // their charge use the same rule.
      let bestCapD2 = ESCORT_ENGAGE_RANGE * ESCORT_ENGAGE_RANGE;
      let bestCapT = null;
      for (const o of world.ships) {
        if (o.dead || o.surrendered || o.side === ship.side) continue;
        const dx = o.pos.x - escortCap.pos.x;
        const dy = o.pos.y - escortCap.pos.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestCapD2) { bestCapD2 = d2; bestCapT = o; }
      }
      if (bestCapT) {
        target = bestCapT;
      } else if (target) {
        // No threat inside the bubble — drop the nearest-to-me target
        // if it's too far from the cap (would yank us out of position).
        const dxT = target.pos.x - escortCap.pos.x;
        const dyT = target.pos.y - escortCap.pos.y;
        const targetFarFromCap = (dxT * dxT + dyT * dyT) > (ESCORT_ENGAGE_RANGE * ESCORT_ENGAGE_RANGE);
        if (targetFarFromCap) target = null;
      }
      // Recall regardless of target — escort that wandered too far
      // drops its target to head back to the station ring.
      const dxS = ship.pos.x - escortCap.pos.x;
      const dyS = ship.pos.y - escortCap.pos.y;
      if ((dxS * dxS + dyS * dyS) > (ESCORT_RECALL_RANGE * ESCORT_RECALL_RANGE)) {
        target = null;
      }
    }
  }

  if (!target) {
    // Escort with nothing to chase — fly back to a station ring around
    // the capital instead of going idle in the void.
    if (escortCap) {
      const stationR = (escortCap.spec ? escortCap.spec.radius : 80) + 200;
      const ang = ship.id * 0.137;
      const sx = escortCap.pos.x + Math.cos(ang) * stationR;
      const sy = escortCap.pos.y + Math.sin(ang) * stationR;
      c.thrust = { x: 0, y: 0 };
      c.aim = { x: sx - ship.pos.x, y: sy - ship.pos.y };
      c.firing = false;
      c.firingMissile = false;
      ship.attackState = "approach";
      ship.approachTimer = 0;
      // Fall through to the wall-clamp safety net below — without it,
      // an escort orbiting a capital that drifted into a corner would
      // happily fly into the wall.
    } else {
      // No target, no escort assignment — point the nose at arena
      // centre rather than null'ing c.aim. Heading-locked ships with
      // c.aim === null don't turn at all, so an idle fighter that
      // happens to face a wall would coast into it and stay clamped.
      c.thrust = { x: 0, y: 0 };
      if (world && world.arena && world.arena.bounds) {
        const b = world.arena.bounds;
        const cx = (b.minX + b.maxX) * 0.5;
        const cy = (b.minY + b.maxY) * 0.5;
        c.aim = { x: cx - ship.pos.x, y: cy - ship.pos.y };
      } else {
        c.aim = null;
      }
      c.firing = false;
      c.firingMissile = false;
    }
  } else {
    if (ship.klass === "fighter") {
      flybyAI(ship, target, dt, world);
    } else if (ship.klass === "bomber") {
      // bomberFlankAI sets up flank slots perpendicular to the
      // target's heading — designed for capitals. Against a fighter
      // or bomber (both heading-locked, both moving) those slots
      // overshoot through the target. Endgame "only bombers left"
      // turns into a head-on charge. Route small-craft engagements
      // through fighter AI so bombers dogfight + use cannons at
      // close range instead.
      if (target.klass === "fighter" || target.klass === "bomber") {
        flybyAI(ship, target, dt, world);
      } else {
        bomberFlankAI(ship, target, dt, world);
      }
    } else if (ship.klass === "battleship") {
      battleshipAI(ship, target, dt, world);
    } else if (ship.klass === "cruiser") {
      cruiserAI(ship, target, dt, world);
    } else if (ship.klass === "frigate") {
      frigateAI(ship, target, dt, world);
    }
  }
  // Stance override (CHARGE / STAND OFF / HOLD POSITION / FALL BACK) must
  // still run even with no target (e.g. an idle ship under FALL BACK should
  // pull to the rear). Runs after the per-class branch so it can supersede
  // the no-target c.aim default.
  applyShipOrders(ship, world, target);

  // Safety net: corners pin heading-locked craft (fighter / bomber)
  // when their per-class AI didn't run wall avoidance — escort station
  // ring, idle no-target, admiral PRESS aim into a corner-target, etc.
  // The bounds clamp in ship.js zeroes wall-normal velocity but leaves
  // heading unchanged, so a ship facing into the wall just sits there.
  // After the per-class AI has set c.aim, re-blend the wall-avoidance
  // vector for fighters + bombers so the nose is always pulled inward
  // when near a boundary regardless of which AI branch ran.
  if (ship.klass === "fighter" || ship.klass === "bomber") {
    enforceWallEscape(ship, world);
  }
}

// Final-pass wall avoidance for heading-locked small craft. Always runs
// after the per-class AI so it overrides any branch that forgot to
// blend wallAvoidance (the escort-station path, the idle no-target
// path, etc.). The strength scales linearly with the worst-axis
// proximity so a ship deep in a corner gets a hard inward turn; a
// ship that's only kissing one wall gets a gentle nudge.
function enforceWallEscape(ship, world) {
  if (!world || !world.arena || !world.arena.bounds) return;
  const wall = wallAvoidance(ship, world.arena.bounds);
  if (!wall) return;
  const c = ship.controller;
  // No prior aim — set one that points inward directly.
  if (!c.aim || (c.aim.x === 0 && c.aim.y === 0)) {
    c.aim = { x: wall.x, y: wall.y };
    return;
  }
  const aimN = V.norm(c.aim);
  // Weight rises sharply with proximity — outweighs every other
  // steering vector once wall.strength approaches 1.
  const w = 3.0 * wall.strength;
  c.aim = { x: aimN.x + wall.x * w, y: aimN.y + wall.y * w };
}

// Admiral-mode directive override. Runs after the per-class AI has set
// c.aim / c.firing so we can cleanly replace those values per the ship's
// STANCE. Only the allied (blue) side is commanded — enemy AI is unaffected
// so the player faces a normal opponent. See BATTLE_COMMANDS_SPEC.md.

// Longest effective offensive range — the distance the ship can still land a
// hit. Used by STAND OFF (kite distance) + HOLD POSITION (engage leash). The
// fighter air-to-air `missile` is excluded so fighters kite at GUN range, not
// the occasional intercept-missile range.
function effectiveRange(ship) {
  const s = ship.spec;
  if (!s) return 1000;
  let r = 0;
  const consider = (w) => { if (w && w.range > r) r = w.range; };
  const arr = (x) => (x ? (Array.isArray(x) ? x : [x]) : []);
  consider(s.weapon);
  for (const p of arr(s.missilePods)) consider(p);
  for (const l of arr(s.heavyLaser)) consider(l);
  consider(s.torpedoes);
  return r > 0 ? r : 1000;
}

// Centroid of a side (optionally hostile-to `ship`), skipping dead/surrendered.
function sideCentroid(world, side, exclude) {
  let sx = 0, sy = 0, n = 0;
  for (const o of world.ships) {
    if (o.dead || o === exclude) continue;
    if (side === "enemy") { if (o.surrendered || o.side === exclude.side) continue; }
    else if (o.side !== side) continue;
    sx += o.pos.x; sy += o.pos.y; n++;
  }
  return n > 0 ? { x: sx / n, y: sy / n, n } : null;
}

// Resolve a ship's orders into the unified shape { stance, priority,
// priorityClass }. New-shape `wingCommand.stance` wins; a legacy
// `wingCommand.kind` (free/hold/press/defend-capital/target-class — still
// emitted by the Frontier Battle Plan UI) is mapped forward; otherwise the
// per-class `game.directives[klass]` (live-editable via the admiral panel)
// is the default. Escort is NOT resolved here — it rides on `ship.escortOf`,
// stamped at spawn. Returns null if the ship has no orders at all.
const LEGACY_STANCE = { free: "engage", press: "charge", hold: "fallback", "defend-capital": "engage", "target-class": "engage" };
function resolveOrders(ship, world) {
  const wc = ship.wingCommand;
  if (wc) {
    if (wc.stance) return wc; // already new-shape
    return {
      stance: LEGACY_STANCE[wc.kind] || "engage",
      priority: wc.kind === "target-class" ? "hunt" : "default",
      priorityClass: wc.kind === "target-class" ? wc.target : null,
    };
  }
  const d = world.directives && world.directives[ship.klass];
  if (!d) return null;
  if (d.stance) return d; // new-shape per-class directive
  // Legacy {posture, missiles} per-class directive — map posture forward.
  return { stance: LEGACY_STANCE[d.posture] || "engage", priority: "default", priorityClass: null };
}

function applyShipOrders(ship, world, target) {
  if (ship.side !== "blue") return;
  const orders = resolveOrders(ship, world);
  const stance = (orders && orders.stance) || "engage";
  if (stance === "engage") return; // no-op: per-class AI stands as-is
  const c = ship.controller;

  if (stance === "fallback") {
    // Full disengage: retreat to the fleet REAR (allied centroid pushed
    // away from the enemy centroid, so ships actually withdraw instead of
    // piling into the middle) and cease fire.
    const ally = sideCentroid(world, "blue", ship);
    const foe = sideCentroid(world, "enemy", ship);
    if (ally) {
      let rx = ally.x, ry = ally.y;
      if (foe) {
        let ax = ally.x - foe.x, ay = ally.y - foe.y;
        const al = Math.hypot(ax, ay) || 1;
        rx = ally.x + (ax / al) * 1000; ry = ally.y + (ay / al) * 1000;
      }
      const dx = rx - ship.pos.x, dy = ry - ship.pos.y;
      if (Math.hypot(dx, dy) > 200) c.aim = { x: dx, y: dy };
    }
    c.firing = false;
    c.firingMissile = false;
    return;
  }

  if (stance === "charge") {
    // Close to point-blank on the target (or the enemy mass if none),
    // overriding any class standoff/orbit. Keep the class AI's fire flags.
    if (target) {
      c.aim = { x: target.pos.x - ship.pos.x, y: target.pos.y - ship.pos.y };
    } else {
      const foe = sideCentroid(world, "enemy", ship);
      if (foe) c.aim = { x: foe.x - ship.pos.x, y: foe.y - ship.pos.y };
    }
    return;
  }

  if (stance === "standoff") {
    // Kite at max weapon range. Inside 0.85R → open distance (turn away);
    // beyond R → close; in the band → orbit perpendicular so guns/PD bear.
    if (!target) return; // nothing to range against → let class AI idle
    const R = effectiveRange(ship);
    const dx = target.pos.x - ship.pos.x, dy = target.pos.y - ship.pos.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d < 0.85 * R) {
      c.aim = { x: -dx, y: -dy }; // back-pedal: open the range
    } else if (d > R) {
      c.aim = { x: dx, y: dy };   // close into range
    } else {
      c.aim = { x: -dy, y: dx };  // orbit perpendicular, hold the range
    }
    // Fire flags from the class AI stand — it shoots when arcs bear.
    return;
  }

  if (stance === "hold") {
    // Hold ground + defend: anchor to the escorted capital (if any) else the
    // spot where the order took effect. Return if pulled past HOLD_RADIUS;
    // otherwise engage only targets near the anchor (never pursue out).
    const HOLD_RADIUS = 600;
    let A;
    if (ship.escortOf != null) {
      const cap = world.ships.find((o) => o.id === ship.escortOf && !o.dead);
      A = cap ? cap.pos : (ship.holdAnchor || (ship.holdAnchor = { x: ship.pos.x, y: ship.pos.y }));
    } else {
      A = ship.holdAnchor || (ship.holdAnchor = { x: ship.pos.x, y: ship.pos.y });
    }
    const dax = ship.pos.x - A.x, day = ship.pos.y - A.y;
    const dA = Math.hypot(dax, day);
    if (dA > HOLD_RADIUS) {
      c.aim = { x: A.x - ship.pos.x, y: A.y - ship.pos.y }; // return home
      c.firing = false;
      c.firingMissile = false;
      return;
    }
    // Within the leash: engage the class-picked target only if it's close
    // enough to the anchor to fight without leaving station; else hold.
    const R = effectiveRange(ship);
    let defend = false;
    if (target) {
      const tx = target.pos.x - A.x, ty = target.pos.y - A.y;
      defend = Math.hypot(tx, ty) <= HOLD_RADIUS + R;
    }
    if (!defend) {
      // No nearby threat — drift back toward the anchor centre, hold fire.
      if (dA > 120) c.aim = { x: A.x - ship.pos.x, y: A.y - ship.pos.y };
      c.firing = false;
      c.firingMissile = false;
    }
    // else: leave the class AI's aim/fire as-is (engage the nearby target).
    return;
  }
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
    if (other.dead || other.surrendered || other.side === ship.side) continue;
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
    //    With multi-group missile loadouts (player capital with mixed
    //    cluster + nuke pods), pick the LONGEST range — that's the
    //    one defining the "stay away" zone.
    if (spec.missilePods) {
      const mp = spec.missilePods;
      let mR = 0;
      if (Array.isArray(mp)) {
        for (const g of mp) if (g && g.range > mR) mR = g.range;
      } else if (typeof mp.range === "number") {
        mR = mp.range;
      }
      if (mR > 0 && d < mR) {
        const u = 1 - d / mR;
        pushX += toUsX * u * 0.55;
        pushY += toUsY * u * 0.55;
      }
    }

    // 3. Heavy laser — instant hit, fatal damage. Push perpendicular
    //    if we're in its forward firing arc. Array-aware: a BB with
    //    multiple beams uses the longest range + widest arc to define
    //    the "stay clear" envelope.
    if (spec.heavyLaser) {
      const hl = spec.heavyLaser;
      let lR = 0, arc = Math.PI * 0.55;
      if (Array.isArray(hl)) {
        for (const g of hl) {
          if (!g) continue;
          if (g.range > lR) lR = g.range;
          if (g.arc && g.arc > arc) arc = g.arc;
        }
      } else {
        lR = hl.range || 0;
        if (hl.arc) arc = hl.arc;
      }
      if (lR > 0 && d < lR) {
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
    if (other.dead || other.surrendered || other.side === ship.side) continue;
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
    if (other.dead || other.surrendered || other.side === ship.side) continue;
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

// Same-side capital crowding push. The big ships are heading-locked
// so they have no built-in collision avoidance — without this they
// drift through each other under the cell-overlap resolver in
// game.js (which kicks in on contact, not before). This helper
// returns a steering vector that points AWAY from the nearest live
// ally capital inside `range`, weighted by how close it is. Result
// is normalised so callers can scale it like the other avoidance
// vectors (bigShipDanger / wallAvoidance).
//
// Fighters/bombers don't trigger this — they're allowed to share
// space with capitals because their AI already accounts for hull
// proximity. Stations are excluded (they don't move).
function allyAvoidance(ship, ships) {
  if (!ships || ships.length === 0) return null;
  const myR = (ship.spec && ship.spec.radius) || 30;
  let nx = 0, ny = 0, any = false;
  for (const o of ships) {
    if (o === ship || o.dead) continue;
    if (o.side !== ship.side) continue;
    if (o.klass === "fighter" || o.klass === "bomber" || o.klass === "station") continue;
    const otherR = (o.spec && o.spec.radius) || 30;
    // Activation distance: when the gap between hulls falls under
    // ~1.5× the larger radius, start pushing. Pad ramps up linearly
    // so the closer the two ships are, the stronger the shove.
    const minGap = Math.max(myR, otherR) * 1.5;
    const dx = ship.pos.x - o.pos.x;
    const dy = ship.pos.y - o.pos.y;
    const d = Math.hypot(dx, dy);
    const gap = d - (myR + otherR);
    if (gap > minGap || d < 1e-6) continue;
    const t = 1 - Math.max(0, gap / minGap);  // 0 (just at minGap) → 1 (touching)
    nx += (dx / d) * t;
    ny += (dy / d) * t;
    any = true;
  }
  if (!any) return null;
  const len = Math.hypot(nx, ny);
  if (len < 0.05) return null;
  return { x: nx / len, y: ny / len };
}

function flybyAI(ship, target, dt, world) {
  const c = ship.controller;
  const s = ship.spec;

  // Lazily initialise per-ship flyby state. The no-target escort path
  // in updateAI sets `attackState = "approach"` directly without
  // touching breakSide / breakTimer, so a fighter that spent its first
  // few ticks as a station-keeping escort could enter the break branch
  // later with `breakSide === undefined`. `undefined` poisons
  // `tangX = perp.x * breakSide` → NaN aim → NaN heading → NaN pos,
  // and the corruption spreads through packCohesion (pack centre goes
  // NaN once any pack member's pos is NaN). Initialise every missing
  // field independently so any code path that sets only attackState
  // can't leave the others undefined.
  if (ship.breakSide === undefined) {
    ship.breakSide = (ship.id % 2 === 0) ? 1 : -1;
  }
  if (ship.breakTimer === undefined) ship.breakTimer = 0;
  if (ship.approachTimer === undefined) ship.approachTimer = 0;
  if (ship.attackState === undefined) ship.attackState = "approach";

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
    // Tighter alignment + tagged controller when the prey is a small
    // moving target. Fighter cannons at default ±0.05 spread will scatter
    // ±25u at 500u range — wider than a fighter's hit radius — so a wide
    // firing cone meant most shots scored against backstop, not the
    // target. 0.94 cos = ~20° full cone (was 0.92 ~ 23°) — narrower
    // enough to bias shots ON the target, wide enough that fighters
    // still get plenty of firing windows during a dogfight. The
    // aimingAtSmall flag also tells the fire path to halve the random
    // spread on the shots that DO get out.
    const smallPrey = target.klass === "fighter" || target.klass === "bomber";
    c.aimingAtSmall = smallPrey;
    const alignThreshold = smallPrey ? 0.94 : 0.92;
    c.firing = dist <= s.weapon.range && aligned > alignThreshold;

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
    c.aimingAtSmall = false;

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
// Bomber behaviour: missile-run from outside the target's PD envelope.
// The bomber picks a side relative to the target's current facing
// (ID-parity for consistency) and aims for a slot offset perpendicular
// to the target's nose — so the strike comes in from the broadside, not
// down the target's gun arc. Standoff is sized dynamically against the
// target's PD range so a station-class target with longer PD pushes
// the bomber further out than a frigate with a single PD turret.
// Pods auto-fire on any target inside acquireRange (see
// updateMissilePodFire in ship.js), so a bomber sitting at the flank
// slot delivers its full payload from a safe distance.
// ---------------------------------------------------------------------------
function bomberFlankAI(ship, target, dt, world) {
  const c = ship.controller;
  const s = ship.spec;

  const rel = V.sub(target.pos, ship.pos);
  const dist = V.len(rel);
  const dir = dist > 1e-6 ? { x: rel.x / dist, y: rel.y / dist } : { x: 1, y: 0 };

  const pods = s.missilePods;
  const podRange = pods ? pods.range : 1700;
  // Target's PD envelope drives the safe standoff. Without this, a
  // bomber would happily flank inside the PD bubble — PD turrets would
  // shred its missiles + nudge the hull. The 1.3× buffer matches the
  // multiplier `bigShipDanger` uses to start nudging the heading
  // outward; the +120 buffer means missiles spawn with clear air
  // before they need to dodge PD rounds. If the target carries no PD
  // (rare — e.g. a wreck or stripped capital), fall back to the old
  // 1200u standoff.
  const targetPdRange = (target.spec && target.spec.pdCannons && target.spec.pdCannons.range) || 0;
  const pdSafe = targetPdRange > 0 ? targetPdRange * 1.3 + 120 : 0;
  // Final standoff: at least clear of the PD ring, capped just inside
  // pod range so missiles still acquire. We *prefer* to sit ~85% of
  // pod range — close enough that missiles don't time out, far enough
  // that PD rounds (which lead aim) miss more often.
  const STANDOFF = Math.max(pdSafe, Math.min(podRange * 0.85, 1400));

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

  // Slot hysteresis: enter the in-slot mode at distToSlot <= 280, but
  // hold it until we drift past 360. Without this, a bomber that just
  // arrived oscillates between "go to slot" and "in slot" on every
  // frame as its heading-locked motion nudges it across the boundary.
  const inSlotEnter = 280, inSlotExit = 360;
  if (ship.inSlot) {
    if (distToSlot > inSlotExit) ship.inSlot = false;
  } else if (distToSlot <= inSlotEnter) {
    ship.inSlot = true;
  }

  // Overshoot threshold: arc out as soon as we breach the PD safety
  // ring (with a small buffer), not at a fixed fraction of STANDOFF.
  // A bomber with a generous pod range (e.g. 1800) against a target
  // with a tiny PD ring (400) would otherwise dive way too deep before
  // peeling — `STANDOFF * 0.55` was 770, well inside the 500 PD ring.
  const overshootThresh = pdSafe > 0 ? pdSafe * 0.95 : STANDOFF * 0.55;

  let aim;
  if (!ship.inSlot) {
    // Get to the flank slot first — heading-locked flight means aiming
    // there IS flying there.
    aim = { x: toSlotX, y: toSlotY };
  } else if (dist < overshootThresh) {
    // Inside the PD safety ring — curve OUT along the flank tangent
    // instead of doing a 180° turn. A heading-locked craft would
    // otherwise spend ~2s spinning around while sitting inside the PD
    // bubble; the tangent escape arcs out in half the time.
    aim = { x: perpTx, y: perpTy };
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

  // Threat avoidance — bombers (unlike fighters) DON'T get to ignore
  // their attack target's PD ring. The whole point of the missile-run
  // doctrine is to stay outside the target's defensive envelope; if
  // we excluded the target the bomber would happily fly into PD range
  // every approach. With the target included, the PD bubble shows up
  // as a strong outward push on the heading once we're inside ~1.25×
  // PD range (see bigShipDanger).
  const pack = world && world.packs ? world.packs.get(ship.packId) : null;
  const cohesion = packCohesion(ship, pack);
  const danger = bigShipDanger(ship, world ? world.ships : [], null);
  const tail = tailDanger(ship, world ? world.ships : []);
  const wall = wallAvoidance(ship, world && world.arena ? world.arena.bounds : null);
  if (cohesion || danger || tail || wall) {
    const aimN = V.norm(c.aim);
    let ax = aimN.x, ay = aimN.y;
    if (cohesion) { ax += cohesion.x * 0.30; ay += cohesion.y * 0.30; }
    // Danger weight bumped from 0.85 → 1.2: the bomber should
    // PRIORITISE staying out of PD range over pressing the attack.
    // Missiles continue to home from a safe distance via the pod auto-
    // fire path (see updateMissilePodFire in ship.js).
    if (danger)   { ax += danger.x   * 1.20; ay += danger.y   * 1.20; }
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
// Target-priority tables. Battleships and cruisers prefer larger,
// stationary, capital-class targets; the picker walks the table in
// order and grabs the nearest live enemy of each class.
// ---------------------------------------------------------------------------
const BATTLESHIP_PRIORITY = ["battleship", "station", "carrier", "cruiser", "frigate", "bomber", "fighter"];
const CRUISER_PRIORITY    = ["battleship", "carrier", "station", "cruiser", "frigate"];

function pickByPriority(ship, ships, priority) {
  for (const klass of priority) {
    const t = nearestEnemyOfClass(ship, ships, klass);
    if (t) return t;
  }
  return null;
}

function pickBattleshipTarget(ship, ships) {
  return pickByPriority(ship, ships, BATTLESHIP_PRIORITY);
}

function pickCruiserTarget(ship, ships) {
  return pickByPriority(ship, ships, CRUISER_PRIORITY);
}

// ---------------------------------------------------------------------------
// Battleship behaviour: heading-locked. Press forward toward the target
// until inside broadside range, then turn so the target sits ±broadsideArc
// off the beam — the existing updateBroadsideFire system catches the
// target in its arc and looses the multi-stage salvo. The aim transition
// happens via heading rotation alone; the ship's translation falls out
// of the heading.
// ---------------------------------------------------------------------------
function battleshipAI(ship, target, dt, world) {
  const c = ship.controller;
  const s = ship.spec;
  const rel = V.sub(target.pos, ship.pos);
  const dist = V.len(rel);
  const dir = dist > 1e-6 ? { x: rel.x / dist, y: rel.y / dist } : { x: 1, y: 0 };

  // Cone of distances where the BB orbits broadside-on. ENTER is tighter
  // than EXIT so we don't oscillate between rush and broadside when
  // motion drifts us across the boundary.
  const broadsideRange = s.weapon.range * 0.85;
  if (ship.battleshipMode === undefined) ship.battleshipMode = "rush";
  if (ship.battleshipMode === "rush" && dist <= broadsideRange) {
    ship.battleshipMode = "broadside";
  } else if (ship.battleshipMode === "broadside" && dist > s.weapon.range * 1.10) {
    ship.battleshipMode = "rush";
  }

  if (ship.battleshipMode === "rush") {
    // Heading-locked press: aim at the target and motion follows.
    c.aim = { x: rel.x, y: rel.y };
  } else {
    // Broadside hold: pick whichever beam currently points more at the
    // target, then steer that beam directly at it. The ship continues
    // to trace a tangential arc at constant speed, naturally orbiting
    // the target while firing.
    const perpA = { x: -dir.y, y: dir.x };
    const perpB = { x: dir.y, y: -dir.x };
    const fwd = { x: Math.cos(ship.heading), y: Math.sin(ship.heading) };
    c.aim = V.dot(fwd, perpA) >= V.dot(fwd, perpB) ? perpA : perpB;
  }
  // Capital crowding: push away from same-side capitals so two BBs
  // don't drift through each other. Blend is moderate so the push
  // doesn't override the broadside-hold aim entirely.
  const crowd = allyAvoidance(ship, world ? world.ships : []);
  if (crowd) {
    const aimN = V.norm(c.aim);
    c.aim = { x: aimN.x + crowd.x * 0.55, y: aimN.y + crowd.y * 0.55 };
  }
  c.firing = false;        // broadsides fire automatically via arc check
  c.firingMissile = false; // missile pods auto-fire
}

// ---------------------------------------------------------------------------
// Cruiser behaviour: heading-locked. Aims at a moving "orbit slot" 90°
// ahead on the orbit around the target. Far away the slot lies roughly
// behind the target, producing a gentle curve in; closer in, the slot
// is mostly perpendicular, tightening into a circular orbit. Missile
// pods do the actual damage and auto-fire via updateMissilePodFire.
// ---------------------------------------------------------------------------
function cruiserAI(ship, target, dt, world) {
  const c = ship.controller;
  const s = ship.spec;
  const rel = V.sub(target.pos, ship.pos);
  const dist = V.len(rel);
  const dir = dist > 1e-6 ? { x: rel.x / dist, y: rel.y / dist } : { x: 1, y: 0 };

  if (!s.weapon) {
    // No primary weapon (carriers, missile-only cruisers): hold an
    // orbit slot perpendicular so missiles + PD still bear.
    const orbitR = s.aiOrbit || 1500;
    const sign = (ship.id % 2 === 0) ? 1 : -1;
    const perpX = -dir.y * sign, perpY = dir.x * sign;
    c.aim = {
      x: target.pos.x + perpX * orbitR - ship.pos.x,
      y: target.pos.y + perpY * orbitR - ship.pos.y,
    };
    c.firing = false;
    c.firingMissile = false;
    return;
  }

  // Forward-fire cruiser: previously aimed at an orbit slot perpendicular
  // to the target, so the bow ended up pointing tangentially and the
  // forward salvo fired into empty space. Now:
  //   - Lead-aim the target so the bow points at where the shells need
  //     to arrive (target.vel × projectile-flight-time prediction).
  //   - When in firing range, aim directly at the lead intercept so the
  //     ship turns onto target.
  //   - When inside the standoff radius (~70% of aiOrbit) bias the aim
  //     past the target along the sign-based perpendicular, so the
  //     cruiser swings around instead of ramming. The bow still sweeps
  //     through the target line on each rotation, so salvos land.
  //   - Fire when the *bow* is aligned with the lead direction
  //     (NOT c.aim) — previously the alignment check used the slot-
  //     direction, which was off-axis by design.
  const lead = leadAim(ship, target, s.weapon.projectileSpeed);
  // Tell the cruiser hull where to *point its cannons* — the cannon
  // slew in updateShip tracks this every tick. It's the lead intercept
  // direction whether we're approaching, orbiting, or breaking off.
  // Steering (c.aim below) drives the hull, which may differ from
  // where the cannons want to shoot.
  ship.cannonTargetDir = { x: lead.x, y: lead.y };
  // Standoff is the closer of `aiOrbit * 0.7` and the hull/PD safety
  // ring — whichever is FURTHER out. Vs a battleship (radius 156, PD
  // ~560) the safety ring dominates: cruiser starts swinging out at
  // ~880u instead of plowing in to 616u and eating the PD bubble.
  const myR = (s && s.radius) || 60;
  const targetR = (target.spec && target.spec.radius) || 60;
  const targetPdRange = (target.spec && target.spec.pdCannons && target.spec.pdCannons.range) || 0;
  const isCapTarget = target.klass !== "fighter" && target.klass !== "bomber";
  const hullSafe = myR + targetR + 220;
  const pdSafe = isCapTarget ? targetPdRange * 1.25 + 160 : 0;
  const standoff = Math.max((s.aiOrbit || 880) * 0.7, hullSafe, pdSafe);
  if (dist > standoff) {
    c.aim = { x: lead.x, y: lead.y };
  } else {
    const sign = (ship.id % 2 === 0) ? 1 : -1;
    const perpX = -dir.y * sign, perpY = dir.x * sign;
    // Perpendicular offset scales with the same safety ring so the
    // cruiser swings AROUND the danger zone, not through it.
    const offset = Math.max(800, hullSafe, pdSafe);
    c.aim = {
      x: target.pos.x + perpX * offset - ship.pos.x,
      y: target.pos.y + perpY * offset - ship.pos.y,
    };
  }

  const leadN = V.norm(lead);
  // Alignment is now checked against the *cannon* aim angle, not the
  // ship's heading — the cruiser's forward cannons turret-track c.aim
  // and may already point at the target before the hull has caught up.
  // Falls back to ship.heading for any future cruiser-shaped class
  // without a tracked cannon angle.
  const cannonAngle = ship.cannonAimAngle != null ? ship.cannonAimAngle : ship.heading;
  const cannonFwd = { x: Math.cos(cannonAngle), y: Math.sin(cannonAngle) };
  const aligned = V.dot(cannonFwd, leadN);
  // ~±28° tolerance so the salvo fires once the cannon is on target,
  // not only at perfect alignment.
  c.firing = dist <= s.weapon.range && aligned > 0.88;
  c.firingMissile = false;

  // Threat + crowding overlay — previously cruisers only had a tiny
  // ally-avoidance push (0.55) so they would happily nose-press into
  // enemy capitals AND into same-side allies. Now they get the same
  // four-component blend as frigates: bigShipDanger (target included),
  // ally crowd push, enemy-hull personal-space push, wall avoidance.
  const danger    = bigShipDanger(ship, world ? world.ships : [], null);
  const wall      = wallAvoidance(ship, world && world.arena ? world.arena.bounds : null);
  const crowd     = allyAvoidance(ship, world ? world.ships : []);
  const enemyHull = enemyHullProximity(ship, world ? world.ships : []);
  if (danger || wall || crowd || enemyHull) {
    const aimN = V.norm(c.aim);
    let ax = aimN.x, ay = aimN.y;
    if (danger)    { ax += danger.x    * 0.85; ay += danger.y    * 0.85; }
    if (crowd)     { ax += crowd.x     * 1.40; ay += crowd.y     * 1.40; }
    if (enemyHull) { ax += enemyHull.x * 1.80; ay += enemyHull.y * 1.80; }
    if (wall)      {
      const w = 2.0 * wall.strength;
      ax += wall.x * w; ay += wall.y * w;
    }
    c.aim = { x: ax, y: ay };
  }
}

// ---------------------------------------------------------------------------
// Frigate behaviour: heading-locked. Strafe past the target at orbit
// range. The four-cannon ring (updateRingFire) handles all the
// shooting independently, so the AI here is purely steering — no
// firing flags to manage.
// ---------------------------------------------------------------------------
function frigateAI(ship, target, dt, world) {
  const c = ship.controller;
  const s = ship.spec;
  const rel = V.sub(target.pos, ship.pos);
  const dist = V.len(rel);
  const dir = dist > 1e-6 ? { x: rel.x / dist, y: rel.y / dist } : { x: 1, y: 0 };

  // PD-aware orbit. Vs capitals the frigate hugs the outside of the
  // target's PD bubble + slack so the ring cannons can chip without
  // the frigate eating PD rounds. Vs small craft we orbit tighter at
  // the spec's `aiOrbit`. The +200 (was +140) buffer keeps the orbit
  // slot comfortably outside the bigShipDanger inner shell (1.25× PD)
  // so the danger push doesn't oscillate the heading once we arrive.
  let orbitR = s.aiOrbit || 380;
  const targetPdRange = (target.spec && target.spec.pdCannons && target.spec.pdCannons.range) || 0;
  if (targetPdRange > 0 && target.klass !== "fighter" && target.klass !== "bomber") {
    orbitR = Math.max(orbitR, targetPdRange + 200);
  }
  // Also enforce a minimum slot distance based on hull radii, so a
  // frigate vs another frigate (or any other ship with no PD) doesn't
  // try to nose-press against the target. The +180 buffer is roughly
  // one frigate length of breathing room.
  const myR = (s && s.radius) || 30;
  const targetR = (target.spec && target.spec.radius) || 30;
  const hullSafe = myR + targetR + 180;
  orbitR = Math.max(orbitR, hullSafe);

  const sign = (ship.id % 2 === 0) ? 1 : -1;
  const perpX = -dir.y * sign, perpY = dir.x * sign;
  // Orbit slot perpendicular to the target — frigate strafes past
  // rather than charging in.
  const slotX = target.pos.x + perpX * orbitR;
  const slotY = target.pos.y + perpY * orbitR;
  c.aim = { x: slotX - ship.pos.x, y: slotY - ship.pos.y };

  // Evasion blend. Frigates use their speed (maxSpeed 150 — fastest
  // non-fighter) to slide out of broadside / heavy-laser arcs and to
  // skirt PD bubbles.
  //
  // Crucially, the target is NO LONGER excluded from `bigShipDanger`
  // (was `bigShipDanger(ship, ships, target)`). Excluding the target
  // meant the frigate would press its nose into a battleship's PD
  // bubble — the orbit slot's perpendicular position made the straight-
  // line path to it pass within ~orbitR/2 of the hull. With the target
  // included, the PD radial push bends the heading outward when the
  // frigate gets too close, and the frigate arcs around the PD ring
  // to its orbit slot instead of plowing through.
  const danger = bigShipDanger(ship, world ? world.ships : [], null);
  const wall   = wallAvoidance(ship, world && world.arena ? world.arena.bounds : null);
  // Same-side avoidance: don't barge into ally capitals (or other
  // frigates).
  const crowd  = allyAvoidance(ship, world ? world.ships : []);
  // Enemy-hull avoidance: any non-strike-craft enemy within a one-hull
  // buffer pushes the frigate outward, even if that ship is the target.
  // Without this an enemy frigate (PD range 460 ≈ matching the orbit
  // slot 660) could still get nose-pressed because the danger ring and
  // the orbit slot are nearly co-located — the hull push gives a
  // dedicated kick when geometry actually overlaps.
  const enemyHull = enemyHullProximity(ship, world ? world.ships : []);
  if (danger || wall || crowd || enemyHull) {
    const aimN = V.norm(c.aim);
    let ax = aimN.x, ay = aimN.y;
    if (danger)    { ax += danger.x    * 0.95; ay += danger.y    * 0.95; }
    // Crowd + enemyHull weights bumped — when same-side frigates pick
    // the same orbit slot they used to nose-press through each other
    // because crowd (0.70) was barely visible against the slot vector
    // (unit) plus danger (0.95). At 1.6 it dominates and the slower
    // of the pair breaks off cleanly.
    if (crowd)     { ax += crowd.x     * 1.60; ay += crowd.y     * 1.60; }
    if (enemyHull) { ax += enemyHull.x * 1.80; ay += enemyHull.y * 1.80; }
    if (wall)      {
      const w = 2.2 * wall.strength;
      ax += wall.x * w; ay += wall.y * w;
    }
    c.aim = { x: ax, y: ay };
  }

  c.firing = false;
  c.firingMissile = false;
}

// Push the ship away from the nearest enemy non-strike-craft hull that
// breaches the personal-space buffer (sum of hull radii + slack).
// Frigates can otherwise still nose-press a target if the orbit slot
// happens to put them close to the hull surface; this is the dedicated
// "you're physically too close to that thing" safety net.
function enemyHullProximity(ship, ships) {
  if (!ships || ships.length === 0) return null;
  const myR = (ship.spec && ship.spec.radius) || 30;
  let nx = 0, ny = 0, any = false;
  for (const o of ships) {
    if (o === ship || o.dead || o.side === ship.side) continue;
    if (o.klass === "fighter" || o.klass === "bomber") continue;
    const otherR = (o.spec && o.spec.radius) || 30;
    // Trigger when hull gap is under ~1.2× the larger radius — a
    // generous buffer that fires well before the cell collision
    // resolver kicks in.
    const minGap = Math.max(myR, otherR) * 1.2;
    const dx = ship.pos.x - o.pos.x;
    const dy = ship.pos.y - o.pos.y;
    const d = Math.hypot(dx, dy);
    const gap = d - (myR + otherR);
    if (gap > minGap || d < 1e-6) continue;
    const t = 1 - Math.max(0, gap / minGap); // 0 (just at minGap) → 1 (touching)
    nx += (dx / d) * t;
    ny += (dy / d) * t;
    any = true;
  }
  if (!any) return null;
  const len = Math.hypot(nx, ny);
  if (len < 0.05) return null;
  return { x: nx / len, y: ny / len };
}

// ---------------------------------------------------------------------------
// Carrier behaviour: heading-locked motion at constant speed means the
// carrier is always flying somewhere — aim away from the nearest
// capital threat so it never closes the gap on an enemy battleship.
// Far from any threat the aim falls back to a lateral strafe past the
// nearest enemy so PD arcs still cover them.
// ---------------------------------------------------------------------------
function carrierAI(ship, world) {
  const c = ship.controller;
  c.firing = false;
  c.firingMissile = false;

  // Thren-style carriers carry a bow cannon and behave more like a
  // strike platform: face the threat and fire. Standard carriers
  // (Terran/Reaver/Hegemony/Voidsworn) have firingMode "none" and
  // run the strafe-and-defend script below.
  const hasCannon = ship.spec.weapon && ship.spec.firingMode === "forward";

  let threat = null, threatD2 = Infinity;
  for (const o of world.ships) {
    if (o.dead || o.surrendered || o.side === ship.side) continue;
    if (o.klass === "fighter" || o.klass === "bomber") continue;
    const dx = o.pos.x - ship.pos.x;
    const dy = o.pos.y - ship.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < threatD2) { threatD2 = d2; threat = o; }
  }

  if (hasCannon) {
    // Face the nearest threat (or any enemy if no capital threat is
    // nearby) so the bow cannon arc stays usable. The carrier is
    // slow enough that closing range isn't a real risk — the PD +
    // missile + shield kit handles whoever closes.
    const target = threat || nearestEnemy(ship, world.ships);
    if (target) {
      const aimPt = aimPointFor(target);
      c.aim = { x: aimPt.x - ship.pos.x, y: aimPt.y - ship.pos.y };
      // The cannon turret tracks the lead-aim direction (cruiser
      // pattern); slewCannonAim in ship.js consumes this each tick.
      ship.cannonTargetDir = { x: aimPt.x - ship.pos.x, y: aimPt.y - ship.pos.y };
      // Fire when the cannon barrel is roughly aligned with the
      // target (within ~15° of the lead direction). Lower tolerance
      // would have the carrier silent most of the time during turn
      // chase; higher would spray off-axis.
      if (ship.cannonAimAngle != null) {
        const desired = Math.atan2(c.aim.y, c.aim.x);
        let delta = desired - ship.cannonAimAngle;
        while (delta >  Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        c.firing = Math.abs(delta) < 0.26; // ±15°
      }
    } else {
      c.aim = null;
      ship.cannonTargetDir = null;
    }
  } else {
    const SAFE_DIST = 1500;
    if (threat && Math.sqrt(threatD2) < SAFE_DIST) {
      c.aim = { x: ship.pos.x - threat.pos.x, y: ship.pos.y - threat.pos.y };
    } else {
      // No nearby capital threat — strafe perpendicular to the
      // nearest enemy so the carrier's PD wall still has a usable
      // target axis.
      const enemy = nearestEnemy(ship, world.ships);
      if (enemy) {
        const dx = enemy.pos.x - ship.pos.x;
        const dy = enemy.pos.y - ship.pos.y;
        const sign = (ship.id % 2 === 0) ? 1 : -1;
        c.aim = { x: -dy * sign, y: dx * sign };
      } else {
        c.aim = null;
      }
    }
  }
  // Capital crowding — keep distance from ally capitals. Carriers
  // are huge; a small push avoids two carriers pancaking together.
  const crowd = allyAvoidance(ship, world ? world.ships : []);
  if (crowd && c.aim) {
    const aimN = V.norm(c.aim);
    c.aim = { x: aimN.x + crowd.x * 0.60, y: aimN.y + crowd.y * 0.60 };
  } else if (crowd) {
    c.aim = { x: crowd.x, y: crowd.y };
  }
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
