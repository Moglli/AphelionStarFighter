/**
 * @file Dev Mode — cached on/off flag + small dev API for Playwright probes.
 *
 * Why cached: `isDev()` is called from per-frame draw paths (balance HUD,
 * future dev overlay). Reading SaveStore each call would add a JSON parse
 * to every frame. Boot reads once into `_devCached`; the Settings overlay
 * pokes it via `setDev(on)` whenever the toggle changes.
 *
 * Dev Mode is off by default and gated behind a Settings toggle (visible
 * to all players). When on, it unlocks playtest + balance tooling — for
 * now: a balance HUD reading `game.battleStats`. Later phases add sim
 * controls (pause/step/heal/kill/spawn) and the designer overlays.
 */

let _devCached = false;

/** Read-only check. Cheap — does NOT touch the SaveStore. */
export function isDev() {
  return _devCached;
}

/**
 * Set the cached flag. Call from main.js once on boot (from saveStore)
 * and again whenever the Settings toggle fires. Persistence is the
 * caller's job (saveStore.update lives in main.js next to the music/sfx
 * apply functions).
 */
export function setDev(on) {
  _devCached = !!on;
}

// Tiny window probe so Playwright + console smoke-tests can flip dev
// without rebuilding. Mirrors the existing window.game / window.input /
// window.saveStore / window.audio hooks (CLAUDE.md "test hooks").
if (typeof window !== "undefined") {
  window.dev = {
    isOn: () => _devCached,
    set: (on) => setDev(on),
  };
}
