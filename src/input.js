// Input sources: virtual joysticks for touch, plus WASD + mouse + Enter
// for desktop play. The aim direction is computed relative to canvas
// center because the camera follows the player ship, so center == player.

import { MAP_SIZES } from "./arena.js";
import { RACES, RACE_KEYS } from "./races.js";
import { SIDES } from "./classes.js";
import {
  ACTS_PER_RUN, COLS_PER_ACT, ROWS_PER_ACT,
  STARTER_FUEL, FUEL_PER_EDGE,
  repairCostFor, eventCardById, PERKS, BOON_TABLE,
} from "./roguelite.js";
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

// Admiral-mode command panel. Bottom-of-screen, two columns of three
// per-class rows. Each row carries posture chips (HOLD / FREE / PRESS)
// and, where the class has missile pods, a missile-hold toggle. Reads
// + writes `game.directives` via the wired getter/setter pair so the
// AI sees changes the same frame.
const ADMIRAL_PANEL_CLASSES = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier"];
// Classes whose missile pods the admiral can hold. Fighters have a
// single player-fired missile (no AI launch) and carriers have no
// pods at all, so they don't get an M toggle.
const ADMIRAL_MISSILE_CLASSES = new Set(["bomber", "frigate", "cruiser", "battleship"]);
const ADMIRAL_POSTURES = ["hold", "free", "press"];

export class AdmiralPanel {
  constructor() {
    this._rects = []; // flat list of { kind, klass, posture?, x, y, w, h }
    this._getDirectives = () => null;
    this._setPosture = () => {};
    this._setMissiles = () => {};
    this.panelRect = null;
  }

  setHooks(getDirectives, setPosture, setMissiles) {
    this._getDirectives = getDirectives;
    this._setPosture = setPosture;
    this._setMissiles = setMissiles;
  }

  layout(viewW, viewH) {
    // Two columns × three rows along the bottom edge. Panel is centred
    // horizontally so it doesn't fight the minimap on the right or the
    // target panel on the left.
    const colW = 360;
    const colGap = 24;
    const rowH = 40;
    const rowGap = 4;
    const padX = 14, padY = 12;
    const cols = 2;
    const rows = 3;
    const innerW = colW * cols + colGap;
    const innerH = rowH * rows + rowGap * (rows - 1);
    const panelW = innerW + padX * 2;
    const panelH = innerH + padY * 2;
    const panelX = (viewW - panelW) / 2;
    const panelY = viewH - panelH - 16;
    this.panelRect = { x: panelX, y: panelY, w: panelW, h: panelH };

    const labelW = 86;
    const postureW = 56;
    const postureGap = 4;
    const missileW = 32;
    const rectsStartY = panelY + padY;

    this._rects = [];
    for (let i = 0; i < ADMIRAL_PANEL_CLASSES.length; i++) {
      const klass = ADMIRAL_PANEL_CLASSES[i];
      const col = Math.floor(i / rows);
      const row = i % rows;
      const rowLeft = panelX + padX + col * (colW + colGap);
      const rowTop = rectsStartY + row * (rowH + rowGap);

      // Label rect — also acts as a click target for the class header
      // (no action yet; reserved for future "select class on canvas"
      // gestures).
      this._rects.push({
        kind: "label", klass,
        x: rowLeft, y: rowTop, w: labelW, h: rowH - rowGap,
      });

      // Posture chips.
      for (let p = 0; p < ADMIRAL_POSTURES.length; p++) {
        this._rects.push({
          kind: "posture", klass, posture: ADMIRAL_POSTURES[p],
          x: rowLeft + labelW + 4 + p * (postureW + postureGap),
          y: rowTop, w: postureW, h: rowH - rowGap,
        });
      }

      // Missile toggle for classes that have pods.
      if (ADMIRAL_MISSILE_CLASSES.has(klass)) {
        this._rects.push({
          kind: "missile", klass,
          x: rowLeft + labelW + 4 + ADMIRAL_POSTURES.length * (postureW + postureGap),
          y: rowTop, w: missileW, h: rowH - rowGap,
        });
      }
    }
  }

  hit(x, y) {
    if (!this.panelRect) return false;
    const r = this.panelRect;
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  // Returns true if the click hit a control. The InputManager uses
  // this to swallow the click so it doesn't also trigger spectate
  // camera pan.
  handleClick(x, y) {
    for (const r of this._rects) {
      if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
      if (r.kind === "posture") {
        this._setPosture(r.klass, r.posture);
        return true;
      }
      if (r.kind === "missile") {
        const d = this._getDirectives();
        const cur = d && d[r.klass] ? d[r.klass].missiles : "on";
        this._setMissiles(r.klass, cur === "on" ? "hold" : "on");
        return true;
      }
      if (r.kind === "label") return true; // swallow without action
    }
    // Click was inside the panel chrome but missed every control —
    // still swallow so the spectate camera doesn't pan under it.
    if (this.hit(x, y)) return true;
    return false;
  }

  draw(ctx) {
    const directives = this._getDirectives();
    if (!directives) return;
    const p = this.panelRect;
    ctx.save();
    ctx.fillStyle = "rgba(8,16,28,0.85)";
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.strokeStyle = "#5af";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p.x, p.y, p.w, p.h);

    for (const r of this._rects) {
      const d = directives[r.klass] || { posture: "free", missiles: "on" };
      if (r.kind === "label") {
        ctx.fillStyle = "#9bd";
        ctx.font = "bold 13px system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(r.klass.toUpperCase(), r.x + 4, r.y + r.h / 2 + 5);
      } else if (r.kind === "posture") {
        const selected = d.posture === r.posture;
        const tint = r.posture === "hold" ? "#fa8"
                   : r.posture === "press" ? "#f97"
                                           : "#7df";
        ctx.fillStyle = selected ? "rgba(40,80,120,0.95)" : "rgba(18,30,46,0.85)";
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = selected ? tint : "rgba(120,160,200,0.6)";
        ctx.lineWidth = selected ? 2 : 1;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = selected ? "#fff" : tint;
        ctx.font = "bold 11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(r.posture.toUpperCase(), r.x + r.w / 2, r.y + r.h / 2 + 4);
      } else if (r.kind === "missile") {
        const held = d.missiles === "hold";
        ctx.fillStyle = held ? "rgba(80,40,30,0.95)" : "rgba(30,60,40,0.9)";
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = held ? "#fa8" : "#9f8";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = held ? "#fa8" : "#9f8";
        ctx.font = "bold 13px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("M", r.x + r.w / 2, r.y + r.h / 2 + 5);
      }
    }
    ctx.restore();
  }
}

// Pre-match menu: lets the player pick a map size, game mode, and Allied
// race before the world spawns. Layout is three rows of chips plus an
// explicit START button. Each chip toggles its row's selection; START
// emits the chosen { mapW, mapH, race, mode } bundle.
const MODE_OPTIONS = [
  { key: "open",      label: "Open Battle",     tagline: "Wipe the enemy fleet" },
  { key: "defend",    label: "Defend Station",  tagline: "Destroy enemy station" },
  { key: "roguelite", label: "Frontier",        tagline: "Procedural war" },
  { key: "custom",    label: "Custom",          tagline: "Pick fleets + races" },
  { key: "admiral",   label: "Admiral",         tagline: "Command, don't pilot" },
];

// Roster classes editable in the Custom Match overlay. Order matters —
// it's the row order in both side panels. Stations are intentionally
// excluded; the Defend mode handles them.
const CUSTOM_CLASSES = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier"];
const CUSTOM_MAX_PER_CLASS = 60;

// Two-letter glyphs for the class icon badge in each slider row.
// Same family as the in-game roster strip (kept in hud.js) — duplicated
// here so input.js stays import-light. If a class is added to either
// file, add the matching glyph in both.
const CLASS_GLYPHS = {
  fighter: "F", bomber: "B", frigate: "Fr",
  cruiser: "C", battleship: "BB", carrier: "CV",
};

// Pull a fresh per-class count map for the given race. Used to seed
// counts when the player opens the overlay or switches the race chip
// for a side. Missing entries default to 0 so adding new classes to
// CUSTOM_CLASSES doesn't desync.
function rosterForRace(raceKey) {
  const race = RACES[raceKey] || RACES.terran;
  const src = race.roster || {};
  const out = {};
  for (const k of CUSTOM_CLASSES) out[k] = src[k] || 0;
  return out;
}

function totalShipCount(counts) {
  let n = 0;
  for (const k of CUSTOM_CLASSES) n += counts[k] || 0;
  return n;
}

function classDisplayName(klass) {
  if (klass === "battleship") return "Battleship";
  if (klass === "fighter") return "Fighter";
  if (klass === "bomber")  return "Bomber";
  if (klass === "frigate") return "Frigate";
  if (klass === "cruiser") return "Cruiser";
  if (klass === "carrier") return "Carrier";
  return klass;
}

// Fleet-size presets. `mul` is a multiplier applied to every per-class
// count in spawnRoster (rounded, minimum 1 per non-zero class). "Huge"
// roughly doubles a stock skirmish to the upper edge of what the
// renderer handles smoothly on modest hardware.
const FLEET_OPTIONS = [
  { key: "small",  label: "Small",  mul: 0.5, tagline: "Skirmish — half fleet" },
  { key: "medium", label: "Medium", mul: 1.0, tagline: "Standard" },
  { key: "large",  label: "Large",  mul: 1.6, tagline: "Heavy battle" },
  { key: "huge",   label: "Huge",   mul: 2.5, tagline: "Full clash" },
];

export class StartMenu {
  constructor() {
    this.sizeRects = [];
    this.modeRects = [];
    this.raceRects = [];
    this.startRect = null;
    this.selectedSize = "medium";
    this.selectedMode = "open";
    this.selectedRace = "terran";
    this.selectedFleet = "medium";
    this.fleetRects = [];
    this.justStarted = null;
    // Roguelite controller state — wired by main.js via setRoguelite().
    // `runState` holds { meta, run, refresh }. `onRunChoice` dispatches
    // every overlay action back to main.js.
    this.runState = null;
    this.onRunChoice = null;
    // Overlay visibility flags. Only one of these is true at a time
    // (the click router enforces this; setting more than one would
    // result in double-handling).
    this.showRunSetup = false;
    this.showRunMap = false;
    this.showResupply = false;
    this.showEvent = false;
    this.showBattleChoice = false;
    // Cached layout rects for each overlay.
    this.runSetupRects = { panel: null, factionChips: [], beginBtn: null, cancelBtn: null };
    this.runMapRects = {
      panel: null, nodes: [], edges: [],
      fleetPanel: null, header: null,
      newRunBtn: null, abandonBtn: null, closeBtn: null,
    };
    this.resupplyRects = {
      panel: null, repairBtns: [], recruitFighterBtn: null, recruitBomberBtn: null,
      refuelBtn: null, boonBtns: [], closeBtn: null, continueBtn: null,
    };
    this.eventRects = { panel: null, choiceBtns: [], lastResult: null };
    this.battleChoiceRects = { panel: null, fly: null, command: null, back: null };
    // Pending node context for the overlays that need it.
    this._pendingResupplyNode = null;
    this._pendingEventNode = null;
    this._pendingBattleNode = null;
    // Random boons offered at the current resupply node, refreshed each
    // visit so the same node doesn't repaint the same three picks.
    this._resupplyBoonOffers = null;
    // Energy state ref + IAP callback wired by main.js.
    this.energy = null;
    this.onEnergyPurchase = null;
    this.showRefill = false;        // package overlay visibility
    this.refillRects = [];          // per-package click rects
    this.refillCloseRect = null;
    this.energyBarRect = null;      // clickable "refill" area in the header

    // Custom Match overlay state. Opened when the player selects the
    // Custom mode chip and clicks CONFIGURE (the START label flips in
    // that mode). Counts seed from the picked race's default roster;
    // changing the side's race chip re-seeds that side's counts so the
    // player has a sensible starting point.
    this.showCustom = false;
    this.customAlliedRace = "terran";
    this.customHostileRace = "terran";
    this.customBlueCounts = rosterForRace("terran");
    this.customRedCounts = rosterForRace("terran");
    this.customRects = {
      panel: null,
      allied: { race: [], counters: [], header: null, panel: null },
      hostile: { race: [], counters: [], header: null, panel: null },
      start: null,
      cancel: null,
    };
    // Active slider drag — populated when a pointer-down lands inside
    // a counter slider track, cleared on pointer-up. While set,
    // pointer-move updates the count from the pointer x. Refers to
    // the counts object directly (allied or hostile) and the rects
    // (so a relayout mid-drag stays correct).
    this._customDrag = null;

    // Settings overlay — wired to main.js via setSettings(). Reads
    // live state through a getter (so the overlay always reflects what
    // the live audio graph currently has) and writes via a patch
    // callback (so persistence happens through saveStore, not here).
    this.showSettings = false;
    this.settingsButtonRect = null;
    this.settingsRects = { panel: null, musicToggle: null, close: null };
    this._settingsGet = () => ({ musicMuted: false });
    this._settingsApply = () => {};
  }

  setSettings(getter, applyFn) {
    this._settingsGet = getter || this._settingsGet;
    this._settingsApply = applyFn || this._settingsApply;
  }

  setRoguelite(state, onRunChoice) {
    this.runState = state;
    this.onRunChoice = onRunChoice;
  }

  setEnergy(state, onPurchase) {
    this.energy = state;
    this.onEnergyPurchase = onPurchase;
  }

  layout(viewW, viewH) {
    this._lastViewW = viewW;
    this._lastViewH = viewH;
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

    // Fleet-size row (Small / Medium / Large / Huge).
    const fn = FLEET_OPTIONS.length;
    const fleetBtnW = Math.min(160, (viewW - 60) / fn - gapX);
    const fleetRowW = fn * fleetBtnW + (fn - 1) * gapX;
    const fleetY = raceY + chipH + rowGap;
    const fleetStartX = (viewW - fleetRowW) / 2;
    this.fleetRects = FLEET_OPTIONS.map((o, i) => ({
      key: o.key, label: o.label, mul: o.mul, tagline: o.tagline,
      x: fleetStartX + i * (fleetBtnW + gapX),
      y: fleetY, w: fleetBtnW, h: chipH,
    }));

    let nextY = fleetY + chipH + rowGap;
    // Frontier mode: show a one-line status under the chip row instead
    // of a tile grid. Run state is rendered inside the run-map overlay,
    // which is the actual interaction surface for this mode.
    if (this.selectedMode === "roguelite") {
      nextY += 36;
    }

    // START button.
    const startW = 260, startH = 56;
    this.startRect = {
      x: (viewW - startW) / 2,
      y: nextY,
      w: startW, h: startH,
    };

    // Top-bar chrome — paired pills sitting in the corners so they
    // never collide with the centered title block. Energy on the
    // left (it's the primary action driver — F2P funnel), Settings
    // on the right.
    const pillH = 38;
    this.energyBarRect = {
      x: 18,
      y: 18,
      w: 240, h: pillH,
    };
    const sgW = 110;
    this.settingsButtonRect = {
      x: viewW - sgW - 18,
      y: 18,
      w: sgW, h: pillH,
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
    // Settings overlay grabs all clicks while open.
    if (this.showSettings) {
      this._clickSettingsOverlay(x, y);
      return true;
    }
    // Settings gear button (top-right corner) opens the overlay.
    if (this.settingsButtonRect && this._hit(this.settingsButtonRect, x, y)) {
      this._layoutSettingsOverlay(this._lastViewW || 1200, this._lastViewH || 800);
      this.showSettings = true;
      return true;
    }
    // Custom Match overlay also grabs all clicks while open.
    if (this.showCustom) {
      const result = this._clickCustomOverlay(x, y);
      if (result === "start") {
        // Energy gate same as the main START path.
        if (this.energy && !canSpend(this.energy, COST_PER_GAME)) {
          this.showRefill = true;
          this.showCustom = false;
          return true;
        }
        this._emitStart();
        this.showCustom = false;
        return true;
      }
      return true; // overlay swallows everything else
    }
    // Roguelite overlays — each grabs all clicks while open. Order
    // matters: battle-choice / event / resupply sit ON TOP of the run
    // map, so check them first.
    if (this.showBattleChoice) { this._clickBattleChoice(x, y); return true; }
    if (this.showEvent)        { this._clickEvent(x, y);        return true; }
    if (this.showResupply)     { this._clickResupply(x, y);     return true; }
    if (this.showRunMap)       { this._clickRunMap(x, y);       return true; }
    if (this.showRunSetup)     { this._clickRunSetup(x, y);     return true; }
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
    for (const r of this.fleetRects) {
      if (this._hit(r, x, y)) { this.selectedFleet = r.key; return true; }
    }
    if (this.startRect && this._hit(this.startRect, x, y)) {
      // Custom mode: START opens the configuration overlay instead of
      // launching. The overlay's own START launches the match.
      if (this.selectedMode === "custom") {
        this._layoutCustomOverlay(this._lastViewW || 1200, this._lastViewH || 800);
        this.showCustom = true;
        return true;
      }
      // Frontier mode: START opens either the run-setup overlay (no
      // run in progress) or the run-map overlay (resume active run).
      // It never launches a match directly — battles only fire when
      // the player picks a node on the map.
      if (this.selectedMode === "roguelite") {
        const hasRun = this.runState && this.runState.run;
        if (hasRun) {
          this._layoutRunMap(this._lastViewW || 1200, this._lastViewH || 800);
          this.showRunMap = true;
        } else {
          this._layoutRunSetup(this._lastViewW || 1200, this._lastViewH || 800);
          this.showRunSetup = true;
        }
        return true;
      }
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
    const fleet = this.fleetRects.find((r) => r.key === this.selectedFleet)
               || this.fleetRects.find((r) => r.key === "medium")
               || { mul: 1 };
    this.justStarted = {
      mapW: size.mapW, mapH: size.mapH,
      race: this.selectedRace,
      mode: this.selectedMode,
      fleetMul: fleet.mul,
      customRoster: this.selectedMode === "custom" ? this.consumeCustomRoster() : null,
    };
  }

  consumeStart() {
    const s = this.justStarted;
    this.justStarted = null;
    return s;
  }

  draw(ctx, viewW, viewH) {
    ctx.save();
    // Full-screen dim with a subtle blue grade so the menu sits on a
    // softly tinted void rather than raw black-over-stars.
    ctx.fillStyle = "rgba(2,8,18,0.78)";
    ctx.fillRect(0, 0, viewW, viewH);

    // Energy + Settings corner pills — drawn before the title so the
    // title can layer over the top-bar baseline if needed.
    if (this.energyBarRect) this._drawEnergyHeader(ctx);

    // Title with accent rule. The thin underline gives the wordmark a
    // visual anchor without needing actual logo art.
    ctx.textAlign = "center";
    ctx.fillStyle = "#e6f4ff";
    ctx.font = "bold 38px system-ui, sans-serif";
    ctx.fillText("APHELION STAR FIGHTER", viewW / 2, viewH / 2 - 230);
    ctx.fillStyle = "#5af";
    ctx.fillRect(viewW / 2 - 200, viewH / 2 - 214, 400, 2);
    ctx.fillStyle = "#7bd";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText("FLEET COMBAT", viewW / 2, viewH / 2 - 198);

    this._drawSectionLabel(ctx, "MAP SIZE", this.sizeRects);
    for (const r of this.sizeRects) {
      this._drawChip(ctx, r, r.key === this.selectedSize,
        r.label, `${r.mapW} × ${r.mapH}`);
    }

    this._drawSectionLabel(ctx, "GAME MODE", this.modeRects);
    for (const r of this.modeRects) {
      this._drawChip(ctx, r, r.key === this.selectedMode,
        r.label, r.tagline);
    }

    this._drawSectionLabel(ctx, "ALLIED RACE", this.raceRects);
    for (const r of this.raceRects) {
      const race = RACES[r.key];
      this._drawChip(ctx, r, r.key === this.selectedRace,
        r.label, race.tagline || "");
    }

    if (this.fleetRects.length > 0) {
      this._drawSectionLabel(ctx, "FLEET SIZE", this.fleetRects);
      for (const r of this.fleetRects) {
        this._drawChip(ctx, r, r.key === this.selectedFleet,
          r.label, r.tagline);
      }
    }

    // Frontier panel: one-line status under the chip rows. Run state
    // is rendered inside the run-map overlay; the menu just shows
    // whether a run is in progress so the player knows what "START"
    // does next.
    if (this.selectedMode === "roguelite") {
      const meta = this.runState && this.runState.meta;
      const run = this.runState && this.runState.run;
      ctx.fillStyle = "#cef";
      ctx.font = "bold 14px system-ui, sans-serif";
      ctx.textAlign = "center";
      const statusY = this.startRect.y - 22;
      if (run) {
        const totalNodes = run.graphs.reduce((n, g) => n + g.nodes.length, 0);
        ctx.fillText(
          `ACTIVE RUN — ${RACES[run.faction].name.toUpperCase()} · ACT ${run.act}/${ACTS_PER_RUN} · ${run.visitedNodeIds.length}/${totalNodes} cleared`,
          viewW / 2, statusY,
        );
      } else if (meta) {
        ctx.fillStyle = "#9bd";
        ctx.font = "13px system-ui, sans-serif";
        ctx.fillText(
          `Runs cleared: ${meta.runsWon} / ${meta.runsCompleted}   ·   Perks: ${meta.unlockedPerks.length}/${Object.keys(PERKS).length}`,
          viewW / 2, statusY,
        );
      }
    }

    const s = this.startRect;
    const outOfEnergy = this.energy && !canSpend(this.energy, COST_PER_GAME);
    // Outer glow plate — radial gradient under the button so the CTA
    // visibly pops off the page without needing real shadow ops.
    const glowCol = outOfEnergy ? "rgba(220,80,80," : "rgba(120,220,160,";
    const g = ctx.createRadialGradient(
      s.x + s.w / 2, s.y + s.h / 2, 0,
      s.x + s.w / 2, s.y + s.h / 2, s.w * 0.7,
    );
    g.addColorStop(0, glowCol + "0.32)");
    g.addColorStop(1, glowCol + "0)");
    ctx.fillStyle = g;
    ctx.fillRect(s.x - 60, s.y - 28, s.w + 120, s.h + 56);

    if (outOfEnergy) {
      ctx.fillStyle = "rgba(70,30,30,0.95)";
      ctx.fillRect(s.x, s.y, s.w, s.h);
      ctx.strokeStyle = "#e88";
      ctx.lineWidth = 3;
      ctx.strokeRect(s.x, s.y, s.w, s.h);
      ctx.fillStyle = "#fdd";
      ctx.font = "bold 18px system-ui, sans-serif";
      ctx.fillText("OUT OF ENERGY", s.x + s.w / 2, s.y + s.h / 2 - 4);
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillStyle = "#fa8";
      ctx.fillText("Tap to refill", s.x + s.w / 2, s.y + s.h / 2 + 14);
    } else {
      // Vertical gradient body — top a touch lighter than bottom for a
      // subtle "lit from above" read.
      const bg = ctx.createLinearGradient(0, s.y, 0, s.y + s.h);
      bg.addColorStop(0, "rgba(80,170,110,0.95)");
      bg.addColorStop(1, "rgba(40,110,75,0.95)");
      ctx.fillStyle = bg;
      ctx.fillRect(s.x, s.y, s.w, s.h);
      ctx.strokeStyle = "#bff";
      ctx.lineWidth = 2.5;
      ctx.strokeRect(s.x, s.y, s.w, s.h);
      // Inner highlight rule along the top edge for that lit-from-above
      // sheen.
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(s.x + 2, s.y + 2, s.w - 4, 1);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 24px system-ui, sans-serif";
      let label = "START";
      if (this.selectedMode === "custom") {
        label = "CONFIGURE…";
      } else if (this.selectedMode === "roguelite") {
        label = (this.runState && this.runState.run) ? "RESUME RUN" : "NEW RUN";
      }
      ctx.fillText(label, s.x + s.w / 2, s.y + s.h / 2 + 9);
    }

    // Settings gear button — drawn alongside the rest of the menu
    // chrome so it sits below modal overlays.
    if (this.settingsButtonRect) this._drawSettingsButton(ctx);

    // Refill overlay renders last so it sits on top of everything.
    if (this.showRefill)       this._drawRefillOverlay(ctx, viewW, viewH);
    if (this.showCustom)       this._drawCustomOverlay(ctx, viewW, viewH);
    if (this.showSettings)     this._drawSettingsOverlay(ctx, viewW, viewH);
    // Roguelite stack — run map below, sub-overlays above.
    if (this.showRunMap)       this._drawRunMap(ctx, viewW, viewH);
    if (this.showRunSetup)     this._drawRunSetup(ctx, viewW, viewH);
    if (this.showResupply)     this._drawResupply(ctx, viewW, viewH);
    if (this.showEvent)        this._drawEvent(ctx, viewW, viewH);
    if (this.showBattleChoice) this._drawBattleChoice(ctx, viewW, viewH);

    ctx.textAlign = "left";
    ctx.restore();
  }

  // Section header — small caps centered above its row of chips, with
  // a faint horizontal rule on either side for visual structure. Pure
  // chrome; no hit-test.
  _drawSectionLabel(ctx, label, rects) {
    if (!rects || rects.length === 0) return;
    const cx = (rects[0].x + rects[rects.length - 1].x + rects[rects.length - 1].w) / 2;
    const y = rects[0].y - 16;
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#5ab";
    ctx.fillText(label, cx, y);
    // Side rules: thin lines flanking the label.
    ctx.fillStyle = "rgba(90,180,200,0.35)";
    const labelW = ctx.measureText(label).width;
    const ruleW = 80, gap = 14;
    ctx.fillRect(cx - labelW / 2 - gap - ruleW, y - 4, ruleW, 1);
    ctx.fillRect(cx + labelW / 2 + gap, y - 4, ruleW, 1);
  }

  _drawEnergyHeader(ctx) {
    const r = this.energyBarRect;
    const e = this.energy;
    const cur = e ? e.current : MAX_ENERGY;
    const full = cur >= MAX_ENERGY;
    const empty = cur <= 0;

    ctx.fillStyle = empty ? "rgba(60,24,30,0.92)" : "rgba(14,28,42,0.92)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = empty ? "#e87" : (full ? "#9ec" : "#5ad");
    ctx.lineWidth = 1.5;
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    // Left: ENERGY label.
    ctx.textAlign = "left";
    ctx.fillStyle = empty ? "#fb8" : "#fd9";
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.fillText("ENERGY", r.x + 12, r.y + 17);
    // Count below label.
    ctx.fillStyle = "#fff";
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.fillText(`${cur}/${MAX_ENERGY}`, r.x + 12, r.y + 32);

    // Center: regen countdown.
    if (!full && e) {
      ctx.fillStyle = "#9bd";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      const next = timeUntilNext(e);
      ctx.fillText(formatDuration(next), r.x + r.w / 2, r.y + 17);
      ctx.fillText("until +1", r.x + r.w / 2, r.y + 30);
    }

    // Right: refill chip.
    ctx.textAlign = "right";
    ctx.fillStyle = "#fd9";
    ctx.font = "bold 12px system-ui, sans-serif";
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

  // ---- Settings overlay ------------------------------------------------
  _layoutSettingsOverlay(viewW, viewH) {
    const panelW = 380, panelH = 220;
    const panelX = (viewW - panelW) / 2;
    const panelY = (viewH - panelH) / 2;
    this.settingsRects.panel = { x: panelX, y: panelY, w: panelW, h: panelH };
    // Music row: full-width toggle pill below the title.
    this.settingsRects.musicToggle = {
      x: panelX + 24, y: panelY + 70,
      w: panelW - 48, h: 56,
    };
    // Close button bottom-centred.
    this.settingsRects.close = {
      x: panelX + (panelW - 140) / 2, y: panelY + panelH - 60,
      w: 140, h: 44,
    };
  }

  _drawSettingsOverlay(ctx, viewW, viewH) {
    ctx.fillStyle = "rgba(0,0,0,0.85)";
    ctx.fillRect(0, 0, viewW, viewH);

    const p = this.settingsRects.panel;
    ctx.fillStyle = "rgba(10,18,28,0.96)";
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.strokeStyle = "#5af";
    ctx.lineWidth = 2;
    ctx.strokeRect(p.x, p.y, p.w, p.h);

    ctx.textAlign = "center";
    ctx.fillStyle = "#cef";
    ctx.font = "bold 22px system-ui, sans-serif";
    ctx.fillText("SETTINGS", viewW / 2, p.y + 36);

    const state = this._settingsGet();
    const t = this.settingsRects.musicToggle;
    const on = !state.musicMuted;
    ctx.fillStyle = on ? "rgba(40,90,140,0.95)" : "rgba(60,30,30,0.85)";
    ctx.fillRect(t.x, t.y, t.w, t.h);
    ctx.strokeStyle = on ? "#7df" : "#c66";
    ctx.lineWidth = 2;
    ctx.strokeRect(t.x, t.y, t.w, t.h);
    ctx.fillStyle = "#cef";
    ctx.textAlign = "left";
    ctx.font = "bold 17px system-ui, sans-serif";
    ctx.fillText("MUSIC", t.x + 18, t.y + t.h / 2 + 6);
    ctx.textAlign = "right";
    ctx.fillStyle = on ? "#9f8" : "#fcc";
    ctx.font = "bold 20px system-ui, sans-serif";
    ctx.fillText(on ? "ON" : "OFF", t.x + t.w - 18, t.y + t.h / 2 + 7);

    // Hint below the toggle: tells the player about the P shortcut so
    // they can mute mid-match without coming back here.
    ctx.textAlign = "center";
    ctx.fillStyle = "#9bd";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText("Tap to toggle  ·  P also mutes during a match", viewW / 2, t.y + t.h + 22);

    const c = this.settingsRects.close;
    ctx.fillStyle = "rgba(40,80,60,0.9)";
    ctx.fillRect(c.x, c.y, c.w, c.h);
    ctx.strokeStyle = "#9f8";
    ctx.lineWidth = 2;
    ctx.strokeRect(c.x, c.y, c.w, c.h);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 16px system-ui, sans-serif";
    ctx.fillText("CLOSE", c.x + c.w / 2, c.y + c.h / 2 + 6);
  }

  _drawSettingsButton(ctx) {
    const r = this.settingsButtonRect;
    const muted = this._settingsGet().musicMuted;
    ctx.fillStyle = "rgba(20,40,60,0.85)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = muted ? "#fa8" : "#7df";
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.textAlign = "center";
    ctx.fillStyle = muted ? "#fda" : "#cef";
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.fillText("SETTINGS", r.x + r.w / 2, r.y + r.h / 2 + 5);
    if (muted) {
      // Small dot in the top-right of the button signals "music off".
      ctx.fillStyle = "#fa8";
      ctx.beginPath(); ctx.arc(r.x + r.w - 8, r.y + 8, 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  _clickSettingsOverlay(x, y) {
    if (!this.showSettings) return false;
    if (this._hit(this.settingsRects.close, x, y)) { this.showSettings = false; return true; }
    if (this._hit(this.settingsRects.musicToggle, x, y)) {
      const cur = this._settingsGet();
      this._settingsApply({ musicMuted: !cur.musicMuted });
      return true;
    }
    // Click-through prevention: anywhere inside / outside the panel
    // while the overlay is open should be swallowed.
    return true;
  }

  // ---- Custom Match overlay --------------------------------------------
  // Returns a snapshot of the configured custom roster for startGame.
  // Shape matches what `modes/custom.js` expects.
  consumeCustomRoster() {
    return {
      alliedRace: this.customAlliedRace,
      hostileRace: this.customHostileRace,
      blue: { ...this.customBlueCounts },
      red: { ...this.customRedCounts },
    };
  }

  // Compute click + draw rects for the overlay. Called every time the
  // overlay opens so it survives viewport resizes between matches.
  _layoutCustomOverlay(viewW, viewH) {
    // Two side-by-side panels, each ~460px wide; comfortable on a
    // typical desktop viewport (>=1000px) and graceful on phones —
    // the overlay shrinks each panel proportionally when the viewport
    // is too narrow to host the ideal width.
    const padX = 24, padY = 24;
    const headerH = 44;
    const raceRowH = 34;
    const dividerH = 12;
    const classRowH = 38;
    const classGap = 6;
    const classesH = CUSTOM_CLASSES.length * classRowH + classGap * (CUSTOM_CLASSES.length - 1);
    const sideFooterH = 26;
    const panelInnerH = headerH + raceRowH + dividerH + classesH + sideFooterH;
    const panelH = panelInnerH + padY * 2;

    // Title strip (top) + the two panels + footer buttons.
    const titleH = 56;
    const footerStrip = 92;          // CANCEL/START buttons + totals line
    const overlayInnerH = titleH + panelH + footerStrip;
    const overlayH = overlayInnerH + padY * 2;

    // Panel sizing: ideal 460/side; fall back to (viewW - 2*pad - gap) / 2
    // when the viewport is narrow. Minimum 280 — below that we'd be
    // strangling sliders to <140px which is unusable on touch.
    const panelGap = 24;
    const idealPanelW = 460;
    const availW = viewW - padX * 4;
    const fitTwo = (availW - panelGap) / 2;
    const panelW = Math.max(280, Math.min(idealPanelW, fitTwo));
    const totalW = panelW * 2 + panelGap;
    const overlayW = totalW + padX * 2;

    const overlayX = (viewW - overlayW) / 2;
    const overlayY = Math.max(20, (viewH - overlayH) / 2);
    this.customRects.panel = { x: overlayX, y: overlayY, w: overlayW, h: overlayH };

    const panelTop = overlayY + padY + titleH;
    const panelLeftX = overlayX + padX;
    const panelRightX = panelLeftX + panelW + panelGap;

    this.customRects.allied.panel = { x: panelLeftX, y: panelTop, w: panelW, h: panelH };
    this.customRects.hostile.panel = { x: panelRightX, y: panelTop, w: panelW, h: panelH };

    this.customRects.allied.header = { x: panelLeftX, y: panelTop, w: panelW, h: headerH };
    this.customRects.hostile.header = { x: panelRightX, y: panelTop, w: panelW, h: headerH };

    // Race chips: 1×4 row across each side panel — one tap to swap a
    // race instead of having to scan a 2×2 grid. Tagline below name.
    const innerPadX = 16;
    const raceY = panelTop + headerH + padY;
    const raceKeys = RACE_KEYS;
    const raceGap = 6;
    const raceInnerW = panelW - innerPadX * 2 - raceGap * (raceKeys.length - 1);
    const raceChipW = raceInnerW / raceKeys.length;
    const buildRaceRects = (px) => raceKeys.map((key, i) => ({
      key,
      x: px + innerPadX + i * (raceChipW + raceGap),
      y: raceY,
      w: raceChipW, h: raceRowH,
    }));
    this.customRects.allied.race = buildRaceRects(panelLeftX);
    this.customRects.hostile.race = buildRaceRects(panelRightX);

    // Per-class slider rows. Each row: [icon] Name | track | count.
    // The track hit zone spans the row's full height so the slider
    // is easy to grab on a phone.
    const rowsTop = raceY + raceRowH + dividerH + padY / 2;
    const iconW = 30;
    const nameW = Math.round(panelW * 0.22);
    const countW = 56;
    const buildClassRects = (px) => {
      const rows = [];
      for (let i = 0; i < CUSTOM_CLASSES.length; i++) {
        const klass = CUSTOM_CLASSES[i];
        const y = rowsTop + i * (classRowH + classGap);
        const rowLeft = px + innerPadX;
        const rowRight = px + panelW - innerPadX;
        const iconX = rowLeft;
        const nameX = iconX + iconW + 6;
        const countX = rowRight - countW;
        const trackX = nameX + nameW + 12;
        const trackW = countX - trackX - 12;
        const trackVisY = y + Math.round((classRowH - 8) / 2);
        rows.push({
          klass,
          row:   { x: rowLeft, y, w: rowRight - rowLeft, h: classRowH },
          icon:  { x: iconX,   y, w: iconW,             h: classRowH },
          name:  { x: nameX,   y, w: nameW,             h: classRowH },
          track: { x: trackX,  y: trackVisY, w: trackW, h: 8,
                   // hitX/hitY/hitW/hitH gives a touch-friendly
                   // taller hit area than the 8px visible track.
                   hitX: trackX - 4, hitY: y, hitW: trackW + 8, hitH: classRowH },
          count: { x: countX,  y, w: countW,            h: classRowH },
        });
      }
      return rows;
    };
    this.customRects.allied.counters = buildClassRects(panelLeftX);
    this.customRects.hostile.counters = buildClassRects(panelRightX);

    // Footer (CANCEL / START) plus the total readout line above them.
    const btnW = 160, btnH = 52;
    const btnY = overlayY + overlayH - padY - btnH;
    this.customRects.cancel = { x: viewW / 2 - btnW - 16, y: btnY, w: btnW, h: btnH };
    this.customRects.start  = { x: viewW / 2 + 16,        y: btnY, w: btnW, h: btnH };
    this._customTotalsY = btnY - 16;
  }

  _drawCustomOverlay(ctx, viewW, viewH) {
    // Full-screen scrim — keeps the background visible but desaturated
    // so the overlay reads as a focused modal.
    ctx.fillStyle = "rgba(2,8,18,0.86)";
    ctx.fillRect(0, 0, viewW, viewH);

    const p = this.customRects.panel;
    // Outer overlay card: same chrome family as the rest of the HUD
    // (rgba(8,16,28,0.85) + #5af border) so the overlay feels native
    // to the game's UI rather than a separate dialog system.
    ctx.fillStyle = "rgba(8,16,28,0.92)";
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.strokeStyle = "#5af";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p.x, p.y, p.w, p.h);
    // Top accent rule — same trick as the side strip / target panel.
    ctx.fillStyle = "#5af";
    ctx.fillRect(p.x, p.y, p.w, 3);

    // Title block: large wordmark + thin accent + subtitle.
    ctx.textAlign = "center";
    ctx.fillStyle = "#e6f4ff";
    ctx.font = "bold 26px system-ui, sans-serif";
    ctx.fillText("CUSTOM MATCH", viewW / 2, p.y + 38);
    ctx.fillStyle = "#7bd";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText("PICK RACE · DRAG SLIDERS TO SET FLEET", viewW / 2, p.y + 58);

    this._drawCustomSide(ctx, "ALLIED", "blue", this.customRects.allied,
      this.customAlliedRace, this.customBlueCounts);
    this._drawCustomSide(ctx, "HOSTILE", "red", this.customRects.hostile,
      this.customHostileRace, this.customRedCounts);

    // Combined totals line — sits above the action buttons so it can't
    // be missed when you're about to start a match that would melt the
    // device. Color graded: blue under 200, soft amber 200–400, hot
    // orange past 400 (rough "this will chug" threshold).
    const blueTotal = totalShipCount(this.customBlueCounts);
    const redTotal = totalShipCount(this.customRedCounts);
    const totalAll = blueTotal + redTotal;
    let totalsColor = "#9bd";
    if (totalAll > 400) totalsColor = "#f97";
    else if (totalAll > 200) totalsColor = "#fc8";
    ctx.fillStyle = totalsColor;
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillText(
      `Total fleet · Allied ${blueTotal}  ·  Hostile ${redTotal}  ·  ${totalAll} ships`,
      viewW / 2, this._customTotalsY,
    );

    // Footer buttons — match the rest of the menu's button language so
    // CANCEL/START aren't visually different from the main START on the
    // previous screen.
    const cancel = this.customRects.cancel;
    ctx.fillStyle = "rgba(60,30,30,0.92)";
    ctx.fillRect(cancel.x, cancel.y, cancel.w, cancel.h);
    ctx.strokeStyle = "#e88";
    ctx.lineWidth = 2;
    ctx.strokeRect(cancel.x, cancel.y, cancel.w, cancel.h);
    ctx.fillStyle = "#fdd";
    ctx.font = "bold 18px system-ui, sans-serif";
    ctx.fillText("CANCEL", cancel.x + cancel.w / 2, cancel.y + cancel.h / 2 + 6);

    const start = this.customRects.start;
    const startBg = ctx.createLinearGradient(0, start.y, 0, start.y + start.h);
    startBg.addColorStop(0, "rgba(80,170,110,0.95)");
    startBg.addColorStop(1, "rgba(40,110,75,0.95)");
    ctx.fillStyle = startBg;
    ctx.fillRect(start.x, start.y, start.w, start.h);
    ctx.strokeStyle = "#bff";
    ctx.lineWidth = 2;
    ctx.strokeRect(start.x, start.y, start.w, start.h);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(start.x + 2, start.y + 2, start.w - 4, 1);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 22px system-ui, sans-serif";
    ctx.fillText("START", start.x + start.w / 2, start.y + start.h / 2 + 8);
    ctx.textAlign = "left";
  }

  _drawCustomSide(ctx, title, side, sideRects, raceKey, counts) {
    const panel = sideRects.panel;
    const accent = SIDES[side].primary;
    // Inner panel chrome — slightly lifted off the overlay backdrop so
    // each side reads as a discrete sub-card.
    ctx.fillStyle = "rgba(14,24,38,0.85)";
    ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
    ctx.strokeStyle = "rgba(120,180,220,0.25)";
    ctx.lineWidth = 1;
    ctx.strokeRect(panel.x, panel.y, panel.w, panel.h);
    // Side-tinted accent rule on the outward edge (left=ALLIED on left
    // edge; right=HOSTILE on right edge) — visually mirrors the HUD
    // side strips at the top of the screen.
    const isLeft = title === "ALLIED";
    ctx.fillStyle = accent;
    if (isLeft) ctx.fillRect(panel.x, panel.y, 3, panel.h);
    else ctx.fillRect(panel.x + panel.w - 3, panel.y, 3, panel.h);

    // Header strip: ALLIED / HOSTILE label + currently selected race
    // name on the same line. Big, easy to scan.
    const header = sideRects.header;
    ctx.textAlign = "left";
    ctx.fillStyle = accent;
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.fillText(title, header.x + 16, header.y + 22);
    ctx.fillStyle = "#cdf";
    ctx.font = "bold 17px system-ui, sans-serif";
    ctx.fillText((RACES[raceKey] && RACES[raceKey].name) || "—",
      header.x + 16, header.y + 38);
    // Tagline on the right of the header.
    const tagline = (RACES[raceKey] && RACES[raceKey].tagline) || "";
    if (tagline) {
      ctx.fillStyle = "#7bd";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(tagline, header.x + header.w - 16, header.y + 38);
    }

    // Header divider rule.
    ctx.fillStyle = "rgba(120,180,220,0.18)";
    ctx.fillRect(panel.x + 12, header.y + header.h, panel.w - 24, 1);

    // Race chips: 1×4 horizontal row.
    for (const r of sideRects.race) {
      this._drawRaceMiniChip(ctx, r, r.key === raceKey, RACES[r.key].name);
    }

    // Divider rule between race chips and class sliders.
    const firstRow = sideRects.counters[0];
    ctx.fillStyle = "rgba(120,180,220,0.18)";
    ctx.fillRect(panel.x + 12, firstRow.row.y - 8, panel.w - 24, 1);

    // Class slider rows.
    for (let i = 0; i < sideRects.counters.length; i++) {
      const row = sideRects.counters[i];
      const klass = CUSTOM_CLASSES[i];
      const count = counts[klass] || 0;
      this._drawClassSliderRow(ctx, row, klass, count, accent);
    }

    // Per-side total in the bottom strip.
    const subtotal = totalShipCount(counts);
    ctx.textAlign = "right";
    ctx.fillStyle = "#9bd";
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.fillText(`${subtotal} SHIPS`,
      panel.x + panel.w - 16, panel.y + panel.h - 10);
    ctx.textAlign = "left";
  }

  // Compact race chip used inside the custom-match overlay's 1×4 row.
  // The main menu's _drawChip is taller (label + sublabel + glow);
  // here we just need a single-line selector with bold selected state.
  _drawRaceMiniChip(ctx, r, selected, label) {
    ctx.fillStyle = selected ? "rgba(70,130,170,0.85)" : "rgba(20,32,48,0.85)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = selected ? "#7df" : "rgba(120,160,200,0.45)";
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = selected ? "#fff" : "#9bd";
    ctx.font = selected
      ? "bold 12px system-ui, sans-serif"
      : "12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 4);
    ctx.textAlign = "left";
  }

  // Single class slider row: [icon] Name | track-with-thumb | count.
  // Active drag receives a brighter thumb so the touch feels alive.
  _drawClassSliderRow(ctx, row, klass, count, accent) {
    const isDragging = this._customDrag
      && this._customDrag.klass === klass
      && this._customDrag.row === row;

    // Class glyph badge on the left.
    const ic = row.icon;
    ctx.fillStyle = "rgba(20,32,48,0.85)";
    ctx.fillRect(ic.x, ic.y + (ic.h - ic.w) / 2, ic.w, ic.w);
    ctx.strokeStyle = "rgba(120,180,220,0.4)";
    ctx.lineWidth = 1;
    ctx.strokeRect(ic.x, ic.y + (ic.h - ic.w) / 2, ic.w, ic.w);
    ctx.fillStyle = "#cdf";
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(CLASS_GLYPHS[klass] || "?",
      ic.x + ic.w / 2, ic.y + ic.h / 2 + 4);

    // Class name.
    ctx.textAlign = "left";
    ctx.fillStyle = count > 0 ? "#e6f4ff" : "#8aa";
    ctx.font = count > 0
      ? "bold 13px system-ui, sans-serif"
      : "13px system-ui, sans-serif";
    ctx.fillText(classDisplayName(klass), row.name.x, row.name.y + row.name.h / 2 + 4);

    // Slider track.
    const t = row.track;
    const frac = Math.max(0, Math.min(1, count / CUSTOM_MAX_PER_CLASS));
    // Track background.
    ctx.fillStyle = "rgba(10,18,28,0.95)";
    ctx.fillRect(t.x, t.y, t.w, t.h);
    ctx.strokeStyle = "rgba(120,180,220,0.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(t.x, t.y, t.w, t.h);
    // Filled portion.
    const fillW = Math.round(t.w * frac);
    if (fillW > 0) {
      const grad = ctx.createLinearGradient(t.x, 0, t.x + t.w, 0);
      grad.addColorStop(0, accent);
      grad.addColorStop(1, count > 40 ? "#fc8" : accent);
      ctx.fillStyle = grad;
      ctx.fillRect(t.x + 1, t.y + 1, Math.max(0, fillW - 2), t.h - 2);
    }
    // Tick marks at 10/20/30/40/50 so the player has a coarse mental
    // scale when dragging.
    ctx.fillStyle = "rgba(120,180,220,0.25)";
    for (let v = 10; v < CUSTOM_MAX_PER_CLASS; v += 10) {
      const tx = t.x + Math.round((v / CUSTOM_MAX_PER_CLASS) * t.w);
      ctx.fillRect(tx, t.y + 1, 1, t.h - 2);
    }
    // Thumb.
    const thumbX = t.x + Math.round(t.w * frac);
    const thumbY = t.y + t.h / 2;
    const thumbR = isDragging ? 9 : 7;
    ctx.beginPath();
    ctx.arc(thumbX, thumbY, thumbR + 1, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(thumbX, thumbY, thumbR, 0, Math.PI * 2);
    ctx.fillStyle = count > 0 ? "#fff" : "#bcd";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(thumbX, thumbY, thumbR - 3, 0, Math.PI * 2);
    ctx.fillStyle = count > 40 ? "#fc8" : accent;
    ctx.fill();

    // Count badge on the right.
    const c = row.count;
    ctx.textAlign = "right";
    ctx.fillStyle = count > 0 ? "#fff" : "#566";
    ctx.font = "bold 18px system-ui, sans-serif";
    ctx.fillText(String(count), c.x + c.w, c.y + c.h / 2 + 6);
    ctx.fillStyle = "#7bd";
    ctx.font = "9px system-ui, sans-serif";
    ctx.fillText(`/ ${CUSTOM_MAX_PER_CLASS}`, c.x + c.w, c.y + c.h / 2 + 18);
    ctx.textAlign = "left";
  }

  // Returns true if the overlay handled the click, false otherwise.
  _clickCustomOverlay(x, y) {
    if (!this.showCustom) return false;
    if (this._hit(this.customRects.cancel, x, y)) {
      this.showCustom = false;
      this._customDrag = null;
      return true;
    }
    if (this._hit(this.customRects.start, x, y)) {
      this._customDrag = null;
      // Pass through to _emitStart via the main click path; the caller
      // (this.click below) handles the energy check + start emission.
      return "start";
    }
    // Race chip clicks: re-seed that side's counts from the new race's
    // default roster so the player has a meaningful starting point.
    for (const r of this.customRects.allied.race) {
      if (this._hit(r, x, y) && this.customAlliedRace !== r.key) {
        this.customAlliedRace = r.key;
        this.customBlueCounts = rosterForRace(r.key);
        return true;
      }
    }
    for (const r of this.customRects.hostile.race) {
      if (this._hit(r, x, y) && this.customHostileRace !== r.key) {
        this.customHostileRace = r.key;
        this.customRedCounts = rosterForRace(r.key);
        return true;
      }
    }
    // Slider tracks. Hit zone is the row-tall band around the visible
    // 8px track, so a tap doesn't need pixel precision on a phone. A
    // tap snaps the count to the pointer x; the same tap also opens a
    // drag so a subsequent move keeps adjusting until pointer-up.
    if (this._tryStartSliderDrag(this.customRects.allied.counters, this.customBlueCounts, "allied", x, y)) return true;
    if (this._tryStartSliderDrag(this.customRects.hostile.counters, this.customRedCounts, "hostile", x, y)) return true;
    // Click on the panel chrome itself: swallow so the underlying menu
    // doesn't catch it. Click outside the panel: also swallow — closing
    // by mis-click would be frustrating.
    return true;
  }

  _tryStartSliderDrag(rows, counts, side, x, y) {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const t = row.track;
      if (x >= t.hitX && x <= t.hitX + t.hitW
          && y >= t.hitY && y <= t.hitY + t.hitH) {
        const klass = CUSTOM_CLASSES[i];
        this._customDrag = { side, klass, row, counts };
        this._applySliderValue(counts, klass, row, x);
        return true;
      }
    }
    return false;
  }

  _applySliderValue(counts, klass, row, pointerX) {
    const t = row.track;
    const frac = Math.max(0, Math.min(1, (pointerX - t.x) / t.w));
    counts[klass] = Math.round(frac * CUSTOM_MAX_PER_CLASS);
  }

  // Called from InputManager.onMove while a slider drag is active.
  // Returns true if the move was consumed (i.e., we are dragging) so
  // the caller can short-circuit any default move behavior.
  pointerMove(x, y) {
    void y;  // sliders are 1D; vertical motion is ignored
    if (!this._customDrag) return false;
    const d = this._customDrag;
    this._applySliderValue(d.counts, d.klass, d.row, x);
    return true;
  }

  // Called from InputManager.onUp. Ends the active slider drag.
  pointerUp() {
    if (this._customDrag) {
      this._customDrag = null;
      return true;
    }
    return false;
  }

  _drawChip(ctx, r, selected, label, sublabel) {
    if (selected) {
      // Gradient fill so a picked chip reads as elevated, plus a soft
      // exterior glow rim.
      const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
      g.addColorStop(0, "rgba(60,130,190,0.95)");
      g.addColorStop(1, "rgba(30,75,120,0.95)");
      ctx.fillStyle = g;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      // Glow plate behind the chip.
      ctx.fillStyle = "rgba(120,180,230,0.10)";
      ctx.fillRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8);
      // Inner top highlight.
      ctx.fillStyle = "rgba(255,255,255,0.20)";
      ctx.fillRect(r.x + 2, r.y + 2, r.w - 4, 1);
      ctx.strokeStyle = "#bff";
      ctx.lineWidth = 2;
    } else {
      ctx.fillStyle = "rgba(14,26,40,0.92)";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = "rgba(120,180,220,0.55)";
      ctx.lineWidth = 1;
    }
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = selected ? "#fff" : "#cef";
    ctx.font = "bold 17px system-ui, sans-serif";
    ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 - 2);
    if (sublabel) {
      ctx.font = "11px system-ui, sans-serif";
      ctx.fillStyle = selected ? "rgba(220,240,255,0.85)" : "#7bd";
      ctx.fillText(sublabel, r.x + r.w / 2, r.y + r.h / 2 + 15);
    }
  }

  // =====================================================================
  // ROGUELITE OVERLAYS — Run setup, Run map, Resupply, Event, Battle choice.
  //
  // All overlays follow the same chrome pattern as the Custom Match
  // overlay (`_layoutCustomOverlay` / `_drawCustomOverlay`):
  //   - Full-screen scrim `rgba(2, 8, 18, 0.65)`.
  //   - Centered panel with a 2px stroke + accent rule along the top.
  //   - CANCEL / CLOSE pill on the bottom-left, primary CTA on bottom-right.
  // Each `_click*` method swallows every click that lands on the panel —
  // overlays are modal.
  // =====================================================================

  // ---- Run setup (NEW RUN) -------------------------------------------
  _layoutRunSetup(viewW, viewH) {
    const panelW = Math.min(720, viewW - 80);
    const panelH = 380;
    const panelX = (viewW - panelW) / 2;
    const panelY = (viewH - panelH) / 2;
    this.runSetupRects.panel = { x: panelX, y: panelY, w: panelW, h: panelH };

    // Faction chips — 4 across (extensible: layout adapts to count).
    const unlocked = (this.runState && this.runState.meta && this.runState.meta.unlockedFactions) || RACE_KEYS;
    const n = unlocked.length;
    const chipW = Math.min(150, (panelW - 80) / n - 12);
    const chipH = 80;
    const chipsTotalW = n * chipW + (n - 1) * 12;
    const chipsStartX = panelX + (panelW - chipsTotalW) / 2;
    const chipsY = panelY + 130;
    this.runSetupRects.factionChips = unlocked.map((k, i) => ({
      key: k, label: RACES[k] ? RACES[k].name : k,
      x: chipsStartX + i * (chipW + 12),
      y: chipsY, w: chipW, h: chipH,
    }));

    // Buttons.
    const btnH = 44, btnW = 140;
    this.runSetupRects.beginBtn = {
      x: panelX + panelW - btnW - 24,
      y: panelY + panelH - btnH - 20,
      w: btnW, h: btnH,
    };
    this.runSetupRects.cancelBtn = {
      x: panelX + 24,
      y: panelY + panelH - btnH - 20,
      w: 110, h: btnH,
    };
    // Default selection is the menu's currently-picked race.
    this._runSetupFaction = this.selectedRace;
  }

  _drawRunSetup(ctx, viewW, viewH) {
    // Scrim.
    ctx.fillStyle = "rgba(2,8,18,0.78)";
    ctx.fillRect(0, 0, viewW, viewH);

    const p = this.runSetupRects.panel;
    ctx.fillStyle = "rgba(8,16,28,0.95)";
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.strokeStyle = "#5af";
    ctx.lineWidth = 2;
    ctx.strokeRect(p.x, p.y, p.w, p.h);
    // Accent rule.
    ctx.fillStyle = "#5af";
    ctx.fillRect(p.x, p.y, p.w, 3);

    ctx.textAlign = "center";
    ctx.fillStyle = "#cef";
    ctx.font = "bold 26px system-ui, sans-serif";
    ctx.fillText("BEGIN FRONTIER RUN", p.x + p.w / 2, p.y + 44);
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillStyle = "#9bd";
    ctx.fillText("PICK YOUR FACTION · STARTER FLEET FIXED · 3 ACTS",
                 p.x + p.w / 2, p.y + 70);

    // Faction chips.
    for (const r of this.runSetupRects.factionChips) {
      const selected = r.key === this._runSetupFaction;
      const accent = RACES[r.key] ? RACES[r.key].accent : "#7df";
      ctx.fillStyle = selected ? "rgba(40,80,120,0.95)" : "rgba(24,36,56,0.85)";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = selected ? accent : "#456";
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      // Accent dot.
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(r.x + r.w / 2, r.y + 18, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#cef";
      ctx.font = "bold 14px system-ui, sans-serif";
      ctx.fillText(r.label, r.x + r.w / 2, r.y + 42);
      ctx.font = "10px system-ui, sans-serif";
      ctx.fillStyle = "#9bd";
      const tag = (RACES[r.key] && RACES[r.key].tagline) || "";
      ctx.fillText(tag.slice(0, 22), r.x + r.w / 2, r.y + 58);
      // War progress notch.
      const wp = (this.runState && this.runState.meta && this.runState.meta.warProgress[r.key]) || 0;
      if (wp > 0) {
        ctx.fillStyle = "#fc8";
        ctx.font = "10px system-ui, sans-serif";
        ctx.fillText(`× ${wp}`, r.x + r.w / 2, r.y + r.h - 8);
      }
    }

    // BEGIN button.
    const b = this.runSetupRects.beginBtn;
    const beginBg = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
    beginBg.addColorStop(0, "rgba(80,170,110,0.95)");
    beginBg.addColorStop(1, "rgba(40,110,75,0.95)");
    ctx.fillStyle = beginBg;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = "#bff";
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 16px system-ui, sans-serif";
    ctx.fillText("BEGIN", b.x + b.w / 2, b.y + b.h / 2 + 6);

    // CANCEL button.
    const c = this.runSetupRects.cancelBtn;
    ctx.fillStyle = "rgba(60,40,40,0.85)";
    ctx.fillRect(c.x, c.y, c.w, c.h);
    ctx.strokeStyle = "#a66";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(c.x, c.y, c.w, c.h);
    ctx.fillStyle = "#fbb";
    ctx.fillText("CANCEL", c.x + c.w / 2, c.y + c.h / 2 + 6);
    ctx.textAlign = "left";
  }

  _clickRunSetup(x, y) {
    if (this._hit(this.runSetupRects.cancelBtn, x, y)) {
      this.showRunSetup = false; return;
    }
    if (this._hit(this.runSetupRects.beginBtn, x, y)) {
      if (this.onRunChoice) {
        this.onRunChoice("new-run", { faction: this._runSetupFaction });
      }
      this.showRunSetup = false;
      // Auto-open the run map so the player lands in their first act.
      this._layoutRunMap(this._lastViewW || 1200, this._lastViewH || 800);
      this.showRunMap = true;
      return;
    }
    for (const r of this.runSetupRects.factionChips) {
      if (this._hit(r, x, y)) { this._runSetupFaction = r.key; return; }
    }
  }

  // ---- Run map -------------------------------------------------------
  _layoutRunMap(viewW, viewH) {
    const panelW = Math.min(1100, viewW - 60);
    const panelH = Math.min(720, viewH - 80);
    const panelX = (viewW - panelW) / 2;
    const panelY = (viewH - panelH) / 2;
    this.runMapRects.panel = { x: panelX, y: panelY, w: panelW, h: panelH };

    // Fleet panel on the right.
    const fleetW = 280;
    this.runMapRects.fleetPanel = {
      x: panelX + panelW - fleetW - 16,
      y: panelY + 80,
      w: fleetW, h: panelH - 160,
    };

    // Map region on the left.
    const mapX = panelX + 24;
    const mapY = panelY + 90;
    const mapW = panelW - fleetW - 56;
    const mapH = panelH - 170;
    const run = this.runState && this.runState.run;
    this.runMapRects.nodes = [];
    this.runMapRects.edges = [];
    if (run) {
      const graph = run.graphs[run.act - 1];
      if (graph) {
        const colSpacing = mapW / Math.max(1, COLS_PER_ACT - 1);
        const rowSpacing = mapH / (ROWS_PER_ACT + 1);
        for (const n of graph.nodes) {
          const nx = mapX + n.col * colSpacing;
          const ny = mapY + (n.row + 1) * rowSpacing;
          this.runMapRects.nodes.push({
            id: n.id, type: n.type, faction: n.faction,
            x: nx, y: ny, r: 22,
          });
        }
        // Edge rendering uses node positions; cache them.
        for (const e of graph.edges) {
          const a = this.runMapRects.nodes.find((r) => r.id === e.fromId);
          const b = this.runMapRects.nodes.find((r) => r.id === e.toId);
          if (a && b) this.runMapRects.edges.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, fromId: e.fromId, toId: e.toId, fuelCost: e.fuelCost });
        }
      }
    }

    // Footer buttons.
    const btnH = 40;
    this.runMapRects.abandonBtn = {
      x: panelX + 24,
      y: panelY + panelH - btnH - 18,
      w: 130, h: btnH,
    };
    this.runMapRects.closeBtn = {
      x: panelX + panelW - 130 - 24,
      y: panelY + panelH - btnH - 18,
      w: 130, h: btnH,
    };
  }

  _drawRunMap(ctx, viewW, viewH) {
    ctx.fillStyle = "rgba(2,8,18,0.78)";
    ctx.fillRect(0, 0, viewW, viewH);

    const p = this.runMapRects.panel;
    if (!p) return;
    ctx.fillStyle = "rgba(8,16,28,0.95)";
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.strokeStyle = "#5af";
    ctx.lineWidth = 2;
    ctx.strokeRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = "#5af";
    ctx.fillRect(p.x, p.y, p.w, 3);

    const run = this.runState && this.runState.run;
    if (!run) {
      ctx.textAlign = "center";
      ctx.fillStyle = "#cef";
      ctx.font = "bold 22px system-ui, sans-serif";
      ctx.fillText("NO ACTIVE RUN", p.x + p.w / 2, p.y + p.h / 2);
      this._drawCloseFooterBtn(ctx);
      ctx.textAlign = "left";
      return;
    }

    // Header.
    ctx.textAlign = "left";
    ctx.fillStyle = "#cef";
    ctx.font = "bold 22px system-ui, sans-serif";
    ctx.fillText(`ACT ${run.act} OF ${ACTS_PER_RUN}`, p.x + 24, p.y + 40);
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillStyle = "#9bd";
    const faction = RACES[run.faction] ? RACES[run.faction].name : run.faction;
    ctx.fillText(`Commander · ${faction}`, p.x + 24, p.y + 60);

    // Top-right currency strip.
    ctx.textAlign = "right";
    ctx.font = "bold 16px system-ui, sans-serif";
    ctx.fillStyle = "#fe8";
    ctx.fillText(`${run.resources.credits} credits`, p.x + p.w - 24, p.y + 40);
    ctx.fillStyle = "#8df";
    ctx.fillText(`${run.resources.fuel} fuel`, p.x + p.w - 24, p.y + 60);

    // Edges first so nodes sit on top.
    for (const e of this.runMapRects.edges) {
      const isCurrent = e.fromId === run.nodePos;
      const isVisited = run.visitedNodeIds.includes(e.fromId) && run.visitedNodeIds.includes(e.toId);
      ctx.strokeStyle = isCurrent
        ? "rgba(140,210,255,0.85)"
        : isVisited
          ? "rgba(140,210,255,0.25)"
          : "rgba(120,140,170,0.35)";
      ctx.lineWidth = isCurrent ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(e.ax, e.ay);
      ctx.lineTo(e.bx, e.by);
      ctx.stroke();
    }

    // Nodes.
    const reachable = new Set();
    for (const e of this.runMapRects.edges) {
      if (e.fromId === run.nodePos) reachable.add(e.toId);
    }
    for (const n of this.runMapRects.nodes) {
      const isCurrent = n.id === run.nodePos;
      const isVisited = run.visitedNodeIds.includes(n.id);
      const isReachable = reachable.has(n.id);
      let state;
      if (isCurrent) state = "current";
      else if (isVisited) state = "visited";
      else if (isReachable) state = "reachable";
      else state = "locked";
      this._drawNodeIcon(ctx, n, state);
    }

    // Fleet panel.
    this._drawFleetPanel(ctx, this.runMapRects.fleetPanel, run);

    // Footer.
    const ab = this.runMapRects.abandonBtn;
    ctx.fillStyle = "rgba(60,30,30,0.85)";
    ctx.fillRect(ab.x, ab.y, ab.w, ab.h);
    ctx.strokeStyle = "#c66";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ab.x, ab.y, ab.w, ab.h);
    ctx.textAlign = "center";
    ctx.fillStyle = "#fbb";
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.fillText("ABANDON RUN", ab.x + ab.w / 2, ab.y + ab.h / 2 + 5);

    this._drawCloseFooterBtn(ctx);
    ctx.textAlign = "left";
  }

  _drawCloseFooterBtn(ctx) {
    const c = this.runMapRects.closeBtn;
    if (!c) return;
    ctx.fillStyle = "rgba(30,50,40,0.85)";
    ctx.fillRect(c.x, c.y, c.w, c.h);
    ctx.strokeStyle = "#6c9";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(c.x, c.y, c.w, c.h);
    ctx.textAlign = "center";
    ctx.fillStyle = "#bfe";
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.fillText("BACK TO MENU", c.x + c.w / 2, c.y + c.h / 2 + 5);
    ctx.textAlign = "left";
  }

  _drawNodeIcon(ctx, n, state) {
    const accent = (n.faction && RACES[n.faction]) ? RACES[n.faction].accent : "#7df";
    const alpha = state === "locked" ? 0.25
                : state === "visited" ? 0.45
                : state === "reachable" ? 1.0 : 1.0;
    ctx.globalAlpha = alpha;
    // Shape per type.
    ctx.beginPath();
    if (n.type === "battle") {
      ctx.moveTo(n.x, n.y - n.r);
      ctx.lineTo(n.x + n.r, n.y + n.r);
      ctx.lineTo(n.x - n.r, n.y + n.r);
      ctx.closePath();
      ctx.fillStyle = accent;
    } else if (n.type === "elite") {
      ctx.moveTo(n.x, n.y - n.r * 1.2);
      ctx.lineTo(n.x + n.r * 1.2, n.y + n.r * 1.2);
      ctx.lineTo(n.x - n.r * 1.2, n.y + n.r * 1.2);
      ctx.closePath();
      ctx.fillStyle = accent;
    } else if (n.type === "resupply") {
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = "#6c9";
    } else if (n.type === "event") {
      ctx.moveTo(n.x, n.y - n.r);
      ctx.lineTo(n.x + n.r, n.y);
      ctx.lineTo(n.x, n.y + n.r);
      ctx.lineTo(n.x - n.r, n.y);
      ctx.closePath();
      ctx.fillStyle = "#fc6";
    } else if (n.type === "boss") {
      ctx.arc(n.x, n.y, n.r * 1.5, 0, Math.PI * 2);
      ctx.fillStyle = "#f76";
    }
    ctx.fill();
    ctx.strokeStyle = state === "current" ? "#fff" : "#012";
    ctx.lineWidth = state === "current" ? 3 : 1.5;
    ctx.stroke();

    // Glyph (single letter inside).
    ctx.fillStyle = "#012";
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.textAlign = "center";
    const glyph = n.type === "battle" ? "B"
                : n.type === "elite" ? "E"
                : n.type === "resupply" ? "R"
                : n.type === "event" ? "?"
                : "X";
    ctx.fillText(glyph, n.x, n.y + 5);

    // Current-position halo.
    if (state === "current") {
      ctx.strokeStyle = "rgba(140,210,255,0.85)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + 8, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  _drawFleetPanel(ctx, panel, run) {
    if (!panel) return;
    ctx.fillStyle = "rgba(12,20,32,0.92)";
    ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
    ctx.strokeStyle = "#356";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(panel.x, panel.y, panel.w, panel.h);
    ctx.fillStyle = SIDES.blue.primary;
    ctx.fillRect(panel.x, panel.y, panel.w, 2);

    ctx.textAlign = "left";
    ctx.fillStyle = "#cef";
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.fillText("FLEET", panel.x + 14, panel.y + 22);

    // Capital list with HP bars.
    let cy = panel.y + 42;
    for (const cap of run.capitals) {
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillStyle = "#cef";
      ctx.fillText(this._capitalName(cap.klass), panel.x + 14, cy);
      // HP bar.
      const barX = panel.x + 110;
      const barW = panel.w - 130;
      const barH = 8;
      ctx.fillStyle = "rgba(40,60,80,0.85)";
      ctx.fillRect(barX, cy - 8, barW, barH);
      const fillW = barW * cap.hpFrac;
      ctx.fillStyle = cap.hpFrac > 0.6 ? "#7df"
                    : cap.hpFrac > 0.3 ? "#fc6"
                    : "#f76";
      ctx.fillRect(barX, cy - 8, fillW, barH);
      ctx.fillStyle = "#cef";
      ctx.font = "10px system-ui, sans-serif";
      ctx.fillText(`${Math.round(cap.hpFrac * 100)}%`, barX + barW + 4, cy);
      cy += 22;
    }

    // Small craft.
    cy += 8;
    ctx.fillStyle = "#9bd";
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.fillText("SMALL CRAFT", panel.x + 14, cy);
    cy += 16;
    ctx.fillStyle = "#cef";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText(`Fighter × ${run.smallCraft.fighter}`, panel.x + 14, cy);
    cy += 18;
    ctx.fillText(`Bomber  × ${run.smallCraft.bomber}`, panel.x + 14, cy);

    // Boons.
    if (run.boons.length > 0) {
      cy += 22;
      ctx.fillStyle = "#9bd";
      ctx.font = "bold 11px system-ui, sans-serif";
      ctx.fillText("BOONS", panel.x + 14, cy);
      cy += 16;
      ctx.font = "11px system-ui, sans-serif";
      ctx.fillStyle = "#fe8";
      for (const b of run.boons) {
        ctx.fillText(`• ${b.desc}`, panel.x + 14, cy);
        cy += 14;
      }
    }
  }

  _capitalName(klass) {
    if (klass === "frigate")    return "Frigate";
    if (klass === "cruiser")    return "Cruiser";
    if (klass === "battleship") return "Battleship";
    if (klass === "carrier")    return "Carrier";
    return klass;
  }

  _clickRunMap(x, y) {
    const run = this.runState && this.runState.run;
    if (this._hit(this.runMapRects.closeBtn, x, y)) {
      this.showRunMap = false; return;
    }
    if (this._hit(this.runMapRects.abandonBtn, x, y)) {
      if (this.onRunChoice) this.onRunChoice("abandon-run", {});
      this.showRunMap = false; return;
    }
    if (!run) return;
    // Node clicks.
    for (const n of this.runMapRects.nodes) {
      const dx = x - n.x, dy = y - n.y;
      if (dx * dx + dy * dy > n.r * n.r + 64) continue;
      // Must be a reachable edge target.
      let reachable = false;
      for (const e of this.runMapRects.edges) {
        if (e.fromId === run.nodePos && e.toId === n.id) {
          reachable = run.resources.fuel >= e.fuelCost;
          break;
        }
      }
      if (!reachable) return;
      // Route to the right sub-overlay or launch a battle.
      const graphNode = run.graphs[run.act - 1].nodes.find((m) => m.id === n.id);
      if (!graphNode) return;
      if (graphNode.type === "battle" || graphNode.type === "elite" || graphNode.type === "boss") {
        this._pendingBattleNode = graphNode;
        this._layoutBattleChoice(this._lastViewW || 1200, this._lastViewH || 800);
        this.showBattleChoice = true;
      } else if (graphNode.type === "resupply") {
        // Resupply nodes open the depot overlay. Fuel cost + node
        // completion happen when the player clicks CONTINUE inside the
        // overlay (which dispatches enter-node-and-complete).
        this._pendingResupplyNode = graphNode;
        this._resupplyBoonOffers = this._pickBoonOffers();
        this._layoutResupply(this._lastViewW || 1200, this._lastViewH || 800);
        this.showResupply = true;
      } else if (graphNode.type === "event") {
        this._pendingEventNode = graphNode;
        this._layoutEvent(this._lastViewW || 1200, this._lastViewH || 800);
        this.showEvent = true;
      }
      return;
    }
  }

  _pickBoonOffers() {
    // Random 3 boons from the table; same boon can't appear twice.
    const pool = BOON_TABLE.slice();
    const out = [];
    while (out.length < 3 && pool.length > 0) {
      const idx = Math.floor(Math.random() * pool.length);
      out.push(pool.splice(idx, 1)[0]);
    }
    return out;
  }

  // ---- Resupply overlay ---------------------------------------------
  _layoutResupply(viewW, viewH) {
    const panelW = Math.min(720, viewW - 60);
    const panelH = Math.min(560, viewH - 80);
    const panelX = (viewW - panelW) / 2;
    const panelY = (viewH - panelH) / 2;
    this.resupplyRects.panel = { x: panelX, y: panelY, w: panelW, h: panelH };

    const run = this.runState && this.runState.run;
    this.resupplyRects.repairBtns = [];
    if (run) {
      let ry = panelY + 90;
      for (const cap of run.capitals) {
        this.resupplyRects.repairBtns.push({
          instanceId: cap.instanceId,
          klass: cap.klass,
          x: panelX + 24, y: ry,
          w: panelW - 48, h: 38,
        });
        ry += 44;
      }
    }
    // Recruit row.
    const ry2 = panelY + panelH - 240;
    this.resupplyRects.recruitFighterBtn = {
      x: panelX + 24, y: ry2, w: (panelW - 60) / 2, h: 38,
    };
    this.resupplyRects.recruitBomberBtn = {
      x: panelX + 36 + (panelW - 60) / 2, y: ry2,
      w: (panelW - 60) / 2, h: 38,
    };
    this.resupplyRects.refuelBtn = {
      x: panelX + 24, y: ry2 + 50,
      w: panelW - 48, h: 38,
    };
    // Boon row — 3 buttons across.
    const boonY = ry2 + 110;
    const boonW = (panelW - 60) / 3;
    this.resupplyRects.boonBtns = [];
    for (let i = 0; i < 3; i++) {
      this.resupplyRects.boonBtns.push({
        slot: i,
        x: panelX + 24 + i * (boonW + 6),
        y: boonY, w: boonW, h: 48,
      });
    }
    this.resupplyRects.continueBtn = {
      x: panelX + panelW - 140 - 24,
      y: panelY + panelH - 56,
      w: 140, h: 40,
    };
    this.resupplyRects.closeBtn = {
      x: panelX + 24,
      y: panelY + panelH - 56,
      w: 100, h: 40,
    };
  }

  _drawResupply(ctx, viewW, viewH) {
    ctx.fillStyle = "rgba(2,8,18,0.78)";
    ctx.fillRect(0, 0, viewW, viewH);

    const p = this.resupplyRects.panel;
    if (!p) return;
    ctx.fillStyle = "rgba(8,16,28,0.95)";
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.strokeStyle = "#6c9";
    ctx.lineWidth = 2;
    ctx.strokeRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = "#6c9";
    ctx.fillRect(p.x, p.y, p.w, 3);

    ctx.textAlign = "center";
    ctx.fillStyle = "#cef";
    ctx.font = "bold 22px system-ui, sans-serif";
    ctx.fillText("RESUPPLY DEPOT", p.x + p.w / 2, p.y + 38);

    const run = this.runState && this.runState.run;
    if (!run) { ctx.textAlign = "left"; return; }
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillStyle = "#9bd";
    ctx.fillText(`${run.resources.credits} credits  ·  ${run.resources.fuel} fuel`,
                 p.x + p.w / 2, p.y + 60);

    // Repair rows.
    ctx.textAlign = "left";
    for (const r of this.resupplyRects.repairBtns) {
      const cap = run.capitals.find((c) => c.instanceId === r.instanceId);
      if (!cap) continue;
      const cost = repairCostFor(cap);
      const afford = run.resources.credits >= cost && cap.hpFrac < 1;
      ctx.fillStyle = afford ? "rgba(30,60,90,0.92)" : "rgba(40,40,55,0.85)";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = afford ? "#9cf" : "#566";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = "#cef";
      ctx.font = "13px system-ui, sans-serif";
      ctx.fillText(
        `${this._capitalName(r.klass)} — ${Math.round(cap.hpFrac * 100)}%  →  100%`,
        r.x + 12, r.y + 24,
      );
      ctx.textAlign = "right";
      ctx.fillStyle = afford ? "#fe8" : "#866";
      ctx.fillText(
        cap.hpFrac >= 1 ? "FULL" : `${cost} cr`,
        r.x + r.w - 12, r.y + 24,
      );
      ctx.textAlign = "left";
    }

    // Recruit / refuel.
    const rf = this.resupplyRects.recruitFighterBtn;
    const rb = this.resupplyRects.recruitBomberBtn;
    const re = this.resupplyRects.refuelBtn;
    this._drawShopBtn(ctx, rf, "Recruit Fighter (+1)", `8 cr`, run.resources.credits >= 8);
    this._drawShopBtn(ctx, rb, "Recruit Bomber (+1)", `20 cr`, run.resources.credits >= 20);
    this._drawShopBtn(ctx, re, "Refuel (+1 fuel)", `10 cr`, run.resources.credits >= 10);

    // Boons.
    ctx.textAlign = "center";
    ctx.fillStyle = "#9bd";
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.fillText("REFITS (1 FUEL EACH)", p.x + p.w / 2, this.resupplyRects.boonBtns[0].y - 6);
    ctx.textAlign = "left";
    for (const b of this.resupplyRects.boonBtns) {
      const offer = this._resupplyBoonOffers && this._resupplyBoonOffers[b.slot];
      if (!offer) continue;
      const afford = run.resources.fuel >= 1;
      ctx.fillStyle = afford ? "rgba(50,30,70,0.92)" : "rgba(40,40,55,0.85)";
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = afford ? "#c9f" : "#566";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = "#fcf";
      ctx.font = "bold 11px system-ui, sans-serif";
      ctx.fillText(offer.key, b.x + 8, b.y + 16);
      ctx.font = "10px system-ui, sans-serif";
      ctx.fillStyle = "#bce";
      ctx.fillText(offer.desc, b.x + 8, b.y + 32);
    }

    // Continue + close.
    const c = this.resupplyRects.continueBtn;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(80,170,110,0.95)";
    ctx.fillRect(c.x, c.y, c.w, c.h);
    ctx.strokeStyle = "#bff";
    ctx.lineWidth = 2;
    ctx.strokeRect(c.x, c.y, c.w, c.h);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.fillText("CONTINUE", c.x + c.w / 2, c.y + c.h / 2 + 6);

    const cl = this.resupplyRects.closeBtn;
    ctx.fillStyle = "rgba(40,50,60,0.85)";
    ctx.fillRect(cl.x, cl.y, cl.w, cl.h);
    ctx.strokeStyle = "#789";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cl.x, cl.y, cl.w, cl.h);
    ctx.fillStyle = "#bce";
    ctx.fillText("BACK", cl.x + cl.w / 2, cl.y + cl.h / 2 + 6);

    ctx.textAlign = "left";
  }

  _drawShopBtn(ctx, r, label, cost, afford) {
    ctx.fillStyle = afford ? "rgba(30,60,90,0.92)" : "rgba(40,40,55,0.85)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = afford ? "#9cf" : "#566";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.textAlign = "left";
    ctx.fillStyle = "#cef";
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillText(label, r.x + 12, r.y + 24);
    ctx.textAlign = "right";
    ctx.fillStyle = afford ? "#fe8" : "#866";
    ctx.fillText(cost, r.x + r.w - 12, r.y + 24);
    ctx.textAlign = "left";
  }

  _clickResupply(x, y) {
    if (this._hit(this.resupplyRects.closeBtn, x, y)) {
      // BACK — return to run map without consuming the node. Player
      // can re-enter or pick a sibling node.
      this.showResupply = false; return;
    }
    if (this._hit(this.resupplyRects.continueBtn, x, y)) {
      // Resupply costs no fuel at the node itself — the jump cost was
      // already deducted when picking the node from the map. Complete
      // it via the non-combat path so main.js calls completeNode().
      if (this._pendingResupplyNode && this.onRunChoice) {
        // First debit fuel (the edge cost), then complete.
        this.onRunChoice("enter-node-and-complete", {
          nodeId: this._pendingResupplyNode.id,
        });
      }
      this._pendingResupplyNode = null;
      this.showResupply = false;
      return;
    }
    for (const r of this.resupplyRects.repairBtns) {
      if (this._hit(r, x, y) && this.onRunChoice) {
        this.onRunChoice("buy-repair", { instanceId: r.instanceId });
        return;
      }
    }
    if (this._hit(this.resupplyRects.recruitFighterBtn, x, y) && this.onRunChoice) {
      this.onRunChoice("buy-recruit", { klass: "fighter" }); return;
    }
    if (this._hit(this.resupplyRects.recruitBomberBtn, x, y) && this.onRunChoice) {
      this.onRunChoice("buy-recruit", { klass: "bomber" }); return;
    }
    if (this._hit(this.resupplyRects.refuelBtn, x, y) && this.onRunChoice) {
      this.onRunChoice("buy-refuel", { units: 1 }); return;
    }
    for (const b of this.resupplyRects.boonBtns) {
      if (this._hit(b, x, y) && this.onRunChoice) {
        const offer = this._resupplyBoonOffers && this._resupplyBoonOffers[b.slot];
        if (offer) this.onRunChoice("apply-boon", { boonKey: offer.key });
        return;
      }
    }
  }

  // ---- Event overlay ------------------------------------------------
  _layoutEvent(viewW, viewH) {
    const panelW = Math.min(640, viewW - 60);
    const panelH = Math.min(420, viewH - 100);
    const panelX = (viewW - panelW) / 2;
    const panelY = (viewH - panelH) / 2;
    this.eventRects.panel = { x: panelX, y: panelY, w: panelW, h: panelH };

    const card = this._pendingEventNode
      ? eventCardById(this._pendingEventNode.eventId)
      : null;
    this.eventRects.choiceBtns = [];
    if (card) {
      const btnH = 48;
      let by = panelY + panelH - card.options.length * (btnH + 8) - 20;
      for (let i = 0; i < card.options.length; i++) {
        this.eventRects.choiceBtns.push({
          choiceIndex: i,
          x: panelX + 24, y: by,
          w: panelW - 48, h: btnH,
        });
        by += btnH + 8;
      }
    }
  }

  _drawEvent(ctx, viewW, viewH) {
    ctx.fillStyle = "rgba(2,8,18,0.78)";
    ctx.fillRect(0, 0, viewW, viewH);
    const p = this.eventRects.panel;
    if (!p) return;
    ctx.fillStyle = "rgba(8,16,28,0.95)";
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.strokeStyle = "#fc6";
    ctx.lineWidth = 2;
    ctx.strokeRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = "#fc6";
    ctx.fillRect(p.x, p.y, p.w, 3);

    const card = this._pendingEventNode
      ? eventCardById(this._pendingEventNode.eventId)
      : null;
    if (!card) return;

    ctx.textAlign = "center";
    ctx.fillStyle = "#cef";
    ctx.font = "bold 22px system-ui, sans-serif";
    ctx.fillText(card.title.toUpperCase(), p.x + p.w / 2, p.y + 40);
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillStyle = "#bce";
    // Wrap body into multiple lines for readability.
    this._wrapText(ctx, card.body, p.x + 32, p.y + 72, p.w - 64, 18);

    // If a choice was just applied, show the result line above the
    // buttons so the player sees what happened before clicking
    // CONTINUE.
    if (this.eventRects.lastResult) {
      ctx.fillStyle = "#fe8";
      ctx.font = "bold 12px system-ui, sans-serif";
      ctx.fillText("» " + this.eventRects.lastResult,
                   p.x + p.w / 2, p.y + p.h - this.eventRects.choiceBtns.length * 56 - 24);
    }

    // Choice buttons.
    ctx.textAlign = "left";
    for (const r of this.eventRects.choiceBtns) {
      const opt = card.options[r.choiceIndex];
      ctx.fillStyle = "rgba(40,50,60,0.92)";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = "#9cf";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = "#cef";
      ctx.font = "13px system-ui, sans-serif";
      ctx.fillText(opt.label, r.x + 12, r.y + r.h / 2 + 5);
    }
    ctx.textAlign = "left";
  }

  _clickEvent(x, y) {
    const card = this._pendingEventNode
      ? eventCardById(this._pendingEventNode.eventId)
      : null;
    if (!card) { this.showEvent = false; return; }

    for (const r of this.eventRects.choiceBtns) {
      if (this._hit(r, x, y)) {
        if (this.onRunChoice) {
          this.onRunChoice("apply-event", {
            eventId: this._pendingEventNode.eventId,
            choiceIndex: r.choiceIndex,
          });
        }
        // Auto-advance: complete the node and close.
        if (this.onRunChoice && this._pendingEventNode) {
          this.onRunChoice("complete-node-noncombat", {
            nodeId: this._pendingEventNode.id,
          });
        }
        this._pendingEventNode = null;
        this.eventRects.lastResult = null;
        this.showEvent = false;
        return;
      }
    }
  }

  _wrapText(ctx, text, x, y, maxW, lineH) {
    const words = text.split(" ");
    let line = "";
    let yy = y;
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x + maxW / 2, yy);
        line = w;
        yy += lineH;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, x + maxW / 2, yy);
  }

  // ---- Battle choice modal ------------------------------------------
  _layoutBattleChoice(viewW, viewH) {
    const panelW = 440, panelH = 240;
    const panelX = (viewW - panelW) / 2;
    const panelY = (viewH - panelH) / 2;
    this.battleChoiceRects.panel = { x: panelX, y: panelY, w: panelW, h: panelH };
    const btnW = 160, btnH = 56;
    this.battleChoiceRects.fly = {
      x: panelX + 24, y: panelY + 90, w: btnW, h: btnH,
    };
    this.battleChoiceRects.command = {
      x: panelX + panelW - btnW - 24, y: panelY + 90, w: btnW, h: btnH,
    };
    this.battleChoiceRects.back = {
      x: panelX + (panelW - 110) / 2,
      y: panelY + panelH - 50,
      w: 110, h: 36,
    };
  }

  _drawBattleChoice(ctx, viewW, viewH) {
    ctx.fillStyle = "rgba(2,8,18,0.78)";
    ctx.fillRect(0, 0, viewW, viewH);
    const p = this.battleChoiceRects.panel;
    if (!p) return;
    ctx.fillStyle = "rgba(8,16,28,0.95)";
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.strokeStyle = "#5af";
    ctx.lineWidth = 2;
    ctx.strokeRect(p.x, p.y, p.w, p.h);

    ctx.textAlign = "center";
    ctx.fillStyle = "#cef";
    ctx.font = "bold 20px system-ui, sans-serif";
    ctx.fillText("HOW WILL YOU FIGHT?", p.x + p.w / 2, p.y + 40);
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillStyle = "#9bd";
    ctx.fillText("Pilot a fighter or command from the bridge.",
                 p.x + p.w / 2, p.y + 60);

    const fly = this.battleChoiceRects.fly;
    const cmd = this.battleChoiceRects.command;
    ctx.fillStyle = "rgba(80,170,110,0.95)";
    ctx.fillRect(fly.x, fly.y, fly.w, fly.h);
    ctx.strokeStyle = "#bff";
    ctx.lineWidth = 2;
    ctx.strokeRect(fly.x, fly.y, fly.w, fly.h);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 16px system-ui, sans-serif";
    ctx.fillText("FLY", fly.x + fly.w / 2, fly.y + fly.h / 2 + 6);

    ctx.fillStyle = "rgba(110,80,170,0.95)";
    ctx.fillRect(cmd.x, cmd.y, cmd.w, cmd.h);
    ctx.strokeStyle = "#cbf";
    ctx.strokeRect(cmd.x, cmd.y, cmd.w, cmd.h);
    ctx.fillStyle = "#fff";
    ctx.fillText("COMMAND", cmd.x + cmd.w / 2, cmd.y + cmd.h / 2 + 6);

    const back = this.battleChoiceRects.back;
    ctx.fillStyle = "rgba(40,50,60,0.85)";
    ctx.fillRect(back.x, back.y, back.w, back.h);
    ctx.strokeStyle = "#789";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(back.x, back.y, back.w, back.h);
    ctx.fillStyle = "#bce";
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillText("BACK", back.x + back.w / 2, back.y + back.h / 2 + 5);
    ctx.textAlign = "left";
  }

  _clickBattleChoice(x, y) {
    if (this._hit(this.battleChoiceRects.back, x, y)) {
      this._pendingBattleNode = null;
      this.showBattleChoice = false;
      return;
    }
    const choose = (mode) => {
      if (this._pendingBattleNode && this.onRunChoice) {
        this.onRunChoice("enter-node", {
          nodeId: this._pendingBattleNode.id,
          battleMode: mode,
        });
      }
      this._pendingBattleNode = null;
      this.showBattleChoice = false;
      this.showRunMap = false; // hide map while battle plays out
    };
    if (this._hit(this.battleChoiceRects.fly, x, y)) { choose("fly"); return; }
    if (this._hit(this.battleChoiceRects.command, x, y)) { choose("command"); return; }
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
    this.admiralPanel = new AdmiralPanel();
    this.admiralActive = false; // set from main.js when game.admiralMode
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
    this.admiralPanel.layout(viewW, viewH);
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

    // Admiral panel grabs clicks first so its controls don't fall
    // through to the spectate-pan handler. Only active in admiral
    // mode; main.js flips this flag on startGame.
    if (this.admiralActive && this.admiralPanel.handleClick(x, y)) {
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
    // Pre-match menu owns the pointer while open — sliders inside the
    // Custom Match overlay need move events to drag. Returns false
    // when nothing is being dragged so we don't swallow stick input
    // (which can't reach this branch anyway, since menu is exclusive).
    if (this.menuActive) {
      this.startMenu.pointerMove(x, y);
      return;
    }
    if (this.left.pointerId === e.pointerId) this.left.move(x, y);
    else if (this.right.pointerId === e.pointerId) this.right.move(x, y);
  }
  onUp(e) {
    if (this.menuActive) {
      this.startMenu.pointerUp();
      return;
    }
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
