import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { WebSocketServer } from "ws";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const preferredPort = Number(process.env.PORT || 3000);
const maxPortAttempts = 20;
const datasetFile = process.env.DATASET_FILE || "yellow_tripdata_2015-01.csv";
const datasetPath = join(root, datasetFile);
const refreshMs = 5_000;
const batchSize = 5_000;
const configuredOrigin = process.env.FRONTEND_URL?.trim();
const allowedOrigin = configuredOrigin && !configuredOrigin.includes("your-netlify-site")
  ? configuredOrigin
  : "https://real-time-dashboard1.netlify.app";
let currentSnapshot = null;
let lastApiError = null;
let csvIterator = null;
let batchNumber = 0;
let refreshInProgress = false;

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function createEmptyBuckets() {
  return new Map();
}

function addRecord(buckets, values) {
  const key = String(values[11] || "Unknown");
  const labels = {
    "1": "Credit card",
    "2": "Cash",
    "3": "No charge",
    "4": "Dispute",
    "5": "Unknown",
    "6": "Voided trip"
  };
  const bucket = buckets.get(key) || {
    id: key,
    name: labels[key] || `Payment type ${key}`,
    channel: "Payment method",
    trips: 0,
    passengers: 0,
    distance: 0,
    revenue: 0,
    fare: 0
  };
  bucket.trips += 1;
  bucket.passengers += asNumber(values[3]);
  bucket.distance += asNumber(values[4]);
  bucket.revenue += asNumber(values[18]);
  bucket.fare += asNumber(values[12]);
  buckets.set(key, bucket);
}

function buildSnapshot(buckets, recordsFetched, currentBatchNumber) {
  const campaigns = [...buckets.values()]
    .sort((a, b) => b.trips - a.trips)
    .map((bucket) => ({
      ...bucket,
      averageFare: bucket.trips ? bucket.fare / bucket.trips : 0,
      averageDistance: bucket.trips ? bucket.distance / bucket.trips : 0,
      averagePassengers: bucket.trips ? bucket.passengers / bucket.trips : 0
    }));
  const totals = campaigns.reduce((result, row) => {
    for (const key of ["trips", "passengers", "distance", "revenue", "fare"]) result[key] += row[key];
    return result;
  }, { trips: 0, passengers: 0, distance: 0, revenue: 0, fare: 0 });

  return {
    timestamp: new Date().toISOString(),
    source: "Local NYC TLC Yellow Taxi Trip Records (January 2015)",
    sourceUrl: `/${datasetFile}`,
    recordsFetched,
    batchNumber: currentBatchNumber,
    batchStart: (currentBatchNumber - 1) * batchSize + 1,
    batchEnd: currentBatchNumber * batchSize,
    campaigns,
    totals: {
      trips: totals.trips,
      passengers: totals.passengers,
      distance: totals.distance,
      revenue: totals.revenue,
      averageFare: totals.trips ? totals.fare / totals.trips : 0,
      averageDistance: totals.trips ? totals.distance / totals.trips : 0,
      averagePassengers: totals.trips ? totals.passengers / totals.trips : 0
    }
  };
}

async function createCsvIterator() {
  const lines = createInterface({
    input: createReadStream(datasetPath),
    crlfDelay: Infinity
  });
  const iterator = lines[Symbol.asyncIterator]();
  await iterator.next();
  return { iterator, lines };
}

async function readDatasetBatch() {
  if (!csvIterator) csvIterator = await createCsvIterator();
  const buckets = createEmptyBuckets();
  let recordsFetched = 0;

  while (recordsFetched < batchSize) {
    const next = await csvIterator.iterator.next();
    if (next.done) {
      csvIterator.lines.close();
      csvIterator = await createCsvIterator();
      continue;
    }
    const values = next.value.split(",");
    if (values.length < 19) continue;
    addRecord(buckets, values);
    recordsFetched += 1;
  }
  batchNumber += 1;
  return buildSnapshot(buckets, recordsFetched, batchNumber);
}

function broadcast() {
  if (!currentSnapshot) return;
  const message = JSON.stringify({ type: "snapshot", data: currentSnapshot });
  for (const client of socketServer.clients) {
    if (client.readyState === 1) client.send(message);
  }
}

async function refreshTaxiData() {
  if (refreshInProgress) return;
  refreshInProgress = true;
  try {
  currentSnapshot = await readDatasetBatch();
  lastApiError = null;
  console.log(`Loaded batch of ${currentSnapshot.recordsFetched} trips from ${datasetFile}.`);
  broadcast();
  } finally {
    refreshInProgress = false;
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
      response.end(JSON.stringify({ error: lastApiError || "Taxi data is still loading" }));
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
  else socket.send(JSON.stringify({ type: "status", message: lastApiError || "Loading NYC Taxi data" }));
});

refreshTaxiData().catch((error) => {
  lastApiError = error.message;
  console.error(`Unable to load NYC Taxi data: ${error.message}`);
});
setInterval(() => refreshTaxiData().catch((error) => {
  lastApiError = error.message;
  console.error(`Unable to refresh NYC Taxi data: ${error.message}`);
}), refreshMs);

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
