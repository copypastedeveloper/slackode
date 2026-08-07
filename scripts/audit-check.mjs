#!/usr/bin/env node
// Strict production-dependency audit gate with an explicit allowlist.
//
// `npm audit` has no built-in per-advisory ignore, so this wraps it: the build
// fails on ANY production advisory except the ones allowlisted below. Prefer
// fixing/upgrading over adding entries here — each entry is a documented,
// accepted risk. Revisit periodically.
import { execFileSync } from "node:child_process";

// GHSA IDs we knowingly accept, with why.
const ALLOW = new Map([
  [
    "GHSA-f88m-g3jw-g9cj",
    "sharp<0.35 libvips CVEs. Pulled in by @huggingface/transformers, which " +
      "pins sharp@^0.34.5 (even at latest) so no in-range fix exists. Only used " +
      "for image preprocessing (we use text embeddings). Drop when transformers " +
      "allows sharp>=0.35 or an override is validated.",
  ],
]);

function runAudit() {
  try {
    // Exits 0 when clean; capture stdout either way.
    return execFileSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8" });
  } catch (err) {
    if (err.stdout) return err.stdout;
    throw err;
  }
}

const report = JSON.parse(runAudit());
const vulns = report.vulnerabilities ?? {};

const ghsaOf = (url) => (typeof url === "string" ? (url.match(/GHSA-[0-9a-z-]+/i)?.[0] ?? url) : null);

const blocking = [];
const allowed = [];
for (const [pkg, v] of Object.entries(vulns)) {
  for (const via of v.via ?? []) {
    if (typeof via !== "object" || !via.url) continue; // string links carry no advisory
    const id = ghsaOf(via.url);
    const entry = { pkg, id, severity: via.severity, title: via.title, url: via.url };
    if (id && ALLOW.has(id)) allowed.push(entry);
    else blocking.push(entry);
  }
}

for (const a of allowed) {
  console.log(`[audit] allowed: ${a.id} (${a.severity}) ${a.pkg} — ${ALLOW.get(a.id)}`);
}

if (blocking.length > 0) {
  console.error(`\n[audit] ${blocking.length} unallowlisted production advisory(ies):`);
  for (const b of blocking) console.error(`  - ${b.id ?? "?"} (${b.severity}) ${b.pkg}: ${b.title}\n    ${b.url}`);
  console.error("\nFix/upgrade, or (last resort) add the GHSA id to the allowlist in scripts/audit-check.mjs with a reason.");
  process.exit(1);
}

console.log(`[audit] OK — no unallowlisted production advisories (${allowed.length} allowlisted).`);
