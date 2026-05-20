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

// Per-class cell HP. Heavier hulls take multiple cannon hits before a
// pixel finally pops, so a fighter strafing a battleship chips slowly
// while another battleship's broadside shears chunks. Stored once on
// the ship as `cellHpMax` so per-cell records only need the current hp
// value (uint8 fits comfortably).
export const CELL_HP = {
  fighter:    1,
  bomber:     1,
  frigate:    2,
  cruiser:    3,
  battleship: 4,
  carrier:    4,
  station:    5,
};

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
  const cellHpMax = CELL_HP[klass] || 1;
  const cellHullCost = CELL_HULL_COST[klass] || 0.5;
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
        // Per-class HP via cellHpMax on the ship — capitals chip slowly
        // while fighters' skin pops in a single hit. Only the current
        // hp is stored per cell; the max is uniform across the ship.
        hp: cellHpMax,
        culled: !inside,    // never alive — not part of the silhouette
        dead: false,        // killed by damage — draws as a void
        // Module binding is set in ship.js after createShip — the
        // module table lives there, not here.
        moduleName: null,
        flash: 0,
      };
    }
  }
  return { cells, cellW, cellH, cols, rows, halfX, halfY, cellHpMax, cellHullCost };
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
export function damageCellsInRadius(ship, lx, ly, radius, budget = 1) {
  if (!ship.cells || ship.cells.length === 0 || budget <= 0) {
    return { destroyed: 0 };
  }
  const cellHpMax = ship.cellHpMax || 1;
  const hullCost = ship.cellHullCost || 0;
  const r2 = radius * radius;
  const innerR2 = (radius * 0.5) * (radius * 0.5);
  // Bucket candidates into inner (closer than half-radius) and outer.
  // Inner cells absorb the damage first so a hit on the impact point
  // actually punches through pixels rather than spreading thin.
  const inner = [];
  const outer = [];
  for (const cell of ship.cells) {
    if (cell.culled || cell.dead) continue;
    const dx = cell.lx - lx;
    const dy = cell.ly - ly;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
    (d2 <= innerR2 ? inner : outer).push(cell);
  }
  let remaining = budget;
  let destroyed = 0;
  const drainBucket = (bucket) => {
    for (const cell of bucket) {
      if (remaining <= 0) break;
      const take = cell.hp <= remaining ? cell.hp : remaining;
      cell.hp -= take;
      remaining -= take;
      cell.flash = 1;
      if (cell.hp <= 0 && !cell.dead) {
        cell.dead = true;
        destroyed++;
        if (ship.deadCells) ship.deadCells.push(cell);
        if (hullCost > 0) ship.hp -= hullCost;
      }
    }
  };
  drainBucket(inner);
  if (remaining > 0) drainBucket(outer);
  return { destroyed };
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
  return count;
}
