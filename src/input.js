// Input sources: virtual joysticks for touch, plus WASD + mouse + Enter
// for desktop play. The aim direction is computed relative to canvas
// center because the camera follows the player ship, so center == player.

import { MAP_SIZES } from "./arena.js";
import { RACES, RACE_KEYS } from "./races.js";
import { UPGRADES, UPGRADE_KEYS, MAX_MISSION, nextCost } from "./campaign.js";
import {
  MAX_ENERGY, COST_PER_GAME, PACKAGES,
  canSpend, timeUntilNext, formatDuration,
} from "./energy.js";

const DEADZONE = 0.15;

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

// Generic on-screen action button. Used for FIRE (primary gun) and
// SPECTATE — touch-friendly, mouse also works. Each button owns one
// pointer at a time so concurrent touches on other zones aren't stolen.
class ActionButton {
  constructor({ w = 90, h = 60 } = {}) {
    this.pointerId = null;
    this.pressed = false;
    this.justPressed = false;
    this.rect = { x: 0, y: 0, w, h };
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
}

// On-screen FIRE button (bottom-right, left of missile). Primary gun.
// Holding fires continuously; the controller reads `pressed`.
export class FireButton extends ActionButton {
  constructor() { super({ w: 90, h: 60 }); }
  layout(viewW, viewH) {
    // Sit to the LEFT of the missile button, same row.
    this.rect.x = viewW - this.rect.w - 18 - 90 - 12;
    this.rect.y = viewH - this.rect.h - 135 - 16 - 12;
  }
  draw(ctx) {
    const r = this.rect;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = this.pressed ? "rgba(70,30,30,0.85)" : "rgba(40,20,20,0.7)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = this.pressed ? "#fa6" : "#f76";
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = "#fec";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 18px system-ui, sans-serif";
    ctx.fillText("FIRE", r.x + r.w / 2, r.y + r.h / 2 - 2);
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = "#fcb";
    ctx.fillText("GUN", r.x + r.w / 2, r.y + r.h / 2 + 14);
    ctx.restore();
  }
}

// On-screen SPECTATE toggle (top-centre under HUD strips). Edge-triggered.
export class SpectateButton extends ActionButton {
  constructor() { super({ w: 110, h: 36 }); }
  layout(viewW /* , viewH */) {
    // Centred at the top, below the headline; gets out of the way of
    // the side-count strips on the corners.
    this.rect.x = (viewW - this.rect.w) / 2;
    this.rect.y = 12;
  }
  draw(ctx, spectating) {
    const r = this.rect;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = spectating ? "rgba(30,60,80,0.85)" : "rgba(15,25,35,0.7)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = spectating ? "#7df" : "#467";
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = spectating ? "#cef" : "#9ab";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.fillText(spectating ? "RETURN TO SHIP" : "SPECTATE", r.x + r.w / 2, r.y + r.h / 2);
    ctx.restore();
  }
}

// On-screen missile button (top-right). Touch-friendly. Mouse also works.
export class MissileButton {
  constructor() {
    this.pointerId = null;
    this.pressed = false;
    this.justPressed = false;
    this.rect = { x: 0, y: 0, w: 90, h: 60 };
  }
  layout(viewW, viewH) {
    // Sit above the minimap (which occupies the bottom-right 180x135
    // area with a 16px margin) so the button never overlaps the map.
    this.rect.x = viewW - this.rect.w - 18;
    this.rect.y = viewH - this.rect.h - 135 - 16 - 12;
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
      // cooldown shade — top portion filled.
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

// Pre-match menu: lets the player pick a map size, game mode, and Allied
// race before the world spawns. Layout is three rows of chips plus an
// explicit START button. Each chip toggles its row's selection; START
// emits the chosen { mapW, mapH, race, mode } bundle.
const MODE_OPTIONS = [
  { key: "open",     label: "Open Battle",     tagline: "Wipe the enemy fleet" },
  { key: "defend",   label: "Defend Station",  tagline: "Destroy enemy station" },
  { key: "campaign", label: "Campaign",        tagline: "100-mission tour" },
];

export class StartMenu {
  constructor() {
    this.sizeRects = [];
    this.modeRects = [];
    this.raceRects = [];
    this.upgradeRects = [];
    this.startRect = null;
    this.selectedSize = "medium";
    this.selectedMode = "open";
    this.selectedRace = "terran";
    this.justStarted = null;
    // Campaign state ref + click callback wired by main.js.
    this.campaign = null;
    this.onPurchase = null;
    // Energy state ref + IAP callback wired by main.js.
    this.energy = null;
    this.onEnergyPurchase = null;
    this.showRefill = false;        // package overlay visibility
    this.refillRects = [];          // per-package click rects
    this.refillCloseRect = null;
    this.energyBarRect = null;      // clickable "refill" area in the header
  }

  setCampaign(state, onPurchase) {
    this.campaign = state;
    this.onPurchase = onPurchase;
  }

  setEnergy(state, onPurchase) {
    this.energy = state;
    this.onEnergyPurchase = onPurchase;
  }

  layout(viewW, viewH) {
    const chipH = 60;
    const gapX = 14;
    const rowGap = 44;
    const titleY = viewH / 2 - 220;

    // Size row.
    const sizeOpts = MAP_SIZES;
    const sn = sizeOpts.length;
    const sizeBtnW = Math.min(180, (viewW - 80) / sn - gapX);
    const sizeRowW = sn * sizeBtnW + (sn - 1) * gapX;
    const sizeY = titleY + 70;
    const sizeStartX = (viewW - sizeRowW) / 2;
    this.sizeRects = sizeOpts.map((o, i) => ({
      key: o.key, label: o.label, mapW: o.mapW, mapH: o.mapH,
      x: sizeStartX + i * (sizeBtnW + gapX),
      y: sizeY, w: sizeBtnW, h: chipH,
    }));

    // Mode row.
    const mn = MODE_OPTIONS.length;
    const modeBtnW = Math.min(220, (viewW - 60) / mn - gapX);
    const modeRowW = mn * modeBtnW + (mn - 1) * gapX;
    const modeY = sizeY + chipH + rowGap;
    const modeStartX = (viewW - modeRowW) / 2;
    this.modeRects = MODE_OPTIONS.map((o, i) => ({
      key: o.key, label: o.label, tagline: o.tagline,
      x: modeStartX + i * (modeBtnW + gapX),
      y: modeY, w: modeBtnW, h: chipH,
    }));

    // Race row.
    const raceKeys = RACE_KEYS;
    const rn = raceKeys.length;
    const raceBtnW = Math.min(150, (viewW - 60) / rn - gapX);
    const raceRowW = rn * raceBtnW + (rn - 1) * gapX;
    const raceY = modeY + chipH + rowGap;
    const raceStartX = (viewW - raceRowW) / 2;
    this.raceRects = raceKeys.map((k, i) => ({
      key: k, label: RACES[k].name,
      x: raceStartX + i * (raceBtnW + gapX),
      y: raceY, w: raceBtnW, h: chipH,
    }));

    // Campaign upgrade grid (only used when Campaign mode is selected).
    // Two rows of three tiles below the race row.
    let nextY = raceY + chipH + rowGap;
    this.upgradeRects = [];
    if (this.selectedMode === "campaign") {
      const tileW = Math.min(220, (viewW - 60) / 3 - gapX);
      const tileH = 56;
      const cols = 3;
      const totalRowW = cols * tileW + (cols - 1) * gapX;
      const startX = (viewW - totalRowW) / 2;
      nextY += 28; // header room ("Mission X/100  Credits: ...")
      for (let i = 0; i < UPGRADE_KEYS.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        this.upgradeRects.push({
          key: UPGRADE_KEYS[i],
          x: startX + col * (tileW + gapX),
          y: nextY + row * (tileH + 10),
          w: tileW, h: tileH,
        });
      }
      const rows = Math.ceil(UPGRADE_KEYS.length / cols);
      nextY += rows * tileH + (rows - 1) * 10 + rowGap;
    }

    // START button.
    const startW = 260, startH = 56;
    this.startRect = {
      x: (viewW - startW) / 2,
      y: nextY,
      w: startW, h: startH,
    };

    // Energy header — clickable strip at the very top of the menu.
    // Sits above the title in screen space.
    const ebW = 360, ebH = 38;
    this.energyBarRect = {
      x: (viewW - ebW) / 2,
      y: titleY - 60,
      w: ebW, h: ebH,
    };

    // Refill overlay (package picker). Always laid out so the click
    // hit-test works the moment the overlay opens — `showRefill`
    // gates draw + click.
    const pkgW = 220, pkgH = 110, pkgGap = 14;
    const totalW = PACKAGES.length * pkgW + (PACKAGES.length - 1) * pkgGap;
    const pkgY = viewH / 2 - pkgH / 2;
    const pkgStartX = (viewW - totalW) / 2;
    this.refillRects = PACKAGES.map((p, i) => ({
      id: p.id,
      x: pkgStartX + i * (pkgW + pkgGap),
      y: pkgY,
      w: pkgW, h: pkgH,
    }));
    this.refillCloseRect = {
      x: viewW / 2 - 50,
      y: pkgY + pkgH + 24,
      w: 100, h: 36,
    };
  }

  click(x, y) {
    // Refill overlay grabs all clicks while open.
    if (this.showRefill) {
      for (const r of this.refillRects) {
        if (this._hit(r, x, y)) {
          if (this.onEnergyPurchase) this.onEnergyPurchase(r.id);
          this.showRefill = false;
          return true;
        }
      }
      // Close button OR clicking outside the overlay dismisses it.
      this.showRefill = false;
      return true;
    }
    // Energy bar opens the refill overlay.
    if (this.energyBarRect && this._hit(this.energyBarRect, x, y)) {
      this.showRefill = true;
      return true;
    }
    for (const r of this.sizeRects) {
      if (this._hit(r, x, y)) { this.selectedSize = r.key; return true; }
    }
    for (const r of this.modeRects) {
      if (this._hit(r, x, y)) {
        const changed = this.selectedMode !== r.key;
        this.selectedMode = r.key;
        // Returning the "remeasure" flag lets the caller relayout so
        // the campaign panel appears / disappears immediately.
        if (changed) return "relayout";
        return true;
      }
    }
    for (const r of this.raceRects) {
      if (this._hit(r, x, y)) { this.selectedRace = r.key; return true; }
    }
    for (const r of this.upgradeRects) {
      if (this._hit(r, x, y)) {
        if (this.onPurchase) this.onPurchase(r.key);
        return true;
      }
    }
    if (this.startRect && this._hit(this.startRect, x, y)) {
      // Out-of-energy clicks pop the refill overlay instead of starting
      // a match. Standard F2P funnel: friction → purchase prompt.
      if (this.energy && !canSpend(this.energy, COST_PER_GAME)) {
        this.showRefill = true;
        return true;
      }
      this._emitStart();
      return true;
    }
    return false;
  }

  _hit(r, x, y) {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  _emitStart() {
    const size = this.sizeRects.find((r) => r.key === this.selectedSize)
              || this.sizeRects[0];
    this.justStarted = {
      mapW: size.mapW, mapH: size.mapH,
      race: this.selectedRace,
      mode: this.selectedMode,
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

    // Energy header — clickable strip showing current tank and the
    // refill countdown when below cap. Doubles as the entry point to
    // the purchase overlay.
    if (this.energyBarRect) this._drawEnergyHeader(ctx);

    ctx.fillStyle = "#cef";
    ctx.textAlign = "center";
    ctx.font = "bold 36px system-ui, sans-serif";
    ctx.fillText("APHELION STAR FIGHTER", viewW / 2, viewH / 2 - 230);

    ctx.fillStyle = "#9bd";
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillText("MAP SIZE", viewW / 2, this.sizeRects[0].y - 14);
    for (const r of this.sizeRects) {
      this._drawChip(ctx, r, r.key === this.selectedSize,
        r.label, `${r.mapW} × ${r.mapH}`);
    }

    ctx.fillStyle = "#9bd";
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillText("GAME MODE", viewW / 2, this.modeRects[0].y - 14);
    for (const r of this.modeRects) {
      this._drawChip(ctx, r, r.key === this.selectedMode,
        r.label, r.tagline);
    }

    ctx.fillStyle = "#9bd";
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillText("ALLIED RACE", viewW / 2, this.raceRects[0].y - 14);
    for (const r of this.raceRects) {
      const race = RACES[r.key];
      this._drawChip(ctx, r, r.key === this.selectedRace,
        r.label, race.tagline || "");
    }

    // Campaign panel: progress header + upgrade tiles.
    if (this.selectedMode === "campaign" && this.upgradeRects.length > 0) {
      const camp = this.campaign;
      const firstRect = this.upgradeRects[0];
      const headerY = firstRect.y - 16;
      ctx.fillStyle = "#cef";
      ctx.font = "bold 16px system-ui, sans-serif";
      const m = camp ? camp.mission : 1;
      const money = camp ? camp.money : 0;
      const status = camp && camp.completed
        ? `CAMPAIGN COMPLETE — Free Skirmish`
        : `MISSION ${m} / ${MAX_MISSION}`;
      ctx.fillText(`${status}    Credits: ${money.toLocaleString()}`, viewW / 2, headerY);
      for (const r of this.upgradeRects) this._drawUpgrade(ctx, r);
    }

    const s = this.startRect;
    const outOfEnergy = this.energy && !canSpend(this.energy, COST_PER_GAME);
    if (outOfEnergy) {
      ctx.fillStyle = "rgba(60,40,40,0.85)";
      ctx.fillRect(s.x, s.y, s.w, s.h);
      ctx.strokeStyle = "#c66";
      ctx.lineWidth = 3;
      ctx.strokeRect(s.x, s.y, s.w, s.h);
      ctx.fillStyle = "#fcc";
      ctx.font = "bold 18px system-ui, sans-serif";
      ctx.fillText("OUT OF ENERGY", s.x + s.w / 2, s.y + s.h / 2 - 2);
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillStyle = "#fa8";
      ctx.fillText("Tap to refill", s.x + s.w / 2, s.y + s.h / 2 + 16);
    } else {
      ctx.fillStyle = "rgba(60,140,90,0.85)";
      ctx.fillRect(s.x, s.y, s.w, s.h);
      ctx.strokeStyle = "#9f8";
      ctx.lineWidth = 3;
      ctx.strokeRect(s.x, s.y, s.w, s.h);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 22px system-ui, sans-serif";
      let label = "START";
      if (this.selectedMode === "campaign" && this.campaign) {
        label = this.campaign.completed
          ? "FREE SKIRMISH"
          : `START MISSION ${this.campaign.mission}`;
      }
      ctx.fillText(label, s.x + s.w / 2, s.y + s.h / 2 + 8);
    }

    // Refill overlay renders last so it sits on top of everything.
    if (this.showRefill) this._drawRefillOverlay(ctx, viewW, viewH);

    ctx.textAlign = "left";
    ctx.restore();
  }

  _drawEnergyHeader(ctx) {
    const r = this.energyBarRect;
    const e = this.energy;
    const cur = e ? e.current : MAX_ENERGY;
    const full = cur >= MAX_ENERGY;
    const empty = cur <= 0;

    ctx.fillStyle = empty ? "rgba(70,30,30,0.85)" : "rgba(20,40,55,0.85)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = empty ? "#f86" : (full ? "#9fc" : "#7df");
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    // Left: ⚡ + count
    ctx.textAlign = "left";
    ctx.fillStyle = empty ? "#f86" : "#fe8";
    ctx.font = "bold 18px system-ui, sans-serif";
    ctx.fillText("ENERGY", r.x + 12, r.y + 24);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 18px system-ui, sans-serif";
    ctx.fillText(`${cur}/${MAX_ENERGY}`, r.x + 90, r.y + 24);

    // Middle: regen countdown.
    if (!full && e) {
      ctx.fillStyle = "#9bd";
      ctx.font = "12px system-ui, sans-serif";
      ctx.textAlign = "center";
      const next = timeUntilNext(e);
      ctx.fillText(`Next +1 in ${formatDuration(next)}`, r.x + r.w / 2, r.y + 23);
    }

    // Right: refill button hint.
    ctx.textAlign = "right";
    ctx.fillStyle = "#fe8";
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.fillText("+ REFILL", r.x + r.w - 12, r.y + 24);
    ctx.textAlign = "left";
  }

  _drawRefillOverlay(ctx, viewW, viewH) {
    // Scrim.
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(0, 0, viewW, viewH);

    ctx.textAlign = "center";
    ctx.fillStyle = "#cef";
    ctx.font = "bold 26px system-ui, sans-serif";
    ctx.fillText("REFUEL ENERGY", viewW / 2, this.refillRects[0].y - 30);
    ctx.fillStyle = "#9bd";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText("Get back in the cockpit instantly",
      viewW / 2, this.refillRects[0].y - 12);

    for (let i = 0; i < this.refillRects.length; i++) {
      const rr = this.refillRects[i];
      const pkg = PACKAGES[i];
      ctx.fillStyle = "rgba(30,60,100,0.95)";
      ctx.fillRect(rr.x, rr.y, rr.w, rr.h);
      ctx.strokeStyle = "#9cf";
      ctx.lineWidth = 2;
      ctx.strokeRect(rr.x, rr.y, rr.w, rr.h);

      ctx.fillStyle = "#cef";
      ctx.font = "bold 18px system-ui, sans-serif";
      ctx.fillText(pkg.label, rr.x + rr.w / 2, rr.y + 28);
      ctx.fillStyle = "#fe8";
      ctx.font = "bold 32px system-ui, sans-serif";
      ctx.fillText(`+${pkg.energy}`, rr.x + rr.w / 2, rr.y + 68);
      ctx.fillStyle = "#9f8";
      ctx.font = "bold 16px system-ui, sans-serif";
      ctx.fillText(pkg.price, rr.x + rr.w / 2, rr.y + 95);
    }

    // Close button.
    const cr = this.refillCloseRect;
    ctx.fillStyle = "rgba(60,40,40,0.85)";
    ctx.fillRect(cr.x, cr.y, cr.w, cr.h);
    ctx.strokeStyle = "#c66";
    ctx.lineWidth = 2;
    ctx.strokeRect(cr.x, cr.y, cr.w, cr.h);
    ctx.fillStyle = "#fcc";
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.fillText("CLOSE", cr.x + cr.w / 2, cr.y + cr.h / 2 + 5);
    ctx.textAlign = "left";
  }

  _drawUpgrade(ctx, r) {
    const def = UPGRADES[r.key];
    if (!def || !this.campaign) return;
    const lvl = this.campaign.upgrades[r.key] || 0;
    const maxed = lvl >= def.maxLevel;
    const cost = maxed ? null : nextCost(this.campaign, r.key);
    const afford = !maxed && this.campaign.money >= cost;

    ctx.fillStyle = maxed ? "rgba(40,80,60,0.85)"
                  : afford ? "rgba(30,60,100,0.92)"
                           : "rgba(40,40,55,0.85)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = maxed ? "#7d9" : afford ? "#9cf" : "#566";
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    ctx.fillStyle = "#cef";
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(def.name, r.x + 8, r.y + 16);
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = "#9bd";
    ctx.fillText(def.desc, r.x + 8, r.y + 30);

    ctx.textAlign = "right";
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.fillStyle = "#fff";
    ctx.fillText(`Lv ${lvl}/${def.maxLevel}`, r.x + r.w - 8, r.y + 16);
    ctx.font = "12px system-ui, sans-serif";
    if (maxed) {
      ctx.fillStyle = "#9f8";
      ctx.fillText("MAX", r.x + r.w - 8, r.y + 44);
    } else {
      ctx.fillStyle = afford ? "#fe8" : "#866";
      ctx.fillText(`$${cost.toLocaleString()}`, r.x + r.w - 8, r.y + 44);
    }
    ctx.textAlign = "left";
  }

  _drawChip(ctx, r, selected, label, sublabel) {
    ctx.fillStyle = selected ? "rgba(40,90,140,0.95)" : "rgba(20,40,60,0.85)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = selected ? "#fff" : "#7df";
    ctx.lineWidth = selected ? 3 : 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = "#cef";
    ctx.font = "bold 17px system-ui, sans-serif";
    ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 - 2);
    if (sublabel) {
      ctx.font = "11px system-ui, sans-serif";
      ctx.fillStyle = "#9bd";
      ctx.fillText(sublabel, r.x + r.w / 2, r.y + r.h / 2 + 15);
    }
  }
}

export class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.left = new VirtualStick({ side: "left", color: "#5cf" });
    this.right = new VirtualStick({ side: "right", color: "#f76" });
    this.missileBtn = new MissileButton();
    this.fireBtn = new FireButton();
    this.spectateBtn = new SpectateButton();
    this.startMenu = new StartMenu();
    this.menuActive = false;

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
    // mouseInside only tracks REAL mouse cursors. Touch events shouldn't
    // pin the mouse-aim layer to the latest fingertip position — that
    // would override the left stick in controller()'s aim priority and
    // route fighter movement through whichever spot a touch last
    // landed.
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
      "KeyM", "KeyV", "KeyN", "KeyB", "KeyP",
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
    this.spectateBtn.layout(viewW, viewH);
    this.startMenu.layout(viewW, viewH);
  }

  onDown(e) {
    e.preventDefault();
    const { x, y } = this.pos(e);
    // Mouse-tracking layer only listens to real mouse pointers — touch
    // events route exclusively through the virtual sticks and on-screen
    // action buttons.
    if (e.pointerType !== "touch") {
      this.mouse.x = x; this.mouse.y = y; this.mouseInside = true;
    }

    // Pre-match menu: route the click to size-selection and swallow
    // everything else. A "relayout" return from click() means the user
    // toggled the mode chip — re-layout so the campaign panel appears
    // or disappears immediately under the cursor.
    if (this.menuActive) {
      const result = this.startMenu.click(x, y);
      if (result === "relayout") {
        const rect = this.canvas.getBoundingClientRect();
        this.startMenu.layout(rect.width, rect.height);
      }
      return;
    }

    // Action-button hit-tests first — works for both touch and mouse.
    // Order matters: each button owns the pointer once it claims it.
    if (this.missileBtn.hit(x, y)) {
      this.canvas.setPointerCapture(e.pointerId);
      this.missileBtn.start(e.pointerId);
      return;
    }
    if (this.fireBtn.hit(x, y)) {
      this.canvas.setPointerCapture(e.pointerId);
      this.fireBtn.start(e.pointerId);
      return;
    }
    if (this.spectateBtn.hit(x, y)) {
      this.canvas.setPointerCapture(e.pointerId);
      this.spectateBtn.start(e.pointerId);
      return;
    }

    if (e.pointerType === "touch") {
      this.canvas.setPointerCapture(e.pointerId);
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
    if (this.spectateBtn.pointerId === e.pointerId) this.spectateBtn.end();
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
    const keyEdge = this._consumeKey("KeyV", "_vLatched");
    const btnEdge = this.spectateBtn.consumeJustPressed();
    return keyEdge || btnEdge;
  }
  consumeSpectateNext()    { return this._consumeKey("KeyN", "_nLatched"); }
  consumeMuteToggle()      { return this._consumeKey("KeyP", "_pLatched"); }
  consumeSpectatePrev()    { return this._consumeKey("KeyB", "_bLatched"); }

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

    // Aim resolution. Fighters fly nose-first at maxSpeed so `aim`
    // effectively IS movement direction for aircraft — the left stick
    // therefore needs to be a valid aim source so single-thumb play
    // (left-thumb-only) actually moves the ship. Order of precedence:
    //   1. Right stick (precision aim with second thumb)
    //   2. Mouse (desktop)
    //   3. Left stick (single-thumb touch flight)
    //   4. Keyboard WASD (desktop fallback)
    let aim;
    if (touchAimLen > 0) aim = touchAim;
    else if (mouseAim) aim = mouseAim;
    else if (touchHasThrust) aim = touchThrust;
    else if (kLen > 0) aim = kbThrust;
    else aim = null;

    // Firing sources: keyboard Enter/Space, mouse left-button, or the
    // on-screen FIRE button. The right stick is aim-only — touching it
    // no longer auto-fires, so movement-related touches stay on the
    // left half and shooting stays an explicit action.
    const firing = this.keys.has("Enter") || this.keys.has("Space")
                || this.mouseDown || this.fireBtn.pressed;

    return { thrust, aim, firing };
  }

  drawSticks(ctx) {
    this.left.draw(ctx);
    this.right.draw(ctx);
  }
}
