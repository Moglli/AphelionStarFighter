/**
 * Waves mode — endless survival. The player can bring a custom-built
 * allied fleet (see CustomGameScreen → "TAKE INTO WAVES"); without one
 * they fly solo. The hostile side has none at start, but waves of enemies
 * spawn on a timer with escalating composition. Match ends on player
 * death (no respawn).
 *
 * Wave N composition (cumulative):
 *   fighters    : 2 + N
 *   bombers     : N >= 3 ? floor(N / 2)  : 0
 *   frigates    : N >= 5 ? floor(N / 4)  : 0
 *   cruisers    : N >= 8 ? floor(N / 6)  : 0
 *   battleships : N >= 12 ? floor(N / 10) : 0
 *
 * Spawn cadence: wave starts as soon as fewer than 3 hostiles remain, or
 * 12 s after the previous wave — whichever comes first.
 */

import { ARENA, randomSpawnPos } from "../arena.js";
import { createShip } from "../ship.js";
import { RACE_KEYS, RACES } from "../races.js";
import { events } from "../events.js";

const WAVE_INTERVAL_MAX = 12.0;
const ENEMY_REMAINING_THRESHOLD = 3;

function rosterHasShips(r) {
  if (!r) return false;
  for (const k of Object.keys(r)) if ((r[k] | 0) > 0) return true;
  return false;
}

export const wavesMode = {
  key: "waves",
  label: "Waves",
  tagline: "Endless survival — one life",

  setup(game, { spawnRoster, promotePlayer }) {
    // Pick a random hostile race so the silhouettes vary.
    game.hostileRace = RACE_KEYS[Math.floor(Math.random() * RACE_KEYS.length)];
    // If the player brought a custom-built fleet, spawn it as the allied
    // side first so promotePlayer can slot the player into one of those
    // hulls instead of creating a lone ship.
    const cr = game.customRoster;
    if (cr && rosterHasShips(cr.blue)) {
      spawnRoster(game, { blue: cr.blue }, { onlySides: ["blue"] });
    }
    promotePlayer(game, game.playerKlass);
    game.modeState = {
      wave: 0,
      nextWaveTimer: 1.5, // grace period before wave 1
      survivedWaves: 0,
    };
  },

  tick(game, dt) {
    const st = game.modeState;
    if (!st) return;
    st.nextWaveTimer -= dt;

    const hostilesAlive = game.ships.filter((s) => s.side === "red" && !s.dead).length;
    const trigger = st.nextWaveTimer <= 0
                 || (st.wave > 0 && hostilesAlive < ENEMY_REMAINING_THRESHOLD);

    if (trigger) {
      st.wave += 1;
      if (st.wave > 1) st.survivedWaves = st.wave - 1;
      spawnWave(game, st.wave);
      st.nextWaveTimer = WAVE_INTERVAL_MAX;
    }
  },

  checkEnd(game) {
    // Player gone → loss. No respawns in waves.
    const player = game.ships.find((s) => s.isPlayer);
    if (!player || player.dead) return "red";
    return null;
  },
};

function spawnWave(game, wave) {
  const counts = {
    fighter: 2 + wave,
    bomber:    wave >= 3  ? Math.floor(wave / 2)  : 0,
    frigate:   wave >= 5  ? Math.floor(wave / 4)  : 0,
    cruiser:   wave >= 8  ? Math.floor(wave / 6)  : 0,
    battleship: wave >= 12 ? Math.floor(wave / 10) : 0,
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  events.emit("waveStarted", { wave, spawnCount: total });

  for (const [klass, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i++) {
      const pos = randomSpawnPos(ARENA.spawn.red);
      const ship = createShip({
        klass,
        race: game.hostileRace,
        side: "red",
        pos,
        heading: Math.PI,
        controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
      });
      game.ships.push(ship);
    }
  }
}
