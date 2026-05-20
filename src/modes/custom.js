/**
 * Custom mode — the player picks the exact roster for both fleets via
 * the custom-game screen instead of inheriting the race default. Wins
 * on the standard arena end-condition (no enemy capitals left).
 *
 * The fleet composition is read from `game.customRoster`, which the
 * menu populates before startGame is called. Shape:
 *
 *   {
 *     alliedRace: "terran",         // overrides game.alliedRace
 *     hostileRace: "voidsworn",     // overrides game.hostileRace
 *     blue: { fighter: N, bomber: N, ... },
 *     red:  { fighter: N, bomber: N, ... },
 *   }
 *
 * Falls back to the default flow if the shape is missing.
 */

import { RACES, randomRaceKey } from "../races.js";

export const customMode = {
  key: "custom",
  label: "Custom",
  tagline: "Your roster vs. theirs",

  setup(game, { spawnRoster, promotePlayer }) {
    const cr = game.customRoster;
    if (cr) {
      if (cr.alliedRace && RACES[cr.alliedRace]) game.alliedRace = cr.alliedRace;
      game.hostileRace = (cr.hostileRace && RACES[cr.hostileRace]) ? cr.hostileRace : randomRaceKey();
    } else {
      game.hostileRace = randomRaceKey();
    }
    const rosters = cr ? { blue: cr.blue, red: cr.red } : null;
    spawnRoster(game, rosters);
    if (!game.spectating) promotePlayer(game);
  },

  tick: null,
  checkEnd: null,
};
