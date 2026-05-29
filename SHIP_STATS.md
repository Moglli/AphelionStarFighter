# Aphelion Star Fighter — Ship Stats Reference

> Auto-generated from `src/classes.js` (base specs) + `src/races.js`
> (per-race overrides), merged exactly as the game does via
> `resolveSpec(race, class)`. Regenerate after balance changes.
> Cosmetic fields (colors, names) omitted. Cooldowns in seconds,
> speeds in units/sec, damage is per-hit (pre armor/shield).
> **hp** is the effective value (base × per-class tier multiplier).
> Per-module HP (e.g. the cannon you can shoot off a ship) lives
> separately in `src/modules.js`, not here.

## Terran — Balanced

Standard roster: 24× fighter, 6× bomber, 4× frigate, 2× cruiser, 1× battleship, 1× carrier  (total 38)

#### Fighter — _Interceptor_  ·  ×24 in roster

- **Hull:** hp **35**  ·  maxSpeed **400**  ·  accel **700**  ·  turnRate **3.2**  ·  drag **0.98**  ·  radius **24**  ·  aiRange **380**  ·  aiOrbit **220**
- **Shield:** max 40, regen 11, regenDelay 2.5
- **Primary weapon:** damage 4, cooldown 0.18, projectileSpeed 760, range 900, spread 0.05, muzzles 1, projectileRadius 4, capacity 30, reloadTime 0.6
- **Missile:** damage 28, cooldown 7, projectileSpeed 540, range 1500, ttl 4, turnRate 3, hp 1, radius 4, acquireRange 1800, antiCraftBonus 1.3, bypassShield true, blastRadius 12
- **Boost:** maxCharge 3, drainRate 1, rechargeRate 0.6, rechargeDelay 0.4, speedMul 1.55, accelMul 1.75

#### Bomber — _Strike Bomber_  ·  ×6 in roster

- **Hull:** hp **98**  ·  maxSpeed **220**  ·  accel **350**  ·  turnRate **1.6**  ·  drag **0.98**  ·  radius **28**  ·  aiRange **1400**  ·  aiOrbit **800**
- **Shield:** max 220, regen 24, regenDelay 2.2
- **Primary weapon:** damage 2.4, cooldown 0.28, projectileSpeed 580, range 600, spread 0.06, muzzles 2, muzzleSpread 12, projectileRadius 3.5, capacity 24, reloadTime 1.2
- **Missile pods:** count 5, damage 70, cooldown 7.5, projectileSpeed 420, range 1800, ttl 6, turnRate 2.4, hp 4, radius 7, acquireRange 2100, bypassShield true, blastRadius 40
- **Point-defense:** count 2, damage 7, cooldown 0.24, projectileSpeed 980, range 400, projectileRadius 2

#### Frigate — _Escort Destroyer_  ·  ×4 in roster

- **Hull:** hp **280**  ·  maxSpeed **150**  ·  accel **220**  ·  turnRate **1**  ·  drag **0.99**  ·  radius **62**  ·  aiRange **620**  ·  aiOrbit **380**
- **Shield:** max 150, regen 11, regenDelay 3.5
- **Armor:** max 160, wearRate 0.42
- **Ring cannons:** count 4, damage 8, cooldown 0.3, projectileSpeed 720, range 800, arc 1.05, projectileRadius 4.5
- **Missile pods:** count 3, damage 36, cooldown 11, projectileSpeed 420, range 1300, ttl 5.5, turnRate 2.2, hp 2, radius 5, acquireRange 1600, bypassShield true, blastRadius 22
- **Point-defense:** count 6, damage 8, cooldown 0.22, projectileSpeed 1000, range 460, projectileRadius 2.5

#### Cruiser — _Strike Cruiser_  ·  ×2 in roster

- **Hull:** hp **1260**  ·  maxSpeed **80**  ·  accel **130**  ·  turnRate **0.4**  ·  drag **0.99**  ·  radius **106**  ·  cannonArc **1.57**  ·  aiRange **1050**  ·  aiOrbit **880**
- **Shield:** max 420, regen 18, regenDelay 4
- **Armor:** max 440, wearRate 0.38
- **Primary weapon:** damage 18, cooldown 1.8, projectileSpeed 640, range 1100, spread 0.05, muzzles 2, muzzleSpread 55, projectileRadius 7
- **Missile pods:** count 4, damage 60, cooldown 11, projectileSpeed 240, range 2000, ttl 9, turnRate 1.4, hp 5, radius 10, acquireRange 2200, bypassShield true, blastRadius 20
- **Point-defense:** count 6, damage 8, cooldown 0.21, projectileSpeed 1020, range 520, projectileRadius 2.5

#### Battleship — _Dreadnought_  ·  ×1 in roster

- **Hull:** hp **4950**  ·  maxSpeed **35**  ·  accel **50**  ·  turnRate **0.15**  ·  drag **0.99**  ·  radius **184**  ·  aiRange **1000**  ·  aiOrbit **800**
- **Shield:** max 950, regen 32, regenDelay 4.5
- **Armor:** max 1050, wearRate 0.34
- **Primary weapon:** damage 50, cooldown 4, projectileSpeed 540, range 1300, spread 0.05, muzzles 3, muzzleSpread 70, projectileRadius 8
- **Heavy laser:** damage 240, cooldown 6, range 2400, arc 1.73, beamDuration 3
- **Torpedoes:** count 2, damage 300, cooldown 18, projectileSpeed 240, range 2800, ttl 12, turnRate 1.8, hp 5, radius 14, acquireRange 2400, bypassShield true, armorPiercing true, blastRadius 65
- **Missile pods:** count 4, damage 25, cooldown 9.5, projectileSpeed 300, range 2200, ttl 7.5, turnRate 1.8, hp 4, radius 9, acquireRange 2400, bypassShield true, blastRadius 20
- **Point-defense:** count 10, damage 9, cooldown 0.18, projectileSpeed 1040, range 560, projectileRadius 3

#### Carrier — _Fleet Carrier_  ·  ×1 in roster

- **Hull:** hp **4950**  ·  maxSpeed **45**  ·  accel **60**  ·  turnRate **0.18**  ·  drag **0.99**  ·  radius **208**  ·  aiRange **0**  ·  aiOrbit **0**
- **Shield:** max 900, regen 28, regenDelay 4.5
- **Armor:** max 950, wearRate 0.34
- **Missile pods:** count 3, damage 36, cooldown 11, projectileSpeed 420, range 1300, ttl 5.5, turnRate 2.2, hp 2, radius 5, acquireRange 1600, bypassShield true, blastRadius 22
- **Point-defense:** count 14, damage 9, cooldown 0.18, projectileSpeed 1040, range 580, projectileRadius 3
- **Replenish (sec/craft):** fighter 18, bomber 36

## Reavers — Swarm

Standard roster: 48× fighter, 12× bomber, 8× frigate, 2× cruiser, 1× battleship, 1× carrier  (total 72)

#### Fighter — _Interceptor_  ·  ×48 in roster

- **Hull:** hp **22**  ·  maxSpeed **598**  ·  accel **700**  ·  turnRate **3.6**  ·  drag **0.98**  ·  radius **24**  ·  aiRange **380**  ·  aiOrbit **220**
- **Shield:** max 12, regen 9, regenDelay 2.5
- **Primary weapon:** damage 3.9, cooldown 0.14, projectileSpeed 760, range 900, spread 0.05, muzzles 1, projectileRadius 4, capacity 24, reloadTime 0.5
- **Missile:** damage 28, cooldown 7, projectileSpeed 540, range 1500, ttl 4, turnRate 3, hp 1, radius 4, acquireRange 1800, antiCraftBonus 1.3, bypassShield true, blastRadius 12
- **Boost:** maxCharge 3, drainRate 1, rechargeRate 0.6, rechargeDelay 0.4, speedMul 1.55, accelMul 1.75

#### Bomber — _Strike Bomber_  ·  ×12 in roster

- **Hull:** hp **65**  ·  maxSpeed **260**  ·  accel **350**  ·  turnRate **1.8**  ·  drag **0.98**  ·  radius **28**  ·  aiRange **1400**  ·  aiOrbit **800**
- **Shield:** max 20, regen 6, regenDelay 3
- **Primary weapon:** damage 2.4, cooldown 0.28, projectileSpeed 580, range 600, spread 0.06, muzzles 2, muzzleSpread 12, projectileRadius 3.5, capacity 24, reloadTime 1.2
- **Missile pods:** count 2, damage 55, cooldown 9, projectileSpeed 448, range 1800, ttl 6, turnRate 2.4, hp 4, radius 7, acquireRange 2100, bypassShield true, blastRadius 40
- **Point-defense:** count 2, damage 7, cooldown 0.24, projectileSpeed 980, range 400, projectileRadius 2

#### Frigate — _Escort Destroyer_  ·  ×8 in roster

- **Hull:** hp **200**  ·  maxSpeed **180**  ·  accel **220**  ·  turnRate **1**  ·  drag **0.99**  ·  radius **62**  ·  aiRange **620**  ·  aiOrbit **380**
- **Shield:** max 60, regen 11, regenDelay 3.5
- **Armor:** max 60, wearRate 0.42
- **Ring cannons:** count 4, damage 8, cooldown 0.3, projectileSpeed 720, range 800, arc 1.05, projectileRadius 4.5
- **Missile pods:** count 3, damage 36, cooldown 11, projectileSpeed 420, range 1300, ttl 5.5, turnRate 2.2, hp 2, radius 5, acquireRange 1600, bypassShield true, blastRadius 22
- **Point-defense:** count 6, damage 8, cooldown 0.22, projectileSpeed 1000, range 460, projectileRadius 2.5

#### Cruiser — _Strike Cruiser_  ·  ×2 in roster

- **Hull:** hp **960**  ·  maxSpeed **100**  ·  accel **130**  ·  turnRate **0.4**  ·  drag **0.99**  ·  radius **106**  ·  cannonArc **1.57**  ·  aiRange **1050**  ·  aiOrbit **880**
- **Shield:** max 420, regen 18, regenDelay 4
- **Armor:** max 180, wearRate 0.38
- **Primary weapon:** damage 20, cooldown 0.65, projectileSpeed 640, range 1100, spread 0.05, muzzles 2, muzzleSpread 55, projectileRadius 7
- **Missile pods:** count 4, damage 60, cooldown 11, projectileSpeed 240, range 2000, ttl 9, turnRate 1.4, hp 5, radius 10, acquireRange 2200, bypassShield true, blastRadius 20
- **Point-defense:** count 6, damage 8, cooldown 0.21, projectileSpeed 1020, range 520, projectileRadius 2.5

#### Battleship — _Dreadnought_  ·  ×1 in roster

- **Hull:** hp **3465**  ·  maxSpeed **35**  ·  accel **50**  ·  turnRate **0.15**  ·  drag **0.99**  ·  radius **184**  ·  aiRange **1000**  ·  aiOrbit **800**
- **Shield:** max 400, regen 32, regenDelay 4.5
- **Armor:** max 400, wearRate 0.34
- **Primary weapon:** damage 50, cooldown 4, projectileSpeed 540, range 1300, spread 0.05, muzzles 3, muzzleSpread 70, projectileRadius 8
- **Heavy laser:** damage 240, cooldown 6, range 2400, arc 1.73, beamDuration 3
- **Torpedoes:** count 2, damage 300, cooldown 18, projectileSpeed 240, range 2800, ttl 12, turnRate 1.8, hp 5, radius 14, acquireRange 2400, bypassShield true, armorPiercing true, blastRadius 65
- **Missile pods:** count 4, damage 25, cooldown 9.5, projectileSpeed 300, range 2200, ttl 7.5, turnRate 1.8, hp 4, radius 9, acquireRange 2400, bypassShield true, blastRadius 20
- **Point-defense:** count 10, damage 9, cooldown 0.18, projectileSpeed 1040, range 560, projectileRadius 3

#### Carrier — _Fleet Carrier_  ·  ×1 in roster

- **Hull:** hp **4950**  ·  maxSpeed **45**  ·  accel **60**  ·  turnRate **0.18**  ·  drag **0.99**  ·  radius **208**  ·  aiRange **0**  ·  aiOrbit **0**
- **Shield:** max 900, regen 28, regenDelay 4.5
- **Armor:** max 950, wearRate 0.34
- **Missile pods:** count 3, damage 36, cooldown 11, projectileSpeed 420, range 1300, ttl 5.5, turnRate 2.2, hp 2, radius 5, acquireRange 1600, bypassShield true, blastRadius 22
- **Point-defense:** count 14, damage 9, cooldown 0.18, projectileSpeed 1040, range 580, projectileRadius 3
- **Replenish (sec/craft):** fighter 12, bomber 24

## Hegemony — Heavy

Standard roster: 18× fighter, 4× bomber, 5× frigate, 2× cruiser, 1× battleship, 1× carrier  (total 31)

#### Fighter — _Interceptor_  ·  ×18 in roster

- **Hull:** hp **52**  ·  maxSpeed **320**  ·  accel **700**  ·  turnRate **2.7**  ·  drag **0.98**  ·  radius **24**  ·  aiRange **380**  ·  aiOrbit **220**
- **Shield:** max 40, regen 8, regenDelay 3.5
- **Primary weapon:** damage 5, cooldown 0.2, projectileSpeed 760, range 900, spread 0.05, muzzles 1, projectileRadius 4, capacity 30, reloadTime 0.6
- **Missile:** damage 28, cooldown 7, projectileSpeed 540, range 1500, ttl 4, turnRate 3, hp 1, radius 4, acquireRange 1800, antiCraftBonus 1.3, bypassShield true, blastRadius 12
- **Boost:** maxCharge 3, drainRate 1, rechargeRate 0.6, rechargeDelay 0.4, speedMul 1.55, accelMul 1.75

#### Bomber — _Strike Bomber_  ·  ×4 in roster

- **Hull:** hp **143**  ·  maxSpeed **180**  ·  accel **350**  ·  turnRate **1.6**  ·  drag **0.98**  ·  radius **28**  ·  aiRange **1400**  ·  aiOrbit **800**
- **Shield:** max 55, regen 24, regenDelay 2.2
- **Primary weapon:** damage 2.4, cooldown 0.28, projectileSpeed 580, range 600, spread 0.06, muzzles 2, muzzleSpread 12, projectileRadius 3.5, capacity 24, reloadTime 1.2
- **Missile pods:** count 5, damage 70, cooldown 7.5, projectileSpeed 420, range 1800, ttl 6, turnRate 2.4, hp 4, radius 7, acquireRange 2100, bypassShield true, blastRadius 40
- **Point-defense:** count 2, damage 7, cooldown 0.24, projectileSpeed 980, range 400, projectileRadius 2

#### Frigate — _Escort Destroyer_  ·  ×5 in roster

- **Hull:** hp **360**  ·  maxSpeed **110**  ·  accel **220**  ·  turnRate **1**  ·  drag **0.99**  ·  radius **62**  ·  aiRange **620**  ·  aiOrbit **380**
- **Shield:** max 120, regen 11, regenDelay 3.5
- **Armor:** max 160, wearRate 0.5
- **Ring cannons:** count 4, damage 8, cooldown 0.3, projectileSpeed 720, range 800, arc 1.05, projectileRadius 4.5
- **Missile pods:** count 3, damage 36, cooldown 11, projectileSpeed 420, range 1300, ttl 5.5, turnRate 2.2, hp 2, radius 5, acquireRange 1600, bypassShield true, blastRadius 22
- **Point-defense:** count 6, damage 8, cooldown 0.22, projectileSpeed 1000, range 460, projectileRadius 2.5

#### Cruiser — _Strike Cruiser_  ·  ×2 in roster

- **Hull:** hp **1620**  ·  maxSpeed **65**  ·  accel **130**  ·  turnRate **0.4**  ·  drag **0.99**  ·  radius **106**  ·  cannonArc **1.57**  ·  aiRange **1050**  ·  aiOrbit **880**
- **Shield:** max 320, regen 18, regenDelay 4
- **Armor:** max 380, wearRate 0.45
- **Primary weapon:** damage 18, cooldown 1.8, projectileSpeed 640, range 1100, spread 0.05, muzzles 2, muzzleSpread 55, projectileRadius 7
- **Missile pods:** count 3, damage 60, cooldown 11, projectileSpeed 240, range 2000, ttl 9, turnRate 1.4, hp 5, radius 10, acquireRange 2200, bypassShield true, blastRadius 20
- **Point-defense:** count 6, damage 8, cooldown 0.21, projectileSpeed 1020, range 520, projectileRadius 2.5

#### Battleship — _Dreadnought_  ·  ×1 in roster

- **Hull:** hp **6750**  ·  maxSpeed **28**  ·  accel **50**  ·  turnRate **0.15**  ·  drag **0.99**  ·  radius **184**  ·  aiRange **1000**  ·  aiOrbit **800**
- **Shield:** max 750, regen 32, regenDelay 4.5
- **Armor:** max 850, wearRate 0.4
- **Primary weapon:** damage 50, cooldown 4, projectileSpeed 540, range 1300, spread 0.05, muzzles 3, muzzleSpread 70, projectileRadius 8
- **Heavy laser:** damage 240, cooldown 6, range 2400, arc 1.73, beamDuration 3
- **Torpedoes:** count 2, damage 300, cooldown 18, projectileSpeed 240, range 2800, ttl 12, turnRate 1.8, hp 5, radius 14, acquireRange 2400, bypassShield true, armorPiercing true, blastRadius 65
- **Missile pods:** count 4, damage 25, cooldown 9.5, projectileSpeed 300, range 2200, ttl 7.5, turnRate 1.8, hp 4, radius 9, acquireRange 2400, bypassShield true, blastRadius 20
- **Point-defense:** count 8, damage 9, cooldown 0.18, projectileSpeed 1040, range 560, projectileRadius 3

#### Carrier — _Fleet Carrier_  ·  ×1 in roster

- **Hull:** hp **6750**  ·  maxSpeed **35**  ·  accel **60**  ·  turnRate **0.18**  ·  drag **0.99**  ·  radius **208**  ·  aiRange **0**  ·  aiOrbit **0**
- **Shield:** max 700, regen 28, regenDelay 4.5
- **Armor:** max 800, wearRate 0.34
- **Missile pods:** count 3, damage 36, cooldown 11, projectileSpeed 420, range 1300, ttl 5.5, turnRate 2.2, hp 2, radius 5, acquireRange 1600, bypassShield true, blastRadius 22
- **Point-defense:** count 14, damage 9, cooldown 0.18, projectileSpeed 1040, range 580, projectileRadius 3
- **Replenish (sec/craft):** fighter 18, bomber 36

## Thren — Bio-swarm

Standard roster: 24× fighter, 6× bomber, 2× carrier  (total 32)

#### Fighter — _Interceptor_  ·  ×24 in roster

- **Hull:** hp **18**  ·  maxSpeed **500**  ·  accel **700**  ·  turnRate **4**  ·  drag **0.98**  ·  radius **16**  ·  aiRange **380**  ·  aiOrbit **220**
- **Shield:** max 8, regen 6, regenDelay 3
- **Primary weapon:** damage 3.6, cooldown 0.12, projectileSpeed 820, range 850, spread 0.05, muzzles 1, projectileRadius 4, capacity 28, reloadTime 0.5
- **Missile:** damage 26, cooldown 8, projectileSpeed 540, range 1500, ttl 4, turnRate 3, hp 1, radius 4, acquireRange 1800, antiCraftBonus 1.3, bypassShield true, blastRadius 12
- **Boost:** maxCharge 3, drainRate 1, rechargeRate 0.6, rechargeDelay 0.4, speedMul 1.55, accelMul 1.75

#### Bomber — _Strike Bomber_  ·  ×6 in roster

- **Hull:** hp **78**  ·  maxSpeed **250**  ·  accel **350**  ·  turnRate **1.9**  ·  drag **0.98**  ·  radius **22**  ·  aiRange **1400**  ·  aiOrbit **800**
- **Shield:** max 90, regen 14, regenDelay 2.2
- **Primary weapon:** damage 2.4, cooldown 0.28, projectileSpeed 580, range 600, spread 0.06, muzzles 2, muzzleSpread 12, projectileRadius 3.5, capacity 24, reloadTime 1.2
- **Missile pods:** count 5, damage 19, cooldown 7, projectileSpeed 460, range 1800, ttl 6, turnRate 2.6, hp 4, radius 7, acquireRange 2100, bypassShield true, blastRadius 40
- **Point-defense:** count 2, damage 7, cooldown 0.24, projectileSpeed 980, range 400, projectileRadius 2

#### Carrier — _Fleet Carrier_  ·  ×2 in roster

- **Hull:** hp **8550**  ·  maxSpeed **32**  ·  accel **60**  ·  turnRate **0.1**  ·  drag **0.99**  ·  radius **440**  ·  cannonTurnRate **0.55**  ·  cannonArc **1.73**  ·  aiRange **0**  ·  aiOrbit **0**
- **Shield:** max 1200, regen 34, regenDelay 4.5
- **Armor:** max 900, wearRate 0.33
- **Primary weapon:** damage 220, cooldown 3.2, projectileSpeed 728, range 1500, spread 0.02, muzzles 1, muzzleSpread 0, projectileRadius 12
- **Missile pods:** count 3, damage 70, cooldown 9, projectileSpeed 360, range 2200, ttl 7, turnRate 2, hp 4, radius 8, acquireRange 2400, bypassShield true, blastRadius 22
- **Point-defense:** count 16, damage 9, cooldown 0.18, projectileSpeed 1040, range 600, projectileRadius 3
- **Replenish (sec/craft):** fighter 6.5, bomber 14

## Voidsworn — Tech

Standard roster: 18× fighter, 5× bomber, 4× frigate, 3× cruiser, 1× battleship, 1× carrier  (total 32)

#### Fighter — _Interceptor_  ·  ×18 in roster

- **Hull:** hp **28**  ·  maxSpeed **400**  ·  accel **700**  ·  turnRate **3.2**  ·  drag **0.98**  ·  radius **24**  ·  aiRange **380**  ·  aiOrbit **220**
- **Shield:** max 50, regen 16, regenDelay 1.8
- **Primary weapon:** damage 5, cooldown 0.18, projectileSpeed 760, range 900, spread 0.05, muzzles 1, projectileRadius 4, capacity 30, reloadTime 0.6
- **Missile:** damage 36, cooldown 7, projectileSpeed 540, range 1500, ttl 4, turnRate 3, hp 1, radius 4, acquireRange 1800, antiCraftBonus 1.3, bypassShield true, blastRadius 12
- **Boost:** maxCharge 3, drainRate 1, rechargeRate 0.6, rechargeDelay 0.4, speedMul 1.55, accelMul 1.75

#### Bomber — _Strike Bomber_  ·  ×5 in roster

- **Hull:** hp **85**  ·  maxSpeed **220**  ·  accel **350**  ·  turnRate **1.6**  ·  drag **0.98**  ·  radius **28**  ·  aiRange **1400**  ·  aiOrbit **800**
- **Shield:** max 70, regen 12, regenDelay 2.5
- **Primary weapon:** damage 2.4, cooldown 0.28, projectileSpeed 580, range 600, spread 0.06, muzzles 2, muzzleSpread 12, projectileRadius 3.5, capacity 24, reloadTime 1.2
- **Missile pods:** count 5, damage 85, cooldown 7.5, projectileSpeed 420, range 1800, ttl 6, turnRate 2.4, hp 4, radius 7, acquireRange 2100, bypassShield true, blastRadius 40
- **Point-defense:** count 2, damage 7, cooldown 0.24, projectileSpeed 980, range 400, projectileRadius 2

#### Frigate — _Escort Destroyer_  ·  ×4 in roster

- **Hull:** hp **240**  ·  maxSpeed **150**  ·  accel **220**  ·  turnRate **1**  ·  drag **0.99**  ·  radius **62**  ·  aiRange **620**  ·  aiOrbit **380**
- **Shield:** max 200, regen 18, regenDelay 2.5
- **Armor:** max 80, wearRate 0.42
- **Ring cannons:** count 4, damage 8, cooldown 0.3, projectileSpeed 720, range 800, arc 1.05, projectileRadius 4.5
- **Missile pods:** count 3, damage 36, cooldown 11, projectileSpeed 420, range 1300, ttl 5.5, turnRate 2.2, hp 2, radius 5, acquireRange 1600, bypassShield true, blastRadius 22
- **Point-defense:** count 6, damage 8, cooldown 0.22, projectileSpeed 1000, range 460, projectileRadius 2.5

#### Cruiser — _Strike Cruiser_  ·  ×3 in roster

- **Hull:** hp **1140**  ·  maxSpeed **80**  ·  accel **130**  ·  turnRate **0.4**  ·  drag **0.99**  ·  radius **106**  ·  cannonArc **1.57**  ·  aiRange **1050**  ·  aiOrbit **880**
- **Shield:** max 480, regen 28, regenDelay 3
- **Armor:** max 240, wearRate 0.38
- **Primary weapon:** damage 18, cooldown 1.8, projectileSpeed 640, range 1100, spread 0.05, muzzles 2, muzzleSpread 55, projectileRadius 7
- **Missile pods:** count 4, damage 60, cooldown 11, projectileSpeed 240, range 2000, ttl 9, turnRate 1.4, hp 5, radius 10, acquireRange 2200, bypassShield true, blastRadius 20
- **Point-defense:** count 6, damage 8, cooldown 0.21, projectileSpeed 1020, range 520, projectileRadius 2.5

#### Battleship — _Dreadnought_  ·  ×1 in roster

- **Hull:** hp **4275**  ·  maxSpeed **35**  ·  accel **50**  ·  turnRate **0.15**  ·  drag **0.99**  ·  radius **184**  ·  aiRange **1000**  ·  aiOrbit **800**
- **Shield:** max 1100, regen 40, regenDelay 4
- **Armor:** max 550, wearRate 0.34
- **Primary weapon:** damage 50, cooldown 4, projectileSpeed 540, range 1300, spread 0.05, muzzles 3, muzzleSpread 70, projectileRadius 8
- **Heavy laser:** damage 220, cooldown 4, range 2400, arc 2.2, beamDuration 3
- **Torpedoes:** count 2, damage 300, cooldown 18, projectileSpeed 240, range 2800, ttl 12, turnRate 1.8, hp 5, radius 14, acquireRange 2400, bypassShield true, armorPiercing true, blastRadius 65
- **Missile pods:** count 4, damage 25, cooldown 9.5, projectileSpeed 300, range 2200, ttl 7.5, turnRate 1.8, hp 4, radius 9, acquireRange 2400, bypassShield true, blastRadius 20
- **Point-defense:** count 10, damage 9, cooldown 0.18, projectileSpeed 1040, range 560, projectileRadius 3

#### Carrier — _Fleet Carrier_  ·  ×1 in roster

- **Hull:** hp **4500**  ·  maxSpeed **45**  ·  accel **60**  ·  turnRate **0.18**  ·  drag **0.99**  ·  radius **208**  ·  aiRange **0**  ·  aiOrbit **0**
- **Shield:** max 850, regen 28, regenDelay 3.5
- **Armor:** max 950, wearRate 0.34
- **Missile pods:** count 3, damage 36, cooldown 11, projectileSpeed 420, range 1300, ttl 5.5, turnRate 2.2, hp 2, radius 5, acquireRange 1600, bypassShield true, blastRadius 22
- **Point-defense:** count 14, damage 9, cooldown 0.18, projectileSpeed 1040, range 580, projectileRadius 3
- **Replenish (sec/craft):** fighter 22, bomber 40
