import { CLASSES, SIDES } from "./classes.js";
import { ARENA } from "./arena.js";
import { getSpectateTarget } from "./game.js";
import { RACES } from "./races.js";

import { classIconSvg, CLASS_SHORT_LABELS } from "./ship-icons.js";

const CLASS_ORDER = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier", "station"];

// Letter glyphs kept as fallback labels for accessibility / narrow
// contexts. The visual UI uses classIconSvg from ship-icons.js so
// players see ship silhouettes instead of letters in every roster cell.
const CLASS_GLYPH = {
  fighter: "F", bomber: "B", frigate: "Fr",
  cruiser: "C", battleship: "BB", carrier: "CV", station: "St",
};

// Friendly labels for module names that appear in the target panel.
const MODULE_LABELS = {
  laser:            "Heavy Laser",
  "laser-fore":     "Heavy Laser Fore",
  "laser-aft":      "Heavy Laser Aft",
  "missile-fwd":      "Missile Bay Fwd",
  "missile-aft":      "Missile Bay Aft",
  "missile-bay":      "Missile Bay",
  "missile-bay-fore": "Missile Bay Fore",
  "missile-bay-aft":  "Missile Bay Aft",
  "broadside-port": "Broadside Port",
  "broadside-stbd": "Broadside Stbd",
  "broadside-port-0": "Cannon Port 1",
  "broadside-port-1": "Cannon Port 2",
  "broadside-port-2": "Cannon Port 3",
  "broadside-stbd-0": "Cannon Stbd 1",
  "broadside-stbd-1": "Cannon Stbd 2",
  "broadside-stbd-2": "Cannon Stbd 3",
  hangar:           "Hangar",
  "torpedo-bay":    "Torpedo Bay",
  "torpedo-tube-port": "Torpedo Tube (P)",
  "torpedo-tube-stbd": "Torpedo Tube (S)",
  "shield-generator":      "Shield Generator",
  "shield-generator-port": "Shield Gen (P)",
  "shield-generator-stbd": "Shield Gen (S)",
  gun:              "Forward Gun",
  cannon:           "Bow Cannon",
  "gun-array":      "Ring Cannons",
  // PD turrets are per-turret (pd-0, pd-1, ...). MODULE_LABEL_FN below
  // handles them so the HUD doesn't need 14 separate entries.
};

// Resolve a module name to a friendly label. Per-turret PD modules
// fall through to a generic "PD Turret N" without polluting the
// static table.
export function moduleLabel(name) {
  if (MODULE_LABELS[name]) return MODULE_LABELS[name];
  if (name && name.startsWith("pd-")) return "PD Turret " + name.slice(3);
  if (name && name.startsWith("engine-")) return "Engine " + name.slice(7);
  return name;
}

function countBySide(ships) {
  const out = {
    blue: { fighter: 0, bomber: 0, frigate: 0, cruiser: 0, battleship: 0, carrier: 0, station: 0 },
    red:  { fighter: 0, bomber: 0, frigate: 0, cruiser: 0, battleship: 0, carrier: 0, station: 0 },
  };
  // Surrendered ships are untargetable, drifting hulks — they're out of
  // the fight, so the on-field roster strip must not count them as active.
  for (const s of ships) if (!s.dead && !s.surrendered) out[s.side][s.klass]++;
  return out;
}

// Render the in-depth end-of-battle report (all modes) from game.battleReport.
// INTERACTIVE: four tappable tabs (Overview / Fleets / Capitals / Strike) and
// tap-to-expand rows for per-capital + per-side strike-craft detail. The tab
// switches and row expands are handled by a single delegated click handler on
// the match-over panel (BattleHUD#_onMatchOverClick) keyed on the data-mo-*
// attributes stamped here — so the markup stays a pure string and the panel
// is built exactly once per match (no per-frame innerHTML churn that would
// reset the player's tab choice / expanded rows / scroll). Returns '' if no
// report.
function renderBattleReportHTML(report) {
  if (!report) return "";
  const B = report.sides.blue, R = report.sides.red;
  const dur = report.durationSeconds || 0;
  const mmss = `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}`;
  const pct = (f) => `${Math.round((f || 0) * 100)}%`;
  const num = (n) => (n || 0).toLocaleString();
  const klassLabel = {
    fighter: "Fighters", bomber: "Bombers", frigate: "Frigates",
    cruiser: "Cruisers", battleship: "Battleships", carrier: "Carriers", station: "Stations",
  };
  const sideDot = (side) => `<span class="bstat-dot bstat-dot-${side}"></span>`;
  const sideName = (side) => (side === "blue" ? "Friendly" : "Enemy");

  // ---- OVERVIEW pane: head-to-head totals + MVP ----
  const cmp = (label, bv, rv) =>
    `<div class="bstat-cmp-row"><span class="bstat-b">${bv}</span><span class="bstat-lbl">${label}</span><span class="bstat-r">${rv}</span></div>`;
  const headToHead = `
    <div class="bstat-cmp">
      <div class="bstat-cmp-row bstat-cmp-head"><span class="bstat-b">FRIENDLY</span><span class="bstat-lbl"></span><span class="bstat-r">ENEMY</span></div>
      ${cmp("Committed", B.totals.committed, R.totals.committed)}
      ${cmp("Survived", B.totals.survivors, R.totals.survivors)}
      ${cmp("Destroyed", B.totals.lost, R.totals.lost)}
      ${cmp("Surrendered", B.totals.surrendered, R.totals.surrendered)}
      ${cmp("Kills", B.totals.kills, R.totals.kills)}
      ${cmp("Damage dealt", num(B.damageDealt), num(R.damageDealt))}
      ${cmp("Accuracy", pct(B.accuracy), pct(R.accuracy))}
      ${cmp("Missiles fired", B.missilesFired, R.missilesFired)}
    </div>`;
  const mvp = report.mvp ? `
    <div class="bstat-mvp">
      <span class="bstat-mvp-label">⭐ MVP</span>
      <span class="bstat-mvp-name">${sideDot(report.mvp.side)}${report.mvp.name}</span>
      <span class="bstat-mvp-stat">${report.mvp.kills} kills · ${num(report.mvp.damageDealt)} dmg</span>
    </div>` : "";
  const overviewPane = `${headToHead}${mvp}`;

  // ---- FLEETS pane: per-side per-class breakdown ----
  const fleetRows = (side) => {
    const rows = [];
    for (const k of ["battleship", "carrier", "cruiser", "frigate", "bomber", "fighter", "station"]) {
      const c = side.committed[k] || 0;
      if (c <= 0) continue;
      const lost = side.lost[k] || 0, surr = side.surrendered[k] || 0, left = side.survivors[k] || 0;
      rows.push(`<div class="bstat-fleet-row"><span class="bstat-fleet-k">${klassLabel[k]}</span><span class="bstat-fleet-v">${left}/${c} left${lost ? ` · ${lost} lost` : ""}${surr ? ` · ${surr} surr` : ""}</span></div>`);
    }
    return rows.join("") || `<div class="bstat-fleet-row"><span class="bstat-fleet-v">—</span></div>`;
  };
  const fleetsPane = `
    <div class="bstat-cols">
      <div class="bstat-col">
        <div class="bstat-section-title bstat-blue">FRIENDLY FLEET</div>
        ${fleetRows(B)}
      </div>
      <div class="bstat-col">
        <div class="bstat-section-title bstat-red">ENEMY FLEET</div>
        ${fleetRows(R)}
      </div>
    </div>`;

  // ---- CAPITALS pane: tap a row to expand its detail ----
  const fateLabel = { alive: "survived", lost: "lost", surrendered: "surrendered" };
  const detailRow = (label, value) =>
    `<span class="bstat-dt-k">${label}</span><span class="bstat-dt-v">${value}</span>`;
  const capItems = report.capitals.length ? report.capitals.map((c) => {
    const acc = c.shotsFired > 0 ? `${Math.round((c.shotsHit / c.shotsFired) * 100)}% (${num(c.shotsHit)}/${num(c.shotsFired)})` : "—";
    return `<div class="bstat-cap-item bstat-fate-${c.fate}" data-mo-expand>
      <div class="bstat-cap-row" role="button" tabindex="0" aria-expanded="false">
        <span class="bstat-caret" aria-hidden="true">▸</span>
        <span class="bstat-cap-name">${sideDot(c.side)}${c.isPlayer ? "★ " : ""}${c.name}</span>
        <span class="bstat-cap-kd">${c.kills}K</span>
        <span class="bstat-cap-fate">${fateLabel[c.fate] || c.fate}</span>
      </div>
      <div class="bstat-detail">
        <div class="bstat-detail-grid">
          ${detailRow("Allegiance", sideName(c.side))}
          ${detailRow("Class", `<span class="bstat-cap-klass">${c.klass}</span>`)}
          ${detailRow("Kills", c.kills)}
          ${detailRow("Damage dealt", num(c.damageDealt))}
          ${detailRow("Accuracy", acc)}
          ${detailRow("Fate", fateLabel[c.fate] || c.fate)}
        </div>
        ${c.isPlayer ? `<div class="bstat-detail-flag">★ Your flagship</div>` : ""}
      </div>
    </div>`;
  }).join("") : `<div class="bstat-cap-empty">No capital ships engaged.</div>`;
  const capitalsPane = `<div class="bstat-cap-list">${capItems}</div>`;

  // ---- STRIKE pane: per-side aggregate, expand for the class split ----
  const sc = report.smallCraft;
  const scItem = (label, side, agg, fleet) => {
    const klassRows = ["fighter", "bomber"].map((k) => {
      const c = fleet.committed[k] || 0;
      if (c <= 0) return "";
      const lost = fleet.lost[k] || 0, surr = fleet.surrendered[k] || 0, left = fleet.survivors[k] || 0;
      return detailRow(klassLabel[k], `${left}/${c} left${lost ? ` · ${lost} lost` : ""}${surr ? ` · ${surr} surr` : ""}`);
    }).join("");
    return `<div class="bstat-sc-item" data-mo-expand>
      <div class="bstat-sc-row" role="button" tabindex="0" aria-expanded="false">
        <span class="bstat-caret" aria-hidden="true">▸</span>
        ${sideDot(side)}<span class="bstat-sc-lbl">${label}</span>
        <span class="bstat-sc-v">${agg.count} craft · ${agg.kills} kills · ${num(agg.damage)} dmg</span>
      </div>
      <div class="bstat-detail">
        <div class="bstat-detail-grid">
          ${klassRows || detailRow("Craft", "—")}
          ${detailRow("Kills", agg.kills)}
          ${detailRow("Damage dealt", num(agg.damage))}
        </div>
      </div>
    </div>`;
  };
  const strikePane = `<div class="bstat-sc-list">
      ${scItem("Friendly", "blue", sc.blue, B)}
      ${scItem("Enemy", "red", sc.red, R)}
    </div>`;

  const tab = (id, label, active) =>
    `<button class="bstat-tab${active ? " active" : ""}" data-mo-tab="${id}" type="button" role="tab" aria-selected="${active ? "true" : "false"}">${label}</button>`;
  const pane = (id, html, active) =>
    `<div class="bstat-pane${active ? " active" : ""}" data-mo-pane="${id}" role="tabpanel">${html}</div>`;

  return `
    <div class="bstat-report">
      <div class="bstat-title">BATTLE REPORT <span class="bstat-duration">⏱ ${mmss}</span></div>
      <div class="bstat-tabs" role="tablist">
        ${tab("overview", "Overview", true)}
        ${tab("fleets", "Fleets", false)}
        ${tab("capitals", "Capitals", false)}
        ${tab("strike", "Strike", false)}
      </div>
      ${pane("overview", overviewPane, true)}
      ${pane("fleets", fleetsPane, false)}
      ${pane("capitals", capitalsPane, false)}
      ${pane("strike", strikePane, false)}
    </div>`;
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
    // COMMAND pill — toggle the mid-battle admiral view (TAKE COMMAND /
    // RESUME PILOT). Only meaningful when the player is piloting a ship;
    // hidden in standalone admiral mode + after elimination (sync gates it).
    const commandBtn = this._createEl("button", "battle-pill", "command-btn");
    commandBtn.textContent = "TAKE COMMAND";
    commandBtn.style.pointerEvents = "auto";
    topRight.appendChild(commandBtn);
    // SETTINGS pill — opens the menu's settings overlay mid-match so
    // the player can mute music / SFX without quitting.
    const settingsBtn = this._createEl("button", "battle-pill", "battle-settings-btn");
    settingsBtn.textContent = "SETTINGS";
    settingsBtn.style.pointerEvents = "auto";
    topRight.appendChild(settingsBtn);
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
        <span class="target-icon" id="target-icon" aria-hidden="true"></span>
        <span class="target-label" id="target-label">TARGET</span>
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
      <div class="matchover-aar" id="matchover-aar"></div>
      <div class="matchover-prompt" id="matchover-prompt"></div>
      <button class="matchover-continue" id="matchover-continue" type="button" data-mo-action="continue">CONTINUE</button>
    `;
    this._root.appendChild(matchover);

    // ---- Captain Comms strip (Tier 39) ----
    const comms = this._createEl("div", "captain-comms", "captain-comms");
    comms.setAttribute("aria-hidden", "true");
    this._captainCommsEl = comms;
    this._root.appendChild(comms);

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
    // Inline SVG icons: crosshair for primary fire, missile for the
    // single-shot launcher, double-chevron for boost. Crisp at any
    // pixel density and respects currentColor for theming.
    actionCluster.innerHTML = `
      <button class="action-btn fire-btn" id="fire-btn" aria-label="Fire primary weapon">
        <div class="btn-glow"></div>
        <svg class="btn-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/>
          <circle cx="12" cy="12" r="2.5" fill="currentColor"/>
          <line x1="12" y1="1.5" x2="12" y2="6"  stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <line x1="12" y1="18"  x2="12" y2="22.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <line x1="1.5" y1="12" x2="6"  y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <line x1="18"  y1="12" x2="22.5" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <span class="btn-label">FIRE</span>
      </button>
      <button class="action-btn missile-btn" id="missile-btn" aria-label="Fire missile">
        <div class="btn-glow"></div>
        <svg class="btn-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <path d="M12 2 L15 9 L15 17 L12 20 L9 17 L9 9 Z" fill="currentColor" fill-opacity="0.55" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
          <line x1="9"  y1="14" x2="6"  y2="18" stroke="currentColor" stroke-width="1.6"/>
          <line x1="15" y1="14" x2="18" y2="18" stroke="currentColor" stroke-width="1.6"/>
          <circle cx="12" cy="11" r="1.4" fill="#0a1424"/>
        </svg>
        <span class="btn-label">MISSILE</span>
        <div class="btn-cooldown" id="missile-cooldown"></div>
      </button>
      <button class="action-btn boost-btn" id="boost-btn" aria-label="Speed boost">
        <div class="btn-glow"></div>
        <svg class="btn-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <path d="M12 3 L18 11 L13.5 11 L13.5 21 L10.5 21 L10.5 11 L6 11 Z" fill="currentColor" fill-opacity="0.55" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>
        <span class="btn-label">BOOST</span>
        <div class="btn-cooldown" id="boost-cooldown"></div>
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
      <div class="admiral-header" id="admiral-header">
        <div class="admiral-title">FLEET COMMAND</div>
        <button class="admiral-min-btn" id="admiral-min-btn" title="Minimise panel" aria-label="Minimise fleet command panel">–</button>
      </div>
      <div class="admiral-body" id="admiral-body">
        <div class="admiral-master" id="admiral-master">
          <button class="admiral-master-btn master-free"  data-master="engage">ALL ENGAGE</button>
          <button class="admiral-master-btn master-hold"  data-master="hold">ALL HOLD</button>
          <button class="admiral-master-btn master-press" data-master="fallback">ALL FALL BACK</button>
          <button class="admiral-master-btn master-focus" id="admiral-master-focus">ALL FOCUS</button>
          <button class="admiral-master-btn master-missiles" id="admiral-master-missiles">MISSILES: FREE</button>
        </div>
        <div class="admiral-focus" id="admiral-focus">
          <span class="focus-label">FOCUS FIRE</span>
          <span class="focus-name" id="admiral-focus-name">Tap an enemy to focus</span>
          <button class="focus-clear" id="admiral-focus-clear" title="Clear focus">&times;</button>
        </div>
        <div class="admiral-grid" id="admiral-grid"></div>
      </div>
    `;
    this._root.appendChild(admiralPanel);
    // Minimise / restore — collapses the panel to just its header so the
    // player can see the battle, then expand it again. HUD-local UI
    // state; tapping the header or the button toggles it.
    this._admiralMinimized = false;
    const minBtn = admiralPanel.querySelector("#admiral-min-btn");
    const header = admiralPanel.querySelector("#admiral-header");
    const toggleMin = (ev) => {
      ev.stopPropagation();
      this._admiralMinimized = !this._admiralMinimized;
      admiralPanel.classList.toggle("minimized", this._admiralMinimized);
      if (minBtn) minBtn.textContent = this._admiralMinimized ? "+" : "–";
    };
    if (minBtn) minBtn.addEventListener("click", toggleMin);
    // Tapping the header (when minimised) restores; when expanded the
    // header tap also minimises for a big touch target.
    if (header) header.addEventListener("click", toggleMin);

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
    this._gunRow = this._root.querySelector("#vitals-gun-row");
    this._gunFill = this._root.querySelector("#gun-fill");
    this._gunValue = this._root.querySelector("#gun-value");
    this._gunLabel = this._root.querySelector("#gun-label");
    this._respawnPanel = this._root.querySelector("#respawn-panel");
    this._respawnTimer = this._root.querySelector("#respawn-timer");
    this._matchoverPanel = this._root.querySelector("#matchover-panel");
    this._matchoverTitle = this._root.querySelector("#matchover-title");
    this._matchoverSubtitle = this._root.querySelector("#matchover-subtitle");
    this._matchoverAAR = this._root.querySelector("#matchover-aar");
    this._matchoverPrompt = this._root.querySelector("#matchover-prompt");
    this._matchoverContinueBtn = this._root.querySelector("#matchover-continue");
    // Built-once guard: the interactive report (tabs + expandable rows +
    // scroll) is rendered the first frame matchOver flips true and left
    // alone after, so the player's tab/expand/scroll state survives.
    this._matchOverBuilt = false;
    this._spectatePill = this._root.querySelector("#spectate-pill");
    this._spectateShip = this._root.querySelector("#spectate-ship");
    this._targetPanelEl = this._root.querySelector("#target-panel");
    this._targetName = this._root.querySelector("#target-name");
    this._targetLabel = this._root.querySelector("#target-label");
    this._targetIcon = this._root.querySelector("#target-icon");
    this._targetIconKey = null;  // cache so we skip innerHTML when target class unchanged
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

    // ---- Wire COMMAND button click (TAKE COMMAND / RESUME PILOT) ----
    // Sets the edge flag main.js#878 drains via consumeAdmiralToggle().
    this._commandBtnEl = this._root.querySelector("#command-btn");
    if (this._commandBtnEl) {
      this._commandBtnEl.addEventListener("click", () => {
        if (this._input) this._input._admiralToggleEdge = true;
      });
    }

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

    // ---- Wire SETTINGS button click ----
    // Same shape as QUIT — set a flag the main.js loop drains. main.js
    // calls `input.startMenu.openInBattleSettings()` which pops the
    // menu's existing settings overlay on top of the battle canvas.
    this._battleSettingsBtnEl = this._root.querySelector("#battle-settings-btn");
    if (this._battleSettingsBtnEl) {
      this._battleSettingsBtnEl.addEventListener("click", () => {
        if (this._input) this._input.settingsRequested = true;
      });
    }

    // ---- Wire the interactive match-over report ----
    // ONE delegated handler on the panel covers the CONTINUE button, the
    // tab bar, and every expandable row. Delegation (rather than per-element
    // listeners) is required because the report body is innerHTML-rebuilt
    // when a match ends, which would orphan element-level listeners; the
    // panel element itself is stable, so its listener persists.
    if (this._matchoverPanel) {
      this._matchoverPanel.addEventListener("click", (e) => this._activateReportControl(e.target));
      // Keyboard parity. The GLOBAL window keydown handler (input.js) traps
      // + preventDefaults Enter/Space (they're firing keys) AND Enter drives
      // the match-advance via consumeEnterPress(). So a focused tab/row/
      // button on the keyboard would be dead (stolen native activation) and
      // worse, Enter would dismiss the whole report. We activate the control
      // HERE and stopPropagation so the global listener never sees the key —
      // no spurious advance, no stolen click. Enter pressed while focus is
      // OUTSIDE a control still bubbles to the window handler → advances,
      // which is the intended keyboard shortcut.
      this._matchoverPanel.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
        const t = e.target;
        if (!t || !t.closest) return;
        if (!t.closest("[data-mo-action], [data-mo-tab], [data-mo-expand] > [role='button']")) return;
        e.preventDefault();
        e.stopPropagation();
        this._activateReportControl(t);
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
      // Ship-silhouette icon instead of a letter chip — players read
      // the fleet composition at a glance instead of decoding "Fr".
      // Title attribute (CLASS_SHORT_LABELS) keeps accessibility solid.
      cell.title = CLASS_SHORT_LABELS[klass] || klass;
      cell.innerHTML = `<div class="cell-glyph">${classIconSvg(klass, { size: 22 })}</div><div class="cell-count">0</div>`;
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

    // 10. Captain comms strip
    this._syncCaptainComms(game);

    // 11. Spectate pill
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
    // Respawn panel doubles as the elimination notice — keep it visible
    // during the post-death banner window even though we've dropped to
    // spectate (piloting is false).
    setVis(this._root.querySelector("#respawn-panel"), piloting || game.eliminationNoticeTimer > 0);
    // Vitals: hide in admiral AND in spectate. During spectate the
    // target panel (left side) already shows the locked ship's shield
    // + module readouts, so the bottom vitals bar showing the SAME
    // shield at 100% was redundant + confusing (read as "the player
    // is alive at full shields" when in fact the player is dead and
    // observing). Only piloting needs the bottom strip.
    setVis(this._root.querySelector("#vitals-bar"), piloting);
    // Both virtual sticks are piloting-only now. The right stick (aim) was
    // always hidden in spectate; the LEFT stick used to stay live as a
    // velocity-pan, which fought the unified grab-pan (and made left-half
    // ships untappable) — input.js now gates it off when selecting, so hide
    // it too. Desktop keeps continuous WASD pan via the keyboard thrust source.
    setVis(this._root.querySelector("#vstick-right"), piloting);
    setVis(this._root.querySelector("#vstick-left"), piloting);
    // Admiral mode is "you ARE the admiral" — the "OBSERVING <ship>"
    // pill is confusing (you're not observing a specific ship, you're
    // commanding the whole fleet), and it overlaps the centred target
    // panel. Keep it for non-admiral spectate where it actually says
    // which ship the camera is locked to.
    setVis(this._root.querySelector("#spectate-pill"), !admiral);
    // SPECTATE pill: hide in admiral view. In admiral-by-toggle the player
    // is BOTH spectating and admiral, so the pill would read "RETURN TO
    // FIELD" and, if clicked, exitSpectate retakes the ship but leaves
    // admiralMode stuck on → piloting with no action cluster / aim stick.
    // RESUME PILOT (the command pill) is the sole, correct return path.
    setVis(this._spectateBtnEl, !admiral);
    // COMMAND pill (TAKE COMMAND / RESUME PILOT). Hidden in standalone
    // admiral mode (the FLEET COMMAND panel is permanently up there, so a
    // toggle is meaningless) and after the player is eliminated (no ship
    // to return to). Label flips to RESUME PILOT once admiral was entered
    // via the mid-battle toggle.
    const standaloneAdmiral = admiral && !game._admiralByToggle;
    setVis(this._commandBtnEl, !standaloneAdmiral && !game.playerEliminated);
    if (this._commandBtnEl) {
      this._commandBtnEl.textContent =
        (admiral && game._admiralByToggle) ? "RESUME PILOT" : "TAKE COMMAND";
    }
  }

  _syncSideStrips(game, viewW) {
    // Side strips stay visible on mobile now (used to be hidden via
    // display:none) — the mobile CSS lays them out as two stacked
    // horizontal rows at the top instead of the desktop column form.
    this._sideLeft.style.display = "";
    this._sideRight.style.display = "";

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
        // Shield HP is a hidden mechanic — player sees active/failed only.
        if (this._shieldValue) this._shieldValue.textContent = "";
      }


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
      (s) => !s.dead && !s.surrendered && !s.wreckSpawned && (s.hp == null || s.hp > 0),
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
    // Header label was hardcoded "MARKED" (red), which read as a
    // "this is a marked rival" badge on every observed ship — including
    // allies. Show the correct relationship (ALLIED / HOSTILE) and
    // colour it from the side palette. Future: if a per-ship rival
    // flag is added (e.g. ship.isRival), swap to "MARKED" in red.
    if (this._targetLabel) {
      const palette = SIDES[ship.side] || SIDES.blue;
      this._targetLabel.textContent = (palette.name || "TARGET").toUpperCase();
      this._targetLabel.style.color = palette.primary;
      this._targetLabel.style.borderColor = palette.primary;
    }
    // Target ship-class icon — refreshed only when the class actually
    // changes (cheap inner-HTML guard so the SVG isn't re-parsed every
    // frame the panel is open).
    const iconKey = ship.klass + "|" + ship.race;
    if (this._targetIcon && iconKey !== this._targetIconKey) {
      this._targetIcon.innerHTML = classIconSvg(ship.klass, { size: 28, race: ship.race });
      this._targetIconKey = iconKey;
    }

    // Target panel shows shield bubble status only — HP and armor are
    // hidden mechanics; the player reads health from the block grid.
    let barsHtml = "";
    if (ship.shieldMax > 0) {
      const shieldFrac = Math.max(0, Math.min(1, ship.shield / ship.shieldMax));
      barsHtml += `
        <div class="target-bar-row">
          <span style="font-size:9px;color:#9bd;width:36px;">SHIELD</span>
          <div class="target-bar"><div class="target-bar-fill" style="width:${shieldFrac * 100}%;background:#5cf;"></div></div>
        </div>`;
    }
    this._targetBars.innerHTML = barsHtml;

    // Module rows
    let modulesHtml = "";
    if (ship.modules) {
      for (const m of ship.modules) {
        const label = moduleLabel(m.name);
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
    // The player ship no longer respawns — on death the pilot drops to
    // spectate and watches the fleet. This panel is now the brief
    // ELIMINATION NOTICE shown for a few seconds after death:
    //   - KIA (Frontier survival roll failed)  → red "KIA — CAREER ENDED"
    //   - ejected / non-Frontier               → "SHIP LOST — OBSERVING"
    // It auto-hides when game.eliminationNoticeTimer drains.
    if (game.eliminationNoticeTimer > 0) {
      const kia = game.playerKIAEvent;
      const isKIA = !!(kia && kia.survived === false);
      this._respawnPanel.classList.add("active");
      this._respawnPanel.setAttribute("aria-hidden", "false");
      this._respawnPanel.classList.toggle("kia", isKIA);
      this._respawnPanel.querySelector(".respawn-label").textContent =
        isKIA ? "KIA — CAREER ENDED" : "SHIP LOST — OBSERVING";
      this._respawnTimer.textContent = isKIA ? "" : "No respawn — your fleet fights on";
      return;
    }
    this._respawnPanel.classList.remove("active", "kia");
    this._respawnPanel.setAttribute("aria-hidden", "true");
  }

  // Toggle one expandable report row (capital ship / strike-craft line):
  // flip the `.expanded` class, swap the caret glyph, and reflect aria.
  _toggleReportRow(item) {
    if (!item) return;
    const open = item.classList.toggle("expanded");
    const caret = item.querySelector(".bstat-caret");
    if (caret) caret.textContent = open ? "▾" : "▸";
    const row = item.querySelector("[role='button']");
    if (row) row.setAttribute("aria-expanded", open ? "true" : "false");
  }

  // Activate an interactive control inside the match-over panel, given the
  // event target (click or keyboard). Shared by the click + keydown wiring.
  // The CONTINUE / RETURN button advances (main.js drains the flag); the tab
  // bar switches panes; an expand row toggles — but ONLY when the row HEADER
  // is hit, not the detail body, so tapping inside an open detail to read /
  // select text doesn't collapse it.
  _activateReportControl(el) {
    if (!el || !el.closest) return;
    if (el.closest("[data-mo-action='continue']")) {
      if (this._input) this._input.matchAdvanceRequested = true;
      return;
    }
    const tab = el.closest("[data-mo-tab]");
    if (tab) {
      const id = tab.getAttribute("data-mo-tab");
      const report = tab.closest(".bstat-report");
      if (!report) return;
      report.querySelectorAll("[data-mo-tab]").forEach((t) => {
        const on = t.getAttribute("data-mo-tab") === id;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      report.querySelectorAll("[data-mo-pane]").forEach((p) => {
        p.classList.toggle("active", p.getAttribute("data-mo-pane") === id);
      });
      return;
    }
    const header = el.closest("[data-mo-expand] > [role='button']");
    if (header) this._toggleReportRow(header.parentElement);
  }

  _syncMatchOver(game) {
    if (game.matchOver) {
      this._matchoverPanel.classList.add("active");
      this._matchoverPanel.setAttribute("aria-hidden", "false");
      // INTERACTIVE report: build the panel contents ONCE per match (tabs,
      // expandable rows, scroll). Re-running the innerHTML below every frame
      // would wipe the player's tab choice / expanded rows / scroll pos.
      if (this._matchOverBuilt) return;
      this._matchOverBuilt = true;
      this._matchoverPanel.scrollTop = 0;
      // CONTINUE button label by mode (replaces the old tap-anywhere). The
      // career-summary screen returns the player home; a mid-run Frontier
      // win returns to the starmap; everything else just continues.
      if (this._matchoverContinueBtn) {
        this._matchoverContinueBtn.textContent = game.mode === "roguelite"
          ? (game.runSummary ? "RETURN TO HOME" : "RETURN TO STARMAP")
          : "CONTINUE";
      }
      // The prompt is now a quiet hint (the button is the action).
      this._matchoverPrompt.textContent = "Review the report below, then continue.";
      // Reset any inline title styling left over from a PRIOR career-summary
      // (green/red tint + stamp animation). Persisted on the stable DOM
      // element, it would otherwise bleed into a later non-roguelite title.
      // The career path re-applies its own tint below.
      this._matchoverTitle.style.color = "";
      this._matchoverTitle.style.textShadow = "";
      this._matchoverTitle.classList.remove("runend-stamp");

      const isRoguelite = game.mode === "roguelite";
      const won = game.winner === "blue";
      const stalled = !!game.endedByStall;
      // In-depth per-battle report (all modes). Appended below any mode-
      // specific AAR / career-summary content.
      const battleHtml = renderBattleReportHTML(game.battleReport);

      // Career-summary takes priority — set on game by main.js's
      // runEnded handler when the run is over (either war-won or any
      // defeat). We show the rank + callsign + flavor blurb instead
      // of a generic "DEFEAT" / "VICTORY".
      const summary = game.runSummary;
      if (isRoguelite && summary) {
        const headline = summary.won ? "WAR WON" : "CAREER ENDED";
        this._matchoverTitle.textContent = headline;
        // Stamp-style reveal animation. Re-trigger by removing+adding
        // the class with a reflow in between so the keyframe restarts
        // even when the same headline lands twice (e.g. after a
        // panel re-render). Tint matches result: green for victory,
        // warm red for defeat — title becomes the visual anchor.
        this._matchoverTitle.style.color = summary.won ? "#afe6b0" : "#f3b0b0";
        this._matchoverTitle.style.textShadow = summary.won
          ? "0 0 18px rgba(140, 220, 150, 0.55)"
          : "0 0 18px rgba(240, 110, 110, 0.45)";
        this._matchoverTitle.classList.remove("runend-stamp");
        void this._matchoverTitle.offsetWidth;
        this._matchoverTitle.classList.add("runend-stamp");
        const handle = `${summary.rank}${summary.callsign ? ` ${summary.callsign}` : ""}`;
        const progress = `Act ${summary.act}/${summary.actsTotal} · ${summary.visitedCount} jumps`;
        this._matchoverSubtitle.innerHTML =
          `<strong>${handle}</strong><br>${summary.flavor || ""}<br><span style="opacity:0.65;font-size:0.85em;">${progress}</span>`;
        this._matchoverSubtitle.style.color = summary.won ? "#bfd" : "#fdb";
        // Final stats breakdown — read summary.stats stamped by main.js.
        if (this._matchoverAAR && summary.stats) {
          const s = summary.stats;
          const totalKills = Object.values(s.shipsKilled || {}).reduce((a, b) => a + b, 0);
          const totalLost  = Object.values(s.shipsLost   || {}).reduce((a, b) => a + b, 0);
          const stat = (label, value) =>
            `<div class="endstats-row"><span class="endstats-label">${label}</span><span class="endstats-value">${value}</span></div>`;
          // Achievements-unlocked block (Tier 43). Names are surfaced
          // from the run.log entries that recordRunEnd wrote, so we
          // don't need a lookup against ACHIEVEMENTS here.
          const achs = (summary.achievementsUnlocked || []);
          let achHtml = "";
          if (achs.length > 0) {
            achHtml = `
              <div class="endstats-section-title" style="color:#ffd680;">ACHIEVEMENTS UNLOCKED</div>
              <div class="endstats-ach-list">
                ${achs.map((id) => `<div class="endstats-ach-row">✦ ${id.replace(/-/g, " ").toUpperCase()}</div>`).join("")}
              </div>
            `;
          }
          // Shipyard credit breakdown (Phase 2). Stamped on game.runSummary
          // by main.js's runEnded subscriber. Renders per-class kills,
          // act/boss/node bonuses, total, and the new balance the player
          // walks away with so the payoff feels tangible.
          let shipyardHtml = "";
          if (summary.shipyard) {
            const sy = summary.shipyard;
            const b = sy.breakdown || {};
            const rows = [];
            if (b.kills) {
              const klassLabel = {
                fighter: "Fighters", bomber: "Bombers", frigate: "Frigates",
                cruiser: "Cruisers", battleship: "Battleships",
                carrier: "Carriers", station: "Stations",
              };
              for (const k of ["fighter","bomber","frigate","cruiser","battleship","carrier","station"]) {
                const entry = b.kills[k];
                if (!entry || entry.count <= 0) continue;
                rows.push(`<div class="endstats-row"><span class="endstats-label">${klassLabel[k] || k} × ${entry.count}</span><span class="endstats-value">+${entry.credits} cr</span></div>`);
              }
            }
            if (b.nodesCleared && b.nodesCleared.count > 0) {
              rows.push(`<div class="endstats-row"><span class="endstats-label">Nodes cleared × ${b.nodesCleared.count}</span><span class="endstats-value">+${b.nodesCleared.credits} cr</span></div>`);
            }
            if (b.actBonus > 0) {
              rows.push(`<div class="endstats-row"><span class="endstats-label">Act ${summary.act} survival bonus</span><span class="endstats-value">+${b.actBonus} cr</span></div>`);
            }
            if (b.bossBonus > 0) {
              rows.push(`<div class="endstats-row"><span class="endstats-label">Boss kill bonus</span><span class="endstats-value">+${b.bossBonus} cr</span></div>`);
            }
            if (b.warWonBonus > 0) {
              rows.push(`<div class="endstats-row endstats-warbonus"><span class="endstats-label">WAR WON</span><span class="endstats-value">+${b.warWonBonus} cr</span></div>`);
            }
            shipyardHtml = `
              <div class="endstats-section-title" style="color:#fc8;">SHIPYARD CREDITS EARNED</div>
              <div class="endstats-grid endstats-shipyard">
                ${rows.length > 0 ? rows.join("") : `<div class="endstats-row"><span class="endstats-label">(none)</span><span class="endstats-value">0 cr</span></div>`}
              </div>
              <div class="endstats-shipyard-total">
                <span>EARNED THIS RUN</span>
                <span class="endstats-shipyard-total-value">+${sy.payout || 0} cr</span>
              </div>
              <div class="endstats-shipyard-balance">
                <span>New balance:</span>
                <span class="endstats-shipyard-balance-value">${sy.newBalance || 0} cr</span>
              </div>
            `;
          }
          this._matchoverAAR.innerHTML = `
            <div class="endstats-block">
              <div class="endstats-section-title">FINAL TALLIES</div>
              <div class="endstats-grid">
                ${stat("Ships destroyed", totalKills)}
                ${stat("Ships lost", totalLost)}
                ${stat("Battles cleared", s.battlesCleared || 0)}
                ${stat("Elites cleared", s.elitesCleared || 0)}
                ${stat("Bosses killed", s.bossesKilled || 0)}
                ${stat("Rivals down", s.rivalsDefeated || 0)}
                ${stat("Credits earned", s.creditsEarned || 0)}
                ${stat("Credits spent", s.creditsSpent || 0)}
                ${stat("Boons acquired", s.boonsAcquired || 0)}
                ${stat("Contracts complete", s.contractsCompleted || 0)}
              </div>
              ${shipyardHtml}
              ${achHtml}
            </div>
            ${battleHtml}
          `;
          this._matchoverAAR.style.display = "block";
        } else if (this._matchoverAAR) {
          this._matchoverAAR.innerHTML = "";
          this._matchoverAAR.style.display = "none";
        }
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

      // After-action report (Frontier only). Two halves:
      //   - Battlefield-promotion narrative block (headline + body +
      //     reward chips). The "step reward" is now a flavored beat,
      //     not a flat numeric drop.
      //   - LOST / DESTROYED tally row below.
      // Tallies + promotion come from game.lastBattleReport which
      // main.js stashed from captureBattleOutcome.
      if (this._matchoverAAR) {
        const report = game.lastBattleReport;
        if (isRoguelite && report) {
          const fmtCounts = (counts) => {
            const entries = [];
            for (const k of ["battleship", "carrier", "cruiser", "frigate", "bomber", "fighter"]) {
              const n = counts[k] || 0;
              if (n > 0) entries.push(`${n} ${k}${n > 1 ? "s" : ""}`);
            }
            return entries.length > 0 ? entries.join(", ") : "—";
          };
          const promo = report.promo || null;
          const reward = (promo && promo.reward) || report.reward || {};
          const rewardChips = [];
          if (reward.fighter > 0) rewardChips.push(`+${reward.fighter} fighter`);
          if (reward.bomber > 0)  rewardChips.push(`+${reward.bomber} bomber`);
          if (reward.frigate > 0) rewardChips.push(`+${reward.frigate} frigate`);
          if (reward.credits > 0) rewardChips.push(`+${reward.credits} credits`);
          const lostCapNames = (report.lostCapitals || [])
            .map((c) => c.name || c.klass)
            .filter(Boolean);
          // Captured craft this battle (surrendered enemies pressed into
          // the fleet). Grouped by class for the count, names listed below.
          const captured = report.captured || [];
          const capturedCounts = {};
          for (const c of captured) capturedCounts[c.klass] = (capturedCounts[c.klass] || 0) + 1;
          const capturedNames = captured.map((c) => c.name).filter(Boolean);
          const capturedBlock = captured.length > 0 ? `
            <div class="aar-row">
              <div class="aar-col aar-captured">
                <div class="aar-label">CAPTURED</div>
                <div class="aar-value">${fmtCounts(capturedCounts)}</div>
                ${capturedNames.length > 0 ? `<div class="aar-note">${capturedNames.join(", ")}</div>` : ""}
              </div>
            </div>
          ` : "";
          const promoBlock = promo ? `
            <div class="aar-promo aar-promo-${promo.type || "recruit"}">
              <div class="aar-promo-headline">${promo.headline}</div>
              <div class="aar-promo-body">${promo.body || ""}</div>
              <div class="aar-promo-rewards">${rewardChips.length > 0 ? rewardChips.join(" · ") : ""}</div>
            </div>
          ` : "";
          this._matchoverAAR.innerHTML = `
            ${promoBlock}
            <div class="aar-row">
              <div class="aar-col aar-lost">
                <div class="aar-label">LOST</div>
                <div class="aar-value">${fmtCounts(report.lost || {})}</div>
                ${lostCapNames.length > 0 ? `<div class="aar-note">${lostCapNames.join(", ")}</div>` : ""}
              </div>
              <div class="aar-col aar-killed">
                <div class="aar-label">DESTROYED</div>
                <div class="aar-value">${fmtCounts(report.killed || {})}</div>
              </div>
            </div>
            ${capturedBlock}
            ${battleHtml}
          `;
          this._matchoverAAR.style.display = "block";
        } else {
          // Non-roguelite modes (skirmish / custom / open / defend): the
          // in-depth battle report is the whole after-action panel.
          this._matchoverAAR.innerHTML = battleHtml;
          this._matchoverAAR.style.display = battleHtml ? "block" : "none";
        }
      }
    } else {
      this._matchoverPanel.classList.remove("active");
      this._matchoverPanel.setAttribute("aria-hidden", "true");
      // Allow the next match to rebuild a fresh report.
      this._matchOverBuilt = false;
    }
  }

  // Captain comms strip (Tier 39). Reads game.captainComms, shows
  // the last 4 lines within COMM_TTL ms; fades by age. Cheap signature
  // so we only re-render when the queue changes.
  _syncCaptainComms(game) {
    if (!this._captainCommsEl) return;
    const COMM_TTL = 6000; // ms a line stays visible
    const FADE_TAIL = 1500; // last ms gets fade
    const now = performance.now();
    const all = Array.isArray(game.captainComms) ? game.captainComms : [];
    // Filter to recent + take last 4.
    const visible = all.filter((c) => now - c.ts < COMM_TTL).slice(-4);
    const sig = visible.map((c) => `${c.ts}|${c.text}`).join("\n");
    if (sig === this._captainCommsSig) return;
    this._captainCommsSig = sig;
    if (visible.length === 0) {
      this._captainCommsEl.innerHTML = "";
      this._captainCommsEl.style.display = "none";
      return;
    }
    let html = "";
    for (const c of visible) {
      const age = now - c.ts;
      const fade = age > (COMM_TTL - FADE_TAIL)
        ? Math.max(0, 1 - (age - (COMM_TTL - FADE_TAIL)) / FADE_TAIL)
        : 1;
      html += `
        <div class="comm-line" style="opacity:${fade.toFixed(2)};">
          <span class="comm-speaker">${c.captain}</span>
          <span class="comm-ship">${c.ship}</span>
          <span class="comm-text">${c.text}</span>
        </div>
      `;
    }
    this._captainCommsEl.innerHTML = html;
    this._captainCommsEl.style.display = "flex";
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

    // Boost button — pass the player's current charge fraction so the
    // button's cooldown overlay shows drain + recharge live.
    if (this._input && this._input.boostBtn) {
      const player = game.ships.find((s) => s.isPlayer && !s.dead);
      let frac = 1;  // default full when ship has no boost spec
      if (player && player.boostMax > 0) {
        frac = Math.max(0, Math.min(1, player.boostCharge / player.boostMax));
      }
      this._input.boostBtn._updateDOM(this._boostBtn, frac);
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
      // ALL FOCUS — toggle every class onto/off the focus target. Restores
      // the old "tap an enemy and the whole fleet piles on" behavior on
      // demand (focus is now opt-in per class, not a blanket pin).
      const masterFocus = this._root.querySelector("#admiral-master-focus");
      if (masterFocus) {
        masterFocus.addEventListener("click", () => {
          if (!game.setPriority) return;
          const classes = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier"];
          const anyDefault = classes.some((k) => {
            const d = game.directives && game.directives[k];
            return d && d.priority !== "focus";
          });
          const next = anyDefault ? "focus" : "default";
          for (const klass of classes) game.setPriority(klass, next);
          this._toastAdmiral(`ALL FOCUS · ${next === "focus" ? "ON" : "OFF"}`);
        });
      }
    }
    // Reflect ALL FOCUS state in its label.
    const masterFocusBtn = this._root.querySelector("#admiral-master-focus");
    if (masterFocusBtn) {
      const classes = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier"];
      const allFocus = classes.every((k) => {
        const d = game.directives && game.directives[k];
        return d && d.priority === "focus";
      });
      masterFocusBtn.classList.toggle("active", allFocus);
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
      // 5 stances (compact glyphs for the in-battle grid; full names on hover).
      const postures = [
        ["engage", "ENG", "Engage — fight at natural range"],
        ["charge", "CHG", "Charge — close to point-blank"],
        ["standoff", "OFF", "Stand off — kite at max range"],
        ["hold", "HLD", "Hold position — defend, don't advance"],
        ["fallback", "BCK", "Fall back — retreat, cease fire"],
      ];
      const missileClasses = new Set(["bomber", "frigate", "cruiser", "battleship"]);
      // Letter glyphs kept here only as accessibility fallback labels; the
      // admiral cell now renders the ship silhouette via classIconSvg.
      const CLASS_GLYPHS = { fighter: "F", bomber: "B", frigate: "Fr", cruiser: "C", battleship: "BB", carrier: "CV" };  // eslint-disable-line no-unused-vars

      this._admiralGrid.innerHTML = "";
      this._admiralCellEls = {};
      for (const klass of classes) {
        const d = game.directives[klass] || { stance: "engage", missiles: "on", priority: "default" };
        const cell = document.createElement("div");
        cell.className = "admiral-cell";

        // Cell header: class glyph + name + live count.
        const head = document.createElement("div");
        head.className = "admiral-cell-head";
        head.innerHTML = `
          <span class="admiral-cell-glyph" title="${CLASS_SHORT_LABELS[klass] || klass}">${classIconSvg(klass, { size: 18 })}</span>
          <span class="admiral-cell-name">${klass.toUpperCase()}</span>
          <span class="admiral-cell-count" data-klass="${klass}">×0</span>
        `;
        cell.appendChild(head);

        // Stance buttons (5).
        const postureBar = document.createElement("div");
        postureBar.className = "admiral-cell-postures";
        for (const [stance, label, tip] of postures) {
          const btn = document.createElement("button");
          btn.className = `posture-btn posture-${stance}` + (d.stance === stance ? " active" : "");
          btn.textContent = label;
          btn.title = tip;
          const handler = () => {
            if (game.setPosture) game.setPosture(klass, stance);
            this._toastAdmiral(`${klass.toUpperCase()} · ${label}`);
            btn.classList.add("flash");
            setTimeout(() => btn.classList.remove("flash"), 240);
          };
          btn.addEventListener("click", handler);
          this._admiralClickHandlers.push({ el: btn, fn: handler });
          postureBar.appendChild(btn);
        }

        // FOCUS toggle — pile this class onto the admiral's tapped target.
        {
          const focused = d.priority === "focus";
          const fBtn = document.createElement("button");
          fBtn.className = "posture-btn focus-toggle" + (focused ? " active" : "");
          fBtn.textContent = "FOCUS";
          fBtn.title = focused ? "Following focus target — tap to release" : "Tap to follow the focus target";
          const handler = () => {
            if (game.setPriority) game.setPriority(klass, focused ? "default" : "focus");
            this._toastAdmiral(`${klass.toUpperCase()} · FOCUS ${focused ? "OFF" : "ON"}`);
            fBtn.classList.add("flash");
            setTimeout(() => fBtn.classList.remove("flash"), 240);
          };
          fBtn.addEventListener("click", handler);
          this._admiralClickHandlers.push({ el: fBtn, fn: handler });
          postureBar.appendChild(fBtn);
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