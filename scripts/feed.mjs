import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const OUT = "inutero-data.json";
const BASE = "data/baseline-heat.json";
const UA = { "User-Agent": "inutero-data/1.0 (non-commercial artwork; github.com/AlteredData-netizen/inutero-data)" };

// --- tempo della gestazione: giorno 0 = 26 dic 2026, termine al giorno 280 ---
const DAY0 = Date.UTC(2026, 11, 26);
const LEN = 281;
const now = new Date();
const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const diff = Math.floor((today - DAY0) / 86400000);
const gestation = diff < 0
  ? { day0: "2026-12-26", day: null, cycle: 0, daysToStart: -diff }
  : { day0: "2026-12-26", day: diff % LEN, cycle: Math.floor(diff / LEN) + 1, daysToStart: 0 };

const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const prevSources = (prev.sources && !Array.isArray(prev.sources)) ? prev.sources : {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(90000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) { last = e; if (i < tries) await sleep(String(e.message).includes("429") ? 65000 : 5000 * i); }
  }
  throw last;
}
const doy = (s) => { const [y, m, d] = s.split("-").map(Number); return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000); };
const r1 = (x) => Math.round(x * 10) / 10;

// --- FONTE: calore (Open-Meteo, CC BY 4.0) ---
const POINTS = [
  ["Delhi", 28.61, 77.21], ["Karachi", 24.86, 67.01], ["Dhaka", 23.81, 90.41], ["Riyadh", 24.71, 46.68],
  ["Tehran", 35.69, 51.39], ["Cairo", 30.04, 31.24], ["Lagos", 6.52, 3.38], ["Kinshasa", -4.32, 15.31],
  ["Johannesburg", -26.2, 28.05], ["Madrid", 40.42, -3.70], ["Rome", 41.90, 12.50], ["Moscow", 55.76, 37.62],
  ["Beijing", 39.90, 116.40], ["Tokyo", 35.68, 139.69], ["Manila", 14.60, 120.98], ["Jakarta", -6.21, 106.85],
  ["Sydney", -33.87, 151.21], ["Phoenix", 33.45, -112.07], ["New York", 40.71, -74.01], ["Mexico City", 19.43, -99.13],
  ["Lima", -12.05, -77.04], ["Sao Paulo", -23.55, -46.63]
];

async function buildBaseline() {
  const points = {};
  for (const [name, lat, lon] of POINTS) {
    const j = await getJSON(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=1991-01-01&end_date=2020-12-31&daily=temperature_2m_max&timezone=auto`);
    const sum = new Array(366).fill(0), cnt = new Array(366).fill(0);
    j.daily.time.forEach((t, i) => { const v = j.daily.temperature_2m_max[i]; if (v != null) { const k = doy(t); sum[k] += v; cnt[k]++; } });
    const mean = [];
    for (let d = 0; d < 366; d++) {
      let s = 0, c = 0;
      for (let k = -7; k <= 7; k++) { const q = (d + k + 366) % 366; s += sum[q]; c += cnt[q]; }
      mean.push(c ? r1(s / c) : null);
    }
    points[name] = mean;
    console.log("baseline: " + name);
    await sleep(12000);
  }
  return { period: "1991-2020", window: "+-7 days", source: "Open-Meteo Historical Weather API (ERA5)", points };
}

async function heat() {
  let base;
  if (existsSync(BASE)) base = JSON.parse(readFileSync(BASE, "utf8"));
  else { base = await buildBaseline(); mkdirSync("data", { recursive: true }); writeFileSync(BASE, JSON.stringify(base) + "\n"); }
  const lats = POINTS.map((p) => p[1]).join(","), lons = POINTS.map((p) => p[2]).join(",");
  const j = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&daily=temperature_2m_max&past_days=1&forecast_days=1&timezone=auto`);
  const arr = Array.isArray(j) ? j : [j];
  const points = [];
  arr.forEach((loc, i) => {
    const name = POINTS[i][0];
    const t = loc.daily.time[0], v = loc.daily.temperature_2m_max[0];
    const b = base.points[name] ? base.points[name][doy(t)] : null;
    if (v != null && b != null) points.push({ name, date: t, tmax: r1(v), anomaly: r1(v - b) });
  });
  if (!points.length) throw new Error("nessun punto valido");
  const hot = points.filter((p) => p.anomaly >= 5);
  return {
    metrics: {
      meanAnomaly: r1(points.reduce((a, p) => a + p.anomaly, 0) / points.length),
      hotShare: Math.round((hot.length / points.length) * 100) / 100,
      maxTmax: Math.max(...points.map((p) => p.tmax))
    },
    points,
    events: hot.map((p) => ({ source: "heat", date: p.date, place: p.name, value: p.anomaly, unit: "C above 1991-2020 mean" }))
  };
}

// --- registro delle fonti: ognuna fallisce da sola, mai il job intero ---
const SOURCES = {
  heat: { fn: heat, license: "CC BY 4.0", credit: "Weather data by Open-Meteo.com (ERA5 baseline 1991-2020; anomalies computed by IN/UTERO)", url: "https://open-meteo.com/" }
};

const sources = {}, events = [];
for (const [key, s] of Object.entries(SOURCES)) {
  try {
    const res = await s.fn();
    sources[key] = { ok: true, stale: false, lastOk: now.toISOString(), license: s.license, credit: s.credit, url: s.url, metrics: res.metrics, points: res.points };
    (res.events || []).forEach((e) => events.push(e));
  } catch (e) {
    const old = prevSources[key] || {};
    sources[key] = { ...old, ok: false, stale: true, license: s.license, credit: s.credit, url: s.url, error: String(e.message || e) };
  }
}

const out = { generated: now.toISOString(), gestation, sources, events, dose: [] };
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ gestation, heat: sources.heat.ok ? sources.heat.metrics : sources.heat.error, events: events.length }));