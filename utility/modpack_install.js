// Shared "file-plan" install engine used by every modpack source. Given a
// normalized plan (mod files to download, extra files, and overrides to upload),
// it downloads and inspects mods in batches, drops client-only mods (and their
// dependents) via the Layer 1 precedence table, and uploads the survivors to
// the server's mods/ directory. Also builds the mod index the boot-verify loop
// (Layer 3) uses for crash attribution.
const AdmZip = require("adm-zip");
const msgLog = require("./logger.js");
const { downloadFile, uploadBufferToServer } = require("./modpack_http.js");
const { getFileUploadUrl, decompressFile, chmodServerFiles, deleteServerFiles } = require("./server_functions.js");
const { inspectModJarCached, decideModInstall, extractModDeps, flushModInspectorCache } = require("./mod_inspector.js");
const { getOracle, assessCrashRiskCached } = require("./crash_risk.js");
const { createModIndex, addJarToModIndex } = require("./crash_attribution.js");

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

// Layer 1 decision for one JAR, running the Layer 2 crash-proof scan lazily —
// only when no earlier slot decided (provider silent, no static signal), since
// that is the only case where the scan result matters (slot 8).
function decideWithLayer2({ inspection, providerServerSide, modId, filename, sha1, buffer, crashOracle, mcVersion }) {
  let decision = decideModInstall({ inspection, providerServerSide, modId, filename, sha1 });
  if (decision.install && decision.slot === 9 && crashOracle) {
    const risk = assessCrashRiskCached(sha1 ?? null, buffer, crashOracle, mcVersion);
    if (risk.risk) {
      decision = decideModInstall({ inspection, providerServerSide, modId, filename, sha1, crashRisk: risk });
      decision.crashDetail = risk.detail;
    }
  }
  return decision;
}

// Uploads override entries as a single overrides.zip extracted at the server
// root. Mod JARs bundled under overrides/mods/ don't go through the manifest
// download path, so they get the same Layer 1 decision here (without provider
// metadata — overrides carry no source side info). Installed override jars are
// added to modIndex and get crash-risk warnings like manifest mods.
async function uploadOverrides(serverId, userId, overrideEntries, loaderType, {
  crashOracle = null, mcVersion = null, crashRiskWarnings = null, modIndex = null
} = {}) {
  if (!overrideEntries || overrideEntries.length === 0) return;
  const overridesZip = new AdmZip();
  for (const entry of overrideEntries) {
    if (/^mods\/[^/]+\.jar$/i.test(entry.path)) {
      const inspection = inspectModJarCached(null, entry.data, loaderType);
      const { modId, requiredDeps } = extractModDeps(entry.data, loaderType);
      const filename = entry.path.split("/").pop();
      const decision = decideWithLayer2({
        inspection, providerServerSide: null, modId, filename,
        sha1: null, buffer: entry.data, crashOracle, mcVersion
      });
      if (!decision.install) {
        msgLog.debugExtended(`[install-modpack] skip override mod (client-only, ${decision.source}): ${entry.path}`);
        continue;
      }
      if (modIndex) addJarToModIndex(modIndex, filename, entry.data, { modId, requiredDeps });
      if (crashOracle && crashRiskWarnings) {
        const risk = assessCrashRiskCached(null, entry.data, crashOracle, mcVersion);
        if (risk.risk) {
          crashRiskWarnings.push({ filename, path: entry.path, detail: risk.detail, modId });
          msgLog.warn(`[install-modpack] crash-risk (override): ${filename}: ${risk.detail}`);
        }
      }
    }
    overridesZip.addFile(entry.path, entry.data, "", 0o100644 << 16);
  }
  flushModInspectorCache();
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
//   ctx  = { i, serverId, userId, loaderType, mcVersion, updateProgress }
//          updateProgress(i, message) drives the Discord progress display.
//   plan = { modFiles, extraFiles, overrideEntries, unavailable }
// Returns { unavailable, installed, total, crashRiskWarnings, modIndex }.
async function installFilePlan(ctx, plan) {
  const { i, serverId, userId, loaderType, mcVersion = null, updateProgress } = ctx;
  const { modFiles = [], extraFiles = [], overrideEntries = [], unavailable = [] } = plan;
  const update = msg => updateProgress(i, msg);

  // Crash-proof oracle (Layer 2). All loaders: Fabric/Quilt roots come from
  // entrypoints, Forge/NeoForge from @Mod containers; legacy versions without
  // official mappings get a prefix-only oracle. Failure to load is non-fatal.
  const crashOracle = mcVersion ? await getOracle(mcVersion) : null;
  const crashRiskWarnings = [];
  const modIndex = createModIndex();

  // Upload overrides first so server-side config is in place before mods.
  await uploadOverrides(serverId, userId, overrideEntries, loaderType, {
    crashOracle, mcVersion, crashRiskWarnings, modIndex
  });

  const grandTotal = modFiles.length + extraFiles.length;
  let downloadFailed = 0;

  // Phase 1: Download all mods and build dependency metadata. Buffers are kept in
  // memory so we can propagate dependency chains before uploading anything.
  await update(
    `**Installing mods from manifest**\nThis may take a while...\n\n${buildProgressBar({ downloaded: 0, installed: 0, total: grandTotal, unit: `${grandTotal} mods` })}`
  );

  const modInfos = []; // { path, filename, buffer, sha1, isClientOnly, rescuable, source, modId, requiredDeps }
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
      const inspection = inspectModJarCached(r.sha1, r.buffer, loaderType);
      const { modId, requiredDeps } = extractModDeps(r.buffer, loaderType);
      // Layer 1 precedence table (see mod_inspector.decideModInstall), with the
      // Layer 2 crash-proof scan filling slot 8 when nothing else decided.
      const decision = decideWithLayer2({
        inspection,
        providerServerSide: r.providerServerSide ?? null,
        modId,
        filename: r.filename,
        sha1: r.sha1 ?? null,
        buffer: r.buffer,
        crashOracle,
        mcVersion
      });
      if (!decision.install) {
        msgLog.debugExtended(`[install-modpack] skip (client-only, slot ${decision.slot}/${decision.source}): ${r.filename}`);
      }
      modInfos.push({
        ...r,
        isClientOnly: !decision.install,
        rescuable: decision.rescuable,
        source: decision.source,
        modId,
        requiredDeps
      });
    }
    flushModInspectorCache();

    await update(
      `**Installing mods from manifest**\nThis may take a while...\n\n${buildProgressBar({ downloaded: modInfos.length + downloadFailed, installed: 0, total: grandTotal, unit: `${grandTotal} mods` })}`
    );
  }

  // Rescue pass: a rescuably-skipped mod that an installed mod hard-requires
  // must be present server-side anyway (the loader would fail on the missing
  // dependency), so install it rather than dropping the dependent — this is how
  // server-needed libraries with client-leaning metadata (e.g. rendering libs
  // marked unsupported on Modrinth) survive. Runs to a fixpoint so a rescued
  // mod's own rescuable dependencies get rescued too.
  let rescued = true;
  while (rescued) {
    rescued = false;
    const requiredByInstalled = new Set(
      modInfos.filter(m => !m.isClientOnly).flatMap(m => m.requiredDeps)
    );
    for (const info of modInfos) {
      if (info.isClientOnly && info.rescuable && info.modId && requiredByInstalled.has(info.modId)) {
        info.isClientOnly = false;
        info.source = "dep-rescue";
        rescued = true;
        msgLog.debugExtended(`[install-modpack] install (required by installed mod): ${info.filename}`);
      }
    }
  }

  // Propagate client-only status: if a mod's required dependency was skipped,
  // skip the mod too. Provider-vouched mods (required/optional) are exempt —
  // the pack author asserts they run server-side (their "dep" on a client mod
  // is typically integration-only, e.g. chipped→ctm, configscreens→modmenu);
  // if the dependency truly is hard, the boot-verify loop attributes the
  // missing-dep failure and quarantines the dependent.
  const providerVouched = m => m.providerServerSide === "required" || m.providerServerSide === "optional";
  const skippedModIds = new Set(modInfos.filter(m => m.isClientOnly && m.modId).map(m => m.modId));
  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const info of modInfos) {
      if (!info.isClientOnly && !providerVouched(info) && info.requiredDeps.some(dep => skippedModIds.has(dep))) {
        info.isClientOnly = true;
        if (info.modId) { skippedModIds.add(info.modId); propagated = true; }
        msgLog.debugExtended(`[install-modpack] skip (client-dep chain): ${info.filename}`);
      }
    }
  }

  // Index installed mods for crash attribution, and surface crash-risk warnings
  // for mods that install anyway (provider vouched for them — never a skip).
  for (const info of modInfos) {
    if (info.isClientOnly) continue;
    addJarToModIndex(modIndex, info.filename, info.buffer, {
      modId: info.modId, requiredDeps: info.requiredDeps, sha1: info.sha1 ?? null
    });
    if (!crashOracle) continue;
    const risk = assessCrashRiskCached(info.sha1 ?? null, info.buffer, crashOracle, mcVersion);
    if (!risk.risk) continue;
    crashRiskWarnings.push({
      filename: info.filename,
      path: info.path,
      detail: risk.detail,
      modId: info.modId
    });
    msgLog.warn(`[install-modpack] crash-risk: ${info.filename}: ${risk.detail}`);
  }
  flushModInspectorCache();

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

  return { unavailable, installed, total, crashRiskWarnings, modIndex };
}

module.exports = { buildProgressBar, installFilePlan };
