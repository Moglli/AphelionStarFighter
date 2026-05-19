/**
 * @file Rally points — strategic command layer for friendly ships.
 *
 * Two-tap flow on the minimap:
 *   tap 1 → SOURCE.  Highlights a circular selection area in the world.
 *   tap 2 → DESTINATION.  All friendly non-player ships inside the source
 *           area receive a rally order to the destination and ignore
 *           normal AI until they arrive.
 *
 * State machine is tiny:
 *   idle       → pendingSource
 *   pendingSource → idle (timeout, off-minimap cancel, or order issued)
 *
 * Source selection auto-times-out after PENDING_TIMEOUT seconds so a
 * stray minimap tap doesn't sit waiting forever.
 */

import { ARENA } from "./arena.js";
import { events } from "./events.js";

const PENDING_TIMEOUT = 5.0;
const ARRIVAL_RADIUS = 220;       // ships clear their rally when within this
const ORDER_LINE_TTL = 4.0;       // how long the rally line shows on the minimap

/** Source-area radius in world coordinates. Scales gently with arena width. */
export function sourceRadius() {
  return Math.max(800, ARENA.width * 0.15);
}

class RallyManager {
  constructor() {
    this.pending = null;      // { x, y, age }
    /** @type {Array<{ source: {x,y}, dest: {x,y}, age: number, count: number }>} */
    this.recentOrders = [];
  }

  /** Tick the timers. Called from game.js update. */
  update(dt) {
    if (this.pending) {
      this.pending.age += dt;
      if (this.pending.age >= PENDING_TIMEOUT) this.pending = null;
    }
    for (const o of this.recentOrders) o.age += dt;
    if (this.recentOrders.length > 0) {
      this.recentOrders = this.recentOrders.filter((o) => o.age < ORDER_LINE_TTL);
    }
  }

  /** Cancel the pending source selection — used when the user taps off-map. */
  cancel() {
    if (this.pending) {
      this.pending = null;
      events.emit("uiClick", { source: "menu" });
    }
  }

  /**
   * Register a tap at world-space (x, y). First tap stores source, second
   * commits the order. Returns one of:
   *   "source"  — pending source set
   *   "order"   — order issued (game.ships needed)
   *   "cancel"  — second tap on the source area is treated as a fresh source
   */
  tap(world, x, y) {
    if (!this.pending) {
      this.pending = { x, y, age: 0 };
      events.emit("uiClick", { source: "menu" });
      return "source";
    }
    // Treat a 2nd tap very close to the source as a re-pin rather than a
    // zero-length order.
    const dx = x - this.pending.x;
    const dy = y - this.pending.y;
    if (dx * dx + dy * dy < (sourceRadius() * 0.25) ** 2) {
      this.pending = { x, y, age: 0 };
      return "cancel";
    }
    const source = this.pending;
    this.pending = null;
    const count = this._issue(world, source, { x, y });
    this.recentOrders.push({
      source: { x: source.x, y: source.y },
      dest: { x, y },
      age: 0,
      count,
    });
    if (this.recentOrders.length > 4) this.recentOrders.shift();
    events.emit("uiClick", { source: "menu" });
    events.emit("rallyOrdered", { source: { x: source.x, y: source.y }, dest: { x, y }, count });
    return "order";
  }

  _issue(world, source, dest) {
    const r = sourceRadius();
    const r2 = r * r;
    let count = 0;
    for (const s of world.ships) {
      if (s.dead || s.isPlayer || s.side !== "blue") continue;
      const dx = s.pos.x - source.x;
      const dy = s.pos.y - source.y;
      if (dx * dx + dy * dy > r2) continue;
      s.rallyTarget = { x: dest.x, y: dest.y };
      count += 1;
    }
    return count;
  }

  /** True if the ship is close enough to its rally to clear the order. */
  static arrived(ship) {
    const t = ship.rallyTarget;
    if (!t) return true;
    const dx = ship.pos.x - t.x;
    const dy = ship.pos.y - t.y;
    return dx * dx + dy * dy <= ARRIVAL_RADIUS * ARRIVAL_RADIUS;
  }
}

export const rally = new RallyManager();

if (typeof window !== "undefined") {
  window.rally = rally;
}
