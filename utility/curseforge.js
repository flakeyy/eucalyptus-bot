require("dotenv").config();

const CURSEFORGE_BASE_URL = "https://api.curseforge.com/v1";
const msgLog = require("./logger.js");
const AdmZip = require("adm-zip");

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

async function getModpackFiles(modId) {
  const response = await fetch(
    `${CURSEFORGE_BASE_URL}/mods/${modId}/files`,
    { headers: { "x-api-key": process.env.CURSEFORGE_API_KEY, "Accept": "application/json" } }
  );
  msgLog.debugExtended(`API: GET /curse/mods/${modId}/files | Status Code: ${response.status}`);
  if (!response.ok) throw new Error(`CurseForge API error: HTTP ${response.status}`);
  const data = await response.json();
  return data.data || [];
}

function detectLoaderType(latestFilesIndexes) {
  if (!latestFilesIndexes || latestFilesIndexes.length === 0) return null;
  for (const entry of latestFilesIndexes) {
    const loader = LOADER_MAP[entry.modLoader];
    if (loader) return loader;
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

module.exports = {
  getModpackById, getModpackBySlug, getModpackFiles, detectLoaderType, findServerPack,
  findLinkedServerPackId, getFileById, getFilesByIds, getModsByIds,
  parseProjectId, parseModpackSlug, LOADER_MAP,
  isManifestZip, parseManifestFromZip, parseManifestLoaderType
};
