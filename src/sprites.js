/**
 * @file Pixel-cell ship sprites.
 *
 * Every ship is a 2D grid of cells. Each cell is its own destructible
 * unit: when a projectile lands, every cell within a damage-scaled
 * radius is removed. As cells disappear the silhouette literally
 * "chews" away, leaving visible chunks missing long before the ship's
 * hp pool runs out.
 *
 * Cell types (character → cell.kind):
 *   '.'  vacuum — no cell, transparent
 *   '#'  hull plate
 *   'H'  heavy hull plate (darker, structural)
 *   'B'  bridge / command core (lit accent)
 *   'E'  engine block (warm glow, rear-facing)
 *   'P'  PD turret mount  — maps to a `pd` module slot
 *   'M'  missile pod mount — maps to a `pod` module slot
 *   'L'  heavy laser mount — maps to a `laser` module slot
 *
 * Sprite orientation: forward is +x (rightmost columns). Row 0 is the
 * top of the ship (-y in local coords). The grid is centered on the
 * ship's origin so column gridW/2 and row gridH/2 map to (0, 0).
 *
 * cellSize is the per-cell pixel size in ship-local units. Together with
 * the grid dimensions it sets the visual hull extent — chosen per class
 * so the silhouette roughly matches spec.radius without forcing every
 * sprite to share the same resolution.
 */

export const SPRITES = {
  fighter: {
    cellSize: 2.6,
    grid: [
      ".....####.",
      "....######",
      "E.#HHHB###",
      "E.#HHHB###",
      "....######",
      ".....####.",
    ],
  },
  bomber: {
    cellSize: 3.4,
    grid: [
      "....######..",
      "..##########",
      "E.M#HHHBHHM#",
      "E.M#HHHBHHM#",
      "..##########",
      "....######..",
    ],
  },
  frigate: {
    cellSize: 6.5,
    grid: [
      ".....P########..",
      "...############.",
      "E.##############",
      "E.#HHHHHHHHHHHH#",
      "E.#HHHHBHHHHHHH#",
      "E.#HHHHHHHHHHHH#",
      "E.##############",
      "...############.",
      ".....P########..",
    ],
  },
  cruiser: {
    cellSize: 9,
    grid: [
      "......P##############..",
      "....##################.",
      "..######################",
      "E.######################",
      "E.#HHHHHHHHHHHHHHHHHHHH#",
      "E.#HHHHHHHHBHHHMHHHHHHL",
      "E.#HHHHHHHHHHHHHHHHHHHH#",
      "E.######################",
      "..######################",
      "....##################.",
      "......P##############..",
    ],
  },
  battleship: {
    cellSize: 14,
    grid: [
      ".......P###################...",
      ".....########################.",
      "...P##########################",
      ".#############################",
      "E.#HHHHHHHHHHHHHHHHHHHHHHHHHH#",
      "E.#HHHHHHHHHHHHHHHHHHHHHHHHHM",
      "E.#HHHHHHHHHHHHBHHHHHHHHHHHHL",
      "E.#HHHHHHHHHHHHHHHHHHHHHHHHHM",
      "E.#HHHHHHHHHHHHHHHHHHHHHHHHHH",
      ".#############################",
      "...P##########################",
      ".....########################.",
      ".......P###################...",
    ],
  },
  carrier: {
    cellSize: 11,
    grid: [
      "..........P#######################...",
      "......############################P..",
      "....################################P",
      "..####################################",
      "E.####################################",
      "E.#HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH#",
      "E.#HHHHHHHHHHHHHHHBHHHHHHHHHHHHHHHHHHM",
      "E.#HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH#",
      "E.####################################",
      "..####################################",
      "....################################P",
      "......############################P..",
      "..........P#######################...",
    ],
  },
};

// Cell-type → render style + module mapping. moduleKind is set for
// cells that should bind to one of the ship's destructible modules so
// the visual cell death tracks the underlying module's `dead` flag.
export const CELL_TYPES = {
  "#": { kind: "hull",      moduleKind: null, baseHp: 2 },
  "H": { kind: "hull_heavy",moduleKind: null, baseHp: 4 },
  "B": { kind: "bridge",    moduleKind: null, baseHp: 6 },
  "E": { kind: "engine",    moduleKind: null, baseHp: 2 },
  "P": { kind: "pd_mount",  moduleKind: "pd", baseHp: 3 },
  "M": { kind: "pod_mount", moduleKind: "pod", baseHp: 3 },
  "L": { kind: "laser_mount", moduleKind: "laser", baseHp: 3 },
};

/**
 * Parse a sprite grid into a cell list. Each cell carries its local
 * pixel position, kind, hp pool, and (optionally) the module-kind it's
 * visually tied to. Returns null when the class has no sprite — caller
 * is responsible for falling back to the legacy polygon hull.
 */
export function buildCells(klass) {
  const sprite = SPRITES[klass];
  if (!sprite) return null;
  const rows = sprite.grid;
  const gridH = rows.length;
  const gridW = Math.max(...rows.map((r) => r.length));
  const cs = sprite.cellSize;
  const halfX = (gridW * cs) / 2;
  const halfY = (gridH * cs) / 2;
  const cells = [];
  let moduleIdxByKind = { pd: 0, pod: 0, laser: 0 };
  for (let r = 0; r < gridH; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      if (ch === ".") continue;
      const type = CELL_TYPES[ch];
      if (!type) continue;
      const cell = {
        kind: type.kind,
        moduleKind: type.moduleKind,
        moduleIndex: type.moduleKind != null
          ? moduleIdxByKind[type.moduleKind]++
          : -1,
        // Local pixel-space position of the cell's center, with the
        // ship's origin at (0, 0).
        lx: -halfX + c * cs + cs / 2,
        ly: -halfY + r * cs + cs / 2,
        // Grid coordinates — used by the connected-component check that
        // sheds any cluster orphaned from the main hull after damage.
        row: r,
        col: c,
        hp: type.baseHp,
        hpMax: type.baseHp,
        dead: false,
      };
      cells.push(cell);
    }
  }
  return { cells, cellSize: cs, gridW, gridH, halfX, halfY };
}
