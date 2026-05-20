import { SIDES } from "./classes.js";
import { getHull } from "./ship.js";

// Persistent map litter. Two entity kinds live here:
//   - "wreck"  : the broken hull of a destroyed ship. Split into a few
//                chunks that drift apart, scorched, with a brief burn
//                glow. Persists indefinitely (capped by MAX_WRECKS).
//   - "debris" : small fragments knocked off a hull when it takes a
//                damaging hit (or showered out on death). Persists
//                indefinitely (capped by MAX_DEBRIS).
//
// Neither kind interacts physically with live ships — they're cosmetic
// map state. Per-tick cost is a polygon draw per wreck-piece and a
// short line per debris fragment.

let nextWreckId = 1;

// Hard caps. On long, busy matches we drop the oldest entries rather
// than letting the arrays grow without bound. These are generous: a
// frigate-on-frigate brawl that produces dozens of kills still fits.
const MAX_WRECKS = 160;
const MAX_DEBRIS = 500;

// How many chunks a hull breaks into on destruction, by class.
const CHUNKS_BY_KLASS = {
  fighter: 2,
  bomber: 2,
  frigate: 3,
  cruiser: 3,
  battleship: 4,
  carrier: 4,
};

// Drift parameters. Velocity is damped each tick so wrecks come to
// near-rest a few seconds after they form.
const VEL_DAMP = 0.985;
const SPIN_DAMP = 0.985;

/**
 * Build a fresh wreck record from a ship that just died.
 * Captures the hull silhouette and splits it into chunks that fly
 * outward from the hull center.
 */
export function createWreck(ship) {
  const poly = getHull(ship.race, ship.klass);
  const chunkCount = CHUNKS_BY_KLASS[ship.klass] || 3;
  const pieces = splitHullIntoChunks(poly, chunkCount);

  // Inherit the ship's velocity so a fast-moving fighter throws debris
  // forward, and dust it with outward kick + spin so chunks separate.
  const kick = ship.klass === "fighter" || ship.klass === "bomber" ? 30 : 18;
  for (const piece of pieces) {
    const cx = piece.centerLocal.x;
    const cy = piece.centerLocal.y;
    const len = Math.hypot(cx, cy) || 1;
    // Convert local outward direction to world space using the ship heading.
    const ca = Math.cos(ship.heading);
    const sa = Math.sin(ship.heading);
    const wx = cx * ca - cy * sa;
    const wy = cx * sa + cy * ca;
    const nx = wx / len;
    const ny = wy / len;
    piece.vel = {
      x: ship.vel.x * 0.4 + nx * kick + (Math.random() - 0.5) * 8,
      y: ship.vel.y * 0.4 + ny * kick + (Math.random() - 0.5) * 8,
    };
    piece.spin = (Math.random() - 0.5) * 0.6;
    piece.rot = 0;
    piece.pos = { x: ship.pos.x, y: ship.pos.y };
  }

  return {
    id: nextWreckId++,
    klass: ship.klass,
    race: ship.race,
    side: ship.side,
    radius: ship.spec.radius,
    heading: ship.heading,
    pieces,
    // Burn glow: a brief hot/spark phase right after destruction, then
    // a cold dark hulk forever after.
    burnTime: 2.5,
    age: 0,
  };
}

/**
 * Split a hull polygon into N "exploded" chunks. Each chunk is a fan
 * slice: centroid + a contiguous arc of vertices, closing back on the
 * next arc's first vertex (or the polygon's first vertex for the last
 * chunk) so adjacent chunks meet edge-to-edge and the union covers the
 * full hull silhouette without gaps.
 */
function splitHullIntoChunks(poly, n) {
  const V = poly.length;
  if (V < 3) return [{ verts: poly.slice(), centerLocal: { x: 0, y: 0 } }];
  // Centroid of the unit hull, used as the shared fan apex.
  let cx = 0, cy = 0;
  for (const v of poly) { cx += v[0]; cy += v[1]; }
  cx /= V; cy /= V;

  // Compute the start vertex index for each chunk; the last one wraps
  // back to start=V (== 0 modulo V).
  const starts = [];
  for (let i = 0; i <= n; i++) starts.push(Math.round((i * V) / n));

  const chunks = [];
  for (let i = 0; i < n; i++) {
    const s = starts[i];
    const e = starts[i + 1]; // exclusive end vertex index
    const arc = [[cx, cy]];
    for (let k = s; k <= e; k++) arc.push(poly[k % V]);
    if (arc.length < 3) continue;
    // Local center of this chunk = average of its outer points.
    let pcx = 0, pcy = 0, count = 0;
    for (let k = 1; k < arc.length; k++) { pcx += arc[k][0]; pcy += arc[k][1]; count++; }
    if (count > 0) { pcx /= count; pcy /= count; }
    chunks.push({ verts: arc, centerLocal: { x: pcx - cx, y: pcy - cy } });
  }
  return chunks;
}

// Per-class debris size scaling so a battleship sheds visibly chunky
// shards while a fighter scatters smaller bits. Each chunk samples
// uniformly within [min, max].
const DEBRIS_SIZE_BY_KLASS = {
  fighter:    { min: 1.8, max: 3.0 },
  bomber:     { min: 2.2, max: 3.6 },
  frigate:    { min: 3.0, max: 5.5 },
  cruiser:    { min: 3.5, max: 7.0 },
  battleship: { min: 4.5, max: 9.0 },
  carrier:    { min: 4.5, max: 9.0 },
  station:    { min: 4.0, max: 7.5 },
};

/** Hull fragments that fly off on impact / death. Persist forever. */
export function createDebrisBurst(pos, hitPos, baseVel, klass, side, count) {
  const out = [];
  const cx = hitPos ? hitPos.x : pos.x;
  const cy = hitPos ? hitPos.y : pos.y;
  const sz = DEBRIS_SIZE_BY_KLASS[klass] || DEBRIS_SIZE_BY_KLASS.frigate;
  const sizeRange = sz.max - sz.min;
  for (let i = 0; i < count; i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = 40 + Math.random() * 80;
    const vx = Math.cos(ang) * sp + (baseVel ? baseVel.x * 0.3 : 0);
    const vy = Math.sin(ang) * sp + (baseVel ? baseVel.y * 0.3 : 0);
    out.push({
      pos: { x: cx, y: cy },
      vel: { x: vx, y: vy },
      rot: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 4,
      size: sz.min + Math.random() * sizeRange,
      side,
      klass,
      // Spark phase: chip glows red-hot for the first second, then
      // cools to a dull grey shard. Persists indefinitely from there.
      burn: 0.6 + Math.random() * 0.6,
      age: 0,
    });
  }
  return out;
}

export function updateWreck(w, dt, bounds) {
  w.age += dt;
  if (w.burnTime > 0) w.burnTime = Math.max(0, w.burnTime - dt);
  const damp = Math.pow(VEL_DAMP, dt * 60);
  const sdamp = Math.pow(SPIN_DAMP, dt * 60);
  for (const piece of w.pieces) {
    piece.pos.x += piece.vel.x * dt;
    piece.pos.y += piece.vel.y * dt;
    piece.vel.x *= damp;
    piece.vel.y *= damp;
    piece.rot += piece.spin * dt;
    piece.spin *= sdamp;
    // Keep pieces inside the arena so wreckage doesn't drift out of sight.
    const r = w.radius;
    if (piece.pos.x < bounds.minX + r) { piece.pos.x = bounds.minX + r; piece.vel.x = 0; }
    if (piece.pos.x > bounds.maxX - r) { piece.pos.x = bounds.maxX - r; piece.vel.x = 0; }
    if (piece.pos.y < bounds.minY + r) { piece.pos.y = bounds.minY + r; piece.vel.y = 0; }
    if (piece.pos.y > bounds.maxY - r) { piece.pos.y = bounds.maxY - r; piece.vel.y = 0; }
  }
}

export function updateDebris(d, dt, bounds) {
  d.age += dt;
  if (d.burn > 0) d.burn = Math.max(0, d.burn - dt);
  d.pos.x += d.vel.x * dt;
  d.pos.y += d.vel.y * dt;
  const damp = Math.pow(VEL_DAMP, dt * 60);
  d.vel.x *= damp;
  d.vel.y *= damp;
  d.rot += d.spin * dt;
  d.spin *= Math.pow(SPIN_DAMP, dt * 60);
  if (d.pos.x < bounds.minX) { d.pos.x = bounds.minX; d.vel.x = 0; }
  if (d.pos.x > bounds.maxX) { d.pos.x = bounds.maxX; d.vel.x = 0; }
  if (d.pos.y < bounds.minY) { d.pos.y = bounds.minY; d.vel.y = 0; }
  if (d.pos.y > bounds.maxY) { d.pos.y = bounds.maxY; d.vel.y = 0; }
}

export function pushWreck(arr, wreck) {
  arr.push(wreck);
  if (arr.length > MAX_WRECKS) arr.splice(0, arr.length - MAX_WRECKS);
}

export function pushDebris(arr, fragments) {
  for (const f of fragments) arr.push(f);
  if (arr.length > MAX_DEBRIS) arr.splice(0, arr.length - MAX_DEBRIS);
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------
export function drawWreck(ctx, w) {
  const baseTint = SIDES[w.side].primary;
  // Charred hull color: very dark variant of the original side tint.
  const hullDark = darken(baseTint, 0.18);
  const edge = darken(baseTint, 0.45);
  const r = w.radius;
  for (const piece of w.pieces) {
    ctx.save();
    ctx.translate(piece.pos.x, piece.pos.y);
    ctx.rotate(w.heading + piece.rot);

    ctx.fillStyle = hullDark;
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(piece.verts[0][0] * r, piece.verts[0][1] * r);
    for (let i = 1; i < piece.verts.length; i++) {
      ctx.lineTo(piece.verts[i][0] * r, piece.verts[i][1] * r);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Burn glow at the fracture edge while the wreck is fresh.
    if (w.burnTime > 0) {
      const glow = w.burnTime / 2.5;
      ctx.fillStyle = "rgba(255,140,60," + (0.18 * glow).toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

export function drawDebris(ctx, d) {
  ctx.save();
  ctx.translate(d.pos.x, d.pos.y);
  ctx.rotate(d.rot);
  if (d.burn > 0) {
    // Hot core fades from orange to dull as the spark cools.
    const g = d.burn / 1.2;
    ctx.fillStyle = "rgba(255," + Math.floor(140 + 80 * g) + "," + Math.floor(40 * g) + "," + (0.6 + 0.3 * g).toFixed(3) + ")";
  } else {
    ctx.fillStyle = "#5a6470";
  }
  ctx.fillRect(-d.size, -d.size * 0.5, d.size * 2, d.size);
  ctx.restore();
}

// Parse "#rgb" or "#rrggbb" and scale toward black by `f` in [0,1].
function darken(hex, f) {
  if (!hex || hex[0] !== "#") return hex;
  let r, g, b;
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16);
    g = parseInt(hex[2] + hex[2], 16);
    b = parseInt(hex[3] + hex[3], 16);
  } else if (hex.length === 7) {
    r = parseInt(hex.slice(1, 3), 16);
    g = parseInt(hex.slice(3, 5), 16);
    b = parseInt(hex.slice(5, 7), 16);
  } else {
    return hex;
  }
  const nr = Math.max(0, Math.min(255, Math.floor(r * f)));
  const ng = Math.max(0, Math.min(255, Math.floor(g * f)));
  const nb = Math.max(0, Math.min(255, Math.floor(b * f)));
  return "#" + nr.toString(16).padStart(2, "0") + ng.toString(16).padStart(2, "0") + nb.toString(16).padStart(2, "0");
}
