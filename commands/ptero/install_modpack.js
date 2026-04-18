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
  changeServerEgg, reinstallServer, listServerFiles, deleteServerFiles, getFileUploadUrl, decompressFile
} = require("../../utility/server_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");
const { getModpackById, getModpackFiles, detectLoaderType, findServerPack, findLinkedServerPackId, getFileById, parseProjectId } = require("../../utility/curseforge.js");
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
  const [vmaj, vmin] = majorMinor.split(".").map(Number);
  const sorted = Object.keys(javaMap).sort((a, b) => {
    const [amaj, amin] = a.split(".").map(Number);
    const [bmaj, bmin] = b.split(".").map(Number);
    return bmaj !== amaj ? bmaj - amaj : bmin - amin;
  });
  for (const key of sorted) {
    const [kmaj, kmin] = key.split(".").map(Number);
    if (vmaj > kmaj || (vmaj === kmaj && vmin >= kmin)) {
      return images[String(javaMap[key])] || null;
    }
  }
  return null;
}

// Streams the file from CurseForge directly into a Wings multipart upload.
// Only a small chunk lives in memory at a time — no full-file buffering.
async function streamModpackToServer(uploadUrl, downloadUrl, filename) {
  const dlResponse = await fetch(downloadUrl);
  if (!dlResponse.ok) throw Object.assign(new Error(`Download failed: HTTP ${dlResponse.status}`), { isDownload: true });

  const fileSize = parseInt(dlResponse.headers.get("content-length") || "0", 10);
  const boundary = `WingsBoundary${Date.now()}`;
  const enc = new TextEncoder();
  const partHeader = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const partFooter = enc.encode(`\r\n--${boundary}--\r\n`);

  const uploadHeaders = { "Content-Type": `multipart/form-data; boundary=${boundary}` };
  if (fileSize > 0) {
    uploadHeaders["Content-Length"] = String(partHeader.length + fileSize + partFooter.length);
  }

  const reader = dlResponse.body.getReader();
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(partHeader);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } finally {
        controller.enqueue(partFooter);
        controller.close();
      }
    },
    cancel() { reader.cancel().catch(() => {}); }
  });

  const uploadResponse = await fetch(uploadUrl, { method: "POST", headers: uploadHeaders, body, duplex: "half" });
  if (!uploadResponse.ok) throw Object.assign(new Error(`Upload failed: HTTP ${uploadResponse.status}`), { isUpload: true });
}

const COLORS = {
  PRIMARY: 0x6b34eb,
  SUCCESS: 0x00aa00,
  DISABLED: 0x808080
};

const COLLECTOR_IDLE_TIMEOUT = 300_000;
const HTTP_STATUS_CODES = { OK: 200, NO_CONTENT: 204 };
const STOP_POLL = { MAX_ATTEMPTS: 60, INTERVAL: 2000 };

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
    const packType = file.serverPackFileId ? "Server pack" : "Client only";
    const description = [ mcVer, date, packType ].filter(Boolean).join(" · ").slice(0, 100);

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
      `The recommended version is pre-selected. Change it if needed.\n` +
      `_Versions with a server pack are preferred._`
    ))
    .addSeparatorComponents(sep => sep)
    .addActionRowComponents(row => row.setComponents(menu))
    .addActionRowComponents(row => row.setComponents(
      new ButtonBuilder().setCustomId("file-select-confirm").setLabel("Continue").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    ));
}

function buildConfirmView1(serverName, modpackName, fileName, loaderType, usingClientPack) {
  let content = `**Install Modpack — Confirm**\n\n`;
  content += `**Server:** ${serverName}\n`;
  content += `**Modpack:** ${modpackName}\n`;
  content += `**File:** ${fileName}\n`;
  content += `**Loader:** ${loaderType ?? "unknown"}\n\n`;
  content += `**WARNING: This will permanently wipe all server files. Back up your server before continuing.**`;

  return new ContainerBuilder()
    .setAccentColor(COLORS.PRIMARY)
    .addTextDisplayComponents(text => text.setContent(content))
    .addSeparatorComponents(sep => sep)
    .addActionRowComponents(row => row.setComponents(
      new ButtonBuilder().setCustomId("confirm-1").setLabel("Confirm").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    ));
}

function buildConfirmView2(serverName, modpackName, usingClientPack) {
  let content = `**Install Modpack — Final Confirmation**\n\n`;
  content += `Installing **${modpackName}** on **${serverName}**.\n\n`;
  content += `**Last chance — this will permanently delete all server files.**`;

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

async function runInstallation(i, state, discordId) {
  const { serverId, serverInternalId, serverName, modpackName, targetFile, loaderType, usingClientPack, mcVersion } = state;

  // a. Stop server
  await updateProgress(i, "Stopping server...");
  await setServerPowerState(serverId, discordId, "stop").catch(() => {});
  for (let attempt = 0; attempt < STOP_POLL.MAX_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, STOP_POLL.INTERVAL));
    const resourceApi = await getServerResourceInfoById(serverId, discordId);
    if (resourceApi.statusCode === HTTP_STATUS_CODES.OK) {
      const data = await resourceApi.body.json();
      if (data.attributes.current_state === "offline") break;
    }
  }

  // b. Delete files
  await updateProgress(i, "Deleting server files...");
  const files = await listServerFiles(serverId, discordId, "/");
  if (files && files.length > 0) {
    await deleteServerFiles(serverId, discordId, files.map(f => f.attributes.name));
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
    const resourceApi = await getServerResourceInfoById(serverId, discordId);
    if (resourceApi.statusCode === HTTP_STATUS_CODES.OK) {
      const data = await resourceApi.body.json();
      if (data.attributes.current_state !== "installing") break;
    }
  }

  // e. Stream modpack from CurseForge → Wings (no full-file buffering)
  await updateProgress(i, `Uploading **${targetFile.displayName}**...`);
  const uploadUrl = await getFileUploadUrl(serverId, discordId);
  if (!uploadUrl) {
    await updateProgress(i, getErrorMessage("MODPACK_FILE_UPLOAD_FAILED"));
    return;
  }
  try {
    await streamModpackToServer(uploadUrl, targetFile.downloadUrl, targetFile.displayName);
  } catch (err) {
    msgLog.error(`[install-modpack] stream failed: ${err.message}`);
    const code = err.isUpload ? "MODPACK_FILE_UPLOAD_FAILED" : "MODPACK_FILE_DOWNLOAD_FAILED";
    await updateProgress(i, getErrorMessage(code));
    return;
  }

  // f. Extract
  await updateProgress(i, "Extracting files...");
  await decompressFile(serverId, discordId, "/", targetFile.displayName);

  // g. Done
  let doneContent = `**Installation Complete**\n\n**${modpackName}** has been installed on **${serverName}**.`;
  if (usingClientPack) {
    doneContent += `\n\n**Reminder:** A client modpack was used. The server may not function correctly without a dedicated server pack.`;
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
              } catch (e) {
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

              // Build top-10 list of selectable versions (non-server-pack files, most recent first)
              const clientFiles = (files || [])
                .filter(f => !f.isServerPack && f.downloadUrl)
                .sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate))
                .slice(0, 10);

              if (clientFiles.length === 0) {
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

              fileOptions = clientFiles;
              // Auto-select: most recent file that has a linked server pack, else most recent overall
              const autoFile = clientFiles.find(f => f.serverPackFileId) || clientFiles[0];
              selectedFileId = autoFile.id;

              await modalSubmit.editReply({
                components: [ buildFileSelectContainer(modpackName, fileOptions, autoFile.id) ],
                flags: MessageFlags.IsComponentsV2
              });

            } catch (modalErr) {
              msgLog.debug(`[install-modpack] modal dismissed: ${modalErr.message}`);
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

            const loadingContainer = new ContainerBuilder()
              .setAccentColor(COLORS.PRIMARY)
              .addTextDisplayComponents(text => text.setContent("**Install Modpack**\n\nLooking up selected version..."));
            await i.editReply({ components: [ loadingContainer ], flags: MessageFlags.IsComponentsV2 });

            // Resolve linked server pack if available
            let serverPackFile = null;
            if (chosenFile.serverPackFileId) {
              serverPackFile = await getFileById(chosenFile.modId, chosenFile.serverPackFileId).catch(() => null);
            }

            if (serverPackFile) {
              targetFile = { id: serverPackFile.id, displayName: serverPackFile.displayName, downloadUrl: serverPackFile.downloadUrl };
              mcVersion = detectMCVersion(modpackData, serverPackFile);
              usingClientPack = false;
            } else {
              targetFile = { id: chosenFile.id, displayName: chosenFile.displayName, downloadUrl: chosenFile.downloadUrl };
              mcVersion = detectMCVersion(modpackData, chosenFile);
              usingClientPack = true;
            }

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
                  `**WARNING:** Client modpack selected.\n` +
                  `It is recommended that you use a dedicated server pack. The modpack may not install correctly.`
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
              components: [ buildConfirmView1(selectedServerName, modpackName, targetFile.displayName, loaderType, false) ],
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
              components: [ buildConfirmView1(selectedServerName, modpackName, targetFile.displayName, loaderType, true) ],
              flags: MessageFlags.IsComponentsV2
            });

          } else if (i.customId === "confirm-1") {
            await i.deferUpdate();
            await i.editReply({
              components: [ buildConfirmView2(selectedServerName, modpackName, usingClientPack) ],
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
            msgLog.log(`${interaction.user.username}/${interaction.user.id} | [install-modpack] install | ${selectedServerName} (${selectedServerId}) | ${modpackName}`);
            await runInstallation(i, installState, interaction.user.id);

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
