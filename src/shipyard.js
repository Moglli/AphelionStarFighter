/**
 * @file shipyard.js — meta-progression currency math.
 *
 * The Shipyard credit pile in save.shipyardCredits grows from completed
 * Frontier runs. Each run accumulates a kill tally + node-clear count;
 * at run-end (win OR loss) the totals are converted to credits via the
 * formula below and banked.
 *
 * No XP curve, no per-day caps — players pay the loss penalty (losing
 * the in-run rank + capitals + callsign) but keep every credit they
 * earned. Roguelites win by always moving forward.
 */

import { saveStore } from "./save.js";
import { HULLS, COMPONENTS, effectiveOwnedComponents, effectiveOwnedHulls, playerTierFromHull } from "./components.js";

// Per-kill payout by ship class. Tuned so a typical Act-1 death
// (~10 fighters, 2 bombers, 1 frigate, 1 node) banks ~50 credits.
// A full Act-5 win banks ~12,000+ credits, comfortably affording a
// hull tier upgrade per win.
export const KILL_VALUES = {
  fighter: 1,
  bomber: 3,
  frigate: 12,
  cruiser: 30,
  battleship: 60,
  carrier: 80,
  station: 40,
};

// Per-act survival bonus payout. Awarded at run-end based on the
// final act reached. Quadratic so deeper-act runs pay disproportionately
// more — incentivises pushing through rather than farming Act 1.
export const ACT_BONUSES = [0, 0, 100, 400, 900, 1600];

// Per-boss kill bonus. Awarded when a boss node is completed; rolled
// into the per-run payout. Heavy back-weighting so the war-winner
// payout dwarfs casual play.
export const BOSS_BONUSES = [0, 200, 400, 800, 1600, 3200];

// Per-node-cleared bonus. Includes resupply + event nodes so even
// non-combat clears pay something.
export const NODE_CLEAR_VALUE = 25;

// Full Frontier war won bonus. Stacks on top of all per-act and
// per-boss bonuses.
export const WAR_WON_BONUS = 5000;

// ---- TIER-AWARE ENEMY SCALING --------------------------------------
//
// A player in a Fighter faces baseline enemy rosters. As they upgrade
// hull tiers (bomber → frigate → cruiser → battleship → carrier), enemy
// forces scale up two ways:
//
//   (1) Quantity: light-craft (fighter/bomber/frigate) counts multiply.
//   (2) Class: capital ships get *added* — at higher tiers, even Act 1
//       trash will include a cruiser, then a battleship, then a carrier.
//
// Bosses get the class additions in full but only ~60% of the quantity
// bump (otherwise the boss fight runs too long against a stronger player
// fleet that already includes the player's own capital ship).
export const TIER_SCALING = {
  0: { qtyMul: 1.00, ensure: {} },                                              // Fighter
  1: { qtyMul: 1.10, ensure: {} },                                              // Bomber
  2: { qtyMul: 1.20, ensure: { frigate: 1 } },                                  // Frigate
  3: { qtyMul: 1.35, ensure: { frigate: 1, cruiser: 1 } },                      // Cruiser
  4: { qtyMul: 1.55, ensure: { cruiser: 1, battleship: 1 } },                   // Battleship
  5: { qtyMul: 1.75, ensure: { cruiser: 1, battleship: 1, carrier: 1 } },       // Carrier
};

// Boss quantity multiplier is dampened — a battleship player vs. boss +
// 75% more escorts becomes a long slog. The class ensure list applies
// in full though, so the boss still scales meaningfully.
const BOSS_QTY_DAMP = 0.6;

/**
 * Return the scaling spec for a given player tier. Defensive against
 * tiers past the table (carrier+ would map to the carrier entry).
 */
export function tierScalingFor(tier) {
  const t = Math.max(0, Math.min(tier, 5));
  return TIER_SCALING[t] || TIER_SCALING[0];
}

/**
 * Apply the tier-aware scaling on top of a roster. `roster` is the
 * post-act-scaled counts (already multiplied by diffFor); this layers
 * the player-tier modifier on top.
 *
 * @param {Object} roster — { fighter, bomber, frigate, cruiser, battleship, carrier }
 * @param {number} tier — player tier 0-5
 * @param {boolean} isBoss — bosses get dampened qty bump
 */
export function applyTierScalingToRoster(roster, tier, isBoss = false) {
  if (!roster) return roster;
  const { qtyMul, ensure } = tierScalingFor(tier);
  // Dampen qty for boss rosters so the fight stays meaningful.
  // (qtyMul - 1) * damp + 1 keeps the formula correct at qtyMul=1 → 1.
  const effectiveMul = isBoss ? 1 + (qtyMul - 1) * BOSS_QTY_DAMP : qtyMul;

  const out = {};
  for (const k of Object.keys(roster)) {
    if (roster[k] <= 0) continue;
    out[k] = Math.max(1, Math.round(roster[k] * effectiveMul));
  }
  // Class ensure: if the roster doesn't already have N of a capital
  // class, ADD enough to hit the floor. Additive so a roster with 1
  // cruiser at tier 4 (ensure cruiser:1) stays at 1, not 2.
  for (const k of Object.keys(ensure)) {
    const cur = out[k] || 0;
    if (cur < ensure[k]) out[k] = ensure[k];
  }
  return out;
}

/**
 * Read the player's current tier from the persisted ship design.
 * Falls back to 0 (Fighter) if there's no save yet.
 */
export function getPlayerTier() {
  const data = saveStore.get();
  const hull = data.playerShip ? data.playerShip.hull : "fighter";
  return playerTierFromHull(hull);
}

/**
 * Compute the credit payout for a finished run. Pure function — no
 * side effects. Returns `{ total, breakdown }` so the run-end panel
 * can show players where their credits came from.
 */
export function computeRunPayout(run, won) {
  const tally = (run && run.killTally) || {};
  const breakdown = { kills: {}, total: 0 };
  let total = 0;

  for (const klass of Object.keys(KILL_VALUES)) {
    const count = tally[klass] || 0;
    if (count <= 0) continue;
    const sub = count * KILL_VALUES[klass];
    breakdown.kills[klass] = { count, credits: sub };
    total += sub;
  }

  const actBonus = ACT_BONUSES[Math.min(run.act || 1, ACT_BONUSES.length - 1)] || 0;
  if (actBonus > 0) {
    breakdown.actBonus = actBonus;
    total += actBonus;
  }

  const bossesDefeated = run.bossesDefeated || 0;
  let bossBonusTotal = 0;
  for (let i = 1; i <= bossesDefeated; i++) {
    bossBonusTotal += BOSS_BONUSES[i] || 0;
  }
  if (bossBonusTotal > 0) {
    breakdown.bossBonus = bossBonusTotal;
    total += bossBonusTotal;
  }

  const nodesCleared = run.nodesCleared || 0;
  if (nodesCleared > 0) {
    breakdown.nodesCleared = { count: nodesCleared, credits: nodesCleared * NODE_CLEAR_VALUE };
    total += nodesCleared * NODE_CLEAR_VALUE;
  }

  if (won) {
    breakdown.warWonBonus = WAR_WON_BONUS;
    total += WAR_WON_BONUS;
  }

  breakdown.total = total;
  return { total, breakdown };
}

/**
 * Apply a payout to the save store. Returns the new credit total so
 * callers can show before/after deltas in the run-end summary.
 */
export function bankRunPayout(payout) {
  if (!payout || payout.total <= 0) return saveStore.get().shipyardCredits || 0;
  let after = 0;
  saveStore.update((d) => {
    d.shipyardCredits = (d.shipyardCredits || 0) + payout.total;
    after = d.shipyardCredits;
  });
  return after;
}

/**
 * Initialise the tally fields on a fresh run. Called from roguelite.js
 * #startNewRun. Idempotent — safe to call on an in-progress run if
 * fields go missing.
 */
export function initRunTally(run) {
  if (!run.killTally) {
    run.killTally = { fighter: 0, bomber: 0, frigate: 0, cruiser: 0, battleship: 0, carrier: 0, station: 0 };
  }
  if (typeof run.bossesDefeated !== "number") run.bossesDefeated = 0;
  if (typeof run.nodesCleared !== "number") run.nodesCleared = 0;
}

/**
 * Increment a kill on the run tally. Called from main.js's shipDestroyed
 * subscriber whenever an enemy ship (side === "red", not the player)
 * dies during a Frontier match.
 */
export function recordKill(run, klass) {
  if (!run) return;
  initRunTally(run);
  if (!(klass in run.killTally)) run.killTally[klass] = 0;
  run.killTally[klass] += 1;
}

// --- HULL + COMPONENT PURCHASE LOGIC --------------------------------

/**
 * Can the player afford this hull right now? Returns { canBuy, owned, cost, balance }.
 */
export function canBuyHull(hullId) {
  const hull = HULLS[hullId];
  const data = saveStore.get();
  const owned = effectiveOwnedHulls(data.ownedHulls).has(hullId);
  return {
    canBuy: !!hull && !owned && (data.shipyardCredits || 0) >= hull.cost,
    owned,
    cost: hull ? hull.cost : 0,
    balance: data.shipyardCredits || 0,
  };
}

/**
 * Buy a hull. Idempotent on already-owned hulls (returns {ok: true, alreadyOwned: true}).
 * Returns { ok, reason?, balance } so the UI can show error states.
 */
export function buyHull(hullId) {
  const hull = HULLS[hullId];
  if (!hull) return { ok: false, reason: "unknown-hull" };
  const data = saveStore.get();
  const owned = effectiveOwnedHulls(data.ownedHulls).has(hullId);
  if (owned) return { ok: true, alreadyOwned: true, balance: data.shipyardCredits };
  if ((data.shipyardCredits || 0) < hull.cost) {
    return { ok: false, reason: "insufficient-credits", balance: data.shipyardCredits };
  }
  let newBalance = 0;
  saveStore.update((d) => {
    d.shipyardCredits = (d.shipyardCredits || 0) - hull.cost;
    if (!Array.isArray(d.ownedHulls)) d.ownedHulls = [];
    if (!d.ownedHulls.includes(hullId)) d.ownedHulls.push(hullId);
    newBalance = d.shipyardCredits;
  });
  return { ok: true, balance: newBalance };
}

/**
 * Buy a component. Same shape as buyHull.
 */
export function buyComponent(componentId) {
  const comp = COMPONENTS[componentId];
  if (!comp) return { ok: false, reason: "unknown-component" };
  const data = saveStore.get();
  const owned = effectiveOwnedComponents(data.ownedComponents).has(componentId);
  if (owned) return { ok: true, alreadyOwned: true, balance: data.shipyardCredits };
  if ((data.shipyardCredits || 0) < comp.cost) {
    return { ok: false, reason: "insufficient-credits", balance: data.shipyardCredits };
  }
  let newBalance = 0;
  saveStore.update((d) => {
    d.shipyardCredits = (d.shipyardCredits || 0) - comp.cost;
    if (!Array.isArray(d.ownedComponents)) d.ownedComponents = [];
    if (!d.ownedComponents.includes(componentId)) d.ownedComponents.push(componentId);
    newBalance = d.shipyardCredits;
  });
  return { ok: true, balance: newBalance };
}

/**
 * Equip a component into a slot on the player ship design. Snaps to a
 * compatible slot only — won't put a heavy laser in a fighter weapon
 * slot.
 */
export function equipComponent(slotId, componentId) {
  const comp = COMPONENTS[componentId];
  if (!comp) return { ok: false, reason: "unknown-component" };
  if (!comp.slots.includes(slotId)) return { ok: false, reason: "slot-mismatch" };
  saveStore.update((d) => {
    if (!d.playerShip.modules) d.playerShip.modules = {};
    d.playerShip.modules[slotId] = componentId;
  });
  return { ok: true };
}

/**
 * Switch the player ship to a different hull. Resets the modules map
 * to defaults for the new hull so a stale module assignment (from the
 * old hull) doesn't leak into the new one.
 */
export function setHull(hullId) {
  const hull = HULLS[hullId];
  if (!hull) return { ok: false, reason: "unknown-hull" };
  const data = saveStore.get();
  const owned = effectiveOwnedHulls(data.ownedHulls).has(hullId);
  if (!owned) return { ok: false, reason: "not-owned" };
  saveStore.update((d) => {
    d.playerShip.hull = hullId;
    // Re-fit modules: keep any existing module that fits the new hull's
    // slot set; default the rest.
    const oldModules = d.playerShip.modules || {};
    const newModules = {};
    const ownedComps = effectiveOwnedComponents(d.ownedComponents);
    for (const slot of hull.slots) {
      // Try to preserve the old slot if compatible
      let id = oldModules[slot];
      if (id && COMPONENTS[id] && COMPONENTS[id].slots.includes(slot) && ownedComps.has(id)) {
        newModules[slot] = id;
        continue;
      }
      // Otherwise default to the slot's default component
      for (const candId of Object.keys(COMPONENTS)) {
        const c = COMPONENTS[candId];
        if (c.default && c.slots.includes(slot) && ownedComps.has(candId)) {
          newModules[slot] = candId;
          break;
        }
      }
    }
    d.playerShip.modules = newModules;
  });
  return { ok: true };
}

/**
 * Rename the player ship. Trims + caps length.
 */
export function renameShip(name) {
  const clean = (name || "").trim().slice(0, 40);
  if (!clean) return { ok: false, reason: "empty-name" };
  saveStore.update((d) => { d.playerShip.name = clean; });
  return { ok: true };
}

/**
 * Set the player ship's cosmetic paint. Either field can be null to
 * clear that layer (falls back to the team-side primary). Validates
 * hex format; rejects non-hex strings to avoid stamping garbage that
 * would break drawShip's ctx.fillStyle assignment.
 */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
export function setPaint(primary, trim) {
  saveStore.update((d) => {
    if (!d.playerShip) return;
    d.playerShip.paintPrimary = (typeof primary === "string" && HEX_COLOR_RE.test(primary)) ? primary : null;
    d.playerShip.paintTrim    = (typeof trim    === "string" && HEX_COLOR_RE.test(trim))    ? trim    : null;
  });
  return { ok: true };
}
