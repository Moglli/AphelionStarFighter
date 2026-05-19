import { arenaMode } from "./arena.js";
import { wavesMode } from "./waves.js";
import { dailyMode } from "./daily.js";

export const MODES = {
  arena: arenaMode,
  waves: wavesMode,
  daily: dailyMode,
};

export const MODE_KEYS = ["arena", "waves", "daily"];
export const DEFAULT_MODE = "arena";

export { arenaMode, wavesMode, dailyMode };
export { todaySeed } from "./daily.js";
