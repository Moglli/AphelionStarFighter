export const ARENA = {
  width: 7000,
  height: 5000,
  bounds: { minX: 0, maxX: 7000, minY: 0, maxY: 5000 },
  // Spawn zones at left (blue/Allied) and right (red/Hostile) ends.
  // Recomputed proportionally whenever the map is resized.
  spawn: {
    blue: { x: 700,  y: 2500, w: 900, h: 4200 },
    red:  { x: 6300, y: 2500, w: 900, h: 4200 },
  },
};

// Map size presets shown on the start menu.
// Uses mapW / mapH to avoid colliding with rect width/height when these
// records are spread into menu hit-rects.
export const MAP_SIZES = [
  { key: "small",  label: "Small",  mapW: 4500,  mapH: 3200 },
  { key: "medium", label: "Medium", mapW: 7000,  mapH: 5000 },
  { key: "large",  label: "Large",  mapW: 11000, mapH: 7800 },
];

// Mutate ARENA in place so all consumers (game.arena reference, etc.)
// pick up the new bounds. Lays out spawn zones for 2, 3, and 4
// factions so the game can pick whichever the menu selected.
export function setArenaSize(w, h) {
  ARENA.width = w;
  ARENA.height = h;
  ARENA.bounds = { minX: 0, maxX: w, minY: 0, maxY: h };
  // 2-faction layout: left vs right.
  ARENA.spawn.blue = { x: w * 0.10, y: h / 2, w: w * 0.13, h: h * 0.84 };
  ARENA.spawn.red  = { x: w * 0.90, y: h / 2, w: w * 0.13, h: h * 0.84 };
  // 3-faction layout: triangle (player at bottom-left, hostiles top-mid
  // and bottom-right).
  ARENA.spawn3 = {
    blue:  { x: w * 0.12, y: h * 0.82, w: w * 0.16, h: h * 0.30 },
    red:   { x: w * 0.50, y: h * 0.15, w: w * 0.16, h: h * 0.30 },
    green: { x: w * 0.88, y: h * 0.82, w: w * 0.16, h: h * 0.30 },
  };
  // 4-faction layout: four corners.
  ARENA.spawn4 = {
    blue:   { x: w * 0.12, y: h * 0.82, w: w * 0.16, h: h * 0.30 },
    red:    { x: w * 0.88, y: h * 0.18, w: w * 0.16, h: h * 0.30 },
    green:  { x: w * 0.12, y: h * 0.18, w: w * 0.16, h: h * 0.30 },
    yellow: { x: w * 0.88, y: h * 0.82, w: w * 0.16, h: h * 0.30 },
  };
}

// Return the spawn zone map for the requested faction count. Defaults
// to the legacy 2-faction layout when N is anything else.
export function spawnZonesFor(factions) {
  if (factions === 3 && ARENA.spawn3) return ARENA.spawn3;
  if (factions === 4 && ARENA.spawn4) return ARENA.spawn4;
  return { blue: ARENA.spawn.blue, red: ARENA.spawn.red };
}

// Build a starfield: a few parallax layers of points sprinkled across the arena.
export function createStarfield() {
  const layers = [];
  for (let l = 0; l < 3; l++) {
    const count = 450 + l * 200;
    const stars = [];
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * ARENA.width,
        y: Math.random() * ARENA.height,
        r: 0.5 + Math.random() * (0.8 + l * 0.4),
        b: 0.3 + Math.random() * 0.7,
      });
    }
    layers.push({ parallax: 0.4 + l * 0.25, stars });
  }
  return layers;
}

export function drawArena(ctx, starfield, camera, viewW, viewH, zoom = 1) {
  // Background fill.
  ctx.fillStyle = "#02030a";
  ctx.fillRect(0, 0, viewW, viewH);

  // Stars with parallax. Each star drawn at world pos scaled by parallax,
  // then by zoom so the starfield matches the zoomed-out world view.
  for (const layer of starfield) {
    ctx.fillStyle = "#cdf";
    for (const s of layer.stars) {
      const sx = (s.x - camera.x * layer.parallax) * zoom + viewW / 2;
      const sy = (s.y - camera.y * layer.parallax) * zoom + viewH / 2;
      if (sx < -2 || sx > viewW + 2 || sy < -2 || sy > viewH + 2) continue;
      ctx.globalAlpha = s.b;
      ctx.beginPath();
      ctx.arc(sx, sy, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// World-space arena boundary rectangle (drawn after camera transform applied).
export function drawArenaBounds(ctx) {
  ctx.strokeStyle = "#234";
  ctx.lineWidth = 4;
  ctx.strokeRect(ARENA.bounds.minX, ARENA.bounds.minY,
    ARENA.bounds.maxX - ARENA.bounds.minX,
    ARENA.bounds.maxY - ARENA.bounds.minY);
}

export function randomSpawnPos(zone) {
  return {
    x: zone.x + (Math.random() - 0.5) * zone.w,
    y: zone.y + (Math.random() - 0.5) * zone.h,
  };
}
