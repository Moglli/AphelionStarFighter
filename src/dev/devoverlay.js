/**
 * @file Dev Overlay — DOM panel for live playtest controls.
 *
 * Mounts a top-right panel with: pause / step / sim-speed, a selected-ship
 * readout, and per-ship actions (heal / kill / invuln / surrender). Plus a
 * SPAWN mode that turns the next canvas tap into a "spawn ship here"
 * affordance.
 *
 * Coordinates: the host (main.js) owns the camera + zoom + view-size, so we
 * accept a `deps` bundle with getter callbacks rather than reaching into
 * globals. `handlePointer(screenX, screenY)` does the screen→world transform
 * using those getters and returns true if the overlay consumed the event
 * (so the caller can stop propagation before the gameplay input layer
 * sees the click).
 *
 * State lives on the instance (selected ship id, spawn mode, last speed
 * index). Sync() is called every frame to refresh the readout — cheap,
 * just DOM text updates.
 */

import { createShip } from "../ship.js";
import { ARENA, randomSpawnPos } from "../arena.js";

const SPEED_STEPS = [0.25, 0.5, 1, 2, 4];
const RACES = ["terran", "reavers", "hegemony", "voidsworn", "thren"];
const KLASSES = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier"];

export class DevOverlay {
  constructor(host, deps) {
    // deps: { game, getCamera(), getZoom(), getView() => {w,h} }
    this.host = host;
    this.deps = deps;
    this._selectedId = null;
    this._spawnMode = false;
    this._spawnConfig = { race: "terran", klass: "fighter", side: "red" };
    this._visible = false;
    this._mount();
  }

  _mount() {
    const el = document.createElement("div");
    el.id = "dev-overlay";
    el.className = "dev-overlay hidden";
    el.innerHTML = `
      <div class="dev-overlay-header">
        <span>DEV OVERLAY</span>
        <button class="dev-x" id="dev-close" title="Close (~)">✕</button>
      </div>
      <div class="dev-row">
        <button class="dev-btn" id="dev-pause">PAUSE</button>
        <button class="dev-btn" id="dev-step" disabled>STEP</button>
        <span class="dev-pill" id="dev-speed">×1</span>
        <button class="dev-btn small" id="dev-speed-down">−</button>
        <button class="dev-btn small" id="dev-speed-up">+</button>
      </div>
      <div class="dev-row dev-sel">
        <span class="dev-label">SEL</span>
        <span class="dev-sel-text" id="dev-sel-text">none — tap a ship</span>
      </div>
      <div class="dev-row">
        <button class="dev-btn" id="dev-heal">HEAL</button>
        <button class="dev-btn" id="dev-kill">KILL</button>
        <button class="dev-btn" id="dev-invuln">INVULN</button>
        <button class="dev-btn" id="dev-surrender">SURR</button>
      </div>
      <div class="dev-row dev-spawn-row">
        <select class="dev-select" id="dev-spawn-race"></select>
        <select class="dev-select" id="dev-spawn-klass"></select>
        <select class="dev-select" id="dev-spawn-side">
          <option value="blue">BLUE</option>
          <option value="red" selected>RED</option>
        </select>
        <button class="dev-btn" id="dev-spawn">SPAWN…</button>
      </div>
      <div class="dev-row">
        <button class="dev-btn" id="dev-open-designer">BATTLE DESIGNER ▸</button>
        <button class="dev-btn" id="dev-open-ship-designer">SHIP DESIGNER ▸</button>
      </div>
      <div class="dev-row">
        <button class="dev-btn" id="dev-open-map-designer">MAP DESIGNER ▸</button>
        <button class="dev-btn" id="dev-open-platform-designer">PLATFORMS ▸</button>
      </div>
      <div class="dev-hint" id="dev-hint">~ toggles · \\ steps · [ ] speed</div>
    `;
    this.host.appendChild(el);

    // Populate race + klass dropdowns.
    const raceSel = el.querySelector("#dev-spawn-race");
    for (const r of RACES) {
      const opt = document.createElement("option");
      opt.value = r; opt.textContent = r.toUpperCase();
      if (r === this._spawnConfig.race) opt.selected = true;
      raceSel.appendChild(opt);
    }
    const klassSel = el.querySelector("#dev-spawn-klass");
    for (const k of KLASSES) {
      const opt = document.createElement("option");
      opt.value = k; opt.textContent = k.toUpperCase();
      if (k === this._spawnConfig.klass) opt.selected = true;
      klassSel.appendChild(opt);
    }

    this._el = el;
    this._pauseBtn = el.querySelector("#dev-pause");
    this._stepBtn = el.querySelector("#dev-step");
    this._speedPill = el.querySelector("#dev-speed");
    this._selText = el.querySelector("#dev-sel-text");
    this._spawnBtn = el.querySelector("#dev-spawn");
    this._hint = el.querySelector("#dev-hint");
    this._raceSel = raceSel;
    this._klassSel = klassSel;
    this._sideSel = el.querySelector("#dev-spawn-side");

    el.querySelector("#dev-close").addEventListener("click", () => this.hide());
    this._pauseBtn.addEventListener("click", () => this.togglePause());
    this._stepBtn.addEventListener("click", () => this.step());
    el.querySelector("#dev-speed-down").addEventListener("click", () => this.bumpSpeed(-1));
    el.querySelector("#dev-speed-up").addEventListener("click", () => this.bumpSpeed(1));
    el.querySelector("#dev-heal").addEventListener("click", () => this.healSelected());
    el.querySelector("#dev-kill").addEventListener("click", () => this.killSelected());
    el.querySelector("#dev-invuln").addEventListener("click", () => this.toggleInvuln());
    el.querySelector("#dev-surrender").addEventListener("click", () => this.surrenderSelected());
    raceSel.addEventListener("change", () => { this._spawnConfig.race = raceSel.value; });
    klassSel.addEventListener("change", () => { this._spawnConfig.klass = klassSel.value; });
    this._sideSel.addEventListener("change", () => { this._spawnConfig.side = this._sideSel.value; });
    this._spawnBtn.addEventListener("click", () => this.toggleSpawnMode());
    // Lazy-launch the Battle Designer via the deps hook so this module
    // doesn't import the designer directly (keeps devoverlay's bundle
    // share small + lets main.js own the designer lifecycle).
    const designerBtn = el.querySelector("#dev-open-designer");
    if (designerBtn) {
      designerBtn.addEventListener("click", () => {
        if (this.deps.openBattleDesigner) this.deps.openBattleDesigner();
      });
    }
    const shipDesignerBtn = el.querySelector("#dev-open-ship-designer");
    if (shipDesignerBtn) {
      shipDesignerBtn.addEventListener("click", () => {
        if (this.deps.openShipDesigner) this.deps.openShipDesigner();
      });
    }
    const mapDesignerBtn = el.querySelector("#dev-open-map-designer");
    if (mapDesignerBtn) {
      mapDesignerBtn.addEventListener("click", () => {
        if (this.deps.openMapDesigner) this.deps.openMapDesigner();
      });
    }
    const platformDesignerBtn = el.querySelector("#dev-open-platform-designer");
    if (platformDesignerBtn) {
      platformDesignerBtn.addEventListener("click", () => {
        if (this.deps.openPlatformDesigner) this.deps.openPlatformDesigner();
      });
    }
  }

  isVisible() { return this._visible; }

  show() {
    this._visible = true;
    this._el.classList.remove("hidden");
  }

  hide() {
    this._visible = false;
    this._el.classList.add("hidden");
    if (this._spawnMode) this.toggleSpawnMode(); // exit spawn mode on close
  }

  toggle() {
    if (this._visible) this.hide(); else this.show();
  }

  togglePause() {
    const g = this.deps.game;
    g.paused = !g.paused;
    this._pauseBtn.textContent = g.paused ? "RESUME" : "PAUSE";
    this._stepBtn.disabled = !g.paused;
  }

  step() {
    const g = this.deps.game;
    if (!g.paused) return;
    g.stepOnce = true;
  }

  bumpSpeed(dir) {
    const g = this.deps.game;
    const cur = SPEED_STEPS.indexOf(g.simSpeed || 1);
    const idx = Math.max(0, Math.min(SPEED_STEPS.length - 1, (cur < 0 ? 2 : cur) + dir));
    g.simSpeed = SPEED_STEPS[idx];
    this._speedPill.textContent = `×${g.simSpeed}`;
  }

  _selectedShip() {
    const g = this.deps.game;
    if (this._selectedId == null) return null;
    return g.ships.find((s) => s.id === this._selectedId) || null;
  }

  select(id) {
    this._selectedId = id;
  }

  healSelected() {
    const s = this._selectedShip();
    if (!s) return;
    s.hp = s.hpMax;
    s.shield = s.shieldMax;
    if (s.modules) {
      for (const m of s.modules) { m.dead = false; if (m.hpMax != null) m.hp = m.hpMax; }
    }
    if (s.cells) {
      for (const c of s.cells) { c.dead = false; if (c.hpMax != null) c.hp = c.hpMax; }
    }
    s.surrendered = false;
  }

  killSelected() {
    const s = this._selectedShip();
    if (!s) return;
    s.hp = 0;
    if (s.cells && s.coreCell) s.coreCell.dead = true;
  }

  toggleInvuln() {
    const s = this._selectedShip();
    if (!s) return;
    s._devGod = !s._devGod;
  }

  surrenderSelected() {
    const s = this._selectedShip();
    if (!s) return;
    s.surrendered = !s.surrendered;
  }

  toggleSpawnMode() {
    this._spawnMode = !this._spawnMode;
    this._spawnBtn.classList.toggle("active", this._spawnMode);
    this._spawnBtn.textContent = this._spawnMode ? "SPAWN ←" : "SPAWN…";
    this._hint.textContent = this._spawnMode
      ? "TAP a spot to spawn · ~ closes"
      : "~ toggles · \\ steps · [ ] speed";
  }

  // Called by main.js from the capture-phase pointer listener. Returns
  // true if the overlay consumed the click (selection or spawn). Caller
  // should stop propagation so InputManager doesn't see it.
  handlePointer(screenX, screenY) {
    if (!this._visible) return false;
    const g = this.deps.game;
    if (g.state !== "playing") return false;

    const view = this.deps.getView();
    const cam = this.deps.getCamera();
    const z = this.deps.getZoom() || 1;
    // Inverse of main.js#draw's transform stack:
    //   translate(viewW/2, viewH/2) → scale(zoom) → translate(-camera.x, -camera.y)
    const wx = (screenX - view.w / 2) / z + cam.x;
    const wy = (screenY - view.h / 2) / z + cam.y;

    if (this._spawnMode) {
      this._spawnAt(wx, wy);
      // Stay in spawn mode for rapid-fire placement; tap the SPAWN
      // button (or ~) to exit.
      return true;
    }

    // Selection — nearest ship within a generous pick radius.
    let best = null;
    let bestD = 60 * 60 / (z * z); // 60-pixel pick radius, world-space
    for (const s of g.ships) {
      if (s.dead) continue;
      const dx = s.pos.x - wx, dy = s.pos.y - wy;
      const d = dx * dx + dy * dy;
      const r = (s.spec && s.spec.radius) || 24;
      const eff = Math.max(bestD, r * r);
      if (d <= eff && (best == null || d < bestD)) {
        best = s; bestD = d;
      }
    }
    if (best) {
      this.select(best.id);
      return true;
    }
    return false;
  }

  _spawnAt(wx, wy) {
    const g = this.deps.game;
    // Clamp inside arena bounds so spawns don't end up off-map.
    const b = g.arena && g.arena.bounds;
    if (b) {
      wx = Math.max(b.minX + 50, Math.min(b.maxX - 50, wx));
      wy = Math.max(b.minY + 50, Math.min(b.maxY - 50, wy));
    }
    const cfg = this._spawnConfig;
    // Default heading: face the enemy centroid (or center of arena).
    let heading = 0;
    const enemyCentroid = (() => {
      let sx = 0, sy = 0, n = 0;
      for (const s of g.ships) {
        if (s.dead || s.side === cfg.side) continue;
        sx += s.pos.x; sy += s.pos.y; n++;
      }
      return n ? { x: sx / n, y: sy / n } : { x: ARENA.width / 2, y: ARENA.height / 2 };
    })();
    heading = Math.atan2(enemyCentroid.y - wy, enemyCentroid.x - wx);

    const ship = createShip({
      klass: cfg.klass,
      race: cfg.race,
      side: cfg.side,
      pos: { x: wx, y: wy },
      heading,
      controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
    });
    g.ships.push(ship);
  }

  // Per-frame DOM refresh of the selected-ship readout.
  sync() {
    if (!this._visible) return;
    const s = this._selectedShip();
    if (!s) {
      this._selText.textContent = "none — tap a ship";
      return;
    }
    const hp = Math.round(s.hp);
    const hpMax = Math.round(s.hpMax);
    const sh = Math.round(s.shield);
    const shMax = Math.round(s.shieldMax);
    const side = s.side === "blue" ? "B" : "R";
    const flags = [];
    if (s._devGod) flags.push("GOD");
    if (s.surrendered) flags.push("SURR");
    if (s.dead) flags.push("DEAD");
    const flagStr = flags.length ? ` [${flags.join(" ")}]` : "";
    this._selText.textContent =
      `${side} #${s.id} ${s.klass} (${s.race}) · HP ${hp}/${hpMax} · SH ${sh}/${shMax}${flagStr}`;
  }
}

// Convenience: also append a small spawn at a random-ish point — used by
// the `window.dev.quickSpawn(klass, race, side)` probe so tests can poke
// the game without driving the overlay.
export function quickSpawn(game, opts = {}) {
  const cfg = {
    race: opts.race || "terran",
    klass: opts.klass || "fighter",
    side: opts.side || "red",
  };
  const zone = game.arena && game.arena.spawn && game.arena.spawn[cfg.side];
  const pos = zone ? randomSpawnPos(zone) : { x: ARENA.width / 2, y: ARENA.height / 2 };
  const ship = createShip({
    klass: cfg.klass,
    race: cfg.race,
    side: cfg.side,
    pos,
    heading: cfg.side === "red" ? Math.PI : 0,
    controller: { thrust: { x: 0, y: 0 }, aim: null, firing: false, firingMissile: false },
  });
  game.ships.push(ship);
  return ship;
}
