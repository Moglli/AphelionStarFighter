// Input sources: virtual joysticks for touch, plus WASD + mouse + Enter
// for desktop play. The aim direction is computed relative to canvas
// center because the camera follows the player unit, so center == player.

import { MAP_SIZES } from "./arena.js";
import { RACES, RACE_KEYS } from "./races.js";
import { SIDES } from "./classes.js";
import {
  ACTS_PER_RUN, COLS_PER_ACT, ROWS_PER_ACT,
  STARTER_FUEL, FUEL_PER_EDGE,
  repairCostFor, eventCardById, PERKS, BOON_TABLE,
} from "./roguelite.js";
import {
  createStarmap, updateStarmap, destroyStarmap,
  setStarmapCallbacks, centerOnNode, getPan, setPan,
} from "./starmap.js";
import { MenuSystem } from "./menus.js";
import {
  MAX_ENERGY, COST_PER_GAME, PACKAGES,
  canSpend, timeUntilNext, formatDuration,
} from "./energy.js";

const DEADZONE = 0.15;

export class VirtualStick {
  constructor({ side, color, baseEl, knobEl }) {
    this.side = side; // "left" or "right"
    this.color = color;
    this.pointerId = null;
    this.center = { x: 0, y: 0 };
    this.knob = { x: 0, y: 0 };
    this.radius = 70;
    this.active = false;
    this.value = { x: 0, y: 0 };
    this._baseEl = baseEl || null;
    this._knobEl = knobEl || null;
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
    if (this._baseEl) this._baseEl.parentElement.style.opacity = "0";
  }

  _updateDOM() {
    if (!this._knobEl || !this._baseEl) return;
    if (!this.active) {
      this._baseEl.parentElement.style.opacity = "0";
      return;
    }
    this._knobEl.style.transform = `translate3d(${this.knob.x - 28}px, ${this.knob.y - 28}px, 0)`;
    this._baseEl.parentElement.style.opacity = "1";
  }

  draw(ctx) {
    if (this._baseEl) return; // DOM handles rendering
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
  _updateDOM(domEl) {
    if (!domEl) return;
    domEl.classList.toggle("pressed", this.pressed);
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
    ctx.fillText("STRIKE", r.x + r.w / 2, r.y + r.h / 2 - 2);
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = "#fcb";
    ctx.fillText("MISSILE", r.x + r.w / 2, r.y + r.h / 2 + 14);
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
  _updateDOM(domEl, ready, frac) {
    if (!domEl) return;
    domEl.classList.toggle("ready", ready);
    domEl.classList.toggle("pressed", this.pressed);
    const angle = ready ? 0 : frac * 360;
    domEl.style.setProperty("--cooldown-angle", `${angle}deg`);
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
    ctx.fillText("SPECIAL", r.x + r.w / 2, r.y + r.h / 2 - 4);
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText(ready ? "READY" : "RELOAD", r.x + r.w / 2, r.y + r.h / 2 + 12);
    ctx.textAlign = "left";
    ctx.restore();
  }
}

// On-screen BOOST button. Afterburner / speed boost — maps to Space key
// or touch. Placed above the missile button in the action cluster.
export class BoostButton {
  constructor() {
    this.pressed = false;
    this.pointerId = null;
    this.rect = { x: 0, y: 0, w: 48, h: 48 };
  }
  hit(x, y) {
    const r = this.rect;
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }
  start(pid) { this.pointerId = pid; this.pressed = true; }
  end() { this.pointerId = null; this.pressed = false; }
  consumeJustPressed() { return false; }
  _updateDOM(domEl) {
    if (!domEl) return;
    domEl.classList.toggle("pressed", this.pressed);
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
  { key: "roguelite", label: "Frontier",        tagline: "Procedural campaign" },
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
// roughly doubles a stock battle to the upper edge of what the
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
    // Starmap state — pan offset + cached galaxy/positions keyed by
    // (run.seed, act). Drag tracking distinguishes a tap-on-node from
    // a pan gesture. Regenerated lazily when the key changes.
    this._runMapPanX = 0;
    this._runMapPanY = 0;
    this._runMapDrag = null;           // { startX, startY, startPanX, startPanY }
    this._runMapDragMoved = false;
    this._runMapGalaxyKey = null;
    this._runMapGalaxy = null;
    this._runMapNodePositions = null;
    this._runMapWorldW = 0;
    this._runMapWorldH = 0;
    this._starmapControl = null;
    this._menuSystem = null;        // initialized lazily in draw()
    this._needsRelayout = false;    // set by DOM mode select callback
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
    this.settingsRects = { panel: null, musicToggle: null, sfxToggle: null, close: null };
    this._settingsGet = () => ({ musicMuted: false, sfxMuted: false });
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
    // Refill overlay — handle package purchase and close (canvas fallback)
    if (this.showRefill) {
      for (const r of this.refillRects) {
        if (this._hit(r, x, y)) {
          if (this.onEnergyPurchase) this.onEnergyPurchase(r.id);
          this.showRefill = false;
          return true;
        }
      }
      this.showRefill = false;
      return true;
    }
    // Settings overlay (canvas fallback)
    if (this.showSettings) {
      this._clickSettingsOverlay(x, y);
      return true;
    }
    // Settings gear button (canvas fallback)
    if (this.settingsButtonRect && this._hit(this.settingsButtonRect, x, y)) {
      this._layoutSettingsOverlay(this._lastViewW || 1200, this._lastViewH || 800);
      this.showSettings = true;
      return true;
    }
    // Custom Match overlay (canvas fallback for sliders)
    if (this.showCustom) {
      const result = this._clickCustomOverlay(x, y);
      if (result === "start") {
        if (this.energy && !canSpend(this.energy, COST_PER_GAME)) {
          this.showRefill = true;
          this.showCustom = false;
          return true;
        }
        this._emitStart();
        this.showCustom = false;
        return true;
      }
      return true;
    }
    // Roguelite overlays (canvas fallback)
    if (this.showBattleChoice) { this._clickBattleChoice(x, y); return true; }
    if (this.showEvent)        { this._clickEvent(x, y);        return true; }
    if (this.showResupply)     { this._clickResupply(x, y);     return true; }
    if (this.showRunMap)       {
      this._runMapPressX = x;
      this._runMapPressY = y;
      this._startRunMapDrag(x, y);
      return true;
    }
    if (this.showRunSetup)     { this._clickRunSetup(x, y);     return true; }
    // Energy bar (canvas fallback)
    if (this.energyBarRect && this._hit(this.energyBarRect, x, y)) {
      this.showRefill = true;
      return true;
    }
    // Main menu chips — DOM handles these, but keep canvas fallback.
    // Also check _needsRelayout set by DOM mode-select callback.
    if (this._needsRelayout) {
      this._needsRelayout = false;
      return "relayout";
    }
    for (const r of this.sizeRects) {
      if (this._hit(r, x, y)) { this.selectedSize = r.key; return true; }
    }
    for (const r of this.modeRects) {
      if (this._hit(r, x, y)) {
        const changed = this.selectedMode !== r.key;
        this.selectedMode = r.key;
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
    // START button (canvas fallback)
    if (this.startRect && this._hit(this.startRect, x, y)) {
      if (this.selectedMode === "custom") {
        this._layoutCustomOverlay(this._lastViewW || 1200, this._lastViewH || 800);
        this.showCustom = true;
        return true;
      }
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

    // Lazy-init the menu system
    if (!this._menuSystem) {
      this._menuSystem = new MenuSystem(document.body);
      this._wireMenuCallbacks();
    }

    // Determine which screen to show
    let screenName = 'main';
    if (this.showSettings) screenName = 'settings';
    else if (this.showRefill) screenName = 'refill';
    else if (this.showCustom) screenName = 'custom';
    else if (this.showRunSetup) screenName = 'runSetup';
    else if (this.showResupply) screenName = 'resupply';
    else if (this.showEvent) screenName = 'event';
    else if (this.showBattleChoice) screenName = 'battleChoice';

    // Show the menu root unless we're on the run-map *and* no overlay is
    // up. When an overlay is up during a run, the menu-root (z-index 15)
    // sits above the starmap (z-index 10) and the DOM screen handles the
    // visuals — keeping menu-root hidden here was the JUMP-does-nothing
    // bug, the overlay state flipped but no DOM ever rendered.
    const hasSubOverlay = this.showResupply || this.showEvent || this.showBattleChoice;
    if (!this.showRunMap || hasSubOverlay) {
      this._menuSystem.showScreen(screenName);
      // Only dim canvas when main menu is showing (not for DOM overlays that have their own scrim)
      if (screenName === 'main') {
        ctx.fillStyle = "rgba(2,8,18,0.78)";
        ctx.fillRect(0, 0, viewW, viewH);
      }
      // Sync menu data
      const menuState = this._buildMenuState(viewW, viewH);
      this._menuSystem.sync(menuState);
    } else {
      // Hide menu when run map is showing and no overlay is up
      this._menuSystem.hideAll();
    }

    // Starmap (existing code, keep as-is)
    if (!this.showRunMap && this._starmapControl) {
      destroyStarmap(this._starmapControl);
      this._starmapControl = null;
    }
    if (this.showRunMap) this._drawRunMap(ctx, viewW, viewH);
    if (this.showRunSetup) this._drawRunSetup(ctx, viewW, viewH);

    // Legacy canvas sub-overlay stubs (DOM-rendered now). The
    // behind-canvas dim is also dead since the menu-root sits above the
    // starmap naturally — leaving the calls in place so the next code-
    // sweep can drop them in one pass.
    if (this.showResupply) this._drawResupply(ctx, viewW, viewH);
    if (this.showEvent) this._drawEvent(ctx, viewW, viewH);
    if (this.showBattleChoice) this._drawBattleChoice(ctx, viewW, viewH);

    ctx.restore();
  }

  _buildMenuState(viewW, viewH) {
    const run = this.runState && this.runState.run;
    const meta = this.runState && this.runState.meta;
    const outOfEnergy = this.energy && !canSpend(this.energy, COST_PER_GAME);

    // Calculate frontier status text
    let frontierStatus = "";
    if (this.selectedMode === "roguelite") {
      if (run) {
        const totalNodes = run.graphs.reduce((n, g) => n + g.nodes.length, 0);
        frontierStatus = `ACTIVE CAMPAIGN — ${RACES[run.faction].name.toUpperCase()} · ACT ${run.act}/${ACTS_PER_RUN} · ${run.visitedNodeIds.length}/${totalNodes} cleared`;
      } else if (meta) {
        frontierStatus = `Campaigns won: ${meta.runsWon} / ${meta.runsCompleted}   ·   Perks: ${meta.unlockedPerks.length}/${Object.keys(PERKS).length}`;
      }
    }

    // Build custom match state
    const blueTotal = totalShipCount(this.customBlueCounts);
    const redTotal = totalShipCount(this.customRedCounts);

    // Build resupply state
    let resupplyState = null;
    if (this.showResupply && this._pendingResupplyNode) {
      const run = this.runState && this.runState.run;
      resupplyState = {
        capitals: run ? run.capitals.map(cap => ({
          klass: cap.klass,
          instanceId: cap.instanceId,
          hpFrac: cap.hpFrac,
          repairCost: repairCostFor(cap),
        })) : [],
        smallCraft: run ? { ...run.smallCraft } : { fighter: 0, bomber: 0 },
        boons: run ? [...run.boons] : [],
        boonOffers: this._resupplyBoonOffers || [],
        fuelPrice: 30,
        fighterPrice: 40,
        bomberPrice: 60,
        canAffordFighter: run ? run.resources.credits >= 40 : false,
        canAffordBomber: run ? run.resources.credits >= 60 : false,
        canAffordRefuel: run ? run.resources.credits >= 30 : false,
        credits: run ? run.resources.credits : 0,
      };
    }

    // Build event state
    let eventState = null;
    if (this.showEvent && this._pendingEventNode) {
      const card = eventCardById && this._pendingEventNode.eventId ? eventCardById(this._pendingEventNode.eventId) : null;
      eventState = {
        title: card ? card.title : "Anomaly Detected",
        body: card ? card.body : "Something unusual is happening in this sector...",
        choices: card ? card.options.map((c, i) => ({
          key: String(i),
          label: c.label,
          hint: c.hint || "",
        })) : [],
      };
    }

    // Build battle choice state
    let battleState = null;
    if (this.showBattleChoice && this._pendingBattleNode) {
      const node = this._pendingBattleNode;
      battleState = {
        title: node.type === "boss" ? "BOSS BATTLE" : node.type === "elite" ? "ELITE HUNT" : "PATROL ENCOUNTER",
        faction: node.faction || "",
        tier: node.tier || 1,
      };
    }

    // Build energy regen info
    let energyRegen = null;
    if (this.energy && this.energy.current < MAX_ENERGY) {
      energyRegen = {
        next: formatDuration(timeUntilNext(this.energy)),
        label: "until +1",
      };
    }

    return {
      selectedSize: this.selectedSize,
      selectedMode: this.selectedMode,
      selectedRace: this.selectedRace,
      selectedFleet: this.selectedFleet,
      modeOptions: MODE_OPTIONS,
      fleetOptions: FLEET_OPTIONS,
      mapSizes: MAP_SIZES,
      raceKeys: RACE_KEYS,
      races: RACES,
      energy: this.energy ? { current: this.energy.current, max: MAX_ENERGY } : null,
      energyRegen,
      canSpendEnergy: !outOfEnergy,
      packages: PACKAGES,
      settings: this._settingsGet(),
      custom: {
        alliedRace: this.customAlliedRace,
        hostileRace: this.customHostileRace,
        blueCounts: { ...this.customBlueCounts },
        redCounts: { ...this.customRedCounts },
        blueTotal,
        redTotal,
        grandTotal: blueTotal + redTotal,
        classes: CUSTOM_CLASSES,
        classGlyphs: CLASS_GLYPHS,
        classNames: {
          fighter: "Fighter", bomber: "Bomber", frigate: "Frigate",
          cruiser: "Cruiser", battleship: "Battleship", carrier: "Carrier",
        },
        maxPerClass: CUSTOM_MAX_PER_CLASS,
      },
      runState: { meta: meta || null, run: run || null },
      actsPerRun: ACTS_PER_RUN,
      perks: PERKS,
      battleNode: battleState,
      resupply: resupplyState,
      event: eventState,
      factions: RACE_KEYS,
      factionMeta: meta ? Object.fromEntries(RACE_KEYS.map(k => [k, { wins: meta.runsWon }])) : {},
      frontierStatus,
      outOfEnergy,
      startLabel: outOfEnergy ? "OUT OF STAMINA" :
                  this.selectedMode === "custom" ? "CONFIGURE..." :
                  this.selectedMode === "roguelite" ? (run ? "RESUME CAMPAIGN" : "NEW CAMPAIGN") :
                  "DEPLOY",
    };
  }

  _wireMenuCallbacks() {
    if (!this._menuSystem) return;
    this._menuSystem.setCallbacks({
      onSizeSelect: (key) => { this.selectedSize = key; },
      onModeSelect: (key) => {
        this.selectedMode = key;
        // Returning "relayout" from click() when mode changes is handled
        // by the caller reading selectedMode after the click. But with
        // DOM menus, we need to trigger a relayout explicitly.
        // We'll handle this via a flag.
        this._needsRelayout = true;
      },
      onRaceSelect: (key) => { this.selectedRace = key; },
      onFleetSelect: (key) => { this.selectedFleet = key; },
      onStart: () => {
        if (this.selectedMode === "custom") {
          this._layoutCustomOverlay(this._lastViewW || 1200, this._lastViewH || 800);
          this.showCustom = true;
        } else if (this.selectedMode === "roguelite") {
          const hasRun = this.runState && this.runState.run;
          if (hasRun) {
            this._layoutRunMap(this._lastViewW || 1200, this._lastViewH || 800);
            this.showRunMap = true;
          } else {
            this._layoutRunSetup(this._lastViewW || 1200, this._lastViewH || 800);
            this.showRunSetup = true;
          }
        } else {
          this._emitStart();
        }
      },
      onConfigure: () => {
        this._layoutCustomOverlay(this._lastViewW || 1200, this._lastViewH || 800);
        this.showCustom = true;
      },
      onResumeRun: () => {
        this._layoutRunMap(this._lastViewW || 1200, this._lastViewH || 800);
        this.showRunMap = true;
      },
      onNewRun: () => {
        this._layoutRunSetup(this._lastViewW || 1200, this._lastViewH || 800);
        this.showRunSetup = true;
      },
      onRefillOpen: () => { this.showRefill = true; },
      onRefillBuy: (pkgId) => {
        if (this.onEnergyPurchase) this.onEnergyPurchase(pkgId);
        this.showRefill = false;
      },
      onRefillClose: () => { this.showRefill = false; },
      onSettingsOpen: () => {
        this._layoutSettingsOverlay(this._lastViewW || 1200, this._lastViewH || 800);
        this.showSettings = true;
      },
      onSettingsClose: () => { this.showSettings = false; },
      onMusicToggle: () => {
        const cur = this._settingsGet();
        this._settingsApply({ musicMuted: !cur.musicMuted });
      },
      onSfxToggle: () => {
        const cur = this._settingsGet();
        this._settingsApply({ sfxMuted: !cur.sfxMuted });
      },
      onCustomClose: () => { this.showCustom = false; this._customDrag = null; },
      onCustomStart: () => {
        this._customDrag = null;
        if (this.energy && !canSpend(this.energy, COST_PER_GAME)) {
          this.showRefill = true;
          this.showCustom = false;
        } else {
          this._emitStart();
          this.showCustom = false;
        }
      },
      onCustomRaceSelect: (side, raceKey) => {
        if (side === "allied") {
          this.customAlliedRace = raceKey;
          this.customBlueCounts = rosterForRace(raceKey);
        } else {
          this.customHostileRace = raceKey;
          this.customRedCounts = rosterForRace(raceKey);
        }
      },
      onCustomSliderChange: (side, klass, count) => {
        if (side === "allied") this.customBlueCounts[klass] = count;
        else this.customRedCounts[klass] = count;
      },
      onBattleFly: () => {
        this._launchBattle("fly");
      },
      onBattleCommand: () => {
        this._launchBattle("command");
      },
      onBattleBack: () => { this.showBattleChoice = false; },
      onResupplyRepair: (instanceId) => {
        if (this.onRunChoice) this.onRunChoice("buy-repair", { instanceId });
      },
      onResupplyRecruit: (type) => {
        if (this.onRunChoice) this.onRunChoice("buy-recruit", { klass: type });
      },
      onResupplyBoon: (slot) => {
        if (this.onRunChoice && this._resupplyBoonOffers && this._resupplyBoonOffers[slot]) {
          this.onRunChoice("apply-boon", { boonKey: this._resupplyBoonOffers[slot].key });
        }
      },
      onResupplyContinue: () => {
        if (this.onRunChoice) this.onRunChoice("enter-node-and-complete", { nodeId: this._pendingResupplyNode.id });
        this.showResupply = false;
      },
      onResupplyClose: () => { this.showResupply = false; },
      onEventChoice: (choiceKey) => {
        const node = this._pendingEventNode;
        if (!node) { this.showEvent = false; return; }
        if (this.onRunChoice) {
          this.onRunChoice("apply-event", { eventId: node.eventId, choiceIndex: parseInt(choiceKey) });
          // Mirror the canvas handler: a choice applied = node visited.
          // Without this the run-map stays put and the player can re-tap
          // the same event endlessly.
          this.onRunChoice("complete-node-noncombat", { nodeId: node.id });
        }
        this._pendingEventNode = null;
        this.showEvent = false;
      },
      onEventClose: () => { this.showEvent = false; },
      onRunSetupSelect: (factionKey) => {
        if (this.onRunChoice) this.onRunChoice("new-run", { faction: factionKey });
        this.showRunSetup = false;
        // Auto-open the run map so the player lands in their first act.
        this._layoutRunMap(this._lastViewW || 1200, this._lastViewH || 800);
        this.showRunMap = true;
      },
      onRunSetupCancel: () => { this.showRunSetup = false; },
    });
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
  /* DOM-rendered by MenuSystem */
  }

  _drawRefillOverlay(ctx, viewW, viewH) {
  /* DOM-rendered by MenuSystem */
  }

  // ---- Settings overlay ------------------------------------------------
  _layoutSettingsOverlay(viewW, viewH) {
    const panelW = 380, panelH = 300;
    const panelX = (viewW - panelW) / 2;
    const panelY = (viewH - panelH) / 2;
    this.settingsRects.panel = { x: panelX, y: panelY, w: panelW, h: panelH };
    // Music + SFX toggle pills stacked. Each row is a full-width pill
    // so the touch target is generous on phones.
    const rowH = 52;
    const rowGap = 10;
    const rowsTop = panelY + 70;
    this.settingsRects.musicToggle = {
      x: panelX + 24, y: rowsTop,
      w: panelW - 48, h: rowH,
    };
    this.settingsRects.sfxToggle = {
      x: panelX + 24, y: rowsTop + rowH + rowGap,
      w: panelW - 48, h: rowH,
    };
    // Close button bottom-centred.
    this.settingsRects.close = {
      x: panelX + (panelW - 140) / 2, y: panelY + panelH - 60,
      w: 140, h: 44,
    };
  }

  _drawSettingsOverlay(ctx, viewW, viewH) {
  /* DOM-rendered by MenuSystem */
  }

  // Settings toggle row: full-width pill with the option label on the
  // left and an ON / OFF indicator on the right. Filled blue when on,
  // muted red when off — keeps the same visual language as the rest
  // of the chrome.
  _drawAudioToggleRow(ctx, t, label, on) {
  /* DOM-rendered by MenuSystem */
  }

  _drawSettingsButton(ctx) {
  /* DOM-rendered by MenuSystem */
  }

  _clickSettingsOverlay(x, y) {
    if (!this.showSettings) return false;
    if (this._hit(this.settingsRects.close, x, y)) { this.showSettings = false; return true; }
    if (this._hit(this.settingsRects.musicToggle, x, y)) {
      const cur = this._settingsGet();
      this._settingsApply({ musicMuted: !cur.musicMuted });
      return true;
    }
    if (this.settingsRects.sfxToggle && this._hit(this.settingsRects.sfxToggle, x, y)) {
      const cur = this._settingsGet();
      this._settingsApply({ sfxMuted: !cur.sfxMuted });
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
  /* DOM-rendered by MenuSystem — sliders still use canvas */
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
    // Side-tinted accent rule on the outward edge (left=FRIENDLY on left
    // edge; right=ENEMY on right edge) — visually mirrors the HUD
    // side strips at the top of the screen.
    const isLeft = side === "blue";
    ctx.fillStyle = accent;
    if (isLeft) ctx.fillRect(panel.x, panel.y, 3, panel.h);
    else ctx.fillRect(panel.x + panel.w - 3, panel.y, 3, panel.h);

    // Header strip: FRIENDLY / ENEMY label + currently selected race
    // name on the same line. Big, easy to scan.
    const header = sideRects.header;
    ctx.textAlign = "left";
    ctx.fillStyle = accent;
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.fillText(isLeft ? "FRIENDLY" : "ENEMY", header.x + 16, header.y + 22);
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
    ctx.fillText(`${subtotal} UNITS`,
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

  // Called from InputManager.onMove while a slider drag OR a run-map
  // pan is active. Returns true if the move was consumed.
  pointerMove(x, y) {
    if (this._customDrag) {
      this._applySliderValue(this._customDrag.counts, this._customDrag.klass,
                             this._customDrag.row, x);
      return true;
    }
    if (this.showRunMap && this._runMapDrag) {
      this._moveRunMapDrag(x, y);
      return true;
    }
    return false;
  }

  // Called from InputManager.onUp. Ends the active slider drag, or
  // ends a run-map pan and routes the deferred click if the gesture
  // didn't actually drag.
  pointerUp() {
    if (this._customDrag) {
      this._customDrag = null;
      return true;
    }
    if (this.showRunMap && this._runMapDrag) {
      const dragMoved = this._runMapDragMoved;
      const px = this._runMapPressX, py = this._runMapPressY;
      this._endRunMapDrag();
      if (!dragMoved) {
        // No pan happened — treat this as a tap on the press position.
        // _clickRunMap re-checks _runMapDragMoved and short-circuits
        // when it is set, so we clear the flag before routing.
        this._runMapDragMoved = false;
        this._clickRunMap(px, py);
      } else {
        // Suppress the next tap-on-node by leaving the moved flag set
        // until _clickRunMap consumes it. Clear here since the click
        // routing was already skipped.
        this._runMapDragMoved = false;
      }
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
  //
  // Full-screen galaxy backdrop + larger faction emblem cards. The
  // emblems are procedurally rendered roundels (no asset art needed).
  // Each card shows the faction's sigil, name, tagline, and war-record
  // count if the meta-progression has any wins against them.
  _layoutRunSetup(viewW, viewH) {
    // No central panel — we paint over the galaxy directly.
    this.runSetupRects.panel = { x: 0, y: 0, w: viewW, h: viewH };

    const unlocked = (this.runState && this.runState.meta && this.runState.meta.unlockedFactions) || RACE_KEYS;
    const n = unlocked.length;
    // Faction cards: bigger than the old chips, with a stacked emblem
    // + name + tagline layout. Sizes scale to viewport.
    const cardW = Math.min(220, Math.max(160, (viewW - 80) / n - 18));
    const cardH = 280;
    const cardsTotalW = n * cardW + (n - 1) * 18;
    const cardsStartX = (viewW - cardsTotalW) / 2;
    const cardsY = (viewH - cardH) / 2 + 30;
    this.runSetupRects.factionChips = unlocked.map((k, i) => ({
      key: k, label: RACES[k] ? RACES[k].name : k,
      x: cardsStartX + i * (cardW + 18),
      y: cardsY, w: cardW, h: cardH,
    }));

    // Buttons sit at the very bottom of the screen so they don't
    // crowd the cards.
    const btnH = 52, btnW = 180;
    this.runSetupRects.beginBtn = {
      x: viewW / 2 + 12,
      y: cardsY + cardH + 36,
      w: btnW, h: btnH,
    };
    this.runSetupRects.cancelBtn = {
      x: viewW / 2 - btnW - 12,
      y: cardsY + cardH + 36,
      w: btnW, h: btnH,
    };
    // Default selection is the menu's currently-picked race.
    this._runSetupFaction = this.selectedRace;
  }

  _drawRunSetup(ctx, viewW, viewH) {
  /* DOM-rendered by MenuSystem */
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
  //
  // Full-screen FTL-style sector chart. Nodes live in world space at
  // ~1.6x viewport size; the player drags the map to pan around. Top
  // strip carries currencies + act, right strip is the fleet panel.
  // Background is a procedural galaxy (parallax stars + nebula clouds)
  // generated deterministically from the run seed + act.
  _layoutRunMap(viewW, viewH) {
    // World rect: wide enough that capital-end columns sit comfortably
    // off-screen on most viewports, encouraging the player to pan.
    const worldW = Math.max(viewW * 1.55, 1600);
    const worldH = Math.max(viewH * 1.25, 900);
    this._runMapWorldW = worldW;
    this._runMapWorldH = worldH;

    const run = this.runState && this.runState.run;

    // Create the DOM starmap on first open.
    if (!this._starmapControl && run) {
      this._starmapControl = createStarmap(document.body, run);
      setStarmapCallbacks(this._starmapControl, {
        onNodeClick: ({ nodeId, nodeType }) => {
          // Read the freshest run from runState — the closure-captured
          // `run` would otherwise stale out after a resume / new act,
          // routing a clicked event/resupply node through the wrong
          // graph (the same id might be a battle in the captured graph).
          const currentRun = (this.runState && this.runState.run) || run;
          const graph = currentRun.graphs[currentRun.act - 1];
          const node = graph && graph.nodes.find((m) => m.id === nodeId);
          if (node) this._routeNodeClick(node);
        },
        onAbandon: () => {
          if (this.onRunChoice) this.onRunChoice("abandon-run", {});
          this.showRunMap = false;
        },
        onClose: () => {
          this.showRunMap = false;
        },
      });
      this._centerPanOnCurrent(viewW, viewH);
    }

    // Keep layout rects for drag-hit testing.
    this.runMapRects.panel = { x: 0, y: 0, w: viewW, h: viewH };
    const stripH = 60;
    const fleetW = Math.min(320, Math.max(260, viewW * 0.24));
    this.runMapRects.header = { x: 0, y: 0, w: viewW, h: stripH };
    this.runMapRects.fleetPanel = {
      x: viewW - fleetW, y: stripH, w: fleetW, h: viewH - stripH,
    };
    const btnH = 42, btnW = 150;
    this.runMapRects.abandonBtn = {
      x: 20, y: viewH - btnH - 20, w: btnW, h: btnH,
    };
    this.runMapRects.closeBtn = {
      x: viewW - fleetW - btnW - 20, y: viewH - btnH - 20, w: btnW, h: btnH,
    };
  }

  // Centre the map view on the player's current node. Called on first
  // open + when act changes so a fresh layout puts "you are here" in
  // the middle of the screen.
  _centerPanOnCurrent(viewW, viewH) {
    const run = this.runState && this.runState.run;
    if (!run) return;
    if (this._starmapControl) {
      centerOnNode(this._starmapControl, run.nodePos, false);
      // Sync our local pan vars so drag math stays consistent.
      const pan = getPan(this._starmapControl);
      this._runMapPanX = pan.x;
      this._runMapPanY = pan.y;
    }
  }

  _drawRunMap(ctx, viewW, viewH) {
    // The DOM starmap handles all its own rendering.
    // Just sync the latest run data so HUD values stay fresh.
    if (this._starmapControl) {
      const run = this.runState && this.runState.run;
      if (run) updateStarmap(this._starmapControl, run);
    } else {
      // Fallback: dark bg if no starmap yet.
      ctx.fillStyle = "#02040a";
      ctx.fillRect(0, 0, viewW, viewH);
      ctx.textAlign = "center";
      ctx.fillStyle = "#cef";
      ctx.font = "bold 26px system-ui, sans-serif";
      ctx.fillText("NO ACTIVE CAMPAIGN", viewW / 2, viewH / 2);
      ctx.textAlign = "left";
    }
  }

  // Top header strip: act badge on the left, faction admiral label,
  // and credits + fuel chips on the right. Sits over the galaxy so the
  // backdrop is still readable through the chrome.
  _drawRunMapHeader(/* ctx, viewW, viewH, run */) {
    // now DOM-rendered by the starmap — see starmap.js
  }

  _drawCloseFooterBtn(/* ctx */) {
    // now DOM-rendered by the starmap — see starmap.js
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

  _drawFleetPanel(/* ctx, panel, run */) {
    // now DOM-rendered by the starmap — see starmap.js
  }

  // Tiny ship silhouette for the fleet panel. Each klass gets a
  // distinct shape so the player can read the roster at a glance
  // without relying on the text label.
  _drawCapitalGlyph(ctx, cx, cy, r, klass) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = "rgba(170,210,240,0.95)";
    ctx.strokeStyle = "rgba(20,40,60,0.9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    switch (klass) {
      case "fighter": {
        // Forward-pointing dart.
        ctx.moveTo(0, -r);
        ctx.lineTo(r * 0.6, r * 0.5);
        ctx.lineTo(0, r * 0.2);
        ctx.lineTo(-r * 0.6, r * 0.5);
        ctx.closePath();
        break;
      }
      case "bomber": {
        // Wider swept wing.
        ctx.moveTo(0, -r * 0.8);
        ctx.lineTo(r, r * 0.5);
        ctx.lineTo(r * 0.4, r * 0.2);
        ctx.lineTo(0, r * 0.5);
        ctx.lineTo(-r * 0.4, r * 0.2);
        ctx.lineTo(-r, r * 0.5);
        ctx.closePath();
        break;
      }
      case "frigate": {
        // Slim hexagon.
        for (let i = 0; i < 6; i++) {
          const a = -Math.PI / 2 + i * (Math.PI * 2 / 6);
          const px = Math.cos(a) * r * 0.85;
          const py = Math.sin(a) * r * 1.1;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        break;
      }
      case "cruiser": {
        // Pointed prow + flared aft.
        ctx.moveTo(0, -r * 1.2);
        ctx.lineTo(r * 0.7, r * 0.4);
        ctx.lineTo(r * 0.4, r * 0.6);
        ctx.lineTo(-r * 0.4, r * 0.6);
        ctx.lineTo(-r * 0.7, r * 0.4);
        ctx.closePath();
        break;
      }
      case "battleship": {
        // Long lozenge.
        ctx.moveTo(0, -r * 1.3);
        ctx.lineTo(r * 0.5, -r * 0.3);
        ctx.lineTo(r * 0.7, r * 0.4);
        ctx.lineTo(r * 0.4, r * 0.8);
        ctx.lineTo(-r * 0.4, r * 0.8);
        ctx.lineTo(-r * 0.7, r * 0.4);
        ctx.lineTo(-r * 0.5, -r * 0.3);
        ctx.closePath();
        break;
      }
      case "carrier": {
        // Flat-decked rounded rectangle.
        ctx.moveTo(-r * 0.9, -r * 0.5);
        ctx.lineTo(r * 0.9, -r * 0.5);
        ctx.lineTo(r * 0.7, r * 0.7);
        ctx.lineTo(-r * 0.7, r * 0.7);
        ctx.closePath();
        break;
      }
      default: {
        ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2);
      }
    }
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  _capitalName(klass) {
    if (klass === "frigate")    return "Frigate";
    if (klass === "cruiser")    return "Cruiser";
    if (klass === "battleship") return "Battleship";
    if (klass === "carrier")    return "Carrier";
    return klass;
  }

  _clickRunMap(/* x, y */) {
    // handled by DOM starmap — all click routing is in onNodeClick callback
  }

  _routeNodeClick(node) {
    const run = this.runState && this.runState.run;
    if (!run) return;
    if (node.type === "battle" || node.type === "elite" || node.type === "boss") {
      this._pendingBattleNode = node;
      this._layoutBattleChoice(this._lastViewW || 1200, this._lastViewH || 800);
      this.showBattleChoice = true;
    } else if (node.type === "resupply") {
      this._pendingResupplyNode = node;
      this._resupplyBoonOffers = this._pickBoonOffers();
      this._layoutResupply(this._lastViewW || 1200, this._lastViewH || 800);
      this.showResupply = true;
    } else if (node.type === "event") {
      this._pendingEventNode = node;
      this._layoutEvent(this._lastViewW || 1200, this._lastViewH || 800);
      this.showEvent = true;
    }
  }

  // ---- Run map pan + drag --------------------------------------------
  //
  // Drag-to-pan on pointer-down inside the map area (anything outside
  // the fleet panel / header / footer buttons). Pan offset updates on
  // each pointerMove; a moved-flag guards against the release being
  // mis-treated as a node tap.
  _startRunMapDrag(x, y) {
    // Don't start a drag if the pointer landed on chrome.
    if (this._hit(this.runMapRects.fleetPanel, x, y)) return false;
    if (this._hit(this.runMapRects.header, x, y)) return false;
    if (this._hit(this.runMapRects.abandonBtn, x, y)) return false;
    if (this._hit(this.runMapRects.closeBtn, x, y)) return false;
    const pan = this._starmapControl ? getPan(this._starmapControl) : { x: this._runMapPanX, y: this._runMapPanY };
    this._runMapDrag = {
      startX: x, startY: y,
      startPanX: pan.x,
      startPanY: pan.y,
    };
    this._runMapDragMoved = false;
    return true;
  }

  _moveRunMapDrag(x, y) {
    if (!this._runMapDrag) return false;
    const dx = x - this._runMapDrag.startX;
    const dy = y - this._runMapDrag.startY;
    // Threshold of 4px — past this we treat the gesture as a pan and
    // the eventual pointer-up won't fire a node click.
    if (!this._runMapDragMoved && (dx * dx + dy * dy) > 16) {
      this._runMapDragMoved = true;
    }
    if (this._runMapDragMoved && this._starmapControl) {
      const panX = this._runMapDrag.startPanX + dx;
      const panY = this._runMapDrag.startPanY + dy;
      setPan(this._starmapControl, panX, panY);
      // Sync local pan vars for consistency.
      const pan = getPan(this._starmapControl);
      this._runMapPanX = pan.x;
      this._runMapPanY = pan.y;
    }
    return true;
  }

  _endRunMapDrag() {
    this._runMapDrag = null;
  }

  // Tear down the run-map DOM and fire enter-node. main.js#handleRunChoice
  // calls startGame() synchronously, after which game.state flips to
  // "playing" and the draw loop stops calling startMenu.draw(). If we
  // don't clean up here the starmap-root (z-index 10) sits above #game
  // (z-index 5) for the entire battle.
  _launchBattle(battleMode) {
    const node = this._pendingBattleNode;
    if (!node) return;
    this.showBattleChoice = false;
    this.showRunMap = false;
    if (this._starmapControl) {
      destroyStarmap(this._starmapControl);
      this._starmapControl = null;
    }
    if (this._menuSystem) this._menuSystem.hideAll();
    if (this.onRunChoice) {
      this.onRunChoice("enter-node", { nodeId: node.id, battleMode });
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
  /* DOM-rendered by MenuSystem */
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
  /* DOM-rendered by MenuSystem */
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
  /* DOM-rendered by MenuSystem */
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
    this.left = new VirtualStick({ side: "left", color: "#7a9ab0",
      baseEl: document.getElementById("vstick-left-base"),
      knobEl: document.getElementById("vstick-left-knob") });
    this.right = new VirtualStick({ side: "right", color: "#b05040",
      baseEl: document.getElementById("vstick-right-base"),
      knobEl: document.getElementById("vstick-right-knob") });
    this.missileBtn = new MissileButton();
    this.fireBtn = new FireButton();
    this.boostBtn = new BoostButton();
    this.spectateBtn = new SpectateButton();
    this.admiralPanel = new AdmiralPanel();
    this.admiralActive = false; // set from main.js when game.admiralMode
    this._battleHUD = null;
    this.startMenu = new StartMenu();
    this.menuActive = false;

    this.keys = new Set();
    this.mouse = { x: 0, y: 0 };
    this.mouseInside = false;
    this.mouseDown = false;
    this.mouseRightDown = false;
    this._rightClickEdge = false;

    // Multi-touch tracking for pinch zoom. We log every live touch
    // pointer (any pointerType==="touch") so we can detect 2+ active
    // fingers regardless of whether they were claimed by sticks. When
    // two touches are active the per-move handler emits a scalar
    // pendingZoomDelta that the game loop consumes each frame in
    // spectator / admiral mode.
    this._touches = new Map();        // pointerId -> {x, y}
    this._pinchPrevDist = null;
    this._pendingZoomDelta = 0;       // accumulates frame-to-frame

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
    // Scroll-wheel zoom is the desktop equivalent of pinch. Negative
    // deltaY (wheel up) zooms in; we normalise by 500 so a typical
    // 100px wheel notch becomes a +0.2 zoom delta.
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this._pendingZoomDelta += -e.deltaY / 500;
    }, { passive: false });
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

  // Called from main.js#resize() on first paint and on every window
  // resize. The DOM/HUD overhaul moved most chrome into the DOM, but the
  // canvas hit-test rects on missile/fire/spectate + the admiral panel +
  // the start-menu layout still need pixel positions tied to viewport
  // size. Without this method main.js crashes on startup -> black screen.
  layoutOverlays(viewW, viewH) {
    this.missileBtn.layout(viewW, viewH);
    this.fireBtn.layout(viewW, viewH);
    this.spectateBtn.layout(viewW, viewH);
    this.startMenu.layout(viewW, viewH);
    this.admiralPanel.layout(viewW, viewH);
  }

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onDown(e) {
    e.preventDefault();
    const { x, y } = this.pos(e);
    // Mouse-tracking layer only listens to real mouse pointers — touch
    // events route exclusively through the virtual sticks and on-screen
    // action buttons.
    if (e.pointerType !== "touch") {
      this.mouse.x = x; this.mouse.y = y; this.mouseInside = true;
    } else {
      // Track every touch pointer for pinch detection. A second active
      // touch seeds the pinch baseline distance; the per-move handler
      // emits a zoom delta from changes to that distance.
      this._touches.set(e.pointerId, { x, y });
      if (this._touches.size === 2) {
        this._pinchPrevDist = this._touchDistance();
      }
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
    if (this.boostBtn.hit(x, y)) {
      this.canvas.setPointerCapture(e.pointerId);
      this.boostBtn.start(e.pointerId);
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
    } else if (this._touches.has(e.pointerId)) {
      // Update the tracked touch position; if two fingers are down,
      // emit a zoom delta from the change in inter-finger distance.
      const t = this._touches.get(e.pointerId);
      t.x = x; t.y = y;
      if (this._touches.size === 2) {
        const newDist = this._touchDistance();
        if (this._pinchPrevDist && newDist > 0) {
          this._pendingZoomDelta += (newDist / this._pinchPrevDist) - 1;
        }
        this._pinchPrevDist = newDist;
      }
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
    if (e.pointerType === "touch" && this._touches.has(e.pointerId)) {
      this._touches.delete(e.pointerId);
      // Less than two fingers — drop the pinch baseline so the next
      // two-finger gesture starts fresh instead of jumping.
      if (this._touches.size < 2) this._pinchPrevDist = null;
    }
    if (this.menuActive) {
      this.startMenu.pointerUp();
      return;
    }
    if (this.left.pointerId === e.pointerId) this.left.end();
    else if (this.right.pointerId === e.pointerId) this.right.end();
    if (this.missileBtn.pointerId === e.pointerId) this.missileBtn.end();
    if (this.fireBtn.pointerId === e.pointerId) this.fireBtn.end();
    if (this.spectateBtn.pointerId === e.pointerId) this.spectateBtn.end();
    if (this.boostBtn.pointerId === e.pointerId) this.boostBtn.end();
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

  // Scalar zoom delta accumulated since the last consume call. Pinch
  // gestures + scroll wheel both feed this; the game loop reads it
  // each frame in spectator / admiral mode and applies it to the
  // camera zoom. Touch baseline distance is preserved across the
  // consume so a continuing pinch keeps adjusting smoothly.
  consumePinchDelta() {
    const d = this._pendingZoomDelta;
    this._pendingZoomDelta = 0;
    return d;
  }

  // Euclidean distance between the two oldest tracked touches. Returns
  // 0 if fewer than two touches are live. Only valid while
  // _touches.size === 2 — callers gate on that.
  _touchDistance() {
    const it = this._touches.values();
    const a = it.next().value;
    const b = it.next().value;
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
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

    const boosting = this.keys.has("Space") || this.boostBtn.pressed
                  || this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");

    return { thrust, aim, firing, boosting };
  }

  drawSticks(ctx) {
    this.left._updateDOM();
    this.right._updateDOM();
  }
}
