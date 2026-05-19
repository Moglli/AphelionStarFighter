// Lightweight particle system for combat VFX. Particles live in world
// space — they're spawned at world coordinates, drift independently,
// age out, and are rendered between the ship layer (smoke goes behind
// hulls) and the projectile layer (sparks / fire / debris go on top).
//
// Five particle kinds:
//   smoke      — gray puff, expands, slow drift, long ttl
//   spark      — small bright dot, fast outward, very short ttl
//   fire       — orange flicker, brief, shrinks
//   debris     — small rotating fragment, medium ttl, slight drag
//   shockwave  — expanding ring stroke, short ttl
//
// Public surface:
//   createSmoke / createSpark / createFire / createDebris / createShockwave
//   updateParticle(p, dt)
//   drawParticle(ctx, p)
//   spawnHitSparks(particles, x, y, count, side?)
//   spawnDestructionBurst(particles, x, y, radius)
//   spawnContinuousSmoke(particles, x, y, isDisabled)

export function createSmoke(x, y, opts = {}) {
  const ttl = opts.ttl != null ? opts.ttl : (1.5 + Math.random() * 1.5);
  const ang = opts.angle != null ? opts.angle : Math.random() * Math.PI * 2;
  const sp = opts.speed != null ? opts.speed : (10 + Math.random() * 25);
  return {
    kind: "smoke",
    pos: { x, y },
    vel: { x: Math.cos(ang) * sp, y: Math.sin(ang) * sp },
    size: opts.size != null ? opts.size : (5 + Math.random() * 5),
    sizeGrowth: opts.sizeGrowth != null ? opts.sizeGrowth : (8 + Math.random() * 14),
    ttl, maxTtl: ttl,
    color: opts.color || "rgba(70,70,80,",
    dead: false,
  };
}

export function createSpark(x, y, opts = {}) {
  const ttl = opts.ttl != null ? opts.ttl : (0.22 + Math.random() * 0.28);
  const ang = opts.angle != null ? opts.angle : Math.random() * Math.PI * 2;
  const sp = opts.speed != null ? opts.speed : (140 + Math.random() * 200);
  return {
    kind: "spark",
    pos: { x, y },
    vel: { x: Math.cos(ang) * sp, y: Math.sin(ang) * sp },
    size: 1.4 + Math.random() * 1.8,
    ttl, maxTtl: ttl,
    color: opts.color || "#ffd070",
    dead: false,
  };
}

export function createDebris(x, y, opts = {}) {
  const ttl = 0.9 + Math.random() * 1.1;
  const ang = opts.angle != null ? opts.angle : Math.random() * Math.PI * 2;
  const sp = 70 + Math.random() * 160;
  return {
    kind: "debris",
    pos: { x, y },
    vel: { x: Math.cos(ang) * sp, y: Math.sin(ang) * sp },
    size: 1.8 + Math.random() * 2.8,
    rot: Math.random() * Math.PI * 2,
    rotVel: (Math.random() - 0.5) * 9,
    ttl, maxTtl: ttl,
    color: opts.color || "#6a4a36",
    dead: false,
  };
}

export function createFire(x, y, opts = {}) {
  const ttl = 0.45 + Math.random() * 0.45;
  const ang = opts.angle != null ? opts.angle : Math.random() * Math.PI * 2;
  const sp = 18 + Math.random() * 45;
  return {
    kind: "fire",
    pos: { x, y },
    vel: { x: Math.cos(ang) * sp, y: Math.sin(ang) * sp },
    size: 2.2 + Math.random() * 3,
    sizeGrowth: -1.6,
    ttl, maxTtl: ttl,
    dead: false,
  };
}

export function createShockwave(x, y, opts = {}) {
  const ttl = opts.ttl != null ? opts.ttl : 0.42;
  return {
    kind: "shockwave",
    pos: { x, y },
    vel: { x: 0, y: 0 },
    size: opts.size != null ? opts.size : 8,
    sizeGrowth: opts.growth != null ? opts.growth : 320,
    ttl, maxTtl: ttl,
    color: opts.color || "rgba(255,200,120,",
    dead: false,
  };
}

export function updateParticle(p, dt) {
  p.pos.x += p.vel.x * dt;
  p.pos.y += p.vel.y * dt;
  if (p.kind === "smoke") {
    p.vel.x *= 0.96;
    p.vel.y *= 0.96;
  } else if (p.kind === "debris") {
    p.vel.x *= 0.97;
    p.vel.y *= 0.97;
    p.rot += p.rotVel * dt;
  } else if (p.kind === "spark") {
    p.vel.x *= 0.92;
    p.vel.y *= 0.92;
  }
  if (p.sizeGrowth) p.size += p.sizeGrowth * dt;
  if (p.size < 0) p.size = 0;
  p.ttl -= dt;
  if (p.ttl <= 0) p.dead = true;
}

export function drawParticle(ctx, p) {
  const alpha = Math.max(0, Math.min(1, p.ttl / p.maxTtl));
  if (alpha <= 0) return;
  if (p.kind === "smoke") {
    ctx.fillStyle = p.color + (alpha * 0.7).toFixed(3) + ")";
    ctx.beginPath();
    ctx.arc(p.pos.x, p.pos.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  } else if (p.kind === "spark") {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.pos.x, p.pos.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  } else if (p.kind === "fire") {
    // Fade from yellow-white through orange to dim red.
    const t = 1 - alpha;
    const r = 255;
    const g = Math.round(230 - t * 200);
    const b = Math.round(120 - t * 120);
    ctx.fillStyle = "rgba(" + r + "," + g + "," + b + "," + alpha.toFixed(3) + ")";
    ctx.beginPath();
    ctx.arc(p.pos.x, p.pos.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  } else if (p.kind === "debris") {
    ctx.save();
    ctx.translate(p.pos.x, p.pos.y);
    ctx.rotate(p.rot);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size, -p.size * 0.55, p.size * 2, p.size * 1.1);
    ctx.restore();
    ctx.globalAlpha = 1;
  } else if (p.kind === "shockwave") {
    ctx.strokeStyle = p.color + (alpha * 0.85).toFixed(3) + ")";
    ctx.lineWidth = 3 * alpha;
    ctx.beginPath();
    ctx.arc(p.pos.x, p.pos.y, p.size, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Spawner helpers.
// ---------------------------------------------------------------------------

// A few sparks fanning outward from a module hit point.
export function spawnHitSparks(particles, x, y, count = 4) {
  for (let i = 0; i < count; i++) particles.push(createSpark(x, y));
}

// Module-just-destroyed burst: shockwave + heavy sparks + debris + initial
// smoke puff + fire flickers. Radius is in world units, used to scale the
// shockwave and number of particles for big-vs-small modules.
export function spawnDestructionBurst(particles, x, y, radius = 20) {
  particles.push(createShockwave(x, y, {
    size: radius * 0.5,
    growth: Math.max(220, radius * 14),
    color: "rgba(255,180,80,",
  }));
  const sparkCount = 12 + Math.floor(radius * 0.3);
  for (let i = 0; i < sparkCount; i++) {
    particles.push(createSpark(x, y, { color: "#ffd870" }));
  }
  for (let i = 0; i < 9; i++) particles.push(createDebris(x, y));
  for (let i = 0; i < 5; i++) {
    particles.push(createSmoke(x, y, {
      color: "rgba(40,40,45,",
      size: 6 + Math.random() * 8,
      ttl: 1.8 + Math.random() * 1.4,
    }));
  }
  for (let i = 0; i < 7; i++) particles.push(createFire(x, y));
}

// Continuous emission from a damaged-but-alive (lighter smoke) or
// disabled (heavy black smoke + fire) module. Caller decides the rate
// by gating how often it invokes this with the spawn coin-flip.
export function spawnContinuousSmoke(particles, x, y, isDisabled) {
  if (isDisabled) {
    particles.push(createSmoke(x, y, {
      color: "rgba(25,25,30,",
      size: 6 + Math.random() * 4,
      ttl: 2.0 + Math.random() * 1.2,
      sizeGrowth: 10 + Math.random() * 10,
      speed: 15 + Math.random() * 20,
    }));
    if (Math.random() < 0.35) particles.push(createFire(x, y));
  } else {
    particles.push(createSmoke(x, y, {
      color: "rgba(110,110,120,",
      size: 3.5 + Math.random() * 2.5,
      ttl: 1.0 + Math.random() * 0.7,
      sizeGrowth: 6 + Math.random() * 6,
      speed: 12 + Math.random() * 18,
    }));
  }
}
