import { ARENA, randomSpawnPos, createStarfield, setArenaSize, spawnZonesFor } from "./arena.js";
import { createShip, updateShip, moduleWorldPos, recordDamageMark, emitPuff, emitSparks, damageCellsInRadius, pruneDisconnectedCells, shieldRadius, createWreckageChunks, updateWreck } from "./ship.js";
import { ARENA, randomSpawnPos, createStarfield, setArenaSize } from "./arena.js";
import {
  createShip, updateShip, findHitSubsystem, resetSubsystems, hasWorkingSubsystem,
} from "./ship.js";
import { updateAI } from "./ai.js";
import { updateProjectile } from "./projectile.js";
import { RACES, RACE_KEYS, randomRaceKey } from "./races.js";
import { events } from "./events.js";
import { MODES, DEFAULT_MODE } from "./modes/index.js";
import { saveStore } from "./save.js";
import { audio } from "./audio.js";
import { resolveCosmetic } from "./cosmetics.js";
import {
  createWreck, createDebrisBurst,
  updateWreck, updateDebris,
  pushWreck, pushDebris,
} from "./wreckage.js";
import { rally } from "./rally.js";

const RESPAWN_SECONDS = 2.0;
const FIGHTER_PACK_SIZE = 5;
const BOMBER_PACK_SIZE = 2;
const PACK_CLUSTER_RADIUS = 130;

const PACK_ROLES = [
  "hunt-fighter",
  "strike-capital",
  "skirmish-frigate",
  "hunt-fighter",
  "strike-capital",
  "skirmish-frigate",
];

let nextPackId = 1;
let nextPackRoleIdx = 0;

export function createGame() {
  // Default map size for the menu backdrop. Replaced when the user picks
  // a size in startGame.
  setArenaSize(7000, 5000);
  const game = {
    ships: [],
    projectiles: [],
    beams: [],
    // Persistent map litter: chunks of destroyed ships + small bits
    // knocked off by damaging hits. See ./wreckage.js.
    wrecks: [],
    debris: [],
    // Persistent wreckage chunks left behind by destroyed ships. Each entry
    // drifts/spins from its initial blast impulse, burns for a few seconds,
    // then settles as a charred husk. Capped to MAX_WRECKAGE so long runs
    // don't accumulate unbounded draw cost.
    wreckage: [],
    arena: ARENA,
    starfield: createStarfield(),
    playerController: {
      thrust: { x: 0, y: 0 },
      aim: null,
      firing: false,
      firingMissile: false,
    },
    respawnTimer: 0,
    matchOver: false,
    winner: null,
    spectating: false,
    spectateTargetId: null,
    // Spectator camera. When `locked`, draw() reads the target ship's
    // position; when the user nudges the left stick we detach into
    // free-pan mode (locked=false) and let them roam the arena. PREV /
    // NEXT re-lock onto whichever ship they cycle to.
    spectateCamera: { x: 0, y: 0, locked: true },
    // Lifecycle: "menu" before the player picks options, "playing" during
    // a match.
    state: "menu",
    // Mode + selections, replaced when startGame is called.
    mode: DEFAULT_MODE,
    playerKlass: "fighter",
    alliedRace: "terran",
    hostileRace: "terran",
    // Match scoring + mode-specific state. Modes own `modeState`.
    score: 0,
    kills: 0,
    elapsed: 0,
    modeState: null,
    // Pack lookup, rebuilt each tick.
    packs: new Map(),
    // Custom-mode roster, set by the menu when launching from the
    // Custom Game screen. Shape: { blue: {fighter: N, ...}, red: {...},
    // hostileRace: "terran" }. Ignored by non-custom modes.
    customRoster: null,
  };
  return game;
}

/**
 * Begin a match.
 *
 * @param {object} game
 * @param {{
 *   mode?: import("./types.js").GameMode,
 *   mapW?: number,
 *   mapH?: number,
 *   race?: import("./types.js").RaceId,
 *   klass?: import("./types.js").ShipId,
 * }} opts
 */
export function startGame(game, opts = {}) {
  const modeKey = opts.mode && MODES[opts.mode] ? opts.mode : DEFAULT_MODE;
  const mode = MODES[modeKey];
  const mapW = opts.mapW != null ? opts.mapW : 7000;
  const mapH = opts.mapH != null ? opts.mapH : 5000;

  setArenaSize(mapW, mapH);
  game.starfield = createStarfield();
  game.ships = [];
  game.projectiles = [];
  game.beams = [];
  game.wrecks = [];
  game.debris = [];
  game.wreckage = [];
  game.respawnTimer = 0;
  game.matchOver = false;
  game.winner = null;
  game.spectating = false;
  game.spectateTargetId = null;
  game.alliedRace = RACES[opts.race] ? opts.race : "terran";
  game.playerKlass = opts.klass || "fighter";
  // Player's chosen opponent race for arena mode. "random" (or anything
  // not a valid race key) means "pick at match start". Other modes
  // currently ignore this and pick their own hostile race.
  game.opponentRace = RACES[opts.opponent] ? opts.opponent : "random";
  game.mode = modeKey;
  game.score = 0;
  game.kills = 0;
  game.elapsed = 0;
  game.modeState = null;
  game.customRoster = opts.customRoster || null;
  game.fleetMul = typeof opts.fleetMul === "number" ? opts.fleetMul : 1;
  game.factions = [2, 3, 4].includes(opts.factions) ? opts.factions : 2;
  game.state = "playing";

  // Let the mode pick the hostile race and stage initial spawns. Falls
  // back to the legacy arena setup if the mode hook is absent.
  if (mode && typeof mode.setup === "function") {
    mode.setup(game, { spawnRoster, promotePlayer });
  } else {
    game.hostileRace = randomRaceKey();
    spawnRoster(game);
    if (!game.spectating) promotePlayer(game);
  }

  // Lazy-start the ambient music drone — fades in over 3s. Browsers
  // require a user gesture to start audio; the gesture that opened the
  // start menu satisfies it.
  audio.musicStart();
}

// Re-exported for modes that want to compose roster/promote behavior.
export { spawnRoster, promotePlayer };

// Spawn rosters for every active faction. Honors:
//   - `override`: per-side roster map { blue, red, ... } from Custom mode
//   - `game.factions`: number of competing sides (2, 3, or 4)
//   - `game.fleetMul`: roster count multiplier from the FLEET SIZE chip
//   - `game.alliedRace`: race for the player's blue side
//   - `game.hostileRaces`: array of races, one per non-blue side
//   - `opts.onlySides`: optional whitelist (e.g. ["blue"]). Used by
//     Waves mode to spawn just the player's allied custom fleet without
//     also placing hostiles at match start — those come from waves.
// Does NOT touch the player slot — callers (mode setup hooks) are
// responsible for invoking promotePlayer afterward.
function spawnRoster(game, override, opts) {
  const onlySides = opts && opts.onlySides ? new Set(opts.onlySides) : null;
  const factionCount = game.factions || 2;
  const zones = spawnZonesFor(factionCount);
  const sides = Object.keys(zones);
  // Hostile-race book-keeping is only meaningful when we'll actually
  // spawn at least one non-blue side this call. Skip it when filtered.
  const willSpawnHostiles = !onlySides
    || sides.some((s) => s !== "blue" && onlySides.has(s));
  if (willSpawnHostiles) {
    if (!Array.isArray(game.hostileRaces) || game.hostileRaces.length < sides.length - 1) {
      game.hostileRaces = [];
      for (let i = 0; i < sides.length - 1; i++) {
        game.hostileRaces.push(randomRaceKey());
      }
    }
    // Keep the legacy single `hostileRace` field pointing at the first
    // hostile side so existing per-mode code still has a value to read.
    game.hostileRace = game.hostileRaces[0];
  }

  const mul = game.fleetMul || 1;
  let hostileIdx = 0;
  for (const side of sides) {
    // Advance the hostile race index regardless of filter, so the race
    // assignment stays stable across calls when the caller spawns each
    // side separately.
    let race;
    if (side === "blue") {
      race = game.alliedRace;
    } else {
      race = (game.hostileRaces && game.hostileRaces[hostileIdx++])
           || randomRaceKey();
    }
    if (onlySides && !onlySides.has(side)) continue;
    const fallback = (RACES[race] && RACES[race].roster) || RACES.terran.roster;
    const baseRoster = (override && override[side]) || fallback;
    // Apply fleet-size multiplier per class, rounding up so even a
    // 0.5x small fleet keeps at least one of each non-zero class.
    const roster = {};
    for (const klass of Object.keys(baseRoster)) {
      const n = baseRoster[klass] || 0;
      roster[klass] = n > 0 ? Math.max(1, Math.round(n * mul)) : 0;
    }
    const zone = zones[side];
    // Face roughly toward the arena center so initial flight paths
    // cross instead of leaving the map.
    const facing = Math.atan2(
      ARENA.height / 2 - zone.y,
      ARENA.width / 2 - zone.x,
    );
    for (const [klass, count] of Object.entries(roster)) {
      if (count <= 0) continue;
      if (klass === "fighter") {
        spawnFighterPacks(game, side, race, zone, count, facing);
      } else if (klass === "bomber") {
        spawnBomberPairs(game, side, race, zone, count, facing);
      } else if (klass === "carrier") {
        spawnCarrierWithEscort(game, side, race, zone, count, facing);
      } else {
        for (let i = 0; i < count; i++) {
          const pos = randomSpawnPos(zone);
          const heading = facing + (Math.random() - 0.5) * 0.3;
          const ship = createShip({
            klass, race, side, pos, heading,
            controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
          });
          game.ships.push(ship);
        }
      }
    }
  }
}

function spawnFighterPacks(game, side, race, zone, count, facing) {
  let remaining = count;
  while (remaining > 0) {
    const packSize = Math.min(FIGHTER_PACK_SIZE, remaining);
    const packCenter = randomSpawnPos(zone);
    const packId = nextPackId++;
    const packRole = PACK_ROLES[nextPackRoleIdx++ % PACK_ROLES.length];
    for (let i = 0; i < packSize; i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = Math.random() * PACK_CLUSTER_RADIUS;
      const pos = {
        x: packCenter.x + Math.cos(ang) * dist,
        y: packCenter.y + Math.sin(ang) * dist,
      };
      const heading = facing + (Math.random() - 0.5) * 0.3;
      const ship = createShip({
        klass: "fighter",
        race,
        side,
        pos,
        heading,
        controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
      });
      ship.packId = packId;
      ship.packRole = packRole;
      game.ships.push(ship);
    }
    remaining -= packSize;
  }
}

// Bombers spawn in tight pairs. They don't share the fighter pack system —
// their AI targets capitals directly, and they're meant to be the "loud"
// threat that pulls fighter attention.
function spawnBomberPairs(game, side, race, zone, count, facing) {
  let remaining = count;
  while (remaining > 0) {
    const pairSize = Math.min(BOMBER_PACK_SIZE, remaining);
    const center = randomSpawnPos(zone);
    for (let i = 0; i < pairSize; i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = Math.random() * (PACK_CLUSTER_RADIUS * 0.7);
      const pos = {
        x: center.x + Math.cos(ang) * dist,
        y: center.y + Math.sin(ang) * dist,
      };
      const heading = facing + (Math.random() - 0.5) * 0.2;
      const ship = createShip({
        klass: "bomber",
        race,
        side,
        pos,
        heading,
        controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
      });
      game.ships.push(ship);
    }
    remaining -= pairSize;
  }
}

// Carrier + fighter escort squadron. Each carrier spawns with a ring of
// fighters that share a packId so they engage as a wing. The escort's
// pack role is "hunt-fighter" — they screen against enemy small craft;
// the pack target picker still upgrades them to a bomber if one shows up.
function spawnCarrierWithEscort(game, side, race, zone, count, facing) {
  for (let n = 0; n < count; n++) {
    const pos = randomSpawnPos(zone);
    const carrier = createShip({
      klass: "carrier", race, side, pos, heading: facing,
      controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
    });
    game.ships.push(carrier);

    const escortSize = carrier.spec.escortSize || 6;
    const packId = nextPackId++;
    for (let i = 0; i < escortSize; i++) {
      const ang = (i / escortSize) * Math.PI * 2;
      const dist = carrier.spec.radius + 70;
      const epos = {
        x: pos.x + Math.cos(ang) * dist,
        y: pos.y + Math.sin(ang) * dist,
      };
      const heading = facing + (Math.random() - 0.5) * 0.3;
      const escort = createShip({
        klass: "fighter", race, side, pos: epos, heading,
        controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
      });
      escort.packId = packId;
      escort.packRole = "hunt-fighter";
      game.ships.push(escort);
    }
  }
}

function promotePlayer(game, klass) {
  const want = klass || game.playerKlass || "fighter";
  // Prefer an existing friendly ship of the requested class so the
  // player slots into the spawned roster instead of duplicating.
  const candidate = game.ships.find(
    (s) => s.side === "blue" && s.klass === want && !s.isPlayer && !s.dead,
  );
  let ship;
  if (!candidate) {
    ship = createShip({
      klass: want,
      race: game.alliedRace,
      side: "blue",
      pos: randomSpawnPos(ARENA.spawn.blue),
      heading: 0,
      controller: game.playerController,
    });
    ship.isPlayer = true;
    game.ships.push(ship);
  } else {
    candidate.controller = game.playerController;
    candidate.isPlayer = true;
    candidate.pos = randomSpawnPos(ARENA.spawn.blue);
    candidate.vel = { x: 0, y: 0 };
    candidate.hp = candidate.hpMax;
    candidate.shield = candidate.shieldMax;
    if (candidate.armorMax > 0) candidate.armor = candidate.armorMax;
    candidate.shieldHitTimer = 999;
    candidate.heading = 0;
    candidate.missileCd = 0;
    if (candidate.spec.weapon && candidate.spec.weapon.capacity) {
      candidate.weaponAmmo = candidate.spec.weapon.capacity;
      candidate.weaponReloading = false;
      candidate.weaponReloadTimer = 0;
    }
    // Subsystems were probably battered during the previous ownership;
    // restore them so the player isn't punished for a respawn handoff.
    resetSubsystems(candidate);
    ship = candidate;
  }
  // Apply equipped cosmetics. Renderer reads ship.cosmetics on draw.
  const equipped = saveStore.get().equippedCosmetics;
  const hullSkin = resolveCosmetic(equipped.hullSkin);
  ship.cosmetics = {
    hullTint: hullSkin && hullSkin.tint ? hullSkin.tint : null,
  };
  return ship;
}

// ---------------------------------------------------------------------------
// Spectate API — called from main when the player toggles spectate.
// ---------------------------------------------------------------------------
export function enterSpectate(game) {
  if (game.spectating) return;
  game.spectating = true;
  // Remove the live player ship; leave the rest of the world running.
  for (const s of game.ships) if (s.isPlayer) s.dead = true;
  game.ships = game.ships.filter((s) => !s.isPlayer);
  // Pick a spectate target — prefer the player's side, fall back to anyone.
  const tgt = pickSpectateInitial(game);
  game.spectateTargetId = tgt ? tgt.id : null;
  // Camera starts locked onto that target (or arena center if none).
  game.spectateCamera.locked = true;
  if (tgt) {
    game.spectateCamera.x = tgt.pos.x;
    game.spectateCamera.y = tgt.pos.y;
  } else {
    game.spectateCamera.x = game.arena.width / 2;
    game.spectateCamera.y = game.arena.height / 2;
  }
}

function pickSpectateInitial(game) {
  return game.ships.find((s) => !s.dead && s.side === "blue")
      || game.ships.find((s) => !s.dead);
}

export function exitSpectate(game) {
  if (!game.spectating) return;
  game.spectating = false;
  game.spectateTargetId = null;
  promotePlayer(game);
}

export function cycleSpectate(game, dir) {
  if (!game.spectating) return;
  const alive = game.ships.filter((s) => !s.dead);
  if (alive.length === 0) { game.spectateTargetId = null; return; }
  // Sort so cycling is stable.
  alive.sort((a, b) => a.id - b.id);
  let idx = alive.findIndex((s) => s.id === game.spectateTargetId);
  if (idx === -1) idx = 0;
  idx = (idx + (dir > 0 ? 1 : -1) + alive.length) % alive.length;
  game.spectateTargetId = alive[idx].id;
  // Re-lock the camera to the new target and snap to it.
  game.spectateCamera.locked = true;
  game.spectateCamera.x = alive[idx].pos.x;
  game.spectateCamera.y = alive[idx].pos.y;
}

export function getSpectateTarget(game) {
  if (!game.spectating || game.spectateTargetId == null) return null;
  return game.ships.find((s) => s.id === game.spectateTargetId && !s.dead) || null;
}

// ---------------------------------------------------------------------------
// Tick.
// ---------------------------------------------------------------------------
export function update(game, dt) {
  if (game.state !== "playing") return;

  if (!game.matchOver) game.elapsed += dt;
  rally.update(dt);
  // Mode-specific per-tick logic (e.g. spawning new waves). Runs before
  // ship AI so any newly-spawned ships still tick this frame. Suppressed
  // once the match is decided so post-game freeze-frame stays still.
  const mode = MODES[game.mode];
  if (!game.matchOver && mode && typeof mode.tick === "function") {
    mode.tick(game, dt);
  }

  game.packs = computePacks(game.ships);

  for (const ship of game.ships) {
    if (ship.dead || ship.isPlayer) continue;
    updateAI(ship, game, dt);
  }

  for (const ship of game.ships) {
    if (ship.dead) continue;
    updateShip(ship, dt, game);
  }

  resolveHeavyOverlap(game.ships, game.arena.bounds);

  // Projectiles: movement + ship collisions + PD-vs-missile collisions.
  for (const p of game.projectiles) {
    if (p.dead) continue;
    updateProjectile(p, dt, game);
    if (p.dead) continue;

    // PD rounds can intercept enemy missiles before they reach a ship.
    if (p.kind !== "missile" && p.fromKlass === "pd") {
      let interceptedMissile = false;
      for (const m of game.projectiles) {
        if (m.dead || m.kind !== "missile" || m.side === p.side) continue;
        const dx = m.pos.x - p.pos.x;
        const dy = m.pos.y - p.pos.y;
        const r = m.radius + p.radius + 1;
        if (dx * dx + dy * dy <= r * r) {
          m.hp -= p.damage;
          if (m.hp <= 0) m.dead = true;
          p.dead = true;
          interceptedMissile = true;
          break;
        }
      }
      if (interceptedMissile) continue;
    }

    // Hit a ship. Effective collision radius depends on shield state:
    // when the bubble is up and the round isn't a missile (which bypasses
    // shields by design), projectiles stop at the visible shield surface
    // instead of phasing through to the hull.
    for (const ship of game.ships) {
      if (ship.dead || ship.side === p.side) continue;
      const dx = ship.pos.x - p.pos.x;
      const dy = ship.pos.y - p.pos.y;
      const shieldsUp = p.kind !== "missile"
        && ship.shieldMax > 0 && ship.shield > 0;
      const hitR = shieldsUp
        ? shieldRadius(ship) + p.radius
        : ship.spec.radius + p.radius;
      if (dx * dx + dy * dy <= hitR * hitR) {
        const attacker = p.ownerId != null
          ? game.ships.find((s) => s.id === p.ownerId)
          : null;
        applyDamage(ship, p, attacker, game, p.pos);
        // Legacy module hit-test runs first for ships that aren't on
        // the new cell system (none right now, but kept as a fallback).
        let legacyModule = null;
        if (!ship.sprite) {
          legacyModule = pickModuleHit(ship, p);
          if (legacyModule) {
            legacyModule.hp -= p.damage;
            legacyModule.flash = 1;
            if (legacyModule.hp <= 0 && !legacyModule.dead) {
              legacyModule.dead = true;
              legacyModule.hp = 0;
              emitSparks(ship, legacyModule.lx, legacyModule.ly, 10);
              emitPuff(ship, legacyModule.lx, legacyModule.ly, "ember");
              emitPuff(ship, legacyModule.lx, legacyModule.ly, "smoke");
              events.emit("moduleDestroyed", { ship, module: legacyModule, byPlayer: !!(attacker && attacker.isPlayer) });
            } else {
              emitSparks(ship, legacyModule.lx, legacyModule.ly, 3);
            }
          }
        }
        const armorBefore = ship.armor;
        const hullBefore = ship.hp;
        const shieldBefore = ship.shield;
        applyDamage(ship, p, attacker);
        // Decide which layer absorbed enough damage and translate that
        // into the right visual. Hull breaches chew cells; armor hits
        // chew a smaller radius plus leave a scorch; shield hits just
        // bump the all-ship flash.
        const hitLocal = worldToShipLocal(ship, p.pos.x, p.pos.y);
        let chewMul = 0;
        if (ship.hp < hullBefore) {
          chewMul = 1.0;
          ship.hitFlash = Math.min(1, (ship.hitFlash || 0) + 0.7);
          emitSparks(ship, hitLocal.lx, hitLocal.ly, 6);
          emitPuff(ship, hitLocal.lx, hitLocal.ly, "ember");
          // Hull breach blows a hard jet of atmosphere outward.
          const outLen = Math.hypot(hitLocal.lx, hitLocal.ly) || 1;
          const ventDir = { x: hitLocal.lx / outLen, y: hitLocal.ly / outLen };
          emitPuff(ship, hitLocal.lx, hitLocal.ly, "vent", ventDir);
          emitPuff(ship, hitLocal.lx, hitLocal.ly, "vent", ventDir);
          if (!ship.sprite) {
            recordDamageMark(ship, p.pos.x, p.pos.y, "hull", p.damage);
          }
        } else if (ship.armor < armorBefore) {
          chewMul = 0.45;
          recordDamageMark(ship, p.pos.x, p.pos.y, "armor", p.damage);
          ship.hitFlash = Math.min(1, (ship.hitFlash || 0) + 0.4);
          emitSparks(ship, hitLocal.lx, hitLocal.ly, 3);
          // Armor crack — small puff of debris/atmosphere from the plate.
          const outLen = Math.hypot(hitLocal.lx, hitLocal.ly) || 1;
          emitPuff(ship, hitLocal.lx, hitLocal.ly, "vent",
            { x: hitLocal.lx / outLen, y: hitLocal.ly / outLen });
        } else if (ship.shield < shieldBefore) {
          ship.hitFlash = Math.min(1, (ship.hitFlash || 0) + 0.2);
        }
        // Chew the sprite. Even a glancing armor hit cracks plating
        // visibly — under the user's request, cells should "chew
        // through" over the course of the engagement rather than only
        // appearing when hull is breached.
        if (chewMul > 0 && ship.sprite) {
          const radius = chewRadius(ship, p.damage) * chewMul;
          const { modulesDestroyed } = damageCellsInRadius(
            ship, hitLocal.lx, hitLocal.ly, radius,
          );
          for (const mod of modulesDestroyed) {
            emitSparks(ship, mod.lx, mod.ly, 10);
            emitPuff(ship, mod.lx, mod.ly, "ember");
            emitPuff(ship, mod.lx, mod.ly, "smoke");
            events.emit("moduleDestroyed", {
              ship, module: mod,
              byPlayer: !!(attacker && attacker.isPlayer),
            });
          }
          applyDisconnectionDamage(game, ship, attacker);
        }
        // Missiles always die on hit; cannons die on hit.
        p.dead = true;
        if (ship.hp <= 0) {
          ship.dead = true;
          handleShipDestroyed(game, ship, attacker);
        }
        break;
      }
    }
  }

  // Wreckage: drift, spin down, age fires + smoke. Cheap per-entry —
  // each wreck stops integrating motion once it settles.
  if (game.wreckage && game.wreckage.length > 0) {
    const bounds = game.arena.bounds;
    for (const w of game.wreckage) updateWreck(w, dt, bounds);
  }

  // Beams: apply damage once, then tick down.
  applyAndAgeBeams(game, dt);

  if (game.projectiles.length > 0) {
    game.projectiles = game.projectiles.filter((p) => !p.dead);
  }

  // Drift + age persistent map litter. Both arrays are capped at spawn
  // time so we never need to cull by age here.
  if (game.wrecks.length > 0) {
    for (const w of game.wrecks) updateWreck(w, dt, game.arena.bounds);
  }
  if (game.debris.length > 0) {
    for (const d of game.debris) updateDebris(d, dt, game.arena.bounds);
  }

  // Player death + respawn (only when not spectating).
  if (!game.spectating) {
    const player = game.ships.find((s) => s.isPlayer);
    if (player && player.dead) {
      if (game.respawnTimer <= 0) game.respawnTimer = RESPAWN_SECONDS;
      game.respawnTimer -= dt;
      if (game.respawnTimer <= 0) {
        game.ships = game.ships.filter((s) => !(s.isPlayer && s.dead));
        promotePlayer(game);
        game.respawnTimer = 0;
      }
    }
  }

  game.ships = game.ships.filter((s) => (s.isPlayer && !game.spectating) || !s.dead);

  // Keep spectate target valid, and drive the spectator camera.
  if (game.spectating) {
    let tgt = getSpectateTarget(game);
    if (!tgt) {
      const next = pickSpectateInitial(game);
      game.spectateTargetId = next ? next.id : null;
      tgt = next;
    }
    // Read left-stick / WASD intent off the player controller. Any
    // meaningful nudge detaches the camera into free-pan mode.
    const c = game.playerController;
    const thr = c.thrust;
    const thrMag = Math.hypot(thr.x, thr.y);
    if (thrMag > 0.1) {
      game.spectateCamera.locked = false;
      const PAN_SPEED = 1200; // px/sec in world space
      game.spectateCamera.x += thr.x * PAN_SPEED * dt;
      game.spectateCamera.y += thr.y * PAN_SPEED * dt;
    } else if (game.spectateCamera.locked && tgt) {
      // Locked-camera mode: track the target ship as it flies.
      game.spectateCamera.x = tgt.pos.x;
      game.spectateCamera.y = tgt.pos.y;
    }
    // Always clamp inside the arena.
    const b = game.arena.bounds;
    game.spectateCamera.x = Math.max(b.minX, Math.min(b.maxX, game.spectateCamera.x));
    game.spectateCamera.y = Math.max(b.minY, Math.min(b.maxY, game.spectateCamera.y));
  }

  if (!game.matchOver) {
    const winner = mode && typeof mode.checkEnd === "function"
      ? mode.checkEnd(game)
      : defaultArenaCheckEnd(game);
    if (winner) {
      game.matchOver = true;
      game.winner = winner;
      events.emit("matchEnded", {
        mode: game.mode,
        winner,
        durationSeconds: game.elapsed,
        score: game.score,
      });
      persistMatchResult(game);
    }
  }
}

// After a chew, check whether the hull was severed. Any cells in
// components smaller than the largest are jettisoned: they're marked
// dead, the ship's hp pool takes proportional damage, and the dropped
// area is dressed up with embers + sparks so the break-off reads as
// catastrophic. Kills the ship if the lost mass takes hp under zero.
function applyDisconnectionDamage(game, ship, attacker) {
  const total = ship.sprite.cells.length;
  if (total === 0) return;
  const { dropped, droppedCells } = pruneDisconnectedCells(ship);
  if (dropped === 0) return;
  // Each dropped cell bills its share of hpMax — losing 30% of cells
  // strips 30% of full hull hp from the pool.
  const damage = ship.hpMax * (dropped / total);
  ship.hp = Math.max(0, ship.hp - damage);
  // Sample a few dropped cells to anchor visible debris FX instead of
  // emitting one puff per cell (which would be silly for big breakups).
  const sampleCount = Math.min(droppedCells.length, 6);
  for (let i = 0; i < sampleCount; i++) {
    const c = droppedCells[Math.floor((i / sampleCount) * droppedCells.length)];
    emitSparks(ship, c.lx, c.ly, 8);
    emitPuff(ship, c.lx, c.ly, "ember");
    emitPuff(ship, c.lx, c.ly, "smoke");
  }
  ship.hitFlash = 1;
  events.emit("hullSevered", {
    ship, cellsLost: dropped, hpLost: damage,
    byPlayer: !!(attacker && attacker.isPlayer),
  });
  if (ship.hp <= 0 && !ship.dead) {
    ship.dead = true;
    handleShipDestroyed(game, ship, attacker);
  }
}

// Translate weapon damage into a cell-destruction radius in ship-local
// pixels. Lighter rounds chew off one cell; heavier ones rip a chunk
// scaled by sqrt(damage) so doubling damage roughly increases area by
// ~2x (not 4x), keeping cannons and torpedoes both feeling distinct.
function chewRadius(ship, damage) {
  const cs = ship.sprite.cellSize;
  return Math.max(cs * 0.55, Math.sqrt(Math.max(1, damage)) * cs * 0.42);
}

// World → ship-local transform. Used to anchor FX particles to a hit
// position so they ride the hull as it moves and rotates.
function worldToShipLocal(ship, wx, wy) {
  const ca = Math.cos(-ship.heading), sa = Math.sin(-ship.heading);
  const dx = wx - ship.pos.x;
  const dy = wy - ship.pos.y;
  return { lx: dx * ca - dy * sa, ly: dx * sa + dy * ca };
}

// Closest live module under the projectile, if any. Returns null when the
// shot landed on bare hull (no module nearby) — keeps subsystem combat
// optional rather than tax every hit with a per-module lookup.
function pickModuleHit(ship, p) {
  if (!ship.modules || ship.modules.length === 0) return null;
  let best = null, bestD2 = Infinity;
  for (const m of ship.modules) {
    if (m.dead) continue;
    const pos = moduleWorldPos(ship, m);
    const dx = pos.x - p.pos.x;
    const dy = pos.y - p.pos.y;
    const reach = m.radius + p.radius;
    const d2 = dx * dx + dy * dy;
    if (d2 <= reach * reach && d2 < bestD2) {
      bestD2 = d2; best = m;
    }
  }
  return best;
}

function defaultArenaCheckEnd(game) {
  // Multi-faction friendly: tally living ships per side (excluding the
  // player, who is always on blue and shouldn't trip the blue-alive
  // check on his own). Match ends when only one side still has ships,
  // or when blue has nothing left but the player.
  const aliveBySide = new Map();
  for (const s of game.ships) {
    if (s.dead) continue;
    if (s.side === "blue" && s.isPlayer) continue;
    aliveBySide.set(s.side, (aliveBySide.get(s.side) || 0) + 1);
  }
  if (!aliveBySide.has("blue")) {
    // Player's faction wiped — whoever's still around wins.
    for (const side of aliveBySide.keys()) return side;
    return "red";
  }
  if (aliveBySide.size === 1) return "blue";
  return null;
}

function persistMatchResult(game) {
  saveStore.update((data) => {
    if (game.winner === "blue") data.stats.wins += 1;
    else data.stats.losses += 1;
    data.stats.kills += game.kills;
    data.stats.playtimeSeconds += game.elapsed;
    if (game.mode === "arena" && game.score > data.bestScores.arena) {
      data.bestScores.arena = game.score;
    }
    if (game.mode === "waves" && game.score > data.bestScores.waves) {
      data.bestScores.waves = game.score;
    }
    if (game.mode === "daily" && game.modeState && game.modeState.seed) {
      data.daily.lastSeed = game.modeState.seed;
      data.daily.lastScore = game.score;
      data.daily.lastResult = game.winner === "blue" ? "win" : "loss";
    }
  });
  saveStore.flush();
}

// Return to the start menu. The user picks a (possibly new) map size and
// startGame spawns a fresh match.
export function restart(game) {
  game.ships = [];
  game.projectiles = [];
  game.beams = [];
  game.wrecks = [];
  game.debris = [];
  game.wreckage = [];
  game.respawnTimer = 0;
  game.matchOver = false;
  game.winner = null;
  game.spectating = false;
  game.spectateTargetId = null;
  game.state = "menu";
  game.score = 0;
  game.kills = 0;
  game.elapsed = 0;
  game.modeState = null;
  rally.pending = null;
  rally.recentOrders = [];
}

// ---------------------------------------------------------------------------
// Damage rules.
//   Layered defence: shield → armor → hull.
//   Missiles bypass shields entirely (straight to armor / hull).
//   Shields are doubly effective vs lasers and fighter cannons: those weapons
//   cost only 50% of their damage from the shield bank.
//   Armor (big ships only) absorbs incoming damage at spec.armor.wearRate —
//   a 100-damage hit erodes ~50 armor by default — so a thick plate
//   "slowly deteriorates" rather than burning through in a single salvo.
// ---------------------------------------------------------------------------
function applyDamage(ship, p, attacker = null, world = null, hitPos = null) {
  let remaining = p.damage;
  const byPlayer = !!(attacker && attacker.isPlayer);

  // Step 1: Shield (unless missile, which bypasses).
  if (p.kind !== "missile" && ship.shieldMax > 0 && ship.shield > 0) {
    const isFighterRound = p.fromKlass === "fighter";
    const isLaser = p.kind === "laser";
    const shieldMul = (isFighterRound || isLaser) ? 0.5 : 1;
    ship.shieldHitTimer = 0;
    ship.shieldFlash = Math.min(1, ship.shieldFlash + 0.4);
    const shieldCost = remaining * shieldMul;
    if (shieldCost <= ship.shield) {
      ship.shield -= shieldCost;
      events.emit("hit", { ship, layer: "shield", amount: remaining, byPlayer });
      return; // shield ate the whole hit
    }
    // Shield breaks; convert remaining capacity back into incoming damage.
    const dmgAbsorbed = ship.shield / shieldMul;
    ship.shield = 0;
    remaining = remaining - dmgAbsorbed;
    if (remaining <= 0) {
      events.emit("hit", { ship, layer: "shield", amount: dmgAbsorbed, byPlayer });
      return;
    }
  }

  // Step 2: Armor (capitals). Wear at a reduced rate so plates last.
  if (ship.armorMax > 0 && ship.armor > 0 && ship.spec.armor) {
    const wearRate = ship.spec.armor.wearRate || 0.5;
    ship.armorFlash = Math.min(1, ship.armorFlash + 0.5);
    const armorWear = remaining * wearRate;
    if (armorWear <= ship.armor) {
      ship.armor -= armorWear;
      events.emit("hit", { ship, layer: "armor", amount: remaining, byPlayer });
      spawnHitDebris(world, ship, hitPos, "armor", remaining);
      return; // armor ate the whole hit
    }
    // Armor strips; convert remaining capacity back into incoming damage.
    const dmgAbsorbed = ship.armor / wearRate;
    ship.armor = 0;
    remaining = remaining - dmgAbsorbed;
    if (remaining <= 0) {
      events.emit("hit", { ship, layer: "armor", amount: dmgAbsorbed, byPlayer });
      spawnHitDebris(world, ship, hitPos, "armor", dmgAbsorbed);
      return;
    }
  }

  // Step 3: Subsystem (if the hit point lands on a node). The node soaks
  // incoming damage up to its remaining HP; overflow falls through to
  // hull. Destroying a node fires `subsystemDestroyed` so audio /
  // gameplay listeners can react, and dusts a small debris shower so
  // the destruction reads visually.
  if (hitPos && ship.subsystems && ship.subsystems.length > 0) {
    const node = findHitSubsystem(ship, hitPos);
    if (node) {
      node.flash = 1;
      if (remaining <= node.hp) {
        node.hp -= remaining;
        events.emit("hit", { ship, layer: "subsystem", amount: remaining, byPlayer });
        spawnHitDebris(world, ship, hitPos, "subsystem", remaining);
        return;
      }
      // Subsystem destroyed; overflow continues to hull.
      const absorbed = node.hp;
      node.hp = 0;
      node.destroyed = true;
      events.emit("subsystemDestroyed", { ship, kind: node.kind, byPlayer });
      events.emit("hit", { ship, layer: "subsystem", amount: absorbed, byPlayer });
      // Bigger fragment shower for a destroyed component.
      spawnHitDebris(world, ship, hitPos, "subsystem", Math.max(20, absorbed));
      remaining -= absorbed;
      if (remaining <= 0) return;
    }
  }

  // Step 4: Hull.
  ship.hp -= remaining;
  events.emit("hit", { ship, layer: "hull", amount: remaining, byPlayer });
  spawnHitDebris(world, ship, hitPos, "hull", remaining);
}

// Knock 1-3 small fragments off the hull at the impact point. Skipped
// for shield-layer hits (the shield ate it; nothing came off the hull).
function spawnHitDebris(world, ship, hitPos, layer, amount) {
  if (!world || !hitPos) return;
  if (layer !== "armor" && layer !== "hull" && layer !== "subsystem") return;
  // Scale fragments with the size of the bite the round took.
  // amount is raw damage post-shield. A fighter cannon round (~6 dmg)
  // shakes off one chip; a battleship broadside (~75 dmg) sheds a small
  // shower. Cap so even huge hits stay bounded.
  let count = 1;
  if (amount > 15) count = 2;
  if (amount > 40) count = 3;
  const frags = createDebrisBurst(ship.pos, hitPos, ship.vel, ship.klass, ship.side, count);
  pushDebris(world.debris, frags);
}

// ---------------------------------------------------------------------------
// Beam ticking. Heavy lasers are sustained beams: damage is spread over the
// beam's full lifetime so dps = total / duration. Each tick we deal
// (beam.dps * dt) to whatever target the beam is still locked onto, and
// re-anchor the origin to the owner's current muzzle so the beam follows
// the firing ship around. The beam dies early if the owner dies or loses
// its laser subsystem mid-fire.
// ---------------------------------------------------------------------------
function applyAndAgeBeams(game, dt) {
  if (!game.beams || game.beams.length === 0) return;
  for (const beam of game.beams) {
    if (!beam.applied) {
      // Verify target is still alive + still in range. If not, beam misses.
      const t = beam.target;
      if (t && !t.dead) {
        const dx = t.pos.x - beam.origin.x;
        const dy = t.pos.y - beam.origin.y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= beam.range * beam.range) {
          const attacker = beam.ownerId != null
            ? game.ships.find((s) => s.id === beam.ownerId)
            : null;
          applyDamage(t, { damage: beam.damage, kind: "laser", fromKlass: "battleship" }, attacker, game, { x: t.pos.x, y: t.pos.y });
          const armorBefore = t.armor;
          const hullBefore = t.hp;
          applyDamage(t, { damage: beam.damage, kind: "laser", fromKlass: "battleship" }, attacker);
          if (t.hp < hullBefore) {
            recordDamageMark(t, t.pos.x, t.pos.y, "hull", beam.damage);
          } else if (t.armor < armorBefore) {
            recordDamageMark(t, t.pos.x, t.pos.y, "armor", beam.damage);
          }
          if (t.hp <= 0) {
            t.dead = true;
            handleShipDestroyed(game, t, attacker);
          }
          beam.hit = { x: t.pos.x, y: t.pos.y };
        } else {
    // Re-anchor origin to the live owner so the beam tracks the firing
    // ship's bow as it manoeuvres. If the owner is gone or has lost the
    // laser subsystem since the beam started, kill the beam now.
    const owner = beam.ownerId != null
      ? game.ships.find((s) => s.id === beam.ownerId)
      : null;
    if (!owner || owner.dead || !hasWorkingSubsystem(owner, "laser")) {
      beam.ttl = 0;
      beam.hit = null;
      continue;
    }
    const fwd = { x: Math.cos(owner.heading), y: Math.sin(owner.heading) };
    beam.origin.x = owner.pos.x + fwd.x * owner.spec.radius * 0.9;
    beam.origin.y = owner.pos.y + fwd.y * owner.spec.radius * 0.9;

    const t = beam.target;
    if (t && !t.dead) {
      const dx = t.pos.x - beam.origin.x;
      const dy = t.pos.y - beam.origin.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= beam.range * beam.range) {
        const dmg = beam.dps * dt;
        applyDamage(
          t,
          { damage: dmg, kind: "laser", fromKlass: "battleship" },
          owner, game, { x: t.pos.x, y: t.pos.y },
        );
        if (t.hp <= 0) {
          t.dead = true;
          handleShipDestroyed(game, t, owner);
          beam.hit = null;
        } else {
          beam.hit = { x: t.pos.x, y: t.pos.y };
        }
      } else {
        beam.hit = null;
      }
    } else {
      beam.hit = null;
    }
    beam.ttl -= dt;
  }
  game.beams = game.beams.filter((b) => b.ttl > 0);
}

// Per-class score weights. Tuned roughly to combat threat: capitals are
// worth multiples of a fighter kill. Used by both arena and waves modes.
const SCORE_PER_KILL = {
  fighter: 10,
  bomber: 20,
  frigate: 40,
  cruiser: 80,
  battleship: 160,
  carrier: 200,
};

// Hard cap on simultaneous wreckage entries. When exceeded, oldest
// settled wrecks are pushed out so a long carrier-vs-carrier brawl
// can't accumulate draw cost forever.
const MAX_WRECKAGE = 80;

function handleShipDestroyed(game, ship, killer) {
  const byPlayer = !!(killer && killer.isPlayer);
  events.emit("shipDestroyed", { ship, killer, byPlayer });
  if (ship.isPlayer) events.emit("playerDestroyed", { ship });
  if (byPlayer && ship.side !== "blue") {
    game.kills += 1;
    game.score += SCORE_PER_KILL[ship.klass] || 10;
  }
  // Persistent wreckage: the broken hull stays on the map, and a
  // shower of small fragments blows out in every direction.
  pushWreck(game.wrecks, createWreck(ship));
  const isBig = ship.klass === "cruiser" || ship.klass === "battleship" || ship.klass === "carrier";
  const burstCount = isBig ? 14 : (ship.klass === "frigate" ? 10 : 7);
  pushDebris(game.debris, createDebrisBurst(ship.pos, ship.pos, ship.vel, ship.klass, ship.side, burstCount));
  // Break the hull into drifting wreckage. The chunks inherit position
  // + velocity from the ship and persist on the map.
  if (!game.wreckage) game.wreckage = [];
  const chunks = createWreckageChunks(ship);
  for (const c of chunks) game.wreckage.push(c);
  // If we blew past the cap, evict the oldest settled wrecks first so
  // still-flying debris keeps its motion.
  if (game.wreckage.length > MAX_WRECKAGE) {
    game.wreckage.sort((a, b) => {
      // Settled, older entries leave first.
      const sa = a.settled ? 1 : 0;
      const sb = b.settled ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return b.age - a.age;
    });
    game.wreckage.length = MAX_WRECKAGE;
  }
}

// ---------------------------------------------------------------------------
function resolveHeavyOverlap(ships, bounds) {
  const heavies = [];
  for (const s of ships) {
    if (s.dead) continue;
    if (s.klass === "frigate" || s.klass === "cruiser"
        || s.klass === "battleship" || s.klass === "carrier") {
      heavies.push(s);
    }
  }
  for (let iter = 0; iter < 4; iter++) {
    let pushed = false;
    for (let i = 0; i < heavies.length; i++) {
      for (let j = i + 1; j < heavies.length; j++) {
        const a = heavies[i], b = heavies[j];
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const minDist = a.spec.radius + b.spec.radius;
        const d2 = dx * dx + dy * dy;
        if (d2 < minDist * minDist) {
          const d = d2 > 1e-6 ? Math.sqrt(d2) : 0;
          const nx = d > 1e-6 ? dx / d : 1;
          const ny = d > 1e-6 ? dy / d : 0;
          const overlap = (minDist - d) * 0.5;
          a.pos.x -= nx * overlap;
          a.pos.y -= ny * overlap;
          b.pos.x += nx * overlap;
          b.pos.y += ny * overlap;
          pushed = true;
        }
      }
    }
    if (!pushed) break;
  }
  for (const s of heavies) {
    const r = s.spec.radius;
    if (s.pos.x < bounds.minX + r) s.pos.x = bounds.minX + r;
    if (s.pos.x > bounds.maxX - r) s.pos.x = bounds.maxX - r;
    if (s.pos.y < bounds.minY + r) s.pos.y = bounds.minY + r;
    if (s.pos.y > bounds.maxY - r) s.pos.y = bounds.maxY - r;
  }
}

function computePacks(ships) {
  const packs = new Map();
  for (const s of ships) {
    if (s.dead || s.packId == null) continue;
    let e = packs.get(s.packId);
    if (!e) {
      e = { side: s.side, role: s.packRole, posSum: { x: 0, y: 0 }, count: 0 };
      packs.set(s.packId, e);
    }
    e.posSum.x += s.pos.x; e.posSum.y += s.pos.y; e.count++;
  }
  for (const e of packs.values()) {
    e.center = { x: e.posSum.x / e.count, y: e.posSum.y / e.count };
    e.target = pickPackTarget(ships, e.side, e.center, e.role);
  }
  return packs;
}

function pickPackTarget(ships, side, center, role) {
  // Bombers outrank every role-preferred target — any fighter pack that
  // can see an enemy bomber peels off to swat it.
  let bestBomber = null, bestBomberD2 = Infinity;
  let bestPreferred = null, bestPreferredD2 = Infinity;
  let bestAny = null, bestAnyD2 = Infinity;
  for (const o of ships) {
    if (o.dead || o.side === side) continue;
    const dx = o.pos.x - center.x;
    const dy = o.pos.y - center.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestAnyD2) { bestAnyD2 = d2; bestAny = o; }
    if (o.klass === "bomber" && d2 < bestBomberD2) {
      bestBomberD2 = d2; bestBomber = o;
    }
    if (matchPackRole(o.klass, role) && d2 < bestPreferredD2) {
      bestPreferredD2 = d2; bestPreferred = o;
    }
  }
  return bestBomber || bestPreferred || bestAny;
}

function matchPackRole(klass, role) {
  switch (role) {
    case "hunt-fighter":     return klass === "fighter";
    case "strike-capital":   return klass === "cruiser" || klass === "battleship";
    case "skirmish-frigate": return klass === "frigate";
    default:                 return false;
  }
}
