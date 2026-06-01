// Shared "file-plan" install engine used by every modpack source. Given a
// normalized plan (mod files to download, extra files, and overrides to upload),
// it downloads and inspects mods in batches, drops client-only mods (and their
// dependents), and uploads the survivors to the server's mods/ directory.
const AdmZip = require("adm-zip");
const config = require("../config.json");
const msgLog = require("./logger.js");
const { downloadFile, uploadBufferToServer } = require("./modpack_http.js");
const { getFileUploadUrl, decompressFile, chmodServerFiles, deleteServerFiles } = require("./server_functions.js");
const { inspectModJarCached, extractModDeps, flushModInspectorCache } = require("./mod_inspector.js");

const MANIFEST_MOD_BATCH = 20;

// Renders a dual download/upload progress bar. `unit` is the trailing label
// (e.g. "42 mods" or "18.3 MB"); downloaded/installed/total share its scale.
function buildProgressBar({ downloaded, installed, total, unit, width = 20 }) {
  const half = Math.floor(width / 2);
  const dlPct = total > 0 ? Math.min(downloaded / total, 1) : 0;
  const ulPct = total > 0 ? Math.min(installed / total, 1) : 0;
  const dlBar = "█".repeat(Math.round(dlPct * half)) + "░".repeat(half - Math.round(dlPct * half));
  const ulBar = "█".repeat(Math.round(ulPct * half)) + "░".repeat(half - Math.round(ulPct * half));
  return `\`[${dlBar}↓${ulBar}↑]\` ↓ ${Math.round(dlPct * 100)}% · ↑ ${Math.round(ulPct * 100)}% · ${unit}`;
}

// Uploads override entries as a single overrides.zip extracted at the server root.
async function uploadOverrides(serverId, userId, overrideEntries) {
  if (!overrideEntries || overrideEntries.length === 0) return;
  const overridesZip = new AdmZip();
  for (const entry of overrideEntries) {
    overridesZip.addFile(entry.path, entry.data, "", 0o100644 << 16);
  }
  const uploadUrl = await getFileUploadUrl(serverId, userId);
  if (!uploadUrl) return;
  const overridesFilename = "overrides.zip";
  await uploadBufferToServer(uploadUrl, overridesFilename, overridesZip.toBuffer());
  await decompressFile(serverId, userId, "/", overridesFilename);
  await chmodServerFiles(serverId, userId, "/", overrideEntries.map(e => ({ file: e.path, mode: "644" }))).catch(() => {});
}

// Bundles { path, buffer } items into a zip, uploads + extracts it at the root,
// chmods them, and removes the temp zip. Returns true on success.
async function uploadFileBatch(serverId, userId, items, batchIdx) {
  const batchZip = new AdmZip();
  for (const { path, buffer } of items) {
    batchZip.addFile(path, buffer, "", 0o100644 << 16);
  }
  const zipFilename = `_mods_batch_${batchIdx}.zip`;

  const uploadUrl = await getFileUploadUrl(serverId, userId);
  if (!uploadUrl) {
    msgLog.error(`[install-modpack] no upload URL for mod batch ${batchIdx}`);
    return false;
  }
  const uploadRes = await uploadBufferToServer(uploadUrl, zipFilename, batchZip.toBuffer());
  if (!uploadRes.ok) {
    msgLog.error(`[install-modpack] mod batch ${batchIdx} upload failed: HTTP ${uploadRes.status}`);
    return false;
  }

  await decompressFile(serverId, userId, "/", zipFilename);
  await chmodServerFiles(serverId, userId, "/", items.map(({ path }) => ({ file: path, mode: "644" }))).catch(() => {});
  await deleteServerFiles(serverId, userId, [ zipFilename ]).catch(() => {});
  return true;
}

// Installs a normalized plan onto a server.
//   ctx  = { i, serverId, userId, loaderType, updateProgress }
//          updateProgress(i, message) drives the Discord progress display.
//   plan = { modFiles, extraFiles, overrideEntries, unavailable }
// Returns { unavailable, installed, total }.
async function installFilePlan(ctx, plan) {
  const { i, serverId, userId, loaderType, updateProgress } = ctx;
  const { modFiles = [], extraFiles = [], overrideEntries = [], unavailable = [] } = plan;
  const update = msg => updateProgress(i, msg);

  // Upload overrides first so server-side config is in place before mods.
  await uploadOverrides(serverId, userId, overrideEntries);

  const grandTotal = modFiles.length + extraFiles.length;
  let downloadFailed = 0;

  // Phase 1: Download all mods and build dependency metadata. Buffers are kept in
  // memory so we can propagate dependency chains before uploading anything.
  await update(
    `**Installing mods from manifest**\nThis may take a while...\n\n${buildProgressBar({ downloaded: 0, installed: 0, total: grandTotal, unit: `${grandTotal} mods` })}`
  );

  const modInfos = []; // { path, filename, buffer, sha1, isClientOnly, source, modId, requiredDeps }
  for (let start = 0; start < modFiles.length; start += MANIFEST_MOD_BATCH) {
    const batch = modFiles.slice(start, start + MANIFEST_MOD_BATCH);
    const results = await Promise.all(batch.map(async mod => {
      try {
        return { ...mod, buffer: await downloadFile(mod.downloadUrl) };
      } catch (e) {
        msgLog.debugExtended(`[install-modpack] mod download failed: ${mod.filename}: ${e.message}`);
        downloadFailed++;
        return null;
      }
    }));

    for (const r of results) {
      if (!r) continue;
      let { isClientOnly, source } = inspectModJarCached(r.sha1, r.buffer, loaderType);
      const { modId, requiredDeps } = extractModDeps(r.buffer, loaderType);
      // Fall back to source-provided side metadata only when the JAR declares none.
      if (!isClientOnly && source === "no-metadata" && r.sideFallback === "unsupported") {
        isClientOnly = true;
        source = "source-env";
      }
      if (!isClientOnly && modId !== null && (config.mod_id_blocklist ?? []).includes(modId)) {
        isClientOnly = true;
        source = "blocklist";
      }
      if (isClientOnly) msgLog.debugExtended(`[install-modpack] skip (client-only, ${source}): ${r.filename}`);
      modInfos.push({ ...r, isClientOnly, source, modId, requiredDeps });
    }
    flushModInspectorCache();

    await update(
      `**Installing mods from manifest**\nThis may take a while...\n\n${buildProgressBar({ downloaded: modInfos.length + downloadFailed, installed: 0, total: grandTotal, unit: `${grandTotal} mods` })}`
    );
  }

  // Propagate client-only status: if a mod's required dependency was skipped, skip the mod too.
  const skippedModIds = new Set(modInfos.filter(m => m.isClientOnly && m.modId).map(m => m.modId));
  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const info of modInfos) {
      if (!info.isClientOnly && info.requiredDeps.some(dep => skippedModIds.has(dep))) {
        info.isClientOnly = true;
        if (info.modId) { skippedModIds.add(info.modId); propagated = true; }
        msgLog.debugExtended(`[install-modpack] skip (client-dep chain): ${info.filename}`);
      }
    }
  }

  // Download extra (non-mod) files — configs etc. that need no side inspection.
  const extraInfos = [];
  for (let start = 0; start < extraFiles.length; start += MANIFEST_MOD_BATCH) {
    const batch = extraFiles.slice(start, start + MANIFEST_MOD_BATCH);
    const results = await Promise.all(batch.map(async file => {
      try {
        return { path: file.path, buffer: await downloadFile(file.downloadUrl) };
      } catch (e) {
        msgLog.debugExtended(`[install-modpack] extra file download failed: ${file.path}: ${e.message}`);
        downloadFailed++;
        return null;
      }
    }));
    for (const r of results) if (r) extraInfos.push(r);
  }

  // Phase 2: Upload non-skipped mods plus extra files in batches.
  const toInstall = [ ...modInfos.filter(m => !m.isClientOnly), ...extraInfos ];
  const total = toInstall.length;
  let installed = 0;

  for (let start = 0; start < toInstall.length; start += MANIFEST_MOD_BATCH) {
    const batchIdx = Math.floor(start / MANIFEST_MOD_BATCH) + 1;
    const batch = toInstall.slice(start, start + MANIFEST_MOD_BATCH);

    await update(
      `**Installing mods from manifest**\nThis may take a while...\n\n${buildProgressBar({ downloaded: grandTotal, installed, total: grandTotal, unit: `${grandTotal} mods` })}`
    );

    const ok = await uploadFileBatch(serverId, userId, batch, batchIdx);
    if (!ok) {
      downloadFailed += batch.length;
      continue;
    }

    installed += batch.length;
    await update(
      `**Installing mods from manifest**\nThis may take a while...\n\n${buildProgressBar({ downloaded: grandTotal, installed, total: grandTotal, unit: `${grandTotal} mods` })}`
    );
  }

  if (downloadFailed > 0) {
    msgLog.warn(`[install-modpack] manifest install: ${installed}/${total} mods installed, ${downloadFailed} unavailable`);
  }

  return { unavailable, installed, total };
}

module.exports = { buildProgressBar, installFilePlan };
