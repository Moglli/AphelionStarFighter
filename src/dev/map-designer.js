/**
 * @file Map Designer — DOM overlay for authoring battle maps.
 *
 * Layout (two-column body):
 *   ┌─ FORM ──────┬─ PREVIEW ────┐
 *   │ name, size, │ canvas of    │
 *   │ blue/red    │ bounds +     │
 *   │ spawn rects,│ spawn rects +│
 *   │ decor list  │ decor; click │
 *   │             │ to add/remove│
 *   └─────────────┴──────────────┘
 *
 * Click-to-place on the preview canvas: with "ASTEROID" tool active,
 * a click adds an asteroid at the world-space click point; with
 * "SELECT" active, a click near an asteroid removes it.
 */

import {
  blankMap, validateMap, serializeMap, parseMap,
} from "../maps/format.js";
import {
  listUserMaps, listAllMaps, saveMap, deleteMap,
} from "../maps/store.js";
import { PLATFORM_TYPE_KEYS, PLATFORM_TYPES } from "../platforms/registry.js";

const TOOL_SELECT = "select";
const TOOL_ASTEROID = "asteroid";
const TOOL_PLATFORM = "platform";

export class MapDesigner {
  constructor(host, deps) {
    // deps: { game, onClose() }
    this.host = host;
    this.deps = deps;
    this._draft = blankMap({ name: "New Map" });
    this._visible = false;
    this._tool = TOOL_ASTEROID;
    this._defaultAsteroidR = 180;
    this._mount();
  }

  _mount() {
    const el = document.createElement("div");
    el.id = "map-designer";
    el.className = "map-designer hidden";
    el.innerHTML = `
      <div class="md-panel">
        <header class="md-header">
          <span class="md-title">MAP DESIGNER</span>
          <button class="md-x" id="md-close" title="Close">✕</button>
        </header>
        <section class="md-meta">
          <label class="md-field"><span>NAME</span><input id="md-name" type="text" maxlength="60" /></label>
          <label class="md-field md-field-tight">
            <span>WIDTH</span>
            <input id="md-w" type="range" min="3000" max="18000" step="200" value="7000" />
            <span id="md-w-val">7000</span>
          </label>
          <label class="md-field md-field-tight">
            <span>HEIGHT</span>
            <input id="md-h" type="range" min="2200" max="12000" step="200" value="5000" />
            <span id="md-h-val">5000</span>
          </label>
        </section>
        <section class="md-body">
          <div class="md-col md-form">
            <h3>SPAWN ZONES</h3>
            <div class="md-spawn-rows" id="md-spawn-rows"></div>
            <h3 class="md-decor-h">DECOR (visual only)</h3>
            <div class="md-tool-row">
              <button class="md-btn md-tool" id="md-tool-asteroid" data-tool="asteroid">＋ ASTEROID</button>
              <button class="md-btn md-tool" id="md-tool-platform" data-tool="platform">＋ PLATFORM</button>
              <button class="md-btn md-tool" id="md-tool-select" data-tool="select">SELECT</button>
              <label class="md-field md-field-tight">
                <span>SIZE</span>
                <input id="md-decor-r" type="range" min="40" max="400" step="10" value="180" />
                <span id="md-decor-r-val">180</span>
              </label>
            </div>
            <div class="md-tool-row">
              <label class="md-field md-field-tight">
                <span>PLATFORM TYPE</span>
                <select id="md-plat-type"></select>
              </label>
              <label class="md-field md-field-tight">
                <span>FACTION</span>
                <select id="md-plat-side">
                  <option value="red" selected>RED</option>
                  <option value="blue">BLUE</option>
                </select>
              </label>
            </div>
            <div class="md-decor-list" id="md-decor-list"></div>
            <div class="md-decor-list" id="md-platform-list"></div>
          </div>
          <div class="md-col md-preview-col">
            <h3>PREVIEW</h3>
            <canvas class="md-preview" id="md-preview" width="520" height="340"></canvas>
            <div class="md-preview-hint">click to add an asteroid · SELECT then click to remove</div>
          </div>
        </section>
        <section class="md-library">
          <h3>SAVED MAPS</h3>
          <div class="md-library-list" id="md-library-list"></div>
        </section>
        <footer class="md-footer">
          <button class="md-btn" id="md-import">IMPORT</button>
          <button class="md-btn" id="md-export">EXPORT (clipboard)</button>
          <button class="md-btn" id="md-new">NEW</button>
          <button class="md-btn md-btn-primary" id="md-save">SAVE</button>
        </footer>
        <div class="md-toast" id="md-toast"></div>
      </div>
    `;
    this.host.appendChild(el);
    this._el = el;
    this._nameEl = el.querySelector("#md-name");
    this._wEl = el.querySelector("#md-w");
    this._hEl = el.querySelector("#md-h");
    this._wValEl = el.querySelector("#md-w-val");
    this._hValEl = el.querySelector("#md-h-val");
    this._spawnRowsEl = el.querySelector("#md-spawn-rows");
    this._decorListEl = el.querySelector("#md-decor-list");
    this._platformListEl = el.querySelector("#md-platform-list");
    this._previewEl = el.querySelector("#md-preview");
    this._libraryListEl = el.querySelector("#md-library-list");
    this._toastEl = el.querySelector("#md-toast");
    this._decorREl = el.querySelector("#md-decor-r");
    this._decorRValEl = el.querySelector("#md-decor-r-val");
    this._platTypeEl = el.querySelector("#md-plat-type");
    this._platSideEl = el.querySelector("#md-plat-side");
    for (const k of PLATFORM_TYPE_KEYS) {
      const o = document.createElement("option");
      o.value = k; o.textContent = PLATFORM_TYPES[k].name;
      this._platTypeEl.appendChild(o);
    }

    this._nameEl.addEventListener("input", () => { this._draft.name = this._nameEl.value; });
    const onResize = () => {
      this._draft.mapW = Number(this._wEl.value);
      this._draft.mapH = Number(this._hEl.value);
      this._wValEl.textContent = String(this._draft.mapW);
      this._hValEl.textContent = String(this._draft.mapH);
      // Re-derive default spawn rects only if the user hasn't touched
      // them — they wouldn't expect a slider drag to wipe their custom
      // spawn zones, but a fresh resize without prior edits should
      // re-flow. We approximate "untouched" with a value-equality check
      // against the proportional default.
      this._reflowSpawnsIfDefault();
      this._renderSpawnRows();
      this._renderPreview();
    };
    this._wEl.addEventListener("input", onResize);
    this._hEl.addEventListener("input", onResize);
    this._decorREl.addEventListener("input", () => {
      this._defaultAsteroidR = Number(this._decorREl.value);
      this._decorRValEl.textContent = String(this._defaultAsteroidR);
    });

    el.querySelectorAll(".md-tool").forEach((b) => {
      b.addEventListener("click", () => this._setTool(b.dataset.tool));
    });

    this._previewEl.addEventListener("pointerdown", (e) => this._onPreviewClick(e));

    el.querySelector("#md-close").addEventListener("click", () => this.hide());
    el.querySelector("#md-new").addEventListener("click", () => this._new());
    el.querySelector("#md-save").addEventListener("click", () => this._save());
    el.querySelector("#md-export").addEventListener("click", () => this._export());
    el.querySelector("#md-import").addEventListener("click", () => this._import());
  }

  isVisible() { return this._visible; }
  show() { this._visible = true; this._el.classList.remove("hidden"); this._syncAll(); }
  hide() { this._visible = false; this._el.classList.add("hidden"); if (this.deps.onClose) this.deps.onClose(); }
  toggle() { if (this._visible) this.hide(); else this.show(); }

  loadDraft(map) {
    const res = validateMap(map);
    if (!res.ok) { this._toast(`load failed: ${res.errors[0]}`, true); return false; }
    // Defensive deep clone — saved presets are read-only, draft must be
    // freely editable. Strip the _builtin flag so editing a preset clone
    // produces a user map on save.
    const cloned = JSON.parse(JSON.stringify(res.value));
    delete cloned._builtin;
    this._draft = cloned;
    if (this._visible) this._syncAll();
    return true;
  }

  // ---- Rendering -----------------------------------------------------------

  _syncAll() {
    this._nameEl.value = this._draft.name || "";
    this._wEl.value = String(this._draft.mapW);
    this._hEl.value = String(this._draft.mapH);
    this._wValEl.textContent = String(this._draft.mapW);
    this._hValEl.textContent = String(this._draft.mapH);
    this._renderSpawnRows();
    this._renderDecorList();
    this._renderPlatformList();
    this._renderLibrary();
    this._setTool(this._tool);
    this._renderPreview();
  }

  _renderPlatformList() {
    if (!this._platformListEl) return;
    const list = this._platformListEl;
    list.innerHTML = "";
    if (!this._draft.platforms || !this._draft.platforms.length) {
      const empty = document.createElement("div");
      empty.className = "md-decor-empty";
      empty.textContent = "no platforms — pick PLATFORM tool and click to place";
      list.appendChild(empty);
      return;
    }
    this._draft.platforms.forEach((pl, i) => {
      const row = document.createElement("div");
      row.className = "md-decor-row";
      row.innerHTML = `
        <span class="md-decor-meta">${pl.faction === "blue" ? "B" : "R"} · ${pl.platformId} · (${Math.round(pl.x)}, ${Math.round(pl.y)})</span>
        <button class="md-btn md-decor-del">✕</button>
      `;
      row.querySelector(".md-decor-del").addEventListener("click", () => {
        this._draft.platforms.splice(i, 1);
        this._renderPlatformList();
        this._renderPreview();
      });
      list.appendChild(row);
    });
  }

  _setTool(tool) {
    this._tool = tool === TOOL_SELECT ? TOOL_SELECT : TOOL_ASTEROID;
    this._el.querySelectorAll(".md-tool").forEach((b) => {
      b.classList.toggle("active", b.dataset.tool === this._tool);
    });
  }

  _renderSpawnRows() {
    const list = this._spawnRowsEl;
    list.innerHTML = "";
    for (const side of ["blue", "red"]) {
      const sp = this._draft.spawn[side];
      const row = document.createElement("div");
      row.className = `md-spawn-row md-spawn-${side}`;
      row.innerHTML = `
        <span class="md-spawn-label">${side.toUpperCase()}</span>
        <label>X<input type="number" data-field="x" value="${Math.round(sp.x)}" /></label>
        <label>Y<input type="number" data-field="y" value="${Math.round(sp.y)}" /></label>
        <label>W<input type="number" data-field="w" value="${Math.round(sp.w)}" /></label>
        <label>H<input type="number" data-field="h" value="${Math.round(sp.h)}" /></label>
      `;
      row.querySelectorAll("input").forEach((inp) => {
        inp.addEventListener("input", () => {
          const v = Number(inp.value);
          if (Number.isFinite(v)) {
            this._draft.spawn[side][inp.dataset.field] = v;
            this._renderPreview();
          }
        });
      });
      list.appendChild(row);
    }
  }

  _renderDecorList() {
    const list = this._decorListEl;
    list.innerHTML = "";
    if (!this._draft.decor.length) {
      const empty = document.createElement("div");
      empty.className = "md-decor-empty";
      empty.textContent = "no decor — click the preview to place asteroids";
      list.appendChild(empty);
      return;
    }
    this._draft.decor.forEach((d, i) => {
      const row = document.createElement("div");
      row.className = "md-decor-row";
      row.innerHTML = `
        <span class="md-decor-meta">#${i} · r=${Math.round(d.r)} · (${Math.round(d.x)}, ${Math.round(d.y)})</span>
        <button class="md-btn md-decor-del">✕</button>
      `;
      row.querySelector(".md-decor-del").addEventListener("click", () => {
        this._draft.decor.splice(i, 1);
        this._renderDecorList();
        this._renderPreview();
      });
      list.appendChild(row);
    });
  }

  _renderPreview() {
    const canvas = this._previewEl;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#06090f";
    ctx.fillRect(0, 0, W, H);

    const { mapW, mapH, spawn, decor } = this._draft;
    const pad = 12;
    const scale = Math.min((W - pad * 2) / mapW, (H - pad * 2) / mapH);
    const ox = (W - mapW * scale) / 2;
    const oy = (H - mapH * scale) / 2;
    this._previewScale = scale;
    this._previewOffset = { x: ox, y: oy };

    // Bounds.
    ctx.strokeStyle = "rgba(80, 140, 200, 0.7)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox, oy, mapW * scale, mapH * scale);

    // Spawn rects.
    for (const side of ["blue", "red"]) {
      const sp = spawn[side];
      const x = ox + (sp.x - sp.w / 2) * scale;
      const y = oy + (sp.y - sp.h / 2) * scale;
      ctx.fillStyle = side === "blue" ? "rgba(80,160,240,0.18)" : "rgba(240,120,90,0.18)";
      ctx.fillRect(x, y, sp.w * scale, sp.h * scale);
      ctx.strokeStyle = side === "blue" ? "rgba(80,160,240,0.6)" : "rgba(240,120,90,0.6)";
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(x, y, sp.w * scale, sp.h * scale);
      ctx.setLineDash([]);
    }

    // Decor.
    for (const d of decor) {
      ctx.beginPath();
      ctx.arc(ox + d.x * scale, oy + d.y * scale, Math.max(2, d.r * scale), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(160, 140, 110, 0.7)";
      ctx.fill();
      ctx.strokeStyle = "rgba(220, 200, 160, 0.85)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Center crosshair so the editor reads at a glance.
    ctx.strokeStyle = "rgba(120,180,220,0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ox + mapW * scale / 2, oy);
    ctx.lineTo(ox + mapW * scale / 2, oy + mapH * scale);
    ctx.moveTo(ox, oy + mapH * scale / 2);
    ctx.lineTo(ox + mapW * scale, oy + mapH * scale / 2);
    ctx.stroke();
  }

  _onPreviewClick(e) {
    const rect = this._previewEl.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const scale = this._previewScale;
    const ox = this._previewOffset.x;
    const oy = this._previewOffset.y;
    const wx = (sx - ox) / scale;
    const wy = (sy - oy) / scale;
    if (wx < 0 || wx > this._draft.mapW || wy < 0 || wy > this._draft.mapH) return;

    if (this._tool === TOOL_ASTEROID) {
      this._draft.decor.push({
        type: "asteroid",
        x: wx, y: wy,
        r: this._defaultAsteroidR,
        rot: Math.random() * Math.PI * 2,
      });
    } else if (this._tool === TOOL_PLATFORM) {
      if (!Array.isArray(this._draft.platforms)) this._draft.platforms = [];
      this._draft.platforms.push({
        platformId: this._platTypeEl.value,
        faction: this._platSideEl.value,
        x: wx, y: wy,
      });
    } else if (this._tool === TOOL_SELECT) {
      // Try platforms first (smaller pick radius), then decor.
      const pickR = Math.max(40, this._draft.mapW * 0.012);
      if (this._draft.platforms && this._draft.platforms.length) {
        let bestI = -1, bestD = pickR * pickR;
        for (let i = 0; i < this._draft.platforms.length; i++) {
          const pl = this._draft.platforms[i];
          const dx = pl.x - wx, dy = pl.y - wy;
          const dd = dx * dx + dy * dy;
          if (dd < bestD) { bestD = dd; bestI = i; }
        }
        if (bestI >= 0) {
          this._draft.platforms.splice(bestI, 1);
          this._renderPlatformList();
          this._renderPreview();
          return;
        }
      }
      let bestI = -1, bestD = pickR * pickR;
      for (let i = 0; i < this._draft.decor.length; i++) {
        const d = this._draft.decor[i];
        const dx = d.x - wx, dy = d.y - wy;
        const dd = dx * dx + dy * dy;
        if (dd < bestD) { bestD = dd; bestI = i; }
      }
      if (bestI >= 0) this._draft.decor.splice(bestI, 1);
    }
    this._renderDecorList();
    this._renderPlatformList();
    this._renderPreview();
  }

  _renderLibrary() {
    const list = this._libraryListEl;
    list.innerHTML = "";
    const items = listAllMaps();
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "md-library-row";
      const name = document.createElement("span");
      name.className = "md-library-name";
      name.textContent = item.name + (item._builtin ? " · built-in" : "");
      const meta = document.createElement("span");
      meta.className = "md-library-meta";
      meta.textContent = `${item.mapW}×${item.mapH} · ${item.decor?.length || 0} decor`;
      const loadBtn = document.createElement("button");
      loadBtn.className = "md-btn md-library-load";
      loadBtn.textContent = "LOAD";
      loadBtn.addEventListener("click", () => this.loadDraft(item));
      const dupBtn = document.createElement("button");
      dupBtn.className = "md-btn md-library-dup";
      dupBtn.textContent = "DUP";
      dupBtn.addEventListener("click", () => {
        const copy = JSON.parse(JSON.stringify(item));
        copy.id = `map-${Date.now().toString(36)}`;
        copy.name = `${item.name} (copy)`;
        delete copy._builtin;
        this.loadDraft(copy);
      });
      row.appendChild(name);
      row.appendChild(meta);
      row.appendChild(loadBtn);
      row.appendChild(dupBtn);
      if (!item._builtin) {
        const delBtn = document.createElement("button");
        delBtn.className = "md-btn md-library-del";
        delBtn.textContent = "✕";
        delBtn.addEventListener("click", () => {
          if (deleteMap(item.id)) {
            this._toast(`deleted ${item.name}`);
            this._renderLibrary();
          }
        });
        row.appendChild(delBtn);
      } else {
        // Spacer so the row grid lines up.
        const spacer = document.createElement("span");
        spacer.className = "md-library-spacer";
        row.appendChild(spacer);
      }
      list.appendChild(row);
    }
  }

  // ---- Helpers -------------------------------------------------------------

  _reflowSpawnsIfDefault() {
    // Detect "untouched" spawn rects via approximate proportional match,
    // then re-derive at the new size. If the user nudged anything, leave
    // the spawn rects alone — they're now authored, not derived.
    for (const side of ["blue", "red"]) {
      const sp = this._draft.spawn[side];
      const propX = side === "blue" ? this._draft.mapW * 0.10 : this._draft.mapW * 0.90;
      const propY = this._draft.mapH / 2;
      const propW = this._draft.mapW * 0.13;
      const propH = this._draft.mapH * 0.84;
      const looksDefault =
        Math.abs(sp.x - propX) < 1 || // exact OR no edit yet at all
        Math.abs(sp.w - propW) < 1;
      if (looksDefault) {
        sp.x = propX; sp.y = propY; sp.w = propW; sp.h = propH;
      }
    }
  }

  _new() {
    this._draft = blankMap({ name: "New Map" });
    this._syncAll();
  }

  _save() {
    const res = validateMap(this._draft);
    if (!res.ok) { this._toast(`invalid: ${res.errors[0]}`, true); return; }
    try {
      saveMap(res.value);
      this._draft = res.value;
      this._toast(`saved "${res.value.name}"`);
      this._renderLibrary();
    } catch (e) {
      this._toast(`save failed: ${e.message}`, true);
    }
  }

  async _export() {
    const res = validateMap(this._draft);
    if (!res.ok) { this._toast(`invalid: ${res.errors[0]}`, true); return; }
    const fenced = serializeMap(res.value);
    const ok = await writeClipboard(fenced);
    if (ok) this._toast(`exported to clipboard (${fenced.length} chars)`);
    else this._showFallbackExport(fenced);
  }

  async _import() {
    let text = await readClipboard();
    if (text == null) text = window.prompt("Paste the map (fenced ```json block or raw JSON):") || "";
    if (!text) return;
    const res = parseMap(text);
    if (!res.ok) { this._toast(`import failed: ${res.errors[0]}`, true); return; }
    this.loadDraft(res.value);
    this._toast(`imported "${res.value.name}"`);
  }

  _showFallbackExport(text) {
    const wrap = document.createElement("div");
    wrap.className = "md-fallback-export";
    wrap.innerHTML = `
      <div class="md-fallback-panel">
        <div class="md-fallback-title">EXPORT — copy manually</div>
        <textarea class="md-fallback-text" readonly></textarea>
        <button class="md-btn">CLOSE</button>
      </div>
    `;
    wrap.querySelector(".md-fallback-text").value = text;
    wrap.querySelector(".md-fallback-text").select();
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

// Clipboard helpers (same as battle/ship designers).
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
