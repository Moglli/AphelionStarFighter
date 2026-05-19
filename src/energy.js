// Energy / stamina gating. Each match costs `COST_PER_GAME` energy;
// energy regenerates passively in real time (calendar time, not play
// time — closing the tab still ticks regen via Date.now diffs at load).
//
// Designed as a free-to-play funnel: when energy runs out the player
// either waits, or "purchases" more via PACKAGES. The purchase()
// function is the integration point for a real payment provider —
// today it simulates an instant grant so the UI is fully usable in
// dev. Replace its body with an IAP receipt-verification flow when
// wiring a backend.
//
// State is persisted to localStorage under "aphelion.energy.v1". A
// missing / corrupt blob falls back to a fresh full tank.

const STORAGE_KEY = "aphelion.energy.v1";

// Tunables — adjust to taste / monetisation strategy.
export const MAX_ENERGY = 5;                 // tank size
export const COST_PER_GAME = 1;              // per-match cost
export const REGEN_MS = 30 * 60 * 1000;      // 30 min per +1 energy

// "Purchase" packages. The price strings are display-only; nothing
// is actually charged. Hook a real billing SDK into purchase() below.
export const PACKAGES = [
  { id: "tank-small",  energy: 5,   label: "Refill",       price: "$0.99" },
  { id: "tank-medium", energy: 20,  label: "Pilot Pack",   price: "$3.99" },
  { id: "tank-large",  energy: 100, label: "Squadron Pack", price: "$9.99" },
];

export function defaultEnergy() {
  return {
    current: MAX_ENERGY,
    lastUpdate: Date.now(),
    totalSpent: 0,
    totalPurchased: 0,
  };
}

export function loadEnergy() {
  try {
    if (typeof localStorage === "undefined") return defaultEnergy();
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultEnergy();
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.current !== "number" || typeof obj.lastUpdate !== "number") {
      return defaultEnergy();
    }
    const out = { ...defaultEnergy(), ...obj };
    // Clamp in case storage was tampered with.
    out.current = Math.max(0, Math.min(MAX_ENERGY * 100, out.current));
    return out;
  } catch {
    return defaultEnergy();
  }
}

export function saveEnergy(state) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* full / disabled storage: silent */ }
}

// Apply any earned regen to `state` and advance lastUpdate by the
// amount actually consumed. Idempotent — call freely from the render
// loop. Returns true if the energy total changed.
export function regenTick(state, now = Date.now()) {
  if (state.current >= MAX_ENERGY) {
    // Keep lastUpdate fresh so we don't dump a huge batch the moment
    // energy drops below cap.
    state.lastUpdate = now;
    return false;
  }
  const elapsed = now - state.lastUpdate;
  if (elapsed < REGEN_MS) return false;
  const ticks = Math.floor(elapsed / REGEN_MS);
  const room = MAX_ENERGY - state.current;
  const grant = Math.min(ticks, room);
  state.current += grant;
  state.lastUpdate += grant * REGEN_MS;
  // If we hit the cap, snap lastUpdate to "now" so we don't carry a
  // partial tick from the old window.
  if (state.current >= MAX_ENERGY) state.lastUpdate = now;
  saveEnergy(state);
  return grant > 0;
}

export function canSpend(state, cost = COST_PER_GAME) {
  regenTick(state);
  return state.current >= cost;
}

export function spendEnergy(state, cost = COST_PER_GAME) {
  regenTick(state);
  if (state.current < cost) return false;
  // First spend below cap anchors the regen clock to now.
  if (state.current === MAX_ENERGY) state.lastUpdate = Date.now();
  state.current -= cost;
  state.totalSpent += cost;
  saveEnergy(state);
  return true;
}

// PLACEHOLDER. Replace this body with a real IAP flow. Today it
// short-circuits straight to a grant so devs can exercise the UI.
// A production flow would:
//   1. Call into the platform's billing SDK with packId.
//   2. Receive a signed receipt.
//   3. POST it to a server endpoint for verification.
//   4. Only on server-ack, mutate state + saveEnergy.
//
// Returns true if the grant happened.
export function purchase(state, packId) {
  const pkg = PACKAGES.find((p) => p.id === packId);
  if (!pkg) return false;
  state.current += pkg.energy;
  state.totalPurchased += pkg.energy;
  saveEnergy(state);
  return true;
}

// Time until the next single regen tick (ms). 0 once full.
export function timeUntilNext(state, now = Date.now()) {
  if (state.current >= MAX_ENERGY) return 0;
  const elapsed = now - state.lastUpdate;
  return Math.max(0, REGEN_MS - elapsed);
}

// Time until the tank is full (ms). 0 if already full.
export function timeUntilFull(state, now = Date.now()) {
  if (state.current >= MAX_ENERGY) return 0;
  const missing = MAX_ENERGY - state.current;
  return timeUntilNext(state, now) + (missing - 1) * REGEN_MS;
}

// Human-readable countdown — "1h 23m" / "12:34" / "0:08".
export function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
