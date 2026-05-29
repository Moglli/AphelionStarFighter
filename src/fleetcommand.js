/**
 * Fleet command — the run-free fleet-direction layer shared by ALL game
 * modes (arena / waves / daily / custom / open / defend). It is the lean
 * sibling of roguelite's run-coupled wing system (see
 * roguelite.js#assignWingsToSpawned): same in-battle behaviour, but driven
 * by a transient `fleetPlan` instead of persistent run state, with no named
 * commanders / traits / perks / captured-craft bookkeeping.
 *
 * The behaviour layer is already mode-agnostic — ai.js#applyAdmiralPosture,
 * the ship.js missile-hold gate, the `target-class` aim pref, and the
 * `escortOf` escort leash all honour any blue ship's `wingCommand` /
 * `escortOf` plus the per-class `game.directives`. This module just builds
 * a default plan and stamps a chosen plan onto the spawned blue fleet.
 *
 * fleetPlan shape (transient; rides on game.modeConfig.fleetPlan):
 *   {
 *     classDirectives: { <klass>: { posture, missiles }, ... },  // merged over defaults
 *     wings: {
 *       fighter: [ { id, name, weight, command: { kind, target? } }, ... ],
 *       bomber:  [ ... ],
 *     },
 *   }
 *   command.kind ∈ "free" | "hold" | "press" | "defend-capital" | "target-class"
 *   defend-capital target = capital KLASS string (e.g. "battleship")
 *   target-class   target = enemy KLASS string
 */

import { ADMIRAL_CLASSES, defaultDirectives } from "./modes/admiral.js";

// Only fighters/bombers are split into ad-hoc wings; capitals take their
// orders from the per-class directives (one posture per class is plenty for
// the handful of capitals a fleet fields).
export const WING_CRAFT = ["fighter", "bomber"];

export const WING_NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];

// Wing-count bounds for the pre-battle UI — mirrors Frontier's 2–5 wing
// spread so a craft pool is never split into unmanageable slivers.
export const MIN_WINGS = 1;
export const MAX_WINGS = 5;

// A fresh, do-nothing plan: every class on free/on, one wing per craft that
// owns all of that craft. Seeds the pre-battle Fleet Plan overlay.
export function makeDefaultFleetPlan() {
  const wings = {};
  for (const craft of WING_CRAFT) {
    wings[craft] = [{
      id: `${craft}-0`, name: WING_NAMES[0], weight: 1,
      command: { stance: "engage", priority: "default", priorityClass: null, assignment: "free", escortKlass: null },
    }];
  }
  return { classDirectives: defaultDirectives(), wings };
}

// Split a pool of `poolLen` ships across `wings` proportionally to each
// wing's weight. Returns an array of integer counts aligned to `wings`.
// Guards a zero/blank total by falling back to an even round-robin split so
// no wing is silently starved. The leftover from flooring is handed out one
// at a time to the highest-weight wings first (stable by index on ties).
export function distributeByWeight(poolLen, wings) {
  const n = wings.length;
  if (n === 0 || poolLen <= 0) return new Array(n).fill(0);
  if (n === 1) return [poolLen];

  const weights = wings.map((w) => (w && w.weight > 0 ? w.weight : 0));
  let total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    // No usable weights → even round-robin.
    const counts = new Array(n).fill(0);
    for (let i = 0; i < poolLen; i++) counts[i % n]++;
    return counts;
  }

  const counts = weights.map((w) => Math.floor((poolLen * w) / total));
  let assigned = counts.reduce((a, b) => a + b, 0);
  let leftover = poolLen - assigned;
  // Hand out the remainder to the heaviest wings first.
  const order = wings.map((_, i) => i).sort((a, b) => weights[b] - weights[a]);
  let oi = 0;
  while (leftover > 0) {
    counts[order[oi % n]]++;
    oi++;
    leftover--;
  }
  return counts;
}

// Nearest live blue capital of a given class to `from` (a ship). Used to
// resolve a defend-capital wing whose target is a capital KLASS rather than
// a persistent instance id (which transient modes don't have).
function nearestBlueCapitalOfKlass(game, klass, from) {
  let best = null, bestD = Infinity;
  for (const s of game.ships) {
    if (s.dead || s.side !== "blue" || s.klass !== klass) continue;
    const dx = s.pos.x - from.pos.x, dy = s.pos.y - from.pos.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

// Apply a transient fleetPlan to the freshly-spawned blue fleet. Call AFTER
// spawnRoster + promotePlayer. No-ops cleanly on an absent plan or empty
// pools (e.g. a blue-only-player skirmish). Never touches the player's own
// hull (it flies on direct input, not a wing order).
export function applyFleetPlan(game, plan) {
  if (!plan || !game) return;

  // 1. Per-class directives merged over the running defaults. Capitals are
  //    commanded entirely through this (no wings for capitals).
  if (plan.classDirectives) {
    if (!game.directives) game.directives = defaultDirectives();
    for (const klass of ADMIRAL_CLASSES) {
      const d = plan.classDirectives[klass];
      if (d) game.directives[klass] = { ...game.directives[klass], ...d };
    }
    // 1b. Per-class ESCORT assignment — leash every blue ship of a class to
    //     the nearest capital of its escortKlass. Now valid for ANY class
    //     (e.g. "frigates screen the battleship"). Fighters/bombers are
    //     re-stamped per-wing below, which overrides this.
    for (const klass of ADMIRAL_CLASSES) {
      const d = plan.classDirectives[klass];
      if (!d || d.assignment !== "escort" || !d.escortKlass) continue;
      for (const s of game.ships) {
        if (s.dead || s.side !== "blue" || s.klass !== klass || s.isPlayer) continue;
        const cap = nearestBlueCapitalOfKlass(game, d.escortKlass, s);
        if (cap && cap.id !== s.id) s.escortOf = cap.id;
      }
    }
  }

  // 2. Ad-hoc wings for fighters/bombers.
  const wingsByCraft = plan.wings || {};
  for (const craft of WING_CRAFT) {
    const wings = wingsByCraft[craft];
    if (!wings || wings.length === 0) continue;
    // Blue, this class, excluding the player's own ship. NOT race-filtered
    // (unlike roguelite, which excludes captured foreign-race craft) — in
    // generic modes every blue craft the player fielded is theirs to command.
    const pool = game.ships.filter(
      (s) => s.side === "blue" && s.klass === craft && !s.isPlayer,
    );
    if (pool.length === 0) continue;

    const counts = distributeByWeight(pool.length, wings);
    let cursor = 0;
    for (let w = 0; w < wings.length; w++) {
      const wing = wings[w];
      const take = Math.min(counts[w], pool.length - cursor);
      for (let i = 0; i < take; i++) {
        const ship = pool[cursor++];
        ship.wingCommand = { ...wing.command };
        ship.wingId = wing.id;
        ship.wingName = wing.name;
        // ESCORT assignment (new `assignment:"escort"+escortKlass`, or the
        // legacy `kind:"defend-capital"+target` the Frontier UI still emits)
        // leashes the wing to the nearest capital of that KLASS. FREE ROAM
        // leaves escortOf as assignEscortPacks set it — "free roam" preserves
        // the auto-escort so a do-nothing default plan plays like vanilla; the
        // STANCE axis (charge/standoff/hold) governs movement regardless of
        // the leash, so there's no need to force-clear it.
        const cmd = wing.command;
        const escortKlass = cmd.escortKlass
          || (cmd.kind === "defend-capital" ? cmd.target : null);
        if ((cmd.assignment === "escort" || cmd.kind === "defend-capital") && escortKlass) {
          const cap = nearestBlueCapitalOfKlass(game, escortKlass, ship);
          if (cap) ship.escortOf = cap.id;
        }
      }
    }
  }
}
