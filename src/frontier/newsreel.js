/**
 * @file Republic Newsreel (FRONTIER_FUTURE.md §10.2) — authored
 * propaganda segments that play in the Pilot's Lounge between runs and
 * surface as "incoming transmissions" on the post-battle screen.
 *
 * Pure-flavor (no mechanical reward) — the doc's "story first" pillar.
 * Every segment unlocks off a DERIVABLE trigger (per-War chapter
 * progress, kill ledger, war completion) so there are no new counters.
 * The voice is propaganda only (the True-Believer POV is locked, §6) —
 * the player never sees the designer-note subtext.
 *
 * `checkNewsreel()` unlocks newly-triggered segments into
 * `frontier.newsreel` (id list, in unlock order); `newsreelView()` is the
 * latest-first feed for the hub sheet.
 */

import { saveStore } from "../save.js";

const KROGER = "High Admiral Kroger";
const BRANT = "Commander Brant";

/**
 * @typedef {Object} Segment
 * @property {string} id
 * @property {string} war          warId this belongs to (for grouping)
 * @property {"chapter"|"milestone"} kind
 * @property {string} speaker
 * @property {string} title
 * @property {string} body
 * @property {(c:any)=>boolean} trigger
 */

/** @type {Segment[]} */
export const NEWSREEL_SEGMENTS = [
  // ---- Op Locust Wind (Brood) ----
  { id: "nw-lw-1", war: "locust-wind", kind: "chapter", speaker: KROGER,
    title: "First Contact at Bellum",
    body: "Citizens — the alien swarm has shown its face at the edge of our frontier, and our pilots have shown it ours. The Brood bleeds like anything else. Hold the line and the stars are ours.",
    trigger: (c) => c.chapters["locust-wind"] >= 1 },
  { id: "nw-lw-2", war: "locust-wind", kind: "chapter", speaker: KROGER,
    title: "The Line Holds at Vorago",
    body: "They came in numbers beyond counting, and Vorago HELD. Every drone that died at our guns is a world the Brood will never devour. The Republic does not break.",
    trigger: (c) => c.chapters["locust-wind"] >= 2 },
  { id: "nw-lw-3", war: "locust-wind", kind: "chapter", speaker: KROGER,
    title: "The Hatcheries Burn",
    body: "Rupes is liberated. Our strike groups have gutted the brood-carriers and the swarm's tide is turning. Morale across the fleet has never been higher. Onward!",
    trigger: (c) => c.chapters["locust-wind"] >= 3 },
  { id: "nw-lw-4", war: "locust-wind", kind: "chapter", speaker: BRANT,
    title: "No More Drones",
    body: "Vastitas is cleansed. The last brood-ship cluster is ash. The enemy cannot replace what it has lost — and we are coming for the heart of it. Make ready.",
    trigger: (c) => c.chapters["locust-wind"] >= 4 },
  { id: "nw-lw-5", war: "locust-wind", kind: "chapter", speaker: KROGER,
    title: "THE HIVE IS DEAD",
    body: "It is done. The Hive is destroyed and the Brood is EXTERMINATED. The frontier is secured for humanity, as it was always meant to be. Glory to the Republic!",
    trigger: (c) => c.warsWon.includes("locust-wind") },
  { id: "nw-lw-m1", war: "locust-wind", kind: "milestone", speaker: BRANT,
    title: "Swarm Tally: 250",
    body: "Two hundred fifty confirmed drone kills, pilot. The ledger of the dead grows — theirs, not ours. Keep it that way.",
    trigger: (c) => c.broodKills >= 250 },

  // ---- Op Dragon's Jaw (Saurian) ----
  { id: "nw-dj-1", war: "dragons-jaw", kind: "chapter", speaker: KROGER,
    title: "Foothold at Var",
    body: "Citizens of the Republic — our bold strike into Dominion space has secured Var. The reptilian pretenders did not expect humanity's resolve. They are learning.",
    trigger: (c) => c.chapters["dragons-jaw"] >= 1 },
  { id: "nw-dj-2", war: "dragons-jaw", kind: "chapter", speaker: KROGER,
    title: "Held at Sskahl",
    body: "Warlord Varas threw his honor-guard at Sskahl and we paid for every metre in blood — but the line stands. An ancient enemy bleeds before a younger, hungrier people.",
    trigger: (c) => c.chapters["dragons-jaw"] >= 2 },
  { id: "nw-dj-3", war: "dragons-jaw", kind: "chapter", speaker: KROGER,
    title: "Broken Banners",
    body: "The Houses of Sk'rath and Vael'ari are shattered, their aces downed, their banners paraded on every newsreel from here to Sol. Let the galaxy see what defiance earns.",
    trigger: (c) => c.chapters["dragons-jaw"] >= 3 },
  { id: "nw-dj-4", war: "dragons-jaw", kind: "chapter", speaker: BRANT,
    title: "The DRAKAR-TSSOR Strikes Colors",
    body: "Varas's own flagship has yielded — a Dominion banner-cruiser, now a Republic trophy. The Warlord fled. He will regret leaving us alive to finish this.",
    trigger: (c) => c.chapters["dragons-jaw"] >= 4 },
  { id: "nw-dj-5", war: "dragons-jaw", kind: "chapter", speaker: KROGER,
    title: "The Treaty of Zavat",
    body: "The hardliners are dead and the Dominion has bent the knee. The contested frontier is ours by treaty and by right. A glorious victory for humanity's manifest destiny!",
    trigger: (c) => c.warsWon.includes("dragons-jaw") },
  { id: "nw-dj-m1", war: "dragons-jaw", kind: "milestone", speaker: BRANT,
    title: "War-Craft Down: 100",
    body: "A hundred Dominion hulls broken by your hand, pilot. They called themselves an ancient warrior race. We call them a footnote.",
    trigger: (c) => c.saurianKills >= 100 },
];

export const SEGMENTS_BY_ID = NEWSREEL_SEGMENTS.reduce((a, s) => { a[s.id] = s; return a; }, {});

/** Derivable metrics for triggers (mirrors achievements.js metricsFor). */
function metricsFor(f) {
  const wars = f.wars || {};
  const chapters = {};
  const warsWon = [];
  let broodKills = 0, saurianKills = 0;
  for (const [warId, w] of Object.entries(wars)) {
    chapters[warId] = w.chaptersCompleted || 0;
    if (w.completed) warsWon.push(warId);
    let n = 0; for (const v of Object.values(w.kills || {})) n += v;
    if (warId === "locust-wind") broodKills = n;
    if (warId === "dragons-jaw") saurianKills = n;
  }
  return { chapters, warsWon, broodKills, saurianKills };
}

/**
 * Unlock newly-triggered segments into `frontier.newsreel` (id list, in
 * unlock order). Idempotent. Returns the newly-unlocked segment objects
 * for the result screen.
 */
export function checkNewsreel() {
  const newly = [];
  saveStore.update((data) => {
    const f = data.frontier;
    if (!f) return;
    if (!Array.isArray(f.newsreel)) f.newsreel = [];
    const have = new Set(f.newsreel);
    const c = metricsFor(f);
    for (const seg of NEWSREEL_SEGMENTS) {
      if (have.has(seg.id)) continue;
      let on = false;
      try { on = seg.trigger(c); } catch (_e) { on = false; }
      if (!on) continue;
      have.add(seg.id);
      f.newsreel.push(seg.id);
      newly.push(seg);
    }
  });
  return newly;
}

/**
 * Hub feed view: unlocked segments newest-first + a locked count so the
 * player sees there's more to earn.
 */
export function newsreelView() {
  const f = saveStore.get().frontier || {};
  const unlockedIds = Array.isArray(f.newsreel) ? f.newsreel : [];
  const unlocked = unlockedIds
    .map((id) => SEGMENTS_BY_ID[id])
    .filter(Boolean)
    .map((s) => ({ id: s.id, war: s.war, kind: s.kind, speaker: s.speaker, title: s.title, body: s.body }))
    .reverse();
  return { unlocked, lockedCount: Math.max(0, NEWSREEL_SEGMENTS.length - unlocked.length) };
}
