require("dotenv").config();

const CURSEFORGE_BASE_URL = "https://api.curseforge.com/v1";
const msgLog = require("./logger.js");

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

async function getModpackById(projectId) {
  const response = await fetch(
    `${CURSEFORGE_BASE_URL}/mods/${projectId}`,
    { headers: { "x-api-key": process.env.CURSEFORGE_API_KEY, "Accept": "application/json" } }
  );
  msgLog.debug(`API: GET /curse/mods/${projectId} | Status Code: ${response.status}`);
  if (!response.ok) throw new Error(`CurseForge API error: HTTP ${response.status}`);
  const data = await response.json();
  if (!data.data) return null;
  // Verify it's a Minecraft modpack (gameId=432, classId=4471)
  if (data.data.gameId !== 432 || data.data.classId !== 4471) return null;
  return data.data;
}

async function getModpackFiles(modId) {
  const response = await fetch(
    `${CURSEFORGE_BASE_URL}/mods/${modId}/files`,
    { headers: { "x-api-key": process.env.CURSEFORGE_API_KEY, "Accept": "application/json" } }
  );
  msgLog.debug(`API: GET /curse/mods/${modId}/files | Status Code: ${response.status}`);
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

async function getFileById(modId, fileId) {
  const response = await fetch(
    `${CURSEFORGE_BASE_URL}/mods/${modId}/files/${fileId}`,
    { headers: { "x-api-key": process.env.CURSEFORGE_API_KEY, "Accept": "application/json" } }
  );
  msgLog.debug(`API: GET /curse/mods/${modId}/files/${fileId} | Status Code: ${response.status}`);
  if (!response.ok) return null;
  const data = await response.json();
  return data.data || null;
}

module.exports = {
  getModpackById, getModpackFiles, detectLoaderType, findServerPack,
  findLinkedServerPackId, getFileById, parseProjectId, LOADER_MAP
};
