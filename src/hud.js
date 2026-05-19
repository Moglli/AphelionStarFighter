import { CLASSES, SIDES } from "./classes.js";
import { ARENA, MAP_SIZES } from "./arena.js";
import { getSpectateTarget } from "./game.js";
import { RACES } from "./races.js";

const CLASS_ORDER = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier", "station"];

// Friendly labels for module names that appear in the target panel.
const MODULE_LABELS = {
  laser:            "Heavy Laser",
  "missile-fwd":    "Missile Bay Fwd",
  "missile-aft":    "Missile Bay Aft",
  "broadside-port": "Broadside Port",
  "broadside-stbd": "Broadside Stbd",
  "pd-bow":         "PD Bow",
  "pd-stern":       "PD Stern",
  hangar:           "Hangar",
  "pd-port":        "PD Port",
  "pd-stbd":        "PD Stbd",
  "torpedo-bay":    "Torpedo Bay",
  "pd-cluster":     "PD Cluster",
};

function countBySide(ships) {
  const out = {
    blue: { fighter: 0, bomber: 0, frigate: 0, cruiser: 0, battleship: 0, carrier: 0, station: 0 },
    red:  { fighter: 0, bomber: 0, frigate: 0, cruiser: 0, battleship: 0, carrier: 0, station: 0 },
  };
  for (const s of ships) if (!s.dead) out[s.side][s.klass]++;
  return out;
}

export function drawHUD(ctx, game, viewW, viewH, missileBtn, startMenu) {
  if (game.state === "menu") {
    if (startMenu) startMenu.draw(ctx, viewW, viewH);
    return;
  }

  const counts = countBySide(game.ships);

  drawSideStrip(ctx, counts.blue, "blue", game.alliedRace, 16, 16, "left");
  drawSideStrip(ctx, counts.red,  "red",  game.hostileRace, viewW - 16, 16, "right");

  const player = game.ships.find((s) => s.isPlayer && !s.dead);
  if (player) {
    drawPlayerHUD(ctx, player, viewW, viewH, missileBtn);
  } else if (game.spectating) {
    drawSpectateOverlay(ctx, game, viewW, viewH);
  } else if (game.respawnTimer > 0) {
    ctx.fillStyle = "#fff";
    ctx.font = "bold 28px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`Respawn in ${game.respawnTimer.toFixed(1)}s`, viewW / 2, 90);
    ctx.textAlign = "left";
  }

  if (game.matchOver) {
    const isCampaign = game.mode === "campaign";
    const panelH = isCampaign ? 220 : 160;
    ctx.fillStyle = "rgba(0,0,0,0.62)";
    ctx.fillRect(0, viewH / 2 - panelH / 2, viewW, panelH);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 42px system-ui, sans-serif";
    ctx.textAlign = "center";
    let msg;
    if (isCampaign) {
      msg = game.winner === "blue" ? "MISSION COMPLETE" : "MISSION FAILED";
    } else {
      msg = game.winner === "blue" ? "ALLIED VICTORY" : "HOSTILE VICTORY";
    }
    ctx.fillText(msg, viewW / 2, viewH / 2 - (isCampaign ? 30 : 0));
    if (isCampaign && game.campaign) {
      ctx.font = "bold 22px system-ui, sans-serif";
      if (game.winner === "blue") {
        ctx.fillStyle = "#fe8";
        ctx.fillText(`+${game.campaign.lastReward.toLocaleString()} credits`,
          viewW / 2, viewH / 2 + 12);
        ctx.fillStyle = "#cef";
        ctx.font = "16px system-ui, sans-serif";
        ctx.fillText(`Balance: $${game.campaign.totalMoney.toLocaleString()}`,
          viewW / 2, viewH / 2 + 38);
      } else {
        ctx.fillStyle = "#fdb";
        ctx.fillText("No reward — retry the mission", viewW / 2, viewH / 2 + 12);
      }
    }
    ctx.fillStyle = "#fff";
    ctx.font = "18px system-ui, sans-serif";
    const prompt = isCampaign
      ? (game.winner === "blue" ? "Tap to return to hangar" : "Tap to retry")
      : "Tap to restart";
    ctx.fillText(prompt, viewW / 2, viewH / 2 + (isCampaign ? 78 : 36));
    ctx.textAlign = "left";
  }

  const focusTarget = pickFocusTarget(game);
  if (focusTarget) drawTargetPanel(ctx, focusTarget, viewW, viewH);

  drawMinimap(ctx, game, viewW, viewH);
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
  ctx.fillStyle = "#0a0e16";
  ctx.fillRect(x, y, mapW, mapH);
  ctx.strokeStyle = "#456";
  ctx.lineWidth = 1.5;
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
      : (s.klass === "station" ? 2.8
      : s.klass === "carrier" ? 2.6
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
export function drawBeams(ctx, game) {
  if (!game.beams || game.beams.length === 0) return;
  for (const beam of game.beams) {
    // Alpha curve over the beam's lifetime — full brightness in the
    // middle, soft falloff at start and end. Uses the recorded
    // `duration` instead of a magic constant so the curve scales with
    // whichever class fired the beam.
    const dur = beam.duration || 1;
    const frac = Math.max(0, Math.min(1, beam.ttl / dur));
    const fadeOut = Math.min(1, frac * 5);     // last 20% fades
    const fadeIn  = Math.min(1, (1 - frac) * 6); // first ~16% ramps
    const alpha = Math.max(0.35, fadeOut * fadeIn);
    // Tiny per-frame width jitter so a 3s sustained beam reads "live".
    const wobble = 1 + Math.sin(performance.now() / 60 + beam.ownerId * 1.3) * 0.12;
    const hit = beam.hit || endPoint(beam);
    // Outer glow.
    ctx.globalAlpha = 0.4 * alpha;
    ctx.strokeStyle = beam.color;
    ctx.lineWidth = 12 * wobble;
    ctx.beginPath();
    ctx.moveTo(beam.origin.x, beam.origin.y);
    ctx.lineTo(hit.x, hit.y);
    ctx.stroke();
    // Core.
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3 * wobble;
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

// ---------------------------------------------------------------------------
// Locked-target panel: picks the most relevant enemy capital to surface
// and renders its hull / armor / per-module status. When the player is
// alive the focus is the nearest enemy capital (with modules); when
// spectating, the spectated ship if it carries any modules.
// ---------------------------------------------------------------------------
function pickFocusTarget(game) {
  if (game.spectating) {
    const t = getSpectateTarget(game);
    if (t && !t.dead && t.modules) return t;
  }
  const player = game.ships.find((s) => s.isPlayer && !s.dead);
  if (!player) return null;
  let best = null, bestD2 = Infinity;
  for (const s of game.ships) {
    if (s.dead || s.side === player.side) continue;
    if (!s.modules || s.modules.length === 0) continue;
    const dx = s.pos.x - player.pos.x;
    const dy = s.pos.y - player.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { best = s; bestD2 = d2; }
  }
  return best;
}

function drawTargetPanel(ctx, ship, viewW, viewH) {
  const rowH = 16;
  const headerH = 64;
  const padX = 12, padY = 10;
  const moduleRows = ship.modules.length;
  const panelW = 280;
  const panelH = headerH + moduleRows * rowH + padY * 2;
  const x = 16;
  const y = viewH - panelH - 16;

  ctx.fillStyle = "rgba(8,12,20,0.78)";
  ctx.fillRect(x, y, panelW, panelH);
  ctx.strokeStyle = SIDES[ship.side].primary;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, panelW, panelH);

  ctx.textAlign = "left";
  ctx.fillStyle = SIDES[ship.side].primary;
  ctx.font = "bold 12px system-ui, sans-serif";
  ctx.fillText("TARGET", x + padX, y + padY + 11);

  // Header: race + class name.
  const raceName = (RACES[ship.race] && RACES[ship.race].name) || "Unknown";
  const klassName = (CLASSES[ship.klass] && CLASSES[ship.klass].name) || ship.klass;
  ctx.fillStyle = "#cdf";
  ctx.font = "bold 14px system-ui, sans-serif";
  ctx.fillText(`${raceName} ${klassName}`, x + padX, y + padY + 29);

  // Hull bar.
  drawStatBar(ctx, x + padX, y + padY + 38, panelW - padX * 2, 6,
    ship.hp / ship.hpMax, "#400", "#4f6");
  // Armor bar (if any).
  if (ship.armorMax > 0) {
    drawStatBar(ctx, x + padX, y + padY + 47, panelW - padX * 2, 5,
      ship.armor / ship.armorMax, "#321", "#c93");
  }

  // Per-module rows.
  ctx.font = "12px system-ui, sans-serif";
  const rowsY = y + padY + headerH - 6;
  for (let i = 0; i < ship.modules.length; i++) {
    const m = ship.modules[i];
    const ry = rowsY + i * rowH;
    const label = MODULE_LABELS[m.name] || m.name;

    if (m.disabled) {
      ctx.fillStyle = "#a55";
      ctx.fillText(label, x + padX, ry + 11);
      ctx.textAlign = "right";
      ctx.fillText("DESTROYED", x + panelW - padX, ry + 11);
      ctx.textAlign = "left";
    } else {
      const frac = m.hp / m.hpMax;
      ctx.fillStyle = "#cef";
      ctx.fillText(label, x + padX, ry + 11);
      // Bar on the right half of the row.
      const barW = 110;
      const barX = x + panelW - padX - barW;
      const barY = ry + 3;
      drawStatBar(ctx, barX, barY, barW, 7, frac, "#222", moduleBarColor(frac));
      // Flash highlight.
      if (m.flash > 0) {
        ctx.strokeStyle = `rgba(255,255,255,${(m.flash * 0.8).toFixed(2)})`;
        ctx.lineWidth = 1;
        ctx.strokeRect(barX - 1, barY - 1, barW + 2, 9);
      }
    }
  }
}

function moduleBarColor(frac) {
  if (frac > 0.66) return "#4f8";
  if (frac > 0.33) return "#fc6";
  return "#f64";
}

function drawStatBar(ctx, x, y, w, h, frac, bgColor, fgColor) {
  ctx.fillStyle = bgColor;
  ctx.fillRect(x, y, w, h);
  const clamped = Math.max(0, Math.min(1, frac));
  ctx.fillStyle = fgColor;
  ctx.fillRect(x, y, w * clamped, h);
}
