const canvas = document.getElementById("canvas");
const statusEl = document.getElementById("status");
const propsForm = document.getElementById("props-form");
const deleteBtn = document.getElementById("delete-btn");
const saveBtn = document.getElementById("save-btn");
const reloadBtn = document.getElementById("reload-btn");

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
  return {
    version: data.version || 1,
    meta: data.meta || { name: "InfraMap", updatedAt: new Date().toISOString() },
    viewport: data.viewport || { x: 0, y: 0, zoom: 1 },
    nodes: Array.isArray(data.nodes) ? data.nodes : [],
    links: Array.isArray(data.links) ? data.links : [],
  };
}

function setStatus(message, tone = "neutral") {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function renderAll() {
  canvas.innerHTML = "";
  state.board.nodes.forEach((node) => {
    const el = buildNodeElement(node);
    canvas.appendChild(el);
  });
  applySelection();
  updatePropsForm();
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
  const nodes = canvas.querySelectorAll(".node");
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
  const nodeEl = canvas.querySelector(`[data-id="${id}"]`);
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
  const rect = canvas.getBoundingClientRect();
  const nodeEl = canvas.querySelector(`[data-id="${id}"]`);
  if (!nodeEl) return;
  const nodeRect = nodeEl.getBoundingClientRect();
  state.dragging = {
    id,
    offsetX: event.clientX - nodeRect.left,
    offsetY: event.clientY - nodeRect.top,
    rect,
  };
  window.addEventListener("mousemove", onDrag);
  window.addEventListener("mouseup", stopDrag);
}

function onDrag(event) {
  if (!state.dragging) return;
  const { id, offsetX, offsetY, rect } = state.dragging;
  const node = state.board.nodes.find((n) => n.id === id);
  const nodeEl = canvas.querySelector(`[data-id="${id}"]`);
  if (!node || !nodeEl) return;
  const x = event.clientX - rect.left - offsetX;
  const y = event.clientY - rect.top - offsetY;
  node.x = Math.max(0, x);
  node.y = Math.max(0, y);
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
  const node = {
    id,
    type,
    label: `${type.toUpperCase()}-${state.board.nodes.length + 1}`,
    x: 120 + state.board.nodes.length * 24,
    y: 120 + state.board.nodes.length * 24,
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
  const nodeEl = canvas.querySelector(`[data-id="${node.id}"]`);
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
  if (event.target === canvas) {
    selectNode(null);
  }
});

document.querySelectorAll("[data-add]").forEach((btn) => {
  btn.addEventListener("click", () => {
    addNode(btn.dataset.add);
  });
});

deleteBtn.addEventListener("click", () => deleteSelected());
saveBtn.addEventListener("click", () => saveBoard());
reloadBtn.addEventListener("click", () => loadBoard());

loadBoard();
