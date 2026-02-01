function hasAnyPingEnabledNode() {
  return state.board.nodes.some((node) => node.type !== "network" && node.pingEnabled === true);
}

function hasAnyVisibleStatus() {
  return state.board.nodes.some(
    (node) =>
      node.type !== "network" &&
      node.pingShowStatus !== false &&
      (node.pingEnabled === true || node.connectEnabled === true)
  );
}

function sanitizeMonitoringSettings(settings) {
  const interval = Math.max(5, Math.min(3600, parseInt(settings.intervalSec, 10) || 0));
  return {
    intervalSec: interval || monitoringDefaults.intervalSec,
    showStatus: Boolean(settings.showStatus),
  };
}

function canEnablePing(node) {
  return Boolean(node.ipPrivate || node.ipPublic);
}

function getNodeMonitoring(node) {
  return sanitizeMonitoringSettings({
    intervalSec:
      typeof node.pingIntervalSec === "number"
        ? node.pingIntervalSec
        : monitoringDefaults.intervalSec,
    showStatus: node.pingShowStatus !== false,
  });
}

function syncSettingsFormState(enabled) {
  if (!settingsForm) return;
  settingsForm.elements.pingInterval.disabled = !enabled;
  settingsForm.elements.showStatus.disabled = false;
}

function setAuthVisibility(method) {
  if (!settingsForm) return;
  settingsForm.querySelectorAll("[data-auth]").forEach((el) => {
    if (el.dataset.auth === method) {
      el.style.display = "flex";
    } else {
      el.style.display = "none";
    }
  });
}

function setHelpForOS(os) {
  if (!settingsForm) return;
  settingsForm.querySelectorAll(".settings-help").forEach((el) => {
    if (el.dataset.os === os) {
      el.classList.add("active");
    } else {
      el.classList.remove("active");
    }
  });
}

async function fetchDeviceSettings(id, detect = false, force = false) {
  try {
    const params = [];
    if (detect) params.push("detect=1");
    if (force) params.push("force=1");
    const suffix = params.length ? `?${params.join("&")}` : "";
    const res = await fetch(`/api/device-settings/${id}${suffix}`);
    if (!res.ok) return { exists: false, settings: {} };
    return await res.json();
  } catch (err) {
    return { exists: false, settings: {} };
  }
}

async function saveDeviceSettings(id, settings) {
  const res = await fetch(`/api/device-settings/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    throw new Error("failed");
  }
  return res.json();
}

async function hydrateDeviceSettings(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return;
  const targets = nodes.filter((node) => node.type !== "network");
  if (!targets.length) return;
  const results = await Promise.all(
    targets.map((node) => fetchDeviceSettings(node.id, true, true))
  );
  let changed = false;
  results.forEach((res, index) => {
    if (!res || !res.exists) return;
    const remote = res.settings || {};
    const desired = remote.connectEnabled === true;
    if (targets[index].connectEnabled !== desired) {
      targets[index].connectEnabled = desired;
      changed = true;
    }
    if (typeof remote.linkSpeedMbps === "number" && remote.linkSpeedMbps >= 0) {
      if (targets[index].linkSpeedMbps !== remote.linkSpeedMbps) {
        targets[index].linkSpeedMbps = remote.linkSpeedMbps;
        changed = true;
      }
    }
  });
  if (changed) {
    targets.forEach((node) => updateNodeElement(node));
    updateStatusBadges();
    updateLinksPositions();
    syncMonitoringSettings();
  }
}

async function openSettingsModal() {
  if (!settingsModal || !settingsForm) return;
  const node = getSelectedNode();
  if (!node || node.type === "network") {
    setStatus("Select a device to edit settings.", "warn");
    return;
  }
  const settings = getNodeMonitoring(node);
  const hasIP = canEnablePing(node);
  const remote = await fetchDeviceSettings(node.id);
  const remoteSettings = remote.settings || {};
  settingsForm.elements.pingEnabled.checked = hasIP && node.pingEnabled === true;
  settingsForm.elements.pingEnabled.disabled = !hasIP;
  settingsForm.elements.pingInterval.value = settings.intervalSec;
  settingsForm.elements.showStatus.checked = settings.showStatus;
  settingsForm.elements.connectEnabled.checked =
    remoteSettings.connectEnabled === true || node.connectEnabled === true;
  settingsForm.elements.isInfraMapServer.checked = node.isInfraMapServer === true;
  settingsForm.elements.os.value = remoteSettings.os || "linux";
  settingsForm.elements.host.value = remoteSettings.host || node.ipPublic || node.ipPrivate || "";
  settingsForm.elements.port.value = remoteSettings.port || "";
  settingsForm.elements.linkSpeedMbps.value =
    typeof remoteSettings.linkSpeedMbps === "number" && remoteSettings.linkSpeedMbps > 0
      ? remoteSettings.linkSpeedMbps
      : node.linkSpeedMbps || "";
  settingsForm.elements.authMethod.value = remoteSettings.authMethod || "password";
  settingsForm.elements.username.value = remoteSettings.username || "";
  settingsForm.elements.password.value = remoteSettings.password || "";
  settingsForm.elements.privateKey.value = remoteSettings.privateKey || "";
  settingsForm.elements.privateKeyPassphrase.value = remoteSettings.privateKeyPassphrase || "";
  syncSettingsFormState(settingsForm.elements.pingEnabled.checked);
  setAuthVisibility(settingsForm.elements.authMethod.value);
  setHelpForOS(settingsForm.elements.os.value);
  const title = document.getElementById("settings-title");
  if (title) {
    title.textContent = `Settings - ${node.label || node.id}`;
  }
  settingsModal.classList.remove("is-hidden");
}

function closeSettingsModal() {
  if (!settingsModal) return;
  settingsModal.classList.add("is-hidden");
}

let logsTimer = null;

function formatLogEntry(entry) {
  const time = entry.time || "";
  const level = (entry.level || "info").toUpperCase();
  const source = entry.source || "system";
  const message = entry.message || "";
  return `[${time}] [${level}] [${source}] ${message}`;
}

async function fetchLogs() {
  if (!logsOutput) return;
  try {
    const res = await fetch("/api/logs?limit=200");
    if (!res.ok) throw new Error("failed");
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    logsOutput.textContent = items.length
      ? items.map((entry) => formatLogEntry(entry)).join("\n")
      : "No logs yet.";
  } catch (err) {
    logsOutput.textContent = "Failed to load logs.";
  }
}

function openLogsModal() {
  if (!logsModal) return;
  logsModal.classList.remove("is-hidden");
  fetchLogs();
  if (logsTimer) clearInterval(logsTimer);
  logsTimer = setInterval(fetchLogs, 5000);
}

function closeLogsModal() {
  if (!logsModal) return;
  logsModal.classList.add("is-hidden");
  if (logsTimer) {
    clearInterval(logsTimer);
    logsTimer = null;
  }
}

async function applySettingsFromForm() {
  if (!settingsForm) return;
  const node = getSelectedNode();
  if (!node || node.type === "network") return;
  const settings = sanitizeMonitoringSettings({
    intervalSec: settingsForm.elements.pingInterval.value,
    showStatus: settingsForm.elements.showStatus.checked,
  });
  const hasIP = canEnablePing(node);
  node.pingEnabled = hasIP && settingsForm.elements.pingEnabled.checked;
  node.pingIntervalSec = settings.intervalSec;
  node.pingShowStatus = settings.showStatus;
  node.connectEnabled = settingsForm.elements.connectEnabled.checked;
  node.isInfraMapServer = settingsForm.elements.isInfraMapServer.checked;
  node.linkSpeedMbps = parseInt(settingsForm.elements.linkSpeedMbps.value, 10) || 0;
  updateNodeElement(node);
  updateStatusBadges();
  updateLinksPositions();
  recordHistory();
  syncMonitoringSettings();
  const deviceSettings = {
    os: settingsForm.elements.os.value,
    host: settingsForm.elements.host.value,
    port: parseInt(settingsForm.elements.port.value, 10) || 0,
    connectEnabled: settingsForm.elements.connectEnabled.checked,
    linkSpeedMbps: parseInt(settingsForm.elements.linkSpeedMbps.value, 10) || 0,
    authMethod: settingsForm.elements.authMethod.value,
    username: settingsForm.elements.username.value,
    password: settingsForm.elements.password.value,
    privateKey: settingsForm.elements.privateKey.value,
    privateKeyPassphrase: settingsForm.elements.privateKeyPassphrase.value,
  };
  try {
    const saved = await saveDeviceSettings(node.id, deviceSettings);
    if (saved && saved.settings) {
      if (typeof saved.settings.linkSpeedMbps === "number") {
        node.linkSpeedMbps = saved.settings.linkSpeedMbps;
      }
      if (typeof saved.settings.connectEnabled === "boolean") {
        node.connectEnabled = saved.settings.connectEnabled;
      }
      updateNodeElement(node);
      updateStatusBadges();
      updateLinksPositions();
    }
    setStatus("Device settings saved.", "success");
  } catch (err) {
    setStatus("Failed to save device settings.", "warn");
  }
  closeSettingsModal();
}

function syncMonitoringSettings() {
  startStatusPolling();
  canvas.classList.toggle("show-status", hasAnyVisibleStatus());
  postMonitoringNodes();
}

async function postMonitoringNodes() {
  try {
    const payload = {
      nodes: state.board.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        ipPrivate: node.ipPrivate || "",
        ipPublic: node.ipPublic || "",
        pingEnabled: node.pingEnabled === true,
        pingIntervalSec: node.pingIntervalSec || monitoringDefaults.intervalSec,
        connectEnabled: node.connectEnabled === true,
      })),
    };
    await fetch("/api/monitoring/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    setStatus("Failed to update monitoring nodes.", "warn");
  }
}

function startStatusPolling() {
  if (state.statusTimer) {
    clearInterval(state.statusTimer);
    state.statusTimer = null;
  }
  const interval = getStatusPollInterval();
  if (!interval) {
    state.statusById = {};
    state.sshStatusById = {};
    updateStatusBadges();
    return;
  }
  fetchStatus();
  state.statusTimer = setInterval(fetchStatus, interval * 1000);
}

function getStatusPollInterval() {
  const intervals = state.board.nodes
    .filter((node) => node.type !== "network" && (node.pingEnabled === true || node.connectEnabled === true))
    .map((node) => {
      if (node.pingEnabled === true) {
        const value = typeof node.pingIntervalSec === "number" ? node.pingIntervalSec : 0;
        return Math.max(5, Math.min(3600, value || monitoringDefaults.intervalSec));
      }
      return monitoringDefaults.intervalSec;
    });
  if (!intervals.length) return 0;
  return Math.min(...intervals);
}

async function fetchStatus() {
  try {
    const [pingRes, sshRes] = await Promise.all([fetch("/api/status"), fetch("/api/ssh-status")]);
    if (pingRes.ok) {
      const data = await pingRes.json();
      state.statusById = data.results || {};
    }
    if (sshRes.ok) {
      const data = await sshRes.json();
      state.sshStatusById = data.results || {};
    }
    updateStatusBadges();
  } catch (err) {
    setStatus("Failed to fetch status.", "warn");
  }
}

function updateStatusBadges() {
  const nodes = world.querySelectorAll(".node");
  nodes.forEach((nodeEl) => {
    const node = getNodeById(nodeEl.dataset.id);
    if (!node || node.type === "network") return;
    applyStatusToNode(node, nodeEl);
  });
}

function applyStatusToNode(node, nodeEl) {
  let stateLabel = "unknown";
  let title = "No connection";
  const hasMonitoring = node.pingEnabled === true || node.connectEnabled === true;
  const isVisible = hasMonitoring && node.pingShowStatus !== false;
  nodeEl.classList.toggle("status-visible", isVisible);
  nodeEl.classList.toggle("status-hidden", !isVisible);
  if (!isVisible) {
    stateLabel = "disabled";
    title = hasMonitoring ? "Status hidden" : "Monitoring disabled";
    nodeEl.dataset.status = stateLabel;
    const dot = nodeEl.querySelector(".node__status");
    if (dot) {
      dot.title = title;
    }
    return;
  }
  const sshStatus = state.sshStatusById[node.id];
  if (node.connectEnabled === true) {
    if (sshStatus && sshStatus.online) {
      stateLabel = "ssh";
      title = "SSH connected";
    } else if (node.pingEnabled === true) {
      const ping = state.statusById[node.id];
      if (ping && ping.online) {
        stateLabel = "online";
        title = "Online (ping)";
      } else {
        stateLabel = "unknown";
        title = sshStatus ? "SSH offline" : "Checking SSH...";
      }
    } else {
      stateLabel = "unknown";
      title = sshStatus ? "SSH offline" : "Checking SSH...";
    }
  } else if (node.pingEnabled === true) {
    const status = state.statusById[node.id];
    if (status && status.online) {
      stateLabel = "online";
      title = "Online (ping)";
    } else {
      stateLabel = "unknown";
      title = status && status.error === "no ip" ? "No IP assigned" : "No ping response";
    }
    if (status && status.lastChecked) {
      title += ` (checked ${status.lastChecked})`;
    }
  }
  nodeEl.dataset.status = stateLabel;
  const dot = nodeEl.querySelector(".node__status");
  if (dot) {
    dot.title = title;
  }
}

