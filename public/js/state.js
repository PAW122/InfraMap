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
const logsBtn = document.getElementById("logs-btn");
const settingsBtn = document.getElementById("settings-btn");
const settingsModal = document.getElementById("settings-modal");
const settingsClose = document.getElementById("settings-close");
const settingsApply = document.getElementById("settings-apply");
const settingsForm = document.getElementById("settings-form");
const logsModal = document.getElementById("logs-modal");
const logsClose = document.getElementById("logs-close");
const logsRefresh = document.getElementById("logs-refresh");
const logsOutput = document.getElementById("logs-output");

const gridSize = 32;
const zoomLimits = { min: 0.35, max: 2.5 };
const networkDefaults = { width: 420, height: 260, color: "#1d6fa3" };
const networkMinSize = { width: 200, height: 140 };
const monitoringDefaults = { intervalSec: 30, showStatus: true };

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
  statusById: {},
  statusTimer: null,
};

function createEmptyBoard() {
  return {
    version: 1,
    meta: {
      name: "InfraMap",
      updatedAt: new Date().toISOString(),
      monitoring: { ...monitoringDefaults },
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
  return {
    ...node,
    connectEnabled: node.connectEnabled === true,
  };
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
