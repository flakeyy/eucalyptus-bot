#!/usr/bin/env node
// Live modpack search against CurseForge + Modrinth with local relevance ranking.
//
// Usage:
//   node scripts/modpack-search.js atm
//   node scripts/modpack-search.js "better mc" --json
//   node scripts/modpack-search.js rlcraft --limit 10

"use strict";

require("dotenv").config();

const {
  searchModpacksDetailed,
  clearSearchCache,
  PROVIDER_LIMIT
} = require("../utility/modpack/search.js");

function parseArgs(argv) {
  const args = { query: null, json: false, limit: 25 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--limit") args.limit = Math.max(1, Number(argv[++i]) || 25);
    else if (a === "--help" || a === "-h") args.help = true;
    else rest.push(a);
  }
  args.query = rest.join(" ").trim();
  return args;
}

function formatDownloads(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.query) {
    console.log(`Usage: node scripts/modpack-search.js <query> [--json] [--limit N]

Fetches up to ${PROVIDER_LIMIT} hits per provider, re-ranks by name/slug relevance.
Requires CURSEFORGE_API_KEY in .env for CurseForge results (Modrinth works without).`);
    process.exit(opts.help ? 0 : 1);
  }

  if (!process.env.CURSEFORGE_API_KEY) {
    console.warn("[warn] CURSEFORGE_API_KEY missing — CurseForge results skipped");
  }

  clearSearchCache();
  const hits = await searchModpacksDetailed(opts.query);
  const sliced = hits.slice(0, opts.limit);

  if (opts.json) {
    console.log(JSON.stringify({ query: opts.query, results: sliced }, null, 2));
    return;
  }

  console.log(`Query: ${opts.query}`);
  console.log(`Results: ${sliced.length} (of ${hits.length} ranked)\n`);
  console.log(
    "rank".padStart(4),
    "score".padStart(7),
    "src".padEnd(3),
    "downloads".padStart(9),
    "value".padEnd(28),
    "name"
  );
  console.log("-".repeat(100));
  sliced.forEach((h, i) => {
    console.log(
      String(i + 1).padStart(4),
      (h.score ?? 0).toFixed(2).padStart(7),
      String(h.source).padEnd(3),
      formatDownloads(h.downloadCount).padStart(9),
      String(h.value).padEnd(28),
      h.name
    );
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
