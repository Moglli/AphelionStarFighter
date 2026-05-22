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
// pick up the new bounds.
export function setArenaSize(w, h) {
  ARENA.width = w;
  ARENA.height = h;
  ARENA.bounds = { minX: 0, maxX: w, minY: 0, maxY: h };
  ARENA.spawn.blue = { x: w * 0.10, y: h / 2, w: w * 0.13, h: h * 0.84 };
  ARENA.spawn.red  = { x: w * 0.90, y: h / 2, w: w * 0.13, h: h * 0.84 };
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

  // Zoom-based starfield fade. When the player pinches out to observe
  // the whole battle, the parallax stars sat right on top of the
  // ships and made the action hard to read against the busy field.
  // Linear fade from full brightness at zoom ≥ FADE_HIGH down to 0
  // at zoom ≤ FADE_LOW so the zoomed-out view is on clean black.
  // Tuned with DEFAULT_ZOOM (0.5) and MIN_ZOOM (0.15) in mind — the
  // fade starts as soon as the player pulls below the default and is
  // gone entirely a little before the min.
  const FADE_HIGH = 0.50;
  const FADE_LOW  = 0.22;
  let starAlpha = 1;
  if (zoom <= FADE_LOW) starAlpha = 0;
  else if (zoom < FADE_HIGH) starAlpha = (zoom - FADE_LOW) / (FADE_HIGH - FADE_LOW);
  if (starAlpha <= 0) return;

  // Stars with parallax. Each star drawn at world pos scaled by parallax,
  // then by zoom so the starfield matches the zoomed-out world view.
  for (const layer of starfield) {
    ctx.fillStyle = "#cdf";
    for (const s of layer.stars) {
      const sx = (s.x - camera.x * layer.parallax) * zoom + viewW / 2;
      const sy = (s.y - camera.y * layer.parallax) * zoom + viewH / 2;
      if (sx < -2 || sx > viewW + 2 || sy < -2 || sy > viewH + 2) continue;
      ctx.globalAlpha = s.b * starAlpha;
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

  // Faint spawn zone outlines.
  ctx.setLineDash([8, 8]);
  ctx.strokeStyle = "rgba(80,180,255,0.25)";
  rectFromZone(ctx, ARENA.spawn.blue);
  ctx.strokeStyle = "rgba(255,120,90,0.25)";
  rectFromZone(ctx, ARENA.spawn.red);
  ctx.setLineDash([]);
}

function rectFromZone(ctx, z) {
  ctx.strokeRect(z.x - z.w / 2, z.y - z.h / 2, z.w, z.h);
}

export function randomSpawnPos(zone) {
  return {
    x: zone.x + (Math.random() - 0.5) * zone.w,
    y: zone.y + (Math.random() - 0.5) * zone.h,
  };
}
