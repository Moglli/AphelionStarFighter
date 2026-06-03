/**
 * @file Balance HUD — dev-only canvas overlay surfacing live game.battleStats.
 *
 * Why a canvas overlay (not DOM): we draw alongside the existing HUD on the
 * same canvas context; one less layout pass and one less z-index conflict
 * to manage. Numbers update every frame.
 *
 * Source of truth: game.battleStats — already collected by game.js
 * (bstatRecordShot / bstatRecordDamage / bstatRecordKill). This module
 * is read-only against it.
 *
 * Layout: top-left panel listing per-side totals + a top-N ship leaderboard
 * by damage dealt. Toggled off whenever isDev() is false (caller's job).
 */

const PANEL_X = 12;
const PANEL_Y = 12;
const PANEL_W = 280;
const ROW_H = 16;
const LEADERBOARD_N = 8;

function pct(num, den) {
  if (!den) return 0;
  return Math.round((num / den) * 100);
}

function dps(value, elapsed) {
  if (!elapsed || elapsed < 0.5) return 0;
  return Math.round(value / elapsed);
}

function fmtKlass(k) {
  if (!k) return "?";
  return k.length > 4 ? k.slice(0, 4) : k;
}

export function drawBalanceHUD(ctx, game, viewW, viewH) {
  const bs = game && game.battleStats;
  if (!bs) return;
  if (game.state !== "playing") return;

  const blueSide = bs.blue || { damageDealt: 0, shotsFired: 0, shotsHit: 0, missilesFired: 0 };
  const redSide = bs.red || { damageDealt: 0, shotsFired: 0, shotsHit: 0, missilesFired: 0 };
  const t = bs.elapsed || 0;

  // Top ships by damage dealt.
  const allShips = Object.values(bs.ships || {});
  const top = allShips
    .filter((r) => r.damageDealt > 0)
    .sort((a, b) => b.damageDealt - a.damageDealt)
    .slice(0, LEADERBOARD_N);

  // Recent kill ticker: last 5 ships marked "lost" in this match. We
  // didn't record a death timestamp, so the list is just the most-recent
  // by descending id (ids are monotonic per match) — good enough for
  // a live ticker.
  const recentLosses = allShips
    .filter((r) => r.fate === "lost")
    .sort((a, b) => b.id - a.id)
    .slice(0, 5);

  const rows = 6 + top.length + (recentLosses.length ? 2 + recentLosses.length : 0);
  const panelH = rows * ROW_H + 16;

  ctx.save();
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textBaseline = "top";

  // Background.
  ctx.fillStyle = "rgba(8, 14, 26, 0.82)";
  ctx.fillRect(PANEL_X, PANEL_Y, PANEL_W, panelH);
  ctx.strokeStyle = "rgba(120, 200, 255, 0.55)";
  ctx.lineWidth = 1;
  ctx.strokeRect(PANEL_X + 0.5, PANEL_Y + 0.5, PANEL_W - 1, panelH - 1);

  const left = PANEL_X + 10;
  const mid = PANEL_X + 150;
  let y = PANEL_Y + 8;

  ctx.fillStyle = "#9cf";
  ctx.fillText(`BALANCE HUD  t=${t.toFixed(1)}s`, left, y);
  y += ROW_H;

  // Per-side header.
  ctx.fillStyle = "#7af";
  ctx.fillText("BLUE", left, y);
  ctx.fillStyle = "#f97";
  ctx.fillText("RED", mid, y);
  y += ROW_H;

  // DPS row.
  ctx.fillStyle = "#cde";
  ctx.fillText(`DPS  ${dps(blueSide.damageDealt, t)}`, left, y);
  ctx.fillText(`DPS  ${dps(redSide.damageDealt, t)}`, mid, y);
  y += ROW_H;

  // Damage row.
  ctx.fillText(`DMG  ${Math.round(blueSide.damageDealt)}`, left, y);
  ctx.fillText(`DMG  ${Math.round(redSide.damageDealt)}`, mid, y);
  y += ROW_H;

  // Accuracy row (cannon only — excludes PD by construction in
  // bstatRecordShot / bstatRecordDamage).
  ctx.fillText(`ACC  ${pct(blueSide.shotsHit, blueSide.shotsFired)}%  (${blueSide.shotsHit}/${blueSide.shotsFired})`, left, y);
  ctx.fillText(`ACC  ${pct(redSide.shotsHit, redSide.shotsFired)}%  (${redSide.shotsHit}/${redSide.shotsFired})`, mid, y);
  y += ROW_H;

  // Missiles row.
  ctx.fillText(`MSL  ${blueSide.missilesFired}`, left, y);
  ctx.fillText(`MSL  ${redSide.missilesFired}`, mid, y);
  y += ROW_H;

  // Leaderboard header.
  ctx.fillStyle = "#9cf";
  ctx.fillText(`TOP ${top.length} BY DAMAGE`, left, y);
  y += ROW_H;

  ctx.fillStyle = "#cde";
  for (const r of top) {
    const sideColor = r.side === "blue" ? "#7af" : "#f97";
    ctx.fillStyle = sideColor;
    ctx.fillText(r.isPlayer ? "P" : ".", left, y);
    ctx.fillStyle = "#cde";
    const label = `${fmtKlass(r.klass).padEnd(5)} ${(r.name || `#${r.id}`).slice(0, 14).padEnd(14)}`;
    ctx.fillText(label, left + 14, y);
    const dmg = Math.round(r.damageDealt);
    const tk = Math.round(r.damageTaken || 0);
    ctx.fillText(`${dmg}↑${tk ? "/" + tk + "↓" : ""}  k${r.kills}`, mid, y);
    y += ROW_H;
  }

  // Recent losses ticker.
  if (recentLosses.length) {
    ctx.fillStyle = "#9cf";
    ctx.fillText("RECENT LOSSES", left, y);
    y += ROW_H;
    ctx.fillStyle = "#cde";
    for (const r of recentLosses) {
      const sideColor = r.side === "blue" ? "#7af" : "#f97";
      ctx.fillStyle = sideColor;
      ctx.fillText("✕", left, y);
      ctx.fillStyle = "#cde";
      ctx.fillText(`${fmtKlass(r.klass).padEnd(5)} ${(r.name || `#${r.id}`).slice(0, 18)}`, left + 14, y);
      y += ROW_H;
    }
  }

  ctx.restore();
}
