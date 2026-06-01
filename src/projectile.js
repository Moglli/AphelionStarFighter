// Projectile kinds:
//   "cannon" — straight-line shell or PD round.
//   "missile" — homing, has its own hp and can be shot down by PD.
//   "laser"  — sustained-effect representation (the actual beam is handled
//              in game.js as an immediate hit + visual; this kind only exists
//              for completeness if needed).
//
// Damage interaction with shields is computed in game.js (see applyDamage).

import { createShockwave, createSpark } from "./particles.js";
import { events } from "./events.js";

export function createProjectile({
  pos, vel, damage, ttl, radius, color, side, ownerId, ownerKlass = null,
  kind = "cannon", fromKlass = null, race = null,
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
    ownerKlass,
    kind,
    fromKlass,
    race,           // firing faction — drives per-faction projectile art only
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
  armorPiercing = false,
  bypassShield = false,
  blastRadius = null,
  antiCraftBonus = null,
  race = null,
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
    race,           // firing faction — drives per-faction missile art only
    dead: false,
    hp,
    speed,
    turnRate,
    acquireRange,
    targetId: initialTarget ? initialTarget.id : null,
    targetModuleName,
    cluster,
    armorPiercing,
    bypassShield,
    blastRadius,
    antiCraftBonus,
    trail: [],
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
    //
    // Two design rules layer on top of `cluster.bloomDistance`:
    //   1. Bloom OUTSIDE the target's PD range. The whole point of
    //      clustering is to overwhelm PD with multiple tracks; if the
    //      parent waited until inside PD it'd just get shot down whole.
    //      Effective bloom = max(spec bloom, target PD range + slack).
    //   2. If the parent was *fired* from inside the target's PD range
    //      (point-blank launch), it would bloom in the same frame next
    //      to the owner's hull. Gate the bloom on having cleared the
    //      launching ship by at least owner.radius + 80u.
    if (m.cluster) {
      const ddx = target.pos.x - m.pos.x;
      const ddy = target.pos.y - m.pos.y;
      const ddist2 = ddx * ddx + ddy * ddy;
      const targetPdRange = (target.spec && target.spec.pdCannons && target.spec.pdCannons.range) || 0;
      const effectiveBloom = Math.max(m.cluster.bloomDistance, targetPdRange + 60);
      let clearedOwner = true;
      if (m.ownerId != null && world && world.ships) {
        const owner = world.ships.find((s) => s.id === m.ownerId);
        if (owner) {
          const ox = owner.pos.x - m.pos.x;
          const oy = owner.pos.y - m.pos.y;
          const ownerR = (owner.spec && owner.spec.radius) || 60;
          const minClear = ownerR + 80;
          clearedOwner = (ox * ox + oy * oy) >= (minClear * minClear);
        }
      }
      if (ddist2 <= effectiveBloom * effectiveBloom && clearedOwner) {
        spawnClusterChildren(m, target, world);
        // Cluster-bloom SFX event — sharp burst + scatter sparkle so
        // the defending player hears multi-track inbound.
        events.emit("missileBloom", { x: m.pos.x, y: m.pos.y });
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
    // Guard a zero/NaN missile speed — a divide here would NaN the heading
    // and position, producing an undying NaN projectile that poisons every
    // distance/collision check. No valid speed → no lead this tick.
    const t = m.speed > 0 ? dist / m.speed : 0;
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
  const count = cfg.childCount || 6;
  const childSpeed = cfg.childSpeed || parent.speed * 1.05;
  const childTurnRate = cfg.childTurnRate || parent.turnRate * 1.6;
  const childTtl = cfg.childTtl || 2.5;
  const childDamage = cfg.childDamage != null ? cfg.childDamage : Math.max(8, parent.damage * 0.25);
  const childRadius = cfg.childRadius || Math.max(3, parent.radius * 0.6);
  const childHp = cfg.childHp || 1;
  // Angular cone of headings. Children leave from `parent.pos` and
  // fan out across `childSpread` radians centred on the parent's
  // approach vector. With childSpread ≈ 2.79 (160°) the outer warheads
  // launch at ±80° off the target line, so the cluster bursts into a
  // genuinely wide cone — outer tracks loop back onto the target
  // under their own homing rather than ride a tight angular fan.
  const childSpread = cfg.childSpread != null ? cfg.childSpread : Math.PI; // default 180°

  const baseAng = Math.atan2(target.pos.y - parent.pos.y, target.pos.x - parent.pos.x);
  const perpX = -Math.sin(baseAng);
  const perpY =  Math.cos(baseAng);

  // "Umbrella" bloom VFX. Outer + inner shockwave then sparks fanning
  // across the same cone the warheads launch through, so the bloom
  // VFX matches the actual spread the player sees a moment later.
  if (world && world.particles) {
    const tint = parent.color || "#fff";
    const rgba = hexToRgba(tint, "0.85");
    // Scale shockwave growth with the cone width so a 160° burst
    // reads visibly wider than a tight angular cluster.
    const wideMul = Math.max(1, childSpread / Math.PI);
    world.particles.push(createShockwave(parent.pos.x, parent.pos.y, {
      size: parent.radius + 6,
      growth: 540 + 280 * wideMul,
      ttl: 0.55,
      color: hexToRgba(tint, ""),
    }));
    world.particles.push(createShockwave(parent.pos.x, parent.pos.y, {
      size: parent.radius + 2,
      growth: 360 + 180 * wideMul,
      ttl: 0.42,
      color: "rgba(255,255,255,",
    }));
    // Spark cone: tracks the same angular fan the warheads will
    // launch into, so the umbrella's "ribs" land along the bloom's
    // outgoing trajectories.
    const sparkCount = Math.max(14, count * 4);
    for (let k = 0; k < sparkCount; k++) {
      const off = (Math.random() - 0.5) * childSpread;
      const sp = 280 + Math.random() * 240;
      world.particles.push(createSpark(parent.pos.x, parent.pos.y, {
        angle: baseAng + off,
        speed: sp,
        ttl: 0.30 + Math.random() * 0.28,
        color: tint,
      }));
    }
    // Perpendicular trim sparks punctuate the cone's edges so the
    // bloom reads as "open canister" even at distance.
    for (let s = -1; s <= 1; s += 2) {
      for (let k = 0; k < 3; k++) {
        const a = baseAng + s * (childSpread / 2 + (Math.random() - 0.5) * 0.3);
        world.particles.push(createSpark(parent.pos.x, parent.pos.y, {
          angle: a,
          speed: 160 + Math.random() * 120,
          ttl: 0.25 + Math.random() * 0.22,
          color: rgba,
        }));
      }
    }
    void perpX; void perpY;
  }

  for (let i = 0; i < count; i++) {
    // Symmetric fan: evenly spaced across the full childSpread cone.
    const offset = (count === 1)
      ? 0
      : ((i - (count - 1) / 2) * (childSpread / (count - 1)));
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
      race: parent.race,
      acquireRange: parent.acquireRange,
      initialTarget: target,
      bypassShield: parent.bypassShield,
      blastRadius: cfg.childBlastRadius || null,
      // Children carry no .cluster so they don't recursively split.
    }));
  }
}

// Tiny helper so the bloom VFX can take a `#rrggbb` parent colour and
// turn it into the `rgba(r,g,b,` prefix that createShockwave wants
// (the shockwave appends its own alpha at draw time). Hex shorthand
// (#rgb) gets expanded, anything else falls back to a neutral white.
function hexToRgba(hex, alpha) {
  if (typeof hex !== "string" || hex[0] !== "#") return `rgba(255,255,255,${alpha})`;
  let h = hex.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6) return `rgba(255,255,255,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return alpha === "" ? `rgba(${r},${g},${b},` : `rgba(${r},${g},${b},${alpha})`;
}

function acquireMissileTarget(m, ships) {
  // Missiles fired from capitals (or cluster children inheriting that
  // owner class) should never re-acquire onto small craft when their
  // original target dies — a 70-110 dmg pod missile bypasses shields
  // and one-shots fighters, which is precisely the bulk-disappearance
  // bug we're fixing. Fighter missiles (fromKlass === "fighter") keep
  // the open re-acquire so a dogfight missile can switch onto a new
  // enemy fighter mid-flight.
  const ownerIsCapital = m.fromKlass && m.fromKlass !== "fighter";
  let best = null, bestD2 = m.acquireRange * m.acquireRange;
  for (const s of ships) {
    if (s.dead || s.side === m.side) continue;
    // A missile that lost its original target must not re-acquire onto a
    // ship that has since surrendered — a surrendered hulk was never
    // "targeted before the white flag". (Missiles whose original lock is
    // still alive keep homing through that ship's surrender via the
    // targetId path in updateMissile — that's the intended in-flight hit.)
    if (s.surrendered) continue;
    if (ownerIsCapital && (s.klass === "fighter" || s.klass === "bomber")) continue;
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
  if (p.fromKlass === "battleship") {
    drawBattleshipShell(ctx, p);
    return;
  }
  if (p.fromKlass === "cruiser") {
    drawCruiserShell(ctx, p);
    return;
  }
  if (p.fromKlass === "carrier") {
    drawCarrierShell(ctx, p);
    return;
  }
  drawFactionRound(ctx, p);
}

// ---------------------------------------------------------------------------
// Per-faction projectile + missile aesthetics. VISUAL ONLY — damage, speed,
// radius, ttl, homing, PD-interception etc. are unchanged; this just picks a
// colour + silhouette per firing faction (p.race / m.race, stamped at fire
// time). Unknown race → terran-style fallback. `c` = core/body colour,
// `g` = [r,g,b] glow, `shape` = silhouette renderer.
// ---------------------------------------------------------------------------
const PROJECTILE_STYLE = {
  terran:    { c: "#bfe6ff", g: [150, 210, 255], shape: "tracer" },
  reavers:   { c: "#ff7a3c", g: [255, 110,  55], shape: "shard"  },
  hegemony:  { c: "#ffd86a", g: [255, 200,  90], shape: "slug"   },
  voidsworn: { c: "#c59cff", g: [180, 120, 255], shape: "lance"  },
  thren:     { c: "#9dff8a", g: [150, 255, 120], shape: "pellet" },
  brood:     { c: "#caff5a", g: [180, 245,  80], shape: "spore"  },
  saurian:   { c: "#ffb24a", g: [255, 170,  70], shape: "bolt"   },
  synthetics:{ c: "#8ff4ff", g: [150, 240, 255], shape: "packet" },
};
function projStyle(p) { return PROJECTILE_STYLE[p.race] || PROJECTILE_STYLE.terran; }

const MISSILE_STYLE = {
  terran:    { body: "#cdd6e6", trail: [160, 210, 255], shape: "sleek"  },
  reavers:   { body: "#5a2018", trail: [255, 110,  55], shape: "jagged" },
  hegemony:  { body: "#5a431a", trail: [255, 200,  90], shape: "heavy"  },
  voidsworn: { body: "#3a2a6a", trail: [180, 120, 255], shape: "lance"  },
  thren:     { body: "#1f5a2a", trail: [150, 255, 120], shape: "organic"},
  brood:     { body: "#2a4a16", trail: [180, 245,  80], shape: "organic"},
  saurian:   { body: "#5a4020", trail: [255, 170,  70], shape: "finned" },
  synthetics:{ body: "#284a5a", trail: [150, 240, 255], shape: "sleek"  },
};
function missileStyle(m) { return MISSILE_STYLE[m.race] || MISSILE_STYLE.terran; }

function drawFactionRound(ctx, p) {
  const st = projStyle(p);
  const R = p.radius;
  const vx = p.vel ? p.vel.x : 0, vy = p.vel ? p.vel.y : 0;
  const heading = (vx || vy) ? Math.atan2(vy, vx) : 0;
  const [gr, gg, gb] = st.g;
  ctx.save();
  ctx.translate(p.pos.x, p.pos.y);
  ctx.rotate(heading);
  switch (st.shape) {
    case "tracer": {            // Terran — bright bolt + short white-hot head
      ctx.fillStyle = st.c;
      ctx.beginPath(); ctx.ellipse(0, 0, R * 1.8, R * 0.7, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(R * 0.9, 0, R * 0.5, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case "shard": {             // Reaver — jagged angular splinter
      ctx.fillStyle = st.c;
      ctx.beginPath();
      ctx.moveTo(R * 2.0, 0); ctx.lineTo(-R * 0.6, R * 0.95);
      ctx.lineTo(-R * 1.1, 0); ctx.lineTo(-R * 0.6, -R * 0.95);
      ctx.closePath(); ctx.fill();
      break;
    }
    case "slug": {              // Hegemony — heavy dark-cored gold slug
      ctx.fillStyle = "rgba(30,20,8,0.9)";
      ctx.beginPath(); ctx.ellipse(0, 0, R * 1.5, R * 0.95, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = st.c;
      ctx.beginPath(); ctx.ellipse(R * 0.2, 0, R * 0.85, R * 0.6, 0, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case "lance": {             // Voidsworn — long glowing energy lance
      const grad = ctx.createLinearGradient(-R * 2.4, 0, R * 2.4, 0);
      grad.addColorStop(0, `rgba(${gr},${gg},${gb},0)`);
      grad.addColorStop(0.5, st.c);
      grad.addColorStop(1, "#fff");
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.ellipse(0, 0, R * 2.4, R * 0.5, 0, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case "pellet": {            // Thren — round bioluminescent blob
      const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 2.0);
      halo.addColorStop(0, st.c); halo.addColorStop(0.5, `rgba(${gr},${gg},${gb},0.5)`);
      halo.addColorStop(1, `rgba(${gr},${gg},${gb},0)`);
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(0, 0, R * 2.0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#eaffe0";
      ctx.beginPath(); ctx.arc(0, 0, R * 0.7, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case "spore": {             // Brood — acid glob + faint pulsing halo
      const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 2.2);
      halo.addColorStop(0, `rgba(${gr},${gg},${gb},0.9)`);
      halo.addColorStop(1, `rgba(${gr},${gg},${gb},0)`);
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(0, 0, R * 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = st.c;
      ctx.beginPath(); ctx.arc(0, 0, R * 0.85, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(40,70,16,0.9)";  // dark organic fleck
      ctx.beginPath(); ctx.arc(R * 0.2, -R * 0.15, R * 0.3, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case "bolt": {              // Saurian — sharp bronze double-streak
      ctx.fillStyle = st.c;
      ctx.beginPath();
      ctx.moveTo(R * 2.2, 0); ctx.lineTo(-R * 1.4, R * 0.45);
      ctx.lineTo(-R * 1.4, -R * 0.45); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#fff6e0";
      ctx.beginPath(); ctx.arc(R * 1.2, 0, R * 0.4, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case "packet": {            // Synthetics — crisp digital diamond
      ctx.fillStyle = `rgba(${gr},${gg},${gb},0.45)`;
      ctx.beginPath(); ctx.arc(0, 0, R * 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = st.c;
      ctx.beginPath();
      ctx.moveTo(R * 1.3, 0); ctx.lineTo(0, R * 0.9); ctx.lineTo(-R * 1.3, 0); ctx.lineTo(0, -R * 0.9);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillRect(-R * 0.25, -R * 0.25, R * 0.5, R * 0.5);
      break;
    }
    default: {
      ctx.fillStyle = st.c;
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

// Battleship broadside round: a slim elongated naval artillery shell.
// Dark steel body, tapered nose, hot white impact tip, warm tracer wake.
function drawBattleshipShell(ctx, p) {
  const vx = p.vel ? p.vel.x : 0;
  const vy = p.vel ? p.vel.y : 0;
  if (!vx && !vy) return;
  ctx.save();
  ctx.translate(p.pos.x, p.pos.y);
  ctx.rotate(Math.atan2(vy, vx));

  const R     = p.radius;
  const hW    = R * 0.30;   // slim half-height
  const noseX = R * 1.0;    // tip ahead of centre
  const bodyL = R * 2.8;    // body length behind centre
  const wakeL = R * 6.0;    // tracer wake length

  // Tracer wake — warm glow fading out behind the round
  const wake = ctx.createLinearGradient(-wakeL, 0, -bodyL * 0.2, 0);
  wake.addColorStop(0,   "rgba(255,210,130,0)");
  wake.addColorStop(1,   "rgba(255,210,130,0.22)");
  ctx.beginPath();
  ctx.ellipse(-(wakeL * 0.5 + bodyL * 0.1), 0, wakeL * 0.5, hW * 0.55, 0, 0, Math.PI * 2);
  ctx.fillStyle = wake;
  ctx.fill();

  // Shell body — dark steel, tapered at both ends
  ctx.beginPath();
  ctx.moveTo(noseX * 0.55,  0);         // tip (where nose glow sits)
  ctx.lineTo(R * 0.05,      hW);        // forward shoulder
  ctx.lineTo(-bodyL,        hW * 0.28); // tail top
  ctx.lineTo(-bodyL,       -hW * 0.28); // tail bottom
  ctx.lineTo(R * 0.05,     -hW);        // forward shoulder bottom
  ctx.closePath();
  ctx.fillStyle = "#2c2a34";
  ctx.fill();

  // Specular rim — faint highlight along the upper edge to sell the
  // cylindrical metal shape
  ctx.beginPath();
  ctx.moveTo(R * 0.4,     -hW * 0.12);
  ctx.lineTo(-bodyL * 0.75, -hW * 0.52);
  ctx.lineWidth   = hW * 0.22;
  ctx.strokeStyle = "rgba(150,140,180,0.40)";
  ctx.stroke();

  // Hot nose — white-core radial glow compressed at the tip
  const noseCx   = noseX * 0.48;
  const noseGlow = ctx.createRadialGradient(noseCx, 0, 0, noseCx, 0, R * 0.95);
  noseGlow.addColorStop(0,    "rgba(255,255,255,1.0)");
  noseGlow.addColorStop(0.30, "rgba(255,240,210,0.85)");
  noseGlow.addColorStop(0.65, "rgba(220,200,255,0.30)");
  noseGlow.addColorStop(1.0,  "rgba(180,160,220,0)");
  ctx.beginPath();
  ctx.arc(noseCx, 0, R * 0.95, 0, Math.PI * 2);
  ctx.fillStyle = noseGlow;
  ctx.fill();

  ctx.restore();
}

// Thren carrier bow round: the largest single cannon shell in the game.
// Heavier and slower than a BB broadside — fatter body, longer wake,
// bioluminescent green-white nose tint to match Thren's faction identity.
function drawCarrierShell(ctx, p) {
  const vx = p.vel ? p.vel.x : 0;
  const vy = p.vel ? p.vel.y : 0;
  if (!vx && !vy) return;
  ctx.save();
  ctx.translate(p.pos.x, p.pos.y);
  ctx.rotate(Math.atan2(vy, vx));

  const R     = p.radius;
  const hW    = R * 0.34;   // slightly fatter than BB — a heavy mass-driver round
  const noseX = R * 1.15;
  const bodyL = R * 3.2;
  const wakeL = R * 7.0;    // long wake — this thing is slow and massive

  // Tracer wake — cool green-tinted glow
  const wake = ctx.createLinearGradient(-wakeL, 0, -bodyL * 0.2, 0);
  wake.addColorStop(0, "rgba(140,255,200,0)");
  wake.addColorStop(1, "rgba(140,255,200,0.18)");
  ctx.beginPath();
  ctx.ellipse(-(wakeL * 0.5 + bodyL * 0.1), 0, wakeL * 0.5, hW * 0.6, 0, 0, Math.PI * 2);
  ctx.fillStyle = wake;
  ctx.fill();

  // Shell body — dark with a faint organic green undertone
  ctx.beginPath();
  ctx.moveTo(noseX * 0.55,  0);
  ctx.lineTo(R * 0.06,      hW);
  ctx.lineTo(-bodyL,        hW * 0.30);
  ctx.lineTo(-bodyL,       -hW * 0.30);
  ctx.lineTo(R * 0.06,     -hW);
  ctx.closePath();
  ctx.fillStyle = "#1e2a22";
  ctx.fill();

  // Specular rim
  ctx.beginPath();
  ctx.moveTo(R * 0.45,      -hW * 0.12);
  ctx.lineTo(-bodyL * 0.78, -hW * 0.54);
  ctx.lineWidth   = hW * 0.22;
  ctx.strokeStyle = "rgba(120,200,150,0.38)";
  ctx.stroke();

  // Hot nose — bioluminescent green-white
  const noseCx   = noseX * 0.50;
  const noseGlow = ctx.createRadialGradient(noseCx, 0, 0, noseCx, 0, R * 1.05);
  noseGlow.addColorStop(0,    "rgba(255,255,255,1.0)");
  noseGlow.addColorStop(0.28, "rgba(200,255,230,0.85)");
  noseGlow.addColorStop(0.62, "rgba(100,220,160,0.30)");
  noseGlow.addColorStop(1.0,  "rgba(60,180,110,0)");
  ctx.beginPath();
  ctx.arc(noseCx, 0, R * 1.05, 0, Math.PI * 2);
  ctx.fillStyle = noseGlow;
  ctx.fill();

  ctx.restore();
}

// Cruiser forward cannon round: slimmer and sharper than a BB broadside
// shell — faster-moving so the wake is shorter and the profile narrower.
function drawCruiserShell(ctx, p) {
  const vx = p.vel ? p.vel.x : 0;
  const vy = p.vel ? p.vel.y : 0;
  if (!vx && !vy) return;
  ctx.save();
  ctx.translate(p.pos.x, p.pos.y);
  ctx.rotate(Math.atan2(vy, vx));

  const R     = p.radius;
  const hW    = R * 0.24;   // narrower than BB
  const noseX = R * 0.9;
  const bodyL = R * 2.4;
  const wakeL = R * 4.2;    // shorter wake — round travels faster

  // Tracer wake
  const wake = ctx.createLinearGradient(-wakeL, 0, -bodyL * 0.15, 0);
  wake.addColorStop(0, "rgba(200,230,255,0)");
  wake.addColorStop(1, "rgba(200,230,255,0.18)");
  ctx.beginPath();
  ctx.ellipse(-(wakeL * 0.5 + bodyL * 0.08), 0, wakeL * 0.5, hW * 0.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = wake;
  ctx.fill();

  // Shell body
  ctx.beginPath();
  ctx.moveTo(noseX * 0.5,   0);
  ctx.lineTo(R * 0.04,      hW);
  ctx.lineTo(-bodyL,        hW * 0.25);
  ctx.lineTo(-bodyL,       -hW * 0.25);
  ctx.lineTo(R * 0.04,     -hW);
  ctx.closePath();
  ctx.fillStyle = "#252830";
  ctx.fill();

  // Specular rim
  ctx.beginPath();
  ctx.moveTo(R * 0.35,      -hW * 0.10);
  ctx.lineTo(-bodyL * 0.72, -hW * 0.50);
  ctx.lineWidth   = hW * 0.20;
  ctx.strokeStyle = "rgba(130,160,200,0.38)";
  ctx.stroke();

  // Hot nose — slightly cooler blue-white than BB (forward kinetic round)
  const noseCx   = noseX * 0.42;
  const noseGlow = ctx.createRadialGradient(noseCx, 0, 0, noseCx, 0, R * 0.82);
  noseGlow.addColorStop(0,    "rgba(255,255,255,1.0)");
  noseGlow.addColorStop(0.30, "rgba(220,240,255,0.80)");
  noseGlow.addColorStop(0.65, "rgba(160,200,255,0.28)");
  noseGlow.addColorStop(1.0,  "rgba(120,170,230,0)");
  ctx.beginPath();
  ctx.arc(noseCx, 0, R * 0.82, 0, Math.PI * 2);
  ctx.fillStyle = noseGlow;
  ctx.fill();

  ctx.restore();
}

function drawMissile(ctx, m) {
  const st = missileStyle(m);
  const [tr, tg, tb] = st.trail;
  const R = m.radius;
  // Faction-tinted exhaust trail.
  if (m.trail.length > 1) {
    ctx.strokeStyle = `rgba(${tr},${tg},${tb},0.4)`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(m.trail[0].x, m.trail[0].y);
    for (let i = 1; i < m.trail.length; i++) ctx.lineTo(m.trail[i].x, m.trail[i].y);
    ctx.lineTo(m.pos.x, m.pos.y);
    ctx.stroke();
  }
  ctx.save();
  ctx.translate(m.pos.x, m.pos.y);
  ctx.rotate(m.heading);
  // Exhaust glow at the tail.
  const ex = ctx.createRadialGradient(-R, 0, 0, -R, 0, R * 1.6);
  ex.addColorStop(0, `rgba(${tr},${tg},${tb},0.85)`);
  ex.addColorStop(1, `rgba(${tr},${tg},${tb},0)`);
  ctx.fillStyle = ex;
  ctx.beginPath(); ctx.arc(-R, 0, R * 1.6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = st.body;
  switch (st.shape) {
    case "organic":             // Thren / Brood — lumpy spore-pod
      ctx.beginPath(); ctx.ellipse(0, 0, R * 1.3, R * 0.7, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgba(${tr},${tg},${tb},0.95)`;   // glowing nose sac
      ctx.beginPath(); ctx.arc(R * 0.9, 0, R * 0.5, 0, Math.PI * 2); ctx.fill();
      break;
    case "jagged":              // Reaver — notched scrap warhead
      ctx.beginPath();
      ctx.moveTo(R * 1.2, 0); ctx.lineTo(R * 0.2, R * 0.5); ctx.lineTo(-R, R * 0.45);
      ctx.lineTo(-R * 0.6, 0); ctx.lineTo(-R, -R * 0.45); ctx.lineTo(R * 0.2, -R * 0.5);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = `rgba(${tr},${tg},${tb},0.9)`;
      ctx.fillRect(R * 0.7, -R * 0.2, R * 0.4, R * 0.4);
      break;
    case "heavy":               // Hegemony — fat banded torpedo
      ctx.fillRect(-R * 1.1, -R * 0.55, R * 2.2, R * 1.1);
      ctx.fillStyle = "rgba(20,14,4,0.7)";
      ctx.fillRect(-R * 0.2, -R * 0.55, R * 0.18, R * 1.1);
      ctx.fillRect(-R * 0.7, -R * 0.55, R * 0.18, R * 1.1);
      ctx.fillStyle = `rgba(${tr},${tg},${tb},0.95)`;
      ctx.beginPath(); ctx.arc(R * 0.95, 0, R * 0.4, 0, Math.PI * 2); ctx.fill();
      break;
    case "lance":               // Voidsworn — sleek glowing dart
      ctx.beginPath();
      ctx.moveTo(R * 1.4, 0); ctx.lineTo(-R, R * 0.4); ctx.lineTo(-R, -R * 0.4);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(R * 1.0, 0, R * 0.28, 0, Math.PI * 2); ctx.fill();
      break;
    case "finned":              // Saurian — swept-fin missile
      ctx.fillRect(-R, -R * 0.4, R * 2, R * 0.8);
      ctx.beginPath();          // swept fins
      ctx.moveTo(-R * 0.6, -R * 0.4); ctx.lineTo(-R * 1.2, -R * 0.9); ctx.lineTo(-R * 0.5, -R * 0.4);
      ctx.moveTo(-R * 0.6, R * 0.4); ctx.lineTo(-R * 1.2, R * 0.9); ctx.lineTo(-R * 0.5, R * 0.4);
      ctx.fill();
      ctx.fillStyle = `rgba(${tr},${tg},${tb},0.95)`;
      ctx.fillRect(R * 0.6, -R * 0.22, R * 0.4, R * 0.44);
      break;
    default:                    // "sleek" — Terran / Synthetics
      ctx.fillRect(-R, -R * 0.45, R * 2, R * 0.9);
      ctx.fillStyle = `rgba(${tr},${tg},${tb},0.95)`;
      ctx.fillRect(R * 0.6, -R * 0.25, R * 0.4, R * 0.5);
  }
  ctx.restore();
}
