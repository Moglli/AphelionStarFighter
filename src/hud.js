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
  // Spectate identifier pill sits at the top whenever spectating, so
  // the player always knows whose camera they're on. The bottom
  // vitals panel is a separate concern below.
  if (!player && game.spectating) {
    drawSpectateOverlay(ctx, game, viewW, viewH);
  }
  // Bottom vitals strip: alive player gets their own; otherwise the
  // spectated ship gets one so you can read its shield/hull/gun the
  // same way you would when piloting. Suppressed in admiral mode —
  // the admiral panel owns the bottom strip there.
  if (player) {
    drawVitalsPanel(ctx, player, viewW, viewH, missileBtn);
  } else if (game.spectating && !game.admiralMode) {
    const t = getSpectateTarget(game);
    if (t && !t.dead) drawVitalsPanel(ctx, t, viewW, viewH, null);
  } else if (game.respawnTimer > 0) {
    drawRespawnPanel(ctx, game.respawnTimer, viewW, viewH);
  }

  if (game.matchOver) drawMatchOverPanel(ctx, game, viewW, viewH);

  const focusTarget = pickFocusTarget(game);
  if (focusTarget) drawTargetPanel(ctx, focusTarget, viewW, viewH);

  drawMinimap(ctx, game, viewW, viewH);
}

// Single-letter class glyphs for the compact roster strip. Chosen so
// each class is unambiguous without needing a full name.
const CLASS_GLYPH = {
  fighter: "F", bomber: "B", frigate: "Fr",
  cruiser: "C", battleship: "BB", carrier: "CV", station: "St",
};

function drawSideStrip(ctx, counts, side, race, anchorX, anchorY, align) {
  const palette = SIDES[side];
  const raceInfo = RACES[race] || RACES.terran;
  // Panel chrome: a tinted strip the width of the roster row so the
  // text isn't floating against the starfield.
  const cellW = 44, cellH = 38, gap = 4;
  const cells = CLASS_ORDER.length;
  const stripW = cellW * cells + gap * (cells - 1) + 14;
  const panelH = 70;
  const stripY = anchorY;
  // Anchor the panel relative to the alignment side so left/right
  // strips mirror cleanly without each caller computing its origin.
  const panelX = align === "right" ? anchorX - stripW : anchorX;

  ctx.fillStyle = "rgba(8,16,28,0.78)";
  ctx.fillRect(panelX, stripY, stripW, panelH);
  // Side-tinted accent rule along the panel's outward edge.
  ctx.fillStyle = palette.primary;
  if (align === "right") {
    ctx.fillRect(panelX + stripW - 3, stripY, 3, panelH);
  } else {
    ctx.fillRect(panelX, stripY, 3, panelH);
  }

  ctx.textAlign = "left";
  ctx.fillStyle = palette.primary;
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.fillText(palette.name, panelX + 9, stripY + 15);
  ctx.fillStyle = "#9bd";
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillText(raceInfo.name.toUpperCase(), panelX + 9, stripY + 28);

  // Roster cells: 7 mini boxes with class glyph + count. Empty classes
  // drop to faded so the alive composition reads at a glance.
  const cellsY = stripY + 36;
  const cellsX = panelX + 7;
  for (let i = 0; i < cells; i++) {
    const klass = CLASS_ORDER[i];
    const c = counts[klass] || 0;
    const cx = cellsX + i * (cellW + gap);
    ctx.globalAlpha = c === 0 ? 0.30 : 1;
    ctx.fillStyle = "rgba(20,32,48,0.85)";
    ctx.fillRect(cx, cellsY, cellW, cellH - 4);
    ctx.strokeStyle = c === 0 ? "rgba(120,180,220,0.25)" : palette.primary;
    ctx.lineWidth = 1;
    ctx.strokeRect(cx, cellsY, cellW, cellH - 4);
    ctx.fillStyle = "#9bd";
    ctx.font = "bold 10px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(CLASS_GLYPH[klass] || "?", cx + cellW / 2, cellsY + 12);
    ctx.fillStyle = c === 0 ? "#566" : "#fff";
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.fillText(String(c), cx + cellW / 2, cellsY + 27);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
}

// Vitals panel: shield + hull (+ gun ammo when applicable) clustered
// in a single side-tinted backdrop. Renders for the live player ship
// when piloting, and for the spectated ship in spectate mode — same
// chrome, same layout — so spectating reads like "what would I see if
// I were flying this thing". `missileBtn` is null when spectating;
// the on-screen missile button only makes sense for an alive player.
function drawVitalsPanel(ctx, ship, viewW, viewH, missileBtn) {
  const w = 300, barH = 10;
  const hasShield = ship.shieldMax > 0;
  const hasAmmo = ship.spec.weapon && ship.spec.weapon.capacity != null;
  const rows = (hasShield ? 1 : 0) + 1 + (hasAmmo ? 1 : 0);
  const rowSpacing = 18;
  const padX = 14, padY = 12;
  const panelW = w + padX * 2;
  const panelH = padY * 2 + rows * rowSpacing - 4;
  const px = (viewW - panelW) / 2;
  const py = viewH - panelH - 14;
  ctx.fillStyle = "rgba(8,16,28,0.85)";
  ctx.fillRect(px, py, panelW, panelH);
  // Spectated ships get a side-tinted border so the colour reinforces
  // whose camera you're on; the alive player keeps the neutral blue
  // accent that ties the bottom strip to the other HUD chrome.
  ctx.strokeStyle = ship.isPlayer ? "#5af" : SIDES[ship.side].primary;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(px, py, panelW, panelH);

  const x = px + padX;
  let rowY = py + padY;

  // Inline label-bar row helper. Label on the left, value on the right,
  // bar fills the remaining width below. Keeps everything aligned and
  // avoids the bouncing text-centered look the old version had.
  const drawLabeledBar = (label, value, frac, fill, bg) => {
    ctx.fillStyle = "#9bd";
    ctx.font = "bold 10px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(label, x, rowY + 8);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "right";
    ctx.fillText(value, x + w, rowY + 8);
    const by = rowY + 11;
    ctx.fillStyle = bg;
    ctx.fillRect(x, by, w, barH);
    ctx.fillStyle = fill;
    ctx.fillRect(x, by, w * Math.max(0, Math.min(1, frac)), barH);
    rowY += rowSpacing;
  };

  if (hasShield) {
    drawLabeledBar(
      "SHIELD",
      `${Math.max(0, Math.round(ship.shield))} / ${ship.shieldMax}`,
      ship.shield / ship.shieldMax, "#7df", "#0a1a2a",
    );
  }
  drawLabeledBar(
    "HULL",
    `${Math.max(0, Math.round(ship.hp))} / ${ship.hpMax}`,
    ship.hp / ship.hpMax,
    ship.hp / ship.hpMax > 0.33 ? "#4f6" : "#f64",
    "#2a1818",
  );
  if (hasAmmo) {
    const cap = ship.spec.weapon.capacity;
    if (ship.weaponReloading) {
      const frac = 1 - (ship.weaponReloadTimer / ship.spec.weapon.reloadTime);
      drawLabeledBar(
        "GUN",
        `RELOAD ${Math.max(0, ship.weaponReloadTimer).toFixed(1)}s`,
        frac, "#fa3", "#2a1c10",
      );
    } else {
      drawLabeledBar(
        "GUN",
        `${ship.weaponAmmo} / ${cap}`,
        ship.weaponAmmo / cap, "#fd6", "#2a1c10",
      );
    }
  }
  ctx.textAlign = "left";

  // Missile cooldown indicator: also drawn through the on-screen
  // button. Only ever wired for the alive player — spectated ships
  // pass null because their missile state isn't player-controllable.
  if (missileBtn && ship.spec.missile) {
    const cd = ship.spec.missile.cooldown;
    const remain = ship.missileCd;
    const ready = remain <= 0;
    const frac = ready ? 0 : (remain / cd);
    missileBtn.draw(ctx, ready, frac);
  }
}

// Centered pill prompting the player while their respawn timer ticks
// down. Sits at the top of the screen, well clear of the bottom HUD,
// so the moment-to-moment battle below isn't visually blocked.
function drawRespawnPanel(ctx, secondsLeft, viewW, _viewH) {
  const panelW = 280, panelH = 56;
  const px = (viewW - panelW) / 2;
  const py = 110;
  ctx.fillStyle = "rgba(8,16,28,0.85)";
  ctx.fillRect(px, py, panelW, panelH);
  ctx.strokeStyle = "#5af";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(px, py, panelW, panelH);
  ctx.fillStyle = "#9bd";
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("RESPAWN IN", px + panelW / 2, py + 18);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 22px system-ui, sans-serif";
  ctx.fillText(`${secondsLeft.toFixed(1)}s`, px + panelW / 2, py + 44);
  ctx.textAlign = "left";
}

// Match-end summary panel. Centered card with side-tinted border that
// matches the winner so the result reads at a glance. Campaign mode
// folds reward / balance lines into the same card; arena/defend get
// a shorter card with just the result + restart prompt.
function drawMatchOverPanel(ctx, game, viewW, viewH) {
  const isCampaign = game.mode === "campaign";
  const winnerSide = game.winner === "blue" ? "blue" : "red";
  const accent = SIDES[winnerSide].primary;
  const won = game.winner === "blue";

  // Soft full-screen dim behind the panel so the still-rendering
  // battle behind doesn't compete for attention.
  ctx.fillStyle = "rgba(2,8,18,0.55)";
  ctx.fillRect(0, 0, viewW, viewH);

  const panelW = 540;
  const panelH = isCampaign ? 230 : 170;
  const px = (viewW - panelW) / 2;
  const py = (viewH - panelH) / 2;
  ctx.fillStyle = "rgba(8,16,28,0.92)";
  ctx.fillRect(px, py, panelW, panelH);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.strokeRect(px, py, panelW, panelH);
  // Inner accent rule across the top of the panel for visual weight.
  ctx.fillStyle = accent;
  ctx.fillRect(px, py, panelW, 3);

  let msg;
  if (isCampaign) msg = won ? "MISSION COMPLETE" : "MISSION FAILED";
  else msg = won ? "ALLIED VICTORY" : "HOSTILE VICTORY";

  ctx.textAlign = "center";
  ctx.fillStyle = "#fff";
  ctx.font = "bold 34px system-ui, sans-serif";
  ctx.fillText(msg, px + panelW / 2, py + 56);

  if (isCampaign && game.campaign) {
    ctx.font = "bold 18px system-ui, sans-serif";
    if (won) {
      ctx.fillStyle = "#fe8";
      ctx.fillText(
        `+${game.campaign.lastReward.toLocaleString()} credits`,
        px + panelW / 2, py + 100,
      );
      ctx.fillStyle = "#cef";
      ctx.font = "14px system-ui, sans-serif";
      ctx.fillText(
        `Balance: $${game.campaign.totalMoney.toLocaleString()}`,
        px + panelW / 2, py + 128,
      );
    } else {
      ctx.fillStyle = "#fdb";
      ctx.fillText(
        "No reward — retry the mission",
        px + panelW / 2, py + 100,
      );
    }
  }

  ctx.fillStyle = "#9bd";
  ctx.font = "13px system-ui, sans-serif";
  const prompt = isCampaign
    ? (won ? "Tap to return to hangar" : "Tap to retry")
    : "Tap to restart";
  ctx.fillText(prompt, px + panelW / 2, py + panelH - 22);
  ctx.textAlign = "left";
}

function drawSpectateOverlay(ctx, game, viewW, viewH) {
  const t = getSpectateTarget(game);
  // Compact pill at the top of the screen instead of a full-width
  // bottom bar — keeps the bottom HUD area clear for the vitals
  // panel + admiral controls.
  // Sits just under the SPECTATE button (which is at y=12, h=36) so
  // the two stack cleanly without overlapping.
  const panelW = 360, panelH = 36;
  const px = (viewW - panelW) / 2;
  const py = 58;
  ctx.fillStyle = "rgba(8,16,28,0.85)";
  ctx.fillRect(px, py, panelW, panelH);
  ctx.strokeStyle = "#5af";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(px, py, panelW, panelH);
  ctx.fillStyle = "#7bd";
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("SPECTATE", px + 10, py + 14);
  ctx.fillStyle = "#9bd";
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("V exit  ·  N/B cycle", px + panelW - 10, py + 14);
  ctx.font = "12px system-ui, sans-serif";
  ctx.textAlign = "center";
  if (t) {
    const palette = SIDES[t.side];
    const raceInfo = RACES[t.race] || RACES.terran;
    ctx.fillStyle = palette.primary;
    ctx.fillText(
      `${palette.name} ${raceInfo.name} ${t.spec.name}`,
      px + panelW / 2, py + 28,
    );
  } else {
    ctx.fillStyle = "#cdf";
    ctx.fillText("No targets available", px + panelW / 2, py + 28);
  }
  ctx.textAlign = "left";
}

function drawMinimap(ctx, game, viewW, viewH) {
  const mapW = 180, mapH = 135;
  const headerH = 18;
  const padTotalH = mapH + headerH;
  const x = viewW - mapW - 16;
  const y = viewH - padTotalH - 16;
  // Outer panel with header strip + map area; the header gives the
  // minimap visual weight and tags it as a deliberate UI element
  // instead of a floating rectangle.
  ctx.fillStyle = "rgba(8,16,28,0.85)";
  ctx.fillRect(x - 4, y - 4, mapW + 8, padTotalH + 8);
  ctx.strokeStyle = "#5af";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x - 4, y - 4, mapW + 8, padTotalH + 8);
  ctx.fillStyle = "rgba(20,40,60,0.95)";
  ctx.fillRect(x, y, mapW, headerH);
  ctx.fillStyle = "#9bd";
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("FLEET MAP", x + 8, y + 12);
  // Compact total readout on the right of the header.
  const totalShips = game.ships.filter(s => !s.dead).length;
  ctx.textAlign = "right";
  ctx.fillStyle = "#7bd";
  ctx.fillText(`${totalShips} units`, x + mapW - 8, y + 12);

  const mapY = y + headerH;
  ctx.fillStyle = "#03070d";
  ctx.fillRect(x, mapY, mapW, mapH);

  const sx = mapW / ARENA.width;
  const sy = mapH / ARENA.height;
  for (const s of game.ships) {
    if (s.dead) continue;
    const px = x + s.pos.x * sx;
    const py = mapY + s.pos.y * sy;
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
  ctx.textAlign = "left";
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

  // Same chrome as the rest of the HUD (rgba(8,16,28,0.85) bg) but
  // keep the side-tinted border + accent rule — the target panel's
  // job is to identify an enemy, so the colour is a feature.
  ctx.fillStyle = "rgba(8,16,28,0.85)";
  ctx.fillRect(x, y, panelW, panelH);
  ctx.strokeStyle = SIDES[ship.side].primary;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, panelW, panelH);
  ctx.fillStyle = SIDES[ship.side].primary;
  ctx.fillRect(x, y, panelW, 2);

  ctx.textAlign = "left";
  ctx.fillStyle = SIDES[ship.side].primary;
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.fillText("TARGET", x + padX, y + padY + 12);

  // Header: race + class name.
  const raceName = (RACES[ship.race] && RACES[ship.race].name) || "Unknown";
  const klassName = (CLASSES[ship.klass] && CLASSES[ship.klass].name) || ship.klass;
  ctx.fillStyle = "#e6f4ff";
  ctx.font = "bold 14px system-ui, sans-serif";
  ctx.fillText(`${raceName} ${klassName}`, x + padX, y + padY + 30);

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
