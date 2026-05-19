/**
 * @file Shared JSDoc typedefs for persisted state and event payloads.
 * No runtime exports — pure documentation aid for editors and future TS migration.
 */

/**
 * @typedef {Object} Stats
 * @property {number} kills
 * @property {number} deaths
 * @property {number} wins
 * @property {number} losses
 * @property {number} playtimeSeconds
 * @property {number} damageDealt
 */

/**
 * @typedef {"hullSkin"|"engineTrail"|"weaponFX"|"audioPack"} CosmeticSlot
 */

/**
 * @typedef {string} CosmeticId   e.g. "hull_terran_fighter_crimson"
 * @typedef {string} ShipId       e.g. "fighter", "wraith"
 * @typedef {string} RaceId       e.g. "terran", "ascendancy"
 * @typedef {string} EntitlementId
 */

/**
 * @typedef {Object} BattlePassState
 * @property {string} seasonId
 * @property {number} tier
 * @property {number} tierXp
 * @property {boolean} premium
 * @property {number[]} claimedTiers
 */

/**
 * @typedef {"arena"|"waves"|"daily"} GameMode
 * @typedef {"small"|"medium"|"large"} MapSizeKey
 */

/**
 * @typedef {Object} DailyState
 * @property {string|null} lastSeed       ISO date of last attempt (e.g. "2026-05-19")
 * @property {number}      lastScore
 * @property {"win"|"loss"|null} lastResult
 * @property {string|null} firstWinSeed   ISO date of the first win bonus claimed today
 */

/**
 * @typedef {Object} BestScores
 * @property {number} arena
 * @property {number} waves
 */

/**
 * @typedef {Object} MenuSelection
 * @property {GameMode}    mode
 * @property {ShipId}      klass
 * @property {RaceId}      race
 * @property {MapSizeKey}  mapSize
 */

/**
 * @typedef {Object} SaveData
 * @property {number} schemaVersion
 * @property {number} xp
 * @property {number} level
 * @property {number} softCurrency        in-game credits
 * @property {number} hardCurrency        Aphelium, purchased or earned sparingly
 * @property {Stats} stats
 * @property {ShipId[]} unlockedShips
 * @property {RaceId[]} unlockedRaces
 * @property {Record<CosmeticSlot, CosmeticId|null>} equippedCosmetics
 * @property {CosmeticId[]} inventory
 * @property {EntitlementId[]} entitlements  mirrored from RevenueCat on launch
 * @property {BattlePassState|null} battlePass
 * @property {number|null} lastLoginEpochMs
 * @property {number} loginStreak
 * @property {DailyState} daily
 * @property {BestScores} bestScores
 * @property {MenuSelection} menuSelection  last picked start-menu state
 * @property {Object} settings
 * @property {number} settings.musicVolume
 * @property {number} settings.sfxVolume
 * @property {number} settings.controlSensitivity
 */

/**
 * @typedef {"cannon"|"broadside"|"missile"|"laser"} WeaponSoundKind
 * @typedef {"shield"|"armor"|"subsystem"|"hull"} HitLayer
 * @typedef {"gun"|"engine"|"missile"|"laser"} SubsystemKind
 */

/**
 * @typedef {Object} EventPayloads
 * @property {{ ship: object, kind: WeaponSoundKind }} weaponFired
 * @property {{ ship: object, killer: object|null, byPlayer: boolean }} shipDestroyed
 * @property {{ ship: object }} playerDestroyed
 * @property {{ ship: object, layer: HitLayer, amount: number, byPlayer: boolean }} hit
 * @property {{ ship: object, kind: SubsystemKind, byPlayer: boolean }} subsystemDestroyed
 * @property {{ amount: number, source: object, target: object }} damageDealt
 * @property {{ mode: GameMode, winner: "blue"|"red", durationSeconds: number, score: number }} matchEnded
 * @property {{ wave: number, spawnCount: number }} waveStarted
 * @property {{ wave: number }} waveCleared
 * @property {{ missionId: string }} missionComplete
 * @property {{ amount: number, source: string }} xpAwarded
 * @property {{ tier: number, premium: boolean }} battlePassTierReached
 * @property {{ source: "menu"|"hud" }} uiClick
 */

export {};
