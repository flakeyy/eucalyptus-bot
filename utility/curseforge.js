require("dotenv").config();

const CURSEFORGE_BASE_URL = "https://api.curseforge.com/v1";
const msgLog = require("./logger.js");
const AdmZip = require("adm-zip");
const { analyzeModrinthFiles, getServerSideBySlugs, projectServerSideForCurseforge } = require("./modrinth.js");

// CurseForge classId for actual mods. Manifest entries with any other classId
// (resource packs 12, shaders 6552, worlds 17, etc.) are not installed to mods/.
const CF_MOD_CLASS_ID = 6;

const LOADER_MAP = {
  1: "forge",
  4: "fabric",
  5: "quilt",
  6: "neoforge"
};

function parseProjectId(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  // Accept a bare numeric ID or a CurseForge project URL containing the numeric ID
  // e.g. "905765" or "https://www.curseforge.com/minecraft/modpacks/star-technology/..."
  const numericMatch = trimmed.match(/^\d+$/);
  if (numericMatch) return parseInt(trimmed, 10);
  // Some CurseForge download URLs embed the project ID: /projects/905765/...
  const urlIdMatch = trimmed.match(/\/(?:projects?|modpacks?)\/(\d+)/i);
  if (urlIdMatch) return parseInt(urlIdMatch[1], 10);
  return null;
}

function parseModpackSlug(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  // Standard CurseForge modpack URLs: /minecraft/modpacks/<slug>[/...]
  const match = trimmed.match(/curseforge\.com\/minecraft\/modpacks\/([a-z0-9][a-z0-9-]*)/i);
  return match ? match[1].toLowerCase() : null;
}

async function getModpackById(projectId) {
  const response = await fetch(
    `${CURSEFORGE_BASE_URL}/mods/${projectId}`,
    { headers: { "x-api-key": process.env.CURSEFORGE_API_KEY, "Accept": "application/json" } }
  );
  msgLog.debugExtended(`API: GET /curse/mods/${projectId} | Status Code: ${response.status}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`CurseForge API error: HTTP ${response.status}`);
  const data = await response.json();
  if (!data.data) return null;
  // Verify it's a Minecraft modpack (gameId=432, classId=4471)
  if (data.data.gameId !== 432 || data.data.classId !== 4471) return null;
  return data.data;
}

async function getModpackBySlug(slug) {
  const url = `${CURSEFORGE_BASE_URL}/mods/search?gameId=432&classId=4471&slug=${encodeURIComponent(slug)}`;
  const response = await fetch(url, {
    headers: { "x-api-key": process.env.CURSEFORGE_API_KEY, "Accept": "application/json" }
  });
  msgLog.debugExtended(`API: GET /curse/mods/search?slug=${slug} | Status Code: ${response.status}`);
  if (!response.ok) throw new Error(`CurseForge API error: HTTP ${response.status}`);
  const data = await response.json();
  const match = (data.data || []).find(m => m.slug?.toLowerCase() === slug.toLowerCase());
  return match || null;
}

// CurseForge caps each files page at 50. Walk pages until exhausted or we hit
// MAX_MODPACK_FILES so older releases remain selectable in the installer.
const CF_FILES_PAGE_SIZE = 50;
const MAX_MODPACK_FILES = 200;

async function getModpackFiles(modId) {
  const all = [];
  let index = 0;
  while (index < MAX_MODPACK_FILES) {
    const pageSize = Math.min(CF_FILES_PAGE_SIZE, MAX_MODPACK_FILES - index);
    const url = `${CURSEFORGE_BASE_URL}/mods/${modId}/files?index=${index}&pageSize=${pageSize}`;
    const response = await fetch(url, {
      headers: { "x-api-key": process.env.CURSEFORGE_API_KEY, "Accept": "application/json" }
    });
    msgLog.debugExtended(`API: GET /curse/mods/${modId}/files?index=${index} | Status Code: ${response.status}`);
    if (!response.ok) throw new Error(`CurseForge API error: HTTP ${response.status}`);
    const data = await response.json();
    const page = data.data || [];
    all.push(...page);
    const total = data.pagination?.totalCount;
    index += pageSize;
    if (page.length < pageSize) break;
    if (typeof total === "number" && all.length >= total) break;
  }
  return all;
}

function detectLoaderType(latestFilesIndexes) {
  if (!latestFilesIndexes || latestFilesIndexes.length === 0) return null;
  for (const entry of latestFilesIndexes) {
    const loader = LOADER_MAP[entry.modLoader];
    if (loader) return loader;
  }
  return null;
}

// CurseForge sometimes tags loaders as gameVersion strings ("Forge", "Fabric")
// instead of (or in addition to) the numeric modLoader enum — especially on
// older files where modLoader is missing/0.
function inferLoaderFromGameVersions(gameVersions) {
  if (!Array.isArray(gameVersions) || gameVersions.length === 0) return null;
  const labels = gameVersions.map(v => String(v));
  if (labels.some(v => /neoforge/i.test(v))) return "neoforge";
  if (labels.some(v => /fabric/i.test(v))) return "fabric";
  if (labels.some(v => /quilt/i.test(v))) return "quilt";
  if (labels.some(v => /^forge$/i.test(v))) return "forge";
  return null;
}

// Fabric/Quilt arrived with 1.14; NeoForge with 1.20.1. Untagged packs on older
// Minecraft versions are effectively always Forge.
function defaultLoaderForLegacyMc(mcVersion) {
  if (!mcVersion || typeof mcVersion !== "string") return null;
  const match = mcVersion.trim().match(/^(\d+)\.(\d+)/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 1 && minor < 14) return "forge";
  return null;
}

function resolveLoaderType({ indexes = null, gameVersions = null, mcVersion = null } = {}) {
  return detectLoaderType(indexes)
    || inferLoaderFromGameVersions(gameVersions)
    || defaultLoaderForLegacyMc(mcVersion);
}

// Best-effort Minecraft version for a modpack file, used to pick the Java image
// and set the MC_VERSION egg variable. Prefers per-file version metadata, then
// falls back to the modpack's latest indexed version.
function detectMCVersion(modpack, targetFile) {
  if (targetFile?.sortableGameVersions) {
    const ver = targetFile.sortableGameVersions
      .map(v => v.gameVersionName)
      .find(v => /^\d+\.\d+/.test(v));
    if (ver) return ver;
  }
  if (targetFile?.gameVersions) {
    const loaderKeywords = /java|forge|fabric|neoforge|quilt/i;
    const ver = targetFile.gameVersions.find(v => /^\d+\.\d+/.test(v) && !loaderKeywords.test(v));
    if (ver) return ver;
  }
  if (modpack?.latestFilesIndexes?.length > 0) {
    const ver = modpack.latestFilesIndexes[0].gameVersion;
    if (ver && /^\d+\.\d+/.test(ver)) return ver;
  }
  return null;
}

function findServerPack(files) {
  if (!files || files.length === 0) return null;
  // Some older modpacks include server pack entries directly in the file list
  const direct = files.filter(f => f.isServerPack);
  if (direct.length > 0) {
    direct.sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate));
    return direct[0];
  }
  return null;
}

// Returns the serverPackFileId from the most recent file that has one.
// CurseForge stores server packs as separate file entries linked via this field.
function findLinkedServerPackId(files) {
  if (!files || files.length === 0) return null;
  const sorted = [ ...files ].sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate));
  for (const file of sorted) {
    if (file.serverPackFileId && file.serverPackFileId !== 0) {
      return { serverPackFileId: file.serverPackFileId, modId: file.modId };
    }
  }
  return null;
}

// Reverse of findLinkedServerPackId: given a server-pack file id, find the
// client file that points at it (so we can read that client's manifest.json
// for the pinned Forge/NeoForge build).
async function findClientFileForServerPack(modId, serverPackFileId) {
  if (!modId || !serverPackFileId) return null;
  const files = await getModpackFiles(modId).catch(() => null);
  if (!files) return null;
  const target = Number(serverPackFileId);
  return files.find(f => Number(f.serverPackFileId) === target && f.downloadUrl) || null;
}

async function getModsByIds(modIds) {
  if (!modIds || modIds.length === 0) return [];
  const response = await fetch(
    `${CURSEFORGE_BASE_URL}/mods`,
    {
      method: "POST",
      headers: { "x-api-key": process.env.CURSEFORGE_API_KEY, "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ modIds })
    }
  );
  msgLog.debugExtended(`API: POST /curse/mods (${modIds.length} ids) | Status Code: ${response.status}`);
  if (!response.ok) return [];
  const data = await response.json();
  return data.data || [];
}

async function getFilesByIds(fileIds) {
  if (!fileIds || fileIds.length === 0) return [];
  const response = await fetch(
    `${CURSEFORGE_BASE_URL}/mods/files`,
    {
      method: "POST",
      headers: { "x-api-key": process.env.CURSEFORGE_API_KEY, "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ fileIds })
    }
  );
  msgLog.debugExtended(`API: POST /curse/mods/files (${fileIds.length} ids) | Status Code: ${response.status}`);
  if (!response.ok) throw new Error(`CurseForge API error: HTTP ${response.status}`);
  const data = await response.json();
  return data.data || [];
}

async function getFileById(modId, fileId) {
  const response = await fetch(
    `${CURSEFORGE_BASE_URL}/mods/${modId}/files/${fileId}`,
    { headers: { "x-api-key": process.env.CURSEFORGE_API_KEY, "Accept": "application/json" } }
  );
  msgLog.debugExtended(`API: GET /curse/mods/${modId}/files/${fileId} | Status Code: ${response.status}`);
  if (!response.ok) return null;
  const data = await response.json();
  return data.data || null;
}

function isManifestZip(buffer) {
  try {
    const zip = new AdmZip(buffer);
    return zip.getEntry("manifest.json") !== null;
  } catch {
    return false;
  }
}

// CurseForge often nulls downloadUrl for "distribution disabled" files while the
// edge CDN still serves them when authenticated with x-api-key (see modpack_http).
// File id 4699254 → https://edge.forgecdn.net/files/4699/254/name.jar
function synthesizeCurseForgeCdnUrl(fileId, fileName) {
  const id = Number(fileId);
  if (!Number.isFinite(id) || id <= 0 || !fileName) return null;
  const top = Math.floor(id / 1000);
  const mid = String(id % 1000).padStart(3, "0");
  return `https://edge.forgecdn.net/files/${top}/${mid}/${fileName}`;
}

function parseManifestFromZip(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntry("manifest.json");
    if (!entry) return null;
    return JSON.parse(zip.readAsText(entry));
  } catch {
    return null;
  }
}

function parseManifestLoaderType(manifest) {
  const loaders = manifest?.minecraft?.modLoaders;
  const primary = loaders?.find(l => l.primary) ?? loaders?.[0];
  const match = primary?.id?.match(/^(forge|fabric|neoforge|quilt)/i);
  return match ? match[1].toLowerCase() : null;
}

// Resolves a CurseForge manifest zip into a normalized install plan consumed by
// the shared file-plan engine. Resolves manifest file IDs to download URLs,
// drops non-mod entries by classId, recovers API-disabled mods via Modrinth
// fallback URLs, and collects the overrides to upload. Returns null if the zip
// has no parseable manifest. onProgress(message) surfaces resolution status.
async function resolveCurseforgeInstall(buffer, loaderType, onProgress = () => {}) {
  const manifest = parseManifestFromZip(buffer);
  if (!manifest) return null;

  const requiredEntries = (manifest.files || []).filter(f => f.required);
  onProgress(
    "No direct server pack download was available. Installing from manifest — this may take longer than usual.\n\nResolving mod list..."
  );
  const resolvedFiles = await getFilesByIds(requiredEntries.map(f => f.fileID)).catch(() => []);

  const nameByModId = new Map(resolvedFiles.map(f => [ f.modId, f.displayName ?? f.fileName ?? String(f.modId) ]));

  // Fetch mod metadata for all resolved files — used for classId filtering
  const allModIds = [ ...new Set(resolvedFiles.map(f => f.modId)) ];
  const allCfMods = await getModsByIds(allModIds);
  const classIdByModId = new Map(allCfMods.map(m => [ m.id, m.classId ]));

  // Build a set of filenames to exclude from overrides/mods/ (non-mod classIds only)
  const overrideModExclude = new Set();
  for (const f of resolvedFiles) {
    if (!f.fileName) continue;
    const classId = classIdByModId.get(f.modId);
    const isNonMod = classId !== undefined && classId !== CF_MOD_CLASS_ID;
    if (isNonMod) overrideModExclude.add(f.fileName);
  }

  // Collect overrides content (strip the "overrides/" prefix so files land at server root)
  onProgress("Preparing overrides...");
  const srcZip = new AdmZip(buffer);
  const overrideEntries = [];
  for (const e of srcZip.getEntries()) {
    if (!e.entryName.startsWith("overrides/") || e.isDirectory) continue;
    if (e.entryName.startsWith("overrides/mods/")) {
      const filename = e.entryName.slice("overrides/mods/".length);
      if (overrideModExclude.has(filename)) {
        msgLog.debugExtended(`[install-modpack] skip override (non-mod): ${filename}`);
        continue;
      }
    }
    overrideEntries.push({ path: e.entryName.slice("overrides/".length), data: e.getData() });
  }

  // Filter out non-mod entries (resource packs classId=12, shaders classId=6552, worlds classId=17, etc.)
  let nonModSkipped = 0;
  const modFiles = resolvedFiles.filter(f => {
    const classId = classIdByModId.get(f.modId);
    if (classId !== undefined && classId !== CF_MOD_CLASS_ID) {
      nonModSkipped++;
      msgLog.debugExtended(`[install-modpack] skip (non-mod classId=${classId}): ${nameByModId.get(f.modId)}`);
      return false;
    }
    return true;
  });
  if (nonModSkipped > 0) {
    msgLog.log(`[install-modpack] skipped ${nonModSkipped} non-mod file(s) from manifest (resource packs, shaders, etc.)`);
  }

  const downloadable = modFiles.filter(f => f.downloadUrl);
  const noUrl = modFiles.filter(f => !f.downloadUrl);

  // Build SHA1 map across all mod files for a single combined Modrinth lookup,
  // which supplies both fallback download URLs and per-mod server-side metadata
  // (CurseForge's own API has no reliable client/server side information).
  const sha1ToFile = new Map();
  for (const f of modFiles) {
    const sha1 = (f.hashes || []).find(h => h.algo === 1)?.value;
    if (sha1) sha1ToFile.set(sha1, f);
  }

  onProgress("Installing from manifest — resolving download URLs...");
  const { fallbackUrls, serverSideByHash } = await analyzeModrinthFiles([ ...sha1ToFile.keys() ]);

  // Second-chance side lookup by slug: CurseForge builds often differ
  // byte-for-byte from the Modrinth upload of the same mod, so hash lookups
  // miss them. Cross-published mods usually share their slug across platforms.
  const slugByModId = new Map(allCfMods.map(m => [ m.id, m.slug ]));
  const unresolvedSlugs = [ ...new Set(
    modFiles
      .filter(f => {
        const sha1 = (f.hashes || []).find(h => h.algo === 1)?.value;
        return !sha1 || !serverSideByHash.has(sha1);
      })
      .map(f => slugByModId.get(f.modId))
      .filter(Boolean)
  ) ];
  const serverSideBySlug = await getServerSideBySlugs(unresolvedSlugs);

  // Recover mods with no CurseForge download URL using Modrinth fallback URLs,
  // then synthesized edge.forgecdn.net paths (API often nulls downloadUrl).
  const unavailable = [];
  const modrinthFallbacks = [];
  const cdnFallbacks = [];
  for (const f of noUrl) {
    const sha1 = (f.hashes || []).find(h => h.algo === 1)?.value;
    const fallback = sha1 ? fallbackUrls.get(sha1) : null;
    if (fallback) {
      modrinthFallbacks.push({ downloadUrl: fallback.url, displayName: nameByModId.get(f.modId), sha1 });
      msgLog.debugExtended(`[install-modpack] Modrinth fallback: ${nameByModId.get(f.modId)}`);
      continue;
    }
    const cdnUrl = synthesizeCurseForgeCdnUrl(f.id, f.fileName);
    if (cdnUrl) {
      cdnFallbacks.push({
        downloadUrl: cdnUrl,
        displayName: nameByModId.get(f.modId) ?? f.fileName,
        sha1: sha1 ?? null,
        modId: f.modId
      });
      msgLog.debugExtended(`[install-modpack] CurseForge CDN fallback: ${f.fileName}`);
      continue;
    }
    unavailable.push(f);
    msgLog.debugExtended(`[install-modpack] no download URL: ${nameByModId.get(f.modId)} (modId: ${f.modId})`);
  }
  if (modrinthFallbacks.length > 0) {
    msgLog.log(`[install-modpack] recovered ${modrinthFallbacks.length} mod(s) via Modrinth fallback`);
  }
  if (cdnFallbacks.length > 0) {
    msgLog.log(`[install-modpack] recovered ${cdnFallbacks.length} mod(s) via CurseForge CDN URL synthesis`);
  }
  if (unavailable.length > 0) {
    msgLog.log(`[install-modpack] ${unavailable.length} mod(s) have no download URL on CurseForge or Modrinth`);
  }

  const rawMods = [
    ...downloadable.map(f => ({ ...f, sha1: (f.hashes || []).find(h => h.algo === 1)?.value ?? null })),
    ...modrinthFallbacks,
    ...cdnFallbacks
  ];

  const planModFiles = rawMods.map(mod => {
    const filename = decodeURIComponent(mod.downloadUrl.split("/").pop());
    const rawSide = (mod.sha1 ? serverSideByHash.get(mod.sha1) : undefined)
      ?? serverSideBySlug.get(slugByModId.get(mod.modId))
      ?? null;
    return {
      path: `mods/${filename}`,
      filename,
      downloadUrl: mod.downloadUrl,
      sha1: mod.sha1 ?? null,
      displayName: mod.displayName ?? filename,
      providerServerSide: projectServerSideForCurseforge(rawSide)
    };
  });

  return {
    kind: "plan",
    plan: {
      loaderType,
      mcVersion: null,
      modFiles: planModFiles,
      extraFiles: [],
      overrideEntries,
      unavailable
    }
  };
}

module.exports = {
  getModpackById, getModpackBySlug, getModpackFiles, detectLoaderType, detectMCVersion, findServerPack,
  inferLoaderFromGameVersions, defaultLoaderForLegacyMc, resolveLoaderType,
  findLinkedServerPackId, findClientFileForServerPack, getFileById, getFilesByIds, getModsByIds,
  parseProjectId, parseModpackSlug, LOADER_MAP,
  isManifestZip, parseManifestFromZip, parseManifestLoaderType,
  synthesizeCurseForgeCdnUrl,
  resolveCurseforgeInstall
};
