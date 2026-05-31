/**
 * @file The two launch Wars as data (FRONTIER_FUTURE.md §8).
 *
 * A War is an authored, time-bounded conflict against one antagonist
 * faction. Each is a Wing-Commander-style campaign: an authored CHAPTER
 * SPINE (gates War progress) plus an open SORTIE POOL of repeatable
 * side missions flown for credits/XP/loot between story beats.
 *
 * This is content data only — no runtime state. Per-War progress lives
 * in the save (`frontier.wars[warId]`); the live pilot run lives in
 * `frontier.run`. The mission→battle bridge (mission.js) reads a
 * chapter/sortie's `battle` hints to assemble a real engine roster.
 *
 * FACTION → RACE mapping is a PLACEHOLDER. The new Brood/Saurian races
 * (FRONTIER_FUTURE.md §7) aren't in races.js yet — until that content
 * slice lands, each new faction maps onto the engine-fit template the
 * doc itself names in §7a: the Brood onto the Reaver fragile-fast-swarm
 * template, the Saurians onto the Hegemony quality-over-quantity
 * template. When the real races ship, change ONLY this map.
 */

/**
 * Placeholder enemy-faction → existing-race mapping. Single point of
 * change when the real Brood/Saurian races land in races.js.
 * @type {Record<string,string>}
 */
export const FACTION_RACE = {
  brood: "brood",       // real race (races.js) — fragile-fast organic swarm
  saurian: "saurian",   // real race (races.js) — quality reptilian warriors
};

/** The player's own faction (Manifest-Destiny Republic). Placeholder race. */
export const PLAYER_FACTION = "republic";
export const PLAYER_RACE = "terran";

/**
 * Resolve a faction key to a spawnable engine race. Falls back to the
 * key itself (so a real race added under its own key Just Works).
 * @param {string} faction
 */
export function raceForFaction(faction) {
  return FACTION_RACE[faction] || faction;
}

/**
 * Battle-shape archetypes. Each chapter/sortie carries a `battle.kind`
 * that the mission bridge expands into a roster + battle mode.
 *
 *   sweep          — strike-craft skirmish, small. Player flies.
 *   defense        — hold-the-line; heavier enemy push. Player flies.
 *   capital-assault— capitals present on both sides, large.
 *   fleet          — full fleet battle, multiple objectives.
 *   boss           — named neverSurrender flagship/hive, massive.
 *   surrender      — force enemy flagship to strike colors (capture).
 *
 * `scale` is a coarse roster multiplier the bridge maps to counts.
 */
export const BATTLE_KINDS = ["sweep", "defense", "capital-assault", "fleet", "boss", "surrender"];

/** @typedef {Object} Chapter
 * @property {string} id
 * @property {string} title
 * @property {string} summary
 * @property {string} beat        Story beat delivered on completion
 * @property {string[]} npcs      Officer-cast roles featured
 * @property {{kind:string, scale:number, neverSurrender?:boolean}} battle
 */

/** @typedef {Object} Sortie
 * @property {string} id
 * @property {string} name
 * @property {string} summary
 * @property {{kind:string, scale:number}} battle
 */

/** @typedef {Object} War
 * @property {string} id
 * @property {string} codename
 * @property {string} enemyFaction
 * @property {string} staging
 * @property {string} pitch
 * @property {{contested:string[], finalTarget:string}} geography
 * @property {Chapter[]} chapters
 * @property {Sortie[]} sorties
 */

/** @type {War} */
export const OP_LOCUST_WIND = {
  id: "locust-wind",
  codename: "Op Locust Wind",
  enemyFaction: "brood",
  staging: "Novus Spes",
  pitch:
    "A monstrous alien swarm — the Brood — is devouring its way across the frontier. " +
    "Mindless, voracious, incommunicable. The Republic has authorized total war to " +
    "exterminate the menace.",
  geography: {
    contested: ["Bellum", "Vorago", "Rupes", "Vastitas"],
    finalTarget: "The Hive",
  },
  chapters: [
    {
      id: "lw-ch1",
      title: "The Swarm",
      summary: "Strike-craft patrols report massive alien presence in Bellum. Fly early skirmishes against the swarm.",
      beat: "The Brood is confirmed as an existential threat.",
      npcs: ["Tarsa", "Brant"],
      battle: { kind: "sweep", scale: 1 },
    },
    {
      id: "lw-ch2",
      title: "Broken Line",
      summary: "Brood forces overwhelm forward defenses and advance toward Novus Spes. Hold the line in Vorago until heavier ships deploy.",
      beat: "The Republic holds the line at brutal cost; the war's true scale becomes clear.",
      npcs: ["Hale"],
      battle: { kind: "defense", scale: 2 },
    },
    {
      id: "lw-ch3",
      title: "Exterminatus",
      summary: "Lead strike groups against massive Brood-carriers in Rupes, crippling their hatch capacity.",
      beat: "The tide is stemmed; Republic morale surges.",
      npcs: ["Kroger"],
      battle: { kind: "capital-assault", scale: 3 },
    },
    {
      id: "lw-ch4",
      title: "Drown the Hatchery",
      summary: "Strike the Brood's last brood-ship cluster deep in Vastitas. No more drones will hatch.",
      beat: "The Brood's ability to replenish ends; the path to the Hive is clear.",
      npcs: ["Brant", "Hale"],
      battle: { kind: "fleet", scale: 4 },
    },
    {
      id: "lw-ch5",
      title: "The Hive",
      summary: "The final assault on the home system. The massive Hive-ship must die.",
      beat: "The Hive is destroyed; the Brood is exterminated.",
      npcs: ["Kroger", "Tarsa"],
      battle: { kind: "boss", scale: 5, neverSurrender: true },
    },
  ],
  sorties: [
    { id: "lw-s1", name: "Swarm suppression", summary: "Clear drone clouds in contested systems.", battle: { kind: "sweep", scale: 1 } },
    { id: "lw-s2", name: "Salvage escort", summary: "Protect civilian salvage crews in post-battle zones.", battle: { kind: "defense", scale: 1 } },
    { id: "lw-s3", name: "Decoy run", summary: "Engage drone packs while transports break orbit.", battle: { kind: "sweep", scale: 2 } },
    { id: "lw-s4", name: "Brood-ship strike", summary: "Destroy a Brood-carrier before its hatch cycle completes.", battle: { kind: "capital-assault", scale: 2 } },
    { id: "lw-s5", name: "Listening post relief", summary: "Defend a Republic comms relay from a drone wave.", battle: { kind: "defense", scale: 2 } },
    { id: "lw-s6", name: "Burnt-system patrol", summary: "Pacify holdout drones in systems declared secure.", battle: { kind: "sweep", scale: 1 } },
    { id: "lw-s7", name: "Refugee convoy escort", summary: "Escort civilian transports out of contested zones.", battle: { kind: "defense", scale: 2 } },
    { id: "lw-s8", name: "Forward picket", summary: "Sortie ahead of a fleet's jump-point as early warning.", battle: { kind: "sweep", scale: 2 } },
  ],
};

/**
 * Saurian Houses — heraldry + named aces (§8.3). Referenced by chapters
 * for ace casting; full rendering (banner sigils) is a later UI slice.
 */
export const SAURIAN_HOUSES = [
  { id: "tssorkan", name: "House Tssor'kan", epithet: "the Old Blood", sigil: "horned-serpent", ace: "Warlord Varas" },
  { id: "skrath", name: "House Sk'rath", epithet: "the Iron Sun", sigil: "barbed-sun", ace: "Zikorex" },
  { id: "vaelari", name: "House Vael'ari", epithet: "the Silver Talon", sigil: "hooked-talon", ace: "Ssaik" },
  { id: "drazn", name: "House Drazn", epithet: "the Black Tide", sigil: "crashing-wave", ace: "Khelovar" },
];

/** @type {War} */
export const OP_DRAGONS_JAW = {
  id: "dragons-jaw",
  codename: "Op Dragon's Jaw",
  enemyFaction: "saurian",
  staging: "Novus Spes",
  pitch:
    "A glorious campaign of expansion: secure contested frontier systems from the Var'sakh " +
    "Dominion, an ancient reptilian empire that refuses to recognize humanity's claim to the stars. " +
    "Proud and warlike — but no match for the might of the Republic.",
  geography: {
    contested: ["Var", "Sskahl", "Khel", "Tazsa"],
    finalTarget: "Zavat",
  },
  chapters: [
    {
      id: "dj-ch1",
      title: "Bold Strike",
      summary: "Surprise attack on Var. Join the initial fighter sweep and capture key positions before the Dominion regroups.",
      beat: "The Republic gains an early foothold in contested space.",
      npcs: ["Tarsa", "Brant", "Hale"],
      battle: { kind: "sweep", scale: 1 },
    },
    {
      id: "dj-ch2",
      title: "Saurian Honor",
      summary: "Dominion forces rally under Warlord Varas and counterattack in Sskahl. Defend Republic positions.",
      beat: "Dominion resistance is harder than briefed; every advance is paid for in blood.",
      npcs: ["Varas", "Kroger"],
      battle: { kind: "defense", scale: 2 },
    },
    {
      id: "dj-ch3",
      title: "Broken Banners",
      summary: "Coordinated assault on Khel targeting Dominion capitals and named aces. Break Houses Sk'rath and Vael'ari.",
      beat: "Key Dominion Houses bloodied; Zikorex's banner recovered as a trophy.",
      npcs: ["Zikorex", "Ssaik", "Kroger"],
      battle: { kind: "capital-assault", scale: 3 },
    },
    {
      id: "dj-ch4",
      title: "Honorless Foes",
      summary: "Break the line at Tazsa and force Varas's banner-cruiser DRAKAR-TSSOR to strike its colors. Varas escapes.",
      beat: "Captured flagship becomes a Republic trophy; Varas survives to fight on.",
      npcs: ["Varas", "Brant"],
      battle: { kind: "surrender", scale: 4 },
    },
    {
      id: "dj-ch5",
      title: "Dragon's Jaw",
      summary: "The hardliner Houses Drazn and Sk'rath refuse the armistice and make a last stand at Zavat. End them.",
      beat: "The hardliner factions are exterminated; the treaty is celebrated; the war is won.",
      npcs: ["Khelovar", "Kroger", "Tarsa"],
      battle: { kind: "boss", scale: 5, neverSurrender: true },
    },
  ],
  sorties: [
    { id: "dj-s1", name: "Banner challenge", summary: "Engage a named Dominion ace and recover their banner.", battle: { kind: "capital-assault", scale: 2 } },
    { id: "dj-s2", name: "Convoy raid", summary: "Destroy Dominion supply lines.", battle: { kind: "sweep", scale: 1 } },
    { id: "dj-s3", name: "Honor duel", summary: "Small wing-vs-wing skirmish in disputed space.", battle: { kind: "sweep", scale: 1 } },
    { id: "dj-s4", name: "Deep-strike", summary: "Probe a Dominion patrol route; return with what you survive.", battle: { kind: "sweep", scale: 2 } },
    { id: "dj-s5", name: "Force-surrender", summary: "Disable a Dominion capital to make it strike colors.", battle: { kind: "surrender", scale: 2 } },
    { id: "dj-s6", name: "Propaganda escort", summary: "Escort Republic broadcast ships into contested space.", battle: { kind: "defense", scale: 2 } },
    { id: "dj-s7", name: "Banner hunt", summary: "Bounty contract on a specific House's capital.", battle: { kind: "capital-assault", scale: 2 } },
    { id: "dj-s8", name: "Forward intercept", summary: "Ambush incoming Dominion reinforcements.", battle: { kind: "defense", scale: 2 } },
  ],
};

/** All launch Wars, in display order. */
export const WARS = [OP_LOCUST_WIND, OP_DRAGONS_JAW];

/** @type {Record<string, War>} */
export const WARS_BY_ID = WARS.reduce((acc, w) => { acc[w.id] = w; return acc; }, {});

/** Lookup a War by id (null if unknown). */
export function getWar(warId) {
  return WARS_BY_ID[warId] || null;
}

/** Lookup a chapter within a War by id. */
export function getChapter(warId, chapterId) {
  const war = getWar(warId);
  if (!war) return null;
  return war.chapters.find((c) => c.id === chapterId) || null;
}

/** Lookup a sortie within a War by id. */
export function getSortie(warId, sortieId) {
  const war = getWar(warId);
  if (!war) return null;
  return war.sorties.find((s) => s.id === sortieId) || null;
}

/**
 * The chapter the player can fly next in a War, given how many they've
 * completed. Returns null once the whole spine is cleared.
 * @param {string} warId
 * @param {number} chaptersCompleted
 */
export function nextChapter(warId, chaptersCompleted) {
  const war = getWar(warId);
  if (!war) return null;
  return war.chapters[chaptersCompleted] || null;
}
