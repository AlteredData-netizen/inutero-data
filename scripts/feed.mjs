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
async function getText(url, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(90000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
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

// --- FONTE: CO2 atmosferica, Mauna Loa (NOAA GML, CC0 1.0) ---
// righe: anno,mese,giorno,anno decimale,ppm — i giorni senza misura mancano
const PREINDUSTRIAL = 280;
async function co2() {
  const txt = await getText("https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_daily_mlo.csv");
  const rows = txt.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => {
    const [y, m, d, , v] = l.split(",").map(Number);
    return { t: Date.UTC(y, m - 1, d), date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, ppm: v };
  }).filter((r) => Number.isFinite(r.ppm) && r.ppm > 0);
  if (!rows.length) throw new Error("nessuna misura valida");
  const last = rows[rows.length - 1];
  const yearAgo = last.t - 365 * 86400000;
  const ref = rows.reduce((b, r) => (Math.abs(r.t - yearAgo) < Math.abs(b.t - yearAgo) ? r : b), rows[0]);
  const refOk = Math.abs(ref.t - yearAgo) <= 10 * 86400000;
  const prevMax = Math.max(...rows.slice(0, -1).map((r) => r.ppm));
  const recent = rows.filter((r) => r.t > last.t - 30 * 86400000);
  const events = [];
  if (last.ppm > prevMax) events.push({ source: "co2", date: last.date, place: "Mauna Loa", value: r1(last.ppm), unit: "ppm, highest daily mean on record" });
  return {
    metrics: {
      ppm: r1(last.ppm),
      date: last.date,
      yoyDelta: refOk ? Math.round((last.ppm - ref.ppm) * 100) / 100 : null,
      mean30: r1(recent.reduce((a, r) => a + r.ppm, 0) / recent.length),
      abovePreindustrial: Math.round((last.ppm / PREINDUSTRIAL - 1) * 100) / 100,
      record: r1(Math.max(prevMax, last.ppm))
    },
    points: recent.map((r) => ({ date: r.date, ppm: r.ppm })),
    events
  };
}

// --- FONTE: disastri naturali (GDACS, EU / UN OCHA, CC BY 4.0) ---
// terremoti, cicloni, alluvioni, vulcani, siccita, incendi; allerta green / orange / red
// orange e red diventano eventi; eventId permette al front di non contare due volte un evento che dura
const HAZARD = { EQ: "earthquake", TC: "cyclone", FL: "flood", VO: "volcano", DR: "drought", WF: "wildfire", TS: "tsunami" };
async function disasters() {
  const ymd = (t) => new Date(t).toISOString().slice(0, 10);
  const from = ymd(today - 2 * 86400000), to = ymd(today + 86400000);
  // una chiamata per tipo: la ricerca GDACS restituisce al massimo 100 eventi, gli incendi riempirebbero tutto
  const feats = [], capped = [];
  for (const code of Object.keys(HAZARD)) {
    // se un tipo non ha eventi GDACS risponde vuoto: vale come zero, non come errore
    const txt = (await getText(`https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=${code}&fromdate=${from}&todate=${to}&alertlevel=green;orange;red`)).trim();
    const j = txt ? JSON.parse(txt) : {};
    const f = Array.isArray(j.features) ? j.features : [];
    if (f.length >= 100) capped.push(HAZARD[code]);
    feats.push(...f);
    await sleep(2000);
  }
  const all = feats.map((f) => {
    const p = f.properties || {};
    const c = (f.geometry && f.geometry.type === "Point") ? f.geometry.coordinates : null;
    const sev = p.severitydata || {};
    return {
      id: `${p.eventtype}-${p.eventid}`,
      type: HAZARD[p.eventtype] || String(p.eventtype || "other").toLowerCase(),
      alert: String(p.alertlevel || "green").toLowerCase(),
      score: Number(p.alertscore) || 0,
      place: String(p.country || p.name || "").split(",").map((s) => s.trim()).filter(Boolean).join(", "),
      lat: c ? r1(c[1]) : null, lon: c ? r1(c[0]) : null,
      from: String(p.fromdate || "").slice(0, 10), to: String(p.todate || "").slice(0, 10),
      severity: sev.severitytext || null
    };
  });
  const n = (a) => all.filter((p) => p.alert === a).length;
  const byType = {};
  all.forEach((p) => { byType[p.type] = (byType[p.type] || 0) + 1; });
  // punti: tutti gli orange e red, poi i green piu recenti, massimo 150
  const grave = all.filter((p) => p.alert !== "green");
  const green = all.filter((p) => p.alert === "green").sort((a, b) => (b.from > a.from ? 1 : -1));
  const points = [...grave, ...green].slice(0, Math.max(150, grave.length));
  return {
    metrics: { total: all.length, green: n("green"), orange: n("orange"), red: n("red"), byType, capped, alertScore: r1(all.reduce((a, p) => a + p.score, 0)) },
    points,
    events: grave.map((p) => ({ source: "disasters", eventId: p.id, date: p.to || p.from, place: p.place, value: p.alert, unit: p.type + (p.severity ? " — " + p.severity : "") }))
  };
}

// --- FONTE (DOSE annuale): morti e dispersi in migrazione, SDG 10.7.3 ---
// IOM Missing Migrants Project (CC BY 4.0), ripubblicato da Our World in Data (CC BY 4.0)
// il CSV ufficiale IOM blocca i download automatici e il servizio ArcGIS IOM oggi non risponde: si passa da OWID
// il dato arriva una volta l'anno: il totale dell'ultimo anno chiuso diventa una razione giornaliera
function csvLine(l) {
  const out = []; let cur = "", q = false;
  for (const ch of l) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur); return out;
}
async function migrants() {
  const txt = await getText("https://ourworldindata.org/grapher/deaths-and-disappearances-during-migration.csv?v=1&csvType=full&useColumnShortNames=true");
  const rows = txt.split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean).slice(1).map(csvLine)
    .map(([entity, code, year, v]) => ({ entity, code, year: Number(year), v: Number(v) }))
    .filter((r) => Number.isFinite(r.year) && Number.isFinite(r.v));
  const world = rows.filter((r) => r.code === "OWID_WRL").sort((a, b) => a.year - b.year);
  if (!world.length) throw new Error("nessun totale mondiale");
  const last = world[world.length - 1], before = world[world.length - 2];
  const days = (last.year % 4 === 0 && last.year % 100 !== 0) || last.year % 400 === 0 ? 366 : 365;
  const perDay = Math.round((last.v / days) * 100) / 100;
  // paesi con codice ISO (niente aggregati OWID), anno piu recente, i dieci con piu vittime
  const countries = rows.filter((r) => r.year === last.year && /^[A-Z]{3}$/.test(r.code) && r.v > 0)
    .sort((a, b) => b.v - a.v).slice(0, 10).map((r) => ({ place: r.entity, code: r.code, value: r.v }));
  return {
    metrics: {
      year: last.year, total: last.v,
      prevYear: before ? before.v : null,
      yoyDelta: before ? last.v - before.v : null,
      perDay,
      sinceFirst: world.reduce((a, r) => a + r.v, 0), firstYear: world[0].year,
      record: Math.max(...world.map((r) => r.v))
    },
    points: [...world.map((r) => ({ year: r.year, value: r.v })), ...countries.map((c) => ({ year: last.year, ...c }))],
    dose: [{ source: "migrants", organ: "blood", year: last.year, total: last.v, perDay, unit: "people dead or missing during migration" }]
  };
}

// --- registro delle fonti: ognuna fallisce da sola, mai il job intero ---
const SOURCES = {
  heat: { fn: heat, license: "CC BY 4.0", credit: "Weather data by Open-Meteo.com (ERA5 baseline 1991-2020; anomalies computed by IN/UTERO)", url: "https://open-meteo.com/" },
  co2: { fn: co2, license: "CC0 1.0", credit: "Atmospheric CO2 at Mauna Loa Observatory (Maunakea Dec 2022 - Jul 2023), NOAA Global Monitoring Laboratory (Lan, Tans & Thoning) and Scripps Institution of Oceanography (Keeling)", url: "https://gml.noaa.gov/ccgg/trends/" },
  disasters: { fn: disasters, license: "CC BY 4.0", credit: "Global Disaster Alert and Coordination System, GDACS (European Union / UN OCHA)", url: "https://www.gdacs.org/" },
  migrants: { fn: migrants, license: "CC BY 4.0", credit: "IOM's Missing Migrants Project (SDG 10.7.3), processed by Our World in Data; daily ration computed by IN/UTERO", url: "https://missingmigrants.iom.int/" }
};

const sources = {}, events = [], dose = [];
const prevDose = Array.isArray(prev.dose) ? prev.dose : [];
for (const [key, s] of Object.entries(SOURCES)) {
  try {
    const res = await s.fn();
    sources[key] = { ok: true, stale: false, lastOk: now.toISOString(), license: s.license, credit: s.credit, url: s.url, metrics: res.metrics, points: res.points };
    (res.events || []).forEach((e) => events.push(e));
    (res.dose || []).forEach((d) => dose.push(d));
  } catch (e) {
    const old = prevSources[key] || {};
    sources[key] = { ...old, ok: false, stale: true, license: s.license, credit: s.credit, url: s.url, error: String(e.message || e) };
    prevDose.filter((d) => d.source === key).forEach((d) => dose.push({ ...d, stale: true }));
  }
}

const out = { generated: now.toISOString(), gestation, sources, events, dose };
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ gestation, ...Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.ok ? v.metrics : v.error])), events: events.length, dose: dose.length }));
