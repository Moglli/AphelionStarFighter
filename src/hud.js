import { CLASSES, SIDES } from "./classes.js";
import { ARENA } from "./arena.js";
import { getSpectateTarget } from "./game.js";
import { RACES } from "./races.js";

const CLASS_ORDER = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier", "station"];

const CLASS_GLYPH = {
  fighter: "Sw", bomber: "Ar", frigate: "Ca",
  cruiser: "Kn", battleship: "Se", carrier: "Su", station: "Fo",
};

// Friendly labels for module names that appear in the target panel.
const MODULE_LABELS = {
  laser:            "Heavy Laser",
  "missile-fwd":    "Missile Bay Fwd",
  "missile-aft":    "Missile Bay Aft",
  "broadside-port": "Broadside Port",
  "broadside-stbd": "Broadside Stbd",
  "pd-bow":         "PD Bow",
  "pd-stern":       "PD Stern",
  hangar:           "Hangar",
  "pd-port":        "PD Port",
  "pd-stbd":        "PD Stbd",
  "torpedo-bay":    "Torpedo Bay",
  "pd-cluster":     "PD Cluster",
};

function countBySide(ships) {
  const out = {
    blue: { fighter: 0, bomber: 0, frigate: 0, cruiser: 0, battleship: 0, carrier: 0, station: 0 },
    red:  { fighter: 0, bomber: 0, frigate: 0, cruiser: 0, battleship: 0, carrier: 0, station: 0 },
  };
  for (const s of ships) if (!s.dead) out[s.side][s.klass]++;
  return out;
}

function moduleBarColor(frac) {
  if (frac > 0.66) return "#4f8";
  if (frac > 0.33) return "#fc6";
  return "#f64";
}

function endPoint(beam) {
  if (beam.target && beam.target.pos) {
    const dx = beam.target.pos.x - beam.origin.x;
    const dy = beam.target.pos.y - beam.origin.y;
    const d = Math.hypot(dx, dy) || 1;
    // Bury the beam into the hull instead of running it to the
    // target's centre. Stop `radius * 0.5` short of centre — i.e.
    // halfway between the leading hull edge and the centre — so the
    // beam visibly carves into the silhouette without drilling all
    // the way through to a tidy centre dot.
    const targetR = (beam.target.spec && beam.target.spec.radius) || 0;
    const buryStop = Math.max(d - targetR * 0.5, 0);
    const r = Math.min(buryStop, beam.range);
    return { x: beam.origin.x + (dx / d) * r, y: beam.origin.y + (dy / d) * r };
  }
  return { x: beam.origin.x + beam.range, y: beam.origin.y };
}

// ---------------------------------------------------------------------------
// BattleHUD: DOM-based HUD overlay for mobile + desktop
// ---------------------------------------------------------------------------
export class BattleHUD {
  constructor(mountEl, inputManager) {
    this._input = inputManager;
    this._root = document.createElement("div");
    this._root.id = "battle-root";
    this._root.className = "battle-root";
    this._root.style.cssText = "visibility:hidden;position:absolute;inset:0;z-index:20;pointer-events:none;overflow:hidden;";

    // ---- Side strips ----
    this._sideLeft = this._createEl("div", "side-strip side-left", "side-strip-left");
    this._sideRight = this._createEl("div", "side-strip side-right", "side-strip-right");
    this._root.appendChild(this._sideLeft);
    this._root.appendChild(this._sideRight);

    // ---- Top-right pills ----
    const topRight = this._createEl("div", "battle-top-right");
    const spectateBtn = this._createEl("button", "battle-pill", "spectate-btn");
    spectateBtn.textContent = "SPECTATE";
    spectateBtn.style.pointerEvents = "auto";
    topRight.appendChild(spectateBtn);
    // QUIT pill — abandons the current match and returns to the main
    // menu. Always available so the player can bail out of a stuck or
    // unwinnable fight without waiting for the stall watchdog.
    const quitBtn = this._createEl("button", "battle-pill quit-pill", "quit-btn");
    quitBtn.textContent = "QUIT";
    quitBtn.style.pointerEvents = "auto";
    topRight.appendChild(quitBtn);
    this._root.appendChild(topRight);

    // ---- Damage indicator ----
    const dmgInd = this._createEl("div", "damage-indicator", "damage-indicator");
    dmgInd.setAttribute("aria-hidden", "true");
    for (const dir of ["north", "east", "south", "west"]) {
      const arc = this._createEl("div", `damage-arc damage-${dir}`);
      arc.dataset.dir = dir;
      dmgInd.appendChild(arc);
    }
    this._root.appendChild(dmgInd);
    this._damageArcs = Array.from(dmgInd.children);

    // ---- Lock reticle ----
    const reticle = this._createEl("div", "lock-reticle", "lock-reticle");
    reticle.setAttribute("aria-hidden", "true");
    reticle.innerHTML = `
      <div class="reticle-ring"></div>
      <div class="reticle-dot"></div>
      <div class="reticle-bracket-left"></div>
      <div class="reticle-bracket-right"></div>
    `;
    this._root.appendChild(reticle);

    // ---- Compass ----
    const compass = this._createEl("div", "compass", "compass");
    compass.setAttribute("aria-hidden", "true");
    compass.innerHTML = `<div class="compass-arrow"></div><div class="compass-label">TGT</div>`;
    this._root.appendChild(compass);
    this._compassArrow = compass.querySelector(".compass-arrow");

    // ---- Target panel ----
    const targetPanel = this._createEl("div", "target-panel", "target-panel");
    targetPanel.setAttribute("aria-hidden", "true");
    targetPanel.innerHTML = `
      <div class="target-header">
        <span class="target-label">MARKED</span>
        <span class="target-name" id="target-name"></span>
      </div>
      <div class="target-bars" id="target-bars"></div>
      <div class="target-modules" id="target-modules"></div>
    `;
    this._root.appendChild(targetPanel);

    // ---- Minimap ----
    const minimap = this._createEl("div", "minimap", "minimap");
    minimap.innerHTML = `
      <div class="minimap-header">
        <span>BATTLEFIELD MAP</span>
        <span class="minimap-count" id="minimap-count"></span>
      </div>
      <div class="minimap-viewport" id="minimap-viewport"></div>
    `;
    this._root.appendChild(minimap);
    this._minimapViewport = minimap.querySelector("#minimap-viewport");

    // ---- Vitals bar ----
    const vitals = this._createEl("div", "vitals-bar", "vitals-bar");
    vitals.innerHTML = `
      <div class="vitals-row" id="vitals-shield-row" style="display:none;">
        <span class="vital-label">SHIELD</span>
        <div class="vital-bar"><div class="vital-fill shield-fill" id="shield-fill"></div></div>
        <span class="vital-value" id="shield-value"></span>
      </div>
      <div class="vitals-row">
        <span class="vital-label">HULL</span>
        <div class="vital-bar"><div class="vital-fill hull-fill" id="hull-fill"></div></div>
        <span class="vital-value" id="hull-value"></span>
      </div>
      <div class="vitals-row" id="vitals-gun-row" style="display:none;">
        <span class="vital-label" id="gun-label">GUN</span>
        <div class="vital-bar"><div class="vital-fill gun-fill" id="gun-fill"></div></div>
        <span class="vital-value" id="gun-value"></span>
      </div>
    `;
    this._root.appendChild(vitals);

    // ---- Respawn panel ----
    const respawn = this._createEl("div", "respawn-panel", "respawn-panel");
    respawn.setAttribute("aria-hidden", "true");
    respawn.innerHTML = `<div class="respawn-label">REINFORCEMENTS</div><div class="respawn-timer" id="respawn-timer"></div>`;
    this._root.appendChild(respawn);

    // ---- Match over panel ----
    const matchover = this._createEl("div", "matchover-panel", "matchover-panel");
    matchover.setAttribute("aria-hidden", "true");
    matchover.innerHTML = `
      <div class="matchover-title" id="matchover-title"></div>
      <div class="matchover-subtitle" id="matchover-subtitle"></div>
      <div class="matchover-prompt" id="matchover-prompt"></div>
    `;
    this._root.appendChild(matchover);

    // ---- Spectate pill ----
    const spectatePill = this._createEl("div", "spectate-pill", "spectate-pill");
    spectatePill.setAttribute("aria-hidden", "true");
    spectatePill.innerHTML = `<span class="spectate-tag">OBSERVING</span><span class="spectate-ship" id="spectate-ship"></span>`;
    this._root.appendChild(spectatePill);

    // ---- Virtual sticks ----
    this._vstickLeft = this._buildVstick("left", "vstick-left");
    this._vstickRight = this._buildVstick("right", "vstick-right");
    this._root.appendChild(this._vstickLeft);
    this._root.appendChild(this._vstickRight);

    // ---- Action cluster ----
    const actionCluster = this._createEl("div", "action-cluster", "action-cluster");
    actionCluster.innerHTML = `
      <button class="action-btn fire-btn" id="fire-btn" aria-label="Fire primary weapon">
        <div class="btn-glow"></div>
        <span class="btn-icon">&#x26A1;</span>
        <span class="btn-label">STRIKE</span>
      </button>
      <button class="action-btn missile-btn" id="missile-btn" aria-label="Fire missile">
        <div class="btn-glow"></div>
        <span class="btn-icon">&#x1F680;</span>
        <span class="btn-label">SPC</span>
        <div class="btn-cooldown" id="missile-cooldown"></div>
      </button>
      <button class="action-btn boost-btn" id="boost-btn" aria-label="Speed boost">
        <div class="btn-glow"></div>
        <span class="btn-icon">&#x25B2;</span>
        <span class="btn-label">CHARGE</span>
      </button>
    `;
    this._root.appendChild(actionCluster);

    // ---- Admiral panel ----
    // Now a three-block layout: a master-command bar (ALL HOLD / FREE
    // / PRESS + MISSILES), a focus-target pill (visible only when an
    // enemy is locked as focus fire), and the per-class command grid
    // with live counts + colour-coded posture buttons.
    const admiralPanel = this._createEl("div", "admiral-panel", "admiral-panel");
    admiralPanel.setAttribute("aria-hidden", "true");
    admiralPanel.innerHTML = `
      <div class="admiral-title">FLEET COMMAND</div>
      <div class="admiral-master" id="admiral-master">
        <button class="admiral-master-btn master-hold"  data-master="hold">ALL HOLD</button>
        <button class="admiral-master-btn master-free"  data-master="free">ALL FREE</button>
        <button class="admiral-master-btn master-press" data-master="press">ALL PRESS</button>
        <button class="admiral-master-btn master-missiles" id="admiral-master-missiles">MISSILES: FREE</button>
      </div>
      <div class="admiral-focus" id="admiral-focus">
        <span class="focus-label">FOCUS FIRE</span>
        <span class="focus-name" id="admiral-focus-name">Tap an enemy to focus</span>
        <button class="focus-clear" id="admiral-focus-clear" title="Clear focus">&times;</button>
      </div>
      <div class="admiral-grid" id="admiral-grid"></div>
    `;
    this._root.appendChild(admiralPanel);

    // Command toast — brief floating caption at top-centre that flashes
    // when the admiral issues an order. Gives instant feedback so the
    // player sees the command landed, even before the fleet reacts.
    const toast = this._createEl("div", "admiral-toast", "admiral-toast");
    toast.setAttribute("aria-hidden", "true");
    this._root.appendChild(toast);
    this._admiralToast = toast;
    this._admiralToastTimer = null;

    mountEl.appendChild(this._root);

    // ---- Cache DOM refs for fast sync() ----
    this._shieldRow = this._root.querySelector("#vitals-shield-row");
    this._shieldFill = this._root.querySelector("#shield-fill");
    this._shieldValue = this._root.querySelector("#shield-value");
    this._hullFill = this._root.querySelector("#hull-fill");
    this._hullValue = this._root.querySelector("#hull-value");
    this._gunRow = this._root.querySelector("#vitals-gun-row");
    this._gunFill = this._root.querySelector("#gun-fill");
    this._gunValue = this._root.querySelector("#gun-value");
    this._gunLabel = this._root.querySelector("#gun-label");
    this._respawnPanel = this._root.querySelector("#respawn-panel");
    this._respawnTimer = this._root.querySelector("#respawn-timer");
    this._matchoverPanel = this._root.querySelector("#matchover-panel");
    this._matchoverTitle = this._root.querySelector("#matchover-title");
    this._matchoverSubtitle = this._root.querySelector("#matchover-subtitle");
    this._matchoverPrompt = this._root.querySelector("#matchover-prompt");
    this._spectatePill = this._root.querySelector("#spectate-pill");
    this._spectateShip = this._root.querySelector("#spectate-ship");
    this._targetPanelEl = this._root.querySelector("#target-panel");
    this._targetName = this._root.querySelector("#target-name");
    this._targetBars = this._root.querySelector("#target-bars");
    this._targetModules = this._root.querySelector("#target-modules");
    this._minimapCount = this._root.querySelector("#minimap-count");
    this._fireBtn = this._root.querySelector("#fire-btn");
    this._missileBtn = this._root.querySelector("#missile-btn");
    this._missileCooldown = this._root.querySelector("#missile-cooldown");
    this._boostBtn = this._root.querySelector("#boost-btn");
    this._admiralPanelEl = this._root.querySelector("#admiral-panel");
    this._admiralGrid = this._root.querySelector("#admiral-grid");
    this._compassEl = this._root.querySelector("#compass");
    this._lockReticle = this._root.querySelector("#lock-reticle");
    this._spectateBtnEl = this._root.querySelector("#spectate-btn");

    // ---- State for sync ----
    this._dotPool = [];         // { el, shipId }
    this._lastHp = 0;
    this._lastHpMax = 1;
    this._damageFlashTimer = 0;
    this._damageDir = null;
    this._sideCells = { blue: [], red: [] };
    this._prevCountsKey = "";
    this._isMobile = false;
    this._admiralClickHandlers = [];

    // ---- Wire spectate button click ----
    this._spectateBtnEl.addEventListener("click", () => {
      if (this._input && this._input.spectateBtn) {
        this._input.spectateBtn.justPressed = true;
      }
    });

    // ---- Wire QUIT button click ----
    // Sets an InputManager flag that main.js drains every frame, the
    // same way the canvas-side enter-press / spectate signal work.
    // Confirmation step lives in main.js so the HUD stays cheap and
    // doesn't need to know about game lifecycle.
    this._quitBtnEl = this._root.querySelector("#quit-btn");
    if (this._quitBtnEl) {
      this._quitBtnEl.addEventListener("click", () => {
        if (this._input) this._input.quitRequested = true;
      });
    }

    // ---- Wire action-cluster buttons (FIRE / MISSILE / BOOST) ----
    // Each DOM .action-btn has `pointer-events: auto` (so the canvas
    // pointerdown below never sees these taps) but no handlers were
    // ever attached — the old canvas FireButton hit-tests run on the
    // canvas which the DOM button shadowed. Result since the overhaul:
    // tapping STRIKE / SPC / CHARGE did nothing.
    //
    // The InputManager already exposes the pressed-state pipeline on
    // `fireBtn` / `missileBtn` / `boostBtn` — we just need the DOM
    // events to drive into start()/end()/consumeJustPressed.
    const wireHoldButton = (el, ibtn) => {
      if (!el || !ibtn) return;
      const onDown = (e) => {
        if (e.cancelable) e.preventDefault();
        if (typeof el.setPointerCapture === "function") {
          try { el.setPointerCapture(e.pointerId); } catch (_) {}
        }
        ibtn.start(e.pointerId);
      };
      const onUp = (e) => {
        if (ibtn.pointerId === e.pointerId || ibtn.pointerId == null) {
          ibtn.end();
        }
      };
      el.addEventListener("pointerdown", onDown);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
      el.addEventListener("pointerleave", onUp);
    };
    wireHoldButton(this._fireBtn, this._input && this._input.fireBtn);
    wireHoldButton(this._boostBtn, this._input && this._input.boostBtn);
    // Missile is edge-triggered; main.js consumes the press once.
    if (this._missileBtn && this._input && this._input.missileBtn) {
      this._missileBtn.addEventListener("pointerdown", (e) => {
        if (e.cancelable) e.preventDefault();
        this._input.missileBtn.start(e.pointerId);
      });
      this._missileBtn.addEventListener("pointerup", (e) => {
        if (this._input.missileBtn.pointerId === e.pointerId) {
          this._input.missileBtn.end();
        }
      });
    }

    // ---- Build side strip cells once ----
    this._buildSideStrip(this._sideLeft, "blue", "FRIENDLY");
    this._buildSideStrip(this._sideRight, "red", "ENEMY");
  }

  _createEl(tag, className, id) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (id) el.id = id;
    return el;
  }

  _buildVstick(side, id) {
    const el = this._createEl("div", `vstick vstick-${side}`, id);
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = `
      <div class="vstick-base" id="${id}-base"></div>
      <div class="vstick-knob" id="${id}-knob"></div>
      <div class="vstick-deadzone"></div>
    `;
    return el;
  }

  _buildSideStrip(container, sideKey, title) {
    const palette = SIDES[sideKey];
    const titleEl = this._createEl("div", "side-title");
    titleEl.textContent = title;
    titleEl.style.color = palette.primary;
    container.appendChild(titleEl);

    const raceEl = this._createEl("div", "side-race");
    raceEl.id = `side-race-${sideKey}`;
    container.appendChild(raceEl);

    const grid = this._createEl("div", "roster-grid");
    for (const klass of CLASS_ORDER) {
      const cell = this._createEl("div", "roster-cell");
      cell.dataset.klass = klass;
      cell.innerHTML = `<div class="cell-glyph">${CLASS_GLYPH[klass] || "?"}</div><div class="cell-count">0</div>`;
      grid.appendChild(cell);
      this._sideCells[sideKey].push(cell);
    }
    container.appendChild(grid);
  }

  sync(game, viewW, viewH) {
    this._isMobile = viewW < 768;

    // Mode-based chrome visibility first. Piloting-only elements (the
    // fire/missile/boost cluster, aim stick, damage arcs, compass, lock
    // reticle, respawn timer) hide in spectate AND admiral because
    // there's no piloted ship to drive them. Vitals stays on in
    // spectate (shows the locked target) but hides in admiral where
    // the fleet-command panel takes the bottom slot. Without this
    // pass the HUD piles 8+ overlapping widgets in admiral mode.
    this._syncModeChrome(game);

    // 1. Side strips
    this._syncSideStrips(game, viewW);

    // 2. Vitals bar
    this._syncVitals(game);

    // 3. Minimap
    this._syncMinimap(game);

    // 4. Target panel
    this._syncTargetPanel(game);

    // 5. Damage indicator
    this._syncDamageIndicator(game);

    // 6. Lock reticle
    this._syncLockReticle(game);

    // 7. Compass
    this._syncCompass(game);

    // 8. Respawn panel
    this._syncRespawn(game);

    // 9. Match over panel
    this._syncMatchOver(game);

    // 10. Spectate pill
    this._syncSpectate(game);

    // 11. Virtual sticks
    if (this._input) {
      if (this._input.left) this._input.left._updateDOM();
      if (this._input.right) this._input.right._updateDOM();
    }

    // 12. Action buttons
    this._syncActionButtons(game);

    // 13. Admiral panel
    this._syncAdmiralPanel(game);
  }

  _syncModeChrome(game) {
    const piloting = !game.spectating && !game.admiralMode;
    const admiral = !!game.admiralMode;
    const setVis = (el, show) => { if (el) el.style.display = show ? "" : "none"; };
    // Piloting-only chrome.
    setVis(this._root.querySelector("#action-cluster"), piloting);
    setVis(this._root.querySelector("#damage-indicator"), piloting);
    setVis(this._root.querySelector("#compass"), piloting);
    setVis(this._root.querySelector("#lock-reticle"), piloting);
    setVis(this._root.querySelector("#respawn-panel"), piloting);
    // Vitals: hide only in admiral (in spectate it tracks the locked
    // target, which is useful chrome).
    setVis(this._root.querySelector("#vitals-bar"), !admiral);
    // Right virtual stick (aim) is meaningless without a piloted ship.
    setVis(this._root.querySelector("#vstick-right"), piloting);
    // Admiral mode is "you ARE the admiral" — the "OBSERVING <ship>"
    // pill is confusing (you're not observing a specific ship, you're
    // commanding the whole fleet), and it overlaps the centred target
    // panel. Keep it for non-admiral spectate where it actually says
    // which ship the camera is locked to.
    setVis(this._root.querySelector("#spectate-pill"), !admiral);
  }

  _syncSideStrips(game, viewW) {
    const hide = viewW < 768;
    this._sideLeft.style.display = hide ? "none" : "";
    this._sideRight.style.display = hide ? "none" : "";
    if (hide) return;

    const counts = countBySide(game.ships);
    const countKey = JSON.stringify(counts);
    if (countKey === this._prevCountsKey) return; // skip if unchanged
    this._prevCountsKey = countKey;

    const races = { blue: game.alliedRace, red: game.hostileRace };
    for (const side of ["blue", "red"]) {
      const raceInfo = RACES[races[side]] || RACES.terran;
      const raceEl = this._root.querySelector(`#side-race-${side}`);
      if (raceEl) raceEl.textContent = raceInfo.name ? raceInfo.name.toUpperCase() : "";
      for (let i = 0; i < CLASS_ORDER.length; i++) {
        const klass = CLASS_ORDER[i];
        const cell = this._sideCells[side][i];
        const c = counts[side][klass] || 0;
        const countEl = cell.querySelector(".cell-count");
        if (countEl) countEl.textContent = String(c);
        cell.classList.toggle("empty", c === 0);
      }
    }
  }

  _syncVitals(game) {
    const player = game.ships.find((s) => s.isPlayer && !s.dead);
    let ship = player;
    if (!ship && game.spectating) {
      ship = getSpectateTarget(game);
    }

    if (ship && !ship.dead) {
      const hasShield = ship.shieldMax > 0;
      const hasAmmo = ship.spec && ship.spec.weapon && ship.spec.weapon.capacity != null;

      this._shieldRow.style.display = hasShield ? "" : "none";
      if (hasShield) {
        const shieldFrac = Math.max(0, Math.min(1, ship.shield / ship.shieldMax));
        this._shieldFill.style.width = `${shieldFrac * 100}%`;
        this._shieldValue.textContent = `${Math.max(0, Math.round(ship.shield))} / ${ship.shieldMax}`;
      }

      const hullFrac = Math.max(0, Math.min(1, ship.hp / ship.hpMax));
      this._hullFill.style.width = `${hullFrac * 100}%`;
      this._hullFill.classList.toggle("critical", hullFrac < 0.33);
      this._hullValue.textContent = `${Math.max(0, Math.round(ship.hp))} / ${ship.hpMax}`;

      this._gunRow.style.display = hasAmmo ? "" : "none";
      if (hasAmmo) {
        const cap = ship.spec.weapon.capacity;
        if (ship.weaponReloading) {
          const reloadFrac = 1 - (ship.weaponReloadTimer / ship.spec.weapon.reloadTime);
          this._gunFill.style.width = `${Math.max(0, reloadFrac) * 100}%`;
          this._gunFill.style.background = "linear-gradient(90deg, #8a6a1a, #fd6)";
          this._gunValue.textContent = `RELOAD ${Math.max(0, ship.weaponReloadTimer).toFixed(1)}s`;
        } else {
          const ammoFrac = ship.weaponAmmo / cap;
          this._gunFill.style.width = `${ammoFrac * 100}%`;
          this._gunFill.style.background = "linear-gradient(90deg, #8a6a1a, #fd6)";
          this._gunValue.textContent = `${ship.weaponAmmo} / ${cap}`;
        }
      }
    } else if (game.respawnTimer > 0) {
      // Hide vitals during respawn
      this._shieldRow.style.display = "none";
      this._gunRow.style.display = "none";
      this._hullFill.style.width = "0%";
      this._hullValue.textContent = "";
    }
  }

  _syncMinimap(game) {
    const mapW = this._isMobile ? 140 : 200;
    const mapH = this._isMobile ? 100 : 140;
    const sx = mapW / ARENA.width;
    const sy = mapH / ARENA.height;

    // Filter aggressively: any ship that's flagged dead, has had its
    // wreck spawned (signals the death has been visually committed),
    // or has dropped to non-positive hull HP should NOT show on the
    // minimap. The game.ships array filter in update() already strips
    // dead non-player ships, but the dead player ship stays around
    // during respawn and a paranoid extra layer here guards against
    // any future ship-removal-timing change.
    const liveShips = game.ships.filter(
      (s) => !s.dead && !s.wreckSpawned && (s.hp == null || s.hp > 0),
    );
    this._minimapCount.textContent = `${liveShips.length} units`;

    // Reuse dot elements from pool
    const needed = liveShips.length;
    while (this._dotPool.length < needed) {
      const dot = document.createElement("div");
      dot.className = "minimap-dot";
      this._minimapViewport.appendChild(dot);
      this._dotPool.push({ el: dot, shipId: null });
    }

    // Hide excess dots
    for (let i = needed; i < this._dotPool.length; i++) {
      this._dotPool[i].el.style.display = "none";
      this._dotPool[i].shipId = null;
    }

    for (let i = 0; i < liveShips.length; i++) {
      const s = liveShips[i];
      const pool = this._dotPool[i];
      const dot = pool.el;
      const isSpec = game.spectating && s.id === game.spectateTargetId;
      const isPlayer = s.isPlayer || isSpec;

      dot.style.display = "";
      dot.className = "minimap-dot" +
        (isPlayer ? " dot-player" : (s.side === "blue" ? " dot-blue" : " dot-red")) +
        ` dot-size-${s.klass || "fighter"}`;

      const px = s.pos.x * sx;
      const py = s.pos.y * sy;
      dot.style.transform = `translate(${px}px, ${py}px)`;
      pool.shipId = s.id;
    }
  }

  _syncTargetPanel(game) {
    const focusTarget = pickFocusTarget(game);
    if (!focusTarget) {
      this._targetPanelEl.classList.remove("active");
      this._targetPanelEl.setAttribute("aria-hidden", "true");
      return;
    }

    const ship = focusTarget;
    this._targetPanelEl.classList.add("active");
    this._targetPanelEl.setAttribute("aria-hidden", "false");

    const raceName = (RACES[ship.race] && RACES[ship.race].name) || "Unknown";
    const klassName = (CLASSES[ship.klass] && CLASSES[ship.klass].name) || ship.klass;
    this._targetName.textContent = `${raceName} ${klassName}`;

    // Bars: shield (if any) → armor (capitals only) → hull. Mirrors the
    // damage-resolution order so the readout matches what the player
    // sees in combat.
    let barsHtml = "";
    if (ship.shieldMax > 0) {
      const shieldFrac = Math.max(0, Math.min(1, ship.shield / ship.shieldMax));
      barsHtml += `
        <div class="target-bar-row">
          <span style="font-size:9px;color:#9bd;width:36px;">SHIELD</span>
          <div class="target-bar"><div class="target-bar-fill" style="width:${shieldFrac * 100}%;background:#5cf;"></div></div>
        </div>`;
    }
    if (ship.armorMax > 0) {
      const armorFrac = Math.max(0, Math.min(1, ship.armor / ship.armorMax));
      barsHtml += `
        <div class="target-bar-row">
          <span style="font-size:9px;color:#9bd;width:36px;">ARMOR</span>
          <div class="target-bar"><div class="target-bar-fill" style="width:${armorFrac * 100}%;background:#c93;"></div></div>
        </div>`;
    }
    const hullFrac = Math.max(0, Math.min(1, ship.hp / ship.hpMax));
    barsHtml += `
      <div class="target-bar-row">
        <span style="font-size:9px;color:#9bd;width:36px;">HULL</span>
        <div class="target-bar"><div class="target-bar-fill" style="width:${hullFrac * 100}%;background:#4f6;"></div></div>
      </div>`;
    this._targetBars.innerHTML = barsHtml;

    // Module rows
    let modulesHtml = "";
    if (ship.modules) {
      for (const m of ship.modules) {
        const label = MODULE_LABELS[m.name] || m.name;
        if (m.disabled) {
          modulesHtml += `<div class="target-module-row destroyed"><span class="target-module-name">${label}</span><span class="target-module-hp">DESTROYED</span></div>`;
        } else {
          const frac = Math.max(0, Math.min(1, m.hp / m.hpMax));
          const color = moduleBarColor(frac);
          modulesHtml += `
            <div class="target-module-row">
              <span class="target-module-name">${label}</span>
              <span class="target-module-hp" style="color:${color};">${Math.round(frac * 100)}%</span>
            </div>`;
        }
      }
    }
    this._targetModules.innerHTML = modulesHtml;
  }

  _syncDamageIndicator(game) {
    const player = game.ships.find((s) => s.isPlayer && !s.dead);
    if (!player) {
      this._clearDamageFlash();
      return;
    }

    const curHp = player.hp;
    if (this._lastHpMax > 0 && curHp < this._lastHp && this._lastHp > 0) {
      // Damage taken - determine direction
      const dmg = this._lastHp - curHp;
      this._triggerDamageDirection(game, player, dmg);
    }
    this._lastHp = curHp;
    this._lastHpMax = player.hpMax;

    // Decrement flash timer
    if (this._damageFlashTimer > 0) {
      this._damageFlashTimer--;
      if (this._damageFlashTimer <= 0) {
        this._clearDamageFlash();
      }
    }
  }

  _triggerDamageDirection(game, player, _dmg) {
    // Find nearest enemy as damage source
    let bestAngle = 0;
    let bestDist = Infinity;
    for (const s of game.ships) {
      if (s.dead || s.side === player.side) continue;
      const dx = s.pos.x - player.pos.x;
      const dy = s.pos.y - player.pos.y;
      const d = Math.hypot(dx, dy);
      if (d < bestDist) {
        bestDist = d;
        bestAngle = Math.atan2(dy, dx);
      }
    }

    // Map angle to N/E/S/W quadrant
    // angle 0 = east, PI/2 = south, PI = west, -PI/2 = north
    let dir;
    const a = bestAngle;
    if (a >= -Math.PI * 0.75 && a < -Math.PI * 0.25) dir = "north";
    else if (a >= -Math.PI * 0.25 && a < Math.PI * 0.25) dir = "east";
    else if (a >= Math.PI * 0.25 && a < Math.PI * 0.75) dir = "south";
    else dir = "west";

    this._clearDamageFlash();
    const arc = this._damageArcs.find((el) => el.dataset.dir === dir);
    if (arc) {
      arc.classList.add("hit");
      // Force reflow to restart animation
      void arc.offsetWidth;
    }
    this._damageFlashTimer = 30; // ~0.5s at 60fps
    this._damageDir = dir;
  }

  _clearDamageFlash() {
    for (const arc of this._damageArcs) {
      arc.classList.remove("hit");
    }
    this._damageDir = null;
  }

  _syncLockReticle(game) {
    const player = game.ships.find((s) => s.isPlayer && !s.dead);
    if (!player || !player.targetId) {
      this._lockReticle.classList.remove("active");
      return;
    }
    const target = game.ships.find((s) => s.id === player.targetId && !s.dead);
    if (!target) {
      this._lockReticle.classList.remove("active");
      return;
    }
    // Show reticle when target is within weapon range
    const range = player.spec && player.spec.weapon ? player.spec.weapon.range : 900;
    const dist = Math.hypot(target.pos.x - player.pos.x, target.pos.y - player.pos.y);
    this._lockReticle.classList.toggle("active", dist <= range);
  }

  _syncCompass(game) {
    const player = game.ships.find((s) => s.isPlayer && !s.dead);
    if (!player) {
      this._compassEl.classList.remove("active");
      return;
    }

    // Find nearest enemy
    let nearest = null;
    let bestD2 = Infinity;
    for (const s of game.ships) {
      if (s.dead || s.side === player.side) continue;
      const dx = s.pos.x - player.pos.x;
      const dy = s.pos.y - player.pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { nearest = s; bestD2 = d2; }
    }

    if (!nearest) {
      this._compassEl.classList.remove("active");
      return;
    }

    this._compassEl.classList.add("active");
    const dx = nearest.pos.x - player.pos.x;
    const dy = nearest.pos.y - player.pos.y;
    const angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;
    this._compassArrow.style.transform = `rotate(${angle}deg)`;
  }

  _syncRespawn(game) {
    if (game.respawnTimer > 0) {
      this._respawnPanel.classList.add("active");
      this._respawnPanel.setAttribute("aria-hidden", "false");
      this._respawnTimer.textContent = game.respawnTimer.toFixed(1) + "s";
    } else {
      this._respawnPanel.classList.remove("active");
      this._respawnPanel.setAttribute("aria-hidden", "true");
    }
  }

  _syncMatchOver(game) {
    if (game.matchOver) {
      this._matchoverPanel.classList.add("active");
      this._matchoverPanel.setAttribute("aria-hidden", "false");

      const isRoguelite = game.mode === "roguelite";
      const won = game.winner === "blue";
      const stalled = !!game.endedByStall;

      // Career-summary takes priority — set on game by main.js's
      // runEnded handler when the run is over (either war-won or any
      // defeat). We show the rank + callsign + flavor blurb instead
      // of a generic "DEFEAT" / "VICTORY".
      const summary = game.runSummary;
      if (isRoguelite && summary) {
        const headline = summary.won ? "WAR WON" : "CAREER ENDED";
        this._matchoverTitle.textContent = headline;
        const handle = `${summary.rank}${summary.callsign ? ` ${summary.callsign}` : ""}`;
        const progress = `Act ${summary.act}/${summary.actsTotal} · ${summary.visitedCount} jumps`;
        this._matchoverSubtitle.innerHTML =
          `<strong>${handle}</strong><br>${summary.flavor || ""}<br><span style="opacity:0.65;font-size:0.85em;">${progress}</span>`;
        this._matchoverSubtitle.style.color = summary.won ? "#bfd" : "#fdb";
        this._matchoverPrompt.textContent = "Tap to return to home";
        return;
      }

      let msg;
      if (stalled) msg = "STALEMATE";
      else if (isRoguelite) msg = won ? "NODE CLEARED" : "FLEET LOSSES";
      else msg = won ? "VICTORY" : "DEFEAT";
      this._matchoverTitle.textContent = msg;

      if (stalled) {
        this._matchoverSubtitle.textContent = "No contact for 45s — match resolved by ship count.";
        this._matchoverSubtitle.style.color = "#fdb";
      } else if (isRoguelite) {
        const sub = won ? "Returning to starmap..." : "Fleet took losses -- check the starmap.";
        this._matchoverSubtitle.textContent = sub;
        this._matchoverSubtitle.style.color = won ? "#bfd" : "#fdb";
      } else {
        this._matchoverSubtitle.textContent = "";
      }

      const prompt = isRoguelite ? "Tap to return to starmap" : "Tap to continue";
      this._matchoverPrompt.textContent = prompt;
    } else {
      this._matchoverPanel.classList.remove("active");
      this._matchoverPanel.setAttribute("aria-hidden", "true");
    }
  }

  _syncSpectate(game) {
    if (game.spectating) {
      this._spectatePill.classList.add("active");
      this._spectatePill.setAttribute("aria-hidden", "false");
      const t = getSpectateTarget(game);
      if (t) {
        const palette = SIDES[t.side];
        const raceInfo = RACES[t.race] || RACES.terran;
        this._spectateShip.textContent = `${palette.name} ${raceInfo.name} ${t.spec.name}`;
      } else {
        this._spectateShip.textContent = "No targets in sight";
      }
    } else {
      this._spectatePill.classList.remove("active");
      this._spectatePill.setAttribute("aria-hidden", "true");
    }
  }

  _syncActionButtons(game) {
    // Fire button
    if (this._input && this._input.fireBtn) {
      this._input.fireBtn._updateDOM(this._fireBtn);
    }

    // Missile button
    if (this._input && this._input.missileBtn) {
      const player = game.ships.find((s) => s.isPlayer && !s.dead);
      if (player && player.spec && player.spec.missile) {
        this._missileBtn.style.display = "";
        const cd = player.spec.missile.cooldown;
        const remain = player.missileCd || 0;
        const ready = remain <= 0;
        const frac = ready ? 0 : (remain / cd);
        this._input.missileBtn._updateDOM(this._missileBtn, ready, frac);
      } else {
        this._missileBtn.style.display = "none";
      }
    }

    // Boost button
    if (this._input && this._input.boostBtn) {
      this._input.boostBtn._updateDOM(this._boostBtn);
    }

    // Spectate button
    if (game.spectating) {
      this._spectateBtnEl.textContent = "RETURN TO FIELD";
    } else {
      this._spectateBtnEl.textContent = "SPECTATE";
    }
  }

  _syncAdmiralPanel(game) {
    if (game.admiralMode && game.directives) {
      this._admiralPanelEl.classList.add("active");
      this._admiralPanelEl.setAttribute("aria-hidden", "false");
      this._rebuildAdmiralGrid(game);
    } else {
      this._admiralPanelEl.classList.remove("active");
      this._admiralPanelEl.setAttribute("aria-hidden", "true");
    }
  }

  _rebuildAdmiralGrid(game) {
    // Live ship counts per class — drives the "FIGHTER ×12" stamp on
    // each cell so the player sees how many ships each command will
    // affect right now. Recompute every frame; cheap.
    const blueCounts = { fighter: 0, bomber: 0, frigate: 0, cruiser: 0, battleship: 0, carrier: 0 };
    for (const s of game.ships) {
      if (s.dead || s.side !== "blue") continue;
      if (blueCounts[s.klass] != null) blueCounts[s.klass]++;
    }

    // Focus bar — visible when a focus target is locked.
    const focusBar = this._root.querySelector("#admiral-focus");
    const focusNameEl = this._root.querySelector("#admiral-focus-name");
    const focusClearBtn = this._root.querySelector("#admiral-focus-clear");
    const focusTarget = game.focusTargetId != null
      ? game.ships.find((s) => s.id === game.focusTargetId && !s.dead)
      : null;
    if (focusBar) {
      if (focusTarget) {
        focusBar.classList.add("active");
        if (focusNameEl) {
          const raceName = (RACES[focusTarget.race] && RACES[focusTarget.race].name) || focusTarget.race;
          const klassName = (CLASSES[focusTarget.klass] && CLASSES[focusTarget.klass].name) || focusTarget.klass;
          focusNameEl.textContent = `${raceName} ${klassName}`;
        }
      } else {
        focusBar.classList.remove("active");
        if (focusNameEl) focusNameEl.textContent = "Tap an enemy to focus";
      }
    }
    if (focusClearBtn && !focusClearBtn._wired) {
      focusClearBtn._wired = true;
      focusClearBtn.addEventListener("click", () => {
        game.focusTargetId = null;
        this._toastAdmiral("FOCUS CLEARED");
      });
    }

    // Wire master-command bar buttons (only once).
    if (!this._admiralMasterWired) {
      this._admiralMasterWired = true;
      const masterBar = this._root.querySelector("#admiral-master");
      if (masterBar) {
        for (const btn of masterBar.querySelectorAll(".admiral-master-btn[data-master]")) {
          const posture = btn.dataset.master;
          btn.addEventListener("click", () => {
            if (game.setPosture) {
              for (const klass of ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier"]) {
                game.setPosture(klass, posture);
              }
            }
            this._toastAdmiral(`ALL FLEET · ${posture.toUpperCase()}`);
          });
        }
      }
      const masterMissiles = this._root.querySelector("#admiral-master-missiles");
      if (masterMissiles) {
        masterMissiles.addEventListener("click", () => {
          if (!game.setMissiles) return;
          // Toggle: if any pod-equipped class is currently FREE, switch
          // all to HOLD; otherwise switch all to FREE. Only the four
          // classes that actually carry pods count — fighter +
          // carrier never had missiles flag in spec, so they're
          // skipped to keep the label semantics honest.
          const podClasses = ["bomber", "frigate", "cruiser", "battleship"];
          const anyFree = podClasses.some((k) => {
            const d = game.directives && game.directives[k];
            return d && d.missiles !== "hold";
          });
          const next = anyFree ? "hold" : "on";
          for (const klass of podClasses) game.setMissiles(klass, next);
          this._toastAdmiral(`MISSILES · ${next === "hold" ? "HOLD" : "FREE"}`);
        });
      }
    }
    // Reflect current master-missiles state in the button label. Label
    // describes the *current* state ("MISSILES: HOLD" means pods are
    // held), not the action the button will take.
    const masterMissiles = this._root.querySelector("#admiral-master-missiles");
    if (masterMissiles) {
      const podClasses = ["bomber", "frigate", "cruiser", "battleship"];
      const anyFree = podClasses.some((k) => {
        const d = game.directives && game.directives[k];
        return d && d.missiles !== "hold";
      });
      masterMissiles.textContent = `MISSILES: ${anyFree ? "FREE" : "HOLD"}`;
      masterMissiles.classList.toggle("missiles-hold", !anyFree);
    }

    // Only rebuild the per-class grid when directives change. Counts
    // update separately below so we don't tear DOM each frame just to
    // update an integer.
    const dirKey = JSON.stringify(game.directives);
    const needsGridRebuild = this._lastAdmiralKey !== dirKey;
    if (needsGridRebuild) {
      this._lastAdmiralKey = dirKey;
      for (const h of this._admiralClickHandlers) {
        h.el.removeEventListener("click", h.fn);
      }
      this._admiralClickHandlers = [];

      const classes = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier"];
      const postures = ["hold", "free", "press"];
      const missileClasses = new Set(["bomber", "frigate", "cruiser", "battleship"]);
      const CLASS_GLYPHS = { fighter: "F", bomber: "B", frigate: "Fr", cruiser: "C", battleship: "BB", carrier: "CV" };

      this._admiralGrid.innerHTML = "";
      this._admiralCellEls = {};
      for (const klass of classes) {
        const d = game.directives[klass] || { posture: "free", missiles: "on" };
        const cell = document.createElement("div");
        cell.className = "admiral-cell";

        // Cell header: class glyph + name + live count.
        const head = document.createElement("div");
        head.className = "admiral-cell-head";
        head.innerHTML = `
          <span class="admiral-cell-glyph">${CLASS_GLYPHS[klass] || "?"}</span>
          <span class="admiral-cell-name">${klass.toUpperCase()}</span>
          <span class="admiral-cell-count" data-klass="${klass}">×0</span>
        `;
        cell.appendChild(head);

        // Posture buttons — colour-coded by class.
        const postureBar = document.createElement("div");
        postureBar.className = "admiral-cell-postures";
        for (const p of postures) {
          const btn = document.createElement("button");
          btn.className = `posture-btn posture-${p}` + (d.posture === p ? " active" : "");
          btn.textContent = p.toUpperCase();
          const handler = () => {
            if (game.setPosture) game.setPosture(klass, p);
            this._toastAdmiral(`${klass.toUpperCase()} · ${p.toUpperCase()}`);
            btn.classList.add("flash");
            setTimeout(() => btn.classList.remove("flash"), 240);
          };
          btn.addEventListener("click", handler);
          this._admiralClickHandlers.push({ el: btn, fn: handler });
          postureBar.appendChild(btn);
        }

        if (missileClasses.has(klass)) {
          const mBtn = document.createElement("button");
          const held = d.missiles === "hold";
          mBtn.className = "posture-btn missile-toggle" + (held ? " active" : "");
          mBtn.textContent = held ? "M HOLD" : "M FREE";
          mBtn.title = held ? "Missile pods HOLD — tap to free" : "Missile pods FREE — tap to hold";
          const handler = () => {
            if (game.setMissiles) game.setMissiles(klass, held ? "on" : "hold");
            this._toastAdmiral(`${klass.toUpperCase()} · MISSILES ${held ? "FREE" : "HOLD"}`);
            mBtn.classList.add("flash");
            setTimeout(() => mBtn.classList.remove("flash"), 240);
          };
          mBtn.addEventListener("click", handler);
          this._admiralClickHandlers.push({ el: mBtn, fn: handler });
          postureBar.appendChild(mBtn);
        }

        cell.appendChild(postureBar);
        this._admiralGrid.appendChild(cell);
        this._admiralCellEls[klass] = cell;
      }
    }

    // Update per-cell live counts every frame (cheap text writes).
    if (this._admiralCellEls) {
      for (const klass of Object.keys(this._admiralCellEls)) {
        const cell = this._admiralCellEls[klass];
        const countEl = cell && cell.querySelector(".admiral-cell-count");
        if (countEl) countEl.textContent = `×${blueCounts[klass] || 0}`;
      }
    }
  }

  // Briefly flash a caption at the top-centre of the screen whenever
  // the admiral issues a command. Gives instant feedback even before
  // the fleet visibly reacts. Replaces any in-flight toast — useful
  // when the player taps several buttons in quick succession.
  _toastAdmiral(msg) {
    if (!this._admiralToast) return;
    this._admiralToast.textContent = msg;
    this._admiralToast.classList.remove("active");
    // Force reflow so the active-class animation restarts cleanly.
    void this._admiralToast.offsetWidth;
    this._admiralToast.classList.add("active");
    if (this._admiralToastTimer) clearTimeout(this._admiralToastTimer);
    this._admiralToastTimer = setTimeout(() => {
      if (this._admiralToast) this._admiralToast.classList.remove("active");
    }, 1400);
  }

  show() { this._root.style.visibility = "visible"; }
  hide() { this._root.style.visibility = "hidden"; }

  destroy() {
    // Clean up listeners
    for (const h of this._admiralClickHandlers) {
      h.el.removeEventListener("click", h.fn);
    }
    this._admiralClickHandlers = [];
    if (this._root.parentElement) {
      this._root.parentElement.removeChild(this._root);
    }
  }
}

// ---------------------------------------------------------------------------
// Backward-compat: main.js calls this; route to BattleHUD if available
// ---------------------------------------------------------------------------
export function drawHUD(ctx, game, viewW, viewH, missileBtn, startMenu) {
  // When BattleHUD is active (managed in main.js), this function becomes a
  // no-op because the DOM HUD handles everything. We keep the signature so
  // main.js's import doesn't break during transition.
  // The actual sync() + show()/hide() calls are in main.js's draw loop.
}

// ---------------------------------------------------------------------------
// Beams still rendered on canvas — unchanged
// ---------------------------------------------------------------------------
export function drawBeams(ctx, game) {
  if (!game.beams || game.beams.length === 0) return;
  for (const beam of game.beams) {
    const dur = beam.duration || 1;
    const frac = Math.max(0, Math.min(1, beam.ttl / dur));
    const fadeOut = Math.min(1, frac * 5);
    const fadeIn  = Math.min(1, (1 - frac) * 6);
    const alpha = Math.max(0.35, fadeOut * fadeIn);
    const wobble = 1 + Math.sin(performance.now() / 60 + beam.ownerId * 1.3) * 0.12;
    const hit = beam.hit || endPoint(beam);
    ctx.globalAlpha = 0.4 * alpha;
    ctx.strokeStyle = beam.color;
    ctx.lineWidth = 12 * wobble;
    ctx.beginPath();
    ctx.moveTo(beam.origin.x, beam.origin.y);
    ctx.lineTo(hit.x, hit.y);
    ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3 * wobble;
    ctx.beginPath();
    ctx.moveTo(beam.origin.x, beam.origin.y);
    ctx.lineTo(hit.x, hit.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Helper: pick the most relevant enemy capital for the target panel
// ---------------------------------------------------------------------------
function pickFocusTarget(game) {
  if (game.spectating) {
    // In spectate / admiral the user explicitly picks who to inspect
    // (via cycleSpectate or the new tap-to-select). Show whatever
    // ship the camera is locked to — even fighters / bombers without
    // a `.modules` array — so the panel reads as a "ship inspector"
    // not just a capital-only readout.
    const t = getSpectateTarget(game);
    if (t && !t.dead) return t;
  }
  const player = game.ships.find((s) => s.isPlayer && !s.dead);
  if (!player) return null;
  let best = null, bestD2 = Infinity;
  for (const s of game.ships) {
    if (s.dead || s.side === player.side) continue;
    if (!s.modules || s.modules.length === 0) continue;
    const dx = s.pos.x - player.pos.x;
    const dy = s.pos.y - player.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { best = s; bestD2 = d2; }
  }
  return best;
}