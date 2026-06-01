/**
 * @file Mission → battle bridge (FRONTIER_FUTURE.md §3.5).
 *
 * Turns a War + a chapter/sortie + the player's chosen pilot class into
 * a `modeConfig` the engine can spawn, and launches it via startGame
 * under the new `frontier` mode. This is the seam between the
 * authored-content layer (wars.js) and the battle engine (game.js).
 *
 * Roster shapes are derived from a chapter's `battle.kind` + `scale`.
 * Counts are PLACEHOLDER tuning — the point of this slice is that a
 * mission actually spawns and runs end-to-end, not that it's balanced.
 *
 * Enemy faction → engine race goes through wars.js#raceForFaction (the
 * Brood/Saurian placeholder map), so when the real races land nothing
 * here changes.
 */

import { startGame } from "../game.js";
import { saveStore } from "../save.js";
import { getWar, raceForFaction, PLAYER_RACE } from "./wars.js";
import { completeChapter, completeSortie, killPilot, currentTier } from "./state.js";
import { awardDrops, loadoutStatsFor, isEquipped } from "./inventory.js";
import { checkAchievements } from "./achievements.js";
import { checkNewsreel } from "./newsreel.js";

/**
 * Base roster (pre-scale) per battle kind. blue = friendly Republic
 * fleet the player fights alongside; red = the enemy. The player pilots
 * ONE ship of their chosen class (promotePlayer recycles/spawns it from
 * the blue side), so blue counts are the supporting fleet.
 * @type {Record<string,{blue:Object,red:Object}>}
 */
// Balance intent (FRONTIER_FUTURE.md: "the player wins missions to
// progress"): the Republic deploys a SPEARHEAD fleet, so blue is favored
// in tonnage — the enemy stays threatening (and individually stronger,
// per faction stats), but the player's fleet isn't out-shipped before
// their own piloting/command even enters the equation. Earlier rosters
// gave RED the heavier line (extra cruiser + carrier vs blue's lone
// battleship), which produced 0-18 AI wipes for the player's side.
const BASE_ROSTERS = {
  sweep: {
    blue: { fighter: 6 },
    red:  { fighter: 6 },
  },
  defense: {
    blue: { fighter: 8, frigate: 1 },
    red:  { fighter: 10, bomber: 2 },
  },
  "capital-assault": {
    blue: { fighter: 8, frigate: 2, cruiser: 1 },
    red:  { fighter: 6, frigate: 2, cruiser: 1 },
  },
  fleet: {
    blue: { fighter: 9, frigate: 2, cruiser: 1, battleship: 1 },
    red:  { fighter: 9, bomber: 2, frigate: 2, cruiser: 1, carrier: 1 },
  },
  boss: {
    blue: { fighter: 9, frigate: 2, cruiser: 1, battleship: 1 },
    red:  { fighter: 8, frigate: 2, cruiser: 1, carrier: 1 },
  },
  surrender: {
    blue: { fighter: 7, frigate: 2, cruiser: 1 },
    red:  { fighter: 5, frigate: 2, cruiser: 1, battleship: 1 },
  },
};

/** Per-faction roster flavor. Brood leans on swarming fighter mass.
 *  Tuned to 1.4× via AI-vs-AI sims: capital fights land ~even and fleet
 *  sieges stay hard-but-winnable (a desperate swarm). VERY sensitive —
 *  1.3× made Brood fleets a pushover, 1.5×+ an unwinnable flood. */
const FACTION_RED_MUL = {
  brood: { fighter: 1.4, bomber: 1.2 },
};

/**
 * Which classes a faction can field in a War. The generic BASE_ROSTERS
 * are faction-agnostic, so a faction with a restricted line-up gets its
 * disallowed classes FOLDED into a substitute (counts preserved, battle
 * scale unchanged). The Brood is a pure organic swarm: drones (fighters),
 * brood-ships (carriers), and the hive (battleship) ONLY — no bombers,
 * frigates, or cruisers. Bombers/frigates collapse into more drones;
 * cruisers become another brood-ship. null/absent = no restriction
 * (Saurians field the full line).
 */
const FACTION_FIELDS = {
  brood: {
    allow: new Set(["fighter", "carrier"]),
    sub: { bomber: "fighter", frigate: "fighter", cruiser: "carrier", battleship: "carrier" },
  },
};

function applyFactionFields(roster, faction) {
  const f = FACTION_FIELDS[faction];
  if (!f) return roster;
  const out = {};
  for (const [klass, count] of Object.entries(roster)) {
    const k = f.allow.has(klass) ? klass : (f.sub[klass] || "fighter");
    out[k] = (out[k] || 0) + count;
  }
  return out;
}

function scaleRoster(roster, factor, perKlassMul) {
  const out = {};
  for (const [klass, count] of Object.entries(roster)) {
    const m = (perKlassMul && perKlassMul[klass]) || 1;
    const n = Math.round(count * factor * m);
    if (n > 0) out[klass] = n;
  }
  return out;
}

/**
 * Build blue/red rosters for a battle descriptor.
 * @param {{kind:string, scale:number}} battle
 * @param {string} enemyFaction
 */
export function rostersForBattle(battle, enemyFaction) {
  const base = BASE_ROSTERS[battle.kind] || BASE_ROSTERS.sweep;
  const factor = 1 + (Math.max(1, battle.scale || 1) - 1) * 0.2;
  return {
    blue: scaleRoster(base.blue, factor, null),
    // Scale, then fold the enemy roster down to the classes the faction
    // can actually field (Brood → fighters/brood-ships/hive only).
    red: applyFactionFields(scaleRoster(base.red, factor, FACTION_RED_MUL[enemyFaction] || null), enemyFaction),
  };
}

/**
 * Assemble the modeConfig for a mission without launching it (pure;
 * useful for previews + tests).
 *
 * @param {Object} opts
 * @param {string} opts.warId
 * @param {string} opts.missionId        chapter or sortie id
 * @param {"chapter"|"sortie"} opts.missionType
 * @param {string} [opts.pilotClass]      class the player flies (default fighter)
 * @param {boolean} [opts.command]        deploy as fleet commander (admiral)
 * @returns {Object|null} modeConfig, or null if the War/mission is unknown
 */
export function buildMissionConfig({ warId, missionId, missionType, pilotClass = "fighter", command = false }) {
  const war = getWar(warId);
  if (!war) return null;
  const mission = missionType === "sortie"
    ? war.sorties.find((s) => s.id === missionId)
    : war.chapters.find((c) => c.id === missionId);
  if (!mission) return null;

  const enemyRace = raceForFaction(war.enemyFaction);
  const { blue, red } = rostersForBattle(mission.battle, war.enemyFaction);

  // Player deploys as the chosen class. promotePlayer reads
  // playerDesign.hull to spawn at any class; for the stock fighter we
  // honour the saved Shipyard design, otherwise a hull-only design lets
  // the spec defaults fill in (loadout application is the loot slice).
  const savedShip = saveStore.get().playerShip || null;
  const playerDesign = pilotClass === "fighter" && savedShip
    ? savedShip
    : { hull: pilotClass };

  return {
    blue,
    red,
    hostileRace: enemyRace,
    // Fleet command = admiral (no piloted ship, directive panel). Otherwise
    // fly the chosen class.
    battleMode: command ? "command" : "fly",
    // No player ship in command mode, so no design needed.
    playerDesign: command ? null : playerDesign,
    // Equipped-loadout combat multipliers for the flown class, snapshotted
    // at launch (pre-battle gear — drops from THIS mission apply next time).
    // Applied post-spawn to the player ship in modes/frontier.js. (No-op in
    // command mode — there's no player ship to scale.)
    loadoutStats: command ? null : loadoutStatsFor(pilotClass),
    frontier: {
      warId,
      missionId,
      missionType,
      missionKind: mission.battle.kind,
      pilotClass,
      command: !!command,
      enemyFaction: war.enemyFaction,
      neverSurrender: !!mission.battle.neverSurrender,
    },
  };
}

/**
 * Build the config AND launch the battle via startGame under the
 * `frontier` mode. Returns the modeConfig used (null if it couldn't be
 * built). Caller is responsible for post-launch chrome (audio.start,
 * input.resetForNewMatch, camera reset) — same contract as the legacy
 * roguelite launch in main.js.
 *
 * @param {Object} game
 * @param {Object} opts  see buildMissionConfig
 * @param {{mapW?:number, mapH?:number}} [size]
 */
export function launchFrontierMission(game, opts, size = {}) {
  const cfg = buildMissionConfig(opts);
  if (!cfg) return null;
  const scale = (() => {
    const war = getWar(opts.warId);
    const mission = war && (opts.missionType === "sortie"
      ? war.sorties.find((s) => s.id === opts.missionId)
      : war.chapters.find((c) => c.id === opts.missionId));
    return (mission && mission.battle && mission.battle.scale) || 1;
  })();
  const mapW = size.mapW || (5000 + (scale - 1) * 1200);
  const mapH = size.mapH || (3500 + (scale - 1) * 900);
  startGame(game, mapW, mapH, PLAYER_RACE, "frontier", cfg, 1);
  return cfg;
}

/**
 * Resolve mission rewards + soft-death at match end. Reads
 * game.frontierContext (stamped by the mode setup) and the winner.
 *
 * - Win → complete the chapter (advances the War spine) or record the
 *   sortie; XP + credits are banked inside the state helpers.
 * - Loss OR player KIA → the live rookie pilot run ends (soft-death).
 *   Banked XP/credits/upgrades persist; only the run is wiped.
 *
 * Career XP/credits survive death, so a loss still keeps everything the
 * pilot earned mid-run (it was banked continuously).
 *
 * @param {Object} game
 * @param {"blue"|"red"|string} winner
 * @returns {Object|null} outcome summary, or null if not a frontier match
 */
export function resolveMissionOutcome(game, winner) {
  const fc = game.frontierContext;
  if (!fc) return null;
  const won = winner === "blue";
  const playerKIA = !game.admiralMode && !!game.playerKIA;
  const outcome = { won, playerKIA, warId: fc.warId, missionId: fc.missionId, mission: null, pilotEnded: false, runSummary: null };
  if (won) {
    outcome.mission = fc.missionType === "sortie"
      ? completeSortie(fc.warId, fc.missionId)
      : completeChapter(fc.warId, fc.missionId);
    // Loot drops for the flown class. Boss/capture missions roll on the
    // richer "boss" rarity table. Auto-equipped into empty slots — record
    // equipped state NOW (before the player touches the loadout) so the
    // result screen can badge them. Build a render-ready view (raw module
    // refs are live stash objects; don't leak them to the HUD layer).
    const raw = awardDrops(fc.pilotClass, fc.missionKind, fc.neverSurrender ? "boss" : "mission");
    outcome.drops = raw.map((d) => ({
      name: d.name, rarity: d.rarity, slotLabel: d.slotLabel, klass: d.klass,
      equipped: isEquipped(d.id),
      affixes: (d.affixes || []).map((a) => ({ label: a.label, value: a.value, applied: a.applied })),
      unique: d.unique ? d.unique.desc : null,
    }));
    // Clean reward summary for the result screen.
    const mr = outcome.mission || {};
    outcome.rewards = {
      xpGained: mr.xpGained || 0,
      creditsGained: mr.creditsGained || 0,
      promoted: !!mr.promoted,
      rankName: currentTier().name,
    };
  }
  if (!won || playerKIA) {
    outcome.pilotEnded = true;
    outcome.runSummary = killPilot();
  }
  // Achievements/decorations — checked AFTER rewards + kills are banked
  // (kills were recorded incrementally during the battle; chapter/tier
  // progress + new gear were just applied above) so a milestone crossed
  // this mission unlocks now. Surfaced on the result screen.
  outcome.newDecorations = checkAchievements();
  // Authored propaganda segments triggered this mission (chapter clears,
  // kill milestones, war wins) — surfaced as incoming transmissions.
  outcome.newTransmissions = checkNewsreel();
  return outcome;
}
