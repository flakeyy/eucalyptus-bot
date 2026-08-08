// Shared "file-plan" install engine used by every modpack source. Given a
// normalized plan (mod files to download, extra files, and overrides to upload),
// it downloads and inspects mods in batches, drops client-only mods (and their
// dependents) via the Layer 1 precedence table, and uploads the survivors to
// the server's mods/ directory. Also builds the mod index the boot-verify loop
// (Layer 3) uses for crash attribution.
const AdmZip = require("adm-zip");
const msgLog = require("./logger.js");
const { downloadFile, uploadBufferToServer } = require("./modpack_http.js");
const {
  getFileUploadUrl, decompressFile, chmodServerFiles, deleteServerFiles, createServerDirectory
} = require("./server_functions.js");
const { inspectModJarCached, decideModInstall, extractModDeps, flushModInspectorCache } = require("./mod_inspector.js");
const { assessClientSignals } = require("./client_signals.js");
const {
  createModIndex, addJarToModIndex, addParkedJarToModIndex
} = require("./crash_attribution.js");
const { isProtectedLearnedMod } = require("./verdict_store.js");

const MANIFEST_MOD_BATCH = 20;
// Archive (server-pack / loose zip) uploads: keep each Wings zip well under
// typical proxy/body limits by capping both file count and total bytes.
const ARCHIVE_BATCH_FILES = 20;
const ARCHIVE_BATCH_BYTES = 40 * 1024 * 1024;

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

// Layer 1 decision for one JAR, running mapping-free client signals lazily —
// only when no earlier slot decided (provider silent, no static signal), since
// that is the only case where the scan result matters (slot 8).
function decideWithClientSignals({ inspection, providerServerSide, modId, filename, sha1, buffer }) {
  let decision = decideModInstall({ inspection, providerServerSide, modId, filename, sha1 });
  if (decision.install && decision.slot === 9 && buffer) {
    const risk = assessClientSignals(buffer);
    if (risk.risk && !isProtectedLearnedMod({ modId, filename })) {
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
function normalizeOverridePath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function isOverrideModsJar(path) {
  // Any JAR under mods/ (flat or nested). Nested paths used to bypass the
  // decision filter and land on disk without a modIndex entry.
  return /^mods\/.+\.jar$/i.test(path);
}

async function uploadOverrides(serverId, userId, overrideEntries, loaderType, {
  crashRiskWarnings = null, modIndex = null
} = {}) {
  if (!overrideEntries || overrideEntries.length === 0) return;
  const overridesZip = new AdmZip();
  const uploadedPaths = [];
  for (const entry of overrideEntries) {
    const path = normalizeOverridePath(entry.path);
    // server-icon.png forces AWT on 1.19.x DedicatedServer (libXrender crash on
    // headless yolks). Other 1.19.2 packs boot fine without it.
    if (/(^|\/)server-icon\.(png|jpe?g)$/i.test(path)) {
      msgLog.debugExtended(`[install-modpack] skip override server-icon: ${path}`);
      continue;
    }
    if (isOverrideModsJar(path)) {
      const inspection = inspectModJarCached(null, entry.data, loaderType);
      const { modId, requiredDeps } = extractModDeps(entry.data, loaderType);
      const filename = path.split("/").pop();
      const decision = decideWithClientSignals({
        inspection, providerServerSide: null, modId, filename,
        sha1: null, buffer: entry.data
      });
      if (!decision.install) {
        msgLog.debugExtended(`[install-modpack] skip override mod (client-only, ${decision.source}): ${path}`);
        continue;
      }
      if (modIndex) addJarToModIndex(modIndex, filename, entry.data, { modId, requiredDeps });
      if (crashRiskWarnings) {
        const risk = assessClientSignals(entry.data);
        if (risk.risk) {
          crashRiskWarnings.push({ filename, path, detail: risk.detail, modId });
          msgLog.warn(`[install-modpack] client-signal (override): ${filename}: ${risk.detail}`);
        }
      }
    }
    overridesZip.addFile(path, entry.data, "", 0o100644 << 16);
    uploadedPaths.push(path);
  }
  flushModInspectorCache();
  if (uploadedPaths.length === 0) return;
  const uploadUrl = await getFileUploadUrl(serverId, userId);
  if (!uploadUrl) return;
  const overridesFilename = "overrides.zip";
  await uploadBufferToServer(uploadUrl, overridesFilename, overridesZip.toBuffer());
  await decompressFile(serverId, userId, "/", overridesFilename);
  await chmodServerFiles(serverId, userId, "/", uploadedPaths.map(file => ({ file, mode: "644" }))).catch(() => {});
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
  const { i, serverId, userId, loaderType, updateProgress } = ctx;
  const { modFiles = [], extraFiles = [], overrideEntries = [], unavailable = [] } = plan;
  const update = msg => updateProgress(i, msg);

  // Mapping-free client signals (slot 8). No oracle / mapping download.
  const crashRiskWarnings = [];
  const modIndex = createModIndex();

  // Upload overrides first so server-side config is in place before mods.
  await uploadOverrides(serverId, userId, overrideEntries, loaderType, {
    crashRiskWarnings, modIndex
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
      // Layer 1 precedence table (see mod_inspector.decideModInstall), with
      // mapping-free client signals filling slot 8 when nothing else decided.
      const decision = decideWithClientSignals({
        inspection,
        providerServerSide: r.providerServerSide ?? null,
        modId,
        filename: r.filename,
        sha1: r.sha1 ?? null,
        buffer: r.buffer
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

  // Pure client renderers / splash providers — never dep-rescue. ATM10's
  // sodium-neoforge was skipped as provider-unsupported then force-installed
  // because another mod listed it as required, which immediately crashes the
  // dedicated server on org.lwjgl.Version (ImmediateWindowHandler).
  const NEVER_RESCUE_CLIENT_IDS = new Set([
    "sodium", "embeddium", "rubidium", "iris", "oculus", "fancymenu", "optifine"
  ]);
  const neverRescueClient = info => {
    const id = String(info.modId ?? "").toLowerCase();
    if (id && NEVER_RESCUE_CLIENT_IDS.has(id)) return true;
    const name = String(info.filename ?? "").toLowerCase();
    return /^(sodium|embeddium|rubidium|iris|oculus|fancymenu|optifine)[-_.]/i.test(name);
  };

  // Rescue pass: a rescuably-skipped mod that an installed mod hard-requires
  // must be present server-side anyway (the loader would fail on the missing
  // dependency), so install it rather than dropping the dependent — this is how
  // server-needed libraries with client-leaning metadata survive. Runs to a
  // fixpoint so a rescued mod's own rescuable dependencies get rescued too.
  let rescued = true;
  while (rescued) {
    rescued = false;
    const requiredByInstalled = new Set(
      modInfos.filter(m => !m.isClientOnly).flatMap(m => m.requiredDeps)
    );
    for (const info of modInfos) {
      if (
        info.isClientOnly && info.rescuable && info.modId &&
        requiredByInstalled.has(info.modId) &&
        !neverRescueClient(info) &&
        info.source !== "learned-crashes-server"
      ) {
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

  // Index installed mods for crash attribution, and surface client-signal
  // warnings for mods that install anyway (provider vouched — never a skip).
  for (const info of modInfos) {
    if (info.isClientOnly) continue;
    addJarToModIndex(modIndex, info.filename, info.buffer, {
      modId: info.modId, requiredDeps: info.requiredDeps, sha1: info.sha1 ?? null
    });
    const risk = assessClientSignals(info.buffer);
    if (!risk.risk) continue;
    crashRiskWarnings.push({
      filename: info.filename,
      path: info.path,
      detail: risk.detail,
      modId: info.modId
    });
    msgLog.warn(`[install-modpack] client-signal: ${info.filename}: ${risk.detail}`);
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
    for (const r of results) {
      if (!r) continue;
      if (/(^|\/)server-icon\.(png|jpe?g)$/i.test(String(r.path).replace(/\\/g, "/"))) {
        msgLog.debugExtended(`[install-modpack] skip extra server-icon: ${r.path}`);
        continue;
      }
      extraInfos.push(r);
    }
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

  // Park rescuable skips under mods-disabled/ so boot-verify can restore them
  // if a MissingModsException names them (e.g. Modrinth-mislabeled libs that
  // nothing in the thin manifest hard-requires in metadata).
  const toPark = modInfos.filter(m => m.isClientOnly && m.rescuable);
  if (toPark.length > 0) {
    await createServerDirectory(serverId, userId, "/", "mods-disabled").catch(() => {});
    const parkBatch = toPark.map(info => ({
      path: `mods-disabled/${info.filename}`,
      buffer: info.buffer
    }));
    for (let start = 0; start < parkBatch.length; start += MANIFEST_MOD_BATCH) {
      const batchIdx = Math.floor(start / MANIFEST_MOD_BATCH) + 1;
      const batch = parkBatch.slice(start, start + MANIFEST_MOD_BATCH);
      const ok = await uploadFileBatch(serverId, userId, batch, `park_${batchIdx}`);
      if (!ok) {
        msgLog.warn(`[install-modpack] failed to park ${batch.length} rescuable skip(s) under mods-disabled/`);
        continue;
      }
      for (const info of toPark.slice(start, start + MANIFEST_MOD_BATCH)) {
        addParkedJarToModIndex(modIndex, info.filename, {
          modId: info.modId, sha1: info.sha1 ?? null
        });
        msgLog.debugExtended(`[install-modpack] parked (rescuable skip): mods-disabled/${info.filename}`);
      }
    }
  }

  if (downloadFailed > 0) {
    msgLog.warn(`[install-modpack] manifest install: ${installed}/${total} mods installed, ${downloadFailed} unavailable`);
  }

  return { unavailable, installed, total, crashRiskWarnings, modIndex };
}

// Detect a single top-level folder wrapping mods/ (common CF server-pack layout).
function detectNestedArchiveRoot(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries()
      .map(e => e.entryName.replace(/\\/g, "/"))
      .filter(n => n && !n.endsWith("/"));
    if (entries.length === 0) return null;
    const tops = [ ...new Set(entries.map(n => n.split("/")[0])) ];
    if (tops.length !== 1) return null;
    const root = tops[0];
    if (/\.(zip|jar|tar|gz|bz2|7z)$/i.test(root)) return null;
    const hasNestedMods = entries.some(n => n.startsWith(`${root}/mods/`) && /\.jar$/i.test(n));
    const hasRootMods = entries.some(n => n.startsWith("mods/") && /\.jar$/i.test(n));
    return hasNestedMods && !hasRootMods ? root : null;
  } catch {
    return null;
  }
}

function normalizeArchiveEntryPath(entryName, nestedRoot) {
  let path = String(entryName || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (nestedRoot && path.startsWith(`${nestedRoot}/`)) {
    path = path.slice(nestedRoot.length + 1);
  }
  return path;
}

function shouldSkipArchiveEntry(path) {
  if (!path || path.endsWith("/")) return true;
  if (path.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/i.test(path)) return true;
  // See uploadOverrides — 1.19.x DedicatedServer loads AWT for server-icon.png.
  if (/(^|\/)server-icon\.(png|jpe?g)$/i.test(path)) return true;
  return false;
}

function isArchiveModsJar(path) {
  return /^mods\/[^/]+\.jar$/i.test(path);
}

// Upload { path, buffer } items in size-aware batches via the shared zip path.
async function uploadItemsChunked(serverId, userId, items, update, label) {
  let installed = 0;
  let failed = 0;
  let batchIdx = 0;
  let batch = [];
  let batchBytes = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    batchIdx += 1;
    const ok = await uploadFileBatch(serverId, userId, batch, batchIdx);
    if (!ok) {
      failed += batch.length;
    } else {
      installed += batch.length;
    }
    if (update) {
      await update(
        `**${label}**\n\n${buildProgressBar({
          downloaded: items.length,
          installed: installed + failed,
          total: items.length,
          unit: `${items.length} files`
        })}`
      );
    }
    batch = [];
    batchBytes = 0;
  };

  for (const item of items) {
    const size = item.buffer?.length || 0;
    if (batch.length > 0 && (batch.length >= ARCHIVE_BATCH_FILES || batchBytes + size > ARCHIVE_BATCH_BYTES)) {
      await flush();
    }
    batch.push(item);
    batchBytes += size;
  }
  await flush();
  return { installed, failed };
}

// Install a non-manifest archive (CF server pack or loose zip) by extracting
// locally, stripping client-only mods/, and uploading survivors in chunks —
// same Wings path as manifest installs, avoiding one giant files/decompress.
async function installArchiveBuffer(ctx, buffer) {
  const { i, serverId, userId, loaderType, updateProgress } = ctx;
  const update = msg => updateProgress(i, msg);

  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    msgLog.error(`[install-modpack] archive open failed: ${err.message}`);
    return { unavailable: [], installed: 0, total: 0, crashRiskWarnings: [], modIndex: createModIndex(), error: err.message };
  }

  const nestedRoot = detectNestedArchiveRoot(buffer);
  if (nestedRoot) {
    msgLog.log(`[install-modpack] archive nested root "${nestedRoot}/" — flattening locally before upload`);
  }

  const crashRiskWarnings = [];
  const modIndex = createModIndex();
  const toUpload = [];
  const toPark = [];
  let skippedClient = 0;
  let modJarTotal = 0;

  await update("Extracting archive locally and filtering client-only mods...");

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const path = normalizeArchiveEntryPath(entry.entryName, nestedRoot);
    if (shouldSkipArchiveEntry(path)) continue;

    let data;
    try {
      data = entry.getData();
    } catch (err) {
      msgLog.warn(`[install-modpack] archive entry read failed (${path}): ${err.message}`);
      continue;
    }

    if (isArchiveModsJar(path)) {
      modJarTotal += 1;
      const filename = path.split("/").pop();
      const inspection = inspectModJarCached(null, data, loaderType);
      const { modId, requiredDeps } = extractModDeps(data, loaderType);
      const decision = decideWithClientSignals({
        inspection,
        providerServerSide: null,
        modId,
        filename,
        sha1: null,
        buffer: data
      });
      if (!decision.install) {
        skippedClient += 1;
        msgLog.debugExtended(
          `[install-modpack] skip archive mod (client-only, ${decision.source}): ${filename}`
        );
        if (decision.rescuable) {
          toPark.push({
            path: `mods-disabled/${filename}`,
            buffer: data,
            filename,
            modId
          });
        }
        continue;
      }
      addJarToModIndex(modIndex, filename, data, { modId, requiredDeps });
      const risk = assessClientSignals(data);
      if (risk.risk) {
        crashRiskWarnings.push({ filename, path, detail: risk.detail, modId });
        msgLog.warn(`[install-modpack] client-signal (archive): ${filename}: ${risk.detail}`);
      }
    }

    toUpload.push({ path, buffer: data });
  }
  flushModInspectorCache();

  if (toUpload.length === 0 && toPark.length === 0) {
    msgLog.error("[install-modpack] archive contained no uploadable files after extract/filter");
    return {
      unavailable: [],
      installed: 0,
      total: modJarTotal,
      crashRiskWarnings,
      modIndex,
      skippedClient,
      error: "empty archive after extract"
    };
  }

  await update(
    `Uploading archive contents (${toUpload.length} files` +
    (skippedClient > 0 ? `, skipped ${skippedClient} client-only mods` : "") +
    ")..."
  );

  const { installed, failed } = await uploadItemsChunked(
    serverId, userId, toUpload, update, "Installing archive (chunked upload)"
  );

  if (toPark.length > 0) {
    await createServerDirectory(serverId, userId, "/", "mods-disabled").catch(() => {});
    const parkItems = toPark.map(({ path, buffer }) => ({ path, buffer }));
    const parkResult = await uploadItemsChunked(
      serverId, userId, parkItems, null, "Parking rescuable client mods"
    );
    if (parkResult.failed > 0) {
      msgLog.warn(`[install-modpack] failed to park ${parkResult.failed} rescuable archive skip(s)`);
    }
    for (const info of toPark) {
      addParkedJarToModIndex(modIndex, info.filename, { modId: info.modId, sha1: null });
    }
  }

  if (failed > 0) {
    msgLog.warn(`[install-modpack] archive install: ${installed}/${toUpload.length} files uploaded, ${failed} failed`);
  }
  msgLog.log(
    `[install-modpack] archive install done: ${installed} files, ` +
    `${modJarTotal - skippedClient}/${modJarTotal} mods kept, ${skippedClient} client-only skipped`
  );

  return {
    unavailable: [],
    installed: Math.max(0, modJarTotal - skippedClient),
    total: modJarTotal,
    crashRiskWarnings,
    modIndex,
    skippedClient,
    filesUploaded: installed,
    uploadFailed: failed
  };
}

module.exports = {
  buildProgressBar,
  installFilePlan,
  installArchiveBuffer,
  detectNestedArchiveRoot
};
