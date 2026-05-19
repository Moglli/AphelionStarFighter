/**
 * @file Tiny pub/sub event bus.
 *
 * Decouples gameplay (which emits domain events like "enemyKilled") from
 * progression / missions / analytics (which subscribe). Synchronous dispatch:
 * subscribers run on the same tick the event is emitted. Keep handlers cheap.
 *
 * Usage:
 *   import { events } from "./events.js";
 *   const off = events.on("enemyKilled", (payload) => { ... });
 *   events.emit("enemyKilled", { ship, killer });
 *   off(); // unsubscribe
 */

class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   * @template {keyof import("./types.js").EventPayloads} K
   * @param {K} eventName
   * @param {(payload: import("./types.js").EventPayloads[K]) => void} handler
   * @returns {() => void}
   */
  on(eventName, handler) {
    let set = this._listeners.get(eventName);
    if (!set) {
      set = new Set();
      this._listeners.set(eventName, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /**
   * Subscribe once. Auto-removes after first dispatch.
   * @template {keyof import("./types.js").EventPayloads} K
   * @param {K} eventName
   * @param {(payload: import("./types.js").EventPayloads[K]) => void} handler
   */
  once(eventName, handler) {
    const off = this.on(eventName, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  /**
   * Emit an event. Handler errors are caught so one bad subscriber can't
   * break the dispatch loop.
   * @template {keyof import("./types.js").EventPayloads} K
   * @param {K} eventName
   * @param {import("./types.js").EventPayloads[K]} payload
   */
  emit(eventName, payload) {
    const set = this._listeners.get(eventName);
    if (!set || set.size === 0) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[events] handler for "${eventName}" threw`, err);
      }
    }
  }

  /** Remove every listener. Test/teardown helper. */
  clear() {
    this._listeners.clear();
  }
}

export const events = new EventBus();

if (typeof window !== "undefined") {
  // Expose for console smoke testing alongside `window.game`.
  window.events = events;
}
