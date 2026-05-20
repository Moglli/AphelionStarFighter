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
  loadCampaign, saveCampaign, getMissionConfig,
  buildPlayerUpgrade, purchaseUpgrade, recordVictory,
} from "./campaign.js";
import { resolveSpec } from "./races.js";
import {
  loadEnergy, regenTick, spendEnergy, purchase as purchaseEnergy,
} from "./energy.js";
import { saveStore } from "./save.js";

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

// Restore persisted music mute state and wire the Settings overlay
// + the P key shortcut to both apply the change to the live audio
// graph AND persist it through saveStore.
audio.setMuted(!!saveStore.get().settings.musicMuted);
function applyMuteChange(muted) {
  audio.setMuted(muted);
  saveStore.update((d) => { d.settings.musicMuted = muted; });
}
input.startMenu.setSettings(
  () => ({ musicMuted: audio.isMuted() }),
  (patch) => { if (typeof patch.musicMuted === "boolean") applyMuteChange(patch.musicMuted); },
);

// Admiral panel — reads and writes game.directives directly. The map
// is allocated by modes/admiral.js at match start; null in other
// modes so the AI fast-paths through the directive check.
input.admiralPanel.setHooks(
  () => game.directives,
  (klass, posture) => { if (game.directives && game.directives[klass]) game.directives[klass].posture = posture; },
  (klass, missiles) => { if (game.directives && game.directives[klass]) game.directives[klass].missiles = missiles; },
);

// Campaign state is loaded from localStorage on boot and kept in memory
// so the menu can render mission progress + money. Mutations happen in
// purchase / victory callbacks below and re-save themselves.
const campaign = loadCampaign();
input.startMenu.setCampaign(campaign, (key) => purchaseUpgrade(campaign, key));

// Energy / stamina state — gates how many matches can be played per
// real-time window. PASSIVE regen ticks each frame via regenTick().
const energy = loadEnergy();
input.startMenu.setEnergy(energy, (packId) => purchaseEnergy(energy, packId));
// Edge-detect the match-over transition so we credit a campaign
// victory exactly once even though matchOver stays true until the
// player taps to leave.
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

const ZOOM = 0.5;

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
      if (choice.mode === "campaign" && !campaign.completed) {
        // Campaign mission: roster + map are mission-defined, player
        // ship gets the upgrade specOverride. Campaign rosters are
        // hand-tuned for mission balance, so the fleet-size chip is
        // ignored here.
        const mc = getMissionConfig(campaign.mission, choice.race);
        const baseSpec = resolveSpec(choice.race, "fighter");
        const playerOverride = buildPlayerUpgrade(campaign, baseSpec);
        startGame(game, mc.mapW, mc.mapH, choice.race, "campaign", {
          enemies: mc.enemies,
          allies: mc.allies,
          playerOverride,
        }, 1);
        // Stash a reference + the staged reward so the match-over HUD
        // can display it without re-deriving.
        game.campaign.totalMoney = campaign.money;
        game.campaign.lastReward = mc.reward;
        game.campaign.missionNumber = mc.mission;
      } else {
        // Open / Defend / Custom / Admiral, or Campaign-completed
        // (falls through to a free skirmish at the player's chosen
        // map size + fleet size). Custom carries its full roster
        // bundle through; Admiral flips the input layer to show the
        // command panel.
        const mode = choice.mode === "campaign" ? "open" : choice.mode;
        startGame(game, choice.mapW, choice.mapH, choice.race, mode, null,
                  choice.fleetMul, choice.customRoster || null);
        input.admiralActive = !!game.admiralMode;
      }
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

    // Edge-trigger: match just ended this frame. Bank a campaign
    // victory exactly once.
    if (game.matchOver && !prevMatchOver) {
      if (game.mode === "campaign" && game.winner === "blue" && game.campaign) {
        recordVictory(campaign);
        game.campaign.totalMoney = campaign.money;
      }
    }
    prevMatchOver = game.matchOver;

    if (game.matchOver && input.consumeEnterPress()) {
      restart(game);
      audio.stop();
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

  drawArena(ctx, game.starfield, camera, viewW, viewH, ZOOM);

  ctx.save();
  ctx.translate(viewW / 2, viewH / 2);
  ctx.scale(ZOOM, ZOOM);
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
  for (const ship of game.ships) if (!ship.dead) drawShip(ctx, ship, ZOOM);
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
  if (game.matchOver && game.state === "playing") restart(game);
});

requestAnimationFrame(frame);
