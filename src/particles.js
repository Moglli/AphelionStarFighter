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
//   fragment   — larger irregular polygon (hull chunk / armor flake)
//                tumbling outward, used when a piece breaks off a ship
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
  // Defaults match the legacy short flame flicker used by hit sparks +
  // destruction bursts. Engine and hull-vent VFX pass larger size /
  // longer ttl so sustained damage actually reads as fire, not a quick
  // pop.
  const ttl = opts.ttl != null ? opts.ttl : (0.45 + Math.random() * 0.45);
  const ang = opts.angle != null ? opts.angle : Math.random() * Math.PI * 2;
  const sp = opts.speed != null ? opts.speed : (18 + Math.random() * 45);
  const size = opts.size != null ? opts.size : (2.2 + Math.random() * 3);
  const sizeGrowth = opts.sizeGrowth != null ? opts.sizeGrowth : -1.6;
  return {
    kind: "fire",
    pos: { x, y },
    vel: { x: Math.cos(ang) * sp, y: Math.sin(ang) * sp },
    size, sizeGrowth,
    ttl, maxTtl: ttl,
    dead: false,
  };
}

// Random jagged polygon in unit space (vertices on a noisy radius). Used
// as the silhouette of a hull/armor fragment that's broken off a ship.
function randomFragmentShape() {
  const n = 4 + Math.floor(Math.random() * 3);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
    const r = 0.65 + Math.random() * 0.6;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}

export function createFragment(x, y, opts = {}) {
  const ttl = opts.ttl != null ? opts.ttl : (1.1 + Math.random() * 1.4);
  const ang = opts.angle != null ? opts.angle : Math.random() * Math.PI * 2;
  const sp = opts.speed != null ? opts.speed : (70 + Math.random() * 140);
  return {
    kind: "fragment",
    pos: { x, y },
    vel: { x: Math.cos(ang) * sp, y: Math.sin(ang) * sp },
    size: opts.size != null ? opts.size : (2.5 + Math.random() * 3),
    rot: Math.random() * Math.PI * 2,
    rotVel: (Math.random() - 0.5) * 7,
    ttl, maxTtl: ttl,
    color: opts.color || "#8a8a90",
    stroke: opts.stroke || "rgba(0,0,0,0.55)",
    shape: opts.shape || randomFragmentShape(),
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

// Bright muzzle-of-impact flash — a quick hot bloom at the point a round
// or missile bites metal. Very short ttl so it reads as the SPARK of
// contact, not lingering fire. Grows slightly as it fades.
export function createImpactFlash(x, y, opts = {}) {
  const ttl = opts.ttl != null ? opts.ttl : 0.12;
  return {
    kind: "flash",
    pos: { x, y },
    vel: { x: 0, y: 0 },
    size: opts.size != null ? opts.size : 5,
    sizeGrowth: opts.sizeGrowth != null ? opts.sizeGrowth : 55,
    ttl, maxTtl: ttl,
    color: opts.color || "255,235,180",   // r,g,b (no rgba wrapper)
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
  } else if (p.kind === "fragment") {
    // Slightly heavier than debris — chunks settle a bit faster.
    p.vel.x *= 0.955;
    p.vel.y *= 0.955;
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
  } else if (p.kind === "fragment") {
    ctx.save();
    ctx.translate(p.pos.x, p.pos.y);
    ctx.rotate(p.rot);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.strokeStyle = p.stroke;
    ctx.lineWidth = 0.6;
    const pts = p.shape;
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * p.size, pts[0][1] * p.size);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i][0] * p.size, pts[i][1] * p.size);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 1;
  } else if (p.kind === "shockwave") {
    ctx.strokeStyle = p.color + (alpha * 0.85).toFixed(3) + ")";
    ctx.lineWidth = 3 * alpha;
    ctx.beginPath();
    ctx.arc(p.pos.x, p.pos.y, p.size, 0, Math.PI * 2);
    ctx.stroke();
  } else if (p.kind === "flash") {
    // Hot white-ish core + soft coloured glow halo. Additive blend so
    // overlapping impact flashes read as a bright burst of contact.
    const prevOp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = "lighter";
    // Outer glow.
    ctx.fillStyle = "rgba(" + p.color + "," + (alpha * 0.45).toFixed(3) + ")";
    ctx.beginPath();
    ctx.arc(p.pos.x, p.pos.y, p.size * 2.0, 0, Math.PI * 2);
    ctx.fill();
    // Hot core.
    ctx.fillStyle = "rgba(255,250,235," + alpha.toFixed(3) + ")";
    ctx.beginPath();
    ctx.arc(p.pos.x, p.pos.y, p.size * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = prevOp;
  }
}

// ---------------------------------------------------------------------------
// Spawner helpers.
// ---------------------------------------------------------------------------

// A few sparks fanning outward from a module hit point.
export function spawnHitSparks(particles, x, y, count = 4) {
  for (let i = 0; i < count; i++) particles.push(createSpark(x, y));
}

// Armor flaking off — small light fragments + 1-2 sparks. Optional
// outwardAngle biases the fragment velocity away from the ship centre
// (caller passes the direction from ship centre to impact point).
export function spawnArmorFlakes(particles, x, y, damage, outwardAngle = null) {
  // Metal-on-metal: a bright flash + a fan of hot sparks ricocheting off
  // the plate + a couple of flaked fragments. Counts scale with the hit
  // so a heavy shell sprays where a light round just pings.
  const heavy = damage >= 50;
  particles.push(createImpactFlash(x, y, {
    size: 3.5 + Math.min(7, damage * 0.06),
    color: "255,225,150",
  }));
  const flakeCount = heavy ? 3 : 2;
  for (let i = 0; i < flakeCount; i++) {
    const ang = outwardAngle != null
      ? outwardAngle + (Math.random() - 0.5) * 1.2
      : Math.random() * Math.PI * 2;
    particles.push(createFragment(x, y, {
      color: "#b8b8c0",
      stroke: "rgba(20,20,30,0.6)",
      size: 1.8 + Math.random() * 1.6,
      angle: ang,
      speed: 90 + Math.random() * 120,
      ttl: 0.7 + Math.random() * 0.6,
    }));
  }
  // Spark fan — biased outward along the impact normal when known.
  const sparkCount = heavy ? 7 : 4;
  for (let i = 0; i < sparkCount; i++) {
    const ang = outwardAngle != null
      ? outwardAngle + (Math.random() - 0.5) * 1.6
      : Math.random() * Math.PI * 2;
    particles.push(createSpark(x, y, {
      color: "#ffe6a0",
      angle: ang,
      speed: 130 + Math.random() * 200,
    }));
  }
}

// Hull plates breaking off — bigger, ship-tinted fragments with longer
// ttl. `tint` is the ship's primary color; the fragment is rendered in
// that color so the broken piece reads as part of that ship's hull.
export function spawnHullBreakoff(particles, x, y, damage, tint, outwardAngle = null) {
  // BARE HULL — no shield/armour to cushion the strike, so this is the
  // most violent impact read: bright flash, hull shrapnel, a hot spark
  // shower, AND a brief flame lick + smoke wisp where the round bites
  // open metal. Everything scales with the hit so a missile gutting a
  // hull throws a fireball where a stray round just chips + sparks.
  const heavy = damage >= 80;
  const mid = damage >= 25;
  particles.push(createImpactFlash(x, y, {
    size: 4 + Math.min(10, damage * 0.08),
    color: "255,210,130",
  }));
  const count = heavy ? 3 + Math.floor(Math.random() * 2) : 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < count; i++) {
    const ang = outwardAngle != null
      ? outwardAngle + (Math.random() - 0.5) * 1.5
      : Math.random() * Math.PI * 2;
    particles.push(createFragment(x, y, {
      color: tint,
      stroke: "rgba(0,0,0,0.6)",
      size: heavy ? (3.5 + Math.random() * 3) : (2.5 + Math.random() * 2.5),
      angle: ang,
      speed: 60 + Math.random() * 140,
      ttl: 1.2 + Math.random() * 1.3,
    }));
  }
  // Hot spark shower from torn metal.
  const sparkCount = heavy ? 9 : (mid ? 6 : 3);
  for (let i = 0; i < sparkCount; i++) {
    const ang = outwardAngle != null
      ? outwardAngle + (Math.random() - 0.5) * 1.8
      : Math.random() * Math.PI * 2;
    particles.push(createSpark(x, y, {
      color: "#ffcf7a",
      angle: ang,
      speed: 120 + Math.random() * 220,
    }));
  }
  // Flame lick + smoke from the breach — bigger hits ignite more.
  const fireCount = heavy ? 3 : (mid ? 1 : 0);
  for (let i = 0; i < fireCount; i++) {
    particles.push(createFire(x, y, {
      size: 3 + Math.random() * 3,
      ttl: 0.4 + Math.random() * 0.4,
      speed: 30 + Math.random() * 50,
    }));
  }
  if (mid && Math.random() < 0.7) {
    particles.push(createSmoke(x, y, {
      color: "rgba(50,46,48,",
      size: 4 + Math.random() * 4,
      ttl: 0.9 + Math.random() * 0.7,
      sizeGrowth: 8 + Math.random() * 8,
      speed: 18 + Math.random() * 24,
    }));
  }
}

// Module-just-destroyed burst: shockwave + heavy sparks + debris + initial
// smoke puff + fire flickers. Radius is in world units, used to scale the
// shockwave and number of particles for big-vs-small modules. `intensity`
// scales the shockwave growth, spark count, and debris count — caller
// passes ~1.4 for armored capitals so their module deaths read as
// dramatic events vs the standard fighter-engine pop.
export function spawnDestructionBurst(particles, x, y, radius = 20, intensity = 1) {
  particles.push(createShockwave(x, y, {
    size: radius * 0.5,
    growth: Math.max(220, radius * 14 * intensity),
    color: "rgba(255,180,80,",
  }));
  const sparkCount = Math.floor((12 + radius * 0.3) * intensity);
  for (let i = 0; i < sparkCount; i++) {
    particles.push(createSpark(x, y, { color: "#ffd870" }));
  }
  const debrisCount = Math.floor(9 * intensity);
  for (let i = 0; i < debrisCount; i++) particles.push(createDebris(x, y));
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
      size: 7 + Math.random() * 5,
      ttl: 2.2 + Math.random() * 1.4,
      sizeGrowth: 12 + Math.random() * 12,
      speed: 15 + Math.random() * 22,
    }));
    // A blown compartment burns hard — near-constant flame (sometimes a
    // double flame for a real fire) plus arcing electrical sparks.
    if (Math.random() < 0.8) {
      particles.push(createFire(x, y, {
        size: 4 + Math.random() * 3.5,
        ttl: 0.6 + Math.random() * 0.6,
      }));
      if (Math.random() < 0.4) {
        particles.push(createFire(x, y, {
          size: 2.5 + Math.random() * 2,
          ttl: 0.4 + Math.random() * 0.4,
          speed: 30 + Math.random() * 40,
        }));
      }
    }
    // Electrical arc sparks spitting from the gutted system.
    if (Math.random() < 0.5) {
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        particles.push(createSpark(x, y, {
          color: "#bfe6ff",   // cool electrical-blue arc
          speed: 90 + Math.random() * 150,
          ttl: 0.15 + Math.random() * 0.2,
        }));
      }
    }
  } else {
    particles.push(createSmoke(x, y, {
      color: "rgba(95,95,105,",
      size: 4 + Math.random() * 3,
      ttl: 1.1 + Math.random() * 0.8,
      sizeGrowth: 7 + Math.random() * 8,
      speed: 12 + Math.random() * 20,
    }));
  }
}

// Engine venting plume: thick smoke pouring out the rear of a damaged
// engine nozzle, laced with fire when the engine is critically damaged
// or destroyed. `backwardAngle` is the world-space direction the engine
// vents toward (typically ship.heading + π). Severity 0..1 drives plume
// size, fire frequency, and smoke darkness — at >=0.85 (disabled) the
// vent is black and burning, at ~0.5 it's a gray exhaust trail.
export function spawnEnginePlumeVFX(particles, x, y, backwardAngle, severity) {
  const ang = backwardAngle + (Math.random() - 0.5) * 0.55;
  const sp = 28 + severity * 30 + Math.random() * 30;
  const dark = severity > 0.75;
  particles.push(createSmoke(x, y, {
    color: dark
      ? "rgba(18,16,18,"
      : (severity > 0.45 ? "rgba(55,50,55," : "rgba(100,95,100,"),
    angle: ang,
    speed: sp,
    size: 5 + severity * 7 + Math.random() * 3,
    sizeGrowth: 10 + severity * 14,
    ttl: 1.4 + severity * 1.6 + Math.random() * 0.5,
  }));
  // Ember glow: dim deep-red smoldering smoke instead of open flame.
  // Subtle heat bleed from the cracked nozzle — more "damaged engine"
  // than "on fire".
  const emberChance = 0.08 + severity * 0.18;
  if (Math.random() < emberChance) {
    particles.push(createSmoke(x, y, {
      color: "rgba(90,22,10,",
      angle: ang + (Math.random() - 0.5) * 0.4,
      speed: sp * 0.7 + Math.random() * 10,
      size: 2 + severity * 2.5 + Math.random() * 1.5,
      sizeGrowth: 4 + severity * 5,
      ttl: 0.4 + severity * 0.5,
    }));
  }
}

// Shield impact VFX. Outward shockwave + 4-6 sparks at the bubble
// hit point, tinted shield-blue (or shield-collapse white when the
// final hit drops the shield). `cost` scales the ring growth + spark
// count so a small fighter ping feels different from a missile slam.
export function spawnShieldImpact(particles, x, y, cost, collapsed = false) {
  const size = Math.max(6, Math.min(28, 6 + cost * 0.18));
  particles.push(createShockwave(x, y, {
    size: 4,
    growth: size * 18,
    color: collapsed ? "rgba(220,230,255," : "rgba(120,200,255,",
    ttl: 0.36 + Math.random() * 0.08,
  }));
  if (collapsed) {
    // Second ring expands faster + longer to mark the bubble drop.
    particles.push(createShockwave(x, y, {
      size: 8,
      growth: size * 28,
      color: "rgba(180,220,255,",
      ttl: 0.5,
    }));
  }
  const sparkCount = collapsed ? 10 : (cost > 30 ? 6 : 3);
  for (let i = 0; i < sparkCount; i++) {
    particles.push(createSpark(x, y, {
      color: collapsed ? "#e8f4ff" : "#bce8ff",
      speed: 120 + Math.random() * 160,
    }));
  }
}

// Hull venting damage VFX: smoke + occasional fire from a hull point on
// the silhouette edge. Used for ship-wide HP-low ambient damage so a
// half-dead capital visibly trails smoke from breached compartments.
// `outwardAngle` is the world-space direction from ship centre to the
// vent point — smoke drifts outward along this vector. Severity 0..1
// drives smoke darkness, fire chance, and emission size.
export function spawnHullVentVFX(particles, x, y, outwardAngle, severity) {
  const ang = outwardAngle + (Math.random() - 0.5) * 0.9;
  const sp = 16 + severity * 18 + Math.random() * 18;
  particles.push(createSmoke(x, y, {
    color: severity > 0.7
      ? "rgba(22,20,22,"
      : (severity > 0.4 ? "rgba(65,60,65," : "rgba(110,108,115,"),
    angle: ang,
    speed: sp,
    size: 3.5 + severity * 5 + Math.random() * 2,
    sizeGrowth: 6 + severity * 12,
    ttl: 1.0 + severity * 1.4 + Math.random() * 0.4,
  }));
  // Fire appears once the ship is hurt — earlier + heavier than before
  // so a wounded hull visibly burns. Below ~70% hp (severity > 0.3) a
  // flame can lick; deeper into the red it's a steady blaze with a
  // second flame jet, and a critical hull (severity > 0.8) spits an
  // electrical spark shower from breached compartments.
  const fireChance = severity > 0.30 ? (severity - 0.20) * 1.0 : 0;
  if (Math.random() < fireChance) {
    particles.push(createFire(x, y, {
      angle: ang,
      speed: sp * 0.9,
      size: 3 + severity * 4 + Math.random() * 1.5,
      ttl: 0.6 + severity * 0.8,
    }));
    if (severity > 0.6 && Math.random() < 0.55) {
      particles.push(createFire(x, y, {
        angle: ang + (Math.random() - 0.5) * 0.7,
        speed: sp * 0.7,
        size: 2.5 + Math.random() * 2.5,
        ttl: 0.5 + Math.random() * 0.5,
      }));
    }
  }
  // Critical-hull electrical arcs — sporadic blue spark bursts.
  if (severity > 0.8 && Math.random() < 0.3) {
    const n = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      particles.push(createSpark(x, y, {
        color: "#cfe8ff",
        speed: 80 + Math.random() * 140,
        ttl: 0.15 + Math.random() * 0.18,
      }));
    }
  }
}
