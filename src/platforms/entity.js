/**
 * @file Platform entity — stationary defensive structure.
 *
 * Duck-types the ship interface for the damage cascade
 * (`hp/hpMax/shield/shieldMax/side/dead/surrendered/spec.radius`) so
 * `applyDamage` in game.js works on a platform identically to a ship —
 * the cascade reads those fields agnostic to entity kind.
 *
 * What's intentionally different:
 *   - No movement: `updatePlatform` only rotates the turret toward the
 *     nearest enemy and fires when in range. No thrust, no controller.
 *   - No `cells` / `modules`: hit detection is broad-phase circle, no
 *     block-based erosion (platforms feel more like terrain).
 *   - `surrendered` is permanently false: platforms never strike colors.
 *   - `kind === "platform"` is the runtime tag so game.js can skip
 *     platforms in surrender counts, AAR, escort assignment, etc.
 */

import { createProjectile, createMissile } from "../projectile.js";
import { events } from "../events.js";
import { PLATFORM_TYPES, DEFAULT_PLATFORM_TYPE } from "./registry.js";

// Per-game ID allocator — platforms share an ID namespace with ships
// only at the conceptual level (no actual collision is possible because
// game.platforms is its own array), but battle stats key by id so we
// offset into a high range to avoid future ambiguity.
let nextPlatformId = 100000;

export function createPlatform({ platformId, side, x, y, faction = null }) {
  const type = PLATFORM_TYPES[platformId] || PLATFORM_TYPES[DEFAULT_PLATFORM_TYPE];
  const spec = JSON.parse(JSON.stringify(type.spec));
  // Pre-resolved shield / hp fields per the cascade contract.
  const shieldMax = (spec.shield && spec.shield.max) || 0;
  const hpMax = spec.hp || 1;
  return {
    id: nextPlatformId++,
    kind: "platform",
    platformId: type.id,
    typeName: type.name,
    side,                       // "blue" | "red"
    faction,                    // race-flavour tag for paint (optional)
    pos: { x, y },
    vel: { x: 0, y: 0 },        // duck-type ship.vel for createDebrisBurst
    heading: 0,                 // gun bearing; mutated by updatePlatform
    turretHeading: 0,
    klass: "station",           // closest existing klass; DEBRIS_SIZE_BY_KLASS keys on this
    spec,
    hp: hpMax, hpMax,
    shield: shieldMax, shieldMax,
    shieldFlash: 0,
    shieldHitTimer: 999,
    shieldHits: [],             // recordShieldHit lazy-inits but we pre-set for clarity
    scars: [],                  // addImpactScar iterates this — must exist
    dead: false,
    surrendered: false,
    cells: null,
    modules: null,
    color: type.color || { hull: "#445", trim: "#bcd" },
    // Weapon state — single-mount only this PR.
    fireCooldown: 0,
    pdCooldown: 0,
    isPlayer: false,
  };
}

export function updatePlatform(p, dt, world) {
  if (p.dead) return;

  // Shield regen — matches the ship branch in ship.js#updateShip so the
  // platform feels like a fortified turret, not a flat-hp wall.
  p.shieldHitTimer += dt;
  if (p.spec.shield && p.shield < p.shieldMax) {
    if (p.shieldHitTimer >= p.spec.shield.regenDelay) {
      p.shield = Math.min(p.shieldMax, p.shield + p.spec.shield.regen * dt);
    }
  }
  p.shieldFlash = Math.max(0, p.shieldFlash - dt * 3);

  // Point-defence ring — fires INDEPENDENTLY of the main weapon (it runs
  // even on a platform whose main gun is out of targets, and a weaponless
  // PD-only platform still screens). Mirrors the ship PD priority
  // (ship.js#pickPDTarget): incoming enemy missiles first, then bombers,
  // then fighters, then any enemy ship in range. The `count` turrets are
  // modelled as one stream at count× the per-turret rate (no per-turret
  // positions on a platform), keeping the PD volume right without the
  // ship's per-turret bookkeeping. Without this the registry's declared
  // pdCannons (+ the "PD ring" blurbs + the designer's "PD turrets" stat)
  // were pure decoration — the turret never fired.
  updatePlatformPD(p, dt, world);

  if (!p.spec.weapon) return;   // shield generators (and PD-only) don't main-shoot

  // Find a target — any enemy ship within range. We scan world.ships
  // (platforms don't shoot platforms in v1).
  const range = p.spec.weapon.range;
  const r2 = range * range;
  let best = null, bestD2 = r2;
  for (const s of world.ships) {
    if (s.dead || s.side === p.side || s.surrendered) continue;
    const dx = s.pos.x - p.pos.x, dy = s.pos.y - p.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = s; }
  }
  if (!best) {
    p.fireCooldown = Math.max(0, p.fireCooldown - dt);
    return;
  }

  // Aim the turret.
  const dx = best.pos.x - p.pos.x, dy = best.pos.y - p.pos.y;
  p.turretHeading = Math.atan2(dy, dx);
  p.fireCooldown = Math.max(0, p.fireCooldown - dt);
  if (p.fireCooldown > 0) return;

  // Lead-aim for projectile travel time.
  const w = p.spec.weapon;
  const speed = w.projectileSpeed || 900;
  const d = Math.hypot(dx, dy) || 1;
  const tof = d / speed;
  const aimX = best.pos.x + (best.vel ? best.vel.x : 0) * tof;
  const aimY = best.pos.y + (best.vel ? best.vel.y : 0) * tof;
  const heading = Math.atan2(aimY - p.pos.y, aimX - p.pos.x);

  if (w.kind === "missile") {
    const m = createMissile({
      pos: { x: p.pos.x + Math.cos(p.turretHeading) * p.spec.radius * 0.8,
             y: p.pos.y + Math.sin(p.turretHeading) * p.spec.radius * 0.8 },
      heading,
      damage: w.damage,
      ttl: 6,
      radius: w.projectileRadius || 6,
      color: "#fc8",
      side: p.side,
      ownerId: p.id,
      speed,
      turnRate: w.turnRate || 1.2,
      fromKlass: "platform",
      acquireRange: w.acquireRange || range,
      initialTarget: best,
    });
    world.projectiles.push(m);
    events.emit("missileLaunched", { x: p.pos.x, y: p.pos.y, isPlayer: false });
  } else {
    // Cannon / beam — both fire as straight-line projectiles for v1
    // (true beam logic lives in updateShip; reusing it from a stationary
    // entity needs more plumbing, deferred to a follow-up).
    const c = createProjectile({
      pos: { x: p.pos.x + Math.cos(p.turretHeading) * p.spec.radius * 0.8,
             y: p.pos.y + Math.sin(p.turretHeading) * p.spec.radius * 0.8 },
      vel: { x: Math.cos(heading) * speed, y: Math.sin(heading) * speed },
      damage: w.damage,
      ttl: range / speed + 0.2,
      radius: w.projectileRadius || 4,
      color: w.kind === "beam" ? "#cae" : "#fdd",
      side: p.side,
      ownerId: p.id,
      ownerKlass: "platform",
      kind: "cannon",
      fromKlass: "platform",
    });
    world.projectiles.push(c);
    events.emit("weaponFired", {
      x: p.pos.x, y: p.pos.y,
      kind: "platform", weapon: "heavycannon",
      isPlayer: false,
    });
  }
  p.fireCooldown = w.cooldown;
}

// Point-defence pass. Range-aware (uses pd.range); no firing arc (a fixed
// turret ring covers 360°, same as the ship PD which seats turrets around
// the hull). The ring's `count` turrets are collapsed into one stream firing
// at count× the per-turret rate.
function updatePlatformPD(p, dt, world) {
  const pd = p.spec.pdCannons;
  if (!pd) return;
  p.pdCooldown = Math.max(0, p.pdCooldown - dt);
  const range2 = pd.range * pd.range;
  const tgt = pickPlatformPDTarget(p, world, range2);
  if (!tgt) return;
  // Track the (single) PD aim for any future turret render; harmless now.
  const tx = tgt.pos.x, ty = tgt.pos.y;
  const tvx = tgt.vel ? tgt.vel.x : 0;
  const tvy = tgt.vel ? tgt.vel.y : 0;
  if (p.pdCooldown > 0) return;
  const speed = pd.projectileSpeed || 900;
  const rx = tx - p.pos.x, ry = ty - p.pos.y;
  const tof = Math.hypot(rx, ry) / speed;
  const ang = Math.atan2(ty + tvy * tof - p.pos.y, tx + tvx * tof - p.pos.x);
  const origin = {
    x: p.pos.x + Math.cos(ang) * p.spec.radius * 0.6,
    y: p.pos.y + Math.sin(ang) * p.spec.radius * 0.6,
  };
  world.projectiles.push(createProjectile({
    pos: origin,
    vel: { x: Math.cos(ang) * speed, y: Math.sin(ang) * speed },
    damage: pd.damage,
    ttl: pd.range / speed,
    radius: pd.projectileRadius || 1.6,
    color: p.side === "blue" ? "#cef" : "#fda",
    side: p.side,
    ownerId: p.id,
    ownerKlass: "platform",
    kind: "cannon",
    fromKlass: "pd",
  }));
  // Collapse the ring's `count` turrets into one stream firing count× faster.
  p.pdCooldown = pd.cooldown / Math.max(1, pd.count || 1);
  events.emit("pdFired", { x: p.pos.x, y: p.pos.y, isPlayer: false });
}

// PD target priority, mirroring ship.js#pickPDTarget: enemy missiles first
// (the whole point of point-defence), then bombers, then fighters, then the
// nearest enemy ship of any class within range.
function pickPlatformPDTarget(p, world, range2) {
  let bestMissile = null, bestMissileD2 = range2;
  for (const proj of world.projectiles) {
    if (proj.dead || proj.kind !== "missile" || proj.side === p.side) continue;
    const dx = proj.pos.x - p.pos.x, dy = proj.pos.y - p.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestMissileD2) { bestMissileD2 = d2; bestMissile = proj; }
  }
  if (bestMissile) return bestMissile;

  let bestBomber = null, bestBomberD2 = range2;
  let bestFighter = null, bestFighterD2 = range2;
  let bestAny = null, bestAnyD2 = range2;
  for (const s of world.ships) {
    if (s.dead || s.surrendered || s.side === p.side) continue;
    const dx = s.pos.x - p.pos.x, dy = s.pos.y - p.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > range2) continue;
    if (s.klass === "bomber" && d2 < bestBomberD2) { bestBomberD2 = d2; bestBomber = s; }
    if (s.klass === "fighter" && d2 < bestFighterD2) { bestFighterD2 = d2; bestFighter = s; }
    if (d2 < bestAnyD2) { bestAnyD2 = d2; bestAny = s; }
  }
  return bestBomber || bestFighter || bestAny;
}

// World-space platform draw. The render order in main.js puts platforms
// between wrecks and ships, so a live ship in front of a platform clearly
// silhouettes against the structure.
export function drawPlatform(ctx, p) {
  if (p.dead) return;
  const r = p.spec.radius;
  const sideColor = p.side === "blue" ? "#7af" : "#f97";

  // Hex base — terrain-like footprint.
  ctx.save();
  ctx.translate(p.pos.x, p.pos.y);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = p.color.hull;
  ctx.fill();
  ctx.strokeStyle = sideColor;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Inner ring — distinguishes platform silhouette from any ship.
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2);
  ctx.strokeStyle = p.color.trim;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Turret barrel — points at last target.
  if (p.spec.weapon) {
    ctx.save();
    ctx.rotate(p.turretHeading);
    ctx.fillStyle = p.color.trim;
    ctx.fillRect(-r * 0.10, -r * 0.10, r * 0.95, r * 0.20);
    ctx.restore();
  }

  // Shield bubble if up.
  if (p.shieldMax > 0 && p.shield > 0) {
    const frac = p.shield / p.shieldMax;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.15, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(120, 200, 255, ${0.35 + frac * 0.4})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
}
