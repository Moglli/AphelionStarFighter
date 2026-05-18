// Ship class stats. Each class has a defined role:
//   fighter    — interceptor: fastest, fragile, light damage, fast shots
//   frigate    — skirmisher: balanced forward guns, PD, single missile pod
//   cruiser    — heavy gunship: slow, durable, hard forward turret, PD, missile pods
//   battleship — dreadnought: slowest, massive HP, broadside barrage, heavy laser,
//                missile pods, point defence wall
// Invariant: bigger ship = slower (lower maxSpeed, accel, turnRate).
//
// Subsystems beyond the primary `weapon`:
//   shield      — regenerating energy shield (see ship.js for damage rules).
//                 Bypassed by missiles. Lasers + fighter cannons cost half of
//                 their damage from the shield bank.
//   missile     — single homing missile launcher (fighter). Player-triggered.
//   missilePods — multiple capital-grade launchers, each with its own cooldown.
//   heavyLaser  — instant-hit beam weapon (battleship). Long range, big damage.
//   pdCannons   — point-defence turrets. Auto-target: missiles, then fighters,
//                 then nearest enemy. Many turrets, low individual damage.
export const CLASSES = {
  fighter: {
    name: "Fighter",
    role: "Interceptor",
    hp: 35,
    maxSpeed: 400,
    accel: 700,
    drag: 0.985,
    turnRate: 3.2,
    radius: 10,
    color: "#9cf",
    firingMode: "forward",
    weapon: {
      damage: 4,
      cooldown: 0.18,
      projectileSpeed: 760,
      range: 900,
      spread: 0.05,
      muzzles: 1,
      projectileRadius: 4,
      projectileColors: { blue: "#7df", red: "#fb8" },
      // Magazine: fires up to `capacity` rounds, then reloads over
      // `reloadTime` seconds before the mag refills.
      capacity: 30,
      reloadTime: 0.6,
    },
    shield: { max: 24, regen: 8, regenDelay: 3.0 },
    missile: {
      damage: 28,
      cooldown: 7.0,
      projectileSpeed: 360,
      range: 1500,
      ttl: 5.0,
      turnRate: 2.6,
      hp: 1,
      radius: 4,
      acquireRange: 1800,
    },
    aiRange: 380,
    aiOrbit: 220,
    aiMissileCooldown: 9.0, // AI-side throttling on top of weapon cooldown
  },
  frigate: {
    name: "Frigate",
    role: "Skirmisher",
    hp: 140,
    maxSpeed: 130,
    accel: 220,
    drag: 0.99,
    turnRate: 0.9,
    radius: 54,
    color: "#bdf",
    firingMode: "forward",
    weapon: {
      damage: 9,
      cooldown: 0.36,
      projectileSpeed: 660,
      range: 800,
      spread: 0.03,
      muzzles: 2,
      muzzleSpread: 28,
      projectileRadius: 5,
      projectileColors: { blue: "#3af", red: "#f85" },
    },
    shield: { max: 90, regen: 8, regenDelay: 4.0 },
    // Armor sits between shield and hull. It takes hits at a reduced wear
    // rate (only `wearRate` fraction of incoming damage actually erodes
    // the plating), and it never regenerates.
    armor: { max: 100, wearRate: 0.55 },
    pdCannons: {
      count: 2,
      damage: 6,
      cooldown: 0.28,
      projectileSpeed: 980,
      range: 380,
      projectileRadius: 2.5,
      projectileColors: { blue: "#cef", red: "#fda" },
    },
    missilePods: {
      count: 1,
      damage: 38,
      cooldown: 9.0,
      projectileSpeed: 320,
      range: 1300,
      ttl: 5.5,
      turnRate: 2.2,
      hp: 2,
      radius: 5,
      acquireRange: 1600,
    },
    aiRange: 620,
    aiOrbit: 460,
  },
  cruiser: {
    name: "Cruiser",
    role: "Heavy Gunship",
    hp: 420,
    maxSpeed: 80,
    accel: 130,
    drag: 0.992,
    turnRate: 0.4,
    radius: 90,
    color: "#aaf",
    firingMode: "forward",
    weapon: {
      damage: 24,
      cooldown: 0.60,
      projectileSpeed: 580,
      range: 1000,
      spread: 0.02,
      muzzles: 2,
      muzzleSpread: 55,
      projectileRadius: 7,
      projectileColors: { blue: "#5fc", red: "#fc3" },
    },
    shield: { max: 260, regen: 14, regenDelay: 5.0 },
    armor: { max: 280, wearRate: 0.5 },
    pdCannons: {
      count: 4,
      damage: 6,
      cooldown: 0.25,
      projectileSpeed: 1000,
      range: 420,
      projectileRadius: 2.5,
      projectileColors: { blue: "#cef", red: "#fda" },
    },
    missilePods: {
      count: 2,
      damage: 52,
      cooldown: 8.5,
      projectileSpeed: 320,
      range: 1700,
      ttl: 6.0,
      turnRate: 2.0,
      hp: 2,
      radius: 6,
      acquireRange: 2000,
    },
    aiRange: 860,
    aiOrbit: 700,
  },
  battleship: {
    name: "Battleship",
    role: "Dreadnought",
    hp: 1100,
    maxSpeed: 35,
    accel: 50,
    drag: 0.994,
    turnRate: 0.15,
    radius: 156,
    color: "#88f",
    firingMode: "broadside",
    // ±arc (radians) around each side perpendicular within which broadside
    // barrage guns will fire. Small enough that you have to position the ship.
    broadsideArc: Math.PI / 4,
    weapon: {
      // Barrage cannons: 3 per side, broadside.
      damage: 70,
      cooldown: 2.6, // per side; sides fire independently
      projectileSpeed: 240, // slow, heavy shells
      range: 1200,
      spread: 0.04,
      muzzles: 3, // gun ports per side
      muzzleSpread: 70, // spaced along the much longer hull
      projectileRadius: 10,
      projectileColors: { blue: "#a3f", red: "#f25" },
    },
    shield: { max: 600, regen: 22, regenDelay: 5.5 },
    armor: { max: 650, wearRate: 0.45 },
    pdCannons: {
      count: 6,
      damage: 7,
      cooldown: 0.22,
      projectileSpeed: 1000,
      range: 460,
      projectileRadius: 3,
      projectileColors: { blue: "#cef", red: "#fda" },
    },
    missilePods: {
      count: 4,
      damage: 65,
      cooldown: 8.0,
      projectileSpeed: 300,
      range: 2200,
      ttl: 7.5,
      turnRate: 1.9,
      hp: 3,
      radius: 7,
      acquireRange: 2400,
    },
    heavyLaser: {
      damage: 180,
      cooldown: 5.0,
      range: 2400,
      // Firing arc from the bow (radians, half-angle).
      arc: Math.PI * 0.55,
      beamDuration: 0.45,
      beamColors: { blue: "#9ef", red: "#fc7" },
    },
    aiRange: 1000,
    aiOrbit: 800,
  },
};

// Side color palette: each ship tints its class color with side accent.
export const SIDES = {
  blue: { primary: "#5cf", accent: "#28a", name: "Allied" },
  red:  { primary: "#f76", accent: "#a33", name: "Hostile" },
};
