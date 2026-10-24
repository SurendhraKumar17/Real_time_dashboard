import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const preferredPort = Number(process.env.PORT || 3000);
const maxPortAttempts = 20;
const snapshotFile = process.env.SNAPSHOT_FILE || "full_dataset_snapshot.json";
const configuredOrigin = process.env.FRONTEND_URL?.trim();
const allowedOrigin = configuredOrigin && !configuredOrigin.includes("your-netlify-site")
  ? configuredOrigin
  : "https://real-time-dashboard1.netlify.app";
let currentSnapshot = null;
let lastApiError = null;

async function readSnapshot() {
  const snapshotPath = join(root, snapshotFile);
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  if (!Number.isInteger(snapshot.recordsFetched) || !Array.isArray(snapshot.campaigns)) {
    throw new Error(`Invalid dashboard snapshot: ${snapshotFile}`);
  }
  return snapshot;
}

function broadcast() {
  if (!currentSnapshot) return;
  const message = JSON.stringify({ type: "snapshot", data: currentSnapshot });
  for (const client of socketServer.clients) {
    if (client.readyState === 1) client.send(message);
  }
}

function contentType(path) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".csv": "text/csv; charset=utf-8"
  }[extname(path)] || "application/octet-stream";
}

const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.url === "/api/taxi") {
    if (!currentSnapshot) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: lastApiError || "Full taxi dataset is still loading" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(currentSnapshot));
    return;
  }

  const requested = request.url === "/" ? "index.html" : request.url.slice(1).split("?")[0];
  const filePath = normalize(join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, { "Content-Type": contentType(filePath), "Cache-Control": "no-cache" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});

const socketServer = new WebSocketServer({ server, path: "/ws" });
socketServer.on("connection", (socket) => {
  if (currentSnapshot) socket.send(JSON.stringify({ type: "snapshot", data: currentSnapshot }));
  else socket.send(JSON.stringify({ type: "status", message: lastApiError || "Loading full NYC Taxi dataset" }));
});

readSnapshot().then((snapshot) => {
  currentSnapshot = snapshot;
  console.log(`Loaded ${snapshot.recordsFetched} trips from ${snapshotFile}.`);
  broadcast();
}).catch((error) => {
  lastApiError = error.message;
  console.error(`Unable to load dashboard snapshot: ${error.message}`);
});

function startServer(portToTry) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE") {
      const nextPort = portToTry + 1;
      if (nextPort - preferredPort > maxPortAttempts) throw error;
      console.warn(`Port ${portToTry} is busy. Retrying on ${nextPort}...`);
      startServer(nextPort);
      return;
    }
    throw error;
  });
  server.listen(portToTry, () => {
    console.log(`NYC Taxi BI dashboard running at http://localhost:${portToTry}`);
  });
}

startServer(preferredPort);
