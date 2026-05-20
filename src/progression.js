/**
 * @file Progression — XP, levels, currency, and daily-login economy.
 *
 * Listens on the event bus established in Phase 0 and emitted from in
 * Phase 1. All economy decisions live here. Game code never writes to
 * currency or XP directly; it just emits domain events.
 *
 * Two currencies:
 *   credits  (soft) — earned from kills, wins, missions, level-ups.
 *                     Spent on cosmetic crates (Phase 3).
 *   aphelium (hard) — drips from daily completion + level milestones;
 *                     primarily purchased via IAP in Phase 3.
 *
 * XP curve: cumulative XP needed to *complete* level N is
 *   xpForLevel(N) = 100 * N + 50 * N * N
 * so level 1 → 2 = 150 XP, 2 → 3 = 250 XP increment, 9 → 10 = 950 XP,
 * which gives roughly 8–15 matches per level early and slows down.
 */

import { events } from "./events.js";
import { saveStore } from "./save.js";
import { todaySeed } from "./modes/daily.js";

const XP_PER_KILL = {
  fighter: 12,
  bomber:  22,
  frigate: 45,
  cruiser: 85,
  battleship: 170,
  carrier: 220,
};

const CREDITS_PER_KILL = {
  fighter: 2,
  bomber:  4,
  frigate: 8,
  cruiser: 16,
  battleship: 32,
  carrier: 40,
};

const WIN_XP = 250;
const WIN_CREDITS = 100;
const PARTICIPATION_XP = 40;
const FIRST_WIN_OF_DAY_XP = 400;
const FIRST_WIN_OF_DAY_CREDITS = 200;
const DAILY_MODE_CLEAR_APHELIUM = 5;
const LEVEL_UP_CREDITS = 50;
const LEVEL_MILESTONE_APHELIUM = 20;    // every 5 levels

// Escalating daily-login reward by streak (last value sticks).
const LOGIN_BONUS_TABLE = [100, 150, 200, 300, 500];
const LOGIN_STREAK_TABLE = [0, 0, 0, 0, 0];  // streak counter mirrors index

const RECENT_REWARDS_CAP = 8;

/**
 * Cumulative XP required to *complete* level N (i.e. to reach N+1).
 * @param {number} n
 */
export function xpForLevel(n) {
  return 100 * n + 50 * n * n;
}

/** Current progress through the level the player is on. */
export function levelProgress(xp, level) {
  const start = level <= 1 ? 0 : sumXpThroughLevel(level - 1);
  const end = sumXpThroughLevel(level);
  return {
    levelStartXp: start,
    levelEndXp: end,
    current: Math.max(0, xp - start),
    span: end - start,
    fraction: Math.max(0, Math.min(1, (xp - start) / (end - start))),
  };
}

function sumXpThroughLevel(n) {
  // Sum of xpForLevel(1..n).
  let s = 0;
  for (let i = 1; i <= n; i++) s += xpForLevel(i);
  return s;
}

class Progression {
  constructor() {
    // Toasts collected for the HUD to render. Game code consumes via
    // `consumeRecentRewards()` so the same award doesn't render twice.
    /** @type {Array<{ text: string, kind: string, t: number }>} */
    this.recentRewards = [];
    this._matchKillsSnapshot = 0; // for awarding at match-end
    this._subscribe();
    this._processDailyLogin();
  }

  // ---------------------------------------------------------------------
  // Public API consumed by HUD / hangar.
  // ---------------------------------------------------------------------

  /** Drain pending reward toasts. Returns an array; clears the buffer. */
  consumeRecentRewards() {
    const out = this.recentRewards;
    this.recentRewards = [];
    return out;
  }

  /** True if today's UTC login bonus is unclaimed. */
  loginBonusAvailable() {
    const d = saveStore.get();
    return !sameUtcDay(d.lastLoginEpochMs, Date.now());
  }

  /** Claim today's bonus; awards credits + small Aphelium. Idempotent per day. */
  claimLoginBonus() {
    if (!this.loginBonusAvailable()) return null;
    const now = Date.now();
    let award = LOGIN_BONUS_TABLE[0];
    let streakIndex = 0;
    saveStore.update((data) => {
      const prev = data.lastLoginEpochMs;
      const consecutive = prev != null && isConsecutiveUtcDay(prev, now);
      const newStreak = consecutive
        ? Math.min((data.loginStreak || 1) + 1, LOGIN_BONUS_TABLE.length)
        : 1;
      streakIndex = newStreak - 1;
      award = LOGIN_BONUS_TABLE[streakIndex];
      data.softCurrency += award;
      data.lastLoginEpochMs = now;
      data.loginStreak = newStreak;
    });
    this._toast(`Daily bonus  +${award} credits  (streak ${streakIndex + 1})`, "credits");
    saveStore.flush();
    return { credits: award, streak: streakIndex + 1 };
  }

  // ---------------------------------------------------------------------
  // Event subscriptions.
  // ---------------------------------------------------------------------

  _subscribe() {
    events.on("shipDestroyed", ({ ship, byPlayer }) => {
      if (!byPlayer) return;
      if (ship.side === "blue") return; // friendly fire / accidents shouldn't pay
      const xp = XP_PER_KILL[ship.klass] || 10;
      const credits = CREDITS_PER_KILL[ship.klass] || 1;
      this._awardXp(xp);
      saveStore.update((data) => { data.softCurrency += credits; });
    });

    events.on("playerDestroyed", () => {
      saveStore.update((data) => { data.stats.deaths += 1; });
    });

    events.on("waveCleared", ({ wave }) => {
      const xp = 30 + wave * 10;
      this._awardXp(xp);
      this._toast(`Wave ${wave} cleared  +${xp} XP`, "xp");
    });

    events.on("runEnded", ({ won, reason }) => {
      if (won) {
        this._toast(`FRONTIER RUN COMPLETE`, "win");
      } else if (reason === "wiped") {
        this._toast(`Run ended — fleet lost`, "xp");
      }
      // Meta-progression bookkeeping (runsCompleted, warProgress,
      // perk unlocks) is owned by recordRunEnd in roguelite.js — we
      // only render the user-facing toast here.
    });

    events.on("matchEnded", ({ mode, winner, score }) => {
      this._awardXp(PARTICIPATION_XP, /*silent*/ true);
      const won = winner === "blue";
      if (won) {
        this._awardXp(WIN_XP);
        saveStore.update((data) => { data.softCurrency += WIN_CREDITS; });
        this._toast(`Victory  +${WIN_XP} XP  +${WIN_CREDITS} credits`, "win");
        this._maybeFirstWinOfDay();
        if (mode === "daily") {
          saveStore.update((data) => { data.hardCurrency += DAILY_MODE_CLEAR_APHELIUM; });
          this._toast(`Daily cleared  +${DAILY_MODE_CLEAR_APHELIUM} Aphelium`, "premium");
        }
      } else {
        this._toast(`Defeat  +${PARTICIPATION_XP} XP`, "xp");
      }
      // Score-derived bonus tail: 1 credit per 50 score.
      const bonusCredits = Math.floor(score / 50);
      if (bonusCredits > 0) {
        saveStore.update((data) => { data.softCurrency += bonusCredits; });
        this._toast(`Score bonus  +${bonusCredits} credits`, "credits");
      }
      saveStore.flush();
    });
  }

  // ---------------------------------------------------------------------
  // Internal economy mutators.
  // ---------------------------------------------------------------------

  _awardXp(amount, silent = false) {
    let leveledTo = null;
    saveStore.update((data) => {
      data.xp += amount;
      // Level-up while remaining XP exceeds next-level threshold.
      while (data.xp >= sumXpThroughLevel(data.level)) {
        data.level += 1;
        data.softCurrency += LEVEL_UP_CREDITS;
        if (data.level % 5 === 0) {
          data.hardCurrency += LEVEL_MILESTONE_APHELIUM;
        }
        leveledTo = data.level;
      }
    });
    if (!silent && amount > 0) {
      this._toast(`+${amount} XP`, "xp");
    }
    if (leveledTo != null) {
      this._toast(`LEVEL UP  →  ${leveledTo}   +${LEVEL_UP_CREDITS} credits`, "levelup");
      if (leveledTo % 5 === 0) {
        this._toast(`Milestone  +${LEVEL_MILESTONE_APHELIUM} Aphelium`, "premium");
      }
      events.emit("xpAwarded", { amount, source: "levelup" });
    }
  }

  _maybeFirstWinOfDay() {
    const today = todaySeed();
    const data = saveStore.get();
    if (data.daily.firstWinSeed === today) return;
    saveStore.update((d) => {
      d.daily.firstWinSeed = today;
      d.xp += FIRST_WIN_OF_DAY_XP;
      d.softCurrency += FIRST_WIN_OF_DAY_CREDITS;
    });
    this._toast(
      `First win today  +${FIRST_WIN_OF_DAY_XP} XP  +${FIRST_WIN_OF_DAY_CREDITS} credits`,
      "win",
    );
  }

  _processDailyLogin() {
    // No auto-award on construct — the player must visit the menu and
    // tap the claim chip. This keeps the toast feedback synchronous
    // with the user gesture rather than firing during startup.
  }

  _toast(text, kind = "xp") {
    this.recentRewards.push({ text, kind, t: Date.now() });
    if (this.recentRewards.length > RECENT_REWARDS_CAP) {
      this.recentRewards.splice(0, this.recentRewards.length - RECENT_REWARDS_CAP);
    }
  }
}

// ---------------------------------------------------------------------
// Date helpers.
// ---------------------------------------------------------------------

function sameUtcDay(aMs, bMs) {
  if (aMs == null || bMs == null) return false;
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getUTCFullYear() === b.getUTCFullYear()
      && a.getUTCMonth() === b.getUTCMonth()
      && a.getUTCDate() === b.getUTCDate();
}

function isConsecutiveUtcDay(prevMs, nowMs) {
  if (prevMs == null) return false;
  const prev = new Date(prevMs);
  const yesterday = new Date(nowMs);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return prev.getUTCFullYear() === yesterday.getUTCFullYear()
      && prev.getUTCMonth() === yesterday.getUTCMonth()
      && prev.getUTCDate() === yesterday.getUTCDate();
}

export const progression = new Progression();

if (typeof window !== "undefined") {
  window.progression = progression;
}
