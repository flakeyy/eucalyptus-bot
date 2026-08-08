#!/usr/bin/env node
// Live hit@N eval for modpack autocomplete ranking.
//
// Usage:
//   node scripts/eval_modpack_search.js
//   node scripts/eval_modpack_search.js --corpus docs/modpack-search-corpus.json

"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const {
  searchModpacksDetailed,
  clearSearchCache
} = require("../utility/modpack/search.js");

function parseArgs(argv) {
  const args = { corpus: path.join(__dirname, "..", "docs", "modpack-search-corpus.json") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--corpus") args.corpus = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
  }
  return args;
}

function matchesExpect(hit, expect) {
  const source = String(expect.source || "").toLowerCase();
  const idOrSlug = String(expect.idOrSlug || "").toLowerCase();
  if (!source || !idOrSlug) return false;
  if (hit.source !== source) return false;
  if (String(hit.id).toLowerCase() === idOrSlug) return true;
  if (String(hit.slug || "").toLowerCase() === idOrSlug) return true;
  if (String(hit.value || "").toLowerCase() === `${source}:${idOrSlug}`) return true;
  return false;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: node scripts/eval_modpack_search.js [--corpus path]");
    process.exit(0);
  }

  const raw = JSON.parse(fs.readFileSync(opts.corpus, "utf8"));
  const cases = Array.isArray(raw) ? raw : (raw.cases || []);
  if (!cases.length) {
    console.error("No cases in corpus");
    process.exit(1);
  }

  if (!process.env.CURSEFORGE_API_KEY) {
    console.warn("[warn] CURSEFORGE_API_KEY missing — CF expects may miss");
  }

  let passed = 0;
  const misses = [];

  for (const c of cases) {
    const query = c.query;
    const topN = c.topN ?? 5;
    clearSearchCache();
    const hits = await searchModpacksDetailed(query);
    const window = hits.slice(0, topN);
    const hit = window.find(h => matchesExpect(h, c.expect));
    const ok = Boolean(hit);
    if (ok) {
      passed++;
      const rank = window.indexOf(hit) + 1;
      console.log(`PASS  "${query}" → ${hit.value} @${rank}/${topN}  (${hit.name})`);
    } else {
      misses.push({ query, expect: c.expect, topN, got: window.map(h => h.value) });
      console.log(`FAIL  "${query}" → want ${c.expect.source}:${c.expect.idOrSlug} in top ${topN}`);
      console.log(`      got: ${window.map(h => h.value).join(", ") || "(none)"}`);
    }
  }

  const total = cases.length;
  console.log(`\n${passed}/${total} hit@N (${((passed / total) * 100).toFixed(1)}%)`);
  if (misses.length) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
