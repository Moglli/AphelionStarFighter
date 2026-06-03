/**
 * @file Ship Designer — DOM overlay for authoring blueprint loadouts.
 *
 * Pairs a (race, klass) hull with a slot → component map and a paint.
 * Saves go to `saveStore.blueprints`; scenarios reference them by
 * `designId` and spawnRoster resolves them at spawn time via
 * `resolveBlueprintDesign(id)`.
 *
 * Layout (three columns):
 *   ┌─ SLOTS ──────┬─ PREVIEW ─────┬─ STATS ───┐
 *   │ Each slot:   │ Canvas-rendered│ Per-field │
 *   │   component  │ silhouette +   │ delta vs  │
 *   │   dropdown   │ module dots    │ stock     │
 *   └──────────────┴───────────────┴───────────┘
 *
 * Live preview reads from the same pipeline the game uses (`resolveSpec`
 * → `applyDesign` → `buildModules`) so what you see in the designer is
 * exactly what spawns in-game. CLAUDE.md "Spec mutation hazard": every
 * apply path here clone-on-descents via `applyDesign` already, so the
 * blueprint can't poison the shared race+class spec for live ships.
 */

import { resolveSpec, RACES } from "../races.js";
import {
  HULLS, HULL_ORDER, COMPONENTS, SLOT_VISUALS,
  computeBlueprintComparison, stockDesignForKlass,
} from "../components.js";
import { getHull } from "../ship.js";
import { buildModules } from "../modules.js";
import {
  blankBlueprint, validateBlueprint,
  serializeBlueprint, parseBlueprint,
} from "../blueprints/format.js";
import {
  listBlueprints, saveBlueprint, deleteBlueprint,
} from "../blueprints/store.js";

const KLASS_LABELS = {
  fighter: "Fighter", bomber: "Bomber", frigate: "Frigate",
  cruiser: "Cruiser", battleship: "Battleship", carrier: "Carrier",
};

export class ShipDesigner {
  constructor(host, deps) {
    // deps: { game, onClose() }
    this.host = host;
    this.deps = deps;
    this._draft = blankBlueprint({ name: "New Blueprint" });
    this._visible = false;
    this._mount();
  }

  _mount() {
    const el = document.createElement("div");
    el.id = "ship-designer";
    el.className = "ship-designer hidden";
    el.innerHTML = `
      <div class="sd-panel">
        <header class="sd-header">
          <span class="sd-title">SHIP DESIGNER</span>
          <button class="sd-x" id="sd-close" title="Close">✕</button>
        </header>
        <section class="sd-meta">
          <label class="sd-field"><span>NAME</span><input id="sd-name" type="text" maxlength="60" /></label>
          <label class="sd-field sd-field-tight"><span>RACE</span><select id="sd-race"></select></label>
          <label class="sd-field sd-field-tight"><span>KLASS</span><select id="sd-klass"></select></label>
          <label class="sd-field sd-field-tight"><span>RADIUS ×</span>
            <input id="sd-radius" type="range" min="70" max="130" step="2" value="100" />
            <span id="sd-radius-val">1.00×</span>
          </label>
        </section>
        <section class="sd-body">
          <div class="sd-col sd-slots">
            <h3>SLOTS</h3>
            <div class="sd-slots-list" id="sd-slots-list"></div>
          </div>
          <div class="sd-col sd-preview-col">
            <h3>PREVIEW</h3>
            <canvas class="sd-preview" id="sd-preview" width="320" height="320"></canvas>
            <div class="sd-preview-hint" id="sd-preview-hint">dots = modules · silhouette = hull</div>
          </div>
          <div class="sd-col sd-stats-col">
            <h3>VS STOCK</h3>
            <div class="sd-stats-list" id="sd-stats-list"></div>
          </div>
        </section>
        <section class="sd-library">
          <h3>SAVED BLUEPRINTS</h3>
          <div class="sd-library-list" id="sd-library-list"></div>
        </section>
        <footer class="sd-footer">
          <button class="sd-btn" id="sd-import">IMPORT</button>
          <button class="sd-btn" id="sd-export">EXPORT (clipboard)</button>
          <button class="sd-btn" id="sd-new">NEW</button>
          <button class="sd-btn sd-btn-primary" id="sd-save">SAVE</button>
        </footer>
        <div class="sd-toast" id="sd-toast"></div>
      </div>
    `;
    this.host.appendChild(el);
    this._el = el;
    this._nameEl = el.querySelector("#sd-name");
    this._raceEl = el.querySelector("#sd-race");
    this._klassEl = el.querySelector("#sd-klass");
    this._radiusEl = el.querySelector("#sd-radius");
    this._radiusValEl = el.querySelector("#sd-radius-val");
    this._slotsListEl = el.querySelector("#sd-slots-list");
    this._previewEl = el.querySelector("#sd-preview");
    this._statsListEl = el.querySelector("#sd-stats-list");
    this._libraryListEl = el.querySelector("#sd-library-list");
    this._toastEl = el.querySelector("#sd-toast");

    // Race + klass dropdowns.
    for (const r of Object.keys(RACES)) {
      const o = document.createElement("option");
      o.value = r; o.textContent = r.toUpperCase();
      this._raceEl.appendChild(o);
    }
    for (const k of HULL_ORDER) {
      const o = document.createElement("option");
      o.value = k; o.textContent = KLASS_LABELS[k] || k;
      this._klassEl.appendChild(o);
    }

    this._nameEl.addEventListener("input", () => { this._draft.name = this._nameEl.value; });
    this._raceEl.addEventListener("change", () => {
      this._draft.race = this._raceEl.value;
      this._rerenderAfterShape();
    });
    this._klassEl.addEventListener("change", () => {
      this._draft.klass = this._klassEl.value;
      // Klass change resets the design slot map to the new klass's stock
      // — the old slots probably don't exist on the new hull and the
      // validator would strip them anyway.
      this._draft.design = stockDesignForKlass(this._draft.klass);
      this._rerenderAfterShape();
    });
    this._radiusEl.addEventListener("input", () => {
      this._draft.radiusScale = Number(this._radiusEl.value) / 100;
      this._radiusValEl.textContent = `${this._draft.radiusScale.toFixed(2)}×`;
      this._renderPreview();
    });

    el.querySelector("#sd-close").addEventListener("click", () => this.hide());
    el.querySelector("#sd-new").addEventListener("click", () => this._new());
    el.querySelector("#sd-save").addEventListener("click", () => this._save());
    el.querySelector("#sd-export").addEventListener("click", () => this._export());
    el.querySelector("#sd-import").addEventListener("click", () => this._import());
  }

  isVisible() { return this._visible; }
  show() {
    this._visible = true;
    this._el.classList.remove("hidden");
    this._syncAll();
  }
  hide() {
    this._visible = false;
    this._el.classList.add("hidden");
    if (this.deps.onClose) this.deps.onClose();
  }
  toggle() { if (this._visible) this.hide(); else this.show(); }

  loadDraft(bp) {
    const res = validateBlueprint(bp);
    if (!res.ok) {
      this._toast(`load failed: ${res.errors[0]}`, true);
      return false;
    }
    this._draft = JSON.parse(JSON.stringify(res.value));
    if (this._visible) this._syncAll();
    return true;
  }

  getDraft() { return JSON.parse(JSON.stringify(this._draft)); }

  // ---- Rendering -----------------------------------------------------------

  _syncAll() {
    this._nameEl.value = this._draft.name || "";
    this._raceEl.value = this._draft.race;
    this._klassEl.value = this._draft.klass;
    this._radiusEl.value = String(Math.round(this._draft.radiusScale * 100));
    this._radiusValEl.textContent = `${this._draft.radiusScale.toFixed(2)}×`;
    this._renderSlots();
    this._renderPreview();
    this._renderStats();
    this._renderLibrary();
  }

  _rerenderAfterShape() {
    this._renderSlots();
    this._renderPreview();
    this._renderStats();
  }

  _renderSlots() {
    const hull = HULLS[this._draft.klass] || HULLS.fighter;
    this._slotsListEl.innerHTML = "";
    for (const slot of hull.slots) {
      const row = document.createElement("div");
      row.className = "sd-slot-row";

      const label = document.createElement("span");
      label.className = "sd-slot-label";
      label.textContent = slot;

      const sel = document.createElement("select");
      sel.className = "sd-slot-select";
      // Options: "—" (default) + every component that fits this slot.
      const noneOpt = document.createElement("option");
      noneOpt.value = ""; noneOpt.textContent = "— stock —";
      sel.appendChild(noneOpt);
      for (const id of Object.keys(COMPONENTS)) {
        const comp = COMPONENTS[id];
        if (!comp.slots.includes(slot)) continue;
        const o = document.createElement("option");
        o.value = id; o.textContent = comp.name;
        sel.appendChild(o);
      }
      sel.value = (this._draft.design.modules && this._draft.design.modules[slot]) || "";
      sel.addEventListener("change", () => {
        if (!this._draft.design.modules) this._draft.design.modules = {};
        if (sel.value) this._draft.design.modules[slot] = sel.value;
        else delete this._draft.design.modules[slot];
        this._renderPreview();
        this._renderStats();
      });

      row.appendChild(label);
      row.appendChild(sel);
      this._slotsListEl.appendChild(row);
    }
  }

  _renderPreview() {
    const canvas = this._previewEl;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#06090f";
    ctx.fillRect(0, 0, W, H);

    const race = this._draft.race;
    const klass = this._draft.klass;
    let poly;
    try { poly = getHull(race, klass); } catch (_e) { poly = null; }
    if (!poly) {
      ctx.fillStyle = "#678";
      ctx.font = "12px ui-monospace, monospace";
      ctx.fillText("no hull poly", 20, 30);
      return;
    }

    // Fit the unit polygon ([-1, 1]) into the canvas with padding.
    const pad = 32;
    const scale = ((Math.min(W, H) - pad * 2) / 2) * this._draft.radiusScale;
    const cx = W / 2, cy = H / 2;

    // Hull silhouette.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    poly.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(x * scale, y * scale);
      else ctx.lineTo(x * scale, y * scale);
    });
    ctx.closePath();
    ctx.fillStyle = "rgba(60, 110, 160, 0.5)";
    ctx.strokeStyle = "rgba(160, 200, 240, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();

    // Module dots — walk buildModules to get real per-module positions,
    // fall back to SLOT_VISUALS for slots the renderer doesn't have a
    // physical module for (shield / armor are abstract).
    let modules = [];
    try {
      const spec = this._resolvedSpec();
      if (spec) modules = buildModules(klass, spec, poly) || [];
    } catch (_e) { modules = []; }

    for (const m of modules) {
      const x = (m.x || 0) * scale;
      const y = (m.y || 0) * scale;
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = "#fc8";
      ctx.fill();
    }

    // Overlay abstract slots (shield / armor) from SLOT_VISUALS so the
    // designer reads each slot the player picked, even those without a
    // physical module to draw.
    const hull = HULLS[klass] || HULLS.fighter;
    for (const slot of hull.slots) {
      const vis = SLOT_VISUALS[slot];
      if (!vis) continue;
      if (vis.category !== "shield" && vis.category !== "armor") continue;
      ctx.beginPath();
      ctx.arc(vis.x * scale, vis.y * scale, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = vis.category === "shield" ? "#9df" : "#cea";
      ctx.fill();
    }

    ctx.restore();
  }

  _renderStats() {
    const list = this._statsListEl;
    list.innerHTML = "";
    let baseSpec;
    try { baseSpec = resolveSpec(this._draft.race, this._draft.klass); }
    catch (_e) { baseSpec = null; }
    if (!baseSpec) {
      const empty = document.createElement("div");
      empty.className = "sd-stats-empty";
      empty.textContent = "no spec available";
      list.appendChild(empty);
      return;
    }
    const stock = stockDesignForKlass(this._draft.klass);
    const rows = computeBlueprintComparison(baseSpec, this._draft.design, stock);
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "sd-stats-empty";
      empty.textContent = "stock loadout";
      list.appendChild(empty);
      return;
    }
    for (const row of rows) {
      const el = document.createElement("div");
      el.className = `sd-stat-row sd-stat-${row.direction}`;
      const label = document.createElement("span");
      label.className = "sd-stat-label";
      label.textContent = row.label;
      const cur = document.createElement("span");
      cur.className = "sd-stat-current";
      cur.textContent = fmtStat(row.current);
      const delta = document.createElement("span");
      delta.className = "sd-stat-delta";
      delta.textContent = row.delta === 0 ? "—" : (row.delta > 0 ? `+${fmtStat(row.delta)}` : `${fmtStat(row.delta)}`);
      el.appendChild(label);
      el.appendChild(cur);
      el.appendChild(delta);
      list.appendChild(el);
    }
  }

  _renderLibrary() {
    const list = this._libraryListEl;
    list.innerHTML = "";
    const items = listBlueprints();
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sd-library-empty";
      empty.textContent = "no saved blueprints — author one and click SAVE";
      list.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "sd-library-row";
      const name = document.createElement("span");
      name.className = "sd-library-name";
      name.textContent = item.name;
      const meta = document.createElement("span");
      meta.className = "sd-library-meta";
      meta.textContent = `${item.race} · ${item.klass}`;
      const loadBtn = this._btn("LOAD", "sd-library-load", () => this.loadDraft(item));
      const dupBtn = this._btn("DUP", "sd-library-dup", () => {
        const copy = JSON.parse(JSON.stringify(item));
        copy.id = `bp-${Date.now().toString(36)}`;
        copy.name = `${item.name} (copy)`;
        this.loadDraft(copy);
      });
      const delBtn = this._btn("✕", "sd-library-del", () => {
        if (deleteBlueprint(item.id)) {
          this._toast(`deleted ${item.name}`);
          this._renderLibrary();
        }
      });
      row.appendChild(name);
      row.appendChild(meta);
      row.appendChild(loadBtn);
      row.appendChild(dupBtn);
      row.appendChild(delBtn);
      list.appendChild(row);
    }
  }

  // ---- Helpers -------------------------------------------------------------

  _resolvedSpec() {
    const baseSpec = resolveSpec(this._draft.race, this._draft.klass);
    return require_applyDesign(baseSpec, this._draft.design);
  }

  _btn(label, cls, onClick) {
    const b = document.createElement("button");
    b.className = `sd-btn ${cls}`;
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  _new() {
    this._draft = blankBlueprint({
      name: "New Blueprint",
      race: this._draft.race,
      klass: this._draft.klass,
    });
    this._syncAll();
  }

  _save() {
    const res = validateBlueprint(this._draft);
    if (!res.ok) {
      this._toast(`invalid: ${res.errors[0]}`, true);
      return;
    }
    try {
      saveBlueprint(res.value);
      this._draft = res.value;
      this._toast(`saved "${res.value.name}"`);
      this._renderLibrary();
    } catch (e) {
      this._toast(`save failed: ${e.message}`, true);
    }
  }

  async _export() {
    const res = validateBlueprint(this._draft);
    if (!res.ok) {
      this._toast(`invalid: ${res.errors[0]}`, true);
      return;
    }
    const fenced = serializeBlueprint(res.value);
    const ok = await writeClipboard(fenced);
    if (ok) {
      this._toast(`exported to clipboard (${fenced.length} chars)`);
    } else {
      this._showFallbackExport(fenced);
    }
  }

  async _import() {
    let text = await readClipboard();
    if (text == null) {
      text = window.prompt("Paste the blueprint (fenced ```json block or raw JSON):") || "";
    }
    if (!text) return;
    const res = parseBlueprint(text);
    if (!res.ok) {
      this._toast(`import failed: ${res.errors[0]}`, true);
      return;
    }
    this.loadDraft(res.value);
    this._toast(`imported "${res.value.name}"`);
  }

  _showFallbackExport(text) {
    const wrap = document.createElement("div");
    wrap.className = "sd-fallback-export";
    wrap.innerHTML = `
      <div class="sd-fallback-panel">
        <div class="sd-fallback-title">EXPORT — copy manually</div>
        <textarea class="sd-fallback-text" readonly></textarea>
        <button class="sd-btn">CLOSE</button>
      </div>
    `;
    wrap.querySelector(".sd-fallback-text").value = text;
    wrap.querySelector(".sd-fallback-text").select();
    wrap.querySelector("button").addEventListener("click", () => wrap.remove());
    this._el.appendChild(wrap);
  }

  _toast(msg, isError = false) {
    const el = this._toastEl;
    el.textContent = msg;
    el.classList.toggle("error", isError);
    el.classList.add("show");
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => el.classList.remove("show"), 2400);
  }
}

// Stat formatter — numeric values rounded, others passed through.
function fmtStat(v) {
  if (typeof v !== "number") return String(v == null ? "—" : v);
  if (Math.abs(v) >= 100) return Math.round(v).toString();
  if (Math.abs(v) >= 1) return v.toFixed(1).replace(/\.0$/, "");
  return v.toFixed(2);
}

// Local applyDesign reference — kept under a clearly-tagged name so the
// designer's hot path is auditable (CLAUDE.md: spec-clone hazard — the
// returned spec must be detached from the shared race+class spec, which
// applyDesign already does via its internal deepMerge clones).
import { applyDesign as _applyDesign } from "../components.js";
function require_applyDesign(spec, design) {
  return _applyDesign(spec, design);
}

// ---- Clipboard helpers (same as battle-designer.js) -----------------------
async function writeClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text); return true;
    }
  } catch (_e) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (_e) { return false; }
}
async function readClipboard() {
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      return await navigator.clipboard.readText();
    }
  } catch (_e) {}
  return null;
}
