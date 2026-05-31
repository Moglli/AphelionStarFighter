/**
 * @file Frontier career-state helpers — the read/write API over the
 * `frontier` save block (FRONTIER_FUTURE.md §3.2–§3.4).
 *
 * Single funnel for every mutation of the new War-based Frontier state,
 * so the persistence shape lives in exactly one place. All writes go
 * through saveStore.update (debounced persist). The legacy `roguelite`
 * block is NOT touched here — the two coexist until the menu route is
 * swapped.
 *
 * Soft-death model: career XP and war credits are banked CONTINUOUSLY
 * (grantXp / bankCredits write straight to meta), so a pilot death never
 * costs earned progress. The live `run` only carries per-run tallies for
 * the end-of-run summary; killing the pilot just nulls it.
 *
 * commandTier is intentionally NOT stored — it's a pure function of
 * careerXp (career.js). Read it via currentTier()/pilotableNow().
 */

import { saveStore } from "../save.js";
import {
  tierForXp, tierProgress, pilotableClasses, canCommand, MAX_TIER, CAREER_TIERS,
} from "./career.js";
import { getWar, nextChapter } from "./wars.js";

/** XP awarded per mission completion, by battle kind. Placeholder. */
const MISSION_XP = {
  sweep: 120,
  defense: 160,
  "capital-assault": 240,
  fleet: 320,
  surrender: 280,
  boss: 600,
};

/** Credits awarded per mission completion, by battle kind. Placeholder. */
const MISSION_CREDITS = {
  sweep: 200,
  defense: 260,
  "capital-assault": 400,
  fleet: 550,
  surrender: 500,
  boss: 1200,
};

/** Career XP per enemy kill, by enemy class. Placeholder. */
const KILL_XP = {
  fighter: 3, bomber: 6, frigate: 20, cruiser: 45, battleship: 90, carrier: 90, station: 60,
};

/**
 * Ensure the frontier block (and the per-War record for `warId`, if
 * given) exists. Defensive: mergeWithDefaults already builds the full
 * shape on load, but a War added at runtime won't be in an existing
 * save's `wars` map until first touched.
 * @returns {any} the live frontier block (mutate inside saveStore.update)
 */
function ensureFrontier(data, warId) {
  if (!data.frontier) {
    data.frontier = {
      careerXp: 0, warCredits: 0, unlockedClasses: ["fighter"],
      loadouts: { fighter: {}, bomber: {}, frigate: {}, cruiser: {}, battleship: {}, carrier: {} },
      stash: [], activeWarId: null, wars: {}, run: null,
      decorations: [], trophies: [], unlockedAchievements: [],
    };
  }
  const f = data.frontier;
  if (warId && !f.wars[warId]) {
    f.wars[warId] = { chaptersCompleted: 0, completed: false, sortiesFlown: 0, kills: {} };
  }
  return f;
}

/** Live frontier block (read-only snapshot — do not mutate directly). */
export function getFrontier() {
  return saveStore.get().frontier;
}

/** Per-War progress record (creates + persists the seed if missing). */
export function getWarState(warId) {
  let out = null;
  saveStore.update((data) => { out = ensureFrontier(data, warId).wars[warId]; });
  return out;
}

/** Current career tier object (derived from XP). */
export function currentTier() {
  return tierForXp(getFrontier().careerXp);
}

/** Tier progress block for HUD/UI. */
export function currentTierProgress() {
  return tierProgress(getFrontier().careerXp);
}

/**
 * Ship classes the player may pilot right now — the tier floor UNIONed
 * with any IAP-granted classes stored in unlockedClasses.
 * @returns {string[]}
 */
export function pilotableNow() {
  const f = getFrontier();
  const set = new Set(pilotableClasses(f.careerXp));
  for (const c of (f.unlockedClasses || [])) set.add(c);
  return [...set];
}

/** True if the player may pilot `klass` right now. */
export function canPilotNow(klass) {
  return pilotableNow().includes(klass);
}

/** True if the player may take fleet command (admiral) right now. */
export function canCommandNow() {
  return canCommand(getFrontier().careerXp);
}

/** Set the War the player is currently engaged with. */
export function setActiveWar(warId) {
  saveStore.update((data) => { ensureFrontier(data, warId).activeWarId = warId; });
}

/**
 * Bank career XP (continuous — survives death). Also tallies onto the
 * live run for the end-of-run summary, if one is active.
 * @returns {{xp:number, tierBefore:number, tierAfter:number, promoted:boolean}}
 */
export function grantXp(amount) {
  const amt = Math.max(0, Math.round(amount || 0));
  let result = { xp: 0, tierBefore: 0, tierAfter: 0, promoted: false };
  saveStore.update((data) => {
    const f = ensureFrontier(data);
    const before = tierForXp(f.careerXp).tier;
    f.careerXp += amt;
    const after = tierForXp(f.careerXp).tier;
    if (f.run) f.run.xpThisRun = (f.run.xpThisRun || 0) + amt;
    result = { xp: f.careerXp, tierBefore: before, tierAfter: after, promoted: after > before };
  });
  return result;
}

/** Bank war credits (continuous — survives death). */
export function bankCredits(amount) {
  const amt = Math.round(amount || 0);
  let total = 0;
  saveStore.update((data) => {
    const f = ensureFrontier(data);
    f.warCredits = Math.max(0, f.warCredits + amt);
    if (f.run && amt > 0) f.run.creditsThisRun = (f.run.creditsThisRun || 0) + amt;
    total = f.warCredits;
  });
  return total;
}

/**
 * Spend war credits if affordable. Returns true on success, false if the
 * player can't afford it (no deduction made). Used by the Quartermaster.
 */
export function spendCredits(amount) {
  const amt = Math.max(0, Math.round(amount || 0));
  let ok = false;
  saveStore.update((data) => {
    const f = ensureFrontier(data);
    if (f.warCredits >= amt) { f.warCredits -= amt; ok = true; }
  });
  return ok;
}

/**
 * Record a kill against the active War's ledger + the live run tally,
 * and grant the per-class kill XP.
 * @param {string} warId
 * @param {string} enemyClass
 */
export function recordKill(warId, enemyClass) {
  saveStore.update((data) => {
    const f = ensureFrontier(data, warId);
    const w = f.wars[warId];
    w.kills[enemyClass] = (w.kills[enemyClass] || 0) + 1;
    if (f.run) f.run.killsThisRun = (f.run.killsThisRun || 0) + 1;
  });
  grantXp(KILL_XP[enemyClass] || 1);
}

/**
 * Start a fresh rookie pilot run in a War. Career meta (XP, tier,
 * credits, loadouts, war progress) is untouched — only the live `run`
 * is (re)seeded. `pilotClass` must be pilotable at the current tier;
 * falls back to "fighter".
 * @param {string} warId
 * @param {string} pilotClass
 */
export function startNewPilot(warId, pilotClass = "fighter") {
  const klass = canPilotNow(pilotClass) ? pilotClass : "fighter";
  saveStore.update((data) => {
    const f = ensureFrontier(data, warId);
    f.activeWarId = warId;
    f.run = {
      warId,
      pilotClass: klass,
      alive: true,
      xpThisRun: 0,
      creditsThisRun: 0,
      killsThisRun: 0,
      missionsThisRun: 0,
    };
  });
  return getFrontier().run;
}

/** True if a live pilot run is in progress. */
export function hasActiveRun() {
  const f = getFrontier();
  return !!(f && f.run && f.run.alive);
}

/**
 * Kill the live pilot (soft-death). Banked XP/credits already persisted;
 * this just ends the run. Returns the final run tally for the summary
 * screen.
 */
export function killPilot() {
  let summary = null;
  saveStore.update((data) => {
    const f = ensureFrontier(data);
    if (f.run) { f.run.alive = false; summary = { ...f.run }; }
    f.run = null;
  });
  return summary;
}

/**
 * Mark a chapter complete. Only advances the spine if `chapterId` is the
 * NEXT uncompleted chapter (out-of-order or re-flown chapters award
 * mission rewards but don't push the spine). Awards XP + credits.
 * @returns {{advanced:boolean, chaptersCompleted:number, warCompleted:boolean,
 *   xp:object, credits:number}}
 */
export function completeChapter(warId, chapterId) {
  const war = getWar(warId);
  if (!war) return { advanced: false, chaptersCompleted: 0, warCompleted: false, xp: null, credits: 0 };
  const chapter = war.chapters.find((c) => c.id === chapterId) || null;
  const kind = (chapter && chapter.battle && chapter.battle.kind) || "sweep";

  let advanced = false, chaptersCompleted = 0, warCompleted = false;
  saveStore.update((data) => {
    const f = ensureFrontier(data, warId);
    const w = f.wars[warId];
    const expected = nextChapter(warId, w.chaptersCompleted);
    if (expected && expected.id === chapterId) {
      w.chaptersCompleted += 1;
      advanced = true;
      if (w.chaptersCompleted >= war.chapters.length) w.completed = true;
    }
    chaptersCompleted = w.chaptersCompleted;
    warCompleted = w.completed;
    if (f.run) f.run.missionsThisRun = (f.run.missionsThisRun || 0) + 1;
  });

  const xpGained = MISSION_XP[kind] || 100;
  const creditsGained = MISSION_CREDITS[kind] || 150;
  const xp = grantXp(xpGained);
  bankCredits(creditsGained);
  return { advanced, chaptersCompleted, warCompleted, xp, xpGained, creditsGained, promoted: xp.promoted, tierAfter: xp.tierAfter };
}

/** Record a flown side sortie (awards XP + credits; bumps the counter). */
export function completeSortie(warId, sortieId) {
  const war = getWar(warId);
  const sortie = war && war.sorties.find((s) => s.id === sortieId);
  const kind = (sortie && sortie.battle && sortie.battle.kind) || "sweep";
  saveStore.update((data) => {
    const f = ensureFrontier(data, warId);
    f.wars[warId].sortiesFlown += 1;
    if (f.run) f.run.missionsThisRun = (f.run.missionsThisRun || 0) + 1;
  });
  const xpGained = MISSION_XP[kind] || 100;
  const creditsGained = MISSION_CREDITS[kind] || 150;
  const xp = grantXp(xpGained);
  bankCredits(creditsGained);
  return { xp, xpGained, creditsGained, promoted: xp.promoted, tierAfter: xp.tierAfter };
}

export { MISSION_XP, MISSION_CREDITS, KILL_XP, MAX_TIER, CAREER_TIERS };
