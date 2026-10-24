const deployedApiUrl = "https://real-time-dashboard-h823.onrender.com";
const isLocalHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const API_URL = isLocalHost ? window.location.origin : deployedApiUrl;
const refreshMs = 5_000;
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("en-US");
const $ = (id) => document.getElementById(id);
const trendHistory = [];
const maxTrendPoints = 12;

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((error) => {
    console.error("Unable to register the service worker.", error);
  });
}

function formatDecimal(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "0.00";
}

function renderTrend() {
  const chart = $("trend-chart");
  if (!chart || trendHistory.length === 0) return;
  const width = 900;
  const height = 260;
  const padding = { top: 18, right: 18, bottom: 34, left: 48 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const revenueValues = trendHistory.map((point) => point.revenue);
  const revenueMin = Math.min(...revenueValues);
  const revenueMax = Math.max(...revenueValues);
  const revenueRange = Math.max(revenueMax - revenueMin, revenueMax * 0.02, 1);
  const revenueDomain = { min: Math.max(0, revenueMin - revenueRange * 0.15), max: revenueMax + revenueRange * 0.15 };
  const x = (index) => padding.left + (trendHistory.length === 1 ? plotWidth / 2 : index / (trendHistory.length - 1) * plotWidth);
  const y = (value, domain) => padding.top + plotHeight - (value - domain.min) / (domain.max - domain.min) * plotHeight;
  const revenuePoints = trendHistory.map((point, index) => `${x(index)},${y(point.revenue, revenueDomain)}`).join(" ");
  const gridLines = [0, 0.5, 1].map((ratio) => {
    const lineY = padding.top + plotHeight * ratio;
    return `<line x1="${padding.left}" y1="${lineY}" x2="${width - padding.right}" y2="${lineY}" class="chart-grid-line" />`;
  }).join("");
  const axisLabels = [0, 0.5, 1].map((ratio) => {
    const lineY = padding.top + plotHeight * (1 - ratio);
    const revenueValue = revenueDomain.min + (revenueDomain.max - revenueDomain.min) * ratio;
    return `<text x="${padding.left - 8}" y="${lineY + 4}" class="chart-axis-label" text-anchor="end">${money.format(revenueValue)}</text>`;
  }).join("");
  const labels = trendHistory.map((point, index) => {
    if (trendHistory.length > 6 && index % 2 !== 0) return "";
    return `<text x="${x(index)}" y="${height - 10}" class="chart-label" text-anchor="middle">B${point.batchNumber}</text>`;
  }).join("");
  const revenueDots = trendHistory.map((point, index) => `<circle cx="${x(index)}" cy="${y(point.revenue, revenueDomain)}" r="3.5" class="revenue-dot"><title>Batch ${point.batchNumber}: ${money.format(point.revenue)}</title></circle>`).join("");
  chart.innerHTML = `${gridLines}${axisLabels}<text x="${padding.left}" y="11" class="chart-axis-title revenue-axis-title">Revenue ($)</text><polyline points="${revenuePoints}" class="trend-line revenue-line" />${revenueDots}${labels}`;
  $("trend-caption").textContent = `${trendHistory.length} recent batch${trendHistory.length === 1 ? "" : "es"} · Each point represents revenue from one 5,000-record batch.`;
  const explanation = $("trend-explanation-text");
  if (trendHistory.length < 2) {
    explanation.textContent = "The chart is collecting another batch. After the next update, it will compare revenue with the previous batch.";
    return;
  }
  const previous = trendHistory[trendHistory.length - 2];
  const latest = trendHistory[trendHistory.length - 1];
  const revenueChange = latest.revenue - previous.revenue;
  const revenuePercent = previous.revenue ? Math.abs(revenueChange / previous.revenue * 100) : 0;
  const revenueDirection = revenueChange >= 0 ? "increased" : "decreased";
  explanation.textContent = `Compared with batch ${previous.batchNumber}, batch ${latest.batchNumber} revenue ${revenueDirection} ${revenuePercent.toFixed(1)}%. This shows whether revenue is strengthening or weakening across consecutive data batches.`;
}

function render(data) {
  if (!data?.totals || !Array.isArray(data.campaigns)) return;
  $("revenue").textContent = money.format(data.totals.revenue);
  $("spend").textContent = number.format(data.totals.trips);
  $("conversions").textContent = number.format(data.recordsFetched);
  $("roas").textContent = `${formatDecimal(data.totals.averageDistance)} mi`;
  $("updated-at").textContent = new Date(data.timestamp).toLocaleTimeString();
  $("top-roas").textContent = money.format(data.totals.averageFare);
  $("conversions").parentElement.querySelector("small").textContent =
    `Batch ${number.format(data.batchNumber || 1)} · records ${number.format(data.batchStart || 1)}-${number.format(data.batchEnd || data.recordsFetched)}`;
  $("campaign-rows").innerHTML = data.campaigns.map((campaign) => `
    <tr><td><strong>${campaign.name}</strong></td><td><span class="channel">${campaign.channel}</span></td>
    <td>${number.format(campaign.trips)}</td><td>${formatDecimal(campaign.averageDistance)} mi</td>
    <td>${formatDecimal(campaign.averagePassengers)}</td><td><strong class="roas">${money.format(campaign.revenue)}</strong></td></tr>
  `).join("");
  const maxTrips = Math.max(...data.campaigns.map((campaign) => campaign.trips), 1);
  $("volume-strip").innerHTML = data.campaigns.map((campaign) => `
    <div class="volume-item" title="${campaign.name}: ${number.format(campaign.trips)} trips">
      <div class="bar" style="height:${Math.max(12, campaign.trips / maxTrips * 100)}%"></div><span>${campaign.name.replace("Payment type ", "Type ")}</span>
    </div>
  `).join("");
  const point = {
    batchNumber: data.batchNumber || trendHistory.length + 1,
    pointKey: data.batchNumber || data.batchStart || data.timestamp || trendHistory.length + 1,
    revenue: Number(data.totals.revenue) || 0,
    trips: Number(data.totals.trips) || 0
  };
  const existingPoint = trendHistory[trendHistory.length - 1];
  if (!existingPoint || existingPoint.pointKey !== point.pointKey) {
    trendHistory.push(point);
    if (trendHistory.length > maxTrendPoints) trendHistory.shift();
    renderTrend();
  }
}

function setConnection(connected) {
  $("status-dot").classList.toggle("connected", connected);
  $("connection-status").textContent = connected ? "Live connection" : "Reconnecting";
}

async function loadInitial() {
  const response = await fetch(`${API_URL}/api/taxi?updated=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    let details = "";
    try {
      const body = await response.json();
      details = body.error ? `: ${body.error}` : "";
    } catch {
      // The status code is enough when the server did not return JSON.
    }
    throw new Error(`Initial data request failed (${response.status})${details}`);
  }
  render(await response.json());
}

async function refreshSnapshot() {
  try {
    await loadInitial();
  } catch (error) {
    console.error("Unable to refresh dashboard data.", error);
  }
}

function connect() {
  const socketUrl = new URL(API_URL);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  socketUrl.pathname = "/ws";
  const socket = new WebSocket(socketUrl);
  socket.addEventListener("open", () => setConnection(true));
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "snapshot") render(message.data);
    } catch (error) {
      console.error("Unable to process live dashboard update.", error);
    }
  });
  socket.addEventListener("close", () => {
    setConnection(false);
    setTimeout(connect, 1500);
  });
  socket.addEventListener("error", () => socket.close());
}

loadInitial().catch((error) => {
  setConnection(false);
  console.error(error);
}).then(connect);
setInterval(refreshSnapshot, refreshMs);
