import {
  createGame, update, restart, startGame,
  enterSpectate, exitSpectate, cycleSpectate, getSpectateTarget,
} from "./game.js";
import { drawArena, drawArenaBounds, ARENA } from "./arena.js";
import { drawShip, drawWreck } from "./ship.js";
import { drawProjectile } from "./projectile.js";
import { drawWreck, drawDebris } from "./wreckage.js";
import { drawHUD, drawBeams } from "./hud.js";
import { InputManager } from "./input.js";
import { saveStore } from "./save.js";
import { events } from "./events.js";
import { audio } from "./audio.js";
import { progression } from "./progression.js";

// Touch the foundation modules so they're initialized on startup. Save
// data is loaded into memory before the first frame; audio + progression
// subscribe to events at construction.
void saveStore;
void events;
void audio;
void progression;

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const input = new InputManager(canvas);
const game = createGame();
// Rally taps on the minimap need to read game.ships at click time.
input._gameRef = game;
window.game = game; // for console smoke-testing

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
  // Mirror spectate state so the on-screen spectate panel can decide
  // which sub-buttons (toggle vs prev/next) are hit-active.
  input.spectating = game.spectating;

  if (game.state === "menu") {
    // Start menu launches with the chip selections; the custom screen
    // launches with an explicit roster bundled into the same opts shape.
    const customStart = input.customScreen.consumeStart();
    if (customStart) {
      const sel = input.startMenu;
      const sizeRect = sel.sizeRects.find((r) => r.key === sel.selectedSize)
                    || sel.sizeRects[0];
      // The Custom screen offers two launch buttons: START MATCH spawns
      // the player's allied roster against a mirrored hostile roster
      // (mode="custom"); TAKE INTO WAVES carries only the allied build
      // into endless-survival (mode="waves").
      const mode = customStart.intoMode === "waves" ? "waves" : "custom";
      startGame(game, {
        mode,
        klass: sel.selectedKlass,
        race: sel.selectedRace,
        mapW: sizeRect.mapW,
        mapH: sizeRect.mapH,
        customRoster: customStart,
      });
      input.menuScreen = "menu";
    } else {
      const choice = input.startMenu.consumeStart();
      if (choice) startGame(game, choice);
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

    // Spectate hotkeys.
    if (input.consumeSpectateToggle()) {
      if (game.spectating) exitSpectate(game);
      else enterSpectate(game);
    }
    if (game.spectating) {
      if (input.consumeSpectateNext()) cycleSpectate(game, +1);
      if (input.consumeSpectatePrev()) cycleSpectate(game, -1);
    }

    if (game.matchOver && input.consumeEnterPress()) restart(game);
  }

  while (accum >= FIXED_DT) {
    update(game, FIXED_DT);
    accum -= FIXED_DT;
  }

  draw();
  requestAnimationFrame(frame);
}

function draw() {
  // Camera: spectator panning rig if spectating, else player ship, else
  // arena center.
  let camera;
  if (game.spectating) {
    camera = game.spectateCamera
      ? { x: game.spectateCamera.x, y: game.spectateCamera.y }
      : { x: ARENA.width / 2, y: ARENA.height / 2 };
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
  // Wrecks under live ships so combatants overlay the battlefield litter.
  if (game.wrecks) for (const w of game.wrecks) drawWreck(ctx, w);
  // Wreckage sits under live ships so a fly-by passes over the debris.
  if (game.wreckage && game.wreckage.length > 0) {
    for (const w of game.wreckage) drawWreck(ctx, w);
  }
  for (const ship of game.ships) if (!ship.dead) drawShip(ctx, ship);
  // Small fragments on top so sparks read against hulls + space.
  if (game.debris) for (const d of game.debris) drawDebris(ctx, d);
  for (const p of game.projectiles) if (!p.dead) drawProjectile(ctx, p);
  drawBeams(ctx, game);

  ctx.restore();

  drawHUD(ctx, game, viewW, viewH, input);
  input.drawSticks(ctx);
}

window.addEventListener("pointerdown", () => {
  if (game.matchOver && game.state === "playing") restart(game);
});

requestAnimationFrame(frame);
