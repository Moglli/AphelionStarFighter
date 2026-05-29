/**
 * @file ship-icons.js — shared inline-SVG ship-class silhouettes.
 *
 * Pulls the unit-space hull polygons from src/ship.js and renders them
 * as small SVG icons so HUD chips, Custom Match cells, target panels,
 * and any other UI surface that used letter glyphs ("F", "BB") can now
 * show actual ship silhouettes.
 *
 * All icons render the Terran polygon (the player faction). Race-
 * specific icons could be added by accepting a race param if needed.
 */

import { getHull } from "./ship.js";

const CLASS_ORDER = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier", "station"];

/**
 * Inline SVG string for a class silhouette. The polygon is scaled so
 * the largest extent fills the viewBox with a small margin. Default
 * stroke + fill respect `currentColor` so CSS can tint the icon.
 *
 * @param {string} klass — fighter / bomber / frigate / cruiser / battleship / carrier / station
 * @param {{ size?: number, fill?: string, stroke?: string, race?: string }} [opts]
 * @returns {string} SVG markup ready to drop into innerHTML
 */
export function classIconSvg(klass, opts = {}) {
  const race = opts.race || "terran";
  const poly = getHull(race, klass);
  if (!poly || poly.length < 3) return "";
  const size = opts.size || 24;
  const fill = opts.fill || "currentColor";
  const stroke = opts.stroke || "currentColor";
  // Bounding box of the polygon — used to centre + scale.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX, h = maxY - minY;
  const dim = Math.max(w, h) || 1;
  // Fit the polygon into a viewBox of (size × size) with 10% padding.
  const pad = 0.10;
  const scale = (1 - 2 * pad) * size / dim;
  const cx = size / 2 - ((minX + maxX) / 2) * scale;
  const cy = size / 2 - ((minY + maxY) / 2) * scale;
  const pts = poly.map(([x, y]) => `${(x * scale + cx).toFixed(2)},${(y * scale + cy).toFixed(2)}`).join(" ");
  return `<svg class="class-icon class-icon-${klass}" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><polygon points="${pts}" fill="${fill}" fill-opacity="0.35" stroke="${stroke}" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
}

/**
 * Friendly short label per class — used where the icon needs a textual
 * supplement (screen readers, narrow contexts).
 */
export const CLASS_SHORT_LABELS = {
  fighter: "Fighter", bomber: "Bomber", frigate: "Frigate",
  cruiser: "Cruiser", battleship: "Battleship", carrier: "Carrier", station: "Station",
};

export { CLASS_ORDER };
