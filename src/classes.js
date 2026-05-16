// Ship class stats. Each class has a defined role:
//   fighter    — interceptor: fastest, fragile, light damage, fast shots
//   frigate    — skirmisher: balanced forward guns
//   cruiser    — heavy gunship: slow, durable, hard forward turret
//   battleship — dreadnought: slowest, massive HP, broadside-only, no aim
// Invariant: bigger ship = slower (lower maxSpeed, accel, turnRate).
export const CLASSES = {
  fighter: {
    name: "Fighter",
    role: "Interceptor",
    hp: 35,
    maxSpeed: 300,
    accel: 700,
    drag: 0.985,
    turnRate: 5.0,
    radius: 10,
    color: "#9cf",
    firingMode: "forward",
    weapon: {
      damage: 4,
      cooldown: 0.18,
      projectileSpeed: 760,
      range: 520,
      spread: 0.05,
      muzzles: 1,
      projectileRadius: 2,
      projectileColor: "#cff",
    },
    aiRange: 380,
    aiOrbit: 220,
  },
  frigate: {
    name: "Frigate",
    role: "Skirmisher",
    hp: 140,
    maxSpeed: 130,
    accel: 220,
    drag: 0.99,
    turnRate: 2.0,
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
      projectileRadius: 2.5,
      projectileColor: "#cef",
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
    turnRate: 1.0,
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
      projectileRadius: 3.5,
      projectileColor: "#bdf",
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
    turnRate: 0.35,
    radius: 156,
    color: "#88f",
    firingMode: "broadside",
    // ±arc (radians) around each side perpendicular within which broadside
    // guns will fire. Small enough that you have to position the ship.
    broadsideArc: Math.PI / 4,
    weapon: {
      damage: 70,
      cooldown: 2.6, // per side; sides fire independently
      projectileSpeed: 240, // slow, heavy shells
      range: 1200,
      spread: 0.04,
      muzzles: 3, // gun ports per side
      muzzleSpread: 70, // spaced along the much longer hull
      projectileRadius: 5,
      projectileColor: "#acf",
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
