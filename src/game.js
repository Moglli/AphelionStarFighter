import { ARENA, randomSpawnPos, createStarfield, setArenaSize } from "./arena.js";
import { createShip, updateShip, isShipDestroyed } from "./ship.js";
import { updateAI } from "./ai.js";
import { updateProjectile } from "./projectile.js";
import { RACES, RACE_KEYS, randomRaceKey, getStationDef } from "./races.js";
import { MODES } from "./modes/index.js";
import { defaultDirectives } from "./modes/admiral.js";
import { applyFleetPlan } from "./fleetcommand.js";
import {
  worldToLocal, findHitModuleLocal, findSplashModulesLocal, moduleWorldPos,
} from "./modules.js";
import {
  updateParticle, spawnHitSparks, spawnDestructionBurst, spawnContinuousSmoke,
  spawnEnginePlumeVFX, spawnHullVentVFX,
  spawnArmorFlakes, spawnHullBreakoff,
  spawnShieldImpact,
} from "./particles.js";
import { damageCellsInRadius, killCellsForModule, projectileBlockHit, projectileBlockHitCell } from "./sprites.js";
import { SIDES } from "./classes.js";
import {
  createWreck, createDebrisBurst,
  updateWreck, updateDebris,
  pushWreck, pushDebris,
} from "./wreckage.js";
import { events } from "./events.js";
import { PERKS, TRAITS, applyCaptainTraitEffects, applyDoctrineEffects, applyBehaviorEffects, pickCaptainCommLine, applyCapitalVariantEffects, applyCommanderPerks } from "./roguelite.js";
import { deepMerge } from "./races.js";

const FIGHTER_PACK_SIZE = 5;
const BOMBER_PACK_SIZE = 2;
const PACK_CLUSTER_RADIUS = 130;

// Per-charge escort *demand* (in fighters). Used at battle start by
// `assignEscortPacks` to claim fighter packs out of the free pool and
// stamp them with `escortOf = charge.id`. Ships no longer spawn with
// escorts attached — they spawn solo, and the assignment step pairs
// them with the nearest fighters. When the fighter pool can't cover
// every demand, charges are filled in `ESCORT_PRIORITY` order:
//   battleship → cruiser → carrier → bomber → frigate
// so the rare heavy capitals get their full screen first, bombers
// still pick up their pair (small but anti-interceptor screen), and
// frigates fly naked when fighters run out.
export const ESCORT_SIZE = {
  battleship: 10,
  cruiser: 10,
  carrier: 15,
  bomber: 2,
  frigate: 5,
};
const ESCORT_PRIORITY = ["battleship", "cruiser", "carrier", "bomber", "frigate"];

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
    // Persistent battle litter — wrecks are the broken hulls of
    // destroyed ships; debris is the chunky shrapnel chipped off live
    // hulls under fire OR showered out on destruction. Both persist
    // for the rest of the match (capped inside wreckage.js).
    wrecks: [],
    debris: [],
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
// Roguelite mode passes a `modeConfig` bundle: { blue, red,
// hostileRace, battleMode, capitalsManifest, playerSpecOverride,
// run, node }. `blue`/`red` are roster maps that override the
// race-defined counts; `capitalsManifest` is an ordered per-instance
// HP array so wounded capitals respawn at the right hull%. Other modes
// pass null — they fall through to the race-defined rosters.
export function startGame(game, mapW, mapH, alliedRace = "terran", mode = "open", modeConfig = null, fleetMul = 1, customRoster = null) {
  setArenaSize(mapW, mapH);
  game.starfield = createStarfield();
  game.ships = [];
  game.projectiles = [];
  game.beams = [];
  game.particles = [];
  game.wrecks = [];
  game.debris = [];
  game.respawnTimer = 0;
  game.matchOver = false;
  game.winner = null;
  game._matchEndedEmitted = false;
  // Player elimination state. A destroyed player ship NO LONGER
  // respawns — the pilot is out of the cockpit for the rest of the
  // battle and drops to spectate. `playerEliminated` gates the
  // spectate toggle (can't return to the cockpit). `playerKIA` (set
  // only when a Frontier survival roll FAILS) is what matchEnded reads
  // to end the run — distinct from "ship dead" so a survived-but-
  // ejected pilot, or a voluntary spectator, isn't mistaken for KIA.
  // `playerHandedToAiId` remembers the hull handed to AI on voluntary
  // spectate so exitSpectate can re-bind it.
  game.playerEliminated = false;
  game.playerKIA = false;
  game.playerHandedToAiId = null;
  game.playerKIAEvent = null;
  // Per-death roll guard (so the survival check fires once per death).
  game.playerDeathResolved = false;
  // Seconds remaining to show the "ship destroyed → observing" banner
  // after the player is eliminated. Counts down in update().
  game.eliminationNoticeTimer = 0;
  // Stall watchdog: tracks how long since the last damage event. If the
  // arena goes idle (no hits dealt on either side for STALL_LIMIT
  // seconds), the match force-ends as a draw — heading-locked craft
  // sometimes wander into pockets they don't escape, and without this
  // the player has no way out short of a quit. Reset to 0 on every
  // applyDamage call.
  game.stallTimer = 0;
  // Admiral focus-fire target. Set when the admiral taps an enemy
  // ship; the AI prefers it for every blue ship. Cleared on a fresh
  // match so stale focus doesn't leak across runs.
  game.focusTargetId = null;
  game.endedByStall = false;
  // Career-summary stash (set by main.js's runEnded handler when a
  // Frontier run ends). Cleared on every new match so a fresh
  // skirmish doesn't show stale rank text.
  game.runSummary = null;
  game.spectating = false;
  game.spectateTargetId = null;
  game.spectateCamera = { x: 0, y: 0, locked: true };
  // Reset admiral state EVERY start. Mode setup hooks (admiral.js,
  // roguelite.js) flip admiralMode back on if the player picked
  // COMMAND FLEET — but the default must be off, otherwise admiral
  // HUD chrome bleeds into the next pilot-mode match.
  game.admiralMode = false;
  // `_admiralByToggle` marks an admiral view entered MID-BATTLE via the HUD
  // toggle (vs. a mode that starts in admiral) — so RESUME PILOT knows to
  // hand the ship back. Reset every match so it never bleeds.
  game._admiralByToggle = false;
  // Directives now default-initialise for EVERY mode (was null). All
  // classes start free/on, so applyAdmiralPosture early-returns and the
  // missile gate is a no-op → zero behaviour change until the player issues
  // orders. admiral.js / roguelite.js still re-assign their own defaults.
  game.directives = defaultDirectives();
  // Per-side per-class tallies for the after-action report. Each
  // entry counts ships of that class that died on that side during
  // this match. Read by main.js#captureBattleOutcome + the match-over
  // panel renderer.
  const emptyTally = () => ({ fighter: 0, bomber: 0, frigate: 0, cruiser: 0, battleship: 0, carrier: 0, station: 0 });
  game.tallies = { blue: emptyTally(), red: emptyTally() };
  // Per-match combat telemetry for the end-of-battle report (all modes).
  initBattleStats(game);
  // After-action report stashed by main.js#matchEnded so the match-
  // over panel renders kills + losses + reward chips. Reset every
  // startGame so a stale report doesn't bleed into the new match.
  game.lastBattleReport = null;
  // In-battle captain comms (Tier 39). Fading chat strip on the HUD.
  // Cleared every match start so a stale line doesn't bleed.
  game.captainComms = [];
  // Set when victory comm fires, so it only fires once per match.
  game._victoryCommFired = false;
  game.alliedRace = RACES[alliedRace] ? alliedRace : "terran";
  game.hostileRace = randomRaceKey();
  // Mode whitelist: legacy values map to "open"; anything in MODES is
  // accepted verbatim.
  const knownLegacy = mode === "defend" || mode === "open";
  game.mode = knownLegacy ? mode : (MODES[mode] ? mode : "open");
  game.state = "playing";
  // modeConfig was renamed from "campaign" — it now carries roguelite
  // payload OR any future mode's per-match config bundle.
  game.modeConfig = modeConfig || null;
  // rogueliteContext is the spawn-time scratch space: capitalsManifest
  // and current pop pointers used by spawnCapital. Mode setup
  // hook stashes here.
  game.rogueliteContext = null;
  game.playerSpecOverride = (modeConfig && modeConfig.playerSpecOverride) || null;
  // Persistent player-ship design (Shipyard meta-progression). Routed
  // through createShip alongside specOverride; resolved last so
  // component patches stack on top of perks / traits / boons.
  game.playerDesign = (modeConfig && modeConfig.playerDesign) || null;
  // Resolve perk-driven player overrides (roguelite). The perk sentinel
  // is stamped by buildModeConfig in roguelite.js; resolve it here against
  // the actual fighter spec so promotePlayer gets a normal specOverride.
  if (game.playerSpecOverride && game.playerSpecOverride._perkKey) {
    const key = game.playerSpecOverride._perkKey;
    const perk = PERKS[key];
    if (perk && perk.playerOverride) {
      const baseSpec = (RACES[game.alliedRace] || RACES.terran).fighter || {};
      // Patch the player ship using race-resolved fighter spec; createShip
      // re-resolves the full spec so this patch only needs to carry fields
      // that perks tweak.
      const patch = perk.playerOverride({
        turnRate: baseSpec.turnRate || 3.2,
        hp: baseSpec.hp || 35,
      });
      delete game.playerSpecOverride._perkKey;
      Object.assign(game.playerSpecOverride, patch);
    }
  }
  if (game.playerSpecOverride && game.playerSpecOverride._fortifiedBridge) {
    delete game.playerSpecOverride._fortifiedBridge;
    // +20% HP. Resolved against base since we don't have spec here yet;
    // createShip honours the patch via deepMerge.
    game.playerSpecOverride.hp = Math.round(35 * 1.20);
  }

  // Active boons — buildModeConfig sends the run's boon list through
  // so spawnRoster can patch each BLUE ship's spec at createShip time
  // (capital HP from reinforced-prows, cannon spread from precog-
  // targeting, etc.). Stored on `game` so spawn-time helpers in
  // ship.js (carrier replenishment launches) can read it via `world`.
  game.activeBoons = (modeConfig && modeConfig.activeBoons) || [];
  game.activeFleetTraits = (modeConfig && modeConfig.activeFleetTraits) || [];
  // Pre-battle doctrine (Tier 34) — modifies every blue capital's AI
  // for this match. Default "skirmish" is a small turn-rate buff.
  game.battleDoctrine = (modeConfig && modeConfig.battleDoctrine) || "skirmish";

  // Officer traits — buildModeConfig stamps `_traitKeys: [...]` on the
  // override. Each trait's `playerOverride(effectiveSpec)` reads the
  // CURRENT effective fighter spec (base + prior traits) and returns a
  // partial deep-merged onto the working spec. Reading the effective
  // spec — not the base — means traits stack multiplicatively when
  // they touch the same field: Steady Hand (+10% damage) then
  // Defensive Driver (-5%) lands at base × 1.10 × 0.95 instead of one
  // overwriting the other.
  if (game.playerSpecOverride && Array.isArray(game.playerSpecOverride._traitKeys)) {
    const keys = game.playerSpecOverride._traitKeys;
    delete game.playerSpecOverride._traitKeys;
    const baseSpec = (RACES[game.alliedRace] || RACES.terran).fighter || {};
    let effective = baseSpec;
    for (const k of keys) {
      const trait = TRAITS[k];
      if (!trait || !trait.playerOverride) continue;
      const patch = trait.playerOverride(effective);
      effective = deepMerge(effective, patch);
    }
    // Bake the chained effective spec onto the override. createShip
    // re-resolves the race spec then deep-merges this, so any field
    // we DIDN'T touch stays at the resolved base.
    game.playerSpecOverride = deepMerge(game.playerSpecOverride, effective);
  }
  game.customRoster = customRoster || null;
  game.kills = 0;
  // Fleet-size multiplier from the menu. Clamped so a bad save / future
  // typo can't push the fleet to a frame-melting size.
  game.fleetMul = Math.max(0.25, Math.min(4, fleetMul));

  // Mode hook (custom, roguelite, future modes): given a chance to
  // override the hostile race + roster before spawn. Falls back to the
  // default spawnRoster + promotePlayer flow if no hook fires.
  const modeHooks = MODES[game.mode];
  if (modeHooks && typeof modeHooks.setup === "function") {
    modeHooks.setup(game, {
      spawnRoster: (g, rosters) => spawnRoster(g, rosters),
      promotePlayer: (g) => promotePlayer(g),
    });
  } else {
    spawnRoster(game);
  }

  // Apply the pre-battle Fleet Plan (per-class directives + ad-hoc wings)
  // to the spawned blue fleet — all non-Frontier modes. Roguelite carries
  // no `fleetPlan` (it stamps wings from run state inside its own setup),
  // so this is a no-op there and leaves that path untouched.
  const fleetPlan = game.modeConfig && game.modeConfig.fleetPlan;
  if (fleetPlan) applyFleetPlan(game, fleetPlan);
}

function spawnRoster(game, rosterOverride = null) {
  // Roguelite capitals manifest: per-instance HP+id, popped in order
  // for blue capitals so a wounded battleship from the last battle
  // spawns at its recorded hull%. Only used for the blue side; red
  // capitals always spawn fresh.
  const manifest = (game.modeConfig && game.modeConfig.capitalsManifest)
    ? game.modeConfig.capitalsManifest.slice()
    : null;

  for (const side of ["blue", "red"]) {
    // Resolution order:
    //   1. Multi-faction list (`blueTeams`/`redTeams`) — Custom mode
    //      with multiple factions sharing this side.
    //   2. Single-faction override (`blue`/`red`) — legacy custom +
    //      roguelite shape.
    //   3. Default race roster — open / defend / admiral / etc.
    // Cases 1+2 (i.e. ANY override) skip the fleet-size multiplier:
    // counts are taken as authored.
    const teamsKey = side + "Teams";
    const teams = (rosterOverride && Array.isArray(rosterOverride[teamsKey]) && rosterOverride[teamsKey].length > 0)
      ? rosterOverride[teamsKey]
      : null;

    const zone = ARENA.spawn[side];
    const facing = side === "blue" ? 0 : Math.PI;
    const mul = rosterOverride ? 1 : (game.fleetMul || 1);

    const spawnOne = (race, roster) => {
      // Compute total escort *demand* from the capitals in this roster.
      // Capitals no longer spawn with escorts attached — those fighters
      // are now part of the open fighter pool — so for the default
      // rosters we bump the fighter count by the escort demand to keep
      // total fighter-density similar to the pre-assignment behaviour.
      // Custom Match + Frontier (anything that passes `rosterOverride`)
      // honours its authored counts verbatim, so the bump is skipped
      // there.
      let escortDemand = 0;
      if (!rosterOverride) {
        for (const [k, c] of Object.entries(roster)) {
          if (ESCORT_SIZE[k] && c > 0) escortDemand += ESCORT_SIZE[k] * c;
        }
      }
      for (const [klass, count] of Object.entries(roster)) {
        if (count <= 0) continue;
        const scaled = Math.max(1, Math.round(count * mul));
        if (klass === "fighter") {
          spawnFighterPacks(game, side, race, zone, scaled + escortDemand, facing);
        } else if (klass === "bomber") {
          spawnBomberPairs(game, side, race, zone, scaled, facing);
        } else if (ESCORT_SIZE[klass]) {
          for (let i = 0; i < scaled; i++) {
            let wounded = null;
            if (side === "blue" && manifest) {
              // Match by klass AND race so a wounded native frigate and
              // a captured (different-race) frigate each pop the right
              // hpFrac + instanceId. Manifest race null = allied race.
              const idx = manifest.findIndex(
                (m) => m.klass === klass && (m.race || game.alliedRace) === race,
              );
              if (idx !== -1) {
                wounded = manifest[idx];
                manifest.splice(idx, 1);
              }
            }
            spawnCapital(game, klass, side, race, zone, facing, wounded);
          }
        } else {
          for (let i = 0; i < scaled; i++) {
            const pos = randomSpawnPos(zone);
            const heading = facing + (Math.random() - 0.5) * 0.3;
            const ship = createShip({
              klass, race, side, pos, heading,
              controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
              boons: side === "blue" ? game.activeBoons : null,
              fleetTraits: side === "blue" ? game.activeFleetTraits : null,
            });
            game.ships.push(ship);
          }
        }
      }
    };

    if (teams) {
      for (const t of teams) {
        if (!t || !t.race || !t.counts) continue;
        spawnOne(t.race, t.counts);
      }
    } else {
      const race = side === "blue" ? game.alliedRace : game.hostileRace;
      const roster = (rosterOverride && rosterOverride[side])
        ? rosterOverride[side]
        : ((RACES[race] && RACES[race].roster) || RACES.terran.roster);
      spawnOne(race, roster);
    }

    // Defend mode: one multi-node station per side, dropped at the
    // centre of that side's spawn zone. Always uses the *primary*
    // race for visual identity (first team or game.alliedRace/
    // hostileRace).
    if (game.mode === "defend") {
      const stationRace = teams ? teams[0].race
        : (side === "blue" ? game.alliedRace : game.hostileRace);
      spawnStation(game, side, stationRace, zone, facing);
    }
  }
  // Now that every ship is on the board, walk both sides and assign
  // fighter packs to capitals as escorts. Capitals no longer spawn
  // with escorts attached — they spawn solo and the assignment step
  // pairs them with the nearest unclaimed packs (largest capitals
  // get first pick).
  assignEscortPacks(game);
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
      boons: side === "blue" ? game.activeBoons : null,
      fleetTraits: side === "blue" ? game.activeFleetTraits : null,
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
        boons: side === "blue" ? game.activeBoons : null,
        fleetTraits: side === "blue" ? game.activeFleetTraits : null,
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
// threat that pulls fighter attention. They spawn solo (no escorts) —
// fighter packs are assigned to *capital* charges post-spawn by
// `assignEscortPacks`; bombers fend for themselves.
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
      const bomber = createShip({
        klass: "bomber",
        race,
        side,
        pos,
        heading,
        controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
        boons: side === "blue" ? game.activeBoons : null,
        fleetTraits: side === "blue" ? game.activeFleetTraits : null,
      });
      game.ships.push(bomber);
    }
    remaining -= pairSize;
  }
}

// Spawns one capital of `klass`, no escorts. The escort pairing
// happens later via `assignEscortPacks` once every ship is on the
// board — fighter packs spawned by `spawnFighterPacks` get their
// `escortOf` stamped to the nearest unclaimed capital.
function spawnCapital(game, klass, side, race, zone, facing, wounded = null) {
  const pos = randomSpawnPos(zone);
  const capital = createShip({
    klass, race, side, pos, heading: facing,
    controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
    // Roguelite carryover — start the capital at the previous battle's
    // hull%. Shields/armor still spawn at max each match.
    initialHpFrac: wounded ? wounded.hpFrac : 1,
    boons: side === "blue" ? game.activeBoons : null,
    fleetTraits: side === "blue" ? game.activeFleetTraits : null,
  });
  // Stamp the run-state instanceId so captureBattleOutcome can match
  // this live ship back to its slot in run.capitals when the match ends.
  if (wounded) capital.runtimeInstanceId = wounded.instanceId;
  // Surrender gating for enemy capitals — bosses and aces never strike
  // colors. Boss/elite nodes are the climactic encounters; surrender
  // would undercut the drama. Stamps `ship.neverSurrender = true`
  // which the surrender check in ship.js#updateShip respects alongside
  // the captain trait check.
  if (side === "red" && game.pendingNode) {
    const nodeType = game.pendingNode.type;
    if (nodeType === "boss" || nodeType === "elite") {
      capital.neverSurrender = true;
    }
  }
  // Captain XP/level (Tier 32) — surviving capitals carry a level
  // into the next battle. Apply HP multiplier from captain level so
  // a "Veteran" frigate spawns with +5% hull. We scale hpMax + hp
  // post-construction (initialHpFrac already applied to spec.hp).
  if (wounded && wounded.level && wounded.level > 1) {
    const hpMul = 1 + 0.05 * Math.max(0, Math.min(4, wounded.level - 1));
    capital.hpMax = capital.hpMax * hpMul;
    capital.hp = capital.hp * hpMul;
  }
  // Capital variant (Tier 40) — Heavy/Hunter/Siege/etc. spec patches.
  // Applied BEFORE captain trait so trait stacks on top of variant.
  if (wounded && wounded.variant) {
    capital.spec = { ...capital.spec };
    applyCapitalVariantEffects(capital, wounded.variant);
  }
  // Captain personality (Tier 33) — mutates spec stats so an aggressive
  // captain's ship closes range, veteran's ship shoots tighter, etc.
  // Clone the spec first so we don't poison the per-class cached spec
  // (createShip already cloned via the boons/traits pipeline if those
  // applied, but if neither did the spec is still a reference).
  if (wounded && wounded.captainTrait) {
    capital.spec = { ...capital.spec };
    applyCaptainTraitEffects(capital, wounded.captainTrait);
  }
  // Commander perks (level-up picks) — stack on top of trait/variant.
  if (wounded && Array.isArray(wounded.perks) && wounded.perks.length) {
    applyCommanderPerks(capital, wounded.perks);
  }
  // Fleet doctrine (Tier 34) — applies on BLUE capitals only. Stacks
  // on top of captain trait effects so PRESS + Aggressive captain
  // compounds the close-range bias. SKIPPED if the capital has its
  // own per-ship behavior override (Tier 37) — that takes precedence.
  if (side === "blue") {
    if (wounded && wounded.behavior) {
      capital.spec = { ...capital.spec };
      applyBehaviorEffects(capital, wounded.behavior);
    } else if (game.battleDoctrine) {
      capital.spec = { ...capital.spec };
      applyDoctrineEffects(capital, game.battleDoctrine);
    }
  }
  // Stamp captain identity onto the live ship for comms attribution.
  if (wounded) {
    capital.commCaptain = wounded.captain || null;
    capital.commShipName = wounded.name || null;
    capital.commTrait = wounded.captainTrait || null;
    // Stamp the full captain block (with neverSurrender bool) so the
    // surrender check in ship.js#updateShip can gate on it.
    capital.captain = {
      name: wounded.captain || null,
      trait: wounded.captainTrait || null,
      neverSurrender: wounded.captainTrait === "never-surrender",
    };
  }
  game.ships.push(capital);
}

// Push a captain comm into the live battle queue. Bounded to the last
// 20 entries so a long brawl doesn't grow the array forever; the HUD
// only ever renders the most recent 4 anyway. `vars` is an optional
// substitution map ({other: shipName}) for templates with ${other}.
export function pushCaptainComm(game, ship, trigger, vars) {
  if (!game || !ship || !ship.commCaptain) return;
  const line = pickCaptainCommLine(trigger, ship.commTrait, {
    captain: ship.commCaptain,
    ship: ship.commShipName || ship.klass,
    ...(vars || {}),
  });
  if (!line) return;
  if (!Array.isArray(game.captainComms)) game.captainComms = [];
  game.captainComms.push({
    captain: ship.commCaptain,
    ship: ship.commShipName || ship.klass,
    text: line,
    trigger,
    ts: performance.now(),
  });
  if (game.captainComms.length > 20) {
    game.captainComms.splice(0, game.captainComms.length - 20);
  }
}

// Post-spawn escort assignment. Runs once at the end of spawnRoster,
// after every ship is on the board. Walks each side's charges in the
// fixed `ESCORT_PRIORITY` order (BB → cruiser → carrier → bomber →
// frigate) and stamps `escortOf = charge.id` on the nearest available
// fighters. Capitals claim whole fighter packs at a time so pack
// cohesion stays consistent; bombers claim 2 individual fighters
// apiece — those two share a fresh packId so they cohere as their own
// small wing instead of pulling cohesion against the leftover pack
// they were plucked from. When the pool runs out, lower-priority
// charges fly with reduced screens or none at all.
function assignEscortPacks(game) {
  for (const side of ["blue", "red"]) {
    // Build a per-pack map of unclaimed fighters on this side. A "pack"
    // is any group of fighters sharing a packId. Free fighters with no
    // packId aren't included — they stay as solo screen units.
    const packs = new Map();
    for (const s of game.ships) {
      if (s.dead || s.side !== side || s.klass !== "fighter") continue;
      if (s.packId == null || s.escortOf != null) continue;
      let entry = packs.get(s.packId);
      if (!entry) {
        entry = { fighters: [], sumX: 0, sumY: 0, claimed: false };
        packs.set(s.packId, entry);
      }
      entry.fighters.push(s);
      entry.sumX += s.pos.x;
      entry.sumY += s.pos.y;
    }
    for (const entry of packs.values()) {
      const n = entry.fighters.length;
      entry.cx = entry.sumX / n;
      entry.cy = entry.sumY / n;
    }

    for (const klass of ESCORT_PRIORITY) {
      const need = ESCORT_SIZE[klass] || 0;
      if (need <= 0) continue;
      const charges = game.ships.filter(
        (s) => s.side === side && s.klass === klass && !s.dead,
      );

      if (klass === "bomber") {
        // Bombers claim individual fighters (2 each) rather than whole
        // packs — picking the closest free fighter from any unclaimed
        // pack, then dropping it out of that pack so subsequent claims
        // don't double-pick. The two claimed fighters share a fresh
        // packId so they cohere as the bomber's wing without tugging
        // the leftover free fighters in their original pack.
        for (const bomber of charges) {
          const claimed = [];
          while (claimed.length < need) {
            let bestF = null, bestEntry = null, bestD2 = Infinity;
            for (const entry of packs.values()) {
              if (entry.claimed || entry.fighters.length === 0) continue;
              for (const f of entry.fighters) {
                const dx = f.pos.x - bomber.pos.x;
                const dy = f.pos.y - bomber.pos.y;
                const d2 = dx * dx + dy * dy;
                if (d2 < bestD2) { bestD2 = d2; bestF = f; bestEntry = entry; }
              }
            }
            if (!bestF) break; // pool exhausted
            const idx = bestEntry.fighters.indexOf(bestF);
            bestEntry.fighters.splice(idx, 1);
            claimed.push(bestF);
          }
          if (claimed.length > 0) {
            const escortPackId = nextPackId++;
            for (const f of claimed) {
              f.escortOf = bomber.id;
              f.packRole = "hunt-fighter";
              f.packId = escortPackId;
            }
          }
        }
        continue;
      }

      // Capital: whole-pack claims.
      for (const cap of charges) {
        let remaining = need;
        while (remaining > 0) {
          let bestPack = null, bestD2 = Infinity;
          for (const entry of packs.values()) {
            if (entry.claimed || entry.fighters.length === 0) continue;
            const dx = entry.cx - cap.pos.x;
            const dy = entry.cy - cap.pos.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) { bestD2 = d2; bestPack = entry; }
          }
          if (!bestPack) break;
          bestPack.claimed = true;
          for (const f of bestPack.fighters) {
            f.escortOf = cap.id;
            // Cap-relative target picker in ai.js drives escort behaviour
            // via `escortOf`; packRole stays for the pack target-fallback
            // when no threat is inside the engage bubble.
            f.packRole = "hunt-fighter";
          }
          remaining -= bestPack.fighters.length;
        }
      }
    }
  }
}

function promotePlayer(game) {
  // Idempotent guard. `spawnRoster` already calls promotePlayer at its
  // end, and several legacy mode setups (arena / custom+skirmish / daily /
  // waves) call it AGAIN afterwards. With a Shipyard design present
  // `forceFresh` is true, so each call spawned a brand-new player ship —
  // producing a duplicate "ghost" fighter flying in lockstep on the same
  // controller. If a live player ship already exists, reuse it.
  const existingPlayer = game.ships.find((s) => s.isPlayer && !s.dead);
  if (existingPlayer) return existingPlayer;
  // Campaign / Shipyard-design / perk overrides all force a fresh
  // player ship so the design applies cleanly. Reusing an existing
  // ally fighter would keep the unupgraded race baseline.
  const forceFresh = !!game.playerSpecOverride || !!game.playerDesign;
  // Hull klass comes from the persistent design when present; otherwise
  // falls back to a plain fighter. This lets the player deploy as a
  // frigate / cruiser / battleship / carrier when they've purchased
  // those hulls in the Shipyard.
  const playerKlass = (game.playerDesign && game.playerDesign.hull) || "fighter";
  const candidate = forceFresh ? null : game.ships.find(
    (s) => s.side === "blue" && s.klass === playerKlass && !s.isPlayer && !s.dead,
  );
  if (!candidate) {
    const ship = createShip({
      klass: playerKlass,
      race: game.alliedRace,
      side: "blue",
      pos: randomSpawnPos(ARENA.spawn.blue),
      heading: 0,
      controller: game.playerController,
      specOverride: game.playerSpecOverride,
      boons: game.activeBoons,
      fleetTraits: game.activeFleetTraits,
      design: game.playerDesign,
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
  const player = game.ships.find((s) => s.isPlayer);
  if (player && !player.dead) {
    // VOLUNTARY spectate — hand the ship to AI control instead of
    // destroying it. The player's craft keeps fighting on its own; the
    // player watches (and can take it back via exitSpectate while it's
    // alive). isPlayer is cleared so updateAI drives it; the player's
    // ship id is remembered so exit can re-bind to the same hull.
    player.isPlayer = false;
    player.wasPlayerShip = true;
    player.controller = { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false };
    game.playerHandedToAiId = player.id;
    game.spectateTargetId = player.id;
    game.spectateCamera = { x: player.pos.x, y: player.pos.y, locked: true };
  } else {
    // No live player ship (death-triggered spectate, or admiral): drop
    // any dead husk and watch the fleet.
    game.ships = game.ships.filter((s) => !s.isPlayer);
    const tgt = pickSpectateInitial(game);
    game.spectateTargetId = tgt ? tgt.id : null;
    if (tgt) game.spectateCamera = { x: tgt.pos.x, y: tgt.pos.y, locked: true };
    else game.spectateCamera = { x: game.arena.width / 2, y: game.arena.height / 2, locked: false };
  }
}

function pickSpectateInitial(game) {
  return game.ships.find((s) => !s.dead && s.side === "blue")
      || game.ships.find((s) => !s.dead);
}

export function exitSpectate(game) {
  if (!game.spectating) return;
  // A pilot whose ship was DESTROYED can't return to the cockpit —
  // they're out for the rest of the battle (no respawn). The spectate
  // toggle stays in observe mode.
  if (game.playerEliminated) return;
  // Re-take the ship we handed to AI on voluntary spectate, IF it's
  // still alive. If it died while we watched, the player is eliminated
  // and can't return. We never spawn a fresh ship here (no respawn).
  const handId = game.playerHandedToAiId;
  const ship = handId != null
    ? game.ships.find((s) => s.id === handId && !s.dead)
    : null;
  if (ship) {
    ship.isPlayer = true;
    ship.wasPlayerShip = false;
    ship.controller = game.playerController;
    game.spectating = false;
    game.spectateTargetId = null;
    game.playerHandedToAiId = null;
    return;
  }
  // The handed-off ship is gone — the player has no hull to return to.
  // Stay observing; mark eliminated so the toggle won't keep trying.
  game.playerHandedToAiId = null;
  game.playerEliminated = true;
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

  // Mode tick hook — optional per-frame logic for the active mode.
  // Existing modes pass `tick: null` and are untouched; new modes
  // (e.g. waves) get their tick callback invoked here.
  const modeHooks = MODES[game.mode];
  if (modeHooks && typeof modeHooks.tick === "function") {
    modeHooks.tick(game, dt);
  }

  // Captain comms detection (Tier 39). Scan blue capitals for the
  // 3 per-ship triggers — shields-down, hull-50, hull-25 — and fire
  // a comm line the first time each crosses. One-shot flags on the
  // ship prevent re-fire while the value bounces (shield regen, etc).
  for (const s of game.ships) {
    if (s.dead || s.side !== "blue" || !s.commCaptain) continue;
    if (s.klass === "fighter" || s.klass === "bomber") continue;
    if (!s._commShieldFired && s.shieldMax > 0 && s.shield <= 0) {
      s._commShieldFired = true;
      pushCaptainComm(game, s, "shields-down");
    }
    const hpFrac = s.hpMax > 0 ? s.hp / s.hpMax : 1;
    if (!s._commHull50Fired && hpFrac <= 0.5) {
      s._commHull50Fired = true;
      pushCaptainComm(game, s, "hull-50");
    }
    if (!s._commHull25Fired && hpFrac <= 0.25) {
      s._commHull25Fired = true;
      pushCaptainComm(game, s, "hull-25");
    }
  }

  // Battle telemetry: clock, roster snapshot/reinforcements, surrenders.
  tickBattleStats(game, dt);

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
    bstatRecordShot(game, p);   // count each round once, on first sighting
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
          if (m.hp <= 0) {
            m.dead = true;
            // Missile shot down — soft pop SFX, distinct from the
            // full ship-explosion `shipDestroyed` event so PD work
            // reads as defensive in the mix.
            events.emit("missileIntercepted", { x: m.pos.x, y: m.pos.y });
          }
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
      if (dx * dx + dy * dy > r * r) continue;   // broad-phase circle reject
      // Narrow-phase: while a shield is up it's a bubble, so a non-missile
      // round strikes the circle. With the shield down (or for a shield-
      // bypassing missile) the round must actually overlap a LIVE block —
      // so it passes through eroded gaps and impacts on the remaining
      // structure, not the original full-hull outline.
      const shieldUp = ship.shieldMax > 0 && ship.shield > 0;
      let hitCell = null;
      if (ship.cells && (p.kind === "missile" || !shieldUp)) {
        hitCell = projectileBlockHitCell(ship, p.pos.x, p.pos.y, p.radius);
        if (!hitCell) continue;
      }
      // Visual-continuity snap: move the projectile's reported impact
      // point so the damage VFX (sparks, scar, hit event, missile blast
      // origin) lands ON the actual block / bubble instead of at the
      // projectile's last-step position. Without this the projectile
      // can be inches outside the block when block-hit fires (broad-
      // phase circle is bigger than the surviving hull), and the flash
      // appears in empty space — exactly the "weapons stop at the
      // undamaged hull outline" visual bug.
      if (hitCell) {
        // Snap to the live block's world centre.
        const c = Math.cos(ship.heading), s = Math.sin(ship.heading);
        p.pos.x = ship.pos.x + hitCell.lx * c - hitCell.ly * s;
        p.pos.y = ship.pos.y + hitCell.lx * s + hitCell.ly * c;
      } else if (shieldUp) {
        // Shield up + no block-test path → snap to the bubble surface
        // so the shield-impact flash sits on the visible bubble, not
        // the polygon's circumscribing circle (which is smaller than
        // the bubble by `shieldOffset` and reads as a flash inside
        // the bubble).
        const shieldOffset = Math.max(12, ship.spec.radius * 0.40);
        const bubbleR = ship.spec.radius + shieldOffset;
        const sdx = p.pos.x - ship.pos.x;
        const sdy = p.pos.y - ship.pos.y;
        const sd = Math.hypot(sdx, sdy) || 1;
        p.pos.x = ship.pos.x + (sdx / sd) * bubbleR;
        p.pos.y = ship.pos.y + (sdy / sd) * bubbleR;
      }
      const targets = computeModuleTargets(ship, p);
      applyDamage(ship, p, targets, game.particles, game);
      // Missiles always die on hit; cannons die on hit.
      p.dead = true;
      if (isShipDestroyed(ship)) ship.dead = true;
      break;
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

  // Player death — NO respawn. A destroyed player ship is gone for the
  // rest of the battle; the pilot drops to spectate and watches their
  // fleet fight on. Resolved exactly once (the first tick the player is
  // flagged dead).
  //
  // Frontier: roll a survival check to decide KIA vs ejected. KIA
  // (`game.playerKIA = true`) ends the run at matchEnded; ejected means
  // the pilot lives (run continues if the fleet wins) but still can't
  // climb back into a cockpit this battle. Survival % escalates per
  // death so a careless pilot eventually runs out of luck.
  if (!game.spectating && !game.playerDeathResolved) {
    const player = game.ships.find((s) => s.isPlayer);
    if (player && player.dead) {
      game.playerDeathResolved = true;
      if (game.mode === "roguelite") {
        const run = (game.modeConfig && game.modeConfig.run) || null;
        const priorDeaths = (run && run.playerDeaths) || 0;
        const survivalChance = Math.max(0.05, 0.60 - 0.18 * priorDeaths);
        const survived = Math.random() < survivalChance;
        if (run) run.playerDeaths = priorDeaths + 1;
        game.playerKIA = !survived;
        game.playerKIAEvent = { survived, survivalChance, deathIndex: priorDeaths + 1 };
      } else {
        // Non-Frontier modes have no career to end — death just means
        // you watch the rest of the skirmish.
        game.playerKIA = false;
        game.playerKIAEvent = { survived: true, eliminated: true };
      }
      // Out of the cockpit for good this battle. We do NOT drop to
      // spectate here: enterSpectate's death branch filters the player
      // husk out of game.ships, which would strip it BEFORE the wreck /
      // tally / telemetry passes below run — so the player's own ship
      // would produce no explosion, no wreck, and would be missing from
      // the loss tally + battle report. Defer the spectate drop until
      // after those passes (see the deferred call further down).
      game.playerEliminated = true;
      game.eliminationNoticeTimer = 4.0;
    }
  }
  // Elimination banner countdown — independent of spectate state so the
  // "SHIP DESTROYED — OBSERVING" / "KIA" beat shows for a few seconds.
  if (game.eliminationNoticeTimer > 0) game.eliminationNoticeTimer -= dt;

  // Convert newly-dead ships into wrecks + a chunky debris shower
  // before the dead-ship filter strips them. The wreckSpawned flag
  // guards against repeating on the second frame of the dead-but-
  // not-yet-filtered window. Stations are skipped — they hold their
  // form in place (the station-node visuals already handle their
  // destruction read).
  for (const s of game.ships) {
    if (!s.dead || s.wreckSpawned || s.klass === "station") continue;
    s.wreckSpawned = true;
    // Tally the loss BEFORE the wreck/debris spawn so it's counted
    // exactly once per ship death. tallies are bucketed by side+class.
    if (game.tallies && game.tallies[s.side] && s.klass) {
      game.tallies[s.side][s.klass] = (game.tallies[s.side][s.klass] || 0) + 1;
    }
    // Captain comm (Tier 39) — if a BLUE capital just went down,
    // have a sibling capital radio in. Pick the first surviving
    // blue capital with a commCaptain set.
    if (s.side === "blue" && s.commCaptain && s.commShipName) {
      const sibling = game.ships.find(
        (o) => !o.dead && o !== s && o.side === "blue" && o.commCaptain && o.klass !== "fighter" && o.klass !== "bomber",
      );
      if (sibling) {
        pushCaptainComm(game, sibling, "friendly-down", { other: s.commShipName });
      }
    }
    pushWreck(game.wrecks, createWreck(s));
    // Chunk shower scales with ship radius — a fighter pops 6 shards,
    // a battleship spits ~35 across its width. Capped at 50 to stay
    // inside the MAX_DEBRIS budget on a multi-kill frame.
    const shower = Math.min(50, 6 + Math.floor(s.spec.radius * 0.2));
    pushDebris(game.debris, createDebrisBurst(s.pos, s.pos, s.vel, s.klass, s.side, shower));
    // Visible explosion at the death point — shockwave + sparks + fire
    // + smoke. Intensity scales with hull radius so a battleship blow
    // rumbles big, but small craft (fighter/bomber) get a floor of 0.95
    // so their pop is large enough to catch the eye in a chaotic brawl.
    // Previously fighter deaths used intensity ≈0.54 which read as a
    // weak puff — players reported escort wings "just disappearing"
    // because the small-craft burst got lost in surrounding VFX.
    if (game.particles) {
      const isSmallCraft = s.klass === "fighter" || s.klass === "bomber";
      const burstIntensity = isSmallCraft
        ? 0.95
        : Math.min(1.6, 0.45 + (s.spec.radius / 110));
      // For small craft, draw the burst against a slightly larger
      // radius so the shockwave is genuinely readable at zoom 0.5.
      const burstR = isSmallCraft ? Math.max(s.spec.radius, 16) : s.spec.radius;
      spawnDestructionBurst(game.particles, s.pos.x, s.pos.y, burstR, burstIntensity);
    }
    // Boom! Explosion SFX scales intensity with hull radius so a
    // battleship death rumbles deeper than a fighter pop.
    const intensity = Math.min(1, 0.3 + (s.spec.radius / 180));
    events.emit("shipDestroyed", {
      x: s.pos.x, y: s.pos.y,
      intensity,
      klass: s.klass,
      side: s.side,
      isPlayer: s.isPlayer,
    });
  }

  // Battle telemetry: credit kills + bucket losses, once per ship death.
  // Independent of the wreck loop above (which skips stations) so every
  // class is attributed exactly once via the _statDead latch.
  for (const s of game.ships) {
    if (s.dead && !s._statDead) {
      s._statDead = true;
      bstatRecordKill(game, s);
    }
  }

  // Deferred spectate hand-off for a just-killed player: the death block
  // above set `playerEliminated` but left the husk in `game.ships` so the
  // wreck / tally / telemetry passes could process it. Now that they have,
  // drop to spectate (which filters the husk). Fires once — enterSpectate
  // sets `game.spectating`, so this guard won't re-trigger. (Voluntary
  // spectate / exitSpectate-elimination never hit this: they leave
  // `spectating` true, or never set `playerEliminated` while not spectating.)
  if (game.playerEliminated && !game.spectating) enterSpectate(game);

  // Tick persistent battle litter.
  const bounds = game.arena.bounds;
  for (const w of game.wrecks) updateWreck(w, dt, bounds);
  for (const d of game.debris) updateDebris(d, dt, bounds);

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
    // Mode-specific end check runs first; if it doesn't decide a
    // winner, fall through to the legacy defend/open rules.
    if (modeHooks && typeof modeHooks.checkEnd === "function") {
      const w = modeHooks.checkEnd(game);
      if (w === "blue" || w === "red") {
        game.matchOver = true;
        game.winner = w;
      }
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
      // Surrendered ships count as out-of-combat — a side with only
      // surrendered ships left has lost the engagement. Without this,
      // an all-surrender wave on red would leave the match running
      // forever because the surrender-untargetable rule means blue
      // can't finish them off.
      const blueAlive = game.ships.some((s) => s.side === "blue" && !s.isPlayer && !s.dead && !s.surrendered);
      const redAlive  = game.ships.some((s) => s.side === "red"  && !s.dead && !s.surrendered);
      if (!redAlive) { game.matchOver = true; game.winner = "blue"; }
      else if (!blueAlive) { game.matchOver = true; game.winner = "red"; }
    }
  }

  // Stall watchdog: if no damage has been dealt for STALL_LIMIT seconds
  // the match force-ends so the player isn't trapped watching idle
  // craft drift. Resolves by ship count — the side with more live
  // hulls wins; a tie ends as the player's loss (red) to discourage
  // grief-stall on the human side. Reset on every applyDamage call
  // (above) so contested battles never trip it.
  const STALL_LIMIT = 45;
  if (!game.matchOver) {
    game.stallTimer = (game.stallTimer || 0) + dt;
    if (game.stallTimer >= STALL_LIMIT) {
      const blueLive = game.ships.filter((s) => s.side === "blue" && !s.dead && !s.surrendered).length;
      const redLive  = game.ships.filter((s) => s.side === "red"  && !s.dead && !s.surrendered).length;
      game.matchOver = true;
      game.winner = blueLive > redLive ? "blue" : "red";
      game.endedByStall = true;
    }
  }
  // Edge-detect: emit matchEnded exactly once, the frame matchOver
  // first flips true. progression.js + the roguelite controller in
  // main.js both subscribe; capture-then-restart is keyed off this.
  if (game.matchOver && !game._matchEndedEmitted) {
    game._matchEndedEmitted = true;
    // Victory comm — pick a surviving blue capital to call it.
    if (game.winner === "blue" && !game._victoryCommFired) {
      game._victoryCommFired = true;
      const victor = game.ships.find(
        (s) => !s.dead && s.side === "blue" && s.commCaptain
            && s.klass !== "fighter" && s.klass !== "bomber",
      );
      if (victor) pushCaptainComm(game, victor, "victory");
    }
    // Fold telemetry into game.battleReport BEFORE the emit so subscribers
    // (and the match-over HUD panel) can read the finished report.
    finalizeBattleStats(game);
    events.emit("matchEnded", {
      mode: game.mode,
      winner: game.winner,
      score: game.kills || 0,
      durationSeconds: (game.battleStats && Math.round(game.battleStats.elapsed)) || 0,
    });
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
  game._matchEndedEmitted = false;
  game.modeConfig = null;
  game.rogueliteContext = null;
  game.focusTargetId = null;
  game.endedByStall = false;
  game.runSummary = null;
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
// module emit thick dark smoke + occasional fire at a higher rate.
// Engine modules use a dedicated spawner that vents smoke + flame jets
// backward along the ship's heading so the engine reads as "burning"
// instead of just a generic smoking patch. Per-frame coin flip uses
// dt so the average rate is framerate-stable.
//
// On top of per-module VFX, every ship below 70% hull HP emits hull
// venting VFX (smoke + fires at higher severity) from random points
// around its silhouette — visible damage at the ship level even when
// no specific module has taken a hit.
function emitContinuousModuleVFX(game, dt) {
  // Smoke rates per second. Bumped from the previous 12 / 3.5 so the
  // damage feedback is more dramatic; combined with the new engine +
  // hull spawners a half-dead capital should be visibly trailing
  // smoke from multiple sources.
  const DISABLED_RATE = 22;
  const DAMAGED_RATE  = 7;
  // Engine module rates ride higher so the rear of a damaged ship is
  // unmistakably venting plumes — engines are the primary "damage tell"
  // the user asked for.
  const ENGINE_DISABLED_RATE = 30;
  const ENGINE_DAMAGED_RATE  = 12;
  for (const s of game.ships) {
    if (s.dead) continue;
    if (s.modules) {
      for (const m of s.modules) {
        const frac = m.hp / m.hpMax;
        const isEngine = m.name && m.name.startsWith("engine-");
        let rate = 0;
        if (m.disabled) rate = isEngine ? ENGINE_DISABLED_RATE : DISABLED_RATE;
        else if (frac < 0.5) rate = isEngine ? ENGINE_DAMAGED_RATE : DAMAGED_RATE;
        else continue;
        if (Math.random() >= rate * dt) continue;
        const wpos = moduleWorldPos(s, m.name);
        if (!wpos) continue;
        if (isEngine) {
          // Severity 0.5 (lightly damaged) → 1.0 (disabled). Backward
          // vector in world space is the heading flipped 180° — engines
          // sit at the rear of the hull and vent rearward.
          const severity = m.disabled ? 1.0 : Math.max(0.45, 1 - frac);
          const backward = s.heading + Math.PI;
          spawnEnginePlumeVFX(game.particles, wpos.x, wpos.y, backward, severity);
        } else {
          spawnContinuousSmoke(game.particles, wpos.x, wpos.y, m.disabled);
        }
      }
    }
    // Ship-wide hull venting once the hull is meaningfully damaged.
    // Severity ramps from ~0 at 70% hp to ~1 at 10% hp; below that
    // we cap so it doesn't go super-nuclear. Emission rate scales
    // linearly with severity.
    const hpFrac = s.hpMax > 0 ? s.hp / s.hpMax : 1;
    if (hpFrac < 0.70) {
      const severity = Math.max(0, Math.min(1, (0.70 - hpFrac) / 0.60));
      // Emission rate ramps hard at low HP so a critically-wounded ship
      // is unmistakably dying — multiple vent points smoking + burning
      // at once. Bumped 9 → 16 base; the severity² curve makes the last
      // sliver of HP look the most desperate.
      const VENT_BASE_RATE = 16;
      const rate = VENT_BASE_RATE * (severity * severity);
      // Spawn 1-2 vent points per eligible tick at high severity so the
      // hull looks ablaze, not gently smoking.
      const bursts = severity > 0.75 ? 2 : 1;
      for (let b = 0; b < bursts; b++) {
        if (Math.random() >= rate * dt) continue;
        // Pick a random point on the hull silhouette — angle around
        // ship centre, radius slightly less than spec.radius so the
        // smoke originates at the hull surface, not from inside.
        const ang = Math.random() * Math.PI * 2;
        const R = s.spec && s.spec.radius ? s.spec.radius : 14;
        const r = R * (0.55 + Math.random() * 0.40);
        const wx = s.pos.x + Math.cos(ang) * r;
        const wy = s.pos.y + Math.sin(ang) * r;
        spawnHullVentVFX(game.particles, wx, wy, ang, severity);
      }
    }
  }
  // Soft particle cap — the beefed-up damage VFX can spike in a big
  // brawl. Drop the OLDEST particles past the cap so newer impact
  // flashes/sparks always render. Cheap: only trims when over budget.
  const MAX_PARTICLES = 1400;
  if (game.particles.length > MAX_PARTICLES) {
    game.particles.splice(0, game.particles.length - MAX_PARTICLES);
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
// Carriers are screening platforms, not gun platforms. Their PD turrets
// still need to deter loitering fighters but shouldn't meaningfully
// contribute to chipping down enemy capitals. Carrier-fired PD rounds
// land on larger ships (anything that isn't strike craft) at 70% of
// the normal 0.22× ship multiplier — so ~0.154× of base PD damage vs
// a frigate/cruiser/battleship/carrier/station.
const CARRIER_PD_VS_LARGE_MUL = 0.7;
// Fighters are the dedicated bomber-killers. A fighter's cannon hits a
// bomber's shields + hull 3× harder than baseline, so a fighter screen
// shreds an incoming bomber wing instead of trading evenly with it.
const FIGHTER_CANNON_VS_BOMBER_MUL = 3;

// Classify an incoming projectile into an impact "source" so the audio
// layer can pick a matching timbre (a missile crump vs a fighter-cannon
// ping vs a PD tink). Mirrors the same axes applyDamage already keys on.
function impactSource(p) {
  if (p.kind === "missile") return "missile";
  if (p.kind === "laser") return "laser";
  if (p.fromKlass === "pd") return "pd";
  // Capital main guns — BB broadside slugs, cruiser/carrier forward cannon
  // (e.g. the Thren carrier's cruiser-grade gun) — land with weight.
  if (p.fromKlass === "cruiser" || p.fromKlass === "battleship" || p.fromKlass === "carrier") return "heavy";
  return "cannon"; // fighter / bomber / frigate light kinetic
}

// ===========================================================================
// Battle telemetry — feeds the end-of-battle report (all modes).
// Reset each startGame (initBattleStats). Instrumented from: the projectile
// loop (shots/missiles fired), applyDamage (damage dealt + cannon hits +
// last-damager stamp), a per-frame ship pass (roster snapshot, reinforcement
// registration, surrender detection), and a death pass (kills + losses).
// finalizeBattleStats folds it into game.battleReport the frame the match ends.
// ===========================================================================
const BSTAT_CLASSES = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier", "station"];
const BSTAT_CAPITAL_LABEL = {
  frigate: "Frigate", cruiser: "Cruiser", battleship: "Battleship",
  carrier: "Carrier", station: "Station",
};

// Side-level scalar counters. Per-class committed/lost/surrendered/survived
// are NOT tracked here — they're derived from per-ship `fate` records in
// finalizeBattleStats (terminal fate → each hull counts in exactly one
// bucket), which is the single source of truth.
function bstatSide() {
  return { damageDealt: 0, shotsFired: 0, shotsHit: 0, missilesFired: 0 };
}

function initBattleStats(game) {
  game.battleStats = {
    elapsed: 0,
    blue: bstatSide(),
    red: bstatSide(),
    ships: {},   // id -> per-ship record
  };
  game.battleReport = null;
}

// Ensure (and return) a per-ship record. First sighting of a hull counts it
// as committed to the fight — this picks up reinforcements (carrier
// replenishment, roguelite waves) that spawn after the opening roster.
function bstatShip(game, ship) {
  const bs = game.battleStats;
  if (!bs) return null;
  let rec = bs.ships[ship.id];
  if (!rec) {
    rec = {
      id: ship.id, name: ship.commShipName || null, klass: ship.klass,
      side: ship.side, isPlayer: !!ship.isPlayer,
      kills: 0, damageDealt: 0, shotsFired: 0, shotsHit: 0, fate: "alive",
    };
    bs.ships[ship.id] = rec;
  } else if (!rec.name && ship.commShipName) {
    rec.name = ship.commShipName;   // captains/names can land after spawn
  }
  return rec;
}

// Per-frame pass: accumulate clock, register every live hull, detect the
// frame a ship raises the white flag.
function tickBattleStats(game, dt) {
  const bs = game.battleStats;
  if (!bs) return;
  if (!game.matchOver) bs.elapsed += dt;
  for (const s of game.ships) {
    const rec = bstatShip(game, s);
    if (rec && s.surrendered && !s._statSurrendered) {
      s._statSurrendered = true;
      rec.fate = "surrendered";   // may later flip to "lost" if over-killed
    }
  }
}

// Count a projectile exactly once, the frame it enters the world. PD rounds
// are excluded from the accuracy stat (they're anti-missile, not aimed fire).
function bstatRecordShot(game, p) {
  const bs = game.battleStats;
  if (!bs || p._statSeen) return;
  p._statSeen = true;
  const side = bs[p.side];
  if (!side) return;
  if (p.kind === "missile") { side.missilesFired++; return; }
  if (p.kind === "cannon" && p.fromKlass !== "pd") {
    side.shotsFired++;
    const rec = bs.ships[p.ownerId];
    if (rec) rec.shotsFired++;
  }
}

// A hit that lands: credit damage to the firer's side + record, and (for
// non-PD cannon rounds) count it as an accuracy hit. `amount` is the
// post-multiplier incoming damage (shield + hull), so the figure reflects
// total damage inflicted regardless of which layer absorbed it.
function bstatRecordDamage(game, p, amount) {
  const bs = game.battleStats;
  if (!bs || p.side == null) return;
  const side = bs[p.side];
  if (side) side.damageDealt += amount;
  const rec = (p.ownerId != null) ? bs.ships[p.ownerId] : null;
  if (rec) rec.damageDealt += amount;
  if (p.kind === "cannon" && p.fromKlass !== "pd" && !p._statHit) {
    p._statHit = true;
    if (side) side.shotsHit++;
    if (rec) rec.shotsHit++;
  }
}

// Death of `victim`: bucket the loss for its side and credit the kill to
// whoever last damaged it (if attributable + still on record).
function bstatRecordKill(game, victim) {
  const bs = game.battleStats;
  if (!bs) return;
  const rec = bstatShip(game, victim);   // ensure victim is on record
  if (rec) rec.fate = "lost";   // terminal — overrides a prior "surrendered"
  const killerId = victim.lastDamagerId;
  if (killerId != null) {
    const krec = bs.ships[killerId];
    if (krec) krec.kills++;
  }
}

// Fold raw counters into the structured report the HUD renders. Side "kills"
// are derived from enemy losses (single source of truth, no double-count);
// per-ship records drive the MVP + per-capital breakdown.
function finalizeBattleStats(game) {
  const bs = game.battleStats;
  if (!bs) return;
  const report = {
    durationSeconds: Math.round(bs.elapsed),
    winner: game.winner,
    endedByStall: !!game.endedByStall,
    mode: game.mode,
    sides: {},
    capitals: [],
    smallCraft: { blue: { count: 0, kills: 0, damage: 0 }, red: { count: 0, kills: 0, damage: 0 } },
    mvp: null,
  };
  // Bucket every committed hull by side/class/terminal-fate from the
  // per-ship records. fate is terminal (a ship that surrenders then gets
  // finished off by in-flight ordnance ends "lost"), so each hull lands in
  // exactly one bucket — committed === survived + lost + surrendered always.
  const buk = {
    blue: { committed: {}, lost: {}, surrendered: {}, survivors: {} },
    red:  { committed: {}, lost: {}, surrendered: {}, survivors: {} },
  };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  for (const id in bs.ships) {
    const r = bs.ships[id];
    const b = buk[r.side];
    if (!b) continue;
    bump(b.committed, r.klass);
    if (r.fate === "lost") bump(b.lost, r.klass);
    else if (r.fate === "surrendered") bump(b.surrendered, r.klass);
    else bump(b.survivors, r.klass);
  }
  for (const sideKey of ["blue", "red"]) {
    const s = bs[sideKey];
    const b = buk[sideKey];
    const enemy = buk[sideKey === "blue" ? "red" : "blue"];
    const out = {
      committed: {}, lost: {}, surrendered: {}, survivors: {}, kills: {},
      damageDealt: Math.round(s.damageDealt),
      shotsFired: s.shotsFired, shotsHit: s.shotsHit, missilesFired: s.missilesFired,
      accuracy: s.shotsFired > 0 ? s.shotsHit / s.shotsFired : 0,
      totals: { committed: 0, lost: 0, surrendered: 0, survivors: 0, kills: 0 },
    };
    for (const k of BSTAT_CLASSES) {
      const c = b.committed[k] || 0, l = b.lost[k] || 0, su = b.surrendered[k] || 0, surv = b.survivors[k] || 0;
      // Kills of class k = enemy hulls of that class destroyed.
      const kills = enemy.lost[k] || 0;
      out.committed[k] = c; out.lost[k] = l; out.surrendered[k] = su;
      out.survivors[k] = surv; out.kills[k] = kills;
      out.totals.committed += c; out.totals.lost += l; out.totals.surrendered += su;
      out.totals.survivors += surv; out.totals.kills += kills;
    }
    report.sides[sideKey] = out;
  }
  let mvp = null;
  for (const id in bs.ships) {
    const r = bs.ships[id];
    const label = r.name || BSTAT_CAPITAL_LABEL[r.klass] || r.klass;
    if (r.klass === "fighter" || r.klass === "bomber") {
      const sc = report.smallCraft[r.side];
      if (sc) { sc.count++; sc.kills += r.kills; sc.damage += r.damageDealt; }
    } else {
      report.capitals.push({
        name: label, klass: r.klass, side: r.side, isPlayer: r.isPlayer,
        kills: r.kills, damageDealt: Math.round(r.damageDealt), fate: r.fate,
      });
    }
    if ((r.kills > 0 || r.damageDealt > 0) &&
        (!mvp || r.kills > mvp.kills || (r.kills === mvp.kills && r.damageDealt > mvp.damageDealt))) {
      mvp = { name: label, klass: r.klass, side: r.side, isPlayer: r.isPlayer,
              kills: r.kills, damageDealt: Math.round(r.damageDealt) };
    }
  }
  // Blue capitals first, then by kills descending.
  report.capitals.sort((a, b) => (a.side === b.side ? b.kills - a.kills : (a.side === "blue" ? -1 : 1)));
  report.smallCraft.blue.damage = Math.round(report.smallCraft.blue.damage);
  report.smallCraft.red.damage = Math.round(report.smallCraft.red.damage);
  report.mvp = mvp;
  game.battleReport = report;
}

function applyDamage(ship, p, moduleTargets = null, particles = null, game = null) {
  // Surrendered ships still take damage from ordnance already in flight:
  // you can't un-launch the 10 missiles that locked on before the white
  // flag went up. They're untargetable for NEW shots (every target/aim
  // picker skips surrendered, and missiles won't re-acquire onto them —
  // see acquireMissileTarget), so the only hits that land are weapons
  // committed before the surrender (locked missiles, in-flight cannon
  // rounds). A ship that's over-killed this way dies instead of being
  // captured — which is the intended consequence of overcommitting.
  let remaining = p.damage;
  if (p.fromKlass === "pd") {
    remaining *= PD_VS_SHIP_MUL;
    if (p.ownerKlass === "carrier"
        && ship.klass !== "fighter" && ship.klass !== "bomber") {
      remaining *= CARRIER_PD_VS_LARGE_MUL;
    }
  }
  // Fighters counter bombers: a fighter's cannon is 3× as effective at
  // stripping a bomber's shields AND hull. Cannon rounds only.
  if (ship.klass === "bomber" && p.fromKlass === "fighter" && p.kind === "cannon") {
    remaining *= FIGHTER_CANNON_VS_BOMBER_MUL;
  }
  // Anti-craft bonus: air-to-air missiles deal extra damage vs fighters
  // and bombers (the carrier-killer role needs a counter).
  if (p.kind === "missile" && p.antiCraftBonus &&
      (ship.klass === "fighter" || ship.klass === "bomber")) {
    remaining *= p.antiCraftBonus;
  }
  // Reset the stall watchdog: any damage event counts as the arena
  // still being meaningfully active. The watchdog is checked in
  // update() and forces a draw when no damage has been dealt for
  // STALL_LIMIT seconds (see below).
  if (game) game.stallTimer = 0;

  // Battle telemetry: attribute this hit. Stamp the last damager (drives
  // kill credit on death) and record damage dealt + cannon-hit accuracy.
  // `remaining` here is the post-multiplier incoming damage (shield+hull).
  if (game && p.side != null) {
    if (p.ownerId != null) { ship.lastDamagerId = p.ownerId; ship.lastDamagerSide = p.side; }
    bstatRecordDamage(game, p, remaining);
  }

  // Step 1: Shield (unless missile, which bypasses).
  if (p.kind !== "missile" && ship.shieldMax > 0 && ship.shield > 0) {
    const isFighterRound = p.fromKlass === "fighter";
    const isLaser = p.kind === "laser";
    const shieldMul = (isFighterRound || isLaser) ? 0.5 : 1;
    ship.shieldHitTimer = 0;
    ship.shieldFlash = Math.min(1, ship.shieldFlash + 0.4);
    // Record a localized hit point on the shield bubble so the
    // renderer can paint a bright arc + ripple near the impact for
    // a few frames. Capped at 6 active hits per ship so the array
    // stays small.
    recordShieldHit(ship, p);
    // SFX event — shielded-hit variant. Position is the impact, not
    // the ship centre, so attenuation feels right when a far-away
    // capital takes one. SUPPRESSED for laser-kind so the per-tick
    // beam damage doesn't trigger 60 shield-impact thunks per second;
    // the sustained `sfxBeam` voice covers the beam's audio role.
    if (!isLaser) events.emit("hit", {
      x: p.pos.x, y: p.pos.y,
      shielded: true,
      layer: "shield",
      source: impactSource(p),
      isPlayer: ship.isPlayer,
    });
    const shieldCost = remaining * shieldMul;
    if (shieldCost <= ship.shield) {
      ship.shield -= shieldCost;
      // Visual: outward shockwave + sparks at the impact point on
      // the bubble. Sized by the absorbed cost so glancing hits
      // ripple gently and a beam tick pops a big ring.
      if (particles) spawnShieldImpact(particles, p.pos.x, p.pos.y, shieldCost);
      return; // shield ate the whole hit
    }
    // Shield breaks; convert remaining capacity back into incoming damage.
    const dmgAbsorbed = ship.shield / shieldMul;
    ship.shield = 0;
    if (particles) spawnShieldImpact(particles, p.pos.x, p.pos.y, dmgAbsorbed, true);
    // Shield-collapse SFX event — bright crystalline shatter so the
    // player hears "screen down" distinctly from a regular bubble
    // absorb. Distinct from the per-hit `hit` event above.
    events.emit("shieldBreak", {
      x: ship.pos.x, y: ship.pos.y,
      isPlayer: ship.isPlayer,
    });
    remaining = remaining - dmgAbsorbed;
    if (remaining <= 0) return;
  }

  // Step 2 (REMOVED): ship-level armor. Armor is per-block + per-
  // module now (cell.armor / module.armor reduces incoming damage at
  // each impact). Heavy capitals are still tougher because their
  // blocks + modules carry higher armor values, but the damage no
  // longer cascades through a separate ship-level pool.

  // Step 3: Damage now hits the hull (either via modules or directly).
  // Record a persistent hull scar + spawn breakoff fragments at the
  // impact point regardless of whether modules absorb part of the hit.
  recordHullImpact(ship, p, remaining, particles, game);
  // SFX event — hull-hit variant (low metallic thunk). SUPPRESSED for
  // laser-kind for the same reason as the shielded branch above: the
  // sustained `sfxBeam` voice plays for the beam's duration and the
  // per-tick hull-hit thunks would otherwise stack 60× per second.
  if (p.kind !== "laser") events.emit("hit", {
    x: p.pos.x, y: p.pos.y,
    shielded: false,
    layer: "hull",
    source: impactSource(p),
    isPlayer: ship.isPlayer,
  });

  // Step 3a: Chew the destructible cell grid at the hit point. Each cell in
  // the blast area takes independent damage with quadratic falloff from center
  // to edge, reduced by per-class armor. Cannons bite cells over 4-8 shots;
  // missiles can one-shot a cluster near the blast center.
  if (ship.cells && p && p.pos) {
    const local = worldToLocal(ship, p.pos.x, p.pos.y);
    const chewR = p.blastRadius != null ? p.blastRadius : chewRadius(ship, remaining);
    const cellResult = damageCellsInRadius(ship, local.x, local.y, chewR, remaining);
    if (cellResult && cellResult.coreKilled) ship.hp = 0;
  }

  if (moduleTargets && moduleTargets.length > 0) {
    for (const { module, weight } of moduleTargets) {
      if (module.disabled) continue;
      // Per-module armor (0..1) reduces the damage that reaches this
      // module's HP. Mirrors the per-cell armor — a heavily-armoured
      // battleship missile bay survives a glancing hit that would
      // disable a fighter's gun outright. armor-piercing ordnance
      // (torpedoes) skips the reduction.
      const modArmor = p.armorPiercing ? 0 : (module.armor || 0);
      const dmg = remaining * weight * (1 - modArmor);
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
        // Killing a subsystem ruptures part of the central hull — drains
        // the structural-integrity bar. Clamped so hpFrac never goes negative.
        ship.hp = Math.max(0, ship.hp - module.hullPenalty);
        // Tear out the cluster of cells bound to this module so the
        // ship's silhouette loses a recognisable chunk at the same time.
        if (ship.cells) killCellsForModule(ship, module.name);
        const wpos = moduleWorldPos(ship, module.name);
        if (particles && wpos) {
          const moduleRadiusWorld = module.radius * ship.spec.radius;
          // Capital module deaths read 40% bigger — bigger shockwave,
          // more sparks/debris — than fighter engine pops. Was using
          // `ship.spec.armorMax > 0` as the capital proxy; ship-level
          // armor is gone, so check the klass directly.
          const isCapital = ship.klass === "frigate" || ship.klass === "cruiser"
            || ship.klass === "battleship" || ship.klass === "carrier"
            || ship.klass === "station";
          const intensity = isCapital ? 1.4 : 1.0;
          spawnDestructionBurst(particles, wpos.x, wpos.y, moduleRadiusWorld, intensity);
        }
        // Module-destroyed SFX event — sharp crack + tonal punch so
        // PD turrets, broadside batteries, missile bays, etc. blowing
        // out reads distinctly from a full ship explosion.
        const isCapital = ship.klass === "frigate" || ship.klass === "cruiser"
          || ship.klass === "battleship" || ship.klass === "carrier"
          || ship.klass === "station";
        events.emit("moduleDestroyed", {
          x: (wpos && wpos.x) || ship.pos.x,
          y: (wpos && wpos.y) || ship.pos.y,
          // Capitals' modules are bigger → louder pop. Small craft
          // (fighter `gun` module) → softer.
          intensity: isCapital ? 0.7 : 0.4,
          isPlayer: ship.isPlayer,
        });
      }
    }
    return;
  }
  // No module targets (glancing hit / laser / small craft): drain hull HP
  // directly. Clamped at 0 so hpFrac carry-over never goes negative.
  // Lethal only via core destruction — the HP bar now shows structural
  // erosion, not an instant-death meter.
  ship.hp = Math.max(0, ship.hp - remaining);
}

// Cell-damage blast radius in local ship space. Scales with weapon damage:
// cannons are tight (chip 1-3 cells), missiles are wide (chunk a cluster).
// Cap at 75% of ship radius so no single hit clears more than half the hull.
function chewRadius(ship, dmg) {
  const R = ship.spec && ship.spec.radius ? ship.spec.radius : 14;
  const cellSize = Math.max(ship.cellW || 6, ship.cellH || 6);
  const base = cellSize * 0.6;
  const scale = Math.min(R * 0.75, base + Math.sqrt(Math.max(0, dmg)) * 3.0);
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
// sustained nearby fire, plus tinted hull fragments breaking off
// (short-lived particle VFX) AND persistent chunk debris (long-lived
// wreckage fragments) for hits weighty enough to plausibly knock a
// piece loose. The persistent debris is what gives a fleet brawl its
// shrapnel-strewn battlefield look — particle fragments disappear in
// a couple seconds, debris stays for the rest of the match.
function recordHullImpact(ship, p, dmg, particles, game) {
  if (!p || !p.pos) return;
  const local = worldToLocal(ship, p.pos.x, p.pos.y);
  addImpactScar(ship, "hull-hole", local.x, local.y, dmg);
  if (particles) {
    const ang = Math.atan2(p.pos.y - ship.pos.y, p.pos.x - ship.pos.x);
    const tint = SIDES[ship.side].primary;
    spawnHullBreakoff(particles, p.pos.x, p.pos.y, dmg, tint, ang);
  }
  if (game && game.debris && dmg >= 4) {
    // Chunk count scales with raw damage but biased by class so a
    // cannon round chipping a battleship sheds only a couple of
    // shards while a missile gutting a fighter throws a big cloud
    // (relative to that hull). Tunable per taste.
    const klassScale = ship.klass === "fighter" || ship.klass === "bomber" ? 0.6 : 1.0;
    const count = Math.max(1, Math.min(8, Math.floor((dmg / 12) * klassScale + 1)));
    pushDebris(game.debris, createDebrisBurst(ship.pos, p.pos, ship.vel, ship.klass, ship.side, count));
  }
}

// Stash a localized shield-bubble hit point so drawShip can paint a
// brighter arc near the impact for a few frames. Stored in ship-local
// frame (rotates with the ship) so a manoeuvring capital's hit arcs
// ride with the hull instead of decaling in world space. ttl ticks
// down in updateShip — kept tight (~0.45s) so the arcs feel like
// momentary impact flares, not persistent.
function recordShieldHit(ship, p) {
  if (!ship.shieldHits) ship.shieldHits = [];
  // Localize the hit point relative to ship pos + heading; clamp to
  // the shield surface radius so a slightly-overlapping projectile
  // still anchors the arc to the bubble.
  const dx = p.pos.x - ship.pos.x;
  const dy = p.pos.y - ship.pos.y;
  const c = Math.cos(-ship.heading);
  const s = Math.sin(-ship.heading);
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  const ang = Math.atan2(ly, lx);
  ship.shieldHits.push({ ang, ttl: 0.45, maxTtl: 0.45 });
  if (ship.shieldHits.length > 6) ship.shieldHits.shift();
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
    // A beam dies when its owner loses ALL its laser emitters. Single-laser
    // ships have a `laser` module; multi-beam ships (heavyLaser array of ≥2)
    // have `laser-fore`/`laser-aft` and NO `laser` module — so the old
    // `moduleByName.laser` check was always false for them and their beams
    // never died after both bays were shot off. Scan the module list for any
    // LIVE laser emitter instead.
    let ownerLaserOk = true;
    if (owner && owner.modules) {
      const laserMods = owner.modules.filter((m) => m.name && m.name.startsWith("laser"));
      if (laserMods.length > 0) ownerLaserOk = laserMods.some((m) => !m.disabled);
    }
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
        // Hit point on the near hull face — beam enters from the firing
        // side, so offset back toward the beam origin by the target radius.
        const d = Math.sqrt(d2) || 1;
        const tR = (t.spec && t.spec.radius) || 14;
        const ux = dx / d, uy = dy / d;
        let hitX = t.pos.x - ux * tR;   // default: near hull face / shield bubble
        let hitY = t.pos.y - uy * tR;
        // Shield down: walk the beam in from the near face to the FIRST live
        // block so the burn lands on remaining structure, not the eroded
        // outline. (Shield up → the laser is absorbed at the bubble, which is
        // the circle, so the near-face point is correct.)
        const tShieldUp = t.shieldMax > 0 && t.shield > 0;
        if (t.cells && !tShieldUp) {
          const step = Math.max(2, Math.max(t.cellW || 6, t.cellH || 6) * 0.5);
          for (let sd = d - tR; sd <= d + tR; sd += step) {
            const sx = beam.origin.x + ux * sd, sy = beam.origin.y + uy * sd;
            if (projectileBlockHit(t, sx, sy, 2)) { hitX = sx; hitY = sy; break; }
          }
        }
        applyDamage(
          t,
          { damage: tickDmg, kind: "laser", fromKlass: "battleship", pos: { x: hitX, y: hitY }, ownerId: beam.ownerId, side: beam.side },
          null,
          game.particles,
          game,
        );
        if (isShipDestroyed(t)) t.dead = true;
        beam.hit = { x: hitX, y: hitY };
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
    if (o.dead || o.surrendered || o.side === side) continue;
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
