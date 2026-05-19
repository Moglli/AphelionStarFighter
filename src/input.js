// Input sources: virtual joysticks for touch, plus WASD + mouse + Enter
// for desktop play. The aim direction is computed relative to canvas
// center because the camera follows the player ship, so center == player.

import { MAP_SIZES } from "./arena.js";
import { RACES, RACE_KEYS } from "./races.js";
import { CLASSES } from "./classes.js";
import { MODES, MODE_KEYS } from "./modes/index.js";
import { saveStore } from "./save.js";
import { events } from "./events.js";
import { todaySeed } from "./modes/daily.js";
import { Hangar } from "./hangar.js";
import { rally } from "./rally.js";
import { minimapHit, minimapToWorld } from "./hud.js";

const DEADZONE = 0.15;

function pointInRect(x, y, r) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

export class VirtualStick {
  constructor({ side, color }) {
    this.side = side; // "left" or "right"
    this.color = color;
    this.pointerId = null;
    this.center = { x: 0, y: 0 };
    this.knob = { x: 0, y: 0 };
    this.radius = 70;
    this.active = false;
    this.value = { x: 0, y: 0 };
  }

  claims(x, w) {
    return this.side === "left" ? x < w / 2 : x >= w / 2;
  }

  start(pointerId, x, y) {
    this.pointerId = pointerId;
    this.center = { x, y };
    this.knob = { x, y };
    this.active = true;
    this.value = { x: 0, y: 0 };
  }

  move(x, y) {
    let dx = x - this.center.x;
    let dy = y - this.center.y;
    const l = Math.hypot(dx, dy);
    if (l > this.radius) { dx = (dx / l) * this.radius; dy = (dy / l) * this.radius; }
    this.knob = { x: this.center.x + dx, y: this.center.y + dy };
    const nx = dx / this.radius;
    const ny = dy / this.radius;
    const nlen = Math.hypot(nx, ny);
    this.value = nlen < DEADZONE ? { x: 0, y: 0 } : { x: nx, y: ny };
  }

  end() {
    this.pointerId = null;
    this.active = false;
    this.value = { x: 0, y: 0 };
  }

  draw(ctx) {
    if (!this.active) return;
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(this.center.x, this.center.y, this.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(this.knob.x, this.knob.y, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// On-screen MISSILE button — single-tap to launch, cooldown gated.
// Sits just above the FIRE button on the right thumb stack.
export class MissileButton {
  constructor() {
    this.pointerId = null;
    this.pressed = false;
    this.justPressed = false;
    this.rect = { x: 0, y: 0, w: 96, h: 58 };
  }
  layout(viewW, viewH) {
    this.rect.x = viewW - this.rect.w - 18;
    this.rect.y = viewH - this.rect.h - 210;
  }
  hit(x, y) {
    const r = this.rect;
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }
  start(pointerId) {
    this.pointerId = pointerId;
    if (!this.pressed) this.justPressed = true;
    this.pressed = true;
  }
  end() {
    this.pointerId = null;
    this.pressed = false;
  }
  consumeJustPressed() {
    const j = this.justPressed;
    this.justPressed = false;
    return j;
  }
  draw(ctx, ready, cooldownFrac) {
    const r = this.rect;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = ready ? "rgba(20,40,60,0.7)" : "rgba(40,20,20,0.7)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = ready ? "#7df" : "#a55";
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    if (!ready) {
      ctx.fillStyle = "rgba(180,80,80,0.35)";
      ctx.fillRect(r.x, r.y, r.w, r.h * cooldownFrac);
    }
    ctx.fillStyle = ready ? "#cef" : "#fcc";
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("MISSILE", r.x + r.w / 2, r.y + r.h / 2 - 4);
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText(ready ? "READY" : "RELOAD", r.x + r.w / 2, r.y + r.h / 2 + 12);
    ctx.textAlign = "left";
    ctx.restore();
  }
}

// On-screen FIRE button — hold-to-fire primary cannons. Drawn larger than
// MISSILE and placed in the bottom-right corner for thumb reach.
export class FireButton {
  constructor() {
    this.pointerId = null;
    this.pressed = false;
    this.rect = { x: 0, y: 0, w: 110, h: 110 };
  }
  layout(viewW, viewH) {
    this.rect.x = viewW - this.rect.w - 12;
    this.rect.y = viewH - this.rect.h - 90;
  }
  hit(x, y) {
    const r = this.rect;
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }
  start(pointerId) {
    this.pointerId = pointerId;
    this.pressed = true;
  }
  end() {
    this.pointerId = null;
    this.pressed = false;
  }
  draw(ctx) {
    const r = this.rect;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const radius = Math.min(r.w, r.h) / 2 - 4;
    ctx.save();
    ctx.globalAlpha = this.pressed ? 0.95 : 0.8;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = this.pressed ? "rgba(200,60,60,0.55)" : "rgba(60,20,20,0.55)";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = this.pressed ? "#fa6" : "#f96";
    ctx.stroke();
    ctx.fillStyle = "#fed";
    ctx.font = "bold 18px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("FIRE", cx, cy + 6);
    ctx.textAlign = "left";
    ctx.restore();
  }
}

// On-screen SPECTATE controls — toggle button always visible during a
// match; PREV/NEXT only hit-active while spectating. Edge-triggered so a
// single tap maps to a single state change.
export class SpectatePanel {
  constructor() {
    this.toggleRect = { x: 0, y: 0, w: 110, h: 32 };
    this.prevRect = { x: 0, y: 0, w: 80, h: 44 };
    this.nextRect = { x: 0, y: 0, w: 80, h: 44 };
    this._toggleEdge = false;
    this._prevEdge = false;
    this._nextEdge = false;
  }
  layout(viewW, viewH) {
    this.toggleRect.x = viewW / 2 - this.toggleRect.w / 2;
    this.toggleRect.y = 50;
    this.prevRect.x = 16;
    this.prevRect.y = viewH - 52;
    this.nextRect.x = viewW - this.nextRect.w - 16;
    this.nextRect.y = viewH - 52;
  }
  // Returns the kind of hit so onDown knows whether to swallow the click.
  hit(x, y, spectating) {
    if (this._inside(this.toggleRect, x, y)) { this._toggleEdge = true; return "toggle"; }
    if (spectating) {
      if (this._inside(this.prevRect, x, y)) { this._prevEdge = true; return "prev"; }
      if (this._inside(this.nextRect, x, y)) { this._nextEdge = true; return "next"; }
    }
    return null;
  }
  _inside(r, x, y) {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }
  consumeToggle() { const e = this._toggleEdge; this._toggleEdge = false; return e; }
  consumePrev()   { const e = this._prevEdge;   this._prevEdge = false;   return e; }
  consumeNext()   { const e = this._nextEdge;   this._nextEdge = false;   return e; }

  draw(ctx, spectating) {
    const t = this.toggleRect;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = spectating ? "rgba(60,30,90,0.7)" : "rgba(20,40,60,0.7)";
    ctx.fillRect(t.x, t.y, t.w, t.h);
    ctx.strokeStyle = spectating ? "#c9f" : "#7df";
    ctx.lineWidth = 2;
    ctx.strokeRect(t.x, t.y, t.w, t.h);
    ctx.fillStyle = "#cef";
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(spectating ? "EXIT SPECTATE" : "SPECTATE", t.x + t.w / 2, t.y + t.h / 2 + 5);

    if (spectating) {
      for (const [r, label] of [[this.prevRect, "◀ PREV"], [this.nextRect, "NEXT ▶"]]) {
        ctx.fillStyle = "rgba(20,40,60,0.75)";
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = "#7df";
        ctx.lineWidth = 2;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = "#cef";
        ctx.font = "bold 14px system-ui, sans-serif";
        ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 5);
      }
    }
    ctx.textAlign = "left";
    ctx.restore();
  }
}

// Pre-match menu: lets the player pick a game mode, ship class, allied
// race, and map size before the world spawns. Selections persist via
// SaveStore so re-opening the menu restores the last pick.
//
// Layout: four rows of chips plus an explicit START button. Each chip
// toggles its row's selection; START emits the chosen options bundle.
const CLASS_ORDER = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier"];

// Fleet-size multipliers — scale every roster entry up or down so the
// player can ask for "a few fighters" or "an absolute swarm".
export const FLEET_OPTIONS = [
  { key: "small",  label: "Small",  mul: 0.5 },
  { key: "medium", label: "Medium", mul: 1.0 },
  { key: "large",  label: "Large",  mul: 2.0 },
  { key: "huge",   label: "Huge",   mul: 3.5 },
];

// Faction count — number of competing AI sides (including the player).
const FACTION_OPTIONS = [
  { key: 2, label: "2 — Duel" },
  { key: 3, label: "3 — Triad" },
  { key: 4, label: "4 — Free-for-all" },
];

export class StartMenu {
  constructor() {
    this.modeRects = [];
    this.classRects = [];
    this.sizeRects = [];
    this.raceRects = [];
    this.fleetRects = [];
    this.factionRects = [];
    this.opponentRects = [];
    this.startRect = null;
    const sel = saveStore.get().menuSelection;
    this.selectedMode = MODES[sel.mode] ? sel.mode : "arena";
    this.selectedKlass = CLASSES[sel.klass] ? sel.klass : "fighter";
    this.selectedSize = sel.mapSize || "medium";
    this.selectedRace = RACES[sel.race] ? sel.race : "terran";
    this.selectedFleet = FLEET_OPTIONS.find(o => o.key === sel.fleetMul) ? sel.fleetMul : "medium";
    this.selectedFactions = [2, 3, 4].includes(sel.factions) ? sel.factions : 2;
    // Opponent selection: "random" picks a hostile race at match start.
    // Used only by arena mode; waves picks its own random, daily is seeded.
    this.selectedOpponent = (sel.opponent === "random" || RACES[sel.opponent])
      ? sel.opponent : "random";
    this.justStarted = null;
    this.hangarRequested = false;
    this.customRequested = false;
  }

  consumeCustomRequest() {
    const r = this.customRequested;
    this.customRequested = false;
    return r;
  }

  layout(viewW, viewH) {
    const chipH = 50;
    const gapX = 12;
    // Tightened spacing so the extra opponent row still fits inside a
    // 600px-tall viewport. Each inter-row gap is chipH + rowGap + 8 ≈ 74.
    const rowGap = 16;
    const titleY = Math.max(48, viewH / 2 - 280);

    // Mode row.
    const modeKeys = MODE_KEYS;
    const mn = modeKeys.length;
    const modeBtnW = Math.min(160, (viewW - 60) / mn - gapX);
    const modeRowW = mn * modeBtnW + (mn - 1) * gapX;
    const modeY = titleY + 64;
    const modeStartX = (viewW - modeRowW) / 2;
    this.modeRects = modeKeys.map((k, i) => ({
      key: k, label: MODES[k].label, sub: MODES[k].tagline || "",
      x: modeStartX + i * (modeBtnW + gapX),
      y: modeY, w: modeBtnW, h: chipH,
    }));

    // Class row.
    const cn = CLASS_ORDER.length;
    const classBtnW = Math.min(110, (viewW - 40) / cn - gapX);
    const classRowW = cn * classBtnW + (cn - 1) * gapX;
    const classY = modeY + chipH + rowGap + 8;
    const classStartX = (viewW - classRowW) / 2;
    this.classRects = CLASS_ORDER.map((k, i) => ({
      key: k, label: CLASSES[k].name,
      x: classStartX + i * (classBtnW + gapX),
      y: classY, w: classBtnW, h: chipH,
    }));

    // Size row.
    const sizeOpts = MAP_SIZES;
    const sn = sizeOpts.length;
    const sizeBtnW = Math.min(160, (viewW - 80) / sn - gapX);
    const sizeRowW = sn * sizeBtnW + (sn - 1) * gapX;
    const sizeY = classY + chipH + rowGap + 8;
    const sizeStartX = (viewW - sizeRowW) / 2;
    this.sizeRects = sizeOpts.map((o, i) => ({
      key: o.key, label: o.label, mapW: o.mapW, mapH: o.mapH,
      x: sizeStartX + i * (sizeBtnW + gapX),
      y: sizeY, w: sizeBtnW, h: chipH,
    }));

    // Race row.
    const raceKeys = RACE_KEYS;
    const rn = raceKeys.length;
    const raceBtnW = Math.min(130, (viewW - 60) / rn - gapX);
    const raceRowW = rn * raceBtnW + (rn - 1) * gapX;
    const raceY = sizeY + chipH + rowGap + 8;
    const raceStartX = (viewW - raceRowW) / 2;
    this.raceRects = raceKeys.map((k, i) => ({
      key: k, label: RACES[k].name,
      x: raceStartX + i * (raceBtnW + gapX),
      y: raceY, w: raceBtnW, h: chipH,
    }));

    // Fleet-size row.
    const fleetOpts = FLEET_OPTIONS;
    const fn = fleetOpts.length;
    const fleetBtnW = Math.min(130, (viewW - 60) / fn - gapX);
    const fleetRowW = fn * fleetBtnW + (fn - 1) * gapX;
    const fleetY = raceY + chipH + rowGap + 16;
    const fleetStartX = (viewW - fleetRowW) / 2;
    this.fleetRects = fleetOpts.map((o, i) => ({
      key: o.key, label: o.label, mul: o.mul,
      x: fleetStartX + i * (fleetBtnW + gapX),
      y: fleetY, w: fleetBtnW, h: chipH,
    }));

    // Factions row.
    const factOpts = FACTION_OPTIONS;
    const fan = factOpts.length;
    const factBtnW = Math.min(170, (viewW - 60) / fan - gapX);
    const factRowW = fan * factBtnW + (fan - 1) * gapX;
    const factY = fleetY + chipH + rowGap + 16;
    const factStartX = (viewW - factRowW) / 2;
    this.factionRects = factOpts.map((o, i) => ({
      key: o.key, label: o.label,
      x: factStartX + i * (factBtnW + gapX),
      y: factY, w: factBtnW, h: chipH,
    }));

    // Bottom button row: HANGAR | START | CUSTOM. Sized so the whole
    // row stays centered under the chip stack on any viewport.
    const startW = 220, startH = 56;
    const sideBtnW = 150;
    const gap = 16;
    const totalW = sideBtnW + gap + startW + gap + sideBtnW;
    const startY = factY + chipH + 36;
    const rowX = (viewW - totalW) / 2;
    this.hangarRect = { x: rowX, y: startY, w: sideBtnW, h: startH };
    this.startRect = { x: rowX + sideBtnW + gap, y: startY, w: startW, h: startH };
    this.customRect = {
      x: rowX + sideBtnW + gap + startW + gap,
      y: startY, w: sideBtnW, h: startH,
    // Opponent row. Random + the four races; relevant only to arena mode
    // (drawn muted otherwise so the disabled state is obvious).
    const oppKeys = ["random", ...RACE_KEYS];
    const on = oppKeys.length;
    const oppBtnW = Math.min(120, (viewW - 60) / on - gapX);
    const oppRowW = on * oppBtnW + (on - 1) * gapX;
    const oppY = raceY + chipH + rowGap + 8;
    const oppStartX = (viewW - oppRowW) / 2;
    this.opponentRects = oppKeys.map((k, i) => ({
      key: k,
      label: k === "random" ? "Random" : RACES[k].name,
      x: oppStartX + i * (oppBtnW + gapX),
      y: oppY, w: oppBtnW, h: chipH,
    }));

    // START button + HANGAR button (sits to the left of START).
    const startW = 220, startH = 56;
    const startY = oppY + chipH + 28;
    this.startRect = {
      x: (viewW - startW) / 2,
      y: startY,
      w: startW, h: startH,
    };
    this.hangarRect = {
      x: this.startRect.x - 150 - 16,
      y: startY,
      w: 150, h: startH,
    };
  }

  consumeHangarRequest() {
    const r = this.hangarRequested;
    this.hangarRequested = false;
    return r;
  }

  /** True when daily mode is selected and the player already played today. */
  dailyLocked() {
    if (this.selectedMode !== "daily") return false;
    const d = saveStore.get().daily;
    return d.lastSeed === todaySeed();
  }

  click(x, y) {
    for (const r of this.modeRects) {
      if (this._hit(r, x, y)) {
        this.selectedMode = r.key;
        events.emit("uiClick", { source: "menu" });
        this._persist();
        return;
      }
    }
    for (const r of this.classRects) {
      if (this._hit(r, x, y)) {
        this.selectedKlass = r.key;
        events.emit("uiClick", { source: "menu" });
        this._persist();
        return;
      }
    }
    for (const r of this.sizeRects) {
      if (this._hit(r, x, y)) {
        this.selectedSize = r.key;
        events.emit("uiClick", { source: "menu" });
        this._persist();
        return;
      }
    }
    for (const r of this.raceRects) {
      if (this._hit(r, x, y)) {
        this.selectedRace = r.key;
        events.emit("uiClick", { source: "menu" });
        this._persist();
        return;
      }
    }
    for (const r of this.fleetRects) {
      if (this._hit(r, x, y)) {
        this.selectedFleet = r.key;
        events.emit("uiClick", { source: "menu" });
        this._persist();
        return;
      }
    }
    for (const r of this.factionRects) {
      if (this._hit(r, x, y)) {
        this.selectedFactions = r.key;
        events.emit("uiClick", { source: "menu" });
        this._persist();
        return;
    // Opponent chips are interactive only in arena mode (the other modes
    // pick their own hostile race). The chip rects always exist so the
    // layout stays stable when switching modes.
    if (this.selectedMode === "arena") {
      for (const r of this.opponentRects) {
        if (this._hit(r, x, y)) {
          this.selectedOpponent = r.key;
          events.emit("uiClick", { source: "menu" });
          this._persist();
          return;
        }
      }
    }
    if (this.hangarRect && this._hit(this.hangarRect, x, y)) {
      this.hangarRequested = true;
      events.emit("uiClick", { source: "menu" });
      return;
    }
    if (this.customRect && this._hit(this.customRect, x, y)) {
      this.customRequested = true;
      events.emit("uiClick", { source: "menu" });
      return;
    }
    if (this.startRect && this._hit(this.startRect, x, y)) {
      if (this.dailyLocked()) {
        events.emit("uiClick", { source: "menu" });
        return;
      }
      events.emit("uiClick", { source: "menu" });
      this._emitStart();
    }
  }

  _persist() {
    saveStore.update((data) => {
      data.menuSelection.mode = this.selectedMode;
      data.menuSelection.klass = this.selectedKlass;
      data.menuSelection.race = this.selectedRace;
      data.menuSelection.opponent = this.selectedOpponent;
      data.menuSelection.mapSize = this.selectedSize;
      data.menuSelection.fleetMul = this.selectedFleet;
      data.menuSelection.factions = this.selectedFactions;
    });
  }

  _hit(r, x, y) {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  _emitStart() {
    const size = this.sizeRects.find((r) => r.key === this.selectedSize)
              || this.sizeRects[0];
    const fleet = this.fleetRects.find((r) => r.key === this.selectedFleet)
               || this.fleetRects[1];
    this.justStarted = {
      mode: this.selectedMode,
      klass: this.selectedKlass,
      race: this.selectedRace,
      opponent: this.selectedOpponent,
      mapW: size.mapW,
      mapH: size.mapH,
      fleetMul: fleet.mul,
      factions: this.selectedFactions,
    };
  }

  consumeStart() {
    const s = this.justStarted;
    this.justStarted = null;
    return s;
  }

  draw(ctx, viewW, viewH) {
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(0, 0, viewW, viewH);

    ctx.fillStyle = "#cef";
    ctx.textAlign = "center";
    ctx.font = "bold 32px system-ui, sans-serif";
    ctx.fillText("APHELION STAR FIGHTER", viewW / 2, this.modeRects[0].y - 36);

    // Mode row.
    ctx.fillStyle = "#9bd";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText("MODE", viewW / 2, this.modeRects[0].y - 12);
    for (const r of this.modeRects) {
      this._drawChip(ctx, r, r.key === this.selectedMode, r.label, r.sub);
    }

    // Class row.
    ctx.fillStyle = "#9bd";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText("YOUR SHIP", viewW / 2, this.classRects[0].y - 12);
    for (const r of this.classRects) {
      this._drawChip(ctx, r, r.key === this.selectedKlass, r.label, CLASSES[r.key].role);
    }

    // Size row.
    ctx.fillStyle = "#9bd";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText("MAP SIZE", viewW / 2, this.sizeRects[0].y - 12);
    for (const r of this.sizeRects) {
      this._drawChip(ctx, r, r.key === this.selectedSize,
        r.label, `${r.mapW} × ${r.mapH}`);
    }

    // Race row.
    ctx.fillStyle = "#9bd";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText("ALLIED RACE", viewW / 2, this.raceRects[0].y - 12);
    for (const r of this.raceRects) {
      const race = RACES[r.key];
      this._drawChip(ctx, r, r.key === this.selectedRace,
        r.label, race.tagline || "");
    }

    // Fleet-size row.
    ctx.fillStyle = "#9bd";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText("FLEET SIZE", viewW / 2, this.fleetRects[0].y - 12);
    for (const r of this.fleetRects) {
      this._drawChip(ctx, r, r.key === this.selectedFleet,
        r.label, `${r.mul}x`);
    }

    // Factions row.
    ctx.fillStyle = "#9bd";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText("FACTIONS", viewW / 2, this.factionRects[0].y - 12);
    for (const r of this.factionRects) {
      this._drawChip(ctx, r, r.key === this.selectedFactions,
        String(r.key), r.label.split(" — ")[1] || "");
    // Opponent row. Heading hints at why it's greyed out for other modes.
    const arenaOnly = this.selectedMode === "arena";
    ctx.fillStyle = arenaOnly ? "#9bd" : "#566";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText(
      arenaOnly ? "OPPONENT" : "OPPONENT (arena only)",
      viewW / 2, this.opponentRects[0].y - 12,
    );
    for (const r of this.opponentRects) {
      const sub = r.key === "random" ? "Any race" : (RACES[r.key].tagline || "");
      this._drawChip(ctx, r, r.key === this.selectedOpponent,
        r.label, sub, !arenaOnly);
    }

    // HANGAR button.
    const h = this.hangarRect;
    ctx.fillStyle = "rgba(40,60,100,0.85)";
    ctx.fillRect(h.x, h.y, h.w, h.h);
    ctx.strokeStyle = "#7df";
    ctx.lineWidth = 2;
    ctx.strokeRect(h.x, h.y, h.w, h.h);
    ctx.fillStyle = "#cef";
    ctx.font = "bold 18px system-ui, sans-serif";
    ctx.fillText("HANGAR", h.x + h.w / 2, h.y + h.h / 2 + 6);

    // CUSTOM button.
    const cu = this.customRect;
    ctx.fillStyle = "rgba(80,40,100,0.85)";
    ctx.fillRect(cu.x, cu.y, cu.w, cu.h);
    ctx.strokeStyle = "#c9f";
    ctx.lineWidth = 2;
    ctx.strokeRect(cu.x, cu.y, cu.w, cu.h);
    ctx.fillStyle = "#ecf";
    ctx.font = "bold 18px system-ui, sans-serif";
    ctx.fillText("CUSTOM", cu.x + cu.w / 2, cu.y + cu.h / 2 + 6);

    // START button.
    const s = this.startRect;
    const locked = this.dailyLocked();
    ctx.fillStyle = locked ? "rgba(60,60,80,0.85)" : "rgba(60,140,90,0.85)";
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.strokeStyle = locked ? "#778" : "#9f8";
    ctx.lineWidth = 3;
    ctx.strokeRect(s.x, s.y, s.w, s.h);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 22px system-ui, sans-serif";
    if (locked) {
      ctx.fillText("DAILY DONE", s.x + s.w / 2, s.y + s.h / 2 + 2);
      ctx.font = "11px system-ui, sans-serif";
      const d = saveStore.get().daily;
      ctx.fillText(`Score ${d.lastScore} · back tomorrow`, s.x + s.w / 2, s.y + s.h / 2 + 18);
    } else {
      ctx.fillText("START", s.x + s.w / 2, s.y + s.h / 2 + 8);
    }

    // Profile strip — pinned top-right above the chips.
    this._drawProfileStrip(ctx, viewW);

    ctx.textAlign = "left";
    ctx.restore();
  }

  _drawProfileStrip(ctx, viewW) {
    const data = saveStore.get();
    const pad = 18;
    ctx.textAlign = "right";
    ctx.fillStyle = "#fd6";
    ctx.font = "bold 16px system-ui, sans-serif";
    ctx.fillText(`${data.softCurrency}`, viewW - pad, pad + 18);
    ctx.fillStyle = "#9bd";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText("CREDITS", viewW - pad, pad + 32);

    ctx.fillStyle = "#b6f";
    ctx.font = "bold 16px system-ui, sans-serif";
    ctx.fillText(`${data.hardCurrency}`, viewW - pad - 110, pad + 18);
    ctx.fillStyle = "#9bd";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText("APHELIUM", viewW - pad - 110, pad + 32);

    ctx.textAlign = "left";
    ctx.fillStyle = "#cef";
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.fillText(`LV ${data.level}`, pad, pad + 18);
    ctx.fillStyle = "#9bd";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText(`XP ${data.xp}`, pad, pad + 32);
  }

  _drawChip(ctx, r, selected, label, sublabel, dim = false) {
    if (dim) {
      ctx.fillStyle = selected ? "rgba(40,55,75,0.7)" : "rgba(18,26,36,0.7)";
    } else {
      ctx.fillStyle = selected ? "rgba(40,90,140,0.95)" : "rgba(20,40,60,0.85)";
    }
    ctx.fillRect(r.x, r.y, r.w, r.h);
    if (dim) {
      ctx.strokeStyle = selected ? "#abc" : "#456";
    } else {
      ctx.strokeStyle = selected ? "#fff" : "#7df";
    }
    ctx.lineWidth = selected ? 3 : 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = dim ? "#7a8a9a" : "#cef";
    ctx.font = "bold 15px system-ui, sans-serif";
    ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 - 1);
    if (sublabel) {
      ctx.font = "10px system-ui, sans-serif";
      ctx.fillStyle = dim ? "#566" : "#9bd";
      ctx.fillText(sublabel, r.x + r.w / 2, r.y + r.h / 2 + 14);
    }
  }
}

// Custom game roster builder. Two columns of class steppers (Allied
// left, Hostile right), a hostile-race chip row, BACK + START at the
// bottom. State mirrors saveStore.customRoster — every adjustment
// persists so the player's last fleet build is preserved between runs.
const CUSTOM_CLASS_ORDER = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier"];
const CUSTOM_PER_CLASS_CAP = 60;

export class CustomGameScreen {
  constructor() {
    const data = saveStore.get();
    const cr = data.customRoster;
    this.roster = {
      blue: { ...cr.blue },
      red:  { ...cr.red },
    };
    this.hostileRace = RACES[cr.hostileRace] ? cr.hostileRace : "terran";
    this.backRequested = false;
    this.justStarted = null;
    this.rowRects = []; // { side, klass, minus, plus }
    this.raceRects = [];
    this.backRect = null;
    this.startRect = null;
  }

  consumeBackRequest() {
    const b = this.backRequested;
    this.backRequested = false;
    return b;
  }
  consumeStart() {
    const s = this.justStarted;
    this.justStarted = null;
    return s;
  }

  layout(viewW, viewH) {
    const panelW = Math.min(900, viewW - 40);
    const panelX = (viewW - panelW) / 2;
    const colW = (panelW - 40) / 2;
    const top = 24;

    this.backRect  = { x: panelX, y: top, w: 110, h: 40 };
    // Two launch buttons stacked along the top-right: custom (versus a
    // mirrored hostile fleet) vs. waves (carry only the allied fleet
    // into endless-survival).
    const launchW = 180, launchGap = 8;
    this.startRect = {
      x: panelX + panelW - launchW, y: top, w: launchW, h: 40,
    };
    this.startWavesRect = {
      x: panelX + panelW - launchW * 2 - launchGap, y: top, w: launchW, h: 40,
    };

    const headerY = top + 64;          // "ALLIED FLEET" / "HOSTILE FLEET" labels
    const firstRowY = headerY + 28;
    const rowH = 40;
    const rowGap = 4;
    this.rowRects = [];
    for (const side of ["blue", "red"]) {
      const colX = side === "blue" ? panelX + 20 : panelX + 20 + colW + 20;
      for (let i = 0; i < CUSTOM_CLASS_ORDER.length; i++) {
        const klass = CUSTOM_CLASS_ORDER[i];
        const y = firstRowY + i * (rowH + rowGap);
        this.rowRects.push({
          side, klass, y, h: rowH,
          x: colX, w: colW - 40,
          labelX: colX + 12,
          minus: { x: colX + colW - 40 - 96, y, w: 36, h: rowH },
          countX: colX + colW - 40 - 50,
          plus:  { x: colX + colW - 40 - 36, y, w: 36, h: rowH },
        });
      }
    }

    const racesY = firstRowY + (rowH + rowGap) * CUSTOM_CLASS_ORDER.length + 32;
    const raceKeys = RACE_KEYS;
    const rn = raceKeys.length;
    const raceBtnW = Math.min(160, (panelW - 40) / rn - 12);
    const raceRowW = rn * raceBtnW + (rn - 1) * 12;
    const raceStartX = panelX + (panelW - raceRowW) / 2;
    this.raceRects = raceKeys.map((k, i) => ({
      key: k,
      x: raceStartX + i * (raceBtnW + 12),
      y: racesY, w: raceBtnW, h: 44,
    }));

    this._panelX = panelX;
    this._panelW = panelW;
    this._headerY = headerY;
    this._racesY = racesY;
  }

  click(x, y) {
    if (this._hit(this.backRect, x, y)) {
      this.backRequested = true;
      events.emit("uiClick", { source: "menu" });
      return;
    }
    if (this._hit(this.startRect, x, y)) {
      this._persist();
      this.justStarted = {
        intoMode: "custom",
        blue: { ...this.roster.blue },
        red: { ...this.roster.red },
        hostileRace: this.hostileRace,
      };
      events.emit("uiClick", { source: "menu" });
      return;
    }
    if (this.startWavesRect && this._hit(this.startWavesRect, x, y)) {
      // Take the allied build into Waves. Only the blue roster matters
      // here; hostiles come from the wave spawner.
      this._persist();
      this.justStarted = {
        intoMode: "waves",
        blue: { ...this.roster.blue },
        red: {},
        hostileRace: this.hostileRace,
      };
      events.emit("uiClick", { source: "menu" });
      return;
    }
    for (const r of this.rowRects) {
      if (this._hit(r.minus, x, y)) {
        this._step(r.side, r.klass, -1);
        events.emit("uiClick", { source: "menu" });
        return;
      }
      if (this._hit(r.plus, x, y)) {
        this._step(r.side, r.klass, +1);
        events.emit("uiClick", { source: "menu" });
        return;
      }
    }
    for (const r of this.raceRects) {
      if (this._hit(r, x, y)) {
        this.hostileRace = r.key;
        this._persist();
        events.emit("uiClick", { source: "menu" });
        return;
      }
    }
  }

  _step(side, klass, delta) {
    const cur = this.roster[side][klass] || 0;
    this.roster[side][klass] = Math.max(0, Math.min(CUSTOM_PER_CLASS_CAP, cur + delta));
    this._persist();
  }

  _persist() {
    saveStore.update((d) => {
      d.customRoster.blue = { ...this.roster.blue };
      d.customRoster.red = { ...this.roster.red };
      d.customRoster.hostileRace = this.hostileRace;
    });
  }

  _hit(r, x, y) {
    return r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  draw(ctx, viewW, viewH) {
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.78)";
    ctx.fillRect(0, 0, viewW, viewH);

    // Title.
    ctx.fillStyle = "#ecf";
    ctx.textAlign = "center";
    ctx.font = "bold 26px system-ui, sans-serif";
    ctx.fillText("CUSTOM GAME", viewW / 2, this.backRect.y + 28);

    this._drawSquareButton(ctx, this.backRect, "← BACK", "#7df", "rgba(20,40,60,0.85)");
    if (this.startWavesRect) {
      this._drawSquareButton(ctx, this.startWavesRect, "TAKE INTO WAVES",
                              "#fb6", "rgba(120,70,30,0.9)");
    }
    this._drawSquareButton(ctx, this.startRect, "START MATCH", "#9f8", "rgba(60,140,90,0.9)");

    // Column headers.
    const colW = (this._panelW - 40) / 2;
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.fillStyle = "#9bd";
    ctx.textAlign = "center";
    ctx.fillText("ALLIED FLEET",  this._panelX + 20 + colW / 2, this._headerY + 14);
    ctx.fillStyle = "#fb6";
    ctx.fillText("HOSTILE FLEET", this._panelX + 20 + colW + 20 + colW / 2, this._headerY + 14);

    // Per-class stepper rows.
    for (const r of this.rowRects) {
      const count = this.roster[r.side][r.klass] || 0;
      // Row background.
      ctx.fillStyle = "rgba(20,30,50,0.7)";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = r.side === "blue" ? "#345" : "#522";
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      // Class name.
      ctx.fillStyle = "#cef";
      ctx.font = "bold 14px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(CLASSES[r.klass].name, r.labelX, r.y + r.h / 2 + 5);
      // Count (centered between the buttons).
      ctx.fillStyle = count > 0 ? "#fff" : "#566";
      ctx.font = "bold 16px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(count), r.countX, r.y + r.h / 2 + 6);
      // Steppers.
      this._drawStepperButton(ctx, r.minus, "−");
      this._drawStepperButton(ctx, r.plus, "+");
    }

    // Hostile-race chip row.
    ctx.fillStyle = "#fb6";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("HOSTILE RACE", viewW / 2, this._racesY - 10);
    for (const r of this.raceRects) {
      const selected = r.key === this.hostileRace;
      ctx.fillStyle = selected ? "rgba(140,60,40,0.95)" : "rgba(40,20,20,0.85)";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = selected ? "#fff" : "#a55";
      ctx.lineWidth = selected ? 3 : 2;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = "#fed";
      ctx.font = "bold 14px system-ui, sans-serif";
      ctx.fillText(RACES[r.key].name, r.x + r.w / 2, r.y + r.h / 2 - 1);
      ctx.font = "10px system-ui, sans-serif";
      ctx.fillStyle = "#fc8";
      ctx.fillText(RACES[r.key].tagline || "", r.x + r.w / 2, r.y + r.h / 2 + 13);
    }

    ctx.textAlign = "left";
    ctx.restore();
  }

  _drawSquareButton(ctx, r, label, stroke, fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 5);
  }

  _drawStepperButton(ctx, r, glyph) {
    ctx.fillStyle = "rgba(20,40,60,0.95)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = "#7df";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = "#cef";
    ctx.font = "bold 18px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(glyph, r.x + r.w / 2, r.y + r.h / 2 + 7);
  }
}

export class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.left = new VirtualStick({ side: "left", color: "#5cf" });
    this.right = new VirtualStick({ side: "right", color: "#f76" });
    this.missileBtn = new MissileButton();
    this.fireBtn = new FireButton();
    this.spectatePanel = new SpectatePanel();
    this.startMenu = new StartMenu();
    // Set from main.js each frame so the spectate panel knows which of its
    // sub-buttons (toggle vs prev/next) should be hit-active.
    this.spectating = false;
    this.hangar = new Hangar();
    this.customScreen = new CustomGameScreen();
    // Which pre-match panel is active. "menu" → start menu; "hangar" →
    // hangar profile screen; "custom" → custom-game roster builder.
    // Toggled by HANGAR / CUSTOM / BACK buttons.
    this.menuScreen = "menu";
    this.menuActive = false;
    // Read-only display rects published by the HUD. Taps inside are
    // swallowed so they don't fire joysticks or weapons.
    this.minimapRect = null;

    this.keys = new Set();
    this.mouse = { x: 0, y: 0 };
    this.mouseInside = false;
    this.mouseDown = false;
    this.mouseRightDown = false;
    this._rightClickEdge = false;

    // Latches for edge-triggered keys.
    this._enterLatched = false;
    this._mLatched = false;
    this._vLatched = false;
    this._nLatched = false;
    this._bLatched = false;
    this._rLatched = false;

    const opts = { passive: false };
    canvas.addEventListener("pointerdown", (e) => this.onDown(e), opts);
    canvas.addEventListener("pointermove", (e) => this.onMove(e), opts);
    canvas.addEventListener("pointerup", (e) => this.onUp(e), opts);
    canvas.addEventListener("pointercancel", (e) => this.onUp(e), opts);
    canvas.addEventListener("pointerenter", (e) => {
      if (e.pointerType !== "touch") this.mouseInside = true;
    });
    canvas.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== "touch") this.mouseInside = false;
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.style.touchAction = "none";

    const TRAPPED = new Set([
      "Space", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      "KeyM", "KeyV", "KeyN", "KeyB",
    ]);
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (TRAPPED.has(e.code)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => { this.keys.delete(e.code); });
    window.addEventListener("blur", () => { this.keys.clear(); });
  }

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  layoutOverlays(viewW, viewH) {
    this.missileBtn.layout(viewW, viewH);
    this.fireBtn.layout(viewW, viewH);
    this.spectatePanel.layout(viewW, viewH);
    this.startMenu.layout(viewW, viewH);
    this.hangar.layout(viewW, viewH);
    this.customScreen.layout(viewW, viewH);
  }

  onDown(e) {
    e.preventDefault();
    const { x, y } = this.pos(e);
    // Track the cursor only for real pointers — touch taps on buttons or
    // joystick zones would otherwise pollute mouseAim and rotate the
    // player toward whatever was just tapped (e.g. the FIRE button).
    if (e.pointerType !== "touch") {
      this.mouse.x = x; this.mouse.y = y; this.mouseInside = true;
    }

    // Pre-match panels: route the click to whichever screen is active
    // and swallow everything else. Screen toggle handled below.
    if (this.menuActive) {
      if (this.menuScreen === "hangar") {
        this.hangar.click(x, y);
        if (this.hangar.consumeBackRequest()) this.menuScreen = "menu";
      } else if (this.menuScreen === "custom") {
        this.customScreen.click(x, y);
        if (this.customScreen.consumeBackRequest()) this.menuScreen = "menu";
      } else {
        this.startMenu.click(x, y);
        if (this.startMenu.consumeHangarRequest()) {
          // Re-layout in case the daily-claim chip needs to appear.
          this.hangar.layout(this.canvas.clientWidth, this.canvas.clientHeight);
          this.menuScreen = "hangar";
        } else if (this.startMenu.consumeCustomRequest()) {
          this.customScreen.layout(this.canvas.clientWidth, this.canvas.clientHeight);
          this.menuScreen = "custom";
        }
      }
      return;
    }

    // Read-only HUD elements consume taps so nothing else (joystick,
    // weapon) reacts to them.
    if (this.minimapRect && pointInRect(x, y, this.minimapRect)) return;
    // Spectate panel — toggle button is always there during play, and the
    // prev/next sub-buttons are only hit-active while already spectating.
    if (this.spectatePanel.hit(x, y, this.spectating)) {
      return;
    }
    // Missile button hit-test first — works for both touch and mouse.
    if (this.missileBtn.hit(x, y)) {
      this.missileBtn.start(e.pointerId);
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
      return;
    }
    // Fire button: hold-to-fire primary cannons.
    if (this.fireBtn.hit(x, y)) {
      this.fireBtn.start(e.pointerId);
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
      return;
    }

    // Minimap tap → rally command. First tap pins the source area,
    // second tap orders the friendlies inside that area to the new
    // point. Always consumes the click so the right-stick claim below
    // doesn't fire a stray aim swing toward the corner of the screen.
    const w0 = this.canvas.clientWidth;
    const h0 = this.canvas.clientHeight;
    if (minimapHit(w0, h0, x, y)) {
      const world = minimapToWorld(w0, h0, x, y);
      if (this._gameRef) rally.tap(this._gameRef, world.x, world.y);
      return;
    }

    if (e.pointerType === "touch") {
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
      const w = this.canvas.clientWidth;
      if (this.left.claims(x, w) && this.left.pointerId === null) {
        this.left.start(e.pointerId, x, y);
      } else if (this.right.claims(x, w) && this.right.pointerId === null) {
        this.right.start(e.pointerId, x, y);
      }
    } else {
      if (e.button === 2) {
        this.mouseRightDown = true;
        this._rightClickEdge = true; // edge for missile fire
      } else {
        this.mouseDown = true;
      }
    }
  }
  onMove(e) {
    const { x, y } = this.pos(e);
    if (e.pointerType !== "touch") {
      this.mouse.x = x; this.mouse.y = y;
    }
    if (this.left.pointerId === e.pointerId) this.left.move(x, y);
    else if (this.right.pointerId === e.pointerId) this.right.move(x, y);
  }
  onUp(e) {
    if (this.left.pointerId === e.pointerId) this.left.end();
    else if (this.right.pointerId === e.pointerId) this.right.end();
    if (this.missileBtn.pointerId === e.pointerId) this.missileBtn.end();
    if (this.fireBtn.pointerId === e.pointerId) this.fireBtn.end();
    if (e.pointerType !== "touch") {
      if (e.button === 2) this.mouseRightDown = false;
      else this.mouseDown = false;
    }
  }

  consumeEnterPress() {
    if (this.keys.has("Enter") && !this._enterLatched) {
      this._enterLatched = true;
      return true;
    }
    if (!this.keys.has("Enter")) this._enterLatched = false;
    return false;
  }

  // Edge-triggered key press, latched until released.
  _consumeKey(code, latchName) {
    if (this.keys.has(code) && !this[latchName]) {
      this[latchName] = true;
      return true;
    }
    if (!this.keys.has(code)) this[latchName] = false;
    return false;
  }

  consumeMissilePress() {
    const keyEdge = this._consumeKey("KeyM", "_mLatched");
    const rightEdge = this._rightClickEdge;
    this._rightClickEdge = false;
    const btnEdge = this.missileBtn.consumeJustPressed();
    return keyEdge || rightEdge || btnEdge;
  }

  consumeSpectateToggle()  {
    return this._consumeKey("KeyV", "_vLatched") || this.spectatePanel.consumeToggle();
  }
  consumeSpectateNext()    {
    return this._consumeKey("KeyN", "_nLatched") || this.spectatePanel.consumeNext();
  }
  consumeSpectatePrev()    {
    return this._consumeKey("KeyB", "_bLatched") || this.spectatePanel.consumePrev();
  }

  controller() {
    const touchThrust = this.left.value;
    const touchAim = this.right.value;
    const touchAimLen = Math.hypot(touchAim.x, touchAim.y);
    const touchHasThrust = Math.hypot(touchThrust.x, touchThrust.y) > 0;

    let kx = 0, ky = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp"))    ky -= 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown"))  ky += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft"))  kx -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) kx += 1;
    const kLen = Math.hypot(kx, ky);
    const kbThrust = kLen > 0 ? { x: kx / kLen, y: ky / kLen } : { x: 0, y: 0 };

    let mouseAim = null;
    if (this.mouseInside) {
      const cx = this.canvas.clientWidth / 2;
      const cy = this.canvas.clientHeight / 2;
      const dx = this.mouse.x - cx;
      const dy = this.mouse.y - cy;
      if (Math.hypot(dx, dy) > 4) mouseAim = { x: dx, y: dy };
    }

    const thrust = kLen > 0 ? kbThrust : (touchHasThrust ? touchThrust : { x: 0, y: 0 });

    // Aim priority: right stick → mouse → keyboard direction → left stick.
    // The left-stick fallback is what makes touch fighters turn — without
    // it, the player's heading is locked because fighter velocity is bound
    // to heading (see ship.js updateShip) and thrust is otherwise ignored.
    let aim;
    if (touchAimLen > 0) aim = touchAim;
    else if (mouseAim) aim = mouseAim;
    else if (kLen > 0) aim = kbThrust;
    else if (touchHasThrust) aim = touchThrust;
    else aim = null;

    const firing = this.keys.has("Enter") || this.keys.has("Space")
                || this.mouseDown || this.fireBtn.pressed;

    return { thrust, aim, firing };
  }

  drawSticks(ctx) {
    this.left.draw(ctx);
    this.right.draw(ctx);
  }
}
