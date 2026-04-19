const {
  ContainerBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, MessageFlags,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder
} = require("discord.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const msgLog = require("../../utility/logger.js");
const { getUserId, reconstructCommand, userHasClientApiKey, applicationApiCall } = require("../../utility/helper_functions.js");
const {
  getClientServers, setServerPowerState, getServerResourceInfoById,
  changeServerEgg, reinstallServer, listServerFiles, deleteServerFiles, getFileUploadUrl, decompressFile, chmodServerFiles
} = require("../../utility/server_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");
const { getModpackById, getModpackFiles, detectLoaderType, getFileById, getFilesByIds, getModsByIds, parseProjectId, isManifestZip, parseManifestFromZip } = require("../../utility/curseforge.js");
const { analyzeModrinthFiles, getClientOnlyBySlugs } = require("../../utility/modrinth.js");
const AdmZip = require("adm-zip");
const config = require("../../config.json");

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

function getJavaImageForMCVersion(mcVersion) {
  const javaMap = config.minecraft_java_map;
  const images = config.java_images;
  if (!mcVersion || !javaMap || !images) return null;

  const match = mcVersion.match(/^(\d+\.\d+)/);
  if (!match) return null;
  const majorMinor = match[1];

  if (javaMap[majorMinor] !== undefined) {
    return images[String(javaMap[majorMinor])] || null;
  }

  // Find highest configured key that is <= the given version
  const [ vmaj, vmin ] = majorMinor.split(".").map(Number);
  const sorted = Object.keys(javaMap).sort((a, b) => {
    const [ amaj, amin ] = a.split(".").map(Number);
    const [ bmaj, bmin ] = b.split(".").map(Number);
    return bmaj !== amaj ? bmaj - amaj : bmin - amin;
  });
  for (const key of sorted) {
    const [ kmaj, kmin ] = key.split(".").map(Number);
    if (vmaj > kmaj || (vmaj === kmaj && vmin >= kmin)) {
      return images[String(javaMap[key])] || null;
    }
  }
  return null;
}

/* global TextEncoder, ReadableStream */
async function downloadFileToBuffer(downloadUrl, onDownloadProgress) {
  const dlResponse = await fetch(downloadUrl);
  if (!dlResponse.ok) throw Object.assign(new Error(`Download failed: HTTP ${dlResponse.status}`), { isDownload: true });

  const fileSize = parseInt(dlResponse.headers.get("content-length") || "0", 10);
  const hasSize = fileSize > 0;
  let lastProgressAt = 0;
  const THROTTLE_MS = 2500;

  const chunks = [];
  let downloadBytes = 0;
  const dlReader = dlResponse.body.getReader();
  while (true) {
    const { done, value } = await dlReader.read();
    if (done) break;
    chunks.push(value);
    downloadBytes += value.length;
    if (onDownloadProgress && hasSize) {
      const now = Date.now();
      if (now - lastProgressAt >= THROTTLE_MS) {
        lastProgressAt = now;
        onDownloadProgress(downloadBytes, fileSize);
      }
    }
  }
  if (onDownloadProgress && hasSize) onDownloadProgress(fileSize, fileSize);
  return { chunks, fileSize };
}

async function uploadBufferToServer(uploadUrl, filename, chunks, fileSize, onProgress) {
  const hasSize = fileSize > 0;
  let lastProgressAt = 0;
  const THROTTLE_MS = 2500;

  const boundary = `WingsBoundary${Date.now()}`;
  const enc = new TextEncoder();
  const partHeader = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const partFooter = enc.encode(`\r\n--${boundary}--\r\n`);

  const uploadHeaders = { "Content-Type": `multipart/form-data; boundary=${boundary}` };
  if (hasSize) {
    uploadHeaders["Content-Length"] = String(partHeader.length + fileSize + partFooter.length);
  }

  let uploadBytes = 0;
  let chunkIdx = 0;
  let headerSent = false;

  const body = new ReadableStream({
    pull(controller) {
      if (!headerSent) {
        controller.enqueue(partHeader);
        headerSent = true;
      } else if (chunkIdx < chunks.length) {
        const chunk = chunks[chunkIdx++];
        uploadBytes += chunk.length;
        if (onProgress && hasSize) {
          const now = Date.now();
          if (now - lastProgressAt >= THROTTLE_MS) {
            lastProgressAt = now;
            onProgress(fileSize, uploadBytes, fileSize);
          }
        }
        controller.enqueue(chunk);
      } else {
        controller.enqueue(partFooter);
        controller.close();
      }
    }
  });

  const uploadResponse = await fetch(uploadUrl, { method: "POST", headers: uploadHeaders, body, duplex: "half" });
  if (!uploadResponse.ok) throw Object.assign(new Error(`Upload failed: HTTP ${uploadResponse.status}`), { isUpload: true });
}

function buildManifestProgressBar(downloaded, installed, total, width = 20) {
  const half = Math.floor(width / 2);
  const dlPct = total > 0 ? Math.min(downloaded / total, 1) : 0;
  const ulPct = total > 0 ? Math.min(installed / total, 1) : 0;
  const dlBar = "█".repeat(Math.round(dlPct * half)) + "░".repeat(half - Math.round(dlPct * half));
  const ulBar = "█".repeat(Math.round(ulPct * half)) + "░".repeat(half - Math.round(ulPct * half));
  return `\`[${dlBar}↓${ulBar}↑]\` ↓ ${Math.round(dlPct * 100)}% · ↑ ${Math.round(ulPct * 100)}% · ${total} mods`;
}

function buildProgressBar(downloadBytes, uploadBytes, fileSize, width = 20) {
  const half = Math.floor(width / 2);
  const dlPct = Math.min(downloadBytes / fileSize, 1);
  const ulPct = Math.min(uploadBytes / fileSize, 1);
  const dlBar = "█".repeat(Math.round(dlPct * half)) + "░".repeat(half - Math.round(dlPct * half));
  const ulBar = "█".repeat(Math.round(ulPct * half)) + "░".repeat(half - Math.round(ulPct * half));
  const totalMb = (fileSize / 1_048_576).toFixed(1);
  return `\`[${dlBar}↓${ulBar}↑]\` ↓ ${Math.round(dlPct * 100)}% · ↑ ${Math.round(ulPct * 100)}% · ${totalMb} MB`;
}

const COLORS = {
  PRIMARY: 0x6b34eb,
  SUCCESS: 0x00aa00,
  DISABLED: 0x808080
};

const COLLECTOR_IDLE_TIMEOUT = 300_000;
const HTTP_STATUS_CODES = { OK: 200, NO_CONTENT: 204 };
const STOP_POLL = { MAX_ATTEMPTS: 60, INTERVAL: 2000 };
const MANIFEST_MOD_BATCH = 20;

function buildServerSelectContainer(servers, nestMap, statusNote = null, disabled = false) {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("server-select")
    .setPlaceholder(disabled ? "Session ended" : "Select a Minecraft server")
    .setDisabled(disabled);

  if (servers && servers.length > 0) {
    for (const server of servers) {
      const isMinecraft = nestMap[server.attributes.identifier] === config.minecraft_nest_id;
      selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(server.attributes.name)
          .setDescription(isMinecraft
            ? `ID: ${server.attributes.identifier}`
            : `[Non-Minecraft] ID: ${server.attributes.identifier}`)
          .setValue(server.attributes.identifier)
      );
    }
  } else {
    selectMenu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel("No servers found")
        .setDescription("No servers available")
        .setValue("none")
    );
  }

  let content = "**Install Modpack**\n\nSelect a Minecraft server to install a modpack on.\n_Non-Minecraft servers are not eligible._";
  if (statusNote) content += `\n\n${statusNote}`;

  return new ContainerBuilder()
    .setAccentColor(disabled ? COLORS.DISABLED : COLORS.PRIMARY)
    .addTextDisplayComponents(text => text.setContent(content))
    .addSeparatorComponents(sep => sep)
    .addActionRowComponents(row => row.setComponents(selectMenu));
}

function buildFileSelectContainer(modpackName, fileOptions, autoSelectedId) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("file-select")
    .setPlaceholder("Select a version");

  for (const file of fileOptions) {
    const loaderKw = /java|forge|fabric|neoforge|quilt/i;
    const mcVer = file.gameVersions?.find(v => /^\d+\.\d+/.test(v) && !loaderKw.test(v));
    const date = file.fileDate?.slice(0, 10) ?? "";
    const packType = file.isServerPack ? "Server pack" : "Client pack";
    const sizeMb = file.fileLength ? `${(file.fileLength / 1_048_576).toFixed(1)} MB` : null;
    const description = [ mcVer, date, sizeMb, packType ].filter(Boolean).join(" · ").slice(0, 100);

    menu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(file.displayName.slice(0, 100))
        .setDescription(description)
        .setValue(String(file.id))
        .setDefault(file.id === autoSelectedId)
    );
  }

  return new ContainerBuilder()
    .setAccentColor(COLORS.PRIMARY)
    .addTextDisplayComponents(text => text.setContent(
      `**Install Modpack — Select Version**\n\n**Modpack:** ${modpackName}\n\n` +
      "The recommended version is pre-selected. Change it if needed.\n" +
      "_Versions are sorted latest first. Use a server pack where available._"
    ))
    .addSeparatorComponents(sep => sep)
    .addActionRowComponents(row => row.setComponents(menu))
    .addActionRowComponents(row => row.setComponents(
      new ButtonBuilder().setCustomId("file-select-confirm").setLabel("Continue").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    ));
}

function buildConfirmView1(serverName, modpackName, fileName, loaderType) {
  let content = "**Install Modpack — Confirm**\n\n";
  content += `**Server:** ${serverName}\n`;
  content += `**Modpack:** ${modpackName}\n`;
  content += `**File:** ${fileName}\n`;
  content += `**Loader:** ${loaderType ?? "unknown"}\n\n`;
  content += "**WARNING: This will permanently wipe all server files. Back up your server before continuing.**";

  return new ContainerBuilder()
    .setAccentColor(COLORS.PRIMARY)
    .addTextDisplayComponents(text => text.setContent(content))
    .addSeparatorComponents(sep => sep)
    .addActionRowComponents(row => row.setComponents(
      new ButtonBuilder().setCustomId("confirm-1").setLabel("Confirm").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    ));
}

function buildConfirmView2(serverName, modpackName) {
  let content = "**Install Modpack — Final Confirmation**\n\n";
  content += `Installing **${modpackName}** on **${serverName}**.\n\n`;
  content += "**Last chance — this will permanently delete all server files.**";

  return new ContainerBuilder()
    .setAccentColor(COLORS.PRIMARY)
    .addTextDisplayComponents(text => text.setContent(content))
    .addSeparatorComponents(sep => sep)
    .addActionRowComponents(row => row.setComponents(
      new ButtonBuilder().setCustomId("confirm-2").setLabel("Install Now").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    ));
}

async function updateProgress(i, message) {
  const container = new ContainerBuilder()
    .setAccentColor(COLORS.PRIMARY)
    .addTextDisplayComponents(text => text.setContent(`**Installing Modpack**\n\n${message}`));
  await i.editReply({ components: [ container ], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
}

async function runManifestSteps(i, serverId, userId, buffer, manifest) {
  // Resolve files and mod metadata first so we can filter overrides
  const requiredEntries = (manifest.files || []).filter(f => f.required);
  await updateProgress(i,
    "No direct server pack download was available. Installing from manifest — this may take longer than usual.\n\nResolving mod list..."
  );
  const resolvedFiles = await getFilesByIds(requiredEntries.map(f => f.fileID)).catch(() => []);

  const nameByModId = new Map(resolvedFiles.map(f => [ f.modId, f.displayName ?? f.fileName ?? String(f.modId) ]));

  // Fetch mod metadata for all resolved files — used for classId filtering and slug-based client-only fallback
  const allModIds = [ ...new Set(resolvedFiles.map(f => f.modId)) ];
  const allCfMods = await getModsByIds(allModIds);
  const classIdByModId = new Map(allCfMods.map(m => [ m.id, m.classId ]));
  const slugByModId = new Map(allCfMods.filter(m => m.slug).map(m => [ m.id, m.slug ]));

  const modWhitelist = new Set((config.mod_whitelist || []).map(Number));
  const modBlacklist = new Set((config.mod_blacklist || []).map(Number));

  // The manifest projectID and the modId returned by the files API can differ (e.g. mod transfers).
  // Build a set of fileIds that are blacklisted via manifest projectID so both paths are checked.
  const blacklistedFileIds = new Set(
    requiredEntries
      .filter(e => modBlacklist.has(e.projectID) && !modWhitelist.has(e.projectID))
      .map(e => e.fileID)
  );

  // Build a set of filenames to exclude from overrides/mods/ (blacklisted + non-mod classIds)
  const CF_MOD_CLASS_ID = 6;
  const overrideModExclude = new Set();
  for (const f of resolvedFiles) {
    if (!f.fileName) continue;
    const classId = classIdByModId.get(f.modId);
    const isNonMod = classId !== undefined && classId !== CF_MOD_CLASS_ID;
    const isBlacklisted = (modBlacklist.has(f.modId) || blacklistedFileIds.has(f.id)) && !modWhitelist.has(f.modId);
    if (isNonMod || isBlacklisted) overrideModExclude.add(f.fileName);
  }

  // Upload overrides content (strip the "overrides/" prefix so files land at server root)
  await updateProgress(i, "Preparing overrides...");
  const srcZip = new AdmZip(buffer);
  const overrideEntries = srcZip.getEntries().filter(e => {
    if (!e.entryName.startsWith("overrides/") || e.isDirectory) return false;
    if (e.entryName.startsWith("overrides/mods/")) {
      const filename = e.entryName.slice("overrides/mods/".length);
      if (overrideModExclude.has(filename)) {
        msgLog.debugExtended(`[install-modpack] skip override (blacklisted/non-mod): ${filename}`);
        return false;
      }
    }
    return true;
  });
  if (overrideEntries.length > 0) {
    const overridesZip = new AdmZip();
    for (const entry of overrideEntries) {
      const stripped = entry.entryName.slice("overrides/".length);
      overridesZip.addFile(stripped, entry.getData(), "", 0o100644 << 16);
    }
    const overridesBuf = overridesZip.toBuffer();
    const uploadUrl = await getFileUploadUrl(serverId, userId);
    if (uploadUrl) {
      const overridesFilename = "overrides.zip";
      const enc = new TextEncoder();
      const boundary = `WingsBoundary${Date.now()}`;
      const partHeader = enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${overridesFilename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
      );
      const partFooter = enc.encode(`\r\n--${boundary}--\r\n`);
      const bodyBuf = Buffer.concat([ partHeader, overridesBuf, partFooter ]);
      await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(bodyBuf.length)
        },
        body: bodyBuf
      });
      await decompressFile(serverId, userId, "/", overridesFilename);
      await chmodServerFiles(serverId, userId, "/", overrideEntries.map(e => ({
        file: e.entryName.slice("overrides/".length),
        mode: "644"
      }))).catch(() => {});
    }
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

  // Build SHA1 map across all mod files for a single combined Modrinth lookup
  const sha1ToFile = new Map();
  for (const f of modFiles) {
    const sha1 = (f.hashes || []).find(h => h.algo === 1)?.value;
    if (sha1) sha1ToFile.set(sha1, f);
  }

  await updateProgress(i, `Installing from manifest — checking ${sha1ToFile.size} mod(s) against Modrinth...`);
  const { clientOnlyHashes, fallbackUrls, foundHashes } = await analyzeModrinthFiles([ ...sha1ToFile.keys() ]);

  // Filter out client-only mods from the downloadable set
  const skippedProjectIds = new Set();
  for (const f of downloadable) {
    const sha1 = (f.hashes || []).find(h => h.algo === 1)?.value;
    if (sha1 && clientOnlyHashes.has(sha1)) {
      if (modWhitelist.has(f.modId)) {
        msgLog.debugExtended(`[install-modpack] whitelist override (client-only): ${nameByModId.get(f.modId)}`);
      } else {
        skippedProjectIds.add(f.modId);
        msgLog.debugExtended(`[install-modpack] skip (client-only): ${nameByModId.get(f.modId)}`);
      }
    }
  }
  // Slug-based fallback for mods whose CurseForge and Modrinth builds differ (different SHA1)
  const unmatchedMods = downloadable.filter(f => {
    const sha1 = (f.hashes || []).find(h => h.algo === 1)?.value;
    return !skippedProjectIds.has(f.modId) && !blacklistedFileIds.has(f.id) && (!sha1 || !foundHashes.has(sha1));
  });
  if (unmatchedMods.length > 0) {
    const slugToModId = new Map(
      unmatchedMods.filter(f => slugByModId.has(f.modId)).map(f => [ slugByModId.get(f.modId), f.modId ])
    );
    const clientOnlySlugs = await getClientOnlyBySlugs([ ...slugToModId.keys() ]);
    for (const slug of clientOnlySlugs) {
      const modId = slugToModId.get(slug);
      if (modId) {
        if (modWhitelist.has(modId)) {
          msgLog.debugExtended(`[install-modpack] whitelist override (client-only via slug): ${nameByModId.get(modId)}`);
        } else {
          skippedProjectIds.add(modId);
          msgLog.debugExtended(`[install-modpack] skip (client-only via slug): ${nameByModId.get(modId)}`);
        }
      }
    }
  }

  // Apply blacklist
  for (const modId of modBlacklist) {
    if (!skippedProjectIds.has(modId)) {
      skippedProjectIds.add(modId);
      msgLog.debugExtended(`[install-modpack] skip (blacklisted): ${nameByModId.get(modId) ?? modId}`);
    }
  }

  if (skippedProjectIds.size > 0) {
    msgLog.log(`[install-modpack] skipped ${skippedProjectIds.size} client-only/blacklisted mod(s) from manifest`);
  }

  // Recover mods with no CurseForge download URL using Modrinth fallback URLs
  const unavailable = [];
  const modrinthFallbacks = [];
  for (const f of noUrl) {
    if (modBlacklist.has(f.modId) || blacklistedFileIds.has(f.id)) {
      msgLog.debugExtended(`[install-modpack] skip (blacklisted, no CF url): ${nameByModId.get(f.modId) ?? f.modId}`);
      continue;
    }
    const sha1 = (f.hashes || []).find(h => h.algo === 1)?.value;
    const fallback = sha1 ? fallbackUrls.get(sha1) : null;
    if (fallback) {
      modrinthFallbacks.push({ downloadUrl: fallback.url, displayName: nameByModId.get(f.modId) });
      msgLog.debugExtended(`[install-modpack] Modrinth fallback: ${nameByModId.get(f.modId)}`);
    } else {
      unavailable.push(f);
      msgLog.debugExtended(`[install-modpack] no download URL: ${nameByModId.get(f.modId)} (modId: ${f.modId})`);
    }
  }
  if (modrinthFallbacks.length > 0) {
    msgLog.log(`[install-modpack] recovered ${modrinthFallbacks.length} mod(s) via Modrinth fallback`);
  }
  if (unavailable.length > 0) {
    msgLog.log(`[install-modpack] ${unavailable.length} mod(s) have no download URL on CurseForge or Modrinth`);
  }

  const mods = [
    ...downloadable.filter(f => !skippedProjectIds.has(f.modId) && !blacklistedFileIds.has(f.id)),
    ...modrinthFallbacks
  ];
  const total = mods.length;
  let installed = 0;
  let downloaded = 0;
  let downloadFailed = 0;

  // Download mods in batches, zip each batch, upload and decompress into /mods/
  for (let start = 0; start < mods.length; start += MANIFEST_MOD_BATCH) {
    const batchIdx = Math.floor(start / MANIFEST_MOD_BATCH) + 1;
    const batch = mods.slice(start, start + MANIFEST_MOD_BATCH);

    await updateProgress(i,
      `**Installing mods from manifest**\nThis may take a while...\n\n${buildManifestProgressBar(downloaded, installed, total)}`
    );

    const downloads = await Promise.all(batch.map(async mod => {
      const filename = decodeURIComponent(mod.downloadUrl.split("/").pop());
      try {
        const res = await fetch(mod.downloadUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const chunks = [];
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        return { filename, buffer: Buffer.concat(chunks) };
      } catch (e) {
        msgLog.debugExtended(`[install-modpack] mod download failed: ${filename}: ${e.message}`);
        downloadFailed++;
        return null;
      }
    }));

    const successful = downloads.filter(Boolean);
    downloaded += batch.length;
    if (successful.length === 0) continue;

    await updateProgress(i,
      `**Installing mods from manifest**\nThis may take a while...\n\n${buildManifestProgressBar(downloaded, installed, total)}`
    );

    // Bundle mods into a zip with a mods/ prefix so it extracts to /mods/
    const batchZip = new AdmZip();
    for (const { filename, buffer } of successful) {
      batchZip.addFile(`mods/${filename}`, buffer, "", 0o100644 << 16);
    }
    const zipBuf = batchZip.toBuffer();
    const zipFilename = `_mods_batch_${batchIdx}.zip`;

    const uploadUrl = await getFileUploadUrl(serverId, userId);
    if (!uploadUrl) {
      msgLog.error(`[install-modpack] no upload URL for mod batch ${batchIdx}`);
      downloadFailed += successful.length;
      continue;
    }

    const enc = new TextEncoder();
    const boundary = `WingsBoundary${Date.now()}`;
    const partHeader = enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${zipFilename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const partFooter = enc.encode(`\r\n--${boundary}--\r\n`);
    const bodyBuf = Buffer.concat([ partHeader, zipBuf, partFooter ]);
    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(bodyBuf.length)
      },
      body: bodyBuf
    });

    if (!uploadRes.ok) {
      msgLog.error(`[install-modpack] mod batch ${batchIdx} upload failed: HTTP ${uploadRes.status}`);
      downloadFailed += successful.length;
      continue;
    }

    await decompressFile(serverId, userId, "/", zipFilename);
    await chmodServerFiles(serverId, userId, "/mods/", successful.map(({ filename }) => ({
      file: filename,
      mode: "644"
    }))).catch(() => {});
    await deleteServerFiles(serverId, userId, [ zipFilename ]).catch(() => {});

    installed += successful.length;
    await updateProgress(i,
      `**Installing mods from manifest**\nThis may take a while...\n\n${buildManifestProgressBar(downloaded, installed, total)}`
    );
  }

  if (downloadFailed > 0) {
    msgLog.warn(`[install-modpack] manifest install: ${installed}/${total} mods installed, ${downloadFailed} unavailable`);
  }

  return unavailable;
}

async function runInstallation(i, state, interaction) {
  const { serverId, serverInternalId, serverName, modpackName, targetFile, loaderType, usingClientPack, mcVersion } = state;

  // a. Stop server
  await updateProgress(i, "Stopping server...");
  await setServerPowerState(serverId, interaction.user.id, "stop").catch(() => {});
  for (let attempt = 0; attempt < STOP_POLL.MAX_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, STOP_POLL.INTERVAL));
    const resourceApi = await getServerResourceInfoById(serverId, interaction.user.id);
    if (resourceApi.statusCode === HTTP_STATUS_CODES.OK) {
      const data = await resourceApi.body.json();
      if (data.attributes.current_state === "offline") break;
    }
  }

  // b. Delete files
  await updateProgress(i, "Deleting server files...");
  const files = await listServerFiles(serverId, interaction.user.id, "/");
  if (files && files.length > 0) {
    await deleteServerFiles(serverId, interaction.user.id, files.map(f => f.attributes.name));
  }

  // c. Change egg (set MC_VERSION and correct Java Docker image)
  await updateProgress(i, `Switching server type to **${loaderType ?? "unknown"}**...`);
  const eggId = config.modpack_eggs[loaderType];
  const envOverrides = {};
  if (mcVersion && config.mc_version_variable) {
    envOverrides[config.mc_version_variable] = mcVersion;
  }
  const javaImage = mcVersion ? getJavaImageForMCVersion(mcVersion) : null;
  await changeServerEgg(serverInternalId, eggId, config.minecraft_nest_id, envOverrides, javaImage);

  // d. Reinstall server
  await updateProgress(i, "Reinstalling server...");
  await reinstallServer(serverInternalId);
  // Give the daemon a moment to transition to "installing" state before polling
  await new Promise(r => setTimeout(r, 5000));
  for (let attempt = 0; attempt < STOP_POLL.MAX_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, STOP_POLL.INTERVAL));
    const resourceApi = await getServerResourceInfoById(serverId, interaction.user.id);
    if (resourceApi.statusCode === HTTP_STATUS_CODES.OK) {
      const data = await resourceApi.body.json();
      if (data.attributes.current_state !== "installing") break;
    }
  }

  // e. Download modpack file, detect manifest, then either manifest-install or direct upload+extract
  await updateProgress(i, `Downloading **${targetFile.displayName}**...`);
  let chunks, fileSize;
  try {
    ({ chunks, fileSize } = await downloadFileToBuffer(targetFile.downloadUrl, (dl, total) => {
      const pct = Math.round((dl / total) * 100);
      updateProgress(i, `Downloading **${targetFile.displayName}**... ${pct}%`).catch(() => {});
    }));
  } catch (err) {
    msgLog.error(`[install-modpack] download failed: ${err.message}`);
    await updateProgress(i, getErrorMessage("MODPACK_FILE_DOWNLOAD_FAILED"));
    return;
  }

  const buffer = Buffer.concat(chunks);
  let unavailableMods = [];

  if (isManifestZip(buffer)) {
    const manifest = parseManifestFromZip(buffer);
    if (!manifest) {
      await updateProgress(i, getErrorMessage("MODPACK_FILE_DOWNLOAD_FAILED"));
      return;
    }
    unavailableMods = await runManifestSteps(i, serverId, interaction.user.id, buffer, manifest);
  } else {
    const uploadUrl = await getFileUploadUrl(serverId, interaction.user.id);
    if (!uploadUrl) {
      await updateProgress(i, getErrorMessage("MODPACK_FILE_UPLOAD_FAILED"));
      return;
    }
    await updateProgress(i, `Uploading **${targetFile.displayName}**...`);
    try {
      await uploadBufferToServer(uploadUrl, targetFile.displayName, chunks, fileSize, (dl, ul, total) => {
        updateProgress(i, `Uploading **${targetFile.displayName}**...\n\n${buildProgressBar(dl, ul, total)}`).catch(() => {});
      });
    } catch (err) {
      msgLog.error(`[install-modpack] upload failed: ${err.message}`);
      await updateProgress(i, getErrorMessage("MODPACK_FILE_UPLOAD_FAILED"));
      return;
    }

    // f. Extract
    await updateProgress(i, "Extracting files...");
    await decompressFile(serverId, interaction.user.id, "/", targetFile.displayName);
  }

  // g. Done
  let doneContent = `**Installation Complete**\n\n**${modpackName}** has been installed on **${serverName}**.`;
  msgLog.log(`${interaction.user.username}/${interaction.user.id} | [install-modpack] install success: ${modpackName} | ${serverId} `);

  if (usingClientPack) {
    doneContent += "\n\n**Reminder:** A client modpack/manifest install was used. You may be required to manually add/remove certain client-sided mods to fix crashing/client-server compatibility issues.";
  }

  if (unavailableMods.length > 0) {
    const MAX_SHOWN = 10;
    const shown = unavailableMods.slice(0, MAX_SHOWN);
    const overflow = unavailableMods.length - shown.length;
    const lines = shown.map(f => {
      const name = f.displayName ?? f.fileName ?? `Mod ${f.modId}`;
      return `- [${name}](https://www.curseforge.com/projects/${f.modId})`;
    });
    if (overflow > 0) lines.push(`- *...and ${overflow} more (see logs)*`);
    doneContent += `\n\n**Warning: ${unavailableMods.length} mod(s) could not be downloaded** (CurseForge API distribution disabled — install manually):\n${lines.join("\n")}`;
  }

  const doneContainer = new ContainerBuilder()
    .setAccentColor(COLORS.SUCCESS)
    .addTextDisplayComponents(text => text.setContent(doneContent));
  await i.editReply({ components: [ doneContainer ], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
}

module.exports = {
  runInstallation,

  data: new SlashCommandBuilder()
    .setName("install-modpack")
    .setDescription("Install a CurseForge modpack onto one of your Minecraft servers."),

  async execute(interaction) {
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);

    const hasReadServers = authenticateUserForPermission(interaction.user.id, PERMISSIONS.READ_SERVERS);
    if (hasReadServers === -1) {
      await interaction.reply(getErrorMessage("USER_NOT_FOUND"));
      return;
    }
    if (!hasReadServers) {
      await interaction.reply(getErrorMessage("INSUFFICIENT_PERMISSIONS"));
      return;
    }
    if (!userHasClientApiKey(interaction.user.id)) {
      await interaction.reply(getErrorMessage("API_KEY_NOT_SET"));
      return;
    }

    try {
      const serverObjects = await getClientServers(interaction.user.id);
      if (!serverObjects || !serverObjects.data) {
        await interaction.reply(getErrorMessage("CLIENT_API_FAILURE"));
        return;
      }

      // Build nestMap: identifier → nestId (used for Minecraft detection)
      const nestMap = {};
      const panelId = getUserId(interaction.user.id);
      if (panelId > 0) {
        try {
          const userApi = await applicationApiCall(`application/users/${panelId}?include=servers`, "GET");
          if (userApi.statusCode === HTTP_STATUS_CODES.OK) {
            const userData = await userApi.body.json();
            for (const server of userData.attributes.relationships.servers.data) {
              nestMap[server.attributes.identifier] = server.attributes.nest;
            }
          }
        } catch (e) {
          msgLog.warn(`[install-modpack] could not fetch nest map: ${e.message}`);
        }
      }

      const initialContainer = buildServerSelectContainer(serverObjects.data, nestMap);
      await interaction.reply({ components: [ initialContainer ], flags: MessageFlags.IsComponentsV2 });

      const response = await interaction.fetchReply();
      const collector = response.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id,
        idle: COLLECTOR_IDLE_TIMEOUT
      });

      let selectedServerId = null;
      let selectedServerInternalId = null;
      let selectedServerName = null;
      let modpackName = null;
      let targetFile = null;
      let loaderType = null;
      let usingClientPack = false;
      let mcVersion = null;
      let modpackData = null;
      let fileOptions = null;
      let selectedFileId = null;

      collector.on("collect", async i => {
        try {
          if (i.customId === "server-select") {
            const chosen = i.values[0];
            if (chosen === "none") {
              await i.update({ components: [ buildServerSelectContainer(serverObjects.data, nestMap) ], flags: MessageFlags.IsComponentsV2 });
              return;
            }

            const isMinecraft = nestMap[chosen] === config.minecraft_nest_id;
            if (!isMinecraft) {
              await i.update({
                components: [ buildServerSelectContainer(serverObjects.data, nestMap, "Please select a Minecraft server.") ],
                flags: MessageFlags.IsComponentsV2
              });
              return;
            }

            const server = serverObjects.data.find(s => s.attributes.identifier === chosen);
            selectedServerId = chosen;
            selectedServerInternalId = server?.attributes?.internal_id;
            selectedServerName = server?.attributes?.name;

            const selectedContainer = buildServerSelectContainer(serverObjects.data, nestMap)
              .addSeparatorComponents(sep => sep)
              .addTextDisplayComponents(text =>
                text.setContent(`**Selected:** ${selectedServerName} (\`${selectedServerId}\`)`)
              )
              .addActionRowComponents(row => row.setComponents(
                new ButtonBuilder().setCustomId("proceed-to-url").setLabel("Enter Modpack ID").setStyle(ButtonStyle.Primary)
              ));

            await i.update({ components: [ selectedContainer ], flags: MessageFlags.IsComponentsV2 });

          } else if (i.customId === "proceed-to-url") {
            const urlModal = new ModalBuilder()
              .setCustomId("modpack-url-modal")
              .setTitle("Install Modpack");

            const urlInput = new TextInputBuilder()
              .setCustomId("modpack-url-input")
              .setLabel("CurseForge Project ID")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("e.g. 905765  (from the About Project section on CurseForge)")
              .setRequired(true)
              .setMaxLength(20);

            urlModal.addComponents(new ActionRowBuilder().addComponents(urlInput));
            await i.showModal(urlModal);

            try {
              const modalSubmit = await i.awaitModalSubmit({
                filter: m => m.customId === "modpack-url-modal" && m.user.id === interaction.user.id,
                time: 300_000
              });
              await modalSubmit.deferUpdate();

              const rawInput = modalSubmit.fields.getTextInputValue("modpack-url-input").trim();
              const projectId = parseProjectId(rawInput);

              if (!projectId) {
                const errorContainer = new ContainerBuilder()
                  .setAccentColor(COLORS.PRIMARY)
                  .addTextDisplayComponents(text => text.setContent(
                    `**Install Modpack**\n\n${getErrorMessage("INVALID_INPUT")}\n\nEnter a numeric CurseForge Project ID.\nFind it in the **About Project** section on the modpack's CurseForge page.`
                  ))
                  .addSeparatorComponents(sep => sep)
                  .addActionRowComponents(row => row.setComponents(
                    new ButtonBuilder().setCustomId("proceed-to-url").setLabel("Try Again").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                  ));
                await modalSubmit.editReply({ components: [ errorContainer ], flags: MessageFlags.IsComponentsV2 });
                return;
              }

              const loadingContainer = new ContainerBuilder()
                .setAccentColor(COLORS.PRIMARY)
                .addTextDisplayComponents(text => text.setContent("**Install Modpack**\n\nLooking up modpack..."));
              await modalSubmit.editReply({ components: [ loadingContainer ], flags: MessageFlags.IsComponentsV2 });

              let modpack;
              try {
                modpack = await getModpackById(projectId);
              } catch {
                const errContainer = new ContainerBuilder()
                  .setAccentColor(COLORS.PRIMARY)
                  .addTextDisplayComponents(text => text.setContent(`**Install Modpack**\n\n${getErrorMessage("CURSEFORGE_API_ERROR")}`))
                  .addSeparatorComponents(sep => sep)
                  .addActionRowComponents(row => row.setComponents(
                    new ButtonBuilder().setCustomId("cancel").setLabel("Close").setStyle(ButtonStyle.Secondary)
                  ));
                await modalSubmit.editReply({ components: [ errContainer ], flags: MessageFlags.IsComponentsV2 });
                return;
              }

              if (!modpack) {
                const notFoundContainer = new ContainerBuilder()
                  .setAccentColor(COLORS.PRIMARY)
                  .addTextDisplayComponents(text => text.setContent(`**Install Modpack**\n\n${getErrorMessage("CURSEFORGE_MODPACK_NOT_FOUND")}`))
                  .addSeparatorComponents(sep => sep)
                  .addActionRowComponents(row => row.setComponents(
                    new ButtonBuilder().setCustomId("proceed-to-url").setLabel("Try Again").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                  ));
                await modalSubmit.editReply({ components: [ notFoundContainer ], flags: MessageFlags.IsComponentsV2 });
                return;
              }

              modpackName = modpack.name;
              modpackData = modpack;
              loaderType = detectLoaderType(modpack.latestFilesIndexes);

              let files = null;
              try {
                files = await getModpackFiles(modpack.id);
              } catch (e) {
                msgLog.warn(`[install-modpack] getModpackFiles failed: ${e.message}`);
              }

              // Client files sorted by date, latest first (server packs aren't in the main list)
              const sortedClientFiles = (files || [])
                .filter(f => !f.isServerPack && f.downloadUrl)
                .sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate))
                .slice(0, 10);

              if (sortedClientFiles.length === 0) {
                const noFileContainer = new ContainerBuilder()
                  .setAccentColor(COLORS.PRIMARY)
                  .addTextDisplayComponents(text => text.setContent(
                    `**Install Modpack**\n\n${getErrorMessage("MODPACK_FILE_DOWNLOAD_FAILED")}\n\nNo downloadable files were found for this modpack.`
                  ))
                  .addSeparatorComponents(sep => sep)
                  .addActionRowComponents(row => row.setComponents(
                    new ButtonBuilder().setCustomId("cancel").setLabel("Close").setStyle(ButtonStyle.Secondary)
                  ));
                await modalSubmit.editReply({ components: [ noFileContainer ], flags: MessageFlags.IsComponentsV2 });
                return;
              }

              // Fetch linked server packs in parallel
              const serverPacks = await Promise.all(
                sortedClientFiles.map(f => f.serverPackFileId
                  ? getFileById(f.modId, f.serverPackFileId).catch(() => null)
                  : null
                )
              );

              // Interleave: server pack (if available) then client file, per version
              fileOptions = [];
              for (let idx = 0; idx < sortedClientFiles.length; idx++) {
                const sp = serverPacks[idx];
                if (sp?.downloadUrl) fileOptions.push(sp);
                fileOptions.push(sortedClientFiles[idx]);
              }

              const autoFile = fileOptions[0];
              selectedFileId = autoFile.id;

              await modalSubmit.editReply({
                components: [ buildFileSelectContainer(modpackName, fileOptions, autoFile.id) ],
                flags: MessageFlags.IsComponentsV2
              });

            } catch (modalErr) {
              msgLog.debugExtended(`[install-modpack] modal dismissed: ${modalErr.message}`);
            }

          } else if (i.customId === "file-select") {
            // Just update the displayed selection; Continue button drives the actual proceed
            selectedFileId = parseInt(i.values[0], 10);
            await i.update({
              components: [ buildFileSelectContainer(modpackName, fileOptions, selectedFileId) ],
              flags: MessageFlags.IsComponentsV2
            });

          } else if (i.customId === "file-select-confirm") {
            await i.deferUpdate();
            const chosenFile = fileOptions?.find(f => f.id === selectedFileId);
            if (!chosenFile) return;

            targetFile = { id: chosenFile.id, displayName: chosenFile.displayName, downloadUrl: chosenFile.downloadUrl };
            mcVersion = detectMCVersion(modpackData, chosenFile);
            usingClientPack = !chosenFile.isServerPack;

            if (!targetFile?.downloadUrl) {
              const noFileContainer = new ContainerBuilder()
                .setAccentColor(COLORS.PRIMARY)
                .addTextDisplayComponents(text => text.setContent(
                  `**Install Modpack**\n\n${getErrorMessage("MODPACK_FILE_DOWNLOAD_FAILED")}\n\nNo download is available for this file.`
                ))
                .addSeparatorComponents(sep => sep)
                .addActionRowComponents(row => row.setComponents(
                  new ButtonBuilder().setCustomId("cancel").setLabel("Close").setStyle(ButtonStyle.Secondary)
                ));
              await i.editReply({ components: [ noFileContainer ], flags: MessageFlags.IsComponentsV2 });
              return;
            }

            if (usingClientPack) {
              const noPackContainer = new ContainerBuilder()
                .setAccentColor(COLORS.PRIMARY)
                .addTextDisplayComponents(text => text.setContent(
                  `**Install Modpack**\n**${modpackName}**.\n\n` +
                  "**WARNING:** Client modpack selected.\n" +
                  "It is recommended that you use a dedicated server pack. The modpack may not install correctly."
                ))
                .addSeparatorComponents(sep => sep)
                .addActionRowComponents(row => row.setComponents(
                  new ButtonBuilder().setCustomId("no-pack-continue").setLabel("Yes, Continue").setStyle(ButtonStyle.Danger),
                  new ButtonBuilder().setCustomId("cancel").setLabel("No, Cancel").setStyle(ButtonStyle.Secondary)
                ));
              await i.editReply({ components: [ noPackContainer ], flags: MessageFlags.IsComponentsV2 });
              return;
            }

            if (!config.modpack_eggs?.[loaderType]) {
              const eggErrContainer = new ContainerBuilder()
                .setAccentColor(COLORS.PRIMARY)
                .addTextDisplayComponents(text => text.setContent(`**Install Modpack**\n\n${getErrorMessage("MODPACK_EGG_NOT_CONFIGURED", loaderType)}`))
                .addSeparatorComponents(sep => sep)
                .addActionRowComponents(row => row.setComponents(
                  new ButtonBuilder().setCustomId("cancel").setLabel("Close").setStyle(ButtonStyle.Secondary)
                ));
              await i.editReply({ components: [ eggErrContainer ], flags: MessageFlags.IsComponentsV2 });
              return;
            }

            await i.editReply({
              components: [ buildConfirmView1(selectedServerName, modpackName, targetFile.displayName, loaderType) ],
              flags: MessageFlags.IsComponentsV2
            });

          } else if (i.customId === "no-pack-continue") {
            await i.deferUpdate();
            usingClientPack = true;

            if (!config.modpack_eggs?.[loaderType]) {
              const eggErrContainer = new ContainerBuilder()
                .setAccentColor(COLORS.PRIMARY)
                .addTextDisplayComponents(text => text.setContent(`**Install Modpack**\n\n${getErrorMessage("MODPACK_EGG_NOT_CONFIGURED", loaderType)}`))
                .addSeparatorComponents(sep => sep)
                .addActionRowComponents(row => row.setComponents(
                  new ButtonBuilder().setCustomId("cancel").setLabel("Close").setStyle(ButtonStyle.Secondary)
                ));
              await i.editReply({ components: [ eggErrContainer ], flags: MessageFlags.IsComponentsV2 });
              return;
            }

            await i.editReply({
              components: [ buildConfirmView1(selectedServerName, modpackName, targetFile.displayName, loaderType) ],
              flags: MessageFlags.IsComponentsV2
            });

          } else if (i.customId === "confirm-1") {
            await i.deferUpdate();
            await i.editReply({
              components: [ buildConfirmView2(selectedServerName, modpackName) ],
              flags: MessageFlags.IsComponentsV2
            });

          } else if (i.customId === "confirm-2") {
            await i.deferUpdate();
            collector.stop("installing");

            const installState = {
              serverId: selectedServerId,
              serverInternalId: selectedServerInternalId,
              serverName: selectedServerName,
              modpackName,
              targetFile,
              loaderType,
              usingClientPack,
              mcVersion
            };
            msgLog.log(`${interaction.user.username}/${interaction.user.id} | [install-modpack] installing: ${modpackName} | ${selectedServerId}`);
            await runInstallation(i, installState, interaction);

          } else if (i.customId === "cancel") {
            await i.deferUpdate();
            collector.stop("cancelled");

            const cancelContainer = new ContainerBuilder()
              .setAccentColor(COLORS.DISABLED)
              .addTextDisplayComponents(text => text.setContent("**Install Modpack**\n\nInstallation cancelled."));
            await i.editReply({ components: [ cancelContainer ], flags: MessageFlags.IsComponentsV2 });
          }
        } catch (err) {
          msgLog.error(`[install-modpack] collector error: ${err.message}`);
          const errResp = { content: "An error occurred while processing your request.", ephemeral: true };
          if (i.replied || i.deferred) {
            await i.followUp(errResp).catch(() => {});
          } else {
            await i.reply(errResp).catch(() => {});
          }
        }
      });

      collector.on("end", async (collected, reason) => {
        if (reason === "idle") {
          const disabledContainer = buildServerSelectContainer(
            serverObjects.data, nestMap, getErrorMessage("USER_TIMEOUT"), true
          );
          await interaction.editReply({ components: [ disabledContainer ], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
        }
      });

    } catch (err) {
      msgLog.error(`[install-modpack] execute error: ${err.message}`);
      const errMsg = { content: "An error occurred while loading the install modpack menu.", ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errMsg).catch(() => {});
      } else {
        await interaction.reply(errMsg).catch(() => {});
      }
    }
  }
};
