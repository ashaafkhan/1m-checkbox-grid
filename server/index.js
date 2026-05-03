import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "redis";
import { verifyToken } from "@clerk/clerk-sdk-node";
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
const REDIS_URL = process.env.REDIS_URL || "";
const REDIS_BITMASK_KEY = process.env.REDIS_BITMASK_KEY || "checkboxes:bitmask";
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || "";
const RATE_LIMIT_HTTP_WINDOW_MS = Number(process.env.RATE_LIMIT_HTTP_WINDOW_MS || 10_000);
const RATE_LIMIT_HTTP = Number(process.env.RATE_LIMIT_HTTP || 30);
const RATE_LIMIT_TOGGLE_WINDOW_MS = Number(process.env.RATE_LIMIT_TOGGLE_WINDOW_MS || 2_000);
const RATE_LIMIT_TOGGLE = Number(process.env.RATE_LIMIT_TOGGLE || 40);
const RATE_LIMIT_RESET_WINDOW_MS = Number(process.env.RATE_LIMIT_RESET_WINDOW_MS || 60_000);
const RATE_LIMIT_RESET = Number(process.env.RATE_LIMIT_RESET || 2);

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

const bitmask = new Uint8Array(BITMASK_SIZE);
let checkedCount = 0;
let visitedClientsCount = 0;

const redis = createClient(REDIS_URL ? { url: REDIS_URL } : {});
let redisReady = false;
const localRateLimit = new Map();

redis.on("error", (err) => {
  console.error("Redis error", err);
});

async function initRedis() {
  try {
    await redis.connect();
    redisReady = true;

    const stored = await redis.getBuffer(REDIS_BITMASK_KEY);
    if (stored && stored.length > 0) {
      const slice = stored.subarray(0, BITMASK_SIZE);
      bitmask.set(slice);
      checkedCount = await redis.bitCount(REDIS_BITMASK_KEY);
    }
  } catch (err) {
    console.error("Redis connection failed", err);
  }
}

function countBits(bytes) {
  let total = 0;
  for (const value of bytes) {
    let v = value;
    while (v) {
      total += v & 1;
      v >>= 1;
    }
  }
  return total;
}

function rateLimitKey(scope, identifier, windowMs) {
  const bucket = Math.floor(Date.now() / windowMs);
  return `rl:${scope}:${identifier}:${bucket}`;
}

function localRateLimitIncr(key, windowMs) {
  const now = Date.now();
  const entry = localRateLimit.get(key);

  if (!entry || entry.expiresAt <= now) {
    const next = { count: 1, expiresAt: now + windowMs };
    localRateLimit.set(key, next);
    return next.count;
  }

  entry.count += 1;
  return entry.count;
}

async function isRateLimited(scope, identifier, limit, windowMs) {
  if (!identifier) return false;
  if (!limit || limit <= 0) return false;

  const key = rateLimitKey(scope, identifier, windowMs);

  if (redisReady) {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.pexpire(key, windowMs);
    }
    return count > limit;
  }

  const count = localRateLimitIncr(key, windowMs);
  return count > limit;
}

function getClientIp(request) {
  const header = request.headers["x-forwarded-for"];
  if (typeof header === "string" && header.length > 0) {
    return header.split(",")[0].trim();
  }

  if (Array.isArray(header) && header.length > 0) {
    return header[0].trim();
  }

  return request.socket?.remoteAddress || "unknown";
}

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

  if (redisReady) {
    redis.setBit(REDIS_BITMASK_KEY, index, next).catch(() => {});
  }

  return next;
}

function resetAllCheckboxes() {
  bitmask.fill(0);
  checkedCount = 0;

  if (redisReady) {
    redis.del(REDIS_BITMASK_KEY).catch(() => {});
  }
}

function getTokenFromRequest(request) {
  const host = request.headers.host || "localhost";
  const url = new URL(request.url || "/", `http://${host}`);
  const queryToken = url.searchParams.get("token");

  const authHeader = request.headers.authorization || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  return queryToken || bearer || "";
}

async function authenticateRequest(request) {
  if (!CLERK_SECRET_KEY) return null;
  const token = getTokenFromRequest(request);
  if (!token) return null;

  try {
    const payload = await verifyToken(token, { secretKey: CLERK_SECRET_KEY });
    return { userId: payload.sub };
  } catch (err) {
    console.warn("Auth failed", err?.message || err);
    return null;
  }
}

wss.on("connection", (socket, request) => {
  visitedClientsCount += 1;
  socket.binaryType = "arraybuffer";
  socket.userId = null;
  socket.clientIp = getClientIp(request);

  authenticateRequest(request).then((auth) => {
    socket.userId = auth?.userId || null;
  });

  socket.send(encodeSnapshot(bitmask));
  socket.send(encodeStats(checkedCount, visitedClientsCount));

  socket.on("message", async (rawData, isBinary) => {
    if (!isBinary) return;

    const data =
      rawData instanceof ArrayBuffer
        ? rawData
        : rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength);

    if (decodeReset(data)) {
      if (!socket.userId) return;
      const resetLimited = await isRateLimited(
        "ws:reset",
        socket.userId,
        RATE_LIMIT_RESET,
        RATE_LIMIT_RESET_WINDOW_MS,
      );
      if (resetLimited) return;
      resetAllCheckboxes();
      broadcastBinary(encodeSnapshot(bitmask));
      broadcastBinary(encodeStats(checkedCount, visitedClientsCount));
      return;
    }

    const index = decodeToggle(data);
    if (index === null || index >= CHECKBOX_COUNT) return;
    if (!socket.userId) return;

    const identifier = socket.userId || socket.clientIp || "anonymous";
    const limited = await isRateLimited(
      "ws:toggle",
      identifier,
      RATE_LIMIT_TOGGLE,
      RATE_LIMIT_TOGGLE_WINDOW_MS,
    );
    if (limited) return;

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
app.use("/api", async (req, res, next) => {
  const ip = getClientIp(req);
  const limited = await isRateLimited(
    "http",
    ip,
    RATE_LIMIT_HTTP,
    RATE_LIMIT_HTTP_WINDOW_MS,
  );

  if (limited) {
    res.status(429).json({ ok: false, error: "rate_limited" });
    return;
  }

  next();
});
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

initRedis().then(() => {
  if (!redisReady && checkedCount === 0) {
    checkedCount = countBits(bitmask);
  }
});
