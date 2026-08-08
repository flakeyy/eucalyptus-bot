"use strict";

/**
 * Parallel CurseForge + Modrinth modpack search for Discord autocomplete.
 * Discord kills autocomplete at 3s — budget 2s and cache hits for 60s.
 */

const msgLog = require("../logger.js");

const CURSEFORGE_BASE_URL = "https://api.curseforge.com/v1";
const MODRINTH_BASE_URL = "https://api.modrinth.com/v2";
const USER_AGENT = "pterobot/discord-bot";

const SEARCH_BUDGET_MS = 2000;
const CACHE_TTL_MS = 60_000;
const MAX_CHOICES = 25;

const cache = new Map(); // queryLower → { at, results }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.results;
}

function cacheSet(key, results) {
  cache.set(key, { at: Date.now(), results });
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("search-timeout")), ms);
  });
  return Promise.race([ promise, timeout ]).finally(() => clearTimeout(timer));
}

async function searchCurseForge(query) {
  if (!process.env.CURSEFORGE_API_KEY) return [];
  const url = `${CURSEFORGE_BASE_URL}/mods/search?gameId=432&classId=4471&pageSize=10&searchFilter=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "x-api-key": process.env.CURSEFORGE_API_KEY, Accept: "application/json" }
  });
  if (!res.ok) throw new Error(`CF search HTTP ${res.status}`);
  const data = await res.json();
  return (data.data || []).map(m => ({
    source: "cf",
    id: String(m.id),
    value: `cf:${m.id}`,
    name: m.name || m.slug || String(m.id),
    slug: m.slug || null,
    downloadCount: m.downloadCount ?? 0
  }));
}

async function searchModrinth(query) {
  const facets = encodeURIComponent(JSON.stringify([ [ "project_type:modpack" ] ]));
  const url = `${MODRINTH_BASE_URL}/search?limit=10&facets=${facets}&query=${encodeURIComponent(query)}`;
  const headers = { "User-Agent": USER_AGENT };
  if (process.env.MODRINTH_API_KEY) headers.Authorization = process.env.MODRINTH_API_KEY;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`MR search HTTP ${res.status}`);
  const data = await res.json();
  return (data.hits || []).map(h => ({
    source: "mr",
    id: String(h.project_id || h.slug),
    value: `mr:${h.slug || h.project_id}`,
    name: h.title || h.slug || String(h.project_id),
    slug: h.slug || null,
    downloadCount: h.downloads ?? 0
  }));
}

/**
 * Search both providers in parallel. Returns up to 25 Discord autocomplete choices:
 * `{ name, value }` where value is `cf:<id>` or `mr:<slug>`.
 */
async function searchModpacks(query) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];

  const cacheKey = q.toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const settled = await Promise.allSettled([
    withTimeout(searchCurseForge(q), SEARCH_BUDGET_MS),
    withTimeout(searchModrinth(q), SEARCH_BUDGET_MS)
  ]);

  const cf = settled[0].status === "fulfilled" ? settled[0].value : [];
  const mr = settled[1].status === "fulfilled" ? settled[1].value : [];
  if (settled[0].status === "rejected") {
    msgLog.debugExtended(`[modpack-search] CF: ${settled[0].reason?.message || settled[0].reason}`);
  }
  if (settled[1].status === "rejected") {
    msgLog.debugExtended(`[modpack-search] MR: ${settled[1].reason?.message || settled[1].reason}`);
  }

  // Interleave by download count, prefer unique names, cap at Discord's 25.
  const merged = [ ...cf, ...mr ].sort((a, b) => (b.downloadCount || 0) - (a.downloadCount || 0));
  const seen = new Set();
  const choices = [];
  for (const hit of merged) {
    const label = hit.source === "cf"
      ? `${hit.name} (CurseForge)`.slice(0, 100)
      : `${hit.name} (Modrinth)`.slice(0, 100);
    if (seen.has(hit.value)) continue;
    seen.add(hit.value);
    choices.push({ name: label, value: hit.value.slice(0, 100) });
    if (choices.length >= MAX_CHOICES) break;
  }

  cacheSet(cacheKey, choices);
  return choices;
}

/** Parse an autocomplete choice value into `{ source, id }`. */
function parsePackChoice(value) {
  const m = String(value || "").match(/^(cf|mr):(.+)$/i);
  if (!m) return null;
  return {
    source: m[1].toLowerCase() === "cf" ? "curseforge" : "modrinth",
    id: m[2]
  };
}

function clearSearchCache() {
  cache.clear();
}

module.exports = {
  searchModpacks,
  parsePackChoice,
  clearSearchCache,
  SEARCH_BUDGET_MS,
  CACHE_TTL_MS
};
