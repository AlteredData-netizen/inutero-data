// controllo anti-chiavi: blocca un commit se dentro c'e' un token o una chiave
// uso: node scripts/check-secrets.mjs            (tutti i file del repository)
//      node scripts/check-secrets.mjs --staged   (solo i file pronti per il commit)
// stampa solo file e riga, mai la chiave trovata
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  ["Cloudflare account token", /cfat_[A-Za-z0-9_-]{20,}/],
  ["Cloudflare user token", /cfut_[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|github_pat_[A-Za-z0-9_]{40,}/],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["chiave privata", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Bearer scritto nel codice", /Bearer\s+[A-Za-z0-9._~+\/-]{24,}/],
  ["chiave scritta nel codice", /(api[_-]?key|token|secret)["']?\s*[:=]\s*["'][A-Za-z0-9_\-]{24,}["']/i]
];
// valori veri dei secret, se il controllo gira dentro il bot
const LIVE = [process.env.CLOUDFLARE_RADAR_TOKEN].filter((v) => v && v.length >= 16);

const staged = process.argv.includes("--staged");
const sh = (c) => execSync(c, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const files = (staged ? sh("git diff --cached --name-only --diff-filter=ACMR") : sh("git ls-files")).split("\n").filter(Boolean);

const hits = [];
for (const f of files) {
  let txt;
  try { txt = staged ? sh(`git show ":${f}"`) : readFileSync(f, "utf8"); } catch { continue; }
  if (txt.includes("\u0000")) continue; // file binario
  txt.split("\n").forEach((line, i) => {
    for (const [name, re] of PATTERNS) if (re.test(line)) hits.push(`${f}:${i + 1}  ${name}`);
    if (LIVE.some((v) => line.includes(v))) hits.push(`${f}:${i + 1}  valore di un secret`);
  });
}
if (hits.length) {
  console.error("BLOCCATO: possibile chiave nei file\n" + hits.join("\n"));
  process.exit(1);
}
console.log(`controllo chiavi ok (${files.length} file)`);
