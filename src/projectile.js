// Projectile kinds:
//   "cannon" — straight-line shell or PD round.
//   "missile" — homing, has its own hp and can be shot down by PD.
//   "laser"  — sustained-effect representation (the actual beam is handled
//              in game.js as an immediate hit + visual; this kind only exists
//              for completeness if needed).
//
// Damage interaction with shields is computed in game.js (see applyDamage).

export function createProjectile({
  pos, vel, damage, ttl, radius, color, side, ownerId,
  kind = "cannon", fromKlass = null,
}) {
  return {
    pos: { ...pos },
    vel: { ...vel },
    damage,
    ttl,
    radius,
    color,
    side,
    ownerId,
    kind,
    fromKlass,
    dead: false,
    hp: 1,
  };
}

// Missile is a homing projectile with its own turn rate and a small hp pool
// so PD can shoot it down. Target is re-acquired if it dies or strays.
export function createMissile({
  pos, heading, damage, ttl, radius, color, side, ownerId,
  speed, turnRate, hp = 1, fromKlass = null, acquireRange = 2000,
  initialTarget = null, targetModuleName = null,
  cluster = null,
}) {
  return {
    pos: { ...pos },
    vel: { x: Math.cos(heading) * speed, y: Math.sin(heading) * speed },
    heading,
    damage,
    ttl,
    radius,
    color,
    side,
    ownerId,
    kind: "missile",
    fromKlass,
    dead: false,
    hp,
    speed,
    turnRate,
    acquireRange,
    targetId: initialTarget ? initialTarget.id : null,
    // When set, the missile homes at the live world position of the named
    // module on the target ship (rather than the ship's center). Falls
    // back to ship-center homing if the module is destroyed mid-flight.
    targetModuleName,
    // Cluster config (battleship pods). When non-null, the missile blooms
    // into N smaller child warheads once it gets within bloomDistance of
    // its target. Children inherit side / ownerId but not the cluster
    // tag, so they don't recursively split.
    cluster,
    trail: [], // recent positions for rendering
  };
}

export function updateProjectile(p, dt, world) {
  if (p.kind === "missile") {
    updateMissile(p, dt, world);
    return;
  }
  p.pos.x += p.vel.x * dt;
  p.pos.y += p.vel.y * dt;
  p.ttl -= dt;
  if (p.ttl <= 0) p.dead = true;
}

function updateMissile(m, dt, world) {
  // Find current target by id; reacquire if missing.
  let target = null;
  if (m.targetId != null) {
    for (const s of world.ships) {
      if (s.dead || s.side === m.side) continue;
      if (s.id === m.targetId) { target = s; break; }
    }
  }
  if (!target) {
    target = acquireMissileTarget(m, world.ships);
    m.targetId = target ? target.id : null;
  }

  if (target) {
    // Cluster bloom — once a cluster-tagged missile gets close enough
    // to its target, it explodes into N smaller homing children that
    // fan out toward the same target. The parent dies at bloom; the
    // children carry their own much smaller payload + hp so PD has to
    // intercept multiple tracks. Children don't carry `.cluster` so
    // they don't recursively split.
    if (m.cluster) {
      const ddx = target.pos.x - m.pos.x;
      const ddy = target.pos.y - m.pos.y;
      const ddist2 = ddx * ddx + ddy * ddy;
      const bloom = m.cluster.bloomDistance;
      if (ddist2 <= bloom * bloom) {
        spawnClusterChildren(m, target, world);
        m.dead = true;
        return;
      }
    }
    // Aim point: by default the ship center, but bombers home on a
    // specific module so a strike wave peels defences before the hull.
    let aimX = target.pos.x;
    let aimY = target.pos.y;
    if (m.targetModuleName && target.moduleByName) {
      const mod = target.moduleByName[m.targetModuleName];
      if (mod && !mod.disabled) {
        const R = target.spec.radius;
        const lx = mod.offset.x * R;
        const ly = mod.offset.y * R;
        const c = Math.cos(target.heading), sh = Math.sin(target.heading);
        aimX = target.pos.x + lx * c - ly * sh;
        aimY = target.pos.y + lx * sh + ly * c;
      } else {
        // Module dead — drop the lock and use ship center.
        m.targetModuleName = null;
      }
    }
    // Lead intercept: aim at predicted future position of the aim point.
    const dx = aimX - m.pos.x;
    const dy = aimY - m.pos.y;
    const dist = Math.hypot(dx, dy);
    const t = dist / m.speed;
    const px = aimX + target.vel.x * t;
    const py = aimY + target.vel.y * t;
    const desired = Math.atan2(py - m.pos.y, px - m.pos.x);
    let delta = desired - m.heading;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const step = Math.sign(delta) * Math.min(Math.abs(delta), m.turnRate * dt);
    m.heading += step;
  }
  m.vel.x = Math.cos(m.heading) * m.speed;
  m.vel.y = Math.sin(m.heading) * m.speed;

  // Record trail.
  m.trail.push({ x: m.pos.x, y: m.pos.y });
  if (m.trail.length > 8) m.trail.shift();

  m.pos.x += m.vel.x * dt;
  m.pos.y += m.vel.y * dt;
  m.ttl -= dt;
  if (m.ttl <= 0) m.dead = true;
}

function spawnClusterChildren(parent, target, world) {
  const cfg = parent.cluster;
  const count = cfg.childCount || 5;
  const spread = cfg.childSpread != null ? cfg.childSpread : 0.45;
  const childSpeed = cfg.childSpeed || parent.speed * 1.05;
  const childTurnRate = cfg.childTurnRate || parent.turnRate * 1.6;
  const childTtl = cfg.childTtl || 2.5;
  const childDamage = cfg.childDamage != null ? cfg.childDamage : Math.max(8, parent.damage * 0.25);
  const childRadius = cfg.childRadius || Math.max(3, parent.radius * 0.6);
  const childHp = cfg.childHp || 1;
  // Heading toward the target at the moment of bloom, with each child
  // offset around that heading by an angular spread so they cover area
  // instead of stacking on top of each other. PD has to intercept
  // multiple incoming tracks rather than one fat round.
  const baseAng = Math.atan2(target.pos.y - parent.pos.y, target.pos.x - parent.pos.x);
  for (let i = 0; i < count; i++) {
    const offset = (count === 1) ? 0 : ((i - (count - 1) / 2) * (spread / Math.max(1, count - 1)));
    const heading = baseAng + offset;
    world.projectiles.push(createMissile({
      pos: parent.pos,
      heading,
      damage: childDamage,
      ttl: childTtl,
      radius: childRadius,
      color: parent.color,
      side: parent.side,
      ownerId: parent.ownerId,
      speed: childSpeed,
      turnRate: childTurnRate,
      hp: childHp,
      fromKlass: parent.fromKlass,
      acquireRange: parent.acquireRange,
      initialTarget: target,
      // Children carry no .cluster so they don't recursively split.
    }));
  }
}

function acquireMissileTarget(m, ships) {
  let best = null, bestD2 = m.acquireRange * m.acquireRange;
  for (const s of ships) {
    if (s.dead || s.side === m.side) continue;
    const dx = s.pos.x - m.pos.x;
    const dy = s.pos.y - m.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = s; }
  }
  return best;
}

export function drawProjectile(ctx, p) {
  if (p.kind === "missile") {
    drawMissile(ctx, p);
    return;
  }
  // Heavy cannon shells render as oriented streaks instead of perfect
  // circles. At fighter scale the circles read fine because the round
  // crosses several body-lengths per frame; for slow heavy rounds
  // (BB barrage, anything with radius >= 6) the circle just sat there
  // looking like a hovering orb. Stretching the round along velocity
  // gives the "tracer" silhouette the player expects from a cannon.
  if (p.radius >= 6) {
    const vx = p.vel ? p.vel.x : 0;
    const vy = p.vel ? p.vel.y : 0;
    const heading = (vx || vy) ? Math.atan2(vy, vx) : 0;
    ctx.save();
    ctx.translate(p.pos.x, p.pos.y);
    ctx.rotate(heading);
    ctx.fillStyle = p.color;
    // Length scaled with radius — gives big BB rounds a clearly long
    // streak without making fighter rounds look like noodles.
    const len = p.radius * 2.6;
    const halfH = p.radius * 0.78;
    ctx.beginPath();
    ctx.ellipse(0, 0, len, halfH, 0, 0, Math.PI * 2);
    ctx.fill();
    // Bright leading tip for the cannon "tracer" read.
    ctx.fillStyle = "#fff";
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.ellipse(len * 0.55, 0, len * 0.25, halfH * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.arc(p.pos.x, p.pos.y, p.radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawMissile(ctx, m) {
  // Smoke/flame trail.
  if (m.trail.length > 1) {
    ctx.strokeStyle = m.color;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(m.trail[0].x, m.trail[0].y);
    for (let i = 1; i < m.trail.length; i++) {
      ctx.lineTo(m.trail[i].x, m.trail[i].y);
    }
    ctx.lineTo(m.pos.x, m.pos.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // Body — a narrow rectangle oriented to heading.
  ctx.save();
  ctx.translate(m.pos.x, m.pos.y);
  ctx.rotate(m.heading);
  ctx.fillStyle = m.color;
  ctx.fillRect(-m.radius, -m.radius * 0.45, m.radius * 2, m.radius * 0.9);
  ctx.fillStyle = "#fff";
  ctx.fillRect(m.radius * 0.6, -m.radius * 0.25, m.radius * 0.4, m.radius * 0.5);
  ctx.restore();
}
