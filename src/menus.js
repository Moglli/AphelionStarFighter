/**
 * @file Unified DOM/CSS Menu System for Aphelion Star Fighter.
 *
 * Replaces all Canvas2D menu rendering with a single DOM-based system.
 * One #menu-root container holds all screens; visibility is toggled via
 * CSS classes.  Call sync() each frame with the latest menuState to keep
 * dynamic content fresh.
 */

// ---------------------------------------------------------------------------
// Constants (mirrored from input.js — must stay in sync)
// ---------------------------------------------------------------------------

const MODE_OPTIONS = [
  { key: "open", label: "Open Battle", tagline: "Wipe the enemy fleet" },
  { key: "defend", label: "Defend Station", tagline: "Destroy enemy station" },
  { key: "roguelite", label: "Frontier", tagline: "Procedural war" },
  { key: "custom", label: "Custom", tagline: "Pick fleets + races" },
  { key: "admiral", label: "Admiral", tagline: "Command, don't pilot" },
];

const CUSTOM_CLASSES = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier"];
const CUSTOM_MAX_PER_CLASS = 60;

const CLASS_GLYPHS = {
  fighter: "F", bomber: "B", frigate: "Fr",
  cruiser: "C", battleship: "BB", carrier: "CV",
};

const CLASS_LABELS = {
  fighter: "Fighter", bomber: "Bomber", frigate: "Frigate",
  cruiser: "Cruiser", battleship: "Battleship", carrier: "Carrier",
};

const FLEET_OPTIONS = [
  { key: "small", label: "Small", mul: 0.5, tagline: "Skirmish" },
  { key: "medium", label: "Medium", mul: 1.0, tagline: "Standard" },
  { key: "large", label: "Large", mul: 1.6, tagline: "Heavy battle" },
  { key: "huge", label: "Huge", mul: 2.5, tagline: "Full clash" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classDisplayName(klass) {
  return CLASS_LABELS[klass] || klass;
}

function capitalDisplayName(klass) {
  if (klass === "battleship") return "Battleship";
  if (klass === "carrier") return "Carrier";
  if (klass === "cruiser") return "Cruiser";
  if (klass === "frigate") return "Frigate";
  return klass;
}

// ---------------------------------------------------------------------------
// MenuSystem class
// ---------------------------------------------------------------------------

export class MenuSystem {
  constructor(mountEl) {
    this._mountEl = mountEl || document.body;
    this._callbacks = {};
    this._currentScreen = null;
    this._listeners = []; // { el, type, fn } — tracked for destroy()

    // References to dynamic elements (filled during _buildDOM)
    this._root = null;
    this._scrim = null;
    this._screens = {}; // name -> element

    // Main menu
    this._chipContainers = {};
    this._chips = {}; // section -> array of { el, key }
    this._startBtn = null;
    this._frontierStatus = null;

    // Energy bar
    this._energyBar = null;
    this._energyCount = null;
    this._energyRegen = null;

    // Settings
    this._settingsBtn = null;
    this._settingsMusicToggle = null;
    this._settingsSfxToggle = null;

    // Refill
    this._refillPackages = null;

    // Custom match
    this._customAlliedRaceName = null;
    this._customAlliedTagline = null;
    this._customHostileRaceName = null;
    this._customHostileTagline = null;
    this._customAlliedRaces = null;
    this._customHostileRaces = null;
    this._customAlliedSliders = null;
    this._customHostileSliders = null;
    this._customAlliedTotal = null;
    this._customHostileTotal = null;
    this._customGrandTotal = null;

    // Run setup
    this._factionGrid = null;
    this._factionCards = []; // array of { el, key }

    // Battle choice
    this._battleTitle = null;
    this._battleInfo = null;

    // Resupply
    this._resupplyRepairs = null;
    this._resupplyFighterBtn = null;
    this._resupplyBomberBtn = null;
    this._resupplyRefuelBtn = null;
    this._resupplyBoons = null;

    // Event
    this._eventTitle = null;
    this._eventBody = null;
    this._eventChoices = null;

    // Build the entire DOM tree
    this._buildDOM();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  setCallbacks(callbacks) {
    this._callbacks = callbacks || {};
  }

  /** Show a screen by name, hide all others. */
  showScreen(name) {
    // Root visibility
    if (this._root) {
      this._root.style.visibility = name ? "visible" : "hidden";
    }

    // Hide all screens first
    for (const el of Object.values(this._screens)) {
      if (el) el.classList.remove("active");
    }

    // Show target screen
    if (name && this._screens[name]) {
      this._screens[name].classList.add("active");
    }

    // Scrim: visible for overlays, hidden for base screens (home / main / about)
    const overlays = ["settings", "refill", "custom", "runSetup", "battleChoice", "resupply", "event"];
    if (this._scrim) {
      this._scrim.style.display = (name && overlays.includes(name)) ? "block" : "none";
    }

    // Energy bar + floating settings pill: only meaningful on PLAY (main)
    // because that's where stamina is spent. Hidden on home/about and on
    // all sub-overlays (those have their own chrome).
    const showPills = (name === "main");
    if (this._energyBar) this._energyBar.style.display = showPills ? "block" : "none";
    if (this._settingsBtn) this._settingsBtn.style.display = showPills ? "block" : "none";

    this._currentScreen = name;
  }

  /** Hide all screens. */
  hideAll() {
    this.showScreen(null);
  }

  /** Remove all listeners and DOM. */
  destroy() {
    for (const { el, type, fn } of this._listeners) {
      el.removeEventListener(type, fn);
    }
    this._listeners = [];
    if (this._root && this._root.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
    this._root = null;
  }

  // -------------------------------------------------------------------------
  // DOM Builder
  // -------------------------------------------------------------------------

  _buildDOM() {
    const root = document.createElement("div");
    root.id = "menu-root";
    root.className = "menu-root";
    root.style.visibility = "hidden";
    this._root = root;

    // 0. Scrim
    this._scrim = document.createElement("div");
    this._scrim.className = "menu-scrim";
    this._scrim.style.display = "none";
    root.appendChild(this._scrim);

    // 1. Home screen — top-level nav (PLAY / SETTINGS / ABOUT)
    this._buildHome(root);

    // 2. Main / Play screen — mode chips + mode-relevant options
    this._buildMainMenu(root);

    // 3. About screen
    this._buildAbout(root);

    // 4. Energy Bar
    this._buildEnergyBar(root);

    // 3. Settings Button
    this._buildSettingsBtn(root);

    // 4. Settings Overlay
    this._buildSettingsOverlay(root);

    // 5. Refill Overlay
    this._buildRefillOverlay(root);

    // 6. Custom Match Overlay
    this._buildCustomOverlay(root);

    // 7. Run Setup Overlay
    this._buildRunSetup(root);

    // 8. Battle Choice Overlay
    this._buildBattleChoice(root);

    // 9. Resupply Overlay
    this._buildResupply(root);

    // 10. Event Overlay
    this._buildEvent(root);

    this._mountEl.appendChild(root);
  }

  // ---- Home screen --------------------------------------------------------
  // Top-level entry: PLAY / SETTINGS / ABOUT. Energy bar and the floating
  // settings pill stay hidden on this screen — both are scoped to PLAY
  // where launching a match (and spending stamina) is the actual action.

  _buildHome(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-home";
    screen.dataset.screen = "home";

    const header = document.createElement("header");
    header.className = "menu-title";
    header.innerHTML = `
      <h1>APHELION STAR FIGHTER</h1>
      <div class="menu-title-accent"></div>
      <p class="menu-subtitle">FLEET COMBAT</p>
    `;
    screen.appendChild(header);

    const nav = document.createElement("div");
    nav.className = "menu-home-nav";

    const playBtn = document.createElement("button");
    playBtn.className = "menu-start-btn menu-home-play";
    playBtn.id = "home-play-btn";
    playBtn.textContent = "PLAY";
    this._addListener(playBtn, "click", () => {
      if (this._callbacks.onHomePlay) this._callbacks.onHomePlay();
    });
    nav.appendChild(playBtn);

    const settingsBtn = document.createElement("button");
    settingsBtn.className = "menu-btn menu-home-secondary";
    settingsBtn.id = "home-settings-btn";
    settingsBtn.textContent = "SETTINGS";
    this._addListener(settingsBtn, "click", () => {
      if (this._callbacks.onSettingsOpen) this._callbacks.onSettingsOpen();
    });
    nav.appendChild(settingsBtn);

    const aboutBtn = document.createElement("button");
    aboutBtn.className = "menu-btn menu-home-secondary";
    aboutBtn.id = "home-about-btn";
    aboutBtn.textContent = "ABOUT";
    this._addListener(aboutBtn, "click", () => {
      if (this._callbacks.onHomeAbout) this._callbacks.onHomeAbout();
    });
    nav.appendChild(aboutBtn);

    screen.appendChild(nav);

    root.appendChild(screen);
    this._screens.home = screen;
  }

  // ---- About screen -------------------------------------------------------

  _buildAbout(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-about";
    screen.dataset.screen = "about";

    const back = document.createElement("button");
    back.className = "menu-back-btn";
    back.id = "about-back-btn";
    back.textContent = "← BACK";
    this._addListener(back, "click", () => {
      if (this._callbacks.onAboutBack) this._callbacks.onAboutBack();
    });
    screen.appendChild(back);

    const header = document.createElement("header");
    header.className = "menu-title";
    header.innerHTML = `
      <h1>ABOUT</h1>
      <div class="menu-title-accent"></div>
    `;
    screen.appendChild(header);

    const body = document.createElement("div");
    body.className = "menu-about-body";
    body.innerHTML = `
      <p><strong>APHELION STAR FIGHTER</strong> is a 2D fleet-combat game —
      pilot a single fighter, command a fleet from the bridge, or run a
      branching roguelite campaign in Frontier mode.</p>
      <p>Touch and mouse + keyboard supported. Five game modes; six ship
      classes per side; deep, destructible capital ships.</p>
      <p class="menu-about-credits">Built with vanilla JS + Canvas2D, packaged
      for mobile via Capacitor.</p>
    `;
    screen.appendChild(body);

    root.appendChild(screen);
    this._screens.about = screen;
  }

  // ---- Main Menu (PLAY screen) --------------------------------------------
  // Mode chips drive what extra sections (map size / faction / fleet size)
  // appear below — Frontier and Custom hide everything because their
  // options live in the respective overlays.

  _buildMainMenu(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-main";
    screen.dataset.screen = "main";

    // BACK button — returns to home screen.
    const back = document.createElement("button");
    back.className = "menu-back-btn";
    back.id = "main-back-btn";
    back.textContent = "← BACK";
    this._addListener(back, "click", () => {
      if (this._callbacks.onMainBack) this._callbacks.onMainBack();
    });
    screen.appendChild(back);

    // Title
    const header = document.createElement("header");
    header.className = "menu-title menu-title-play";
    header.innerHTML = `
      <h1>PLAY</h1>
      <div class="menu-title-accent"></div>
    `;
    screen.appendChild(header);

    // Chip sections: mode (always), then size/race/fleet (conditional)
    const sections = [
      { key: "mode", label: "GAME MODE", chipId: "mode-chips" },
      { key: "size", label: "MAP SIZE", chipId: "size-chips" },
      { key: "race", label: "FACTION", chipId: "race-chips" },
      { key: "fleet", label: "FLEET SIZE", chipId: "fleet-chips" },
    ];

    this._sectionEls = {};
    for (const sec of sections) {
      const section = document.createElement("div");
      section.className = "menu-section";
      section.dataset.section = sec.key;
      section.innerHTML = `
        <div class="section-label"><span></span>${sec.label}<span></span></div>
        <div class="chip-row" id="${sec.chipId}"></div>
      `;
      screen.appendChild(section);
      this._chipContainers[sec.key] = section.querySelector(".chip-row");
      this._chips[sec.key] = [];
      this._sectionEls[sec.key] = section;
    }

    // Frontier status line
    this._frontierStatus = document.createElement("div");
    this._frontierStatus.className = "frontier-status";
    this._frontierStatus.id = "frontier-status";
    screen.appendChild(this._frontierStatus);

    // START button
    this._startBtn = document.createElement("button");
    this._startBtn.className = "menu-start-btn";
    this._startBtn.id = "main-start-btn";
    this._startBtn.textContent = "DEPLOY";
    this._addListener(this._startBtn, "click", () => {
      const label = this._startBtn.textContent;
      if (label === "CONFIGURE..." && this._callbacks.onConfigure) {
        this._callbacks.onConfigure();
      } else if (label === "RESUME CAMPAIGN" && this._callbacks.onResumeRun) {
        this._callbacks.onResumeRun();
      } else if (label === "NEW CAMPAIGN" && this._callbacks.onNewRun) {
        this._callbacks.onNewRun();
      } else if (label === "OUT OF STAMINA" && this._callbacks.onRefillOpen) {
        this._callbacks.onRefillOpen();
      } else if (this._callbacks.onStart) {
        this._callbacks.onStart();
      }
    });
    screen.appendChild(this._startBtn);

    root.appendChild(screen);
    this._screens.main = screen;
  }

  // ---- Energy Bar ---------------------------------------------------------

  _buildEnergyBar(root) {
    const bar = document.createElement("div");
    bar.className = "menu-energy-bar";
    bar.id = "menu-energy-bar";
    bar.style.display = "none";
    bar.innerHTML = `
      <div class="energy-bar-inner">
        <div class="energy-label">STAMINA</div>
        <div class="energy-count" id="energy-count">5/10</div>
      </div>
      <div class="energy-regen" id="energy-regen"></div>
      <div class="energy-refill-label">+ RESTORE</div>
    `;
    this._energyCount = bar.querySelector("#energy-count");
    this._energyRegen = bar.querySelector("#energy-regen");

    this._addListener(bar, "click", () => {
      if (this._callbacks.onRefillOpen) this._callbacks.onRefillOpen();
    });

    root.appendChild(bar);
    this._energyBar = bar;
  }

  // ---- Settings Button ----------------------------------------------------

  _buildSettingsBtn(root) {
    const btn = document.createElement("button");
    btn.className = "menu-settings-btn";
    btn.id = "menu-settings-btn";
    btn.style.display = "none";
    btn.innerHTML = `
      <span>SETTINGS</span>
      <span class="settings-mute-dot" style="display:none;"></span>
    `;
    this._addListener(btn, "click", () => {
      if (this._callbacks.onSettingsOpen) this._callbacks.onSettingsOpen();
    });
    root.appendChild(btn);
    this._settingsBtn = btn;
  }

  // ---- Settings Overlay ---------------------------------------------------

  _buildSettingsOverlay(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-settings";
    screen.dataset.screen = "settings";
    screen.innerHTML = `
      <div class="overlay-panel">
        <div class="panel-accent-rule"></div>
        <h2>SETTINGS</h2>
        <div class="settings-rows">
          <button class="settings-toggle" id="settings-music" data-setting="music">
            <span class="toggle-label">MUSIC</span>
            <span class="toggle-value">ON</span>
          </button>
          <button class="settings-toggle" id="settings-sfx" data-setting="sfx">
            <span class="toggle-label">SFX</span>
            <span class="toggle-value">ON</span>
          </button>
        </div>
        <p class="settings-hint">Tap rows to toggle &middot; P mutes music mid-match</p>
        <button class="overlay-close-btn" id="settings-close">CLOSE</button>
      </div>
    `;

    this._settingsMusicToggle = screen.querySelector("#settings-music");
    this._settingsSfxToggle = screen.querySelector("#settings-sfx");

    this._addListener(this._settingsMusicToggle, "click", () => {
      if (this._callbacks.onMusicToggle) this._callbacks.onMusicToggle();
    });
    this._addListener(this._settingsSfxToggle, "click", () => {
      if (this._callbacks.onSfxToggle) this._callbacks.onSfxToggle();
    });
    this._addListener(screen.querySelector("#settings-close"), "click", () => {
      if (this._callbacks.onSettingsClose) this._callbacks.onSettingsClose();
    });

    root.appendChild(screen);
    this._screens.settings = screen;
  }

  // ---- Refill Overlay -----------------------------------------------------

  _buildRefillOverlay(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-refill";
    screen.dataset.screen = "refill";
    screen.innerHTML = `
      <div class="overlay-panel">
        <h2>RESTORE STAMINA</h2>
        <p class="refill-subtitle">Get back on the field instantly</p>
        <div class="refill-packages" id="refill-packages"></div>
        <button class="overlay-close-btn" id="refill-close">CLOSE</button>
      </div>
    `;

    this._refillPackages = screen.querySelector("#refill-packages");
    this._addListener(screen.querySelector("#refill-close"), "click", () => {
      if (this._callbacks.onRefillClose) this._callbacks.onRefillClose();
    });

    root.appendChild(screen);
    this._screens.refill = screen;
  }

  // ---- Custom Match Overlay -----------------------------------------------

  _buildCustomOverlay(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-custom";
    screen.dataset.screen = "custom";
    screen.innerHTML = `
      <div class="overlay-panel custom-panel">
        <div class="panel-accent-rule"></div>
        <h2>CUSTOM MATCH</h2>
        <p class="custom-subtitle">PICK FACTION &middot; DRAG SLIDERS TO SET UNITS</p>
        <div class="custom-sides">
          <div class="custom-side" data-side="allied">
            <div class="custom-side-header">
              <span class="side-title">FRIENDLY</span>
              <span class="side-race" id="custom-allied-race">Terran</span>
              <span class="side-tagline" id="custom-allied-tagline"></span>
            </div>
            <div class="custom-race-chips" id="custom-allied-races"></div>
            <div class="custom-divider"></div>
            <div class="custom-sliders" id="custom-allied-sliders"></div>
            <div class="custom-side-total" id="custom-allied-total">0 units</div>
          </div>
          <div class="custom-side" data-side="hostile">
            <div class="custom-side-header">
              <span class="side-title">ENEMY</span>
              <span class="side-race" id="custom-hostile-race">Terran</span>
              <span class="side-tagline" id="custom-hostile-tagline"></span>
            </div>
            <div class="custom-race-chips" id="custom-hostile-races"></div>
            <div class="custom-divider"></div>
            <div class="custom-sliders" id="custom-hostile-sliders"></div>
            <div class="custom-side-total" id="custom-hostile-total">0 units</div>
          </div>
        </div>
        <div class="custom-totals" id="custom-grand-total"></div>
        <div class="custom-footer">
          <button class="menu-btn cancel-btn" id="custom-cancel">CANCEL</button>
          <button class="menu-btn start-btn" id="custom-start">START</button>
        </div>
      </div>
    `;

    this._customAlliedRaceName = screen.querySelector("#custom-allied-race");
    this._customAlliedTagline = screen.querySelector("#custom-allied-tagline");
    this._customHostileRaceName = screen.querySelector("#custom-hostile-race");
    this._customHostileTagline = screen.querySelector("#custom-hostile-tagline");
    this._customAlliedRaces = screen.querySelector("#custom-allied-races");
    this._customHostileRaces = screen.querySelector("#custom-hostile-races");
    this._customAlliedSliders = screen.querySelector("#custom-allied-sliders");
    this._customHostileSliders = screen.querySelector("#custom-hostile-sliders");
    this._customAlliedTotal = screen.querySelector("#custom-allied-total");
    this._customHostileTotal = screen.querySelector("#custom-hostile-total");
    this._customGrandTotal = screen.querySelector("#custom-grand-total");

    this._addListener(screen.querySelector("#custom-cancel"), "click", () => {
      if (this._callbacks.onCustomClose) this._callbacks.onCustomClose();
    });
    this._addListener(screen.querySelector("#custom-start"), "click", () => {
      if (this._callbacks.onCustomStart) this._callbacks.onCustomStart();
    });

    root.appendChild(screen);
    this._screens.custom = screen;
  }

  // ---- Run Setup ----------------------------------------------------------

  _buildRunSetup(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-runsetup";
    screen.dataset.screen = "runSetup";
    screen.innerHTML = `
      <div class="runsetup-panel">
        <h2>SELECT FACTION</h2>
        <p class="runsetup-subtitle">Choose your faction for the Frontier campaign</p>
        <div class="faction-grid" id="faction-grid"></div>
        <div class="runsetup-footer">
          <button class="menu-btn cancel-btn" id="runsetup-cancel">CANCEL</button>
        </div>
      </div>
    `;

    this._factionGrid = screen.querySelector("#faction-grid");
    this._addListener(screen.querySelector("#runsetup-cancel"), "click", () => {
      if (this._callbacks.onRunSetupCancel) this._callbacks.onRunSetupCancel();
    });

    root.appendChild(screen);
    this._screens.runSetup = screen;
  }

  // ---- Battle Choice ------------------------------------------------------

  _buildBattleChoice(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-battlechoice";
    screen.dataset.screen = "battleChoice";
    screen.innerHTML = `
      <div class="overlay-panel">
        <div class="panel-accent-rule"></div>
        <h2 id="battle-title">ENEMY SPOTTED</h2>
        <div class="battle-info" id="battle-info"></div>
        <div class="battle-actions">
          <button class="menu-btn battle-btn" id="battle-fly">FLY INTO BATTLE</button>
          <button class="menu-btn battle-btn" id="battle-command">COMMAND FLEET</button>
        </div>
        <button class="menu-btn cancel-btn" id="battle-back">BACK TO MAP</button>
      </div>
    `;

    this._battleTitle = screen.querySelector("#battle-title");
    this._battleInfo = screen.querySelector("#battle-info");
    this._addListener(screen.querySelector("#battle-fly"), "click", () => {
      if (this._callbacks.onBattleFly) this._callbacks.onBattleFly();
    });
    this._addListener(screen.querySelector("#battle-command"), "click", () => {
      if (this._callbacks.onBattleCommand) this._callbacks.onBattleCommand();
    });
    this._addListener(screen.querySelector("#battle-back"), "click", () => {
      if (this._callbacks.onBattleBack) this._callbacks.onBattleBack();
    });

    root.appendChild(screen);
    this._screens.battleChoice = screen;
  }

  // ---- Resupply -----------------------------------------------------------

  _buildResupply(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-resupply";
    screen.dataset.screen = "resupply";
    screen.innerHTML = `
      <div class="overlay-panel resupply-panel">
        <div class="panel-accent-rule"></div>
        <h2>RESUPPLY DEPOT</h2>
        <div class="resupply-credits" id="resupply-credits"></div>
        <div class="resupply-section" id="resupply-repairs"></div>
        <div class="resupply-section" id="resupply-craft">
          <div class="resupply-row">
            <button class="shop-btn" id="resupply-fighter">Hire Fighter</button>
            <button class="shop-btn" id="resupply-bomber">Hire Bomber</button>
          </div>
          <button class="shop-btn wide" id="resupply-refuel">Refuel</button>
        </div>
        <div class="resupply-section" id="resupply-boons"></div>
        <div class="overlay-footer">
          <button class="overlay-close-btn" id="resupply-close">CLOSE</button>
          <button class="menu-btn start-btn" id="resupply-continue">CONTINUE</button>
        </div>
      </div>
    `;

    this._resupplyCredits = screen.querySelector("#resupply-credits");
    this._resupplyRepairs = screen.querySelector("#resupply-repairs");
    this._resupplyFighterBtn = screen.querySelector("#resupply-fighter");
    this._resupplyBomberBtn = screen.querySelector("#resupply-bomber");
    this._resupplyRefuelBtn = screen.querySelector("#resupply-refuel");
    this._resupplyBoons = screen.querySelector("#resupply-boons");

    this._addListener(this._resupplyFighterBtn, "click", () => {
      if (this._callbacks.onResupplyRecruit) this._callbacks.onResupplyRecruit("fighter");
    });
    this._addListener(this._resupplyBomberBtn, "click", () => {
      if (this._callbacks.onResupplyRecruit) this._callbacks.onResupplyRecruit("bomber");
    });
    this._addListener(this._resupplyRefuelBtn, "click", () => {
      if (this._callbacks.onResupplyRecruit) this._callbacks.onResupplyRecruit("refuel");
    });
    this._addListener(screen.querySelector("#resupply-close"), "click", () => {
      if (this._callbacks.onResupplyClose) this._callbacks.onResupplyClose();
    });
    this._addListener(screen.querySelector("#resupply-continue"), "click", () => {
      if (this._callbacks.onResupplyContinue) this._callbacks.onResupplyContinue();
    });

    root.appendChild(screen);
    this._screens.resupply = screen;
  }

  // ---- Event --------------------------------------------------------------

  _buildEvent(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-event";
    screen.dataset.screen = "event";
    screen.innerHTML = `
      <div class="overlay-panel event-panel">
        <div class="panel-accent-rule"></div>
        <h2 id="event-title">ANOMALY DETECTED</h2>
        <div class="event-body" id="event-body"></div>
        <div class="event-choices" id="event-choices"></div>
        <div class="overlay-footer">
          <button class="overlay-close-btn" id="event-close">CLOSE</button>
        </div>
      </div>
    `;

    this._eventTitle = screen.querySelector("#event-title");
    this._eventBody = screen.querySelector("#event-body");
    this._eventChoices = screen.querySelector("#event-choices");
    this._addListener(screen.querySelector("#event-close"), "click", () => {
      if (this._callbacks.onEventClose) this._callbacks.onEventClose();
    });

    root.appendChild(screen);
    this._screens.event = screen;
  }

  // -------------------------------------------------------------------------
  // Event listener helper (tracked for cleanup)
  // -------------------------------------------------------------------------

  _addListener(el, type, fn) {
    if (!el) return;
    el.addEventListener(type, fn);
    this._listeners.push({ el, type, fn });
  }

  // -------------------------------------------------------------------------
  // Chip builders
  // -------------------------------------------------------------------------

  _buildChips(container, items, onClick) {
    container.innerHTML = "";
    const chips = [];
    for (const item of items) {
      const chip = document.createElement("button");
      chip.className = "chip-item";
      chip.dataset.key = item.key;
      chip.innerHTML = `
        <div class="chip-label">${item.label}</div>
        <div class="chip-sublabel">${item.sublabel || ""}</div>
      `;
      this._addListener(chip, "click", () => onClick(item.key));
      container.appendChild(chip);
      chips.push({ el: chip, key: item.key });
    }
    return chips;
  }

  _updateChipSelection(chips, selectedKey) {
    for (const { el, key } of chips) {
      el.classList.toggle("selected", key === selectedKey);
    }
  }

  // -------------------------------------------------------------------------
  // sync() — called each frame, updates ALL dynamic content
  // -------------------------------------------------------------------------

  sync(menuState) {
    if (!menuState) return;

    // --- Main menu chips (build once, then update selection) ---
    this._syncMainMenuChips(menuState);

    // --- START button label ---
    this._syncStartButton(menuState);

    // --- Frontier status line ---
    this._syncFrontierStatus(menuState);

    // --- Energy bar ---
    this._syncEnergyBar(menuState);

    // --- Settings button mute dot ---
    this._syncSettingsBtn(menuState);

    // --- Settings toggle states ---
    this._syncSettings(menuState);

    // --- Refill packages ---
    this._syncRefill(menuState);

    // --- Custom match ---
    this._syncCustomMatch(menuState);

    // --- Run setup faction cards ---
    this._syncRunSetup(menuState);

    // --- Battle choice ---
    this._syncBattleChoice(menuState);

    // --- Resupply ---
    this._syncResupply(menuState);

    // --- Event ---
    this._syncEvent(menuState);
  }

  // ---- sync: Main Menu Chips ----------------------------------------------

  _syncMainMenuChips(s) {
    // Build chips on first call when the arrays are available
    if (!this._chips.size.length && s.mapSizes) {
      const items = s.mapSizes.map((sz) => ({
        key: sz.key, label: sz.label, sublabel: `${sz.mapW} \u00d7 ${sz.mapH}`,
      }));
      this._chips.size = this._buildChips(this._chipContainers.size, items,
        (key) => { if (this._callbacks.onSizeSelect) this._callbacks.onSizeSelect(key); });
    }
    if (!this._chips.mode.length && s.modeOptions) {
      const items = s.modeOptions.map((m) => ({
        key: m.key, label: m.label, sublabel: m.tagline,
      }));
      this._chips.mode = this._buildChips(this._chipContainers.mode, items,
        (key) => { if (this._callbacks.onModeSelect) this._callbacks.onModeSelect(key); });
    }
    if (!this._chips.race.length && s.raceKeys && s.races) {
      const items = s.raceKeys.map((k) => ({
        key: k, label: s.races[k] ? s.races[k].name : k, sublabel: s.races[k] ? s.races[k].tagline : "",
      }));
      this._chips.race = this._buildChips(this._chipContainers.race, items,
        (key) => { if (this._callbacks.onRaceSelect) this._callbacks.onRaceSelect(key); });
    }
    if (!this._chips.fleet.length && s.fleetOptions) {
      const items = s.fleetOptions.map((f) => ({
        key: f.key, label: f.label, sublabel: f.tagline,
      }));
      this._chips.fleet = this._buildChips(this._chipContainers.fleet, items,
        (key) => { if (this._callbacks.onFleetSelect) this._callbacks.onFleetSelect(key); });
    }

    // Update selected states
    if (this._chips.size.length) this._updateChipSelection(this._chips.size, s.selectedSize);
    if (this._chips.mode.length) this._updateChipSelection(this._chips.mode, s.selectedMode);
    if (this._chips.race.length) this._updateChipSelection(this._chips.race, s.selectedRace);
    if (this._chips.fleet.length) this._updateChipSelection(this._chips.fleet, s.selectedFleet);

    // Hide size/race/fleet for modes that own their own setup. Frontier
    // gets faction + map size from the run itself; Custom owns rosters
    // and races inside its CONFIGURE overlay.
    if (this._sectionEls) {
      const mode = s.selectedMode;
      const isRoguelite = mode === "roguelite";
      const isCustom = mode === "custom";
      const hideAll = isRoguelite;
      const hideExtras = isRoguelite || isCustom;
      if (this._sectionEls.size) this._sectionEls.size.style.display = hideAll ? "none" : "";
      if (this._sectionEls.race) this._sectionEls.race.style.display = hideExtras ? "none" : "";
      if (this._sectionEls.fleet) this._sectionEls.fleet.style.display = hideExtras ? "none" : "";
    }
  }

  // ---- sync: START Button -------------------------------------------------

  _syncStartButton(s) {
    const outOfEnergy = s.canSpendEnergy === false;
    const mode = s.selectedMode;
    const hasRun = s.runState && s.runState.run;

    let label = "DEPLOY";
    if (outOfEnergy) label = "OUT OF STAMINA";
    else if (mode === "custom") label = "CONFIGURE...";
    else if (mode === "roguelite" && hasRun) label = "RESUME CAMPAIGN";
    else if (mode === "roguelite" && !hasRun) label = "NEW CAMPAIGN";

    this._startBtn.textContent = label;
    this._startBtn.classList.toggle("out-of-energy", outOfEnergy);
  }

  // ---- sync: Frontier Status ----------------------------------------------

  _syncFrontierStatus(s) {
    if (s.selectedMode !== "roguelite") {
      this._frontierStatus.textContent = "";
      this._frontierStatus.style.display = "none";
      return;
    }
    this._frontierStatus.style.display = "block";

    const run = s.runState && s.runState.run;
    const meta = s.runState && s.runState.meta;
    if (run) {
      const totalNodes = run.graphs.reduce((n, g) => n + g.nodes.length, 0);
      const raceName = s.races[run.faction] ? s.races[run.faction].name : run.faction;
      this._frontierStatus.textContent =
        `ACTIVE CAMPAIGN \u2014 ${raceName.toUpperCase()} \u00b7 ACT ${run.act}/${s.actsPerRun || 3} \u00b7 ${run.visitedNodeIds.length}/${totalNodes} COMPLETED`;
    } else if (meta) {
      const perksTotal = s.perks ? Object.keys(s.perks).length : 0;
      this._frontierStatus.textContent =
        `Campaigns completed: ${meta.runsWon || 0} / ${meta.runsCompleted || 0}   \u00b7   Perks: ${(meta.unlockedPerks || []).length}/${perksTotal}`;
    } else {
      this._frontierStatus.textContent = "";
    }
  }

  // ---- sync: Energy Bar ---------------------------------------------------

  _syncEnergyBar(s) {
    const e = s.energy;
    if (!e) return;
    this._energyCount.textContent = `${e.current}/${e.max}`;

    const regen = s.energyRegen;
    if (regen && regen.next && e.current < e.max) {
      this._energyRegen.innerHTML = `<span>${regen.next}</span><span class="regen-label">${regen.label || "until +1"}</span>`;
      this._energyRegen.style.display = "block";
    } else {
      this._energyRegen.textContent = "";
      this._energyRegen.style.display = "none";
    }
  }

  // ---- sync: Settings Button ----------------------------------------------

  _syncSettingsBtn(s) {
    const muted = s.settings && s.settings.musicMuted;
    const dot = this._settingsBtn.querySelector(".settings-mute-dot");
    if (dot) dot.style.display = muted ? "inline-block" : "none";
  }

  // ---- sync: Settings Toggles ---------------------------------------------

  _syncSettings(s) {
    const st = s.settings || {};
    this._syncToggle(this._settingsMusicToggle, !st.musicMuted);
    this._syncToggle(this._settingsSfxToggle, !st.sfxMuted);
  }

  _syncToggle(el, isOn) {
    if (!el) return;
    const valueEl = el.querySelector(".toggle-value");
    el.classList.toggle("off", !isOn);
    if (valueEl) valueEl.textContent = isOn ? "ON" : "OFF";
  }

  // ---- sync: Refill Packages ----------------------------------------------

  _syncRefill(s) {
    const packages = s.packages || [];
    // Build package cards on first change in package count
    if (this._refillPackages.children.length !== packages.length) {
      this._refillPackages.innerHTML = "";
      for (const pkg of packages) {
        const card = document.createElement("button");
        card.className = "refill-package";
        card.innerHTML = `
          <div class="pkg-amount">+${pkg.amount || pkg.energy || 0}</div>
          <div class="pkg-label">${pkg.label || "Energy"}</div>
          <div class="pkg-price">${pkg.priceLabel || ""}</div>
        `;
        this._addListener(card, "click", () => {
          if (this._callbacks.onRefillBuy) this._callbacks.onRefillBuy(pkg.id);
        });
        this._refillPackages.appendChild(card);
      }
    }
  }

  // ---- sync: Custom Match -------------------------------------------------

  _syncCustomMatch(s) {
    const custom = s.custom;
    if (!custom) return;

    // Side color accents
    const alliedAccent = "#5af";
    const hostileAccent = "#f55";

    // Update race names and taglines
    const aRace = s.races[custom.alliedRace];
    const hRace = s.races[custom.hostileRace];
    this._customAlliedRaceName.textContent = aRace ? aRace.name : custom.alliedRace;
    this._customAlliedTagline.textContent = aRace ? aRace.tagline : "";
    this._customHostileRaceName.textContent = hRace ? hRace.name : custom.hostileRace;
    this._customHostileTagline.textContent = hRace ? hRace.tagline : "";

    // Build race chips on first call
    if (!this._customAlliedRaces.children.length && s.raceKeys) {
      const items = s.raceKeys.map((k) => ({
        key: k, label: s.races[k] ? s.races[k].name : k, sublabel: "",
      }));
      this._customAlliedRaces.innerHTML = "";
      for (const item of items) {
        const chip = document.createElement("button");
        chip.className = "chip-item chip-sm";
        chip.dataset.key = item.key;
        chip.textContent = item.label;
        this._addListener(chip, "click", () => {
          if (this._callbacks.onCustomRaceSelect) this._callbacks.onCustomRaceSelect("allied", item.key);
        });
        this._customAlliedRaces.appendChild(chip);
      }
    }
    if (!this._customHostileRaces.children.length && s.raceKeys) {
      const items = s.raceKeys.map((k) => ({
        key: k, label: s.races[k] ? s.races[k].name : k, sublabel: "",
      }));
      this._customHostileRaces.innerHTML = "";
      for (const item of items) {
        const chip = document.createElement("button");
        chip.className = "chip-item chip-sm";
        chip.dataset.key = item.key;
        chip.textContent = item.label;
        this._addListener(chip, "click", () => {
          if (this._callbacks.onCustomRaceSelect) this._callbacks.onCustomRaceSelect("hostile", item.key);
        });
        this._customHostileRaces.appendChild(chip);
      }
    }

    // Update race chip selections
    for (const chip of this._customAlliedRaces.children) {
      chip.classList.toggle("selected", chip.dataset.key === custom.alliedRace);
    }
    for (const chip of this._customHostileRaces.children) {
      chip.classList.toggle("selected", chip.dataset.key === custom.hostileRace);
    }

    // Build sliders on first call
    if (!this._customAlliedSliders.children.length) {
      this._buildSliders(this._customAlliedSliders, "allied", alliedAccent, custom);
    }
    if (!this._customHostileSliders.children.length) {
      this._buildSliders(this._customHostileSliders, "hostile", hostileAccent, custom);
    }

    // Update slider values
    this._updateSliders(this._customAlliedSliders, custom.blueCounts || {});
    this._updateSliders(this._customHostileSliders, custom.redCounts || {});

    // Update totals
    this._customAlliedTotal.textContent = `${custom.blueTotal || 0} ships`;
    this._customHostileTotal.textContent = `${custom.redTotal || 0} ships`;

    let totalsColor = "#9bd";
    const grand = custom.grandTotal || 0;
    if (grand > 400) totalsColor = "#f97";
    else if (grand > 200) totalsColor = "#fc8";
    this._customGrandTotal.textContent = `Total fleet \u00b7 Friendly ${custom.blueTotal || 0}  \u00b7  Enemy ${custom.redTotal || 0}  \u00b7  ${grand} ships`;
    this._customGrandTotal.style.color = totalsColor;
  }

  _buildSliders(container, side, accent, custom) {
    container.innerHTML = "";
    const classes = custom.classes || CUSTOM_CLASSES;
    for (const klass of classes) {
      const row = document.createElement("div");
      row.className = "slider-row";
      row.dataset.klass = klass;
      const glyph = (custom.classGlyphs || CLASS_GLYPHS)[klass] || "?";
      const name = (custom.classNames || CLASS_LABELS)[klass] || klass;
      row.innerHTML = `
        <span class="slider-glyph">${glyph}</span>
        <span class="slider-name">${name}</span>
        <input type="range" class="custom-slider" min="0" max="${custom.maxPerClass || CUSTOM_MAX_PER_CLASS}" value="0" data-klass="${klass}">
        <span class="slider-count">0</span>
      `;
      const input = row.querySelector("input");
      input.style.accentColor = accent;
      this._addListener(input, "input", () => {
        const countEl = row.querySelector(".slider-count");
        countEl.textContent = input.value;
        if (this._callbacks.onCustomSliderChange) {
          this._callbacks.onCustomSliderChange(side, klass, parseInt(input.value, 10));
        }
      });
      container.appendChild(row);
    }
  }

  _updateSliders(container, counts) {
    for (const row of container.children) {
      const klass = row.dataset.klass;
      const input = row.querySelector("input");
      const countEl = row.querySelector(".slider-count");
      const val = counts[klass] || 0;
      if (input && parseInt(input.value, 10) !== val) {
        input.value = val;
      }
      if (countEl) countEl.textContent = val;
    }
  }

  // ---- sync: Run Setup ----------------------------------------------------

  _syncRunSetup(s) {
    const factions = s.factions || [];
    if (!this._factionGrid.children.length && factions.length) {
      this._factionGrid.innerHTML = "";
      this._factionCards = [];
      for (const key of factions) {
        const race = s.races ? s.races[key] : null;
        const meta = s.factionMeta ? s.factionMeta[key] : null;
        const card = document.createElement("button");
        card.className = "faction-card";
        card.dataset.key = key;
        const accent = race ? race.accent : "#7df";
        const wins = meta ? (meta.wins || 0) : 0;
        const winsText = wins > 0
          ? `&#9733; ${wins} VICTOR${wins > 1 ? "IES" : "Y"}`
          : "Unbroken";
        card.innerHTML = `
          <div class="faction-emblem" style="background:${accent};"></div>
          <div class="faction-name">${race ? race.name.toUpperCase() : key.toUpperCase()}</div>
          <div class="faction-tagline">${race ? race.tagline : ""}</div>
          <div class="faction-record">${winsText}</div>
        `;
        this._addListener(card, "click", () => {
          if (this._callbacks.onRunSetupSelect) this._callbacks.onRunSetupSelect(key);
        });
        this._factionGrid.appendChild(card);
        this._factionCards.push({ el: card, key });
      }
    }
  }

  // ---- sync: Battle Choice ------------------------------------------------

  _syncBattleChoice(s) {
    const node = s.battleNode;
    if (!node) return;
    const race = s.races ? s.races[node.faction] : null;
    const raceName = race ? race.name : (node.faction || "Unknown");
    const tier = node.tier || 1;
    const tierLabel = tier === 1 ? "Standard" : tier === 2 ? "Elite" : "Boss";
    this._battleTitle.textContent = "ENEMY SPOTTED";
    this._battleInfo.innerHTML = `
      <span class="battle-faction" style="color:${race ? race.accent : '#cef'};">${raceName.toUpperCase()}</span>
      <span class="battle-tier">${tierLabel} (Tier ${tier})</span>
    `;
  }

  // ---- sync: Resupply -----------------------------------------------------

  _syncResupply(s) {
    const rs = s.resupply;
    if (!rs) return;

    // Credits/fuel header
    this._resupplyCredits.textContent = `${rs.credits || 0} credits  \u00b7  ${rs.fuel || 0} fuel`;

    // Repair rows — rebuild if count changes to ensure correct data
    const capitals = rs.capitals || [];
    this._resupplyRepairs.innerHTML = "";
    for (const cap of capitals) {
      const row = document.createElement("div");
      row.className = "repair-row";
      const hpPct = Math.round((cap.hpFrac || 0) * 100);
      const isFull = hpPct >= 100;
      const canAfford = rs.credits >= (cap.repairCost || 0);
      row.innerHTML = `
        <div class="repair-info">
          <span class="repair-name">${capitalDisplayName(cap.klass)}</span>
          <span class="repair-hp">${hpPct}% &rarr; 100%</span>
        </div>
        <div class="repair-hp-bar"><div class="repair-hp-fill" style="width:${hpPct}%;"></div></div>
        <button class="shop-btn repair-btn" data-id="${cap.instanceId}">
          ${isFull ? "FULL" : `Repair (${cap.repairCost || 0} cr)`}
        </button>
      `;
      const btn = row.querySelector(".repair-btn");
      if (isFull || !canAfford) {
        btn.disabled = true;
        btn.classList.add("disabled");
      }
      this._addListener(btn, "click", () => {
        if (this._callbacks.onResupplyRepair) this._callbacks.onResupplyRepair(cap.instanceId);
      });
      this._resupplyRepairs.appendChild(row);
    }

    // Craft buttons — update labels and disabled state
    const fCost = rs.fighterPrice || 0;
    const bCost = rs.bomberPrice || 0;
    const fuelCost = rs.fuelPrice || 0;
    const fighterCount = (rs.smallCraft && rs.smallCraft.fighter) || 0;
    const bomberCount = (rs.smallCraft && rs.smallCraft.bomber) || 0;

    this._resupplyFighterBtn.innerHTML = `Hire Fighter (+1) <span class="shop-cost">${fCost} cr</span>`;
    this._resupplyFighterBtn.classList.toggle("disabled", !rs.canAffordFighter);
    this._resupplyFighterBtn.disabled = !rs.canAffordFighter;

    this._resupplyBomberBtn.innerHTML = `Hire Bomber (+1) <span class="shop-cost">${bCost} cr</span>`;
    this._resupplyBomberBtn.classList.toggle("disabled", !rs.canAffordBomber);
    this._resupplyBomberBtn.disabled = !rs.canAffordBomber;

    this._resupplyRefuelBtn.innerHTML = `Refuel (+1) <span class="shop-cost">${fuelCost} cr</span>`;
    this._resupplyRefuelBtn.classList.toggle("disabled", !rs.canAffordRefuel);
    this._resupplyRefuelBtn.disabled = !rs.canAffordRefuel;

    // Boon offers
    const offers = rs.boonOffers || [];
    this._resupplyBoons.innerHTML = "";
    for (let i = 0; i < offers.length; i++) {
      const offer = offers[i];
      const card = document.createElement("button");
      card.className = "boon-card";
      const canAffordBoon = (rs.fuel || 0) >= 1;
      card.innerHTML = `
        <div class="boon-name">${offer.id || offer.key || "Boon"}</div>
        <div class="boon-desc">${offer.desc || ""}</div>
      `;
      if (!canAffordBoon) {
        card.disabled = true;
        card.classList.add("disabled");
      }
      this._addListener(card, "click", () => {
        if (this._callbacks.onResupplyBoon) this._callbacks.onResupplyBoon(i);
      });
      this._resupplyBoons.appendChild(card);
    }
  }

  // ---- sync: Event --------------------------------------------------------

  _syncEvent(s) {
    const evt = s.event;
    if (!evt) return;
    this._eventTitle.textContent = evt.title ? evt.title.toUpperCase() : "ANOMALY DETECTED";
    this._eventBody.textContent = evt.body || "";

    // Build choice buttons
    const choices = evt.choices || [];
    this._eventChoices.innerHTML = "";
    for (const choice of choices) {
      const btn = document.createElement("button");
      btn.className = "event-choice-btn";
      btn.innerHTML = `
        <span class="choice-label">${choice.label}</span>
        <span class="choice-hint">${choice.hint || ""}</span>
      `;
      this._addListener(btn, "click", () => {
        if (this._callbacks.onEventChoice) this._callbacks.onEventChoice(choice.key);
      });
      this._eventChoices.appendChild(btn);
    }
  }
}
