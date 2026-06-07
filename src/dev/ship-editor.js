/**
 * @file Ship Editor — free-form custom-ship authoring surface (dev-gated).
 *
 * Unlike the slot-picker Ship Designer, this draws a hull outline, auto-fills a
 * block grid, drops fully-custom modules with editable stats + firing arcs,
 * scales fighter→mothership, saves to a named library, and test-flies the
 * result in a sandbox. The authored doc (customships/format.js) is lowered by
 * compileCustomShip into createShip's existing shape, so the whole engine
 * pipeline is reused unchanged.
 *
 * Mobile-first: one scrollable fullscreen overlay, a pan/pinch-zoom canvas,
 * draggable/closable stat popups, and debounced autosave on every mutation.
 *
 * CLAUDE.md gotchas honored: the panel sets explicit `flex-direction: column`
 * (the base flex rule is row); SVG/HTML class writes use classList/setAttribute,
 * never `.className` on SVG; global box-sizing:border-box is already reset.
 */

import { getHull } from "../ship.js";
import { buildCells, scaledCellGrid } from "../sprites.js";
import {
  blankCustomShip, validateCustomShip, serializeCustomShip, parseCustomShip,
  blankModule, fallbackHull, TIERS, MODULE_TYPES, MODULE_DEFAULTS,
} from "../customships/format.js";
import {
  listCustomShips, saveCustomShip, deleteCustomShip, saveCustomShipDebounced, flushCustomShipSave,
} from "../customships/store.js";
import { blankCustomModule, instantiateLibraryModule } from "../custommodules/format.js";
import { listCustomModules as listLibModules, saveCustomModule as saveLibModule, deleteCustomModule as delLibModule } from "../custommodules/store.js";

const TIER_LABELS = {
  fighter: "Fighter", bomber: "Bomber", frigate: "Frigate", cruiser: "Cruiser",
  battleship: "Battleship", carrier: "Carrier", station: "Station", mothership: "Mothership",
};
const MODULE_LABELS = {
  forwardGun: "Fwd Gun", ring: "Ring", broadside: "Broadside", heavyLaser: "Laser",
  missilePod: "Missile", pd: "PD", engine: "Engine", shieldGenerator: "Shield", hangar: "Hangar",
};
const MODULE_GLYPH = {
  forwardGun: "▲", ring: "◎", broadside: "▤", heavyLaser: "✦",
  missilePod: "◆", pd: "•", engine: "►", shieldGenerator: "⬡", hangar: "▭",
};
const MODULE_COLOR = {
  forwardGun: "#f55", ring: "#f80", broadside: "#e44", heavyLaser: "#4dd",
  missilePod: "#dd4", pd: "#4ad", engine: "#f72", shieldGenerator: "#6cf", hangar: "#9c6",
};
const RACES = ["terran", "reavers", "hegemony", "voidsworn", "thren", "brood", "vanguard", "saurian", "synthetic"];

export class ShipEditor {
  constructor(host, deps) {
    // deps: { onTestFly(design), onClose() }
    this.host = host;
    this.deps = deps || {};
    this._draft = blankCustomShip({ name: "New Custom Ship", tier: "frigate" });
    this._visible = false;
    // Canvas view state (unit-hull space → screen): center + zoom + pan.
    this._zoom = 1;
    this._pan = { x: 0, y: 0 };
    this._tool = "draw";          // draw | move | place
    this._placeType = "forwardGun";
    this._drawPts = [];           // half-profile vertices [x,y] (y>=0), nose→tail
    this._selectedModule = -1;    // index into _draft.modules, -1 = none
    this._cellPreview = null;     // cached buildCells result for the current hull/scale
    this._panelPos = null;        // remembered stat-panel position (draggable)
    this._mount();
  }

  _mount() {
    const el = document.createElement("div");
    el.id = "ship-editor";
    el.className = "ship-editor hidden";
    el.innerHTML = `
      <div class="se-panel">
        <header class="se-header">
          <span class="se-title">SHIP EDITOR</span>
          <button class="se-x" id="se-close" title="Close">✕</button>
        </header>
        <section class="se-meta">
          <label class="se-field"><span>NAME</span><input id="se-name" type="text" maxlength="60" /></label>
          <label class="se-field se-field-tight"><span>TIER</span><select id="se-tier"></select></label>
          <label class="se-field se-field-tight"><span>RACE</span><select id="se-race"></select></label>
          <label class="se-field se-field-tight"><span>SCALE</span>
            <input id="se-scale" type="range" min="40" max="300" step="5" value="100" />
            <span id="se-scale-val">1.00×</span>
          </label>
        </section>
        <section class="se-tools">
          <button class="se-tool" data-tool="draw">✎ DRAW HULL</button>
          <button class="se-tool" data-tool="place">＋ MODULE</button>
          <button class="se-tool" data-tool="move">✥ MOVE/ZOOM</button>
          <span class="se-tool-sep"></span>
          <button class="se-mini" id="se-close-hull">CLOSE HULL</button>
          <button class="se-mini" id="se-clear-hull">CLEAR</button>
          <button class="se-mini" id="se-tier-hull">USE TIER HULL</button>
          <button class="se-mini" id="se-zoom-fit">FIT</button>
        </section>
        <section class="se-stage">
          <canvas class="se-canvas" id="se-canvas" width="640" height="420"></canvas>
          <div class="se-palette" id="se-palette"></div>
        </section>
        <section class="se-durability">
          <label class="se-field se-field-tight"><span>HULL HP</span><input id="se-hp" type="number" min="1" step="10" /></label>
          <label class="se-field se-field-tight"><span>SHIELD</span><input id="se-shield" type="number" min="0" step="25" placeholder="none" /></label>
          <label class="se-field se-field-tight"><span>CELL HP</span><input id="se-cellhp" type="number" min="1" step="1" /></label>
          <label class="se-field se-field-tight"><span>CELL ARMOR</span>
            <input id="se-cellarmor" type="range" min="0" max="90" step="5" value="10" />
            <span id="se-cellarmor-val">0.10</span>
          </label>
          <span class="se-hint" id="se-hint"></span>
        </section>
        <section class="se-library">
          <h3>SAVED CUSTOM SHIPS</h3>
          <div class="se-library-list" id="se-library-list"></div>
        </section>
        <footer class="se-footer">
          <button class="se-btn" id="se-new">NEW</button>
          <button class="se-btn" id="se-import">IMPORT</button>
          <button class="se-btn" id="se-export">EXPORT</button>
          <button class="se-btn se-btn-primary" id="se-save">SAVE</button>
          <button class="se-btn se-btn-fly" id="se-testfly">TEST FLY ▸</button>
        </footer>
        <div class="se-toast" id="se-toast"></div>
      </div>
    `;
    this.host.appendChild(el);
    this._el = el;
    const $ = (id) => el.querySelector(id);
    this._nameEl = $("#se-name");
    this._tierEl = $("#se-tier");
    this._raceEl = $("#se-race");
    this._scaleEl = $("#se-scale");
    this._scaleValEl = $("#se-scale-val");
    this._canvas = $("#se-canvas");
    this._paletteEl = $("#se-palette");
    this._hpEl = $("#se-hp");
    this._shieldEl = $("#se-shield");
    this._cellHpEl = $("#se-cellhp");
    this._cellArmorEl = $("#se-cellarmor");
    this._cellArmorValEl = $("#se-cellarmor-val");
    this._hintEl = $("#se-hint");
    this._libraryListEl = $("#se-library-list");
    this._toastEl = $("#se-toast");

    for (const t of TIERS) {
      const o = document.createElement("option");
      o.value = t; o.textContent = TIER_LABELS[t] || t;
      this._tierEl.appendChild(o);
    }
    for (const r of RACES) {
      const o = document.createElement("option");
      o.value = r; o.textContent = r.toUpperCase();
      this._raceEl.appendChild(o);
    }

    // ---- Meta inputs (each mutation autosaves) ----
    this._nameEl.addEventListener("input", () => { this._draft.name = this._nameEl.value; this._autosave(); });
    this._tierEl.addEventListener("change", () => {
      this._draft.tier = this._tierEl.value;
      // A blank hull on tier change keeps the old outline; only refit the cell
      // preview (cell grid is tier-keyed). Author can hit USE TIER HULL to swap.
      this._invalidateCells();
      this._renderAll();
      this._autosave();
    });
    this._raceEl.addEventListener("change", () => { this._draft.race = this._raceEl.value; this._invalidateCells(); this._renderCanvas(); this._autosave(); });
    this._scaleEl.addEventListener("input", () => {
      this._draft.scaleMul = Number(this._scaleEl.value) / 100;
      this._scaleValEl.textContent = `${this._draft.scaleMul.toFixed(2)}×`;
      this._invalidateCells();
      this._renderCanvas();
      this._autosave();
    });
    this._hpEl.addEventListener("input", () => { this._draft.hp = Math.max(1, Number(this._hpEl.value) || 1); this._autosave(); });
    this._shieldEl.addEventListener("input", () => {
      const v = this._shieldEl.value.trim();
      this._draft.shield = v === "" ? null : Math.max(0, Number(v) || 0);
      this._autosave();
    });
    this._cellHpEl.addEventListener("input", () => { this._draft.cellHp = Math.max(1, Number(this._cellHpEl.value) || 1); this._autosave(); });
    this._cellArmorEl.addEventListener("input", () => {
      this._draft.cellArmor = Number(this._cellArmorEl.value) / 100;
      this._cellArmorValEl.textContent = this._draft.cellArmor.toFixed(2);
      this._autosave();
    });

    // ---- Tool selector ----
    for (const b of el.querySelectorAll(".se-tool")) {
      b.addEventListener("click", () => { this._setTool(b.dataset.tool); });
    }
    $("#se-close-hull").addEventListener("click", () => this._closeHull());
    $("#se-clear-hull").addEventListener("click", () => { this._drawPts = []; this._renderCanvas(); });
    $("#se-tier-hull").addEventListener("click", () => {
      this._draft.hullPoly = fallbackHull(this._draft.tier);
      this._drawPts = [];
      this._invalidateCells();
      this._renderCanvas();
      this._autosave();
      this._toast("loaded tier hull");
    });
    $("#se-zoom-fit").addEventListener("click", () => { this._zoom = 1; this._pan = { x: 0, y: 0 }; this._renderCanvas(); });

    $("#se-close").addEventListener("click", () => this.hide());
    $("#se-new").addEventListener("click", () => this._new());
    $("#se-save").addEventListener("click", () => this._save());
    $("#se-export").addEventListener("click", () => this._export());
    $("#se-import").addEventListener("click", () => this._import());
    $("#se-testfly").addEventListener("click", () => this._testFly());

    this._buildPalette();
    this._wireCanvas();
  }

  // ---- Lifecycle -----------------------------------------------------------
  isVisible() { return this._visible; }
  show() { this._visible = true; this._el.classList.remove("hidden"); this._renderAll(); }
  hide() {
    this._visible = false;
    this._el.classList.add("hidden");
    flushCustomShipSave();
    if (this.deps.onClose) this.deps.onClose();
  }
  toggle() { if (this._visible) this.hide(); else this.show(); }

  loadDraft(doc) {
    const res = validateCustomShip(doc);
    if (!res.value) { this._toast("load failed", true); return false; }
    this._draft = JSON.parse(JSON.stringify(res.value));
    this._drawPts = [];
    this._selectedModule = -1;
    this._invalidateCells();
    if (this._visible) this._renderAll();
    return true;
  }
  getDraft() { return JSON.parse(JSON.stringify(this._draft)); }

  // ---- Tool / palette ------------------------------------------------------
  _setTool(tool) {
    this._tool = tool;
    for (const b of this._el.querySelectorAll(".se-tool")) {
      b.classList.toggle("active", b.dataset.tool === tool);
    }
    this._paletteEl.classList.toggle("se-palette-open", tool === "place");
    this._updateHint();
    this._renderCanvas();
  }

  _buildPalette() {
    this._paletteEl.innerHTML = "";
    const builtinHdr = document.createElement("div");
    builtinHdr.className = "se-palette-hdr";
    builtinHdr.textContent = "TYPES";
    this._paletteEl.appendChild(builtinHdr);
    for (const type of MODULE_TYPES) {
      const b = document.createElement("button");
      b.className = "se-pal-item";
      b.dataset.type = type;
      b.style.borderColor = MODULE_COLOR[type];
      b.innerHTML = `<span class="se-pal-glyph" style="color:${MODULE_COLOR[type]}">${MODULE_GLYPH[type]}</span><span>${MODULE_LABELS[type]}</span>`;
      b.addEventListener("click", () => { this._placeType = type; this._placeLibRef = null; this._setTool("place"); this._syncPalette(); });
      this._paletteEl.appendChild(b);
    }
    // Saved library modules (reusable across ships).
    const lib = listLibModules();
    const libHdr = document.createElement("div");
    libHdr.className = "se-palette-hdr";
    libHdr.textContent = `LIBRARY (${lib.length})`;
    this._paletteEl.appendChild(libHdr);
    for (const rec of lib) {
      const b = document.createElement("button");
      b.className = "se-pal-item se-pal-lib";
      b.style.borderColor = MODULE_COLOR[rec.type] || "#789";
      b.innerHTML = `<span class="se-pal-glyph" style="color:${MODULE_COLOR[rec.type] || "#789"}">${MODULE_GLYPH[rec.type] || "?"}</span><span>${rec.name}</span>`;
      b.addEventListener("click", () => { this._placeType = rec.type; this._placeLibRef = rec; this._setTool("place"); this._syncPalette(); });
      const del = document.createElement("button");
      del.className = "se-pal-del"; del.textContent = "✕"; del.title = "delete library module";
      del.addEventListener("click", (e) => { e.stopPropagation(); if (delLibModule(rec.id)) { this._buildPalette(); this._toast("deleted library module"); } });
      b.appendChild(del);
      this._paletteEl.appendChild(b);
    }
    this._syncPalette();
  }
  _syncPalette() {
    for (const b of this._paletteEl.querySelectorAll(".se-pal-item")) {
      const isLib = b.classList.contains("se-pal-lib");
      const match = !isLib && b.dataset.type === this._placeType && !this._placeLibRef;
      b.classList.toggle("active", match);
    }
  }

  // ---- Hull drawing --------------------------------------------------------
  _closeHull() {
    if (this._drawPts.length < 2) { this._toast("tap a few points along the top edge first", true); return; }
    const poly = mirrorHalfProfile(this._drawPts);
    const probe = validateCustomShip({ ...this._draft, hullPoly: poly });
    // validateCustomShip repairs-or-falls-back; if the drawn outline was bad it
    // returns the tier fallback. Surface that so the author knows to redraw.
    const usedFallback = probe.errors.some((e) => /hullPoly/.test(e));
    this._draft.hullPoly = probe.value.hullPoly;
    this._drawPts = [];
    this._invalidateCells();
    this._renderCanvas();
    this._autosave();
    this._toast(usedFallback ? "outline invalid — used tier fallback (redraw nose→tail)" : "hull closed", usedFallback);
  }

  // ---- Canvas --------------------------------------------------------------
  _invalidateCells() { this._cellPreview = null; }
  _ensureCells() {
    if (this._cellPreview) return this._cellPreview;
    const poly = this._draft.hullPoly || fallbackHull(this._draft.tier);
    // R is a nominal preview radius; cell.lx/ly come back scaled by R, so we
    // divide by R to get unit-space when drawing. Resolution (cols/rows) +
    // culling are R-independent, so this is faithful to the spawned grid.
    const scaleMul = this._draft.scaleMul || 1;
    const R = 100 * scaleMul;
    // Same scale-aware grid the compiler bakes into the spawned ship, so the
    // preview densifies with scale (constant block size) and matches what flies.
    const gridOv = scaledCellGrid(this._draft.tier, scaleMul, this._draft.race);
    let grid = null;
    try { grid = buildCells(this._draft.tier, R, this._draft.race, poly, gridOv); } catch (_e) { grid = null; }
    this._cellPreview = grid ? { grid, R } : null;
    return this._cellPreview;
  }

  // unit-hull coord → screen px
  _toScreen(ux, uy) {
    const c = this._canvas;
    const base = (Math.min(c.width, c.height) - 56) / 2;
    const s = base * this._zoom;
    return { x: c.width / 2 + this._pan.x + ux * s, y: c.height / 2 + this._pan.y + uy * s };
  }
  // screen px → unit-hull coord
  _toUnit(sx, sy) {
    const c = this._canvas;
    const base = (Math.min(c.width, c.height) - 56) / 2;
    const s = base * this._zoom;
    return { x: (sx - c.width / 2 - this._pan.x) / s, y: (sy - c.height / 2 - this._pan.y) / s };
  }
  _canvasPoint(ev) {
    const rect = this._canvas.getBoundingClientRect();
    const t = ev.touches && ev.touches[0] ? ev.touches[0] : ev;
    const scaleX = this._canvas.width / rect.width;
    const scaleY = this._canvas.height / rect.height;
    return { x: (t.clientX - rect.left) * scaleX, y: (t.clientY - rect.top) * scaleY };
  }

  _wireCanvas() {
    const c = this._canvas;
    let dragging = null;     // 'pan' | 'module' | null
    let last = null;
    let pinchDist = null;
    let moved = false;

    const onDown = (ev) => {
      if (ev.touches && ev.touches.length === 2) {
        pinchDist = touchDist(ev);
        dragging = null;
        return;
      }
      const p = this._canvasPoint(ev);
      last = p; moved = false;
      const u = this._toUnit(p.x, p.y);
      if (this._tool === "place") {
        // Tap an existing module to select; otherwise drop a new one.
        const hit = this._moduleAt(u);
        if (hit >= 0) { this._selectedModule = hit; this._openModulePanel(); dragging = "module"; }
        else { this._placeModule(u); dragging = "module"; }
      } else if (this._tool === "draw") {
        dragging = "draw";
      } else {
        dragging = "pan";
      }
      ev.preventDefault();
    };
    const onMove = (ev) => {
      if (ev.touches && ev.touches.length === 2 && pinchDist != null) {
        const d = touchDist(ev);
        if (d > 0 && pinchDist > 0) { this._zoom = clamp(this._zoom * (d / pinchDist), 0.3, 6); this._renderCanvas(); }
        pinchDist = d;
        ev.preventDefault();
        return;
      }
      if (!dragging) return;
      const p = this._canvasPoint(ev);
      const dx = p.x - last.x, dy = p.y - last.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      if (dragging === "pan") { this._pan.x += dx; this._pan.y += dy; this._renderCanvas(); }
      else if (dragging === "module" && this._selectedModule >= 0 && moved) {
        const u = this._toUnit(p.x, p.y);
        const m = this._draft.modules[this._selectedModule];
        if (m) { m.offset.x = clamp(u.x, -1.2, 1.2); m.offset.y = clamp(u.y, -1.2, 1.2); this._renderCanvas(); this._syncModulePanel(); }
      }
      last = p;
      ev.preventDefault();
    };
    const onUp = (ev) => {
      if (dragging === "draw" && !moved) {
        const p = this._canvasPoint(ev);
        const u = this._toUnit(p.x, p.y);
        // Half-profile: force y to the top half; clamp to the unit box.
        this._drawPts.push([clamp(u.x, -1, 1), clamp(Math.abs(u.y), 0, 0.95)]);
        this._renderCanvas();
      } else if (dragging === "module" && moved) {
        this._autosave();
      }
      dragging = null; pinchDist = null;
    };

    c.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    c.addEventListener("touchstart", onDown, { passive: false });
    c.addEventListener("touchmove", onMove, { passive: false });
    c.addEventListener("touchend", onUp);
    c.addEventListener("wheel", (ev) => { this._zoom = clamp(this._zoom * (ev.deltaY < 0 ? 1.1 : 0.9), 0.3, 6); this._renderCanvas(); ev.preventDefault(); }, { passive: false });
  }

  _moduleAt(u) {
    // Nearest module within a tap radius (unit space).
    let best = -1, bestD = 0.09 * 0.09;
    this._draft.modules.forEach((m, i) => {
      const dx = m.offset.x - u.x, dy = m.offset.y - u.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }
  _placeModule(u) {
    let mod;
    if (this._placeLibRef) mod = instantiateLibraryModule(this._placeLibRef, { x: u.x, y: u.y });
    else mod = blankModule(this._placeType, { x: clamp(u.x, -1.2, 1.2), y: clamp(u.y, -1.2, 1.2) });
    if (!mod) return;
    this._draft.modules.push(mod);
    this._selectedModule = this._draft.modules.length - 1;
    this._renderCanvas();
    this._openModulePanel();
    this._autosave();
  }

  _renderCanvas() {
    const c = this._canvas;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#05080e";
    ctx.fillRect(0, 0, c.width, c.height);

    // Block grid (autofill) under the hull line.
    const cp = this._ensureCells();
    if (cp) {
      const { grid, R } = cp;
      const cw = (grid.cellW / R), ch = (grid.cellH / R);
      for (const cell of grid.cells) {
        if (cell.culled) continue;
        const s0 = this._toScreen(cell.lx / R - cw / 2, cell.ly / R - ch / 2);
        const s1 = this._toScreen(cell.lx / R + cw / 2, cell.ly / R + ch / 2);
        ctx.fillStyle = cell.isCore ? "rgba(120,200,255,0.55)" : "rgba(40,80,130,0.45)";
        ctx.fillRect(s0.x, s0.y, Math.max(1, s1.x - s0.x - 0.5), Math.max(1, s1.y - s0.y - 0.5));
      }
    }

    // Hull outline (committed) or the in-progress half-profile.
    const poly = this._draft.hullPoly;
    if (poly && poly.length >= 3) {
      ctx.beginPath();
      poly.forEach(([x, y], i) => { const s = this._toScreen(x, y); i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y); });
      ctx.closePath();
      ctx.strokeStyle = "rgba(170,210,250,0.95)"; ctx.lineWidth = 1.5; ctx.stroke();
    }
    if (this._drawPts.length) {
      ctx.beginPath();
      const axis = this._toScreen(this._drawPts[0][0], 0);
      this._drawPts.forEach(([x, y], i) => { const s = this._toScreen(x, y); i === 0 ? ctx.moveTo(s.x, s.y) : ctx.lineTo(s.x, s.y); });
      ctx.strokeStyle = "rgba(120,255,160,0.95)"; ctx.lineWidth = 1.5; ctx.stroke();
      for (const [x, y] of this._drawPts) { const s = this._toScreen(x, y); ctx.fillStyle = "#7fffa0"; ctx.beginPath(); ctx.arc(s.x, s.y, 3, 0, Math.PI * 2); ctx.fill(); }
    }
    // Centre axis guide.
    const a0 = this._toScreen(-1.1, 0), a1 = this._toScreen(1.1, 0);
    ctx.strokeStyle = "rgba(120,160,210,0.25)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a0.x, a0.y); ctx.lineTo(a1.x, a1.y); ctx.stroke();

    // Modules (dots, colored by type; selected gets a ring + arc wedge).
    this._draft.modules.forEach((m, i) => {
      const s = this._toScreen(m.offset.x, m.offset.y);
      const col = MODULE_COLOR[m.type] || "#ccc";
      // Firing-arc wedge for the selected module (visual only here; the engine
      // gates ring/broadside/laser on arc, and the optional forward-gun gate).
      if (i === this._selectedModule && typeof m.arc === "number") {
        const facing = m.offset.x >= 0 ? 0 : Math.PI; // forward-ish vs aft-ish
        const r = (Math.min(c.width, c.height) - 56) / 2 * this._zoom * 0.55;
        ctx.beginPath(); ctx.moveTo(s.x, s.y);
        ctx.arc(s.x, s.y, r, facing - m.arc, facing + m.arc);
        ctx.closePath(); ctx.fillStyle = hexA(col, 0.18); ctx.fill();
      }
      ctx.beginPath(); ctx.arc(s.x, s.y, i === this._selectedModule ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      if (i === this._selectedModule) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
      ctx.fillStyle = "rgba(0,0,0,0.8)"; ctx.font = "8px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(MODULE_GLYPH[m.type] || "?", s.x, s.y + 0.5);
    });
    ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
  }

  // ---- Selected-module stat panel (draggable/closable) ---------------------
  _openModulePanel() {
    this._closeModulePanel();
    const m = this._draft.modules[this._selectedModule];
    if (!m) return;
    const panel = document.createElement("div");
    panel.className = "se-modpanel";
    panel.innerHTML = `
      <header class="se-modpanel-head">
        <span class="se-modpanel-title" id="se-modpanel-title">${m.name || MODULE_LABELS[m.type] || m.type}</span>
        <button class="se-modpanel-x" title="close">✕</button>
      </header>
      <div class="se-modpanel-body" id="se-modpanel-body"></div>
      <footer class="se-modpanel-foot">
        <button class="se-mini" id="se-mod-save-lib">SAVE TO LIBRARY</button>
        <button class="se-mini se-mod-del" id="se-mod-del">DELETE</button>
      </footer>
    `;
    this._el.appendChild(panel);
    this._modPanel = panel;
    const pos = this._panelPos || { x: 16, y: 90 };
    panel.style.left = pos.x + "px"; panel.style.top = pos.y + "px";
    panel.querySelector(".se-modpanel-x").addEventListener("click", () => this._closeModulePanel());
    panel.querySelector("#se-mod-del").addEventListener("click", () => {
      this._draft.modules.splice(this._selectedModule, 1);
      this._selectedModule = -1; this._closeModulePanel(); this._renderCanvas(); this._autosave();
    });
    panel.querySelector("#se-mod-save-lib").addEventListener("click", () => {
      // Prompt for the library name, prefilled with the module's own name (or
      // type label). Empty/cancel aborts so a stray module can't land unnamed.
      const suggested = m.name || `${MODULE_LABELS[m.type]} ${Date.now().toString(36).slice(-3)}`;
      const name = (window.prompt("Name this library module:", suggested) || "").trim();
      if (!name) return;
      const rec = blankCustomModule({ type: m.type, name });
      rec.hp = m.hp; rec.hullPenalty = m.hullPenalty; rec.armor = m.armor; rec.arc = m.arc;
      rec.stats = JSON.parse(JSON.stringify(m.stats)); rec.projectile = m.projectile ? JSON.parse(JSON.stringify(m.projectile)) : null;
      try { saveLibModule(rec); this._buildPalette(); this._toast(`saved "${name}" to library`); } catch (e) { this._toast("save failed: " + e.message, true); }
    });
    makeDraggable(panel, panel.querySelector(".se-modpanel-head"), (x, y) => { this._panelPos = { x, y }; });
    this._renderModulePanelBody();
  }
  _renderModulePanelBody() {
    const m = this._draft.modules[this._selectedModule];
    const body = this._modPanel && this._modPanel.querySelector("#se-modpanel-body");
    if (!m || !body) return;
    body.innerHTML = "";
    const def = MODULE_DEFAULTS[m.type];
    const addNum = (label, get, set, step = 1, min = 0) => {
      const row = document.createElement("label"); row.className = "se-modrow";
      row.innerHTML = `<span>${label}</span>`;
      const inp = document.createElement("input"); inp.type = "number"; inp.step = String(step); inp.min = String(min);
      inp.value = String(get());
      inp.addEventListener("input", () => { set(Number(inp.value)); this._renderCanvas(); this._autosave(); });
      row.appendChild(inp); body.appendChild(row);
    };
    // Name (optional, per-module). Drives the panel title + the save-to-library
    // default; preserved through validateCustomShip (format.js#cleanModule).
    {
      const row = document.createElement("label"); row.className = "se-modrow";
      row.innerHTML = `<span>name</span>`;
      const inp = document.createElement("input"); inp.type = "text"; inp.maxLength = 40;
      inp.placeholder = MODULE_LABELS[m.type] || m.type;
      inp.value = m.name || "";
      inp.addEventListener("input", () => {
        m.name = inp.value.trim() || null;
        const title = this._modPanel && this._modPanel.querySelector("#se-modpanel-title");
        if (title) title.textContent = m.name || MODULE_LABELS[m.type] || m.type;
        this._autosave();
      });
      row.appendChild(inp); body.appendChild(row);
    }
    addNum("module HP", () => m.hp, (v) => m.hp = Math.max(1, v), 5);
    addNum("hull penalty", () => m.hullPenalty, (v) => m.hullPenalty = Math.max(0, v), 1);
    // armor 0..0.95
    const arRow = document.createElement("label"); arRow.className = "se-modrow";
    arRow.innerHTML = `<span>armor</span>`;
    const ar = document.createElement("input"); ar.type = "range"; ar.min = "0"; ar.max = "90"; ar.step = "5"; ar.value = String(Math.round((m.armor || 0) * 100));
    const arv = document.createElement("span"); arv.className = "se-modval"; arv.textContent = (m.armor || 0).toFixed(2);
    ar.addEventListener("input", () => { m.armor = Number(ar.value) / 100; arv.textContent = m.armor.toFixed(2); this._autosave(); });
    arRow.appendChild(ar); arRow.appendChild(arv); body.appendChild(arRow);
    // Stat fields (per-type).
    for (const k of Object.keys(def.stats)) addNum(k, () => m.stats[k], (v) => m.stats[k] = v, k === "cooldown" || k === "spread" ? 0.05 : 1);
    // Arc (radians, half-angle). Shown for the weapon types whose fire path
    // gates on an arc: forward gun (optional gate), ring, broadside, heavy
    // laser. Forward guns start with arc null (straight-firing) until the
    // author dials one in here, which the compiler then routes to spec.arc.
    const ARC_TYPES = new Set(["forwardGun", "ring", "broadside", "heavyLaser"]);
    if (ARC_TYPES.has(m.type)) {
      const arcRow = document.createElement("label"); arcRow.className = "se-modrow";
      arcRow.innerHTML = `<span>arc (°)</span>`;
      const arc = document.createElement("input"); arc.type = "range"; arc.min = "5"; arc.max = "180"; arc.step = "5";
      arc.value = String(Math.round((m.arc != null ? m.arc : Math.PI / 4) * 180 / Math.PI));
      const arcv = document.createElement("span"); arcv.className = "se-modval"; arcv.textContent = arc.value + "°";
      arc.addEventListener("input", () => { m.arc = Number(arc.value) * Math.PI / 180; arcv.textContent = arc.value + "°"; this._renderCanvas(); this._autosave(); });
      arcRow.appendChild(arc); arcRow.appendChild(arcv); body.appendChild(arcRow);
    }
    // Projectile visuals.
    if (m.projectile) {
      const pRow = document.createElement("label"); pRow.className = "se-modrow";
      pRow.innerHTML = `<span>proj color</span>`;
      const col = document.createElement("input"); col.type = "color"; col.value = m.projectile.color || "#88ddff";
      col.addEventListener("input", () => { m.projectile.color = col.value; this._autosave(); });
      pRow.appendChild(col); body.appendChild(pRow);
      const szRow = document.createElement("label"); szRow.className = "se-modrow";
      szRow.innerHTML = `<span>proj size</span>`;
      const sz = document.createElement("input"); sz.type = "range"; sz.min = "5"; sz.max = "120"; sz.step = "1"; sz.value = String(Math.round((m.projectile.size || 2.4) * 10));
      const szv = document.createElement("span"); szv.className = "se-modval"; szv.textContent = (m.projectile.size || 2.4).toFixed(1);
      sz.addEventListener("input", () => { m.projectile.size = Number(sz.value) / 10; szv.textContent = m.projectile.size.toFixed(1); this._autosave(); });
      szRow.appendChild(sz); szRow.appendChild(szv); body.appendChild(szRow);
    }
  }
  _syncModulePanel() { /* offset changed via drag — body fields unaffected */ }
  _closeModulePanel() { if (this._modPanel) { this._modPanel.remove(); this._modPanel = null; } }

  // ---- Render orchestration ------------------------------------------------
  _renderAll() {
    this._nameEl.value = this._draft.name || "";
    this._tierEl.value = this._draft.tier;
    this._raceEl.value = this._draft.race;
    this._scaleEl.value = String(Math.round((this._draft.scaleMul || 1) * 100));
    this._scaleValEl.textContent = `${(this._draft.scaleMul || 1).toFixed(2)}×`;
    this._hpEl.value = String(this._draft.hp);
    this._shieldEl.value = this._draft.shield == null ? "" : String(this._draft.shield);
    this._cellHpEl.value = String(this._draft.cellHp);
    this._cellArmorEl.value = String(Math.round((this._draft.cellArmor || 0) * 100));
    this._cellArmorValEl.textContent = (this._draft.cellArmor || 0).toFixed(2);
    this._setTool(this._tool);
    this._renderCanvas();
    this._renderLibrary();
    this._updateHint();
  }
  _updateHint() {
    const hints = {
      draw: "DRAW: tap the TOP edge nose→tail, then CLOSE HULL (auto-mirrors symmetric).",
      place: "MODULE: pick a type, tap to drop; tap a module to edit, drag to move.",
      move: "MOVE: drag to pan, pinch / wheel to zoom.",
    };
    this._hintEl.textContent = hints[this._tool] || "";
  }

  _renderLibrary() {
    const list = this._libraryListEl;
    list.innerHTML = "";
    const items = listCustomShips();
    if (!items.length) {
      const e = document.createElement("div"); e.className = "se-library-empty";
      e.textContent = "no saved ships — author one and SAVE"; list.appendChild(e); return;
    }
    for (const item of items) {
      const row = document.createElement("div"); row.className = "se-library-row";
      const name = document.createElement("span"); name.className = "se-library-name"; name.textContent = item.name;
      const meta = document.createElement("span"); meta.className = "se-library-meta";
      meta.textContent = `${item.tier} · ${item.race} · ${item.modules.length} mod`;
      const load = mkBtn("LOAD", "se-library-load", () => this.loadDraft(item));
      const dup = mkBtn("DUP", "se-library-dup", () => { const c = JSON.parse(JSON.stringify(item)); c.id = `cs-${Date.now().toString(36)}`; c.name = `${item.name} (copy)`; this.loadDraft(c); });
      const del = mkBtn("✕", "se-library-del", () => { if (deleteCustomShip(item.id)) { this._toast(`deleted ${item.name}`); this._renderLibrary(); } });
      row.append(name, meta, load, dup, del);
      list.appendChild(row);
    }
  }

  // ---- Save / load / fly ---------------------------------------------------
  _autosave() { saveCustomShipDebounced(this._draft); }
  _new() {
    this._draft = blankCustomShip({ name: "New Custom Ship", tier: this._draft.tier, race: this._draft.race });
    this._drawPts = []; this._selectedModule = -1; this._closeModulePanel(); this._invalidateCells();
    this._renderAll();
  }
  _save() {
    try { const v = saveCustomShip(this._draft); this._draft = v; this._toast(`saved "${v.name}"`); this._renderLibrary(); }
    catch (e) { this._toast("save failed: " + e.message, true); }
  }
  async _export() {
    const res = validateCustomShip(this._draft);
    const fenced = serializeCustomShip(res.value);
    const ok = await writeClipboard(fenced);
    if (ok) this._toast(`exported (${fenced.length} chars)`);
    else this._showFallbackExport(fenced);
  }
  async _import() {
    let text = await readClipboard();
    if (text == null) text = window.prompt("Paste a custom ship (```json block or raw JSON):") || "";
    if (!text) return;
    const res = parseCustomShip(text);
    if (!res.value) { this._toast("import failed", true); return; }
    this.loadDraft(res.value); this._toast(`imported "${res.value.name}"`);
  }
  _testFly() {
    // Persist first so a crash mid-fly doesn't lose the draft, then hand the
    // validated doc to main.js to compile + spawn in a sandbox match.
    let doc;
    try { doc = saveCustomShip(this._draft); this._draft = doc; this._renderLibrary(); }
    catch (e) { this._toast("can't fly — " + e.message, true); return; }
    flushCustomShipSave();
    if (this.deps.onTestFly) { this.hide(); this.deps.onTestFly(doc); }
    else this._toast("test-fly not wired", true);
  }

  _showFallbackExport(text) {
    const wrap = document.createElement("div");
    wrap.className = "se-fallback-export";
    wrap.innerHTML = `<div class="se-fallback-panel"><div class="se-fallback-title">EXPORT — copy manually</div><textarea class="se-fallback-text" readonly></textarea><button class="se-btn">CLOSE</button></div>`;
    wrap.querySelector(".se-fallback-text").value = text;
    wrap.querySelector(".se-fallback-text").select();
    wrap.querySelector("button").addEventListener("click", () => wrap.remove());
    this._el.appendChild(wrap);
  }
  _toast(msg, isError = false) {
    const el = this._toastEl;
    el.textContent = msg;
    el.classList.toggle("error", isError);
    el.classList.add("show");
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => el.classList.remove("show"), 2600);
  }
}

// ---- Module-free helpers ----------------------------------------------------

// Mirror a top-edge half-profile (nose→tail, y>=0) into a full y-symmetric
// hull. Mirrors ship.js#mk: nose-on-axis vertex is shared (not duplicated).
function mirrorHalfProfile(top) {
  const pts = top.map(([x, y]) => [x, Math.abs(y)]);
  // Snap the first vertex (nose) to the axis so the hull closes cleanly.
  if (pts.length) pts[0] = [pts[0][0], 0];
  const noseOnAxis = Math.abs(pts[0][1]) < 1e-9;
  const src = (noseOnAxis ? pts.slice(1) : pts.slice()).reverse();
  const bottom = src.map(([x, y]) => [x, -y]);
  return pts.concat(bottom);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function touchDist(ev) {
  if (!ev.touches || ev.touches.length < 2) return 0;
  return Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX, ev.touches[0].clientY - ev.touches[1].clientY);
}
function hexA(hex, a) {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function mkBtn(label, cls, onClick) {
  const b = document.createElement("button");
  b.className = `se-btn ${cls}`; b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}
// Drag a panel by its handle; reports the new top-left so the editor can
// remember it across re-opens. Touch + mouse.
function makeDraggable(panel, handle, onMove) {
  let sx = 0, sy = 0, ox = 0, oy = 0, active = false;
  const start = (e) => {
    active = true;
    const t = e.touches ? e.touches[0] : e;
    sx = t.clientX; sy = t.clientY;
    const r = panel.getBoundingClientRect();
    const host = panel.parentElement.getBoundingClientRect();
    ox = r.left - host.left; oy = r.top - host.top;
    e.preventDefault();
  };
  const move = (e) => {
    if (!active) return;
    const t = e.touches ? e.touches[0] : e;
    const nx = ox + (t.clientX - sx), ny = oy + (t.clientY - sy);
    panel.style.left = nx + "px"; panel.style.top = ny + "px";
    if (onMove) onMove(nx, ny);
  };
  const end = () => { active = false; };
  handle.addEventListener("mousedown", start);
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);
  handle.addEventListener("touchstart", start, { passive: false });
  window.addEventListener("touchmove", move, { passive: false });
  window.addEventListener("touchend", end);
}

async function writeClipboard(text) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; } } catch (_e) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy"); document.body.removeChild(ta); return ok;
  } catch (_e) { return false; }
}
async function readClipboard() {
  try { if (navigator.clipboard && navigator.clipboard.readText) return await navigator.clipboard.readText(); } catch (_e) {}
  return null;
}
