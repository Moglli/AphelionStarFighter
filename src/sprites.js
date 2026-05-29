// Procedural ship sprite renderer + destructible damage-cell grid.
//
// Two systems live in this file:
//
// 1. Pre-rendered ship sprites — at game start, prerenderSprites() bakes
//    every (race, klass, side) combo into an offscreen canvas (hull +
//    shaded fill + panel lines + race accent stripe + outline).
//    drawShip blits the cached bitmap instead of re-tessellating polygons.
//
// 2. Damage cell grids — each ship class has a small grid of cells
//    overlaid on the sprite. Cells take hits and "die" (become dark
//    voids) so the silhouette visibly loses chunks as the ship is
//    damaged. Cells near a destructible module bind to it, so killing
//    a module also tears out its cluster of cells. See buildCells +
//    damageCellsInRadius (called from game.js applyDamage).
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

// Per-race base-fill recipes. Each race takes the side accent and
// shifts it toward the race's flavour palette so a Reavers fighter is
// visually grungy even before any overlays land:
//   Terran    — clean utilitarian metal (unmodified side accent).
//   Reavers   — rust-purple grime, dark blotch underlay.
//   Hegemony  — burnished amber armour, warm desaturated highlights.
//   Voidsworn — deep cold black-violet with a green energy bloom.
function applyRaceBaseFill(ctx, race, R, hullPath, side) {
  // Default: side accent fill.
  const fill = SIDES[side].accent;
  ctx.fillStyle = fill;
  ctx.fill(hullPath);
  if (race === "terran") return;
  ctx.save();
  ctx.clip(hullPath);
  if (race === "reavers") {
    // Grimy underlay — dark plum smear over the side fill.
    ctx.fillStyle = "rgba(50, 20, 38, 0.55)";
    ctx.fillRect(-R * 1.3, -R * 1.3, R * 2.6, R * 2.6);
    // Patchy rust blotches sprinkled across the hull.
    const blotchN = 7;
    for (let i = 0; i < blotchN; i++) {
      const ang = (i * 2.1) % (Math.PI * 2);
      const rad = R * (0.15 + 0.55 * (((i * 311) % 100) / 100));
      const cx = Math.cos(ang) * rad;
      const cy = Math.sin(ang) * rad;
      const bs = R * (0.08 + ((i * 173) % 100) / 600);
      ctx.fillStyle = "rgba(120, 50, 30, 0.35)";
      ctx.beginPath(); ctx.arc(cx, cy, bs, 0, Math.PI * 2); ctx.fill();
    }
  } else if (race === "thren") {
    // Organic flesh-tone underlay — deep magenta-violet with green
    // chitin highlights. Looks like a tissue surface, not metal.
    ctx.fillStyle = "rgba(60, 18, 50, 0.70)";
    ctx.fillRect(-R * 1.3, -R * 1.3, R * 2.6, R * 2.6);
    // Iridescent green chitin sheen — radial gradient bleeding from
    // the spine outward.
    const sheen = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.1);
    sheen.addColorStop(0.0, "rgba(100, 220, 130, 0.0)");
    sheen.addColorStop(0.45, "rgba(80, 200, 120, 0.20)");
    sheen.addColorStop(1.0, "rgba(160, 240, 180, 0.32)");
    ctx.fillStyle = sheen;
    ctx.fillRect(-R * 1.3, -R * 1.3, R * 2.6, R * 2.6);
    // Capillary mottling — irregular darker blotches that read as
    // organ structures under translucent skin.
    const blotchN = 8;
    for (let i = 0; i < blotchN; i++) {
      const ang = (i * 1.83) % (Math.PI * 2);
      const rad = R * (0.10 + 0.55 * (((i * 263) % 100) / 100));
      const cx = Math.cos(ang) * rad;
      const cy = Math.sin(ang) * rad;
      const bs = R * (0.10 + ((i * 211) % 100) / 500);
      ctx.fillStyle = "rgba(30, 10, 35, 0.40)";
      ctx.beginPath(); ctx.arc(cx, cy, bs, 0, Math.PI * 2); ctx.fill();
    }
  } else if (race === "hegemony") {
    // Warm amber wash — armoured metal that's caught the running lights.
    ctx.fillStyle = "rgba(150, 95, 35, 0.42)";
    ctx.fillRect(-R * 1.3, -R * 1.3, R * 2.6, R * 2.6);
    // A dark seam down the spine for a heavy "split keel" look.
    ctx.fillStyle = "rgba(20, 12, 8, 0.55)";
    ctx.fillRect(-R, -R * 0.04, R * 2, R * 0.08);
  } else if (race === "voidsworn") {
    // Deep void-tinted hull — looks like coated obsidian.
    ctx.fillStyle = "rgba(15, 25, 30, 0.65)";
    ctx.fillRect(-R * 1.3, -R * 1.3, R * 2.6, R * 2.6);
    // Faint green energy bleed under the spine.
    const grad = ctx.createLinearGradient(0, -R * 0.3, 0, R * 0.3);
    grad.addColorStop(0.0, "rgba(80, 240, 180, 0)");
    grad.addColorStop(0.5, "rgba(80, 240, 180, 0.22)");
    grad.addColorStop(1.0, "rgba(80, 240, 180, 0)");
    ctx.fillStyle = grad;
    ctx.fillRect(-R, -R * 0.3, R * 2, R * 0.6);
  }
  ctx.restore();
}

// Per-race detail pass — runs after the base fill, lighting gradient,
// and panel lines. Each race draws its own signature artwork:
//   Terran    — clean panel cross-lines, single thin spine stripe.
//   Reavers   — rivets, scorch streaks, jagged accent fangs.
//   Hegemony  — heavy chevron armour bands, perpendicular plate ridges.
//   Voidsworn — glowing rune nodes + a thin emissive seam down the spine.
// Caller has already clipped to the hull path.
function drawRaceDetails(ctx, race, klass, R, accent) {
  if (race === "reavers") {
    // Rivet dots — small dark studs scattered along the hull plates.
    ctx.fillStyle = "rgba(15, 10, 12, 0.7)";
    const rivetN = klass === "station" ? 14 : (klass === "battleship" || klass === "carrier" ? 18 : (klass === "fighter" ? 4 : 10));
    for (let i = 0; i < rivetN; i++) {
      // Pseudo-random spread using a deterministic hash so the pattern
      // is stable across renders.
      const a = (i * 2.397) % (Math.PI * 2);
      const r = R * 0.15 + ((i * 137) % 100) / 100 * R * 0.65;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r * 0.85;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.7, R * 0.018), 0, Math.PI * 2);
      ctx.fill();
    }
    // Jagged predator stripe — accent triangles down the spine.
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.5;
    const segments = klass === "fighter" ? 3 : 5;
    for (let i = 0; i < segments; i++) {
      const x0 = -R * 0.7 + (R * 1.4) * (i / segments);
      const w = R * (1.4 / segments) * 0.7;
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.lineTo(x0 + w * 0.5, -R * 0.08);
      ctx.lineTo(x0 + w, 0);
      ctx.lineTo(x0 + w * 0.5, R * 0.08);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Sharp scorch streak across the bow.
    ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
    ctx.lineWidth = Math.max(1, R * 0.03);
    ctx.beginPath();
    ctx.moveTo(R * 0.6, -R * 0.4);
    ctx.lineTo(R * 0.2, R * 0.25);
    ctx.stroke();
  } else if (race === "hegemony") {
    // Heavy chevron bands — three nested V's pointing forward.
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(1.5, R * 0.045);
    const chevronN = klass === "fighter" ? 2 : 3;
    for (let i = 0; i < chevronN; i++) {
      const x0 = R * 0.55 - i * R * 0.22;
      const span = R * 0.35;
      ctx.beginPath();
      ctx.moveTo(x0 - span, -span * 0.55);
      ctx.lineTo(x0, 0);
      ctx.lineTo(x0 - span, span * 0.55);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Heavy perpendicular plate ridges along the body.
    ctx.strokeStyle = "rgba(40, 25, 10, 0.65)";
    ctx.lineWidth = Math.max(1, R * 0.025);
    const plateN = klass === "fighter" ? 1 : (klass === "bomber" ? 2 : 4);
    for (let i = 1; i <= plateN; i++) {
      const x = -R * 0.45 + (R * 0.9) * ((i - 0.5) / plateN);
      ctx.beginPath();
      ctx.moveTo(x, -R);
      ctx.lineTo(x, R);
      ctx.stroke();
    }
    // Bright trim along the leading edges for a polished-armour read.
    ctx.fillStyle = "rgba(255, 220, 150, 0.42)";
    ctx.fillRect(R * 0.4, -R * 0.04, R * 0.55, R * 0.08);
  } else if (race === "thren") {
    // Branching vein network — dark capillary lines pulsing from a
    // central spine outward. Reads as a circulatory system under the
    // flesh skin.
    ctx.strokeStyle = "rgba(20, 5, 25, 0.55)";
    ctx.lineWidth = Math.max(0.6, R * 0.018);
    ctx.lineCap = "round";
    // Main spine — wavy line down the centre, not perfectly straight.
    ctx.beginPath();
    ctx.moveTo(-R * 0.75, 0);
    ctx.bezierCurveTo(-R * 0.3, -R * 0.05, R * 0.3, R * 0.05, R * 0.7, 0);
    ctx.stroke();
    // Branching capillaries — 5 short veins peeling off the spine,
    // mirrored top/bottom. Random-looking but deterministic via index.
    const veinSpots = klass === "fighter" ? 3 : (klass === "battleship" || klass === "carrier" || klass === "station") ? 8 : 5;
    for (let i = 0; i < veinSpots; i++) {
      const tx = -R * 0.6 + (R * 1.2) * (i / (veinSpots - 1 || 1));
      const sweep = R * (0.20 + 0.20 * ((i * 0.37) % 1));
      ctx.beginPath();
      ctx.moveTo(tx, 0);
      ctx.quadraticCurveTo(tx + sweep * 0.3, sweep * 0.4, tx + sweep * 0.1, sweep);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(tx, 0);
      ctx.quadraticCurveTo(tx + sweep * 0.3, -sweep * 0.4, tx + sweep * 0.1, -sweep);
      ctx.stroke();
    }
    // Bioluminescent nodes — bright green pulses along the spine, at
    // the joints where veins fork. Bright accent + soft halo to sell
    // the "living glow" read.
    const nodeN = klass === "fighter" ? 2 : (klass === "battleship" || klass === "carrier" || klass === "station") ? 6 : 4;
    for (let i = 0; i < nodeN; i++) {
      const nx = -R * 0.55 + (R * 1.1) * ((i + 0.5) / nodeN);
      const nr = Math.max(1.3, R * 0.04);
      // Soft halo
      const halo = ctx.createRadialGradient(nx, 0, 0, nx, 0, nr * 3);
      halo.addColorStop(0, "rgba(150, 255, 180, 0.55)");
      halo.addColorStop(1, "rgba(150, 255, 180, 0)");
      ctx.fillStyle = halo;
      ctx.fillRect(nx - nr * 3, -nr * 3, nr * 6, nr * 6);
      // Bright core
      ctx.fillStyle = "rgba(220, 255, 220, 0.95)";
      ctx.beginPath(); ctx.arc(nx, 0, nr, 0, Math.PI * 2); ctx.fill();
      // Green outer ring
      ctx.fillStyle = "rgba(100, 240, 140, 0.9)";
      ctx.beginPath(); ctx.arc(nx, 0, nr * 1.7, 0, Math.PI * 2);
      ctx.arc(nx, 0, nr * 0.9, 0, Math.PI * 2, true);
      ctx.fill();
    }
    // Cell-like skin pattern — small dotted nodes scattered across
    // the body to suggest cellular texture. Less prominent than the
    // veins so they read as background detail.
    ctx.fillStyle = "rgba(20, 8, 25, 0.55)";
    const cells = klass === "fighter" ? 6 : (klass === "carrier" || klass === "battleship" || klass === "station") ? 18 : 12;
    for (let i = 0; i < cells; i++) {
      const a = (i * 2.397) % (Math.PI * 2);
      const r = R * (0.20 + 0.55 * ((i * 0.31) % 1));
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r, Math.sin(a) * r * 0.85, Math.max(0.5, R * 0.012), 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (race === "voidsworn") {
    // Emissive seam down the spine — glowing thin line.
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = Math.max(1, R * 0.025);
    ctx.beginPath();
    ctx.moveTo(-R * 0.7, 0);
    ctx.lineTo(R * 0.6, 0);
    ctx.stroke();
    // Bright core line for the seam — sells the "live energy" read.
    ctx.strokeStyle = "rgba(220, 255, 235, 0.85)";
    ctx.lineWidth = Math.max(0.5, R * 0.01);
    ctx.beginPath();
    ctx.moveTo(-R * 0.7, 0);
    ctx.lineTo(R * 0.6, 0);
    ctx.stroke();
    ctx.globalAlpha = 1;
    // Rune nodes — small glowing diamonds at intervals.
    const runeN = klass === "fighter" ? 2 : (klass === "battleship" || klass === "carrier" ? 5 : 3);
    for (let i = 0; i < runeN; i++) {
      const x = -R * 0.55 + (R * 1.1) * ((i + 0.5) / runeN);
      const rs = Math.max(1.5, R * 0.045);
      ctx.save();
      ctx.translate(x, 0);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = "rgba(160, 250, 200, 0.85)";
      ctx.fillRect(-rs, -rs, rs * 2, rs * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      ctx.fillRect(-rs * 0.35, -rs * 0.35, rs * 0.7, rs * 0.7);
      ctx.restore();
    }
    // Soft inner halo near the bow — gives the impression of a contained
    // power core glow.
    if (klass !== "fighter" && klass !== "station") {
      const halo = ctx.createRadialGradient(R * 0.3, 0, 0, R * 0.3, 0, R * 0.4);
      halo.addColorStop(0, "rgba(160, 250, 200, 0.32)");
      halo.addColorStop(1, "rgba(160, 250, 200, 0)");
      ctx.fillStyle = halo;
      ctx.fillRect(-R * 0.1, -R * 0.4, R * 0.7, R * 0.8);
    }
  } else {
    // Terran — a single thin spine highlight and an accent flash near
    // the bow. Cleanest read of the four; the "default" baseline.
    ctx.fillStyle = "rgba(220, 240, 255, 0.4)";
    ctx.fillRect(-R * 0.65, -R * 0.015, R * 1.3, R * 0.03);
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(R * 0.3, -R * 0.07, R * 0.3, R * 0.14);
    ctx.globalAlpha = 1;
  }
}

function drawSchematic(ctx, race, klass, side, R) {
  const hull = getHull(race, klass);
  const accent = (RACES[race] && RACES[race].accent) || "#7df";
  const tint = SIDES[side].primary;

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

  // 2. Per-race base fill (replaces the flat side-accent fill).
  applyRaceBaseFill(ctx, race, R, hullPath, side);

  // 3. Top-down lighting gradient.
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
  // Voidsworn uses sleeker, sparser lines (energy seams handle the
  // structural read); Reavers use a heavier dark stroke for a riveted
  // industrial feel; Hegemony / Terran use the default panel grid.
  ctx.save();
  ctx.clip(hullPath);
  if (race === "voidsworn") {
    ctx.strokeStyle = "rgba(120, 220, 200, 0.16)";
  } else if (race === "reavers") {
    ctx.strokeStyle = "rgba(15, 10, 12, 0.42)";
  } else {
    ctx.strokeStyle = "rgba(200,230,255,0.18)";
  }
  ctx.lineWidth = Math.max(0.5, R * 0.012);
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
  if (klass === "station") {
    if (race === "voidsworn") {
      ctx.strokeStyle = "rgba(160, 250, 200, 0.30)";
    } else if (race === "reavers") {
      ctx.strokeStyle = "rgba(15, 10, 12, 0.45)";
    } else if (race === "hegemony") {
      ctx.strokeStyle = "rgba(80, 50, 20, 0.5)";
    } else {
      ctx.strokeStyle = "rgba(200,230,255,0.13)";
    }
    ctx.beginPath(); ctx.arc(0, 0, R * 0.45, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, R * 0.75, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();

  // 5. Race-specific detail pass + class-shape accent stripe.
  ctx.save();
  ctx.clip(hullPath);
  drawRaceDetails(ctx, race, klass, R, accent);
  // Class-specific accent shape (deck / radial / spine / broad).
  ctx.fillStyle = accent;
  const shape = STRIPE[klass];
  if (shape === "deck") {
    ctx.globalAlpha = 0.38;
    ctx.fillRect(-R * 0.85, -R * 0.07, R * 1.75, R * 0.14);
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = "rgba(220,240,255,0.6)";
    ctx.fillRect(-R * 0.7, -R * 0.018, R * 1.45, R * 0.036);
  } else if (shape === "radial") {
    // Station hub-and-spokes treatment, tinted by race.
    ctx.globalAlpha = 0.7;
    const dots = 6;
    for (let i = 0; i < dots; i++) {
      const a = (i / dots) * Math.PI * 2;
      const r = R * 0.6;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r, Math.sin(a) * r, R * 0.06, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = race === "voidsworn"
      ? "rgba(180, 255, 220, 0.9)"
      : race === "reavers"
        ? "rgba(255, 180, 130, 0.9)"
        : race === "hegemony"
          ? "rgba(255, 220, 150, 0.9)"
          : "rgba(220,240,255,0.9)";
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.18, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // 6. Bow cockpit / bridge bright spot (skip stations).
  if (klass !== "station") {
    // Voidsworn cockpit is a green pinpoint; Reavers' is a sooty red eye;
    // Hegemony cockpit is amber; Terran stays the original cool white.
    if (race === "voidsworn") {
      ctx.fillStyle = "rgba(160, 250, 200, 0.95)";
    } else if (race === "reavers") {
      ctx.fillStyle = "rgba(255, 130, 100, 0.9)";
    } else if (race === "hegemony") {
      ctx.fillStyle = "rgba(255, 210, 130, 0.9)";
    } else if (race === "thren") {
      // Glowing pink-magenta "eye" — distinct from voidsworn's green
      // bow node.
      ctx.fillStyle = "rgba(255, 140, 220, 0.95)";
    } else {
      ctx.fillStyle = "rgba(220,240,255,0.85)";
    }
    const bowX = klass === "carrier" ? R * 0.7 : R * 0.55;
    ctx.beginPath();
    ctx.arc(bowX, 0, R * 0.07, 0, Math.PI * 2);
    ctx.fill();
  }

  // 7. Outline stroke. Per-race tinting on top of the side primary so
  // even monochrome silhouettes hint at faction (Voidsworn outline is
  // tinged green, Reavers outline gets a darker rim, Hegemony stays
  // warm-tinted).
  let outlineColor = tint;
  if (race === "voidsworn") {
    outlineColor = blendColor(tint, "#9fa", 0.35);
  } else if (race === "reavers") {
    outlineColor = blendColor(tint, "#3a1c2e", 0.45);
  } else if (race === "hegemony") {
    outlineColor = blendColor(tint, "#fc6", 0.30);
  } else if (race === "thren") {
    // Magenta-ish chitin outline — distinct from voidsworn's green
    // outline so the two bio/green-tinted races read separately.
    outlineColor = blendColor(tint, "#b3f", 0.40);
  }
  // Strike craft (fighter/bomber) get a thicker double-stroke: a dark
  // halo backing + a brighter colored line on top. They're small enough
  // (R≈24-28) that a single thin outline disappears against a busy
  // starfield + wreckage at the default 0.5x zoom. Capitals already
  // read clearly from their sheer footprint, so they keep the original
  // single thin stroke.
  const isStrikeCraft = klass === "fighter" || klass === "bomber";
  if (isStrikeCraft) {
    // Halo: a dark rim 1.8× the colored stroke width, drawn first so
    // the colored stroke sits ON TOP and the halo only shows at the
    // outer edge. Makes the silhouette read like a stencilled icon.
    ctx.strokeStyle = "rgba(6,10,16,0.95)";
    ctx.lineWidth = Math.max(3.0, R * 0.14);
    ctx.stroke(hullPath);
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = Math.max(1.8, R * 0.08);
    ctx.stroke(hullPath);
  } else {
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = Math.max(1, R * 0.05);
    ctx.stroke(hullPath);
  }
}

// Linear-mix two hex colors. Used so the per-race outline tint keeps
// the side identity (blue vs. red) but shifts toward the race accent.
function blendColor(a, b, t) {
  const pa = parseHex(a);
  const pb = parseHex(b);
  const r = Math.round(pa.r * (1 - t) + pb.r * t);
  const g = Math.round(pa.g * (1 - t) + pb.g * t);
  const bl = Math.round(pa.b * (1 - t) + pb.b * t);
  return "rgb(" + r + "," + g + "," + bl + ")";
}
function parseHex(h) {
  if (!h || h[0] !== "#") return { r: 255, g: 255, b: 255 };
  const s = h.slice(1);
  if (s.length === 3) {
    return {
      r: parseInt(s[0] + s[0], 16),
      g: parseInt(s[1] + s[1], 16),
      b: parseInt(s[2] + s[2], 16),
    };
  }
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

// ---------------------------------------------------------------------------
// Destructible damage cells.
// ---------------------------------------------------------------------------
//
// Each class gets a 2D grid of cells laid over its silhouette. The grid
// is sized so the cell footprint covers the hull's bounding box; cells
// whose centre falls outside the unit-circle of the hull start `dead`
// (they were never part of the silhouette to begin with). Live cells
// take damage from projectile hits within a damage-scaled radius and
// from module destruction. A "dead" cell paints as a dark void in
// drawShip, leaving a visible chunk-shaped hole in the ship.
//
// gridCols/gridRows per class — bigger ships get more cells so the
// chunks read at the right scale. Cell size is then derived from
// spec.radius so the grid spans the silhouette regardless of which
// class-specific radius the ship instance happens to have.
//
// Grid bumped to ~2-3px per cell at typical zoom (the "pixel-based hull"
// feel) without sliding into per-pixel cost. ~600 avg cells × 250 ships
// ≈ 150k cells fleet-wide — 4-10x current resolution, comfortably
// inside canvas2D budget when we only iterate the dead-cells cache.
const CELL_GRID = {
  fighter:    { cols: 12, rows:  8 },
  bomber:     { cols: 14, rows: 10 },
  frigate:    { cols: 22, rows: 14 },
  cruiser:    { cols: 32, rows: 18 },
  battleship: { cols: 40, rows: 22 },
  carrier:    { cols: 48, rows: 26 },
  station:    { cols: 36, rows: 36 },
};

// Per-race grid overrides. Cell pixel size is R*2/cols, so a class whose
// race-specific radius differs from the baseline gets bigger/smaller
// blocks unless the grid is scaled to compensate.
//   Thren carrier: radius was doubled (220→440) for the "massive bio-
//   carrier" look, which also doubled its block size vs every other ship.
//   Doubling the grid (48×26 → 96×52) brings the block size back down to
//   the default while keeping the hull radius at 440. Side effect: ~4×
//   the cell count, so the hull is much tankier (per-cell HP unchanged).
const CELL_GRID_OVERRIDES = {
  thren: { carrier: { cols: 96, rows: 52 } },
};

// Per-class cell HP. Heavier hulls take multiple cannon hits before a
// pixel finally pops, so a fighter strafing a battleship chips slowly
// while another battleship's broadside shears chunks. Stored once on
// the ship as `cellHpMax` so per-cell records only need the current hp
// value (uint8 fits comfortably).
// Per-class hull-HP cost per cell death. Couples pixel erosion to the
// scalar ship.hp so the HP bar drains smoothly with chip damage — keeps
// AI / HUD code (which reads ship.hp) working unchanged.
export const CELL_HULL_COST = {
  fighter:    0.25,
  bomber:     0.25,
  frigate:    0.5,
  cruiser:    0.5,
  battleship: 1.0,
  carrier:    1.0,
  station:    1.0,
};

// Per-faction, per-class block stats. Each faction has a named default
// armor loadout — this is what ships spawn with before the player buys
// upgrades in the shipyard. Terran is the balance baseline; all other
// factions are tuned relative to it.
//
// hp    — block hit points. Cannon rounds take 3-8 hits to kill at center;
//         missiles one-shot near the blast. Armor stretches this further.
// armor — damage reduction (0–1). effectiveDmg = dmg * (1 - armor).
export const FACTION_CELL_STATS = {
  terran: {
    armorName: "Plasta-Steel MK2",
    fighter:    { hp: 10, armor: 0.00 },
    bomber:     { hp: 12, armor: 0.00 },
    frigate:    { hp: 16, armor: 0.10 },
    cruiser:    { hp: 20, armor: 0.20 },
    battleship: { hp: 22, armor: 0.30 },
    carrier:    { hp: 20, armor: 0.25 },
    station:    { hp: 28, armor: 0.35 },
  },
  hegemony: {
    armorName: "Ferromag Composite",
    fighter:    { hp: 15, armor: 0.10 },
    bomber:     { hp: 18, armor: 0.10 },
    frigate:    { hp: 24, armor: 0.20 },
    cruiser:    { hp: 30, armor: 0.30 },
    battleship: { hp: 34, armor: 0.42 },
    carrier:    { hp: 30, armor: 0.35 },
    station:    { hp: 42, armor: 0.45 },
  },
  reavers: {
    armorName: "Refurb Composite Steel",
    fighter:    { hp:  7, armor: 0.00 },
    bomber:     { hp:  8, armor: 0.00 },
    frigate:    { hp: 11, armor: 0.05 },
    cruiser:    { hp: 14, armor: 0.12 },
    battleship: { hp: 16, armor: 0.20 },
    carrier:    { hp: 14, armor: 0.15 },
    station:    { hp: 20, armor: 0.25 },
  },
  voidsworn: {
    armorName: "Void-Tempered Lattice",
    fighter:    { hp:  8, armor: 0.00 },
    bomber:     { hp: 10, armor: 0.00 },
    frigate:    { hp: 12, armor: 0.05 },
    cruiser:    { hp: 15, armor: 0.12 },
    battleship: { hp: 17, armor: 0.20 },
    carrier:    { hp: 15, armor: 0.15 },
    station:    { hp: 22, armor: 0.25 },
  },
  thren: {
    armorName: "Bio-Chitin Plate",
    fighter:    { hp:  6, armor: 0.00 },
    bomber:     { hp:  8, armor: 0.00 },
    frigate:    { hp: 10, armor: 0.05 },
    cruiser:    { hp: 13, armor: 0.10 },
    battleship: { hp: 14, armor: 0.15 },
    carrier:    { hp: 18, armor: 0.10 },
    station:    { hp: 18, armor: 0.20 },
  },
};

// Resolve block stats for a given faction + class. Falls back to Terran
// if the faction is unknown (safe for future faction additions).
export function getCellStats(race, klass) {
  const faction = FACTION_CELL_STATS[race] || FACTION_CELL_STATS.terran;
  return faction[klass] || FACTION_CELL_STATS.terran[klass] || { hp: 10, armor: 0 };
}

// Per-faction base RGB for block-grid rendering. Used by rebuildBlockCanvas
// to shade each cell by type (structural / weapon / engine / PD / core).
const BLOCK_PALETTE = {
  terran:    { r: 28,  g: 56,  b: 90  },
  hegemony:  { r: 55,  g: 20,  b: 65  },
  reaver:    { r: 85,  g: 20,  b: 18  },
  voidsworn: { r: 12,  g: 20,  b: 60  },
  thren:     { r: 20,  g: 65,  b: 28  },
};

// Module-type accent color mixed into system cells so you can read which
// blocks carry weapons, engines, PD, etc. at a glance.
function moduleAccentRGB(name) {
  if (!name) return null;
  if (name.startsWith("engine-"))              return { r: 220, g: 100, b: 20  };
  if (name.startsWith("broadside-")
   || name === "gun" || name === "gun-array"
   || name === "cannon")                       return { r: 210, g: 50,  b: 50  };
  if (name.startsWith("pd-"))                  return { r: 40,  g: 160, b: 210 };
  if (name.startsWith("missile-")
   || name === "torpedo-bay")                  return { r: 210, g: 185, b: 40  };
  if (name.startsWith("laser"))                return { r: 40,  g: 210, b: 210 };
  if (name === "hangar")                       return { r: 140, g: 100, b: 40  };
  return { r: 160, g: 160, b: 160 };
}

function cellFillColor(cell, base) {
  // Alive-till-dead: every live cell renders at full brightness. The
  // damage state is communicated by cells WINKING OUT when they die,
  // not by progressive dimming. (Was: bright = 0.30 + frac*0.70 — a
  // hp-based tint that read as a "wounded" hull texture; the user
  // wants a cleaner alive/dead binary.)
  let r, g, b;
  if (cell.isCore) {
    // Core: bright teal/white highlight so it stands out as the vital block.
    r = Math.min(255, base.r * 0.4 + 180);
    g = Math.min(255, base.g * 0.4 + 180);
    b = Math.min(255, base.b * 0.4 + 200);
  } else {
    const acc = cell.moduleName ? moduleAccentRGB(cell.moduleName) : null;
    if (acc) {
      r = base.r * 0.25 + acc.r * 0.75;
      g = base.g * 0.25 + acc.g * 0.75;
      b = base.b * 0.25 + acc.b * 0.75;
    } else {
      r = base.r;
      g = base.g;
      b = base.b;
    }
  }
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

// Parse "#rgb" or "#rrggbb" into {r,g,b}. Returns null on invalid input.
function parseHexRGB(hex) {
  if (!hex || hex[0] !== "#") return null;
  if (hex.length === 4) {
    return {
      r: parseInt(hex[1] + hex[1], 16),
      g: parseInt(hex[2] + hex[2], 16),
      b: parseInt(hex[3] + hex[3], 16),
    };
  }
  if (hex.length === 7) {
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16),
    };
  }
  return null;
}

// (Re)draw every live cell of a ship onto ship.blockCanvas. Called once
// per ship on first draw and whenever ship.blockDirty is true (cells
// changed HP or alive state). Returns immediately if no cell grid.
export function rebuildBlockCanvas(ship) {
  if (!ship.cells || !ship.cellW) return;
  const cw = ship.cellW;
  const ch = ship.cellH;
  const cols = ship.cols;
  const rows = ship.rows;
  const halfX = ship.cellHalfX;
  const halfY = ship.cellHalfY;
  const canvasW = Math.ceil(cols * cw) + 2;
  const canvasH = Math.ceil(rows * ch) + 2;

  if (!ship.blockCanvas) {
    ship.blockCanvas = document.createElement("canvas");
  }
  if (ship.blockCanvas.width !== canvasW || ship.blockCanvas.height !== canvasH) {
    ship.blockCanvas.width  = canvasW;
    ship.blockCanvas.height = canvasH;
  }
  const bctx = ship.blockCanvas.getContext("2d");
  bctx.clearRect(0, 0, canvasW, canvasH);

  // Use the player's custom paint color as the base palette if set,
  // so the shipyard color picker is visible in combat on structural cells.
  // System cells still read distinctly (accent color dominates 75% of the mix).
  let base = BLOCK_PALETTE[ship.race] || BLOCK_PALETTE.terran;
  if (ship.paint && ship.paint.primary) {
    const p = parseHexRGB(ship.paint.primary);
    if (p) base = p;
  }
  const GAP = Math.max(1, Math.round(Math.min(cw, ch) * 0.12));

  for (const cell of ship.cells) {
    if (cell.culled || cell.dead) continue;
    // Canvas coords: (0,0) is top-left = local (-halfX-1, -halfY-1)
    const cx = cell.lx + halfX + 1;
    const cy = cell.ly + halfY + 1;
    bctx.fillStyle = cellFillColor(cell, base);
    bctx.fillRect(cx - cw / 2 + GAP / 2, cy - ch / 2 + GAP / 2, cw - GAP, ch - GAP);
  }

  // Strike craft (fighter/bomber) get a baked-on silhouette outline.
  // Without it they read as a small cluster of pixels lost in the
  // starfield + projectile noise at default 0.5x zoom. Capitals are
  // big enough that their cell mass is its own silhouette — the trace
  // is gated to strike craft so we don't add a fat outline to a
  // battleship at high zoom.
  if (ship.klass === "fighter" || ship.klass === "bomber") {
    const hull = getHull(ship.race, ship.klass);
    const R = (ship.spec && ship.spec.radius) || 24;
    if (hull && hull.length > 2) {
      // Dark halo first (3-4px), then a side-tinted line on top so the
      // edge reads at distance without losing the team color.
      const tint = (ship.side && SIDES[ship.side] && SIDES[ship.side].primary) || "#aef";
      bctx.lineJoin = "round";
      bctx.lineCap = "round";
      const tracePath = () => {
        bctx.beginPath();
        bctx.moveTo(hull[0][0] * R + halfX + 1, hull[0][1] * R + halfY + 1);
        for (let i = 1; i < hull.length; i++) {
          bctx.lineTo(hull[i][0] * R + halfX + 1, hull[i][1] * R + halfY + 1);
        }
        bctx.closePath();
      };
      tracePath();
      bctx.strokeStyle = "rgba(4,8,14,0.95)";
      bctx.lineWidth = Math.max(3.0, R * 0.16);
      bctx.stroke();
      tracePath();
      bctx.strokeStyle = tint;
      bctx.lineWidth = Math.max(1.6, R * 0.08);
      bctx.stroke();
    }
  }
  ship.blockDirty = false;
}

// BFS from the core cell through 4-connected non-dead cells. Any cell not
// reachable from core is orphaned — marked dead and its module disabled.
export function checkCellConnectivity(ship) {
  if (!ship.cells || !ship.coreCell || ship.coreCell.dead) return;
  const cols = ship.cols;
  const rows = ship.rows;
  const visited = new Uint8Array(cols * rows);

  const queue = [ship.coreCell];
  visited[ship.coreCell.row * cols + ship.coreCell.col] = 1;
  let head = 0;
  while (head < queue.length) {
    const curr = queue[head++];
    for (let d = 0; d < 4; d++) {
      const nr = curr.row + (d < 2 ? (d === 0 ? -1 : 1) : 0);
      const nc = curr.col + (d >= 2 ? (d === 2 ? -1 : 1) : 0);
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const ni = nr * cols + nc;
      if (visited[ni]) continue;
      const nb = ship.cells[ni];
      if (!nb || nb.culled || nb.dead) continue;
      visited[ni] = 1;
      queue.push(nb);
    }
  }

  const hullCost = ship.cellHullCost || 0;
  for (let i = 0; i < ship.cells.length; i++) {
    const cell = ship.cells[i];
    if (cell.culled || cell.dead || visited[i]) continue;
    // Orphaned block — destroy it
    cell.dead = true;
    cell.hp = 0;
    if (ship.deadCells) ship.deadCells.push(cell);
    if (hullCost > 0) ship.hp = Math.max(0, ship.hp - hullCost);
    // Disable any system mounted on this block
    if (cell.moduleName && ship.moduleByName) {
      const mod = ship.moduleByName[cell.moduleName];
      if (mod && !mod.disabled) {
        mod.disabled = true;
        mod.hp = 0;
        ship.hp = Math.max(0, ship.hp - (mod.hullPenalty || 0));
      }
    }
  }
}

// Build a per-ship cell grid in ship-local coordinates. The bounding
// box spans roughly [-R..R] on each axis; cells outside the unit circle
// Ray-cast even-odd test: returns true when (px, py) is inside `poly`.
// poly is an array of [x, y] pairs in unit space (hull coords).
// Runs once per cell at spawn — zero runtime cost during gameplay.
function pointInHull(poly, px, py) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > py) !== (yj > py) &&
        px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// start `dead` so the grid hugs the silhouette rather than appearing as
// a flat square. `R` is the ship's spec.radius — the per-cell pixel
// size is R*2 / cols (and the same on the rows axis).
//
// Returns null when the class has no entry in CELL_GRID (defensive).
export function buildCells(klass, R, race = "terran") {
  const spec = (CELL_GRID_OVERRIDES[race] && CELL_GRID_OVERRIDES[race][klass]) || CELL_GRID[klass];
  if (!spec) return null;
  const cols = spec.cols;
  const rows = spec.rows;
  const blockStats = getCellStats(race, klass);
  const cellHpMax = blockStats.hp;
  const cellArmor = blockStats.armor;
  const cellHullCost = CELL_HULL_COST[klass] || 0.5;
  const hull = getHull(race, klass);
  // Per-axis cell size. The X span is fixed at 2R (hull |x| ≤ 1). The Y
  // span must cover the hull's ACTUAL half-height: many non-Terran
  // cruisers / battleships / bombers reach |y| ≈ 0.85–0.95, well past the
  // old hardcoded 0.7R — so the grid clipped their wings/flanks (parts of
  // the silhouette rendered as nothing) AND left edge-mounted modules
  // (broadsides, flank PD) with no block to sit on. Track the true hull
  // half-height, floored at 0.70 so flat Terran hulls keep their original
  // grid byte-for-byte. Cell count (rows) is unchanged — only cellH grows
  // for tall hulls, so HP tuning / perf / surrender %s are unaffected.
  let maxAbsY = 0;
  for (const v of hull) { const ay = Math.abs(v[1]); if (ay > maxAbsY) maxAbsY = ay; }
  const halfYUnit = Math.max(0.70, maxAbsY);
  const cellW = (R * 2) / cols;
  const cellH = klass === "station" ? cellW : (R * 2 * halfYUnit) / rows;
  const halfX = (cols * cellW) / 2;
  const halfY = (rows * cellH) / 2;
  const cells = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lx = -halfX + c * cellW + cellW / 2;
      const ly = -halfY + r * cellH + cellH / 2;
      // Cull cells whose centre falls outside the actual hull polygon.
      // pointInHull runs in unit space; cell coords are in pixel space
      // scaled by R, so divide by R to convert back to unit coords.
      const inside = pointInHull(hull, lx / R, ly / R);
      cells[r * cols + c] = {
        lx, ly, row: r, col: c,
        hp: cellHpMax,
        hpMax: cellHpMax,
        // Per-cell armor (0..1 damage reduction). Initialized from the
        // class-level value; module-bearing cells get a small bonus
        // (assignModulesToCells does that pass). Read by damageCells-
        // InRadius so a heavy-plated capital battles longer than a
        // strike craft block-for-block. Replaces the old ship.cellArmor
        // ship-wide constant.
        armor: cellArmor,
        culled: !inside,
        dead: false,
        isCore: false,      // set below for the cell closest to origin
        moduleName: null,
        flash: 0,
      };
    }
  }
  // Mark the live cell closest to the hull centre as the CORE BLOCK.
  // Destroying it kills the ship instantly. Ships with no live cells
  // (shouldn't happen) skip this gracefully.
  let coreDist = Infinity, coreCell = null;
  for (const cell of cells) {
    if (cell.culled) continue;
    const d = cell.lx * cell.lx + cell.ly * cell.ly;
    if (d < coreDist) { coreDist = d; coreCell = cell; }
  }
  if (coreCell) coreCell.isCore = true;

  return { cells, cellW, cellH, cols, rows, halfX, halfY, cellHpMax, cellHullCost, cellArmor, coreCell };
}

// Collision narrow-phase: does a projectile disc (WORLD centre px,py, radius
// pr) overlap any LIVE block of `ship`? Lets rounds pass through eroded gaps
// and impact on the remaining structure instead of the original full-hull
// circle. Converts the point into the ship-local block frame and only scans
// the handful of cells under the disc's bounding box, so it's O(1)-ish per
// projectile/ship pair. Returns true on the first live-cell overlap.
export function projectileBlockHit(ship, px, py, pr) {
  return projectileBlockHitCell(ship, px, py, pr) !== null;
}

// Same disc-vs-live-cell test, but returns the CLOSEST live cell the
// projectile overlaps (or null if none). game.js uses this to snap the
// projectile's world position onto the actual block before spawning
// damage VFX — otherwise the sparks/scar/hit-event spawn at the
// projectile's current position which (for a half-destroyed hull) can
// land in empty space outside the surviving cells, breaking "weapons
// must impact the hull for visual continuity".
export function projectileBlockHitCell(ship, px, py, pr) {
  if (!ship.cells || !ship.cellW) return null;
  const dx = px - ship.pos.x, dy = py - ship.pos.y;
  const c = Math.cos(-ship.heading), s = Math.sin(-ship.heading);
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  const cw = ship.cellW, ch = ship.cellH;
  const halfX = ship.cellHalfX, halfY = ship.cellHalfY;
  const minCol = Math.max(0, Math.floor((lx - pr + halfX) / cw));
  const maxCol = Math.min(ship.cols - 1, Math.floor((lx + pr + halfX) / cw));
  const minRow = Math.max(0, Math.floor((ly - pr + halfY) / ch));
  const maxRow = Math.min(ship.rows - 1, Math.floor((ly + pr + halfY) / ch));
  const pr2 = pr * pr;
  let bestCell = null;
  let bestD2 = Infinity;
  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      const cell = ship.cells[row * ship.cols + col];
      if (!cell || cell.culled || cell.dead) continue;
      // Closest point on the cell rect to the disc centre.
      const nx = Math.max(cell.lx - cw / 2, Math.min(lx, cell.lx + cw / 2));
      const ny = Math.max(cell.ly - ch / 2, Math.min(ly, cell.ly + ch / 2));
      const ex = lx - nx, ey = ly - ny;
      const d2 = ex * ex + ey * ey;
      if (d2 <= pr2 && d2 < bestD2) {
        bestCell = cell;
        bestD2 = d2;
      }
    }
  }
  return bestCell;
}

// Snap a module's unit-hull offset onto the nearest LIVE block so the
// module visibly rests on ship structure instead of floating in a culled
// void — needle prows, tapered sterns, and hull flanks that the grid
// can't represent at this point. Pure geometry, called once per module at
// spawn (see createShip). `grid` is the buildCells result; `ux,uy` are the
// module's offset.x/.y in unit-hull space; `R` scales unit→cell space.
// Returns the (possibly unchanged) unit offset {x, y}: if the module
// centre already lands inside a live cell it is returned as-is, otherwise
// it is moved to the centre of the closest non-culled cell. The PD ring,
// broadside batteries, and engine nozzles all read these snapped offsets,
// so their disc + art + firing origin stay coincident on the block.
// `placed` (optional) is an array of already-seated modules
// [{x, y, r}, …] in unit-hull space; `selfR` is this module's unit radius.
// When supplied, the snap won't just keep/return any live cell — it prefers
// the nearest live cell whose centre clears every placed module by
// (selfR + p.r) * 0.9, so a module shoved off its layout slot (an off-hull
// broadside, a stern PD turret) doesn't land on top of a neighbour. Falls
// back to the nearest live cell if the hull is too cramped to find a clear
// one (the genuinely-no-room case).
// `accept(unitX, unitY)` (optional) further restricts eligible cells — used
// by the symmetric placer to keep centreline modules on the axis and pair
// members on the +y half-plane with enough offset that their mirror clears.
export function snapOffsetToLiveCell(grid, R, ux, uy, placed = null, selfR = 0, accept = null) {
  if (!grid || !grid.cells) return { x: ux, y: uy, idx: -1 };
  const lx = ux * R, ly = uy * R;
  const clear = (cx, cy) => {
    if (!placed) return true;
    for (const p of placed) {
      const dx = cx - p.x, dy = cy - p.y;
      const need = (selfR + p.r) * 0.9;
      if (dx * dx + dy * dy < need * need) return false;
    }
    return true;
  };
  const ok = (cx, cy) => !accept || accept(cx, cy);
  // Cell whose footprint contains the module centre — keep it if live, clear
  // of neighbours, AND accepted by the constraint.
  const col = Math.floor((lx + grid.halfX) / grid.cellW);
  const row = Math.floor((ly + grid.halfY) / grid.cellH);
  if (col >= 0 && col < grid.cols && row >= 0 && row < grid.rows) {
    const idx = row * grid.cols + col;
    const c = grid.cells[idx];
    if (c && !c.culled && !c.dead && clear(ux, uy) && ok(ux, uy)) return { x: ux, y: uy, idx };
  }
  // Prefer nearest CLEAR+accepted; then nearest accepted; then nearest live.
  let best = null, bestD2 = Infinity, bestIdx = -1;          // clear + accepted
  let acc = null, accD2 = Infinity, accIdx = -1;             // accepted (any)
  let any = null, anyD2 = Infinity, anyIdx = -1;             // live (any)
  for (let i = 0; i < grid.cells.length; i++) {
    const c = grid.cells[i];
    if (c.culled || c.dead) continue;
    const cx = c.lx / R, cy = c.ly / R;
    const dx = c.lx - lx, dy = c.ly - ly;
    const d2 = dx * dx + dy * dy;
    if (d2 < anyD2) { anyD2 = d2; any = c; anyIdx = i; }
    if (ok(cx, cy)) {
      if (d2 < accD2) { accD2 = d2; acc = c; accIdx = i; }
      if (d2 < bestD2 && clear(cx, cy)) { bestD2 = d2; best = c; bestIdx = i; }
    }
  }
  const pick = best || acc || any;
  const pickIdx = best ? bestIdx : acc ? accIdx : anyIdx;
  return pick ? { x: pick.lx / R, y: pick.ly / R, idx: pickIdx } : { x: ux, y: uy, idx: -1 };
}

// Snap a ship's modules onto live blocks while ENFORCING port↔starboard
// mirror symmetry about the long (x) axis, so weapon + PD systems read
// symmetric. Offsets are mutated in place. Hull polygons are themselves
// y-symmetric, so a clear +y cell guarantees a clear -y mirror. Steps:
//   1. Pair off-axis modules by (same x, opposite-sign y, equal radius).
//   2. Pin centreline + any lone off-axis module to the axis (y = 0).
//   3. For each pair, snap the +y member to the nearest clear block on the
//      +y half-plane (offset ≥ its radius so the mirror doesn't overlap it),
//      then place its twin at (x, -y).
// `placed` stays symmetric throughout, so clearing the +y member also clears
// the mirror. Shared by createShip and the shipyard blueprint preview.
export function snapModulesSymmetric(grid, R, modules) {
  if (!grid || !grid.cells || !modules || modules.length === 0) return;
  const EPSy = Math.max(0.02, (grid.cellH / R) * 0.6);
  const n = modules.length;
  const partner = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (partner[i] >= 0 || Math.abs(modules[i].offset.y) < EPSy) continue;
    for (let j = i + 1; j < n; j++) {
      if (partner[j] >= 0 || Math.abs(modules[j].offset.y) < EPSy) continue;
      const a = modules[i].offset, b = modules[j].offset;
      if (a.y * b.y < 0 &&                          // opposite sides
          Math.abs(a.x - b.x) < 0.06 &&
          Math.abs(Math.abs(a.y) - Math.abs(b.y)) < 0.10 &&
          Math.abs(modules[i].radius - modules[j].radius) < 1e-6) {
        partner[i] = j; partner[j] = i; break;
      }
    }
  }
  const placed = [];
  const rec = (m) => placed.push({ x: m.offset.x, y: m.offset.y, r: m.radius });
  // 1+2. Centreline + lone off-axis modules → pinned to the axis.
  for (let i = 0; i < n; i++) {
    if (partner[i] >= 0) continue;
    const m = modules[i];
    const sn = snapOffsetToLiveCell(grid, R, m.offset.x, 0, placed, m.radius,
      (x, y) => Math.abs(y) < EPSy);
    m.offset.x = sn.x; m.offset.y = 0;
    rec(m);
  }
  // 3. Mirror pairs (process each once, i < j).
  for (let i = 0; i < n; i++) {
    const j = partner[i];
    if (j < 0 || j < i) continue;
    const a = modules[i].offset.y >= 0 ? modules[i] : modules[j];
    const b = a === modules[i] ? modules[j] : modules[i];
    const minSep = a.radius * 0.95;
    const sn = snapOffsetToLiveCell(grid, R, a.offset.x, Math.max(Math.abs(a.offset.y), minSep),
      placed, a.radius, (x, y) => y >= minSep);
    a.offset.x = sn.x; a.offset.y = sn.y;
    b.offset.x = sn.x; b.offset.y = -sn.y;
    rec(a); rec(b);
  }
}

// Apply a damage budget to cells whose centre falls within `radius` of
// (lx, ly). Inner cells take damage first (full hpMax each), spillover
// goes to outer cells. This means a small chip eats one pixel, a heavy
// shot shears a tight cluster, and you can't vaporise half a ship with
// a single hit (budget is capped by the caller). Cells that drop to 0
// hp flip to `dead`, are pushed onto ship.deadCells for cheap iteration
// at draw time, and deduct cellHullCost from ship.hp so the HP bar
// erodes smoothly along with the silhouette.
//
// `budget` is the total damage to deal across the affected cells. The
// caller (game.js) clamps this at ~remaining*1.2 so a single huge beam
// tick can't punch through half a battleship in one frame.
// Apply weapon impact at local point (lx, ly) with given blast radius and
// damage. Each cell in range receives independent damage scaled by quadratic
// falloff (full at center, zero at edge) and reduced by per-class armor:
//   effectiveDmg = dmg * max(0, 1 - dist²/radius²) * (1 - armor)
// Cells whose HP drops to 0 are destroyed individually. Multiple hits
// gradually erode a block — cannons bite over 4-8 shots, missiles punch
// through in 1-2 near the blast center.
export function damageCellsInRadius(ship, lx, ly, radius, dmg) {
  if (!ship.cells || ship.cells.length === 0 || dmg <= 0 || radius <= 0) {
    return { destroyed: 0 };
  }
  const hullCost = ship.cellHullCost || 0;
  const r2 = radius * radius;
  let destroyed = 0;
  let coreKilled = false;

  for (const cell of ship.cells) {
    if (cell.culled || cell.dead) continue;
    const dx = cell.lx - lx;
    const dy = cell.ly - ly;
    const d2 = dx * dx + dy * dy;
    if (d2 >= r2) continue;

    // Quadratic falloff: 1.0 at center, 0 at radius edge. Each cell
    // applies ITS OWN armor reduction now (per-cell, not ship-wide),
    // so a heavy-armoured battleship core block resists more than its
    // lightly-plated wing cells.
    const cellArmor = cell.armor || 0;
    const effective = dmg * (1 - d2 / r2) * (1 - cellArmor);
    if (effective <= 0) continue;

    cell.hp -= effective;
    cell.flash = 1;

    if (cell.hp <= 0 && !cell.dead) {
      cell.hp = 0;
      cell.dead = true;
      destroyed++;
      if (ship.deadCells) ship.deadCells.push(cell);
      if (hullCost > 0) ship.hp = Math.max(0, ship.hp - hullCost);
      if (cell.moduleName && ship.moduleByName) {
        const mod = ship.moduleByName[cell.moduleName];
        if (mod && !mod.disabled) {
          mod.disabled = true;
          mod.hp = 0;
          ship.hp = Math.max(0, ship.hp - (mod.hullPenalty || 0));
        }
      }
      if (cell.isCore) coreKilled = true;
    }
  }

  // Block canvas only needs rebuild when a cell actually dies — cells
  // no longer dim with damage (alive-till-dead visual). The momentary
  // impact ember (cell.flash) draws on top in ship.js, not into the
  // baked canvas.
  if (destroyed > 0) ship.blockDirty = true;
  if (destroyed > 0 && !coreKilled) checkCellConnectivity(ship);
  return { destroyed, coreKilled };
}

// Pre-damage the block grid to match a carry-over hull fraction
// (initialHpFrac < 1 from a prior roguelite battle). Kills approximately
// (1-hpFrac) of cells without touching ship.hp — the caller already set
// hp = spec.hp * hpFrac.
//
// Strategy: sort structural cells furthest-from-core first with light
// random jitter, then kill from the outside edge inward. This erodes the
// hull silhouette naturally (outer blocks missing, core area intact) and
// keeps remaining blocks connected so no BFS cascade is needed. Module
// cells are only killed if structural cells run out (preserving systems
// until very high damage fractions). Core cell is never killed.
export function preDamageBlockGrid(ship, hpFrac) {
  if (!ship.cells || hpFrac >= 1) return;
  const allLive = [];
  for (const cell of ship.cells) {
    if (!cell.culled && !cell.dead) allLive.push(cell);
  }
  if (allLive.length === 0) return;
  const targetKills = Math.round((1 - hpFrac) * allLive.length);
  if (targetKills <= 0) return;

  const coreLx = ship.coreCell ? ship.coreCell.lx : 0;
  const coreLy = ship.coreCell ? ship.coreCell.ly : 0;
  const coreDist2 = (c) => (c.lx - coreLx) ** 2 + (c.ly - coreLy) ** 2;
  // R² for jitter scale — roughly (hull radius)²
  const R2 = (ship.cellHalfX || 1) ** 2 + (ship.cellHalfY || 1) ** 2;

  const structural = allLive.filter((c) => !c.moduleName && !c.isCore);
  const modular    = allLive.filter((c) =>  c.moduleName && !c.isCore);

  // Sort structural cells: furthest-from-core first, with 30% jitter so
  // the damage front looks ragged rather than a perfect concentric ring.
  structural.sort((a, b) =>
    (coreDist2(b) - coreDist2(a)) + (Math.random() - 0.5) * R2 * 0.3
  );

  let killed = 0;
  const killCell = (cell) => {
    cell.dead = true; cell.hp = 0;
    if (ship.deadCells) ship.deadCells.push(cell);
    killed++;
  };
  for (const cell of structural) {
    if (killed >= targetKills) break;
    killCell(cell);
  }
  // If structural cells weren't enough, erode module cells (except core)
  // in the same outward-first order. Disables the mounted system.
  if (killed < targetKills) {
    modular.sort((a, b) =>
      (coreDist2(b) - coreDist2(a)) + (Math.random() - 0.5) * R2 * 0.3
    );
    for (const cell of modular) {
      if (killed >= targetKills) break;
      killCell(cell);
      if (cell.moduleName && ship.moduleByName) {
        const mod = ship.moduleByName[cell.moduleName];
        if (mod && !mod.disabled) { mod.disabled = true; mod.hp = 0; }
      }
    }
  }

  ship.blockDirty = true;
}

// Kill every live cell bound to a given module (called when the module
// gets disabled by the existing module-damage flow in game.js). The
// cluster of cells over the module visibly tears out at once.
export function killCellsForModule(ship, moduleName) {
  if (!ship.cells || !moduleName) return 0;
  let count = 0;
  for (const cell of ship.cells) {
    if (cell.culled || cell.dead) continue;
    if (cell.moduleName === moduleName) {
      cell.dead = true;
      cell.hp = 0;
      count++;
      if (ship.deadCells) ship.deadCells.push(cell);
    }
  }
  if (count > 0) {
    ship.blockDirty = true;
    checkCellConnectivity(ship);
  }
  return count;
}
