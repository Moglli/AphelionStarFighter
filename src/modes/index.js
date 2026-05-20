import { arenaMode } from "./arena.js";
import { wavesMode } from "./waves.js";
import { dailyMode } from "./daily.js";
import { customMode } from "./custom.js";
import { admiralMode } from "./admiral.js";
import { rogueliteMode } from "./roguelite.js";

export const MODES = {
  arena: arenaMode,
  waves: wavesMode,
  daily: dailyMode,
  custom: customMode,
  admiral: admiralMode,
  roguelite: rogueliteMode,
};

// Custom + Admiral + Roguelite are intentionally NOT in MODE_KEYS —
// they're reached via their own menu paths (overlays), not the mode
// chip row.
export const MODE_KEYS = ["arena", "waves", "daily"];
export const DEFAULT_MODE = "arena";

export { arenaMode, wavesMode, dailyMode, customMode, admiralMode, rogueliteMode };
export { todaySeed } from "./daily.js";
