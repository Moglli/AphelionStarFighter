/**
 * Custom mode — the player picks the exact roster for both fleets via
 * the custom-game screen instead of inheriting the race default. Wins
 * on the standard arena end-condition (no enemy capitals left).
 *
 * The fleet composition is read from `game.customRoster`, which is set
 * by the menu before startGame is called. Falls back to the allied
 * race's default roster if it's missing for some reason.
 */

import { RACES, randomRaceKey } from "../races.js";

export const customMode = {
  key: "custom",
  label: "Custom",
  tagline: "Your roster vs. theirs",

  setup(game, { spawnRoster, promotePlayer }) {
    const cr = game.customRoster;
    game.hostileRace = (cr && cr.hostileRace) || randomRaceKey();
    const rosters = cr
      ? { blue: cr.blue, red: cr.red }
      : null;
    spawnRoster(game, rosters);
    if (!game.spectating) promotePlayer(game, game.playerKlass);
  },

  tick: null,
  checkEnd: null,
};
