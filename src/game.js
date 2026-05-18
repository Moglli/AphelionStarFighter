import { ARENA, randomSpawnPos, createStarfield, setArenaSize } from "./arena.js";
import { createShip, updateShip } from "./ship.js";
import { updateAI } from "./ai.js";
import { updateProjectile } from "./projectile.js";

const ROSTER = { fighter: 30, frigate: 5, cruiser: 2, battleship: 1 };
const RESPAWN_SECONDS = 2.0;
const FIGHTER_PACK_SIZE = 5;
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
    // Lifecycle: "menu" before the player picks a map size, "playing"
    // once a match is in progress.
    state: "menu",
  };
  return game;
}

// Called from main when the player picks a map size on the start menu.
export function startGame(game, mapW, mapH) {
  setArenaSize(mapW, mapH);
  game.starfield = createStarfield();
  game.ships = [];
  game.projectiles = [];
  game.beams = [];
  game.respawnTimer = 0;
  game.matchOver = false;
  game.winner = null;
  game.spectating = false;
  game.spectateTargetId = null;
  game.state = "playing";
  spawnRoster(game);
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
            controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
          });
          game.ships.push(ship);
        }
      }
    }
  }
  if (!game.spectating) promotePlayer(game);
}

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
        controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
      });
      ship.packId = packId;
      ship.packRole = packRole;
      game.ships.push(ship);
    }
    remaining -= packSize;
  }
}

function promotePlayer(game) {
  const candidate = game.ships.find(
    (s) => s.side === "blue" && s.klass === "fighter" && !s.isPlayer && !s.dead,
  );
  if (!candidate) {
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
        applyDamage(ship, p);
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
    const blueAlive = game.ships.some((s) => s.side === "blue" && !s.isPlayer && !s.dead);
    const redAlive  = game.ships.some((s) => s.side === "red"  && !s.dead);
    if (!redAlive) { game.matchOver = true; game.winner = "blue"; }
    else if (!blueAlive) { game.matchOver = true; game.winner = "red"; }
  }
}

// Return to the start menu. The user picks a (possibly new) map size and
// startGame spawns a fresh match.
export function restart(game) {
  game.ships = [];
  game.projectiles = [];
  game.beams = [];
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
function applyDamage(ship, p) {
  let remaining = p.damage;

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
      return; // armor ate the whole hit
    }
    // Armor strips; convert remaining capacity back into incoming damage.
    const dmgAbsorbed = ship.armor / wearRate;
    ship.armor = 0;
    remaining = remaining - dmgAbsorbed;
    if (remaining <= 0) return;
  }

  // Step 3: Hull.
  ship.hp -= remaining;
}

// ---------------------------------------------------------------------------
// Beam ticking. Each beam applies its damage to the locked target on the
// first frame it exists, then lingers as visual for `ttl` seconds.
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
          applyDamage(t, { damage: beam.damage, kind: "laser", fromKlass: "battleship" });
          if (t.hp <= 0) t.dead = true;
          beam.hit = { x: t.pos.x, y: t.pos.y };
        } else {
          beam.hit = null;
        }
      } else {
        beam.hit = null;
      }
      beam.applied = true;
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
  let bestPreferred = null, bestPreferredD2 = Infinity;
  let bestAny = null, bestAnyD2 = Infinity;
  for (const o of ships) {
    if (o.dead || o.side === side) continue;
    const dx = o.pos.x - center.x;
    const dy = o.pos.y - center.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestAnyD2) { bestAnyD2 = d2; bestAny = o; }
    if (matchPackRole(o.klass, role) && d2 < bestPreferredD2) {
      bestPreferredD2 = d2; bestPreferred = o;
    }
  }
  return bestPreferred || bestAny;
}

function matchPackRole(klass, role) {
  switch (role) {
    case "hunt-fighter":     return klass === "fighter";
    case "strike-capital":   return klass === "cruiser" || klass === "battleship";
    case "skirmish-frigate": return klass === "frigate";
    default:                 return false;
  }
}
