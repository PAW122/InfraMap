const canvas = document.getElementById("canvas");
const world = document.getElementById("world");
const statusEl = document.getElementById("status");
const propsForm = document.getElementById("props-form");
const deleteBtn = document.getElementById("delete-btn");
const saveBtn = document.getElementById("save-btn");
const reloadBtn = document.getElementById("reload-btn");
const zoomOutBtn = document.getElementById("zoom-out");
const zoomInBtn = document.getElementById("zoom-in");
const zoomLevel = document.getElementById("zoom-level");
const centerViewBtn = document.getElementById("center-view");

const gridSize = 32;
const zoomLimits = { min: 0.35, max: 2.5 };

const typeLabels = {
  server: "SV",
  pc: "PC",
  router: "RT",
  switch: "SW",
  cloud: "CL",
};

const state = {
  board: createEmptyBoard(),
  selectedId: null,
  dragging: null,
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
  return {
    version: data.version || 1,
    meta: data.meta || { name: "InfraMap", updatedAt: new Date().toISOString() },
    viewport: safeViewport,
    nodes: Array.isArray(data.nodes) ? data.nodes : [],
    links: Array.isArray(data.links) ? data.links : [],
  };
}

function setStatus(message, tone = "neutral") {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
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
function renderAll() {
  world.innerHTML = "";
  state.board.nodes.forEach((node) => {
    const el = buildNodeElement(node);
    world.appendChild(el);
  });
  applySelection();
  updatePropsForm();
  updateViewport();
}

function buildNodeElement(node) {
  const el = document.createElement("div");
  el.className = `node node--${node.type || "server"}`;
  el.dataset.id = node.id;
  el.style.left = `${node.x || 0}px`;
  el.style.top = `${node.y || 0}px`;

  const icon = document.createElement("div");
  icon.className = "node__icon";
  icon.textContent = typeLabels[node.type] || "SV";

  const meta = document.createElement("div");
  meta.className = "node__meta";

  const label = document.createElement("div");
  label.className = "node__label";
  label.textContent = node.label || "Untitled";

  const ip = document.createElement("div");
  ip.className = "node__ip";
  ip.textContent = buildIpLine(node);

  meta.appendChild(label);
  meta.appendChild(ip);
  el.appendChild(icon);
  el.appendChild(meta);

  el.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    selectNode(node.id);
    startDrag(event, node.id);
  });

  el.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    focusNode(node.id);
  });

  return el;
}

function buildIpLine(node) {
  const parts = [];
  if (node.ipPrivate) parts.push(`priv ${node.ipPrivate}`);
  if (node.ipPublic) parts.push(`pub ${node.ipPublic}`);
  return parts.length ? parts.join(" | ") : "no ip assigned";
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
    return;
  }

  inputs.forEach((el) => (el.disabled = false));
  propsForm.elements.label.value = node.label || "";
  propsForm.elements.type.value = node.type || "server";
  propsForm.elements.network.value = node.network || "";
  propsForm.elements.ipPrivate.value = node.ipPrivate || "";
  propsForm.elements.ipPublic.value = node.ipPublic || "";
  propsForm.elements.notes.value = node.notes || "";
}

function getSelectedNode() {
  return state.board.nodes.find((n) => n.id === state.selectedId) || null;
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
  nodeEl.style.left = `${node.x}px`;
  nodeEl.style.top = `${node.y}px`;
}

function stopDrag() {
  state.dragging = null;
  window.removeEventListener("mousemove", onDrag);
  window.removeEventListener("mouseup", stopDrag);
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
  state.board.nodes.push(node);
  renderAll();
  selectNode(id);
}

function deleteSelected() {
  if (!state.selectedId) return;
  state.board.nodes = state.board.nodes.filter((n) => n.id !== state.selectedId);
  state.selectedId = null;
  renderAll();
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
  } catch (err) {
    setStatus("Could not load board. Using blank canvas.", "warn");
    state.board = createEmptyBoard();
    renderAll();
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
  } catch (err) {
    setStatus("Save failed. Check server logs.", "error");
  }
}

let panState = null;

function startPan(event) {
  if (event.button !== 0) return;
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
  }
}

function onWheel(event) {
  event.preventDefault();
  const viewport = getViewport();
  const zoomFactor = Math.exp(-event.deltaY * 0.001);
  setZoom(viewport.zoom * zoomFactor, event.clientX, event.clientY);
}

propsForm.addEventListener("input", (event) => {
  const node = getSelectedNode();
  if (!node) return;
  const field = event.target.name;
  if (!field) return;
  node[field] = event.target.value;
  updateNodeElement(node);
});

propsForm.addEventListener("submit", (event) => {
  event.preventDefault();
});

function updateNodeElement(node) {
  const nodeEl = world.querySelector(`[data-id="${node.id}"]`);
  if (!nodeEl) return;
  nodeEl.className = `node node--${node.type || "server"}`;
  if (node.id === state.selectedId) nodeEl.classList.add("selected");
  const icon = nodeEl.querySelector(".node__icon");
  const label = nodeEl.querySelector(".node__label");
  const ip = nodeEl.querySelector(".node__ip");
  if (icon) icon.textContent = typeLabels[node.type] || "SV";
  if (label) label.textContent = node.label || "Untitled";
  if (ip) ip.textContent = buildIpLine(node);
}

canvas.addEventListener("mousedown", (event) => {
  if (event.target === canvas || event.target === world) {
    startPan(event);
  }
});

canvas.addEventListener("wheel", onWheel, { passive: false });
window.addEventListener("resize", updateViewport);

document.querySelectorAll("[data-add]").forEach((btn) => {
  btn.addEventListener("click", () => {
    addNode(btn.dataset.add);
  });
});

deleteBtn.addEventListener("click", () => deleteSelected());
saveBtn.addEventListener("click", () => saveBoard());
reloadBtn.addEventListener("click", () => loadBoard());
zoomOutBtn.addEventListener("click", () => {
  const viewport = getViewport();
  setZoom(viewport.zoom * 0.9);
});
zoomInBtn.addEventListener("click", () => {
  const viewport = getViewport();
  setZoom(viewport.zoom * 1.1);
});
centerViewBtn.addEventListener("click", () => {
  const viewport = getViewport();
  viewport.x = 0;
  viewport.y = 0;
  viewport.zoom = 1;
  updateViewport();
});

loadBoard();
