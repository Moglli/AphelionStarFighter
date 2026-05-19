/**
 * Arena mode — the original match. Two full rosters fight; the side with
 * any non-player ships still alive wins.
 *
 * Mode descriptors expose three hooks. All are optional; `null` falls back
 * to the default arena behavior in game.js.
 *
 * - `setup(game, helpers)` — runs once at match start. Picks the hostile
 *   race, spawns rosters, slots the player into the chosen class.
 * - `tick(game, dt)` — runs every frame before AI. Use to spawn over
 *   time (waves), tick mode timers, etc.
 * - `checkEnd(game)` — returns `"blue"` / `"red"` to end the match, or
 *   `null` to keep playing. Called every tick.
 */

import { RACES, randomRaceKey } from "../races.js";

export const arenaMode = {
  key: "arena",
  label: "Arena",
  tagline: "Full fleet vs. fleet",

  setup(game, { spawnRoster, promotePlayer }) {
    // Honor the player's pick from the start menu. "random" (or any
    // unknown key) falls back to a random choice so the silhouettes
    // still vary across matches.
    game.hostileRace = RACES[game.opponentRace] ? game.opponentRace : randomRaceKey();
    spawnRoster(game);
    if (!game.spectating) promotePlayer(game, game.playerKlass);
  },

  // No per-tick logic — arena uses the default end-condition check.
  tick: null,
  checkEnd: null,
};
