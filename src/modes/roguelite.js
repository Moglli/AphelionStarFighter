/**
 * Roguelite "Frontier" mode — the procedural campaign. The actual
 * encounter graph + run state lives in src/roguelite.js; this file
 * handles per-match setup AND the Act 5 boss phase reinforcements.
 *
 * game.modeConfig (set by startGame) carries the run-built bundle:
 *   { blue, red, hostileRace, battleMode, capitalsManifest,
 *     playerSpecOverride, run, node }
 *
 * battleMode === "command" puts the player in admiral mode (no piloted
 * fighter, spectator camera + directive panel). Otherwise the player
 * spawns as a fighter via promotePlayer.
 *
 * Apheliotrope (Act 5 boss) is a phased fight: when the boss capital's
 * hull crosses 66% and 33%, a wave of reinforcements warps in from the
 * red spawn zone. Phase state lives on `game.bossPhases` so the
 * `tick` hook can edge-detect each threshold once per match.
 */

import { defaultDirectives } from "./admiral.js";
import { createShip } from "../ship.js";

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
    } else {
      // Fly mode: standard player-pilot loop. spawnRoster auto-calls
      // promotePlayer at the end when game.spectating is false.
      spawnRoster(game, { blue: cfg.blue, red: cfg.red });
    }

    // Act 5 boss: mark the Apheliotrope (largest enemy capital) for
    // phase tracking. Tick hook checks hull thresholds and spawns
    // reinforcement waves at 66% / 33%.
    const run = cfg.run;
    const node = cfg.node;
    if (run && run.act === 5 && node && node.type === "boss") {
      const boss = pickBossShip(game);
      if (boss) {
        boss.isBoss = true;
        game.bossPhases = {
          bossId: boss.id,
          // Edge-detect: only fire each wave once even though hp
          // hovers around the threshold for many ticks.
          phasedAt: { p1: false, p2: false },
        };
      }
    }
  },

  tick(game, dt) {
    if (!game.bossPhases) return;
    const phases = game.bossPhases;
    const boss = game.ships.find((s) => s.id === phases.bossId);
    if (!boss || boss.dead) {
      // Boss is gone — phase tracking irrelevant. Clear so we don't
      // keep scanning every tick.
      game.bossPhases = null;
      return;
    }
    const hpFrac = boss.hpMax > 0 ? boss.hp / boss.hpMax : 1;
    if (!phases.phasedAt.p1 && hpFrac <= 0.66) {
      phases.phasedAt.p1 = true;
      spawnBossWave(game, "phase1");
    }
    if (!phases.phasedAt.p2 && hpFrac <= 0.33) {
      phases.phasedAt.p2 = true;
      spawnBossWave(game, "phase2");
    }
  },
  checkEnd: null,
};

// Pick the named-boss ship: prefer carrier (the Apheliotrope is a
// flagship-class hull), fall back to battleship, then any largest
// enemy ship by hull radius. Spawnup order is preserved by
// game.ships.push, so the first match is the run-builder's canonical
// capital for that class.
function pickBossShip(game) {
  let carrier = null, battleship = null, biggest = null;
  for (const s of game.ships) {
    if (s.dead || s.side !== "red") continue;
    if (s.klass === "carrier" && !carrier) carrier = s;
    if (s.klass === "battleship" && !battleship) battleship = s;
    if (!biggest || (s.spec && s.spec.radius || 0) > (biggest.spec && biggest.spec.radius || 0)) {
      biggest = s;
    }
  }
  return carrier || battleship || biggest;
}

// Phase reinforcements for the Apheliotrope fight. Compositions are
// designed to feel like the War-Queen pulling in escorts as her hull
// degrades — phase 1 is a screen of frigates, phase 2 is heavier
// shock troops (cruiser + fighter wing).
const PHASE_WAVES = {
  phase1: [{ klass: "frigate", count: 2 }, { klass: "fighter", count: 4 }],
  phase2: [{ klass: "cruiser", count: 1 }, { klass: "fighter", count: 6 }, { klass: "bomber", count: 2 }],
};

function spawnBossWave(game, phaseKey) {
  const wave = PHASE_WAVES[phaseKey];
  if (!wave) return;
  const z = game.arena && game.arena.spawn && game.arena.spawn.red;
  if (!z) return;
  const race = game.hostileRace || "terran";
  // Heading faces toward the allied side (PI for red).
  const facing = Math.PI;
  for (const entry of wave) {
    for (let i = 0; i < entry.count; i++) {
      // Scatter around the spawn zone so the wave reads as a fresh
      // arrival, not stacked on a single point.
      const ang = Math.random() * Math.PI * 2;
      const r = 80 + Math.random() * 140;
      const pos = { x: z.x + Math.cos(ang) * r, y: z.y + Math.sin(ang) * r };
      const ship = createShip({
        klass: entry.klass,
        race,
        side: "red",
        pos,
        heading: facing + (Math.random() - 0.5) * 0.3,
        controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
      });
      game.ships.push(ship);
    }
  }
}
