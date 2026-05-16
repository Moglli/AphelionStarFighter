import { CLASSES, SIDES } from "./classes.js";
import { ARENA } from "./arena.js";

const CLASS_ORDER = ["fighter", "frigate", "cruiser", "battleship"];

function countBySide(ships) {
  const out = {
    blue: { fighter: 0, frigate: 0, cruiser: 0, battleship: 0 },
    red:  { fighter: 0, frigate: 0, cruiser: 0, battleship: 0 },
  };
  for (const s of ships) if (!s.dead) out[s.side][s.klass]++;
  return out;
}

export function drawHUD(ctx, game, viewW, viewH) {
  const counts = countBySide(game.ships);

  // Top strength bars: blue on left, red on right.
  drawSideStrip(ctx, counts.blue, "blue", 16, 16, "left");
  drawSideStrip(ctx, counts.red,  "red",  viewW - 16, 16, "right");

  // Player HP bar + respawn message.
  const player = game.ships.find((s) => s.isPlayer && !s.dead);
  if (player) {
    drawPlayerHP(ctx, player, viewW, viewH);
  } else if (game.respawnTimer > 0) {
    ctx.fillStyle = "#fff";
    ctx.font = "bold 28px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`Respawn in ${game.respawnTimer.toFixed(1)}s`, viewW / 2, 90);
    ctx.textAlign = "left";
  }

  // End-of-match card.
  if (game.matchOver) {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, viewH / 2 - 80, viewW, 160);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 42px system-ui, sans-serif";
    ctx.textAlign = "center";
    const msg = game.winner === "blue" ? "ALLIED VICTORY" : "HOSTILE VICTORY";
    ctx.fillText(msg, viewW / 2, viewH / 2);
    ctx.font = "18px system-ui, sans-serif";
    ctx.fillText("Tap to restart", viewW / 2, viewH / 2 + 36);
    ctx.textAlign = "left";
  }

  // Minimap.
  drawMinimap(ctx, game, viewW, viewH);
}

function drawSideStrip(ctx, counts, side, anchorX, anchorY, align) {
  const palette = SIDES[side];
  ctx.fillStyle = palette.primary;
  ctx.font = "bold 14px system-ui, sans-serif";
  ctx.textAlign = align;
  ctx.fillText(palette.name, anchorX, anchorY + 14);
  ctx.font = "13px system-ui, sans-serif";
  ctx.fillStyle = "#cdf";
  let y = anchorY + 34;
  for (const klass of CLASS_ORDER) {
    const c = counts[klass];
    if (c === 0) ctx.globalAlpha = 0.35; else ctx.globalAlpha = 1;
    ctx.fillText(`${CLASSES[klass].name}: ${c}`, anchorX, y);
    y += 18;
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
}

function drawPlayerHP(ctx, player, viewW, viewH) {
  const w = 260, h = 12;
  const x = (viewW - w) / 2;
  const y = viewH - 36;
  ctx.fillStyle = "#222";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#4f6";
  ctx.fillRect(x, y, w * (player.hp / player.hpMax), h);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = "#fff";
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`HULL ${Math.max(0, Math.round(player.hp))} / ${player.hpMax}`, viewW / 2, y - 4);
  ctx.textAlign = "left";
}

function drawMinimap(ctx, game, viewW, viewH) {
  const mapW = 180, mapH = 135;
  const x = viewW - mapW - 16;
  const y = viewH - mapH - 16;
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(x, y, mapW, mapH);
  ctx.strokeStyle = "#456";
  ctx.strokeRect(x, y, mapW, mapH);

  const sx = mapW / ARENA.width;
  const sy = mapH / ARENA.height;
  for (const s of game.ships) {
    if (s.dead) continue;
    const px = x + s.pos.x * sx;
    const py = y + s.pos.y * sy;
    ctx.fillStyle = s.isPlayer ? "#fff" : SIDES[s.side].primary;
    const r = s.isPlayer ? 2.5 : (s.klass === "battleship" ? 2.2 : s.klass === "cruiser" ? 1.8 : 1.2);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
}
