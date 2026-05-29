/**
 * @file components.js — persistent player ship component library + design patcher.
 *
 * The "design-your-own-ship" feature lives entirely on top of the existing
 * spec pipeline. A design is just a hull class + a map of slot → component id.
 * `applyDesign(spec, design)` returns a patched spec; createShip consumes
 * that path identically to a specOverride, so AI / physics / render are
 * untouched.
 *
 * Default design (DEFAULT_PLAYER_DESIGN) reproduces the current stock Terran
 * fighter exactly — a save before this feature shipped boots with no
 * behaviour change.
 */

import { deepMerge } from "./races.js";

// --- HULLS ------------------------------------------------------------
// Maps each hull to: cost in shipyard credits, slot map (which slot kinds
// can be filled at what size), and a base klass (which CLASSES entry
// drives stats). Component picker filters by `slot` field below.
//
// Slot kinds:
//   weapon-*    primary forward/broadside cannon
//   pd-*        point defense ring
//   missile-*   missile pods / racks
//   shield-*    energy shield
//   armor-*     armor plating
//   engine-*    propulsion
//   hangar      (carrier-only) fighter/bomber replenishment
export const HULLS = {
  fighter: {
    klass: "fighter",
    cost: 0,
    label: "Fighter",
    blurb: "Stock interceptor. Fast, fragile.",
    slots: ["weapon-small", "missile-small", "shield-small", "engine-small"],
  },
  bomber: {
    klass: "bomber",
    cost: 400,
    label: "Bomber",
    blurb: "Slow capital killer with bigger missile racks.",
    slots: ["weapon-small", "missile-medium", "shield-medium", "engine-small"],
  },
  frigate: {
    klass: "frigate",
    cost: 1800,
    label: "Frigate",
    blurb: "Anti-fighter escort with PD ring.",
    slots: ["weapon-medium", "pd-medium", "missile-medium", "shield-medium", "engine-medium"],
  },
  cruiser: {
    klass: "cruiser",
    cost: 8500,
    label: "Cruiser",
    blurb: "Long-range artillery: heavy cannon, cluster pods.",
    slots: ["weapon-large", "pd-medium", "missile-medium", "shield-medium", "armor-medium", "engine-medium"],
  },
  battleship: {
    klass: "battleship",
    cost: 25000,
    label: "Battleship",
    blurb: "Broadside dreadnought. Heavy laser, twin batteries.",
    slots: ["weapon-large", "weapon-large-2", "pd-heavy", "missile-medium", "missile-medium-2", "shield-heavy", "armor-heavy", "engine-medium", "engine-medium-2"],
  },
  carrier: {
    klass: "carrier",
    cost: 40000,
    label: "Carrier",
    blurb: "Launches its own escort squadrons.",
    slots: ["hangar", "pd-heavy", "missile-medium", "missile-medium-2", "shield-heavy", "armor-medium", "engine-medium", "engine-medium-2"],
  },
};

export const HULL_ORDER = ["fighter", "bomber", "frigate", "cruiser", "battleship", "carrier"];

// Per-slot visual hotspot positions in unit space [-1, 1] (matches the
// hull polygon coord space in src/ship.js HULLS). The Shipyard ship-
// preview overlays these as clickable dots on the hull silhouette. Each
// entry: { x, y, category, icon }.
//
// Positions are intentionally generic — slot ids don't depend on race
// or specific hull shape, so the same hotspot map works for any hull.
// `category` drives the dot color; `icon` is the glyph shown inside.
export const SLOT_VISUALS = {
  "weapon-small":    { x:  0.70, y:  0.00, category: "weapon",   icon: "✦" },
  "weapon-medium":   { x:  0.00, y:  0.00, category: "weapon",   icon: "✦" },
  "weapon-large":    { x:  0.55, y:  0.00, category: "weapon",   icon: "✦" },
  "weapon-large-2":  { x: -0.30, y:  0.00, category: "weapon",   icon: "✦" },
  "pd-medium":       { x:  0.30, y: -0.60, category: "pd",       icon: "•" },
  "pd-heavy":        { x:  0.30, y: -0.60, category: "pd",       icon: "•" },
  "missile-small":   { x:  0.00, y:  0.45, category: "missile",  icon: "▲" },
  "missile-medium":  { x: -0.10, y:  0.55, category: "missile",  icon: "▲" },
  "missile-medium-2":{ x: -0.10, y: -0.55, category: "missile",  icon: "▲" },
  "shield-small":    { x: -0.05, y:  0.00, category: "shield",   icon: "◊" },
  "shield-medium":   { x: -0.05, y:  0.00, category: "shield",   icon: "◊" },
  "shield-heavy":    { x: -0.05, y:  0.00, category: "shield",   icon: "◊" },
  "armor-medium":    { x:  0.30, y:  0.55, category: "armor",    icon: "■" },
  "armor-heavy":     { x:  0.30, y:  0.55, category: "armor",    icon: "■" },
  "engine-small":    { x: -0.70, y:  0.00, category: "engine",   icon: "►" },
  "engine-medium":   { x: -0.65, y:  0.30, category: "engine",   icon: "►" },
  "engine-medium-2": { x: -0.65, y: -0.30, category: "engine",   icon: "►" },
  "hangar":          { x:  0.00, y:  0.00, category: "hangar",   icon: "✈" },
};

/**
 * Tier rank for a hull id (fighter=0 .. carrier=5). Used by the
 * Frontier enemy-scaler so larger player ships face proportionally
 * larger enemy forces.
 */
export function playerTierFromHull(hullId) {
  const idx = HULL_ORDER.indexOf(hullId);
  return idx < 0 ? 0 : idx;
}

// --- COMPONENT LIBRARY ------------------------------------------------
// Each component declares: id, name, slot kinds it fits into, cost in
// shipyard credits, narrative blurb, and an `applies(spec)` patch function
// that returns a partial spec to deep-merge onto the base resolved spec.
//
// `default: true` flags the entry as the free starter for its slot kind —
// every player owns these from day one (see DEFAULT_OWNED_COMPONENTS).
export const COMPONENTS = {
  // ---- WEAPONS: small (fighter / bomber) -----------------------------
  "weapon-light-cannon": {
    id: "weapon-light-cannon", name: "Light Cannon", category: "weapon",
    slots: ["weapon-small"], cost: 0, default: true,
    blurb: "Stock issue forward cannon.",
    applies: () => ({ /* base fighter weapon */ }),
  },
  "weapon-burst-cannon": {
    id: "weapon-burst-cannon", name: "Burst Cannon", category: "weapon",
    slots: ["weapon-small"], cost: 350,
    blurb: "Rapid 3-shot bursts. Higher DPS, lower per-shot.",
    applies: () => ({ weapon: { damage: 3, cooldown: 0.10, capacity: 36, reloadTime: 0.7 } }),
  },
  "weapon-twin-cannons": {
    id: "weapon-twin-cannons", name: "Twin Cannons", category: "weapon",
    slots: ["weapon-small"], cost: 800,
    blurb: "Doubled mounts, +50% damage.",
    applies: () => ({ weapon: { damage: 6, cooldown: 0.22, muzzles: 2, muzzleSpread: 10 } }),
  },
  "weapon-sniper-rifle": {
    id: "weapon-sniper-rifle", name: "Marksman Rifle", category: "weapon",
    slots: ["weapon-small"], cost: 1100,
    blurb: "Slow shots, huge damage, long range.",
    applies: () => ({ weapon: { damage: 18, cooldown: 0.75, projectileSpeed: 1100, range: 1600, capacity: 12, reloadTime: 1.0 } }),
  },
  "weapon-pulse-repeater": {
    id: "weapon-pulse-repeater", name: "Pulse Repeater", category: "weapon",
    slots: ["weapon-small"], cost: 1000,
    blurb: "Sustained rapid fire. Smaller mag, bigger pool.",
    applies: () => ({ weapon: { damage: 2.5, cooldown: 0.07, capacity: 50, reloadTime: 0.9 } }),
  },
  "weapon-scatter-cannon": {
    id: "weapon-scatter-cannon", name: "Scatter Cannon", category: "weapon",
    slots: ["weapon-small"], cost: 1400,
    blurb: "Shotgun spread. Devastating at point-blank.",
    applies: () => ({ weapon: { damage: 4, cooldown: 0.35, muzzles: 5, muzzleSpread: 28, spread: 0.18, projectileSpeed: 620, range: 500 } }),
  },
  "weapon-plasma-lance": {
    id: "weapon-plasma-lance", name: "Plasma Lance", category: "weapon",
    slots: ["weapon-small"], cost: 2200,
    blurb: "Hot plasma bolts. High damage, slower projectiles.",
    applies: () => ({ weapon: { damage: 12, cooldown: 0.40, projectileSpeed: 640, range: 1100, projectileRadius: 6, capacity: 20, reloadTime: 1.1 } }),
  },
  "weapon-twin-mk2": {
    id: "weapon-twin-mk2", name: "Twin Cannons mk2", category: "weapon",
    slots: ["weapon-small"], cost: 1500,
    blurb: "Higher damage twin mounts.",
    applies: () => ({ weapon: { damage: 9, cooldown: 0.20, muzzles: 2, muzzleSpread: 12, capacity: 30, reloadTime: 0.6 } }),
  },

  // ---- WEAPONS: medium (frigate) -------------------------------------
  "weapon-ring-cannon-array": {
    id: "weapon-ring-cannon-array", name: "Ring Cannon Array", category: "weapon",
    slots: ["weapon-medium"], cost: 0, default: true,
    blurb: "Four mounts, 360° coverage.",
    applies: () => ({ /* base frigate ring cannons */ }),
  },
  "weapon-frigate-heavy-array": {
    id: "weapon-frigate-heavy-array", name: "Heavy Ring Array", category: "weapon",
    slots: ["weapon-medium"], cost: 1600,
    blurb: "Higher damage per mount; slower cycle.",
    applies: () => ({ ringCannons: { count: 4, damage: 14, cooldown: 0.45, projectileSpeed: 760, range: 900, projectileRadius: 4 } }),
  },
  "weapon-frigate-quad-array": {
    id: "weapon-frigate-quad-array", name: "Quad Cannon Array", category: "weapon",
    slots: ["weapon-medium"], cost: 2400,
    blurb: "Six-mount 360° array. Anti-swarm specialist.",
    applies: () => ({ ringCannons: { count: 6, damage: 10, cooldown: 0.30, projectileSpeed: 800, range: 950, projectileRadius: 4 } }),
  },
  "weapon-frigate-storm-cannon": {
    id: "weapon-frigate-storm-cannon", name: "Storm Cannon", category: "weapon",
    slots: ["weapon-medium"], cost: 3000,
    blurb: "Rapid-fire heavy array. Best DPS at the cost of range.",
    applies: () => ({ ringCannons: { count: 4, damage: 16, cooldown: 0.22, projectileSpeed: 780, range: 800, projectileRadius: 5 } }),
  },
  "weapon-frigate-particle-lance": {
    id: "weapon-frigate-particle-lance", name: "Particle Lance Array", category: "weapon",
    slots: ["weapon-medium"], cost: 3800,
    blurb: "Energy weapons. Heavy single-shot damage per mount.",
    applies: () => ({ ringCannons: { count: 4, damage: 26, cooldown: 0.65, projectileSpeed: 1000, range: 1300, projectileRadius: 5 } }),
  },

  // ---- WEAPONS: large (cruiser / battleship) -------------------------
  "weapon-bow-cannon": {
    id: "weapon-bow-cannon", name: "Bow Cannon", category: "weapon",
    slots: ["weapon-large", "weapon-large-2"], cost: 0, default: true,
    blurb: "Forward-facing salvo cannon.",
    applies: () => ({
      firingMode: "forward",
      weapon: { damage: 50, cooldown: 1.6, projectileSpeed: 560, range: 1500,
                salvo: { shotsPerVolley: 3, intraShotDelay: 0.10 },
                muzzles: 1, projectileRadius: 7, spread: 0.05,
                projectileColors: { blue: "#9ef", red: "#fc8" } },
    }),
  },
  "weapon-broadside-battery": {
    id: "weapon-broadside-battery", name: "Broadside Battery", category: "weapon",
    slots: ["weapon-large", "weapon-large-2"], cost: 3200,
    blurb: "Port + starboard cannon volleys.",
    applies: (klass) => ({
      firingMode: "broadside",
      weapon: { damage: 40, cooldown: 1.6, projectileSpeed: 560, range: 1500, salvo: { shotsPerVolley: 4, intraShotDelay: 0.12 }, projectileRadius: 7, projectileColors: { blue: "#9ef", red: "#fc8" } },
    }),
  },
  "weapon-heavy-laser": {
    id: "weapon-heavy-laser", name: "Heavy Laser", category: "weapon",
    slots: ["weapon-large", "weapon-large-2"], cost: 4500,
    blurb: "3-second sustained beam. Bypasses 50% shield.",
    applies: () => ({
      heavyLaser: { damage: 220, beamDuration: 3.0, cooldown: 9.0, range: 2400, arc: Math.PI * 0.45, beamColors: { blue: "#9ff", red: "#f99" } },
    }),
  },
  "weapon-siege-missile": {
    id: "weapon-siege-missile", name: "Siege Missile", category: "weapon",
    slots: ["weapon-large", "weapon-large-2"], cost: 3800,
    blurb: "Single heavy pod. 240 dmg. Bypasses shields, large blast.",
    applies: () => ({
      missilePods: { count: 1, damage: 240, cooldown: 18, projectileSpeed: 320, ttl: 12,
        range: 2400, hp: 10, radius: 8, turnRate: 0.6,
        bypassShield: true, blastRadius: 45 },
    }),
  },
  "weapon-twin-bow-cannons": {
    id: "weapon-twin-bow-cannons", name: "Twin Bow Cannons", category: "weapon",
    slots: ["weapon-large", "weapon-large-2"], cost: 5500,
    blurb: "Paired forward salvos. Doubled DPS, same arc.",
    applies: () => ({
      firingMode: "forward",
      weapon: { damage: 35, cooldown: 1.4, projectileSpeed: 540, range: 1400, salvo: { shotsPerVolley: 3, intraShotDelay: 0.10 }, projectileRadius: 7, muzzles: 2, muzzleSpread: 26, projectileColors: { blue: "#9ef", red: "#fc8" } },
    }),
  },
  "weapon-mass-driver": {
    id: "weapon-mass-driver", name: "Mass Driver", category: "weapon",
    slots: ["weapon-large", "weapon-large-2"], cost: 7000,
    blurb: "Kinetic rail slug. One round, devastating impact.",
    applies: () => ({
      firingMode: "forward",
      weapon: { damage: 220, cooldown: 5.5, projectileSpeed: 1600, range: 2400, projectileRadius: 9, salvo: { shotsPerVolley: 1, intraShotDelay: 0 }, projectileColors: { blue: "#cff", red: "#fcc" } },
    }),
  },
  "weapon-particle-cannon": {
    id: "weapon-particle-cannon", name: "Particle Cannon", category: "weapon",
    slots: ["weapon-large", "weapon-large-2"], cost: 8500,
    blurb: "Endgame energy weapon. Sustained 8s beam, very high DPS.",
    applies: () => ({
      heavyLaser: { damage: 480, beamDuration: 8.0, cooldown: 14, range: 2800, arc: Math.PI * 0.55, beamColors: { blue: "#9ff", red: "#f9c" } },
    }),
  },

  // ---- POINT DEFENSE -------------------------------------------------
  "pd-none": {
    id: "pd-none", name: "No PD", category: "pd",
    slots: ["pd-medium", "pd-heavy"], cost: 0, default: true,
    blurb: "No point defense turrets.",
    applies: () => ({ pdCannons: null }),
  },
  "pd-sparse": {
    id: "pd-sparse", name: "PD Sparse (4)", category: "pd",
    slots: ["pd-medium", "pd-heavy"], cost: 600,
    blurb: "4 turrets around hull rim.",
    applies: () => ({ pdCannons: { count: 4, damage: 8, range: 420, cooldown: 0.30, projectileSpeed: 720, projectileRadius: 3, projectileColors: { blue: "#cef", red: "#fc8" } } }),
  },
  "pd-dense": {
    id: "pd-dense", name: "PD Dense (10)", category: "pd",
    slots: ["pd-medium", "pd-heavy"], cost: 1600,
    blurb: "10 turrets. Reliable missile shield.",
    applies: () => ({ pdCannons: { count: 10, damage: 8, range: 500, cooldown: 0.28, projectileSpeed: 760, projectileRadius: 3, projectileColors: { blue: "#cef", red: "#fc8" } } }),
  },
  "pd-wall": {
    id: "pd-wall", name: "PD Wall (16)", category: "pd",
    slots: ["pd-heavy"], cost: 3200,
    blurb: "16 turrets. Capital-grade defense.",
    applies: () => ({ pdCannons: { count: 16, damage: 10, range: 540, cooldown: 0.26, projectileSpeed: 800, projectileRadius: 3, projectileColors: { blue: "#cef", red: "#fc8" } } }),
  },
  "pd-medium-ring": {
    id: "pd-medium-ring", name: "PD Medium Ring (7)", category: "pd",
    slots: ["pd-medium", "pd-heavy"], cost: 1100,
    blurb: "7 turrets, balanced coverage between Sparse and Dense.",
    applies: () => ({ pdCannons: { count: 7, damage: 9, range: 460, cooldown: 0.29, projectileSpeed: 740, projectileRadius: 3, projectileColors: { blue: "#cef", red: "#fc8" } } }),
  },
  "pd-lattice": {
    id: "pd-lattice", name: "PD Lattice (20)", category: "pd",
    slots: ["pd-heavy"], cost: 5000,
    blurb: "20-turret defense lattice. Top-tier missile screen.",
    applies: () => ({ pdCannons: { count: 20, damage: 11, range: 580, cooldown: 0.24, projectileSpeed: 820, projectileRadius: 3, projectileColors: { blue: "#cef", red: "#fc8" } } }),
  },

  // ---- MISSILES ------------------------------------------------------
  "missile-light-launcher": {
    id: "missile-light-launcher", name: "Light Missile", category: "missile",
    slots: ["missile-small"], cost: 0, default: true,
    blurb: "Air-to-air missile. 28 dmg, 1.3× vs strike craft. Bypasses shields.",
    applies: () => ({ /* base fighter missile — bypassShield + antiCraftBonus come from classes.js */ }),
  },
  "missile-heavy-launcher": {
    id: "missile-heavy-launcher", name: "Heavy Missile mk2", category: "missile",
    slots: ["missile-small"], cost: 900,
    blurb: "55 dmg. Bypasses shields.",
    applies: () => ({ missile: { damage: 55, cooldown: 6.0, bypassShield: true, blastRadius: 18 } }),
  },
  "missile-multilock": {
    id: "missile-multilock", name: "Multi-Lock Missile", category: "missile",
    slots: ["missile-small"], cost: 1400,
    blurb: "Twin-launch: two missiles per trigger. Bypasses shields.",
    applies: () => ({ missile: { damage: 35, cooldown: 5.0, muzzles: 2, muzzleSpread: 22,
      bypassShield: true, blastRadius: 12 } }),
  },
  "missile-anti-capital": {
    id: "missile-anti-capital", name: "Anti-Capital Lance", category: "missile",
    slots: ["missile-small"], cost: 2500,
    blurb: "130 dmg. Optimal vs capitals. Bypasses shields.",
    applies: () => ({ missile: { damage: 130, cooldown: 10, projectileSpeed: 280, ttl: 8,
      range: 2200, hp: 4, bypassShield: true, blastRadius: 30 } }),
  },
  "missile-rack-mk1": {
    id: "missile-rack-mk1", name: "Missile Rack (3)", category: "missile",
    slots: ["missile-medium", "missile-medium-2"], cost: 0, default: true,
    blurb: "3 launchers. Bypasses shields.",
    applies: () => ({ missilePods: { count: 3, damage: 70, cooldown: 8.0, projectileSpeed: 360,
      range: 1800, ttl: 6, hp: 3, radius: 5, turnRate: 1.6, bypassShield: true, blastRadius: 20 } }),
  },
  "missile-rack-mk2": {
    id: "missile-rack-mk2", name: "Missile Rack (5)", category: "missile",
    slots: ["missile-medium", "missile-medium-2"], cost: 1400,
    blurb: "5 launchers, higher damage. Bypasses shields.",
    applies: () => ({ missilePods: { count: 5, damage: 90, cooldown: 7.0, projectileSpeed: 400,
      range: 2000, ttl: 6, hp: 3, radius: 5, turnRate: 1.6, bypassShield: true, blastRadius: 22 } }),
  },
  "missile-cluster-pod": {
    id: "missile-cluster-pod", name: "Cluster Pod", category: "missile",
    slots: ["missile-medium", "missile-medium-2"], cost: 2800,
    blurb: "Parent splits into 6 warheads near target. Bypasses shields.",
    applies: () => ({ missilePods: { count: 2, damage: 60, cooldown: 10, projectileSpeed: 340,
      range: 2200, ttl: 8, hp: 4, radius: 5, turnRate: 1.4, bypassShield: true, blastRadius: 18,
      cluster: { childCount: 6, childDamage: 24, childSpread: Math.PI * 160 / 180,
        bloomDistance: 600, childBlastRadius: 6 } } }),
  },
  "missile-long-range": {
    id: "missile-long-range", name: "Long-Range Bay", category: "missile",
    slots: ["missile-medium", "missile-medium-2"], cost: 2200,
    blurb: "Fewer launchers, doubled range. Bypasses shields.",
    applies: () => ({ missilePods: { count: 2, damage: 100, cooldown: 9, projectileSpeed: 380,
      range: 3200, ttl: 10, hp: 4, radius: 5, turnRate: 1.4, bypassShield: true, blastRadius: 25 } }),
  },
  "missile-hailstorm": {
    id: "missile-hailstorm", name: "Hailstorm Bay", category: "missile",
    slots: ["missile-medium", "missile-medium-2"], cost: 3500,
    blurb: "Eight fast missiles. Overwhelms PD. Bypasses shields.",
    applies: () => ({ missilePods: { count: 8, damage: 35, cooldown: 5, projectileSpeed: 480,
      range: 1800, ttl: 5, hp: 2, radius: 4, turnRate: 1.8, bypassShield: true, blastRadius: 12 } }),
  },
  "missile-singularity-bomb": {
    id: "missile-singularity-bomb", name: "Singularity Bomb", category: "missile",
    slots: ["missile-medium", "missile-medium-2"], cost: 5500,
    blurb: "One slow capital-killer. 380 dmg. Bypasses shields, massive blast.",
    applies: () => ({ missilePods: { count: 1, damage: 380, cooldown: 22, projectileSpeed: 240,
      range: 2600, ttl: 14, hp: 12, radius: 9, turnRate: 0.5, bypassShield: true, blastRadius: 55 } }),
  },

  // ---- SHIELDS -------------------------------------------------------
  "shield-light": {
    id: "shield-light", name: "Light Shield", category: "shield",
    slots: ["shield-small"], cost: 0, default: true,
    blurb: "40 max, fast regen.",
    applies: () => ({ /* base fighter shield */ }),
  },
  "shield-light-mk2": {
    id: "shield-light-mk2", name: "Light Shield mk2", category: "shield",
    slots: ["shield-small"], cost: 700,
    blurb: "60 max, faster regen.",
    applies: () => ({ shield: { max: 60, regen: 14, regenDelay: 2.2 } }),
  },
  "shield-light-mk3": {
    id: "shield-light-mk3", name: "Light Shield mk3", category: "shield",
    slots: ["shield-small"], cost: 1500,
    blurb: "85 max, rapid regen.",
    applies: () => ({ shield: { max: 85, regen: 18, regenDelay: 2.0 } }),
  },
  "shield-phase": {
    id: "shield-phase", name: "Phase Shield", category: "shield",
    slots: ["shield-small"], cost: 2200,
    blurb: "Faster regen recovery. Best for hit-and-run pilots.",
    applies: () => ({ shield: { max: 90, regen: 24, regenDelay: 1.4 } }),
  },
  "shield-reflective": {
    id: "shield-reflective", name: "Reflective Shield", category: "shield",
    slots: ["shield-small"], cost: 3000,
    blurb: "130 max. Heavy fighter loadout.",
    applies: () => ({ shield: { max: 130, regen: 16, regenDelay: 2.4 } }),
  },
  "shield-medium": {
    id: "shield-medium", name: "Medium Shield", category: "shield",
    slots: ["shield-medium"], cost: 0, default: true,
    blurb: "Capital-grade shield (220 max).",
    applies: () => ({ shield: { max: 220, regen: 18, regenDelay: 3 } }),
  },
  "shield-medium-mk2": {
    id: "shield-medium-mk2", name: "Medium Shield mk2", category: "shield",
    slots: ["shield-medium"], cost: 1800,
    blurb: "320 max, +30% regen.",
    applies: () => ({ shield: { max: 320, regen: 24, regenDelay: 2.8 } }),
  },
  "shield-adaptive": {
    id: "shield-adaptive", name: "Adaptive Shield", category: "shield",
    slots: ["shield-medium"], cost: 2500,
    blurb: "Faster regen recovery for sustained engagements.",
    applies: () => ({ shield: { max: 380, regen: 32, regenDelay: 2.0 } }),
  },
  "shield-hardened": {
    id: "shield-hardened", name: "Hardened Shield", category: "shield",
    slots: ["shield-medium"], cost: 3200,
    blurb: "Massive cap, slow regen. Best for brawler builds.",
    applies: () => ({ shield: { max: 560, regen: 18, regenDelay: 3.6 } }),
  },
  "shield-layered": {
    id: "shield-layered", name: "Layered Shield", category: "shield",
    slots: ["shield-medium"], cost: 4500,
    blurb: "640 max, balanced regen profile.",
    applies: () => ({ shield: { max: 640, regen: 30, regenDelay: 2.6 } }),
  },
  "shield-heavy": {
    id: "shield-heavy", name: "Heavy Shield", category: "shield",
    slots: ["shield-heavy"], cost: 3500,
    blurb: "Battleship-grade. 700 max.",
    applies: () => ({ shield: { max: 700, regen: 28, regenDelay: 3.2 } }),
  },
  "shield-aegis": {
    id: "shield-aegis", name: "Aegis Capital Shield", category: "shield",
    slots: ["shield-heavy"], cost: 6500,
    blurb: "1100 max, ultra regen.",
    applies: () => ({ shield: { max: 1100, regen: 38, regenDelay: 2.8 } }),
  },
  "shield-fortified": {
    id: "shield-fortified", name: "Fortified Capital", category: "shield",
    slots: ["shield-heavy"], cost: 9000,
    blurb: "1600 max. Built to absorb battleline punishment.",
    applies: () => ({ shield: { max: 1600, regen: 44, regenDelay: 3.0 } }),
  },
  "shield-void-barrier": {
    id: "shield-void-barrier", name: "Void Barrier", category: "shield",
    slots: ["shield-heavy"], cost: 12000,
    blurb: "Endgame. 2200 max with elite regen.",
    applies: () => ({ shield: { max: 2200, regen: 56, regenDelay: 2.5 } }),
  },

  // ---- ARMOR ---------------------------------------------------------
  "armor-none": {
    id: "armor-none", name: "No Armor", category: "armor",
    slots: ["armor-medium", "armor-heavy"], cost: 0, default: true,
    blurb: "No additional armor plating.",
    applies: () => ({ armor: null }),
  },
  "armor-light": {
    id: "armor-light", name: "Light Armor", category: "armor",
    slots: ["armor-medium"], cost: 1200,
    blurb: "120 plating, slow wear.",
    applies: () => ({ armor: { max: 120, wearRate: 0.55 } }),
  },
  "armor-medium": {
    id: "armor-medium", name: "Medium Armor", category: "armor",
    slots: ["armor-medium", "armor-heavy"], cost: 2400,
    blurb: "240 plating.",
    applies: () => ({ armor: { max: 240, wearRate: 0.5 } }),
  },
  "armor-heavy": {
    id: "armor-heavy", name: "Heavy Armor", category: "armor",
    slots: ["armor-heavy"], cost: 4000,
    blurb: "450 plating, durable.",
    applies: () => ({ armor: { max: 450, wearRate: 0.42 } }),
  },
  "armor-reactive": {
    id: "armor-reactive", name: "Reactive Plating", category: "armor",
    slots: ["armor-heavy"], cost: 6800,
    blurb: "700 plating, minimal wear.",
    applies: () => ({ armor: { max: 700, wearRate: 0.3 } }),
  },
  "armor-composite": {
    id: "armor-composite", name: "Composite Armor", category: "armor",
    slots: ["armor-medium", "armor-heavy"], cost: 3200,
    blurb: "Mid-tier 340 plating. Sits between Medium and Heavy.",
    applies: () => ({ armor: { max: 340, wearRate: 0.45 } }),
  },
  "armor-ablative": {
    id: "armor-ablative", name: "Ablative Plating", category: "armor",
    slots: ["armor-heavy"], cost: 9500,
    blurb: "Endgame. 1000 plating, ultra-slow wear.",
    applies: () => ({ armor: { max: 1000, wearRate: 0.25 } }),
  },

  // ---- ENGINES -------------------------------------------------------
  "engine-standard": {
    id: "engine-standard", name: "Standard Engine", category: "engine",
    slots: ["engine-small", "engine-medium", "engine-medium-2"], cost: 0, default: true,
    blurb: "Baseline propulsion.",
    applies: () => ({ /* base engine */ }),
  },
  "engine-sprint": {
    id: "engine-sprint", name: "Sprint Engine", category: "engine",
    slots: ["engine-small", "engine-medium", "engine-medium-2"], cost: 800,
    blurb: "+30% top speed, lower turn rate.",
    applies: (klass, baseSpec) => ({
      maxSpeed: Math.round((baseSpec.maxSpeed || 400) * 1.3),
      accel: Math.round((baseSpec.accel || 700) * 1.25),
      turnRate: (baseSpec.turnRate || 3.2) * 0.9,
    }),
  },
  "engine-heavy": {
    id: "engine-heavy", name: "Heavy Engine", category: "engine",
    slots: ["engine-small", "engine-medium", "engine-medium-2"], cost: 1200,
    blurb: "Slower but +30% hull.",
    applies: (klass, baseSpec) => ({
      maxSpeed: Math.round((baseSpec.maxSpeed || 400) * 0.8),
      hp: Math.round((baseSpec.hp || 35) * 1.3),
    }),
  },
  "engine-precision": {
    id: "engine-precision", name: "Precision Drive", category: "engine",
    slots: ["engine-small", "engine-medium", "engine-medium-2"], cost: 1600,
    blurb: "+30% turn rate. Tighter handling.",
    applies: (klass, baseSpec) => ({
      turnRate: (baseSpec.turnRate || 3.2) * 1.3,
    }),
  },
  "engine-overdrive": {
    id: "engine-overdrive", name: "Overdrive Engine", category: "engine",
    slots: ["engine-small", "engine-medium", "engine-medium-2"], cost: 2400,
    blurb: "+20% speed AND +20% turn. Best of both worlds.",
    applies: (klass, baseSpec) => ({
      maxSpeed: Math.round((baseSpec.maxSpeed || 400) * 1.2),
      turnRate: (baseSpec.turnRate || 3.2) * 1.2,
      accel:    Math.round((baseSpec.accel || 700) * 1.15),
    }),
  },
  "engine-titan-drive": {
    id: "engine-titan-drive", name: "Titan Drive", category: "engine",
    slots: ["engine-small", "engine-medium", "engine-medium-2"], cost: 3200,
    blurb: "Endgame. +20% hull and +10% all-around handling.",
    applies: (klass, baseSpec) => ({
      maxSpeed: Math.round((baseSpec.maxSpeed || 400) * 1.10),
      accel:    Math.round((baseSpec.accel || 700) * 1.10),
      turnRate: (baseSpec.turnRate || 3.2) * 1.10,
      hp:       Math.round((baseSpec.hp || 35) * 1.20),
    }),
  },

  // ---- HANGAR (carrier-only) -----------------------------------------
  "hangar-standard": {
    id: "hangar-standard", name: "Standard Hangar", category: "hangar",
    slots: ["hangar"], cost: 0, default: true,
    blurb: "Launches fighters every 12s, bombers every 24s.",
    applies: () => ({ replenish: { fighter: 12, bomber: 24 } }),
  },
  "hangar-rapid": {
    id: "hangar-rapid", name: "Rapid Launch Bay", category: "hangar",
    slots: ["hangar"], cost: 4500,
    blurb: "Fighters every 6s, bombers every 12s.",
    applies: () => ({ replenish: { fighter: 6, bomber: 12 } }),
  },
  "hangar-strike-bay": {
    id: "hangar-strike-bay", name: "Strike Bay", category: "hangar",
    slots: ["hangar"], cost: 6500,
    blurb: "Fighters every 10s, bombers every 8s. Bomber-focused.",
    applies: () => ({ replenish: { fighter: 10, bomber: 8 } }),
  },
  "hangar-elite-squadron": {
    id: "hangar-elite-squadron", name: "Elite Squadron Bay", category: "hangar",
    slots: ["hangar"], cost: 8000,
    blurb: "Fighters every 4s, bombers every 9s. Maximum sortie rate.",
    applies: () => ({ replenish: { fighter: 4, bomber: 9 } }),
  },
};

// Components every player owns from the start. These are also the
// fallback components if a save somehow references an unknown id.
export const DEFAULT_OWNED_COMPONENTS = Object.keys(COMPONENTS).filter(
  (id) => COMPONENTS[id].default,
);

// Maps a slot id to the canonical default component for it. Used when
// the design references a slot but doesn't supply a value, or supplies
// an unknown one — we slot the default in.
function defaultForSlot(slotId) {
  for (const id of DEFAULT_OWNED_COMPONENTS) {
    const comp = COMPONENTS[id];
    if (comp.slots.includes(slotId)) return id;
  }
  return null;
}

/**
 * The persistent player-ship design that the Shipyard mutates and
 * Frontier deploys. Stays in `save.meta.playerShip`. Default is
 * deliberately the stock Terran fighter — every save before this
 * feature shipped boots with this exact design and gets identical
 * spec output.
 */
export const DEFAULT_PLAYER_DESIGN = Object.freeze({
  hull: "fighter",
  modules: {
    "weapon-small":  "weapon-light-cannon",
    "missile-small": "missile-light-launcher",
    "shield-small":  "shield-light",
    "engine-small":  "engine-standard",
  },
  name: "ISS Spectre",
  paintPrimary: null,   // null => use side's standard primary
  paintTrim: null,
});

/**
 * Resolve a design into a list of components, slot-by-slot. Unknown ids
 * fall back to the default for that slot. Returns the component objects
 * (not just ids) so callers can read costs / blurbs.
 */
export function resolveDesignComponents(design) {
  const hull = HULLS[design.hull] || HULLS.fighter;
  const out = [];
  for (const slot of hull.slots) {
    const requestedId = design.modules && design.modules[slot];
    // Unknown component ids fall back to the slot's default so a save
    // referencing a since-removed component doesn't lose its weapon.
    let id = requestedId && COMPONENTS[requestedId] ? requestedId : defaultForSlot(slot);
    const comp = id ? COMPONENTS[id] : null;
    if (comp) out.push({ slot, comp });
  }
  return out;
}

/**
 * Apply a design's components to a resolved spec. Returns a new spec
 * with each component's applies(klass, spec) patch deep-merged in.
 *
 * Important: components patch *additively*. If you want to *remove* a
 * subsystem (e.g. armor: null), the component returns `{ armor: null }`
 * which the post-merge step strips out so resolveSpec's default doesn't
 * keep it.
 */
export function applyDesign(spec, design) {
  if (!design) return spec;
  const hull = HULLS[design.hull];
  if (!hull) return spec;
  let out = spec;
  // Separate missile-medium* slot components from the normal patch
  // pass so we can aggregate them into an array of groups. Without
  // this, two missile slots equipped with different components would
  // have the second slot's `missilePods` patch silently overwrite the
  // first via deepMerge. The fighter `missile-small` slot is unique
  // (single launcher → spec.missile), so it stays on the normal path.
  const missilePodSlotIds = hull.slots.filter((s) => s.startsWith("missile-medium"));
  // Capture heavyLaser-writing AND weapon-writing weapon patches so
  // we can aggregate each into an array. Without this, two weapon-large
  // slots both equipping a beam weapon (Heavy Laser + Particle Cannon)
  // or two forward weapons (Bow Cannon + Mass Driver) would have the
  // second silently overwrite the first via deepMerge.
  const weaponSlotIds = hull.slots.filter((s) => s.startsWith("weapon-large"));
  const laserGroups = [];
  const weaponGroups = [];
  let weaponFiringMode = null;
  for (const { slot, comp } of resolveDesignComponents(design)) {
    if (missilePodSlotIds.includes(slot)) continue;
    if (!comp || !comp.applies) continue;
    const patch = comp.applies(hull.klass, out);
    if (!patch) continue;
    if (weaponSlotIds.includes(slot)) {
      // Side-channel: collect heavyLaser/weapon/missilePods patches
      // from weapon-large slots into arrays. Strip them from the
      // generic patch so deepMerge doesn't collapse them.
      const carve = { ...patch };
      if (carve.heavyLaser) {
        laserGroups.push(carve.heavyLaser);
        delete carve.heavyLaser;
      }
      if (carve.weapon) {
        // Each weapon spec carries its OWN firingMode so multi-mount
        // designs can mix forward + broadside per-weapon. The hull's
        // overall stance (spec.firingMode at the root) comes from the
        // first weapon — that's what the AI uses to pose the ship.
        const wFireMode = carve.firingMode || "forward";
        weaponGroups.push({ ...carve.weapon, firingMode: wFireMode });
        if (weaponFiringMode === null) weaponFiringMode = wFireMode;
        delete carve.weapon;
        delete carve.firingMode;
      }
      if (Object.keys(carve).length > 0) out = deepMerge(out, carve);
      continue;
    }
    out = deepMerge(out, patch);
  }
  // Stamp the laser array onto the spec. Single group → scalar
  // (backwards compat with race-default battleships); multiple →
  // array. createShip's flattener handles both shapes.
  if (laserGroups.length === 1) out = { ...out, heavyLaser: laserGroups[0] };
  else if (laserGroups.length > 1) out = { ...out, heavyLaser: laserGroups };
  // Weapons: keep `spec.weapon` as the SINGLE primary so all the
  // external readers (ai.js, hud.js, game.js, roguelite.js) that
  // expect `spec.weapon.damage / .capacity / .range` keep working
  // unchanged. Additional weapons live on `spec.weaponExtras` (array);
  // createShip combines [spec.weapon, ...spec.weaponExtras] into
  // ship.weapons[]. firingMode stamped from the first weapon.
  if (weaponGroups.length === 1) {
    out = { ...out, weapon: weaponGroups[0] };
    if (weaponFiringMode) out.firingMode = weaponFiringMode;
  } else if (weaponGroups.length > 1) {
    out = { ...out, weapon: weaponGroups[0], weaponExtras: weaponGroups.slice(1) };
    if (weaponFiringMode) out.firingMode = weaponFiringMode;
  }
  // Now aggregate missile-medium* slots. Each slot's component
  // applies() returns { missilePods: { count, damage, ... } }. Collect
  // them into an array. If only one slot, store as single (preserves
  // backwards compat with all existing code that does
  // `spec.missilePods.count`). If multiple, store as array.
  if (missilePodSlotIds.length > 0) {
    const groups = [];
    for (const slotId of missilePodSlotIds) {
      const requestedId = design.modules && design.modules[slotId];
      const id = requestedId && COMPONENTS[requestedId] ? requestedId : (() => {
        for (const defId of DEFAULT_OWNED_COMPONENTS) {
          if (COMPONENTS[defId].slots.includes(slotId)) return defId;
        }
        return null;
      })();
      const comp = id ? COMPONENTS[id] : null;
      if (!comp || !comp.applies) continue;
      const patch = comp.applies(hull.klass, out);
      if (patch && patch.missilePods) groups.push(patch.missilePods);
    }
    if (groups.length === 1) out = { ...out, missilePods: groups[0] };
    else if (groups.length > 1) out = { ...out, missilePods: groups };
    // else: 0 groups → leave whatever the base spec had (probably none)
  }
  // null-strip pass: a component setting `pdCannons: null` or `armor: null`
  // expresses "remove this subsystem". deepMerge would leave the null in
  // place; createShip's downstream code reads spec.pdCannons as truthy.
  // Strip explicit nulls so the absence is honored.
  if (out.pdCannons === null) delete out.pdCannons;
  if (out.armor === null) delete out.armor;
  return out;
}

/**
 * Normalize spec.missilePods to a flat per-pod spec array. The single
 * form `{ count: N, ... }` expands to N copies of the same group.
 * The array form `[{count, ...}, {count, ...}]` expands each group's
 * count copies in order. Used by createShip + updateMissilePodFire so
 * the rest of the engine doesn't need to know whether it's looking
 * at a single-type or multi-type missile loadout.
 */
export function flattenMissilePods(missilePodsSpec) {
  if (!missilePodsSpec) return null;
  const groups = Array.isArray(missilePodsSpec) ? missilePodsSpec : [missilePodsSpec];
  const flat = [];
  for (const g of groups) {
    if (!g || !g.count || g.count <= 0) continue;
    for (let i = 0; i < g.count; i++) flat.push(g);
  }
  return flat.length > 0 ? flat : null;
}

/**
 * Sum or max-pick a field across all missile pod groups. Used by AI
 * danger zones (uses max range) and any future stat surfaces.
 */
export function missilePodsMaxRange(missilePodsSpec) {
  if (!missilePodsSpec) return 0;
  const groups = Array.isArray(missilePodsSpec) ? missilePodsSpec : [missilePodsSpec];
  let r = 0;
  for (const g of groups) if (g && g.range > r) r = g.range;
  return r;
}

/**
 * Normalize spec.heavyLaser to an array. Single-spec ships (legacy
 * race-default battleships) get wrapped in a 1-element array. Multi-
 * laser designs (BB with 2× Particle Cannon equipped) stay as-is.
 * Returns null if no lasers configured.
 */
export function flattenHeavyLasers(heavyLaserSpec) {
  if (!heavyLaserSpec) return null;
  const arr = Array.isArray(heavyLaserSpec) ? heavyLaserSpec : [heavyLaserSpec];
  const out = arr.filter((l) => l && typeof l.damage === "number" && l.damage > 0);
  return out.length > 0 ? out : null;
}

/**
 * Normalize spec.weapon to an array of weapon specs. Single-weapon
 * ships (every legacy hull) get wrapped in a 1-element array; multi-
 * weapon designs (BB with 2× Bow Cannon equipped) stay as-is. Returns
 * null if no primary weapon configured.
 */
export function flattenWeapons(weaponSpec) {
  if (!weaponSpec) return null;
  const arr = Array.isArray(weaponSpec) ? weaponSpec : [weaponSpec];
  const out = arr.filter((w) => w && typeof w.damage === "number" && w.damage > 0);
  return out.length > 0 ? out : null;
}

/**
 * What klass should createShip use when spawning a ship from this design?
 * Lets Frontier promote the player from "fighter" to "battleship" cleanly
 * — the design dictates klass, not the race default.
 */
export function klassForDesign(design) {
  const hull = HULLS[(design && design.hull) || "fighter"];
  return hull.klass;
}

/**
 * List components owned by default + any unlock list. Use this when
 * rendering the store so a save with no `ownedComponents` field (older
 * saves) still shows the starter library as owned.
 */
export function effectiveOwnedComponents(ownedList) {
  const set = new Set(DEFAULT_OWNED_COMPONENTS);
  if (Array.isArray(ownedList)) for (const id of ownedList) set.add(id);
  return set;
}

export function effectiveOwnedHulls(ownedList) {
  const set = new Set(["fighter"]);
  if (Array.isArray(ownedList)) for (const h of ownedList) set.add(h);
  return set;
}

// ---- DELTA COMPARISON ----------------------------------------------
//
// Each comparable field declares its label, value extractor, formatter,
// and which direction is "better" so the renderer can color appropriately.
// `format`'s return is the delta string (e.g. "+30", "-0.05s"); `betterIf`
// returns true if the candidate value is better than the current.
const DELTA_FIELDS = [
  // Hull stats
  { key: "hp",       label: "hull",   pick: (s) => s.hp,                  fmt: (d) => fmtNum(d, ""),     better: "higher" },
  { key: "speed",    label: "speed",  pick: (s) => s.maxSpeed,            fmt: (d) => fmtNum(d, ""),     better: "higher" },
  { key: "turn",     label: "turn",   pick: (s) => round1(s.turnRate),    fmt: (d) => fmtNum(d, "/s"),   better: "higher" },
  // Weapon (primary forward / broadside / salvo)
  { key: "wdmg",     label: "dmg",    pick: (s) => s.weapon?.damage,      fmt: (d) => fmtNum(d, ""),     better: "higher" },
  { key: "wcd",      label: "cycle",  pick: (s) => s.weapon?.cooldown,    fmt: (d) => fmtNum(d, "s", 2), better: "lower"  },
  { key: "wrange",   label: "range",  pick: (s) => s.weapon?.range,       fmt: (d) => fmtNum(d, ""),     better: "higher" },
  // Ring cannons (frigate weapons)
  { key: "rcnt",     label: "mounts", pick: (s) => s.ringCannons?.count,  fmt: (d) => fmtNum(d, ""),     better: "higher" },
  { key: "rdmg",     label: "dmg",    pick: (s) => s.ringCannons?.damage, fmt: (d) => fmtNum(d, ""),     better: "higher" },
  { key: "rcd",      label: "cycle",  pick: (s) => s.ringCannons?.cooldown, fmt: (d) => fmtNum(d, "s", 2), better: "lower" },
  // Heavy laser. Array-aware: sum damage across all beam mounts
  // (total firepower per cycle), max beam duration (longest sustained
  // beam — typically the player's main weapon timing reference).
  { key: "ldmg",     label: "beam dmg", pick: (s) => sumPodField(s.heavyLaser, "damage"), fmt: (d) => fmtNum(d, ""), better: "higher" },
  { key: "ldur",     label: "beam dur", pick: (s) => maxPodField(s.heavyLaser, "beamDuration"), fmt: (d) => fmtNum(d, "s", 1), better: "higher" },
  // Shield
  { key: "smax",     label: "shield",   pick: (s) => s.shield?.max,        fmt: (d) => fmtNum(d, ""), better: "higher" },
  { key: "sregen",   label: "regen",    pick: (s) => s.shield?.regen,      fmt: (d) => fmtNum(d, "/s"), better: "higher" },
  { key: "sdelay",   label: "regen-delay", pick: (s) => s.shield?.regenDelay, fmt: (d) => fmtNum(d, "s", 1), better: "lower" },
  // Armor
  { key: "amax",     label: "armor",    pick: (s) => s.armor?.max,         fmt: (d) => fmtNum(d, ""), better: "higher" },
  { key: "awear",    label: "wear",     pick: (s) => s.armor?.wearRate,    fmt: (d) => fmtNum(d, "", 2), better: "lower" },
  // PD ring
  { key: "pdcnt",    label: "PD turrets", pick: (s) => s.pdCannons?.count, fmt: (d) => fmtNum(d, ""), better: "higher" },
  { key: "pdrange",  label: "PD range", pick: (s) => s.pdCannons?.range,   fmt: (d) => fmtNum(d, ""), better: "higher" },
  // Missile pods. Array-aware: when missilePods is multi-group, count
  // sums; damage/cooldown/range take the value of the first group (the
  // delta picker is per-slot, so the first group is the one that
  // actually changed in this swap).
  { key: "mpcnt",    label: "pods",     pick: (s) => sumPodField(s.missilePods, "count"),    fmt: (d) => fmtNum(d, ""), better: "higher" },
  { key: "mpdmg",    label: "pod dmg",  pick: (s) => firstPodField(s.missilePods, "damage"), fmt: (d) => fmtNum(d, ""), better: "higher" },
  { key: "mpcd",     label: "pod cycle", pick: (s) => firstPodField(s.missilePods, "cooldown"), fmt: (d) => fmtNum(d, "s", 1), better: "lower" },
  { key: "mprange",  label: "pod range", pick: (s) => maxPodField(s.missilePods, "range"),  fmt: (d) => fmtNum(d, ""), better: "higher" },
  // Single fighter missile
  { key: "mdmg",     label: "missile",  pick: (s) => s.missile?.damage,    fmt: (d) => fmtNum(d, ""), better: "higher" },
  { key: "mcd",      label: "missile cycle", pick: (s) => s.missile?.cooldown, fmt: (d) => fmtNum(d, "s", 1), better: "lower" },
  // Carrier replenishment (lower = faster sortie rate, so "lower is better")
  { key: "repf",     label: "fighter launch", pick: (s) => s.replenish?.fighter, fmt: (d) => fmtNum(d, "s", 1), better: "lower" },
  { key: "repb",     label: "bomber launch",  pick: (s) => s.replenish?.bomber,  fmt: (d) => fmtNum(d, "s", 1), better: "lower" },
];

function round1(x) { return typeof x === "number" ? Math.round(x * 100) / 100 : x; }

// Helpers for array-aware missile pod field reads. The spec.missilePods
// may be a single group `{count, damage, ...}` (legacy + most ships)
// or an array of groups `[{...}, {...}]` (capital multi-slot designs).
function sumPodField(mp, field) {
  if (!mp) return null;
  if (Array.isArray(mp)) {
    let s = 0;
    for (const g of mp) if (g && typeof g[field] === "number") s += g[field];
    return s > 0 ? s : null;
  }
  return typeof mp[field] === "number" ? mp[field] : null;
}
function firstPodField(mp, field) {
  if (!mp) return null;
  if (Array.isArray(mp)) {
    for (const g of mp) if (g && typeof g[field] === "number") return g[field];
    return null;
  }
  return typeof mp[field] === "number" ? mp[field] : null;
}
function maxPodField(mp, field) {
  if (!mp) return null;
  if (Array.isArray(mp)) {
    let m = -Infinity;
    for (const g of mp) if (g && typeof g[field] === "number" && g[field] > m) m = g[field];
    return m > -Infinity ? m : null;
  }
  return typeof mp[field] === "number" ? mp[field] : null;
}

function fmtNum(delta, unit, decimals = 0) {
  if (typeof delta !== "number" || delta === 0) return null;
  const abs = Math.abs(delta);
  const fixed = abs >= 1 || decimals === 0 ? abs.toFixed(decimals) : abs.toFixed(decimals);
  const sign = delta > 0 ? "+" : "-";
  return `${sign}${fixed}${unit}`;
}

/**
 * Compute per-field deltas between the current design and one where
 * `slotId`'s component is swapped to `candidateId`. Returns an array
 * of `{ label, text, direction }` where:
 *   - label: field name ("shield", "speed", ...)
 *   - text: formatted delta ("+30", "-0.05s")
 *   - direction: "better" | "worse" — for tint
 * Returns empty array if the swap produces no meaningful change.
 */
export function computeDeltas(baseSpec, currentDesign, slotId, candidateId) {
  if (!baseSpec || !currentDesign || !slotId || !candidateId) return [];
  // No-op if user is hovering the currently-equipped option.
  if (currentDesign.modules && currentDesign.modules[slotId] === candidateId) return [];

  const currentSpec = applyDesign(baseSpec, currentDesign);
  const altDesign = {
    ...currentDesign,
    modules: { ...currentDesign.modules, [slotId]: candidateId },
  };
  const altSpec = applyDesign(baseSpec, altDesign);

  const out = [];
  for (const field of DELTA_FIELDS) {
    const before = field.pick(currentSpec);
    const after  = field.pick(altSpec);
    // Treat null/undefined as 0 ONLY when the OTHER side has a value
    // (e.g. swapping "No Armor" → "Heavy Armor" means before=undef,
    // after=450 — delta is +450, not "no change").
    const a = (typeof before === "number") ? before : (typeof after === "number" ? 0 : null);
    const b = (typeof after  === "number") ? after  : (typeof before === "number" ? 0 : null);
    if (a === null || b === null) continue;
    const delta = b - a;
    if (delta === 0) continue;
    const text = field.fmt(delta);
    if (!text) continue;
    const direction =
      (field.better === "higher" && delta > 0) || (field.better === "lower" && delta < 0)
        ? "better" : "worse";
    out.push({ label: field.label, text, direction });
  }
  return out;
}
