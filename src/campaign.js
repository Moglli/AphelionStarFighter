// Campaign mode: 100 procedurally-generated missions, persistent money,
// and upgradeable fighter. State lives in localStorage so progress
// survives across browser sessions.
//
// Public surface:
//   MAX_MISSION                  — number of missions in the campaign
//   UPGRADES                     — upgrade catalog (key, name, desc, cost, apply)
//   defaultCampaign()            — fresh starting state
//   loadCampaign()               — read from localStorage (fallbacks to default)
//   saveCampaign(state)          — write to localStorage
//   getMissionConfig(n, race)    — roster/map/reward for mission n
//   canAfford(state, key)        — is the next level of `key` purchasable?
//   purchaseUpgrade(state, key)  — deduct money + bump level. Returns true on success.
//   buildPlayerUpgrade(state, baseFighterSpec) — specOverride patch for createShip.
//   recordVictory(state)         — bank the reward, advance the mission counter.
//                                  Returns the reward amount.

const STORAGE_KEY = "aphelion.campaign.v1";
export const MAX_MISSION = 100;
const STARTING_MONEY = 250;

// ---------------------------------------------------------------------------
// Upgrade catalogue.
//
// Each upgrade reads the BASE fighter spec and emits a deepMerge-style
// patch for createShip's specOverride. Multiplicative upgrades (engine,
// fire rate) use power-of-level so each rank stacks predictably.
// Levels are 0..10 with linear cost scaling.
// ---------------------------------------------------------------------------
export const UPGRADES = {
  hull: {
    name: "Hull Plating",
    desc: "+10 HP",
    maxLevel: 10,
    cost: (lvl) => 200 + lvl * 180,
    apply: (base, lvl) => ({ hp: base.hp + lvl * 10 }),
  },
  shield: {
    name: "Shield Capacitor",
    desc: "+6 max, +1 regen",
    maxLevel: 10,
    cost: (lvl) => 250 + lvl * 200,
    apply: (base, lvl) => ({
      shield: {
        max: base.shield.max + lvl * 6,
        regen: base.shield.regen + lvl,
        regenDelay: base.shield.regenDelay,
      },
    }),
  },
  cannon: {
    name: "Cannon Damage",
    desc: "+1 dmg per round",
    maxLevel: 10,
    cost: (lvl) => 220 + lvl * 220,
    apply: (base, lvl) => ({ weapon: { damage: base.weapon.damage + lvl } }),
  },
  fireRate: {
    name: "Fire Rate",
    desc: "-4% cooldown",
    maxLevel: 10,
    cost: (lvl) => 240 + lvl * 220,
    apply: (base, lvl) => ({
      weapon: { cooldown: base.weapon.cooldown * Math.pow(0.96, lvl) },
    }),
  },
  engine: {
    name: "Engine Tuning",
    desc: "+5% speed, +3% turn",
    maxLevel: 10,
    cost: (lvl) => 200 + lvl * 190,
    apply: (base, lvl) => ({
      maxSpeed: base.maxSpeed * Math.pow(1.05, lvl),
      turnRate: base.turnRate * Math.pow(1.03, lvl),
    }),
  },
  missile: {
    name: "Missile Tech",
    desc: "+5 dmg, -3% cooldown",
    maxLevel: 10,
    cost: (lvl) => 300 + lvl * 240,
    apply: (base, lvl) => base.missile ? ({
      missile: {
        ...base.missile,
        damage: base.missile.damage + lvl * 5,
        cooldown: base.missile.cooldown * Math.pow(0.97, lvl),
      },
    }) : {},
  },
};
export const UPGRADE_KEYS = Object.keys(UPGRADES);

// ---------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------
export function defaultCampaign() {
  const upgrades = {};
  for (const k of UPGRADE_KEYS) upgrades[k] = 0;
  return {
    mission: 1,
    money: STARTING_MONEY,
    upgrades,
    totalKills: 0,
    completed: false,
  };
}

export function loadCampaign() {
  try {
    const raw = (typeof localStorage !== "undefined") && localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultCampaign();
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.mission !== "number" || typeof obj.money !== "number") {
      return defaultCampaign();
    }
    const out = { ...defaultCampaign(), ...obj };
    out.upgrades = { ...defaultCampaign().upgrades, ...(obj.upgrades || {}) };
    return out;
  } catch {
    return defaultCampaign();
  }
}

export function saveCampaign(state) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* full / disabled storage: silent */ }
}

export function resetCampaign(state) {
  const fresh = defaultCampaign();
  Object.assign(state, fresh);
  saveCampaign(state);
}

// ---------------------------------------------------------------------------
// Upgrade purchasing.
// ---------------------------------------------------------------------------
export function nextCost(state, key) {
  const def = UPGRADES[key];
  if (!def) return Infinity;
  const lvl = state.upgrades[key] || 0;
  if (lvl >= def.maxLevel) return Infinity;
  return def.cost(lvl);
}

export function canAfford(state, key) {
  const c = nextCost(state, key);
  return Number.isFinite(c) && state.money >= c;
}

export function purchaseUpgrade(state, key) {
  if (!canAfford(state, key)) return false;
  const c = nextCost(state, key);
  state.money -= c;
  state.upgrades[key] = (state.upgrades[key] || 0) + 1;
  saveCampaign(state);
  return true;
}

// Build a deepMerge-compatible patch describing the player's current
// fighter loadout. Caller passes the resolved base fighter spec
// (race-merged) so per-race fighter baselines are respected.
export function buildPlayerUpgrade(state, baseSpec) {
  let patch = {};
  for (const key of UPGRADE_KEYS) {
    const lvl = state.upgrades[key] || 0;
    if (lvl <= 0) continue;
    const def = UPGRADES[key];
    patch = mergePatches(patch, def.apply(baseSpec, lvl));
  }
  return patch;
}

function mergePatches(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b)) {
    const v = b[k];
    if (v && typeof v === "object" && !Array.isArray(v)
        && a[k] && typeof a[k] === "object" && !Array.isArray(a[k])) {
      out[k] = mergePatches(a[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mission generation. Difficulty curve is a smooth ramp from a trivial
// 2-fighter skirmish at mission 1 to a full-fleet brawl at mission 100.
// Allies lag enemy strength so the player is the deciding factor.
// ---------------------------------------------------------------------------
export function getMissionConfig(missionNumber, playerRace) {
  const m = Math.max(1, Math.min(MAX_MISSION, missionNumber));
  const t = (m - 1) / (MAX_MISSION - 1); // 0..1 progress

  // Map grows with difficulty so the bigger fleets have room to maneuver.
  const mapW = Math.round(4000 + t * 12000);
  const mapH = Math.round(3000 + t * 9000);

  // Enemy composition. Each class unlocks at a threshold then ramps.
  const enemies = {
    fighter:    Math.max(2, Math.floor(2 + t * 10)),
    bomber:     m >= 8  ? Math.max(1, Math.floor((m - 7)  / 8))   : 0,
    frigate:    m >= 4  ? Math.max(1, Math.floor((m - 3)  / 6))   : 0,
    cruiser:    m >= 18 ? Math.max(1, Math.floor((m - 17) / 14))  : 0,
    battleship: m >= 35 ? Math.max(1, Math.floor((m - 34) / 22))  : 0,
    carrier:    m >= 55 ? Math.max(1, Math.floor((m - 54) / 30))  : 0,
  };
  // Allies grow slower and lag behind enemy unlock thresholds.
  const allies = {
    fighter:    Math.max(1, Math.floor(1 + t * 5)),
    bomber:     m >= 14 ? Math.max(1, Math.floor((m - 13) / 12))  : 0,
    frigate:    m >= 9  ? Math.max(1, Math.floor((m - 8)  / 7))   : 0,
    cruiser:    m >= 28 ? Math.max(1, Math.floor((m - 27) / 18))  : 0,
    battleship: m >= 55 ? Math.max(1, Math.floor((m - 54) / 26))  : 0,
    carrier:    m >= 78 ? Math.max(1, Math.floor((m - 77) / 28))  : 0,
  };

  // Reward grows with mission, with a difficulty-tilted bonus so late
  // missions are worth grinding when you're underleveled.
  const reward = Math.round(300 + m * 60 + Math.pow(t, 1.5) * 1400);

  return {
    mission: m,
    mapW, mapH,
    race: playerRace || "terran",
    enemies, allies,
    reward,
  };
}

export function recordVictory(state) {
  const cfg = getMissionConfig(state.mission, "terran");
  const reward = cfg.reward;
  state.money += reward;
  state.mission = state.mission + 1;
  if (state.mission > MAX_MISSION) {
    state.mission = MAX_MISSION;
    state.completed = true;
  }
  saveCampaign(state);
  return reward;
}
