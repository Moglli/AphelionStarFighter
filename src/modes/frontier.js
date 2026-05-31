/**
 * @file New War-based Frontier mode (FRONTIER_FUTURE.md).
 *
 * Per-match setup for the new mode. The content + run state live in
 * src/frontier/ (wars.js, state.js, career.js, mission.js); this file
 * only turns the assembled modeConfig into spawned ships, mirroring the
 * legacy roguelite mode but far simpler — no acts, no boss-phase waves,
 * no allied-reinforcement pass yet.
 *
 * game.modeConfig (built by mission.js#buildMissionConfig) carries:
 *   { blue, red, hostileRace, battleMode, playerDesign,
 *     frontier: { warId, missionId, missionType, missionKind,
 *                 pilotClass, enemyFaction, neverSurrender } }
 *
 * Runs ALONGSIDE the legacy `roguelite` mode (key "frontier") — the
 * menu route still points at roguelite until this mode is playable.
 */

import { defaultDirectives } from "./admiral.js";

export const frontierMode = {
  key: "frontier",
  label: "Frontier",
  tagline: "Republic war",

  setup(game, { spawnRoster }) {
    const cfg = game.modeConfig;
    if (!cfg) {
      spawnRoster(game);
      return;
    }

    if (cfg.hostileRace) game.hostileRace = cfg.hostileRace;
    game.frontierContext = cfg.frontier || null;
    game.directives = defaultDirectives();

    if (cfg.battleMode === "command") {
      // FLEET COMMAND (admiral): no piloted ship — spectator camera +
      // directive panel. spawnRoster skips promotePlayer while
      // game.spectating is true, so the blue fleet flies on AI. Mirrors
      // the legacy roguelite command branch.
      game.spectating = true;
      game.admiralMode = true;
      spawnRoster(game, { blue: cfg.blue, red: cfg.red });
      const z = game.arena && game.arena.spawn && game.arena.spawn.blue;
      if (z) game.spectateCamera = { x: z.x, y: z.y, locked: false };
    } else {
      // Player flies their chosen class — promotePlayer (called at the end
      // of spawnRoster when not spectating) spawns the playerDesign.hull,
      // so any unlocked class deploys as that hull.
      spawnRoster(game, { blue: cfg.blue, red: cfg.red });

      // Apply equipped-loadout combat multipliers to the player ship.
      // Done POST-SPAWN (not via playerSpecOverride) because applyDesign
      // runs AFTER specOverride in createShip and would re-stamp default
      // component stats over loot. Clone-on-write the shared spec refs to
      // avoid poisoning other ships of the same race/class.
      if (cfg.loadoutStats) {
        const player = game.ships.find((s) => s.isPlayer && !s.dead);
        if (player) applyLoadoutToShip(player, cfg.loadoutStats);
      }
    }

    // Boss / capture missions: mark the largest enemy capital as the
    // boss and lock surrender off so it fights to the death (boss) — or
    // leave surrender enabled (capture-mission) so the player can force
    // it to strike colors.
    const fc = cfg.frontier;
    if (fc && fc.neverSurrender) {
      const boss = pickBossShip(game);
      if (boss) {
        boss.isBoss = true;
        boss.neverSurrender = true;
      }
    }
  },

  tick: null,
  checkEnd: null,
};

// Apply loot multipliers to a freshly-spawned player ship. Scales the
// cached combat fields the runtime actually reads: hull/shield pools,
// movement (spec.maxSpeed/turnRate), and per-mount weapon damage +
// cooldown. Each shared spec object is cloned before mutation so other
// ships sharing the resolved race/class spec are unaffected (the
// codebase-wide spec-mutation hazard). Multipliers default to 1, so an
// empty loadout is a no-op.
function applyLoadoutToShip(ship, m) {
  if (!m) return;
  // Hull integrity — ship spawns at full, so scale max and current together.
  if (m.hp && m.hp !== 1) {
    ship.hpMax = Math.round(ship.hpMax * m.hp);
    ship.hp = ship.hpMax;
  }
  // Shield capacity (skip shieldless hulls). shieldBaseMax is the value
  // updateShip rescales against live generators, so scale it too.
  if (m.shield && m.shield !== 1 && ship.shieldMax > 0) {
    ship.shieldMax = Math.round(ship.shieldMax * m.shield);
    if (ship.shieldBaseMax) ship.shieldBaseMax = Math.round(ship.shieldBaseMax * m.shield);
    ship.shield = ship.shieldMax;
  }
  // Spec-level fields (movement + fighter missile launcher). Clone the
  // shared spec ONCE before any mutation, then touch fields in place.
  const needSpec = (m.speed && m.speed !== 1) || (m.turn && m.turn !== 1)
    || (m.missileDamage && m.missileDamage !== 1 && ship.spec.missile);
  if (needSpec) {
    ship.spec = { ...ship.spec };
    if (m.speed && m.speed !== 1 && typeof ship.spec.maxSpeed === "number") ship.spec.maxSpeed *= m.speed;
    if (m.turn && m.turn !== 1 && typeof ship.spec.turnRate === "number") ship.spec.turnRate *= m.turn;
    if (m.missileDamage && m.missileDamage !== 1 && ship.spec.missile && typeof ship.spec.missile.damage === "number") {
      ship.spec.missile = { ...ship.spec.missile, damage: ship.spec.missile.damage * m.missileDamage };
    }
  }
  // Weapons — clone each per-mount spec, scale damage + cooldown (fire
  // rate ↑ = cooldown ↓). ship.weapons[] is the live fire path.
  if ((m.damage && m.damage !== 1) || (m.fireRate && m.fireRate !== 1)) {
    if (Array.isArray(ship.weapons)) {
      for (const w of ship.weapons) {
        if (!w || !w.spec) continue;
        w.spec = { ...w.spec };
        if (m.damage && m.damage !== 1 && typeof w.spec.damage === "number") w.spec.damage *= m.damage;
        if (m.fireRate && m.fireRate !== 1 && typeof w.spec.cooldown === "number") w.spec.cooldown /= m.fireRate;
      }
    }
  }
  // Capital missile pods (per-mount). Fighter launcher handled above.
  if (m.missileDamage && m.missileDamage !== 1 && Array.isArray(ship.podSpecs)) {
    for (let i = 0; i < ship.podSpecs.length; i++) {
      const p = ship.podSpecs[i];
      if (p && typeof p.damage === "number") ship.podSpecs[i] = { ...p, damage: p.damage * m.missileDamage };
    }
  }
}

// Largest enemy capital: prefer carrier (hive/banner-carrier), then
// battleship, else biggest red ship by hull radius. Mirrors the
// roguelite-mode helper.
function pickBossShip(game) {
  let carrier = null, battleship = null, biggest = null;
  for (const s of game.ships) {
    if (s.dead || s.side !== "red") continue;
    if (s.klass === "carrier" && !carrier) carrier = s;
    if (s.klass === "battleship" && !battleship) battleship = s;
    const r = (s.spec && s.spec.radius) || 0;
    const br = (biggest && biggest.spec && biggest.spec.radius) || 0;
    if (!biggest || r > br) biggest = s;
  }
  return carrier || battleship || biggest;
}
