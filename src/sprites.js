// Procedural ship sprite renderer.
//
// At game start, prerenderSprites() bakes every (race, klass, side) combo
// into an offscreen canvas — hull + shaded fill + panel lines + race
// accent stripe + engine glow + outline. drawShip then blits the cached
// bitmap each frame instead of re-tessellating polygons.
//
// Sprites use the class's base radius as the reference scale. Ships
// whose spec.radius differs (e.g. station nodes overriding the base
// station radius) draw the sprite scaled to fit — so a small spire and
// a large core share the same artwork stretched to their own hitbox.
import { CLASSES, SIDES } from "./classes.js";
import { RACES, RACE_KEYS } from "./races.js";
import { getHull } from "./ship.js";

const CACHE = new Map();
// 2x oversample — bitmap is twice the natural display size, downscaled
// at draw time by the browser. Enough AA for hairline panel lines.
const SUPERSAMPLE = 2;

// Per-class detail tables. Bigger ships get more panel lines + engines.
// Engine counts and back-edge x-positions are exported so drawShip can
// render the plumes live (intensity scales with engine module HP; full
// black-out when the engine module is destroyed).
const PANEL_LINES = {
  fighter: 1, bomber: 2, frigate: 2, cruiser: 3,
  battleship: 4, carrier: 5, station: 0,
};
export const ENGINES = {
  fighter: 1, bomber: 1, frigate: 2, cruiser: 4,
  battleship: 6, carrier: 4, station: 0,
};
export const ENGINE_X = {
  fighter: -0.6, bomber: -0.75, frigate: -0.85,
  cruiser: -0.95, battleship: -0.95, carrier: -0.95,
};
// Accent-stripe shape per class.
const STRIPE = {
  fighter: "spine", bomber: "broad", frigate: "spine",
  cruiser: "broad", battleship: "broad", carrier: "deck",
  station: "radial",
};

export function prerenderSprites() {
  CACHE.clear();
  for (const race of RACE_KEYS) {
    for (const klass of Object.keys(CLASSES)) {
      for (const side of ["blue", "red"]) {
        CACHE.set(key(race, klass, side), buildSprite(race, klass, side));
      }
    }
  }
}

export function getSprite(race, klass, side) {
  return CACHE.get(key(race, klass, side));
}

function key(race, klass, side) { return race + "|" + klass + "|" + side; }

function buildSprite(race, klass, side) {
  const spec = CLASSES[klass];
  const R = spec.radius;
  // Margin holds the engine glow halo + outline blur outside the hull.
  const margin = R * 0.35;
  const halfExtent = R + margin;
  const size = Math.ceil(halfExtent * 2 * SUPERSAMPLE);

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");

  // Internal coordinate system: origin at center, 1 world-unit per
  // 1/SUPERSAMPLE pixel. Ship faces +X.
  ctx.translate(size / 2, size / 2);
  ctx.scale(SUPERSAMPLE, SUPERSAMPLE);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  drawSchematic(ctx, race, klass, side, R);

  return { canvas, baseRadius: R, halfExtent };
}

function drawSchematic(ctx, race, klass, side, R) {
  const hull = getHull(race, klass);
  const accent = (RACES[race] && RACES[race].accent) || "#7df";
  const tint = SIDES[side].primary;
  const fill = SIDES[side].accent;

  // Hull silhouette path is reused for every clipped layer.
  const hullPath = new Path2D();
  hullPath.moveTo(hull[0][0] * R, hull[0][1] * R);
  for (let i = 1; i < hull.length; i++) {
    hullPath.lineTo(hull[i][0] * R, hull[i][1] * R);
  }
  hullPath.closePath();

  // 1. Soft drop shadow — fake depth offset down-right.
  ctx.save();
  ctx.translate(R * 0.05, R * 0.06);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fill(hullPath);
  ctx.restore();

  // 2. Base hull fill.
  ctx.fillStyle = fill;
  ctx.fill(hullPath);

  // 3. Top-down lighting gradient: front-top brightens, rear-bottom darkens.
  ctx.save();
  ctx.clip(hullPath);
  const grad = ctx.createLinearGradient(R, -R, -R, R);
  grad.addColorStop(0.0, "rgba(255,255,255,0.22)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.05)");
  grad.addColorStop(1.0, "rgba(0,0,0,0.40)");
  ctx.fillStyle = grad;
  ctx.fillRect(-R * 1.3, -R * 1.3, R * 2.6, R * 2.6);
  ctx.restore();

  // 4. Panel lines — thin internal strokes hinting at hull plates.
  ctx.save();
  ctx.clip(hullPath);
  ctx.strokeStyle = "rgba(200,230,255,0.18)";
  ctx.lineWidth = Math.max(0.5, R * 0.012);
  // Centerline (skip on stations — radial symmetry).
  if (klass !== "station") {
    ctx.beginPath();
    ctx.moveTo(-R, 0); ctx.lineTo(R, 0);
    ctx.stroke();
  }
  const crossCount = PANEL_LINES[klass] || 0;
  for (let i = 1; i <= crossCount; i++) {
    const x = -R + (2 * R) * (i / (crossCount + 1));
    ctx.beginPath();
    ctx.moveTo(x, -R); ctx.lineTo(x, R);
    ctx.stroke();
  }
  // Station rings — concentric structural circles instead of cross-lines.
  if (klass === "station") {
    ctx.strokeStyle = "rgba(200,230,255,0.13)";
    ctx.beginPath(); ctx.arc(0, 0, R * 0.45, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, R * 0.75, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();

  // 5. Race accent stripe / marking.
  ctx.save();
  ctx.clip(hullPath);
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.38;
  const shape = STRIPE[klass];
  if (shape === "spine") {
    ctx.fillRect(-R * 0.7, -R * 0.05, R * 1.5, R * 0.1);
  } else if (shape === "broad") {
    ctx.fillRect(-R * 0.6, -R * 0.14, R * 1.4, R * 0.28);
  } else if (shape === "deck") {
    // Carrier flight-deck stripe — long thin bar with a brighter core.
    ctx.fillRect(-R * 0.85, -R * 0.07, R * 1.75, R * 0.14);
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = "rgba(220,240,255,0.6)";
    ctx.fillRect(-R * 0.7, -R * 0.018, R * 1.45, R * 0.036);
  } else if (shape === "radial") {
    // Station — accent dots placed around an inner ring.
    ctx.globalAlpha = 0.7;
    const dots = 6;
    for (let i = 0; i < dots; i++) {
      const a = (i / dots) * Math.PI * 2;
      const r = R * 0.6;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r, Math.sin(a) * r, R * 0.06, 0, Math.PI * 2);
      ctx.fill();
    }
    // Bright central hub.
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = "rgba(220,240,255,0.9)";
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.18, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 6. Bow cockpit / bridge bright spot (skip stations).
  if (klass !== "station") {
    ctx.fillStyle = "rgba(220,240,255,0.85)";
    const bowX = klass === "carrier" ? R * 0.7 : R * 0.55;
    ctx.beginPath();
    ctx.arc(bowX, 0, R * 0.07, 0, Math.PI * 2);
    ctx.fill();
  }

  // Engine glow was baked here previously. It's now rendered live in
  // drawShip (src/ship.js) so it can dim with engine HP and black out
  // when the engine module is destroyed.

  // 7. Outline stroke in the side tint — sharp silhouette read.
  ctx.strokeStyle = tint;
  ctx.lineWidth = Math.max(1, R * 0.05);
  ctx.stroke(hullPath);
}
