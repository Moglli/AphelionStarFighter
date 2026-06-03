/**
 * @file Battle Designer — DOM overlay for authoring Scenarios.
 *
 * Wraps the format/store primitives shipped in PR-1a in a fullscreen DOM
 * editor: meta (name + notes + player team), two-column team builders,
 * a saved-scenario list, and the Save / Save As / Test Play / Export /
 * Import buttons.
 *
 * Scope (PR-1b): klass + count + stance + priority + assignment per
 * ship-group. NOT in this cut (each its own later PR): mini-arena
 * drag-place, map dropdown beyond defaults, platform placement, blueprint
 * (designId) picker.
 *
 * Lifecycle: lazy-mounted by main.js's `_ensureBattleDesigner()` and the
 * `Battle Designer` button on the dev overlay. State lives on the
 * instance — `this._draft` is the scenario currently being edited (a
 * defensive clone so SaveStore changes don't ghost into the editor mid-
 * session). `show()` re-syncs from saveStore so a save→load round trip
 * picks up the latest list.
 */

import {
  blankScenario, validateScenario, serializeScenario, parseScenario,
} from "../scenario/format.js";
import {
  listScenarios, getScenario, saveScenario, deleteScenario,
} from "../scenario/store.js";
import { listBlueprints } from "../blueprints/store.js";
import { listAllMaps } from "../maps/store.js";

const RACES = ["terran", "reavers", "hegemony", "voidsworn", "thren", "brood", "vanguard", "saurian", "synthetic"];
const KLASSES = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier"];
const STANCES = ["ENGAGE", "CHARGE", "STANDOFF", "HOLD", "FALLBACK"];
const PRIORITIES = ["DEFAULT", "HUNT", "FOCUS"];
const ASSIGNMENTS = ["FREE_ROAM", "ESCORT", "GUARD_POINT"];

export class BattleDesigner {
  constructor(host, deps) {
    // deps: { game, onTestPlay(scenario), onClose() }
    this.host = host;
    this.deps = deps;
    this._draft = blankScenario({ name: "New Scenario" });
    this._visible = false;
    this._mount();
  }

  _mount() {
    const el = document.createElement("div");
    el.id = "battle-designer";
    el.className = "battle-designer hidden";
    el.innerHTML = `
      <div class="bd-panel">
        <header class="bd-header">
          <span class="bd-title">BATTLE DESIGNER</span>
          <button class="bd-x" id="bd-close" title="Close">✕</button>
        </header>

        <section class="bd-meta">
          <label class="bd-field">
            <span>NAME</span>
            <input id="bd-name" type="text" maxlength="60" />
          </label>
          <label class="bd-field">
            <span>NOTES</span>
            <input id="bd-notes" type="text" maxlength="200" placeholder="Optional — surfaced when re-loading"/>
          </label>
          <label class="bd-field bd-field-tight">
            <span>MAP</span>
            <select id="bd-map-id"></select>
          </label>
          <label class="bd-field bd-field-tight">
            <span>PLAYER</span>
            <select id="bd-player-team">
              <option value="blue">BLUE</option>
              <option value="red">RED</option>
            </select>
          </label>
          <label class="bd-field bd-field-tight">
            <span>PLAYER SHIP</span>
            <select id="bd-player-klass"></select>
          </label>
        </section>

        <section class="bd-teams">
          <div class="bd-side" data-side="blue">
            <h3>BLUE TEAMS</h3>
            <div class="bd-teams-list" id="bd-blue-teams"></div>
            <button class="bd-btn" id="bd-blue-add">+ ADD TEAM</button>
          </div>
          <div class="bd-side" data-side="red">
            <h3>RED TEAMS</h3>
            <div class="bd-teams-list" id="bd-red-teams"></div>
            <button class="bd-btn" id="bd-red-add">+ ADD TEAM</button>
          </div>
        </section>

        <section class="bd-library">
          <h3>SAVED SCENARIOS</h3>
          <div class="bd-library-list" id="bd-library-list"></div>
        </section>

        <footer class="bd-footer">
          <button class="bd-btn" id="bd-import">IMPORT</button>
          <button class="bd-btn" id="bd-export">EXPORT (clipboard)</button>
          <button class="bd-btn" id="bd-save">SAVE</button>
          <button class="bd-btn bd-btn-primary" id="bd-test">TEST PLAY ▶</button>
        </footer>

        <div class="bd-toast" id="bd-toast"></div>
      </div>
    `;
    this.host.appendChild(el);
    this._el = el;
    this._nameEl = el.querySelector("#bd-name");
    this._notesEl = el.querySelector("#bd-notes");
    this._playerTeamEl = el.querySelector("#bd-player-team");
    this._playerKlassEl = el.querySelector("#bd-player-klass");
    this._blueListEl = el.querySelector("#bd-blue-teams");
    this._redListEl = el.querySelector("#bd-red-teams");
    this._libraryListEl = el.querySelector("#bd-library-list");
    this._toastEl = el.querySelector("#bd-toast");

    // Populate the player-ship-klass dropdown once.
    for (const k of KLASSES) {
      const opt = document.createElement("option");
      opt.value = k; opt.textContent = k.toUpperCase();
      this._playerKlassEl.appendChild(opt);
    }

    // Top-level field wire-ups. Each change writes through to this._draft.
    this._nameEl.addEventListener("input", () => { this._draft.name = this._nameEl.value; });
    this._notesEl.addEventListener("input", () => { this._draft.notes = this._notesEl.value; });
    this._playerTeamEl.addEventListener("change", () => { this._draft.playerTeam = this._playerTeamEl.value; });
    this._playerKlassEl.addEventListener("change", () => {
      this._draft.playerShip = { ...this._draft.playerShip, klass: this._playerKlassEl.value };
    });

    el.querySelector("#bd-close").addEventListener("click", () => this.hide());
    el.querySelector("#bd-blue-add").addEventListener("click", () => this._addTeam("blue"));
    el.querySelector("#bd-red-add").addEventListener("click", () => this._addTeam("red"));
    el.querySelector("#bd-save").addEventListener("click", () => this._save());
    el.querySelector("#bd-test").addEventListener("click", () => this._test());
    el.querySelector("#bd-export").addEventListener("click", () => this._export());
    el.querySelector("#bd-import").addEventListener("click", () => this._import());
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

  /** Replace the active draft (used by Load / Import). Re-validates. */
  loadDraft(scenario) {
    const res = validateScenario(scenario);
    if (!res.ok) {
      this._toast(`load failed: ${res.errors[0]}`, true);
      return false;
    }
    // Defensive clone — editing the draft must not bleed into the saved
    // copy or another scenario's data.
    this._draft = JSON.parse(JSON.stringify(res.value));
    if (this._visible) this._syncAll();
    return true;
  }

  /** Read-only snapshot of the current draft (for tests + probes). */
  getDraft() { return JSON.parse(JSON.stringify(this._draft)); }

  // ---- Internal rendering --------------------------------------------------

  _syncAll() {
    this._nameEl.value = this._draft.name || "";
    this._notesEl.value = this._draft.notes || "";
    this._playerTeamEl.value = this._draft.playerTeam || "blue";
    this._playerKlassEl.value = (this._draft.playerShip && this._draft.playerShip.klass) || "fighter";
    this._renderTeams("blue");
    this._renderTeams("red");
    this._renderLibrary();
  }

  _renderTeams(side) {
    const list = side === "blue" ? this._blueListEl : this._redListEl;
    const teams = side === "blue" ? this._draft.blueTeams : this._draft.redTeams;
    list.innerHTML = "";
    teams.forEach((team, ti) => {
      list.appendChild(this._teamCard(side, team, ti));
    });
  }

  _teamCard(side, team, ti) {
    const card = document.createElement("div");
    card.className = "bd-team-card";
    const raceSel = this._select("bd-race", RACES, team.race, (val) => { team.race = val; });
    const removeBtn = this._btn("✕", "bd-team-remove", () => {
      const arr = side === "blue" ? this._draft.blueTeams : this._draft.redTeams;
      arr.splice(ti, 1);
      this._renderTeams(side);
    });
    const header = document.createElement("div");
    header.className = "bd-team-header";
    header.appendChild(raceSel);
    header.appendChild(removeBtn);

    const shipsWrap = document.createElement("div");
    shipsWrap.className = "bd-ships";
    team.ships.forEach((row, ri) => {
      shipsWrap.appendChild(this._shipRow(team, row, ri, () => {
        team.ships.splice(ri, 1);
        this._renderTeams(side);
      }));
    });
    const addShip = this._btn("+ ADD SHIP", "bd-ship-add", () => {
      team.ships.push({ klass: "fighter", count: 1 });
      this._renderTeams(side);
    });

    card.appendChild(header);
    card.appendChild(shipsWrap);
    card.appendChild(addShip);
    return card;
  }

  _shipRow(team, row, ri, onRemove) {
    const wrap = document.createElement("div");
    wrap.className = "bd-ship-row";
    const klassSel = this._select("bd-klass", KLASSES, row.klass, (v) => {
      row.klass = v;
      // Klass change invalidates the blueprint if it was klass-specific —
      // re-render the row so the designId dropdown re-filters.
      const blueprintSelEl = wrap.querySelector(".bd-designid");
      if (blueprintSelEl) {
        const fresh = this._designIdSelect(row);
        blueprintSelEl.replaceWith(fresh);
      }
    });
    wrap.appendChild(klassSel);

    const count = document.createElement("input");
    count.type = "number"; count.min = "1"; count.max = "99"; count.value = String(row.count || 1);
    count.className = "bd-count";
    count.addEventListener("input", () => { row.count = Math.max(1, Math.min(99, Number(count.value) || 1)); });
    wrap.appendChild(count);

    wrap.appendChild(this._select("bd-stance", ["—", ...STANCES], row.stance || "—",
      (v) => { row.stance = v === "—" ? null : v; }));
    wrap.appendChild(this._select("bd-priority", ["—", ...PRIORITIES], row.priority || "—",
      (v) => { row.priority = v === "—" ? null : v; }));
    wrap.appendChild(this._select("bd-assignment", ["—", ...ASSIGNMENTS], row.assignment || "—",
      (v) => { row.assignment = v === "—" ? null : v; }));

    wrap.appendChild(this._designIdSelect(row));
    wrap.appendChild(this._btn("✕", "bd-ship-remove", onRemove));
    return wrap;
  }

  // Blueprint picker for a ship row. Filters by klass — a frigate row
  // only sees frigate blueprints. Unset = stock spec (no design applied).
  _designIdSelect(row) {
    const sel = document.createElement("select");
    sel.className = "bd-designid";
    const none = document.createElement("option");
    none.value = ""; none.textContent = "— stock —";
    sel.appendChild(none);
    const items = listBlueprints().filter((bp) => bp.klass === row.klass);
    for (const bp of items) {
      const o = document.createElement("option");
      o.value = bp.id; o.textContent = bp.name;
      sel.appendChild(o);
    }
    sel.value = row.designId || "";
    sel.addEventListener("change", () => {
      row.designId = sel.value || null;
    });
    return sel;
  }

  _renderLibrary() {
    const list = this._libraryListEl;
    list.innerHTML = "";
    const items = listScenarios();
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bd-library-empty";
      empty.textContent = "no saved scenarios yet — author one and click SAVE";
      list.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "bd-library-row";
      const name = document.createElement("span");
      name.className = "bd-library-name";
      name.textContent = item.name;
      const meta = document.createElement("span");
      meta.className = "bd-library-meta";
      const blueShips = (item.blueTeams || []).reduce((n, t) => n + (t.ships || []).reduce((a, s) => a + s.count, 0), 0);
      const redShips = (item.redTeams || []).reduce((n, t) => n + (t.ships || []).reduce((a, s) => a + s.count, 0), 0);
      meta.textContent = `${blueShips} blue · ${redShips} red`;
      const loadBtn = this._btn("LOAD", "bd-library-load", () => this.loadDraft(item));
      const dupBtn = this._btn("DUP", "bd-library-dup", () => {
        const copy = JSON.parse(JSON.stringify(item));
        copy.id = `scenario-${Date.now().toString(36)}`;
        copy.name = `${item.name} (copy)`;
        this.loadDraft(copy);
      });
      const delBtn = this._btn("✕", "bd-library-del", () => {
        if (deleteScenario(item.id)) {
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

  // ---- DOM helpers ---------------------------------------------------------

  _select(cls, options, value, onChange) {
    const sel = document.createElement("select");
    sel.className = cls;
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt; o.textContent = opt;
      sel.appendChild(o);
    }
    sel.value = value;
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  }

  _btn(label, cls, onClick) {
    const b = document.createElement("button");
    b.className = `bd-btn ${cls}`;
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  _addTeam(side) {
    const arr = side === "blue" ? this._draft.blueTeams : this._draft.redTeams;
    arr.push({ race: "terran", ships: [{ klass: "fighter", count: 1 }] });
    this._renderTeams(side);
  }

  // ---- Actions -------------------------------------------------------------

  _save() {
    const res = validateScenario(this._draft);
    if (!res.ok) {
      this._toast(`invalid: ${res.errors[0]}`, true);
      return;
    }
    try {
      // If the id is the auto-generated "scenario-<timestamp>" pattern and
      // a save with the same name already exists, prompt rename (the user
      // probably hit SAVE expecting Save As). For v1: just keep the id —
      // future PR can add Save As.
      saveScenario(res.value);
      this._draft = res.value;   // pick up normalized values
      this._toast(`saved "${res.value.name}"`);
      this._renderLibrary();
    } catch (e) {
      this._toast(`save failed: ${e.message}`, true);
    }
  }

  _test() {
    const res = validateScenario(this._draft);
    if (!res.ok) {
      this._toast(`invalid: ${res.errors[0]}`, true);
      return;
    }
    if (this.deps.onTestPlay) this.deps.onTestPlay(res.value);
    this.hide();
  }

  async _export() {
    const res = validateScenario(this._draft);
    if (!res.ok) {
      this._toast(`invalid: ${res.errors[0]}`, true);
      return;
    }
    const fenced = serializeScenario(res.value);
    const ok = await writeClipboard(fenced);
    if (ok) {
      this._toast(`exported to clipboard (${fenced.length} chars)`);
    } else {
      // Clipboard API blocked — drop into a textarea the user can copy
      // manually. Fallback is the load-bearing path on iOS Safari + any
      // non-secure context.
      this._showFallbackExport(fenced);
    }
  }

  async _import() {
    let text = await readClipboard();
    if (text == null) {
      text = window.prompt("Paste the scenario (fenced ```json block or raw JSON):") || "";
    }
    if (!text) return;
    const res = parseScenario(text);
    if (!res.ok) {
      this._toast(`import failed: ${res.errors[0]}`, true);
      return;
    }
    this.loadDraft(res.value);
    this._toast(`imported "${res.value.name}"`);
  }

  _showFallbackExport(text) {
    const wrap = document.createElement("div");
    wrap.className = "bd-fallback-export";
    wrap.innerHTML = `
      <div class="bd-fallback-panel">
        <div class="bd-fallback-title">EXPORT — copy manually</div>
        <textarea class="bd-fallback-text" readonly></textarea>
        <button class="bd-btn">CLOSE</button>
      </div>
    `;
    wrap.querySelector(".bd-fallback-text").value = text;
    wrap.querySelector(".bd-fallback-text").select();
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

// ---- Clipboard helpers ----------------------------------------------------
// navigator.clipboard is gated on secure context + user gesture; in mobile
// webviews + non-https it can be missing. The fallback (textarea select +
// document.execCommand("copy")) still works in most webviews, including iOS
// Capacitor. Both return true on success, false otherwise.

async function writeClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_e) { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
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
  } catch (_e) { /* fall through */ }
  return null;
}
