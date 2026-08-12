const {
  ContainerBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, MessageFlags
} = require("discord.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const msgLog = require("../../utility/logger.js");
const { getUserId, reconstructCommand, userHasClientApiKey, applicationApiCall } = require("../../utility/helper_functions.js");
const { getClientServers } = require("../../utility/server_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");
const { lookupModpack, listModpackFiles, FILE_SELECT_PAGE_SIZE } = require("../../utility/modpack_providers.js");
const { runModpackJob } = require("../../utility/modpack/job.js");
const { DiscordReporter } = require("../../utility/modpack/reporters.js");
const { searchModpacks, parsePackChoice, SEARCH_BUDGET_MS, CACHE_TTL_MS } = require("../../utility/modpack/search.js");
const config = require("../../config.json");
const { COLORS, COLLECTOR_IDLE_TIMEOUT, HTTP_STATUS_CODES } = require("../../utility/constants.js");

// Server autocomplete does a full getClientServers plus an application-API user
// fetch per keystroke against Discord's 3s deadline. Cache the resolved list per
// user on the same TTL the pack search uses, and bound it the same way.
const serverListCache = new Map(); // discordUserId → { at, servers: [{ name, value }] }

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("autocomplete-timeout")), ms);
  });
  return Promise.race([ promise, timeout ]).finally(() => clearTimeout(timer));
}

/** Minecraft servers the user owns, as autocomplete choices. Cached per user. */
async function loadServerChoices(discordUserId) {
  const hit = serverListCache.get(discordUserId);
  if (hit && Date.now() - hit.at <= CACHE_TTL_MS) return hit.servers;

  const serverObjects = await getClientServers(discordUserId);
  const nestMap = {};
  const panelId = getUserId(discordUserId);
  if (panelId > 0) {
    try {
      const userApi = await applicationApiCall(`application/users/${panelId}?include=servers`, "GET");
      if (userApi.statusCode === HTTP_STATUS_CODES.OK) {
        const userData = await userApi.body.json();
        for (const server of userData.attributes.relationships.servers.data) {
          nestMap[server.attributes.identifier] = server.attributes.nest;
        }
      }
    } catch { /* ignore — list without nest filter */ }
  }

  const servers = (serverObjects?.data || [])
    .filter(s => nestMap[s.attributes.identifier] === config.minecraft_nest_id)
    .map(s => ({ name: `${s.attributes.name}`.slice(0, 100), value: s.attributes.identifier }));

  serverListCache.set(discordUserId, { at: Date.now(), servers });
  return servers;
}

function clearServerListCache() {
  serverListCache.clear();
}

/** Thin Discord adapter — job lives in utility/modpack/job.js. */
async function runInstallation(i, state, interaction) {
  const reporter = new DiscordReporter(i, {
    channel: interaction.channel ?? null,
    // Token lifetime runs from the original interaction, not from confirm.
    startedAt: interaction.createdTimestamp
  });
  return runModpackJob({
    ...state,
    userId: interaction.user.id,
    username: interaction.user.username
  }, reporter);
}

function buildServerSelectContainer(servers, nestMap, statusNote = null, disabled = false) {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("server-select")
    .setPlaceholder(disabled ? "Session ended" : "Select a Minecraft server")
    .setDisabled(disabled);

  const minecraftServers = (servers || []).filter(
    s => nestMap[s.attributes.identifier] === config.minecraft_nest_id
  );
  if (minecraftServers.length > 0) {
    for (const server of minecraftServers) {
      selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(server.attributes.name)
          .setDescription(`ID: ${server.attributes.identifier}`)
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

  let content = "**Install Modpack**\n\nSelect a Minecraft server to install a modpack on.";
  if (statusNote) content += `\n\n${statusNote}`;

  return new ContainerBuilder()
    .setAccentColor(disabled ? COLORS.DISABLED : COLORS.PRIMARY)
    .addTextDisplayComponents(text => text.setContent(content))
    .addSeparatorComponents(sep => sep)
    .addActionRowComponents(row => row.setComponents(selectMenu));
}

function buildFileSelectContainer(modpackName, fileOptions, autoSelectedId, page = 0) {
  const totalPages = Math.max(1, Math.ceil(fileOptions.length / FILE_SELECT_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const pageOptions = fileOptions.slice(
    safePage * FILE_SELECT_PAGE_SIZE,
    (safePage + 1) * FILE_SELECT_PAGE_SIZE
  );

  const menu = new StringSelectMenuBuilder()
    .setCustomId("file-select")
    .setPlaceholder("Select a version");

  for (const file of pageOptions) {
    menu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(file.label)
        .setDescription(file.description || "—")
        .setValue(file.id)
        .setDefault(file.id === autoSelectedId)
    );
  }

  let content =
    `**Install Modpack — Select Version**\n\n**Modpack:** ${modpackName}\n\n` +
    "The recommended version is pre-selected. Change it if needed.\n" +
    "_Versions are sorted latest first. Server packs are preferred when available._";
  if (totalPages > 1) {
    content += `\n\nShowing ${safePage * FILE_SELECT_PAGE_SIZE + 1}–` +
      `${Math.min((safePage + 1) * FILE_SELECT_PAGE_SIZE, fileOptions.length)} of ${fileOptions.length}` +
      ` · Page ${safePage + 1}/${totalPages}`;
  }

  const container = new ContainerBuilder()
    .setAccentColor(COLORS.PRIMARY)
    .addTextDisplayComponents(text => text.setContent(content))
    .addSeparatorComponents(sep => sep)
    .addActionRowComponents(row => row.setComponents(menu));

  if (totalPages > 1) {
    container.addActionRowComponents(row => row.setComponents(
      new ButtonBuilder()
        .setCustomId("file-select-newer")
        .setLabel("Newer versions")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage === 0),
      new ButtonBuilder()
        .setCustomId("file-select-older")
        .setLabel("Older versions")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage >= totalPages - 1)
    ));
  }

  return container.addActionRowComponents(row => row.setComponents(
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
      new ButtonBuilder().setCustomId("confirm-install").setLabel("Install Now").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    ));
}

module.exports = {
  runInstallation,
  clearServerListCache,

  category: "Servers",
  requiresApiKey: true,

  data: new SlashCommandBuilder()
    .setName("install-modpack")
    .setDescription("Install a CurseForge or Modrinth modpack onto one of your Minecraft servers.")
    .addStringOption(opt =>
      opt.setName("pack")
        .setDescription("Modpack to install (search by name)")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(opt =>
      opt.setName("server")
        .setDescription("Minecraft server to install onto (optional)")
        .setRequired(false)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name === "pack") {
      const choices = await searchModpacks(focused.value);
      await interaction.respond(choices.slice(0, 25));
      return;
    }
    if (focused.name === "server") {
      try {
        const servers = await withTimeout(loadServerChoices(interaction.user.id), SEARCH_BUDGET_MS);
        const q = String(focused.value || "").toLowerCase();
        const choices = servers
          .filter(s => !q || s.name.toLowerCase().includes(q) || s.value.includes(q))
          .slice(0, 25);
        await interaction.respond(choices);
      } catch {
        await interaction.respond([]);
      }
    }
  },

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

    const packChoice = interaction.options.getString("pack");
    const parsedPack = parsePackChoice(packChoice);
    if (!parsedPack) {
      await interaction.reply({
        content: "Pick a modpack from the autocomplete list (`pack:`).",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    try {
      const serverObjects = await getClientServers(interaction.user.id);
      if (!serverObjects || !serverObjects.data) {
        await interaction.reply({ content: getErrorMessage("CLIENT_API_FAILURE"), flags: MessageFlags.Ephemeral });
        return;
      }

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

      await interaction.reply({
        components: [ new ContainerBuilder()
          .setAccentColor(COLORS.PRIMARY)
          .addTextDisplayComponents(text => text.setContent("**Install Modpack**\n\nLooking up modpack...")) ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
      });

      let modpack;
      try {
        modpack = await lookupModpack(parsedPack.source, parsedPack.id);
      } catch {
        const apiErrorKey = parsedPack.source === "modrinth" ? "MODRINTH_API_ERROR" : "CURSEFORGE_API_ERROR";
        await interaction.editReply({
          components: [ new ContainerBuilder()
            .setAccentColor(COLORS.PRIMARY)
            .addTextDisplayComponents(text => text.setContent(`**Install Modpack**\n\n${getErrorMessage(apiErrorKey)}`)) ],
          flags: MessageFlags.IsComponentsV2
        });
        return;
      }
      if (!modpack) {
        const notFoundKey = parsedPack.source === "modrinth" ? "MODRINTH_MODPACK_NOT_FOUND" : "CURSEFORGE_MODPACK_NOT_FOUND";
        await interaction.editReply({
          components: [ new ContainerBuilder()
            .setAccentColor(COLORS.PRIMARY)
            .addTextDisplayComponents(text => text.setContent(`**Install Modpack**\n\n${getErrorMessage(notFoundKey)}`)) ],
          flags: MessageFlags.IsComponentsV2
        });
        return;
      }

      const fileOptions = await listModpackFiles(parsedPack.source, modpack);
      if (!fileOptions || fileOptions.length === 0) {
        await interaction.editReply({
          components: [ new ContainerBuilder()
            .setAccentColor(COLORS.PRIMARY)
            .addTextDisplayComponents(text => text.setContent(
              `**Install Modpack**\n\n${getErrorMessage("MODPACK_FILE_DOWNLOAD_FAILED")}\n\nNo downloadable files were found for this modpack.`
            )) ],
          flags: MessageFlags.IsComponentsV2
        });
        return;
      }

      let selectedServerId = null;
      let selectedServerInternalId = null;
      let selectedServerName = null;
      const modpackName = modpack.name;
      const modpackSource = parsedPack.source;
      const modpackId = modpack.id;
      let targetFile = null;
      let loaderType = modpack.loaderType;
      let usingClientPack = false;
      let mcVersion = null;
      let selectedFileId = fileOptions[0].id;
      let fileSelectPage = 0;

      const optionServerId = interaction.options.getString("server");
      if (optionServerId) {
        const server = serverObjects.data.find(s => s.attributes.identifier === optionServerId);
        const isMinecraft = nestMap[optionServerId] === config.minecraft_nest_id;
        if (server && isMinecraft) {
          selectedServerId = optionServerId;
          selectedServerInternalId = server.attributes.internal_id;
          selectedServerName = server.attributes.name;
        }
      }

      const initial = selectedServerId
        ? buildFileSelectContainer(modpackName, fileOptions, selectedFileId, fileSelectPage)
        : buildServerSelectContainer(serverObjects.data, nestMap);
      await interaction.editReply({ components: [ initial ], flags: MessageFlags.IsComponentsV2 });

      const response = await interaction.fetchReply();
      const collector = response.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id,
        idle: COLLECTOR_IDLE_TIMEOUT
      });

      collector.on("collect", async i => {
        try {
          if (i.customId === "server-select") {
            const chosen = i.values[0];
            if (chosen === "none") {
              await i.update({
                components: [ buildServerSelectContainer(serverObjects.data, nestMap) ],
                flags: MessageFlags.IsComponentsV2
              });
              return;
            }
            const server = serverObjects.data.find(s => s.attributes.identifier === chosen);
            selectedServerId = chosen;
            selectedServerInternalId = server?.attributes?.internal_id;
            selectedServerName = server?.attributes?.name;
            await i.update({
              components: [ buildFileSelectContainer(modpackName, fileOptions, selectedFileId, fileSelectPage) ],
              flags: MessageFlags.IsComponentsV2
            });

          } else if (i.customId === "file-select") {
            selectedFileId = i.values[0];
            await i.update({
              components: [ buildFileSelectContainer(modpackName, fileOptions, selectedFileId, fileSelectPage) ],
              flags: MessageFlags.IsComponentsV2
            });

          } else if (i.customId === "file-select-older" || i.customId === "file-select-newer") {
            const totalPages = Math.max(1, Math.ceil((fileOptions?.length || 0) / FILE_SELECT_PAGE_SIZE));
            if (i.customId === "file-select-older") {
              fileSelectPage = Math.min(fileSelectPage + 1, totalPages - 1);
            } else {
              fileSelectPage = Math.max(fileSelectPage - 1, 0);
            }
            await i.update({
              components: [ buildFileSelectContainer(modpackName, fileOptions, selectedFileId, fileSelectPage) ],
              flags: MessageFlags.IsComponentsV2
            });

          } else if (i.customId === "file-select-confirm") {
            await i.deferUpdate();
            const chosenFile = fileOptions?.find(f => f.id === selectedFileId);
            if (!chosenFile || !selectedServerId) return;

            targetFile = { id: chosenFile.id, displayName: chosenFile.label, downloadUrl: chosenFile.downloadUrl };
            mcVersion = chosenFile.mcVersion;
            usingClientPack = !chosenFile.isServerPack;
            loaderType = chosenFile.loaderType ?? loaderType;

            if (!targetFile?.downloadUrl) {
              await i.editReply({
                components: [ new ContainerBuilder()
                  .setAccentColor(COLORS.PRIMARY)
                  .addTextDisplayComponents(text => text.setContent(
                    `**Install Modpack**\n\n${getErrorMessage("MODPACK_FILE_DOWNLOAD_FAILED")}\n\nNo download is available for this file.`
                  )) ],
                flags: MessageFlags.IsComponentsV2
              });
              return;
            }
            if (!config.modpack_eggs?.[loaderType]) {
              await i.editReply({
                components: [ new ContainerBuilder()
                  .setAccentColor(COLORS.PRIMARY)
                  .addTextDisplayComponents(text => text.setContent(
                    `**Install Modpack**\n\n${getErrorMessage("MODPACK_EGG_NOT_CONFIGURED", loaderType)}`
                  )) ],
                flags: MessageFlags.IsComponentsV2
              });
              return;
            }

            await i.editReply({
              components: [ buildConfirmView1(selectedServerName, modpackName, targetFile.displayName, loaderType) ],
              flags: MessageFlags.IsComponentsV2
            });

          } else if (i.customId === "confirm-install") {
            await i.deferUpdate();
            collector.stop("installing");

            const installState = {
              source: modpackSource,
              serverId: selectedServerId,
              serverInternalId: selectedServerInternalId,
              serverName: selectedServerName,
              modpackName,
              modpackId,
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
            await i.editReply({
              components: [ new ContainerBuilder()
                .setAccentColor(COLORS.DISABLED)
                .addTextDisplayComponents(text => text.setContent("**Install Modpack**\n\nInstallation cancelled.")) ],
              flags: MessageFlags.IsComponentsV2
            });
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

      collector.on("end", async (_collected, reason) => {
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
