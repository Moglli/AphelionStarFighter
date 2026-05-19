import {
  createGame, update, restart, startGame,
  enterSpectate, exitSpectate, cycleSpectate, getSpectateTarget,
} from "./game.js";
import { drawArena, drawArenaBounds, ARENA } from "./arena.js";
import { drawShip } from "./ship.js";
import { drawProjectile } from "./projectile.js";
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

  if (game.state === "menu") {
    const choice = input.startMenu.consumeStart();
    if (choice) startGame(game, choice);
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
  // Camera: spectate target if spectating, else player, else arena center.
  let camera;
  if (game.spectating) {
    const spec = getSpectateTarget(game);
    camera = spec
      ? { x: spec.pos.x, y: spec.pos.y }
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
  for (const ship of game.ships) if (!ship.dead) drawShip(ctx, ship);
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
