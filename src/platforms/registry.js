/**
 * @file Platform type registry — built-in defence platform definitions.
 *
 * Each entry produces a `spec` shape compatible with applyDamage's
 * shield→hull cascade (CLAUDE.md "Damage layers"). Platforms are
 * stationary, never surrender, and have no movement spec.
 *
 * Weapon spec mirrors the ship weapon shape so the firing path can reuse
 * the same projectile.createCannon contract. Pod / laser support is
 * deferred — v1 ships the cannon + PD layout.
 */

export const PLATFORM_TYPES = {
  "turret-bastion": {
    id: "turret-bastion",
    name: "Turret Bastion",
    blurb: "Twin heavy cannon + PD ring. Anti-everything generalist.",
    spec: {
      radius: 90,
      hp: 4000,
      shield: { max: 2000, regen: 25, regenDelay: 4 },
      weapon: { damage: 24, cooldown: 0.4, range: 1400, projectileSpeed: 900, projectileRadius: 5 },
      pdCannons: { count: 4, range: 480, damage: 4, cooldown: 0.18 },
    },
    color: { hull: "#445", trim: "#bcd" },
  },
  "missile-platform": {
    id: "missile-platform",
    name: "Missile Platform",
    blurb: "Long-range missile silos; thin shield, no PD.",
    spec: {
      radius: 80,
      hp: 2200,
      shield: { max: 800, regen: 12, regenDelay: 6 },
      weapon: { damage: 60, cooldown: 1.8, range: 2200, projectileSpeed: 700, projectileRadius: 7,
                kind: "missile", acquireRange: 2400, turnRate: 1.2 },
    },
    color: { hull: "#543", trim: "#fc8" },
  },
  "beam-fortress": {
    id: "beam-fortress",
    name: "Beam Fortress",
    blurb: "Single heavy beam, slow cycle, devastating up close.",
    spec: {
      radius: 100,
      hp: 5000,
      shield: { max: 3000, regen: 30, regenDelay: 3 },
      weapon: { damage: 120, cooldown: 2.4, range: 1600, projectileSpeed: 1400, projectileRadius: 4,
                kind: "beam" },
      pdCannons: { count: 2, range: 420, damage: 3.5, cooldown: 0.20 },
    },
    color: { hull: "#534", trim: "#cae" },
  },
  "shield-generator": {
    id: "shield-generator",
    name: "Shield Generator",
    blurb: "No offense; thick shield, soaks fire for adjacent allies.",
    spec: {
      radius: 70,
      hp: 1800,
      shield: { max: 4000, regen: 60, regenDelay: 2 },
      // No weapon — generator just absorbs hits.
    },
    color: { hull: "#354", trim: "#9df" },
  },
};

export const PLATFORM_TYPE_KEYS = Object.keys(PLATFORM_TYPES);
export const DEFAULT_PLATFORM_TYPE = "turret-bastion";
