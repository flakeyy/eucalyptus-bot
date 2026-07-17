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
  changeServerEgg, reinstallServer, getServerInstallStatus,
  listServerFiles, deleteServerFiles, getFileUploadUrl, decompressFile,
  writeServerFile, renameServerFiles
} = require("../../utility/server_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");
const { isManifestZip } = require("../../utility/curseforge.js");
const { downloadToBuffer, streamUploadToServer } = require("../../utility/modpack_http.js");
const { buildProgressBar, installFilePlan } = require("../../utility/modpack_install.js");
const { verifyServerBoot } = require("../../utility/boot_verify.js");
const { detectProvider, lookupModpack, listModpackFiles, resolveModpackInstall } = require("../../utility/modpack_providers.js");
const AdmZip = require("adm-zip");
const config = require("../../config.json");

function isServerStarterZip(buffer) {
  try {
    const zip = new AdmZip(buffer);
    return zip.getEntry("server-setup-config.yaml") !== null;
  } catch {
    return false;
  }
}

// CurseForge server packs sometimes wrap everything in a single top-level folder
// (e.g. Server-Files-1.1.1/mods/...). After extract, Forge/Fabric still look in
// /mods at the server root — hoist that folder up when we detect it.
function detectNestedServerPackRoot(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries()
      .map(e => e.entryName.replace(/\\/g, "/"))
      .filter(n => n && !n.endsWith("/"));
    if (entries.length === 0) return null;
    const tops = [ ...new Set(entries.map(n => n.split("/")[0])) ];
    if (tops.length !== 1) return null;
    const root = tops[0];
    const hasNestedMods = entries.some(n => n.startsWith(`${root}/mods/`) && /\.jar$/i.test(n));
    const hasRootMods = entries.some(n => n.startsWith("mods/") && /\.jar$/i.test(n));
    return hasNestedMods && !hasRootMods ? root : null;
  } catch {
    return null;
  }
}

function countJarModsInZip(buffer) {
  try {
    const zip = new AdmZip(buffer);
    return zip.getEntries().filter(e => {
      const n = e.entryName.replace(/\\/g, "/");
      return /(?:^|\/)mods\/[^/]+\.jar$/i.test(n) && !e.isDirectory;
    }).length;
  } catch {
    return 0;
  }
}

async function countServerModJars(serverId, userId) {
  const files = await listServerFiles(serverId, userId, "/mods");
  if (!files) return 0;
  return files.filter(f => f.attributes?.is_file && /\.jar$/i.test(f.attributes.name || "")).length;
}

async function hoistNestedServerPack(serverId, userId, nestName) {
  const nested = await listServerFiles(serverId, userId, `/${nestName}`);
  if (!nested || nested.length === 0) return false;
  const moves = nested.map(f => ({
    from: `${nestName}/${f.attributes.name}`,
    to: f.attributes.name
  }));
  // Rename in batches — panel APIs can reject huge single payloads.
  const BATCH = 50;
  for (let i = 0; i < moves.length; i += BATCH) {
    const status = await renameServerFiles(serverId, userId, "/", moves.slice(i, i + BATCH));
    if (status < 200 || status >= 300) {
      msgLog.error(`[install-modpack] hoist rename failed for ${nestName} batch @${i}: HTTP ${status}`);
      return false;
    }
  }
  await deleteServerFiles(serverId, userId, [ nestName ]).catch(() => {});
  msgLog.log(`[install-modpack] hoisted nested server-pack folder "${nestName}/" to server root`);
  return true;
}

// Panel decompress is synchronous on Wings but proxies/Elytra can return early or
// 5xx on large archives while work is still finishing — poll until jar count
// matches expectations or we time out.
async function waitForExtractedMods(serverId, userId, expectedJars, timeoutMs = 180_000) {
  if (expectedJars <= 0) return 0;
  const start = Date.now();
  let last = 0;
  while (Date.now() - start < timeoutMs) {
    last = await countServerModJars(serverId, userId);
    // Allow a little slack for client-only jars we may later skip, but we need
    // a real extract — require at least half the zip's mods/ jars on disk.
    if (last >= Math.max(1, Math.floor(expectedJars * 0.5))) return last;
    await new Promise(r => setTimeout(r, 3000));
  }
  return last;
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

const { COLORS, COLLECTOR_IDLE_TIMEOUT, HTTP_STATUS_CODES } = require("../../utility/constants.js");
const STOP_POLL = { MAX_ATTEMPTS: 60, INTERVAL: 2000 };
// Reinstall runs the egg's install script (download server jar, run loader installer);
// allow up to ~10 minutes before giving up rather than uploading into an unfinished server.
const INSTALL_POLL = { MAX_ATTEMPTS: 300, INTERVAL: 2000 };

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
    menu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(file.label)
        .setDescription(file.description || "—")
        .setValue(file.id)
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

async function runInstallation(i, state, interaction) {
  const { source, serverId, serverInternalId, serverName, modpackName, targetFile, loaderType, usingClientPack, mcVersion } = state;

  // a. Download the modpack file first — a failed download must leave the server untouched.
  await updateProgress(i, `Downloading **${targetFile.displayName}**...`);
  let chunks, fileSize;
  try {
    ({ chunks, fileSize } = await downloadToBuffer(targetFile.downloadUrl, (dl, total) => {
      const pct = Math.round((dl / total) * 100);
      updateProgress(i, `Downloading **${targetFile.displayName}**... ${pct}%`).catch(() => {});
    }));
  } catch (err) {
    msgLog.error(`[install-modpack] download failed: ${err.message}`);
    await updateProgress(i, getErrorMessage("MODPACK_FILE_DOWNLOAD_FAILED"));
    return { ok: false, stage: "download", error: err.message };
  }

  let buffer = Buffer.concat(chunks);

  // b. CurseForge ServerStarter wrapper: fetch the real pack, still before any destructive step.
  if (source !== "modrinth" && isServerStarterZip(buffer)) {
    const ssConfig = parseServerStarterConfig(buffer);
    if (!ssConfig?.modpackUrl) {
      await updateProgress(i, getErrorMessage("MODPACK_FILE_DOWNLOAD_FAILED"));
      return { ok: false, stage: "serverstarter", error: "missing modpackUrl" };
    }
    await updateProgress(i, "Downloading modpack from ServerStarter URL...");
    try {
      ({ chunks, fileSize } = await downloadToBuffer(ssConfig.modpackUrl, (dl, total) => {
        const pct = Math.round((dl / total) * 100);
        updateProgress(i, `Downloading modpack from ServerStarter URL... ${pct}%`).catch(() => {});
      }));
    } catch (err) {
      msgLog.error(`[install-modpack] ServerStarter modpackUrl download failed: ${err.message}`);
      await updateProgress(i, getErrorMessage("MODPACK_FILE_DOWNLOAD_FAILED"));
      return { ok: false, stage: "serverstarter-download", error: err.message };
    }
    buffer = Buffer.concat(chunks);
  }

  // c. Resolve manifest installs up front so resolution failures abort while the
  // server still has its files. Modrinth packs are always .mrpack manifests.
  let installPlan = null;
  let usedManifest = false;
  if (source === "modrinth" || isManifestZip(buffer)) {
    usedManifest = true;
    const resolution = await resolveModpackInstall(
      source === "modrinth" ? "modrinth" : "curseforge",
      buffer, loaderType, msg => updateProgress(i, msg)
    );
    if (!resolution || resolution.kind !== "plan") {
      await updateProgress(i, getErrorMessage("MODPACK_FILE_DOWNLOAD_FAILED"));
      return { ok: false, stage: "resolve-plan", error: "manifest resolution failed" };
    }
    installPlan = resolution.plan;
  }

  // d. Stop server — abort if it never reaches offline rather than wiping a running server.
  await updateProgress(i, "Stopping server...");
  await setServerPowerState(serverId, interaction.user.id, "stop").catch(() => {});
  let serverStopped = false;
  for (let attempt = 0; attempt < STOP_POLL.MAX_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, STOP_POLL.INTERVAL));
    const resourceApi = await getServerResourceInfoById(serverId, interaction.user.id);
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
    await updateProgress(i, getErrorMessage("MODPACK_SERVER_STOP_TIMEOUT"));
    return { ok: false, stage: "stop", error: "server stop timeout" };
  }

  // e. Delete files
  await updateProgress(i, "Deleting server files...");
  const files = await listServerFiles(serverId, interaction.user.id, "/");
  if (files && files.length > 0) {
    await deleteServerFiles(serverId, interaction.user.id, files.map(f => f.attributes.name));
  }

  // f. Change egg (set MC_VERSION and correct Java Docker image)
  await updateProgress(i, `Switching server type to **${loaderType ?? "unknown"}**...`);
  const eggId = config.modpack_eggs[loaderType];
  const envOverrides = {};
  if (mcVersion && config.mc_version_variable) {
    envOverrides[config.mc_version_variable] = mcVersion;
  }
  const javaImage = mcVersion ? getJavaImageForMCVersion(mcVersion) : null;
  const eggChangeStatus = await changeServerEgg(serverInternalId, eggId, config.minecraft_nest_id, envOverrides, javaImage);
  if (eggChangeStatus < 200 || eggChangeStatus >= 300) {
    msgLog.error(`[install-modpack] egg change failed for ${serverId} (status ${eggChangeStatus})`);
    await updateProgress(i, getErrorMessage("MODPACK_EGG_CHANGE_FAILED"));
    return { ok: false, stage: "egg-change", error: `HTTP ${eggChangeStatus}` };
  }

  // g. Reinstall server, then wait until the panel confirms the install actually
  // finished before placing any files. We poll the application-API server status
  // (getServerInstallStatus): the panel sets it to "installing" synchronously when
  // the reinstall is accepted and only clears it once the daemon reports completion.
  // The client resources current_state is unreliable here — it can read "offline"
  // in the gap before the daemon picks up the install, which previously let us
  // upload into a server that was about to be wiped again by the install.
  await updateProgress(i, "Reinstalling server...");
  const reinstallStatus = await reinstallServer(serverInternalId);
  if (reinstallStatus < 200 || reinstallStatus >= 300) {
    msgLog.error(`[install-modpack] reinstall failed for ${serverId} (status ${reinstallStatus})`);
    await updateProgress(i, getErrorMessage("MODPACK_REINSTALL_FAILED"));
    return { ok: false, stage: "reinstall", error: `HTTP ${reinstallStatus}` };
  }
  let reinstallFinished = false;
  for (let attempt = 0; attempt < INSTALL_POLL.MAX_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, INSTALL_POLL.INTERVAL));
    const installState = await getServerInstallStatus(serverInternalId);
    if (installState === "installing" || installState === -1) continue; // still running, or transient API hiccup
    if (installState === "install_failed" || installState === "reinstall_failed") {
      msgLog.error(`[install-modpack] reinstall reported "${installState}" for ${serverId}`);
      await updateProgress(i, getErrorMessage("MODPACK_REINSTALL_FAILED"));
      return { ok: false, stage: "reinstall", error: installState };
    }
    reinstallFinished = true; // null / idle — install complete
    break;
  }
  if (!reinstallFinished) {
    msgLog.error(`[install-modpack] reinstall did not finish in time for ${serverId}`);
    await updateProgress(i, getErrorMessage("MODPACK_REINSTALL_TIMEOUT"));
    return { ok: false, stage: "reinstall", error: "timeout" };
  }

  // h. Place files: manifest plan install or direct upload+extract
  let unavailableMods = [];
  let crashRiskWarnings = [];
  let manifestInstalled = 0;
  let manifestTotal = 0;
  let modIndex = null;

  const effectiveMcVersion = mcVersion ?? installPlan?.mcVersion ?? null;
  const installCtx = {
    i,
    serverId,
    userId: interaction.user.id,
    loaderType,
    mcVersion: effectiveMcVersion,
    updateProgress
  };

  if (usedManifest) {
    ({ unavailable: unavailableMods, installed: manifestInstalled, total: manifestTotal, crashRiskWarnings = [], modIndex = null } =
      await installFilePlan(installCtx, installPlan));
  } else {
    const uploadUrl = await getFileUploadUrl(serverId, interaction.user.id);
    if (!uploadUrl) {
      await updateProgress(i, getErrorMessage("MODPACK_FILE_UPLOAD_FAILED"));
      return { ok: false, stage: "upload", error: "no upload URL" };
    }
    await updateProgress(i, `Uploading **${targetFile.displayName}**...`);
    try {
      await streamUploadToServer(uploadUrl, targetFile.displayName, chunks, fileSize, (dl, ul, total) => {
        const unit = `${(total / 1_048_576).toFixed(1)} MB`;
        updateProgress(i, `Uploading **${targetFile.displayName}**...\n\n${buildProgressBar({ downloaded: dl, installed: ul, total, unit })}`).catch(() => {});
      });
    } catch (err) {
      msgLog.error(`[install-modpack] upload failed: ${err.message}`);
      await updateProgress(i, getErrorMessage("MODPACK_FILE_UPLOAD_FAILED"));
      return { ok: false, stage: "upload", error: err.message };
    }

    const expectedModJars = countJarModsInZip(buffer);
    const nestedRoot = detectNestedServerPackRoot(buffer);

    await updateProgress(i, "Extracting files...");
    const decompressStatus = await decompressFile(serverId, interaction.user.id, "/", targetFile.displayName);
    if (decompressStatus < 200 || decompressStatus >= 300) {
      msgLog.error(`[install-modpack] decompress failed for ${serverId}: HTTP ${decompressStatus}`);
      await updateProgress(i, getErrorMessage("MODPACK_FILE_UPLOAD_FAILED"));
      return { ok: false, stage: "decompress", error: `HTTP ${decompressStatus}` };
    }

    // Delete the archive so it doesn't confuse later listing / eat disk.
    await deleteServerFiles(serverId, interaction.user.id, [ targetFile.displayName ]).catch(() => {});

    if (nestedRoot) {
      await updateProgress(i, `Flattening nested server-pack folder (\`${nestedRoot}/\`)...`);
      const hoisted = await hoistNestedServerPack(serverId, interaction.user.id, nestedRoot);
      if (!hoisted) {
        msgLog.error(`[install-modpack] failed to hoist nested folder ${nestedRoot} on ${serverId}`);
        await updateProgress(i, getErrorMessage("MODPACK_FILE_UPLOAD_FAILED"));
        return { ok: false, stage: "hoist", error: `failed to hoist ${nestedRoot}` };
      }
    }

    if (expectedModJars > 0) {
      await updateProgress(i, `Verifying mods extracted (expect ~${expectedModJars} jars)...`);
      const onDisk = await waitForExtractedMods(serverId, interaction.user.id, expectedModJars);
      if (onDisk < Math.max(1, Math.floor(expectedModJars * 0.5))) {
        msgLog.error(
          `[install-modpack] extract verification failed for ${serverId}: ` +
          `only ${onDisk}/${expectedModJars} jars in mods/ after decompress` +
          (decompressStatus === 204 ? " (decompress returned 204 but files missing — likely timeout/partial extract)" : "")
        );
        await updateProgress(i, getErrorMessage("MODPACK_FILE_UPLOAD_FAILED"));
        return {
          ok: false,
          stage: "extract-verify",
          error: `only ${onDisk}/${expectedModJars} mod jars on disk after extract`
        };
      }
      msgLog.log(`[install-modpack] extract verified: ${onDisk} jars in mods/ (zip had ${expectedModJars})`);
      manifestInstalled = onDisk;
      manifestTotal = expectedModJars;
    }
  }

  // i. Done — but bail out as a failure if a manifest install couldn't place a single mod.
  if (usedManifest && manifestTotal > 0 && manifestInstalled === 0) {
    msgLog.error(`${interaction.user.username}/${interaction.user.id} | [install-modpack] install failed: 0/${manifestTotal} mods installed: ${modpackName} | ${serverId}`);
    await updateProgress(i, getErrorMessage("MODPACK_FILE_UPLOAD_FAILED"));
    return { ok: false, stage: "place-mods", error: `0/${manifestTotal} mods installed` };
  }

  // i1. Accept the Minecraft EULA so boot-verify (and first user start) can
  // actually reach "Done". Reinstall leaves eula=false / missing eula.txt.
  try {
    const eulaStatus = await writeServerFile(
      serverId, interaction.user.id, "/eula.txt", "eula=true\n"
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
    await updateProgress(i, "Verifying server boot (this can take several minutes)...");
    try {
      bootResult = await verifyServerBoot({
        serverId,
        userId: interaction.user.id,
        modIndex,
        settings: config.boot_verify,
        onProgress: msg => updateProgress(i, msg).catch(() => {})
      });
    } catch (err) {
      msgLog.error(`[install-modpack] boot verification errored for ${serverId}: ${err.message}`);
    }
    if (bootResult) {
      msgLog.log(
        `${interaction.user.username}/${interaction.user.id} | [install-modpack] boot verify: ` +
        `${bootResult.success ? "success" : `failed (${bootResult.reason})`} after ${bootResult.attempts} attempt(s), ` +
        `${bootResult.quarantined.length} quarantined | ${serverId}`
      );
      if (!bootResult.success && bootResult.consoleTail) {
        msgLog.warn(`[install-modpack] ${serverId} final console tail:\n${bootResult.consoleTail.split("\n").slice(-40).join("\n")}`);
      }
    }
  }

  let doneContent = `**Installation Complete**\n\n**${modpackName}** has been installed on **${serverName}**.`;
  msgLog.log(`${interaction.user.username}/${interaction.user.id} | [install-modpack] install success: ${modpackName} | ${serverId} `);

  if (bootResult?.success) {
    doneContent += "\n\n**Boot verified:** the server started successfully.";
  } else if (bootResult && !bootResult.success) {
    doneContent += `\n\n**Warning:** the server did not boot successfully during verification (${bootResult.reason}). Please report to <@${process.env.ADMIN_DISCORD_ID}>.`;
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

  const doneContainer = new ContainerBuilder()
    .setAccentColor(COLORS.SUCCESS)
    .addTextDisplayComponents(text => text.setContent(doneContent));
  await i.editReply({ components: [ doneContainer ], flags: MessageFlags.IsComponentsV2 }).catch(() => {});

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
  runInstallation,

  category: "Servers",
  requiresApiKey: true,

  data: new SlashCommandBuilder()
    .setName("install-modpack")
    .setDescription("Install a CurseForge or Modrinth modpack onto one of your Minecraft servers."),

  async execute(interaction) {
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);

    const hasEditServers = authenticateUserForPermission(interaction.user.id, PERMISSIONS.EDIT_SERVER_PROPERTIES);
    if (hasEditServers === -1) {
      await interaction.reply({ content: getErrorMessage("USER_NOT_FOUND"), flags: MessageFlags.Ephemeral });
      return;
    }
    if (!hasEditServers) {
      await interaction.reply({ content: getErrorMessage("INSUFFICIENT_PERMISSIONS"), flags: MessageFlags.Ephemeral });
      return;
    }
    if (!userHasClientApiKey(interaction.user.id)) {
      await interaction.reply({ content: getErrorMessage("API_KEY_NOT_SET"), flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      const serverObjects = await getClientServers(interaction.user.id);
      if (!serverObjects || !serverObjects.data) {
        await interaction.reply({ content: getErrorMessage("CLIENT_API_FAILURE"), flags: MessageFlags.Ephemeral });
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
      await interaction.reply({ components: [ initialContainer ], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });

      const response = await interaction.fetchReply();
      const collector = response.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id,
        idle: COLLECTOR_IDLE_TIMEOUT
      });

      let selectedServerId = null;
      let selectedServerInternalId = null;
      let selectedServerName = null;
      let modpackName = null;
      let modpackSource = null;
      let targetFile = null;
      let loaderType = null;
      let usingClientPack = false;
      let mcVersion = null;
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
                new ButtonBuilder().setCustomId("proceed-to-url").setLabel("Enter Modpack URL").setStyle(ButtonStyle.Primary)
              ));

            await i.update({ components: [ selectedContainer ], flags: MessageFlags.IsComponentsV2 });

          } else if (i.customId === "proceed-to-url") {
            const urlModal = new ModalBuilder()
              .setCustomId("modpack-url-modal")
              .setTitle("Install Modpack");

            const urlInput = new TextInputBuilder()
              .setCustomId("modpack-url-input")
              .setLabel("Modpack URL (CurseForge or Modrinth)")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("curseforge.com/minecraft/modpacks/...  or  modrinth.com/modpack/...")
              .setRequired(true)
              .setMaxLength(300);

            urlModal.addComponents(new ActionRowBuilder().addComponents(urlInput));
            await i.showModal(urlModal);

            try {
              const modalSubmit = await i.awaitModalSubmit({
                filter: m => m.customId === "modpack-url-modal" && m.user.id === interaction.user.id,
                time: 300_000
              });
              await modalSubmit.deferUpdate();

              const rawInput = modalSubmit.fields.getTextInputValue("modpack-url-input").trim();
              const source = detectProvider(rawInput);

              if (!source) {
                const errorContainer = new ContainerBuilder()
                  .setAccentColor(COLORS.PRIMARY)
                  .addTextDisplayComponents(text => text.setContent(
                    `**Install Modpack**\n\n${getErrorMessage("UNSUPPORTED_MODPACK_URL")}`
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
                modpack = await lookupModpack(source, rawInput);
              } catch {
                const apiErrorKey = source === "modrinth" ? "MODRINTH_API_ERROR" : "CURSEFORGE_API_ERROR";
                const errContainer = new ContainerBuilder()
                  .setAccentColor(COLORS.PRIMARY)
                  .addTextDisplayComponents(text => text.setContent(`**Install Modpack**\n\n${getErrorMessage(apiErrorKey)}`))
                  .addSeparatorComponents(sep => sep)
                  .addActionRowComponents(row => row.setComponents(
                    new ButtonBuilder().setCustomId("cancel").setLabel("Close").setStyle(ButtonStyle.Secondary)
                  ));
                await modalSubmit.editReply({ components: [ errContainer ], flags: MessageFlags.IsComponentsV2 });
                return;
              }

              if (!modpack) {
                const notFoundKey = source === "modrinth" ? "MODRINTH_MODPACK_NOT_FOUND" : "CURSEFORGE_MODPACK_NOT_FOUND";
                const notFoundContainer = new ContainerBuilder()
                  .setAccentColor(COLORS.PRIMARY)
                  .addTextDisplayComponents(text => text.setContent(`**Install Modpack**\n\n${getErrorMessage(notFoundKey)}`))
                  .addSeparatorComponents(sep => sep)
                  .addActionRowComponents(row => row.setComponents(
                    new ButtonBuilder().setCustomId("proceed-to-url").setLabel("Try Again").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                  ));
                await modalSubmit.editReply({ components: [ notFoundContainer ], flags: MessageFlags.IsComponentsV2 });
                return;
              }

              modpackSource = source;
              modpackName = modpack.name;
              loaderType = modpack.loaderType;

              fileOptions = await listModpackFiles(source, modpack);

              if (!fileOptions || fileOptions.length === 0) {
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
            selectedFileId = i.values[0];
            await i.update({
              components: [ buildFileSelectContainer(modpackName, fileOptions, selectedFileId) ],
              flags: MessageFlags.IsComponentsV2
            });

          } else if (i.customId === "file-select-confirm") {
            await i.deferUpdate();
            const chosenFile = fileOptions?.find(f => f.id === selectedFileId);
            if (!chosenFile) return;

            targetFile = { id: chosenFile.id, displayName: chosenFile.label, downloadUrl: chosenFile.downloadUrl };
            mcVersion = chosenFile.mcVersion;
            usingClientPack = !chosenFile.isServerPack;
            // Modrinth loaders vary per version; prefer the selected file's loader.
            loaderType = chosenFile.loaderType ?? loaderType;

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
              source: modpackSource,
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
          const errResp = { content: "An error occurred while processing your request.", flags: MessageFlags.Ephemeral };
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
            serverObjects.data, nestMap, getErrorMessage("USER_TIMEOUT", "/install-modpack"), true
          );
          await interaction.editReply({ components: [ disabledContainer ], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
        }
      });

    } catch (err) {
      msgLog.error(`[install-modpack] execute error: ${err.message}`);
      const errMsg = { content: "An error occurred while loading the install modpack menu.", flags: MessageFlags.Ephemeral };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errMsg).catch(() => {});
      } else {
        await interaction.reply(errMsg).catch(() => {});
      }
    }
  }
};
