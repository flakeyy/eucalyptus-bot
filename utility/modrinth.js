const MODRINTH_BASE_URL = "https://api.modrinth.com/v2";
const USER_AGENT = "pterobot/discord-bot";
const msgLog = require("./logger.js");

// Looks up all provided SHA1 hashes against Modrinth in a single round-trip.
// Returns:
//   clientOnlyHashes - Set of SHA1s whose mod is server_side "unsupported"
//   fallbackUrls     - Map of SHA1 -> { url, filename } for mods found on Modrinth
//   foundHashes      - Set of SHA1s that were matched at all (used to detect unmatched mods)
// Silently degrades to empty results on any API failure.
async function analyzeModrinthFiles(sha1Hashes) {
  const empty = { clientOnlyHashes: new Set(), fallbackUrls: new Map(), foundHashes: new Set() };
  if (!sha1Hashes || sha1Hashes.length === 0) return empty;

  let versionMap;
  try {
    const res = await fetch(`${MODRINTH_BASE_URL}/version_files`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
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
  if (projectIds.length === 0) return { clientOnlyHashes: new Set(), fallbackUrls, foundHashes };

  let projects;
  try {
    const res = await fetch(
      `${MODRINTH_BASE_URL}/projects?ids=${encodeURIComponent(JSON.stringify(projectIds))}`,
      { headers: { "User-Agent": USER_AGENT } }
    );
    msgLog.debugExtended(`API: GET /modrinth/projects (${projectIds.length} ids) | Status Code: ${res.status}`);
    if (!res.ok) return { clientOnlyHashes: new Set(), fallbackUrls, foundHashes };
    projects = await res.json();
  } catch (e) {
    msgLog.warn(`[modrinth] projects lookup failed: ${e.message}`);
    return { clientOnlyHashes: new Set(), fallbackUrls, foundHashes };
  }

  const clientOnlyProjectIds = new Set(
    projects.filter(p => p.server_side === "unsupported").map(p => p.id)
  );

  const clientOnlyHashes = new Set();
  for (const [ hash, version ] of Object.entries(versionMap)) {
    if (clientOnlyProjectIds.has(version.project_id)) clientOnlyHashes.add(hash);
  }

  return { clientOnlyHashes, fallbackUrls, foundHashes };
}

// Given a list of CurseForge mod slugs, returns a Set of slugs that Modrinth
// considers client-only (server_side === "unsupported").
// Silently returns an empty Set on any API failure.
async function getClientOnlyBySlugs(slugs) {
  if (!slugs || slugs.length === 0) return new Set();

  let projects;
  try {
    const res = await fetch(
      `${MODRINTH_BASE_URL}/projects?ids=${encodeURIComponent(JSON.stringify(slugs))}`,
      { headers: { "User-Agent": USER_AGENT } }
    );
    msgLog.debugExtended(`API: GET /modrinth/projects by slug (${slugs.length} slugs) | Status Code: ${res.status}`);
    if (!res.ok) return new Set();
    projects = await res.json();
  } catch (e) {
    msgLog.warn(`[modrinth] slug projects lookup failed: ${e.message}`);
    return new Set();
  }

  return new Set(
    projects.filter(p => p.server_side === "unsupported").map(p => p.slug)
  );
}

module.exports = { analyzeModrinthFiles, getClientOnlyBySlugs };
