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
const CELL_GRID = {
  fighter:    { cols:  6, rows:  4 },
  bomber:     { cols:  7, rows:  5 },
  frigate:    { cols: 10, rows:  6 },
  cruiser:    { cols: 14, rows:  7 },
  battleship: { cols: 16, rows:  8 },
  carrier:    { cols: 18, rows: 10 },
  station:    { cols: 12, rows: 12 },
};

// Build a per-ship cell grid in ship-local coordinates. The bounding
// box spans roughly [-R..R] on each axis; cells outside the unit circle
// start `dead` so the grid hugs the silhouette rather than appearing as
// a flat square. `R` is the ship's spec.radius — the per-cell pixel
// size is R*2 / cols (and the same on the rows axis).
//
// Returns null when the class has no entry in CELL_GRID (defensive).
export function buildCells(klass, R) {
  const spec = CELL_GRID[klass];
  if (!spec) return null;
  const cols = spec.cols;
  const rows = spec.rows;
  // Per-axis cell size — slightly wider than tall on most hulls because
  // ships are elongated bow-to-stern. Picking the cell size as 2R/cols
  // makes the grid span the silhouette along the long axis; the row
  // axis uses the same cell size so cells stay square (consistent
  // "pixel-block" look). For stations the grid is genuinely square.
  const cellW = (R * 2) / cols;
  const cellH = klass === "station" ? cellW : (R * 1.4) / rows;
  const halfX = (cols * cellW) / 2;
  const halfY = (rows * cellH) / 2;
  const cells = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lx = -halfX + c * cellW + cellW / 2;
      const ly = -halfY + r * cellH + cellH / 2;
      // Approximate hull silhouette as an ellipse on the bounding box.
      // Cells whose centre falls outside the ellipse are `culled` so
      // they're never drawn AND never damaged — they don't leak ugly
      // dark squares into the silhouette's corners on undamaged ships.
      // Only cells that started `inside` and got killed by combat draw
      // as missing chunks.
      const nx = lx / (halfX * 0.98);
      const ny = ly / (halfY * 0.98);
      const inside = (nx * nx + ny * ny) <= 1.0;
      cells[r * cols + c] = {
        lx, ly, row: r, col: c,
        // One-shot kill keeps the visible-chunks feedback immediate —
        // we'd otherwise need two hits before a cell goes dark, which
        // hides the loss under shield/armor flicker.
        hp: 1,
        hpMax: 1,
        culled: !inside,    // never alive — not part of the silhouette
        dead: false,        // killed by damage — draws as a void
        // Module binding is set in ship.js after createShip — the
        // module table lives there, not here.
        moduleName: null,
        flash: 0,
      };
    }
  }
  return { cells, cellW, cellH, cols, rows, halfX, halfY };
}

// Kill every live cell whose centre falls within `radius` of (lx, ly).
// Returns the number of cells removed plus a list of newly-destroyed
// module names so the caller can fire the matching destruction VFX.
// Each cell takes at most one hp per call, so a single low-damage hit
// chips a cell, and a heavy hit clears a whole cluster.
export function damageCellsInRadius(ship, lx, ly, radius, hpDrain = 1) {
  if (!ship.cells || ship.cells.length === 0) {
    return { destroyed: 0, modulesDestroyed: [] };
  }
  const r2 = radius * radius;
  let destroyed = 0;
  const modulesDestroyed = [];
  for (const cell of ship.cells) {
    if (cell.culled || cell.dead) continue;
    const dx = cell.lx - lx;
    const dy = cell.ly - ly;
    if (dx * dx + dy * dy > r2) continue;
    cell.hp -= hpDrain;
    cell.flash = 1;
    if (cell.hp <= 0) {
      cell.dead = true;
      destroyed++;
    }
  }
  return { destroyed, modulesDestroyed };
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
      count++;
    }
  }
  return count;
}
