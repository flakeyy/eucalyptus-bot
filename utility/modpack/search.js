"use strict";

/**
 * Parallel CurseForge + Modrinth modpack search for Discord autocomplete.
 * Discord kills autocomplete at 3s — budget 2s and cache hits for 60s.
 *
 * Provider results are re-ranked locally by name/slug relevance (not downloads).
 * CurseForge requires sortField=Popularity or searchFilter returns unrelated junk.
 */

const msgLog = require("../logger.js");

const CURSEFORGE_BASE_URL = "https://api.curseforge.com/v1";
const MODRINTH_BASE_URL = "https://api.modrinth.com/v2";
const USER_AGENT = "pterobot/discord-bot";

const SEARCH_BUDGET_MS = 2000;
const CACHE_TTL_MS = 60_000;
const MAX_CHOICES = 25;
const PROVIDER_LIMIT = 25;
/** CurseForge ModsSearchSortField.Popularity — required for usable searchFilter results. */
const CF_SORT_POPULARITY = 2;

/**
 * Extra Modrinth/CurseForge slugs to resolve when provider text search misses
 * well-known packs (e.g. Modrinth does not return project `sop` for "Simply Optimized").
 */
const QUERY_SLUG_ALIASES = {
  "simply optimized": [ "sop" ],
  sop: [ "sop" ],
  rlcraft: [ "rlcraft" ],
  "rl craft": [ "rlcraft" ],
  pixelmon: [ "the-pixelmon-modpack" ],
  "create above and beyond": [ "create-above-and-beyond" ],
  "create aab": [ "create-above-and-beyond" ],
  aab: [ "create-above-and-beyond" ]
};

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

/** Lowercase, strip punctuation to spaces, collapse whitespace. */
function normalizeSearchText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactText(s) {
  return normalizeSearchText(s).replace(/\s+/g, "");
}

function slugifyQuery(query) {
  return normalizeSearchText(query).replace(/\s+/g, "-");
}

/** First letters of each word — "All the Mods 9" → "atm9". */
function wordInitials(normalized) {
  return normalizeSearchText(normalized)
    .split(" ")
    .filter(Boolean)
    .map(w => w[0])
    .join("");
}

/**
 * Relevance score for a hit against the user query.
 * Exact name/slug ≫ prefix/initials ≫ tokens ≫ substring; log10(downloads) as tie-break.
 * Returns < 100 when there is no textual match (provider noise).
 */
function scoreHit(query, hit) {
  const q = normalizeSearchText(query);
  if (!q) return 0;

  const name = normalizeSearchText(hit.name);
  const slug = normalizeSearchText(hit.slug || "");
  const qCompact = compactText(q);
  const nameCompact = compactText(name);
  const slugCompact = compactText(slug);
  const initials = wordInitials(name);

  const nameWords = name.split(" ").filter(Boolean);
  const slugWords = slug.split(" ").filter(Boolean);
  // Whole-word title hit ("The Pixelmon Modpack" for query "pixelmon") beats
  // prefix-only fan titles so download tie-break can prefer the real pack.
  const wholeWordHit = nameWords.some(w => w === q || w === qCompact)
    || slugWords.some(w => w === q || w === qCompact);
  const initialsHit = initials === qCompact || initials.startsWith(qCompact);

  let textScore = 0;

  if (name === q || slugCompact === qCompact || nameCompact === qCompact) {
    textScore = 1000;
  } else if (initialsHit) {
    // "atm" → "All the Mods 10" (initials atm1a) above titles that merely contain word "atm"
    textScore = 920;
  } else if (wholeWordHit) {
    textScore = 900;
  } else if (
    name.startsWith(q)
    || nameCompact.startsWith(qCompact)
    || slugCompact.startsWith(qCompact)
    || nameWords.some(w => w.startsWith(qCompact))
  ) {
    textScore = 800;
  } else {
    const tokens = q.split(" ").filter(Boolean);
    const haystacks = [ name, nameCompact, slugCompact, initials ];
    const allTokensMatch = tokens.length > 0 && tokens.every(t => {
      const tc = compactText(t);
      return haystacks.some(h => h.includes(t) || (tc && h.includes(tc)));
    });
    if (allTokensMatch) {
      textScore = 600;
    } else if (
      name.includes(q)
      || nameCompact.includes(qCompact)
      || slugCompact.includes(qCompact)
      || initials.includes(qCompact)
    ) {
      textScore = 400;
    }
  }

  if (textScore === 0) return Math.log10((Number(hit.downloadCount) || 0) + 1); // noise — keep sort key only

  const dl = Math.max(0, Number(hit.downloadCount) || 0);
  return textScore + Math.log10(dl + 1);
}

function rankHits(query, hits) {
  const scored = hits.map(hit => ({ ...hit, score: scoreHit(query, hit) }));
  scored.sort((a, b) => {
    const ds = (b.score || 0) - (a.score || 0);
    if (ds !== 0) return ds;
    return (b.downloadCount || 0) - (a.downloadCount || 0);
  });

  // Drop provider noise when we have real textual matches.
  const hasStrong = scored.some(h => (h.score || 0) >= 400);
  if (hasStrong) return scored.filter(h => (h.score || 0) >= 400);
  return scored;
}

function toChoice(hit) {
  const label = hit.source === "cf"
    ? `${hit.name} (CurseForge)`.slice(0, 100)
    : `${hit.name} (Modrinth)`.slice(0, 100);
  return {
    name: label,
    value: String(hit.value || "").slice(0, 100)
  };
}

function mapCfMod(m) {
  return {
    source: "cf",
    id: String(m.id),
    value: `cf:${m.id}`,
    name: m.name || m.slug || String(m.id),
    slug: m.slug || null,
    downloadCount: m.downloadCount ?? 0
  };
}

function mapMrHit(h) {
  return {
    source: "mr",
    id: String(h.project_id || h.id || h.slug),
    value: `mr:${h.slug || h.project_id || h.id}`,
    name: h.title || h.name || h.slug || String(h.project_id || h.id),
    slug: h.slug || null,
    downloadCount: h.downloads ?? h.downloadCount ?? 0
  };
}

async function searchCurseForge(query) {
  if (!process.env.CURSEFORGE_API_KEY) return [];
  const url = `${CURSEFORGE_BASE_URL}/mods/search?gameId=432&classId=4471`
    + `&pageSize=${PROVIDER_LIMIT}`
    + `&searchFilter=${encodeURIComponent(query)}`
    + `&sortField=${CF_SORT_POPULARITY}&sortOrder=desc`;
  const res = await fetch(url, {
    headers: { "x-api-key": process.env.CURSEFORGE_API_KEY, Accept: "application/json" }
  });
  if (!res.ok) throw new Error(`CF search HTTP ${res.status}`);
  const data = await res.json();
  return (data.data || []).map(mapCfMod);
}

async function curseForgeBySlug(slug) {
  if (!process.env.CURSEFORGE_API_KEY || !slug) return [];
  const url = `${CURSEFORGE_BASE_URL}/mods/search?gameId=432&classId=4471&slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url, {
    headers: { "x-api-key": process.env.CURSEFORGE_API_KEY, Accept: "application/json" }
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data || []).map(mapCfMod);
}

async function searchModrinth(query) {
  const facets = encodeURIComponent(JSON.stringify([ [ "project_type:modpack" ] ]));
  const url = `${MODRINTH_BASE_URL}/search?limit=${PROVIDER_LIMIT}&facets=${facets}&query=${encodeURIComponent(query)}`;
  const headers = { "User-Agent": USER_AGENT };
  if (process.env.MODRINTH_API_KEY) headers.Authorization = process.env.MODRINTH_API_KEY;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`MR search HTTP ${res.status}`);
  const data = await res.json();
  return (data.hits || []).map(mapMrHit);
}

async function modrinthBySlug(slug) {
  if (!slug) return [];
  const headers = { "User-Agent": USER_AGENT };
  if (process.env.MODRINTH_API_KEY) headers.Authorization = process.env.MODRINTH_API_KEY;
  const res = await fetch(`${MODRINTH_BASE_URL}/project/${encodeURIComponent(slug)}`, { headers });
  if (!res.ok) return [];
  const p = await res.json();
  if (p.project_type && p.project_type !== "modpack") return [];
  return [ mapMrHit({
    project_id: p.id,
    slug: p.slug,
    title: p.title,
    downloads: p.downloads
  }) ];
}

function candidateSlugs(query) {
  const q = normalizeSearchText(query);
  const slugs = new Set();
  const aliased = QUERY_SLUG_ALIASES[q];
  if (aliased) for (const s of aliased) slugs.add(s);
  const slugified = slugifyQuery(query);
  if (slugified && !slugified.includes(" ")) slugs.add(slugified);
  const compact = compactText(query);
  if (compact.length >= 2 && compact !== slugified) slugs.add(compact);
  // Single-token queries often are already CF/MR slugs (rlcraft, atm9, sop).
  if (!q.includes(" ") && q.length >= 2) slugs.add(q);
  return [ ...slugs ];
}

/** Resolve exact slug hits on both providers (fills gaps when text search misses). */
async function resolveSlugHits(query) {
  const slugs = candidateSlugs(query);
  if (!slugs.length) return [];
  const settled = await Promise.all(
    slugs.flatMap(slug => [
      withTimeout(curseForgeBySlug(slug), SEARCH_BUDGET_MS).catch(() => []),
      withTimeout(modrinthBySlug(slug), SEARCH_BUDGET_MS).catch(() => [])
    ])
  );
  return settled.flat();
}

/**
 * Full ranked hits (with score). Used by CLI/eval; Discord uses searchModpacks.
 * @returns {Promise<Array<{source,id,value,name,slug,downloadCount,score}>>}
 */
async function searchModpacksDetailed(query) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];

  const cacheKey = `detailed:${q.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const settled = await Promise.allSettled([
    withTimeout(searchCurseForge(q), SEARCH_BUDGET_MS),
    withTimeout(searchModrinth(q), SEARCH_BUDGET_MS),
    withTimeout(resolveSlugHits(q), SEARCH_BUDGET_MS)
  ]);

  const cf = settled[0].status === "fulfilled" ? settled[0].value : [];
  const mr = settled[1].status === "fulfilled" ? settled[1].value : [];
  const slugHits = settled[2].status === "fulfilled" ? settled[2].value : [];
  if (settled[0].status === "rejected") {
    msgLog.debugExtended(`[modpack-search] CF: ${settled[0].reason?.message || settled[0].reason}`);
  }
  if (settled[1].status === "rejected") {
    msgLog.debugExtended(`[modpack-search] MR: ${settled[1].reason?.message || settled[1].reason}`);
  }
  if (settled[2].status === "rejected") {
    msgLog.debugExtended(`[modpack-search] slug: ${settled[2].reason?.message || settled[2].reason}`);
  }

  const ranked = rankHits(q, [ ...cf, ...mr, ...slugHits ]);
  const seen = new Set();
  const unique = [];
  for (const hit of ranked) {
    if (seen.has(hit.value)) continue;
    seen.add(hit.value);
    unique.push(hit);
    if (unique.length >= MAX_CHOICES) break;
  }

  cacheSet(cacheKey, unique);
  cacheSet(q.toLowerCase(), unique.map(toChoice));
  return unique;
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

  const detailed = await searchModpacksDetailed(q);
  const choices = detailed.map(toChoice);
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
  searchModpacksDetailed,
  parsePackChoice,
  clearSearchCache,
  normalizeSearchText,
  scoreHit,
  rankHits,
  SEARCH_BUDGET_MS,
  CACHE_TTL_MS,
  PROVIDER_LIMIT,
  QUERY_SLUG_ALIASES
};
