import { arenaMode } from "./arena.js";
import { wavesMode } from "./waves.js";
import { dailyMode } from "./daily.js";
import { customMode } from "./custom.js";

export const MODES = {
  arena: arenaMode,
  waves: wavesMode,
  daily: dailyMode,
  custom: customMode,
};

// Custom is intentionally NOT in MODE_KEYS — it's reached via its own
// menu screen, not the mode chip row.
export const MODE_KEYS = ["arena", "waves", "daily"];
export const DEFAULT_MODE = "arena";

export { arenaMode, wavesMode, dailyMode, customMode };
export { todaySeed } from "./daily.js";
