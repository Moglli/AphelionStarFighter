// Procedural starmap renderer for the Frontier roguelite campaign UI.
// Generates a deep-space galaxy background (parallax stars + nebula
// clouds) and renders nodes as stars / planets / anomalies rather
// than the previous geometric chips. Everything is deterministic from
// a seed so a given run + act always paints the same galaxy — the
// player can leave and come back to the map and the layout is stable.
//
// Public surface:
//   makeGalaxy(seed, viewW, viewH)
//   drawGalaxy(ctx, galaxy, panX, panY, viewW, viewH)
//   nodePositionsFor(graph, world)
//   drawCurvedEdge(ctx, ax, ay, bx, by, state)
//   drawNodeArt(ctx, n, state, t)
//   drawFleetMarker(ctx, x, y, t)
//   drawFactionEmblem(ctx, x, y, r, color, key)

import { RACES } from "./races.js";

// Tiny Mulberry32 PRNG — matches the one in roguelite.js so seeds line up.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --------------------------------------------------------------------
// Galaxy generation. A "galaxy" is a stable visual backdrop tied to
// (run, act). Three layers of parallax stars + 2-3 nebula clouds; the
// numbers are tuned so the map reads as inhabited space rather than
// empty void.
// --------------------------------------------------------------------
export function makeGalaxy(seed, worldW, worldH) {
  const rng = mulberry32(seed);
  // Three star layers, each thinner and brighter than the last so
  // parallax depth reads when the player drags the map.
  const stars = [];
  // Distant haze — small, dim, dense.
  const distant = 320;
  for (let i = 0; i < distant; i++) {
    stars.push({
      depth: 0.35,
      x: rng() * worldW,
      y: rng() * worldH,
      r: 0.5 + rng() * 0.7,
      alpha: 0.25 + rng() * 0.35,
      tint: starTint(rng),
    });
  }
  // Mid layer — visible stars.
  const mid = 160;
  for (let i = 0; i < mid; i++) {
    stars.push({
      depth: 0.65,
      x: rng() * worldW,
      y: rng() * worldH,
      r: 0.9 + rng() * 1.1,
      alpha: 0.5 + rng() * 0.4,
      tint: starTint(rng),
    });
  }
  // Foreground — sparse, brighter, larger; these get a soft halo on draw.
  const near = 38;
  for (let i = 0; i < near; i++) {
    stars.push({
      depth: 1.0,
      x: rng() * worldW,
      y: rng() * worldH,
      r: 1.6 + rng() * 1.4,
      alpha: 0.75 + rng() * 0.25,
      tint: starTint(rng),
      halo: true,
    });
  }
  // Nebula clouds: each is a soft radial gradient blob with a tinted
  // colour. Placed deterministically; 2-3 per galaxy so the player can
  // see them as they pan.
  const nebulaCount = 2 + Math.floor(rng() * 2);
  const nebulae = [];
  const palettes = [
    { inner: "rgba(80,40,140,",  outer: "rgba(20,10,40," },
    { inner: "rgba(40,90,160,",  outer: "rgba(10,20,50," },
    { inner: "rgba(140,60,90,",  outer: "rgba(40,15,30," },
    { inner: "rgba(40,120,140,", outer: "rgba(10,30,40," },
  ];
  for (let i = 0; i < nebulaCount; i++) {
    nebulae.push({
      x: 0.15 * worldW + rng() * 0.7 * worldW,
      y: 0.15 * worldH + rng() * 0.7 * worldH,
      r: 220 + rng() * 220,
      palette: palettes[Math.floor(rng() * palettes.length)],
      rot: rng() * Math.PI * 2,
    });
  }
  return { stars, nebulae, worldW, worldH };
}

function starTint(rng) {
  // Mostly white with occasional warm yellow / cool blue / red so the
  // foreground reads as a real sky. Returns "r,g,b" string fragment.
  const roll = rng();
  if (roll < 0.6)  return "230,238,255";    // white
  if (roll < 0.78) return "255,230,180";    // warm yellow
  if (roll < 0.92) return "200,220,255";    // cool blue
  return "255,200,180";                     // red
}

// --------------------------------------------------------------------
// Background paint. Renders deep-space gradient + nebulae + parallax
// stars relative to the current pan offset. Stars at depth 1.0 move
// with the pan 1:1; deeper layers move slower (parallax).
// --------------------------------------------------------------------
export function drawGalaxy(ctx, galaxy, panX, panY, viewW, viewH) {
  // Base gradient — radial dark navy from centre to almost-black at edges.
  const g = ctx.createRadialGradient(
    viewW / 2, viewH / 2, viewH * 0.1,
    viewW / 2, viewH / 2, Math.max(viewW, viewH) * 0.85,
  );
  g.addColorStop(0, "#0a1024");
  g.addColorStop(0.55, "#04060e");
  g.addColorStop(1, "#01020a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, viewW, viewH);

  // Nebula pass — these live in world space; pan at depth 0.5.
  const nebulaDepth = 0.5;
  for (const n of galaxy.nebulae) {
    const x = n.x + panX * nebulaDepth;
    const y = n.y + panY * nebulaDepth;
    if (x < -n.r || x > viewW + n.r || y < -n.r || y > viewH + n.r) continue;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, n.r);
    grad.addColorStop(0, n.palette.inner + "0.55)");
    grad.addColorStop(0.5, n.palette.inner + "0.20)");
    grad.addColorStop(1, n.palette.outer + "0)");
    ctx.fillStyle = grad;
    ctx.fillRect(x - n.r, y - n.r, n.r * 2, n.r * 2);
  }

  // Stars — parallax sorted by depth so distant render first.
  for (const s of galaxy.stars) {
    const x = s.x + panX * s.depth;
    const y = s.y + panY * s.depth;
    if (x < -8 || x > viewW + 8 || y < -8 || y > viewH + 8) continue;
    if (s.halo) {
      // Soft halo for foreground stars — gives the sky depth.
      const haloR = s.r * 3.2;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, haloR);
      grad.addColorStop(0, "rgba(" + s.tint + "," + (s.alpha * 0.6).toFixed(2) + ")");
      grad.addColorStop(1, "rgba(" + s.tint + ",0)");
      ctx.fillStyle = grad;
      ctx.fillRect(x - haloR, y - haloR, haloR * 2, haloR * 2);
    }
    ctx.fillStyle = "rgba(" + s.tint + "," + s.alpha.toFixed(2) + ")";
    ctx.beginPath();
    ctx.arc(x, y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// --------------------------------------------------------------------
// World-space node positions. Spreads the col/row grid across the
// world rect with a seeded per-node jitter so the map reads as an
// organic sector chart, not a regular grid.
// --------------------------------------------------------------------
export function nodePositionsFor(graph, seed, worldW, worldH, cols, rows) {
  const rng = mulberry32(seed ^ 0x9e3779b1);
  const padX = worldW * 0.08;
  const padY = worldH * 0.12;
  const innerW = worldW - padX * 2;
  const innerH = worldH - padY * 2;
  const colStep = innerW / Math.max(1, cols - 1);
  const rowStep = innerH / Math.max(1, rows + 1);
  // Map node.id → {x,y} for quick edge lookup. Per-node jitter is
  // proportional to local step size so dense maps stay legible.
  const positions = new Map();
  for (const n of graph.nodes) {
    const baseX = padX + n.col * colStep;
    const baseY = padY + (n.row + 1) * rowStep;
    // Entry + boss columns get less jitter so they read as fixed
    // anchors; the middle columns get bigger spread for a more
    // chart-like feel.
    const jitterScale = (n.col === 0 || n.col === cols - 1) ? 0.18 : 0.45;
    const jx = (rng() - 0.5) * colStep * jitterScale;
    const jy = (rng() - 0.5) * rowStep * jitterScale;
    positions.set(n.id, { x: baseX + jx, y: baseY + jy });
  }
  return positions;
}

// --------------------------------------------------------------------
// Curved edge between two nodes. Quadratic Bezier with a perpendicular
// midpoint offset that flips per-edge so adjacent paths don't all
// curve the same way. State drives colour + width + dashed-flow.
// --------------------------------------------------------------------
export function drawCurvedEdge(ctx, ax, ay, bx, by, state, edgeKey, timeSec) {
  // Midpoint perpendicular offset for the curve — deterministic per
  // edge so the curve doesn't wobble frame to frame.
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const seed = (Math.abs(edgeKey) % 100) / 100;
  const bulge = (seed - 0.5) * Math.min(60, len * 0.25);
  const mx = (ax + bx) / 2 + nx * bulge;
  const my = (ay + by) / 2 + ny * bulge;

  const isCurrent = state === "current-out";  // outgoing from current node
  const isVisited = state === "visited";
  const isLocked  = state === "locked";

  const color = isCurrent  ? "rgba(140,210,255,0.95)"
              : isVisited  ? "rgba(140,210,255,0.40)"
              :              "rgba(120,140,170,0.45)";
  const width = isCurrent ? 2.5 : (isVisited ? 1.5 : 1.2);

  // Base curve.
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (isLocked) ctx.setLineDash([2, 4]);
  else ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.quadraticCurveTo(mx, my, bx, by);
  ctx.stroke();

  // Flow shimmer along reachable paths — short bright dash that crawls
  // along the curve, giving the chart life without animation cost.
  if (isCurrent) {
    const dashLen = 6;
    const gapLen = 14;
    const offset = -(timeSec * 60) % (dashLen + gapLen);
    ctx.setLineDash([dashLen, gapLen]);
    ctx.lineDashOffset = offset;
    ctx.strokeStyle = "rgba(220,245,255,0.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.quadraticCurveTo(mx, my, bx, by);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}

// --------------------------------------------------------------------
// Node art. Each node type renders as a different celestial body so
// the player can tell the map layout at a glance. State drives the
// dim / glow / pulse treatment for locked / reachable / current.
//
// `t` is timeSec (for slow pulse animation). Drawn in screen space.
// --------------------------------------------------------------------
export function drawNodeArt(ctx, n, state, t) {
  const faction = (n.faction && RACES[n.faction]) ? RACES[n.faction] : null;
  const factionAccent = faction ? (faction.accent || "#7df") : "#7df";

  // State alpha + glow gating.
  const stateDim   = state === "locked";
  const stateMuted = state === "visited";
  const stateLit   = state === "reachable" || state === "current";

  const baseAlpha = stateDim ? 0.30 : stateMuted ? 0.55 : 1.0;
  ctx.globalAlpha = baseAlpha;

  switch (n.type) {
    case "battle":   drawBattleStar(ctx, n.x, n.y, n.r, factionAccent, state, t); break;
    case "elite":    drawEliteStar(ctx, n.x, n.y, n.r, factionAccent, state, t); break;
    case "resupply": drawResupplyPlanet(ctx, n.x, n.y, n.r, state, t); break;
    case "event":    drawEventAnomaly(ctx, n.x, n.y, n.r, state, t); break;
    case "boss":     drawBossPlanet(ctx, n.x, n.y, n.r, factionAccent, state, t); break;
    default:         drawBattleStar(ctx, n.x, n.y, n.r, factionAccent, state, t);
  }

  // Reachable/current ring — bright outer halo that pulses on current.
  if (stateLit) {
    const pulse = state === "current" ? (0.85 + Math.sin(t * 3.4) * 0.15) : 0.6;
    const ringR = n.r + (state === "current" ? 10 : 6);
    ctx.strokeStyle = state === "current"
      ? "rgba(220,245,255," + pulse.toFixed(3) + ")"
      : "rgba(140,210,255,0.45)";
    ctx.lineWidth = state === "current" ? 2.5 : 1.2;
    ctx.beginPath();
    ctx.arc(n.x, n.y, ringR, 0, Math.PI * 2);
    ctx.stroke();

    if (state === "current") {
      // Second softer outer ring for the player's current location so
      // it reads as "you are here" at a glance even on a busy map.
      ctx.strokeStyle = "rgba(140,210,255,0.30)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, ringR + 8 + Math.sin(t * 2.1) * 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.globalAlpha = 1;
}

// Battle: angry red star with corona + flare cross.
function drawBattleStar(ctx, x, y, r, accent, state, t) {
  // Corona — radial gradient halo.
  const haloR = r * 2.4;
  const corona = ctx.createRadialGradient(x, y, r * 0.2, x, y, haloR);
  corona.addColorStop(0, "rgba(255,180,140,0.85)");
  corona.addColorStop(0.5, "rgba(220,80,60,0.45)");
  corona.addColorStop(1, "rgba(220,80,60,0)");
  ctx.fillStyle = corona;
  ctx.fillRect(x - haloR, y - haloR, haloR * 2, haloR * 2);
  // Body — bright orange-red disc.
  const body = ctx.createRadialGradient(x - r * 0.2, y - r * 0.2, 0, x, y, r);
  body.addColorStop(0, "#ffe4a8");
  body.addColorStop(0.4, "#ff8a4a");
  body.addColorStop(1, "#a0331c");
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  // Subtle inner highlight.
  ctx.fillStyle = "rgba(255,240,200,0.45)";
  ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.35, 0, Math.PI * 2); ctx.fill();
  // Faction-coloured glint ring (thin) so battles read with their
  // hostile faction at a glance.
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(x, y, r + 2, 0, Math.PI * 2); ctx.stroke();
}

// Elite: same family as battle but brighter + with a 4-point flare cross.
function drawEliteStar(ctx, x, y, r, accent, state, t) {
  drawBattleStar(ctx, x, y, r * 1.1, accent, state, t);
  // Cross-flare rays.
  const flareLen = r * 2.4;
  ctx.strokeStyle = "rgba(255,220,160,0.75)";
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI / 2) + (t * 0.3);
    const cx = Math.cos(a) * flareLen;
    const cy = Math.sin(a) * flareLen;
    ctx.beginPath();
    ctx.moveTo(x + cx * 0.4, y + cy * 0.4);
    ctx.lineTo(x + cx, y + cy);
    ctx.stroke();
  }
}

// Resupply: blue-green planet with terminator + a thin atmosphere ring.
function drawResupplyPlanet(ctx, x, y, r, state, t) {
  // Atmosphere halo.
  const haloR = r * 1.8;
  const halo = ctx.createRadialGradient(x, y, r * 0.95, x, y, haloR);
  halo.addColorStop(0, "rgba(120,220,200,0.55)");
  halo.addColorStop(1, "rgba(60,140,160,0)");
  ctx.fillStyle = halo;
  ctx.fillRect(x - haloR, y - haloR, haloR * 2, haloR * 2);
  // Planet body — green-blue with a darkening terminator.
  const body = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
  body.addColorStop(0, "#a8f0d4");
  body.addColorStop(0.4, "#3aa890");
  body.addColorStop(1, "#0c3a44");
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  // Two subtle land/cloud bands so it reads as a planet, not a disc.
  ctx.globalAlpha *= 0.5;
  ctx.fillStyle = "rgba(180,230,210,0.6)";
  ctx.beginPath();
  ctx.ellipse(x - r * 0.1, y + r * 0.15, r * 0.55, r * 0.18, 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x + r * 0.2, y - r * 0.3, r * 0.4, r * 0.12, -0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha *= 2;
}

// Event: purple swirling anomaly — radial gradient with rotating arcs.
function drawEventAnomaly(ctx, x, y, r, state, t) {
  // Outer glow.
  const haloR = r * 2.2;
  const halo = ctx.createRadialGradient(x, y, r * 0.4, x, y, haloR);
  halo.addColorStop(0, "rgba(180,120,255,0.7)");
  halo.addColorStop(0.6, "rgba(120,60,200,0.35)");
  halo.addColorStop(1, "rgba(60,30,120,0)");
  ctx.fillStyle = halo;
  ctx.fillRect(x - haloR, y - haloR, haloR * 2, haloR * 2);
  // Core disc.
  const core = ctx.createRadialGradient(x, y, 0, x, y, r);
  core.addColorStop(0, "#f4e8ff");
  core.addColorStop(0.4, "#b88aff");
  core.addColorStop(1, "#3a1a70");
  ctx.fillStyle = core;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  // Two thin spiral arcs that rotate.
  ctx.strokeStyle = "rgba(220,200,255,0.8)";
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 2; i++) {
    const a0 = t * (i === 0 ? 0.8 : -0.6) + i * Math.PI;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.7, a0, a0 + Math.PI * 0.75);
    ctx.stroke();
  }
  // "?" glyph centred.
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.font = "bold " + Math.round(r * 1.0) + "px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("?", x, y + r * 0.32);
  ctx.textAlign = "left";
}

// Boss: massive ringed planet with faction tint. Bigger visual weight
// than any other node so the column-end goal reads instantly.
function drawBossPlanet(ctx, x, y, r, accent, state, t) {
  const R = r * 1.6;
  // Outer halo.
  const haloR = R * 1.7;
  const halo = ctx.createRadialGradient(x, y, R * 0.9, x, y, haloR);
  halo.addColorStop(0, accent.replace(")", ",0.45)").replace("rgb(", "rgba(") || "rgba(255,120,80,0.45)");
  // Fallback if accent isn't rgb()/rgba() formatted — use a hex-ish blanket.
  ctx.fillStyle = "rgba(255,140,90,0.35)";
  // (Re-creating the halo more safely with manual rgba so accent hex
  // colours work too.)
  const accentRgba = factionRgba(accent, 0.45);
  const halo2 = ctx.createRadialGradient(x, y, R * 0.9, x, y, haloR);
  halo2.addColorStop(0, accentRgba);
  halo2.addColorStop(1, factionRgba(accent, 0));
  ctx.fillStyle = halo2;
  ctx.fillRect(x - haloR, y - haloR, haloR * 2, haloR * 2);
  // Planet body — darker gas-giant gradient with faction tint at the
  // limb. Looks distinctly different from the battle stars.
  const body = ctx.createRadialGradient(x - R * 0.3, y - R * 0.3, 0, x, y, R);
  body.addColorStop(0, "#f8e8d0");
  body.addColorStop(0.4, factionRgba(accent, 1));
  body.addColorStop(1, "#1a0808");
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
  // Banding lines.
  ctx.strokeStyle = "rgba(40,20,15,0.45)";
  ctx.lineWidth = 1;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.ellipse(x, y + i * R * 0.18, R * 0.95, R * 0.08, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Ring system — flat ellipse tilted slightly. Front half drawn after
  // the body so it occludes the planet.
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.45);
  // Back half (behind planet) — draw before body... actually the
  // simpler trick: draw the whole ring before the planet, then mask
  // the front half on top. Easier: draw a thin elliptical stroke and
  // accept the read; players don't need pixel-perfect Saturn here.
  ctx.strokeStyle = factionRgba(accent, 0.85);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(0, 0, R * 1.6, R * 0.35, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = factionRgba(accent, 0.45);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(0, 0, R * 1.85, R * 0.4, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// Hex / rgb() → rgba string utility for the boss planet halo. Accepts
// the common formats stored on RACES[*].accent.
function factionRgba(color, alpha) {
  if (!color) return "rgba(255,140,90," + alpha + ")";
  if (color.startsWith("#")) {
    let h = color.slice(1);
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }
  if (color.startsWith("rgb(")) {
    return color.replace("rgb(", "rgba(").replace(")", "," + alpha + ")");
  }
  if (color.startsWith("rgba(")) {
    // Replace existing alpha.
    return color.replace(/,[\s\d.]+\)/, "," + alpha + ")");
  }
  return "rgba(255,140,90," + alpha + ")";
}

// --------------------------------------------------------------------
// Player-fleet marker drawn over the current node. A small wing-shaped
// silhouette with a subtle bobbing offset so the player's position
// reads at a glance without obscuring the underlying star.
// --------------------------------------------------------------------
export function drawFleetMarker(ctx, x, y, t) {
  const bob = Math.sin(t * 2.2) * 1.5;
  ctx.save();
  ctx.translate(x, y - 38 + bob);
  // Pip line down to the node so the marker visibly points at it.
  ctx.strokeStyle = "rgba(220,245,255,0.7)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 14);
  ctx.lineTo(0, 30);
  ctx.stroke();
  // Wing-shaped icon: a small swept arrow in cool blue.
  ctx.fillStyle = "rgba(220,245,255,0.95)";
  ctx.beginPath();
  ctx.moveTo(0, -7);
  ctx.lineTo(7, 6);
  ctx.lineTo(0, 3);
  ctx.lineTo(-7, 6);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(40,90,140,0.9)";
  ctx.lineWidth = 1;
  ctx.stroke();
  // Glow underlay.
  const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, 14);
  halo.addColorStop(0, "rgba(140,210,255,0.55)");
  halo.addColorStop(1, "rgba(140,210,255,0)");
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// --------------------------------------------------------------------
// Faction emblem: a stylised roundel used by the Run Setup overlay.
// Procedural concentric rings with a faction sigil at the centre.
// --------------------------------------------------------------------
export function drawFactionEmblem(ctx, x, y, r, accent, key) {
  const accentRgba1 = factionRgba(accent, 1);
  const accentRgba03 = factionRgba(accent, 0.3);

  // Outer halo.
  const halo = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 1.5);
  halo.addColorStop(0, accentRgba03);
  halo.addColorStop(1, factionRgba(accent, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(x - r * 1.5, y - r * 1.5, r * 3, r * 3);

  // Outer ring.
  ctx.strokeStyle = accentRgba1;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = factionRgba(accent, 0.4);
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(x, y, r * 0.85, 0, Math.PI * 2); ctx.stroke();

  // Centre disc — dark with subtle faction tint.
  const body = ctx.createRadialGradient(x, y, 0, x, y, r * 0.7);
  body.addColorStop(0, factionRgba(accent, 0.5));
  body.addColorStop(0.8, "rgba(8,16,28,0.95)");
  body.addColorStop(1, "rgba(2,6,14,1)");
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.arc(x, y, r * 0.7, 0, Math.PI * 2); ctx.fill();

  // Sigil — a per-faction simple shape so each emblem feels distinct
  // without needing real asset art. Key-driven dispatch.
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = accentRgba1;
  ctx.fillStyle = accentRgba1;
  ctx.lineWidth = 2.5;
  const s = r * 0.42;
  switch (key) {
    case "terran": {
      // Star: 5-point.
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + i * (Math.PI * 2 / 5);
        const px = Math.cos(a) * s;
        const py = Math.sin(a) * s;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        const ai = a + Math.PI / 5;
        ctx.lineTo(Math.cos(ai) * s * 0.45, Math.sin(ai) * s * 0.45);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "reavers": {
      // Triangle-skull: downward-pointing triangle with notches.
      ctx.beginPath();
      ctx.moveTo(0, s);
      ctx.lineTo(s, -s * 0.75);
      ctx.lineTo(-s, -s * 0.75);
      ctx.closePath();
      ctx.fill();
      // Two eye notches.
      ctx.fillStyle = "rgba(8,16,28,1)";
      ctx.beginPath(); ctx.arc(-s * 0.35, -s * 0.2, s * 0.18, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc( s * 0.35, -s * 0.2, s * 0.18, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case "hegemony": {
      // Square crest with inset cross.
      ctx.strokeRect(-s, -s, s * 2, s * 2);
      ctx.beginPath();
      ctx.moveTo(-s, 0); ctx.lineTo(s, 0);
      ctx.moveTo(0, -s); ctx.lineTo(0, s);
      ctx.stroke();
      break;
    }
    case "voidsworn": {
      // Hexagram - two overlapping triangles for the void rite read.
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + i * (Math.PI * 2 / 3);
        if (i === 0) ctx.moveTo(Math.cos(a) * s, Math.sin(a) * s);
        else ctx.lineTo(Math.cos(a) * s, Math.sin(a) * s);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const a = Math.PI / 2 + i * (Math.PI * 2 / 3);
        if (i === 0) ctx.moveTo(Math.cos(a) * s, Math.sin(a) * s);
        else ctx.lineTo(Math.cos(a) * s, Math.sin(a) * s);
      }
      ctx.closePath();
      ctx.stroke();
      break;
    }
    default: {
      ctx.beginPath(); ctx.arc(0, 0, s * 0.5, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

// Utility: clamp a pan offset so the map content can't be dragged
// completely off-screen. Caller passes world bounds + viewport size.
export function clampPan(panX, panY, worldW, worldH, viewW, viewH) {
  const minX = viewW - worldW - 80;
  const maxX = 80;
  const minY = viewH - worldH - 80;
  const maxY = 80;
  return {
    x: Math.max(minX, Math.min(maxX, panX)),
    y: Math.max(minY, Math.min(maxY, panY)),
  };
}
