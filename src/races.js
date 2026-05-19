// Race definitions. Each race is a sparse modifier table over the base
// Terran ship specs in classes.js, plus a per-race ROSTER.
//
// resolveSpec(raceKey, klass) returns a merged spec — the base class
// spec with race-specific overrides applied (deep-merged for nested
// objects like weapon, shield, armor, missilePods, heavyLaser, etc).
import { CLASSES } from "./classes.js";

export const RACES = {
  terran: {
    key: "terran",
    name: "Terran",
    tagline: "Balanced",
    accent: "#7df",
    fighter: {}, bomber: {}, frigate: {}, cruiser: {}, battleship: {}, carrier: {},
    roster: { fighter: 24, bomber: 6, frigate: 4, cruiser: 2, battleship: 1, carrier: 1 },
  },
  reavers: {
    key: "reavers",
    name: "Reavers",
    tagline: "Swarm",
    accent: "#c6f",
    fighter: {
      hp: 22, maxSpeed: 460, turnRate: 3.6,
      shield: { max: 12, regen: 9, regenDelay: 2.5 },
      weapon: { damage: 3, cooldown: 0.14, capacity: 24, reloadTime: 0.5 },
    },
    bomber: {
      hp: 50, maxSpeed: 260, turnRate: 1.8,
      shield: { max: 20, regen: 6, regenDelay: 3 },
      missilePods: { count: 2, cooldown: 9.0, damage: 55, projectileSpeed: 320 },
    },
    frigate: {
      hp: 100, maxSpeed: 180,
      shield: { max: 60 }, armor: { max: 60 },
    },
    cruiser: {
      hp: 320, maxSpeed: 100,
      armor: { max: 180 },
      weapon: { damage: 20, cooldown: 0.65 },
    },
    battleship: {
      hp: 770, shield: { max: 400 }, armor: { max: 400 },
    },
    carrier: {
      replenish: { fighter: 12.0, bomber: 24.0 },
      escortSize: 8,
    },
    roster: { fighter: 36, bomber: 9, frigate: 6, cruiser: 1, battleship: 0, carrier: 1 },
  },
  hegemony: {
    key: "hegemony",
    name: "Hegemony",
    tagline: "Heavy",
    accent: "#fc6",
    fighter: {
      hp: 52, maxSpeed: 320, turnRate: 2.7,
      shield: { max: 40, regen: 8, regenDelay: 3.5 },
      weapon: { damage: 5, cooldown: 0.20 },
    },
    bomber: {
      hp: 110, maxSpeed: 180,
      shield: { max: 55 },
    },
    frigate: {
      hp: 180, maxSpeed: 110,
      shield: { max: 120 },
      armor: { max: 160, wearRate: 0.5 },
    },
    cruiser: {
      hp: 540, maxSpeed: 65,
      shield: { max: 320 }, armor: { max: 380, wearRate: 0.45 },
      missilePods: { count: 3 },
    },
    battleship: {
      hp: 1500, maxSpeed: 56,
      shield: { max: 750 }, armor: { max: 850, wearRate: 0.4 },
      pdCannons: { count: 5 },
    },
    carrier: {
      hp: 1500, maxSpeed: 35,
      shield: { max: 700 }, armor: { max: 800 },
    },
    roster: { fighter: 18, bomber: 4, frigate: 5, cruiser: 3, battleship: 2, carrier: 1 },
  },
  voidsworn: {
    key: "voidsworn",
    name: "Voidsworn",
    tagline: "Tech",
    accent: "#9fa",
    fighter: {
      hp: 28,
      shield: { max: 50, regen: 16, regenDelay: 1.8 },
      weapon: { damage: 5 },
      missile: { damage: 36 },
    },
    bomber: {
      hp: 65,
      shield: { max: 70, regen: 12, regenDelay: 2.5 },
      missilePods: { damage: 85 },
    },
    frigate: {
      hp: 120,
      shield: { max: 200, regen: 18, regenDelay: 2.5 },
      armor: { max: 80 },
    },
    cruiser: {
      hp: 380,
      shield: { max: 480, regen: 28, regenDelay: 3 },
      armor: { max: 240 },
    },
    battleship: {
      hp: 950,
      shield: { max: 1100, regen: 40, regenDelay: 4 },
      armor: { max: 550 },
      heavyLaser: { damage: 220, cooldown: 4.0, arc: Math.PI * 0.7 },
    },
    carrier: {
      hp: 1000,
      shield: { max: 850, regen: 28, regenDelay: 3.5 },
      escortSize: 7,
      replenish: { fighter: 22, bomber: 40 },
    },
    roster: { fighter: 18, bomber: 5, frigate: 4, cruiser: 2, battleship: 1, carrier: 1 },
  },
};

export const RACE_KEYS = Object.keys(RACES);

export function resolveSpec(raceKey, klass) {
  const base = CLASSES[klass];
  const race = RACES[raceKey] || RACES.terran;
  const mods = race[klass] || {};
  return deepMerge(base, mods);
}

export function randomRaceKey() {
  return RACE_KEYS[Math.floor(Math.random() * RACE_KEYS.length)];
}

// Deep-merge `mods` onto `base`. Plain objects recurse; scalars and
// arrays replace wholesale. Returns a new object — base is untouched.
function deepMerge(base, mods) {
  if (mods === null || typeof mods !== "object" || Array.isArray(mods)) return mods;
  if (base === null || typeof base !== "object" || Array.isArray(base)) {
    return cloneDeep(mods);
  }
  const out = { ...base };
  for (const k in mods) {
    const mv = mods[k];
    const bv = base[k];
    if (mv && typeof mv === "object" && !Array.isArray(mv) &&
        bv && typeof bv === "object" && !Array.isArray(bv)) {
      out[k] = deepMerge(bv, mv);
    } else {
      out[k] = mv;
    }
  }
  return out;
}

function cloneDeep(o) {
  if (o === null || typeof o !== "object") return o;
  if (Array.isArray(o)) return o.map(cloneDeep);
  const out = {};
  for (const k in o) out[k] = cloneDeep(o[k]);
  return out;
}
