const canvas = document.getElementById("canvas");
const world = document.getElementById("world");
const statusEl = document.getElementById("status");
const propsForm = document.getElementById("props-form");
const deleteBtn = document.getElementById("delete-btn");
const lockBtn = document.getElementById("lock-btn");
const layerUpBtn = document.getElementById("layer-up");
const layerDownBtn = document.getElementById("layer-down");
const saveBtn = document.getElementById("save-btn");
const reloadBtn = document.getElementById("reload-btn");
const zoomOutBtn = document.getElementById("zoom-out");
const zoomInBtn = document.getElementById("zoom-in");
const zoomLevel = document.getElementById("zoom-level");
const centerViewBtn = document.getElementById("center-view");
const dirtyIndicator = document.getElementById("dirty-indicator");
const linkBtn = document.getElementById("link-btn");
const undoBtn = document.getElementById("undo-btn");
const redoBtn = document.getElementById("redo-btn");

const gridSize = 32;
const zoomLimits = { min: 0.35, max: 2.5 };
const networkDefaults = { width: 420, height: 260, color: "#1d6fa3" };
const networkMinSize = { width: 200, height: 140 };

const typeLabels = {
  server: "SV",
  pc: "PC",
  router: "RT",
  switch: "SW",
  cloud: "CL",
  network: "NW",
};

const state = {
  board: createEmptyBoard(),
  selectedId: null,
  dragging: null,
  dirty: false,
  linkMode: false,
  linkStartId: null,
  history: {
    undo: [],
    redo: [],
    saved: "",
    last: "",
    restoring: false,
    max: 80,
  },
};

function createEmptyBoard() {
  return {
    version: 1,
    meta: {
      name: "InfraMap",
      updatedAt: new Date().toISOString(),
    },
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    links: [],
  };
}

function normalizeBoard(data) {
  if (!data || typeof data !== "object") return createEmptyBoard();
  const viewport = data.viewport || {};
  const safeViewport = {
    x: typeof viewport.x === "number" ? viewport.x : 0,
    y: typeof viewport.y === "number" ? viewport.y : 0,
    zoom: typeof viewport.zoom === "number" ? viewport.zoom : 1,
  };
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const normalizedNodes = nodes.map((node) => normalizeNode(node));
  return {
    version: data.version || 1,
    meta: data.meta || { name: "InfraMap", updatedAt: new Date().toISOString() },
    viewport: safeViewport,
    nodes: normalizedNodes,
    links: Array.isArray(data.links) ? data.links : [],
  };
}

function normalizeNode(node) {
  if (!node || typeof node !== "object") return node;
  if (node.type === "network") {
    return {
      ...node,
      width: typeof node.width === "number" ? node.width : networkDefaults.width,
      height: typeof node.height === "number" ? node.height : networkDefaults.height,
      networkPublicIp: typeof node.networkPublicIp === "string" ? node.networkPublicIp : "",
      color: typeof node.color === "string" ? node.color : networkDefaults.color,
    };
  }
  return node;
}

function setStatus(message, tone = "neutral") {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function setDirty(isDirty) {
  state.dirty = isDirty;
  if (!dirtyIndicator) return;
  if (isDirty) {
    dirtyIndicator.textContent = "Unsaved changes";
    dirtyIndicator.classList.remove("is-hidden");
  } else {
    dirtyIndicator.textContent = "";
    dirtyIndicator.classList.add("is-hidden");
  }
}

let historyTimer = null;

function serializeBoard(board) {
  return JSON.stringify(board);
}

function initHistory(board) {
  if (historyTimer) {
    clearTimeout(historyTimer);
    historyTimer = null;
  }
  const snap = serializeBoard(board);
  state.history.undo = [snap];
  state.history.redo = [];
  state.history.saved = snap;
  state.history.last = snap;
  updateHistoryButtons();
  setDirty(false);
}

function recordHistory() {
  if (state.history.restoring) return;
  const snap = serializeBoard(state.board);
  if (snap === state.history.last) {
    refreshDirtyState(snap);
    return;
  }
  state.history.undo.push(snap);
  state.history.last = snap;
  state.history.redo = [];
  if (state.history.undo.length > state.history.max) {
    state.history.undo.shift();
  }
  updateHistoryButtons();
  refreshDirtyState(snap);
}

function scheduleHistory(delay = 300) {
  if (historyTimer) {
    clearTimeout(historyTimer);
  }
  historyTimer = setTimeout(() => {
    historyTimer = null;
    recordHistory();
  }, delay);
}

function refreshDirtyState(snapshot) {
  const current = snapshot || serializeBoard(state.board);
  setDirty(current !== state.history.saved);
}

function markSaved() {
  const snap = serializeBoard(state.board);
  state.history.saved = snap;
  state.history.last = snap;
  if (!state.history.undo.length) {
    state.history.undo = [snap];
  }
  refreshDirtyState(snap);
  updateHistoryButtons();
}

function applySnapshot(snapshot) {
  if (historyTimer) {
    clearTimeout(historyTimer);
    historyTimer = null;
  }
  state.history.restoring = true;
  const data = JSON.parse(snapshot);
  state.board = normalizeBoard(data);
  state.history.last = snapshot;
  renderAll();
  state.history.restoring = false;
  refreshDirtyState(snapshot);
  updateHistoryButtons();
}

function undo() {
  if (state.history.undo.length <= 1) return;
  const current = state.history.undo.pop();
  state.history.redo.push(current);
  const prev = state.history.undo[state.history.undo.length - 1];
  applySnapshot(prev);
}

function redo() {
  if (!state.history.redo.length) return;
  const next = state.history.redo.pop();
  state.history.undo.push(next);
  applySnapshot(next);
}

function updateHistoryButtons() {
  if (undoBtn) undoBtn.disabled = state.history.undo.length <= 1;
  if (redoBtn) redoBtn.disabled = state.history.redo.length === 0;
}

function setLinkMode(enabled) {
  state.linkMode = enabled;
  if (linkBtn) {
    linkBtn.classList.toggle("btn--primary", enabled);
    linkBtn.classList.toggle("btn--ghost", !enabled);
  }
  if (!enabled) {
    state.linkStartId = null;
  }
  canvas.classList.toggle("link-mode", enabled);
  updateLinkModeHighlight();
}

function updateLinkModeHighlight() {
  const nodes = world.querySelectorAll(".node");
  nodes.forEach((nodeEl) => {
    if (nodeEl.dataset.id === state.linkStartId) {
      nodeEl.classList.add("link-start");
    } else {
      nodeEl.classList.remove("link-start");
    }
  });
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getViewport() {
  if (!state.board.viewport) {
    state.board.viewport = { x: 0, y: 0, zoom: 1 };
  }
  return state.board.viewport;
}

function updateViewport() {
  const viewport = getViewport();
  viewport.zoom = clamp(viewport.zoom || 1, zoomLimits.min, zoomLimits.max);
  const rect = canvas.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const tx = cx - viewport.x * viewport.zoom;
  const ty = cy - viewport.y * viewport.zoom;

  world.style.transform = `translate(${tx}px, ${ty}px) scale(${viewport.zoom})`;
  const scaledGrid = gridSize * viewport.zoom;
  canvas.style.backgroundSize = `${scaledGrid}px ${scaledGrid}px`;
  canvas.style.backgroundPosition = `${tx}px ${ty}px`;
  updateZoomLabel();
}

function updateZoomLabel() {
  const viewport = getViewport();
  if (zoomLevel) {
    zoomLevel.textContent = `${Math.round(viewport.zoom * 100)}%`;
  }
}

function screenToWorld(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const viewport = getViewport();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const sx = clientX - rect.left;
  const sy = clientY - rect.top;
  return {
    x: (sx - cx) / viewport.zoom + viewport.x,
    y: (sy - cy) / viewport.zoom + viewport.y,
  };
}

function setZoom(zoom, clientX, clientY) {
  const viewport = getViewport();
  const rect = canvas.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const sx = typeof clientX === "number" ? clientX - rect.left : cx;
  const sy = typeof clientY === "number" ? clientY - rect.top : cy;
  const before = {
    x: (sx - cx) / viewport.zoom + viewport.x,
    y: (sy - cy) / viewport.zoom + viewport.y,
  };

  viewport.zoom = clamp(zoom, zoomLimits.min, zoomLimits.max);
  viewport.x = before.x - (sx - cx) / viewport.zoom;
  viewport.y = before.y - (sy - cy) / viewport.zoom;
  updateViewport();
}

let linksLayer = null;

function renderAll() {
  world.innerHTML = "";
  linksLayer = createLinksLayer();
  world.appendChild(linksLayer);

  const networks = state.board.nodes.filter((node) => node.type === "network");
  const others = state.board.nodes.filter((node) => node.type !== "network");
  [...networks, ...others].forEach((node) => {
    const el = buildNodeElement(node);
    world.appendChild(el);
  });
  renderLinks();
  updateLinksLayerBounds();
  assignNodesToNetworks();
  applySelection();
  updateLinkModeHighlight();
  updatePropsForm();
  updateViewport();
}

function buildNodeElement(node) {
  const el = document.createElement("div");
  el.className = `node node--${node.type || "server"}`;
  if (node.locked) {
    el.classList.add("locked");
  }
  el.dataset.id = node.id;
  el.style.zIndex = getNodeZIndex(node);
  el.style.left = `${node.x || 0}px`;
  el.style.top = `${node.y || 0}px`;
  if (node.type === "network") {
    const width = typeof node.width === "number" ? node.width : networkDefaults.width;
    const height = typeof node.height === "number" ? node.height : networkDefaults.height;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    applyNetworkStyles(el, node);
  }

  const icon = document.createElement("div");
  icon.className = "node__icon";
  icon.textContent = typeLabels[node.type] || "SV";

  const label = document.createElement("div");
  label.className = "node__label";
  label.textContent = node.label || "Untitled";

  const ip = document.createElement("div");
  ip.className = "node__ip";
  ip.textContent = buildIpLine(node);

  if (node.type === "network") {
    const header = document.createElement("div");
    header.className = "network-header";
    header.appendChild(icon);
    header.appendChild(label);

    const meta = document.createElement("div");
    meta.className = "network-meta";
    meta.appendChild(ip);

    el.appendChild(header);
    el.appendChild(meta);
    addResizeHandles(el, node.id);
  } else {
    const meta = document.createElement("div");
    meta.className = "node__meta";
    meta.appendChild(label);
    meta.appendChild(ip);
    el.appendChild(icon);
    el.appendChild(meta);
  }

  el.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    selectNode(node.id);
    if (state.linkMode) {
      handleLinkClick(node.id);
      return;
    }
    if (node.locked) return;
    startDrag(event, node.id);
  });

  el.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    focusNode(node.id);
  });

  return el;
}

function buildIpLine(node) {
  if (node.type === "network") {
    return node.networkPublicIp
      ? `public ${node.networkPublicIp}`
      : "no public ip";
  }
  const parts = [];
  if (node.ipPrivate) parts.push(`priv ${node.ipPrivate}`);
  if (node.ipPublic) parts.push(`pub ${node.ipPublic}`);
  return parts.length ? parts.join(" | ") : "no ip assigned";
}

function applyNetworkStyles(el, node) {
  const base = typeof node.color === "string" && node.color ? node.color : networkDefaults.color;
  const bg = hexToRgba(base, 0.12);
  const border = hexToRgba(base, 0.55);
  const text = hexToRgba(base, 0.9);
  el.style.backgroundColor = bg;
  el.style.borderColor = border;
  const meta = el.querySelector(".network-meta");
  if (meta) {
    meta.style.color = text;
  }
}

function hexToRgba(hex, alpha) {
  const value = hex.replace("#", "");
  if (value.length !== 6) return `rgba(29, 111, 163, ${alpha})`;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function applySelection() {
  const nodes = world.querySelectorAll(".node");
  nodes.forEach((nodeEl) => {
    if (nodeEl.dataset.id === state.selectedId) {
      nodeEl.classList.add("selected");
    } else {
      nodeEl.classList.remove("selected");
    }
  });
}

function selectNode(id) {
  state.selectedId = id;
  applySelection();
  updatePropsForm();
}

function focusNode(id) {
  const nodeEl = world.querySelector(`[data-id="${id}"]`);
  if (!nodeEl) return;
  nodeEl.classList.add("pulse");
  setTimeout(() => nodeEl.classList.remove("pulse"), 600);
}

function updatePropsForm() {
  const node = getSelectedNode();
  const inputs = propsForm.querySelectorAll("input, select, textarea, button");
  if (!node) {
    inputs.forEach((el) => {
      if (el !== deleteBtn) {
        el.value = "";
      }
      el.disabled = true;
    });
    deleteBtn.disabled = true;
    if (lockBtn) lockBtn.disabled = true;
    if (layerUpBtn) layerUpBtn.disabled = true;
    if (layerDownBtn) layerDownBtn.disabled = true;
    if (lockBtn) {
      lockBtn.classList.remove("btn--primary");
      lockBtn.classList.add("btn--ghost");
    }
    propsForm.dataset.mode = "none";
    return;
  }

  inputs.forEach((el) => (el.disabled = false));
  if (lockBtn) lockBtn.disabled = false;
  if (layerUpBtn) layerUpBtn.disabled = false;
  if (layerDownBtn) layerDownBtn.disabled = false;
  propsForm.dataset.mode = node.type === "network" ? "network" : "node";
  propsForm.elements.label.value = node.label || "";
  propsForm.elements.type.value = node.type || "server";
  if (propsForm.elements.network) {
    propsForm.elements.network.value = node.network || "";
  }
  if (propsForm.elements.ipPrivate) {
    propsForm.elements.ipPrivate.value = node.ipPrivate || "";
  }
  if (propsForm.elements.ipPublic) {
    propsForm.elements.ipPublic.value = node.ipPublic || "";
  }
  if (propsForm.elements.networkPublicIp) {
    propsForm.elements.networkPublicIp.value = node.networkPublicIp || "";
  }
  if (propsForm.elements.color) {
    propsForm.elements.color.value = node.color || networkDefaults.color;
  }
  if (propsForm.elements.width) {
    propsForm.elements.width.value = node.width || "";
  }
  if (propsForm.elements.height) {
    propsForm.elements.height.value = node.height || "";
  }
  propsForm.elements.notes.value = node.notes || "";
  if (lockBtn) {
    const label = lockBtn.querySelector(".btn__label");
    if (label) {
      label.textContent = node.locked ? "Unlock" : "Lock";
    }
    lockBtn.setAttribute("aria-pressed", node.locked ? "true" : "false");
    if (node.locked) {
      lockBtn.classList.add("btn--primary");
      lockBtn.classList.remove("btn--ghost");
    } else {
      lockBtn.classList.remove("btn--primary");
      lockBtn.classList.add("btn--ghost");
    }
  }
}

function getSelectedNode() {
  return state.board.nodes.find((n) => n.id === state.selectedId) || null;
}

function getNodeById(id) {
  return state.board.nodes.find((n) => n.id === id) || null;
}

function startDrag(event, id) {
  const node = state.board.nodes.find((n) => n.id === id);
  if (!node) return;
  const nodeEl = world.querySelector(`[data-id="${id}"]`);
  if (!nodeEl) return;
  const point = screenToWorld(event.clientX, event.clientY);
  state.dragging = {
    id,
    offsetX: point.x - node.x,
    offsetY: point.y - node.y,
    startX: node.x,
    startY: node.y,
    moved: false,
  };
  window.addEventListener("mousemove", onDrag);
  window.addEventListener("mouseup", stopDrag);
}

function onDrag(event) {
  if (!state.dragging) return;
  const { id, offsetX, offsetY } = state.dragging;
  const node = state.board.nodes.find((n) => n.id === id);
  const nodeEl = world.querySelector(`[data-id="${id}"]`);
  if (!node || !nodeEl) return;
  const point = screenToWorld(event.clientX, event.clientY);
  node.x = point.x - offsetX;
  node.y = point.y - offsetY;
  if (Math.abs(node.x - state.dragging.startX) > 1 || Math.abs(node.y - state.dragging.startY) > 1) {
    state.dragging.moved = true;
  }
  nodeEl.style.left = `${node.x}px`;
  nodeEl.style.top = `${node.y}px`;
  updateLinksPositions();
}

function stopDrag() {
  const moved = state.dragging && state.dragging.moved;
  state.dragging = null;
  window.removeEventListener("mousemove", onDrag);
  window.removeEventListener("mouseup", stopDrag);
  assignNodesToNetworks();
  updateLinksPositions();
  updatePropsForm();
  if (moved) {
    recordHistory();
  }
}

function addNode(type) {
  const id = crypto?.randomUUID ? crypto.randomUUID() : `node-${Date.now()}`;
  const viewport = getViewport();
  const offset = (state.board.nodes.length % 6) * 24;
  const node = {
    id,
    type,
    label: `${type.toUpperCase()}-${state.board.nodes.length + 1}`,
    x: viewport.x + offset,
    y: viewport.y + offset,
    network: "",
    ipPrivate: "",
    ipPublic: "",
    notes: "",
  };
  if (type === "network") {
    node.label = `LAN-${state.board.nodes.filter((n) => n.type === "network").length + 1}`;
    node.width = 480;
    node.height = 280;
    node.networkPublicIp = "";
    node.color = networkDefaults.color;
  }
  state.board.nodes.push(node);
  renderAll();
  selectNode(id);
  recordHistory();
}

function deleteSelected() {
  if (!state.selectedId) return;
  const removedId = state.selectedId;
  state.board.nodes = state.board.nodes.filter((n) => n.id !== state.selectedId);
  state.board.links = state.board.links.filter(
    (link) => link.from !== removedId && link.to !== removedId
  );
  state.selectedId = null;
  renderAll();
  recordHistory();
}

async function loadBoard() {
  try {
    setStatus("Loading board...", "info");
    const res = await fetch("/api/board");
    if (!res.ok) throw new Error("failed");
    const data = await res.json();
    state.board = normalizeBoard(data);
    setStatus("Board loaded.", "success");
    renderAll();
    initHistory(state.board);
  } catch (err) {
    setStatus("Could not load board. Using blank canvas.", "warn");
    state.board = createEmptyBoard();
    renderAll();
    initHistory(state.board);
  }
}

async function saveBoard() {
  try {
    setStatus("Saving...", "info");
    state.board.meta = state.board.meta || {};
    state.board.meta.updatedAt = new Date().toISOString();
    const res = await fetch("/api/board", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.board, null, 2),
    });
    if (!res.ok) throw new Error("failed");
    setStatus("Saved to data/board.json.", "success");
    recordHistory();
    markSaved();
  } catch (err) {
    setStatus("Save failed. Check server logs.", "error");
  }
}

let panState = null;

function startPan(event) {
  if (event.button !== 0 && event.button !== 2) return;
  const viewport = getViewport();
  panState = {
    startX: event.clientX,
    startY: event.clientY,
    startViewportX: viewport.x,
    startViewportY: viewport.y,
    moved: false,
  };
  window.addEventListener("mousemove", onPanMove);
  window.addEventListener("mouseup", stopPan);
}

function onPanMove(event) {
  if (!panState) return;
  const viewport = getViewport();
  const dx = (event.clientX - panState.startX) / viewport.zoom;
  const dy = (event.clientY - panState.startY) / viewport.zoom;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
    panState.moved = true;
  }
  viewport.x = panState.startViewportX - dx;
  viewport.y = panState.startViewportY - dy;
  updateViewport();
}

function stopPan() {
  if (!panState) return;
  const didMove = panState.moved;
  panState = null;
  window.removeEventListener("mousemove", onPanMove);
  window.removeEventListener("mouseup", stopPan);
  if (!didMove) {
    selectNode(null);
  } else {
    recordHistory();
  }
}

function onWheel(event) {
  event.preventDefault();
  const viewport = getViewport();
  const zoomFactor = Math.exp(-event.deltaY * 0.001);
  setZoom(viewport.zoom * zoomFactor, event.clientX, event.clientY);
  refreshDirtyState();
  scheduleHistory();
}

let resizeState = null;

function addResizeHandles(el, id) {
  const dirs = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
  dirs.forEach((dir) => {
    const handle = document.createElement("div");
    handle.className = "resize-handle";
    handle.dataset.dir = dir;
    handle.addEventListener("mousedown", (event) => {
      event.stopPropagation();
      event.preventDefault();
      startResize(event, id, dir);
    });
    el.appendChild(handle);
  });
}

function startResize(event, id, dir) {
  const node = state.board.nodes.find((n) => n.id === id);
  if (!node) return;
  if (node.locked) return;
  const point = screenToWorld(event.clientX, event.clientY);
  resizeState = {
    id,
    dir,
    startX: node.x || 0,
    startY: node.y || 0,
    startWidth: node.width || networkDefaults.width,
    startHeight: node.height || networkDefaults.height,
    startPoint: point,
    moved: false,
  };
  window.addEventListener("mousemove", onResizeMove);
  window.addEventListener("mouseup", stopResize);
}

function onResizeMove(event) {
  if (!resizeState) return;
  const node = state.board.nodes.find((n) => n.id === resizeState.id);
  if (!node) return;
  const point = screenToWorld(event.clientX, event.clientY);
  const dx = point.x - resizeState.startPoint.x;
  const dy = point.y - resizeState.startPoint.y;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
    resizeState.moved = true;
  }

  let width = resizeState.startWidth;
  let height = resizeState.startHeight;
  let x = resizeState.startX;
  let y = resizeState.startY;

  if (resizeState.dir.includes("e")) {
    width += dx;
  }
  if (resizeState.dir.includes("s")) {
    height += dy;
  }
  if (resizeState.dir.includes("w")) {
    width -= dx;
    x += dx;
  }
  if (resizeState.dir.includes("n")) {
    height -= dy;
    y += dy;
  }

  if (width < networkMinSize.width) {
    const delta = networkMinSize.width - width;
    width = networkMinSize.width;
    if (resizeState.dir.includes("w")) {
      x -= delta;
    }
  }
  if (height < networkMinSize.height) {
    const delta = networkMinSize.height - height;
    height = networkMinSize.height;
    if (resizeState.dir.includes("n")) {
      y -= delta;
    }
  }

  node.x = x;
  node.y = y;
  node.width = width;
  node.height = height;
  updateNodeElement(node);
  updateLinksPositions();
}

function stopResize() {
  const moved = resizeState && resizeState.moved;
  resizeState = null;
  window.removeEventListener("mousemove", onResizeMove);
  window.removeEventListener("mouseup", stopResize);
  assignNodesToNetworks();
  updateLinksPositions();
  updatePropsForm();
  if (moved) {
    recordHistory();
  }
}

propsForm.addEventListener("input", (event) => {
  const node = getSelectedNode();
  if (!node) return;
  const field = event.target.name;
  if (!field) return;
  if (field === "width" || field === "height") {
    const value = parseFloat(event.target.value);
    node[field] = Number.isFinite(value) ? value : 0;
    if (field === "width") {
      node.width = Math.max(networkMinSize.width, node.width);
    }
    if (field === "height") {
      node.height = Math.max(networkMinSize.height, node.height);
    }
  } else {
    node[field] = event.target.value;
  }
  if (field === "type") {
    if (node.type === "network") {
      node.width = typeof node.width === "number" ? node.width : networkDefaults.width;
      node.height = typeof node.height === "number" ? node.height : networkDefaults.height;
      node.networkPublicIp = node.networkPublicIp || "";
      node.color = node.color || networkDefaults.color;
    }
    renderAll();
    selectNode(node.id);
    recordHistory();
    return;
  }
  updateNodeElement(node);
  if (node.type === "network" || field === "label") {
    assignNodesToNetworks();
    updatePropsForm();
  }
  refreshDirtyState();
  scheduleHistory();
});

propsForm.addEventListener("submit", (event) => {
  event.preventDefault();
});

function updateNodeElement(node) {
  const nodeEl = world.querySelector(`[data-id="${node.id}"]`);
  if (!nodeEl) return;
  nodeEl.className = `node node--${node.type || "server"}`;
  if (node.locked) {
    nodeEl.classList.add("locked");
  }
  nodeEl.style.zIndex = getNodeZIndex(node);
  nodeEl.style.left = `${node.x || 0}px`;
  nodeEl.style.top = `${node.y || 0}px`;
  if (node.id === state.selectedId) nodeEl.classList.add("selected");
  if (node.id === state.linkStartId) nodeEl.classList.add("link-start");
  const icon = nodeEl.querySelector(".node__icon");
  const label = nodeEl.querySelector(".node__label");
  const ip = nodeEl.querySelector(".node__ip");
  if (node.type === "network") {
    const width = typeof node.width === "number" ? node.width : networkDefaults.width;
    const height = typeof node.height === "number" ? node.height : networkDefaults.height;
    nodeEl.style.width = `${width}px`;
    nodeEl.style.height = `${height}px`;
    applyNetworkStyles(nodeEl, node);
  } else {
    nodeEl.style.width = "";
    nodeEl.style.height = "";
  }
  if (icon) icon.textContent = typeLabels[node.type] || "SV";
  if (label) label.textContent = node.label || "Untitled";
  if (ip) ip.textContent = buildIpLine(node);
}

function createLinksLayer() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("links-layer");
  return svg;
}

function renderLinks() {
  if (!linksLayer) return;
  linksLayer.innerHTML = "";
  const nodesById = new Map(state.board.nodes.map((node) => [node.id, node]));
  state.board.links.forEach((link) => {
    const from = nodesById.get(link.from);
    const to = nodesById.get(link.to);
    if (!from || !to) return;
    const a = getNodeCenter(from);
    const b = getNodeCenter(to);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.classList.add("link-line");
    line.dataset.from = link.from;
    line.dataset.to = link.to;
    line.setAttribute("x1", a.x);
    line.setAttribute("y1", a.y);
    line.setAttribute("x2", b.x);
    line.setAttribute("y2", b.y);
    linksLayer.appendChild(line);
  });
}

function updateLinksPositions() {
  if (!linksLayer) return;
  const nodesById = new Map(state.board.nodes.map((node) => [node.id, node]));
  linksLayer.querySelectorAll("line").forEach((line) => {
    const from = nodesById.get(line.dataset.from);
    const to = nodesById.get(line.dataset.to);
    if (!from || !to) return;
    const a = getNodeCenter(from);
    const b = getNodeCenter(to);
    line.setAttribute("x1", a.x);
    line.setAttribute("y1", a.y);
    line.setAttribute("x2", b.x);
    line.setAttribute("y2", b.y);
  });
  updateLinksLayerBounds();
}

function updateLinksLayerBounds() {
  if (!linksLayer) return;
  const nodes = state.board.nodes;
  if (!nodes.length) {
    linksLayer.setAttribute("width", 1);
    linksLayer.setAttribute("height", 1);
    linksLayer.setAttribute("viewBox", "0 0 1 1");
    linksLayer.style.left = "0px";
    linksLayer.style.top = "0px";
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  nodes.forEach((node) => {
    const bounds = getNodeBounds(node);
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  });
  const padding = 400;
  const left = minX - padding;
  const top = minY - padding;
  const width = Math.max(1, maxX - minX + padding * 2);
  const height = Math.max(1, maxY - minY + padding * 2);
  linksLayer.style.left = `${left}px`;
  linksLayer.style.top = `${top}px`;
  linksLayer.setAttribute("width", width);
  linksLayer.setAttribute("height", height);
  linksLayer.setAttribute("viewBox", `${left} ${top} ${width} ${height}`);
}

function getNodeBounds(node) {
  const nodeEl = world.querySelector(`[data-id="${node.id}"]`);
  let width = nodeEl ? nodeEl.offsetWidth : 150;
  let height = nodeEl ? nodeEl.offsetHeight : 70;
  if (node.type === "network") {
    width = typeof node.width === "number" ? node.width : networkDefaults.width;
    height = typeof node.height === "number" ? node.height : networkDefaults.height;
  }
  return {
    x: typeof node.x === "number" ? node.x : 0,
    y: typeof node.y === "number" ? node.y : 0,
    width,
    height,
  };
}

function getNodeZIndex(node) {
  const base = node.type === "network" ? 1 : 2;
  const offset = typeof node.z === "number" ? node.z : 0;
  return base + offset;
}

function assignNodesToNetworks() {
  const networks = state.board.nodes.filter((n) => n.type === "network");
  if (!networks.length) {
    state.board.nodes.forEach((node) => {
      if (node.type !== "network") {
        node.networkId = null;
        node.network = "";
      }
    });
    return;
  }

  state.board.nodes.forEach((node) => {
    if (node.type === "network") return;
    const center = getNodeCenter(node);
    const matching = networks.find((net) => {
      const bounds = getNetworkBounds(net);
      return (
        center.x >= bounds.x &&
        center.x <= bounds.x + bounds.width &&
        center.y >= bounds.y &&
        center.y <= bounds.y + bounds.height
      );
    });
    if (matching) {
      node.networkId = matching.id;
      node.network = matching.label || matching.id;
    } else {
      node.networkId = null;
      node.network = "";
    }
  });
}

function getNetworkBounds(net) {
  const width = typeof net.width === "number" ? net.width : 420;
  const height = typeof net.height === "number" ? net.height : 260;
  return {
    x: typeof net.x === "number" ? net.x : 0,
    y: typeof net.y === "number" ? net.y : 0,
    width,
    height,
  };
}

function getNodeCenter(node) {
  const nodeEl = world.querySelector(`[data-id="${node.id}"]`);
  const width = nodeEl ? nodeEl.offsetWidth : 150;
  const height = nodeEl ? nodeEl.offsetHeight : 70;
  return {
    x: (node.x || 0) + width / 2,
    y: (node.y || 0) + height / 2,
  };
}

function handleLinkClick(id) {
  if (!state.linkMode) return;
  const clicked = getNodeById(id);
  if (!clicked) return;
  if (clicked.type === "network") {
    setStatus("Linking networks is disabled.", "warn");
    return;
  }
  if (!state.linkStartId) {
    state.linkStartId = id;
    setStatus("Link mode: select target node.", "info");
    updateLinkModeHighlight();
    return;
  }
  if (state.linkStartId === id) {
    state.linkStartId = null;
    setStatus("Link mode: select first node.", "info");
    updateLinkModeHighlight();
    return;
  }
  const startNode = getNodeById(state.linkStartId);
  if (startNode && startNode.type === "network") {
    state.linkStartId = null;
    setStatus("Linking networks is disabled.", "warn");
    updateLinkModeHighlight();
    return;
  }
  const from = state.linkStartId;
  const to = id;
  const linkIndex = state.board.links.findIndex(
    (link) =>
      (link.from === from && link.to === to) || (link.from === to && link.to === from)
  );
  if (linkIndex >= 0) {
    state.board.links.splice(linkIndex, 1);
    setStatus("Link removed.", "info");
    recordHistory();
    renderAll();
  } else {
    state.board.links.push({
      id: crypto?.randomUUID ? crypto.randomUUID() : `link-${Date.now()}`,
      from,
      to,
    });
    recordHistory();
    renderAll();
  }
  state.linkStartId = null;
  updateLinkModeHighlight();
}

canvas.addEventListener("mousedown", (event) => {
  if (event.button === 2) {
    event.preventDefault();
    startPan(event);
    return;
  }
  if (event.button === 0 && (event.target === canvas || event.target === world)) {
    startPan(event);
  }
});

canvas.addEventListener("wheel", onWheel, { passive: false });
canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});
window.addEventListener("resize", updateViewport);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.linkMode) {
    setLinkMode(false);
    setStatus("Link mode disabled.", "info");
  }
});

document.querySelectorAll("[data-add]").forEach((btn) => {
  btn.addEventListener("click", () => {
    addNode(btn.dataset.add);
  });
});

deleteBtn.addEventListener("click", () => deleteSelected());
lockBtn.addEventListener("click", () => {
  const node = getSelectedNode();
  if (!node) return;
  node.locked = !node.locked;
  updateNodeElement(node);
  updatePropsForm();
  recordHistory();
});
layerUpBtn.addEventListener("click", () => {
  const node = getSelectedNode();
  if (!node) return;
  node.z = (typeof node.z === "number" ? node.z : 0) + 1;
  updateNodeElement(node);
  recordHistory();
});
layerDownBtn.addEventListener("click", () => {
  const node = getSelectedNode();
  if (!node) return;
  node.z = (typeof node.z === "number" ? node.z : 0) - 1;
  updateNodeElement(node);
  recordHistory();
});
linkBtn.addEventListener("click", () => {
  setLinkMode(!state.linkMode);
  setStatus(
    state.linkMode ? "Link mode: select first node." : "Link mode disabled.",
    "info"
  );
});
undoBtn.addEventListener("click", () => {
  undo();
});
redoBtn.addEventListener("click", () => {
  redo();
});
saveBtn.addEventListener("click", () => saveBoard());
reloadBtn.addEventListener("click", () => loadBoard());
zoomOutBtn.addEventListener("click", () => {
  const viewport = getViewport();
  setZoom(viewport.zoom * 0.9);
  recordHistory();
});
zoomInBtn.addEventListener("click", () => {
  const viewport = getViewport();
  setZoom(viewport.zoom * 1.1);
  recordHistory();
});
centerViewBtn.addEventListener("click", () => {
  const viewport = getViewport();
  viewport.x = 0;
  viewport.y = 0;
  viewport.zoom = 1;
  updateViewport();
  recordHistory();
});

loadBoard();
