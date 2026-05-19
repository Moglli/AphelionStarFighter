import { CLASSES, SIDES } from "./classes.js";
import { ARENA, MAP_SIZES } from "./arena.js";
import { getSpectateTarget } from "./game.js";
import { RACES } from "./races.js";
import { MODES } from "./modes/index.js";
import { saveStore } from "./save.js";
import { progression } from "./progression.js";

const CLASS_ORDER = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier"];

// Toast queue: progression emits text labels for XP / credit awards;
// the HUD picks them up here and decays each over TOAST_LIFETIME seconds.
const TOAST_LIFETIME = 2.6;
const toasts = [];
let lastToastDrainMs = performance.now();

function drainAndAgeToasts() {
  const now = performance.now();
  const dt = (now - lastToastDrainMs) / 1000;
  lastToastDrainMs = now;
  for (const t of toasts) t.age += dt;
  // Drop expired.
  while (toasts.length > 0 && toasts[0].age >= TOAST_LIFETIME) toasts.shift();
  // Pull new awards.
  const fresh = progression.consumeRecentRewards();
  for (const r of fresh) toasts.push({ text: r.text, kind: r.kind, age: 0 });
  // Cap the visible stack at 6.
  while (toasts.length > 6) toasts.shift();
}

const TOAST_COLORS = {
  xp:      "#7df",
  credits: "#fd6",
  premium: "#b6f",
  win:     "#9f8",
  levelup: "#fff",
};

function drawToasts(ctx, viewW, viewH) {
  drainAndAgeToasts();
  if (toasts.length === 0) return;
  ctx.save();
  ctx.textAlign = "right";
  const x = viewW - 16;
  let y = viewH * 0.32;
  for (const t of toasts) {
    const a = Math.max(0, 1 - t.age / TOAST_LIFETIME);
    ctx.globalAlpha = a;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(x - 320, y - 18, 320, 26);
    ctx.fillStyle = TOAST_COLORS[t.kind] || "#cef";
    ctx.font = t.kind === "levelup" ? "bold 16px system-ui, sans-serif" : "bold 13px system-ui, sans-serif";
    ctx.fillText(t.text, x - 8, y);
    y += 30;
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function countBySide(ships) {
  const out = {
    blue: { fighter: 0, bomber: 0, frigate: 0, cruiser: 0, battleship: 0, carrier: 0 },
    red:  { fighter: 0, bomber: 0, frigate: 0, cruiser: 0, battleship: 0, carrier: 0 },
  };
  for (const s of ships) if (!s.dead) out[s.side][s.klass]++;
  return out;
}

export function drawHUD(ctx, game, viewW, viewH, input) {
  if (game.state === "menu") {
    if (input.menuScreen === "hangar") {
      input.hangar.draw(ctx, viewW, viewH);
    } else if (input.startMenu) {
      input.startMenu.draw(ctx, viewW, viewH);
    }
    return;
  }

  const counts = countBySide(game.ships);

  drawSideStrip(ctx, counts.blue, "blue", game.alliedRace, 16, 16, "left");
  drawSideStrip(ctx, counts.red,  "red",  game.hostileRace, viewW - 16, 16, "right");

  drawModeBanner(ctx, game, viewW);

  const player = game.ships.find((s) => s.isPlayer && !s.dead);
  if (player) {
    drawPlayerHUD(ctx, player, viewW, viewH, input.missileBtn);
  } else if (game.spectating) {
    drawSpectateOverlay(ctx, game, viewW, viewH);
  } else if (game.respawnTimer > 0 && game.mode !== "waves") {
    ctx.fillStyle = "#fff";
    ctx.font = "bold 28px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`Respawn in ${game.respawnTimer.toFixed(1)}s`, viewW / 2, 90);
    ctx.textAlign = "left";
  }

  if (game.matchOver) {
    drawMatchOverOverlay(ctx, game, viewW, viewH);
  }

  drawToasts(ctx, viewW, viewH);
  drawMinimap(ctx, game, viewW, viewH);
}

function drawModeBanner(ctx, game, viewW) {
  const mode = MODES[game.mode];
  if (!mode) return;
  ctx.save();
  ctx.textAlign = "center";
  ctx.fillStyle = "#9bd";
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.fillText(mode.label.toUpperCase(), viewW / 2, 18);
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillStyle = "#cef";
  let line = `Score ${game.score}  ·  Kills ${game.kills}`;
  if (game.mode === "waves" && game.modeState) {
    line = `Wave ${game.modeState.wave}  ·  ${line}`;
  }
  ctx.fillText(line, viewW / 2, 36);
  ctx.textAlign = "left";
  ctx.restore();
}

function drawMatchOverOverlay(ctx, game, viewW, viewH) {
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(0, viewH / 2 - 110, viewW, 220);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 42px system-ui, sans-serif";
  ctx.textAlign = "center";
  let title;
  if (game.mode === "waves") {
    title = `WAVE ${game.modeState ? game.modeState.survivedWaves : 0} SURVIVED`;
  } else if (game.mode === "daily") {
    title = game.winner === "blue" ? "DAILY CLEARED" : "DAILY FAILED";
  } else {
    title = game.winner === "blue" ? "ALLIED VICTORY" : "HOSTILE VICTORY";
  }
  ctx.fillText(title, viewW / 2, viewH / 2 - 30);
  ctx.font = "16px system-ui, sans-serif";
  ctx.fillStyle = "#cef";
  ctx.fillText(`Score ${game.score}  ·  Kills ${game.kills}`, viewW / 2, viewH / 2);
  const best = saveStore.get().bestScores;
  if (game.mode === "arena" || game.mode === "waves") {
    const b = best[game.mode];
    ctx.fillStyle = "#9bd";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText(`Best: ${b}`, viewW / 2, viewH / 2 + 22);
  }
  ctx.font = "16px system-ui, sans-serif";
  ctx.fillStyle = "#fff";
  ctx.fillText("Tap to return to menu", viewW / 2, viewH / 2 + 60);
  ctx.textAlign = "left";
}

function drawSideStrip(ctx, counts, side, race, anchorX, anchorY, align) {
  const palette = SIDES[side];
  ctx.fillStyle = palette.primary;
  ctx.font = "bold 14px system-ui, sans-serif";
  ctx.textAlign = align;
  ctx.fillText(palette.name, anchorX, anchorY + 14);
  // Race name beneath the side label.
  const raceInfo = RACES[race] || RACES.terran;
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillStyle = "#9bd";
  ctx.fillText(raceInfo.name.toUpperCase(), anchorX, anchorY + 30);
  ctx.font = "13px system-ui, sans-serif";
  ctx.fillStyle = "#cdf";
  let y = anchorY + 50;
  for (const klass of CLASS_ORDER) {
    const c = counts[klass];
    if (c === 0) ctx.globalAlpha = 0.35; else ctx.globalAlpha = 1;
    ctx.fillText(`${CLASSES[klass].name}: ${c}`, anchorX, y);
    y += 18;
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
}

function drawPlayerHUD(ctx, player, viewW, viewH, missileBtn) {
  const w = 260, h = 12;
  const x = (viewW - w) / 2;
  const y = viewH - 36;

  // Shield bar (above hull).
  if (player.shieldMax > 0) {
    const sy = y - 16;
    ctx.fillStyle = "#113";
    ctx.fillRect(x, sy, w, h);
    ctx.fillStyle = "#7df";
    ctx.fillRect(x, sy, w * (player.shield / player.shieldMax), h);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.strokeRect(x, sy, w, h);
    ctx.fillStyle = "#fff";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      `SHIELD ${Math.max(0, Math.round(player.shield))} / ${player.shieldMax}`,
      viewW / 2, sy - 3);
    ctx.textAlign = "left";
  }

  // Hull bar.
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
  ctx.fillText(`HULL ${Math.max(0, Math.round(player.hp))} / ${player.hpMax}`, viewW / 2, y - 3);
  ctx.textAlign = "left";

  // Cannon ammo readout: a short bar below the hull bar.
  if (player.spec.weapon && player.spec.weapon.capacity != null) {
    const cap = player.spec.weapon.capacity;
    const ay = y + h + 4;
    const aw = w, ah = 8;
    ctx.fillStyle = "#221";
    ctx.fillRect(x, ay, aw, ah);
    if (player.weaponReloading) {
      const frac = 1 - (player.weaponReloadTimer / player.spec.weapon.reloadTime);
      ctx.fillStyle = "#fa3";
      ctx.fillRect(x, ay, aw * frac, ah);
    } else {
      ctx.fillStyle = "#fd6";
      ctx.fillRect(x, ay, aw * (player.weaponAmmo / cap), ah);
    }
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.strokeRect(x, ay, aw, ah);
    ctx.fillStyle = "#fff";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "center";
    const label = player.weaponReloading
      ? `GUN RELOADING ${Math.max(0, player.weaponReloadTimer).toFixed(1)}s`
      : `GUN ${player.weaponAmmo} / ${cap}`;
    ctx.fillText(label, viewW / 2, ay + ah + 9);
    ctx.textAlign = "left";
  }

  // Missile cooldown indicator: also drawn through the on-screen button.
  if (missileBtn) {
    const cd = player.spec.missile ? player.spec.missile.cooldown : 1;
    const remain = player.missileCd;
    const ready = remain <= 0;
    const frac = ready ? 0 : (remain / cd);
    missileBtn.draw(ctx, ready, frac);
  }
}

function drawSpectateOverlay(ctx, game, viewW, viewH) {
  const t = getSpectateTarget(game);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, viewH - 60, viewW, 60);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 16px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("SPECTATING", viewW / 2, viewH - 38);
  ctx.font = "12px system-ui, sans-serif";
  if (t) {
    const palette = SIDES[t.side];
    ctx.fillStyle = palette.primary;
    const armorPart = t.armorMax > 0
      ? `  ·  ARMOR ${Math.round(t.armor)}/${t.armorMax}`
      : "";
    const raceInfo = RACES[t.race] || RACES.terran;
    ctx.fillText(
      `${palette.name} ${raceInfo.name} ${t.spec.name}  ·  HULL ${Math.round(t.hp)}/${t.hpMax}  ·  SHIELD ${Math.round(t.shield)}/${t.shieldMax}${armorPart}`,
      viewW / 2, viewH - 20);
  } else {
    ctx.fillStyle = "#cdf";
    ctx.fillText("No targets available", viewW / 2, viewH - 20);
  }
  ctx.fillStyle = "#cdf";
  ctx.fillText("V: return to ship   ·   N / B: cycle target", viewW / 2, viewH - 6);
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
    const isSpec = game.spectating && s.id === game.spectateTargetId;
    ctx.fillStyle = (s.isPlayer || isSpec) ? "#fff" : SIDES[s.side].primary;
    const r = (s.isPlayer || isSpec) ? 2.5
      : (s.klass === "carrier" ? 2.6
      : s.klass === "battleship" ? 2.2
      : s.klass === "cruiser" ? 1.8
      : s.klass === "bomber" ? 1.6
      : 1.2);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Beams are rendered in the world transform (called from main.js).
// Heavy lasers sustain for ~3 seconds; brightness scales with the
// fraction of beam life remaining so it fades toward the cutoff. A
// per-frame jitter on width makes the sustained beam visibly "live"
// instead of static.
export function drawBeams(ctx, game) {
  if (!game.beams || game.beams.length === 0) return;
  const now = performance.now();
  for (const beam of game.beams) {
    const life = beam.duration > 0 ? beam.ttl / beam.duration : 1;
    // Bright in the middle of the beam, fades out near the tail.
    const alpha = Math.max(0.35, Math.min(1, 0.65 + 0.5 * life));
    const jitter = 0.85 + 0.15 * Math.sin(now * 0.06 + (beam.ownerId || 0));
    const hit = beam.hit || endPoint(beam);
    // Outer glow.
    ctx.globalAlpha = 0.4 * alpha;
    ctx.strokeStyle = beam.color;
    ctx.lineWidth = 14 * jitter;
    ctx.beginPath();
    ctx.moveTo(beam.origin.x, beam.origin.y);
    ctx.lineTo(hit.x, hit.y);
    ctx.stroke();
    // Core.
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3.5 * jitter;
    ctx.beginPath();
    ctx.moveTo(beam.origin.x, beam.origin.y);
    ctx.lineTo(hit.x, hit.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function endPoint(beam) {
  // Extend by full range in the original aim direction if no hit recorded.
  // Approximation: aim from origin toward `target.pos` when we still have it.
  if (beam.target && beam.target.pos) {
    const dx = beam.target.pos.x - beam.origin.x;
    const dy = beam.target.pos.y - beam.origin.y;
    const d = Math.hypot(dx, dy) || 1;
    const r = Math.min(d, beam.range);
    return { x: beam.origin.x + (dx / d) * r, y: beam.origin.y + (dy / d) * r };
  }
  return { x: beam.origin.x + beam.range, y: beam.origin.y };
}
