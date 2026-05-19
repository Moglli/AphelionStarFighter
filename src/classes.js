// Ship class stats. Each class has a defined role:
//   fighter    — interceptor: fastest, fragile, light damage, fast shots
//   bomber     — strike bomber: slow capital killer with heavy missile pods.
//                Fighters prioritise hunting them down before anything else.
//   frigate    — anti-fighter escort: rapid forward gun + heavy PD wall
//   cruiser    — strike cruiser: heavy guns + heavy torpedoes from standoff
//   battleship — dreadnought: slowest, massive HP, broadside barrage, heavy
//                laser, missile pods, point-defence wall
//   carrier    — fleet carrier: huge non-combatant capital. Defends only
//                with PD; slowly launches replacement fighters and bombers,
//                arrives with a fighter escort squadron.
//   station    — defence platform: immobile multi-node structure. Spawned
//                in groups; each node is a separate destruction target.
//                Used in Defend Station mode.
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
  bomber: {
    name: "Bomber",
    role: "Strike Bomber",
    hp: 75,
    maxSpeed: 220,        // slower than any fighter; fighters easily intercept
    accel: 350,
    drag: 0.985,
    turnRate: 1.6,        // sluggish vs fighter's 3.2 — they can't dogfight
    radius: 16,           // visibly bigger silhouette than a fighter
    color: "#cdf",
    firingMode: "forward",
    // Light defensive cannon — bombers don't dogfight, they alpha-strike.
    weapon: {
      damage: 3,
      cooldown: 0.28,
      projectileSpeed: 580,
      range: 600,
      spread: 0.06,
      muzzles: 2,
      muzzleSpread: 12,
      projectileRadius: 3.5,
      projectileColors: { blue: "#7df", red: "#fb8" },
      capacity: 24,
      reloadTime: 1.2,
    },
    shield: { max: 35, regen: 6, regenDelay: 3.5 },
    // No armor — bombers are still light craft.
    // Heavy missile pods are the bomber's reason to exist. Each pod is
    // tougher than a frigate's missile (more hp) so it survives some PD.
    missilePods: {
      count: 2,
      damage: 70,
      cooldown: 11.0,
      projectileSpeed: 290,
      range: 1700,
      ttl: 7.0,
      turnRate: 1.7,
      hp: 3,
      radius: 7,
      acquireRange: 2000,
      colors: { blue: "#9cf", red: "#fa6" },
    },
    aiRange: 1400,
    aiOrbit: 800,
  },
  frigate: {
    name: "Frigate",
    role: "Escort Destroyer",
    hp: 140,
    maxSpeed: 150,
    accel: 220,
    drag: 0.99,
    turnRate: 1.0,
    radius: 54,
    color: "#bdf",
    firingMode: "forward",
    // Triple-muzzle rapid forward battery: built for chewing through
    // fighter packs at close-to-medium range.
    weapon: {
      damage: 6,
      cooldown: 0.22,
      projectileSpeed: 720,
      range: 850,
      spread: 0.04,
      muzzles: 3,
      muzzleSpread: 22,
      projectileRadius: 4.5,
      projectileColors: { blue: "#3af", red: "#f85" },
    },
    shield: { max: 90, regen: 8, regenDelay: 4.0 },
    armor: { max: 100, wearRate: 0.55 },
    // Heavy PD screen — frigates' primary contribution to a fleet is
    // killing inbound missiles and harassing fighters.
    pdCannons: {
      count: 4,
      damage: 6,
      cooldown: 0.26,
      projectileSpeed: 980,
      range: 380,
      projectileRadius: 2.5,
      projectileColors: { blue: "#cef", red: "#fda" },
    },
    // Single light pod gives the frigate a token anti-capital option but
    // it's on a long cooldown — the cannons do the work.
    missilePods: {
      count: 1,
      damage: 36,
      cooldown: 11.0,
      projectileSpeed: 340,
      range: 1300,
      ttl: 5.5,
      turnRate: 2.2,
      hp: 2,
      radius: 5,
      acquireRange: 1600,
      colors: { blue: "#cef", red: "#fc8" },
    },
    aiRange: 620,
    aiOrbit: 380,
  },
  cruiser: {
    name: "Cruiser",
    role: "Strike Cruiser",
    hp: 420,
    maxSpeed: 80,
    accel: 130,
    drag: 0.992,
    turnRate: 0.4,
    radius: 90,
    color: "#aaf",
    firingMode: "forward",
    // Slower-firing pair of heavy forward guns. Hits hard per shot but
    // sustained DPS is below the frigate — the cruiser leans on torps.
    weapon: {
      damage: 28,
      cooldown: 0.80,
      projectileSpeed: 580,
      range: 1050,
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
    // Heavy torpedoes: slow, high damage, lots of hp so PD has to commit
    // multiple rounds to kill one. The cruiser's defining weapon.
    missilePods: {
      count: 2,
      damage: 110,
      cooldown: 11.0,
      projectileSpeed: 220,
      range: 2000,
      ttl: 9.0,
      turnRate: 1.4,
      hp: 5,
      radius: 10,
      acquireRange: 2200,
      colors: { blue: "#3df", red: "#f4a" },
    },
    aiRange: 1050,
    aiOrbit: 880,
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
      // Parent missile is a slow heavy carrier — most of its job is
      // delivering the cluster payload to bloom range. The headline
      // `damage` is the direct-hit damage if it ever connects without
      // splitting; total *cluster* damage = childCount * childDamage.
      damage: 25,
      cooldown: 9.5,
      projectileSpeed: 300,
      range: 2200,
      ttl: 7.5,
      turnRate: 1.8,
      hp: 4,
      radius: 9,
      acquireRange: 2400,
      colors: { blue: "#fff", red: "#fc8" },
      // Cluster bloom: parent missile splits into N small homing
      // warheads once it comes within bloomDistance of its target.
      // Children fan out across childSpread radians from the
      // approach heading so PD has to engage multiple tracks instead
      // of one fat round.
      cluster: {
        bloomDistance: 420,
        childCount: 5,
        childSpread: 0.55,
        childSpeed: 360,
        childTurnRate: 3.2,
        childTtl: 3.0,
        childDamage: 28,
        childRadius: 4,
        childHp: 1,
      },
    },
    heavyLaser: {
      // Sustained beam: damage is spread across beamDuration (dps =
      // damage / beamDuration). The beam re-anchors to the owner's
      // bow each tick so it tracks the firing ship, and dies early
      // if the owner is destroyed or the laser module is shot off
      // mid-fire.
      damage: 240,
      cooldown: 6.0,
      range: 2400,
      // Firing arc from the bow (radians, half-angle).
      arc: Math.PI * 0.55,
      beamDuration: 3.0,
      beamColors: { blue: "#9ef", red: "#fc7" },
    },
    aiRange: 1000,
    aiOrbit: 800,
  },
  carrier: {
    name: "Carrier",
    role: "Fleet Carrier",
    hp: 1100,
    maxSpeed: 45,
    accel: 60,
    drag: 0.994,
    turnRate: 0.18,
    radius: 180,         // largest hull
    color: "#9bf",
    // "none" = no primary weapon. The carrier defends with PD only.
    firingMode: "none",
    shield: { max: 550, regen: 20, regenDelay: 6.0 },
    armor: { max: 600, wearRate: 0.45 },
    pdCannons: {
      count: 8,          // densest PD wall in the fleet
      damage: 7,
      cooldown: 0.22,
      projectileSpeed: 1000,
      range: 480,
      projectileRadius: 3,
      projectileColors: { blue: "#cef", red: "#fda" },
    },
    // Replenishment cadence (seconds per launch). Bomber cycle is double
    // the fighter cycle, so over time the carrier sends 2 fighters for
    // every 1 bomber.
    replenish: {
      fighter: 18.0,
      bomber: 36.0,
    },
    // Escort fighter squadron spawned alongside the carrier at game start.
    escortSize: 6,
    aiRange: 0,
    aiOrbit: 0,
  },
  station: {
    // Base station node — immobile, no built-in weapons. Per-race node
    // specs in races.js layer on the heavy-laser / missile-pod / PD that
    // each node carries.
    name: "Station",
    role: "Defense Platform",
    hp: 600,
    maxSpeed: 0,
    accel: 0,
    drag: 1,
    // Nodes rotate slowly so heavy-laser arcs and missile-pod launch
    // geometry can still track the nearest enemy.
    turnRate: 0.06,
    radius: 70,
    color: "#9bf",
    firingMode: "none",
    shield: { max: 250, regen: 8, regenDelay: 5.0 },
    armor: { max: 300, wearRate: 0.5 },
    aiRange: 0,
    aiOrbit: 0,
  },
};

// Side color palette: each ship tints its class color with side accent.
export const SIDES = {
  blue: { primary: "#5cf", accent: "#28a", name: "Allied" },
  red:  { primary: "#f76", accent: "#a33", name: "Hostile" },
};
