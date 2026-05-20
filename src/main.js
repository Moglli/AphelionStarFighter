import {
  createGame, update, restart, startGame,
  enterSpectate, exitSpectate, cycleSpectate, getSpectateTarget,
} from "./game.js";
import { drawArena, drawArenaBounds, ARENA } from "./arena.js";
import { drawShip } from "./ship.js";
import { drawProjectile } from "./projectile.js";
import { drawHUD, drawBeams } from "./hud.js";
import { drawWreck, drawDebris } from "./wreckage.js";
import { InputManager } from "./input.js";
import { prerenderSprites } from "./sprites.js";
import { drawParticle } from "./particles.js";
import { GameAudio } from "./audio.js";
import {
  loadRun, loadMeta, startNewRun, abandonRun, discardRun,
  buildModeConfig, captureBattleOutcome, completeNode, enterNode,
  isRunOver, recordRunEnd,
  buyRepair, buyRecruit, buyRefuel, applyBoon, applyEventChoice,
} from "./roguelite.js";
import {
  loadEnergy, regenTick, spendEnergy, purchase as purchaseEnergy,
} from "./energy.js";
import { saveStore } from "./save.js";
import { events } from "./events.js";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const input = new InputManager(canvas);
// Bake every (race, klass, side) ship sprite into an offscreen canvas
// before the first frame so drawShip can blit instead of re-drawing
// polygons each tick.
prerenderSprites();
const game = createGame();
window.game = game; // for console smoke-testing
const audio = new GameAudio();
let musicWasPlaying = false; // tracks state for start/stop edge detection

// Restore persisted music + SFX mute states and wire the Settings
// overlay + the P key shortcut (music only) to both apply the change
// to the live audio graph AND persist it through saveStore.
audio.setMuted(!!saveStore.get().settings.musicMuted);
audio.setSfxMuted(!!saveStore.get().settings.sfxMuted);
function applyMuteChange(muted) {
  audio.setMuted(muted);
  saveStore.update((d) => { d.settings.musicMuted = muted; });
}
function applySfxMuteChange(muted) {
  audio.setSfxMuted(muted);
  saveStore.update((d) => { d.settings.sfxMuted = muted; });
}
input.startMenu.setSettings(
  () => ({ musicMuted: audio.isMuted(), sfxMuted: audio.isSfxMuted() }),
  (patch) => {
    if (typeof patch.musicMuted === "boolean") applyMuteChange(patch.musicMuted);
    if (typeof patch.sfxMuted === "boolean") applySfxMuteChange(patch.sfxMuted);
  },
);

// SFX routing: gameplay code emits weaponFired / hit / shipDestroyed
// events with world-space positions; the camera-attenuated distance
// drives volume so a battle on the far side of the map is muted while
// a knife-fight at the player's position is at full volume.
let _lastCamera = { x: 0, y: 0 };
const SFX_RANGE = 1800;        // world units past which volume → 0
const SFX_CANNON_PROB = 0.35;  // gate cannon emissions so brawls aren't a wall of sound
function sfxAttenuation(x, y) {
  const dx = x - _lastCamera.x;
  const dy = y - _lastCamera.y;
  const d = Math.hypot(dx, dy);
  if (d >= SFX_RANGE) return 0;
  // Soft inverse curve — louder up close, gentle falloff to range.
  return Math.max(0, 1 - (d / SFX_RANGE) ** 1.3);
}
events.on("weaponFired", ({ x, y, kind, isPlayer }) => {
  if (!audio.ctx) return;
  // Player always plays full-volume cannon SFX. AI cannons probability-gated
  // so a 200-ship brawl doesn't deafen the player.
  if (!isPlayer && Math.random() > SFX_CANNON_PROB) return;
  const att = isPlayer ? 1 : sfxAttenuation(x, y);
  if (att <= 0.04) return;
  audio.sfxCannon({ volume: att, kind });
});
events.on("missileFired", ({ x, y, isPlayer }) => {
  if (!audio.ctx) return;
  const att = isPlayer ? 1 : sfxAttenuation(x, y);
  if (att <= 0.04) return;
  audio.sfxMissile({ volume: att });
});
events.on("hit", ({ x, y, shielded, isPlayer }) => {
  if (!audio.ctx) return;
  const att = isPlayer ? 1 : sfxAttenuation(x, y) * 0.7;
  if (att <= 0.08) return;
  audio.sfxHit({ shielded, volume: att });
});
events.on("shipDestroyed", ({ x, y, intensity }) => {
  if (!audio.ctx) return;
  const att = sfxAttenuation(x, y);
  if (att <= 0.05) return;
  audio.sfxExplosion({ volume: att, intensity: intensity || 0.6 });
});

// Admiral panel — reads and writes game.directives directly. The map
// is allocated by modes/admiral.js at match start; null in other
// modes so the AI fast-paths through the directive check.
input.admiralPanel.setHooks(
  () => game.directives,
  (klass, posture) => { if (game.directives && game.directives[klass]) game.directives[klass].posture = posture; },
  (klass, missiles) => { if (game.directives && game.directives[klass]) game.directives[klass].missiles = missiles; },
);

// Roguelite "Frontier" controller — owns the live run state. The
// StartMenu reads the run via setRoguelite + the onChoice callback;
// matchEnded captures fleet state back into the run; runEnded clears
// it.
let activeRun = loadRun();
let pendingNode = null; // node the player has just chosen to enter — used post-startGame
input.startMenu.setRoguelite({
  meta: loadMeta(),
  run: activeRun,
  refresh,
}, handleRunChoice);

function refresh() {
  activeRun = loadRun();
  input.startMenu.setRoguelite({
    meta: loadMeta(),
    run: activeRun,
    refresh,
  }, handleRunChoice);
}

function handleRunChoice(action, payload) {
  if (action === "new-run") {
    activeRun = startNewRun(payload.faction, payload.seed);
    refresh();
    return;
  }
  if (action === "abandon-run") {
    abandonRun();
    activeRun = null;
    refresh();
    return;
  }
  if (action === "enter-node") {
    if (!activeRun) return;
    const { nodeId, battleMode } = payload;
    if (!enterNode(activeRun, nodeId)) return;
    activeRun.battleMode = battleMode || "fly";
    pendingNode = activeRun.graphs[activeRun.act - 1].nodes.find((n) => n.id === nodeId);
    // Build the modeConfig bundle and launch the battle.
    const cfg = buildModeConfig(activeRun, pendingNode, activeRun.battleMode);
    // Map size scales with act so later acts feel bigger.
    const mapW = 5000 + (activeRun.act - 1) * 2000;
    const mapH = 3500 + (activeRun.act - 1) * 1500;
    startGame(game, mapW, mapH, activeRun.faction, "roguelite", cfg, 1);
    input.admiralActive = !!game.admiralMode;
    audio.start();
    return;
  }
  if (action === "complete-node-noncombat") {
    // Event nodes — the choice was already applied. Now just advance.
    if (!activeRun) return;
    if (!enterNode(activeRun, payload.nodeId)) return;
    completeNode(activeRun, payload.nodeId);
    refresh();
    return;
  }
  if (action === "enter-node-and-complete") {
    // Resupply nodes — pay fuel, advance, payout. All purchases inside
    // the overlay have already mutated the run via buyRepair / etc.
    if (!activeRun) return;
    if (!enterNode(activeRun, payload.nodeId)) return;
    completeNode(activeRun, payload.nodeId);
    refresh();
    return;
  }
  if (action === "buy-repair") {
    if (activeRun) { buyRepair(activeRun, payload.instanceId); refresh(); }
    return;
  }
  if (action === "buy-recruit") {
    if (activeRun) { buyRecruit(activeRun, payload.klass); refresh(); }
    return;
  }
  if (action === "buy-refuel") {
    if (activeRun) { buyRefuel(activeRun, payload.units || 1); refresh(); }
    return;
  }
  if (action === "apply-boon") {
    if (activeRun) { applyBoon(activeRun, payload.boonKey); refresh(); }
    return;
  }
  if (action === "apply-event") {
    if (activeRun) {
      applyEventChoice(activeRun, payload.eventId, payload.choiceIndex);
      refresh();
    }
    return;
  }
}

// When a battle ends, walk live ships → run.capitals + run.smallCraft,
// then either continue the run or end it. Subscribing here (not inside
// roguelite.js) so we have direct access to the live game object.
events.on("matchEnded", ({ mode, winner }) => {
  if (mode !== "roguelite" || !activeRun || !pendingNode) return;
  // Snapshot the run reference up front — completeNode can clear it
  // synchronously on a final-boss win via the runEnded handler below.
  const runRef = activeRun;
  captureBattleOutcome(runRef, game);
  if (winner === "blue") {
    completeNode(runRef, pendingNode.id);
  }
  pendingNode = null;
  // If the run is still alive after capture+complete, check whether
  // the fleet wipe condition fired (locked design rule: losing a single
  // battle doesn't end the run — only losing every capital does).
  if (activeRun && isRunOver(activeRun)) {
    recordRunEnd(activeRun, false);
    discardRun();
    activeRun = null;
  }
  refresh();
});

// Run-completed cleanup: when act 3's boss is cleared, roguelite.js
// emits runEnded with won=true. We don't clear the run here so the
// player can see the victory state — handleRunChoice("abandon-run")
// from the menu clears it.
events.on("runEnded", ({ won }) => {
  // The roguelite.js completeNode flow already wrote saveStore. Pull
  // the latest into our cached reference.
  if (!won) {
    activeRun = null;
  } else {
    activeRun = loadRun();
  }
  refresh();
});

// Energy / stamina state — gates how many matches can be played per
// real-time window. PASSIVE regen ticks each frame via regenTick().
const energy = loadEnergy();
input.startMenu.setEnergy(energy, (packId) => purchaseEnergy(energy, packId));
// Edge-detect the match-over transition so the run controller knows
// when to capture battle outcomes.
let prevMatchOver = false;

let viewW = 0, viewH = 0;
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  viewW = window.innerWidth;
  viewH = window.innerHeight;
  canvas.width = Math.floor(viewW * dpr);
  canvas.height = Math.floor(viewH * dpr);
  canvas.style.width = viewW + "px";
  canvas.style.height = viewH + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  input.layoutOverlays(viewW, viewH);
}
window.addEventListener("resize", resize);
resize();

// Camera zoom. Default reads similar to the old fixed value so existing
// gameplay (piloting a fighter) doesn't shift. In spectator and admiral
// mode the user can pinch / scroll to zoom; the active value is read
// each frame and applied to the world transform + ship draw.
const DEFAULT_ZOOM = 0.5;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.0;
let zoom = DEFAULT_ZOOM;

const FIXED_DT = 1 / 60;
const MAX_ACCUM = 0.25;
let last = performance.now() / 1000;
let accum = 0;

function frame(now) {
  const t = now / 1000;
  let delta = t - last;
  last = t;
  if (delta > MAX_ACCUM) delta = MAX_ACCUM;
  accum += delta;

  // Let the input layer know whether the start menu is up so it can
  // intercept clicks before forwarding them to gameplay controls.
  input.menuActive = game.state === "menu";

  // Passive energy regen every frame. Idempotent; cheap.
  regenTick(energy);

  if (game.state === "menu") {
    const choice = input.startMenu.consumeStart();
    // Energy gate: deduct exactly here. The menu already filtered
    // clicks via canSpend, so a failure path is defensive only —
    // re-open the refill overlay and skip the start.
    if (choice && !spendEnergy(energy)) {
      input.startMenu.showRefill = true;
    } else if (choice) {
      if (choice.mode === "roguelite") {
        // Roguelite battles are launched indirectly: clicking a node on
        // the run map calls handleRunChoice("enter-node", ...) which
        // builds the modeConfig and calls startGame itself. The "START"
        // path from a Frontier-mode chip click should never fire — the
        // chip opens overlays via _emitStart returning early. Defensive
        // no-op for any future regression.
        return;
      }
      // Open / Defend / Custom / Admiral. Custom carries its full
      // roster bundle through; Admiral flips the input layer to show
      // the command panel.
      startGame(game, choice.mapW, choice.mapH, choice.race, choice.mode, null,
                choice.fleetMul, choice.customRoster || null);
      input.admiralActive = !!game.admiralMode;
      // The "Play" click is the user-gesture that unlocks Web Audio.
      audio.start();
    }
  } else {
    // Player input → controller.
    const ctrl = input.controller();
    game.playerController.thrust = ctrl.thrust;
    game.playerController.aim = ctrl.aim;
    game.playerController.firing = ctrl.firing;
    // Edge-triggered missile fire. The flag is consumed inside updateShip.
    // Clear stale presses when there's no live player to fire.
    game.playerController.firingMissile = input.consumeMissilePress();

    // Spectate hotkey OR on-screen SPECTATE button.
    if (input.consumeSpectateToggle()) {
      if (game.spectating) exitSpectate(game);
      else enterSpectate(game);
    }
    // Camera zoom: pinch (touch) + wheel (mouse) feed a single delta
    // pool. Spectator and admiral get to use it; piloting keeps the
    // default zoom so the player isn't fighting muscle-memory aim at
    // varying scales. Reset to default when leaving those modes so a
    // zoomed-out admiral doesn't carry a wide view into the next match.
    if (game.spectating || game.admiralMode) {
      const dz = input.consumePinchDelta();
      if (dz !== 0) {
        zoom *= (1 + dz);
        if (zoom < MIN_ZOOM) zoom = MIN_ZOOM;
        else if (zoom > MAX_ZOOM) zoom = MAX_ZOOM;
      }
    } else if (zoom !== DEFAULT_ZOOM) {
      zoom = DEFAULT_ZOOM;
      input.consumePinchDelta(); // drop any pending input
    }

    if (game.spectating) {
      if (input.consumeSpectateNext()) cycleSpectate(game, +1);
      if (input.consumeSpectatePrev()) cycleSpectate(game, -1);

      // Free-pan camera: in spectate, the left stick (or WASD) detaches
      // the camera from the locked target and lets the user roam the
      // arena. Re-lock happens when they cycle to a different ship via
      // Prev / Next. The right stick is unused in spectate.
      const camSpeed = 700; // world units per second at full deflection
      const panX = ctrl.thrust.x * camSpeed * delta;
      const panY = ctrl.thrust.y * camSpeed * delta;
      if (panX !== 0 || panY !== 0) {
        if (game.spectateCamera.locked) {
          // First nudge — seed camera at the current target before
          // unlocking so there's no jump.
          const t = getSpectateTarget(game);
          if (t) {
            game.spectateCamera.x = t.pos.x;
            game.spectateCamera.y = t.pos.y;
          }
          game.spectateCamera.locked = false;
        }
        game.spectateCamera.x += panX;
        game.spectateCamera.y += panY;
        // Clamp to arena so the user can't pan off into the void.
        const b = game.arena.bounds;
        if (game.spectateCamera.x < b.minX) game.spectateCamera.x = b.minX;
        if (game.spectateCamera.x > b.maxX) game.spectateCamera.x = b.maxX;
        if (game.spectateCamera.y < b.minY) game.spectateCamera.y = b.minY;
        if (game.spectateCamera.y > b.maxY) game.spectateCamera.y = b.maxY;
      }
    }

    // Edge-trigger: match just ended this frame. Roguelite handling
    // (capture fleet state, advance run) lives inside the matchEnded
    // listener registered above; this block only handles the
    // return-to-menu input.
    prevMatchOver = game.matchOver;

    if (game.matchOver && input.consumeEnterPress()) {
      const wasRoguelite = game.mode === "roguelite";
      restart(game);
      audio.stop();
      refresh();
      // If a Frontier run is still alive, re-open the run map so the
      // player lands back at the fleet/map view instead of the bare
      // main menu.
      if (wasRoguelite && activeRun) {
        input.startMenu.selectedMode = "roguelite";
        input.startMenu._layoutRunMap(viewW || 1200, viewH || 800);
        input.startMenu.showRunMap = true;
      }
    }
  }

  // P toggles music mute (works regardless of state). Routes through
  // applyMuteChange so the new state persists to saveStore.
  if (input.consumeMuteToggle()) applyMuteChange(!audio.isMuted());

  // Music plays only during active gameplay. Pause it on match-over
  // and on the start menu; resume when a new game kicks off (the
  // startGame branch above calls audio.start()).
  const shouldPlay = game.state === "playing" && !game.matchOver;
  if (shouldPlay && !musicWasPlaying) audio.start();
  else if (!shouldPlay && musicWasPlaying) audio.stop();
  musicWasPlaying = shouldPlay;

  while (accum >= FIXED_DT) {
    update(game, FIXED_DT);
    accum -= FIXED_DT;
  }

  draw();
  requestAnimationFrame(frame);
}

function draw() {
  // Camera: spectate target if spectating + locked, free-pan position
  // if unlocked, else player, else arena center.
  let camera;
  if (game.spectating) {
    if (game.spectateCamera && !game.spectateCamera.locked) {
      camera = { x: game.spectateCamera.x, y: game.spectateCamera.y };
    } else {
      const spec = getSpectateTarget(game);
      camera = spec
        ? { x: spec.pos.x, y: spec.pos.y }
        : (game.spectateCamera
          ? { x: game.spectateCamera.x, y: game.spectateCamera.y }
          : { x: ARENA.width / 2, y: ARENA.height / 2 });
    }
  } else {
    const player = game.ships.find((s) => s.isPlayer && !s.dead);
    camera = player
      ? { x: player.pos.x, y: player.pos.y }
      : { x: ARENA.width / 2, y: ARENA.height / 2 };
  }

  _lastCamera.x = camera.x;
  _lastCamera.y = camera.y;
  audio.tickSfxBudget();

  drawArena(ctx, game.starfield, camera, viewW, viewH, zoom);

  ctx.save();
  ctx.translate(viewW / 2, viewH / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-camera.x, -camera.y);

  drawArenaBounds(ctx);
  // Persistent wrecks sit UNDER everything live so a fresh kill drops
  // into the background as the battle keeps going on top.
  if (game.wrecks) for (const w of game.wrecks) drawWreck(ctx, w);
  // Smoke particles render behind the hull layer so plumes look like
  // they're trailing from the ship rather than painted on top of it.
  if (game.particles) {
    for (const p of game.particles) if (p.kind === "smoke") drawParticle(ctx, p);
  }
  for (const ship of game.ships) if (!ship.dead) drawShip(ctx, ship, zoom);
  for (const p of game.projectiles) if (!p.dead) drawProjectile(ctx, p);
  drawBeams(ctx, game);
  // Persistent debris on top of live ships — fresh chunks visibly chip
  // off the hull mid-engagement instead of fading with the particles.
  if (game.debris) for (const d of game.debris) drawDebris(ctx, d);
  // Sparks / fire / debris / shockwaves render on top of ships and beams
  // so a freshly-killed module's explosion reads above the hull silhouette.
  if (game.particles) {
    for (const p of game.particles) if (p.kind !== "smoke") drawParticle(ctx, p);
  }

  ctx.restore();

  drawHUD(ctx, game, viewW, viewH, input.missileBtn, input.startMenu);
  // Touch-action overlays: only meaningful in-match, hidden in the
  // pre-match menu and at match-over so they don't catch stray taps.
  if (game.state === "playing" && !game.matchOver) {
    const player = game.ships.find((s) => s.isPlayer && !s.dead);
    if (player || game.spectating) {
      // FIRE button is only useful when there's a live player to fire.
      if (player) input.fireBtn.draw(ctx);
      input.spectateBtn.draw(ctx, game.spectating);
    }
    // Admiral command panel — only in admiral mode, only mid-match.
    if (game.admiralMode) input.admiralPanel.draw(ctx);
  }
  input.drawSticks(ctx);
}

window.addEventListener("pointerdown", () => {
  if (game.matchOver && game.state === "playing") {
    const wasRoguelite = game.mode === "roguelite";
    restart(game);
    refresh();
    if (wasRoguelite && activeRun) {
      input.startMenu.selectedMode = "roguelite";
      input.startMenu._layoutRunMap(viewW || 1200, viewH || 800);
      input.startMenu.showRunMap = true;
    }
  }
});

requestAnimationFrame(frame);
