import {
  createGame, update, restart, startGame,
  enterSpectate, exitSpectate, cycleSpectate, getSpectateTarget,
} from "./game.js";
import { drawArena, drawArenaBounds, ARENA } from "./arena.js";
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
import {
  recordKill, computeRunPayout, bankRunPayout,
  buyHull, setHull, buyComponent, equipComponent, renameShip, setPaint,
} from "./shipyard.js";

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
input.startMenu.setSettings(
  () => ({
    musicVolume: audio.getMusicVolume(),
    sfxVolume: audio.getSfxVolume(),
    musicMuted: audio.isMuted(),
    sfxMuted: audio.isSfxMuted(),
  }),
  (patch) => {
    if (typeof patch.musicVolume === "number") applyMusicVolume(patch.musicVolume);
    if (typeof patch.sfxVolume === "number") applySfxVolume(patch.sfxVolume);
    if (typeof patch.musicMuted === "boolean") applyMuteChange(patch.musicMuted);
    if (typeof patch.sfxMuted === "boolean") applySfxMuteChange(patch.sfxMuted);
  },
);

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
// `setPosture` now writes the STANCE axis (engage/charge/standoff/hold/
// fallback) — the live admiral panel passes stance values. Kept the name so
// the legacy canvas AdmiralPanel hook signature is unchanged.
const setPosture = (klass, stance) => {
  if (game.directives && game.directives[klass]) game.directives[klass].stance = stance;
};
const setMissiles = (klass, missiles) => {
  if (game.directives && game.directives[klass]) game.directives[klass].missiles = missiles;
};
// FOCUS toggle — sets the TARGET-PRIORITY axis so the class follows the
// admiral's tapped focus target (game.focusTargetId).
const setPriority = (klass, priority) => {
  if (game.directives && game.directives[klass]) game.directives[klass].priority = priority;
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
  accum += delta;

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
    const choice = input.startMenu.consumeStart();
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
      startGame(game, choice.mapW, choice.mapH, choice.race, choice.mode, legacyCfg,
                choice.fleetMul, choice.customRoster || null);
      input.resetForNewMatch();
      input.admiralActive = !!game.admiralMode;
      // The "Play" click is the user-gesture that unlocks Web Audio.
      audio.start();
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
    }
    // Camera zoom: pinch (touch) + wheel (mouse) feed a single delta
    // pool. Spectator and admiral get to use it; piloting keeps the
    // default zoom so the player isn't fighting muscle-memory aim at
    // varying scales. Reset to default when leaving those modes so a
    // zoomed-out admiral doesn't carry a wide view into the next match.
    if (game.spectating || game.admiralMode) {
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
          if (s.dead) continue;
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

    if (game.matchOver && input.consumeEnterPress()) {
      const wasRoguelite = game.mode === "roguelite";
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
    }
  }

  // In-match QUIT (HUD button or Escape key): bail out of the current
  // match and return to the main menu. Only fires while playing — at
  // matchOver the enter-press path already returns to menu. Roguelite
  // runs preserve their saved state so re-opening Frontier resumes the
  // run on the same node.
  if (game.state === "playing" && !game.matchOver && input.consumeQuitRequest()) {
    const wasRoguelite = game.mode === "roguelite";
    restart(game);
    audio.stop();
    refresh();
    if (wasRoguelite && activeRun) {
      input.startMenu.selectedMode = "roguelite";
      input.startMenu._layoutRunMap(viewW || 1200, viewH || 800);
      input.startMenu.showRunMap = true;
    }
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

  while (accum >= FIXED_DT) {
    update(game, FIXED_DT);
    accum -= FIXED_DT;
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
      camera = spec
        ? { x: spec.pos.x, y: spec.pos.y }
        : (game.spectateCamera
          ? { x: game.spectateCamera.x, y: game.spectateCamera.y }
          : { x: ARENA.width / 2, y: ARENA.height / 2 });
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
  // Persistent wrecks sit UNDER everything live so a fresh kill drops
  // into the background as the battle keeps going on top.
  if (game.wrecks) for (const w of game.wrecks) drawWreck(ctx, w);
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
    const ft = game.ships.find((s) => s.id === game.focusTargetId && !s.dead);
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

  // Virtual stick DOM updates
  input.drawSticks(ctx);
}

window.addEventListener("pointerdown", () => {
  if (game.matchOver && game.state === "playing") {
    const wasRoguelite = game.mode === "roguelite";
    restart(game);
    refresh();
    if (wasRoguelite && activeRun) {
      input.startMenu.selectedMode = "roguelite";
      input.startMenu._layoutRunMap(viewW || 1200, viewH || 800);
      input.startMenu.showRunMap = true;
    }
  }
});

requestAnimationFrame(frame);
