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
import { rebalanceWings, applyWingCommanderEffect, applyCommanderPerks } from "../roguelite.js";

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
    // Blue roster: prefer the multi-race blueTeams (native + captured
    // ships keeping their own race) when present; fall back to the
    // single-race blue roster for older configs.
    const blueRosterArg = (cfg.blueTeams && cfg.blueTeams.length > 0)
      ? { blueTeams: cfg.blueTeams, red: cfg.red }
      : { blue: cfg.blue, red: cfg.red };
    if (cfg.battleMode === "command") {
      game.spectating = true;
      game.admiralMode = true;
      game.directives = defaultDirectives();
      spawnRoster(game, blueRosterArg);
      if (game.arena && game.arena.spawn && game.arena.spawn.blue) {
        const z = game.arena.spawn.blue;
        game.spectateCamera = { x: z.x, y: z.y, locked: false };
      }
    } else {
      // Fly mode: standard player-pilot loop. spawnRoster auto-calls
      // promotePlayer at the end when game.spectating is false.
      // Also init directives in fly mode so Battle Plan wing commands
      // (run.fighterWingCommand / bomberWingCommand) carry through to
      // applyAdmiralPosture in ai.js.
      game.directives = defaultDirectives();
      spawnRoster(game, blueRosterArg);
    }
    // Apply Battle Plan wing commands (Frontier pre-flight orders).
    // Legacy class-wide single command (still supported for old saves):
    const planRun = cfg.run;
    if (planRun && game.directives) {
      if (planRun.fighterWingCommand) game.directives.fighter.posture = planRun.fighterWingCommand;
      if (planRun.bomberWingCommand)  game.directives.bomber.posture  = planRun.bomberWingCommand;
    }
    // Multi-wing assignment — distribute spawned blue fighters/bombers
    // into the run's wings in order, stamping per-ship `wingCommand`.
    // Each wing carries a command shape:
    //   { kind: "free" | "hold" | "press" | "defend-capital" | "target-class",
    //     target?: capital.instanceId | enemy klass string }
    // free/hold/press → applyAdmiralPosture in ai.js
    // defend-capital → ship.escortOf set, existing escort leash logic
    // target-class   → ship.wingCommand drives target preference in updateAI
    if (planRun) {
      assignWingsToSpawned(game, planRun, "fighter");
      assignWingsToSpawned(game, planRun, "bomber");
    }

    // Phase 1 — allied reinforcements from friendly factions. Spawned
    // AFTER wing assignment (so they're not pulled into native wings)
    // and tagged `alliedReinforcement` so the post-battle recount
    // doesn't fold them into the persistent fleet. They fly default AI.
    if (cfg.reinforcements && cfg.reinforcements.length > 0) {
      spawnAlliedReinforcements(game, cfg.reinforcements);
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

// Allied reinforcements (Phase 1 — faction relations). Friendly
// factions send ships that warp in on the BLUE side. Tagged
// `alliedReinforcement` so captureBattleOutcome's recount skips them
// (they're one-battle support, not a permanent fleet asset). They
// keep their faction race (sprite + spec) and fly default AI. Spawned
// at the blue zone after the main roster + wing assignment.
function spawnAlliedReinforcements(game, reinforcements) {
  const z = game.arena && game.arena.spawn && game.arena.spawn.blue;
  if (!z) return;
  const facing = 0; // blue faces toward the enemy (0)
  for (const r of reinforcements) {
    const race = r.race || "terran";
    const entries = [
      ["fighter", r.fighter || 0],
      ["bomber", r.bomber || 0],
      ["frigate", r.frigate || 0],
    ];
    for (const [klass, count] of entries) {
      for (let i = 0; i < count; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rad = 90 + Math.random() * 160;
        const pos = { x: z.x + Math.cos(ang) * rad, y: z.y + Math.sin(ang) * rad };
        const ship = createShip({
          klass,
          race,
          side: "blue",
          pos,
          heading: facing + (Math.random() - 0.5) * 0.3,
          controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
          boons: game.activeBoons,
          fleetTraits: game.activeFleetTraits,
        });
        // Tag so the post-battle recount treats them as temporary —
        // they don't join run.smallCraft or run.capturedCraft.
        ship.alliedReinforcement = true;
        game.ships.push(ship);
      }
    }
  }
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

// Distribute spawned blue fighters/bombers into wings per the run's
// pre-flight plan. Walks game.ships in spawn order, pulling `wing.count`
// ships per wing and stamping `ship.wingCommand`. Defend-capital
// commands also stamp `ship.escortOf` so the existing escort leash in
// ai.js#updateAI picks the ship up as a screen for that capital
// (overriding the default escort assignment from assignEscortPacks).
function assignWingsToSpawned(game, run, craft) {
  // Rebalance first so a wing's `count` doesn't exceed the actual
  // spawned-craft population (e.g. resupply bought more fighters since
  // the wings were last assigned).
  rebalanceWings(run, craft);
  const wings = (craft === "fighter") ? run.fighterWings : run.bomberWings;
  if (!wings || wings.length === 0) return;
  // Collect spawned blue ships of this klass in stable spawn order.
  // Excludes the player (promotePlayer recycles a spawned fighter for
  // the player — the player's own ship doesn't take a wing slot) AND
  // captured foreign-race craft — wings are a native-fleet construct;
  // captured craft fly on default AI as a distinct asset. The wing
  // counts track only native smallCraft, so including captured ships
  // would over-fill wings beyond their declared counts.
  const alliedRace = run.faction || game.alliedRace;
  const pool = game.ships.filter(
    (s) => s.side === "blue" && s.klass === craft && !s.isPlayer && s.race === alliedRace,
  );
  let cursor = 0;
  for (const wing of wings) {
    const take = Math.min(wing.count, pool.length - cursor);
    for (let i = 0; i < take; i++) {
      const ship = pool[cursor++];
      ship.wingCommand = { ...wing.command };
      ship.wingId = wing.id;
      ship.wingName = wing.name;
      // Stamp commander + apply their trait effect (speed / damage /
      // hp / engine HP modifiers). Mutates ship.spec via clone-on-write
      // inside applyWingCommanderEffect so other wings stay clean.
      if (wing.commander) {
        ship.wingCommander = wing.commander;
        applyWingCommanderEffect(ship, wing.commander);
        // Level-up perk picks stack on top of the commander's trait.
        if (Array.isArray(wing.commander.perks) && wing.commander.perks.length) {
          applyCommanderPerks(ship, wing.commander.perks);
        }
      }
      // Defend-capital: hook into the existing escort leash by
      // stamping escortOf with the capital's runtime instance id.
      // assignEscortPacks already ran during spawnRoster; this
      // overwrites any auto-assigned escortOf so player intent wins.
      if (wing.command.kind === "defend-capital" && wing.command.target != null) {
        const cap = game.ships.find(
          (s) => s.side === "blue" && s.runtimeInstanceId === wing.command.target && !s.dead
        );
        if (cap) ship.escortOf = cap.id;
      } else if (wing.command.kind !== "defend-capital") {
        // Non-defend wings: clear any auto-assigned escortOf so
        // free/press/hold ships aren't leashed to a random capital.
        // (Skipped for defend so an unmatched capital instanceId
        // doesn't strip the auto-assignment.)
        ship.escortOf = null;
      }
    }
  }
}
