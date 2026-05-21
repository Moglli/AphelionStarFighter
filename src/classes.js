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
    shield: { max: 40, regen: 11, regenDelay: 2.5 },
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
    shield: { max: 220, regen: 24, regenDelay: 2.2 },
    // No armor — bombers are still light craft.
    // Heavy missile pods are the bomber's reason to exist. Each pod is
    // tougher than a frigate's missile (more hp) so it survives some PD.
    // Five pods, faster propellant, better tracking — bombers were
    // getting overrun before they could deliver a meaningful strike.
    missilePods: {
      count: 5,
      damage: 70,
      cooldown: 7.5,
      projectileSpeed: 420,
      range: 1800,
      ttl: 6.0,
      turnRate: 2.4,
      hp: 4,
      radius: 7,
      acquireRange: 2100,
      colors: { blue: "#9cf", red: "#fa6" },
    },
    // Twin light PD turrets. Anti-missile only in practice — the
    // global PD_VS_SHIP_MUL nerf keeps them from chipping enemy hulls.
    pdCannons: {
      count: 2,
      damage: 7,
      cooldown: 0.24,
      projectileSpeed: 980,
      range: 400,
      projectileRadius: 2,
      projectileColors: { blue: "#cef", red: "#fda" },
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
    // Four fixed cannon mounts arranged at the cardinal points of the
    // hull (front / starboard / aft / port). Each fires independently
    // when an enemy is inside its arc, so the frigate has effective
    // 360° coverage when strafing past a target. firingMode is "ring"
    // to bypass the forward / broadside dispatch in updateShip.
    firingMode: "ring",
    ringCannons: {
      count: 4,
      damage: 8,
      cooldown: 0.30,
      projectileSpeed: 720,
      range: 800,
      arc: Math.PI / 3,   // ±60° around each mount's facing
      projectileRadius: 4.5,
      projectileColors: { blue: "#3af", red: "#f85" },
    },
    shield: { max: 150, regen: 11, regenDelay: 3.5 },
    armor: { max: 160, wearRate: 0.42 },
    // Heavy PD screen — frigates' primary contribution to a fleet is
    // killing inbound missiles and harassing fighters.
    pdCannons: {
      count: 6,
      damage: 8,
      cooldown: 0.22,
      projectileSpeed: 1000,
      range: 460,
      projectileRadius: 2.5,
      projectileColors: { blue: "#cef", red: "#fda" },
    },
    // Three light pods give the frigate a token anti-capital option but
    // they're on a long cooldown — the cannons do the work.
    missilePods: {
      count: 3,
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
    // Multi-stage salvo: each forward bank looses a tight 4-shot burst
    // (0.10 s between shells) on a ~1.8 s cooldown. Per-shot damage is
    // lower than the old single-shot to leave room for the volume, so
    // the cruiser feels like it's hammering rather than tapping.
    weapon: {
      damage: 18,
      cooldown: 1.8,
      projectileSpeed: 640,
      range: 1100,
      spread: 0.05,
      muzzles: 2,
      muzzleSpread: 55,
      projectileRadius: 7,
      projectileColors: { blue: "#5fc", red: "#fc3" },
      salvo: { shotsPerVolley: 4, intraShotDelay: 0.10 },
    },
    shield: { max: 420, regen: 18, regenDelay: 4.0 },
    armor: { max: 440, wearRate: 0.38 },
    pdCannons: {
      count: 6,
      damage: 8,
      cooldown: 0.21,
      projectileSpeed: 1020,
      range: 520,
      projectileRadius: 2.5,
      projectileColors: { blue: "#cef", red: "#fda" },
    },
    // Cluster missile pods. Each parent is a slow heavy carrier; the
    // headline payload comes from the four warheads it splits into
    // outside PD range. Direct-hit damage (60) is intentionally lower
    // than the cluster total (4 × 30 = 120) so the bloom is the
    // optimal play instead of a point-blank ram.
    missilePods: {
      count: 4,
      damage: 60,
      cooldown: 11.0,
      projectileSpeed: 240,
      range: 2000,
      ttl: 9.0,
      turnRate: 1.4,
      hp: 5,
      radius: 10,
      acquireRange: 2200,
      colors: { blue: "#3df", red: "#f4a" },
      cluster: {
        bloomDistance: 360,
        childCount: 6,
        // 160° total angular spread (≈ 2.793 rad). Children fan out
        // very wide so the cluster bursts in a true cone — a target
        // can't dodge sideways past the whole spread, and PD has to
        // engage tracks coming from every angle.
        childSpread: Math.PI * 160 / 180,
        childSpeed: 380,
        childTurnRate: 2.8,
        childTtl: 2.8,
        childDamage: 24,
        childRadius: 4,
        childHp: 1,
      },
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
      // Barrage cannons: 3 ports per side, fire as a multi-stage salvo.
      // Each side, on cooldown, looses a 3-stage volley: all 3 gun ports
      // fire 3 shells each (0.15s apart) — 9 shells per side per cycle.
      // Per-shot damage is lower than the old single-shell so the
      // headline number is in the volley weight, not the individual hit.
      //
      // Visually these are upscaled cannon shells, not lobbed plasma —
      // travelling slower than fighter rounds but still on a flat
      // trajectory at ~70% of fighter projectile speed.
      damage: 50,
      cooldown: 4.0, // per side; sides fire independently
      projectileSpeed: 540,
      range: 1300,
      spread: 0.05,
      muzzles: 3, // gun ports per side
      muzzleSpread: 70, // spaced along the much longer hull
      projectileRadius: 8,
      projectileColors: { blue: "#a3f", red: "#f25" },
      salvo: { shotsPerVolley: 3, intraShotDelay: 0.15 },
    },
    shield: { max: 950, regen: 32, regenDelay: 4.5 },
    armor: { max: 1050, wearRate: 0.34 },
    pdCannons: {
      count: 10,
      damage: 9,
      cooldown: 0.18,
      projectileSpeed: 1040,
      range: 560,
      projectileRadius: 3,
      projectileColors: { blue: "#cef", red: "#fda" },
    },
    missilePods: {
      count: 6,
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
        childCount: 6,
        // 160° angular spread — same shape as the cruiser cluster.
        childSpread: Math.PI * 160 / 180,
        childSpeed: 360,
        childTurnRate: 3.2,
        childTtl: 3.0,
        childDamage: 24,
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
    shield: { max: 900, regen: 28, regenDelay: 4.5 },
    armor: { max: 950, wearRate: 0.34 },
    pdCannons: {
      count: 14,         // densest PD wall in the fleet
      damage: 9,
      cooldown: 0.18,
      projectileSpeed: 1040,
      range: 580,
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
    aiRange: 0,
    aiOrbit: 0,
  },
  station: {
    // Base station node — immobile, no built-in weapons. Per-race node
    // specs in races.js layer on the heavy-laser / missile-pod / PD that
    // each node carries. Defense archetype: massive HP + shield + armor
    // + dense PD per node, intended to be the toughest single targets
    // in the game (Defend mode's victory condition is wiping them).
    name: "Station",
    role: "Defense Platform",
    hp: 950,
    maxSpeed: 0,
    accel: 0,
    drag: 1,
    // Nodes rotate slowly so heavy-laser arcs and missile-pod launch
    // geometry can still track the nearest enemy.
    turnRate: 0.06,
    radius: 80,
    color: "#9bf",
    firingMode: "none",
    shield: { max: 700, regen: 18, regenDelay: 3.5 },
    armor: { max: 780, wearRate: 0.30 },
    aiRange: 0,
    aiOrbit: 0,
  },
};

// Side color palette: each ship tints its class color with side accent.
export const SIDES = {
  blue: { primary: "#5cf", accent: "#28a", name: "Allied" },
  red:  { primary: "#f76", accent: "#a33", name: "Hostile" },
};
