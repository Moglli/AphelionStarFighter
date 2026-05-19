/**
 * @file Hangar — pre-match profile screen. Shows level, XP bar, currency,
 * stats, daily-login claim, and a cosmetic equip grid. Sister panel to
 * StartMenu; the input router (InputManager) decides which is on screen.
 *
 * Cosmetic slot tiles cycle through owned cosmetics for that slot when
 * tapped; equipped IDs persist via SaveStore so the next match renders
 * with the new tint.
 */

import { saveStore } from "./save.js";
import { events } from "./events.js";
import { progression, levelProgress } from "./progression.js";
import {
  SLOT_ORDER, SLOT_LABELS, COSMETICS, groupBySlot, resolveCosmetic,
} from "./cosmetics.js";

const HEADER_H = 96;
const STATS_H = 110;
const SLOT_H = 92;
const SLOT_GAP = 12;
const BACK_W = 120;
const BACK_H = 44;

export class Hangar {
  constructor() {
    this.slotRects = [];
    this.backRect = null;
    this.loginRect = null;
    this.viewW = 0;
    this.viewH = 0;
    this.backRequested = false;
  }

  layout(viewW, viewH) {
    this.viewW = viewW;
    this.viewH = viewH;
    const panelW = Math.min(720, viewW - 40);
    const panelX = (viewW - panelW) / 2;
    const top = 24;

    this.backRect = { x: panelX, y: top, w: BACK_W, h: BACK_H };

    const loginAvail = progression.loginBonusAvailable();
    this.loginRect = loginAvail
      ? { x: panelX + panelW - 220, y: top, w: 220, h: BACK_H }
      : null;

    const slotsTop = top + HEADER_H + STATS_H + 24;
    const slotW = (panelW - SLOT_GAP * (SLOT_ORDER.length - 1)) / SLOT_ORDER.length;
    this.slotRects = SLOT_ORDER.map((slot, i) => ({
      slot,
      x: panelX + i * (slotW + SLOT_GAP),
      y: slotsTop,
      w: slotW,
      h: SLOT_H,
    }));
    this._panelX = panelX;
    this._panelW = panelW;
    this._top = top;
  }

  click(x, y) {
    if (this.backRect && this._hit(this.backRect, x, y)) {
      this.backRequested = true;
      events.emit("uiClick", { source: "menu" });
      return;
    }
    if (this.loginRect && this._hit(this.loginRect, x, y)) {
      progression.claimLoginBonus();
      events.emit("uiClick", { source: "menu" });
      // Re-layout so the now-unavailable claim chip disappears.
      this.layout(this.viewW, this.viewH);
      return;
    }
    for (const r of this.slotRects) {
      if (this._hit(r, x, y)) {
        this._cycleSlot(r.slot);
        events.emit("uiClick", { source: "menu" });
        return;
      }
    }
  }

  consumeBackRequest() {
    const b = this.backRequested;
    this.backRequested = false;
    return b;
  }

  _cycleSlot(slot) {
    const data = saveStore.get();
    const owned = groupBySlot(data.inventory)[slot] || [];
    if (owned.length === 0) return;
    const cur = data.equippedCosmetics[slot];
    let idx = owned.findIndex((c) => c.id === cur);
    idx = (idx + 1) % (owned.length + 1); // +1 so we can also un-equip
    const next = idx >= owned.length ? null : owned[idx].id;
    saveStore.update((d) => { d.equippedCosmetics[slot] = next; });
  }

  _hit(r, x, y) {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  draw(ctx, viewW, viewH) {
    const data = saveStore.get();
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(0, 0, viewW, viewH);

    // Title.
    ctx.fillStyle = "#cef";
    ctx.textAlign = "center";
    ctx.font = "bold 28px system-ui, sans-serif";
    ctx.fillText("HANGAR", viewW / 2, this._top + 30);

    this._drawBackButton(ctx);
    if (this.loginRect) this._drawLoginButton(ctx);

    // Header strip: level + XP bar + currency.
    const headerY = this._top + BACK_H + 16;
    this._drawHeader(ctx, data, this._panelX, headerY, this._panelW);

    // Stats strip.
    const statsY = headerY + HEADER_H;
    this._drawStats(ctx, data, this._panelX, statsY, this._panelW);

    // Cosmetic slot tiles.
    ctx.fillStyle = "#9bd";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText(
      "COSMETICS  ·  tap to cycle",
      viewW / 2,
      this.slotRects[0].y - 10,
    );
    for (const r of this.slotRects) this._drawSlotTile(ctx, r, data);

    ctx.textAlign = "left";
    ctx.restore();
  }

  _drawBackButton(ctx) {
    const r = this.backRect;
    ctx.fillStyle = "rgba(20,40,60,0.85)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = "#7df";
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = "#cef";
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("← BACK", r.x + r.w / 2, r.y + r.h / 2 + 5);
  }

  _drawLoginButton(ctx) {
    const r = this.loginRect;
    ctx.fillStyle = "rgba(60,140,90,0.9)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = "#9f8";
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("CLAIM DAILY BONUS", r.x + r.w / 2, r.y + r.h / 2 + 5);
  }

  _drawHeader(ctx, data, x, y, w) {
    const lp = levelProgress(data.xp, data.level);
    ctx.fillStyle = "rgba(20,40,60,0.85)";
    ctx.fillRect(x, y, w, HEADER_H);
    ctx.strokeStyle = "#456";
    ctx.strokeRect(x, y, w, HEADER_H);

    // Level + XP bar.
    ctx.fillStyle = "#cef";
    ctx.font = "bold 22px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`LV ${data.level}`, x + 16, y + 34);

    const barX = x + 90;
    const barY = y + 22;
    const barW = w - 360;
    const barH = 14;
    ctx.fillStyle = "#113";
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = "#7df";
    ctx.fillRect(barX, barY, barW * lp.fraction, barH);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barY, barW, barH);
    ctx.fillStyle = "#cef";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(`${lp.current} / ${lp.span} XP`, barX, barY + barH + 14);

    // Currency.
    ctx.textAlign = "right";
    ctx.fillStyle = "#fd6";
    ctx.font = "bold 18px system-ui, sans-serif";
    ctx.fillText(`${data.softCurrency}`, x + w - 16, y + 34);
    ctx.fillStyle = "#9bd";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText("CREDITS", x + w - 16, y + 48);

    ctx.fillStyle = "#b6f";
    ctx.font = "bold 18px system-ui, sans-serif";
    ctx.fillText(`${data.hardCurrency}`, x + w - 16, y + 76);
    ctx.fillStyle = "#9bd";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText("APHELIUM", x + w - 16, y + 90);

    // Login streak tag.
    if (data.loginStreak > 0) {
      ctx.fillStyle = "#9bd";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(`Login streak: ${data.loginStreak}`, x + 16, y + 76);
    }
  }

  _drawStats(ctx, data, x, y, w) {
    ctx.fillStyle = "rgba(20,40,60,0.7)";
    ctx.fillRect(x, y, w, STATS_H);
    ctx.strokeStyle = "#345";
    ctx.strokeRect(x, y, w, STATS_H);

    ctx.fillStyle = "#9bd";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("CAREER STATS", x + 16, y + 18);

    const cells = [
      ["Kills",       data.stats.kills],
      ["Deaths",      data.stats.deaths],
      ["Wins",        data.stats.wins],
      ["Losses",      data.stats.losses],
      ["Playtime",    formatPlaytime(data.stats.playtimeSeconds)],
      ["Best Arena",  data.bestScores.arena],
      ["Best Waves",  data.bestScores.waves],
    ];
    const colW = (w - 32) / cells.length;
    for (let i = 0; i < cells.length; i++) {
      const cx = x + 16 + i * colW;
      ctx.fillStyle = "#cef";
      ctx.font = "bold 18px system-ui, sans-serif";
      ctx.fillText(String(cells[i][1]), cx, y + 56);
      ctx.fillStyle = "#9bd";
      ctx.font = "10px system-ui, sans-serif";
      ctx.fillText(cells[i][0].toUpperCase(), cx, y + 78);
    }
  }

  _drawSlotTile(ctx, r, data) {
    const equippedId = data.equippedCosmetics[r.slot];
    const equipped = resolveCosmetic(equippedId);
    const owned = groupBySlot(data.inventory)[r.slot] || [];

    ctx.fillStyle = "rgba(20,40,60,0.85)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = equipped && equipped.tint ? equipped.tint : "#7df";
    ctx.lineWidth = equipped ? 3 : 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    ctx.textAlign = "center";
    ctx.fillStyle = "#9bd";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText(SLOT_LABELS[r.slot].toUpperCase(), r.x + r.w / 2, r.y + 16);

    ctx.fillStyle = equipped && equipped.tint ? equipped.tint : "#cef";
    ctx.font = "bold 14px system-ui, sans-serif";
    const label = equipped ? equipped.label : "— none —";
    ctx.fillText(label, r.x + r.w / 2, r.y + 42);

    ctx.fillStyle = "#9bd";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText(`${owned.length} owned`, r.x + r.w / 2, r.y + r.h - 12);

    // Color swatch.
    if (equipped && equipped.tint) {
      ctx.fillStyle = equipped.tint;
      ctx.fillRect(r.x + r.w / 2 - 14, r.y + 56, 28, 8);
    }
  }
}

function formatPlaytime(seconds) {
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}
