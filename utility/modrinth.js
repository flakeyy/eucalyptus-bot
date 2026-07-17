require("dotenv").config();

const MODRINTH_BASE_URL = "https://api.modrinth.com/v2";
const USER_AGENT = "pterobot/discord-bot";
const msgLog = require("./logger.js");
const AdmZip = require("adm-zip");

// Maps the loader identifiers used by Modrinth projects/versions and by .mrpack
// dependency keys onto our internal loader names.
const LOADER_ALIASES = {
  "fabric": "fabric",
  "fabric-loader": "fabric",
  "quilt": "quilt",
  "quilt-loader": "quilt",
  "forge": "forge",
  "neoforge": "neoforge"
};

// Builds request headers, attaching MODRINTH_API_KEY as a bearer-less token when
// configured (Modrinth accepts the raw token); anonymous access works otherwise.
function modrinthHeaders(extra = {}) {
  const headers = { "User-Agent": USER_AGENT, ...extra };
  if (process.env.MODRINTH_API_KEY) headers["Authorization"] = process.env.MODRINTH_API_KEY;
  return headers;
}

// Looks up all provided SHA1 hashes against Modrinth in a single round-trip.
// Returns:
//   clientOnlyHashes - Set of SHA1s whose mod is server_side "unsupported"
//   serverSideByHash - Map of SHA1 -> project server_side ("required"|"optional"|"unsupported")
//   fallbackUrls     - Map of SHA1 -> { url, filename } for mods found on Modrinth
//   foundHashes      - Set of SHA1s that were matched at all (used to detect unmatched mods)
// Silently degrades to empty results on any API failure.
async function analyzeModrinthFiles(sha1Hashes) {
  const empty = { clientOnlyHashes: new Set(), serverSideByHash: new Map(), fallbackUrls: new Map(), foundHashes: new Set() };
  if (!sha1Hashes || sha1Hashes.length === 0) return empty;

  let versionMap;
  try {
    const res = await fetch(`${MODRINTH_BASE_URL}/version_files`, {
      method: "POST",
      headers: modrinthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ hashes: sha1Hashes, algorithm: "sha1" })
    });
    msgLog.debugExtended(`API: POST /modrinth/version_files (${sha1Hashes.length} hashes) | Status Code: ${res.status}`);
    if (!res.ok) return empty;
    versionMap = await res.json();
  } catch (e) {
    msgLog.warn(`[modrinth] version_files lookup failed: ${e.message}`);
    return empty;
  }

  const foundHashes = new Set(Object.keys(versionMap));

  // Build fallback download URLs from the version file entries
  const fallbackUrls = new Map();
  for (const [ hash, version ] of Object.entries(versionMap)) {
    const file = version.files?.find(f => f.primary) ?? version.files?.[0];
    if (file?.url) fallbackUrls.set(hash, { url: file.url, filename: file.filename });
  }

  // Fetch project details to determine client/server side
  const projectIds = [ ...new Set(Object.values(versionMap).map(v => v.project_id)) ];
  if (projectIds.length === 0) return { clientOnlyHashes: new Set(), serverSideByHash: new Map(), fallbackUrls, foundHashes };

  let projects;
  try {
    const res = await fetch(
      `${MODRINTH_BASE_URL}/projects?ids=${encodeURIComponent(JSON.stringify(projectIds))}`,
      { headers: modrinthHeaders() }
    );
    msgLog.debugExtended(`API: GET /modrinth/projects (${projectIds.length} ids) | Status Code: ${res.status}`);
    if (!res.ok) return { clientOnlyHashes: new Set(), serverSideByHash: new Map(), fallbackUrls, foundHashes };
    projects = await res.json();
  } catch (e) {
    msgLog.warn(`[modrinth] projects lookup failed: ${e.message}`);
    return { clientOnlyHashes: new Set(), serverSideByHash: new Map(), fallbackUrls, foundHashes };
  }

  const serverSideByProjectId = new Map(
    projects.filter(p => typeof p.server_side === "string").map(p => [ p.id, p.server_side ])
  );

  const clientOnlyHashes = new Set();
  const serverSideByHash = new Map();
  for (const [ hash, version ] of Object.entries(versionMap)) {
    const serverSide = serverSideByProjectId.get(version.project_id);
    if (serverSide) serverSideByHash.set(hash, serverSide);
    if (serverSide === "unsupported") clientOnlyHashes.add(hash);
  }

  return { clientOnlyHashes, serverSideByHash, fallbackUrls, foundHashes };
}

// Given a list of project slugs (e.g. CurseForge slugs, which usually match
// Modrinth slugs for cross-published mods), returns a Map of slug ->
// server_side ("required"|"optional"|"unsupported") for those found on Modrinth.
// Silently returns an empty Map on any API failure.
async function getServerSideBySlugs(slugs) {
  const result = new Map();
  if (!slugs || slugs.length === 0) return result;

  // The ids parameter goes in the query string, so chunk to keep URLs short.
  for (let start = 0; start < slugs.length; start += 75) {
    const chunk = slugs.slice(start, start + 75);
    try {
      const res = await fetch(
        `${MODRINTH_BASE_URL}/projects?ids=${encodeURIComponent(JSON.stringify(chunk))}`,
        { headers: modrinthHeaders() }
      );
      msgLog.debugExtended(`API: GET /modrinth/projects by slug (${chunk.length} slugs) | Status Code: ${res.status}`);
      if (!res.ok) continue;
      for (const p of await res.json()) {
        if (typeof p.server_side === "string") result.set(p.slug, p.server_side);
      }
    } catch (e) {
      msgLog.warn(`[modrinth] slug projects lookup failed: ${e.message}`);
    }
  }

  return result;
}

// CurseForge has no client/server side field, so installs borrow Modrinth's
// project-level server_side. Only "required"/"optional" are trusted — they can
// rescue a weak JAR client verdict. "unsupported" is dropped: author-set
// Modrinth labels are frequently wrong for content mods, and following them
// when the JAR is silent skips packs (e.g. Pam's HarvestCraft). Pack-authored
// mrpack env.server still passes "unsupported" through unchanged.
function projectServerSideForCurseforge(serverSide) {
  return serverSide === "required" || serverSide === "optional" ? serverSide : null;
}

// Returns our internal loader name for a Modrinth loaders array (project/version).
function mapModrinthLoader(loaders) {
  if (!Array.isArray(loaders)) return null;
  for (const loader of loaders) {
    const key = String(loader).toLowerCase();
    if (LOADER_ALIASES[key]) return LOADER_ALIASES[key];
  }
  return null;
}

// Returns our internal loader name from a .mrpack dependencies object.
function loaderFromMrpackDeps(deps) {
  if (!deps || typeof deps !== "object") return null;
  for (const key of Object.keys(deps)) {
    const k = key.toLowerCase();
    if (k === "minecraft") continue;
    if (LOADER_ALIASES[k]) return LOADER_ALIASES[k];
  }
  return null;
}

function mcVersionFromMrpackDeps(deps) {
  return deps?.minecraft ?? null;
}

// Extracts the project slug/ID from a Modrinth modpack URL (modrinth.com/modpack
// or /project). Returns null for anything else — a full URL is required.
function parseModrinthUrl(input) {
  if (!input || typeof input !== "string") return null;
  const match = input.trim().match(/modrinth\.com\/(?:modpack|project)\/([\w-]+)/i);
  return match ? match[1] : null;
}

// Fetches a Modrinth project and confirms it is a modpack. Returns null when the
// project doesn't exist or isn't a modpack; throws on other API errors.
async function getModrinthModpack(idOrSlug) {
  const res = await fetch(`${MODRINTH_BASE_URL}/project/${encodeURIComponent(idOrSlug)}`, { headers: modrinthHeaders() });
  msgLog.debugExtended(`API: GET /modrinth/project/${idOrSlug} | Status Code: ${res.status}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Modrinth API error: HTTP ${res.status}`);
  const data = await res.json();
  if (!data || data.project_type !== "modpack") return null;
  return data;
}

// Lists a project's versions (newest first, as returned by Modrinth).
async function getModrinthVersions(projectId) {
  const res = await fetch(`${MODRINTH_BASE_URL}/project/${encodeURIComponent(projectId)}/version`, { headers: modrinthHeaders() });
  msgLog.debugExtended(`API: GET /modrinth/project/${projectId}/version | Status Code: ${res.status}`);
  if (!res.ok) throw new Error(`Modrinth API error: HTTP ${res.status}`);
  return await res.json();
}

function isMrpackZip(buffer) {
  try {
    return new AdmZip(buffer).getEntry("modrinth.index.json") !== null;
  } catch {
    return false;
  }
}

function parseMrpackIndex(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntry("modrinth.index.json");
    if (!entry) return null;
    return JSON.parse(zip.readAsText(entry));
  } catch {
    return null;
  }
}

// Resolves a downloaded .mrpack into a normalized install plan for the shared
// engine. The index declares each file's server side via env.server: for mods/
// JARs we pass that through as provider metadata that the engine combines with
// its own JAR inspection (see isClientOnlyMod); non-mod files (configs,
// resource packs) are dropped outright when env.server is unsupported.
// overrides/ and server-overrides/ are merged (server wins); client-overrides/
// is skipped. Returns null if the zip has no parseable index.
function resolveModrinthInstall(buffer) {
  const index = parseMrpackIndex(buffer);
  if (!index) return null;

  const loaderType = loaderFromMrpackDeps(index.dependencies);
  const mcVersion = mcVersionFromMrpackDeps(index.dependencies);

  const modFiles = [];
  const extraFiles = [];
  for (const file of index.files || []) {
    if (!file?.path || !Array.isArray(file.downloads) || file.downloads.length === 0) continue;
    const serverEnv = file.env?.server;
    const downloadUrl = file.downloads[0];
    const sha1 = file.hashes?.sha1 ?? null;

    if (file.path.startsWith("mods/")) {
      modFiles.push({
        path: file.path,
        filename: file.path.split("/").pop(),
        downloadUrl,
        sha1,
        providerServerSide: typeof serverEnv === "string" ? serverEnv : null
      });
    } else {
      // Non-mod files can't be JAR-inspected, so the index is authoritative.
      if (serverEnv === "unsupported") continue;
      extraFiles.push({ path: file.path, downloadUrl, sha1 });
    }
  }

  // Merge overrides then server-overrides (server-overrides win on path collision).
  const zip = new AdmZip(buffer);
  const overrideMap = new Map();
  for (const prefix of [ "overrides/", "server-overrides/" ]) {
    for (const e of zip.getEntries()) {
      if (e.isDirectory || !e.entryName.startsWith(prefix)) continue;
      const stripped = e.entryName.slice(prefix.length);
      if (stripped) overrideMap.set(stripped, e.getData());
    }
  }
  const overrideEntries = [ ...overrideMap ].map(([ path, data ]) => ({ path, data }));

  return {
    kind: "plan",
    plan: { loaderType, mcVersion, modFiles, extraFiles, overrideEntries, unavailable: [] }
  };
}

module.exports = {
  analyzeModrinthFiles,
  getServerSideBySlugs,
  projectServerSideForCurseforge,
  mapModrinthLoader,
  loaderFromMrpackDeps,
  mcVersionFromMrpackDeps,
  parseModrinthUrl,
  getModrinthModpack,
  getModrinthVersions,
  isMrpackZip,
  parseMrpackIndex,
  resolveModrinthInstall
};
