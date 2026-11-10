"use strict";
const $ = (id) => document.getElementById(id);
const state = { cfg: { units: "mi", temp_unit: "F" }, hours: 24, map: null, marker: null, path: null, selectedDrive: null };
const MI_TO_KM = 1.609344;

// ---------- formatting ----------
const dist = (mi, d = 0) => mi == null ? "–" :
  state.cfg.units === "km" ? `${(mi * MI_TO_KM).toFixed(d)} km` : `${(+mi).toFixed(d)} mi`;
const eff = (whmi) => whmi == null ? "–" :
  state.cfg.units === "km" ? `${Math.round(whmi / MI_TO_KM)} Wh/km` : `${whmi} Wh/mi`;
const speed = (mph) => mph == null ? "–" :
  state.cfg.units === "km" ? `${Math.round(mph * MI_TO_KM)} km/h` : `${Math.round(mph)} mph`;
const temp = (c) => c == null ? "–" :
  state.cfg.temp_unit === "F" ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`;
const pct = (v) => v == null ? "–" : `${Math.round(v)}%`;
const kwh = (v, d = 1) => v == null ? "–" : `${(+v).toFixed(d)} kWh`;
const money = (v) => v == null ? "–" : `$${(+v).toFixed(2)}`;
const dur = (s) => { if (s == null) return "–"; const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`; };
const when = (ts) => new Date(ts * 1000).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const ago = (ts) => { const s = Date.now() / 1000 - ts; if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401) { location.href = "/login"; throw new Error("login required"); }
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

// ---------- tooltip ----------
const tip = $("tooltip");
function showTip(html, x, y) {
  tip.innerHTML = html; tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(window.innerWidth - w - 8, x + 14) + "px";
  tip.style.top = Math.max(8, y - h - 10) + "px";
}
const hideTip = () => { tip.hidden = true; };

// ---------- summary / live ----------
function badge(text, color) {
  const b = $("state-badge"); b.textContent = text; b.style.setProperty("--dot", `var(--${color})`);
}

function renderSummary(s) {
  state.cfg = s.config;
  const d = s.latest_data || {}, last = s.latest || {};
  $("car-name").textContent = s.meta.display_name || "My Tesla";
  $("mode-pill").textContent = s.config.mode === "demo" ? "Demo mode · simulated car" : "Live · Fleet API";
  $("login").hidden = s.config.mode !== "fleet" || s.authorized;
  renderSetup(s);

  let status = last.state || "unknown", color = "text-muted";
  if (s.open_drive) { status = "Driving"; color = "good"; }
  else if (s.open_charge) { status = "Charging"; color = "good"; }
  else if (last.state === "online") { status = "Parked"; color = "series-1"; }
  else if (last.state === "asleep") { status = "Asleep"; color = "text-muted"; }
  else if (last.state === "offline") { status = "Offline"; color = "warn"; }
  badge(status, color);
  $("last-seen").textContent = d.ts ? `· data ${ago(d.ts)}` : "· no data yet";

  // battery ring
  const C = 2 * Math.PI * 52;
  const soc = d.battery_level, lim = d.charge_limit;
  $("soc").textContent = soc == null ? "–" : `${soc}%`;
  $("ring-fill").style.strokeDasharray = C;
  $("ring-fill").style.strokeDashoffset = C * (1 - (soc || 0) / 100);
  $("ring-limit").style.strokeDasharray = C;
  $("ring-limit").style.strokeDashoffset = C * (1 - (lim || 0) / 100);
  $("range").textContent = dist(d.range);
  $("est-range").textContent = dist(d.est_range);
  $("limit").textContent = pct(lim);

  $("odo").textContent = dist(d.odometer);
  $("inside").textContent = temp(d.inside_temp);
  $("outside").textContent = temp(d.outside_temp);
  $("locked").textContent = d.locked == null ? "–" : d.locked ? "Locked" : "Unlocked";
  $("sentry").textContent = d.sentry == null ? "–" : d.sentry ? "On" : "Off";
  $("software").textContent = d.software || "–";

  // live card
  const kv = (l, v) => `<div><div class="label">${l}</div><div class="value">${v}</div></div>`;
  let title = "Status", body = "";
  if (s.open_drive) {
    const od = s.open_drive;
    title = "Driving now";
    body = kv("Speed", speed(d.speed)) + kv("Power", d.power == null ? "–" : `${d.power} kW`) +
      kv("Trip time", dur(od.duration_s)) + kv("Battery used", od.start_soc != null && soc != null ? `${Math.round(od.start_soc - soc)}%` : "–");
  } else if (s.open_charge) {
    const oc = s.open_charge;
    title = oc.fast ? "Supercharging" : "Charging";
    body = kv("Power", d.charger_power == null ? "–" : `${d.charger_power} kW`) + kv("Added", kwh(d.charge_energy_added)) +
      kv("Time to limit", d.minutes_to_full ? dur(d.minutes_to_full * 60) : "–") +
      kv("Session", dur(oc.duration_s));
  } else {
    body = kv("State", status) + kv("Plug", d.charging_state || "–") +
      kv("Last update", d.ts ? ago(d.ts) : "–") + kv("Next poll", s.poller.next_poll_in == null ? "–" : `${s.poller.next_poll_in}s`);
  }
  $("live-title").textContent = title;
  $("live-body").innerHTML = body;

  // API usage
  const p = s.poller;
  $("api-calls").textContent = p.api_calls_month.toLocaleString();
  $("api-cost").textContent = money(p.api_cost_month);
  const big = p.budget > 1e6;
  $("api-budget-label").textContent = big ? "Budget (off in demo)" : `Budget ${money(p.budget)}`;
  const frac = big ? 0 : Math.min(1, p.api_cost_month / p.budget);
  $("api-meter").style.width = `${frac * 100}%`;
  $("api-meter").classList.toggle("over", p.throttled);
  $("poller-phase").textContent = p.phase;

  const err = $("error");
  if (p.last_error) { err.hidden = false; err.textContent = p.last_error; } else err.hidden = true;

  // map: current location unless a drive is selected
  if (d.lat != null) updateMarker(d.lat, d.lon);
}

// ---------- first-run setup ----------
function renderSetup(s) {
  const box = $("setup");
  if (s.config.mode !== "fleet" || s.authorized) { box.hidden = true; return; }
  const step = (done, text) => `<li class="${done ? "done" : ""}">${done ? "✓ " : ""}${text}</li>`;
  box.hidden = false;
  box.innerHTML = `<h2>Finish setup</h2><ol>
    ${step(s.public_key_configured, "Public key installed (<code>npx wrangler secret put PUBLIC_KEY_PEM</code>)")}
    ${step(s.partner_registered, `Register this domain with Tesla <button class="btn" id="register">Register ${esc(location.hostname)}</button>`)}
    ${step(false, `Connect your Tesla account <a class="btn" href="/auth/login">Connect</a>`)}
  </ol><div id="setup-msg" class="muted small"></div>`;
  const btn = $("register");
  if (btn) btn.onclick = async () => {
    btn.disabled = true; $("setup-msg").textContent = "Registering…";
    try {
      const r = await fetch("/api/setup/register", { method: "POST" });
      const body = await r.json();
      $("setup-msg").textContent = r.ok ? "Registered." : `Failed: ${body.error}`;
      if (r.ok) refresh(true);
    } finally { btn.disabled = false; }
  };
}

// ---------- map ----------
function initMap() {
  if (!window.L) { $("map").innerHTML = '<p class="muted small" style="padding:12px">Map unavailable (offline).</p>'; return; }
  state.map = L.map("map", { zoomControl: true, attributionControl: true }).setView([37.4, -122.1], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(state.map);
}
function updateMarker(lat, lon) {
  if (!state.map) return;
  if (!state.marker) {
    state.marker = L.circleMarker([lat, lon], { radius: 8, color: getCss("--surface-1"), weight: 2,
      fillColor: getCss("--series-1"), fillOpacity: 1 }).addTo(state.map).bindTooltip("Car");
    if (!state.selectedDrive) state.map.setView([lat, lon], 13);
  } else state.marker.setLatLng([lat, lon]);
  if (!state.selectedDrive) $("map-caption").textContent = "· current position";
}
async function showDrive(id, row) {
  document.querySelectorAll("#drives tr.selected").forEach((r) => r.classList.remove("selected"));
  if (state.selectedDrive === id) { // toggle off
    state.selectedDrive = null; if (state.path) state.path.remove(); state.path = null;
    $("map-caption").textContent = "· current position";
    if (state.marker) state.map.setView(state.marker.getLatLng(), 13);
    return;
  }
  row.classList.add("selected");
  state.selectedDrive = id;
  const d = await api(`/api/drives/${id}`);
  $("map-caption").textContent = `· drive ${when(d.start_ts)}, ${dist(d.distance, 1)}` +
    (d.inferred ? " (no route: drive happened between checks)" : "");
  if (state.path) { state.path.remove(); state.path = null; }
  if (!state.map || d.path.length < 2) return;
  if (state.path) state.path.remove();
  state.path = L.polyline(d.path, { color: getCss("--series-1"), weight: 4, opacity: .9 }).addTo(state.map);
  state.map.fitBounds(state.path.getBounds(), { padding: [20, 20] });
  $("map").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
const getCss = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// ---------- charts (plain SVG) ----------
const NS = "http://www.w3.org/2000/svg";
function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function lineChart(container, rows) {
  container.innerHTML = "";
  const pts = rows.filter((r) => r.battery_level != null);
  if (pts.length < 2) { container.innerHTML = '<p class="muted">Not enough data yet.</p>'; return; }
  const W = container.clientWidth, H = container.clientHeight, m = { l: 36, r: 8, t: 8, b: 22 };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Battery level over time" }, container);
  const t0 = pts[0].ts, t1 = pts[pts.length - 1].ts;
  const x = (t) => m.l + (t - t0) / (t1 - t0 || 1) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - v / 100) * (H - m.t - m.b);
  // grid + y labels
  const ax = el("g", { class: "axis" }, svg);
  for (const v of [0, 25, 50, 75, 100]) {
    el("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "gridline" }, svg);
    el("text", { x: m.l - 6, y: y(v) + 4, "text-anchor": "end" }, ax).textContent = `${v}%`;
  }
  // x labels
  const span = t1 - t0, n = Math.max(2, Math.floor((W - m.l) / 110));
  for (let i = 0; i <= n; i++) {
    const t = t0 + span * i / n, dt = new Date(t * 1000);
    const label = span > 2 * 86400 ? dt.toLocaleDateString([], { month: "short", day: "numeric" })
      : dt.toLocaleTimeString([], { hour: "numeric" });
    el("text", { x: x(t), y: H - 4, "text-anchor": i === 0 ? "start" : i === n ? "end" : "middle" }, ax).textContent = label;
  }
  // charging bands
  let bandStart = null;
  pts.forEach((p, i) => {
    const charging = p.charger_power > 0;
    if (charging && bandStart == null) bandStart = p.ts;
    if ((!charging || i === pts.length - 1) && bandStart != null) {
      el("rect", { x: x(bandStart), y: m.t, width: Math.max(2, x(p.ts) - x(bandStart)), height: H - m.t - m.b, class: "charge-band" }, svg);
      bandStart = null;
    }
  });
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.battery_level).toFixed(1)}`).join("");
  el("path", { d: `${d}L${x(t1)},${y(0)}L${x(t0)},${y(0)}Z`, class: "area" }, svg);
  el("path", { d, class: "line" }, svg);
  // hover
  const cross = el("line", { y1: m.t, y2: H - m.b, class: "crosshair", visibility: "hidden" }, svg);
  const dot = el("circle", { r: 4, class: "dot", visibility: "hidden" }, svg);
  const hit = el("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" }, svg);
  hit.addEventListener("mousemove", (ev) => {
    const r = svg.getBoundingClientRect(), mx = (ev.clientX - r.left) * W / r.width;
    const t = t0 + (mx - m.l) / (W - m.l - m.r) * (t1 - t0);
    let best = pts[0]; for (const p of pts) if (Math.abs(p.ts - t) < Math.abs(best.ts - t)) best = p;
    cross.setAttribute("x1", x(best.ts)); cross.setAttribute("x2", x(best.ts)); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", x(best.ts)); dot.setAttribute("cy", y(best.battery_level)); dot.setAttribute("visibility", "visible");
    let extra = best.charger_power > 0 ? `<br>Charging ${best.charger_power} kW` : best.speed ? `<br>Driving ${speed(best.speed)}` : "";
    showTip(`${when(best.ts)}<br>Battery <b>${best.battery_level}%</b> · ${dist(best.range)}${extra}`, ev.clientX, ev.clientY);
  });
  hit.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); hideTip(); });
  // legend (charging band key)
  const lg = document.createElement("div"); lg.className = "legend";
  lg.innerHTML = `<span><i style="background:var(--series-1)"></i>Battery %</span><span><i style="background:var(--series-2);opacity:.35"></i>Charging</span>`;
  container.appendChild(lg);
}

function barChart(container, rows, key, fmt) {
  container.innerHTML = "";
  const W = container.clientWidth, H = container.clientHeight, m = { l: 44, r: 8, t: 8, b: 22 };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Distance per day" }, container);
  const vals = rows.map((r) => state.cfg.units === "km" ? r[key] * MI_TO_KM : r[key]);
  const max = Math.max(1, ...vals), nice = niceMax(max);
  const bw = (W - m.l - m.r) / rows.length, y = (v) => m.t + (1 - v / nice) * (H - m.t - m.b);
  const ax = el("g", { class: "axis" }, svg);
  for (let i = 0; i <= 4; i++) {
    const v = nice * i / 4;
    el("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "gridline" }, svg);
    el("text", { x: m.l - 6, y: y(v) + 4, "text-anchor": "end" }, ax).textContent = Math.round(v);
  }
  rows.forEach((r, i) => {
    const v = vals[i], bx = m.l + i * bw + 1, w = Math.max(1, bw - 2), h = H - m.b - y(v);
    if (v > 0) {
      const rad = Math.min(4, w / 2, h);
      const yt = y(v), yb = H - m.b;
      el("path", { class: "bar", d: `M${bx},${yb}V${yt + rad}Q${bx},${yt} ${bx + rad},${yt}H${bx + w - rad}Q${bx + w},${yt} ${bx + w},${yt + rad}V${yb}Z` }, svg);
    }
    if (i % Math.ceil(rows.length / 8) === 0)
      el("text", { x: bx + w / 2, y: H - 4, "text-anchor": "middle" }, ax).textContent =
        new Date(r.date + "T12:00").toLocaleDateString([], { month: "short", day: "numeric" });
    const hit = el("rect", { x: m.l + i * bw, y: m.t, width: bw, height: H - m.t - m.b, fill: "transparent" }, svg);
    hit.addEventListener("mousemove", (ev) => showTip(
      `${new Date(r.date + "T12:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}<br>` +
      `Distance <b>${fmt(r[key])}</b><br>Charged ${kwh(r.charged_kwh)}`, ev.clientX, ev.clientY));
    hit.addEventListener("mouseleave", hideTip);
  });
}
function niceMax(v) { const p = 10 ** Math.floor(Math.log10(v)); for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= v) return k * p; return v; }

// ---------- tables & stats ----------
function renderDrives(rows) {
  const tb = document.querySelector("#drives tbody");
  tb.innerHTML = rows.length ? "" : '<tr><td colspan="6" class="muted">No drives yet.</td></tr>';
  for (const d of rows) {
    const tr = document.createElement("tr");
    if (d.id === state.selectedDrive) tr.classList.add("selected");
    tr.innerHTML = `<td>${when(d.start_ts)} ${d.in_progress ? '<span class="live-dot">● live</span>' : ""}${d.inferred ? ' <span class="tag" title="Happened between two checks; distance and battery from the odometer, no route">no route</span>' : ""}</td>
      <td>${d.inferred ? "–" : (d.start_estimated ? "~" : "") + dur(d.duration_s)}</td><td class="num">${dist(d.distance, 1)}</td>
      <td class="num">${pct(d.start_soc)} → ${pct(d.end_soc)}</td><td class="num">${eff(d.wh_per_mi)}</td>
      <td class="num">${speed(d.avg_speed)}</td>`;
    tr.title = "Show route on map";
    tr.addEventListener("click", () => showDrive(d.id, tr));
    tb.appendChild(tr);
  }
}
function renderCharges(rows) {
  const tb = document.querySelector("#charges tbody");
  tb.innerHTML = rows.length ? "" : '<tr><td colspan="7" class="muted">No charging sessions yet.</td></tr>';
  for (const c of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${when(c.start_ts)} ${c.in_progress ? '<span class="live-dot">● live</span>' : ""}</td>
      <td><span class="tag ${c.fast ? "fast" : ""}">${c.fast ? "DC fast" : "AC"}</span></td>
      <td>${dur(c.duration_s)}</td><td class="num">${pct(c.start_soc)} → ${pct(c.end_soc)}</td>
      <td class="num">${kwh(c.energy_added)}</td><td class="num">${c.max_power ? `${Math.round(c.max_power)} kW` : "–"}</td>
      <td class="num">${c.in_progress ? "–" : money(c.cost)}</td>`;
    tr.style.cursor = "default";
    tb.appendChild(tr);
  }
}
function renderStats(s) {
  const k = (l, v) => `<div><div class="label">${l}</div><div class="value">${v}</div></div>`;
  $("kpis").innerHTML = k("Distance", dist(s.distance)) + k("Drives", s.drive_count) +
    k("Time driving", `${s.drive_hours} h`) + k("Avg efficiency", eff(s.avg_wh_per_mi)) +
    k("Energy charged", kwh(s.charged_kwh, 0)) + k("Charging cost", money(s.charge_cost)) +
    k("Cost per " + (state.cfg.units === "km" ? "km" : "mile"),
      s.cost_per_mi == null ? "–" : money(state.cfg.units === "km" ? s.cost_per_mi / MI_TO_KM : s.cost_per_mi)) +
    k("DC fast share", s.fast_charge_share == null ? "–" : `${s.fast_charge_share}%`);
  $("daily-title").textContent = `Distance per day (${state.cfg.units})`;
  barChart($("daily-chart"), s.daily, "distance", (v) => dist(v, 1));
}

// ---------- refresh loop ----------
let lastSlow = 0, cache = {};
async function refresh(force = false) {
  try {
    const s = await api("/api/summary");
    renderSummary(s);
    const now = Date.now();
    if (force || now - lastSlow > 60000 || s.open_drive || s.open_charge) {
      lastSlow = now;
      const [hist, drives, charges, stats] = await Promise.all([
        api(`/api/history?hours=${state.hours}`), api("/api/drives?limit=25"),
        api("/api/charges?limit=15"), api(`/api/stats?days=30&tz=${-new Date().getTimezoneOffset()}`)]);
      cache = { hist, stats };
      lineChart($("soc-chart"), hist); renderDrives(drives); renderCharges(charges); renderStats(stats);
    }
  } catch (e) {
    const err = $("error"); err.hidden = false; err.textContent = `Dashboard can't reach the server: ${e.message}`;
  }
}

$("refresh").addEventListener("click", async () => { await api("/api/poll", { method: "POST" }); setTimeout(() => refresh(true), 1500); });
$("theme").addEventListener("click", () => {
  const r = document.documentElement, t = r.dataset.theme === "dark" ? "light" : "dark";
  r.dataset.theme = t; localStorage.setItem("teslog-theme", t);
  if (cache.hist) { lineChart($("soc-chart"), cache.hist); renderStats(cache.stats); }
});
document.querySelectorAll("#hist-range button").forEach((b) => b.addEventListener("click", async () => {
  document.querySelectorAll("#hist-range button").forEach((x) => x.classList.toggle("on", x === b));
  state.hours = +b.dataset.h;
  cache.hist = await api(`/api/history?hours=${state.hours}`); lineChart($("soc-chart"), cache.hist);
}));
let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => {
  if (cache.hist) { lineChart($("soc-chart"), cache.hist); renderStats(cache.stats); } }, 150); });

const saved = localStorage.getItem("teslog-theme");
if (saved) document.documentElement.dataset.theme = saved;
else if (matchMedia("(prefers-color-scheme: light)").matches) document.documentElement.dataset.theme = "light";
initMap();
refresh(true);
setInterval(refresh, 10000);
