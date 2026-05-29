/**
 * Holographic War Table — DOM/CSS-based starmap for the Frontier roguelite.
 *
 * Self-contained subsystem: creates its own DOM subtree, reads run state
 * from roguelite.js exports, and emits user actions via callbacks wired
 * by input.js.
 *
 * Exports:
 *   createStarmap(mountEl, run)     → control object
 *   updateStarmap(control, run)     → sync data + refresh DOM
 *   destroyStarmap(control)         → remove all DOM, clean listeners
 *   setStarmapCallbacks(control, c) → wire onNodeClick/onAbandon/onClose
 *   centerOnNode(control, id, anim) → pan to node
 *   getPan(control)                 → { x, y }
 *   setPan(control, x, y)           → set pan offset (clamped)
 */

import {
  currentGraph, nodeAt, currentNode, reachableEdges, canEnter,
  ACTS_PER_RUN, COLS_PER_ACT, ROWS_PER_ACT,
  buildNpcRoster, COMMANDER_PERKS, commanderPendingPicks,
} from "./roguelite.js";
import { RACES } from "./races.js";

const NODE_TYPE_LABELS = {
  battle: "Battle",
  elite: "Elite",
  event: "Event",
  resupply: "Resupply",
  boss: "Boss",
};

// ---------------------------------------------------------------------------
// Internal: clampPan utility
// ---------------------------------------------------------------------------
function clampPan(panX, panY, worldW, worldH, viewW, viewH) {
  const minX = viewW - worldW - 80;
  const maxX = 80;
  const minY = viewH - worldH - 80;
  const maxY = 80;
  return {
    x: Math.max(minX, Math.min(maxX, panX)),
    y: Math.max(minY, Math.min(maxY, panY)),
  };
}

// ---------------------------------------------------------------------------
// Internal: Mulberry32 PRNG (matches roguelite.js)
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Internal: node position calculation (grid-based with jitter)
// ---------------------------------------------------------------------------
function nodePositionsFor(graph, seed, worldW, worldH) {
  const rng = mulberry32(seed ^ 0x9e3779b1);
  const padX = worldW * 0.08;
  const padY = worldH * 0.12;
  const innerW = worldW - padX * 2;
  const innerH = worldH - padY * 2;
  const colStep = innerW / Math.max(1, COLS_PER_ACT - 1);
  const rowStep = innerH / Math.max(1, ROWS_PER_ACT + 1);
  const positions = new Map();
  for (const n of graph.nodes) {
    const baseX = padX + n.col * colStep;
    const baseY = padY + (n.row + 1) * rowStep;
    const jitterScale = (n.col === 0 || n.col === COLS_PER_ACT - 1) ? 0.18 : 0.45;
    const jx = (rng() - 0.5) * colStep * jitterScale;
    const jy = (rng() - 0.5) * rowStep * jitterScale;
    positions.set(n.id, { x: baseX + jx, y: baseY + jy });
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Internal: capital ship name helper
// ---------------------------------------------------------------------------
function capitalName(klass) {
  if (klass === "frigate") return "Frigate";
  if (klass === "cruiser") return "Cruiser";
  if (klass === "battleship") return "Battleship";
  if (klass === "carrier") return "Carrier";
  return klass.charAt(0).toUpperCase() + klass.slice(1);
}

// ---------------------------------------------------------------------------
// Internal: SVG quadratic Bezier edge path
// ---------------------------------------------------------------------------
function edgePathD(ax, ay, bx, by, edgeKey) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const seed = (Math.abs(edgeKey) % 100) / 100;
  const bulge = (seed - 0.5) * Math.min(60, len * 0.25);
  const mx = (ax + bx) / 2 + nx * bulge;
  const my = (ay + by) / 2 + ny * bulge;
  return { d: `M ${ax},${ay} Q ${mx},${my} ${bx},${by}`, mx, my };
}

// ---------------------------------------------------------------------------
// Internal: compute world dimensions from viewport
// ---------------------------------------------------------------------------
function worldDimsFromView(viewW, viewH) {
  return {
    worldW: Math.max(viewW * 1.55, 1600),
    worldH: Math.max(viewH * 1.25, 900),
  };
}

// ---------------------------------------------------------------------------
// createStarmap — builds the full DOM tree, returns control object
// ---------------------------------------------------------------------------
export function createStarmap(mountEl, run) {
  // Root container
  const root = document.createElement("div");
  root.id = "starmap-root";
  root.className = "starmap-root";
  root.setAttribute("aria-label", "Frontier campaign tactical map");

  // Background layers
  const bgLayer = document.createElement("div");
  bgLayer.className = "starmap-bg-layer";
  // Drifting nebula clouds — large blurred colour fields that slowly
  // pan, giving the void depth + atmosphere behind the node lattice.
  const nebula = document.createElement("div");
  nebula.className = "starmap-nebula";
  const gridDiv = document.createElement("div");
  gridDiv.className = "starmap-grid";
  const starfield = document.createElement("div");
  starfield.className = "starmap-starfield";
  bgLayer.appendChild(nebula);
  bgLayer.appendChild(gridDiv);
  bgLayer.appendChild(starfield);

  // World container (pannable)
  const world = document.createElement("div");
  world.id = "starmap-world";
  world.className = "starmap-world";

  // SVG edges layer
  const edgesSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  edgesSvg.id = "starmap-edges";
  edgesSvg.classList.add("starmap-edges");
  edgesSvg.setAttribute("aria-hidden", "true");
  edgesSvg.setAttribute("width", "100%");
  edgesSvg.setAttribute("height", "100%");

  // Nodes layer
  const nodesContainer = document.createElement("div");
  nodesContainer.id = "starmap-nodes";
  nodesContainer.className = "starmap-nodes";
  nodesContainer.setAttribute("aria-hidden", "true");

  world.appendChild(edgesSvg);
  world.appendChild(nodesContainer);

  // Header HUD — slim top strip with act + commanding faction +
  // currency chips on the right.
  const header = document.createElement("header");
  header.id = "starmap-header";
  header.className = "starmap-header";
  header.innerHTML = `
    <div class="header-left">
      <div class="header-badge">
        <span class="badge-label">ACT</span>
        <span class="badge-value" id="header-act">1 / 5</span>
      </div>
      <div class="header-faction">
        <span class="faction-label">COMMANDING</span>
        <span class="faction-value" id="header-faction">Terran</span>
      </div>
    </div>
    <div class="header-currencies">
      <div class="cred-chip" title="Credits">
        <span class="cred-icon">$</span>
        <span id="header-credits">0</span>
      </div>
      <div class="fuel-chip" title="Fuel">
        <span class="fuel-icon">⛽</span>
        <span id="header-fuel">0</span>
      </div>
      <button class="header-menu-btn" id="header-menu-btn" title="Menu">⋯</button>
    </div>
  `;

  // Tab content overlay — slides up over the map when a non-map tab
  // is selected. Built once; content rebuilt per tab on switch.
  const tabPanel = document.createElement("div");
  tabPanel.id = "starmap-tab-panel";
  tabPanel.className = "starmap-tab-panel";
  tabPanel.setAttribute("aria-hidden", "true");
  tabPanel.innerHTML = `
    <header class="tab-panel-header">
      <button class="tab-back-btn" id="tab-back-btn" title="Back to map">←</button>
      <h2 class="tab-panel-title" id="tab-panel-title">PANEL</h2>
      <div class="tab-panel-spacer"></div>
    </header>
    <div class="tab-panel-body" id="tab-panel-body"></div>
  `;

  // Bottom tab bar — fixed at the bottom. Each tab opens a fullscreen
  // panel above the map (except MAP which closes the panel).
  const tabBar = document.createElement("nav");
  tabBar.id = "starmap-tab-bar";
  tabBar.className = "starmap-tab-bar";
  tabBar.innerHTML = `
    <button class="tab-btn active" data-tab="map">
      <span class="tab-icon">▣</span>
      <span class="tab-label">MAP</span>
    </button>
    <button class="tab-btn" data-tab="player">
      <span class="tab-icon">★</span>
      <span class="tab-label">PLAYER</span>
    </button>
    <button class="tab-btn" data-tab="commanders">
      <span class="tab-icon">▲</span>
      <span class="tab-label">COMMANDERS</span>
    </button>
    <button class="tab-btn" data-tab="fleet">
      <span class="tab-icon">⊿</span>
      <span class="tab-label">FLEET</span>
    </button>
    <button class="tab-btn" data-tab="factions">
      <span class="tab-icon">◆</span>
      <span class="tab-label">FACTIONS</span>
    </button>
    <button class="tab-btn" data-tab="rivals">
      <span class="tab-icon">⚔</span>
      <span class="tab-label">RIVALS</span>
    </button>
    <button class="tab-btn" data-tab="log">
      <span class="tab-icon">≡</span>
      <span class="tab-label">LOG</span>
    </button>
  `;

  // Overflow menu (popup) for ABANDON / BACK TO MENU / SETTINGS.
  const overflowMenu = document.createElement("div");
  overflowMenu.id = "starmap-overflow";
  overflowMenu.className = "starmap-overflow";
  overflowMenu.setAttribute("aria-hidden", "true");
  overflowMenu.innerHTML = `
    <button class="overflow-item" id="overflow-stats">RUN STATS</button>
    <button class="overflow-item" id="overflow-abandon">ABANDON CAMPAIGN</button>
    <button class="overflow-item" id="overflow-close">BACK TO MAIN MENU</button>
  `;

  // Tooltip
  const tooltip = document.createElement("div");
  tooltip.id = "node-tooltip";
  tooltip.className = "node-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("aria-hidden", "true");
  tooltip.innerHTML = `
    <div class="tooltip-title"></div>
    <div class="tooltip-body"></div>
    <div class="tooltip-cost"></div>
  `;

  // Jump confirmation
  const jumpConfirm = document.createElement("div");
  jumpConfirm.id = "jump-confirm";
  jumpConfirm.className = "jump-confirm";
  jumpConfirm.setAttribute("aria-hidden", "true");
  jumpConfirm.innerHTML = `
    <div class="jump-confirm-text">BEGIN JUMP?</div>
    <div class="jump-confirm-cost"></div>
    <button class="jump-confirm-btn" id="jump-confirm-btn">JUMP</button>
    <button class="jump-cancel-btn" id="jump-cancel-btn">CANCEL</button>
  `;

  // Assemble — header on top, world fills the middle, tabPanel overlay
  // (hidden by default), tab bar pinned to the bottom, overflow popup
  // anchored to the header menu button.
  root.appendChild(bgLayer);
  root.appendChild(world);
  root.appendChild(header);
  root.appendChild(tabPanel);
  root.appendChild(tabBar);
  root.appendChild(overflowMenu);
  root.appendChild(tooltip);
  root.appendChild(jumpConfirm);

  mountEl.appendChild(root);

  // Build control object
  const control = {
    root,
    world,
    edgesSvg,
    nodesContainer,
    header,
    tabPanel,
    tabBar,
    overflowMenu,
    activeTab: "map",
    tooltip,
    jumpConfirm,
    panX: 0,
    panY: 0,
    isDragging: false,
    dragStart: null,
    nodePositions: new Map(),
    callbacks: {},
    run: null,
    hoverNodeId: null,
    selectedNodeId: null,
    // Internal references
    _worldW: 0,
    _worldH: 0,
    _edgeElements: new Map(), // edgeKey → { path, fuelChip }
    _nodeElements: new Map(),  // nodeId → HTMLElement
    _lastViewW: 0,
    _lastViewH: 0,
    _listeners: [],
  };

  // Wire button events
  const addListener = (el, type, fn) => {
    el.addEventListener(type, fn);
    control._listeners.push({ el, type, fn });
  };

  // Bottom tab bar — each tab opens its detail panel (or closes back
  // to the map for the MAP tab).
  for (const btn of tabBar.querySelectorAll(".tab-btn")) {
    addListener(btn, "click", () => {
      setActiveTab(control, btn.dataset.tab);
    });
  }
  // Tab back button — same as tapping MAP.
  addListener(tabPanel.querySelector("#tab-back-btn"), "click", () => {
    setActiveTab(control, "map");
  });
  // Header menu (overflow) button.
  const menuBtn = header.querySelector("#header-menu-btn");
  addListener(menuBtn, "click", (e) => {
    e.stopPropagation();
    const hidden = overflowMenu.getAttribute("aria-hidden") === "true";
    overflowMenu.setAttribute("aria-hidden", hidden ? "false" : "true");
  });
  // Click-away to close overflow.
  addListener(document, "click", (e) => {
    if (overflowMenu.contains(e.target) || menuBtn.contains(e.target)) return;
    overflowMenu.setAttribute("aria-hidden", "true");
  });
  // Overflow menu items.
  addListener(overflowMenu.querySelector("#overflow-stats"), "click", () => {
    overflowMenu.setAttribute("aria-hidden", "true");
    if (control.callbacks.onStats) control.callbacks.onStats();
  });
  addListener(overflowMenu.querySelector("#overflow-abandon"), "click", () => {
    overflowMenu.setAttribute("aria-hidden", "true");
    if (control.callbacks.onAbandon) control.callbacks.onAbandon();
  });
  addListener(overflowMenu.querySelector("#overflow-close"), "click", () => {
    overflowMenu.setAttribute("aria-hidden", "true");
    if (control.callbacks.onClose) control.callbacks.onClose();
  });

  // Jump confirm buttons
  const jumpConfirmBtn = jumpConfirm.querySelector("#jump-confirm-btn");
  const jumpCancelBtn = jumpConfirm.querySelector("#jump-cancel-btn");

  addListener(jumpConfirmBtn, "click", () => {
    if (control._pendingJumpNodeId !== null && control.callbacks.onNodeClick) {
      control.callbacks.onNodeClick({
        nodeId: control._pendingJumpNodeId,
        nodeType: control._pendingJumpNodeType,
      });
    }
    control._pendingJumpNodeId = null;
    control._pendingJumpNodeType = null;
    jumpConfirm.setAttribute("aria-hidden", "true");
  });

  addListener(jumpCancelBtn, "click", () => {
    control._pendingJumpNodeId = null;
    control._pendingJumpNodeType = null;
    jumpConfirm.setAttribute("aria-hidden", "true");
  });

  // Drag / pan handling
  addListener(root, "pointerdown", (e) => {
    // Ignore if on interactive elements (buttons, panels)
    if (e.target.closest(".starmap-fleet-panel")) return;
    if (e.target.closest(".starmap-header")) return;
    if (e.target.closest(".starmap-footer")) return;
    if (e.target.closest(".jump-confirm")) return;
    if (e.target.closest(".node-tooltip")) return;
    if (e.target.closest(".starmap-node")) return; // Nodes handle their own clicks

    control.isDragging = true;
    control.dragStart = {
      x: e.clientX,
      y: e.clientY,
      panX: control.panX,
      panY: control.panY,
    };
    world.classList.add("dragging");
    root.setPointerCapture(e.pointerId);
  });

  addListener(root, "pointermove", (e) => {
    if (!control.isDragging || !control.dragStart) return;
    const dx = e.clientX - control.dragStart.x;
    const dy = e.clientY - control.dragStart.y;

    const rawPanX = control.dragStart.panX + dx;
    const rawPanY = control.dragStart.panY + dy;

    const clamped = clampPan(
      rawPanX, rawPanY,
      control._worldW, control._worldH,
      control._lastViewW, control._lastViewH,
    );

    control.panX = clamped.x;
    control.panY = clamped.y;
    applyPan(control);
  });

  addListener(root, "pointerup", (e) => {
    if (control.isDragging) {
      control.isDragging = false;
      control.dragStart = null;
      world.classList.remove("dragging");
    }
  });

  addListener(root, "pointercancel", (e) => {
    if (control.isDragging) {
      control.isDragging = false;
      control.dragStart = null;
      world.classList.remove("dragging");
    }
  });

  // Prevent context menu on the starmap
  addListener(root, "contextmenu", (e) => e.preventDefault());

  // Initial data sync
  if (run) {
    updateStarmap(control, run);
  }

  return control;
}

// ---------------------------------------------------------------------------
// updateStarmap — sync data from run object and refresh DOM
// ---------------------------------------------------------------------------
export function updateStarmap(control, run) {
  if (!run) return;
  control.run = run;

  const graph = currentGraph(run);
  if (!graph) return;

  // Viewport dims
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  control._lastViewW = viewW;
  control._lastViewH = viewH;

  const { worldW, worldH } = worldDimsFromView(viewW, viewH);
  control._worldW = worldW;
  control._worldH = worldH;

  // Node positions
  const seed = (run.seed >>> 0) + run.act;
  const positions = nodePositionsFor(graph, seed, worldW, worldH);
  control.nodePositions = positions;

  // Determine states
  const reachable = new Set();
  for (const e of graph.edges) {
    if (e.fromId === run.nodePos) reachable.add(e.toId);
  }

  // Build/reuse edge elements
  const neededEdges = new Set();
  for (const e of graph.edges) {
    const edgeKey = `${e.fromId}-${e.toId}`;
    neededEdges.add(edgeKey);

    const a = positions.get(e.fromId);
    const b = positions.get(e.toId);
    if (!a || !b) continue;

    let edgeEl = control._edgeElements.get(edgeKey);

    const isCurrentOut = e.fromId === run.nodePos;
    const isVisited = run.visitedNodeIds.includes(e.fromId) && run.visitedNodeIds.includes(e.toId);
    const edgeState = isCurrentOut ? "available" : isVisited ? "traversed" : "locked";

    if (!edgeEl) {
      // Create new SVG path
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.classList.add("starmap-edge");

      const fuelChip = document.createElement("div");
      fuelChip.className = "fuel-cost-chip";

      control.edgesSvg.appendChild(path);
      control.root.appendChild(fuelChip);

      edgeEl = { path, fuelChip, fromId: e.fromId, toId: e.toId };
      control._edgeElements.set(edgeKey, edgeEl);
    }

    // Update path data and classes
    const { d, mx, my } = edgePathD(a.x, a.y, b.x, b.y, parseInt(edgeKey));
    edgeEl.path.setAttribute("d", d);
    edgeEl.path.setAttribute("class", `starmap-edge edge-${edgeState}`);

    // Fuel cost chip at midpoint for reachable edges
    if (isCurrentOut && e.fuelCost != null) {
      edgeEl.fuelChip.style.left = `${mx}px`;
      edgeEl.fuelChip.style.top = `${my}px`;
      edgeEl.fuelChip.style.display = "block";
      const canAfford = run.resources.fuel >= e.fuelCost;
      edgeEl.fuelChip.textContent = `\u26FD ${e.fuelCost}`;
      edgeEl.fuelChip.className = `fuel-cost-chip${canAfford ? "" : " unaffordable"}`;
    } else {
      edgeEl.fuelChip.style.display = "none";
    }
  }

  // Remove stale edge elements
  for (const [key, edgeEl] of control._edgeElements) {
    if (!neededEdges.has(key)) {
      edgeEl.path.remove();
      edgeEl.fuelChip.remove();
      control._edgeElements.delete(key);
    }
  }

  // Build/reuse node elements
  const neededNodes = new Set();
  for (const n of graph.nodes) {
    neededNodes.add(n.id);
    const p = positions.get(n.id);
    if (!p) continue;

    const isCurrent = n.id === run.nodePos;
    const isVisited = run.visitedNodeIds.includes(n.id);
    const isReachable = reachable.has(n.id);
    const nodeState = isCurrent ? "current" : isVisited ? "visited" : isReachable ? "reachable" : "locked";

    let nodeEl = control._nodeElements.get(n.id);

    if (!nodeEl) {
      nodeEl = createNodeElement(n, p.x, p.y);
      control._nodeElements.set(n.id, nodeEl);
      control.nodesContainer.appendChild(nodeEl);
    }

    // Update position (world space)
    nodeEl.style.left = `${p.x}px`;
    nodeEl.style.top = `${p.y}px`;

    // Update state classes
    nodeEl.className = `starmap-node node-${n.type} node-state-${nodeState}`;
    nodeEl.setAttribute("data-node-id", n.id);
    nodeEl.setAttribute("data-node-type", n.type);

    // ARIA label
    const factionName = n.faction ? (RACES[n.faction]?.name || n.faction) : "";
    const typeLabel = NODE_TYPE_LABELS[n.type] || n.type;
    let label = `${typeLabel} node`;
    if (factionName) label += `, ${factionName}`;
    if (isCurrent) label += `, current position`;
    else if (isVisited) label += `, visited`;
    else if (isReachable) label += `, reachable`;
    else label += `, locked`;
    nodeEl.setAttribute("aria-label", label);

    // Stagger animation via delay (from SPEC: nodeId * 0.3s)
    nodeEl.style.animationDelay = `-${n.id * 0.3}s`;

    // Show/hide chevron for current node
    const chevron = nodeEl.querySelector(".node-chevron");
    if (chevron) {
      chevron.style.display = isCurrent ? "block" : "none";
    }

    // Show/hide visited stamp
    const stamp = nodeEl.querySelector(".node-visited-stamp");
    if (stamp) {
      stamp.style.display = isVisited ? "block" : "none";
    }

    // Click handler
    nodeEl.onclick = (ev) => {
      ev.stopPropagation();
      handleNodeClick(control, n, nodeState);
    };

    // Hover handlers
    nodeEl.onmouseenter = (ev) => {
      showTooltip(control, n, p.x, p.y, nodeState);
    };
    nodeEl.onmouseleave = (ev) => {
      hideTooltip(control);
    };
  }

  // Remove stale node elements
  for (const [id, el] of control._nodeElements) {
    if (!neededNodes.has(id)) {
      el.remove();
      control._nodeElements.delete(id);
    }
  }

  // Update HUD: header
  updateHeader(control, run);

  // Cache the run snapshot so tab switches can re-render without
  // requiring an updateStarmap pass.
  control.run = run;
  // If a non-map tab is currently open, refresh its content.
  if (control.activeTab && control.activeTab !== "map") {
    renderActiveTab(control);
  }

  // Apply pan
  applyPan(control);
}

// ---------------------------------------------------------------------------
// Internal: create a node DOM element
// ---------------------------------------------------------------------------
// Per-type SVG icons for nodes \u2014 drawn inside the glyph layer. Reads
// crisp at any zoom and scales with the node size. (Tier 41 polish.)
const NODE_ICONS = {
  battle:   `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 14 L10 8 L12 10 L18 4 L20 6 L14 12 L16 14 L10 20 Z" fill="currentColor"/></svg>`,
  elite:    `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 2 L14.5 9 L22 9 L16 13.5 L18.5 21 L12 16.5 L5.5 21 L8 13.5 L2 9 L9.5 9 Z" fill="currentColor"/></svg>`,
  boss:     `<svg viewBox="0 0 24 24" width="24" height="24"><path d="M12 2 L21 7 L21 13 C21 18 17 21.5 12 22 C7 21.5 3 18 3 13 L3 7 Z" fill="currentColor"/></svg>`,
  event:    `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 3 A9 9 0 1 1 12 21 A9 9 0 1 1 12 3 M11 7 L13 7 L13 13 L11 13 Z M11 15 L13 15 L13 17 L11 17 Z" fill="currentColor"/></svg>`,
  resupply: `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 8 L20 8 L20 20 L4 20 Z M9 8 L9 4 L15 4 L15 8 M11 12 L11 17 L13 17 L13 12 Z M8 13 L16 13 L16 15 L8 15 Z" fill="currentColor"/></svg>`,
  anomaly:  `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 2 C8 8 16 8 12 14 C8 20 16 20 12 22" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"/></svg>`,
};

// Deterministic per-node hash → drives all visual variation so the
// same node always looks identical across re-renders + save/reload,
// but no two nodes look the same.
function hashNodeId(id) {
  let h = ((id | 0) + 1) * 2654435761;
  h ^= h >>> 15; h = (h * 0x85ebca6b) | 0; h ^= h >>> 13;
  return h >>> 0;
}

// Per-node visual variant. Continuous knobs (hue / scale / speed /
// spin) make every node unique; rolled decoration flags add celestial
// flourishes (orbiting satellite, planetary ring, asteroid speckles,
// star corona). Decoration probabilities are type-aware so each type
// keeps its read while still varying node-to-node.
function nodeVisualVariant(node) {
  const h = hashNodeId(node.id);
  const bit = (n) => ((h >>> n) & 1) === 1;
  const type = node.type;
  const variant = {
    hue: (h % 31) - 15,                     // -15..+15deg hue shift
    scale: 0.82 + ((h >>> 5) % 36) / 100,   // 0.82..1.17
    bobDur: 2.2 + ((h >>> 10) % 20) / 10,   // 2.2..4.1s
    spin: (h >>> 14) % 360,                 // base rotation offset
    orbitDur: 6 + ((h >>> 7) % 9),          // 6..14s orbit period
    ringTilt: (h % 120) - 60,               // -60..+60deg ring tilt
    orbitRev: bit(9),                       // orbit direction
    ring: false, orbit: false, speckle: false, corona: false,
  };
  switch (type) {
    case "boss":     variant.ring = true;  variant.corona = true; variant.orbit = bit(2); break;
    case "elite":    variant.corona = true; variant.orbit = bit(3); variant.ring = bit(8); break;
    case "resupply": variant.ring = true;  variant.orbit = bit(3); break;
    case "battle":   variant.corona = bit(2); variant.speckle = bit(4); variant.orbit = bit(6); break;
    case "event":
    case "anomaly":  variant.orbit = bit(2); variant.speckle = bit(5); break;
    default:         variant.orbit = bit(2); break;
  }
  return variant;
}

function createNodeElement(node, x, y) {
  const el = document.createElement("div");
  el.className = `starmap-node node-${node.type}`;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;

  // Stamp per-node visual variant as CSS custom properties + decoration
  // flag classes. The CSS reads these to vary hue / size / speed and
  // toggle the decoration layers below.
  const v = nodeVisualVariant(node);
  el.style.setProperty("--node-hue", `${v.hue}deg`);
  el.style.setProperty("--node-scale", v.scale.toFixed(3));
  el.style.setProperty("--node-bob-dur", `${v.bobDur.toFixed(2)}s`);
  el.style.setProperty("--node-spin", `${v.spin}deg`);
  el.style.setProperty("--orbit-dur", `${v.orbitDur}s`);
  el.style.setProperty("--ring-tilt", `${v.ringTilt}deg`);
  if (v.orbitRev) el.classList.add("node-orbit-rev");

  const glow = document.createElement("div");
  glow.className = "node-glow";

  const core = document.createElement("div");
  core.className = "node-core";

  const glyph = document.createElement("div");
  glyph.className = "node-glyph";
  // Inject per-type SVG icon. Falls back to a small dot if the type
  // isn't in the icon table (defensive \u2014 keeps the layout valid).
  glyph.innerHTML = NODE_ICONS[node.type] || `<svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="6" fill="currentColor"/></svg>`;

  const ring = document.createElement("div");
  ring.className = "node-ring";

  // Boss/elite/ace flag \u2014 small label below the node so the player
  // can read what's there without hovering for the tooltip.
  const flag = document.createElement("div");
  flag.className = "node-flag";
  if (node.type === "boss") {
    flag.textContent = node.bossName || "BOSS";
  } else if (node.aceName) {
    flag.textContent = node.aceName;
  } else if (node.type === "elite") {
    flag.textContent = "ELITE";
  } else if (node.type === "resupply" && node.vendor) {
    flag.textContent = (node.vendor.label || "RESUPPLY").toUpperCase();
  } else {
    flag.textContent = "";
    flag.style.display = "none";
  }

  const stamp = document.createElement("div");
  stamp.className = "node-visited-stamp";
  stamp.style.display = "none";

  const chevron = document.createElement("div");
  chevron.className = "node-chevron";
  chevron.textContent = "\u25BC YOU ARE HERE";
  chevron.style.display = "none";

  el.appendChild(glow);
  // Star corona — radiating spikes behind the core (stars / bosses).
  if (v.corona) {
    const corona = document.createElement("div");
    corona.className = "node-corona";
    el.appendChild(corona);
  }
  // Planetary ring — tilted ellipse around the body (gas giants / depots).
  if (v.ring) {
    const pring = document.createElement("div");
    pring.className = "node-pring";
    el.appendChild(pring);
  }
  el.appendChild(core);
  // Asteroid speckles — a few drifting motes around the node.
  if (v.speckle) {
    const speck = document.createElement("div");
    speck.className = "node-speckles";
    el.appendChild(speck);
  }
  el.appendChild(glyph);
  el.appendChild(ring);
  // Orbiting satellite — a small body revolving around the node.
  if (v.orbit) {
    const orbit = document.createElement("div");
    orbit.className = "node-orbit";
    const dot = document.createElement("i");
    dot.className = "node-orbit-dot";
    orbit.appendChild(dot);
    el.appendChild(orbit);
  }
  el.appendChild(flag);
  el.appendChild(stamp);
  el.appendChild(chevron);

  return el;
}

// ---------------------------------------------------------------------------
// Internal: handle node click
// ---------------------------------------------------------------------------
function handleNodeClick(control, node, nodeState) {
  if (nodeState === "locked" || nodeState === "visited") return;
  if (nodeState === "current") return;

  if (nodeState === "reachable") {
    const run = control.run;
    if (!run) return;

    // Find the edge to get fuel cost
    const graph = currentGraph(run);
    if (!graph) return;
    const edge = graph.edges.find((e) => e.fromId === run.nodePos && e.toId === node.id);
    const fuelCost = edge ? edge.fuelCost : 1;

    // Show jump confirmation
    control._pendingJumpNodeId = node.id;
    control._pendingJumpNodeType = node.type;

    const costEl = control.jumpConfirm.querySelector(".jump-confirm-cost");
    costEl.textContent = `FUEL COST: ${fuelCost}`;

    control.jumpConfirm.setAttribute("aria-hidden", "false");
  }
}

// ---------------------------------------------------------------------------
// Internal: tooltip show/hide
// ---------------------------------------------------------------------------
function showTooltip(control, node, x, y, nodeState) {
  const run = control.run;
  if (!run) return;

  const titleEl = control.tooltip.querySelector(".tooltip-title");
  const bodyEl = control.tooltip.querySelector(".tooltip-body");
  const costEl = control.tooltip.querySelector(".tooltip-cost");

  // Type label with faction
  const factionName = node.faction ? (RACES[node.faction]?.name || node.faction) : "";
  const typeLabel = NODE_TYPE_LABELS[node.type] || node.type;
  titleEl.textContent = `${typeLabel}${factionName ? ` — ${factionName}` : ""}`;

  // Description based on type
  const descriptions = {
    battle: "Enemy scouts detected.",
    elite: "Elite target spotted.",
    event: "Strange signal detected.",
    resupply: "A resupply depot awaits.",
    boss: "Boss ahead — extreme danger.",
  };
  bodyEl.textContent = descriptions[node.type] || "Uncharted system.";

  // Fuel cost for reachable nodes
  if (nodeState === "reachable") {
    const graph = currentGraph(run);
    const edge = graph?.edges.find((e) => e.fromId === run.nodePos && e.toId === node.id);
    if (edge) {
      const canAfford = run.resources.fuel >= edge.fuelCost;
      costEl.textContent = `\u26FD Jump cost: ${edge.fuelCost} fuel`;
      costEl.className = `tooltip-cost${canAfford ? "" : " unaffordable"}`;
    } else {
      costEl.textContent = "";
    }
  } else if (nodeState === "current") {
    costEl.textContent = "Current position";
    costEl.className = "tooltip-cost";
  } else {
    costEl.textContent = "";
  }

  // Position tooltip near the node (convert world to screen space)
  const screenX = x + control.panX;
  const screenY = y + control.panY;

  control.tooltip.style.left = `${screenX + 30}px`;
  control.tooltip.style.top = `${screenY - 20}px`;
  control.tooltip.setAttribute("aria-hidden", "false");
}

function hideTooltip(control) {
  control.tooltip.setAttribute("aria-hidden", "true");
}

// ---------------------------------------------------------------------------
// Internal: update header HUD from run data
// ---------------------------------------------------------------------------
function updateHeader(control, run) {
  const actEl = control.header.querySelector("#header-act");
  const factionEl = control.header.querySelector("#header-faction");
  const creditsEl = control.header.querySelector("#header-credits");
  const fuelEl = control.header.querySelector("#header-fuel");

  actEl.textContent = `${run.act} / ${ACTS_PER_RUN}`;

  const raceInfo = RACES[run.faction];
  const factionName = raceInfo ? raceInfo.name : run.faction;
  factionEl.textContent = factionName;

  // Apply faction accent color
  if (raceInfo && raceInfo.accent) {
    factionEl.style.color = raceInfo.accent;
  }

  creditsEl.textContent = String(run.resources.credits);
  fuelEl.textContent = String(run.resources.fuel);
}

// ---------------------------------------------------------------------------
// Tab system (Tier 41) \u2014 bottom tab bar + fullscreen tab panel.
// activeTab="map" hides the panel; other tabs render content into
// #tab-panel-body via the per-tab renderer below.
// ---------------------------------------------------------------------------

function setActiveTab(control, tabKey) {
  control.activeTab = tabKey;
  // Toggle .active state on tab buttons.
  for (const btn of control.tabBar.querySelectorAll(".tab-btn")) {
    btn.classList.toggle("active", btn.dataset.tab === tabKey);
  }
  if (tabKey === "map") {
    control.tabPanel.setAttribute("aria-hidden", "true");
    control.tabPanel.classList.remove("open");
    return;
  }
  control.tabPanel.setAttribute("aria-hidden", "false");
  control.tabPanel.classList.add("open");
  // Re-render content using the cached run snapshot.
  renderActiveTab(control);
}

function renderActiveTab(control) {
  if (!control.run) return;
  const title = control.tabPanel.querySelector("#tab-panel-title");
  const body = control.tabPanel.querySelector("#tab-panel-body");
  const run = control.run;
  switch (control.activeTab) {
    case "player":     title.textContent = "PLAYER";     renderPlayerTab(body, run); break;
    case "commanders": title.textContent = "COMMANDERS"; renderCommandersTab(body, run, control); break;
    case "fleet":      title.textContent = "FLEET";      renderFleetTab(body, run); break;
    case "factions":   title.textContent = "FACTIONS";   renderFactionsTab(body, run); break;
    case "rivals":     title.textContent = "RIVALS";     renderRivalsTab(body, run); break;
    case "log":        title.textContent = "CAREER LOG"; renderLogTab(body, run); break;
    default: break;
  }
}

function renderPlayerTab(body, run) {
  const st = run.stats || {};
  const totalKills = Object.values(st.shipsKilled || {}).reduce((a, b) => a + b, 0);
  const totalLost  = Object.values(st.shipsLost   || {}).reduce((a, b) => a + b, 0);
  const traitChips = (run.traits || []).map((k) => `<span class="td-chip">${k}</span>`).join("") || '<span class="td-muted">No traits yet</span>';
  body.innerHTML = `
    <div class="td-card">
      <div class="td-eyebrow">OFFICER</div>
      <div class="td-headline">${(run.callsign || "UNKNOWN").toUpperCase()}</div>
      <div class="td-sub">Act ${run.act}/5 \u00B7 ${(run.visitedNodeIds || []).length} jumps</div>
    </div>
    <div class="td-grid-2">
      <div class="td-card">
        <div class="td-eyebrow">CREDITS</div>
        <div class="td-bignum">${run.resources && run.resources.credits || 0}</div>
      </div>
      <div class="td-card">
        <div class="td-eyebrow">FUEL</div>
        <div class="td-bignum">${run.resources && run.resources.fuel || 0}</div>
      </div>
    </div>
    <div class="td-card">
      <div class="td-eyebrow">OFFICER TRAITS</div>
      <div class="td-chips">${traitChips}</div>
    </div>
    <div class="td-card">
      <div class="td-eyebrow">CAREER STATS</div>
      <div class="td-statgrid">
        <div><span>Nodes cleared</span><b>${st.nodesCleared || 0}</b></div>
        <div><span>Bosses killed</span><b>${st.bossesKilled || 0}</b></div>
        <div><span>Ships destroyed</span><b>${totalKills}</b></div>
        <div><span>Ships lost</span><b>${totalLost}</b></div>
        <div><span>Credits earned</span><b>${st.creditsEarned || 0}</b></div>
        <div><span>Promotions</span><b>${st.promotionsEarned || 0}</b></div>
      </div>
    </div>
  `;
}

function renderCommandersTab(body, run, control) {
  const caps = run.capitals || [];
  const wings = [
    ...(run.fighterWings || []).map((w) => ({ w, craft: "fighter" })),
    ...(run.bomberWings || []).map((w) => ({ w, craft: "bomber" })),
  ].filter((x) => x.w.commander);
  if (caps.length === 0 && wings.length === 0) {
    body.innerHTML = `<div class="td-empty">No commanders in service.</div>`;
    return;
  }
  const stars = (level) => level > 1 ? "\u2605".repeat(Math.min(5, level - 1)) : "";
  const perkChips = (perks) => {
    const chips = (perks || []).map((k) => {
      const p = COMMANDER_PERKS[k];
      return p ? `<span class="td-perk-chip" title="${p.blurb}">${p.name}</span>` : "";
    }).join("");
    return chips ? `<div class="td-perk-row">${chips}</div>` : "";
  };
  // Inline perk-pick buttons when a commander has an unspent pick.
  const pickUI = (refAttrs, c) => {
    if (!c || !(c.pendingPerks > 0) || !Array.isArray(c.perkDraw) || !c.perkDraw.length) return "";
    const btns = c.perkDraw.map((k) => {
      const p = COMMANDER_PERKS[k];
      if (!p) return "";
      return `<button class="td-perk-pick" ${refAttrs} data-perk="${k}">
        <span class="td-perk-pick-name">${p.name}</span>
        <span class="td-perk-pick-blurb">${p.blurb}</span></button>`;
    }).join("");
    return `<div class="td-perk-pick-label">CHOOSE A PERK</div><div class="td-perk-pick-row">${btns}</div>`;
  };

  let html = "";
  const pending = commanderPendingPicks(run);
  if (pending > 0) {
    html += `<div class="td-perk-banner">${pending} perk pick${pending === 1 ? "" : "s"} ready \u2014 choose below.</div>`;
  }
  // Capital captains.
  for (const cap of caps) {
    const klassLabel = capitalName(cap.klass);
    const hpPct = Math.round((cap.hpFrac || 0) * 100);
    const hpClass = cap.hpFrac > 0.6 ? "hp-high" : cap.hpFrac > 0.3 ? "hp-mid" : "hp-low";
    const refAttrs = `data-ref-kind="capital" data-ref-id="${cap.instanceId}"`;
    html += `
      <div class="td-row td-row-cmd td-row-tap" data-tap-kind="capital" data-tap-id="${cap.instanceId}">
        <div class="td-row-head">
          <span class="td-row-name">${cap.name || klassLabel}</span>
          ${stars(cap.level || 1) ? `<span class="td-row-rank">${stars(cap.level || 1)}</span>` : ""}
          <span class="td-row-pct">${hpPct}%</span>
          <span class="td-row-chev">›</span>
        </div>
        <div class="td-row-sub">
          <span class="td-row-class">${klassLabel.toUpperCase()}</span>
          ${cap.captain ? `<span class="td-row-captain">${cap.captain}</span>` : ""}
          ${cap.captainTraitLabel ? `<span class="td-row-trait">${cap.captainTraitLabel}</span>` : ""}
        </div>
        ${perkChips(cap.perks)}
        <div class="td-row-hpbar"><div class="td-row-hpfill ${hpClass}" style="width:${hpPct}%"></div></div>
        ${pickUI(refAttrs, cap)}
      </div>`;
  }
  // Wing commanders (fighter + bomber wings).
  for (const { w, craft } of wings) {
    const c = w.commander;
    const refAttrs = `data-ref-kind="wing" data-ref-craft="${craft}" data-ref-wing="${w.id}"`;
    html += `
      <div class="td-row td-row-cmd td-row-wingcmd td-row-tap" data-tap-kind="wing" data-tap-craft="${craft}" data-tap-wing="${w.id}">
        <div class="td-row-head">
          <span class="td-row-name">${c.name}</span>
          ${stars(c.level || 1) ? `<span class="td-row-rank">${stars(c.level || 1)}</span>` : ""}
          <span class="td-row-chev">›</span>
        </div>
        <div class="td-row-sub">
          <span class="td-row-class">${w.name.toUpperCase()} WING \u00b7 ${craft.toUpperCase()}</span>
          ${c.traitLabel ? `<span class="td-row-trait">${c.traitLabel}</span>` : ""}
        </div>
        ${perkChips(c.perks)}
        ${pickUI(refAttrs, c)}
      </div>`;
  }
  body.innerHTML = html;
  // Whole row \u2192 full commander detail overlay (capital captain OR wing
  // commander). Perk-pick buttons inside the row stopPropagation so they
  // don't also open the detail.
  for (const row of body.querySelectorAll(".td-row-tap")) {
    row.addEventListener("click", () => {
      const cb = control.callbacks;
      if (!cb) return;
      if (row.dataset.tapKind === "capital") {
        const id = parseInt(row.dataset.tapId, 10);
        if (Number.isFinite(id) && cb.onCapitalClick) cb.onCapitalClick(id);
      } else if (row.dataset.tapKind === "wing" && cb.onWingCommanderClick) {
        cb.onWingCommanderClick(row.dataset.tapCraft, row.dataset.tapWing);
      }
    });
  }
  // Perk-pick buttons \u2192 onPickPerk(ref, perkKey).
  for (const btn of body.querySelectorAll(".td-perk-pick")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const perk = btn.dataset.perk;
      const ref = btn.dataset.refKind === "capital"
        ? { kind: "capital", id: parseInt(btn.dataset.refId, 10) }
        : { kind: "wing", craft: btn.dataset.refCraft, wingId: btn.dataset.refWing };
      if (control.callbacks && control.callbacks.onPickPerk) control.callbacks.onPickPerk(ref, perk);
    });
  }
}

function renderFleetTab(body, run) {
  const passengers = (run.passengers || []).map((p) => `
    <div class="td-row td-row-passenger">
      <div class="td-row-head">
        <span class="td-row-name">${p.name}</span>
        <span class="td-row-pct">${p.jumpsLeft} jump${p.jumpsLeft === 1 ? "" : "s"} left</span>
      </div>
      <div class="td-row-sub"><span class="td-row-detail">${p.description || ""}</span></div>
    </div>
  `).join("") || `<div class="td-empty">No passengers aboard.</div>`;
  const contracts = ((run.contracts || []).filter(c => c.status === "active")).map((c) => `
    <div class="td-row td-row-contract">
      <div class="td-row-head">
        <span class="td-row-name">${c.name}</span>
        <span class="td-row-pct">${c.jumpsLeft} left</span>
      </div>
      <div class="td-row-sub"><span class="td-row-detail">${c.description || ""}</span></div>
    </div>
  `).join("") || `<div class="td-empty">No active contracts.</div>`;
  const boons = (run.boons || []).map((b) => `
    <div class="td-row td-row-boon">
      <div class="td-row-head"><span class="td-row-name">${b.desc || b.key}</span></div>
    </div>
  `).join("") || `<div class="td-empty">No boons acquired.</div>`;
  body.innerHTML = `
    <div class="td-grid-2">
      <div class="td-card">
        <div class="td-eyebrow">FIGHTERS</div>
        <div class="td-bignum">${run.smallCraft && run.smallCraft.fighter || 0}</div>
      </div>
      <div class="td-card">
        <div class="td-eyebrow">BOMBERS</div>
        <div class="td-bignum">${run.smallCraft && run.smallCraft.bomber || 0}</div>
      </div>
    </div>
    <div class="td-card">
      <div class="td-eyebrow">PASSENGERS</div>
      ${passengers}
    </div>
    <div class="td-card">
      <div class="td-eyebrow">CONTRACTS</div>
      ${contracts}
    </div>
    <div class="td-card">
      <div class="td-eyebrow">BOONS</div>
      ${boons}
    </div>
  `;
}

function renderFactionsTab(body, run) {
  const labels = { coalition: "COALITION", hegemony: "HEGEMONY", reavers: "REAVERS", voidsworn: "VOIDSWORN" };
  const rep = run.reputation || {};
  let html = "";
  for (const key of ["coalition", "hegemony", "reavers", "voidsworn"]) {
    const v = rep[key] || 0;
    const pct = Math.round((v + 100) / 2); // -100..+100 \u2192 0..100
    const tone = v >= 30 ? "ally" : (v <= -30 ? "rival" : "neutral");
    const label = v >= 70 ? "Allied" : v >= 30 ? "Friendly" : v >= -10 ? "Neutral" : v >= -50 ? "Hostile" : "Marked";
    html += `
      <div class="td-faction-row td-faction-${tone}">
        <div class="td-faction-head">
          <span class="td-faction-name">${labels[key]}</span>
          <span class="td-faction-value">${label} \u00B7 ${v > 0 ? "+" : ""}${v}</span>
        </div>
        <div class="td-faction-bar">
          <div class="td-faction-axis"></div>
          <div class="td-faction-fill" style="left:${pct}%"></div>
        </div>
      </div>
    `;
  }
  body.innerHTML = html;
}

function renderRivalsTab(body, run) {
  const rivalsHtml = (run.rivals || []).map((r) => {
    const status = r.status || "active";
    const tone = status === "active" ? "rival" : (status === "defeated" ? "memorial" : "note");
    const statusLabel = status === "active" ? "ACTIVE TARGET" : status === "defeated" ? `DOWN \u00B7 ACT ${r.defeatedAct || "?"}` : status.toUpperCase();
    return `
      <div class="td-row td-row-rival td-tone-${tone}">
        <div class="td-row-head">
          <span class="td-row-name">${r.name}</span>
          <span class="td-row-pct">${statusLabel}</span>
        </div>
        <div class="td-row-sub"><span class="td-row-detail">${r.motivation || ""}</span></div>
      </div>
    `;
  }).join("");
  const wingHtml = (run.wingRoster || []).slice(-12).reverse().map((p) => `
    <div class="td-row td-row-wing">
      <div class="td-row-head">
        <span class="td-row-name">${p.name}</span>
        <span class="td-row-pct">${(p.role || "Wing pilot").toUpperCase()}</span>
      </div>
    </div>
  `).join("") || `<div class="td-empty">No wing pilots yet.</div>`;
  body.innerHTML = `
    <div class="td-card">
      <div class="td-eyebrow">MARKED RIVALS</div>
      ${rivalsHtml || `<div class="td-empty">No rivals on record.</div>`}
    </div>
    <div class="td-card">
      <div class="td-eyebrow">WING ROSTER</div>
      ${wingHtml}
    </div>
  `;
}

function renderLogTab(body, run) {
  const log = run.log || [];
  if (log.length === 0) {
    body.innerHTML = `<div class="td-empty">Career log empty.</div>`;
    return;
  }
  const items = log.slice().reverse().map((l) => {
    const kind = String(l.kind || "note");
    return `<li class="td-log-line td-log-${kind}"><span class="td-log-act">A${l.act}</span> ${l.text}</li>`;
  }).join("");
  body.innerHTML = `<ul class="td-log-list">${items}</ul>`;
}

// ---------------------------------------------------------------------------
// Internal: apply pan transform to world container
// ---------------------------------------------------------------------------
function applyPan(control) {
  control.world.style.transform = `translate(${control.panX}px, ${control.panY}px)`;
}

// ---------------------------------------------------------------------------
// destroyStarmap — remove all DOM, clean listeners
// ---------------------------------------------------------------------------
export function destroyStarmap(control) {
  if (!control) return;

  // Remove all registered event listeners
  for (const { el, type, fn } of control._listeners) {
    el.removeEventListener(type, fn);
  }
  control._listeners = [];

  // Remove root from DOM
  if (control.root && control.root.parentNode) {
    control.root.parentNode.removeChild(control.root);
  }

  // Clear edge fuel chips that may be siblings of root
  for (const [, edgeEl] of control._edgeElements) {
    if (edgeEl.fuelChip && edgeEl.fuelChip.parentNode) {
      edgeEl.fuelChip.parentNode.removeChild(edgeEl.fuelChip);
    }
  }
  control._edgeElements.clear();
  control._nodeElements.clear();

  // Null out references
  control.root = null;
  control.world = null;
  control.edgesSvg = null;
  control.nodesContainer = null;
  control.header = null;
  control.tabPanel = null;
  control.tabBar = null;
  control.overflowMenu = null;
  control.tooltip = null;
  control.jumpConfirm = null;
}

// ---------------------------------------------------------------------------
// setStarmapCallbacks
// ---------------------------------------------------------------------------
export function setStarmapCallbacks(control, callbacks) {
  if (!control) return;
  control.callbacks = { ...control.callbacks, ...callbacks };
}

// ---------------------------------------------------------------------------
// centerOnNode — pan to center a specific node in the viewport
// ---------------------------------------------------------------------------
export function centerOnNode(control, nodeId, animate = true) {
  if (!control || !control.nodePositions) return;
  const p = control.nodePositions.get(nodeId);
  if (!p) return;

  const viewW = control._lastViewW || window.innerWidth;
  const viewH = control._lastViewH || window.innerHeight;

  // Account for fleet panel width in centering
  const fleetPanelWidth = parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue("--fleet-panel-width")) || 300;
  const visibleCenterX = (viewW - fleetPanelWidth) / 2;
  const visibleCenterY = viewH / 2;

  const targetPanX = visibleCenterX - p.x;
  const targetPanY = visibleCenterY - p.y;

  const clamped = clampPan(
    targetPanX, targetPanY,
    control._worldW, control._worldH,
    viewW, viewH,
  );

  if (animate) {
    control.world.style.transition = "transform 0.5s ease-out";
    setTimeout(() => {
      if (control.world) control.world.style.transition = "";
    }, 500);
  }

  control.panX = clamped.x;
  control.panY = clamped.y;
  applyPan(control);
}

// ---------------------------------------------------------------------------
// getPan / setPan
// ---------------------------------------------------------------------------
export function getPan(control) {
  if (!control) return { x: 0, y: 0 };
  return { x: control.panX, y: control.panY };
}

export function setPan(control, x, y) {
  if (!control) return;

  const viewW = control._lastViewW || window.innerWidth;
  const viewH = control._lastViewH || window.innerHeight;

  const clamped = clampPan(
    x, y,
    control._worldW, control._worldH,
    viewW, viewH,
  );

  control.panX = clamped.x;
  control.panY = clamped.y;
  applyPan(control);
}