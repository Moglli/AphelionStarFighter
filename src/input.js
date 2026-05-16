// Input sources: virtual joysticks for touch, plus WASD + mouse + Enter
// for desktop play. The aim direction is computed relative to canvas
// center because the camera follows the player ship, so center == player.

const DEADZONE = 0.15;

export class VirtualStick {
  constructor({ side, color }) {
    this.side = side; // "left" or "right"
    this.color = color;
    this.pointerId = null;
    this.center = { x: 0, y: 0 };  // screen-space center where finger landed
    this.knob = { x: 0, y: 0 };    // current finger pos
    this.radius = 70;              // max knob travel
    this.active = false;
    this.value = { x: 0, y: 0 };   // normalized -1..1
  }

  // Hit test: is this pointer in our half of the screen?
  claims(x, w) {
    return this.side === "left" ? x < w / 2 : x >= w / 2;
  }

  start(pointerId, x, y) {
    this.pointerId = pointerId;
    this.center = { x, y };
    this.knob = { x, y };
    this.active = true;
    this.value = { x: 0, y: 0 };
  }

  move(x, y) {
    let dx = x - this.center.x;
    let dy = y - this.center.y;
    const l = Math.hypot(dx, dy);
    if (l > this.radius) { dx = (dx / l) * this.radius; dy = (dy / l) * this.radius; }
    this.knob = { x: this.center.x + dx, y: this.center.y + dy };
    const nx = dx / this.radius;
    const ny = dy / this.radius;
    const nlen = Math.hypot(nx, ny);
    this.value = nlen < DEADZONE ? { x: 0, y: 0 } : { x: nx, y: ny };
  }

  end() {
    this.pointerId = null;
    this.active = false;
    this.value = { x: 0, y: 0 };
  }

  draw(ctx) {
    if (!this.active) return;
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(this.center.x, this.center.y, this.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(this.knob.x, this.knob.y, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

export class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.left = new VirtualStick({ side: "left", color: "#5cf" });
    this.right = new VirtualStick({ side: "right", color: "#f76" });

    // Desktop input state.
    this.keys = new Set();
    this.mouse = { x: 0, y: 0 };
    this.mouseInside = false;
    this.mouseDown = false;

    const opts = { passive: false };
    canvas.addEventListener("pointerdown", (e) => this.onDown(e), opts);
    canvas.addEventListener("pointermove", (e) => this.onMove(e), opts);
    canvas.addEventListener("pointerup", (e) => this.onUp(e), opts);
    canvas.addEventListener("pointercancel", (e) => this.onUp(e), opts);
    canvas.addEventListener("pointerenter", () => { this.mouseInside = true; });
    canvas.addEventListener("pointerleave", () => { this.mouseInside = false; });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    // Prevent gestures / scroll on touch.
    canvas.style.touchAction = "none";

    // Keyboard — listen on window so focus on the canvas isn't required.
    const TRAPPED = new Set(["Space", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (TRAPPED.has(e.code)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => { this.keys.delete(e.code); });
    window.addEventListener("blur", () => { this.keys.clear(); });
  }

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onDown(e) {
    e.preventDefault();
    const { x, y } = this.pos(e);
    this.mouse.x = x; this.mouse.y = y; this.mouseInside = true;
    if (e.pointerType === "touch") {
      this.canvas.setPointerCapture(e.pointerId);
      const w = this.canvas.clientWidth;
      if (this.left.claims(x, w) && this.left.pointerId === null) {
        this.left.start(e.pointerId, x, y);
      } else if (this.right.claims(x, w) && this.right.pointerId === null) {
        this.right.start(e.pointerId, x, y);
      }
    } else {
      this.mouseDown = true;
    }
  }
  onMove(e) {
    const { x, y } = this.pos(e);
    this.mouse.x = x; this.mouse.y = y;
    if (this.left.pointerId === e.pointerId) this.left.move(x, y);
    else if (this.right.pointerId === e.pointerId) this.right.move(x, y);
  }
  onUp(e) {
    if (this.left.pointerId === e.pointerId) this.left.end();
    else if (this.right.pointerId === e.pointerId) this.right.end();
    if (e.pointerType !== "touch") this.mouseDown = false;
  }

  // True if Enter was pressed *since* the last poll (edge-triggered).
  // Used by main.js to handle match-restart on Enter.
  consumeEnterPress() {
    if (this.keys.has("Enter") && !this._enterLatched) {
      this._enterLatched = true;
      return true;
    }
    if (!this.keys.has("Enter")) this._enterLatched = false;
    return false;
  }

  // Build a controller snapshot for the player ship. Combines touch sticks,
  // keyboard (WASD / arrows), and mouse-aim into a single {thrust, aim, firing}.
  controller() {
    // Touch sticks
    const touchThrust = this.left.value;
    const touchAim = this.right.value;
    const touchAimLen = Math.hypot(touchAim.x, touchAim.y);
    const touchHasThrust = Math.hypot(touchThrust.x, touchThrust.y) > 0;

    // Keyboard thrust (WASD primary; arrows also accepted)
    let kx = 0, ky = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp"))    ky -= 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown"))  ky += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft"))  kx -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) kx += 1;
    const kLen = Math.hypot(kx, ky);
    const kbThrust = kLen > 0 ? { x: kx / kLen, y: ky / kLen } : { x: 0, y: 0 };

    // Mouse aim: vector from canvas center (player ship) to cursor.
    let mouseAim = null;
    if (this.mouseInside) {
      const cx = this.canvas.clientWidth / 2;
      const cy = this.canvas.clientHeight / 2;
      const dx = this.mouse.x - cx;
      const dy = this.mouse.y - cy;
      if (Math.hypot(dx, dy) > 4) mouseAim = { x: dx, y: dy };
    }

    // Thrust: keyboard wins if pressed, else touch.
    const thrust = kLen > 0 ? kbThrust : (touchHasThrust ? touchThrust : { x: 0, y: 0 });

    // Aim priority: touch right stick > mouse > thrust direction (auto-aim).
    let aim;
    if (touchAimLen > 0) aim = touchAim;
    else if (mouseAim) aim = mouseAim;
    else if (kLen > 0) aim = kbThrust;
    else aim = null;

    // Firing: explicit only — Enter, Space, mouse button, or touch right stick.
    const firing = this.keys.has("Enter") || this.keys.has("Space")
                || this.mouseDown || touchAimLen > 0;

    return { thrust, aim, firing };
  }

  drawSticks(ctx) {
    this.left.draw(ctx);
    this.right.draw(ctx);
  }
}
