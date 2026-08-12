"use strict";

/**
 * Modpack install stage machine. Takes a reporter — never Discord types — so
 * the same path runs under Discord, Jest, and the smoke script.
 *
 * Stages:
 *   resolve -> download -> unwrap -> plan | STOP | wipe -> egg -> reinstall
 *           -> place -> preconditions -> boot-verify -> report
 *
 * Invariant: nothing destructive happens before stop.
 */

const AdmZip = require("adm-zip");
const msgLog = require("../logger.js");
const { getErrorMessage } = require("../error_messages.js");
const { isManifestZip, findClientFileForServerPack, defaultLoaderForLegacyMc } = require("../curseforge.js");
const { downloadToBuffer } = require("../modpack_http.js");
const { installFilePlan, installArchiveBuffer, detectNestedArchiveRoot } = require("../modpack_install.js");
const { verifyServerBoot } = require("../boot_verify.js");
const { resolveModpackInstall } = require("../modpack_providers.js");
const { detectLoaderVersionFromBuffer, buildLoaderEggEnv } = require("../loader_version.js");
const { getJavaImageForMCVersion } = require("../minecraft_java.js");
const { HTTP_STATUS_CODES } = require("../constants.js");
const {
  setServerPowerState, getServerResourceInfoById,
  changeServerEgg, reinstallServer, getServerInstallStatus,
  listServerFiles, deleteServerFiles, writeServerFile,
  pullServerFile, decompressFile
} = require("../server_functions.js");
const { createModIndex } = require("../crash_attribution.js");

const config = require("../../config.json");

const STOP_POLL = { MAX_ATTEMPTS: 60, INTERVAL: 2000 };
// Reinstall runs the egg's install script (download server jar, run loader installer);
// allow up to ~10 minutes before giving up rather than uploading into an unfinished server.
const INSTALL_POLL = { MAX_ATTEMPTS: 300, INTERVAL: 2000 };

function isServerStarterZip(buffer) {
  try {
    const zip = new AdmZip(buffer);
    return zip.getEntry("server-setup-config.yaml") !== null;
  } catch {
    return false;
  }
}

function parseServerStarterConfig(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntry("server-setup-config.yaml");
    if (!entry) return null;
    const text = zip.readAsText(entry);
    const lines = text.split(/\r?\n/);

    let modpackUrl = null;
    const ignoreProject = [];
    let inIgnoreProject = false;
    let ignoreProjectIndent = -1;

    for (const line of lines) {
      const trimmed = line.trim();

      const urlMatch = trimmed.match(/^modpackUrl:\s*(\S+)$/);
      if (urlMatch) {
        modpackUrl = urlMatch[1];
        continue;
      }

      const ignoreProjMatch = line.match(/^(\s*)ignoreProject:\s*$/);
      if (ignoreProjMatch) {
        inIgnoreProject = true;
        ignoreProjectIndent = ignoreProjMatch[1].length;
        continue;
      }

      if (inIgnoreProject) {
        const itemMatch = line.match(/^(\s*)-\s+(\d+)/);
        if (itemMatch && itemMatch[1].length > ignoreProjectIndent) {
          ignoreProject.push(parseInt(itemMatch[2], 10));
        } else if (trimmed && !trimmed.startsWith("#")) {
          inIgnoreProject = false;
        }
      }
    }

    return { modpackUrl, ignoreProject };
  } catch {
    return null;
  }
}

/**
 * @param {object} state
 * @param {string} state.source
 * @param {string} state.serverId
 * @param {number} state.serverInternalId
 * @param {string} state.serverName
 * @param {string} state.modpackName
 * @param {object} state.targetFile
 * @param {string|null} state.loaderType
 * @param {boolean} state.usingClientPack
 * @param {string|null} [state.mcVersion]
 * @param {number|null} [state.modpackId]
 * @param {string} state.userId
 * @param {string} [state.username]
 * @param {object} reporter  DiscordReporter | CollectingReporter
 */
async function runModpackJob(state, reporter) {
  const {
    source, serverId, serverInternalId, serverName, modpackName, targetFile,
    loaderType, usingClientPack, mcVersion, modpackId = null,
    userId, username = "unknown"
  } = state;

  const progress = (msg, meta) => reporter.progress(msg, meta);

  // a. Download the modpack file first — a failed download must leave the server untouched.
  await progress(`Downloading **${targetFile.displayName}**...`, { stage: "download" });
  let chunks;
  try {
    ({ chunks } = await downloadToBuffer(targetFile.downloadUrl, (dl, total) => {
      const pct = Math.round((dl / total) * 100);
      progress(`Downloading **${targetFile.displayName}**... ${pct}%`, { stage: "download", pct }).catch(() => {});
    }));
  } catch (err) {
    msgLog.error(`[install-modpack] download failed: ${err.message}`);
    await progress(getErrorMessage("MODPACK_FILE_DOWNLOAD_FAILED"), { stage: "download" });
    return { ok: false, stage: "download", error: err.message };
  }

  let buffer = Buffer.concat(chunks);
  // CDN URL used for the Wings pull fast path (may change after ServerStarter unwrap).
  let archivePullUrl = targetFile.downloadUrl;

  // b. CurseForge ServerStarter wrapper: fetch the real pack, still before any destructive step.
  if (source !== "modrinth" && isServerStarterZip(buffer)) {
    const ssConfig = parseServerStarterConfig(buffer);
    if (!ssConfig?.modpackUrl) {
      await progress(getErrorMessage("MODPACK_FILE_DOWNLOAD_FAILED"), { stage: "serverstarter" });
      return { ok: false, stage: "serverstarter", error: "missing modpackUrl" };
    }
    await progress("Downloading modpack from ServerStarter URL...", { stage: "unwrap" });
    try {
      ({ chunks } = await downloadToBuffer(ssConfig.modpackUrl, (dl, total) => {
        const pct = Math.round((dl / total) * 100);
        progress(`Downloading modpack from ServerStarter URL... ${pct}%`, { stage: "unwrap", pct }).catch(() => {});
      }));
    } catch (err) {
      msgLog.error(`[install-modpack] ServerStarter modpackUrl download failed: ${err.message}`);
      await progress(getErrorMessage("MODPACK_FILE_DOWNLOAD_FAILED"), { stage: "serverstarter-download" });
      return { ok: false, stage: "serverstarter-download", error: err.message };
    }
    buffer = Buffer.concat(chunks);
    archivePullUrl = ssConfig.modpackUrl;
  }

  // c. Resolve manifest installs up front so resolution failures abort while the
  // server still has its files. Modrinth packs are always .mrpack manifests.
  // Older CurseForge packs often omit loader tags — recover from the zip
  // manifest / legacy MC version before we pick an egg.
  let effectiveLoaderType = loaderType;
  if (!effectiveLoaderType) {
    const fromZip = detectLoaderVersionFromBuffer(buffer);
    if (fromZip?.loaderType) effectiveLoaderType = fromZip.loaderType;
  }
  if (!effectiveLoaderType) {
    effectiveLoaderType = defaultLoaderForLegacyMc(mcVersion);
  }
  if (!effectiveLoaderType || !config.modpack_eggs?.[effectiveLoaderType]) {
    await progress(getErrorMessage("MODPACK_EGG_NOT_CONFIGURED", effectiveLoaderType), { stage: "loader" });
    return { ok: false, stage: "loader", error: `No egg configured for loader ${effectiveLoaderType}` };
  }
  if (effectiveLoaderType !== loaderType) {
    msgLog.log(`[install-modpack] resolved loader ${loaderType} → ${effectiveLoaderType}`);
  }

  let installPlan = null;
  let usedManifest = false;
  if (source === "modrinth" || isManifestZip(buffer)) {
    usedManifest = true;
    const resolution = await resolveModpackInstall(
      source === "modrinth" ? "modrinth" : "curseforge",
      buffer, effectiveLoaderType, msg => progress(msg, { stage: "plan" })
    );
    if (!resolution || resolution.kind !== "plan") {
      await progress(getErrorMessage("MODPACK_FILE_DOWNLOAD_FAILED"), { stage: "resolve-plan" });
      return { ok: false, stage: "resolve-plan", error: "manifest resolution failed" };
    }
    installPlan = resolution.plan;
  }

  // d. Stop server — abort if it never reaches offline rather than wiping a running server.
  await progress("Stopping server...", { stage: "stop" });
  await setServerPowerState(serverId, userId, "stop").catch(() => {});
  let serverStopped = false;
  for (let attempt = 0; attempt < STOP_POLL.MAX_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, STOP_POLL.INTERVAL));
    const resourceApi = await getServerResourceInfoById(serverId, userId);
    if (resourceApi.statusCode === HTTP_STATUS_CODES.OK) {
      const data = await resourceApi.body.json();
      if (data.attributes.current_state === "offline") {
        serverStopped = true;
        break;
      }
    }
  }
  if (!serverStopped) {
    msgLog.error(`[install-modpack] server ${serverId} did not stop in time; install aborted`);
    await progress(getErrorMessage("MODPACK_SERVER_STOP_TIMEOUT"), { stage: "stop" });
    return { ok: false, stage: "stop", error: "server stop timeout" };
  }

  // e. Delete files
  await progress("Deleting server files...", { stage: "wipe" });
  const files = await listServerFiles(serverId, userId, "/");
  if (files && files.length > 0) {
    await deleteServerFiles(serverId, userId, files.map(f => f.attributes.name));
  }

  // f. Change egg (set MC_VERSION, pin loader build from the pack when known,
  //    otherwise prefer Forge "latest" over stale "recommended")
  await progress(`Switching server type to **${effectiveLoaderType ?? "unknown"}**...`, { stage: "egg" });
  const eggId = config.modpack_eggs[effectiveLoaderType];
  const envOverrides = {};
  if (mcVersion && config.mc_version_variable) {
    envOverrides[config.mc_version_variable] = mcVersion;
  }

  let loaderSpec = detectLoaderVersionFromBuffer(buffer);
  // Server packs rarely ship manifest.json — pull the linked client pack just
  // far enough to read the pinned Forge/NeoForge build.
  if (!loaderSpec && source === "curseforge" && !usingClientPack && modpackId && targetFile?.id) {
    try {
      const clientFile = await findClientFileForServerPack(modpackId, targetFile.id);
      if (clientFile?.downloadUrl) {
        await progress("Reading loader version from client pack manifest...", { stage: "egg" });
        const { chunks: clientChunks } = await downloadToBuffer(clientFile.downloadUrl, () => {});
        loaderSpec = detectLoaderVersionFromBuffer(Buffer.concat(clientChunks));
      }
    } catch (err) {
      msgLog.warn(`[install-modpack] could not read client-pack loader version: ${err.message}`);
    }
  }

  const loaderEnv = buildLoaderEggEnv({
    loaderType: effectiveLoaderType, mcVersion, loaderSpec, config
  });
  Object.assign(envOverrides, loaderEnv.envOverrides);
  if (loaderEnv.source === "pack") {
    msgLog.log(`[install-modpack] pinning ${effectiveLoaderType} to ${loaderEnv.resolvedVersion} (from pack)`);
  } else if (loaderEnv.source === "latest-fallback") {
    msgLog.log("[install-modpack] no pack loader pin; using Forge BUILD_TYPE=latest");
  }

  const javaImage = mcVersion ? getJavaImageForMCVersion(mcVersion, config) : null;
  const eggChangeStatus = await changeServerEgg(serverInternalId, eggId, config.minecraft_nest_id, envOverrides, javaImage);
  if (eggChangeStatus < 200 || eggChangeStatus >= 300) {
    msgLog.error(`[install-modpack] egg change failed for ${serverId} (status ${eggChangeStatus})`);
    await progress(getErrorMessage("MODPACK_EGG_CHANGE_FAILED"), { stage: "egg-change" });
    return { ok: false, stage: "egg-change", error: `HTTP ${eggChangeStatus}` };
  }

  // g. Reinstall server, then wait until the panel confirms the install actually
  // finished before placing any files. We poll the application-API server status
  // (getServerInstallStatus): the panel sets it to "installing" synchronously when
  // the reinstall is accepted and only clears it once the daemon reports completion.
  // The client resources current_state is unreliable here — it can read "offline"
  // in the gap before the daemon picks up the install, which previously let us
  // upload into a server that was about to be wiped again by the install.
  await progress("Reinstalling server...", { stage: "reinstall" });
  const reinstallStatus = await reinstallServer(serverInternalId);
  if (reinstallStatus < 200 || reinstallStatus >= 300) {
    msgLog.error(`[install-modpack] reinstall failed for ${serverId} (status ${reinstallStatus})`);
    await progress(getErrorMessage("MODPACK_REINSTALL_FAILED"), { stage: "reinstall" });
    return { ok: false, stage: "reinstall", error: `HTTP ${reinstallStatus}` };
  }
  let reinstallFinished = false;
  for (let attempt = 0; attempt < INSTALL_POLL.MAX_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, INSTALL_POLL.INTERVAL));
    const installState = await getServerInstallStatus(serverInternalId);
    if (installState === "installing" || installState === -1) continue; // still running, or transient API hiccup
    if (installState === "install_failed" || installState === "reinstall_failed") {
      msgLog.error(`[install-modpack] reinstall reported "${installState}" for ${serverId}`);
      await progress(getErrorMessage("MODPACK_REINSTALL_FAILED"), { stage: "reinstall" });
      return { ok: false, stage: "reinstall", error: installState };
    }
    reinstallFinished = true; // null / idle — install complete
    break;
  }
  if (!reinstallFinished) {
    msgLog.error(`[install-modpack] reinstall did not finish in time for ${serverId}`);
    await progress(getErrorMessage("MODPACK_REINSTALL_TIMEOUT"), { stage: "reinstall" });
    return { ok: false, stage: "reinstall", error: "timeout" };
  }

  // h. Place files: manifest plan install or direct upload+extract
  let unavailableMods;
  let crashRiskWarnings;
  let manifestInstalled;
  let manifestTotal;
  let modIndex;

  const effectiveMcVersion = mcVersion ?? installPlan?.mcVersion ?? null;
  const installCtx = {
    i: null,
    serverId,
    userId,
    loaderType: effectiveLoaderType,
    mcVersion: effectiveMcVersion,
    updateProgress: (i, msg) => reporter.updateProgress(i, msg)
  };

  if (usedManifest) {
    ({ unavailable: unavailableMods, installed: manifestInstalled, total: manifestTotal, crashRiskWarnings = [], modIndex = null } =
      await installFilePlan(installCtx, installPlan));
  } else {
    // Fast path: Wings pulls the archive from the CDN and decompresses in place.
    // Bytes never round-trip through the bot. Falls back to local extract + chunked
    // upload on any non-2xx (SUMMARY.md notes decompress 500s on some packs).
    //
    // Wings extracts as-is, so a pack wrapped in a single top-level folder — the
    // common CF server-pack layout — would land at /PackName/mods/ with nothing
    // at /mods. installArchiveBuffer flattens that; the pull cannot. Skip the fast
    // path when the buffer we already hold shows a nested root.
    const nestedRoot = detectNestedArchiveRoot(buffer);
    let placedViaPull = false;
    if (archivePullUrl && !usingClientPack && !nestedRoot) {
      await progress("Pulling server pack onto the panel (fast path)...", { stage: "place" });
      const pullName = `_modpack_pull_${Date.now()}.zip`;
      try {
        const pullStatus = await pullServerFile(serverId, userId, archivePullUrl, "/", pullName, { foreground: true });
        if (pullStatus >= 200 && pullStatus < 300) {
          const decStatus = await decompressFile(serverId, userId, "/", pullName);
          await deleteServerFiles(serverId, userId, [ pullName ]).catch(() => {});
          if (decStatus >= 200 && decStatus < 300) {
            const pulledIndex = createModIndex();
            // Sparse index: filenames only — enough for jar-name attribution.
            let jarCount = 0;
            try {
              const modEntries = await listServerFiles(serverId, userId, "/mods");
              for (const f of modEntries || []) {
                const name = f.attributes?.name;
                if (name && /\.jar$/i.test(name)) {
                  pulledIndex.byFileName.set(name.toLowerCase(), name);
                }
              }
              jarCount = pulledIndex.byFileName.size;
            } catch {
              jarCount = 0;
            }

            // Every call returned 2xx yet /mods is empty: the archive's layout
            // defeated an as-is extract (a nested root detectNestedArchiveRoot
            // doesn't recognise, for instance). That is a fallback trigger, not
            // a result — a "success" with no mods is the worst outcome here.
            if (jarCount === 0) {
              msgLog.warn(
                "[install-modpack] Wings pull decompressed but /mods is empty; falling back to local extract"
              );
            } else {
              placedViaPull = true;
              unavailableMods = [];
              crashRiskWarnings = [];
              modIndex = pulledIndex;
              manifestInstalled = jarCount;
              manifestTotal = jarCount;
              // Strip server-icon — forces AWT on headless yolks.
              try {
                const rootFiles = await listServerFiles(serverId, userId, "/");
                const icons = (rootFiles || [])
                  .map(f => f.attributes?.name)
                  .filter(n => n && /^server-icon\.(png|jpe?g)$/i.test(n));
                if (icons.length) await deleteServerFiles(serverId, userId, icons).catch(() => {});
              } catch { /* ignore */ }
              msgLog.log(
                `[install-modpack] Wings pull path ok: ${manifestInstalled} jar(s) under mods/`
              );
            }
          } else {
            msgLog.warn(`[install-modpack] Wings decompress after pull returned ${decStatus}; falling back`);
          }
        } else {
          msgLog.warn(`[install-modpack] Wings pull returned ${pullStatus}; falling back to local extract`);
        }
      } catch (err) {
        msgLog.warn(`[install-modpack] Wings pull failed (${err.message}); falling back to local extract`);
      }
    }

    if (!placedViaPull) {
      // Non-manifest archives (CF server packs, loose zips): extract locally,
      // strip client-only mods, upload in chunks — same Wings path as manifests.
      await progress("Extracting archive locally and uploading in chunks...", { stage: "place" });
      const archiveResult = await installArchiveBuffer(installCtx, buffer);
      if (archiveResult.error && (archiveResult.filesUploaded || 0) === 0) {
        msgLog.error(`[install-modpack] archive install failed for ${serverId}: ${archiveResult.error}`);
        await progress(getErrorMessage("MODPACK_FILE_UPLOAD_FAILED"), { stage: "archive-install" });
        return { ok: false, stage: "archive-install", error: archiveResult.error };
      }
      if ((archiveResult.uploadFailed || 0) > 0 && (archiveResult.filesUploaded || 0) === 0) {
        msgLog.error(`[install-modpack] archive chunked upload failed for ${serverId}`);
        await progress(getErrorMessage("MODPACK_FILE_UPLOAD_FAILED"), { stage: "upload" });
        return { ok: false, stage: "upload", error: "chunked upload failed" };
      }
      unavailableMods = archiveResult.unavailable || [];
      crashRiskWarnings = archiveResult.crashRiskWarnings || [];
      modIndex = archiveResult.modIndex || null;
      manifestInstalled = archiveResult.installed || 0;
      manifestTotal = archiveResult.total || 0;
      msgLog.log(
        `[install-modpack] archive path: ${manifestInstalled}/${manifestTotal} mods kept` +
        (archiveResult.skippedClient ? ` (${archiveResult.skippedClient} client-only skipped)` : "")
      );
    }
  }

  // i. Done — but bail out as a failure if a manifest install couldn't place a single mod.
  if (usedManifest && manifestTotal > 0 && manifestInstalled === 0) {
    msgLog.error(`${username}/${userId} | [install-modpack] install failed: 0/${manifestTotal} mods installed: ${modpackName} | ${serverId}`);
    await progress(getErrorMessage("MODPACK_FILE_UPLOAD_FAILED"), { stage: "place-mods" });
    return { ok: false, stage: "place-mods", error: `0/${manifestTotal} mods installed` };
  }

  // i1. Accept the Minecraft EULA so boot-verify (and first user start) can
  // actually reach "Done". Reinstall leaves eula=false / missing eula.txt.
  try {
    const eulaStatus = await writeServerFile(
      serverId, userId, "/eula.txt", "eula=true\n"
    );
    if (eulaStatus < 200 || eulaStatus >= 300) {
      msgLog.warn(`[install-modpack] eula.txt write returned HTTP ${eulaStatus} for ${serverId}`);
    }
  } catch (err) {
    msgLog.warn(`[install-modpack] eula.txt write failed for ${serverId}: ${err.message}`);
  }

  // i2. Boot verification (Layer 3): start the server and empirically confirm
  // it boots, quarantining crash-attributed mods and retrying. Progress updates
  // are best-effort — the loop can outlive the 15-min interaction token — so
  // the final outcome always goes to the logs as well.
  let bootResult = null;
  if (config.boot_verify?.enabled) {
    await progress("Verifying server boot (this can take several minutes)...", { stage: "boot-verify" });
    try {
      bootResult = await verifyServerBoot({
        serverId,
        userId,
        modIndex,
        settings: config.boot_verify,
        onProgress: msg => progress(msg, { stage: "boot-verify" }).catch(() => {})
      });
    } catch (err) {
      msgLog.error(`[install-modpack] boot verification errored for ${serverId}: ${err.message}`);
    }
    if (bootResult) {
      msgLog.log(
        `${username}/${userId} | [install-modpack] boot verify: ` +
        `${bootResult.success ? "success" : `failed (${bootResult.reason})`} after ${bootResult.attempts} attempt(s), ` +
        `${bootResult.quarantined.length} quarantined | ${serverId}`
      );
      if (!bootResult.success && bootResult.consoleTail) {
        msgLog.warn(`[install-modpack] ${serverId} final console tail:\n${bootResult.consoleTail.split("\n").slice(-40).join("\n")}`);
      }
    }
  }

  let doneContent = `**Installation Complete**\n\n**${modpackName}** has been installed on **${serverName}**.`;
  msgLog.log(`${username}/${userId} | [install-modpack] install success: ${modpackName} | ${serverId} `);

  if (bootResult?.success) {
    doneContent += "\n\n**Boot verified:** the server started successfully.";
  } else if (bootResult && !bootResult.success) {
    const detail = bootResult.diagnosis
      ? bootResult.diagnosis
      : `verification failed (${bootResult.reason})`;
    doneContent += `\n\n**Warning:** the server did not boot successfully — ${detail}. Please report to <@${process.env.ADMIN_DISCORD_ID}>.`;
  } else if (usingClientPack || usedManifest) {
    doneContent += `\n\n**Reminder:** A client modpack/manifest install was used, please report to <@${process.env.ADMIN_DISCORD_ID}> if you encounter a crash at server boot.`;
  }

  if (bootResult?.quarantined?.length > 0) {
    const MAX_SHOWN = 10;
    const shown = bootResult.quarantined.slice(0, MAX_SHOWN);
    const overflow = bootResult.quarantined.length - shown.length;
    const lines = shown.map(q => `- \`${q.jar}\` — ${q.reason}`);
    if (overflow > 0) lines.push(`- *...and ${overflow} more (see logs)*`);
    doneContent += `\n\n**${bootResult.quarantined.length} mod(s) crashed the server and were moved to \`mods-disabled/\`:**\n${lines.join("\n")}`;
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
    doneContent += `\n\n**Warning: ${unavailableMods.length} mod(s) could not be retrieved** (API download disabled, must install manually):\n${lines.join("\n")}`;
  }

  if (crashRiskWarnings.length > 0) {
    const MAX_SHOWN = 10;
    const shown = crashRiskWarnings.slice(0, MAX_SHOWN);
    const overflow = crashRiskWarnings.length - shown.length;
    const lines = shown.map(w => `- \`${w.filename}\``);
    if (overflow > 0) lines.push(`- *...and ${overflow} more (see logs)*`);
    doneContent += `\n\n**Warning: ${crashRiskWarnings.length} installed mod(s) may crash a dedicated server** (eager client-only init detected), they were still installed. Try removing them from \`mods/\` if boot fails:\n${lines.join("\n")}`;
  }

  await reporter.done(doneContent);

  return {
    ok: true,
    usedManifest,
    manifestInstalled,
    manifestTotal,
    unavailableMods,
    crashRiskWarnings,
    bootResult
  };
}

module.exports = {
  runModpackJob,
  isServerStarterZip,
  parseServerStarterConfig,
  STOP_POLL,
  INSTALL_POLL
};
