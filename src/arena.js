export const ARENA = {
  width: 7000,
  height: 5000,
  bounds: { minX: 0, maxX: 7000, minY: 0, maxY: 5000 },
  // Spawn zones at left (blue/Allied) and right (red/Hostile) ends.
  // Wide + tall so packs/cruisers/battleships spread out at the start.
  spawn: {
    blue: { x: 700,  y: 2500, w: 900, h: 4200 },
    red:  { x: 6300, y: 2500, w: 900, h: 4200 },
  },
};

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

export function drawArena(ctx, starfield, camera, viewW, viewH) {
  // Background fill.
  ctx.fillStyle = "#02030a";
  ctx.fillRect(0, 0, viewW, viewH);

  // Stars with parallax. Each star drawn at world pos scaled by parallax.
  for (const layer of starfield) {
    ctx.fillStyle = "#cdf";
    for (const s of layer.stars) {
      // Parallax: shift world relative to camera.
      const sx = s.x - camera.x * layer.parallax + viewW / 2;
      const sy = s.y - camera.y * layer.parallax + viewH / 2;
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
