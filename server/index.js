import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  BITMASK_SIZE,
  CHECKBOX_COUNT,
  decodeReset,
  decodeToggle,
  encodePatch,
  encodeSnapshot,
  encodeStats,
  getBit,
  setBit,
} from "../shared/protocol.js";

const PORT = Number(process.env.PORT || 8080);

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

const bitmask = new Uint8Array(BITMASK_SIZE);
let checkedCount = 0;
let visitedClientsCount = 0;

function broadcastBinary(buffer) {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(buffer);
    }
  }
}

function toggleCheckbox(index) {
  const previous = getBit(bitmask, index);
  const next = previous ? 0 : 1;
  setBit(bitmask, index, next);

  checkedCount += next ? 1 : -1;
  if (checkedCount < 0) checkedCount = 0;

  return next;
}

function resetAllCheckboxes() {
  bitmask.fill(0);
  checkedCount = 0;
}

wss.on("connection", (socket) => {
  visitedClientsCount += 1;
  socket.binaryType = "arraybuffer";

  socket.send(encodeSnapshot(bitmask));
  socket.send(encodeStats(checkedCount, visitedClientsCount));

  socket.on("message", (rawData, isBinary) => {
    if (!isBinary) return;

    const data =
      rawData instanceof ArrayBuffer
        ? rawData
        : rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength);

    if (decodeReset(data)) {
      resetAllCheckboxes();
      broadcastBinary(encodeSnapshot(bitmask));
      broadcastBinary(encodeStats(checkedCount, visitedClientsCount));
      return;
    }

    const index = decodeToggle(data);
    if (index === null || index >= CHECKBOX_COUNT) return;

    const value = toggleCheckbox(index);
    broadcastBinary(encodePatch(index, value));
  });

  socket.on("close", () => {
    broadcastBinary(encodeStats(checkedCount, visitedClientsCount));
  });

  broadcastBinary(encodeStats(checkedCount, visitedClientsCount));
});

setInterval(() => {
  broadcastBinary(encodeStats(checkedCount, visitedClientsCount));
}, 1000);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    checkboxes: CHECKBOX_COUNT,
    bitmaskBytes: BITMASK_SIZE,
    checked: checkedCount,
    activeClients: wss.clients.size,
    visitedClients: visitedClientsCount,
  });
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

app.use(express.static(distDir));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    next();
    return;
  }

  res.sendFile(path.join(distDir, "index.html"), (err) => {
    if (err) next();
  });
});

httpServer.listen(PORT, () => {
  console.log(`1M checkbox server running on http://localhost:${PORT}`);
});
