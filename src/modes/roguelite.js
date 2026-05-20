/**
 * Roguelite "Frontier" mode — the procedural campaign. The actual
 * encounter graph + run state lives in src/roguelite.js; this file
 * just handles the per-match setup hook.
 *
 * game.modeConfig (set by startGame) carries the run-built bundle:
 *   { blue, red, hostileRace, battleMode, capitalsManifest,
 *     playerSpecOverride, run, node }
 *
 * battleMode === "command" puts the player in admiral mode (no piloted
 * fighter, spectator camera + directive panel). Otherwise the player
 * spawns as a fighter via promotePlayer.
 */

import { defaultDirectives } from "./admiral.js";

export const rogueliteMode = {
  key: "roguelite",
  label: "Frontier",
  tagline: "Procedural war",

  setup(game, { spawnRoster, promotePlayer }) {
    const cfg = game.modeConfig;
    if (!cfg) {
      // Defensive — no run config provided. Fall back to a default
      // skirmish using the race-defined rosters.
      spawnRoster(game);
      return;
    }

    // Override the hostile race so the enemy fleet matches the node's
    // assigned faction (the random race rolled in startGame is ignored).
    if (cfg.hostileRace) game.hostileRace = cfg.hostileRace;

    // Stash the run context — spawnRoster reads game.modeConfig
    // directly for the capitalsManifest. Kept on rogueliteContext as a
    // future-proof scratch space (e.g. when boons inject per-class
    // patches at spawn-time).
    game.rogueliteContext = cfg;

    // Command mode: admiral posture, no player ship spawn, free-pan
    // camera. Same control surface as the standalone Admiral mode.
    if (cfg.battleMode === "command") {
      game.spectating = true;
      game.admiralMode = true;
      game.directives = defaultDirectives();
      spawnRoster(game, { blue: cfg.blue, red: cfg.red });
      if (game.arena && game.arena.spawn && game.arena.spawn.blue) {
        const z = game.arena.spawn.blue;
        game.spectateCamera = { x: z.x, y: z.y, locked: false };
      }
      return;
    }

    // Fly mode: standard player-pilot loop. spawnRoster auto-calls
    // promotePlayer at the end when game.spectating is false.
    spawnRoster(game, { blue: cfg.blue, red: cfg.red });
  },

  tick: null,
  checkEnd: null,
};
