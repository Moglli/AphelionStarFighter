import { ARENA, randomSpawnPos, createStarfield } from "./arena.js";
import { createShip, updateShip } from "./ship.js";
import { updateAI } from "./ai.js";
import { updateProjectile } from "./projectile.js";

const ROSTER = { fighter: 30, frigate: 5, cruiser: 2, battleship: 1 };
const RESPAWN_SECONDS = 2.0;
const FIGHTER_PACK_SIZE = 5;
const PACK_CLUSTER_RADIUS = 130; // jitter around pack center at spawn

// Roles cycle through packs at spawn so squadrons diverge instead of all
// converging on the same central target. Each role biases the pack's
// target selection toward a class.
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
  const game = {
    ships: [],
    projectiles: [],
    arena: ARENA,
    starfield: createStarfield(),
    playerController: { thrust: { x: 0, y: 0 }, aim: null, firing: false },
    respawnTimer: 0,
    matchOver: false,
    winner: null,
  };
  spawnRoster(game);
  return game;
}

function spawnRoster(game) {
  for (const side of ["blue", "red"]) {
    const zone = ARENA.spawn[side];
    const facing = side === "blue" ? 0 : Math.PI;
    for (const [klass, count] of Object.entries(ROSTER)) {
      if (klass === "fighter") {
        spawnFighterPacks(game, side, zone, count, facing);
      } else {
        for (let i = 0; i < count; i++) {
          const pos = randomSpawnPos(zone);
          const heading = facing + (Math.random() - 0.5) * 0.3;
          const ship = createShip({
            klass, side, pos, heading,
            controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false },
          });
          game.ships.push(ship);
        }
      }
    }
  }
  promotePlayer(game);
}

// Spawn fighters in tight clusters of FIGHTER_PACK_SIZE. Each pack gets a
// unique packId so the AI can target as a wing (see update() below).
function spawnFighterPacks(game, side, zone, count, facing) {
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
        side,
        pos,
        heading,
        controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false },
      });
      ship.packId = packId;
      ship.packRole = packRole;
      game.ships.push(ship);
    }
    remaining -= packSize;
  }
}

// Pick a friendly fighter and bind it to the player controller.
function promotePlayer(game) {
  const candidate = game.ships.find(
    (s) => s.side === "blue" && s.klass === "fighter" && !s.isPlayer && !s.dead,
  );
  if (!candidate) {
    // No friendly fighter alive — spawn a fresh one for the player.
    const ship = createShip({
      klass: "fighter",
      side: "blue",
      pos: randomSpawnPos(ARENA.spawn.blue),
      heading: 0,
      controller: game.playerController,
    });
    ship.isPlayer = true;
    game.ships.push(ship);
    return ship;
  }
  candidate.controller = game.playerController;
  candidate.isPlayer = true;
  // Move to spawn zone for a clean respawn feel.
  candidate.pos = randomSpawnPos(ARENA.spawn.blue);
  candidate.vel = { x: 0, y: 0 };
  candidate.hp = candidate.hpMax;
  candidate.heading = 0;
  return candidate;
}

export function update(game, dt) {
  // Pack centroids + shared targets — fighter packs engage as a wing.
  game.packs = computePacks(game.ships);

  // AI controllers update first (skip the player ship).
  for (const ship of game.ships) {
    if (ship.dead || ship.isPlayer) continue;
    updateAI(ship, game, dt);
  }
  // Player controller is already populated externally (input -> game.playerController).

  // Ship physics + firing.
  for (const ship of game.ships) {
    if (ship.dead) continue;
    updateShip(ship, dt, game);
  }

  // Heavies (frigate / cruiser / battleship) can't overlap each other.
  resolveHeavyOverlap(game.ships, game.arena.bounds);

  // Projectiles + collisions.
  for (const p of game.projectiles) {
    if (p.dead) continue;
    updateProjectile(p, dt);
    if (p.dead) continue;
    for (const ship of game.ships) {
      if (ship.dead || ship.side === p.side) continue;
      const dx = ship.pos.x - p.pos.x;
      const dy = ship.pos.y - p.pos.y;
      const r = ship.spec.radius + p.radius;
      if (dx * dx + dy * dy <= r * r) {
        ship.hp -= p.damage;
        p.dead = true;
        if (ship.hp <= 0) ship.dead = true;
        break;
      }
    }
  }

  // Cull dead projectiles.
  if (game.projectiles.length > 0) {
    game.projectiles = game.projectiles.filter((p) => !p.dead);
  }

  // Player death + respawn.
  const player = game.ships.find((s) => s.isPlayer);
  if (player && player.dead) {
    if (game.respawnTimer <= 0) game.respawnTimer = RESPAWN_SECONDS;
    game.respawnTimer -= dt;
    if (game.respawnTimer <= 0) {
      // Remove dead player marker, promote a new fighter.
      game.ships = game.ships.filter((s) => !(s.isPlayer && s.dead));
      promotePlayer(game);
      game.respawnTimer = 0;
    }
  }

  // Cull other dead ships (after player handling so we don't clobber the
  // dead-player marker before respawn fires).
  game.ships = game.ships.filter((s) => s.isPlayer || !s.dead);

  // Win check: a side wiped (excluding the always-respawning player).
  if (!game.matchOver) {
    const blueAlive = game.ships.some((s) => s.side === "blue" && !s.isPlayer && !s.dead);
    const redAlive  = game.ships.some((s) => s.side === "red"  && !s.dead);
    if (!redAlive) { game.matchOver = true; game.winner = "blue"; }
    else if (!blueAlive) { game.matchOver = true; game.winner = "red"; }
  }
}

export function restart(game) {
  game.ships = [];
  game.projectiles = [];
  game.respawnTimer = 0;
  game.matchOver = false;
  game.winner = null;
  spawnRoster(game);
}

// Separate any overlapping heavy hulls (frigate / cruiser / battleship) by
// pushing each pair apart along the axis between them. Fighters pass through
// freely — only the big hulls have ship-vs-ship collision. Run a few
// iterations so chained overlaps untangle in one tick (e.g., at spawn).
function resolveHeavyOverlap(ships, bounds) {
  const heavies = [];
  for (const s of ships) {
    if (s.dead) continue;
    if (s.klass === "frigate" || s.klass === "cruiser" || s.klass === "battleship") {
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
          // Coincident-center fallback: nudge along x.
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
  // Re-clamp to arena bounds in case a push shoved someone outside.
  for (const s of heavies) {
    const r = s.spec.radius;
    if (s.pos.x < bounds.minX + r) s.pos.x = bounds.minX + r;
    if (s.pos.x > bounds.maxX - r) s.pos.x = bounds.maxX - r;
    if (s.pos.y < bounds.minY + r) s.pos.y = bounds.minY + r;
    if (s.pos.y > bounds.maxY - r) s.pos.y = bounds.maxY - r;
  }
}

// Build a Map<packId, {center, target}> from current ships. Pack target is
// the enemy nearest to the pack centroid — packmates converge on the same
// foe instead of scattering after individually-closest enemies.
function computePacks(ships) {
  const packs = new Map();
  for (const s of ships) {
    if (s.dead || s.packId == null) continue;
    let e = packs.get(s.packId);
    if (!e) {
      e = { side: s.side, posSum: { x: 0, y: 0 }, count: 0 };
      packs.set(s.packId, e);
    }
    e.posSum.x += s.pos.x; e.posSum.y += s.pos.y; e.count++;
  }
  for (const e of packs.values()) {
    e.center = { x: e.posSum.x / e.count, y: e.posSum.y / e.count };
    let best = null, bestD2 = Infinity;
    for (const o of ships) {
      if (o.dead || o.side === e.side) continue;
      const dx = o.pos.x - e.center.x;
      const dy = o.pos.y - e.center.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = o; }
    }
    e.target = best;
  }
  return packs;
}
