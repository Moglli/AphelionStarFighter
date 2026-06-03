/**
 * @file Decor rendering — asteroid silhouettes drawn between the starfield
 * and the live ships.
 *
 * Visual-only this phase (DEV_FEATURES_PLAN.md Phase 3 acceptance). Each
 * decor entry has `{ type, x, y, r, rot }`; we draw it as an irregular
 * polygon so a hand-placed asteroid looks like terrain instead of a flat
 * circle. The polygon is deterministic on (x, y, r, rot) so successive
 * frames render the same shape.
 *
 * Hot path: main.js#draw calls drawDecor once per frame inside the
 * camera transform, so coords are world-space.
 */

const TWO_PI = Math.PI * 2;

// Mulberry32 — same tiny seeded RNG `src/ship.js` uses for procedural
// hull rolls. Keeps decor draws deterministic per asteroid so the shape
// doesn't shimmer frame-to-frame.
function mulberry32(seed) {
  let t = seed | 0;
  return () => {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function decorSeed(d) {
  // Cheap hash: pack x/y/r into a single 32-bit value via XOR/shift.
  // Different asteroids land on different seeds; the same asteroid every
  // frame lands on the same one.
  const sx = Math.floor(d.x) | 0;
  const sy = Math.floor(d.y) | 0;
  const sr = Math.floor(d.r) | 0;
  return (((sx * 2654435761) ^ (sy * 40503) ^ (sr * 31)) >>> 0) || 1;
}

export function drawDecor(ctx, decorList, zoom = 1) {
  if (!decorList || !decorList.length) return;
  ctx.save();
  for (const d of decorList) {
    if (!d || d.type !== "asteroid") continue;
    const rng = mulberry32(decorSeed(d));
    const sides = 14;
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(d.rot || 0);
    // Outer body — slightly noisy polygon so two asteroids of the same
    // radius read as different rocks.
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * TWO_PI;
      const noise = 0.82 + rng() * 0.28; // 0.82..1.10
      const r = d.r * noise;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(60, 56, 50, 0.9)";
    ctx.fill();
    ctx.lineWidth = Math.max(1, 1.2 / zoom);
    ctx.strokeStyle = "rgba(140, 130, 110, 0.85)";
    ctx.stroke();
    // A few rock-face highlights so the asteroid reads at zoom.
    const facets = 3;
    for (let f = 0; f < facets; f++) {
      const a = rng() * TWO_PI;
      const rr = d.r * (0.20 + rng() * 0.35);
      const fx = Math.cos(a) * rr * 0.4;
      const fy = Math.sin(a) * rr * 0.4;
      ctx.beginPath();
      ctx.arc(fx, fy, rr * 0.25, 0, TWO_PI);
      ctx.fillStyle = "rgba(110, 100, 86, 0.55)";
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
}
