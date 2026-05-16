export function createProjectile({ pos, vel, damage, ttl, radius, color, side, ownerId }) {
  return { pos: { ...pos }, vel: { ...vel }, damage, ttl, radius, color, side, ownerId, dead: false };
}

export function updateProjectile(p, dt) {
  p.pos.x += p.vel.x * dt;
  p.pos.y += p.vel.y * dt;
  p.ttl -= dt;
  if (p.ttl <= 0) p.dead = true;
}

export function drawProjectile(ctx, p) {
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.arc(p.pos.x, p.pos.y, p.radius, 0, Math.PI * 2);
  ctx.fill();
}
