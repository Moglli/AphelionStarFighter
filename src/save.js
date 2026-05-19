/**
 * @file SaveStore — versioned localStorage wrapper, single source of truth for persisted state.
 *
 * Reads/writes one JSON blob under STORAGE_KEY. Migrations run on load so old
 * saves are forward-compatible. Writes are debounced to avoid hammering
 * localStorage during gameplay event bursts.
 */

import { DEFAULT_INVENTORY } from "./cosmetics.js";

const STORAGE_KEY = "aphelion.save.v1";
const CURRENT_SCHEMA_VERSION = 2;
const WRITE_DEBOUNCE_MS = 250;

/** @type {import("./types.js").SaveData} */
const DEFAULT_SAVE = Object.freeze({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  xp: 0,
  level: 1,
  softCurrency: 0,
  hardCurrency: 0,
  stats: {
    kills: 0,
    deaths: 0,
    wins: 0,
    losses: 0,
    playtimeSeconds: 0,
    damageDealt: 0,
  },
  unlockedShips: ["fighter"],
  unlockedRaces: ["terran", "reavers", "hegemony", "voidsworn"],
  equippedCosmetics: {
    hullSkin: null,
    engineTrail: null,
    weaponFX: null,
    audioPack: null,
  },
  inventory: [...DEFAULT_INVENTORY],
  entitlements: [],
  battlePass: null,
  lastLoginEpochMs: null,
  loginStreak: 0,
  daily: {
    lastSeed: null,
    lastScore: 0,
    lastResult: null,
    firstWinSeed: null,
  },
  bestScores: {
    arena: 0,
    waves: 0,
  },
  menuSelection: {
    mode: "arena",
    klass: "fighter",
    race: "terran",
    opponent: "random",
    mapSize: "medium",
  },
  settings: {
    musicVolume: 0.6,
    sfxVolume: 0.8,
    controlSensitivity: 1.0,
  },
});

/**
 * Migration registry. Each function takes the prior version's blob and
 * returns the next version's blob. Keyed by the *source* schema version.
 * Phase 0 ships with version 1, so this is empty until v2 ships.
 *
 * @type {Record<number, (data: any) => any>}
 */
const MIGRATIONS = {
  // v1 → v2: Phase 2 seeds the starter cosmetic inventory + login-streak
  // counter + daily.firstWinSeed. Empty-inventory check guards against
  // wiping a future Phase 3 player's purchased items if they hit this
  // path twice somehow.
  1: (data) => ({
    ...data,
    schemaVersion: 2,
    loginStreak: data.loginStreak || 0,
    inventory: (Array.isArray(data.inventory) && data.inventory.length > 0)
      ? data.inventory
      : [...DEFAULT_INVENTORY],
    daily: { firstWinSeed: null, ...(data.daily || {}) },
  }),
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function migrate(data) {
  let cur = data;
  while (cur.schemaVersion < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS[cur.schemaVersion];
    if (!step) {
      console.warn(
        `[save] no migration from v${cur.schemaVersion}, falling back to defaults`,
      );
      return deepClone(DEFAULT_SAVE);
    }
    cur = step(cur);
  }
  return cur;
}

function mergeWithDefaults(loaded) {
  // Shallow merge top-level keys, deep-merge known nested objects so a save
  // missing newly-introduced fields still works without an explicit migration.
  const base = deepClone(DEFAULT_SAVE);
  return {
    ...base,
    ...loaded,
    stats: { ...base.stats, ...(loaded.stats || {}) },
    equippedCosmetics: { ...base.equippedCosmetics, ...(loaded.equippedCosmetics || {}) },
    daily: { ...base.daily, ...(loaded.daily || {}) },
    bestScores: { ...base.bestScores, ...(loaded.bestScores || {}) },
    menuSelection: { ...base.menuSelection, ...(loaded.menuSelection || {}) },
    settings: { ...base.settings, ...(loaded.settings || {}) },
  };
}

class SaveStore {
  constructor() {
    /** @type {import("./types.js").SaveData} */
    this.data = deepClone(DEFAULT_SAVE);
    this._writeTimer = null;
    this._available = this._detectStorage();
    if (this._available) this._load();
  }

  _detectStorage() {
    try {
      const probe = "__aphelion_probe__";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return true;
    } catch (_err) {
      console.warn("[save] localStorage unavailable; running in volatile mode");
      return false;
    }
  }

  _load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const migrated = migrate(parsed);
      this.data = mergeWithDefaults(migrated);
    } catch (err) {
      console.error("[save] corrupt save, resetting to defaults", err);
      this.data = deepClone(DEFAULT_SAVE);
    }
  }

  /** Flush pending writes synchronously. Call before navigation away. */
  flush() {
    if (this._writeTimer !== null) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    if (!this._available) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (err) {
      console.error("[save] write failed", err);
    }
  }

  _scheduleWrite() {
    if (!this._available) return;
    if (this._writeTimer !== null) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      this.flush();
    }, WRITE_DEBOUNCE_MS);
  }

  /**
   * Apply a mutation to the save data and schedule a debounced write.
   * @param {(data: import("./types.js").SaveData) => void} fn
   */
  update(fn) {
    fn(this.data);
    this._scheduleWrite();
  }

  /**
   * Read a snapshot. Returned object is the live reference — do not mutate
   * directly; use {@link SaveStore.update} so writes are scheduled.
   * @returns {import("./types.js").SaveData}
   */
  get() {
    return this.data;
  }

  /** Wipe to defaults. Used by settings → reset progress. */
  reset() {
    this.data = deepClone(DEFAULT_SAVE);
    this.flush();
  }
}

export const saveStore = new SaveStore();

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => saveStore.flush());
  window.addEventListener("beforeunload", () => saveStore.flush());
}
