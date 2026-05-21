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
  const gridDiv = document.createElement("div");
  gridDiv.className = "starmap-grid";
  const starfield = document.createElement("div");
  starfield.className = "starmap-starfield";
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

  // Fleet panel (right sidebar)
  const fleetPanel = document.createElement("aside");
  fleetPanel.id = "starmap-fleet-panel";
  fleetPanel.className = "starmap-fleet-panel";
  fleetPanel.setAttribute("aria-label", "Fleet status");
  fleetPanel.innerHTML = `
    <header class="fleet-panel-header">FLEET ROSTER</header>
    <div class="fleet-panel-capitals" id="fleet-capitals"></div>
    <div class="fleet-panel-divider"></div>
    <div class="fleet-panel-craft" id="fleet-craft"></div>
    <div class="fleet-panel-boons" id="fleet-boons"></div>
  `;

  // Header HUD
  const header = document.createElement("header");
  header.id = "starmap-header";
  header.className = "starmap-header";
  header.innerHTML = `
    <div class="header-badge">
      <span class="badge-label">CURRENT ACT</span>
      <span class="badge-value" id="header-act">1 / 3</span>
    </div>
    <div class="header-faction">
      <span class="faction-label">COMMANDING</span>
      <span class="faction-value" id="header-faction">Terran</span>
    </div>
    <div class="header-currencies">
      <div class="cred-chip">
        <span class="cred-icon">$</span>
        <span id="header-credits">0</span>
      </div>
      <div class="fuel-chip">
        <span class="fuel-icon">R</span>
        <span id="header-fuel">0</span>
      </div>
    </div>
  `;

  // Footer buttons
  const footer = document.createElement("footer");
  footer.className = "starmap-footer";

  const abandonBtn = document.createElement("button");
  abandonBtn.id = "starmap-abandon";
  abandonBtn.className = "starmap-btn abandon-btn";
  abandonBtn.textContent = "ABANDON CAMPAIGN";

  const closeBtn = document.createElement("button");
  closeBtn.id = "starmap-close";
  closeBtn.className = "starmap-btn close-btn";
  closeBtn.textContent = "BACK TO MENU";

  footer.appendChild(abandonBtn);
  footer.appendChild(closeBtn);

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

  // Assemble
  root.appendChild(bgLayer);
  root.appendChild(world);
  root.appendChild(fleetPanel);
  root.appendChild(header);
  root.appendChild(footer);
  root.appendChild(tooltip);
  root.appendChild(jumpConfirm);

  mountEl.appendChild(root);

  // Build control object
  const control = {
    root,
    world,
    edgesSvg,
    nodesContainer,
    fleetPanel,
    header,
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

  addListener(abandonBtn, "click", () => {
    if (control.callbacks.onAbandon) control.callbacks.onAbandon();
  });

  addListener(closeBtn, "click", () => {
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

      edgesSvg = control.edgesSvg;
      edgesSvg.appendChild(path);
      control.root.appendChild(fuelChip);

      edgeEl = { path, fuelChip, fromId: e.fromId, toId: e.toId };
      control._edgeElements.set(edgeKey, edgeEl);
    }

    // Update path data and classes
    const { d, mx, my } = edgePathD(a.x, a.y, b.x, b.y, parseInt(edgeKey));
    edgeEl.path.setAttribute("d", d);
    edgeEl.path.className = `starmap-edge edge-${edgeState}`;

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

  // Update HUD: fleet panel
  updateFleetPanel(control, run);

  // Apply pan
  applyPan(control);
}

// ---------------------------------------------------------------------------
// Internal: create a node DOM element
// ---------------------------------------------------------------------------
function createNodeElement(node, x, y) {
  const el = document.createElement("div");
  el.className = `starmap-node node-${node.type}`;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;

  const glow = document.createElement("div");
  glow.className = "node-glow";

  const core = document.createElement("div");
  core.className = "node-core";

  const glyph = document.createElement("div");
  glyph.className = "node-glyph";

  const ring = document.createElement("div");
  ring.className = "node-ring";

  const stamp = document.createElement("div");
  stamp.className = "node-visited-stamp";
  stamp.style.display = "none";

  const chevron = document.createElement("div");
  chevron.className = "node-chevron";
  chevron.textContent = "\u25BC YOU ARE HERE";
  chevron.style.display = "none";

  el.appendChild(glow);
  el.appendChild(core);
  el.appendChild(glyph);
  el.appendChild(ring);
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
// Internal: update fleet panel from run data
// ---------------------------------------------------------------------------
function updateFleetPanel(control, run) {
  const capitalsContainer = control.fleetPanel.querySelector("#fleet-capitals");
  const craftContainer = control.fleetPanel.querySelector("#fleet-craft");
  const boonsContainer = control.fleetPanel.querySelector("#fleet-boons");

  // Capital ships
  let capHtml = "";
  for (const cap of run.capitals) {
    const name = capitalName(cap.klass);
    const hpPct = Math.round(cap.hpFrac * 100);
    const hpClass = cap.hpFrac > 0.6 ? "hp-high" : cap.hpFrac > 0.3 ? "hp-mid" : "hp-low";
    capHtml += `
      <div class="fleet-capital-row">
        <div class="fleet-capital-info">
          <span class="fleet-capital-glyph">\u25B2</span>
          <span class="fleet-capital-name">${name}</span>
          <span class="fleet-capital-hp-label">HULL ${hpPct}%</span>
        </div>
        <div class="fleet-hp-bar-bg">
          <div class="fleet-hp-bar-fill ${hpClass}" style="width:${hpPct}%"></div>
        </div>
      </div>
    `;
  }
  capitalsContainer.innerHTML = capHtml || '<div style="color:var(--text-secondary);font-size:12px;">No capitals</div>';

  // Small craft
  craftContainer.innerHTML = `
    <div class="fleet-craft-row">
      <span class="fleet-craft-name">Fighters</span>
      <span class="fleet-craft-count">\u00D7 ${run.smallCraft.fighter}</span>
    </div>
    <div class="fleet-craft-row">
      <span class="fleet-craft-name">Bombers</span>
      <span class="fleet-craft-count">\u00D7 ${run.smallCraft.bomber}</span>
    </div>
  `;

  // Boons
  if (run.boons && run.boons.length > 0) {
    let boonHtml = '<div class="fleet-panel-section-title">Boons</div>';
    for (const b of run.boons) {
      boonHtml += `<div class="fleet-boon-item">\u25C6 ${b.desc}</div>`;
    }
    boonsContainer.innerHTML = boonHtml;
    boonsContainer.style.display = "flex";
  } else {
    boonsContainer.innerHTML = "";
    boonsContainer.style.display = "none";
  }
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
  control.fleetPanel = null;
  control.header = null;
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