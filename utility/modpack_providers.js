// Source dispatch for modpack installs. Resolves a user-supplied URL to a
// provider, looks up the modpack and its installable files in a normalized
// shape, and routes archive/manifest resolution to the matching resolver so the
// command and install engine stay source-agnostic.
const msgLog = require("./logger.js");
const {
  getModpackById, getModpackBySlug, getModpackFiles, getFilesByIds,
  detectMCVersion, resolveLoaderType, parseProjectId, parseModpackSlug,
  resolveCurseforgeInstall
} = require("./curseforge.js");
const {
  parseModrinthUrl, getModrinthModpack, getModrinthVersions,
  mapModrinthLoader, resolveModrinthInstall
} = require("./modrinth.js");

const LOADER_KEYWORDS = /java|forge|fabric|neoforge|quilt/i;
// Soft cap on listed versions (Discord select menus paginate these in the UI).
const MAX_FILE_OPTIONS = 100;
// Options shown per select-menu page (Discord max is 25).
const FILE_SELECT_PAGE_SIZE = 10;

// Determines the modpack source from user input. Returns "curseforge",
// "modrinth", or null when the host isn't recognized. Bare numeric input is
// treated as a CurseForge project ID for backward compatibility.
function detectProvider(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return "curseforge";

  let host;
  try {
    host = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === "curseforge.com" || host.endsWith(".curseforge.com")) return "curseforge";
  if (host === "modrinth.com" || host.endsWith(".modrinth.com")) return "modrinth";
  return null;
}

// Looks up a modpack for the given source. Returns a normalized
// { source, id, name, loaderType, raw } or null when the input can't be parsed
// or the modpack isn't found. Throws on upstream API errors.
async function lookupModpack(source, rawInput) {
  if (source === "curseforge") {
    const projectId = parseProjectId(rawInput);
    const slug = projectId ? null : parseModpackSlug(rawInput);
    if (!projectId && !slug) return null;
    const modpack = projectId ? await getModpackById(projectId) : await getModpackBySlug(slug);
    if (!modpack) return null;
    const indexedMc = modpack.latestFilesIndexes?.[0]?.gameVersion || null;
    const indexedVersions = (modpack.latestFiles || [])
      .flatMap(f => f.gameVersions || []);
    return {
      source,
      id: modpack.id,
      name: modpack.name,
      loaderType: resolveLoaderType({
        indexes: modpack.latestFilesIndexes,
        gameVersions: indexedVersions,
        mcVersion: indexedMc
      }),
      raw: modpack
    };
  }
  if (source === "modrinth") {
    const trimmed = String(rawInput || "").trim();
    const id = parseModrinthUrl(trimmed)
      || (/^[\w-]+$/.test(trimmed) ? trimmed : null);
    if (!id) return null;
    const project = await getModrinthModpack(id);
    if (!project) return null;
    return { source, id: project.id, name: project.title, loaderType: mapModrinthLoader(project.loaders), raw: project };
  }
  return null;
}

// Returns installable file options for a modpack in a normalized shape:
// { id, label, description, downloadUrl, isServerPack, mcVersion, loaderType }.
async function listModpackFiles(source, modpack) {
  if (source === "curseforge") return listCurseforgeFiles(modpack);
  if (source === "modrinth") return listModrinthFiles(modpack);
  return [];
}

async function listCurseforgeFiles(modpack) {
  const cf = modpack.raw;
  const loaderType = modpack.loaderType;

  let files = null;
  try {
    files = await getModpackFiles(cf.id);
  } catch (e) {
    msgLog.warn(`[install-modpack] getModpackFiles failed: ${e.message}`);
  }

  // Client files sorted by date, latest first (server packs aren't in the main list)
  const sortedClientFiles = (files || [])
    .filter(f => !f.isServerPack && f.downloadUrl)
    .sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate))
    .slice(0, MAX_FILE_OPTIONS);
  if (sortedClientFiles.length === 0) return [];

  // Batch-resolve linked server packs (one POST instead of N GETs)
  const serverPackIds = sortedClientFiles
    .map(f => f.serverPackFileId)
    .filter(Boolean);
  let serverPackById = new Map();
  if (serverPackIds.length > 0) {
    try {
      const packs = await getFilesByIds(serverPackIds);
      serverPackById = new Map(packs.map(p => [ p.id, p ]));
    } catch (e) {
      msgLog.warn(`[install-modpack] getFilesByIds (server packs) failed: ${e.message}`);
    }
  }

  // Prefer server packs when the author published one. Fall back to the client
  // pack (manifest + strip client-only jars) only when no linked server pack exists.
  // One option per version: emitting both doubled the list past MAX_FILE_OPTIONS
  // (which was applied to client files only) and interleaved near-identical pairs
  // across 20 pages. The description marks which kind was chosen.
  // `metaFile` is the client file the version was listed from: server-pack
  // entries frequently ship sparse gameVersions, so loader/MC detection reads
  // through to the client file rather than losing the metadata with the option.
  const rawOptions = [];
  for (const clientFile of sortedClientFiles) {
    const sp = clientFile.serverPackFileId
      ? serverPackById.get(clientFile.serverPackFileId)
      : null;
    rawOptions.push(sp?.downloadUrl
      ? { file: sp, metaFile: clientFile }
      : { file: clientFile, metaFile: clientFile });
  }

  return rawOptions.map(({ file, metaFile }) => {
    const mcVersion = detectMCVersion(cf, file) ?? detectMCVersion(cf, metaFile);
    const gameVersions = file.gameVersions?.length ? file.gameVersions : metaFile.gameVersions;
    const mcVer = gameVersions?.find(v => /^\d+\.\d+/.test(v) && !LOADER_KEYWORDS.test(v));
    const date = (file.fileDate ?? metaFile.fileDate)?.slice(0, 10) ?? "";
    const packType = file.isServerPack ? "Server pack" : "Client pack";
    const sizeMb = file.fileLength ? `${(file.fileLength / 1_048_576).toFixed(1)} MB` : null;
    const description = [ mcVer, date, sizeMb, packType ].filter(Boolean).join(" · ").slice(0, 100);
    return {
      id: String(file.id),
      label: String(file.displayName || metaFile.displayName || file.id).slice(0, 100),
      description,
      downloadUrl: file.downloadUrl,
      isServerPack: !!file.isServerPack,
      mcVersion,
      loaderType: resolveLoaderType({ gameVersions, mcVersion }) || loaderType
    };
  });
}

async function listModrinthFiles(modpack) {
  let versions = null;
  try {
    versions = await getModrinthVersions(modpack.id);
  } catch (e) {
    msgLog.warn(`[install-modpack] getModrinthVersions failed: ${e.message}`);
  }
  if (!Array.isArray(versions) || versions.length === 0) return [];

  return versions.slice(0, MAX_FILE_OPTIONS).map(v => {
    const primary = (v.files || []).find(f => f.primary) ?? v.files?.[0];
    if (!primary?.url) return null;
    const mcVer = (v.game_versions || []).find(g => /^\d+\.\d+/.test(g)) ?? null;
    const loaderType = mapModrinthLoader(v.loaders);
    const date = v.date_published?.slice(0, 10) ?? "";
    const sizeMb = primary.size ? `${(primary.size / 1_048_576).toFixed(1)} MB` : null;
    const description = [ mcVer, loaderType, date, sizeMb ].filter(Boolean).join(" · ").slice(0, 100);
    return {
      id: String(v.id),
      label: String(v.name || v.version_number).slice(0, 100),
      description,
      downloadUrl: primary.url,
      isServerPack: false,
      mcVersion: mcVer,
      loaderType
    };
  }).filter(Boolean);
}

// Resolves a downloaded modpack archive into an install result for the given
// source. Returns { kind: "archive", ... } or { kind: "plan", plan } (or null
// when the buffer can't be resolved). onProgress(message) surfaces status.
async function resolveModpackInstall(source, buffer, loaderType, onProgress = () => {}) {
  if (source === "curseforge") return resolveCurseforgeInstall(buffer, loaderType, onProgress);
  if (source === "modrinth") return resolveModrinthInstall(buffer);
  return null;
}

module.exports = {
  detectProvider, lookupModpack, listModpackFiles, resolveModpackInstall,
  FILE_SELECT_PAGE_SIZE, MAX_FILE_OPTIONS
};
