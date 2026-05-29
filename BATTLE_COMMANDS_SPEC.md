# Battle Plan — Command Spec

> **Status (2026-05-29): SHIPPED** — behavior layer (`ai.js#applyShipOrders`),
> data model (`admiral.js`/`fleetcommand.js`), the generic **Fleet Plan**
> overlay (all non-Frontier modes), and the live **admiral panel** (5 stances +
> FOCUS, all modes) are built + verified. The Frontier **Battle Plan** overlay
> still shows the legacy chip vocabulary (free/hold/press/defend/target), which
> is mapped forward to the new stances under the hood — its 3-axis UI upgrade is
> the remaining follow-up.


Tighter, precise definitions for what each Battle Plan / Fleet Plan command
does. Decisions locked 2026-05-29: 5 stances; HOLD POSITION defends itself;
soft hunt-class; capitals get the full command set.

A ship's orders are **three independent axes**. The AI resolves a TARGET (axis
B), an ANCHOR + leash (axis C), then a MOVEMENT/FIRE behavior around them
(axis A).

---

## Axis A — STANCE (how to fight)

One per class/wing. Modifies the per-class AI's movement + fire output.

| Stance | Movement | Fire | Notes |
|---|---|---|---|
| **ENGAGE** | Class AI unchanged — fight at the class's natural range (fighters strafe, cruisers stand off, bombers run in). | Normal. | The smart default (today's FREE). |
| **CHARGE** | Full thrust straight at the target (lead-aimed); if no target, at the enemy centroid. Overrides class standoff range; ignores any flee-when-damaged. | Fire whenever in arc/range. | Max aggression — closes to point-blank (today's PRESS, but it now actually closes on the target, not just the centroid). |
| **STAND OFF** | Kite at max weapon range `R`. `d` = dist to threat: `d<0.85R` → thrust *away* (back-pedal); `d>R` → close in; else hold + strafe perpendicular. | Fire while in range. | New. Artillery cruisers / skittish fighters keep their distance instead of piling in. |
| **HOLD POSITION** | Anchor `A` (see axis C; default = position when the order took effect). If `dist(ship,A) > HOLD_RADIUS` (≈600u) → return to `A` (no fire while returning). Else station-keep; **do NOT pursue** targets past `A`'s leash. | Fire at anything in weapon range. | New. Holds ground and defends itself — never advances. |
| **FALL BACK** | Thrust to the fleet rear = allied centroid pushed ~1000u away from the enemy centroid (a real retreat, not into the blob). | **Cease fire** (guns + missiles off). | Full disengage / stand-down (today's HOLD, renamed + clarified). |

`R` = the ship's longest effective offensive range (primary weapon / main
cannon / laser, resolved per class).

---

## Axis B — TARGET PRIORITY (what to shoot first)

Optional overlay; default if unset.

| Priority | Behavior |
|---|---|
| **DEFAULT** | The class AI's natural target pick. |
| **HUNT ‹class›** | *Soft* preference: pick the nearest enemy of the chosen class; if none alive, fall back to default targeting. (Unchanged from today's target-class.) |
| **FOCUS** | Attack the admiral's live focus target (`game.focusTargetId`, set by tapping an enemy in admiral view) if set + alive, else default. Standing focus-fire: FOCUS-tagged ships pile onto whatever the admiral taps. |

Surrendered/dead enemies are always skipped (existing invariant).

---

## Axis C — ASSIGNMENT (where to operate)

Optional overlay; sets the ANCHOR and leash radius that axis A reads.

| Assignment | Anchor | Behavior |
|---|---|---|
| **FREE ROAM** | none | No positional constraint (default). |
| **ESCORT ‹capital›** | the capital's live position (moves with it) | Engage threats within `ESCORT_ENGAGE_RANGE` (3500u) of the capital; don't pursue past it. **Now valid for any class** — a frigate can screen a battleship. |
| **GUARD POINT ‹rally›** | a fixed map point | _(Deferred — needs minimap point-pick UI. Not in the first pass.)_ |

---

## How the axes compose

- **Assignment** picks the anchor + leash. **Stance** is the behavior at/around
  that anchor and the target. **Priority** picks the target.
- Examples:
  - `ESCORT BB + ENGAGE` → patrol the battleship, fight at natural range near it.
  - `ESCORT BB + STAND OFF` → screen the BB at weapon range.
  - `GUARD POINT + HOLD POSITION` → sit on the point and defend it.
  - `CHARGE + HUNT carrier` → beeline the nearest enemy carrier.
  - `FREE ROAM + FALL BACK` → retreat to the fleet rear, cease fire.
- **FALL BACK overrides the anchor** — a retreating ship abandons its escort/
  guard and runs for the rear.
- **HOLD POSITION vs GUARD POINT are not redundant**: GUARD POINT is the
  *assignment* that supplies an explicit anchor; HOLD POSITION is the *stance*
  that says "stay at the anchor and defend." HOLD POSITION with no guard point
  anchors to the ship's current location.

## Missiles toggle (unchanged, orthogonal)

Per-class **MISSILES FREE / HOLD** stays as its own switch (conserve pods even
while ENGAGE/CHARGE). FALL BACK forces missiles off regardless.

## Defaults

Every class/wing starts **ENGAGE · DEFAULT · FREE ROAM · MISSILES FREE** — a
no-op plan plays exactly like an un-commanded battle.
