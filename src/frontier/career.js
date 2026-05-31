/**
 * @file Frontier career-tier track (new War-based Frontier — FRONTIER_FUTURE.md §3.2/§3.6).
 *
 * A SINGLE career-XP track unlocks, at each tier, both the player's
 * command scope AND the ship classes they may personally pilot. The
 * piloting unlock lags command scope by roughly one tier — "you can
 * pilot what you've earned the right to lead."
 *
 * This module is pure data + pure functions. It owns NO state — the
 * live career XP lives in the save (`frontier.careerXp`); callers
 * derive tier/unlocks from it via the helpers here. That keeps tier a
 * computed property of XP (single source of truth) rather than a stored
 * field that can drift out of sync with the XP it's supposed to track.
 *
 * XP thresholds are PLACEHOLDERS, tuned toward the doc's ~50–80h
 * rookie→admiral target (§6 decision log). Revisit once mission XP
 * rewards are authored.
 */

/**
 * @typedef {Object} CareerTier
 * @property {number} tier          0..6
 * @property {string} name          Display rank
 * @property {string} commandScope  Human-readable battlefield authority
 * @property {string[]} pilotable   Ship classes pilotable AT this tier (cumulative)
 * @property {number} xpRequired    Cumulative career XP to REACH this tier
 */

/** @type {CareerTier[]} */
export const CAREER_TIERS = [
  {
    tier: 0,
    name: "Rookie",
    commandScope: "none",
    pilotable: ["fighter"],
    xpRequired: 0,
  },
  {
    tier: 1,
    name: "Wing Lead",
    commandScope: "Own fighter wing",
    pilotable: ["fighter"],
    xpRequired: 500,
  },
  {
    tier: 2,
    name: "Strike Lead",
    commandScope: "All friendly fighters",
    pilotable: ["fighter", "bomber"],
    xpRequired: 1500,
  },
  {
    tier: 3,
    name: "Strike Group Lead",
    commandScope: "All strike craft (fighters + bombers)",
    pilotable: ["fighter", "bomber", "frigate"],
    xpRequired: 3500,
  },
  {
    tier: 4,
    name: "Tactical Officer",
    commandScope: "Strike craft + frigates",
    pilotable: ["fighter", "bomber", "frigate", "cruiser"],
    xpRequired: 7000,
  },
  {
    tier: 5,
    name: "Captain",
    commandScope: "+ cruisers, capitals",
    pilotable: ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier"],
    xpRequired: 13000,
  },
  {
    tier: 6,
    name: "Commodore",
    commandScope: "Full fleet",
    pilotable: ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier", "station"],
    xpRequired: 24000,
  },
];

export const MAX_TIER = CAREER_TIERS[CAREER_TIERS.length - 1].tier;

/**
 * Resolve the tier object for a given career XP total. Walks from the
 * top tier down so the highest threshold met wins.
 * @param {number} xp
 * @returns {CareerTier}
 */
export function tierForXp(xp) {
  const x = Number.isFinite(xp) ? xp : 0;
  for (let i = CAREER_TIERS.length - 1; i >= 0; i--) {
    if (x >= CAREER_TIERS[i].xpRequired) return CAREER_TIERS[i];
  }
  return CAREER_TIERS[0];
}

/** Tier index (0..6) for an XP total. */
export function tierIndexForXp(xp) {
  return tierForXp(xp).tier;
}

/**
 * Ship classes the player may pilot at the current XP total.
 * @param {number} xp
 * @returns {string[]} copy (callers may not mutate the table)
 */
export function pilotableClasses(xp) {
  return tierForXp(xp).pilotable.slice();
}

/** Command-scope label for the current XP total. */
export function commandScope(xp) {
  return tierForXp(xp).commandScope;
}

/**
 * Progress toward the next tier.
 * @param {number} xp
 * @returns {{current: CareerTier, next: CareerTier|null, xpIntoTier: number,
 *   xpForNext: number, fraction: number}}
 *   `next` is null at MAX_TIER (fraction reports 1).
 */
export function tierProgress(xp) {
  const x = Number.isFinite(xp) ? xp : 0;
  const current = tierForXp(x);
  const next = CAREER_TIERS.find((t) => t.tier === current.tier + 1) || null;
  if (!next) {
    return { current, next: null, xpIntoTier: 0, xpForNext: 0, fraction: 1 };
  }
  const span = next.xpRequired - current.xpRequired;
  const into = x - current.xpRequired;
  return {
    current,
    next,
    xpIntoTier: into,
    xpForNext: span,
    fraction: span > 0 ? Math.max(0, Math.min(1, into / span)) : 1,
  };
}

/** True if a class is pilotable at the given XP. */
export function canPilot(klass, xp) {
  return tierForXp(xp).pilotable.includes(klass);
}

/**
 * Minimum tier to step back and take FLEET COMMAND (admiral mode) instead
 * of piloting. Tier 3 = Strike Group Lead — the first rank whose command
 * scope spans the whole strike wing, so it's the natural point the player
 * can hand their ship to the AI and direct the battle. (The engine's
 * admiral mode is all-or-nothing; the finer per-tier command scope in the
 * §3.2 table is flavor for now.)
 */
export const COMMAND_MIN_TIER = 3;

/** True if the player may take fleet command at the given XP. */
export function canCommand(xp) {
  return tierForXp(xp).tier >= COMMAND_MIN_TIER;
}
