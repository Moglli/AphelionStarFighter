import { arenaMode } from "./arena.js";
import { wavesMode } from "./waves.js";
import { dailyMode } from "./daily.js";
import { customMode } from "./custom.js";
import { admiralMode } from "./admiral.js";
import { rogueliteMode } from "./roguelite.js";
import { frontierMode } from "./frontier.js";

export const MODES = {
  arena: arenaMode,
  waves: wavesMode,
  daily: dailyMode,
  custom: customMode,
  admiral: admiralMode,
  roguelite: rogueliteMode,
  // New War-based Frontier (FRONTIER_FUTURE.md). Built alongside the
  // legacy `roguelite` mode; menu route stays on roguelite until this
  // is playable. Reached programmatically via frontier/mission.js.
  frontier: frontierMode,
};

// Custom + Admiral + Roguelite + Frontier are intentionally NOT in
// MODE_KEYS — they're reached via their own menu paths (overlays), not
// the mode chip row.
export const MODE_KEYS = ["arena", "waves", "daily"];
export const DEFAULT_MODE = "arena";

export { arenaMode, wavesMode, dailyMode, customMode, admiralMode, rogueliteMode, frontierMode };
export { todaySeed } from "./daily.js";
