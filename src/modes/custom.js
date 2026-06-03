/**
 * Custom mode — the player picks the exact roster for both fleets via
 * the custom-game screen instead of inheriting the race default. Wins
 * on the standard arena end-condition (no enemy capitals left).
 *
 * Two roster sources, checked in order:
 *
 *   1. `game.scenario` — a full Scenario record (DEV_FEATURES_PLAN.md
 *      Phase 1). Carries per-team races, per-ship counts, per-ship
 *      spawn hints + orders + designId, plus a player-team selection.
 *      Authored in the Battle Designer or imported from chat.
 *
 *   2. `game.customRoster` — the legacy custom-screen shape:
 *        {
 *          alliedRace: "terran",
 *          hostileRace: "voidsworn",
 *          blue: { fighter: N, bomber: N, ... },
 *          red:  { fighter: N, bomber: N, ... },
 *          blueTeams: [{ race, counts }],
 *          redTeams:  [{ race, counts }],
 *        }
 *
 * Scenario wins when present; customRoster is the fallback. Falling
 * through both lands on the default race-roster path inside spawnRoster.
 */

import { RACES, randomRaceKey } from "../races.js";

export const customMode = {
  key: "custom",
  label: "Custom",
  tagline: "Your roster vs. theirs",

  setup(game, { spawnRoster, promotePlayer }) {
    if (game.scenario) {
      return setupFromScenario(game, { spawnRoster, promotePlayer });
    }

    const cr = game.customRoster;
    if (cr) {
      if (cr.alliedRace && RACES[cr.alliedRace]) game.alliedRace = cr.alliedRace;
      game.hostileRace = (cr.hostileRace && RACES[cr.hostileRace]) ? cr.hostileRace : randomRaceKey();
    } else {
      game.hostileRace = randomRaceKey();
    }
    // Forward both the multi-faction shape and the legacy single-race
    // shape — spawnRoster prefers `blueTeams`/`redTeams` if present
    // and falls back to `blue`/`red`.
    const rosters = cr ? {
      blue: cr.blue, red: cr.red,
      blueTeams: cr.blueTeams,
      redTeams: cr.redTeams,
    } : null;
    spawnRoster(game, rosters);
    if (!game.spectating) promotePlayer(game);
  },

  tick: null,
  checkEnd: null,
};

// Translate a Scenario into spawnRoster's input shape. Each scenario
// team becomes an entry in `blueTeams`/`redTeams` with `race` + `counts`
// (legacy shape) PLUS a `rows` array carrying per-row spawn + orders +
// designId for spawnRoster to read. Player-team mapping flips the
// allied/hostile race fields so promotePlayer spawns into the right side.
function setupFromScenario(game, { spawnRoster, promotePlayer }) {
  const sc = game.scenario;
  const playerTeam = sc.playerTeam === "red" ? "red" : "blue";

  // Pick a primary race per side for game.alliedRace / hostileRace (used
  // by station spawns, captain comms, paint defaults). First team wins;
  // empty side → terran fallback.
  const primaryBlue = (sc.blueTeams[0] && sc.blueTeams[0].race) || "terran";
  const primaryRed = (sc.redTeams[0] && sc.redTeams[0].race) || "terran";

  if (playerTeam === "blue") {
    game.alliedRace = RACES[primaryBlue] ? primaryBlue : "terran";
    game.hostileRace = RACES[primaryRed] ? primaryRed : randomRaceKey();
  } else {
    // Player is on red. The engine still calls "blue" the player side
    // everywhere (camera, controllers, applyShipOrders) — for a v1 red-
    // player scenario the simplest path is to map the scenario's "red"
    // team to engine-blue and vice versa. Future-proof: log + flip.
    game.alliedRace = RACES[primaryRed] ? primaryRed : "terran";
    game.hostileRace = RACES[primaryBlue] ? primaryBlue : randomRaceKey();
  }

  const blueTeams = teamsForSide(sc, playerTeam === "blue" ? "blueTeams" : "redTeams");
  const redTeams  = teamsForSide(sc, playerTeam === "blue" ? "redTeams"  : "blueTeams");

  spawnRoster(game, { blueTeams, redTeams });
  if (!game.spectating) promotePlayer(game);
}

function teamsForSide(scenario, key) {
  const teams = scenario[key] || [];
  return teams.map((t) => {
    const counts = {};
    for (const row of t.ships || []) {
      counts[row.klass] = (counts[row.klass] || 0) + row.count;
    }
    return {
      race: t.race,
      counts,
      // Per-row metadata — spawnRoster reads ROWS to stamp orders +
      // optional spawn-position overrides. Indexing alongside `counts`
      // is fine because spawnRoster walks the same klass→count list.
      rows: t.ships || [],
    };
  });
}
