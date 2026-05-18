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
 * @property {string|null} lastDailySeed
 * @property {Object} settings
 * @property {number} settings.musicVolume
 * @property {number} settings.sfxVolume
 * @property {number} settings.controlSensitivity
 */

/**
 * @typedef {Object} EventPayloads
 * @property {{ ship: object, killer: object|null }} enemyKilled
 * @property {{ ship: object, killer: object|null }} playerKilled
 * @property {{ amount: number, source: object, target: object }} damageDealt
 * @property {{ mode: string, durationSeconds: number, score: number }} matchWon
 * @property {{ mode: string, durationSeconds: number }} matchLost
 * @property {{ missionId: string }} missionComplete
 * @property {{ amount: number, source: string }} xpAwarded
 * @property {{ tier: number, premium: boolean }} battlePassTierReached
 */

export {};
