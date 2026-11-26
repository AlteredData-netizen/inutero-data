import { writeFileSync } from "node:fs";
// IN/UTERO - giorno 0 = 26 dic 2026, termine al giorno 280, poi nuova gestazione
const DAY0 = Date.UTC(2026, 11, 26);
const LEN = 281;
const now = new Date();
const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const diff = Math.floor((today - DAY0) / 86400000);
const gestation = diff < 0
  ? { day0: "2026-12-26", day: null, cycle: 0, daysToStart: -diff }
  : { day0: "2026-12-26", day: diff % LEN, cycle: Math.floor(diff / LEN) + 1, daysToStart: 0 };
const out = { generated: now.toISOString(), gestation, events: [], dose: [] };
writeFileSync("inutero-data.json", JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(gestation));