const deployedApiUrl = "https://real-time-dashboard-h823.onrender.com";
const isLocalHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const API_URL = isLocalHost ? window.location.origin : deployedApiUrl;
const refreshMs = 30_000;
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("en-US");
const $ = (id) => document.getElementById(id);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((error) => {
    console.error("Unable to register the service worker.", error);
  });
}

function formatDecimal(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "0.00";
}

function render(data) {
  if (!data?.totals || !Array.isArray(data.campaigns)) return;
  $("revenue").textContent = money.format(data.totals.revenue);
  $("spend").textContent = number.format(data.totals.trips);
  $("conversions").textContent = number.format(data.recordsFetched);
  $("roas").textContent = `${formatDecimal(data.totals.averageDistance)} mi`;
  $("updated-at").textContent = new Date(data.timestamp).toLocaleTimeString();
  $("top-roas").textContent = money.format(data.totals.averageFare);
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
}

function setConnection(connected) {
  $("status-dot").classList.toggle("connected", connected);
  $("connection-status").textContent = connected ? "Live connection" : "Reconnecting";
}

async function loadInitial() {
  const response = await fetch(`${API_URL}/api/taxi`);
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
