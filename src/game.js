import { ARENA, randomSpawnPos, createStarfield, setArenaSize } from "./arena.js";
import { createShip, updateShip } from "./ship.js";
import { updateAI } from "./ai.js";
import { updateProjectile } from "./projectile.js";
import { RACES, RACE_KEYS, randomRaceKey, getStationDef } from "./races.js";
import { MODES } from "./modes/index.js";
import {
  worldToLocal, findHitModuleLocal, findSplashModulesLocal, moduleWorldPos,
} from "./modules.js";
import {
  updateParticle, spawnHitSparks, spawnDestructionBurst, spawnContinuousSmoke,
  spawnArmorFlakes, spawnHullBreakoff,
} from "./particles.js";
import { damageCellsInRadius, killCellsForModule } from "./sprites.js";
import { SIDES } from "./classes.js";

const RESPAWN_SECONDS = 2.0;
const FIGHTER_PACK_SIZE = 5;
const BOMBER_PACK_SIZE = 2;
const PACK_CLUSTER_RADIUS = 130;

// Every escortable ship spawns with a tight fighter escort. Escorts
// share a packId so the pack AI engages them as a wing centred on their
// charge, and the pack target picker prioritises bombers so any bomber
// threatening the charge gets swatted before it can deliver its payload.
// Bombers also rate an escort (small but enough to ward off lone
// interceptors) — they're the second-most-valuable strike asset after
// the capitals and were getting picked off solo before.
const ESCORT_SIZE = {
  bomber: 2,
  frigate: 5,
  cruiser: 10,
  battleship: 10,
  carrier: 15,
};

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
    // Particle VFX (sparks, smoke, fire, debris, shockwaves) live in
    // world space and tick alongside projectiles.
    particles: [],
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
    // Spectator camera. While `locked`, draw() follows the target ship;
    // a left-stick nudge during spectate flips `locked` to false and
    // lets the camera free-pan around the arena. Cycling Prev / Next
    // re-locks onto whichever ship the user picks.
    spectateCamera: { x: 0, y: 0, locked: true },
    // Lifecycle: "menu" before the player picks a map size, "playing"
    // once a match is in progress.
    state: "menu",
    // Per-side race selection. Allied is picked from the start menu;
    // Hostile is rolled at match start.
    alliedRace: "terran",
    hostileRace: "terran",
    // Game mode: "open" (fleet vs fleet, current default) or "defend"
    // (each side has a multi-node station; first station down loses).
    mode: "open",
    // Admiral-mode directive map. Populated by modes/admiral.js when
    // the player starts an Admiral match; null in all other modes so
    // the AI fast-paths through the directive check.
    directives: null,
    admiralMode: false,
  };
  return game;
}

// Centroid of all live ships of a given side. Used by the Admiral
// directives: HOLD ships pull back to their own side's centroid;
// PRESS ships aim toward the enemy's. Falls back to the spawn-zone
// centre if the side has been wiped — keeps a recall-order from
// producing NaN aim vectors.
export function fleetCenter(game, side) {
  let sx = 0, sy = 0, n = 0;
  for (const s of game.ships) {
    if (s.dead || s.side !== side) continue;
    sx += s.pos.x; sy += s.pos.y; n++;
  }
  if (n > 0) return { x: sx / n, y: sy / n };
  const zone = game.arena && game.arena.spawn && game.arena.spawn[side];
  return zone ? { x: zone.x, y: zone.y } : { x: 0, y: 0 };
}

// Called from main when the player picks map size + allied race + mode
// on the start menu. Hostile race is rolled here so the enemy
// composition is a surprise.
//
// Campaign mode passes a `campaign` config: { enemies, allies, playerOverride }.
// `enemies` and `allies` are roster maps that override the race-defined
// counts so mission difficulty can scale independently of race. The
// player ship is then promoted with `playerOverride` (a deepMerge-style
// patch describing purchased upgrades).
export function startGame(game, mapW, mapH, alliedRace = "terran", mode = "open", campaign = null, fleetMul = 1, customRoster = null) {
  setArenaSize(mapW, mapH);
  game.starfield = createStarfield();
  game.ships = [];
  game.projectiles = [];
  game.beams = [];
  game.particles = [];
  game.respawnTimer = 0;
  game.matchOver = false;
  game.winner = null;
  game.spectating = false;
  game.spectateTargetId = null;
  game.spectateCamera = { x: 0, y: 0, locked: true };
  game.alliedRace = RACES[alliedRace] ? alliedRace : "terran";
  game.hostileRace = randomRaceKey();
  // Mode whitelist: legacy values map to "open"; anything in MODES is
  // accepted verbatim. "campaign" stays as a special string so the
  // existing campaign-only branches in spawnRoster keep working.
  const knownLegacy = mode === "defend" || mode === "campaign" || mode === "open";
  game.mode = knownLegacy ? mode : (MODES[mode] ? mode : "open");
  game.state = "playing";
  game.campaign = campaign || null;
  game.playerSpecOverride = (campaign && campaign.playerOverride) || null;
  game.customRoster = customRoster || null;
  game.kills = 0;
  // Fleet-size multiplier from the menu. Clamped so a bad save / future
  // typo can't push the fleet to a frame-melting size.
  game.fleetMul = Math.max(0.25, Math.min(4, fleetMul));

  // Mode hook (custom, future modes): given a chance to override the
  // hostile race + roster before spawn. Falls back to the default
  // spawnRoster + promotePlayer flow if no hook fires.
  const modeHooks = MODES[game.mode];
  if (modeHooks && typeof modeHooks.setup === "function") {
    modeHooks.setup(game, {
      spawnRoster: (g, rosters) => spawnRoster(g, rosters),
      promotePlayer: (g) => promotePlayer(g),
    });
  } else {
    spawnRoster(game);
  }
}

function spawnRoster(game, rosterOverride = null) {
  for (const side of ["blue", "red"]) {
    const race = side === "blue" ? game.alliedRace : game.hostileRace;
    // Resolution order: explicit override (custom mode) > campaign
    // rosters > race-defined defaults. Override and campaign both
    // bypass the fleet-size multiplier — those numbers were chosen
    // deliberately.
    let roster;
    if (rosterOverride && rosterOverride[side]) {
      roster = rosterOverride[side];
    } else if (game.campaign) {
      roster = side === "blue" ? game.campaign.allies : game.campaign.enemies;
    } else {
      roster = (RACES[race] && RACES[race].roster) || RACES.terran.roster;
    }
    const zone = ARENA.spawn[side];
    const facing = side === "blue" ? 0 : Math.PI;
    // Apply fleet-size multiplier. Campaign + custom modes skip this
    // (the rosters are hand-set); free skirmish + Defend scale per
    // the menu chip. Every non-zero class is guaranteed at least one
    // ship so Small fleets don't accidentally drop a whole class.
    const mul = (game.campaign || rosterOverride) ? 1 : (game.fleetMul || 1);
    for (const [klass, count] of Object.entries(roster)) {
      if (count <= 0) continue;
      const scaled = Math.max(1, Math.round(count * mul));
      if (klass === "fighter") {
        spawnFighterPacks(game, side, race, zone, scaled, facing);
      } else if (klass === "bomber") {
        spawnBomberPairs(game, side, race, zone, scaled, facing);
      } else if (ESCORT_SIZE[klass]) {
        // Frigates, cruisers, battleships, and carriers each spawn with
        // a class-sized fighter escort attached to them.
        for (let i = 0; i < scaled; i++) {
          spawnCapitalWithEscort(game, klass, side, race, zone, facing);
        }
      } else {
        for (let i = 0; i < scaled; i++) {
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
    // Defend mode: one multi-node station per side, dropped at the
    // centre of that side's spawn zone (so the fleet sits between
    // the station and the contested middle of the map).
    if (game.mode === "defend") {
      spawnStation(game, side, race, zone, facing);
    }
  }
  if (!game.spectating) promotePlayer(game);
}

// Each station = N separate ships of klass "station" arranged at offsets
// from the spawn-zone centre. Each carries its own per-node weapon kit
// applied as a createShip specOverride.
function spawnStation(game, side, race, zone, facing) {
  const def = getStationDef(race);
  if (!def) return;
  const center = { x: zone.x, y: zone.y };
  const spread = def.spread || 240;
  for (const node of def.nodes) {
    const pos = {
      x: center.x + (node.offset.x || 0) * spread,
      y: center.y + (node.offset.y || 0) * spread,
    };
    const ship = createShip({
      klass: "station",
      race,
      side,
      pos,
      heading: facing,
      controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
      specOverride: node.mods,
    });
    ship.stationNodeName = node.name;
    game.ships.push(ship);
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
  const escortSize = ESCORT_SIZE.bomber || 0;
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
      const bomber = createShip({
        klass: "bomber",
        race,
        side,
        pos,
        heading,
        controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
      });
      game.ships.push(bomber);

      // Each bomber gets its own escort wing so the pack AI keeps them
      // glued to that specific bomber instead of drifting across the
      // pair. Same pack-role as capital escorts — hunt-fighter — so the
      // existing target picker upgrades them to an enemy fighter
      // threatening their charge.
      if (escortSize > 0) {
        const packId = nextPackId++;
        const ringR = bomber.spec.radius + Math.max(40, escortSize * 8);
        for (let j = 0; j < escortSize; j++) {
          const eang = (j / escortSize) * Math.PI * 2 + Math.PI / 2;
          const epos = {
            x: pos.x + Math.cos(eang) * ringR,
            y: pos.y + Math.sin(eang) * ringR,
          };
          const eheading = facing + (Math.random() - 0.5) * 0.3;
          const escort = createShip({
            klass: "fighter", race, side, pos: epos, heading: eheading,
            controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
          });
          escort.packId = packId;
          escort.packRole = "hunt-fighter";
          escort.escortOf = bomber.id;
          game.ships.push(escort);
        }
      }
    }
    remaining -= pairSize;
  }
}

// Capital + fighter escort squadron. Spawns one capital of `klass` and
// ESCORT_SIZE[klass] fighter escorts in a tight ring around it. Escorts
// share a packId so the pack AI engages them as a wing centred on the
// capital. Pack role is "hunt-fighter" — they screen against enemy
// small craft; the pack target picker still upgrades them to a bomber
// if one shows up. The first escort wears `escortOf` for HUD / debug.
function spawnCapitalWithEscort(game, klass, side, race, zone, facing) {
  const pos = randomSpawnPos(zone);
  const capital = createShip({
    klass, race, side, pos, heading: facing,
    controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
  });
  game.ships.push(capital);

  const escortSize = ESCORT_SIZE[klass] || 0;
  if (escortSize <= 0) return;
  const packId = nextPackId++;
  // Spread ring slightly so 15 fighters around a battleship don't
  // overlap each other at spawn.
  const ringR = capital.spec.radius + Math.max(70, escortSize * 6);
  for (let i = 0; i < escortSize; i++) {
    const ang = (i / escortSize) * Math.PI * 2;
    const epos = {
      x: pos.x + Math.cos(ang) * ringR,
      y: pos.y + Math.sin(ang) * ringR,
    };
    const heading = facing + (Math.random() - 0.5) * 0.3;
    const escort = createShip({
      klass: "fighter", race, side, pos: epos, heading,
      controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
    });
    escort.packId = packId;
    escort.packRole = "hunt-fighter";
    escort.escortOf = capital.id;
    game.ships.push(escort);
  }
}

function promotePlayer(game) {
  // Campaign mode always builds a FRESH player ship so purchased
  // upgrades (specOverride) apply cleanly. Reusing an existing
  // ally fighter would keep the unupgraded race baseline.
  const forceFresh = !!game.playerSpecOverride;
  const candidate = forceFresh ? null : game.ships.find(
    (s) => s.side === "blue" && s.klass === "fighter" && !s.isPlayer && !s.dead,
  );
  if (!candidate) {
    const ship = createShip({
      klass: "fighter",
      race: game.alliedRace,
      side: "blue",
      pos: randomSpawnPos(ARENA.spawn.blue),
      heading: 0,
      controller: game.playerController,
      specOverride: game.playerSpecOverride,
    });
    ship.isPlayer = true;
    game.ships.push(ship);
    return ship;
  }
  candidate.controller = game.playerController;
  candidate.isPlayer = true;
  candidate.pos = randomSpawnPos(ARENA.spawn.blue);
  candidate.vel = { x: 0, y: 0 };
  candidate.hp = candidate.hpMax;
  candidate.shield = candidate.shieldMax;
  candidate.shieldHitTimer = 999;
  candidate.heading = 0;
  candidate.missileCd = 0;
  if (candidate.spec.weapon && candidate.spec.weapon.capacity) {
    candidate.weaponAmmo = candidate.spec.weapon.capacity;
    candidate.weaponReloading = false;
    candidate.weaponReloadTimer = 0;
  }
  return candidate;
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
  // Start locked on whatever we picked; free-pan engages on stick nudge.
  if (tgt) game.spectateCamera = { x: tgt.pos.x, y: tgt.pos.y, locked: true };
  else game.spectateCamera = { x: game.arena.width / 2, y: game.arena.height / 2, locked: false };
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
  // Cycling re-locks the camera onto the new target — free-pan exits
  // the moment the user explicitly picks someone to watch.
  const t = alive[idx];
  game.spectateCamera = { x: t.pos.x, y: t.pos.y, locked: true };
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

    // Hit a ship.
    for (const ship of game.ships) {
      if (ship.dead || ship.side === p.side) continue;
      const dx = ship.pos.x - p.pos.x;
      const dy = ship.pos.y - p.pos.y;
      const r = ship.spec.radius + p.radius;
      if (dx * dx + dy * dy <= r * r) {
        const targets = computeModuleTargets(ship, p);
        applyDamage(ship, p, targets, game.particles);
        // Missiles always die on hit; cannons die on hit.
        p.dead = true;
        if (ship.hp <= 0) ship.dead = true;
        break;
      }
    }
  }

  // Beams: apply damage once, then tick down.
  applyAndAgeBeams(game, dt);

  if (game.projectiles.length > 0) {
    game.projectiles = game.projectiles.filter((p) => !p.dead);
  }

  // Particle VFX: continuous smoke / fire from damaged + disabled modules,
  // then tick existing particles.
  emitContinuousModuleVFX(game, dt);
  for (const p of game.particles) updateParticle(p, dt);
  if (game.particles.length > 0) {
    game.particles = game.particles.filter((p) => !p.dead);
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

  // Keep spectate target valid.
  if (game.spectating) {
    const tgt = getSpectateTarget(game);
    if (!tgt) {
      const next = pickSpectateInitial(game);
      game.spectateTargetId = next ? next.id : null;
    }
  }

  if (!game.matchOver) {
    if (game.mode === "defend") {
      // First side to lose every station node loses the match.
      const blueStation = game.ships.some(
        (s) => s.side === "blue" && s.klass === "station" && !s.dead);
      const redStation  = game.ships.some(
        (s) => s.side === "red"  && s.klass === "station" && !s.dead);
      if (!redStation)  { game.matchOver = true; game.winner = "blue"; }
      else if (!blueStation) { game.matchOver = true; game.winner = "red"; }
    } else {
      const blueAlive = game.ships.some((s) => s.side === "blue" && !s.isPlayer && !s.dead);
      const redAlive  = game.ships.some((s) => s.side === "red"  && !s.dead);
      if (!redAlive) { game.matchOver = true; game.winner = "blue"; }
      else if (!blueAlive) { game.matchOver = true; game.winner = "red"; }
    }
  }
}

// Return to the start menu. The user picks a (possibly new) map size and
// startGame spawns a fresh match.
export function restart(game) {
  game.ships = [];
  game.projectiles = [];
  game.beams = [];
  game.particles = [];
  game.respawnTimer = 0;
  game.matchOver = false;
  game.winner = null;
  game.spectating = false;
  game.spectateTargetId = null;
  game.state = "menu";
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
// Continuous module-state VFX. Each frame, for every damaged-but-alive
// module emit a thin smoke puff at a low rate, and for every disabled
// module emit thick dark smoke + occasional fire at a higher rate. The
// per-frame coin flip uses dt so the average rate is framerate-stable.
function emitContinuousModuleVFX(game, dt) {
  // Smoke rates per second.
  const DISABLED_RATE = 12;
  const DAMAGED_RATE = 3.5;
  for (const s of game.ships) {
    if (s.dead || !s.modules) continue;
    for (const m of s.modules) {
      let rate = 0;
      if (m.disabled) rate = DISABLED_RATE;
      else if (m.hp / m.hpMax < 0.5) rate = DAMAGED_RATE;
      else continue;
      // Poisson-style: probability = rate * dt of one emission this frame.
      if (Math.random() < rate * dt) {
        const wpos = moduleWorldPos(s, m.name);
        if (wpos) spawnContinuousSmoke(game.particles, wpos.x, wpos.y, m.disabled);
      }
    }
  }
}

// Decide which modules (if any) absorb a hit. Cannon/laser hits land on
// at most one module — the closest disc that contains the impact. Missile
// hits splash: the directly-hit module takes full damage and every other
// module within blast radius takes 50%. Laser beam damage skips module
// routing entirely (lasers carve through to central hull).
function computeModuleTargets(ship, p) {
  if (!ship.modules || ship.modules.length === 0) return null;
  if (p.kind === "laser") return null;
  const local = worldToLocal(ship, p.pos.x, p.pos.y);
  if (p.kind === "missile") {
    const blastR = ship.spec.radius * 0.30;
    const splash = findSplashModulesLocal(ship, local.x, local.y, blastR);
    if (splash.length === 0) return null;
    const direct = findHitModuleLocal(ship, local.x, local.y);
    return splash.map((m) => ({ module: m, weight: m === direct ? 1.0 : 0.5 }));
  }
  // Cannon / PD round.
  const hit = findHitModuleLocal(ship, local.x, local.y);
  return hit ? [{ module: hit, weight: 1.0 }] : null;
}

// Module HP fraction → damage stage 0-4. Mirrors the thresholds used by
// drawShip's progressive chip rendering so the visual stage and the
// transition-VFX trigger stay in lockstep.
function moduleStage(hp, hpMax) {
  if (hp <= 0)          return 4;
  const f = hp / hpMax;
  if (f > 0.80)         return 0;
  if (f > 0.55)         return 1;
  if (f > 0.30)         return 2;
  return 3;
}

// PD vs ship multiplier. Point-defence cannons are the screen against
// inbound missiles — their cannon rounds are *not* meant to be the
// primary damage source vs other ships. Without this nerf a frigate's
// 4-cannon PD bank (~92 dps inside the bubble) shreds fighters in
// well under a second, and capitals chip each other to death
// passively when they drift in range. Scaled to 22% damage vs ships
// so PD still plinks (deters loitering inside the bubble) but isn't
// the headline damage source it had become.
const PD_VS_SHIP_MUL = 0.22;

function applyDamage(ship, p, moduleTargets = null, particles = null) {
  let remaining = p.damage;
  if (p.fromKlass === "pd") remaining *= PD_VS_SHIP_MUL;

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
      return; // shield ate the whole hit
    }
    // Shield breaks; convert remaining capacity back into incoming damage.
    const dmgAbsorbed = ship.shield / shieldMul;
    ship.shield = 0;
    remaining = remaining - dmgAbsorbed;
    if (remaining <= 0) return;
  }

  // Step 2: Armor (capitals). Wear at a reduced rate so plates last.
  if (ship.armorMax > 0 && ship.armor > 0 && ship.spec.armor) {
    const wearRate = ship.spec.armor.wearRate || 0.5;
    ship.armorFlash = Math.min(1, ship.armorFlash + 0.5);
    const armorWear = remaining * wearRate;
    if (armorWear <= ship.armor) {
      ship.armor -= armorWear;
      recordArmorImpact(ship, p, remaining, particles);
      return; // armor ate the whole hit
    }
    // Armor strips; convert remaining capacity back into incoming damage.
    const dmgAbsorbed = ship.armor / wearRate;
    ship.armor = 0;
    // Big shed moment — pass the full absorbed amount so extra flakes spawn.
    recordArmorImpact(ship, p, dmgAbsorbed * 1.2, particles);
    remaining = remaining - dmgAbsorbed;
    if (remaining <= 0) return;
  }

  // Step 3: Damage now hits the hull (either via modules or directly).
  // Record a persistent hull scar + spawn breakoff fragments at the
  // impact point regardless of whether modules absorb part of the hit.
  recordHullImpact(ship, p, remaining, particles);

  // Step 3a: Chew the destructible cell grid at the hit point. Radius
  // scales with damage so a glancing fighter round chips a single cell
  // and a cruiser shell or missile rips out a cluster. With per-class
  // cell HP > 1 the budget approach drills inner-cells-first: a small
  // hit chips one pixel, a heavy hit shears a tight chunk. The 1.2x
  // cap prevents a single 200-dmg beam tick from punching a hole
  // straight through a battleship.
  if (ship.cells && p && p.pos) {
    const local = worldToLocal(ship, p.pos.x, p.pos.y);
    const chewR = chewRadius(ship, remaining);
    damageCellsInRadius(ship, local.x, local.y, chewR, remaining * 1.2);
  }

  if (moduleTargets && moduleTargets.length > 0) {
    for (const { module, weight } of moduleTargets) {
      if (module.disabled) continue;
      const dmg = remaining * weight;
      // Damage-stage tracking: each module steps through stages 0-4 as
      // its HP drops (matches drawShip's progressive chip rendering).
      // When we cross into a worse stage, fire a one-shot spark + smoke
      // puff so the transition reads as a discrete event rather than a
      // slow color drift.
      const prevStage = moduleStage(module.hp, module.hpMax);
      module.hp -= dmg;
      const newStage = moduleStage(module.hp, module.hpMax);
      module.flash = Math.min(1, module.flash + 0.6);
      if (particles) {
        const wpos = moduleWorldPos(ship, module.name);
        if (wpos) {
          spawnHitSparks(particles, wpos.x, wpos.y, 4);
          if (newStage > prevStage && newStage < 4) {
            spawnHitSparks(particles, wpos.x, wpos.y, 6);
            spawnContinuousSmoke(particles, wpos.x, wpos.y, false);
          }
        }
      }
      if (module.hp <= 0) {
        module.disabled = true;
        module.hp = 0;
        // Killing a subsystem ruptures part of the central hull too —
        // strip enough modules and the ship dies of cumulative breaches.
        ship.hp -= module.hullPenalty;
        // Tear out the cluster of cells bound to this module so the
        // ship's silhouette loses a recognisable chunk at the same time.
        if (ship.cells) killCellsForModule(ship, module.name);
        if (particles) {
          const wpos = moduleWorldPos(ship, module.name);
          if (wpos) {
            const moduleRadiusWorld = module.radius * ship.spec.radius;
            // Capital module deaths read 40% bigger — bigger shockwave,
            // more sparks/debris — than fighter engine pops.
            const intensity = ship.spec.armorMax > 0 ? 1.4 : 1.0;
            spawnDestructionBurst(particles, wpos.x, wpos.y, moduleRadiusWorld, intensity);
          }
        }
      }
    }
    return;
  }
  ship.hp -= remaining;
}

// Cell-damage radius for a given hit. Scales with damage so a glancing
// hit chips one or two pixels and a big shell shears a chunk. The cap
// keeps a single hit from clearing more than ~30% of a ship's grid
// extent — sustained fire still has to do the work of stripping the
// hull. The base is at least one full cell so a hit on the hull always
// lands at least one visible block, not a near-miss.
function chewRadius(ship, dmg) {
  const R = ship.spec && ship.spec.radius ? ship.spec.radius : 14;
  const cellSize = Math.max(ship.cellW || 6, ship.cellH || 6);
  const base = cellSize * 0.85;
  const scale = Math.min(R * 0.5, base + Math.sqrt(Math.max(0, dmg)) * 2.4);
  return scale;
}

// Record an armor impact: a chipped/scratched flake scar at the impact
// point on the ship-local frame, plus light-gray fragments tumbling
// outward in world space.
function recordArmorImpact(ship, p, dmg, particles) {
  if (!p || !p.pos) return;
  const local = worldToLocal(ship, p.pos.x, p.pos.y);
  addImpactScar(ship, "armor-flake", local.x, local.y, dmg);
  if (!particles) return;
  const ang = Math.atan2(p.pos.y - ship.pos.y, p.pos.x - ship.pos.x);
  spawnArmorFlakes(particles, p.pos.x, p.pos.y, dmg, ang);
}

// Record a hull impact: a dark gouge with hot rim that grows under
// sustained nearby fire, plus tinted hull fragments breaking off.
function recordHullImpact(ship, p, dmg, particles) {
  if (!p || !p.pos) return;
  const local = worldToLocal(ship, p.pos.x, p.pos.y);
  addImpactScar(ship, "hull-hole", local.x, local.y, dmg);
  if (!particles) return;
  const ang = Math.atan2(p.pos.y - ship.pos.y, p.pos.x - ship.pos.x);
  const tint = SIDES[ship.side].primary;
  spawnHullBreakoff(particles, p.pos.x, p.pos.y, dmg, tint, ang);
}

// Merge nearby same-kind scars into one growing mark; otherwise append
// a fresh entry. Bounded by MAX_SCARS so the array stays cheap to draw
// even after a long firefight. Scar size is capped relative to ship
// radius so a hole on a fighter doesn't eat the whole silhouette.
function addImpactScar(ship, kind, localX, localY, dmg) {
  const R = ship.spec && ship.spec.radius;
  if (!R) return;
  // Clamp to the silhouette so scars don't paint outside the hull.
  const rMax = R * 0.92;
  const d2 = localX * localX + localY * localY;
  if (d2 > rMax * rMax) {
    const d = Math.sqrt(d2);
    localX = localX / d * rMax;
    localY = localY / d * rMax;
  }
  const sizeCap = kind === "hull-hole" ? R * 0.17 : R * 0.13;
  const grow = Math.min(dmg * 0.055, sizeCap * 0.7);
  const mergeDist2 = (R * 0.18) * (R * 0.18);
  for (const s of ship.scars) {
    if (s.kind !== kind) continue;
    const dx = s.lx - localX;
    const dy = s.ly - localY;
    if (dx * dx + dy * dy < mergeDist2) {
      s.size = Math.min(sizeCap, s.size + grow);
      return;
    }
  }
  const MAX_SCARS = 26;
  if (ship.scars.length >= MAX_SCARS) {
    let idx = 0; let smallest = Infinity;
    for (let i = 0; i < ship.scars.length; i++) {
      if (ship.scars[i].size < smallest) { smallest = ship.scars[i].size; idx = i; }
    }
    ship.scars.splice(idx, 1);
  }
  ship.scars.push({
    kind,
    lx: localX,
    ly: localY,
    size: Math.max(1.2, grow),
    seed: Math.random(),
  });
}

// ---------------------------------------------------------------------------
// Beam ticking. The heavy laser is a SUSTAINED beam: each tick we
// re-anchor the origin to the owner's current bow (so the beam tracks
// the firing ship as it manoeuvres), deal `dps * dt` of damage to the
// target if it's still alive and in range, and kill the beam early if
// the owner ship has died or had its laser module shot off mid-fire.
// ---------------------------------------------------------------------------
function applyAndAgeBeams(game, dt) {
  if (!game.beams || game.beams.length === 0) return;
  for (const beam of game.beams) {
    // Owner check: if the firing ship died or its laser module is gone,
    // the beam dies immediately (forcing ttl <= 0 so it's filtered out
    // below). This prevents a beam from continuing to chew a target
    // after the player has destroyed its emitter.
    const owner = beam.ownerId != null
      ? game.ships.find((s) => s.id === beam.ownerId)
      : null;
    const ownerLaserOk = !owner || !owner.moduleByName
      || !owner.moduleByName.laser
      || !owner.moduleByName.laser.disabled;
    if (!owner || owner.dead || !ownerLaserOk) {
      beam.ttl = 0;
      beam.hit = null;
      continue;
    }
    // Re-anchor the visible beam origin to the owner's live bow.
    const fwd = { x: Math.cos(owner.heading), y: Math.sin(owner.heading) };
    beam.origin.x = owner.pos.x + fwd.x * owner.spec.radius * 0.9;
    beam.origin.y = owner.pos.y + fwd.y * owner.spec.radius * 0.9;

    // Apply this tick's damage to the target if still alive + in range.
    const t = beam.target;
    if (t && !t.dead) {
      const dx = t.pos.x - beam.origin.x;
      const dy = t.pos.y - beam.origin.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= beam.range * beam.range) {
        const tickDmg = beam.dps * dt;
        applyDamage(
          t,
          { damage: tickDmg, kind: "laser", fromKlass: "battleship", pos: { x: t.pos.x, y: t.pos.y } },
          null,
          game.particles,
        );
        if (t.hp <= 0) t.dead = true;
        beam.hit = { x: t.pos.x, y: t.pos.y };
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

// ---------------------------------------------------------------------------
function resolveHeavyOverlap(ships, bounds) {
  const heavies = [];
  for (const s of ships) {
    if (s.dead) continue;
    if (s.klass === "frigate" || s.klass === "cruiser"
        || s.klass === "battleship" || s.klass === "carrier"
        || s.klass === "station") {
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
          const overlap = minDist - d;
          // Stations are immobile — only the other hull gets shoved.
          const aImmovable = a.klass === "station";
          const bImmovable = b.klass === "station";
          if (aImmovable && bImmovable) continue;
          if (aImmovable) {
            b.pos.x += nx * overlap;
            b.pos.y += ny * overlap;
          } else if (bImmovable) {
            a.pos.x -= nx * overlap;
            a.pos.y -= ny * overlap;
          } else {
            a.pos.x -= nx * overlap * 0.5;
            a.pos.y -= ny * overlap * 0.5;
            b.pos.x += nx * overlap * 0.5;
            b.pos.y += ny * overlap * 0.5;
          }
          pushed = true;
        }
      }
    }
    if (!pushed) break;
  }
  for (const s of heavies) {
    if (s.klass === "station") continue; // never shove stations into bounds
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
