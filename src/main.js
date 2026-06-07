import {
  createGame, update, restart, startGame,
  enterSpectate, exitSpectate, cycleSpectate, getSpectateTarget,
} from "./game.js";
import { drawArena, drawArenaBounds, ARENA, applyMap } from "./arena.js";
import { drawDecor } from "./maps/decor.js";
import { drawPlatform } from "./platforms/entity.js";
import { drawShip } from "./ship.js";
import { drawProjectile } from "./projectile.js";
import { drawHUD, drawBeams, BattleHUD } from "./hud.js";
import { drawWreck, drawDebris } from "./wreckage.js";
import { InputManager } from "./input.js";
import { prerenderSprites } from "./sprites.js";
import { drawParticle } from "./particles.js";
import { GameAudio } from "./audio.js";
import {
  loadRun, loadMeta, startNewRun, abandonRun, discardRun,
  buildModeConfig, captureBattleOutcome, completeNode, enterNode,
  isRunOver, recordRunEnd, clearPendingPromotion, clearPendingPreamble, clearPendingDispatch, clearPendingJumpEncounter, selectPromotionTrait, endReasonFlavor,
  ACT_RANKS,
  buyRepair, buyRecruit, buyRefuel, applyBoon, applyEventChoice,
  renameCapital, setCapitalBehavior, buyServiceUpgrade, selectCapitalVariant,
  setWingCommand, pickCommanderPerk,
  addWing, removeWing, adjustWingCount, setWingDetail,
} from "./roguelite.js";
import {
  loadEnergy, regenTick, spendEnergy, purchase as purchaseEnergy,
} from "./energy.js";
import { saveStore } from "./save.js";
import { events } from "./events.js";
import { isDev, setDev } from "./dev/devmode.js";
import { drawBalanceHUD } from "./dev/balancehud.js";
import { DevOverlay, quickSpawn } from "./dev/devoverlay.js";
import { BattleDesigner } from "./dev/battle-designer.js";
import { ShipDesigner } from "./dev/ship-designer.js";
import { MapDesigner } from "./dev/map-designer.js";
import { PlatformDesigner } from "./dev/platform-designer.js";
import { ShipEditor } from "./dev/ship-editor.js";
import { compileCustomShip } from "./customships/compile.js";
import * as customShipFormat from "./customships/format.js";
import * as customShipStore from "./customships/store.js";
import * as scenarioFormat from "./scenario/format.js";
import * as scenarioStore from "./scenario/store.js";
import * as blueprintFormat from "./blueprints/format.js";
import * as blueprintStore from "./blueprints/store.js";
import * as mapFormat from "./maps/format.js";
import * as mapStore from "./maps/store.js";
import {
  recordKill, computeRunPayout, bankRunPayout,
  buyHull, setHull, buyComponent, equipComponent, renameShip, setPaint,
} from "./shipyard.js";
// NEW War-based Frontier (FRONTIER_FUTURE.md). Wired alongside the
// legacy roguelite; reached programmatically (no menu route yet).
import { launchFrontierMission, resolveMissionOutcome } from "./frontier/mission.js";
import * as frontierState from "./frontier/state.js";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const input = new InputManager(canvas);
// Bake every (race, klass, side) ship sprite into an offscreen canvas
// before the first frame so drawShip can blit instead of re-drawing
// polygons each tick.
prerenderSprites();
const game = createGame();
window.game = game; // for console smoke-testing
window.input = input; // exposed for browser-side test probes
window.saveStore = saveStore; // exposed so probes share the singleton
// NEW Frontier test surface — programmatic launch + career-state reads
// until the menu route is built. Mirrors the window.game/input probes.
window.frontier = {
  ...frontierState,
  launch: (opts, size) => launchFrontierMission(game, opts, size),
  outcome: () => game.frontierOutcome || null,
};

// Dismiss the boot splash once the engine is ready. Two RAFs so the
// first paint draws the menu UI before the splash fades out — feels
// like a clean transition into a populated home screen.
requestAnimationFrame(() => requestAnimationFrame(() => {
  const splash = document.getElementById("boot-splash");
  if (splash) {
    splash.classList.add("fade-out");
    setTimeout(() => splash.remove(), 600);
  }
}));
const audio = new GameAudio();
window.audio = audio; // exposed for browser-side test probes
let musicWasPlaying = false; // tracks state for start/stop edge detection

// Restore persisted music + SFX mute states and wire the Settings
// overlay + the P key shortcut (music only) to both apply the change
// to the live audio graph AND persist it through saveStore.
{
  const st = saveStore.get().settings;
  // Per-channel volumes (the Settings sliders). Fall back to the old
  // boolean mutes for saves that predate the volume fields: a previously
  // muted channel restores at 0.
  audio.setMusicVolume(typeof st.musicVolume === "number" ? st.musicVolume : (st.musicMuted ? 0 : 0.6));
  audio.setSfxVolume(typeof st.sfxVolume === "number" ? st.sfxVolume : (st.sfxMuted ? 0 : 0.8));
  // Mute flags layer over volume (the P-key quick-mute persists too).
  audio.setMuted(!!st.musicMuted);
  audio.setSfxMuted(!!st.sfxMuted);
  // Cache the Dev Mode flag once at boot so isDev() in per-frame draws
  // is a memory read. Settings-overlay toggle updates re-cache via setDev.
  setDev(!!st.devMode);
}

// Global UI tap audio. Plays a short procedural click whenever the
// player taps a menu button, link, chip, or shipyard slot. Routed
// through audio.sfxUiTap which respects SFX mute. The capture-phase
// listener catches taps before any stopPropagation. Buttons inside
// the game canvas (action cluster FIRE/MISSILE/BOOST) skip the tap
// voice because they already have weapon SFX.
document.addEventListener("pointerdown", (e) => {
  const t = e.target;
  if (!t || !(t instanceof Element)) return;
  // Only react to interactive UI controls inside menu / battle-HUD chrome.
  const tap = t.closest("button, .home-card, .home-nav-btn, .preview-hotspot, .shipyard-slot-row, .shipyard-cat-item, .home-shipyard-card, .home-link, .home-more-row, .chip-item");
  if (!tap) return;
  // Action cluster + virtual sticks have their own SFX — skip.
  if (tap.closest(".action-btn, .vstick")) return;
  // Back / dismiss buttons get a slightly lower-pitch chirp.
  const isBack = !!tap.closest(".menu-back-btn, .shipyard-back, .shipyard-cat-back, .playhub-back, .skirmish-back, .home-nav-panel-back") || tap.id?.includes("back");
  audio.sfxUiTap({ variant: isBack ? "back" : "tap" });
}, true);
function applyMuteChange(muted) {
  audio.setMuted(muted);
  saveStore.update((d) => { d.settings.musicMuted = muted; });
}
function applySfxMuteChange(muted) {
  audio.setSfxMuted(muted);
  saveStore.update((d) => { d.settings.sfxMuted = muted; });
}
function applyMusicVolume(v) {
  audio.setMusicVolume(v);
  saveStore.update((d) => { d.settings.musicVolume = audio.getMusicVolume(); });
}
function applySfxVolume(v) {
  audio.setSfxVolume(v);
  saveStore.update((d) => { d.settings.sfxVolume = audio.getSfxVolume(); });
}
function applyDevMode(on) {
  // Cache flips first (so any draw that reads isDev() this frame sees the
  // new value), then persist.
  setDev(on);
  saveStore.update((d) => { d.settings.devMode = !!on; });
  // Reflect the flag in the on-screen launcher — the only way to reach the
  // overlay on touch devices (no keyboard `~`).
  _updateDevFab();
  if (on) {
    // Surface the tool routes immediately so flipping the toggle has a
    // visible effect (the overlay holds the designer + sim buttons).
    _ensureDevOverlay().show();
  } else if (_devOverlay) {
    // Turning Dev Mode OFF closes the overlay so a stale panel doesn't
    // keep intercepting clicks.
    _devOverlay.hide();
  }
}

// Dev overlay — lazy mounted on first toggle. Mounting is gated on
// isDev(); the overlay's own visibility is independent so the user can
// hide it without flipping Dev Mode off.
let _devOverlay = null;
function _ensureDevOverlay() {
  if (_devOverlay) return _devOverlay;
  _devOverlay = new DevOverlay(document.body, {
    game,
    getCamera: () => _lastCamera,
    getZoom: () => zoom,
    getView: () => ({ w: viewW, h: viewH }),
    openBattleDesigner: () => _ensureBattleDesigner().show(),
    openShipDesigner: () => _ensureShipDesigner().show(),
    openMapDesigner: () => _ensureMapDesigner().show(),
    openPlatformDesigner: () => _ensurePlatformDesigner().show(),
  });
  return _devOverlay;
}

// On-screen launcher button. Dev Mode is togglable via the `~` key on
// desktop, but Starfighter is touch-first (Capacitor) with no keyboard —
// so whenever Dev Mode is on we show a tappable DEV button that toggles
// the overlay (which holds the designer + sim-control routes). Without
// this the dev features are unreachable on a phone.
let _devFab = null;
function _ensureDevFab() {
  if (_devFab) return _devFab;
  const b = document.createElement("button");
  b.id = "dev-fab";
  b.className = "dev-fab hidden";
  b.textContent = "DEV ▸";
  b.title = "Dev Tools";
  b.addEventListener("click", () => _ensureDevOverlay().toggle());
  document.body.appendChild(b);
  _devFab = b;
  return _devFab;
}
function _updateDevFab() {
  _ensureDevFab().classList.toggle("hidden", !isDev());
}

// Battle Designer — lazy mounted from the dev overlay's button or from
// the window.dev.designer probe. TEST PLAY hands the validated draft to
// the existing scenario.play() probe so the playback path is shared with
// console smoke-tests.
let _battleDesigner = null;
function _ensureBattleDesigner() {
  if (_battleDesigner) return _battleDesigner;
  _battleDesigner = new BattleDesigner(document.body, {
    game,
    onTestPlay: (scenario) => {
      game.scenario = scenario;
      const allied = (scenario.blueTeams[0] && scenario.blueTeams[0].race) || "terran";
      startGame(game, ARENA.width, ARENA.height, allied, "custom", null, 1, null);
    },
    onClose: () => {},
  });
  return _battleDesigner;
}

// Ship Designer — lazy mounted from the dev overlay button. Pure
// authoring surface — no game-state side effects beyond saveStore
// updates.
let _shipDesigner = null;
function _ensureShipDesigner() {
  if (_shipDesigner) return _shipDesigner;
  _shipDesigner = new ShipDesigner(document.body, {
    game,
    onClose: () => {},
  });
  return _shipDesigner;
}

// Map Designer — same lazy pattern. Authoring only; mapId resolution
// happens later in modes/custom.js#setupFromScenario.
let _mapDesigner = null;
function _ensureMapDesigner() {
  if (_mapDesigner) return _mapDesigner;
  _mapDesigner = new MapDesigner(document.body, {
    game,
    onClose: () => {},
  });
  return _mapDesigner;
}

// Platform Designer — read-only inspector for the built-in PLATFORM_TYPES.
let _platformDesigner = null;
function _ensurePlatformDesigner() {
  if (_platformDesigner) return _platformDesigner;
  _platformDesigner = new PlatformDesigner(document.body, { onClose: () => {} });
  return _platformDesigner;
}

// Ship Editor — free-form custom-ship authoring (Free-Form Custom Ship Editor).
// Lazy-mounted on first open (from the dev-gated MORE-panel entry via the event
// bus, or the window.dev.editor() probe). TEST FLY compiles the authored doc and
// ARMS it as the player ship, then opens the real custom-battle configurator so
// the player chooses the opponents / roster / map. The menu start handler swaps
// the armed ship into the next match's modeConfig (see `_pendingTestFly`).
let _shipEditor = null;
// Compiled custom ship awaiting a test-fly battle. Set by TEST FLY, consumed by
// the menu start handler on the next match, and disarmed if the player backs out
// of the configurator — so a custom test-fly can never leak into a normal match.
let _pendingTestFly = null;
function _ensureShipEditor() {
  if (_shipEditor) return _shipEditor;
  _shipEditor = new ShipEditor(document.body, {
    onTestFly: (doc) => {
      let c;
      try { c = compileCustomShip(doc); }
      catch (e) { console.warn("[shipEditor] compile failed:", e); return; }
      // Arm the compiled ship; the player will pick the battle in the custom
      // configurator (same UI as the home "Custom" tile). race is carried so the
      // player ship + allies spawn as the authored faction.
      _pendingTestFly = {
        race: c.race,
        design: {
          hull: c.klass,
          hullPoly: c.design.hullPoly,
          paintPrimary: c.design.paintPrimary,
          paintTrim: c.design.paintTrim,
        },
        specOverride: c.specOverride,
        moduleList: c.moduleList,
        cellOverride: c.cellOverride,
      };
      // Hand off to the custom-match configurator (the editor already hid
      // itself, so the menu is showing underneath).
      if (input && input.startMenu) {
        input.startMenu.selectedMode = "custom";
        input.startMenu.showCustom = true;
      }
    },
    onClose: () => {},
  });
  return _shipEditor;
}
// Open from the dev-gated MORE-panel SHIP EDITOR entry (menus.js emits this).
// Clear any stale armed test-fly so re-entering the editor starts clean.
events.on("dev:openShipEditor", () => { _pendingTestFly = null; _ensureShipEditor().show(); });

// Dev hotkeys. Bound at the window level so they fire even when the
// canvas isn't focused, and ALL gated on isDev() so a non-dev player
// can't trip them. The ~/` key toggles the overlay (lazy-mounts it on
// first press); \ steps one fixed tick while paused; [/] cycle simSpeed.
window.addEventListener("keydown", (e) => {
  if (!isDev()) return;
  // Ignore when typing in a form control (search box, future settings).
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === "`" || e.key === "~") {
    e.preventDefault();
    _ensureDevOverlay().toggle();
  } else if (e.key === "\\") {
    if (!_devOverlay) return;
    e.preventDefault();
    _devOverlay.step();
  } else if (e.key === "[") {
    e.preventDefault();
    _ensureDevOverlay().bumpSpeed(-1);
  } else if (e.key === "]") {
    e.preventDefault();
    _ensureDevOverlay().bumpSpeed(1);
  }
});

// Capture-phase pointerdown router. When the dev overlay is visible and
// the click landed on the canvas (not the overlay panel itself), let the
// overlay handle it first; if it consumes the click (selection or
// spawn), stop propagation so the gameplay input layer doesn't see it.
canvas.addEventListener("pointerdown", (e) => {
  if (!isDev() || !_devOverlay || !_devOverlay.isVisible()) return;
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  if (_devOverlay.handlePointer(sx, sy)) {
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

// Dev probe surface. Mirrors the window.game / window.input / window.saveStore
// hooks so Playwright + console smoke-tests can drive the overlay without
// keyboard input.
if (typeof window !== "undefined") {
  Object.assign(window.dev || (window.dev = {}), {
    overlay: () => _ensureDevOverlay(),
    quickSpawn: (opts) => quickSpawn(game, opts),
    designer: () => _ensureBattleDesigner(),
    shipDesigner: () => _ensureShipDesigner(),
    mapDesigner: () => _ensureMapDesigner(),
    platformDesigner: () => _ensurePlatformDesigner(),
    editor: () => _ensureShipEditor(),
    isTestFlyArmed: () => _pendingTestFly != null,
  });
  // Custom-ship probe surface — mirrors window.blueprint. Exposes the format,
  // store, and the compiler so Playwright + console smoke-tests can round-trip
  // a doc, inject it into storage, and verify compileCustomShip output without
  // driving the editor DOM.
  window.customShip = {
    ...customShipFormat,
    ...customShipStore,
    compile: compileCustomShip,
  };
  // Blueprint probe surface — mirrors window.scenario.
  window.blueprint = {
    ...blueprintFormat,
    ...blueprintStore,
  };
  // Map probe surface.
  window.map = {
    ...mapFormat,
    ...mapStore,
  };
  // Scenario probe surface (PR-1a). Mirrors window.dev / window.game
  // pattern — lets Playwright + console smoke-tests drive the format,
  // store, and the game.scenario hand-off without driving DOM yet (UI
  // lands in PR-1b).
  window.scenario = {
    ...scenarioFormat,
    ...scenarioStore,
    // Set the live game.scenario then start a custom match. Doesn't
    // touch the SaveStore — for one-shot "load this and play" use.
    play: (input) => {
      const res = scenarioFormat.parseScenario(input);
      if (!res.ok) {
        console.warn("[scenario] invalid:", res.errors);
        return res;
      }
      game.scenario = res.value;
      // The custom mode reads game.scenario inside its setup hook. The
      // `mode: "custom"` arg routes startGame → MODES.custom.setup which
      // will see game.scenario and call setupFromScenario.
      const allied = (res.value.blueTeams[0] && res.value.blueTeams[0].race) || "terran";
      startGame(game, ARENA.width, ARENA.height, allied, "custom", null, 1, null);
      return res;
    },
    clear: () => { game.scenario = null; },
  };
}
input.startMenu.setSettings(
  () => ({
    musicVolume: audio.getMusicVolume(),
    sfxVolume: audio.getSfxVolume(),
    musicMuted: audio.isMuted(),
    sfxMuted: audio.isSfxMuted(),
    devMode: isDev(),
  }),
  (patch) => {
    if (typeof patch.musicVolume === "number") applyMusicVolume(patch.musicVolume);
    if (typeof patch.sfxVolume === "number") applySfxVolume(patch.sfxVolume);
    if (typeof patch.musicMuted === "boolean") applyMuteChange(patch.musicMuted);
    if (typeof patch.sfxMuted === "boolean") applySfxMuteChange(patch.sfxMuted);
    if (typeof patch.devMode === "boolean") applyDevMode(patch.devMode);
  },
);

// Reflect a persisted Dev Mode flag in the on-screen launcher at boot, so
// a player who enabled it in a previous session can reach the tools.
_updateDevFab();

// SFX routing: gameplay code emits weaponFired / hit / shipDestroyed
// events with world-space positions; the camera-attenuated distance
// drives volume so a battle on the far side of the map is muted while
// a knife-fight at the player's position is at full volume.
let _lastCamera = { x: 0, y: 0 };
const SFX_RANGE = 1800;        // world units past which volume → 0
const SFX_CANNON_PROB = 0.35;  // gate cannon emissions so brawls aren't a wall of sound
function sfxAttenuation(x, y) {
  const dx = x - _lastCamera.x;
  const dy = y - _lastCamera.y;
  const d = Math.hypot(dx, dy);
  if (d >= SFX_RANGE) return 0;
  // Soft inverse curve — louder up close, gentle falloff to range.
  return Math.max(0, 1 - (d / SFX_RANGE) ** 1.3);
}
// Per-weapon-module fire SFX. Each weapon system has its own gritty voice
// (autocannon / ring battery / heavy cannon / broadside). AI fire is
// probability-gated so a big brawl doesn't wall up — but heavy weapons are
// rarer + more impactful, so they pass through more often than the rapid
// light guns. Player fire is always full-volume + ungated.
const WEAPON_FIRE_PROB = {
  broadside: 0.85,
  heavycannon: 0.70,
  cruisercannon: 0.75,
  ringcannon: 0.40,
  autocannon: 0.35,
};
events.on("weaponFired", ({ x, y, kind, weapon, isPlayer }) => {
  if (!audio.ctx) return;
  // Resolve the weapon voice: prefer the explicit `weapon` tag; fall back
  // to mapping the firing ship's class for any older emit site.
  const w = weapon || (kind === "battleship" ? "broadside"
    : (kind === "cruiser" || kind === "carrier") ? "heavycannon"
    : kind === "frigate" ? "ringcannon" : "autocannon");
  if (!isPlayer && Math.random() > (WEAPON_FIRE_PROB[w] ?? SFX_CANNON_PROB)) return;
  const att = isPlayer ? 1 : sfxAttenuation(x, y);
  if (att <= 0.04) return;
  audio.sfxWeapon({ weapon: w, volume: att });
});

// Point-defence fire — a faint metallic rattle. PD rings fire far too
// fast to sound per-shot, so ship.js emits one throttled `pdFired` per
// ship per tick and we probability-gate it hard here so a fleet of
// capitals reads as ambient chatter, not a machine-gun wall.
const PD_FIRE_PROB = 0.14;
events.on("pdFired", ({ x, y, isPlayer }) => {
  if (!audio.ctx) return;
  if (Math.random() > (isPlayer ? 0.35 : PD_FIRE_PROB)) return;
  const att = isPlayer ? 0.85 : sfxAttenuation(x, y) * 0.7;
  if (att <= 0.05) return;
  audio.sfxPdFire({ volume: att });
});
events.on("missileFired", ({ x, y, isPlayer }) => {
  if (!audio.ctx) return;
  const att = isPlayer ? 1 : sfxAttenuation(x, y);
  if (att <= 0.04) return;
  audio.sfxMissile({ volume: att });
});
// Impact SFX — distinct per defence LAYER (shield / armor / hull) and
// coloured by the SOURCE weapon (a missile crump reads differently from a
// fighter-cannon ping or a PD tink against the same plate).
events.on("hit", ({ x, y, shielded, layer, source, isPlayer }) => {
  if (!audio.ctx) return;
  const att = isPlayer ? 1 : sfxAttenuation(x, y) * 0.7;
  if (att <= 0.08) return;
  audio.sfxImpact({
    layer: layer || (shielded ? "shield" : "hull"),
    source: source || "cannon",
    volume: att,
  });
});
events.on("shipDestroyed", ({ x, y, intensity }) => {
  if (!audio.ctx) return;
  const att = sfxAttenuation(x, y);
  if (att <= 0.05) return;
  audio.sfxExplosion({ volume: att, intensity: intensity || 0.6 });
});

// Shipyard meta-progression: tally enemy kills onto the active Frontier
// run. Banked into save.shipyardCredits at run-end. Non-Frontier modes
// have no activeRun so the tally just stays at 0 — credits only flow
// from career play.
events.on("shipDestroyed", ({ klass, side, isPlayer }) => {
  if (!activeRun || isPlayer || side !== "red") return;
  recordKill(activeRun, klass);
});

// New Frontier kill ledger: tally enemy kills against the active War +
// grant per-class career XP (state.js banks it continuously).
events.on("shipDestroyed", ({ klass, side, isPlayer }) => {
  if (game.mode !== "frontier" || !game.frontierContext) return;
  if (isPlayer || side !== "red") return;
  frontierState.recordKill(game.frontierContext.warId, klass);
});

// Heavy laser — one-shot sustained whine for the beam's duration.
// Player-fired beams always play at full volume; AI beams attenuate
// with camera distance.
events.on("beamFired", ({ x, y, duration, isPlayer }) => {
  if (!audio.ctx) return;
  const att = isPlayer ? 1 : sfxAttenuation(x, y);
  if (att <= 0.05) return;
  audio.sfxBeam({ volume: att, duration: duration || 3.0 });
});

// Cluster missile bloom — sharp burst + scatter sparkle. Audible cue
// that one inbound parent missile has split into multiple tracks.
events.on("missileBloom", ({ x, y }) => {
  if (!audio.ctx) return;
  const att = sfxAttenuation(x, y);
  if (att <= 0.06) return;
  audio.sfxMissileBloom({ volume: att });
});

// PD intercept — missile shot down before reaching target. Soft pop
// distinct from a full ship explosion so defensive PD work reads
// clearly in the mix.
events.on("missileIntercepted", ({ x, y }) => {
  if (!audio.ctx) return;
  const att = sfxAttenuation(x, y) * 0.65;
  if (att <= 0.06) return;
  audio.sfxMissileIntercept({ volume: att });
});

// Shield collapse — crystalline shatter when a ship's shield drops
// from positive to zero. Player events bypass attenuation so a
// breaking player shield is always heard.
events.on("shieldBreak", ({ x, y, isPlayer }) => {
  if (!audio.ctx) return;
  const att = isPlayer ? 1 : sfxAttenuation(x, y);
  if (att <= 0.06) return;
  audio.sfxShieldBreak({ volume: att });
});

// Armor plate strip — metallic shear when a capital's armor depletes.
events.on("armorStripped", ({ x, y, isPlayer }) => {
  if (!audio.ctx) return;
  const att = isPlayer ? 1 : sfxAttenuation(x, y);
  if (att <= 0.06) return;
  audio.sfxArmorStrip({ volume: att });
});

// Module destroyed — PD turret / missile bay / broadside battery /
// laser / engine / hangar takes its final hit. Smaller than a full
// ship explosion; the per-event intensity scales pitch + duration
// (capitals louder than fighter `gun` module).
events.on("moduleDestroyed", ({ x, y, intensity, isPlayer }) => {
  if (!audio.ctx) return;
  const att = isPlayer ? 1 : sfxAttenuation(x, y);
  if (att <= 0.06) return;
  audio.sfxModuleDestroyed({ volume: att, intensity: intensity || 0.5 });
});

// Carrier replenishment launch — catapult thunk + thrust whoosh as a
// new fighter/bomber clears the bay. Probability-gated for AI carriers
// so a heavy fleet of carriers doesn't sound like a constant launch
// chorus.
events.on("carrierLaunch", ({ x, y }) => {
  if (!audio.ctx) return;
  if (Math.random() > 0.55) return; // sparse, character-only
  const att = sfxAttenuation(x, y);
  if (att <= 0.06) return;
  audio.sfxCarrierLaunch({ volume: att });
});

// Admiral panel — reads and writes game.directives directly. The map
// is allocated by modes/admiral.js at match start; null in other
// modes so the AI fast-paths through the directive check.
//
// Both the (now-orphaned) canvas AdmiralPanel and the live DOM
// .admiral-panel under #battle-root drive into the same setters.
// hud.js' rebuilt grid calls game.setPosture / game.setMissiles, so
// hang them on the game object too — without this the DOM buttons
// render but their click handlers no-op.
// Live admiral orders live on game.directives[klass], BUT fighters/bombers
// carry a per-ship `wingCommand` (stamped at spawn by the fleet plan) that
// ai.js#resolveOrders prioritises OVER the class directive. Capitals have no
// wingCommand so the directive drives them directly — but strike craft were
// reading their stale pre-battle wing order and ignoring every live command
// ("fighters ignore in-game battle commands"). Fix: when a live per-class
// order changes the STANCE or TARGET-PRIORITY axis, push that axis onto every
// commandable blue ship of that class so the live order supersedes the wing
// plan. (MISSILES is read straight off game.directives[klass] in ship.js, so
// it already reached strike craft and needs no propagation.)
const STANCE_FROM_KIND = { free: "engage", press: "charge", hold: "fallback", "defend-capital": "engage", "target-class": "engage" };
const propagateOrderToWings = (klass, axis, value) => {
  if (!game.ships) return;
  for (const s of game.ships) {
    if (s.dead || s.side !== "blue" || s.klass !== klass) continue;
    const wc = s.wingCommand;
    if (!wc) continue; // capitals: the directive path already drives them
    // Normalise a legacy {kind,…} wing order to the new {stance,…} shape on
    // first live edit — resolveOrders only reads our axis once `.stance` is
    // set (otherwise it maps the legacy `.kind` and ignores everything else).
    if (!wc.stance) {
      wc.stance = STANCE_FROM_KIND[wc.kind] || "engage";
      if (wc.priority == null) wc.priority = wc.kind === "target-class" ? "hunt" : "default";
      if (wc.priorityClass == null) wc.priorityClass = wc.kind === "target-class" ? (wc.target ?? null) : null;
    }
    wc[axis] = value;
  }
};
// `setPosture` now writes the STANCE axis (engage/charge/standoff/hold/
// fallback) — the live admiral panel passes stance values. Kept the name so
// the legacy canvas AdmiralPanel hook signature is unchanged.
const setPosture = (klass, stance) => {
  if (game.directives && game.directives[klass]) game.directives[klass].stance = stance;
  propagateOrderToWings(klass, "stance", stance);
};
const setMissiles = (klass, missiles) => {
  if (game.directives && game.directives[klass]) game.directives[klass].missiles = missiles;
};
// FOCUS toggle — sets the TARGET-PRIORITY axis so the class follows the
// admiral's tapped focus target (game.focusTargetId).
const setPriority = (klass, priority) => {
  if (game.directives && game.directives[klass]) game.directives[klass].priority = priority;
  propagateOrderToWings(klass, "priority", priority);
};
game.setPosture = setPosture;
game.setMissiles = setMissiles;
game.setPriority = setPriority;
input.admiralPanel.setHooks(() => game.directives, setPosture, setMissiles);

// Roguelite "Frontier" controller — owns the live run state. The
// StartMenu reads the run via setRoguelite + the onChoice callback;
// matchEnded captures fleet state back into the run; runEnded clears
// it.
let activeRun = loadRun();
let pendingNode = null; // node the player has just chosen to enter — used post-startGame
input.startMenu.setRoguelite({
  meta: loadMeta(),
  run: activeRun,
  refresh,
}, handleRunChoice);

function refresh() {
  activeRun = loadRun();
  input.startMenu.setRoguelite({
    meta: loadMeta(),
    run: activeRun,
    refresh,
  }, handleRunChoice);
}

// Look up the vendor on the currently-pending resupply node so the
// buy* helpers can read its pricing modifiers. Falls through to null
// (no vendor) if the player isn't standing at a resupply.
function currentResupplyVendor() {
  if (!activeRun) return null;
  const node = input && input._pendingResupplyNode;
  return (node && node.vendor) || null;
}

// Deferred node transition. When a jump-encounter fires we hold the
// node-entry action (battle start, event clear, resupply clear) here
// until the player dismisses the encounter overlay. Cleared after
// the proceed call. Null when no transition is pending.
let _deferredProceed = null;

function proceedAfterJump(action, payload) {
  if (!activeRun) return;
  if (action === "battle") {
    const { nodeId, battleMode, doctrine } = payload;
    activeRun.battleMode = battleMode || "fly";
    // Stamp the pre-battle doctrine so buildModeConfig picks it up
    // and threads it through to game.battleDoctrine for spawnCapital.
    activeRun.battleDoctrine = doctrine || "skirmish";
    pendingNode = activeRun.graphs[activeRun.act - 1].nodes.find((n) => n.id === nodeId);
    const cfg = buildModeConfig(activeRun, pendingNode, activeRun.battleMode);
    // Persistent Shipyard design — player deploys as the ship they've
    // built between runs. Frontier always honours the design; legacy
    // modes don't carry one (they're skirmish-only).
    cfg.playerDesign = saveStore.get().playerShip || null;
    const mapW = 5000 + (activeRun.act - 1) * 2000;
    const mapH = 3500 + (activeRun.act - 1) * 1500;
    startGame(game, mapW, mapH, activeRun.faction, "roguelite", cfg, 1);
    input.resetForNewMatch();
    zoom = DEFAULT_ZOOM; // reset view scale per match (see menu-launch note)
    input.admiralActive = !!game.admiralMode;
    audio.start();
  } else if (action === "noncombat") {
    completeNode(activeRun, payload.nodeId);
    refresh();
  }
}

function handleRunChoice(action, payload) {
  if (action === "new-run") {
    activeRun = startNewRun(
      payload.faction,
      payload.seed,
      { callsign: payload.callsign, perkKey: payload.perkKey },
    );
    refresh();
    return;
  }
  if (action === "dismiss-promotion") {
    if (activeRun) { clearPendingPromotion(activeRun); refresh(); }
    return;
  }
  if (action === "dismiss-preamble") {
    if (activeRun) { clearPendingPreamble(activeRun); refresh(); }
    return;
  }
  if (action === "dismiss-dispatch") {
    if (activeRun) { clearPendingDispatch(activeRun); refresh(); }
    return;
  }
  if (action === "select-trait") {
    if (activeRun) { selectPromotionTrait(activeRun, payload.traitKey); refresh(); }
    return;
  }
  if (action === "abandon-run") {
    abandonRun();
    activeRun = null;
    refresh();
    return;
  }
  if (action === "enter-node") {
    if (!activeRun) return;
    const { nodeId } = payload;
    if (!enterNode(activeRun, nodeId)) return;
    // Mid-jump encounter check — enterNode may have stamped a
    // pendingJumpEncounter. Defer the actual battle launch until the
    // overlay is dismissed.
    if (activeRun.pendingJumpEncounter) {
      _deferredProceed = { action: "battle", payload };
      refresh();
      return;
    }
    proceedAfterJump("battle", payload);
    return;
  }
  if (action === "complete-node-noncombat") {
    // Event nodes — the choice was already applied. Now just advance.
    if (!activeRun) return;
    if (!enterNode(activeRun, payload.nodeId)) return;
    if (activeRun.pendingJumpEncounter) {
      _deferredProceed = { action: "noncombat", payload };
      refresh();
      return;
    }
    proceedAfterJump("noncombat", payload);
    return;
  }
  if (action === "enter-node-and-complete") {
    // Resupply nodes — pay fuel, advance, payout. All purchases inside
    // the overlay have already mutated the run via buyRepair / etc.
    if (!activeRun) return;
    if (!enterNode(activeRun, payload.nodeId)) return;
    if (activeRun.pendingJumpEncounter) {
      _deferredProceed = { action: "noncombat", payload };
      refresh();
      return;
    }
    proceedAfterJump("noncombat", payload);
    return;
  }
  if (action === "rename-capital") {
    if (activeRun) {
      renameCapital(activeRun, payload.instanceId, payload.fields || {});
      refresh();
    }
    return;
  }
  if (action === "set-capital-behavior") {
    if (activeRun) {
      setCapitalBehavior(activeRun, payload.instanceId, payload.behavior);
      refresh();
    }
    return;
  }
  if (action === "set-wing-command") {
    if (activeRun) {
      setWingCommand(activeRun, payload.wing, payload.command);
      refresh();
    }
    return;
  }
  if (action === "set-wing-detail") {
    if (activeRun) {
      setWingDetail(activeRun, payload.craft, payload.wingId, payload.command);
      refresh();
    }
    return;
  }
  if (action === "add-wing") {
    if (activeRun) {
      addWing(activeRun, payload.craft, 1);
      refresh();
    }
    return;
  }
  if (action === "remove-wing") {
    if (activeRun) {
      removeWing(activeRun, payload.craft, payload.wingId);
      refresh();
    }
    return;
  }
  if (action === "adjust-wing") {
    if (activeRun) {
      adjustWingCount(activeRun, payload.craft, payload.wingId, payload.delta);
      refresh();
    }
    return;
  }
  if (action === "buy-service-upgrade") {
    buyServiceUpgrade(payload.key);
    refresh();
    return;
  }
  if (action === "shipyard-buy-hull") {
    buyHull(payload.hullId);
    refresh();
    return;
  }
  if (action === "shipyard-set-hull") {
    setHull(payload.hullId);
    refresh();
    return;
  }
  if (action === "shipyard-buy-component") {
    const r = buyComponent(payload.componentId);
    // After a successful buy, auto-equip the new component into the
    // requested slot so the player doesn't have to tap twice.
    if (r.ok && payload.slotId) equipComponent(payload.slotId, payload.componentId);
    refresh();
    return;
  }
  if (action === "shipyard-equip") {
    equipComponent(payload.slotId, payload.componentId);
    refresh();
    return;
  }
  if (action === "shipyard-rename") {
    renameShip(payload.name);
    refresh();
    return;
  }
  if (action === "shipyard-paint") {
    setPaint(payload.primary, payload.trim);
    refresh();
    return;
  }
  if (action === "select-variant") {
    if (activeRun) {
      selectCapitalVariant(activeRun, payload.instanceId, payload.variantKey);
      refresh();
    }
    return;
  }
  if (action === "pick-commander-perk") {
    if (activeRun) {
      pickCommanderPerk(activeRun, payload.ref, payload.perkKey);
      refresh();
    }
    return;
  }
  if (action === "dismiss-jump-encounter") {
    if (activeRun) clearPendingJumpEncounter(activeRun);
    const d = _deferredProceed;
    _deferredProceed = null;
    if (d) proceedAfterJump(d.action, d.payload);
    else refresh();
    return;
  }
  if (action === "buy-repair") {
    if (activeRun) {
      const v = currentResupplyVendor();
      buyRepair(activeRun, payload.instanceId, v);
      refresh();
    }
    return;
  }
  if (action === "buy-recruit") {
    if (activeRun) {
      const v = currentResupplyVendor();
      buyRecruit(activeRun, payload.klass, v);
      refresh();
    }
    return;
  }
  if (action === "buy-refuel") {
    if (activeRun) {
      const v = currentResupplyVendor();
      buyRefuel(activeRun, payload.units || 1, v);
      refresh();
    }
    return;
  }
  if (action === "apply-boon") {
    if (activeRun) { applyBoon(activeRun, payload.boonKey); refresh(); }
    return;
  }
  if (action === "apply-event") {
    if (activeRun) {
      // Snapshot resources before so we can show the player exactly
      // what their choice changed (obvious feedback). The event's
      // apply() returns a flavor outcome string.
      const before = {
        credits: activeRun.resources.credits,
        fuel: activeRun.resources.fuel,
        fighter: activeRun.smallCraft.fighter,
        bomber: activeRun.smallCraft.bomber,
        capitals: activeRun.capitals.length,
      };
      const text = applyEventChoice(activeRun, payload.eventId, payload.choiceIndex);
      const after = {
        credits: activeRun.resources.credits,
        fuel: activeRun.resources.fuel,
        fighter: activeRun.smallCraft.fighter,
        bomber: activeRun.smallCraft.bomber,
        capitals: activeRun.capitals.length,
      };
      const deltas = [];
      const push = (label, b, a) => { if (a !== b) deltas.push({ label, delta: a - b }); };
      push("credits", before.credits, after.credits);
      push("fuel", before.fuel, after.fuel);
      push("fighter", before.fighter, after.fighter);
      push("bomber", before.bomber, after.bomber);
      push("capital", before.capitals, after.capitals);
      // refresh() reloads activeRun from the save (applyEventChoice
      // already persisted the resource changes), so stamp the transient
      // result AFTER refresh — onto the live object the menu reads.
      refresh();
      activeRun._lastEventResult = { text: text || "", deltas };
    }
    return;
  }
}

// When a battle ends, walk live ships → run.capitals + run.smallCraft,
// then either continue the run or end the career. Subscribing here
// (not inside roguelite.js) so we have direct access to the live game
// object. Career-end rules: a SINGLE defeated battle ends the run —
// the player is a Terran officer and the war doesn't give second
// chances. We tag the cause so the run-summary screen can show the
// right death-flavor line.
// Match-end sting — fires for every match, regardless of mode. Player
// won (blue) gets the victory triad; lost (red) gets the defeat
// descent. Bypasses the per-frame SFX budget inside the voice itself
// since it's a single one-shot at the end of the match.
events.on("matchEnded", ({ winner }) => {
  if (!audio.ctx) return;
  if (winner === "blue") audio.sfxVictory();
  else if (winner === "red") audio.sfxDefeat();
});

// New Frontier outcome: bank mission rewards on a win, soft-kill the
// pilot on a loss/KIA. (UI for the result screen is a later slice; this
// just closes the persistence loop.)
events.on("matchEnded", ({ mode, winner }) => {
  if (mode !== "frontier") return;
  game.frontierOutcome = resolveMissionOutcome(game, winner);
});

events.on("matchEnded", ({ mode, winner }) => {
  if (mode !== "roguelite" || !activeRun || !pendingNode) return;
  // Snapshot the run reference up front — completeNode can clear it
  // synchronously on a final-boss win via the runEnded handler below.
  const runRef = activeRun;
  // Pass the node faction through so the promotion picker can gate
  // archetypes like "defector" (Hegemony-only) by enemy faction.
  game.pendingNode = pendingNode;
  captureBattleOutcome(runRef, game);
  // Stash the AAR snapshot on game so the match-over panel renderer
  // (in hud.js#_syncMatchOver) can read it. captureBattleOutcome wrote
  // it onto run.lastBattleReport — but the HUD only has `game`.
  game.lastBattleReport = runRef.lastBattleReport || null;

  // KIA is now an explicit flag, NOT "no/dead player ship". A
  // destroyed player ship no longer respawns — the pilot drops to
  // spectate — so "no isPlayer ship at matchEnd" is the NORMAL state
  // after any player death OR a voluntary spectate, and must not be
  // read as career-ending. `game.playerKIA` is set true ONLY when a
  // Frontier survival roll FAILS (see the death block in game.js); an
  // ejected-but-alive pilot, a voluntary spectator, and an admiral all
  // leave it false so the run continues on a fleet win.
  const isAdmiral = !!game.admiralMode;
  const playerKIA = !isAdmiral && !!game.playerKIA;

  if (winner === "blue") {
    completeNode(runRef, pendingNode.id);
  } else {
    // Any defeat closes the career — but pick a flavor reason so the
    // summary reads correctly. Order matters: KIA trumps fleet-lost,
    // since being dead is the most personal cause.
    if (playerKIA) {
      runRef.endReason = "kia";
    } else if (runRef.capitals.length === 0 && runRef.act >= 2) {
      runRef.endReason = "fleet-lost";
    } else {
      runRef.endReason = "defeat";
    }
  }
  pendingNode = null;

  // KIA can also fire on a *won* battle if the player died in the
  // process but their fleet still cleared the node. That's still a
  // career-ender — heroic last stand. Admiral guard applies here too.
  if (activeRun && winner === "blue" && playerKIA && !activeRun.endReason) {
    activeRun.endReason = "kia";
  }

  if (activeRun && isRunOver(activeRun)) {
    recordRunEnd(activeRun, false, activeRun.endReason);
    // Don't clear the run yet — the match-over panel reads
    // game.runSummary to display the death flavor. discardRun fires
    // in the runEnded subscriber below after the panel is dismissed.
  }
  refresh();
});

// Run-completed cleanup: when act 5's boss is cleared, roguelite.js
// emits runEnded with won=true. We stash a career summary on the game
// object so the match-over panel can render the career arc — rank
// reached, why it ended, callsign — instead of just "you lost". The
// run isn't discarded until the panel is dismissed.
events.on("runEnded", ({ run, won, reason, flavor }) => {
  const rank = (ACT_RANKS[run.act] || {}).rank || "Officer";
  // Compute + bank Shipyard credit payout from the run tally. Pure
  // function — won/loss both pay; loss just doesn't get the war-won
  // bonus. Surfaced on game.runSummary so the match-over panel can
  // show the breakdown.
  const payout = computeRunPayout(run, !!won);
  const newBalance = bankRunPayout(payout);
  game.runSummary = {
    won,
    reason,
    flavor,
    rank,
    callsign: run.callsign || "",
    act: run.act,
    actsTotal: 5,
    visitedCount: (run.visitedNodeIds || []).length,
    // Snapshot of run.stats for the end-screen breakdown.
    stats: run.stats || null,
    // Achievements unlocked this run (Tier 43). Stamped by
    // recordRunEnd on the run object via _achievementsUnlocked.
    achievementsUnlocked: run._achievementsUnlocked || [],
    // Shipyard payout breakdown — surfaced on the match-over panel
    // so players see how their kills converted to credits.
    shipyard: {
      payout: payout.total,
      breakdown: payout.breakdown,
      newBalance,
    },
  };
  if (!won) {
    // Defeated runs are already wiped from save by recordRunEnd's
    // caller (matchEnded sets the flag; we discardRun on dismiss in
    // the menu flow). Drop our cached reference so the menu reverts
    // to NEW CAMPAIGN after the panel is gone.
    activeRun = null;
    discardRun();
  } else {
    activeRun = loadRun();
  }
  refresh();
});

// Energy / stamina state — gates how many matches can be played per
// real-time window. PASSIVE regen ticks each frame via regenTick().
const energy = loadEnergy();
input.startMenu.setEnergy(energy, (packId) => purchaseEnergy(energy, packId));
// Edge-detect the match-over transition so the run controller knows
// when to capture battle outcomes.
let prevMatchOver = false;

let viewW = 0, viewH = 0;
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  viewW = window.innerWidth;
  viewH = window.innerHeight;
  canvas.width = Math.floor(viewW * dpr);
  canvas.height = Math.floor(viewH * dpr);
  canvas.style.width = viewW + "px";
  canvas.style.height = viewH + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  input.layoutOverlays(viewW, viewH);
}
window.addEventListener("resize", resize);
resize();

// Camera zoom. Default reads similar to the old fixed value so existing
// gameplay (piloting a fighter) doesn't shift. In spectator and admiral
// mode the user can pinch / scroll to zoom; the active value is read
// each frame and applied to the world transform + ship draw.
const DEFAULT_ZOOM = 0.5;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.0;
let zoom = DEFAULT_ZOOM;

const FIXED_DT = 1 / 60;
const MAX_ACCUM = 0.25;
let last = performance.now() / 1000;
let accum = 0;
// True while the tab is hidden / the app is backgrounded. The frame loop
// freezes the simulation + draw, and all audio is suspended, so a player
// who swaps tabs or minimises comes back to a paused game with no music
// or SFX having played in the background. See the visibilitychange wiring.
let paused = false;

// Pause-on-hide. Browsers already throttle requestAnimationFrame for
// hidden tabs, but the Web Audio scheduler + context keep running, so the
// soundtrack (and any ringing SFX) would otherwise play on in the
// background. On hide: freeze the sim and suspend all audio. On show:
// wake audio, reset the timestep so we don't process one huge catch-up
// step, and let the frame loop restart the soundtrack if appropriate.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    paused = true;
    audio.suspendAll();
    // Force the music edge-detector to "not playing" so the loop calls
    // audio.start() again on resume (suspendAll halted the scheduler).
    musicWasPlaying = false;
  } else {
    paused = false;
    // Drop the accumulated wall-clock gap from the hidden period — the
    // next frame should advance by a single tick, not replay minutes.
    last = performance.now() / 1000;
    accum = 0;
    audio.resumeCtx();
  }
});

function frame(now) {
  // Tab hidden — keep the RAF chain alive but do no work (no sim, no
  // draw, no audio). Audio is already suspended by the visibility handler.
  if (paused) { requestAnimationFrame(frame); return; }
  const t = now / 1000;
  let delta = t - last;
  last = t;
  if (delta > MAX_ACCUM) delta = MAX_ACCUM;
  // Dev sim-speed (PR-0b): scale the accumulator inflow so a simSpeed
  // of 0.5 produces half the ticks per wall-clock second (slow-mo) and
  // 2.0 produces twice (fast-forward). simSpeed=1 is exactly the
  // pre-PR-0b behaviour.
  accum += delta * (game.simSpeed || 1);

  // Let the input layer know whether the start menu is up so it can
  // intercept clicks before forwarding them to gameplay controls.
  input.menuActive = game.state === "menu";
  // Spectate / admiral both have no piloted ship, so the right stick
  // is hidden (see hud._syncModeChrome) and its real estate becomes a
  // tap-to-select zone for inspecting ships. Mouse clicks anywhere on
  // the canvas count as selects too.
  input.selectActive = game.state === "playing" && (game.spectating || game.admiralMode);

  // Passive energy regen every frame. Idempotent; cheap.
  regenTick(energy);

  if (game.state === "menu") {
    // NEW War-based Frontier launch (FRONTIER_FUTURE.md). Drained
    // separately from consumeStart — the hub's LAUNCH builds its own
    // modeConfig. Starts a fresh rookie pilot if none is alive (career
    // XP/credits persist across pilots), else just (re)flags the War.
    const fl = input.startMenu.consumeFrontierLaunch();
    if (fl) {
      if (!frontierState.hasActiveRun()) frontierState.startNewPilot(fl.warId, fl.pilotClass);
      else frontierState.setActiveWar(fl.warId);
      const cfg = launchFrontierMission(game, fl);
      if (cfg) {
        input.startMenu.showFrontierHub = false;
        input.resetForNewMatch();
        zoom = DEFAULT_ZOOM;
        input.admiralActive = !!game.admiralMode;
        audio.start();
      }
    }
    // Skip the normal start path when a Frontier launch was just
    // consumed this frame. NOTE: do NOT `return` here — frame() must
    // fall through to the requestAnimationFrame(frame) reschedule at
    // the bottom, or the RAF loop dies after launch.
    const choice = fl ? null : input.startMenu.consumeStart();
    // Energy gate: deduct exactly here. The menu already filtered
    // clicks via canSpend, so a failure path is defensive only —
    // re-open the refill overlay and skip the start.
    if (choice && !spendEnergy(energy)) {
      input.startMenu.showRefill = true;
    } else if (choice) {
      if (choice.mode === "roguelite") {
        // Roguelite battles are launched indirectly: clicking a node on
        // the run map calls handleRunChoice("enter-node", ...) which
        // builds the modeConfig and calls startGame itself. The "DEPLOY"
        // path from a Frontier-mode chip click should never fire — the
        // chip opens overlays via _emitStart returning early. Defensive
        // no-op for any future regression.
        return;
      }
      // Open / Defend / Custom / Admiral. Custom carries its full
      // roster bundle through; Admiral flips the input layer to show
      // the command panel.
      // Persistent Shipyard design deploys in every mode that has a
      // player ship. Admiral has no player ship — passing a design is
      // harmless because promotePlayer doesn't run in that path.
      // Pre-battle Fleet Plan (per-class directives + ad-hoc wings) rides
      // on the mode config so game.js#startGame applies it post-spawn.
      const legacyCfg = {
        playerDesign: saveStore.get().playerShip || null,
        fleetPlan: choice.fleetPlan || null,
      };
      let alliedRace = choice.race;
      if (_pendingTestFly) {
        // Free-Form Custom Ship Editor test-fly: the player flies their compiled
        // custom ship instead of the Shipyard design. The custom-battle config
        // chose the opponents/roster/map; we just swap the player ship in. These
        // four params thread through startGame → promotePlayer → createShip and
        // reset to null next match, so the custom ship never leaks into campaign.
        legacyCfg.playerDesign = _pendingTestFly.design;
        legacyCfg.playerSpecOverride = _pendingTestFly.specOverride;
        legacyCfg.playerModuleList = _pendingTestFly.moduleList;
        legacyCfg.playerCellOverride = _pendingTestFly.cellOverride;
        alliedRace = _pendingTestFly.race;
        game.scenario = null;   // ensure custom mode reads the configured roster
        _pendingTestFly = null;
      }
      startGame(game, choice.mapW, choice.mapH, alliedRace, choice.mode, legacyCfg,
                choice.fleetMul, choice.customRoster || null);
      input.resetForNewMatch();
      // `zoom` is a main.js module-level var (not on game), so startGame can't
      // reset it — do it here so a zoomed-out admiral/spectate view never
      // carries into the next match (e.g. two Admiral matches in a row).
      zoom = DEFAULT_ZOOM;
      input.admiralActive = !!game.admiralMode;
      // The "Play" click is the user-gesture that unlocks Web Audio.
      audio.start();
    }
    // Test-fly disarm: if the custom ship is armed but the player closed the
    // configurator without starting (no choice this frame, configurator gone),
    // drop it so it can't slip into a later normal match.
    if (!choice && _pendingTestFly && (!input.startMenu || !input.startMenu.showCustom)) {
      _pendingTestFly = null;
    }
  } else {
    // Player input → controller.
    const ctrl = input.controller();
    game.playerController.thrust = ctrl.thrust;
    game.playerController.aim = ctrl.aim;
    game.playerController.firing = ctrl.firing;
    // Boost — hold to burn charge for +speed/accel. Consumed in
    // updateShip via spec.boost config. Empty controllers default
    // to false so AI ships (which don't get a boost flag) skip.
    game.playerController.boost = !!ctrl.boosting;
    // Edge-triggered missile fire. The flag is consumed inside updateShip.
    // Clear stale presses when there's no live player to fire.
    game.playerController.firingMissile = input.consumeMissilePress();

    // Spectate hotkey OR on-screen SPECTATE button.
    if (input.consumeSpectateToggle()) {
      if (game.spectating) exitSpectate(game);
      else enterSpectate(game);
      // Drop any in-flight pan/pinch so a half-finished gesture doesn't
      // jolt the camera the next time we enter spectate (the consume block
      // is gated on game.spectating, so otherwise a stale delta sits and
      // applies on re-entry).
      input.clearCameraGestures();
    }

    // TAKE COMMAND / RESUME PILOT — drop into the top-down admiral view
    // mid-battle to direct the fleet, then return to the cockpit. Reuses
    // the spectate hand-off (enterSpectate hands the live hull to AI;
    // exitSpectate retakes it if still alive). Only meaningful in modes
    // that have a player ship — the HUD hides the button otherwise.
    if (input.consumeAdmiralToggle()) {
      if (game.admiralMode && game._admiralByToggle) {
        // RESUME PILOT: leave admiral, retake the ship (no-op if it died).
        game.admiralMode = false;
        game._admiralByToggle = false;
        input.admiralActive = false;
        game.focusTargetId = null;   // drop stale focus-fire
        exitSpectate(game);
      } else if (!game.admiralMode && !game.playerEliminated) {
        // TAKE COMMAND: hand the ship to AI (unless already spectating
        // after death) and enter the admiral command view. Gated on
        // !playerEliminated so the C hotkey can't drop an eliminated
        // pilot (who has no hull to return to) into admiral — the HUD
        // already hides the COMMAND pill in that state.
        if (!game.spectating) enterSpectate(game);
        game.admiralMode = true;
        game._admiralByToggle = true;
        input.admiralActive = true;
      }
      input.clearCameraGestures(); // same anti-jolt reset as the spectate toggle
    }
    // Camera zoom: pinch (touch) + wheel (mouse) feed a single delta
    // pool. Spectator and admiral get to use it; piloting keeps the
    // default zoom so the player isn't fighting muscle-memory aim at
    // varying scales. Reset to default when leaving those modes so a
    // zoomed-out admiral doesn't carry a wide view into the next match.
    // Single-keyed on game.spectating (every admiral path sets spectating=true,
    // so dropping the redundant `|| game.admiralMode` keeps zoom, pan, tap, and
    // the draw() camera pick — all gated on spectating — from diverging).
    if (game.spectating) {
      const dz = input.consumePinchDelta();
      if (dz !== 0) {
        zoom *= (1 + dz);
        if (zoom < MIN_ZOOM) zoom = MIN_ZOOM;
        else if (zoom > MAX_ZOOM) zoom = MAX_ZOOM;
      }
    } else if (zoom !== DEFAULT_ZOOM) {
      zoom = DEFAULT_ZOOM;
      input.consumePinchDelta(); // drop any pending input
    }

    if (game.spectating) {
      if (input.consumeSpectateNext()) cycleSpectate(game, +1);
      if (input.consumeSpectatePrev()) cycleSpectate(game, -1);

      // Free-pan camera: in spectate, the left stick (or WASD) detaches
      // the camera from the locked target and lets the user roam the
      // arena. Re-lock happens when they cycle to a different ship via
      // Prev / Next. The right stick is unused in spectate.
      const camSpeed = 700; // world units per second at full deflection
      let panX = ctrl.thrust.x * camSpeed * delta;
      let panY = ctrl.thrust.y * camSpeed * delta;
      // Click-and-drag pan: when a pointer-down on the canvas wanders
      // past the tap threshold, InputManager promotes it to a pan drag
      // and accumulates screen-pixel deltas. Drag direction matches
      // map UX — grab the world and pull, so a rightward drag shifts
      // the camera LEFT (subtract).
      const dragPan = input.consumePanDelta();
      if (dragPan) {
        panX -= dragPan.x / zoom;
        panY -= dragPan.y / zoom;
      }
      if (panX !== 0 || panY !== 0) {
        if (game.spectateCamera.locked) {
          // First nudge — seed camera at the current target before
          // unlocking so there's no jump.
          const t = getSpectateTarget(game);
          if (t) {
            game.spectateCamera.x = t.pos.x;
            game.spectateCamera.y = t.pos.y;
          }
          game.spectateCamera.locked = false;
        }
        game.spectateCamera.x += panX;
        game.spectateCamera.y += panY;
        // Clamp to arena so the user can't pan off into the void.
        const b = game.arena.bounds;
        if (game.spectateCamera.x < b.minX) game.spectateCamera.x = b.minX;
        if (game.spectateCamera.x > b.maxX) game.spectateCamera.x = b.maxX;
        if (game.spectateCamera.y < b.minY) game.spectateCamera.y = b.minY;
        if (game.spectateCamera.y > b.maxY) game.spectateCamera.y = b.maxY;
      }

      // Tap-to-select: short, low-movement clicks/taps in spectate or
      // admiral select the nearest live ship for the target panel +
      // spectate-pill readout. The InputManager flagged this gesture
      // in onUp; here we convert the canvas-space tap to world coords
      // using the camera we just panned + the live zoom.
      const tap = input.consumeTap();
      if (tap) {
        const wx = _lastCamera.x + (tap.x - viewW / 2) / zoom;
        const wy = _lastCamera.y + (tap.y - viewH / 2) / zoom;
        let best = null, bestD2 = Infinity;
        for (const s of game.ships) {
          // Skip surrendered hulks: they're untargetable drifting wrecks, so
          // locking the camera on one (or, in admiral, focus-firing it) is a
          // dead end — the AI ignores them. Matches the surrender-skip
          // convention used by every target-picker.
          if (s.dead || s.surrendered) continue;
          const dx = s.pos.x - wx;
          const dy = s.pos.y - wy;
          const r = (s.spec && s.spec.radius) || s.radius || 20;
          // Generous pick radius: hit-zone is the ship visual + 28 px
          // world slack so fighters are still tappable on a phone.
          const slack = 28 / zoom;
          const reach = (r + slack) * (r + slack);
          const d2 = dx * dx + dy * dy;
          if (d2 < reach && d2 < bestD2) { best = s; bestD2 = d2; }
        }
        if (best) {
          // In admiral mode, tapping an enemy sets focus-fire instead
          // of moving the spectate lock. Tapping a friendly still
          // re-aims the inspect camera so the admiral can watch a
          // specific commander. Spectate-without-admiral keeps the
          // legacy behaviour (any tap locks the camera).
          if (game.admiralMode && best.side === "red") {
            game.focusTargetId = best.id;
            // Don't disturb the camera lock — the player is directing
            // attention to a target, not changing what they're watching.
          } else {
            game.spectateTargetId = best.id;
            if (game.spectateCamera) game.spectateCamera.locked = true;
          }
        }
      }
    }

    // Edge-trigger: match just ended this frame. Roguelite handling
    // (capture fleet state, advance run) lives inside the matchEnded
    // listener registered above; this block only handles the
    // return-to-menu input.
    prevMatchOver = game.matchOver;

    // Advance past the (now interactive) end-of-battle report. Two explicit
    // signals: the HUD CONTINUE / RETURN button (touch + mouse) and the
    // Enter key (desktop). Both are drained every frame so a stale flag
    // can't linger. The old window-level tap-anywhere dismiss is gone — it
    // fired on taps ON the report too, so the player couldn't read it.
    const advanceEnter = input.consumeEnterPress();
    const advanceBtn = input.consumeMatchAdvance();
    if (game.matchOver && (advanceEnter || advanceBtn)) {
      const wasRoguelite = game.mode === "roguelite";
      const wasFrontier = game.mode === "frontier";
      restart(game);
      audio.stop();
      refresh();
      // If a Frontier run is still alive, re-open the run map so the
      // player lands back at the fleet/map view instead of the bare
      // main menu.
      if (wasRoguelite && activeRun) {
        input.startMenu.selectedMode = "roguelite";
        input.startMenu._layoutRunMap(viewW || 1200, viewH || 800);
        input.startMenu.showRunMap = true;
      }
      // New Frontier: return to the hub (rewards already banked by the
      // matchEnded subscriber). A soft-death loss left no active run —
      // the hub handles that (LAUNCH restarts a fresh rookie pilot).
      if (wasFrontier) input.startMenu.showFrontierHub = true;
    }
  }

  // In-match QUIT (HUD button or Escape key): bail out of the current
  // match and return to the main menu. Only fires while playing — at
  // matchOver the enter-press path already returns to menu. Roguelite
  // runs preserve their saved state so re-opening Frontier resumes the
  // run on the same node.
  if (game.state === "playing" && !game.matchOver && input.consumeQuitRequest()) {
    const wasRoguelite = game.mode === "roguelite";
    const wasFrontier = game.mode === "frontier";
    restart(game);
    audio.stop();
    refresh();
    if (wasRoguelite && activeRun) {
      input.startMenu.selectedMode = "roguelite";
      input.startMenu._layoutRunMap(viewW || 1200, viewH || 800);
      input.startMenu.showRunMap = true;
    }
    // Frontier: a mid-match QUIT abandons the sortie (no reward, run
    // stays alive) and returns to the hub.
    if (wasFrontier) input.startMenu.showFrontierHub = true;
  }

  // In-match SETTINGS (HUD pill): pop the menu's settings overlay over
  // the live battle so the player can toggle music/SFX without quitting.
  // The overlay's CLOSE button tears itself down via onSettingsClose
  // (see input.js); main.js doesn't need to know about close.
  if (game.state === "playing" && input.consumeSettingsRequest()) {
    input.startMenu.openInBattleSettings(viewW || 1200, viewH || 800);
  }

  // P toggles music mute (works regardless of state). Routes through
  // applyMuteChange so the new state persists to saveStore.
  if (input.consumeMuteToggle()) applyMuteChange(!audio.isMuted());

  // Music plays only during active gameplay. Pause it on match-over
  // and on the start menu; resume when a new game kicks off (the
  // startGame branch above calls audio.start()).
  const shouldPlay = game.state === "playing" && !game.matchOver;
  if (shouldPlay && !musicWasPlaying) audio.start();
  else if (!shouldPlay && musicWasPlaying) audio.stop();
  musicWasPlaying = shouldPlay;

  // Dev pause / step (PR-0b). When paused, drain the accumulator without
  // ticking — keeps the clock from snapping forward on unpause.
  // `stepOnce` lets the dev overlay advance one fixed tick at a time
  // while paused. Defaults (paused=false, stepOnce=false) are pre-PR-0b
  // behaviour.
  if (game.paused) {
    if (game.stepOnce) {
      update(game, FIXED_DT);
      game.stepOnce = false;
    }
    accum = 0;
  } else {
    while (accum >= FIXED_DT) {
      update(game, FIXED_DT);
      accum -= FIXED_DT;
    }
  }

  draw();
  requestAnimationFrame(frame);
}

function draw() {
  // Camera: spectate target if spectating + locked, free-pan position
  // if unlocked, else player, else arena center.
  let camera;
  if (game.spectating) {
    if (game.spectateCamera && !game.spectateCamera.locked) {
      camera = { x: game.spectateCamera.x, y: game.spectateCamera.y };
    } else {
      const spec = getSpectateTarget(game);
      if (spec) {
        // Mirror the live locked target into spectateCamera every frame so
        // that when the target dies (update() silently auto-recycles the
        // spectate id) or we start panning, the camera resumes from the
        // last-seen position instead of snapping to a stale lock point.
        if (game.spectateCamera) { game.spectateCamera.x = spec.pos.x; game.spectateCamera.y = spec.pos.y; }
        camera = { x: spec.pos.x, y: spec.pos.y };
      } else {
        camera = game.spectateCamera
          ? { x: game.spectateCamera.x, y: game.spectateCamera.y }
          : { x: ARENA.width / 2, y: ARENA.height / 2 };
      }
    }
  } else {
    const player = game.ships.find((s) => s.isPlayer && !s.dead);
    camera = player
      ? { x: player.pos.x, y: player.pos.y }
      : { x: ARENA.width / 2, y: ARENA.height / 2 };
  }

  _lastCamera.x = camera.x;
  _lastCamera.y = camera.y;
  audio.tickSfxBudget();

  drawArena(ctx, game.starfield, camera, viewW, viewH, zoom);

  ctx.save();
  ctx.translate(viewW / 2, viewH / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-camera.x, -camera.y);

  drawArenaBounds(ctx);
  // Map decor (PR-3 of DEV_FEATURES_PLAN.md). Drawn AFTER bounds + BEFORE
  // wrecks so a fresh wreck still chips off in front of an asteroid,
  // and BEFORE ships so a fighter brushing past silhouettes against the
  // rock rather than getting eclipsed by it. Visual-only — no collision
  // wiring this phase.
  if (ARENA.decor && ARENA.decor.length) drawDecor(ctx, ARENA.decor, zoom);
  // Persistent wrecks sit UNDER everything live so a fresh kill drops
  // into the background as the battle keeps going on top.
  if (game.wrecks) for (const w of game.wrecks) drawWreck(ctx, w);
  // Defence platforms (PR-4 of DEV_FEATURES_PLAN.md). Drawn AFTER wrecks
  // and decor but BEFORE ships so a fighter flying over the bastion's
  // hex silhouettes against it, not the other way around.
  if (game.platforms && game.platforms.length) {
    for (const pl of game.platforms) if (!pl.dead) drawPlatform(ctx, pl);
  }
  // Smoke particles render behind the hull layer so plumes look like
  // they're trailing from the ship rather than painted on top of it.
  if (game.particles) {
    for (const p of game.particles) if (p.kind === "smoke") drawParticle(ctx, p);
  }
  for (const ship of game.ships) if (!ship.dead) drawShip(ctx, ship, zoom);
  for (const p of game.projectiles) if (!p.dead) drawProjectile(ctx, p);
  drawBeams(ctx, game);
  // Admiral focus reticle: rotating dashed ring on the focused enemy
  // so the player can see which target the fleet is prioritising at
  // a glance. Drawn AFTER ships so it sits on top of the hull.
  if (game.admiralMode && game.focusTargetId != null) {
    const ft = game.ships.find((s) => s.id === game.focusTargetId && !s.dead && !s.surrendered);
    if (ft) {
      const r = (ft.spec && ft.spec.radius) || 24;
      const ringR = r + 22;
      const t = performance.now() / 1000;
      ctx.save();
      ctx.translate(ft.pos.x, ft.pos.y);
      ctx.rotate(t * 0.6);
      ctx.strokeStyle = "rgba(255,210,90,0.95)";
      ctx.lineWidth = 2.5 / zoom;
      ctx.setLineDash([10 / zoom, 6 / zoom]);
      ctx.beginPath();
      ctx.arc(0, 0, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      // Four corner brackets so the reticle reads as a target lock,
      // not just a dashed circle.
      const br = ringR + 8;
      const bl = 14 / zoom;
      ctx.lineWidth = 2.5 / zoom;
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
        const cx = Math.cos(a) * br;
        const cy = Math.sin(a) * br;
        ctx.beginPath();
        ctx.moveTo(cx - bl * Math.cos(a + 0.4), cy - bl * Math.sin(a + 0.4));
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx - bl * Math.cos(a - 0.4), cy - bl * Math.sin(a - 0.4));
        ctx.stroke();
      }
      ctx.restore();
    } else {
      // Focus target is dead or missing — clear so the panel hides
      // and the AI stops trying to honour a phantom target.
      game.focusTargetId = null;
    }
  }
  // Persistent debris on top of live ships — fresh chunks visibly chip
  // off the hull mid-engagement instead of fading with the particles.
  if (game.debris) for (const d of game.debris) drawDebris(ctx, d);
  // Sparks / fire / debris / shockwaves render on top of ships and beams
  // so a freshly-killed module's explosion reads above the hull silhouette.
  if (game.particles) {
    for (const p of game.particles) if (p.kind !== "smoke") drawParticle(ctx, p);
  }

  ctx.restore();

  // DOM-based BattleHUD (lazy init)
  if (!input._battleHUD) {
    input._battleHUD = new BattleHUD(document.body, input);
  }
  input._battleHUD.sync(game, viewW, viewH);
  if (game.state === "playing") {
    input._battleHUD.show();
  } else {
    input._battleHUD.hide();
  }

  // Pre-match menu: lazy-mounts the DOM MenuSystem on first call and
  // keeps it synced. Without this the page shows a black canvas on
  // first load — the menu DOM never mounts. The else branch tears the
  // menu chrome down once a battle starts; without it the DOM menu
  // (z-15) keeps sitting on top of the canvas/HUD for the rest of the
  // match — the user saw it as "menu persists on Open / Defend /
  // Admiral / Custom."
  if (game.state === "menu") {
    input.startMenu.draw(ctx, viewW, viewH);
  } else {
    input.startMenu.hide();
  }

  // Dev-only balance HUD (Phase 0 of DEV_FEATURES_PLAN.md). Drawn LAST
  // so it overlays everything; reads game.battleStats directly. Zero
  // cost when Dev Mode is off — single boolean check.
  if (isDev()) {
    drawBalanceHUD(ctx, game, viewW, viewH);
    if (_devOverlay) _devOverlay.sync();
  }

  // Virtual stick DOM updates
  input.drawSticks(ctx);
}

// NOTE: the end-of-battle report is interactive — advancing past it is
// handled by the HUD CONTINUE / RETURN button (input.matchAdvanceRequested)
// and the Enter key, both drained in the frame loop above. The old
// window-level "tap anywhere to dismiss" listener was removed: it fired on
// taps landing ON the report panel, so the player couldn't scroll, switch
// tabs, or expand rows without instantly closing the match.

requestAnimationFrame(frame);
