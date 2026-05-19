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

// On-screen missile button (top-right). Touch-friendly. Mouse also works.
export class MissileButton {
  constructor() {
    this.pointerId = null;
    this.pressed = false;
    this.justPressed = false;
    this.rect = { x: 0, y: 0, w: 90, h: 60 };
  }
  layout(viewW, viewH) {
    this.rect.x = viewW - this.rect.w - 18;
    this.rect.y = viewH - this.rect.h - 70;
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

// Pre-match menu: lets the player pick a game mode, ship class, allied
// race, and map size before the world spawns. Selections persist via
// SaveStore so re-opening the menu restores the last pick.
//
// Layout: four rows of chips plus an explicit START button. Each chip
// toggles its row's selection; START emits the chosen options bundle.
const CLASS_ORDER = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier"];

export class StartMenu {
  constructor() {
    this.modeRects = [];
    this.classRects = [];
    this.sizeRects = [];
    this.raceRects = [];
    this.startRect = null;
    const sel = saveStore.get().menuSelection;
    this.selectedMode = MODES[sel.mode] ? sel.mode : "arena";
    this.selectedKlass = CLASSES[sel.klass] ? sel.klass : "fighter";
    this.selectedSize = sel.mapSize || "medium";
    this.selectedRace = RACES[sel.race] ? sel.race : "terran";
    this.justStarted = null;
  }

  layout(viewW, viewH) {
    const chipH = 50;
    const gapX = 12;
    const rowGap = 22;
    const titleY = Math.max(60, viewH / 2 - 260);

    // Mode row.
    const modeKeys = MODE_KEYS;
    const mn = modeKeys.length;
    const modeBtnW = Math.min(160, (viewW - 60) / mn - gapX);
    const modeRowW = mn * modeBtnW + (mn - 1) * gapX;
    const modeY = titleY + 80;
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
    const classY = modeY + chipH + rowGap + 16;
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
    const sizeY = classY + chipH + rowGap + 16;
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
    const raceY = sizeY + chipH + rowGap + 16;
    const raceStartX = (viewW - raceRowW) / 2;
    this.raceRects = raceKeys.map((k, i) => ({
      key: k, label: RACES[k].name,
      x: raceStartX + i * (raceBtnW + gapX),
      y: raceY, w: raceBtnW, h: chipH,
    }));

    // START button.
    const startW = 220, startH = 56;
    this.startRect = {
      x: (viewW - startW) / 2,
      y: raceY + chipH + 40,
      w: startW, h: startH,
    };
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
      data.menuSelection.mapSize = this.selectedSize;
    });
  }

  _hit(r, x, y) {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  _emitStart() {
    const size = this.sizeRects.find((r) => r.key === this.selectedSize)
              || this.sizeRects[0];
    this.justStarted = {
      mode: this.selectedMode,
      klass: this.selectedKlass,
      race: this.selectedRace,
      mapW: size.mapW,
      mapH: size.mapH,
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

    ctx.textAlign = "left";
    ctx.restore();
  }

  _drawChip(ctx, r, selected, label, sublabel) {
    ctx.fillStyle = selected ? "rgba(40,90,140,0.95)" : "rgba(20,40,60,0.85)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = selected ? "#fff" : "#7df";
    ctx.lineWidth = selected ? 3 : 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = "#cef";
    ctx.font = "bold 15px system-ui, sans-serif";
    ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 - 1);
    if (sublabel) {
      ctx.font = "10px system-ui, sans-serif";
      ctx.fillStyle = "#9bd";
      ctx.fillText(sublabel, r.x + r.w / 2, r.y + r.h / 2 + 14);
    }
  }
}

export class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.left = new VirtualStick({ side: "left", color: "#5cf" });
    this.right = new VirtualStick({ side: "right", color: "#f76" });
    this.missileBtn = new MissileButton();
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
    canvas.addEventListener("pointerenter", () => { this.mouseInside = true; });
    canvas.addEventListener("pointerleave", () => { this.mouseInside = false; });
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
    this.startMenu.layout(viewW, viewH);
  }

  onDown(e) {
    e.preventDefault();
    const { x, y } = this.pos(e);
    this.mouse.x = x; this.mouse.y = y; this.mouseInside = true;

    // Pre-match menu: route the click to size-selection and swallow
    // everything else.
    if (this.menuActive) {
      this.startMenu.click(x, y);
      return;
    }

    // Missile button hit-test first — works for both touch and mouse.
    if (this.missileBtn.hit(x, y)) {
      this.canvas.setPointerCapture(e.pointerId);
      this.missileBtn.start(e.pointerId);
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
    this.mouse.x = x; this.mouse.y = y;
    if (this.left.pointerId === e.pointerId) this.left.move(x, y);
    else if (this.right.pointerId === e.pointerId) this.right.move(x, y);
  }
  onUp(e) {
    if (this.left.pointerId === e.pointerId) this.left.end();
    else if (this.right.pointerId === e.pointerId) this.right.end();
    if (this.missileBtn.pointerId === e.pointerId) this.missileBtn.end();
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

  consumeSpectateToggle()  { return this._consumeKey("KeyV", "_vLatched"); }
  consumeSpectateNext()    { return this._consumeKey("KeyN", "_nLatched"); }
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

    let aim;
    if (touchAimLen > 0) aim = touchAim;
    else if (mouseAim) aim = mouseAim;
    else if (kLen > 0) aim = kbThrust;
    else aim = null;

    const firing = this.keys.has("Enter") || this.keys.has("Space")
                || this.mouseDown || touchAimLen > 0;

    return { thrust, aim, firing };
  }

  drawSticks(ctx) {
    this.left.draw(ctx);
    this.right.draw(ctx);
  }
}
