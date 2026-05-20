/**
 * Admiral mode — the player commands the allied (blue) fleet rather
 * than piloting a fighter. No player ship is spawned; the camera
 * defaults to spectate-style free pan over the battlefield. A
 * command panel during gameplay sets per-class directives that the
 * AI honors only for the blue side:
 *
 *   posture:  hold  → ships return to the allied fleet centroid,
 *                     hold fire
 *             free  → standard per-class AI
 *             press → aim overridden toward the enemy fleet centroid,
 *                     normal firing
 *   missiles: hold  → updateMissilePodFire skips for this class
 *             on    → normal pod firing
 *
 * Defaults: every class starts on "free" / "on" so the match plays
 * out like Open Battle until the admiral starts issuing orders.
 *
 * Uses the standard arena end-condition (blue wins when no enemy
 * capitals remain; loses when no allied capitals remain).
 */

import { RACES, randomRaceKey } from "../races.js";

export const ADMIRAL_CLASSES = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier"];

export function defaultDirectives() {
  const out = {};
  for (const k of ADMIRAL_CLASSES) {
    out[k] = { posture: "free", missiles: "on" };
  }
  return out;
}

export const admiralMode = {
  key: "admiral",
  label: "Admiral",
  tagline: "Command, don't pilot",

  setup(game, { spawnRoster }) {
    game.hostileRace = RACES[game.opponentRace] ? game.opponentRace : randomRaceKey();
    // Player ship never spawns — admiral commands from a free-pan
    // spectator camera. Match keeps the standard end-condition.
    game.spectating = true;
    game.directives = defaultDirectives();
    game.admiralMode = true;
    spawnRoster(game);
    // Initial camera at the centre of the allied spawn zone — gives
    // the admiral a useful starting view instead of dumping them at
    // origin.
    if (game.arena && game.arena.spawn && game.arena.spawn.blue) {
      const z = game.arena.spawn.blue;
      game.spectateCamera = { x: z.x, y: z.y, locked: false };
    }
  },

  tick: null,
  checkEnd: null,
};
