import { ARENA, randomSpawnPos, createStarfield } from "./arena.js";
import { createShip, updateShip } from "./ship.js";
import { updateAI } from "./ai.js";
import { updateProjectile } from "./projectile.js";

const ROSTER = { fighter: 30, frigate: 5, cruiser: 2, battleship: 1 };
const RESPAWN_SECONDS = 2.0;

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
      for (let i = 0; i < count; i++) {
        const pos = randomSpawnPos(zone);
        const heading = facing + (Math.random() - 0.5) * 0.3;
        const ship = createShip({
          klass,
          side,
          pos,
          heading,
          controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false },
        });
        game.ships.push(ship);
      }
    }
  }
  promotePlayer(game);
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
  // AI controllers update first (skip the player ship).
  for (const ship of game.ships) {
    if (ship.dead || ship.isPlayer) continue;
    updateAI(ship, game.ships, dt);
  }
  // Player controller is already populated externally (input -> game.playerController).

  // Ship physics + firing.
  for (const ship of game.ships) {
    if (ship.dead) continue;
    updateShip(ship, dt, game);
  }

  // Projectiles + collisions.
  for (const p of game.projectiles) {
    if (p.dead) continue;
    updateProjectile(p, dt);
    if (p.dead) continue;
    for (const ship of game.ships) {
      if (ship.dead || ship.side === p.side) continue;
      const dx = ship.pos.x - p.pos.x;
      const dy = ship.pos.y - p.pos.y;
      const r = ship.spec.radius;
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
