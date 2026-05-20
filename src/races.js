// Race definitions. Each race is a sparse modifier table over the base
// Terran ship specs in classes.js, plus a per-race ROSTER.
//
// resolveSpec(raceKey, klass) returns a merged spec — the base class
// spec with race-specific overrides applied (deep-merged for nested
// objects like weapon, shield, armor, missilePods, heavyLaser, etc).
//
// Defend-mode stations are defined under RACES[race].station as
// { spread, nodes[] } — one entry per destruction target. Each node has
// an offset and a per-node `mods` block layered onto base station spec
// at spawn time via createShip's specOverride parameter.
import { CLASSES } from "./classes.js";

// ---------------------------------------------------------------------------
// Weapon-system templates shared across station nodes. Each race tweaks
// these slightly so a Hegemony PD bank feels different from a Voidsworn one.
// ---------------------------------------------------------------------------
const PD_BASE = {
  damage: 9, cooldown: 0.18, projectileSpeed: 1040, range: 560,
  projectileRadius: 3, projectileColors: { blue: "#cef", red: "#fda" },
};
const MISSILES_BASE = {
  damage: 80, cooldown: 7, projectileSpeed: 320, range: 2400,
  ttl: 8.5, turnRate: 1.9, hp: 4, radius: 7, acquireRange: 2600,
  colors: { blue: "#fff", red: "#fc8" },
};
const LASER_BASE = {
  damage: 260, cooldown: 4.5, range: 2600,
  // Wide arc — stations can't snap-turn so the heavy beam covers a full
  // forward hemisphere.
  arc: Math.PI * 0.95,
  beamDuration: 0.45,
  beamColors: { blue: "#9ef", red: "#fc7" },
};
const pd = (count, extra = {}) => ({ ...PD_BASE, ...extra, count });
const pods = (count, extra = {}) => ({ ...MISSILES_BASE, ...extra, count });
const laser = (extra = {}) => ({ ...LASER_BASE, ...extra });

export const RACES = {
  terran: {
    key: "terran",
    name: "Terran",
    tagline: "Balanced",
    accent: "#7df",
    fighter: {}, bomber: {}, frigate: {}, cruiser: {}, battleship: {}, carrier: {},
    roster: { fighter: 24, bomber: 6, frigate: 4, cruiser: 2, battleship: 1, carrier: 1 },
    station: {
      spread: 260,
      nodes: [
        { name: "Core",         offset: { x:  0, y:  0 },
          mods: { hp: 1200, radius: 100,
                  shield: { max: 600 }, armor: { max: 600 },
                  pdCannons: pd(4), missilePods: pods(2), heavyLaser: laser() } },
        { name: "PD Spire NE",  offset: { x:  1, y:  1 },
          mods: { hp: 500, radius: 55, pdCannons: pd(5) } },
        { name: "PD Spire SE",  offset: { x:  1, y: -1 },
          mods: { hp: 500, radius: 55, pdCannons: pd(5) } },
        { name: "Bastion NW",   offset: { x: -1, y:  1 },
          mods: { hp: 500, radius: 55, pdCannons: pd(2), missilePods: pods(1) } },
        { name: "Bastion SW",   offset: { x: -1, y: -1 },
          mods: { hp: 500, radius: 55, pdCannons: pd(2), missilePods: pods(1) } },
      ],
    },
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
    },
    roster: { fighter: 36, bomber: 9, frigate: 6, cruiser: 1, battleship: 0, carrier: 1 },
    // Reavers: more, smaller nodes — a bristling spike-cluster instead of
    // a fortress. Lots of missile pods, no heavy laser.
    station: {
      spread: 230,
      nodes: [
        { name: "Hive Core",  offset: { x:  0, y:  0 },
          mods: { hp: 700, radius: 80,
                  shield: { max: 250 }, armor: { max: 320 },
                  pdCannons: pd(3, { damage: 5 }), missilePods: pods(2, { damage: 50, cooldown: 7 }) } },
        { name: "Spike N",    offset: { x:  0, y:  1.1 },
          mods: { hp: 320, radius: 42, missilePods: pods(2, { damage: 50, cooldown: 7 }), pdCannons: pd(2, { damage: 5 }) } },
        { name: "Spike NE",   offset: { x:  1, y:  0.6 },
          mods: { hp: 320, radius: 42, missilePods: pods(2, { damage: 50, cooldown: 7 }), pdCannons: pd(2, { damage: 5 }) } },
        { name: "Spike SE",   offset: { x:  1, y: -0.6 },
          mods: { hp: 320, radius: 42, pdCannons: pd(4, { damage: 5 }) } },
        { name: "Spike S",    offset: { x:  0, y: -1.1 },
          mods: { hp: 320, radius: 42, missilePods: pods(2, { damage: 50, cooldown: 7 }), pdCannons: pd(2, { damage: 5 }) } },
        { name: "Spike SW",   offset: { x: -1, y: -0.6 },
          mods: { hp: 320, radius: 42, missilePods: pods(2, { damage: 50, cooldown: 7 }), pdCannons: pd(2, { damage: 5 }) } },
        { name: "Spike NW",   offset: { x: -1, y:  0.6 },
          mods: { hp: 320, radius: 42, pdCannons: pd(4, { damage: 5 }) } },
      ],
    },
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
      hp: 1500, maxSpeed: 28,
      shield: { max: 750 }, armor: { max: 850, wearRate: 0.4 },
      pdCannons: { count: 8 },
    },
    carrier: {
      hp: 1500, maxSpeed: 35,
      shield: { max: 700 }, armor: { max: 800 },
    },
    roster: { fighter: 18, bomber: 4, frigate: 5, cruiser: 3, battleship: 2, carrier: 1 },
    // Hegemony: 5 hardened nodes. Big armor pools, biggest core.
    station: {
      spread: 280,
      nodes: [
        { name: "Citadel Core",   offset: { x:  0, y:  0 },
          mods: { hp: 2500, radius: 120,
                  shield: { max: 1000 }, armor: { max: 1500, wearRate: 0.4 },
                  pdCannons: pd(6, { damage: 9 }), missilePods: pods(2, { damage: 80 }), heavyLaser: laser({ damage: 260, cooldown: 4.5 }) } },
        { name: "Bastion N",      offset: { x:  0, y:  1 },
          mods: { hp: 1100, radius: 65,
                  shield: { max: 400 }, armor: { max: 600, wearRate: 0.42 },
                  pdCannons: pd(5, { damage: 9 }), missilePods: pods(1, { damage: 80 }) } },
        { name: "Bastion S",      offset: { x:  0, y: -1 },
          mods: { hp: 1100, radius: 65,
                  shield: { max: 400 }, armor: { max: 600, wearRate: 0.42 },
                  pdCannons: pd(5, { damage: 9 }), missilePods: pods(1, { damage: 80 }) } },
        { name: "Reinforced E",   offset: { x:  1, y:  0 },
          mods: { hp: 1000, radius: 60,
                  shield: { max: 400 }, armor: { max: 500, wearRate: 0.42 },
                  pdCannons: pd(6, { damage: 9 }) } },
        { name: "Reinforced W",   offset: { x: -1, y:  0 },
          mods: { hp: 1000, radius: 60,
                  shield: { max: 400 }, armor: { max: 500, wearRate: 0.42 },
                  pdCannons: pd(6, { damage: 9 }) } },
      ],
    },
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
      replenish: { fighter: 22, bomber: 40 },
    },
    roster: { fighter: 18, bomber: 5, frigate: 4, cruiser: 2, battleship: 1, carrier: 1 },
    // Voidsworn: huge shields with fast regen, premium beam weapons. Fewer
    // nodes but each one is shield-tanky.
    station: {
      spread: 250,
      nodes: [
        { name: "Aegis Core",     offset: { x:  0, y:  0 },
          mods: { hp: 1100, radius: 95,
                  shield: { max: 1500, regen: 35, regenDelay: 4 }, armor: { max: 500 },
                  pdCannons: pd(4), missilePods: pods(2, { damage: 80 }), heavyLaser: laser({ damage: 240, cooldown: 4.0 }) } },
        { name: "Crystal NE",     offset: { x:  1, y:  1 },
          mods: { hp: 600, radius: 55,
                  shield: { max: 700, regen: 24, regenDelay: 3 }, armor: { max: 240 },
                  pdCannons: pd(3), heavyLaser: laser({ damage: 180, cooldown: 5.0 }) } },
        { name: "Crystal NW",     offset: { x: -1, y:  1 },
          mods: { hp: 600, radius: 55,
                  shield: { max: 700, regen: 24, regenDelay: 3 }, armor: { max: 240 },
                  pdCannons: pd(4) } },
        { name: "Crystal SE",     offset: { x:  1, y: -1 },
          mods: { hp: 600, radius: 55,
                  shield: { max: 700, regen: 24, regenDelay: 3 }, armor: { max: 240 },
                  pdCannons: pd(3), heavyLaser: laser({ damage: 180, cooldown: 5.0 }) } },
        { name: "Crystal SW",     offset: { x: -1, y: -1 },
          mods: { hp: 600, radius: 55,
                  shield: { max: 700, regen: 24, regenDelay: 3 }, armor: { max: 240 },
                  pdCannons: pd(4) } },
      ],
    },
  },
};

export const RACE_KEYS = Object.keys(RACES);

// Non-linear hull-HP scaling by class tier. Capitals were too brittle —
// a battleship would crumble in ~30 s of focused fire which made big
// ships feel small. Multiplier curve ramps superlinearly: light craft
// keep their base HP, capitals scale 3–4.5× so module destruction
// (laser, missile pods, broadsides) becomes the practical way to
// disable a capital instead of grinding hull. Applied AFTER race
// overrides deep-merge, so race-specific HP variance (Reavers'
// glass-cannons, Hegemony's tanks) still rides on top.
const HP_TIER_MUL = {
  fighter:    1.0,
  bomber:     1.3,
  frigate:    2.0,
  cruiser:    3.0,
  battleship: 4.5,
  carrier:    4.5,
  station:    3.0,
};

export function resolveSpec(raceKey, klass) {
  const base = CLASSES[klass];
  const race = RACES[raceKey] || RACES.terran;
  // `race.station` is a spawn descriptor ({ spread, nodes }), not a spec
  // override. Per-node mods are applied via createShip's specOverride.
  if (klass === "station") {
    const mul = HP_TIER_MUL[klass] || 1;
    if (mul !== 1 && base.hp) {
      return { ...base, hp: Math.round(base.hp * mul) };
    }
    return base;
  }
  const mods = race[klass] || {};
  const merged = deepMerge(base, mods);
  const mul = HP_TIER_MUL[klass] || 1;
  if (mul !== 1 && merged.hp) {
    merged.hp = Math.round(merged.hp * mul);
  }
  return merged;
}

export function getStationDef(raceKey) {
  const race = RACES[raceKey] || RACES.terran;
  return race.station || RACES.terran.station;
}

export function randomRaceKey() {
  return RACE_KEYS[Math.floor(Math.random() * RACE_KEYS.length)];
}

// Deep-merge `mods` onto `base`. Plain objects recurse; scalars and
// arrays replace wholesale. Returns a new object — base is untouched.
export function deepMerge(base, mods) {
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
