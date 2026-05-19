/**
 * Daily mode — one seeded match per UTC day, with hostile race and map
 * size derived from the date string. Save state tracks the date of the
 * last attempt; selecting daily mode after already playing today shows
 * a "come back tomorrow" overlay handled in hud.js.
 *
 * Spawn placement is still non-deterministic — only the starting
 * conditions (hostile race + map) are fixed. That's enough to make a
 * leaderboard comparable without retrofitting a seeded RNG into every
 * gameplay subsystem.
 */

import { RACE_KEYS } from "../races.js";
import { arenaMode } from "./arena.js";
import { setArenaSize } from "../arena.js";

export function todaySeed() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Simple deterministic hash → 32-bit unsigned int.
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}

// Map sizes that the daily can roll. Mirrors MAP_SIZES in arena.js without
// importing it (to avoid the menu coupling).
const DAILY_MAP_SIZES = [
  { mapW: 7000,  mapH: 5000 },
  { mapW: 11000, mapH: 7800 },
];

export const dailyMode = {
  key: "daily",
  label: "Daily",
  tagline: "One seeded match per day",

  setup(game, helpers) {
    const seed = todaySeed();
    const h = hash(seed);
    const race = RACE_KEYS[h % RACE_KEYS.length];
    const sizePick = DAILY_MAP_SIZES[(h >> 8) % DAILY_MAP_SIZES.length];
    setArenaSize(sizePick.mapW, sizePick.mapH);
    game.hostileRace = race;
    helpers.spawnRoster(game);
    if (!game.spectating) helpers.promotePlayer(game, game.playerKlass);
    game.modeState = { seed };
  },

  // Daily uses arena's default end-condition check.
  tick: null,
  checkEnd: arenaMode.checkEnd,
};
