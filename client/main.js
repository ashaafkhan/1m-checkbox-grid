import {
  BITMASK_SIZE,
  CHECKBOX_COUNT,
  GRID_COLUMNS,
  GRID_ROWS,
  decodePatch,
  decodeSnapshot,
  decodeStats,
  encodeToggle,
  getBit,
  setBit,
} from "../shared/protocol.js";

const MIN_VISIBLE_CELLS = 40;
const MAX_VISIBLE_CELLS = 260;

const state = {
  stats: {
    checked: 0,
    total: CHECKBOX_COUNT,
    clients: 0,
  },
  bitmask: new Uint8Array(BITMASK_SIZE),
  socket: null,
  visibleCols: 40,
  visibleRows: 40,
  offsetCol: 440,
  offsetRow: 440,
  drag: {
    active: false,
    x: 0,
    y: 0,
  },
};

const dom = {
  status: document.getElementById("status"),
  checked: document.getElementById("checked"),
  total: document.getElementById("total"),
  fillRate: document.getElementById("fill-rate"),
  clients: document.getElementById("clients"),
  canvas: document.getElementById("grid-canvas"),
  zoomLabel: document.getElementById("zoom-label"),
  zoomIn: document.getElementById("zoom-in"),
  zoomOut: document.getElementById("zoom-out"),
  resetView: document.getElementById("reset-view"),
  themeToggle: document.getElementById("theme-toggle"),
};

const ctx = dom.canvas.getContext("2d", { alpha: false });

function syncCanvasSize() {
  const rect = dom.canvas.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(320, Math.floor(rect.height));

  if (dom.canvas.width !== width) dom.canvas.width = width;
  if (dom.canvas.height !== height) dom.canvas.height = height;
}

function clampOffset() {
  state.offsetCol = Math.max(0, Math.min(GRID_COLUMNS - state.visibleCols, state.offsetCol));
  state.offsetRow = Math.max(0, Math.min(GRID_ROWS - state.visibleRows, state.offsetRow));
}

function updateZoomLabel() {
  dom.zoomLabel.textContent = `${state.visibleCols} x ${state.visibleRows}`;
}

function getTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("grid-theme", theme);
  dom.themeToggle.textContent = theme === "dark" ? "Light" : "Dark";
  renderCanvas();
}

function initTheme() {
  const saved = localStorage.getItem("grid-theme");
  if (saved === "dark" || saved === "light") {
    setTheme(saved);
    return;
  }

  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  setTheme(prefersDark ? "dark" : "light");
}

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const host = import.meta.env.DEV ? "localhost:8080" : window.location.host;
  return `${protocol}://${host}/ws`;
}

function setStatus(status) {
  dom.status.textContent = status;
  dom.status.dataset.state = status;
}

function renderStats() {
  dom.checked.textContent = state.stats.checked.toLocaleString();
  dom.total.textContent = state.stats.total.toLocaleString();
  dom.clients.textContent = String(state.stats.clients);

  const fillRate = state.stats.total
    ? ((state.stats.checked / state.stats.total) * 100).toFixed(2)
    : "0.00";
  dom.fillRate.textContent = fillRate;
}

function cellColor(index, checked) {
  const theme = getTheme();

  if (checked) {
    return theme === "dark" ? [138, 226, 129, 255] : [34, 94, 39, 255];
  }

  const row = Math.floor(index / GRID_COLUMNS);
  const col = index % GRID_COLUMNS;

  if (theme === "dark") {
    return (row + col) % 2 === 0
      ? [43, 68, 48, 255]
      : [36, 58, 42, 255];
  }

  return (row + col) % 2 === 0
    ? [194, 214, 187, 255]
    : [210, 225, 206, 255];
}

function renderCanvas() {
  if (!ctx) return;
  syncCanvasSize();
  clampOffset();

  const theme = getTheme();
  const cellW = dom.canvas.width / state.visibleCols;
  const cellH = dom.canvas.height / state.visibleRows;

  ctx.fillStyle = theme === "dark" ? "#17261d" : "#edf3e6";
  ctx.fillRect(0, 0, dom.canvas.width, dom.canvas.height);

  for (let r = 0; r < state.visibleRows; r += 1) {
    for (let c = 0; c < state.visibleCols; c += 1) {
      const row = state.offsetRow + r;
      const col = state.offsetCol + c;
      const index = row * GRID_COLUMNS + col;
      const checked = getBit(state.bitmask, index);
      const [cr, cg, cb] = cellColor(index, checked);

      const x = c * cellW;
      const y = r * cellH;

      ctx.fillStyle = `rgb(${cr}, ${cg}, ${cb})`;
      ctx.fillRect(x, y, cellW, cellH);

      ctx.strokeStyle = theme === "dark" ? "#3f6241" : "#9db495";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, cellW - 1), Math.max(1, cellH - 1));
    }
  }
}

function connectSocket() {
  const socket = new WebSocket(wsUrl());
  socket.binaryType = "arraybuffer";
  state.socket = socket;

  socket.addEventListener("open", () => {
    setStatus("connected");
  });

  socket.addEventListener("close", () => {
    setStatus("disconnected");
  });

  socket.addEventListener("error", () => {
    setStatus("error");
  });

  socket.addEventListener("message", (event) => {
    const snapshot = decodeSnapshot(event.data);
    if (snapshot) {
      state.bitmask.set(snapshot);
      renderCanvas();
      return;
    }

    const patch = decodePatch(event.data);
    if (patch) {
      setBit(state.bitmask, patch.index, patch.value);
      renderCanvas();
      return;
    }

    const nextStats = decodeStats(event.data);
    if (nextStats) {
      state.stats = nextStats;
      renderStats();
    }
  });
}

function handleCanvasClick(event) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const rect = dom.canvas.getBoundingClientRect();
  const localX = Math.max(0, Math.min(rect.width - 1, event.clientX - rect.left));
  const localY = Math.max(0, Math.min(rect.height - 1, event.clientY - rect.top));

  const col = state.offsetCol + Math.floor((localX / rect.width) * state.visibleCols);
  const row = state.offsetRow + Math.floor((localY / rect.height) * state.visibleRows);

  if (col < 0 || col >= GRID_COLUMNS || row < 0 || row >= GRID_ROWS) {
    return;
  }

  const index = row * GRID_COLUMNS + col;
  state.socket.send(encodeToggle(index));
}

function zoom(delta) {
  const next = Math.max(MIN_VISIBLE_CELLS, Math.min(MAX_VISIBLE_CELLS, state.visibleCols + delta));
  state.visibleCols = next;
  state.visibleRows = next;
  updateZoomLabel();
  renderCanvas();
}

function centerView() {
  state.offsetCol = Math.floor((GRID_COLUMNS - state.visibleCols) / 2);
  state.offsetRow = Math.floor((GRID_ROWS - state.visibleRows) / 2);
  renderCanvas();
}

function handlePointerDown(event) {
  state.drag.active = true;
  state.drag.x = event.clientX;
  state.drag.y = event.clientY;
}

function handlePointerMove(event) {
  if (!state.drag.active) return;

  const dx = event.clientX - state.drag.x;
  const dy = event.clientY - state.drag.y;
  state.drag.x = event.clientX;
  state.drag.y = event.clientY;

  const colShift = Math.round((-dx / dom.canvas.clientWidth) * state.visibleCols);
  const rowShift = Math.round((-dy / dom.canvas.clientHeight) * state.visibleRows);

  if (colShift !== 0 || rowShift !== 0) {
    state.offsetCol += colShift;
    state.offsetRow += rowShift;
    renderCanvas();
  }
}

function handlePointerUp() {
  state.drag.active = false;
}

function init() {
  initTheme();
  setStatus("connecting");
  renderStats();
  updateZoomLabel();
  centerView();

  dom.zoomIn.addEventListener("click", () => zoom(-20));
  dom.zoomOut.addEventListener("click", () => zoom(20));
  dom.resetView.addEventListener("click", centerView);
  dom.themeToggle.addEventListener("click", () => {
    setTheme(getTheme() === "dark" ? "light" : "dark");
  });

  dom.canvas.addEventListener("click", handleCanvasClick);
  dom.canvas.addEventListener("pointerdown", handlePointerDown);
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("resize", renderCanvas);

  connectSocket();
}

init();
