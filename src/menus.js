/**
 * @file Unified DOM/CSS Menu System for Aphelion Star Fighter.
 *
 * Replaces all Canvas2D menu rendering with a single DOM-based system.
 * One #menu-root container holds all screens; visibility is toggled via
 * CSS classes.  Call sync() each frame with the latest menuState to keep
 * dynamic content fresh.
 */

import { classIconSvg, CLASS_SHORT_LABELS } from "./ship-icons.js";

// Rank insignia — inline SVG per Frontier rank. Drawn with thin
// strokes so they overlay cleanly on the memorial card chrome.
// Visual language: bar count + chevron count escalates with rank.
const RANK_INSIGNIA = {
  "Pilot Officer":   `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="6" y="11" width="12" height="2" fill="currentColor"/></svg>`,
  "Lieutenant":      `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="4" y="9"  width="16" height="2" fill="currentColor"/><rect x="4" y="13" width="16" height="2" fill="currentColor"/></svg>`,
  "Lt. Commander":   `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><polyline points="4,11 12,7 20,11" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><polyline points="4,15 12,11 20,15" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  "Lt Commander":    `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><polyline points="4,11 12,7 20,11" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><polyline points="4,15 12,11 20,15" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  "Captain":         `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><polyline points="4,9  12,5  20,9"  fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><polyline points="4,13 12,9  20,13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><polyline points="4,17 12,13 20,17" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  "Admiral":         `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><polygon points="12,2 14.5,9 22,9 16,13.5 18.5,21 12,17 5.5,21 8,13.5 2,9 9.5,9" fill="currentColor" fill-opacity="0.55" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
};

// Friendly fallback when the rank string doesn't match (defensive
// against old saves with abbreviated rank).
function rankInsigniaSvg(rank) {
  return RANK_INSIGNIA[rank] || RANK_INSIGNIA["Pilot Officer"];
}

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
    this._settingsMusicSlider = null;
    this._settingsMusicVal = null;
    this._settingsSfxSlider = null;
    this._settingsSfxVal = null;

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
  _resetOverlayState(name) {
    // Re-opening an overlay should always land on its first step so
    // returning users aren't dropped halfway through a previous edit.
    // Skip when the screen was already active — showScreen runs every
    // frame from the input draw loop and resetting on every tick would
    // pin the carousel to step 0 forever.
    if (this._currentScreen === name) return;
    if (name === "custom" && typeof this._gotoCustomStep === "function") {
      this._gotoCustomStep(0);
    }
    if (name === "main" && typeof this._gotoMainStep === "function") {
      this._gotoMainStep(0);
    }
  }

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
      this._resetOverlayState(name);
      this._screens[name].classList.add("active");
    }

    // Scrim: visible for overlays, hidden for base screens (home / main / about)
    const overlays = ["settings", "refill", "custom", "runSetup", "battleChoice", "battlePlan", "fleetPlan", "resupply", "event", "promotion", "shipyard"];
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

    // 2b. Play Hub (Tier 44) — clean mobile mode-card layout that
    // replaces the legacy carousel as the home → PLAY destination.
    this._buildPlayHub(root);

    // 2c. Skirmish config sub-screen — clean form-style mode setup.
    this._buildSkirmishConfig(root);

    // 3. About screen
    this._buildAbout(root);

    // 3b. Memorial screen — Frontier career roll
    this._buildMemorial(root);

    // 3c. Shipyard screen — design-your-own-ship meta-progression store.
    this._buildShipyard(root);

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

    // 8b. Battle Plan Overlay — pre-flight orders + enemy roster.
    // Sits between battle-choice and the actual launch. Reads run.
    // Shows enemy fleet composition, lets the player set per-capital
    // postures + fighter/bomber wing commands, then LAUNCH proceeds
    // to startGame.
    this._buildBattlePlan(root);

    // 8b. Fleet Plan overlay — the run-free pre-battle planner shown
    // before every non-Frontier match (per-class directives + wings).
    this._buildFleetPlan(root);

    // 9. Resupply Overlay
    this._buildResupply(root);

    // 10. Event Overlay
    this._buildEvent(root);

    // 11. Promotion Overlay — appears between acts when a boss clear
    // promotes the player. Renders the new rank, the blurb, and what
    // ships are joining the fleet.
    this._buildPromotion(root);

    // 12. Preamble Overlay — short war-state briefing shown at the
    // start of each act, AFTER promotion. Frames the strategic stakes
    // before the player opens the starmap.
    this._buildPreamble(root);

    // 13. Dispatch Overlay — procedural radio transmission shown AFTER
    // the preamble dismisses. Reads as an incoming comm; no choice,
    // just narrative texture before the starmap.
    this._buildDispatch(root);

    // 14. Jump Encounter Overlay — brief mid-jump narrative beat.
    // ~32% chance per jump; reuses the dispatch styling but routed
    // through its own state so it doesn't clobber inter-act dispatches.
    this._buildJumpEncounter(root);

    // 15. Run Stats Overlay — opened from the run map STATS button.
    // Reads run.stats and renders a scrollable breakdown.
    this._buildRunStats(root);

    // 16. Captain Detail Overlay — opens when a capital row is
    // clicked. Shows ship name, captain, trait, XP/level, hp.
    this._buildCaptainDetail(root);

    // 17. Career Detail Overlay — opens when a memorial wall row
    // is clicked. Full epitaph, stats grid, complete log.
    this._buildCareerDetail(root);

    // 18. Service Hall Overlay — meta-progression. Spend service
    // points earned across runs on permanent upgrades.
    this._buildServiceHall(root);

    // 19. New-Career Confirm Overlay — guard rail before abandoning an
    // active Frontier officer for a fresh start.
    this._buildNewCareerConfirm(root);

    this._mountEl.appendChild(root);
  }

  // ---- Home screen --------------------------------------------------------
  // Top-level entry: PLAY / SETTINGS / ABOUT. Energy bar and the floating
  // settings pill stay hidden on this screen — both are scoped to PLAY
  // where launching a match (and spending stamina) is the actual action.

  _buildHome(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-home menu-home-v2";
    screen.dataset.screen = "home";

    // ---- Top status bar — avatar + currencies + inbox ----
    // Mobile-game style: pilot avatar/rank on the left, currency
    // chips on the right with subtle "+" affordances (monetization
    // hook: tap to top up). Service-points chip and credits chip
    // pull from meta + the active run; the premium "tokens" chip
    // is a placeholder for the future Frontier Pass currency.
    const status = document.createElement("header");
    status.className = "home-status-bar";
    status.innerHTML = `
      <div class="home-avatar" id="home-avatar">
        <div class="home-avatar-icon">★</div>
        <div class="home-avatar-meta">
          <div class="home-avatar-rank" id="home-avatar-rank">PILOT OFFICER</div>
          <div class="home-avatar-callsign" id="home-avatar-callsign">— NO CAREER —</div>
          <div class="home-avatar-progress" id="home-avatar-progress" title="Tap to view achievements">✦ 0/0</div>
        </div>
      </div>
      <div class="home-currency-strip">
        <button class="home-currency-chip" id="home-curr-credits" title="Credits">
          <span class="curr-icon">$</span><span class="curr-value" id="home-curr-credits-value">—</span>
        </button>
        <button class="home-currency-chip" id="home-curr-service" title="Service Points · spend in the Service Hall">
          <span class="curr-icon">✦</span><span class="curr-value" id="home-curr-service-value">0</span>
        </button>
        <button class="home-currency-chip home-currency-premium" id="home-curr-tokens" title="Frontier Tokens (coming soon)">
          <span class="curr-icon">◇</span><span class="curr-value">0</span>
        </button>
        <button class="home-inbox-btn" id="home-inbox-btn" title="Inbox (coming soon)">✉</button>
      </div>
    `;
    screen.appendChild(status);

    // ---- Hero band — title + tagline ----
    const hero = document.createElement("section");
    hero.className = "home-hero";
    hero.innerHTML = `
      <div class="home-title-line">
        <h1>APHELION STAR FIGHTER</h1>
        <div class="home-title-rule"></div>
      </div>
      <p class="home-tagline">FRONTIER WARS · YEAR 9</p>
    `;
    screen.appendChild(hero);

    // ---- Main play card — Frontier Campaign (continue / new) ----
    // Big tap target so it reads as the primary action. Below it,
    // smaller mode tiles for Skirmish / Custom / Daily.
    const main = document.createElement("section");
    main.className = "home-main";
    main.innerHTML = `
      <article class="home-card home-card-hero" id="home-card-frontier">
        <div class="card-hero-eyebrow">CAMPAIGN</div>
        <div class="card-hero-title">FRONTIER</div>
        <div class="card-hero-sub" id="card-frontier-sub">Begin a career as a Terran officer.</div>
        <div class="card-hero-actions">
          <button class="home-cta-btn" id="home-cta-primary">NEW CAREER</button>
          <button class="home-cta-btn home-cta-secondary" id="home-cta-secondary" style="display:none;">RESUME</button>
        </div>
      </article>
      <div class="home-tile-row">
        <button class="home-card home-card-tile" id="home-tile-skirmish">
          <div class="tile-icon">⚔</div>
          <div class="tile-title">SKIRMISH</div>
          <div class="tile-sub">One-off battle</div>
        </button>
        <button class="home-card home-card-tile" id="home-tile-custom">
          <div class="tile-icon">⊞</div>
          <div class="tile-title">CUSTOM</div>
          <div class="tile-sub">Build the fight</div>
        </button>
        <button class="home-card home-card-tile home-card-locked" id="home-tile-daily">
          <div class="tile-icon">◷</div>
          <div class="tile-title">DAILY</div>
          <div class="tile-sub">Soon</div>
        </button>
      </div>
      <button class="home-card home-shipyard-card" id="home-shipyard-card">
        <div class="shipyard-card-eyebrow">YOUR SHIP</div>
        <div class="shipyard-card-row">
          <div class="shipyard-card-info">
            <div class="shipyard-card-name" id="home-shipyard-name">ISS Spectre</div>
            <div class="shipyard-card-hull" id="home-shipyard-hull">Fighter</div>
          </div>
          <div class="shipyard-card-right">
            <div class="shipyard-card-credits"><span id="home-shipyard-credits">0</span> <span class="cr">cr</span></div>
            <div class="shipyard-card-cta">ENTER SHIPYARD →</div>
          </div>
        </div>
      </button>
      <div class="home-link-row">
        <button class="home-link" id="home-link-service">
          <span class="link-icon">✦</span><span>SERVICE HALL</span>
        </button>
        <button class="home-link" id="home-link-memorial">
          <span class="link-icon">▣</span><span>MEMORIAL</span>
        </button>
        <button class="home-link" id="home-link-about">
          <span class="link-icon">ⓘ</span><span>ABOUT</span>
        </button>
      </div>
    `;
    screen.appendChild(main);

    // ---- Bottom nav — HOME / STORE / EVENTS / MORE ----
    // STORE + EVENTS are monetization placeholders ("Coming soon")
    // but in place so the nav structure ships now and content can
    // drop into them later without re-laying out the home screen.
    const bottomNav = document.createElement("nav");
    bottomNav.className = "home-bottom-nav";
    bottomNav.innerHTML = `
      <button class="home-nav-btn active" data-nav="home">
        <span class="nav-icon">⌂</span><span class="nav-label">HOME</span>
      </button>
      <button class="home-nav-btn" data-nav="store">
        <span class="nav-icon">▤</span><span class="nav-label">STORE</span>
      </button>
      <button class="home-nav-btn" data-nav="events">
        <span class="nav-icon">★</span><span class="nav-label">EVENTS</span>
      </button>
      <button class="home-nav-btn" data-nav="more">
        <span class="nav-icon">⋯</span><span class="nav-label">MORE</span>
      </button>
    `;
    screen.appendChild(bottomNav);

    // ---- Overlay panels for STORE / EVENTS / MORE ----
    // Each opens fullscreen above the home screen when its nav
    // button is tapped. The MORE panel is a settings-style list
    // (Settings / About / Reset etc).
    const navPanel = document.createElement("section");
    navPanel.className = "home-nav-panel";
    navPanel.id = "home-nav-panel";
    navPanel.setAttribute("aria-hidden", "true");
    navPanel.innerHTML = `
      <header class="home-nav-panel-header">
        <button class="home-nav-panel-back" id="home-nav-panel-back">←</button>
        <h2 id="home-nav-panel-title">PANEL</h2>
        <div class="home-nav-panel-spacer"></div>
      </header>
      <div class="home-nav-panel-body" id="home-nav-panel-body"></div>
    `;
    screen.appendChild(navPanel);

    // Cache element refs.
    this._homeAvatarRank = status.querySelector("#home-avatar-rank");
    this._homeAvatarCallsign = status.querySelector("#home-avatar-callsign");
    this._homeAvatarProgress = status.querySelector("#home-avatar-progress");
    this._homeCurrCredits = status.querySelector("#home-curr-credits-value");
    this._homeCurrService = status.querySelector("#home-curr-service-value");
    this._homeCardSub = main.querySelector("#card-frontier-sub");
    this._homeCtaPrimary = main.querySelector("#home-cta-primary");
    this._homeCtaSecondary = main.querySelector("#home-cta-secondary");
    this._homeShipyardName = main.querySelector("#home-shipyard-name");
    this._homeShipyardHull = main.querySelector("#home-shipyard-hull");
    this._homeShipyardCredits = main.querySelector("#home-shipyard-credits");
    this._homeNavPanel = navPanel;
    this._homeNavPanelTitle = navPanel.querySelector("#home-nav-panel-title");
    this._homeNavPanelBody = navPanel.querySelector("#home-nav-panel-body");
    this._homeSyncSig = null;

    // ---- Wire interactions ----
    // Hero card — primary tap routes to PLAY (the campaign flow);
    // secondary "RESUME" appears only when an active run exists and
    // is wired in _syncHome.
    this._addListener(this._homeCtaPrimary, "click", () => {
      if (this._callbacks.onHomePlay) this._callbacks.onHomePlay();
    });
    // Secondary CTA — when a career is active, this is the
    // "NEW CAREER" override that opens the abandon-confirm overlay.
    // When no career is active it stays hidden (see _syncHome).
    this._addListener(this._homeCtaSecondary, "click", (e) => {
      e.stopPropagation();
      if (this._callbacks.onHomeNewCareer) this._callbacks.onHomeNewCareer();
    });
    this._addListener(main.querySelector("#home-card-frontier"), "click", (e) => {
      // Tapping the card body (not the buttons) also starts the flow.
      if (e.target.closest("button")) return;
      if (this._callbacks.onHomePlay) this._callbacks.onHomePlay();
    });
    // Skirmish → its own setup form; Custom → the custom-match configure
    // overlay. (Previously both fell through to onHomePlay → the play
    // hub, so the two tiles opened the same sub-menu.)
    this._addListener(main.querySelector("#home-tile-skirmish"), "click", () => {
      if (this._callbacks.onHomeSkirmish) this._callbacks.onHomeSkirmish();
      else if (this._callbacks.onHomePlay) this._callbacks.onHomePlay();
    });
    this._addListener(main.querySelector("#home-tile-custom"), "click", () => {
      if (this._callbacks.onHomeCustom) this._callbacks.onHomeCustom();
      else if (this._callbacks.onHomePlay) this._callbacks.onHomePlay();
    });
    this._addListener(main.querySelector("#home-tile-daily"), "click", () => {
      this._openHomeNavPanel("daily");
    });
    // Shipyard card — primary entry point to the design-your-own-ship store.
    this._addListener(main.querySelector("#home-shipyard-card"), "click", () => {
      if (this._callbacks.onHomeShipyard) this._callbacks.onHomeShipyard();
    });
    // Link row.
    this._addListener(main.querySelector("#home-link-service"), "click", () => {
      if (this._callbacks.onHomeServiceHall) this._callbacks.onHomeServiceHall();
    });
    this._addListener(main.querySelector("#home-link-memorial"), "click", () => {
      if (this._callbacks.onHomeMemorial) this._callbacks.onHomeMemorial();
    });
    this._addListener(main.querySelector("#home-link-about"), "click", () => {
      if (this._callbacks.onHomeAbout) this._callbacks.onHomeAbout();
    });
    // Currency chips — tap → open Store / Service Hall.
    this._addListener(status.querySelector("#home-curr-service"), "click", () => {
      if (this._callbacks.onHomeServiceHall) this._callbacks.onHomeServiceHall();
    });
    this._addListener(status.querySelector("#home-curr-tokens"), "click", () => {
      this._openHomeNavPanel("store");
    });
    this._addListener(status.querySelector("#home-curr-credits"), "click", () => {
      this._openHomeNavPanel("store");
    });
    this._addListener(status.querySelector("#home-inbox-btn"), "click", () => {
      this._openHomeNavPanel("events");
    });
    // Avatar progress chip → opens achievements directly.
    this._addListener(status.querySelector("#home-avatar"), "click", () => {
      this._openHomeNavPanel("achievements");
    });
    // Bottom nav.
    for (const btn of bottomNav.querySelectorAll(".home-nav-btn")) {
      this._addListener(btn, "click", () => {
        const nav = btn.dataset.nav;
        if (nav === "home") {
          this._closeHomeNavPanel();
        } else {
          this._openHomeNavPanel(nav);
        }
        for (const b of bottomNav.querySelectorAll(".home-nav-btn")) {
          b.classList.toggle("active", b.dataset.nav === (nav === "home" ? "home" : nav));
        }
      });
    }
    // Back button on the panel.
    this._addListener(navPanel.querySelector("#home-nav-panel-back"), "click", () => {
      this._closeHomeNavPanel();
      for (const b of bottomNav.querySelectorAll(".home-nav-btn")) {
        b.classList.toggle("active", b.dataset.nav === "home");
      }
    });

    root.appendChild(screen);
    this._screens.home = screen;
  }

  // Open a nav panel (STORE / EVENTS / MORE / DAILY). Each is a
  // placeholder Coming Soon view for the monetization scaffold —
  // when the actual content lands later, swap the renderer.
  _openHomeNavPanel(nav) {
    if (!this._homeNavPanel) return;
    const titles = {
      store:  "STORE",
      events: "EVENTS",
      more:   "MORE",
      daily:  "DAILY CHALLENGE",
    };
    this._homeNavPanelTitle.textContent = titles[nav] || nav.toUpperCase();
    if (nav === "store") {
      this._homeNavPanelBody.innerHTML = `
        <div class="store-coming-soon">
          <div class="store-icon">▤</div>
          <h3>FRONTIER STORE</h3>
          <p>Bundles, capital ship skins, and Frontier Tokens will be available here.</p>
          <div class="store-card-row">
            <div class="store-card store-card-locked">
              <div class="store-card-eyebrow">FOUNDERS</div>
              <div class="store-card-title">First-Wave Pack</div>
              <div class="store-card-sub">Lifetime perks for early players</div>
              <div class="store-card-cta">COMING SOON</div>
            </div>
            <div class="store-card store-card-locked">
              <div class="store-card-eyebrow">SEASONAL</div>
              <div class="store-card-title">Frontier Pass</div>
              <div class="store-card-sub">2 tracks · 50 tiers · per season</div>
              <div class="store-card-cta">COMING SOON</div>
            </div>
          </div>
        </div>
      `;
    } else if (nav === "events") {
      this._homeNavPanelBody.innerHTML = `
        <div class="store-coming-soon">
          <div class="store-icon">★</div>
          <h3>LIVE EVENTS</h3>
          <p>Rotating challenges and limited-time modes will appear here.</p>
          <div class="store-card-row">
            <div class="store-card store-card-locked">
              <div class="store-card-eyebrow">WEEKLY</div>
              <div class="store-card-title">Voidsworn Incursion</div>
              <div class="store-card-sub">Boss rush against the Apheliotrope's escorts</div>
              <div class="store-card-cta">SOON</div>
            </div>
            <div class="store-card store-card-locked">
              <div class="store-card-eyebrow">DAILY</div>
              <div class="store-card-title">Daily Combat Drill</div>
              <div class="store-card-sub">Seeded skirmish · global leaderboard</div>
              <div class="store-card-cta">SOON</div>
            </div>
          </div>
        </div>
      `;
    } else if (nav === "daily") {
      this._homeNavPanelBody.innerHTML = `
        <div class="store-coming-soon">
          <div class="store-icon">◷</div>
          <h3>DAILY CHALLENGE</h3>
          <p>A new seeded skirmish refreshes every 24 hours. Compete on the leaderboard.</p>
          <p class="store-coming-tag">FEATURE IN DEVELOPMENT</p>
        </div>
      `;
    } else if (nav === "more") {
      this._homeNavPanelBody.innerHTML = `
        <div class="home-more-list">
          <button class="home-more-row" id="more-achievements">
            <span class="more-icon">✦</span>
            <span class="more-label">ACHIEVEMENTS</span>
            <span class="more-chev">›</span>
          </button>
          <button class="home-more-row" id="more-service">
            <span class="more-icon">🏛</span>
            <span class="more-label">SERVICE HALL</span>
            <span class="more-chev">›</span>
          </button>
          <button class="home-more-row" id="more-memorial">
            <span class="more-icon">▣</span>
            <span class="more-label">MEMORIAL WALL</span>
            <span class="more-chev">›</span>
          </button>
          <button class="home-more-row" id="more-settings">
            <span class="more-icon">⚙</span>
            <span class="more-label">SETTINGS</span>
            <span class="more-chev">›</span>
          </button>
          <button class="home-more-row" id="more-about">
            <span class="more-icon">ⓘ</span>
            <span class="more-label">ABOUT</span>
            <span class="more-chev">›</span>
          </button>
        </div>
      `;
      // Wire the inner rows.
      const achRow = this._homeNavPanelBody.querySelector("#more-achievements");
      const settingsRow = this._homeNavPanelBody.querySelector("#more-settings");
      const aboutRow = this._homeNavPanelBody.querySelector("#more-about");
      const memorialRow = this._homeNavPanelBody.querySelector("#more-memorial");
      const serviceRow = this._homeNavPanelBody.querySelector("#more-service");
      if (achRow) this._addListener(achRow, "click", () => {
        this._openHomeNavPanel("achievements");
      });
      if (settingsRow) this._addListener(settingsRow, "click", () => {
        this._closeHomeNavPanel();
        if (this._callbacks.onSettingsOpen) this._callbacks.onSettingsOpen();
      });
      if (aboutRow) this._addListener(aboutRow, "click", () => {
        this._closeHomeNavPanel();
        if (this._callbacks.onHomeAbout) this._callbacks.onHomeAbout();
      });
      if (memorialRow) this._addListener(memorialRow, "click", () => {
        this._closeHomeNavPanel();
        if (this._callbacks.onHomeMemorial) this._callbacks.onHomeMemorial();
      });
      if (serviceRow) this._addListener(serviceRow, "click", () => {
        this._closeHomeNavPanel();
        if (this._callbacks.onHomeServiceHall) this._callbacks.onHomeServiceHall();
      });
    } else if (nav === "achievements") {
      // Build the achievements grid. Reads from menuState's lastSync
      // payload — set in syncFromState. Falls back to the saveStore
      // direct read if needed.
      this._renderAchievementsPanel();
    }
    this._homeNavPanel.setAttribute("aria-hidden", "false");
    this._homeNavPanel.classList.add("open");
  }

  _closeHomeNavPanel() {
    if (!this._homeNavPanel) return;
    this._homeNavPanel.setAttribute("aria-hidden", "true");
    this._homeNavPanel.classList.remove("open");
  }

  _renderAchievementsPanel() {
    // Stash the data needed via menuState (the achievements list +
    // unlocked ids + total count + reward values). Caller (input.js)
    // populates this on every sync; we read what's there at click time.
    const data = this._achievementsData || { unlocked: [], list: [] };
    this._homeNavPanelTitle.textContent = `ACHIEVEMENTS · ${data.unlocked.length}/${data.list.length}`;
    if (data.list.length === 0) {
      this._homeNavPanelBody.innerHTML = `<div class="td-empty">No achievements available.</div>`;
      return;
    }
    let html = `<div class="achievements-grid">`;
    for (const ach of data.list) {
      const isUnlocked = data.unlocked.includes(ach.id);
      html += `
        <div class="achievement-card ${isUnlocked ? "unlocked" : "locked"}">
          <div class="ach-icon">${ach.icon || "★"}</div>
          <div class="ach-meta">
            <div class="ach-name">${ach.name}</div>
            <div class="ach-desc">${ach.description}</div>
          </div>
          <div class="ach-reward">
            ${isUnlocked
              ? `<span class="ach-unlocked-tag">UNLOCKED</span>`
              : `<span class="ach-reward-chip">+${ach.reward || 0} ✦</span>`}
          </div>
        </div>
      `;
    }
    html += `</div>`;
    this._homeNavPanelBody.innerHTML = html;
  }

  // ---- Play Hub (Tier 44) -------------------------------------------------
  // Mobile-first mode-card layout. Replaces the legacy carousel for the
  // home → PLAY destination. Each card opens its own configuration flow:
  // FRONTIER → run setup / run map; SKIRMISH → skirmish config;
  // CUSTOM → custom builder; DAILY → coming-soon placeholder.

  _buildPlayHub(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-playhub";
    screen.dataset.screen = "playHub";
    screen.innerHTML = `
      <header class="playhub-header">
        <button class="playhub-back" id="playhub-back" title="Back">←</button>
        <h2>SELECT MODE</h2>
        <div class="playhub-spacer"></div>
      </header>
      <div class="playhub-body">
        <article class="playhub-card playhub-card-frontier" id="playhub-frontier">
          <div class="playhub-card-icon">★</div>
          <div class="playhub-card-meta">
            <div class="playhub-card-eyebrow">CAMPAIGN</div>
            <div class="playhub-card-title">FRONTIER</div>
            <div class="playhub-card-sub" id="playhub-frontier-sub">5-act roguelite career. Captains, rivals, and the Apheliotrope.</div>
            <div class="playhub-card-tag" id="playhub-frontier-tag">RECOMMENDED</div>
          </div>
          <div class="playhub-card-cta-stack">
            <button class="playhub-card-cta" id="playhub-frontier-cta">START</button>
            <button class="playhub-card-cta-secondary" id="playhub-frontier-new" style="display:none;">+ NEW CAREER</button>
          </div>
        </article>
        <article class="playhub-card" id="playhub-skirmish">
          <div class="playhub-card-icon">⚔</div>
          <div class="playhub-card-meta">
            <div class="playhub-card-eyebrow">QUICK PLAY</div>
            <div class="playhub-card-title">SKIRMISH</div>
            <div class="playhub-card-sub">One-off battle. Pick map, opponent, and fleet size. No persistence.</div>
          </div>
          <button class="playhub-card-cta" id="playhub-skirmish-cta">CONFIGURE</button>
        </article>
        <article class="playhub-card" id="playhub-custom">
          <div class="playhub-card-icon">⊞</div>
          <div class="playhub-card-meta">
            <div class="playhub-card-eyebrow">SANDBOX</div>
            <div class="playhub-card-title">CUSTOM MATCH</div>
            <div class="playhub-card-sub">Build both sides. Up to two factions per team, per-class ship counts.</div>
          </div>
          <button class="playhub-card-cta" id="playhub-custom-cta">CONFIGURE</button>
        </article>
        <article class="playhub-card playhub-card-locked">
          <div class="playhub-card-icon">◷</div>
          <div class="playhub-card-meta">
            <div class="playhub-card-eyebrow">EVENT</div>
            <div class="playhub-card-title">DAILY CHALLENGE</div>
            <div class="playhub-card-sub">Seeded skirmish that refreshes every 24 hours.</div>
            <div class="playhub-card-tag playhub-card-tag-locked">COMING SOON</div>
          </div>
          <button class="playhub-card-cta" disabled>LOCKED</button>
        </article>
      </div>
    `;
    this._playhubFrontierSub = screen.querySelector("#playhub-frontier-sub");
    this._playhubFrontierTag = screen.querySelector("#playhub-frontier-tag");
    this._playhubFrontierCta = screen.querySelector("#playhub-frontier-cta");
    this._playhubFrontierNew = screen.querySelector("#playhub-frontier-new");
    this._addListener(screen.querySelector("#playhub-back"), "click", () => {
      if (this._callbacks.onPlayHubBack) this._callbacks.onPlayHubBack();
    });
    // FRONTIER — primary flow. Routes to runSetup (new career) or
    // run map (active career) via the existing callbacks.
    const frontierGo = () => {
      if (this._callbacks.onPlayHubFrontier) this._callbacks.onPlayHubFrontier();
    };
    this._addListener(screen.querySelector("#playhub-frontier"), "click", frontierGo);
    this._addListener(this._playhubFrontierCta, "click", (e) => { e.stopPropagation(); frontierGo(); });
    // Secondary "+ NEW CAREER" — only visible with an active run.
    // Opens the abandon-confirm overlay before any state change.
    this._addListener(this._playhubFrontierNew, "click", (e) => {
      e.stopPropagation();
      if (this._callbacks.onPlayHubNewCareer) this._callbacks.onPlayHubNewCareer();
    });
    // SKIRMISH → opens the skirmish config sub-screen.
    const skirmishGo = () => {
      if (this._callbacks.onPlayHubSkirmish) this._callbacks.onPlayHubSkirmish();
    };
    this._addListener(screen.querySelector("#playhub-skirmish"), "click", skirmishGo);
    this._addListener(screen.querySelector("#playhub-skirmish-cta"), "click", (e) => { e.stopPropagation(); skirmishGo(); });
    // CUSTOM → opens the custom overlay (existing).
    const customGo = () => {
      if (this._callbacks.onPlayHubCustom) this._callbacks.onPlayHubCustom();
    };
    this._addListener(screen.querySelector("#playhub-custom"), "click", customGo);
    this._addListener(screen.querySelector("#playhub-custom-cta"), "click", (e) => { e.stopPropagation(); customGo(); });

    root.appendChild(screen);
    this._screens.playHub = screen;
  }

  _syncPlayHub(s) {
    // Update the FRONTIER card to reflect run state: shows CONTINUE
    // + a small "act / rank" line when there's an active career.
    if (!this._playhubFrontierCta) return;
    const run = (s && s.runState && s.runState.run) || null;
    if (run) {
      this._playhubFrontierCta.textContent = "RESUME";
      this._playhubFrontierSub.textContent = `Act ${run.act}/5 · ${(run.callsign || "UNKNOWN")}`;
      this._playhubFrontierTag.textContent = "ACTIVE CAREER";
      this._playhubFrontierTag.classList.add("playhub-card-tag-active");
      if (this._playhubFrontierNew) this._playhubFrontierNew.style.display = "";
    } else {
      this._playhubFrontierCta.textContent = "START";
      this._playhubFrontierSub.textContent = "5-act roguelite career. Captains, rivals, and the Apheliotrope.";
      this._playhubFrontierTag.textContent = "RECOMMENDED";
      this._playhubFrontierTag.classList.remove("playhub-card-tag-active");
      if (this._playhubFrontierNew) this._playhubFrontierNew.style.display = "none";
    }
  }

  // ---- Skirmish config (Tier 44) ------------------------------------------
  // Clean form-style skirmish setup: map size + your faction + enemy
  // faction + fleet-size slider. Routes through onSkirmishStart to
  // emit a `start` payload identical to what the legacy carousel built.

  _buildSkirmishConfig(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-skirmish";
    screen.dataset.screen = "skirmish";
    screen.innerHTML = `
      <header class="playhub-header">
        <button class="playhub-back" id="skirmish-back" title="Back">←</button>
        <h2>SKIRMISH</h2>
        <div class="playhub-spacer"></div>
      </header>
      <div class="skirmish-body">
        <section class="skirmish-section">
          <div class="skirmish-section-title">ARENA SIZE</div>
          <div class="skirmish-chip-row" id="skirmish-sizes"></div>
        </section>
        <section class="skirmish-section">
          <div class="skirmish-section-title">YOUR FACTION</div>
          <div class="skirmish-chip-row" id="skirmish-races"></div>
        </section>
        <section class="skirmish-section">
          <div class="skirmish-section-title">OPPONENT</div>
          <div class="skirmish-chip-row" id="skirmish-opponents"></div>
        </section>
        <section class="skirmish-section">
          <div class="skirmish-section-title">FLEET SIZE</div>
          <div class="skirmish-slider-row">
            <button class="skirmish-step-btn" id="skirmish-fleet-down">−</button>
            <div class="skirmish-slider-track">
              <div class="skirmish-slider-fill" id="skirmish-fleet-fill"></div>
              <div class="skirmish-slider-label" id="skirmish-fleet-label">1.0×</div>
            </div>
            <button class="skirmish-step-btn" id="skirmish-fleet-up">+</button>
          </div>
        </section>
      </div>
      <div class="skirmish-footer">
        <button class="skirmish-deploy-btn" id="skirmish-deploy">DEPLOY</button>
      </div>
    `;
    this._skirmishSizesEl = screen.querySelector("#skirmish-sizes");
    this._skirmishRacesEl = screen.querySelector("#skirmish-races");
    this._skirmishOpponentsEl = screen.querySelector("#skirmish-opponents");
    this._skirmishFleetFill = screen.querySelector("#skirmish-fleet-fill");
    this._skirmishFleetLabel = screen.querySelector("#skirmish-fleet-label");
    this._skirmishSelectedSize = null;
    this._skirmishSelectedRace = null;
    this._skirmishSelectedOpponent = "random";
    this._skirmishFleetMul = 1.0;
    this._addListener(screen.querySelector("#skirmish-back"), "click", () => {
      if (this._callbacks.onSkirmishBack) this._callbacks.onSkirmishBack();
    });
    // Fleet slider — step in 0.25 increments between 0.5x and 3x.
    this._addListener(screen.querySelector("#skirmish-fleet-down"), "click", () => {
      this._skirmishFleetMul = Math.max(0.5, Math.round((this._skirmishFleetMul - 0.25) * 100) / 100);
      this._updateSkirmishFleetSlider();
    });
    this._addListener(screen.querySelector("#skirmish-fleet-up"), "click", () => {
      this._skirmishFleetMul = Math.min(3.0, Math.round((this._skirmishFleetMul + 0.25) * 100) / 100);
      this._updateSkirmishFleetSlider();
    });
    this._addListener(screen.querySelector("#skirmish-deploy"), "click", () => {
      if (this._callbacks.onSkirmishStart) {
        this._callbacks.onSkirmishStart({
          size: this._skirmishSelectedSize,
          race: this._skirmishSelectedRace,
          opponent: this._skirmishSelectedOpponent,
          fleetMul: this._skirmishFleetMul,
        });
      }
    });

    root.appendChild(screen);
    this._screens.skirmish = screen;
  }

  _updateSkirmishFleetSlider() {
    if (!this._skirmishFleetLabel) return;
    this._skirmishFleetLabel.textContent = `${this._skirmishFleetMul.toFixed(2).replace(/\.?0+$/, "")}×`;
    // Map 0.5..3.0 → 0..100%.
    const pct = Math.round(((this._skirmishFleetMul - 0.5) / 2.5) * 100);
    this._skirmishFleetFill.style.width = `${pct}%`;
  }

  _syncSkirmishConfig(s) {
    if (!this._skirmishSizesEl) return;
    // Map sizes — same source as the carousel.
    const sizes = (s && s.mapSizes) || [];
    if (sizes.length > 0 && !this._skirmishSelectedSize) {
      this._skirmishSelectedSize = sizes[Math.floor(sizes.length / 2)].label;
    }
    const sizeSig = sizes.map(z => z.label).join("|") + "/" + this._skirmishSelectedSize;
    if (sizeSig !== this._skirmishSizesSig) {
      this._skirmishSizesSig = sizeSig;
      this._skirmishSizesEl.innerHTML = sizes.map(z => `
        <button class="skirmish-chip ${z.label === this._skirmishSelectedSize ? "active" : ""}" data-size="${z.label}">${z.label.toUpperCase()}</button>
      `).join("");
      for (const btn of this._skirmishSizesEl.querySelectorAll(".skirmish-chip")) {
        this._addListener(btn, "click", () => {
          this._skirmishSelectedSize = btn.dataset.size;
          this._skirmishSizesSig = null;
          this._syncSkirmishConfig(s);
        });
      }
    }
    // Your faction — read from menuState.factions + factionMeta.
    const factions = (s && s.factions) || [];
    if (factions.length > 0 && !this._skirmishSelectedRace) {
      this._skirmishSelectedRace = factions[0];
    }
    const factSig = factions.join("|") + "/" + this._skirmishSelectedRace;
    if (factSig !== this._skirmishRacesSig) {
      this._skirmishRacesSig = factSig;
      const labelOf = (f) => (s.races && s.races[f] && s.races[f].name) || (f || "").toUpperCase();
      this._skirmishRacesEl.innerHTML = factions.map(f => `
        <button class="skirmish-chip ${f === this._skirmishSelectedRace ? "active" : ""}" data-race="${f}">${labelOf(f).toUpperCase()}</button>
      `).join("");
      for (const btn of this._skirmishRacesEl.querySelectorAll(".skirmish-chip")) {
        this._addListener(btn, "click", () => {
          this._skirmishSelectedRace = btn.dataset.race;
          this._skirmishRacesSig = null;
          this._syncSkirmishConfig(s);
        });
      }
    }
    // Opponent — Random + each faction.
    const oppSig = factions.join("|") + "/" + this._skirmishSelectedOpponent;
    if (oppSig !== this._skirmishOpponentsSig) {
      this._skirmishOpponentsSig = oppSig;
      const opps = ["random", ...factions];
      this._skirmishOpponentsEl.innerHTML = opps.map(f => `
        <button class="skirmish-chip ${f === this._skirmishSelectedOpponent ? "active" : ""}" data-opp="${f}">${f.toUpperCase()}</button>
      `).join("");
      for (const btn of this._skirmishOpponentsEl.querySelectorAll(".skirmish-chip")) {
        this._addListener(btn, "click", () => {
          this._skirmishSelectedOpponent = btn.dataset.opp;
          this._skirmishOpponentsSig = null;
          this._syncSkirmishConfig(s);
        });
      }
    }
    this._updateSkirmishFleetSlider();
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

  // ---- Memorial screen ----------------------------------------------------
  // Title-screen view that lists the player's completed Frontier
  // careers from meta.memorial. Each entry shows rank + callsign + a
  // one-line epitaph; the list grows up to 10 entries (oldest entries
  // shift out as new wins are recorded — see recordRunEnd).

  _buildMemorial(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-memorial";
    screen.dataset.screen = "memorial";

    const back = document.createElement("button");
    back.className = "menu-back-btn";
    back.id = "memorial-back-btn";
    back.textContent = "← BACK";
    this._addListener(back, "click", () => {
      if (this._callbacks.onMemorialBack) this._callbacks.onMemorialBack();
    });
    screen.appendChild(back);

    const header = document.createElement("header");
    header.className = "menu-title";
    header.innerHTML = `
      <h1>MEMORIAL</h1>
      <div class="menu-title-accent"></div>
      <p class="menu-subtitle">FRONTIER SERVICE · CAREER ROLL</p>
    `;
    screen.appendChild(header);

    const list = document.createElement("div");
    list.className = "memorial-list";
    list.id = "memorial-list";
    screen.appendChild(list);

    root.appendChild(screen);
    this._screens.memorial = screen;
    this._memorialList = list;
    this._memorialSig = null;
  }

  // ---- Shipyard (Design-Your-Own-Ship) -----------------------------------
  // Two-pane layout:
  //   Overview — ship name + hull + slot list + REPORT FOR DUTY (returns to
  //              home, having committed the design). Tap a slot row to enter
  //              the category list.
  //   Category — list of components for that slot kind, with owned / buyable /
  //              locked states. Tap to equip or buy.
  _buildShipyard(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-shipyard";
    screen.dataset.screen = "shipyard";
    screen.innerHTML = `
      <header class="shipyard-header">
        <button class="shipyard-back" id="shipyard-back-btn" title="Back">←</button>
        <h2>SHIPYARD</h2>
        <div class="shipyard-balance">
          <span class="shipyard-balance-value" id="shipyard-credits">0</span>
          <span class="shipyard-balance-unit">cr</span>
        </div>
      </header>
      <div class="shipyard-body" id="shipyard-body">
        <!-- OVERVIEW PANE -->
        <section class="shipyard-pane shipyard-pane-overview active" id="shipyard-pane-overview">
          <article class="shipyard-ship-card">
            <div class="shipyard-ship-eyebrow">YOUR SHIP</div>
            <div class="shipyard-ship-name-row">
              <input class="shipyard-ship-name-input" id="shipyard-ship-name" maxlength="40" placeholder="ISS Spectre" />
            </div>
            <div class="shipyard-ship-meta">
              <span class="shipyard-ship-hull-label" id="shipyard-ship-hull">FIGHTER</span>
              <span class="shipyard-ship-divider">·</span>
              <span class="shipyard-ship-stats" id="shipyard-ship-stats">HP — / Shield — / Spd —</span>
            </div>
          </article>

          <!-- Ship preview — blueprint-schematic SVG + per-slot clickable
               callout markers. Renderer reads menuState.shipyard.preview. -->
          <article class="shipyard-preview" id="shipyard-preview">
            <div class="preview-hint"><span class="preview-hint-doc">SCHEMATIC</span> TAP A NODE TO REVISE</div>
            <div class="preview-stage" id="shipyard-preview-stage"></div>
            <ol class="preview-legend" id="shipyard-preview-legend"></ol>
          </article>

          <div class="shipyard-section-title">HULL</div>
          <div class="shipyard-hull-row" id="shipyard-hull-row"></div>

          <div class="shipyard-section-title">MODULES</div>
          <div class="shipyard-slot-list" id="shipyard-slot-list"></div>

          <div class="shipyard-section-title">PAINT</div>
          <div class="shipyard-paint-row">
            <label class="shipyard-paint-swatch">
              <span class="paint-label">Primary</span>
              <input type="color" id="shipyard-paint-primary" value="#5cf">
            </label>
            <label class="shipyard-paint-swatch">
              <span class="paint-label">Trim</span>
              <input type="color" id="shipyard-paint-trim" value="#ff8">
            </label>
            <button class="shipyard-paint-reset" id="shipyard-paint-reset" title="Reset to stock colors">RESET</button>
          </div>

          <footer class="shipyard-footer">
            <button class="shipyard-deploy-btn" id="shipyard-deploy-btn">SAVE &amp; CLOSE</button>
          </footer>
        </section>

        <!-- CATEGORY PANE -->
        <section class="shipyard-pane shipyard-pane-category" id="shipyard-pane-category">
          <div class="shipyard-cat-header">
            <button class="shipyard-cat-back" id="shipyard-cat-back">←</button>
            <h3 id="shipyard-cat-title">SLOT</h3>
          </div>
          <div class="shipyard-cat-list" id="shipyard-cat-list"></div>
        </section>
      </div>
    `;
    root.appendChild(screen);
    this._screens.shipyard = screen;

    // Cache refs.
    this._shipyardCredits = screen.querySelector("#shipyard-credits");
    this._shipyardShipName = screen.querySelector("#shipyard-ship-name");
    this._shipyardShipHull = screen.querySelector("#shipyard-ship-hull");
    this._shipyardShipStats = screen.querySelector("#shipyard-ship-stats");
    this._shipyardHullRow = screen.querySelector("#shipyard-hull-row");
    this._shipyardSlotList = screen.querySelector("#shipyard-slot-list");
    this._shipyardCatList = screen.querySelector("#shipyard-cat-list");
    this._shipyardCatTitle = screen.querySelector("#shipyard-cat-title");
    this._shipyardPaneOverview = screen.querySelector("#shipyard-pane-overview");
    this._shipyardPaneCategory = screen.querySelector("#shipyard-pane-category");
    this._shipyardPreviewStage = screen.querySelector("#shipyard-preview-stage");
    this._shipyardPreviewLegend = screen.querySelector("#shipyard-preview-legend");
    this._shipyardSig = null;
    this._shipyardPreviewSig = null;  // separate sig so hotspots re-render on hull change
    this._shipyardActiveSlot = null;  // which slot's category is open

    // Wire static handlers.
    this._addListener(screen.querySelector("#shipyard-back-btn"), "click", () => {
      if (this._callbacks.onShipyardBack) this._callbacks.onShipyardBack();
    });
    this._addListener(screen.querySelector("#shipyard-deploy-btn"), "click", () => {
      if (this._callbacks.onShipyardBack) this._callbacks.onShipyardBack();
    });
    this._addListener(screen.querySelector("#shipyard-cat-back"), "click", () => {
      this._shipyardActiveSlot = null;
      this._shipyardPaneOverview.classList.add("active");
      this._shipyardPaneCategory.classList.remove("active");
    });
    this._addListener(this._shipyardShipName, "change", () => {
      const newName = this._shipyardShipName.value.trim();
      if (this._callbacks.onShipyardRename) this._callbacks.onShipyardRename(newName);
    });
    // Paint inputs — emit on change. "input" fires every drag tick of
    // the native picker; use it so the preview tints update live.
    this._shipyardPaintPrimary = screen.querySelector("#shipyard-paint-primary");
    this._shipyardPaintTrim    = screen.querySelector("#shipyard-paint-trim");
    this._shipyardPaintReset   = screen.querySelector("#shipyard-paint-reset");
    const emitPaint = () => {
      if (this._callbacks.onShipyardPaint) {
        this._callbacks.onShipyardPaint(
          this._shipyardPaintPrimary.value || null,
          this._shipyardPaintTrim.value    || null,
        );
      }
    };
    this._addListener(this._shipyardPaintPrimary, "input", emitPaint);
    this._addListener(this._shipyardPaintPrimary, "change", emitPaint);
    this._addListener(this._shipyardPaintTrim, "input", emitPaint);
    this._addListener(this._shipyardPaintTrim, "change", emitPaint);
    this._addListener(this._shipyardPaintReset, "click", () => {
      if (this._callbacks.onShipyardPaint) this._callbacks.onShipyardPaint(null, null);
    });
  }

  _syncShipyard(s) {
    if (!this._shipyardCredits || !s || !s.shipyard) return;
    const sy = s.shipyard;
    const sig = JSON.stringify({
      credits: sy.credits,
      hull: sy.hullId,
      modules: sy.modules,
      ownedHulls: sy.ownedHulls,
      ownedComps: sy.ownedComponents,
      slot: this._shipyardActiveSlot,
    });
    if (sig === this._shipyardSig) return;
    this._shipyardSig = sig;

    this._shipyardCredits.textContent = String(sy.credits || 0);
    this._shipyardShipHull.textContent = (sy.hullLabel || "FIGHTER").toUpperCase();
    if (document.activeElement !== this._shipyardShipName) {
      this._shipyardShipName.value = sy.shipName || "";
    }
    // Paint inputs — only push from state when not actively being
    // edited (otherwise the picker UI jumps under the user's finger).
    if (this._shipyardPaintPrimary && document.activeElement !== this._shipyardPaintPrimary) {
      this._shipyardPaintPrimary.value = sy.paintPrimary || "#5cf";
    }
    if (this._shipyardPaintTrim && document.activeElement !== this._shipyardPaintTrim) {
      this._shipyardPaintTrim.value = sy.paintTrim || "#ff8";
    }
    if (sy.stats) {
      let statLine = `HP ${sy.stats.hp || "—"}  ·  SHD ${sy.stats.shield || "—"}  ·  SPD ${sy.stats.maxSpeed || "—"}`;
      if (sy.stats.torpedoes) {
        const t = sy.stats.torpedoes;
        statLine += `  ·  TORP ${t.count}× ${t.damage}dmg`;
      }
      if (sy.stats.carrierPods) {
        const p = sy.stats.carrierPods;
        statLine += `  ·  PODS ${p.count}× ${p.damage}dmg`;
      }
      this._shipyardShipStats.textContent = statLine;
    }

    // Hull row — tappable cards per hull tier.
    if (sy.hulls) {
      this._shipyardHullRow.innerHTML = "";
      for (const h of sy.hulls) {
        const card = document.createElement("button");
        card.className = "shipyard-hull-card";
        if (h.equipped) card.classList.add("equipped");
        else if (h.owned) card.classList.add("owned");
        else if (h.canBuy) card.classList.add("buyable");
        else card.classList.add("locked");
        const tag = h.equipped ? "EQUIPPED" : h.owned ? "OWNED" : h.canBuy ? `${h.cost} cr` : `${h.cost} cr`;
        card.innerHTML = `
          <div class="hull-card-name">${h.label}</div>
          <div class="hull-card-tag">${tag}</div>
        `;
        this._addListener(card, "click", () => {
          if (h.equipped) return;
          if (h.owned) {
            if (this._callbacks.onShipyardSetHull) this._callbacks.onShipyardSetHull(h.id);
          } else if (h.canBuy) {
            if (this._callbacks.onShipyardBuyHull) this._callbacks.onShipyardBuyHull(h.id);
          }
        });
        this._shipyardHullRow.appendChild(card);
      }
    }

    // Slot list for the current hull.
    if (sy.slots) {
      this._shipyardSlotList.innerHTML = "";
      for (const slot of sy.slots) {
        const row = document.createElement("button");
        row.className = "shipyard-slot-row";
        row.innerHTML = `
          <span class="slot-row-kind">${slot.kindLabel}</span>
          <span class="slot-row-comp">${slot.equippedName || "—"}</span>
          <span class="slot-row-chev">›</span>
        `;
        this._addListener(row, "click", () => {
          this._openShipyardCategory(slot.id);
        });
        this._shipyardSlotList.appendChild(row);
      }
    }

    // Ship preview — clickable SVG hull + per-slot hotspot dots.
    // Rebuilds when the hull klass changes or any equipped module
    // swaps (sig captures both).
    if (this._shipyardPreviewStage && sy.preview) {
      const psig = `${sy.hullId}|${JSON.stringify(sy.modules)}|${sy.paintPrimary}|${sy.paintTrim}`;
      if (psig !== this._shipyardPreviewSig) {
        this._shipyardPreviewSig = psig;
        this._renderShipyardPreview(sy);
      }
    }

    // If a category pane is open, refresh its contents.
    if (this._shipyardActiveSlot) {
      this._renderShipyardCategory(sy);
    }
  }

  // Render the SVG ship silhouette + clickable module hotspots in the
  // overview pane. Hull polygon is in unit space; we map to a 280x180
  // viewBox so the silhouette fills the preview frame.
  _renderShipyardPreview(sy) {
    const stage = this._shipyardPreviewStage;
    if (!stage || !sy.preview) return;
    const poly = sy.preview.hullPoly;
    if (!poly || poly.length < 3) {
      stage.innerHTML = '';
      return;
    }
    // Blueprint-schematic render. viewBox is 280x180; hull spans [-1, 1]
    // in both axes. Map to a centered silhouette with room for the slot
    // callout markers that sit just outside the hull (e.g. PD at y=-0.6).
    const VBW = 280, VBH = 180;
    const SCALE = 86;                // hull radius in viewBox units
    const CX = VBW / 2, CY = VBH / 2;
    const toX = (ux) => +(CX + ux * SCALE).toFixed(1);
    const toY = (uy) => +(CY + uy * SCALE).toFixed(1);
    const mapped = poly.map((p) => [toX(p[0]), toY(p[1])]);
    const pts = mapped.map((p) => `${p[0]},${p[1]}`).join(" ");

    // Hull bounding box (viewBox units) — anchors the dimension callouts.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of mapped) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }

    // The "drawn in" line color follows the trim paint so the player's
    // livery still reads; the primary paint becomes a faint hull wash.
    const trim = sy.paintTrim || "#7fdfff";
    const primary = sy.paintPrimary || "#1c3a5c";

    // Construction ghost outline — a hair outside the hull, dashed, for
    // the classic double-line draughting feel.
    const ghost = mapped.map(([x, y]) => {
      const dx = x - CX, dy = y - CY;
      const d = Math.hypot(dx, dy) || 1;
      return `${(x + (dx / d) * 3).toFixed(1)},${(y + (dy / d) * 3).toFixed(1)}`;
    }).join(" ");

    // Frame corner registration ticks.
    const fx0 = 8, fy0 = 8, fx1 = VBW - 8, fy1 = VBH - 8, T = 11;
    const corner = (x, y, sx, sy2) =>
      `<path class="bp-corner" d="M${x} ${y + sy2 * T} V${y} H${x + sx * T}"/>`;
    const corners =
      corner(fx0, fy0, 1, 1) + corner(fx1, fy0, -1, 1) +
      corner(fx0, fy1, 1, -1) + corner(fx1, fy1, -1, -1);

    // Vertical "station" reference lines, clipped to the hull — a lines-
    // plan texture. Four evenly spaced cuts across the length.
    let stations = "";
    for (let i = 1; i <= 4; i++) {
      const sxp = (minX + (maxX - minX) * (i / 5)).toFixed(1);
      stations += `<line x1="${sxp}" y1="${minY - 4}" x2="${sxp}" y2="${maxY + 4}"/>`;
    }

    // Vertex crosshair ticks — every hull node gets a tiny registration +.
    const ticks = mapped.map(([x, y]) =>
      `<path class="bp-tick" d="M${(x - 2.2).toFixed(1)} ${y} h4.4 M${x} ${(y - 2.2).toFixed(1)} v4.4"/>`,
    ).join("");

    // Dimension callouts — LOA along the bottom, BEAM up the right side.
    // The figures are derived from the normalised hull extent (schematic
    // "units"), enough to read as a real draughting annotation.
    const loaU = ((maxX - minX) / SCALE * 12).toFixed(1);
    const beamU = ((maxY - minY) / SCALE * 12).toFixed(1);
    const dimY = Math.min(VBH - 12, maxY + 16);
    const dimX = Math.min(VBW - 12, maxX + 16);
    const dims = `
      <g class="bp-dim">
        <line x1="${minX}" y1="${dimY}" x2="${maxX}" y2="${dimY}"/>
        <path d="M${minX} ${dimY - 3} v6 M${maxX} ${dimY - 3} v6"/>
        <text x="${((minX + maxX) / 2).toFixed(1)}" y="${dimY - 4}" text-anchor="middle">LOA ${loaU}u</text>
        <line x1="${dimX}" y1="${minY}" x2="${dimX}" y2="${maxY}"/>
        <path d="M${dimX - 3} ${minY} h6 M${dimX - 3} ${maxY} h6"/>
        <text x="${dimX + 4}" y="${((minY + maxY) / 2).toFixed(1)}" transform="rotate(90 ${dimX + 4} ${((minY + maxY) / 2).toFixed(1)})" text-anchor="middle">BEAM ${beamU}u</text>
      </g>`;

    // Title block (bottom-left) — class designation + drawing meta.
    const hullClass = (sy.hullLabel || "FIGHTER").toUpperCase();
    const dno = hullClass.slice(0, 3) + "-" + String((sy.stats && sy.stats.hp) || 1).padStart(3, "0");
    const titleBlock = `
      <g class="bp-titleblock">
        <rect x="12" y="${VBH - 40}" width="116" height="30" rx="1.5"/>
        <line x1="12" y1="${VBH - 30}" x2="128" y2="${VBH - 30}"/>
        <text class="bp-tb-main" x="17" y="${VBH - 32}">${hullClass}-CLASS HULL</text>
        <text class="bp-tb-sub" x="17" y="${VBH - 22}">DWG ${dno} · SCALE 1:1</text>
        <text class="bp-tb-sub" x="17" y="${VBH - 14}">APHELION FLEET WORKS</text>
      </g>`;

    // Build hotspot HTML. Each hotspot sits at the REAL module position
    // so the schematic matches the in-game mounts. "primary" hotspots
    // (one per design slot) get a numbered callout balloon keyed to the
    // legend; extra physical mounts of the same slot — the PD turret ring,
    // a second engine, the broadside pair — render as small unnumbered
    // markers so they show on the hull without exploding the legend.
    let num = 0;
    const hotspotsHtml = sy.preview.hotspots.map((h) => {
      const px = ((toX(h.x) / VBW) * 100).toFixed(1);
      const py = ((toY(h.y) / VBH) * 100).toFixed(1);
      // Fixed built-in modules (shield generators, torpedo tubes) are
      // non-clickable info markers — they're not swappable components.
      if (h.fixed) {
        return `<span class="preview-hotspot preview-fixed hot-${h.category}"
                  style="left:${px}%;top:${py}%;" title="${h.equippedName}"></span>`;
      }
      if (h.primary) {
        num += 1;
        return `
        <button class="preview-hotspot hot-${h.category}" data-slot="${h.slot}"
                style="left:${px}%;top:${py}%;" title="${h.equippedName}">
          <span class="hot-num">${num}</span>
        </button>`;
      }
      return `
        <button class="preview-hotspot preview-marker hot-${h.category}" data-slot="${h.slot}"
                style="left:${px}%;top:${py}%;" title="${h.equippedName}"></button>`;
    }).join("");

    stage.innerHTML = `
      <svg class="preview-svg blueprint-svg" viewBox="0 0 ${VBW} ${VBH}" preserveAspectRatio="xMidYMid meet">
        <defs>
          <pattern id="bpFine" width="14" height="14" patternUnits="userSpaceOnUse">
            <path d="M14 0H0V14" fill="none" stroke="#17456e" stroke-width="0.5"/>
          </pattern>
          <pattern id="bpMajor" width="70" height="70" patternUnits="userSpaceOnUse">
            <path d="M70 0H0V70" fill="none" stroke="#235f92" stroke-width="0.8"/>
          </pattern>
          <clipPath id="bpHullClip"><polygon points="${pts}"/></clipPath>
        </defs>
        <rect class="bp-bg" width="${VBW}" height="${VBH}"/>
        <rect width="${VBW}" height="${VBH}" fill="url(#bpFine)"/>
        <rect width="${VBW}" height="${VBH}" fill="url(#bpMajor)"/>
        <rect class="bp-frame" x="8" y="8" width="${VBW - 16}" height="${VBH - 16}"/>
        ${corners}
        <line class="bp-axis" x1="12" y1="${CY}" x2="${VBW - 12}" y2="${CY}"/>
        <line class="bp-axis" x1="${CX}" y1="12" x2="${CX}" y2="${VBH - 12}"/>
        <g class="bp-stations" clip-path="url(#bpHullClip)">${stations}</g>
        <polygon class="bp-hull-ghost" points="${ghost}"/>
        <polygon class="bp-hull" points="${pts}" style="stroke:${trim};fill:${primary};fill-opacity:0.12"/>
        ${ticks}
        ${dims}
        ${titleBlock}
      </svg>
      ${hotspotsHtml}
    `;

    // Wire hotspot clicks — open the slot's picker.
    for (const dot of stage.querySelectorAll(".preview-hotspot")) {
      const slot = dot.dataset.slot;
      this._addListener(dot, "click", (e) => {
        e.preventDefault();
        this._openShipyardCategory(slot);
      });
    }

    // Parts legend — the numbered key beneath the plate. One row per
    // PRIMARY hotspot. Fixed built-in modules get an info-only row with
    // no number and a "FIXED" tag instead of a slot picker.
    if (this._shipyardPreviewLegend) {
      let lnum = 0;
      this._shipyardPreviewLegend.innerHTML = sy.preview.hotspots
        .filter((h) => h.primary)
        .map((h) => {
          if (h.fixed) {
            return `
        <li class="preview-leg-row preview-leg-fixed hot-${h.category}" data-slot="">
          <span class="leg-num">—</span>
          <span class="leg-cat">${(h.category || "").toUpperCase().replace("-", " ")}</span>
          <span class="leg-name">${h.equippedName || "—"}</span>
        </li>`;
          }
          lnum += 1;
          return `
        <li class="preview-leg-row hot-${h.category}" data-slot="${h.slot}">
          <span class="leg-num">${lnum}</span>
          <span class="leg-cat">${(h.category || "").toUpperCase()}</span>
          <span class="leg-name">${h.equippedName || "—"}</span>
        </li>`;
        }).join("");
      for (const row of this._shipyardPreviewLegend.querySelectorAll(".preview-leg-row:not(.preview-leg-fixed)")) {
        const slot = row.dataset.slot;
        this._addListener(row, "click", (e) => {
          e.preventDefault();
          this._openShipyardCategory(slot);
        });
      }
    }
  }

  _openShipyardCategory(slotId) {
    this._shipyardActiveSlot = slotId;
    this._shipyardPaneOverview.classList.remove("active");
    this._shipyardPaneCategory.classList.add("active");
    // Re-render with current state.
    if (this._lastMenuState) this._renderShipyardCategory(this._lastMenuState.shipyard);
    // Force a re-sync next tick.
    this._shipyardSig = null;
  }

  _renderShipyardCategory(sy) {
    if (!sy || !sy.slots) return;
    const slot = sy.slots.find((sl) => sl.id === this._shipyardActiveSlot);
    if (!slot) return;
    this._shipyardCatTitle.textContent = slot.kindLabel.toUpperCase();
    this._shipyardCatList.innerHTML = "";
    for (const comp of slot.options) {
      const item = document.createElement("button");
      item.className = "shipyard-cat-item";
      if (comp.equipped) item.classList.add("equipped");
      else if (comp.owned) item.classList.add("owned");
      else if (comp.canBuy) item.classList.add("buyable");
      else item.classList.add("locked");
      const tag = comp.equipped ? "EQUIPPED"
                : comp.owned ? "OWNED · TAP TO EQUIP"
                : comp.canBuy ? `${comp.cost} cr · BUY`
                : `${comp.cost} cr · LOCKED`;
      // Stat-delta chips vs the currently equipped component. Empty
      // when this IS the equipped component or when the swap produces
      // no meaningful change. Tinted green/red by direction.
      let deltaHtml = "";
      if (Array.isArray(comp.deltas) && comp.deltas.length > 0) {
        deltaHtml = `<div class="cat-item-deltas">${comp.deltas.map(
          (d) => `<span class="cat-delta cat-delta-${d.direction}">${d.text} <span class="cat-delta-label">${d.label}</span></span>`,
        ).join("")}</div>`;
      }
      item.innerHTML = `
        <div class="cat-item-row">
          <div class="cat-item-name">${comp.name}</div>
          <div class="cat-item-tag">${tag}</div>
        </div>
        <div class="cat-item-blurb">${comp.blurb}</div>
        ${deltaHtml}
      `;
      this._addListener(item, "click", () => {
        if (comp.equipped) return;
        if (comp.owned) {
          if (this._callbacks.onShipyardEquip) this._callbacks.onShipyardEquip(slot.id, comp.id);
        } else if (comp.canBuy) {
          if (this._callbacks.onShipyardBuyComponent) this._callbacks.onShipyardBuyComponent(slot.id, comp.id);
        }
      });
      this._shipyardCatList.appendChild(item);
    }
  }

  // ---- Main Menu (PLAY screen) --------------------------------------------
  // Mode chips drive what extra sections (map size / faction / fleet size)
  // appear below — Frontier and Custom hide everything because their
  // options live in the respective overlays.

  _buildMainMenu(root) {
    // Step-carousel layout: one focused decision per step rather than
    // the old single-screen stack of four chip rows. Steps:
    //   0. GAME MODE          (always)
    //   1. MAP SIZE           (skipped for Frontier; honored for the rest)
    //   2. FACTION            (skipped for Frontier + Custom)
    //   3. FLEET SIZE         (skipped for Frontier + Custom)
    //   4. DEPLOY review      (always)
    // Steps that are skipped for the active mode just slide past on Next
    // — the dot indicator collapses to only show visible steps.
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-main carousel-panel";
    screen.dataset.screen = "main";

    // BACK button — returns to home screen.
    const back = document.createElement("button");
    back.className = "menu-back-btn";
    back.id = "main-back-btn";
    back.textContent = "← HOME";
    this._addListener(back, "click", () => {
      if (this._callbacks.onMainBack) this._callbacks.onMainBack();
    });
    screen.appendChild(back);

    // Title + step indicator.
    const header = document.createElement("header");
    header.className = "menu-title menu-title-play carousel-header";
    header.innerHTML = `
      <div class="carousel-step-label" id="main-step-label">STEP 1 / 5</div>
      <h1 id="main-step-title">PICK A MODE</h1>
      <p class="carousel-subtitle" id="main-step-sub">Choose how you want to play.</p>
    `;
    screen.appendChild(header);

    const carouselBody = document.createElement("div");
    carouselBody.className = "carousel-body main-carousel-body";
    screen.appendChild(carouselBody);

    // One step per chip section. Each step is a `.carousel-step` div
    // wrapping a single `.menu-section` so the slide animation runs
    // around the section without disturbing chip layout.
    const sections = [
      { key: "mode", label: "GAME MODE", chipId: "mode-chips" },
      { key: "size", label: "MAP SIZE", chipId: "size-chips" },
      { key: "race", label: "FACTION", chipId: "race-chips" },
      { key: "fleet", label: "FLEET SIZE", chipId: "fleet-chips" },
    ];

    this._sectionEls = {};
    this._mainStepEls = [];
    sections.forEach((sec, i) => {
      const step = document.createElement("section");
      step.className = "carousel-step";
      step.dataset.step = String(i);
      const section = document.createElement("div");
      section.className = "menu-section";
      section.dataset.section = sec.key;
      section.innerHTML = `
        <div class="chip-row" id="${sec.chipId}"></div>
      `;
      step.appendChild(section);
      carouselBody.appendChild(step);
      this._chipContainers[sec.key] = section.querySelector(".chip-row");
      this._chips[sec.key] = [];
      this._sectionEls[sec.key] = section;
      this._mainStepEls.push(step);
    });

    // Step 4: DEPLOY review — chosen settings summary + the existing
    // primary action button (handles DEPLOY / CONFIGURE / RESUME etc.).
    const reviewStep = document.createElement("section");
    reviewStep.className = "carousel-step";
    reviewStep.dataset.step = "4";
    reviewStep.innerHTML = `
      <div class="main-review" id="main-review"></div>
    `;
    carouselBody.appendChild(reviewStep);
    this._mainStepEls.push(reviewStep);
    this._mainReviewEl = reviewStep.querySelector("#main-review");

    // Frontier status line — shown on the review step when the active
    // mode is Frontier so the player knows whether they're resuming or
    // starting fresh.
    this._frontierStatus = document.createElement("div");
    this._frontierStatus.className = "frontier-status";
    this._frontierStatus.id = "frontier-status";
    reviewStep.appendChild(this._frontierStatus);

    // START button lives in the review step.
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
    reviewStep.appendChild(this._startBtn);

    // Carousel nav: BACK / dots / NEXT. The Next button doubles as the
    // primary action on the review step (DEPLOY) but we keep the START
    // button visible there as well so the existing "CONFIGURE..." /
    // "RESUME CAMPAIGN" / etc. labels stay reachable. Next is hidden on
    // the review step to keep one obvious primary action.
    const nav = document.createElement("nav");
    nav.className = "carousel-nav";
    nav.innerHTML = `
      <button class="menu-btn carousel-btn" id="main-prev">← BACK</button>
      <div class="carousel-dots" id="main-dots"></div>
      <button class="menu-btn carousel-btn carousel-next" id="main-next">NEXT →</button>
    `;
    screen.appendChild(nav);

    this._mainStep = 0;
    this._mainPrevBtn = nav.querySelector("#main-prev");
    this._mainNextBtn = nav.querySelector("#main-next");
    this._mainDotsEl = nav.querySelector("#main-dots");
    this._mainStepLabel = header.querySelector("#main-step-label");
    this._mainStepTitle = header.querySelector("#main-step-title");
    this._mainStepSub = header.querySelector("#main-step-sub");

    this._addListener(this._mainPrevBtn, "click", () => this._stepMain(-1));
    this._addListener(this._mainNextBtn, "click", () => this._stepMain(+1));

    root.appendChild(screen);
    this._screens.main = screen;
    // Initialise step chrome (label, dots, active step) so the carousel
    // reads correctly on first render before the first sync() call.
    this._gotoMainStep(0);
  }

  // Resolve the list of visible step indices for the current selected
  // mode. Frontier and Custom skip their irrelevant configuration
  // sections — they own their own setup (Frontier: run state, Custom:
  // CONFIGURE overlay).
  _visibleMainSteps() {
    const mode = this._lastSelectedMode || "open";
    // Step ids: 0=mode, 1=size, 2=race, 3=fleet, 4=review.
    if (mode === "roguelite") return [0, 4];
    if (mode === "custom")    return [0, 1, 4];
    return [0, 1, 2, 3, 4];
  }

  // Move the visible step pointer by ±1 along the visible-steps list.
  _stepMain(direction) {
    const visible = this._visibleMainSteps();
    const here = visible.indexOf(this._mainStep);
    let nextPos = (here < 0 ? 0 : here) + direction;
    if (nextPos < 0) nextPos = 0;
    if (nextPos >= visible.length) nextPos = visible.length - 1;
    this._gotoMainStep(visible[nextPos]);
  }

  _gotoMainStep(idx) {
    const visible = this._visibleMainSteps();
    if (!visible.includes(idx)) idx = visible[0];
    this._mainStep = idx;
    if (this._mainStepEls) {
      for (const el of this._mainStepEls) {
        const stepIdx = parseInt(el.dataset.step, 10);
        el.classList.toggle("active", stepIdx === idx);
      }
    }
    // Rebuild dots to match the count of visible steps for the active
    // mode (so Frontier shows 2 dots, Open shows 5).
    if (this._mainDotsEl) {
      this._mainDotsEl.innerHTML = "";
      const here = visible.indexOf(idx);
      for (let i = 0; i < visible.length; i++) {
        const d = document.createElement("span");
        d.className = "carousel-dot" + (i === here ? " active" : "");
        this._mainDotsEl.appendChild(d);
      }
    }
    const here = visible.indexOf(idx);
    const stepNum = here + 1;
    const total = visible.length;
    if (this._mainStepLabel) this._mainStepLabel.textContent = `STEP ${stepNum} / ${total}`;
    const STEP_TITLES = {
      0: { title: "PICK A MODE",   sub: "Choose how you want to play." },
      1: { title: "MAP SIZE",      sub: "Smaller maps = tighter brawls; larger = breathing room." },
      2: { title: "FACTION",       sub: "Pick the race you'll deploy with." },
      3: { title: "FLEET SIZE",    sub: "Skirmish to full clash." },
      4: { title: "DEPLOY",        sub: "Confirm and launch." },
    };
    const info = STEP_TITLES[idx] || { title: "", sub: "" };
    if (this._mainStepTitle) this._mainStepTitle.textContent = info.title;
    if (this._mainStepSub) this._mainStepSub.textContent = info.sub;
    const isFirst = here === 0;
    const isLast = here === visible.length - 1;
    if (this._mainPrevBtn) this._mainPrevBtn.style.visibility = isFirst ? "hidden" : "";
    if (this._mainNextBtn) this._mainNextBtn.style.display = isLast ? "none" : "";
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
    // Icon + volume slider per channel. Music and SFX have fully
    // independent levels (0–100%); dragging to 0 silences that channel.
    screen.innerHTML = `
      <div class="overlay-panel">
        <div class="panel-accent-rule"></div>
        <h2>SETTINGS</h2>
        <div class="settings-rows">
          <div class="settings-slider-row" data-setting="music">
            <span class="toggle-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22"><path d="M9 18 V6 L20 4 V16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="7" cy="18" r="2.4" fill="currentColor"/><circle cx="18" cy="16" r="2.4" fill="currentColor"/></svg>
            </span>
            <span class="toggle-label">MUSIC</span>
            <input type="range" class="settings-slider" id="settings-music-vol" min="0" max="100" step="1" value="60" aria-label="Music volume">
            <span class="settings-vol-value" id="settings-music-val">60%</span>
          </div>
          <div class="settings-slider-row" data-setting="sfx">
            <span class="toggle-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22"><polygon points="4,10 9,10 14,5 14,19 9,14 4,14" fill="currentColor" fill-opacity="0.55" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M17 8.5 Q19.5 12 17 15.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M19.5 6 Q23 12 19.5 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            </span>
            <span class="toggle-label">SFX</span>
            <input type="range" class="settings-slider" id="settings-sfx-vol" min="0" max="100" step="1" value="80" aria-label="SFX volume">
            <span class="settings-vol-value" id="settings-sfx-val">80%</span>
          </div>
        </div>
        <p class="settings-hint">Drag to set volume &middot; P mutes music mid-match</p>
        <button class="overlay-close-btn" id="settings-close">CLOSE</button>
      </div>
    `;

    this._settingsMusicSlider = screen.querySelector("#settings-music-vol");
    this._settingsMusicVal = screen.querySelector("#settings-music-val");
    this._settingsSfxSlider = screen.querySelector("#settings-sfx-vol");
    this._settingsSfxVal = screen.querySelector("#settings-sfx-val");

    // Live volume on every input event; the % readout + muted styling
    // update locally so the row reacts instantly without waiting on sync.
    const wireSlider = (slider, valEl, cb) => {
      if (!slider) return;
      const row = slider.closest(".settings-slider-row");
      this._addListener(slider, "input", () => {
        const pct = Number(slider.value);
        if (valEl) valEl.textContent = pct + "%";
        slider.style.setProperty("--fill", pct + "%");
        if (row) row.classList.toggle("muted", pct === 0);
        cb(pct / 100);
      });
    };
    wireSlider(this._settingsMusicSlider, this._settingsMusicVal,
      (v) => { if (this._callbacks.onMusicVolume) this._callbacks.onMusicVolume(v); });
    wireSlider(this._settingsSfxSlider, this._settingsSfxVal,
      (v) => { if (this._callbacks.onSfxVolume) this._callbacks.onSfxVolume(v); });

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
    // Step-carousel layout: FRIENDLY → ENEMY → REVIEW.
    // Each step shows one focused decision so the player isn't hit with
    // both sides + per-faction sliders + grand totals on one screen.
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-custom";
    screen.dataset.screen = "custom";
    screen.innerHTML = `
      <div class="overlay-panel custom-panel carousel-panel">
        <div class="panel-accent-rule"></div>
        <header class="carousel-header">
          <div class="carousel-step-label" id="custom-step-label">STEP 1 / 3</div>
          <h2 id="custom-step-title">FRIENDLY FORCES</h2>
          <p class="carousel-subtitle" id="custom-step-sub">Pick faction and fleet for your side</p>
        </header>
        <div class="carousel-body" id="custom-carousel-body">
          <section class="carousel-step" data-step="0">
            <div class="custom-side" data-side="allied">
              <div class="custom-team-list" id="custom-allied-teams"></div>
              <button class="menu-btn custom-add-btn" id="custom-allied-add">+ ADD ALLY</button>
              <div class="custom-side-total" id="custom-allied-total">0 ships</div>
            </div>
          </section>
          <section class="carousel-step" data-step="1">
            <div class="custom-side" data-side="hostile">
              <div class="custom-team-list" id="custom-hostile-teams"></div>
              <button class="menu-btn custom-add-btn" id="custom-hostile-add">+ ADD ENEMY</button>
              <div class="custom-side-total" id="custom-hostile-total">0 ships</div>
            </div>
          </section>
          <section class="carousel-step" data-step="2">
            <div class="custom-review">
              <div class="custom-review-row" data-side="allied">
                <span class="custom-review-side">FRIENDLY</span>
                <span class="custom-review-list" id="custom-review-allied"></span>
                <span class="custom-review-total" id="custom-review-allied-total">0</span>
              </div>
              <div class="custom-review-row" data-side="hostile">
                <span class="custom-review-side">ENEMY</span>
                <span class="custom-review-list" id="custom-review-hostile"></span>
                <span class="custom-review-total" id="custom-review-hostile-total">0</span>
              </div>
              <div class="custom-totals" id="custom-grand-total"></div>
              <p class="custom-review-hint">Step back to tweak fleets, or launch when ready.</p>
            </div>
          </section>
        </div>
        <nav class="carousel-nav">
          <button class="menu-btn carousel-btn" id="custom-prev">← BACK</button>
          <div class="carousel-dots" id="custom-dots">
            <span class="carousel-dot active"></span>
            <span class="carousel-dot"></span>
            <span class="carousel-dot"></span>
          </div>
          <button class="menu-btn carousel-btn carousel-next" id="custom-next">NEXT →</button>
        </nav>
        <div class="custom-footer">
          <button class="menu-btn cancel-btn" id="custom-cancel">CANCEL</button>
        </div>
      </div>
    `;

    this._customStep = 0;
    this._customStepCount = 3;
    this._customStepEls = screen.querySelectorAll(".carousel-step");
    this._customStepLabel = screen.querySelector("#custom-step-label");
    this._customStepTitle = screen.querySelector("#custom-step-title");
    this._customStepSub = screen.querySelector("#custom-step-sub");
    this._customDots = screen.querySelectorAll("#custom-dots .carousel-dot");
    this._customPrevBtn = screen.querySelector("#custom-prev");
    this._customNextBtn = screen.querySelector("#custom-next");
    this._customAlliedTeamsEl = screen.querySelector("#custom-allied-teams");
    this._customHostileTeamsEl = screen.querySelector("#custom-hostile-teams");
    this._customAlliedAddBtn = screen.querySelector("#custom-allied-add");
    this._customHostileAddBtn = screen.querySelector("#custom-hostile-add");
    this._customAlliedTotal = screen.querySelector("#custom-allied-total");
    this._customHostileTotal = screen.querySelector("#custom-hostile-total");
    this._customGrandTotal = screen.querySelector("#custom-grand-total");
    this._customReviewAllied = screen.querySelector("#custom-review-allied");
    this._customReviewHostile = screen.querySelector("#custom-review-hostile");
    this._customReviewAlliedTotal = screen.querySelector("#custom-review-allied-total");
    this._customReviewHostileTotal = screen.querySelector("#custom-review-hostile-total");
    // Tracked team-block elements per side so _syncCustomMatch can do
    // incremental updates instead of rebuilding the DOM tree each frame.
    this._customTeamBlocks = { allied: [], hostile: [] };

    this._addListener(this._customAlliedAddBtn, "click", () => {
      if (this._callbacks.onCustomAddTeam) this._callbacks.onCustomAddTeam("allied");
    });
    this._addListener(this._customHostileAddBtn, "click", () => {
      if (this._callbacks.onCustomAddTeam) this._callbacks.onCustomAddTeam("hostile");
    });
    this._addListener(this._customPrevBtn, "click", () => this._gotoCustomStep(this._customStep - 1));
    this._addListener(this._customNextBtn, "click", () => {
      // On the final step the NEXT button doubles as DEPLOY — _gotoCustomStep
      // swaps its label when reaching the end. Fire onCustomStart in that case.
      if (this._customStep >= this._customStepCount - 1) {
        if (this._callbacks.onCustomStart) this._callbacks.onCustomStart();
      } else {
        this._gotoCustomStep(this._customStep + 1);
      }
    });
    this._addListener(screen.querySelector("#custom-cancel"), "click", () => {
      if (this._callbacks.onCustomClose) this._callbacks.onCustomClose();
    });

    root.appendChild(screen);
    this._screens.custom = screen;
    // Default visible step (overlay always opens on step 0).
    this._gotoCustomStep(0);
  }

  // Carousel step navigation for the Custom overlay. Updates the
  // visible step + chrome (label, dots, prev/next/start visibility).
  // Re-entering the overlay resets to step 0 — see showScreen.
  _gotoCustomStep(idx) {
    const last = this._customStepCount - 1;
    if (idx < 0) idx = 0;
    if (idx > last) idx = last;
    this._customStep = idx;
    if (this._customStepEls) {
      for (const el of this._customStepEls) {
        const stepIdx = parseInt(el.dataset.step, 10);
        el.classList.toggle("active", stepIdx === idx);
      }
    }
    if (this._customDots) {
      for (let i = 0; i < this._customDots.length; i++) {
        this._customDots[i].classList.toggle("active", i === idx);
      }
    }
    if (this._customStepLabel) {
      this._customStepLabel.textContent = `STEP ${idx + 1} / ${this._customStepCount}`;
    }
    const titles = ["FRIENDLY FORCES", "ENEMY FORCES", "REVIEW & LAUNCH"];
    const subs = [
      "Pick faction and fleet for your side",
      "Pick faction and fleet for the opposition",
      "Confirm the matchup, then deploy",
    ];
    if (this._customStepTitle) this._customStepTitle.textContent = titles[idx] || "";
    if (this._customStepSub) this._customStepSub.textContent = subs[idx] || "";
    // Prev hides on first step; Next becomes DEPLOY on the last.
    const isFirst = idx === 0;
    const isLast = idx === last;
    if (this._customPrevBtn) this._customPrevBtn.style.visibility = isFirst ? "hidden" : "";
    if (this._customNextBtn) {
      this._customNextBtn.textContent = isLast ? "DEPLOY" : "NEXT →";
      this._customNextBtn.classList.toggle("deploy-mode", isLast);
    }
  }

  // ---- Run Setup ----------------------------------------------------------

  _buildRunSetup(root) {
    // Tier 45 — mobile-first rebuild. Header strip with back chevron,
    // hero crest + recruit copy, callsign input as a sleek text field,
    // perk chips in a clean grid, big gold DEPLOY at the bottom.
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-runsetup runsetup-v2";
    screen.dataset.screen = "runSetup";
    screen.innerHTML = `
      <header class="runsetup-header">
        <button class="playhub-back" id="runsetup-cancel" title="Back">←</button>
        <h2>BEGIN CAREER</h2>
        <div class="playhub-spacer"></div>
      </header>
      <div class="runsetup-body">
        <section class="runsetup-hero">
          <div class="runsetup-crest">
            <div class="runsetup-crest-ring"></div>
            <div class="runsetup-crest-inner">★</div>
          </div>
          <div class="runsetup-hero-eyebrow">TERRAN FRONTIER SERVICE</div>
          <div class="runsetup-hero-title">PILOT OFFICER COMMISSION</div>
          <p class="runsetup-hero-body">
            Reaver raids are eating Terran convoys. The Hegemony is
            testing the border. The Service needs warm bodies in
            cockpits — you're the warmest one available.
          </p>
          <div class="runsetup-stakes">
            ONE CAREER · ONE DEFEAT ENDS IT
          </div>
        </section>

        <section class="runsetup-section">
          <div class="runsetup-section-title">CALLSIGN</div>
          <input type="text" id="runsetup-callsign" class="runsetup-callsign-field"
                 maxlength="12" placeholder="LEAVE BLANK FOR RANDOM" autocomplete="off" />
        </section>

        <section class="runsetup-section" id="runsetup-perk-section">
          <div class="runsetup-section-title">STARTER PERK</div>
          <div class="runsetup-perk-grid" id="runsetup-perk-chips"></div>
          <div class="runsetup-perk-desc" id="runsetup-perk-desc">No perk — earn one by surviving a career.</div>
        </section>
      </div>
      <div class="runsetup-footer">
        <button class="skirmish-deploy-btn" id="runsetup-begin">REPORT FOR DUTY</button>
      </div>
    `;

    // Legacy hook left intact: external code that called
    // _factionGrid.children.length will see zero. The new flow only
    // uses the begin button.
    this._factionGrid = null;
    this._runsetupCallsignInput = screen.querySelector("#runsetup-callsign");
    this._runsetupPerkChips = screen.querySelector("#runsetup-perk-chips");
    this._runsetupPerkDesc = screen.querySelector("#runsetup-perk-desc");
    // Selected perk for this career. `null` is the explicit "no perk"
    // option; that's also the default when meta.unlockedPerks is empty
    // (fresh saves, before the first run-completed unlock).
    this._runsetupSelectedPerk = null;
    this._addListener(screen.querySelector("#runsetup-cancel"), "click", () => {
      if (this._callbacks.onRunSetupCancel) this._callbacks.onRunSetupCancel();
    });
    this._addListener(screen.querySelector("#runsetup-begin"), "click", () => {
      const callsign = this._runsetupCallsignInput
        ? this._runsetupCallsignInput.value.trim().toUpperCase()
        : "";
      if (this._callbacks.onRunSetupSelect) {
        this._callbacks.onRunSetupSelect("terran", {
          callsign,
          perkKey: this._runsetupSelectedPerk,
        });
      }
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
        <div class="battle-banter" id="battle-banter"></div>
        <div class="battle-info" id="battle-info"></div>
        <div class="battle-doctrine" id="battle-doctrine">
          <div class="doctrine-label">FLEET DOCTRINE</div>
          <div class="doctrine-chips">
            <button class="doctrine-chip" data-doctrine="press">PRESS</button>
            <button class="doctrine-chip" data-doctrine="skirmish">SKIRMISH</button>
            <button class="doctrine-chip" data-doctrine="hold">HOLD</button>
          </div>
          <div class="doctrine-desc" id="doctrine-desc"></div>
        </div>
        <div class="battle-actions">
          <button class="menu-btn battle-btn" id="battle-fly">FLY INTO BATTLE</button>
          <button class="menu-btn battle-btn" id="battle-command">COMMAND FLEET</button>
        </div>
        <button class="menu-btn cancel-btn" id="battle-back">BACK TO MAP</button>
      </div>
    `;

    this._battleTitle = screen.querySelector("#battle-title");
    this._battleInfo = screen.querySelector("#battle-info");
    this._battleBanter = screen.querySelector("#battle-banter");
    this._battleDoctrine = screen.querySelector("#battle-doctrine");
    this._doctrineDesc = screen.querySelector("#doctrine-desc");
    this._selectedDoctrine = "skirmish";
    // Wire doctrine chip clicks. Selection updates the description
    // line and stamps the chosen doctrine on this._selectedDoctrine
    // so the FLY/COMMAND buttons can forward it via onRunChoice.
    for (const chip of screen.querySelectorAll(".doctrine-chip")) {
      this._addListener(chip, "click", () => {
        const key = chip.dataset.doctrine;
        this._selectedDoctrine = key;
        for (const c of screen.querySelectorAll(".doctrine-chip")) {
          c.classList.toggle("active", c.dataset.doctrine === key);
        }
        // Description line rendered from the doctrine table; menus.js
        // doesn't import the constants directly so we mirror inline.
        const desc = {
          "press":    "Close range. Damage +10%, orbit -25%, less danger-avoidance.",
          "skirmish": "Balanced. Turn rate +10%.",
          "hold":     "Stand-off. Shields +15%, regen +20%, orbit +35%.",
        }[key];
        if (this._doctrineDesc) this._doctrineDesc.textContent = desc || "";
      });
    }
    this._addListener(screen.querySelector("#battle-fly"), "click", () => {
      if (this._callbacks.onBattleFly) this._callbacks.onBattleFly(this._selectedDoctrine);
    });
    this._addListener(screen.querySelector("#battle-command"), "click", () => {
      if (this._callbacks.onBattleCommand) this._callbacks.onBattleCommand(this._selectedDoctrine);
    });
    this._addListener(screen.querySelector("#battle-back"), "click", () => {
      if (this._callbacks.onBattleBack) this._callbacks.onBattleBack();
    });

    root.appendChild(screen);
    this._screens.battleChoice = screen;
  }

  // ---- Battle Plan (Frontier pre-flight orders) ---------------------------
  //
  // Sits between battle-choice and the launch. Shows enemy fleet
  // composition, lets the player adjust per-capital posture + fighter
  // / bomber wing commands, then LAUNCH proceeds to startGame.
  _buildBattlePlan(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-battleplan";
    screen.dataset.screen = "battlePlan";
    screen.innerHTML = `
      <header class="battleplan-header">
        <button class="battleplan-back" id="battleplan-back" title="Back">←</button>
        <h2>BATTLE PLAN</h2>
        <span class="battleplan-node-tag" id="battleplan-node-tag"></span>
      </header>
      <div class="battleplan-body" id="battleplan-body">
        <!-- Enemy section -->
        <section class="battleplan-section">
          <div class="battleplan-section-title">ENEMY FORCES</div>
          <div class="battleplan-enemy" id="battleplan-enemy"></div>
        </section>
        <!-- Friendly capitals -->
        <section class="battleplan-section">
          <div class="battleplan-section-title">YOUR CAPITALS</div>
          <div class="battleplan-capitals" id="battleplan-capitals"></div>
        </section>
        <!-- Fighter + Bomber wings -->
        <section class="battleplan-section">
          <div class="battleplan-section-title">WINGS</div>
          <div class="battleplan-wings" id="battleplan-wings"></div>
        </section>
      </div>
      <footer class="battleplan-footer">
        <button class="battleplan-launch-btn" id="battleplan-launch">LAUNCH →</button>
      </footer>
    `;
    root.appendChild(screen);
    this._screens.battlePlan = screen;

    // Cache refs.
    this._bpNodeTag = screen.querySelector("#battleplan-node-tag");
    this._bpEnemy = screen.querySelector("#battleplan-enemy");
    this._bpCapitals = screen.querySelector("#battleplan-capitals");
    this._bpWings = screen.querySelector("#battleplan-wings");
    this._bpSig = null;

    // Static handlers.
    this._addListener(screen.querySelector("#battleplan-back"), "click", () => {
      if (this._callbacks.onBattlePlanBack) this._callbacks.onBattlePlanBack();
    });
    this._addListener(screen.querySelector("#battleplan-launch"), "click", () => {
      if (this._callbacks.onBattlePlanLaunch) this._callbacks.onBattlePlanLaunch();
    });
  }

  // -----------------------------------------------------------------------
  // Fleet Plan — run-free pre-battle planner for all non-Frontier modes.
  // Mirrors Battle Plan's DOM-screen pattern but drives a transient plan
  // (per-class directives + ad-hoc wings) instead of run state, and uses a
  // single delegated click handler (the body is innerHTML-rebuilt on every
  // plan change, so per-element listeners would leak).
  // -----------------------------------------------------------------------
  _buildFleetPlan(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-fleetplan";
    screen.dataset.screen = "fleetPlan";
    screen.innerHTML = `
      <header class="fleetplan-header">
        <button class="battleplan-back" id="fleetplan-back" title="Back">←</button>
        <h2>FLEET PLAN</h2>
        <span class="battleplan-node-tag" id="fleetplan-mode-tag"></span>
      </header>
      <div class="battleplan-body" id="fleetplan-body">
        <section class="battleplan-section">
          <div class="battleplan-section-title">ENEMY FORCES</div>
          <div class="battleplan-enemy" id="fleetplan-enemy"></div>
        </section>
        <section class="battleplan-section">
          <div class="battleplan-section-title">CAPITAL ORDERS</div>
          <div class="fp-classes" id="fleetplan-classes"></div>
        </section>
        <section class="battleplan-section">
          <div class="battleplan-section-title">STRIKE-CRAFT WINGS</div>
          <div class="battleplan-wings" id="fleetplan-wings"></div>
        </section>
      </div>
      <footer class="battleplan-footer">
        <button class="battleplan-launch-btn" id="fleetplan-launch">LAUNCH →</button>
      </footer>
    `;
    root.appendChild(screen);
    this._screens.fleetPlan = screen;

    this._fpModeTag = screen.querySelector("#fleetplan-mode-tag");
    this._fpEnemy = screen.querySelector("#fleetplan-enemy");
    this._fpClasses = screen.querySelector("#fleetplan-classes");
    this._fpWings = screen.querySelector("#fleetplan-wings");
    this._fpSig = null;
    this._fpLast = null; // last fleetPlan payload, for resolving cmd defaults

    // Static header / footer handlers.
    this._addListener(screen.querySelector("#fleetplan-back"), "click", () => {
      if (this._callbacks.onFleetPlanBack) this._callbacks.onFleetPlanBack();
    });
    this._addListener(screen.querySelector("#fleetplan-launch"), "click", () => {
      if (this._callbacks.onFleetPlanLaunch) this._callbacks.onFleetPlanLaunch();
    });

    // ONE delegated click handler for all the dynamic controls.
    this._addListener(screen, "click", (e) => this._onFleetPlanClick(e));
  }

  _onFleetPlanClick(e) {
    const cb = this._callbacks;
    const t = e.target;
    // Wing add / remove / weight — structural buttons.
    const addBtn = t.closest(".fp-add-wing");
    if (addBtn) { if (cb.onFleetPlanAddWing) cb.onFleetPlanAddWing(addBtn.dataset.craft); return; }
    const rmBtn = t.closest(".fp-wing-remove");
    if (rmBtn) {
      const row = rmBtn.closest(".fp-wing-row");
      if (cb.onFleetPlanRemoveWing) cb.onFleetPlanRemoveWing(row.dataset.craft, row.dataset.wingId);
      return;
    }
    const cntBtn = t.closest(".fp-wing-count-btn");
    if (cntBtn) {
      const row = cntBtn.closest(".fp-wing-row");
      const delta = parseInt(cntBtn.dataset.delta, 10) || 0;
      if (cb.onFleetPlanAdjustWing) cb.onFleetPlanAdjustWing(row.dataset.craft, row.dataset.wingId, delta);
      return;
    }
    // Order chip — one of the 3 axes (stance / priority [+priorityClass] /
    // assignment [+escortKlass]) or the missiles toggle. The chip (or an
    // ancestor row) carries data-scope = "class" | "wing".
    const chip = t.closest(".fp-chip[data-axis]");
    if (!chip) return;
    const scopeEl = chip.closest("[data-scope]");
    if (!scopeEl) return;
    const axis = chip.dataset.axis;
    const value = chip.dataset.value;
    const fp = this._fpLast || {};
    const bestCap = () => { const c = fp.capitalKlasses || []; return c[c.length - 1] || null; };
    const firstEnemy = () => (fp.enemyKlasses || [])[0] || null;
    if (scopeEl.dataset.scope === "class") {
      const klass = scopeEl.dataset.klass;
      if (!cb.onFleetPlanSetDirective) return;
      cb.onFleetPlanSetDirective(klass, axis, value);
      // Seed the sub-target so the order bites immediately.
      if (axis === "priority" && value === "hunt") cb.onFleetPlanSetDirective(klass, "priorityClass", firstEnemy());
      if (axis === "assignment" && value === "escort") cb.onFleetPlanSetDirective(klass, "escortKlass", bestCap());
    } else if (scopeEl.dataset.scope === "wing") {
      const craft = scopeEl.dataset.craft, wingId = scopeEl.dataset.wingId;
      if (!cb.onFleetPlanSetWingField) return;
      cb.onFleetPlanSetWingField(craft, wingId, axis, value);
      if (axis === "priority" && value === "hunt") cb.onFleetPlanSetWingField(craft, wingId, "priorityClass", firstEnemy());
      if (axis === "assignment" && value === "escort") cb.onFleetPlanSetWingField(craft, wingId, "escortKlass", bestCap());
    }
  }

  // Shared renderer for the three command axes (+ optional missiles toggle).
  // `order` = { stance, priority, priorityClass, assignment, escortKlass },
  // `missiles` = "on"|"hold"|undefined (omit to hide the toggle).
  _fpOrderControls(order, missiles) {
    const fp = this._fpLast || {};
    const STANCES = [["engage", "ENGAGE"], ["charge", "CHARGE"], ["standoff", "STAND-OFF"], ["hold", "HOLD"], ["fallback", "FALL-BACK"]];
    const PRIOS = [["default", "DEFAULT"], ["hunt", "HUNT"], ["focus", "FOCUS"]];
    const ASSIGNS = [["free", "FREE ROAM"], ["escort", "ESCORT"]];
    const chip = (active, axis, value, label, extra) =>
      `<button class="fp-chip${active ? " active" : ""}${extra ? " " + extra : ""}" data-axis="${axis}" data-value="${value}">${label}</button>`;
    const stance = order.stance || "engage";
    const priority = order.priority || "default";
    const assignment = order.assignment || "free";
    let h = `<div class="fp-axis"><span class="fp-axis-lbl">STANCE</span>${STANCES.map(([v, l]) => chip(stance === v, "stance", v, l, "fp-stance")).join("")}</div>`;
    h += `<div class="fp-axis"><span class="fp-axis-lbl">TARGET</span>${PRIOS.map(([v, l]) => chip(priority === v, "priority", v, l)).join("")}</div>`;
    if (priority === "hunt") {
      const ek = fp.enemyKlasses || [];
      h += `<div class="fp-axis fp-sub-axis">${ek.length
        ? ek.map((k) => chip(order.priorityClass === k, "priorityClass", k, CLASS_SHORT_LABELS[k] || k, "fp-sub")).join("")
        : `<span class="fp-sub-empty">enemy unknown — hunts when sighted</span>`}</div>`;
    }
    h += `<div class="fp-axis"><span class="fp-axis-lbl">POSITION</span>${ASSIGNS.map(([v, l]) => chip(assignment === v, "assignment", v, l)).join("")}</div>`;
    if (assignment === "escort") {
      const ck = fp.capitalKlasses || [];
      h += `<div class="fp-axis fp-sub-axis">${ck.length
        ? ck.map((k) => chip(order.escortKlass === k, "escortKlass", k, CLASS_SHORT_LABELS[k] || k, "fp-sub")).join("")
        : `<span class="fp-sub-empty">no capital to escort</span>`}</div>`;
    }
    if (missiles !== undefined) {
      const held = missiles === "hold";
      h += `<div class="fp-axis"><span class="fp-axis-lbl">MISSILES</span>${chip(held, "missiles", held ? "on" : "hold", held ? "HOLD" : "FREE")}</div>`;
    }
    return h;
  }

  _syncFleetPlan(s) {
    const fp = s && s.fleetPlan;
    if (!fp || !this._fpEnemy) return;
    this._fpLast = fp; // _fpOrderControls reads enemyKlasses/capitalKlasses off this
    const orderSig = (o) => `${o.stance}:${o.priority}:${o.priorityClass ?? ""}:${o.assignment}:${o.escortKlass ?? ""}`;
    const wingSig = (wings) => (wings || []).map((w) => `${w.id}:${w.count}:${orderSig(w)}`).join("|");
    const sig = JSON.stringify({
      mode: fp.modeLabel,
      enemyKnown: fp.enemyKnown,
      enemy: fp.enemyRoster,
      your: fp.yourRoster,
      classRows: fp.classRows.map((c) => `${c.klass}:${c.count}:${orderSig(c)}:${c.missiles}`).join(","),
      fighterWings: wingSig(fp.fighterWings),
      bomberWings: wingSig(fp.bomberWings),
      fMis: fp.fighterMissiles, bMis: fp.bomberMissiles,
      canAddF: fp.canAddFighterWing,
      canAddB: fp.canAddBomberWing,
    });
    if (sig === this._fpSig) return;
    this._fpSig = sig;

    this._fpModeTag.textContent = fp.modeLabel || "";

    // --- Enemy Forces ---
    let enemyHtml = "";
    if (!fp.enemyKnown) {
      enemyHtml = `<div class="fp-enemy-unknown">Opponent randomised at launch — set your fleet's orders below.</div>`;
    } else {
      if (fp.enemyFactionName) {
        enemyHtml += `<div class="bp-enemy-faction" style="color:${fp.enemyFactionAccent || "#fc8"}">${fp.enemyFactionName.toUpperCase()}</div>`;
      }
      enemyHtml += `<div class="bp-enemy-roster">`;
      for (const entry of fp.enemyRoster) {
        enemyHtml += `
          <div class="bp-enemy-cell" title="${CLASS_SHORT_LABELS[entry.klass] || entry.klass}">
            <div class="bp-enemy-icon">${classIconSvg(entry.klass, { size: 24 })}</div>
            <div class="bp-enemy-count">×${entry.count}</div>
          </div>`;
      }
      enemyHtml += `</div>`;
    }
    this._fpEnemy.innerHTML = enemyHtml;

    // --- Per-class capital orders (frigate/cruiser/battleship) ---
    let clsHtml = "";
    if (!fp.classRows || fp.classRows.length === 0) {
      clsHtml = `<div class="bp-empty">No formation capitals in this fleet.</div>`;
    } else {
      for (const row of fp.classRows) {
        clsHtml += `
          <div class="fp-cmd-row" data-scope="class" data-klass="${row.klass}">
            <div class="fp-cmd-head">
              <span class="bp-cap-icon">${classIconSvg(row.klass, { size: 20 })}</span>
              <span class="fp-class-name">${(CLASS_SHORT_LABELS[row.klass] || row.klass).toUpperCase()}</span>
              <span class="fp-class-count">×${row.count}</span>
            </div>
            <div class="fp-order">${this._fpOrderControls(row, row.hasMissiles ? row.missiles : undefined)}</div>
          </div>`;
      }
    }
    this._fpClasses.innerHTML = clsHtml;

    // --- Strike-craft wings ---
    const wingRow = (craft, wing) => `
      <div class="fp-cmd-row fp-wing-row" data-scope="wing" data-craft="${craft}" data-wing-id="${wing.id}">
        <div class="fp-cmd-head">
          <span class="bp-cap-icon">${classIconSvg(craft, { size: 20 })}</span>
          <span class="fp-class-name">${wing.name} Wing</span>
          <span class="fp-wing-count-ctl">
            <button class="bp-wing-count-btn fp-wing-count-btn" data-delta="-1">−</button>
            <span class="bp-wing-count">~${wing.count}</span>
            <button class="bp-wing-count-btn fp-wing-count-btn" data-delta="1">+</button>
          </span>
          <button class="bp-wing-remove fp-wing-remove" title="Remove wing">×</button>
        </div>
        <div class="fp-order">${this._fpOrderControls(wing, undefined)}</div>
      </div>`;
    const wingSection = (craft, wings, canAdd, missiles) => {
      const total = (wings || []).reduce((a, w) => a + w.count, 0);
      const held = missiles === "hold";
      let html = `<div class="bp-wings-header" data-scope="class" data-klass="${craft}">
        <div class="bp-wings-title">${craft.toUpperCase()} WINGS · ${total}</div>
        <button class="fp-chip fp-section-missile${held ? " active" : ""}" data-axis="missiles" data-value="${held ? "on" : "hold"}" title="Missile pods ${held ? "HOLD" : "FREE"}">M ${held ? "HOLD" : "FREE"}</button>
        <button class="bp-add-wing fp-add-wing" data-craft="${craft}"${canAdd ? "" : " disabled"}>+ NEW WING</button>
      </div>`;
      if (!wings || wings.length === 0) html += `<div class="bp-empty">No ${craft}s in this fleet.</div>`;
      else for (const w of wings) html += wingRow(craft, w);
      return html;
    };
    let wingsHtml = "";
    if ((fp.fighterWings || []).length > 0 || (fp.yourRoster || []).some((r) => r.klass === "fighter")) {
      wingsHtml += wingSection("fighter", fp.fighterWings, fp.canAddFighterWing, fp.fighterMissiles);
    }
    if ((fp.bomberWings || []).length > 0 || (fp.yourRoster || []).some((r) => r.klass === "bomber")) {
      wingsHtml += wingSection("bomber", fp.bomberWings, fp.canAddBomberWing, fp.bomberMissiles);
    }
    if (!wingsHtml) wingsHtml = `<div class="bp-empty">No strike craft in this fleet.</div>`;
    this._fpWings.innerHTML = wingsHtml;
  }

  _syncBattlePlan(s) {
    const bp = s && s.battlePlan;
    if (!bp || !this._bpEnemy) return;
    const wingSig = (wings) => (wings || []).map((w) =>
      `${w.id}:${w.count}:${w.command?.kind}:${w.command?.target ?? ""}:${w.commander?.callsign ?? ""}`
    ).join("|");
    const sig = JSON.stringify({
      node: bp.nodeId,
      enemy: bp.enemyRoster,
      capitals: bp.capitals?.map(c => `${c.instanceId}|${c.behavior}|${c.race ?? ""}`).join(","),
      captured: (bp.capturedCraft || []).map(c => `${c.race}:${c.klass}:${c.count}`).join(","),
      reinf: (bp.reinforcements || []).map(r => `${r.faction}:${r.fighter}:${r.bomber}:${r.frigate}`).join(","),
      grudge: bp.grudge ? `${bp.grudge.factionLabel}:${bp.grudge.pct}` : "",
      fighterWings: wingSig(bp.fighterWings),
      bomberWings: wingSig(bp.bomberWings),
      fighterCount: bp.fighterCount,
      bomberCount: bp.bomberCount,
    });
    if (sig === this._bpSig) return;
    this._bpSig = sig;

    // Node tag — "BOSS · APHELIOTROPE" / "BATTLE" / "ELITE"
    this._bpNodeTag.textContent = bp.nodeLabel || "";

    // Enemy roster — class icons + counts. Faction emblem optional
    // (color-coded by faction accent).
    let enemyHtml = "";
    if (bp.enemyFactionName) {
      enemyHtml += `<div class="bp-enemy-faction" style="color:${bp.enemyFactionAccent || "#fc8"}">${bp.enemyFactionName.toUpperCase()}</div>`;
    }
    if (bp.bossName) {
      enemyHtml += `<div class="bp-enemy-boss">${bp.bossName}</div>`;
      if (bp.bossDescription) enemyHtml += `<div class="bp-enemy-boss-desc">${bp.bossDescription}</div>`;
    }
    enemyHtml += `<div class="bp-enemy-roster">`;
    for (const entry of (bp.enemyRoster || [])) {
      enemyHtml += `
        <div class="bp-enemy-cell" title="${CLASS_SHORT_LABELS[entry.klass] || entry.klass}">
          <div class="bp-enemy-icon">${classIconSvg(entry.klass, { size: 24 })}</div>
          <div class="bp-enemy-count">×${entry.count}</div>
        </div>
      `;
    }
    enemyHtml += `</div>`;
    // Grudge warning — a Marked enemy faction commits a heavier roster.
    if (bp.grudge) {
      enemyHtml += `<div class="bp-grudge">⚠ MARKED BY ${bp.grudge.factionLabel.toUpperCase()} — +${bp.grudge.pct}% hostile forces</div>`;
    }
    // Allied reinforcements — friendly factions sending ships to your side.
    if (bp.reinforcements && bp.reinforcements.length > 0) {
      let reinfHtml = `<div class="bp-reinf"><div class="bp-reinf-title">ALLIED SUPPORT INBOUND</div>`;
      for (const r of bp.reinforcements) {
        const parts = [];
        if (r.fighter) parts.push(`${r.fighter} fighter${r.fighter !== 1 ? "s" : ""}`);
        if (r.bomber)  parts.push(`${r.bomber} bomber${r.bomber !== 1 ? "s" : ""}`);
        if (r.frigate) parts.push(`${r.frigate} frigate${r.frigate !== 1 ? "s" : ""}`);
        reinfHtml += `<div class="bp-reinf-row"><span class="bp-reinf-faction">${r.factionLabel} <span class="bp-reinf-standing">(${r.standing})</span></span><span class="bp-reinf-ships">+${parts.join(", ")}</span></div>`;
      }
      reinfHtml += `</div>`;
      enemyHtml += reinfHtml;
    }
    this._bpEnemy.innerHTML = enemyHtml;

    // Friendly capitals — per-row posture chips.
    let capHtml = "";
    if (!bp.capitals || bp.capitals.length === 0) {
      capHtml = `<div class="bp-empty">No capitals yet — they join the fleet at promotions.</div>`;
    } else {
      for (const cap of bp.capitals) {
        const klassName = CLASS_SHORT_LABELS[cap.klass] || cap.klass;
        const currentBehavior = cap.behavior || "default";
        // Captured prize tag — shows the original race so the player
        // sees "captured Reaver cruiser" rather than a generic hull.
        const capturedTag = cap.captured
          ? `<span class="bp-captured-tag">CAPTURED${cap.race ? " · " + cap.race.toUpperCase() : ""}</span>`
          : "";
        capHtml += `
          <div class="bp-cap-row${cap.captured ? " bp-cap-captured" : ""}">
            <div class="bp-cap-icon">${classIconSvg(cap.klass, { size: 24 })}</div>
            <div class="bp-cap-id">
              <div class="bp-cap-name">${cap.name || klassName}${capturedTag}</div>
              <div class="bp-cap-captain">${cap.captain || klassName}</div>
            </div>
            <div class="bp-cap-postures" data-instance="${cap.instanceId}">
              ${["default", "aggressive", "defensive"].map(b =>
                `<button class="bp-posture-chip${b === currentBehavior ? " active" : ""}" data-behavior="${b}">${b.toUpperCase()}</button>`
              ).join("")}
            </div>
          </div>
        `;
      }
    }
    this._bpCapitals.innerHTML = capHtml;

    // Wire capital posture chips
    for (const chip of this._bpCapitals.querySelectorAll(".bp-posture-chip")) {
      this._addListener(chip, "click", () => {
        const row = chip.closest(".bp-cap-postures");
        const instanceId = parseInt(row.dataset.instance, 10);
        const behavior = chip.dataset.behavior;
        if (this._callbacks.onBattlePlanCapBehavior) {
          this._callbacks.onBattlePlanCapBehavior(instanceId, behavior);
        }
      });
    }

    // Wings — multi-wing per craft type (Alpha/Bravo/Charlie...).
    // Each wing row: name + count adjuster + command picker.
    // Command picker is a 2-tier select: the kind chip row, plus an
    // inline sub-picker when defend-capital / target-class is active.
    const CMD_KINDS = ["hold", "free", "press", "defend-capital", "target-class"];
    const CMD_LABEL = {
      "hold": "HOLD", "free": "FREE", "press": "PRESS",
      "defend-capital": "DEFEND", "target-class": "TARGET",
    };
    const ENEMY_CLASSES = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier"];

    const wingHtml = (craft, wing) => {
      const cmd = wing.command || { kind: "free" };
      // Build sub-picker for defend-capital / target-class
      let subHtml = "";
      if (cmd.kind === "defend-capital") {
        if (!bp.capitals || bp.capitals.length === 0) {
          subHtml = `<div class="bp-wing-sub bp-wing-sub-empty">No capitals to defend</div>`;
        } else {
          subHtml = `<div class="bp-wing-sub" data-craft="${craft}" data-wing-id="${wing.id}" data-cmd-kind="defend-capital">
            ${bp.capitals.map(c =>
              `<button class="bp-wing-sub-chip${cmd.target === c.instanceId ? " active" : ""}" data-target="${c.instanceId}">${CLASS_SHORT_LABELS[c.klass] || c.klass}</button>`
            ).join("")}
          </div>`;
        }
      } else if (cmd.kind === "target-class") {
        // Only show enemy classes actually on the field this battle.
        const onField = new Set((bp.enemyRoster || []).map(e => e.klass));
        const choices = ENEMY_CLASSES.filter(k => onField.has(k));
        if (choices.length === 0) {
          subHtml = `<div class="bp-wing-sub bp-wing-sub-empty">No targets on field</div>`;
        } else {
          subHtml = `<div class="bp-wing-sub" data-craft="${craft}" data-wing-id="${wing.id}" data-cmd-kind="target-class">
            ${choices.map(k =>
              `<button class="bp-wing-sub-chip${cmd.target === k ? " active" : ""}" data-target="${k}">${CLASS_SHORT_LABELS[k] || k}</button>`
            ).join("")}
          </div>`;
        }
      }
      // Commander name + trait label sit under the wing name.
      const commanderLine = wing.commander
        ? `<div class="bp-wing-commander" title="${wing.commander.blurb || ""}">${wing.commander.name} <span class="bp-wing-trait">· ${wing.commander.traitLabel}</span></div>`
        : "";
      return `
        <div class="bp-wing-row" data-craft="${craft}" data-wing-id="${wing.id}">
          <div class="bp-cap-icon">${classIconSvg(craft, { size: 24 })}</div>
          <div class="bp-cap-id">
            <div class="bp-cap-name">${wing.name} Wing</div>
            ${commanderLine}
            <div class="bp-cap-captain">
              <button class="bp-wing-count-btn" data-delta="-1"${wing.count <= 2 ? " disabled" : ""}>−</button>
              <span class="bp-wing-count">${wing.count} ${craft}${wing.count !== 1 ? "s" : ""}</span>
              <button class="bp-wing-count-btn" data-delta="+1"${wing.count >= 5 ? " disabled" : ""}>+</button>
            </div>
          </div>
          <div class="bp-wing-controls">
            <div class="bp-wing-cmds">
              ${CMD_KINDS.map(k =>
                `<button class="bp-posture-chip${cmd.kind === k ? " active" : ""}" data-cmd-kind="${k}">${CMD_LABEL[k]}</button>`
              ).join("")}
            </div>
            ${subHtml}
            <button class="bp-wing-remove" title="Remove wing">×</button>
          </div>
        </div>
      `;
    };

    const sectionHtml = (craft, wings, count) => {
      const total = (wings || []).reduce((s, w) => s + w.count, 0);
      // NEW WING needs a source wing with ≥4 ships (min 2 stays in source,
      // min 2 goes to the new wing). 6-wing UI cap kept as a soft ceiling.
      const hasSplittable = (wings || []).some((w) => w.count >= 4);
      const canAdd = hasSplittable && wings.length < 6;
      let html = "";
      if (count === 0 || wings.length === 0) {
        html += `<div class="bp-empty">No ${craft}s to assign.</div>`;
      } else {
        html += `<div class="bp-wings-header">
          <div class="bp-wings-title">${craft.toUpperCase()} WINGS · ${total}</div>
          <button class="bp-add-wing" data-craft="${craft}"${canAdd ? "" : " disabled"}>+ NEW WING</button>
        </div>`;
        for (const w of wings) html += wingHtml(craft, w);
      }
      return html;
    };

    let wingsHtml = "";
    wingsHtml += sectionHtml("fighter", bp.fighterWings || [], bp.fighterCount || 0);
    wingsHtml += sectionHtml("bomber", bp.bomberWings || [], bp.bomberCount || 0);
    // Captured small craft — keep their original race, fly on default
    // AI (not part of the native wing system). Shown as a read-only
    // summary so the player sees the captured prizes in their fleet.
    const captured = bp.capturedCraft || [];
    if (captured.length > 0) {
      wingsHtml += `<div class="bp-wings-header"><div class="bp-wings-title">CAPTURED CRAFT</div></div>`;
      for (const c of captured) {
        const klassName = CLASS_SHORT_LABELS[c.klass] || c.klass;
        wingsHtml += `
          <div class="bp-wing-row bp-cap-captured">
            <div class="bp-cap-icon">${classIconSvg(c.klass, { size: 24 })}</div>
            <div class="bp-cap-id">
              <div class="bp-cap-name">${c.race.toUpperCase()} ${klassName}<span class="bp-captured-tag">CAPTURED</span></div>
              <div class="bp-cap-captain">×${c.count} · flies independently</div>
            </div>
          </div>
        `;
      }
    }
    if (!wingsHtml) wingsHtml = `<div class="bp-empty">No small craft to assign.</div>`;
    this._bpWings.innerHTML = wingsHtml;

    // Wire command kind chips
    for (const chip of this._bpWings.querySelectorAll(".bp-wing-cmds .bp-posture-chip")) {
      this._addListener(chip, "click", () => {
        const row = chip.closest(".bp-wing-row");
        const craft = row.dataset.craft;
        const wingId = row.dataset.wingId;
        const kind = chip.dataset.cmdKind;
        // For defend-capital / target-class, pre-seed a sensible default
        // target so the picker isn't blank after switching.
        const command = { kind };
        if (kind === "defend-capital" && bp.capitals && bp.capitals.length > 0) {
          command.target = bp.capitals[0].instanceId;
        } else if (kind === "target-class") {
          const onField = (bp.enemyRoster || []).map(e => e.klass);
          if (onField.length > 0) command.target = onField[0];
        }
        if (this._callbacks.onBattlePlanWingDetail) {
          this._callbacks.onBattlePlanWingDetail(craft, wingId, command);
        }
      });
    }
    // Wire sub-picker chips (defend-capital + target-class)
    for (const chip of this._bpWings.querySelectorAll(".bp-wing-sub-chip")) {
      this._addListener(chip, "click", () => {
        const sub = chip.closest(".bp-wing-sub");
        const craft = sub.dataset.craft;
        const wingId = sub.dataset.wingId;
        const kind = sub.dataset.cmdKind;
        const targetStr = chip.dataset.target;
        // capital targets are numeric instanceIds; class targets are strings
        const target = /^\d+$/.test(targetStr) ? parseInt(targetStr, 10) : targetStr;
        if (this._callbacks.onBattlePlanWingDetail) {
          this._callbacks.onBattlePlanWingDetail(craft, wingId, { kind, target });
        }
      });
    }
    // Wire count adjusters
    for (const btn of this._bpWings.querySelectorAll(".bp-wing-count-btn")) {
      this._addListener(btn, "click", () => {
        const row = btn.closest(".bp-wing-row");
        const craft = row.dataset.craft;
        const wingId = row.dataset.wingId;
        const delta = parseInt(btn.dataset.delta, 10);
        if (this._callbacks.onBattlePlanAdjustWing) {
          this._callbacks.onBattlePlanAdjustWing(craft, wingId, delta);
        }
      });
    }
    // Wire add wing
    for (const btn of this._bpWings.querySelectorAll(".bp-add-wing")) {
      this._addListener(btn, "click", () => {
        const craft = btn.dataset.craft;
        if (this._callbacks.onBattlePlanAddWing) {
          this._callbacks.onBattlePlanAddWing(craft);
        }
      });
    }
    // Wire remove wing
    for (const btn of this._bpWings.querySelectorAll(".bp-wing-remove")) {
      this._addListener(btn, "click", () => {
        const row = btn.closest(".bp-wing-row");
        const craft = row.dataset.craft;
        const wingId = row.dataset.wingId;
        if (this._callbacks.onBattlePlanRemoveWing) {
          this._callbacks.onBattlePlanRemoveWing(craft, wingId);
        }
      });
    }
  }

  // ---- Resupply -----------------------------------------------------------

  _buildResupply(root) {
    // Tier 45 — mobile-first rebuild. Header strip + vendor card +
    // credit chips + sectioned shop with REPAIR / CRAFT / BOONS
    // panes. Footer with CLOSE + CONTINUE.
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-resupply resupply-v2";
    screen.dataset.screen = "resupply";
    screen.innerHTML = `
      <header class="resupply-header">
        <button class="playhub-back" id="resupply-close" title="Back">←</button>
        <h2 id="resupply-title">RESUPPLY</h2>
        <div class="playhub-spacer"></div>
        <div class="resupply-creds-chip">
          <span class="resupply-creds-icon">$</span>
          <span id="resupply-credits-value">0</span>
        </div>
        <div class="resupply-fuel-chip">
          <span class="resupply-fuel-icon">⛽</span>
          <span id="resupply-fuel-value">0</span>
        </div>
      </header>
      <div class="resupply-body">
        <section class="resupply-vendor-card" id="resupply-vendor"></section>

        <section class="resupply-pane">
          <div class="resupply-pane-title">REPAIRS</div>
          <div class="resupply-rows" id="resupply-repairs"></div>
        </section>

        <section class="resupply-pane">
          <div class="resupply-pane-title">RECRUIT &amp; REFUEL</div>
          <div class="resupply-shop-grid">
            <button class="resupply-shop-tile" id="resupply-fighter">
              <span class="shop-tile-icon">⚙</span>
              <span class="shop-tile-name">FIGHTER</span>
              <span class="shop-tile-cost" id="resupply-fighter-cost">— cr</span>
            </button>
            <button class="resupply-shop-tile" id="resupply-bomber">
              <span class="shop-tile-icon">▼</span>
              <span class="shop-tile-name">BOMBER</span>
              <span class="shop-tile-cost" id="resupply-bomber-cost">— cr</span>
            </button>
            <button class="resupply-shop-tile" id="resupply-refuel">
              <span class="shop-tile-icon">⛽</span>
              <span class="shop-tile-name">REFUEL +1</span>
              <span class="shop-tile-cost" id="resupply-refuel-cost">— cr</span>
            </button>
          </div>
        </section>

        <section class="resupply-pane" id="resupply-boons-pane">
          <div class="resupply-pane-title">FIELD BOONS · 1 FUEL EACH</div>
          <div class="resupply-rows" id="resupply-boons"></div>
        </section>
      </div>
      <div class="resupply-footer">
        <button class="skirmish-deploy-btn" id="resupply-continue">CONTINUE</button>
      </div>
    `;

    this._resupplyCredits = screen.querySelector("#resupply-credits-value");
    this._resupplyFuel = screen.querySelector("#resupply-fuel-value");
    this._resupplyRepairs = screen.querySelector("#resupply-repairs");
    this._resupplyFighterBtn = screen.querySelector("#resupply-fighter");
    this._resupplyBomberBtn = screen.querySelector("#resupply-bomber");
    this._resupplyRefuelBtn = screen.querySelector("#resupply-refuel");
    this._resupplyFighterCost = screen.querySelector("#resupply-fighter-cost");
    this._resupplyBomberCost = screen.querySelector("#resupply-bomber-cost");
    this._resupplyRefuelCost = screen.querySelector("#resupply-refuel-cost");
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
        <!-- Result view — shown after a choice is made so the player
             SEES the consequence (outcome text + resource deltas). -->
        <div class="event-result" id="event-result" style="display:none;">
          <div class="event-result-text" id="event-result-text"></div>
          <div class="event-result-deltas" id="event-result-deltas"></div>
        </div>
        <div class="overlay-footer">
          <button class="overlay-close-btn" id="event-close">CLOSE</button>
          <button class="overlay-continue-btn" id="event-continue" style="display:none;">CONTINUE →</button>
        </div>
      </div>
    `;

    this._eventTitle = screen.querySelector("#event-title");
    this._eventBody = screen.querySelector("#event-body");
    this._eventChoices = screen.querySelector("#event-choices");
    this._eventResult = screen.querySelector("#event-result");
    this._eventResultText = screen.querySelector("#event-result-text");
    this._eventResultDeltas = screen.querySelector("#event-result-deltas");
    this._eventCloseBtn = screen.querySelector("#event-close");
    this._eventContinueBtn = screen.querySelector("#event-continue");
    this._addListener(this._eventCloseBtn, "click", () => {
      if (this._callbacks.onEventClose) this._callbacks.onEventClose();
    });
    this._addListener(this._eventContinueBtn, "click", () => {
      if (this._callbacks.onEventContinue) this._callbacks.onEventContinue();
    });

    root.appendChild(screen);
    this._screens.event = screen;
  }

  // ---- Promotion ----------------------------------------------------------

  _buildPromotion(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-promotion";
    screen.dataset.screen = "promotion";
    screen.innerHTML = `
      <div class="overlay-panel promotion-panel">
        <div class="panel-accent-rule"></div>
        <div class="promotion-eyebrow">FRONTIER COMMAND · COMMENDATION</div>
        <!-- Insignia hero — large rank chip with sparkle/glow reveal.
             Populated by _syncPromotion from RANK_INSIGNIA. -->
        <div class="promotion-insignia-stage">
          <div class="promotion-insignia-rays" aria-hidden="true"></div>
          <div class="promotion-insignia" id="promotion-insignia" aria-hidden="true"></div>
        </div>
        <h2 id="promotion-rank">LIEUTENANT</h2>
        <div class="promotion-title" id="promotion-title">Flight Leader</div>
        <p class="promotion-blurb" id="promotion-blurb"></p>
        <div class="promotion-bulletin" id="promotion-bulletin-section">
          <div class="promotion-additions-label">WAR BULLETIN</div>
          <ul class="promotion-bulletin-list" id="promotion-bulletin-list"></ul>
        </div>
        <div class="promotion-additions">
          <div class="promotion-additions-label">JOINING YOUR LINE</div>
          <div class="promotion-additions-list" id="promotion-additions"></div>
        </div>
        <div class="promotion-traits" id="promotion-traits-section">
          <div class="promotion-additions-label">OFFICER TRAIT</div>
          <div class="promotion-trait-hint" id="promotion-trait-hint">Choose one — it carries to the end of your career.</div>
          <div class="promotion-trait-chips" id="promotion-trait-chips"></div>
        </div>
        <div class="overlay-footer">
          <button class="menu-btn start-btn" id="promotion-proceed">PROCEED</button>
        </div>
      </div>
    `;

    this._promotionInsignia = screen.querySelector("#promotion-insignia");
    this._promotionRank = screen.querySelector("#promotion-rank");
    this._promotionTitle = screen.querySelector("#promotion-title");
    this._promotionBlurb = screen.querySelector("#promotion-blurb");
    this._promotionAdditions = screen.querySelector("#promotion-additions");
    this._promotionBulletinSection = screen.querySelector("#promotion-bulletin-section");
    this._promotionBulletinList = screen.querySelector("#promotion-bulletin-list");
    this._promotionTraitsSection = screen.querySelector("#promotion-traits-section");
    this._promotionTraitChips = screen.querySelector("#promotion-trait-chips");
    this._promotionTraitHint = screen.querySelector("#promotion-trait-hint");
    this._promotionProceedBtn = screen.querySelector("#promotion-proceed");
    this._promotionTraitSig = null;
    this._promotionBulletinSig = null;

    this._addListener(this._promotionProceedBtn, "click", () => {
      if (this._callbacks.onPromotionDismiss) this._callbacks.onPromotionDismiss();
    });

    root.appendChild(screen);
    this._screens.promotion = screen;
  }

  // ---- Act preamble (war-state briefing) ----------------------------------

  _buildPreamble(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-preamble";
    screen.dataset.screen = "preamble";
    screen.innerHTML = `
      <div class="overlay-panel preamble-panel">
        <div class="panel-accent-rule"></div>
        <div class="preamble-eyebrow" id="preamble-eyebrow">FRONTIER WARS · YEAR 9</div>
        <h2 id="preamble-title">ACT 1</h2>
        <ul class="preamble-lines" id="preamble-lines"></ul>
        <div class="overlay-footer">
          <button class="menu-btn start-btn" id="preamble-proceed">PROCEED</button>
        </div>
      </div>
    `;
    this._preambleEyebrow = screen.querySelector("#preamble-eyebrow");
    this._preambleTitle = screen.querySelector("#preamble-title");
    this._preambleLines = screen.querySelector("#preamble-lines");
    this._preambleProceedBtn = screen.querySelector("#preamble-proceed");
    this._preambleSig = null;
    this._addListener(this._preambleProceedBtn, "click", () => {
      if (this._callbacks.onPreambleDismiss) this._callbacks.onPreambleDismiss();
    });
    root.appendChild(screen);
    this._screens.preamble = screen;
  }

  _syncPreamble(s) {
    const p = s && s.preamble;
    if (!p) return;
    const sig = `${p.act}:${p.title}:${p.lines.length}:${(p.lines[p.lines.length - 1] || "").slice(0, 32)}`;
    if (sig === this._preambleSig) return;
    this._preambleSig = sig;
    this._preambleEyebrow.textContent = p.eyebrow || "";
    this._preambleTitle.textContent = p.title || "";
    let html = "";
    for (const line of p.lines) html += `<li>${line}</li>`;
    this._preambleLines.innerHTML = html;
  }

  // ---- Inter-act dispatch (Tier 17) ---------------------------------------

  _buildDispatch(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-dispatch";
    screen.dataset.screen = "dispatch";
    screen.innerHTML = `
      <div class="overlay-panel dispatch-panel">
        <div class="panel-accent-rule"></div>
        <div class="dispatch-static-row">
          <span class="dispatch-static-dot"></span>
          <span class="dispatch-eyebrow" id="dispatch-eyebrow">INCOMING TRANSMISSION</span>
        </div>
        <h2 id="dispatch-title">DISPATCH</h2>
        <p class="dispatch-text" id="dispatch-text"></p>
        <div class="overlay-footer">
          <button class="menu-btn start-btn" id="dispatch-proceed">ACKNOWLEDGE</button>
        </div>
      </div>
    `;
    this._dispatchEyebrow = screen.querySelector("#dispatch-eyebrow");
    this._dispatchTitle = screen.querySelector("#dispatch-title");
    this._dispatchText = screen.querySelector("#dispatch-text");
    this._dispatchProceedBtn = screen.querySelector("#dispatch-proceed");
    this._dispatchSig = null;
    this._addListener(this._dispatchProceedBtn, "click", () => {
      if (this._callbacks.onDispatchDismiss) this._callbacks.onDispatchDismiss();
    });
    root.appendChild(screen);
    this._screens.dispatch = screen;
  }

  // ---- Run stats overlay (Tier 27) ----------------------------------------

  _buildRunStats(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-runstats";
    screen.dataset.screen = "runStats";
    screen.innerHTML = `
      <div class="overlay-panel runstats-panel">
        <div class="panel-accent-rule"></div>
        <div class="runstats-eyebrow">CAREER DOSSIER</div>
        <h2 id="runstats-title">RUN STATS</h2>
        <div class="runstats-body" id="runstats-body"></div>
        <div class="overlay-footer">
          <button class="overlay-close-btn" id="runstats-close">CLOSE</button>
        </div>
      </div>
    `;
    this._runstatsBody = screen.querySelector("#runstats-body");
    this._runstatsTitle = screen.querySelector("#runstats-title");
    this._runstatsSig = null;
    this._addListener(screen.querySelector("#runstats-close"), "click", () => {
      if (this._callbacks.onRunStatsClose) this._callbacks.onRunStatsClose();
    });
    root.appendChild(screen);
    this._screens.runStats = screen;
  }

  _syncRunStats(s) {
    if (!this._runstatsBody) return;
    const rs = s && s.runStats;
    if (!rs) return;
    // Re-render only when the stats payload changes (cheap signature
    // via JSON stringify since the object is small).
    const sig = JSON.stringify(rs);
    if (sig === this._runstatsSig) return;
    this._runstatsSig = sig;
    const st = rs.stats || {};
    const totalKills = Object.values(st.shipsKilled || {}).reduce((a, b) => a + b, 0);
    const totalLost  = Object.values(st.shipsLost   || {}).reduce((a, b) => a + b, 0);
    const k = st.shipsKilled || {};
    const l = st.shipsLost   || {};
    const fmtRow = (label, value) => `
      <div class="runstats-row">
        <span class="runstats-label">${label}</span>
        <span class="runstats-value">${value}</span>
      </div>
    `;
    const fmtRowSub = (label, value, sub) => `
      <div class="runstats-row">
        <span class="runstats-label">${label}</span>
        <span class="runstats-value">${value}<span class="runstats-sub">${sub}</span></span>
      </div>
    `;
    this._runstatsTitle.textContent = rs.title || "RUN STATS";
    const handle = rs.handle ? `<div class="runstats-handle">${rs.handle}</div>` : "";
    this._runstatsBody.innerHTML = `
      ${handle}
      <div class="runstats-section">
        <div class="runstats-section-title">Career</div>
        ${fmtRow("Act", `${rs.act}/${rs.actsTotal || 5}`)}
        ${fmtRow("Rank", rs.rank || "Officer")}
        ${fmtRow("Nodes cleared", st.nodesCleared || 0)}
        ${fmtRow("Battles", st.battlesCleared || 0)}
        ${fmtRow("Elites", st.elitesCleared || 0)}
        ${fmtRow("Bosses", st.bossesKilled || 0)}
        ${fmtRow("Events", st.eventsResolved || 0)}
        ${fmtRow("Resupplies", st.resupplyVisits || 0)}
      </div>
      <div class="runstats-section">
        <div class="runstats-section-title">Combat</div>
        ${fmtRowSub("Ships destroyed", totalKills,
          ` · F${k.fighter || 0} B${k.bomber || 0} Fr${k.frigate || 0} Cr${k.cruiser || 0} BB${k.battleship || 0} CV${k.carrier || 0}`)}
        ${fmtRowSub("Ships lost", totalLost,
          ` · F${l.fighter || 0} B${l.bomber || 0} Fr${l.frigate || 0} Cr${l.cruiser || 0} BB${l.battleship || 0} CV${l.carrier || 0}`)}
        ${fmtRow("Marked rivals down", st.rivalsDefeated || 0)}
      </div>
      <div class="runstats-section">
        <div class="runstats-section-title">Logistics</div>
        ${fmtRow("Credits earned", st.creditsEarned || 0)}
        ${fmtRow("Credits spent", st.creditsSpent || 0)}
        ${fmtRow("Fuel burned", st.fuelBurned || 0)}
        ${fmtRow("Boons acquired", st.boonsAcquired || 0)}
        ${fmtRow("Repairs purchased", st.repairsPurchased || 0)}
        ${fmtRow("Recruits hired", st.recruitsHired || 0)}
      </div>
      <div class="runstats-section">
        <div class="runstats-section-title">Story</div>
        ${fmtRow("Promotions earned", st.promotionsEarned || 0)}
        ${fmtRow("Jump encounters", st.jumpEncounters || 0)}
        ${fmtRow("Contracts complete", st.contractsCompleted || 0)}
        ${fmtRow("Contracts failed", st.contractsFailed || 0)}
      </div>
    `;
  }

  // ---- Service Hall overlay (Tier 38) ------------------------------------

  _buildServiceHall(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-servicehall";
    screen.dataset.screen = "serviceHall";
    screen.innerHTML = `
      <div class="overlay-panel servicehall-panel">
        <div class="panel-accent-rule"></div>
        <div class="svchall-eyebrow">FRONTIER SERVICE HALL</div>
        <h2>PERMANENT UPGRADES</h2>
        <div class="svchall-points-row">
          <span class="svchall-points-label">SERVICE POINTS:</span>
          <span class="svchall-points-value" id="svchall-points">0</span>
        </div>
        <div class="svchall-list" id="svchall-list"></div>
        <div class="overlay-footer">
          <button class="overlay-close-btn" id="svchall-close">CLOSE</button>
        </div>
      </div>
    `;
    this._svchallPoints = screen.querySelector("#svchall-points");
    this._svchallList = screen.querySelector("#svchall-list");
    this._svchallSig = null;
    this._addListener(screen.querySelector("#svchall-close"), "click", () => {
      if (this._callbacks.onServiceHallClose) this._callbacks.onServiceHallClose();
    });
    root.appendChild(screen);
    this._screens.serviceHall = screen;
  }

  _syncServiceHall(s) {
    if (!this._svchallList) return;
    const d = s && s.serviceHall;
    if (!d) return;
    const sig = `${d.points}|${JSON.stringify(d.ranks || {})}`;
    if (sig === this._svchallSig) return;
    this._svchallSig = sig;
    this._svchallPoints.textContent = d.points || 0;
    let html = "";
    for (const u of d.upgrades || []) {
      const rank = u.rank || 0;
      const max = u.maxRank;
      const isMaxed = rank >= max;
      const cost = isMaxed ? null : u.nextCost;
      const canAfford = !isMaxed && d.points >= cost;
      const btnLabel = isMaxed ? "MAXED" : `BUY (${cost} pts)`;
      // Rank pips visualize current progress.
      let pips = "";
      for (let i = 0; i < max; i++) {
        pips += `<span class="svchall-pip ${i < rank ? "filled" : ""}"></span>`;
      }
      html += `
        <div class="svchall-row ${isMaxed ? "maxed" : ""}">
          <div class="svchall-row-head">
            <span class="svchall-name">${u.name}</span>
            <span class="svchall-rank">RANK ${rank}/${max}</span>
          </div>
          <div class="svchall-desc">${u.description}</div>
          <div class="svchall-pips-row">${pips}</div>
          <button class="svchall-buy-btn" data-key="${u.key}" ${isMaxed || !canAfford ? "disabled" : ""}>${btnLabel}</button>
        </div>
      `;
    }
    this._svchallList.innerHTML = html;
    for (const btn of this._svchallList.querySelectorAll(".svchall-buy-btn")) {
      this._addListener(btn, "click", () => {
        if (btn.disabled) return;
        const key = btn.dataset.key;
        if (this._callbacks.onServiceHallBuy) this._callbacks.onServiceHallBuy(key);
      });
    }
  }

  // ---- Career detail overlay (Tier 35) -----------------------------------

  _buildCareerDetail(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-careerdetail";
    screen.dataset.screen = "careerDetail";
    screen.innerHTML = `
      <div class="overlay-panel careerdetail-panel">
        <div class="panel-accent-rule"></div>
        <div class="cardtl-eyebrow" id="cardtl-eyebrow">CAREER ARCHIVE</div>
        <h2 id="cardtl-title">CAREER</h2>
        <div class="cardtl-rank" id="cardtl-rank">Officer</div>
        <p class="cardtl-epitaph" id="cardtl-epitaph"></p>
        <div class="cardtl-section">
          <div class="cardtl-section-title">FINAL TALLIES</div>
          <div class="cardtl-stats-grid" id="cardtl-stats"></div>
        </div>
        <div class="cardtl-section">
          <div class="cardtl-section-title">FULL LOG</div>
          <ul class="cardtl-log" id="cardtl-log"></ul>
        </div>
        <div class="overlay-footer">
          <button class="overlay-close-btn" id="cardtl-close">CLOSE</button>
        </div>
      </div>
    `;
    this._cardtlEyebrow = screen.querySelector("#cardtl-eyebrow");
    this._cardtlTitle = screen.querySelector("#cardtl-title");
    this._cardtlRank = screen.querySelector("#cardtl-rank");
    this._cardtlEpitaph = screen.querySelector("#cardtl-epitaph");
    this._cardtlStats = screen.querySelector("#cardtl-stats");
    this._cardtlLog = screen.querySelector("#cardtl-log");
    this._cardtlSig = null;
    this._addListener(screen.querySelector("#cardtl-close"), "click", () => {
      if (this._callbacks.onCareerDetailClose) this._callbacks.onCareerDetailClose();
    });
    root.appendChild(screen);
    this._screens.careerDetail = screen;
  }

  // ---- New-Career Confirm Overlay -----------------------------------------
  // Guard rail before abandoning an active Frontier officer. Shows the
  // current callsign + act so the player knows whose career they're
  // about to end. CONFIRM dispatches abandon-run + opens run setup;
  // CANCEL just hides the overlay.

  _buildNewCareerConfirm(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-newcareer-confirm";
    screen.dataset.screen = "newCareerConfirm";
    screen.innerHTML = `
      <div class="overlay-panel newcareer-confirm-panel">
        <div class="panel-accent-rule"></div>
        <div class="ncc-eyebrow">FRONTIER COMMAND</div>
        <h2 class="ncc-title">START A NEW CAREER?</h2>
        <p class="ncc-body" id="ncc-body">
          Your current officer will be discharged. Their fleet, perks,
          and ribbons close with them. Memorial wall keeps the name.
        </p>
        <div class="ncc-active" id="ncc-active"></div>
        <p class="ncc-warn">This cannot be undone.</p>
        <div class="overlay-footer ncc-footer">
          <button class="overlay-close-btn ncc-cancel" id="ncc-cancel">CANCEL</button>
          <button class="overlay-close-btn ncc-confirm" id="ncc-confirm">ABANDON &amp; START</button>
        </div>
      </div>
    `;
    this._nccActive = screen.querySelector("#ncc-active");
    this._nccSig = null;
    this._addListener(screen.querySelector("#ncc-cancel"), "click", () => {
      if (this._callbacks.onNewCareerCancel) this._callbacks.onNewCareerCancel();
    });
    this._addListener(screen.querySelector("#ncc-confirm"), "click", () => {
      if (this._callbacks.onNewCareerConfirm) this._callbacks.onNewCareerConfirm();
    });
    root.appendChild(screen);
    this._screens.newCareerConfirm = screen;
  }

  _syncNewCareerConfirm(s) {
    if (!this._nccActive) return;
    const d = s && s.newCareerConfirm;
    if (!d) return;
    const RANK_BY_ACT = {
      1: "Pilot Officer", 2: "Lieutenant", 3: "Lt. Commander",
      4: "Captain", 5: "Admiral",
    };
    const rank = RANK_BY_ACT[d.act] || "Officer";
    const sig = `${d.callsign}|${d.act}`;
    if (sig === this._nccSig) return;
    this._nccSig = sig;
    this._nccActive.innerHTML = `
      <div class="ncc-active-eyebrow">ACTIVE OFFICER</div>
      <div class="ncc-active-name">${rank} ${(d.callsign || "Unknown").toUpperCase()}</div>
      <div class="ncc-active-sub">Act ${d.act}/5</div>
    `;
  }

  _syncCareerDetail(s) {
    if (!this._cardtlStats) return;
    const d = s && s.careerDetail;
    if (!d) return;
    const sig = `${d.timestamp}|${d.callsign}|${d.rank}|${(d.log || []).length}`;
    if (sig === this._cardtlSig) return;
    this._cardtlSig = sig;
    const wonClass = d.result === "won" ? "career-won" : "career-lost";
    this._cardtlEyebrow.textContent = d.result === "won" ? "WAR WON" : "CAREER ENDED";
    this._cardtlEyebrow.className = `cardtl-eyebrow ${wonClass}`;
    this._cardtlTitle.textContent = (d.callsign || "UNKNOWN").toUpperCase();
    this._cardtlRank.textContent = (d.rank || "Officer").toUpperCase();
    this._cardtlEpitaph.textContent = d.epitaph || "";
    // Final tallies grid — pulled from snapshotted stats.
    const s2 = d.stats || {};
    const totalKills = Object.values(s2.shipsKilled || {}).reduce((a, b) => a + b, 0);
    const totalLost  = Object.values(s2.shipsLost   || {}).reduce((a, b) => a + b, 0);
    const stat = (label, value) =>
      `<div class="cardtl-stat-row"><span class="cardtl-stat-label">${label}</span><span class="cardtl-stat-value">${value}</span></div>`;
    this._cardtlStats.innerHTML = [
      stat("Nodes cleared", s2.nodesCleared || 0),
      stat("Battles", s2.battlesCleared || 0),
      stat("Elites", s2.elitesCleared || 0),
      stat("Bosses", s2.bossesKilled || 0),
      stat("Ships destroyed", totalKills),
      stat("Ships lost", totalLost),
      stat("Credits earned", s2.creditsEarned || 0),
      stat("Credits spent", s2.creditsSpent || 0),
      stat("Boons acquired", s2.boonsAcquired || 0),
      stat("Promotions", s2.promotionsEarned || 0),
      stat("Rivals down", s2.rivalsDefeated || 0),
      stat("Contracts complete", s2.contractsCompleted || 0),
    ].join("");
    // Full career log — every entry, not just the last 6.
    const log = Array.isArray(d.log) ? d.log : [];
    if (log.length === 0) {
      this._cardtlLog.innerHTML = '<li class="cardtl-log-empty">No entries recorded.</li>';
    } else {
      this._cardtlLog.innerHTML = log.map((l) => {
        const kind = String(l.kind || "note");
        return `<li class="cardtl-log-line cardtl-log-${kind}"><span class="cardtl-log-act">A${l.act}</span> ${l.text}</li>`;
      }).join("");
    }
  }

  // ---- Captain detail overlay (Tier 32) -----------------------------------

  _buildCaptainDetail(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-captaindetail";
    screen.dataset.screen = "captainDetail";
    screen.innerHTML = `
      <div class="overlay-panel captaindetail-panel">
        <div class="panel-accent-rule"></div>
        <div class="cdtl-eyebrow" id="cdtl-eyebrow">CAPTAIN'S DOSSIER</div>
        <div class="cdtl-namerow">
          <h2 id="cdtl-shipname">Capital Ship</h2>
          <button class="cdtl-rename-btn" id="cdtl-rename-ship" title="Rename ship">✎</button>
        </div>
        <div class="cdtl-class" id="cdtl-class">Frigate</div>
        <div class="cdtl-divider"></div>
        <div class="cdtl-namerow">
          <div class="cdtl-captain" id="cdtl-captain">Captain Name</div>
          <button class="cdtl-rename-btn" id="cdtl-rename-captain" title="Rename captain">✎</button>
        </div>
        <div class="cdtl-trait-row">
          <span class="cdtl-trait" id="cdtl-trait">VETERAN</span>
          <span class="cdtl-title" id="cdtl-title">Veteran</span>
        </div>
        <div class="cdtl-trait-blurb" id="cdtl-trait-blurb"></div>
        <div class="cdtl-effect" id="cdtl-effect"></div>
        <div class="cdtl-section" id="cdtl-behavior-section">
          <div class="cdtl-section-title">PRE-BATTLE BEHAVIOR</div>
          <div class="cdtl-behavior-chips" id="cdtl-behavior-chips">
            <button class="cdtl-behavior-chip" data-behavior="default">FLEET</button>
            <button class="cdtl-behavior-chip" data-behavior="press">PRESS</button>
            <button class="cdtl-behavior-chip" data-behavior="hold">HOLD</button>
            <button class="cdtl-behavior-chip" data-behavior="flank">FLANK</button>
            <button class="cdtl-behavior-chip" data-behavior="screen">SCREEN</button>
          </div>
          <div class="cdtl-behavior-desc" id="cdtl-behavior-desc"></div>
        </div>
        <div class="cdtl-section">
          <div class="cdtl-section-title">EXPERIENCE</div>
          <div class="cdtl-xp-row">
            <span class="cdtl-level">LVL <span id="cdtl-level">1</span></span>
            <span class="cdtl-xp-text" id="cdtl-xp-text">0 XP</span>
          </div>
          <div class="cdtl-xp-bar-bg">
            <div class="cdtl-xp-bar-fill" id="cdtl-xp-bar"></div>
          </div>
        </div>
        <div class="cdtl-section" id="cdtl-perks-section">
          <div class="cdtl-section-title">PERKS</div>
          <div class="cdtl-perks" id="cdtl-perks"></div>
        </div>
        <div class="cdtl-section" id="cdtl-bonus-section">
          <div class="cdtl-section-title">BONUS</div>
          <div class="cdtl-bonus" id="cdtl-bonus">+0% hull</div>
        </div>
        <div class="cdtl-section" id="cdtl-hull-section">
          <div class="cdtl-section-title">HULL</div>
          <div class="cdtl-hp-row">
            <span class="cdtl-hp-text" id="cdtl-hp-text">100%</span>
          </div>
          <div class="cdtl-hp-bar-bg">
            <div class="cdtl-hp-bar-fill" id="cdtl-hp-bar"></div>
          </div>
        </div>
        <div class="overlay-footer">
          <button class="overlay-close-btn" id="cdtl-close">CLOSE</button>
        </div>
      </div>
    `;
    this._cdtlShipName = screen.querySelector("#cdtl-shipname");
    this._cdtlClass = screen.querySelector("#cdtl-class");
    this._cdtlCaptain = screen.querySelector("#cdtl-captain");
    this._cdtlTrait = screen.querySelector("#cdtl-trait");
    this._cdtlTitle = screen.querySelector("#cdtl-title");
    this._cdtlTraitBlurb = screen.querySelector("#cdtl-trait-blurb");
    this._cdtlEffect = screen.querySelector("#cdtl-effect");
    this._cdtlBehaviorChips = screen.querySelector("#cdtl-behavior-chips");
    this._cdtlBehaviorDesc = screen.querySelector("#cdtl-behavior-desc");
    this._cdtlLevel = screen.querySelector("#cdtl-level");
    this._cdtlXpText = screen.querySelector("#cdtl-xp-text");
    this._cdtlXpBar = screen.querySelector("#cdtl-xp-bar");
    this._cdtlBonus = screen.querySelector("#cdtl-bonus");
    this._cdtlHpText = screen.querySelector("#cdtl-hp-text");
    this._cdtlHpBar = screen.querySelector("#cdtl-hp-bar");
    this._cdtlEyebrow = screen.querySelector("#cdtl-eyebrow");
    this._cdtlPerks = screen.querySelector("#cdtl-perks");
    this._cdtlPerksSection = screen.querySelector("#cdtl-perks-section");
    this._cdtlBehaviorSection = screen.querySelector("#cdtl-behavior-section");
    this._cdtlBonusSection = screen.querySelector("#cdtl-bonus-section");
    this._cdtlHullSection = screen.querySelector("#cdtl-hull-section");
    this._cdtlRenameShip = screen.querySelector("#cdtl-rename-ship");
    this._cdtlRenameCaptain = screen.querySelector("#cdtl-rename-captain");
    this._cdtlSig = null;
    this._addListener(screen.querySelector("#cdtl-close"), "click", () => {
      if (this._callbacks.onCaptainDetailClose) this._callbacks.onCaptainDetailClose();
    });
    // Behavior chip handlers — clicking sets per-capital behavior.
    for (const chip of this._cdtlBehaviorChips.querySelectorAll(".cdtl-behavior-chip")) {
      this._addListener(chip, "click", () => {
        if (this._callbacks.onSetCapitalBehavior) {
          this._callbacks.onSetCapitalBehavior(chip.dataset.behavior);
        }
      });
    }
    // Rename triggers — prompt() is intentionally simple for v1.
    // A custom modal could replace this later without changing the API.
    this._addListener(screen.querySelector("#cdtl-rename-ship"), "click", () => {
      const current = this._cdtlShipName.textContent || "";
      const next = window.prompt("Rename ship:", current);
      if (next && next.trim() && next !== current && this._callbacks.onRenameCapital) {
        this._callbacks.onRenameCapital({ name: next.trim() });
      }
    });
    this._addListener(screen.querySelector("#cdtl-rename-captain"), "click", () => {
      const current = this._cdtlCaptain.textContent || "";
      const next = window.prompt("Rename captain:", current);
      if (next && next.trim() && next !== current && this._callbacks.onRenameCapital) {
        this._callbacks.onRenameCapital({ captain: next.trim() });
      }
    });
    root.appendChild(screen);
    this._screens.captainDetail = screen;
  }

  _syncCaptainDetail(s) {
    const d = s && s.captainDetail;
    if (!d) return;
    const sig = JSON.stringify(d);
    if (sig === this._cdtlSig) return;
    this._cdtlSig = sig;
    const isWing = d.kind === "wing";
    // Toggle capital-only sections + rename buttons for wing commanders.
    const setDisp = (el, on) => { if (el) el.style.display = on ? "" : "none"; };
    setDisp(this._cdtlBehaviorSection, !isWing);
    setDisp(this._cdtlBonusSection, !isWing);
    setDisp(this._cdtlHullSection, !isWing);
    setDisp(this._cdtlRenameShip, !isWing);
    setDisp(this._cdtlRenameCaptain, !isWing);
    if (this._cdtlEyebrow) this._cdtlEyebrow.textContent = isWing ? "WING COMMANDER" : "CAPTAIN'S DOSSIER";
    // Perks (both kinds).
    if (this._cdtlPerks) {
      const perks = d.perks || [];
      this._cdtlPerks.innerHTML = perks.length
        ? perks.map((p) => `<div class="cdtl-perk"><span class="cdtl-perk-name">${p.name}</span><span class="cdtl-perk-blurb">${p.blurb}</span></div>`).join("")
        : `<div class="cdtl-perk-empty">${d.pendingPerks > 0 ? "Perk pick available — choose it in the COMMANDERS list." : "No perks yet — earned on level-up."}</div>`;
    }
    const klassLabel = ({
      frigate: "Frigate", cruiser: "Cruiser",
      battleship: "Battleship", carrier: "Carrier",
    })[d.shipKlass] || d.shipKlass;
    this._cdtlShipName.textContent = d.shipName || klassLabel;
    if (isWing) {
      this._cdtlClass.innerHTML = `${(d.shipKlass || "").toUpperCase()} WING`;
      this._cdtlCaptain.textContent = d.wingName ? `${d.wingName} Wing` : "";
    } else {
      // Variant chip (Tier 40) appended to the class line if set.
      const variantLabel = d.variant
        ? ({ heavy:"HEAVY", hunter:"HUNTER", siege:"SIEGE", skirmisher:"SKIRMISHER",
             bulwark:"BULWARK", aggressor:"AGGRESSOR", hangar:"HANGAR", patrol:"PATROL"
           })[d.variant] || d.variant.toUpperCase()
        : null;
      this._cdtlClass.innerHTML = `${klassLabel.toUpperCase()}${variantLabel ? ` · <span class="cdtl-variant">${variantLabel}</span>` : ""}`;
      this._cdtlCaptain.textContent = d.captain || "";
    }
    this._cdtlTrait.textContent = (d.trait || "").toUpperCase();
    this._cdtlTitle.textContent = d.title || "—";
    this._cdtlTraitBlurb.textContent = d.traitBlurb || "";
    if (this._cdtlEffect) {
      if (d.effectLabel) {
        this._cdtlEffect.innerHTML = `<span class="cdtl-effect-label">BATTLE EFFECT</span> ${d.effectLabel}`;
        this._cdtlEffect.style.display = "block";
      } else {
        this._cdtlEffect.innerHTML = "";
        this._cdtlEffect.style.display = "none";
      }
    }
    // Behavior chip selection + description.
    if (this._cdtlBehaviorChips) {
      const active = d.behavior || "default";
      for (const chip of this._cdtlBehaviorChips.querySelectorAll(".cdtl-behavior-chip")) {
        chip.classList.toggle("active", chip.dataset.behavior === active);
      }
      const desc = {
        "default": "Follows the fleet doctrine for this battle.",
        "press":   "Close-quarters — orbit -25%, +10% damage.",
        "hold":    "Stand-off — orbit +35%, shields +15%.",
        "flank":   "Wide orbit, approach from the quarter — +20% turn rate.",
        "screen":  "Stay near other capitals — +25% shield regen, slower.",
      }[active];
      if (this._cdtlBehaviorDesc) this._cdtlBehaviorDesc.textContent = desc || "";
    }
    this._cdtlLevel.textContent = d.level;
    // XP bar — fill from prev threshold to next threshold.
    const xp = d.xp || 0;
    const nextXp = d.nextXp;
    const prevXp = (() => {
      const table = [0, 3, 8, 16, 28];
      return table[Math.max(0, d.level - 1)] || 0;
    })();
    if (nextXp != null) {
      const span = Math.max(1, nextXp - prevXp);
      const into = Math.max(0, xp - prevXp);
      const pct = Math.min(100, Math.round((into / span) * 100));
      this._cdtlXpBar.style.width = `${pct}%`;
      this._cdtlXpText.textContent = `${xp} / ${nextXp} XP`;
    } else {
      this._cdtlXpBar.style.width = "100%";
      this._cdtlXpText.textContent = `${xp} XP · MAX`;
    }
    this._cdtlBonus.textContent = d.hpBonusPct > 0 ? `+${d.hpBonusPct}% hull at spawn` : "(no bonus yet)";
    const hpPct = Math.round((d.hpFrac || 0) * 100);
    this._cdtlHpBar.style.width = `${hpPct}%`;
    this._cdtlHpBar.className = hpPct > 60 ? "cdtl-hp-bar-fill hp-high"
                              : hpPct > 30 ? "cdtl-hp-bar-fill hp-mid"
                              : "cdtl-hp-bar-fill hp-low";
    this._cdtlHpText.textContent = `${hpPct}%`;
  }

  // ---- Jump encounter overlay (Tier 22) -----------------------------------

  _buildJumpEncounter(root) {
    const screen = document.createElement("div");
    screen.className = "menu-screen menu-dispatch menu-jumpencounter";
    screen.dataset.screen = "jumpEncounter";
    screen.innerHTML = `
      <div class="overlay-panel dispatch-panel jumpencounter-panel">
        <div class="panel-accent-rule"></div>
        <div class="dispatch-static-row">
          <span class="dispatch-static-dot"></span>
          <span class="dispatch-eyebrow" id="je-eyebrow">JUMP — INCIDENT</span>
        </div>
        <h2 id="je-title">ENCOUNTER</h2>
        <p class="dispatch-text" id="je-text"></p>
        <div class="jumpencounter-reward" id="je-reward"></div>
        <div class="overlay-footer">
          <button class="menu-btn start-btn" id="je-proceed">ACKNOWLEDGE</button>
        </div>
      </div>
    `;
    this._jeEyebrow = screen.querySelector("#je-eyebrow");
    this._jeTitle = screen.querySelector("#je-title");
    this._jeText = screen.querySelector("#je-text");
    this._jeReward = screen.querySelector("#je-reward");
    this._jeProceedBtn = screen.querySelector("#je-proceed");
    this._jeSig = null;
    this._addListener(this._jeProceedBtn, "click", () => {
      if (this._callbacks.onJumpEncounterDismiss) this._callbacks.onJumpEncounterDismiss();
    });
    root.appendChild(screen);
    this._screens.jumpEncounter = screen;
  }

  _syncJumpEncounter(s) {
    const e = s && s.jumpEncounter;
    if (!e) return;
    const sig = `${e.key}:${(e.body || "").slice(0, 48)}`;
    if (sig === this._jeSig) return;
    this._jeSig = sig;
    this._jeEyebrow.textContent = "MID-JUMP · " + (e.headline || "ENCOUNTER");
    const speakerLabel =
      e.speaker === "wingman"     ? "WING"    :
      e.speaker === "engineering" ? "ENGINEERING" :
      e.speaker === "intercept"   ? "INTERCEPT" :
      e.speaker === "voidsworn"   ? "VOIDSWORN" :
      e.speaker === "ally"        ? "ALLY"    :
      e.speaker === "command"     ? "COMMAND" : "INCIDENT";
    this._jeTitle.textContent = speakerLabel;
    this._screens.jumpEncounter.querySelector(".jumpencounter-panel").className =
      `overlay-panel dispatch-panel jumpencounter-panel dispatch-${e.speaker || "intercept"}`;
    this._jeText.textContent = e.body || "";
    // Reward chips — null/0 values hidden so a no-stakes encounter
    // doesn't show an empty chip row.
    const reward = e.reward || {};
    const chips = [];
    if (reward.credits > 0) chips.push(`+${reward.credits} credits`);
    if (reward.credits < 0) chips.push(`${reward.credits} credits`);
    if (reward.fuel > 0)    chips.push(`+${reward.fuel} fuel`);
    if (reward.fuel < 0)    chips.push(`${reward.fuel} fuel`);
    if (reward.fighter > 0) chips.push(`+${reward.fighter} fighter`);
    if (reward.bomber > 0)  chips.push(`+${reward.bomber} bomber`);
    if (chips.length > 0) {
      this._jeReward.textContent = chips.join(" · ");
      this._jeReward.style.display = "block";
    } else {
      this._jeReward.textContent = "";
      this._jeReward.style.display = "none";
    }
  }

  _syncDispatch(s) {
    const d = s && s.dispatch;
    if (!d) return;
    const sig = `${d.act}:${d.speaker}:${(d.text || "").slice(0, 48)}`;
    if (sig === this._dispatchSig) return;
    this._dispatchSig = sig;
    this._dispatchEyebrow.textContent = d.eyebrow || "INCOMING TRANSMISSION";
    // Title shows speaker tag — COMMAND / WING / VOIDSWORN / etc.
    const speakerLabel =
      d.speaker === "command"     ? "COMMAND" :
      d.speaker === "friend"      ? "FRIEND" :
      d.speaker === "ally"        ? "CONTACT" :
      d.speaker === "intercept"   ? "INTERCEPT" :
      d.speaker === "voidsworn"   ? "VOIDSWORN" :
      d.speaker === "engineering" ? "ENGINEERING" : "TRANSMISSION";
    this._dispatchTitle.textContent = speakerLabel;
    // Apply tone class so the panel border tints per speaker.
    this._screens.dispatch.querySelector(".dispatch-panel").className =
      `overlay-panel dispatch-panel dispatch-${d.speaker || "command"}`;
    this._dispatchText.textContent = d.text || "";
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

    // Cache achievements for the lazy-render in _renderAchievementsPanel.
    if (menuState.achievements) {
      this._achievementsData = menuState.achievements;
    }

    // --- Main menu chips (build once, then update selection) ---
    this._syncMainMenuChips(menuState);
    this._syncHome(menuState);
    // Tier 44 — play hub + skirmish config.
    if (this._syncPlayHub) this._syncPlayHub(menuState);
    if (this._syncSkirmishConfig) this._syncSkirmishConfig(menuState);

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
    this._syncBattlePlan(menuState);
    this._syncFleetPlan(menuState);

    // --- Resupply ---
    this._syncResupply(menuState);

    // --- Event ---
    this._syncEvent(menuState);

    // --- Promotion ---
    this._syncPromotion(menuState);

    // --- Preamble (act-intro war-state briefing) ---
    this._syncPreamble(menuState);

    // --- Dispatch (radio transmission, post-preamble) ---
    this._syncDispatch(menuState);

    // --- Jump encounter (mid-jump beat) ---
    this._syncJumpEncounter(menuState);

    // --- Run stats overlay ---
    this._syncRunStats(menuState);

    // --- Captain detail overlay ---
    this._syncCaptainDetail(menuState);

    // --- Career detail overlay (clicked memorial entry) ---
    this._syncCareerDetail(menuState);

    // --- Service Hall overlay ---
    this._syncServiceHall(menuState);

    // --- New-career confirm overlay ---
    this._syncNewCareerConfirm(menuState);

    // --- Memorial wall ---
    this._syncMemorial(menuState);

    // --- Shipyard (design-your-own-ship) ---
    this._lastMenuState = menuState;
    this._syncShipyard(menuState);
  }

  _syncHome(s) {
    if (!this._homeAvatarRank) return;
    const meta = (s && s.runState && s.runState.meta) || null;
    const run = (s && s.runState && s.runState.run) || null;
    const sy = (s && s.shipyard) || null;
    const sig = [
      run ? `${run.callsign}|${run.act}|${run.resources && run.resources.credits}` : "no-run",
      meta ? `${meta.servicePoints || 0}|${meta.runsCompleted || 0}` : "no-meta",
      sy ? `${sy.credits}|${sy.hullId}|${sy.shipName}` : "no-ship",
    ].join("::");
    if (sig === this._homeSyncSig) return;
    this._homeSyncSig = sig;
    // Avatar — rank + callsign from active run, fallback to history.
    if (run) {
      const rank = (s.runState && s.runState.run && ((s.runState.run.act && s.runState.run.act >= 1)))
        ? ((s.runState && s.runState.run && s.runState.run.act)) : 1;
      // Use ACT_RANKS lookup if accessible via menuState's frontier hint; else
      // simple act-to-rank.
      const RANK_BY_ACT = {1:"PILOT OFFICER",2:"LIEUTENANT",3:"LT. COMMANDER",4:"CAPTAIN",5:"ADMIRAL"};
      this._homeAvatarRank.textContent = RANK_BY_ACT[run.act] || "OFFICER";
      this._homeAvatarCallsign.textContent = (run.callsign || "UNKNOWN").toUpperCase();
      this._homeCurrCredits.textContent = String(run.resources && run.resources.credits || 0);
      this._homeCardSub.textContent = `Act ${run.act}/5 · ${RANK_BY_ACT[run.act] || "Officer"} ${run.callsign || ""}`.trim();
      this._homeCtaPrimary.textContent = "RESUME";
      // Secondary CTA = NEW CAREER (opens the confirm overlay before
      // wiping the active officer). Only surfaces with an active run.
      this._homeCtaSecondary.textContent = "NEW CAREER";
      this._homeCtaSecondary.style.display = "";
    } else {
      // No active run — show last-completed run's rank if any.
      const lastRun = meta && meta.memorial && meta.memorial[0];
      if (lastRun) {
        this._homeAvatarRank.textContent = (lastRun.rank || "Officer").toUpperCase();
        this._homeAvatarCallsign.textContent = (lastRun.callsign || "—").toUpperCase();
      } else {
        this._homeAvatarRank.textContent = "PILOT OFFICER";
        this._homeAvatarCallsign.textContent = "— NO CAREER —";
      }
      this._homeCurrCredits.textContent = "—";
      this._homeCardSub.textContent = "Begin a career as a Terran officer.";
      this._homeCtaPrimary.textContent = "NEW CAREER";
      this._homeCtaSecondary.style.display = "none";
    }
    this._homeCurrService.textContent = String(meta && meta.servicePoints || 0);
    // Shipyard card — name, hull, credit balance.
    if (this._homeShipyardName && s && s.shipyard) {
      this._homeShipyardName.textContent = s.shipyard.shipName || "ISS Spectre";
      this._homeShipyardHull.textContent = s.shipyard.hullLabel || "Fighter";
      this._homeShipyardCredits.textContent = String(s.shipyard.credits || 0);
    }
    // Achievements progress chip (Tier 43).
    if (this._homeAvatarProgress) {
      const total = (s.achievements && s.achievements.list && s.achievements.list.length) || 0;
      const unlocked = (s.achievements && s.achievements.unlocked && s.achievements.unlocked.length) || 0;
      this._homeAvatarProgress.textContent = `✦ ${unlocked}/${total}`;
    }
  }

  _syncMemorial(s) {
    if (!this._memorialList) return;
    const entries = (s && s.memorial) || [];
    const sig = entries.map((e) => `${e.callsign}|${e.rank}|${e.epitaph || ""}`).join("\n");
    if (sig === this._memorialSig) return;
    this._memorialSig = sig;
    if (entries.length === 0) {
      this._memorialList.innerHTML = `<div class="memorial-empty">No careers complete. Be the first.</div>`;
      return;
    }
    const rows = entries.map((e, idx) => {
      const rankRaw = e.rank || "Officer";
      const rank = rankRaw.toUpperCase();
      const callsign = (e.callsign || "UNKNOWN").toUpperCase();
      const epitaph = e.epitaph || "Career closed.";
      const cls = e.result === "lost" ? "memorial-row lost" : "memorial-row";
      const resultBadge = e.result === "lost"
        ? `<span class="memorial-result-badge lost" title="Career lost">KIA</span>`
        : `<span class="memorial-result-badge won"  title="War won">VICTOR</span>`;
      // Memoir snippet — last few career-log entries from this run.
      // Acts as a "what happened" summary distinct from the epitaph.
      let memoirHtml = "";
      if (Array.isArray(e.log) && e.log.length > 0) {
        const shown = e.log.slice(-6);
        memoirHtml = '<ul class="memorial-row-memoir">';
        for (const l of shown) {
          const kind = String(l.kind || "note");
          memoirHtml += `<li class="memoir-line memoir-${kind}"><span class="memoir-act">A${l.act}</span> ${l.text}</li>`;
        }
        memoirHtml += "</ul>";
      }
      return `
        <div class="${cls} memorial-clickable" data-memorial-idx="${idx}" title="Tap for full career detail">
          <div class="memorial-row-header">
            <span class="memorial-rank-insignia" title="${rankRaw}">${rankInsigniaSvg(rankRaw)}</span>
            <div class="memorial-row-identity">
              <div class="memorial-row-rank">${rank}</div>
              <div class="memorial-row-callsign">${callsign}</div>
            </div>
            ${resultBadge}
          </div>
          <div class="memorial-row-epitaph">${epitaph}</div>
          ${memoirHtml}
          <div class="memorial-row-hint">Tap for full career →</div>
        </div>
      `;
    });
    this._memorialList.innerHTML = rows.join("");
    // Wire click handlers — each row opens the career-detail overlay.
    for (const row of this._memorialList.querySelectorAll(".memorial-clickable")) {
      this._addListener(row, "click", () => {
        const idx = parseInt(row.dataset.memorialIdx, 10);
        if (Number.isFinite(idx) && this._callbacks.onMemorialEntryClick) {
          this._callbacks.onMemorialEntryClick(idx);
        }
      });
    }
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

    // Track active mode so the carousel knows which intermediate steps
    // to skip. Frontier and Custom run their own deeper setup.
    const modeChanged = this._lastSelectedMode !== s.selectedMode;
    this._lastSelectedMode = s.selectedMode;
    // If we switched modes while sitting on a step that the new mode
    // skips, slide back to the start so the carousel doesn't get stuck
    // on a hidden step.
    if (modeChanged && this._mainStepEls) {
      const visible = this._visibleMainSteps();
      if (!visible.includes(this._mainStep)) this._gotoMainStep(visible[0]);
      else this._gotoMainStep(this._mainStep); // refresh dots / label
    }

    // Populate the review step.
    if (this._mainReviewEl) this._renderMainReview(s);
  }

  // Build the review-step summary so the player can sanity-check the
  // matchup before tapping DEPLOY. Renders a compact "key: value" list
  // of whatever options the active mode actually consumed.
  _renderMainReview(s) {
    const mode = s.selectedMode;
    const rows = [];
    const modeMeta = (s.modeOptions || []).find((m) => m.key === mode);
    rows.push({ k: "MODE", v: modeMeta ? modeMeta.label : mode });
    if (mode !== "roguelite") {
      const size = (s.mapSizes || []).find((sz) => sz.key === s.selectedSize);
      if (size) rows.push({ k: "MAP", v: `${size.label} · ${size.mapW} × ${size.mapH}` });
    }
    if (mode !== "roguelite" && mode !== "custom") {
      const race = s.races ? s.races[s.selectedRace] : null;
      if (race) rows.push({ k: "FACTION", v: race.name });
      const fleet = (s.fleetOptions || []).find((f) => f.key === s.selectedFleet);
      if (fleet) rows.push({ k: "FLEET", v: `${fleet.label} (×${fleet.mul})` });
    }
    this._mainReviewEl.innerHTML = rows.map(
      (r) => `<div class="main-review-row"><span class="main-review-k">${r.k}</span><span class="main-review-v">${r.v}</span></div>`
    ).join("");
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
    const st = s.settings || {};
    const muted = st.musicMuted || st.musicVolume === 0;
    const dot = this._settingsBtn.querySelector(".settings-mute-dot");
    if (dot) dot.style.display = muted ? "inline-block" : "none";
  }

  // ---- sync: Settings sliders ---------------------------------------------

  _syncSettings(s) {
    const st = s.settings || {};
    this._syncSlider(this._settingsMusicSlider, this._settingsMusicVal, st.musicVolume, st.musicMuted);
    this._syncSlider(this._settingsSfxSlider, this._settingsSfxVal, st.sfxVolume, st.sfxMuted);
  }

  // Reflect persisted volume on the slider, but DON'T stomp the value
  // while the user is actively dragging it (the slider would jump under
  // their finger). The % readout + muted styling always track state.
  _syncSlider(slider, valEl, vol, muted) {
    if (!slider) return;
    const pct = Math.round((typeof vol === "number" ? vol : 0) * 100);
    if (document.activeElement !== slider) slider.value = String(pct);
    slider.style.setProperty("--fill", pct + "%");
    if (valEl) valEl.textContent = pct + "%";
    const row = slider.closest(".settings-slider-row");
    if (row) row.classList.toggle("muted", pct === 0 || !!muted);
  }

  _syncToggle(el, isOn) {
    if (!el) return;
    const valueEl = el.querySelector(".toggle-value");
    el.classList.toggle("off", !isOn);
    el.setAttribute("aria-pressed", isOn ? "true" : "false");
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
    if (!custom || !s.raceKeys) return;

    const accents = { allied: "#5af", hostile: "#f55" };
    const MAX_TEAMS_PER_SIDE = 2;

    const renderSide = (sideKey, teamsArr, listEl, addBtnEl, totalEl) => {
      // Reconcile DOM blocks to match the team count for this side.
      // Each block owns a race-chip row, a sliders block, and (for
      // slots past the first) a REMOVE button.
      const tracked = this._customTeamBlocks[sideKey];
      // Tear down extras.
      while (tracked.length > teamsArr.length) {
        const blk = tracked.pop();
        if (blk && blk.root && blk.root.parentNode) blk.root.parentNode.removeChild(blk.root);
      }
      // Build missing.
      while (tracked.length < teamsArr.length) {
        const idx = tracked.length;
        const block = document.createElement("div");
        block.className = "custom-team-block";
        block.innerHTML = `
          <div class="custom-team-header">
            <span class="custom-team-label">FACTION ${idx + 1}</span>
            <span class="custom-team-name"></span>
            <button class="custom-team-remove" type="button" aria-label="Remove this faction">&times;</button>
          </div>
          <div class="custom-team-races"></div>
          <div class="custom-team-sliders"></div>
        `;
        const racesEl = block.querySelector(".custom-team-races");
        const slidersEl = block.querySelector(".custom-team-sliders");
        const removeBtn = block.querySelector(".custom-team-remove");
        // Race chips for this slot.
        for (const k of s.raceKeys) {
          const chip = document.createElement("button");
          chip.className = "chip-item chip-sm";
          chip.dataset.key = k;
          chip.textContent = s.races[k] ? s.races[k].name : k;
          this._addListener(chip, "click", () => {
            if (this._callbacks.onCustomRaceSelect) this._callbacks.onCustomRaceSelect(sideKey, k, idx);
          });
          racesEl.appendChild(chip);
        }
        // Sliders (one set per faction so per-faction fleet sizes work).
        this._buildSliders(slidersEl, sideKey, accents[sideKey], custom, idx);
        // Remove (slot 1 always present; UI hides its button via CSS).
        this._addListener(removeBtn, "click", () => {
          if (this._callbacks.onCustomRemoveTeam) this._callbacks.onCustomRemoveTeam(sideKey, idx);
        });
        listEl.appendChild(block);
        tracked.push({ root: block, racesEl, slidersEl, removeBtn, nameEl: block.querySelector(".custom-team-name") });
      }
      // Sync each block to its team data.
      for (let i = 0; i < teamsArr.length; i++) {
        const team = teamsArr[i];
        const blk = tracked[i];
        const race = s.races[team.race];
        blk.nameEl.textContent = race ? race.name : team.race;
        for (const chip of blk.racesEl.children) {
          chip.classList.toggle("selected", chip.dataset.key === team.race);
        }
        this._updateSliders(blk.slidersEl, team.counts || {});
        // Hide the X on the first slot \u2014 every side must keep one
        // faction. CSS could do this with :first-child, but we toggle
        // an attribute so future styles (e.g. dim it) stay easy.
        blk.removeBtn.style.visibility = (i === 0) ? "hidden" : "";
      }
      // Side total + Add button gating.
      const sideTotal = teamsArr.reduce(
        (n, t) => n + Object.values(t.counts || {}).reduce((a, b) => a + (b || 0), 0),
        0,
      );
      totalEl.textContent = `${sideTotal} ships`;
      addBtnEl.style.display = teamsArr.length >= MAX_TEAMS_PER_SIDE ? "none" : "";
    };

    renderSide("allied",  custom.blueTeams  || [], this._customAlliedTeamsEl,  this._customAlliedAddBtn,  this._customAlliedTotal);
    renderSide("hostile", custom.redTeams   || [], this._customHostileTeamsEl, this._customHostileAddBtn, this._customHostileTotal);

    // Grand total + heat colour.
    const blueTotal  = (custom.blueTeams  || []).reduce((n, t) => n + Object.values(t.counts || {}).reduce((a, b) => a + (b || 0), 0), 0);
    const redTotal   = (custom.redTeams   || []).reduce((n, t) => n + Object.values(t.counts || {}).reduce((a, b) => a + (b || 0), 0), 0);
    const grand = blueTotal + redTotal;
    let totalsColor = "#9bd";
    if (grand > 400) totalsColor = "#f97";
    else if (grand > 200) totalsColor = "#fc8";
    this._customGrandTotal.textContent = `Total fleet \u00b7 ${grand} ships`;
    this._customGrandTotal.style.color = totalsColor;

    // Review-step summary lines: per-side faction breakdown so the
    // player can sanity-check the matchup before launching without
    // having to step back through both editor pages.
    const fmtSide = (teams) => {
      if (!teams || teams.length === 0) return "no fleet";
      return teams.map((t) => {
        const race = s.races && s.races[t.race] ? s.races[t.race].name : t.race;
        const n = Object.values(t.counts || {}).reduce((a, b) => a + (b || 0), 0);
        return `${race} \u00d7 ${n}`;
      }).join("  \u00b7  ");
    };
    if (this._customReviewAllied) this._customReviewAllied.textContent = fmtSide(custom.blueTeams);
    if (this._customReviewHostile) this._customReviewHostile.textContent = fmtSide(custom.redTeams);
    if (this._customReviewAlliedTotal) this._customReviewAlliedTotal.textContent = `${blueTotal} ships`;
    if (this._customReviewHostileTotal) this._customReviewHostileTotal.textContent = `${redTotal} ships`;
  }

  _buildSliders(container, side, accent, custom, teamIdx = 0) {
    container.innerHTML = "";
    container.dataset.teamIdx = String(teamIdx);
    const classes = custom.classes || CUSTOM_CLASSES;
    for (const klass of classes) {
      const row = document.createElement("div");
      row.className = "slider-row";
      row.dataset.klass = klass;
      const name = (custom.classNames || CLASS_LABELS)[klass] || klass;
      row.innerHTML = `
        <span class="slider-glyph" title="${CLASS_SHORT_LABELS[klass] || klass}">${classIconSvg(klass, { size: 22 })}</span>
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
          // teamIdx is the per-side faction slot (0 or 1). Slot is
          // hung off the container so a callback fires for the right
          // team even after re-renders.
          const idx = container && container.dataset ? parseInt(container.dataset.teamIdx || "0", 10) : 0;
          this._callbacks.onCustomSliderChange(side, klass, parseInt(input.value, 10), idx);
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
    // Faction + callsign are static — career is Terran-locked and the
    // textbox holds its own value. The only dynamic block is the
    // starter-perk row, which depends on which perks the player has
    // unlocked. We rebuild the chip strip whenever the unlocked set
    // changes (cheap; ≤4 chips), and reset the selected perk if it
    // no longer matches a valid option.
    if (!this._runsetupPerkChips) return;
    const runSetup = (s && s.runSetup) || { perks: [] };
    const perks = runSetup.perks || [];

    // Build the option list: always include "NONE" at the front, then
    // each unlocked perk.
    const options = [{ key: null, name: "(NONE)", desc: "No perk — earn one by surviving a career." }];
    for (const p of perks) options.push(p);

    // Reset selection if it no longer maps to an available option —
    // protects against a stale perk key after a save migration.
    if (this._runsetupSelectedPerk !== null &&
        !options.some((o) => o.key === this._runsetupSelectedPerk)) {
      this._runsetupSelectedPerk = null;
    }

    // Cheap rebuild: drop a hash so we only re-render when the set
    // actually changed.
    const sig = options.map((o) => o.key || "_none").join("|");
    if (this._runsetupPerkSig !== sig) {
      this._runsetupPerkSig = sig;
      this._runsetupPerkChips.innerHTML = "";
      for (const opt of options) {
        const btn = document.createElement("button");
        btn.className = "runsetup-perk-chip";
        btn.dataset.perkKey = opt.key || "";
        btn.dataset.perkDesc = opt.desc || "";
        btn.textContent = opt.name;
        this._addListener(btn, "click", () => {
          this._runsetupSelectedPerk = opt.key;
          this._syncRunSetupChipState(options);
        });
        this._runsetupPerkChips.appendChild(btn);
      }
    }
    this._syncRunSetupChipState(options);
  }

  _syncRunSetupChipState(options) {
    if (!this._runsetupPerkChips) return;
    const chips = this._runsetupPerkChips.querySelectorAll(".runsetup-perk-chip");
    let activeDesc = "";
    for (const btn of chips) {
      const key = btn.dataset.perkKey || null;
      const active = key === this._runsetupSelectedPerk;
      btn.classList.toggle("active", active);
      if (active) activeDesc = btn.dataset.perkDesc || "";
    }
    if (this._runsetupPerkDesc) {
      this._runsetupPerkDesc.textContent = activeDesc ||
        (options.length <= 1
          ? "No perk — earn one by surviving a career."
          : "Pick a starter perk.");
    }
  }

  // ---- sync: Battle Choice ------------------------------------------------

  _syncBattleChoice(s) {
    const node = s.battleNode;
    if (!node) return;
    const race = s.races ? s.races[node.bossFaction || node.faction] : null;
    const raceName = race ? race.name : (node.faction || "Unknown");
    const tier = node.tier || 1;
    const tierLabel = tier === 1 ? "Standard" : tier === 2 ? "Elite" : "Boss";

    // Default doctrine pre-selected so the player sees a chip lit
    // even if they don't touch the picker.
    if (this._battleDoctrine && !this._battleDoctrine.dataset.synced) {
      const skirmish = this._battleDoctrine.querySelector('[data-doctrine="skirmish"]');
      if (skirmish) skirmish.classList.add("active");
      if (this._doctrineDesc) this._doctrineDesc.textContent = "Balanced. Turn rate +10%.";
      this._battleDoctrine.dataset.synced = "1";
    }

    // Banter — 0-2 lines above the briefing. Each line is a comms
    // snippet with a speaker tag that drives the row's left-bar tint.
    if (this._battleBanter) {
      const banter = (node && node.banter) || [];
      if (banter.length > 0) {
        let html = "";
        for (const b of banter) {
          const speaker = String(b.speaker || "command");
          const label =
            speaker === "wingman"    ? "WING" :
            speaker === "command"    ? "COMMAND" :
            speaker === "ally"       ? "ALLY" :
            speaker === "voidsworn"  ? "VOIDSWORN" :
            speaker === "intercept"  ? "INTERCEPT" : "COMMS";
          html += `
            <div class="banter-line banter-${speaker}">
              <span class="banter-speaker">${label}</span>
              <span class="banter-text">${b.text}</span>
            </div>
          `;
        }
        this._battleBanter.innerHTML = html;
        this._battleBanter.style.display = "flex";
      } else {
        this._battleBanter.innerHTML = "";
        this._battleBanter.style.display = "none";
      }
    }

    // Boss briefing: when the node is a named-boss encounter we swap
    // the generic "ENEMY SPOTTED" + faction/tier strip for the named
    // commander's profile + their description from the BOSSES table.
    // Reads like the CO calling out the threat before the player
    // commits — sets the tone for the act-finale fight.
    if (node.bossName) {
      this._battleTitle.textContent = "TARGET BRIEFING";
      const accent = race ? race.accent : "#f55";
      this._battleInfo.innerHTML = `
        <div class="boss-briefing">
          <div class="boss-briefing-eyebrow" style="color:${accent};">FRONTIER INTEL · TARGET DOSSIER</div>
          <div class="boss-briefing-name" style="color:${accent};">${node.bossName}</div>
          <div class="boss-briefing-faction">${raceName.toUpperCase()}</div>
          <div class="boss-briefing-body">${node.bossDescription || ""}</div>
        </div>
      `;
    } else if (node.aceName) {
      this._battleTitle.textContent = "ACE INTERCEPT";
      const accent = race ? race.accent : "#fc6";
      this._battleInfo.innerHTML = `
        <div class="boss-briefing ace-briefing">
          <div class="boss-briefing-eyebrow" style="color:${accent};">FRONTIER INTEL · ACE PILOT</div>
          <div class="boss-briefing-name" style="color:${accent};">${node.aceName}</div>
          <div class="boss-briefing-faction">${raceName.toUpperCase()}</div>
          <div class="boss-briefing-body">${node.aceDescription || ""}</div>
        </div>
      `;
    } else {
      this._battleTitle.textContent = "ENEMY SPOTTED";
      this._battleInfo.innerHTML = `
        <span class="battle-faction" style="color:${race ? race.accent : '#cef'};">${raceName.toUpperCase()}</span>
        <span class="battle-tier">${tierLabel} (Tier ${tier})</span>
      `;
    }
  }

  // ---- sync: Resupply -----------------------------------------------------

  _syncResupply(s) {
    const rs = s.resupply;
    if (!rs) return;

    // Credit + fuel chips in the header.
    if (this._resupplyCredits) this._resupplyCredits.textContent = `${rs.credits || 0}`;
    if (this._resupplyFuel) this._resupplyFuel.textContent = `${rs.fuel || 0}`;

    // Vendor card \u2014 procedural personality block.
    const vendor = rs.vendor;
    const vendorEl = this._screens.resupply.querySelector("#resupply-vendor");
    if (vendor && vendorEl) {
      const tagHtml = vendor.serviceTag ? `<span class="vendor-tag">${vendor.serviceTag}</span>` : "";
      vendorEl.innerHTML = `
        <div class="vendor-archetype" style="color:${vendor.color || "#9df"};">${(vendor.label || "Vendor").toUpperCase()}</div>
        <div class="vendor-name">${vendor.name || ""}</div>
        <div class="vendor-pitch">&ldquo;${vendor.pitch || ""}&rdquo;</div>
        ${tagHtml}
      `;
      vendorEl.className = `resupply-vendor-card vendor-${vendor.key || "quartermaster"}`;
    } else if (vendorEl) {
      vendorEl.innerHTML = "";
    }

    // Repair rows.
    const capitals = rs.capitals || [];
    const repairsHost = this._resupplyRepairs;
    if (repairsHost) {
      repairsHost.innerHTML = "";
      if (!capitals.length) {
        const empty = document.createElement("div");
        empty.className = "resupply-empty";
        empty.textContent = "No capitals in the line yet.";
        repairsHost.appendChild(empty);
      }
      for (const cap of capitals) {
        const row = document.createElement("div");
        row.className = "resupply-row repair-row";
        const hpPct = Math.round((cap.hpFrac || 0) * 100);
        const isFull = hpPct >= 100;
        const canAfford = (rs.credits || 0) >= (cap.repairCost || 0);
        row.innerHTML = `
          <div class="resupply-row-main">
            <div class="resupply-row-title">${capitalDisplayName(cap.klass)}</div>
            <div class="resupply-row-meta">${hpPct}% &rarr; 100% hull</div>
            <div class="repair-hp-bar"><div class="repair-hp-fill" style="width:${hpPct}%;"></div></div>
          </div>
          <button class="resupply-action-btn" data-id="${cap.instanceId}">
            ${isFull ? "FULL" : `${cap.repairCost || 0} cr`}
          </button>
        `;
        const btn = row.querySelector(".resupply-action-btn");
        if (isFull || !canAfford) {
          btn.disabled = true;
          btn.classList.add("disabled");
        }
        this._addListener(btn, "click", () => {
          if (this._callbacks.onResupplyRepair) this._callbacks.onResupplyRepair(cap.instanceId);
        });
        repairsHost.appendChild(row);
      }
    }

    // Recruit + refuel shop tiles.
    const fCost = rs.fighterPrice || 0;
    const bCost = rs.bomberPrice || 0;
    const fuelCost = rs.fuelPrice || 0;
    if (this._resupplyFighterCost) this._resupplyFighterCost.textContent = `${fCost} cr`;
    if (this._resupplyBomberCost) this._resupplyBomberCost.textContent = `${bCost} cr`;
    if (this._resupplyRefuelCost) this._resupplyRefuelCost.textContent = `${fuelCost} cr`;
    if (this._resupplyFighterBtn) {
      this._resupplyFighterBtn.classList.toggle("disabled", !rs.canAffordFighter);
      this._resupplyFighterBtn.disabled = !rs.canAffordFighter;
    }
    if (this._resupplyBomberBtn) {
      this._resupplyBomberBtn.classList.toggle("disabled", !rs.canAffordBomber);
      this._resupplyBomberBtn.disabled = !rs.canAffordBomber;
    }
    if (this._resupplyRefuelBtn) {
      this._resupplyRefuelBtn.classList.toggle("disabled", !rs.canAffordRefuel);
      this._resupplyRefuelBtn.disabled = !rs.canAffordRefuel;
    }

    // Boon offers as rows.
    const offers = rs.boonOffers || [];
    const boonsHost = this._resupplyBoons;
    if (boonsHost) {
      boonsHost.innerHTML = "";
      if (!offers.length) {
        const empty = document.createElement("div");
        empty.className = "resupply-empty";
        empty.textContent = "Vendor offered no boons this stop.";
        boonsHost.appendChild(empty);
      }
      const canAffordBoon = (rs.fuel || 0) >= 1;
      for (let i = 0; i < offers.length; i++) {
        const offer = offers[i];
        const row = document.createElement("button");
        row.className = "resupply-row resupply-boon-row";
        row.type = "button";
        row.innerHTML = `
          <div class="resupply-row-main">
            <div class="resupply-row-title">${offer.id || offer.key || "Boon"}</div>
            <div class="resupply-row-meta">${offer.desc || ""}</div>
          </div>
          <span class="resupply-action-btn boon-cost">1 fuel</span>
        `;
        if (!canAffordBoon) {
          row.disabled = true;
          row.classList.add("disabled");
        }
        this._addListener(row, "click", () => {
          if (this._callbacks.onResupplyBoon) this._callbacks.onResupplyBoon(i);
        });
        boonsHost.appendChild(row);
      }
    }
  }

  // ---- sync: Event --------------------------------------------------------

  _syncEvent(s) {
    const evt = s.event;
    if (!evt) return;
    this._eventTitle.textContent = evt.title ? evt.title.toUpperCase() : "ANOMALY DETECTED";
    this._eventBody.textContent = evt.body || "";

    if (evt.resolved) {
      // RESULT VIEW — hide choices, show the outcome + resource deltas.
      this._eventChoices.style.display = "none";
      this._eventResult.style.display = "block";
      this._eventCloseBtn.style.display = "none";
      this._eventContinueBtn.style.display = "";
      const res = evt.result || { text: "", deltas: [] };
      this._eventResultText.textContent = res.text || "Orders carried out.";
      // Render resource deltas as coloured chips (+green / −red).
      const LABELS = { credits: "credits", fuel: "fuel", fighter: "fighter", bomber: "bomber", capital: "capital" };
      let chips = "";
      for (const d of (res.deltas || [])) {
        const sign = d.delta > 0 ? "+" : "";
        const cls = d.delta > 0 ? "delta-gain" : "delta-loss";
        const noun = LABELS[d.label] || d.label;
        const plural = Math.abs(d.delta) !== 1 && (noun === "fighter" || noun === "bomber" || noun === "capital") ? "s" : "";
        chips += `<span class="event-delta ${cls}">${sign}${d.delta} ${noun}${plural}</span>`;
      }
      this._eventResultDeltas.innerHTML = chips || `<span class="event-delta delta-none">No change to fleet or stores</span>`;
      return;
    }

    // CHOICE VIEW.
    this._eventChoices.style.display = "";
    this._eventResult.style.display = "none";
    this._eventCloseBtn.style.display = "";
    this._eventContinueBtn.style.display = "none";
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

  // ---- sync: Promotion ----------------------------------------------------

  _syncPromotion(s) {
    const promo = s.promotion;
    if (!promo) return;
    this._promotionRank.textContent = (promo.rank || "").toUpperCase();
    this._promotionTitle.textContent = promo.title || "";
    this._promotionBlurb.textContent = promo.blurb || "";
    // Insignia hero — populated only when the rank changes so the
    // reveal animation re-triggers per promotion (forced reflow trick).
    if (this._promotionInsignia) {
      const newKey = promo.rank || "";
      if (this._promotionInsigniaKey !== newKey) {
        this._promotionInsigniaKey = newKey;
        this._promotionInsignia.innerHTML = rankInsigniaSvg(promo.rank);
        // Force reflow so the keyframe restarts on each rank change.
        this._promotionInsignia.classList.remove("revealing");
        // Trigger reflow then re-add — pattern for re-running animations.
        void this._promotionInsignia.offsetWidth;
        this._promotionInsignia.classList.add("revealing");
      }
    }

    const added = promo.added || {};
    const capitals = added.capitals || [];
    const fighters = added.fighter || 0;
    const bombers = added.bomber || 0;

    const parts = [];
    for (const c of capitals) {
      const variants = c.variants || [];
      const klassName = capitalDisplayName(c.klass).toUpperCase();
      const picked = c.selectedVariant || null;
      let variantChips = "";
      if (variants.length > 0) {
        variantChips = '<div class="promotion-variant-chips">';
        for (const v of variants) {
          const active = picked === v.key ? "active" : "";
          variantChips += `
            <button class="promotion-variant-chip ${active}" data-instance="${c.instanceId}" data-variant="${v.key}" title="${v.blurb || ""}">
              <span class="variant-label">${v.label}</span>
              <span class="variant-blurb">${v.blurb || ""}</span>
            </button>
          `;
        }
        variantChips += '</div>';
      }
      parts.push(`
        <div class="promotion-addition-row promotion-addition-capital">
          <div class="promotion-addition-head">+ ${klassName}${c.name ? ` — <span class="promotion-ship-name">${c.name}</span>` : ""}</div>
          ${c.captain ? `<div class="promotion-addition-captain">${c.captain}</div>` : ""}
          ${variantChips}
        </div>
      `);
    }
    if (fighters > 0) parts.push(`<div class="promotion-addition-row">+ ${fighters} fighter${fighters > 1 ? "s" : ""}</div>`);
    if (bombers > 0)  parts.push(`<div class="promotion-addition-row">+ ${bombers} bomber${bombers > 1 ? "s" : ""}</div>`);
    if (parts.length === 0) parts.push(`<div class="promotion-addition-row promotion-addition-empty">No new units</div>`);

    this._promotionAdditions.innerHTML = parts.join("");
    // Wire variant chip clicks.
    for (const chip of this._promotionAdditions.querySelectorAll(".promotion-variant-chip")) {
      this._addListener(chip, "click", () => {
        const instanceId = parseInt(chip.dataset.instance, 10);
        const variant = chip.dataset.variant;
        if (this._callbacks.onPromotionVariantSelect && Number.isFinite(instanceId)) {
          this._callbacks.onPromotionVariantSelect(instanceId, variant);
        }
      });
    }

    // ---- War bulletin ----
    // 3-line news ticker stamped onto pendingPromotion at boss-clear
    // time. Rebuild the <li> list on a hash change so each act-break
    // shows its own headlines without thrashing the DOM.
    const bulletin = promo.bulletin || [];
    if (this._promotionBulletinSection) {
      this._promotionBulletinSection.style.display = bulletin.length > 0 ? "" : "none";
    }
    const bsig = bulletin.join("|");
    if (this._promotionBulletinList && bsig !== this._promotionBulletinSig) {
      this._promotionBulletinSig = bsig;
      this._promotionBulletinList.innerHTML = bulletin
        .map((line) => `<li class="promotion-bulletin-line">${line}</li>`)
        .join("");
    }

    // ---- Trait picker ----
    const draw = promo.traitDraw || [];
    const selectedKey = promo.selectedTraitKey || null;
    if (this._promotionTraitsSection) {
      this._promotionTraitsSection.style.display = draw.length > 0 ? "" : "none";
    }
    // Cheap rebuild on key-set change (each promotion has a unique
    // traitDraw so this fires exactly once per overlay open).
    const sig = draw.map((t) => t.key).join("|");
    if (sig !== this._promotionTraitSig) {
      this._promotionTraitSig = sig;
      if (this._promotionTraitChips) {
        this._promotionTraitChips.innerHTML = "";
        for (const t of draw) {
          const btn = document.createElement("button");
          btn.className = "promotion-trait-chip";
          btn.dataset.traitKey = t.key;
          btn.innerHTML = `<div class="trait-name">${t.name}</div><div class="trait-desc">${t.desc}</div>`;
          this._addListener(btn, "click", () => {
            if (this._callbacks.onPromotionTraitSelect) {
              this._callbacks.onPromotionTraitSelect(t.key);
            }
          });
          this._promotionTraitChips.appendChild(btn);
        }
      }
    }
    // Highlight the picked chip + gate PROCEED.
    if (this._promotionTraitChips) {
      const chips = this._promotionTraitChips.querySelectorAll(".promotion-trait-chip");
      for (const c of chips) {
        c.classList.toggle("active", c.dataset.traitKey === selectedKey);
      }
    }
    // PROCEED is enabled when (a) no traits to pick (degenerate case),
    // or (b) the player has picked one. Disabled state is visual
    // only — the dismiss callback still fires either way, but the
    // styling tells the player to make their choice first.
    if (this._promotionProceedBtn) {
      const needsPick = draw.length > 0 && !selectedKey;
      this._promotionProceedBtn.disabled = needsPick;
      this._promotionProceedBtn.classList.toggle("disabled", needsPick);
    }
    if (this._promotionTraitHint) {
      this._promotionTraitHint.textContent = selectedKey
        ? "Trait locked in. Promotion ready."
        : (draw.length > 0
            ? "Choose one — it carries to the end of your career."
            : "No traits available — career too short.");
    }
  }
}
