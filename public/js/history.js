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
  syncMonitoringSettings();
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
