import { createGame, update, restart } from "./game.js";
import { drawArena, drawArenaBounds, ARENA } from "./arena.js";
import { drawShip } from "./ship.js";
import { drawProjectile } from "./projectile.js";
import { drawHUD } from "./hud.js";
import { InputManager } from "./input.js";

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
}
window.addEventListener("resize", resize);
resize();

// Player POV zoom. 0.5 = zoomed out 2x (see twice as much of the arena).
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

  // Pump player input each frame into the shared controller object.
  const ctrl = input.controller();
  game.playerController.thrust = ctrl.thrust;
  game.playerController.aim = ctrl.aim;
  game.playerController.firing = ctrl.firing;

  // Edge-triggered Enter restarts the match when it's over.
  if (game.matchOver && input.consumeEnterPress()) restart(game);

  while (accum >= FIXED_DT) {
    update(game, FIXED_DT);
    accum -= FIXED_DT;
  }

  draw();
  requestAnimationFrame(frame);
}

function draw() {
  // Camera follows the player ship, falls back to arena center.
  const player = game.ships.find((s) => s.isPlayer && !s.dead);
  const camera = player
    ? { x: player.pos.x, y: player.pos.y }
    : { x: ARENA.width / 2, y: ARENA.height / 2 };

  drawArena(ctx, game.starfield, camera, viewW, viewH);

  // World transform.
  ctx.save();
  ctx.translate(viewW / 2 - camera.x, viewH / 2 - camera.y);

  drawArenaBounds(ctx);
  for (const ship of game.ships) if (!ship.dead) drawShip(ctx, ship);
  for (const p of game.projectiles) if (!p.dead) drawProjectile(ctx, p);

  ctx.restore();

  drawHUD(ctx, game, viewW, viewH);
  input.drawSticks(ctx);
}

// Tap-to-restart on match end. Use a separate listener so it doesn't fight
// with the joystick pointer capture.
window.addEventListener("pointerdown", () => {
  if (game.matchOver) restart(game);
});

requestAnimationFrame(frame);
