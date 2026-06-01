const { ContainerBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require("discord.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const msgLog = require("../../utility/logger.js");
const { getUserId, reconstructCommand, userHasClientApiKey } = require("../../utility/helper_functions.js");
const { getClientServers, setServerPowerState, getServerInfoById, getServerResourceInfoById, isServerSuspended, suspendServer, unsuspendServer, getAvailableUserMemory, deleteServer, editServerInfo } = require("../../utility/server_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");
const { PterodactylWebSocket } = require("../../utility/pterodactyl_websocket.js");
const { COLORS, HTTP_STATUS_CODES, COLLECTOR_IDLE_TIMEOUT, WS_THROTTLE_MS, CONSOLE_MAX_LINES } = require("../../utility/constants.js");
const { buildServerSelectMenu, buildServerDetailsText, renderConsoleBlock } = require("../../utility/server_views.js");

function buildMainServerView(serverObjects, currentSelectedServer, serverResourceInfo = null, statusMessage = null, consoleLines = []) {
  const selectMenu = buildServerSelectMenu(
    serverObjects,
    currentSelectedServer?.attributes?.identifier
  );

  const container = new ContainerBuilder()
    .setAccentColor(COLORS.PRIMARY)
    .addActionRowComponents(actionRow =>
      actionRow.setComponents(selectMenu)
    );

  if (currentSelectedServer) {
    let detailsText = buildServerDetailsText(currentSelectedServer, serverResourceInfo);

    if (statusMessage) {
      detailsText += `\n\n${statusMessage}`;
    }

    const isSuspended = !serverResourceInfo;

    container
      .addTextDisplayComponents(text =>
        text.setContent(detailsText)
      )
      .addSeparatorComponents(separator => separator);

    const consolePreview = renderConsoleBlock(consoleLines, { preview: true });
    if (consolePreview) {
      container
        .addTextDisplayComponents(text =>
          text.setContent(consolePreview)
        )
        .addSeparatorComponents(separator => separator);
    }

    container
      .addActionRowComponents(actionRow =>
        actionRow.setComponents(
          new ButtonBuilder().setCustomId("server-settings").setLabel("Server Settings").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("console-view").setLabel("Console").setStyle(ButtonStyle.Secondary).setDisabled(isSuspended)
        )
      )
      .addActionRowComponents(actionRow =>
        actionRow.setComponents(
          new ButtonBuilder().setCustomId("power-start").setLabel("Start").setStyle(ButtonStyle.Success).setDisabled(isSuspended),
          new ButtonBuilder().setCustomId("power-restart").setLabel("Restart").setStyle(ButtonStyle.Primary).setDisabled(isSuspended),
          new ButtonBuilder().setCustomId("power-stop").setLabel("Stop").setStyle(ButtonStyle.Danger).setDisabled(isSuspended)
        )
      );
  }

  return container;
}

function buildConsoleView(serverName, lines) {
  const consoleText = renderConsoleBlock(lines) ?? "No output yet.";

  return new ContainerBuilder()
    .setAccentColor(COLORS.PRIMARY)
    .addActionRowComponents(actionRow =>
      actionRow.setComponents(
        new ButtonBuilder().setCustomId("back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
      )
    )
    .addTextDisplayComponents(text =>
      text.setContent(`**${serverName}** — Console`)
    )
    .addSeparatorComponents(separator => separator)
    .addTextDisplayComponents(text =>
      text.setContent(consoleText)
    )
    .addSeparatorComponents(separator => separator)
    .addActionRowComponents(actionRow =>
      actionRow.setComponents(
        new ButtonBuilder().setCustomId("send-command").setLabel("Send Command").setStyle(ButtonStyle.Primary)
      )
    );
}

function buildSettingsView(serverName, isSuspended) {
  return new ContainerBuilder()
    .setAccentColor(COLORS.PRIMARY)
    .addActionRowComponents(actionRow =>
      actionRow.setComponents(
        new ButtonBuilder().setCustomId("back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
      )
    )
    .addTextDisplayComponents(text =>
      text.setContent(`**${serverName}** — Settings`)
    )
    .addSeparatorComponents(separator => separator)
    .addActionRowComponents(actionRow =>
      actionRow.setComponents(
        new ButtonBuilder().setCustomId("edit-server-name").setLabel("Edit Name").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("edit-server-memory").setLabel("Edit Memory").setStyle(ButtonStyle.Primary)
      )
    )
    .addSeparatorComponents(separator => separator)
    .addActionRowComponents(actionRow =>
      actionRow.setComponents(
        isSuspended
          ? new ButtonBuilder().setCustomId("unsuspend-server").setLabel("Unsuspend Server").setStyle(ButtonStyle.Success)
          : new ButtonBuilder().setCustomId("suspend-server").setLabel("Suspend Server").setStyle(ButtonStyle.Danger)
      )
    )
    .addActionRowComponents(actionRow =>
      actionRow.setComponents(
        new ButtonBuilder().setCustomId("delete-server").setLabel("Delete Server").setStyle(ButtonStyle.Danger)
      )
    );
}

module.exports = {
  buildServerSelectMenu,
  buildMainServerView,
  buildConsoleView,

  data: new SlashCommandBuilder()
    .setName("servers")
    .setDescription("Opens the interactive server management menu."),

  async execute(interaction) {
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);

    const hasReadServers = authenticateUserForPermission(interaction.user.id, PERMISSIONS.READ_SERVERS);
    const hasEditSettings = authenticateUserForPermission(interaction.user.id, PERMISSIONS.EDIT_SERVER_PROPERTIES);

    if (hasReadServers === -1 || hasEditSettings === -1) {
      await interaction.reply({ content: getErrorMessage("USER_NOT_FOUND"), flags: MessageFlags.Ephemeral });
      return;
    }

    if (!hasReadServers || !hasEditSettings) {
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

      const selectMenu = buildServerSelectMenu(serverObjects);

      const initialContainer = new ContainerBuilder()
        .setAccentColor(COLORS.PRIMARY)
        .addActionRowComponents(actionRow =>
          actionRow.setComponents(selectMenu)
        );

      await interaction.reply({
        components: [ initialContainer ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
      });

      const response = await interaction.fetchReply();
      const collector = response.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id,
        idle: COLLECTOR_IDLE_TIMEOUT
      });

      let currentSelectedServer = null;
      let currentServerResourceInfo = null;
      let currentView = "main";
      let activeWs = null;
      let lastDiscordEditTime = 0;
      let consoleBuffer = [];

      const disconnectWebSocket = () => {
        if (activeWs) {
          activeWs.close();
          activeWs = null;
        }
      };

      const connectWebSocket = serverId => {
        disconnectWebSocket();

        if (!currentSelectedServer || !currentServerResourceInfo) return;

        const ws = new PterodactylWebSocket(serverId, interaction.user.id);
        activeWs = ws;

        ws.on("stats", async resourceInfo => {
          currentServerResourceInfo = resourceInfo;
          const now = Date.now();
          if (now - lastDiscordEditTime < WS_THROTTLE_MS || currentView !== "main") return;
          lastDiscordEditTime = now;
          await interaction.editReply({
            components: [ buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, null, consoleBuffer) ],
            flags: MessageFlags.IsComponentsV2
          }).catch(() => disconnectWebSocket());
        });

        ws.on("consoleLine", async line => {
          // eslint-disable-next-line no-control-regex
          const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
          const truncated = stripped.length > 300 ? stripped.slice(0, 300) + "…" : stripped;
          consoleBuffer.push(truncated);
          if (consoleBuffer.length > CONSOLE_MAX_LINES) consoleBuffer.shift();

          const now = Date.now();
          if (now - lastDiscordEditTime < WS_THROTTLE_MS || currentView !== "console") return;
          lastDiscordEditTime = now;
          await interaction.editReply({
            components: [ buildConsoleView(currentSelectedServer.attributes.name, consoleBuffer) ],
            flags: MessageFlags.IsComponentsV2
          }).catch(() => disconnectWebSocket());
        });

        ws.on("powerStateChange", async state => {
          if (currentServerResourceInfo?.attributes) {
            currentServerResourceInfo.attributes.current_state = state;
            if (state === "offline") {
              currentServerResourceInfo.attributes.resources.cpu_absolute = 0;
              currentServerResourceInfo.attributes.resources.memory_bytes = 0;
            }
          }
          if (currentView !== "main") return;
          await interaction.editReply({
            components: [ buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, null, consoleBuffer) ],
            flags: MessageFlags.IsComponentsV2
          }).catch(() => disconnectWebSocket());
        });

        ws.on("error", err => {
          msgLog.error(`[server-menu] WS error for ${serverId}: ${err.message}`);
        });

        ws.on("close", () => {
          if (activeWs === ws) activeWs = null;
        });

        ws.connect().catch(err => {
          msgLog.error(`[server-menu] WS connect failed for ${serverId}: ${err.message}`);
          activeWs = null;
        });
      };

      const createDisabledMenu = errorKey => {
        const disabledSelectMenu = buildServerSelectMenu(
          serverObjects,
          currentSelectedServer?.attributes?.identifier,
          true
        );

        const disabledContainer = new ContainerBuilder()
          .setAccentColor(COLORS.DISABLED)
          .addActionRowComponents(actionRow =>
            actionRow.setComponents(disabledSelectMenu)
          )
          .addTextDisplayComponents(text =>
            text.setContent(getErrorMessage(errorKey))
          );

        if (currentSelectedServer) {
          disabledContainer
            .addSeparatorComponents(separator => separator)
            .addActionRowComponents(actionRow =>
              actionRow.setComponents(
                new ButtonBuilder().setCustomId("server-settings").setLabel("Server Settings").setStyle(ButtonStyle.Primary).setDisabled(true)
              )
            )
            .addActionRowComponents(actionRow =>
              actionRow.setComponents(
                new ButtonBuilder().setCustomId("power-start").setLabel("Start").setStyle(ButtonStyle.Success).setDisabled(true),
                new ButtonBuilder().setCustomId("power-restart").setLabel("Restart").setStyle(ButtonStyle.Primary).setDisabled(true),
                new ButtonBuilder().setCustomId("power-stop").setLabel("Stop").setStyle(ButtonStyle.Danger).setDisabled(true)
              )
            );
        }

        return disabledContainer;
      };

      const logMenuAction = (i, action, extra = "") => {
        const serverCtx = currentSelectedServer
          ? ` | ${currentSelectedServer.attributes.name} (${currentSelectedServer.attributes.identifier})`
          : "";
        msgLog.log(`${i.user.username}/${i.user.id} | [server-menu] ${action}${serverCtx}${extra ? ` | ${extra}` : ""}`);
      };

      const refreshCurrentServer = async serverId => {
        const res = await getServerInfoById(serverId, interaction.user.id);
        if (res.statusCode === HTTP_STATUS_CODES.OK) {
          const updated = await res.body.json();
          const idx = serverObjects.data.findIndex(s => s.attributes.identifier === serverId);
          if (idx !== -1) serverObjects.data[idx] = updated;
          currentSelectedServer = updated;
        }
      };

      const buildModalErrorView = message => new ContainerBuilder()
        .setAccentColor(COLORS.PRIMARY)
        .addActionRowComponents(actionRow =>
          actionRow.setComponents(
            new ButtonBuilder().setCustomId("back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
          )
        )
        .addTextDisplayComponents(text =>
          text.setContent(`**Server Settings**\n\n${message}`)
        );

      collector.on("collect", async i => {
        try {
          if (i.customId === "server-selection") {
            disconnectWebSocket();
            consoleBuffer = [];

            const selectedServerId = i.values[0];
            msgLog.debugExtended(`${i.user.username}/${i.user.id} | [servers] select-server | ${selectedServerId}`);

            const selectedServerObject = await getServerInfoById(selectedServerId, interaction.user.id);

            if (selectedServerObject.statusCode === HTTP_STATUS_CODES.UNAUTHORIZED) {
              collector.stop("unauthorized");
              return;
            }

            currentSelectedServer = serverObjects.data.find(
              server => server.attributes.identifier === selectedServerId
            );

            const serverResourceApi = await getServerResourceInfoById(selectedServerId, interaction.user.id);
            if (serverResourceApi.statusCode === HTTP_STATUS_CODES.OK) {
              currentServerResourceInfo = await serverResourceApi.body.json();
            } else {
              currentServerResourceInfo = null;
            }

            currentView = "main";

            await i.update({
              components: [ buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, null, consoleBuffer) ],
              flags: MessageFlags.IsComponentsV2
            });

            connectWebSocket(selectedServerId);
          } else if (i.customId === "server-settings") {
            disconnectWebSocket();

            await i.deferUpdate();

            let isSuspended = false;
            const serverResourceApi = await getServerResourceInfoById(currentSelectedServer.attributes.identifier, interaction.user.id);
            if (serverResourceApi.statusCode === HTTP_STATUS_CODES.OK) {
              currentServerResourceInfo = await serverResourceApi.body.json();
              isSuspended = currentServerResourceInfo?.attributes?.is_suspended || false;
            } else if (serverResourceApi.statusCode === HTTP_STATUS_CODES.CONFLICT) {
              isSuspended = true;
              currentServerResourceInfo = null;
            }

            currentView = "settings";

            await i.editReply({
              components: [ buildSettingsView(currentSelectedServer.attributes.name, isSuspended) ],
              flags: MessageFlags.IsComponentsV2
            });
          } else if ([ "power-start", "power-restart", "power-stop" ].includes(i.customId)) {
            const action = i.customId.replace("power-", "");
            logMenuAction(i, i.customId);
            await i.deferUpdate();

            const apiResult = await setServerPowerState(
              currentSelectedServer.attributes.identifier,
              interaction.user.id,
              action
            );

            const message = apiResult.statusCode === HTTP_STATUS_CODES.NO_CONTENT
              ? `${action.charAt(0).toUpperCase() + action.slice(1)} command sent.`
              : `Failed to send ${action} command (status ${apiResult.statusCode}).`;

            await i.editReply({
              components: [ buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, message, consoleBuffer) ],
              flags: MessageFlags.IsComponentsV2
            });

            connectWebSocket(currentSelectedServer.attributes.identifier);
          } else if (i.customId === "edit-server-name") {
            const nameModal = new ModalBuilder()
              .setCustomId("edit-name-modal")
              .setTitle("Edit Server Name");

            const nameInput = new TextInputBuilder()
              .setCustomId("server-name-input")
              .setLabel("Server Name")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("Enter new server name")
              .setValue(currentSelectedServer.attributes.name)
              .setRequired(true)
              .setMaxLength(50);

            nameModal.addComponents(
              new ActionRowBuilder().addComponents(nameInput)
            );

            await i.showModal(nameModal);

            try {
              const modalSubmit = await i.awaitModalSubmit({
                filter: interaction => interaction.customId === "edit-name-modal" && interaction.user.id === i.user.id,
                time: 300000
              });

              await modalSubmit.deferUpdate();

              const newName = modalSubmit.fields.getTextInputValue("server-name-input").trim();
              logMenuAction(i, "edit-server-name:submit", `new name: ${newName}`);

              if (!newName || newName.length === 0) {
                await modalSubmit.editReply({
                  components: [ buildModalErrorView(getErrorMessage("INVALID_SERVER_NAME")) ],
                  flags: MessageFlags.IsComponentsV2
                });
                return;
              }

              const updateStatusCode = await editServerInfo(
                currentSelectedServer.attributes.internal_id,
                "name",
                newName
              );

              let message;
              if (updateStatusCode === HTTP_STATUS_CODES.OK) {
                message = `Server name updated to **${newName}**.`;
                await refreshCurrentServer(currentSelectedServer.attributes.identifier);
              } else {
                message = getErrorMessage("SERVER_NAME_UPDATE_FAILED");
              }

              currentView = "main";

              await modalSubmit.editReply({
                components: [ buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, message, consoleBuffer) ],
                flags: MessageFlags.IsComponentsV2
              });

              connectWebSocket(currentSelectedServer.attributes.identifier);
            } catch (error) {
              msgLog.error(`Name edit modal error: ${error.message}`);
            }
          } else if (i.customId === "edit-server-memory") {
            const memoryModal = new ModalBuilder()
              .setCustomId("edit-memory-modal")
              .setTitle("Edit Server Memory");

            const memoryInput = new TextInputBuilder()
              .setCustomId("server-memory-input")
              .setLabel("Memory (MB)")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("Enter memory in MB")
              .setValue(currentSelectedServer.attributes.limits.memory.toString())
              .setRequired(true);

            memoryModal.addComponents(
              new ActionRowBuilder().addComponents(memoryInput)
            );

            await i.showModal(memoryModal);

            try {
              const modalSubmit = await i.awaitModalSubmit({
                filter: interaction => interaction.customId === "edit-memory-modal" && interaction.user.id === i.user.id,
                time: 300000
              });

              await modalSubmit.deferUpdate();

              const newMemoryStr = modalSubmit.fields.getTextInputValue("server-memory-input").trim();
              logMenuAction(i, "edit-server-memory:submit", `new memory: ${newMemoryStr} MB`);
              const newMemory = parseInt(newMemoryStr);

              if (isNaN(newMemory) || newMemory <= 0) {
                await modalSubmit.editReply({
                  components: [ buildModalErrorView(getErrorMessage("INVALID_MEMORY_VALUE")) ],
                  flags: MessageFlags.IsComponentsV2
                });
                return;
              }

              const updateStatusCode = await editServerInfo(
                currentSelectedServer.attributes.internal_id,
                "memory",
                newMemory
              );

              let message;
              if (updateStatusCode === HTTP_STATUS_CODES.OK) {
                message = `Server memory updated to **${newMemory} MB**.`;
                await refreshCurrentServer(currentSelectedServer.attributes.identifier);
              } else {
                message = getErrorMessage("SERVER_MEMORY_UPDATE_FAILED");
              }

              currentView = "main";

              await modalSubmit.editReply({
                components: [ buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, message, consoleBuffer) ],
                flags: MessageFlags.IsComponentsV2
              });

              connectWebSocket(currentSelectedServer.attributes.identifier);
            } catch (error) {
              msgLog.error(`Memory edit modal error: ${error.message}`);
            }
          } else if (i.customId === "suspend-server") {
            logMenuAction(i, "suspend-server");
            await i.deferUpdate();

            const serverIsSuspended = await isServerSuspended(currentSelectedServer.attributes.identifier, interaction.user.id);

            if (serverIsSuspended) {
              await i.editReply({
                components: [ buildModalErrorView(`\`${currentSelectedServer.attributes.name}\`\n\n${getErrorMessage("SERVER_SUSPEND_FAILED_ALREADY_SUSPENDED")}`) ],
                flags: MessageFlags.IsComponentsV2
              });
              return;
            }

            const suspensionStatusCode = await suspendServer(currentSelectedServer.attributes.internal_id);

            const selectedServerId = currentSelectedServer.attributes.identifier;
            await refreshCurrentServer(selectedServerId);

            const serverResourceApi = await getServerResourceInfoById(selectedServerId, interaction.user.id);
            if (serverResourceApi.statusCode === HTTP_STATUS_CODES.OK) {
              currentServerResourceInfo = await serverResourceApi.body.json();
            } else {
              currentServerResourceInfo = null;
            }

            const message = suspensionStatusCode === HTTP_STATUS_CODES.NO_CONTENT
              ? "Server suspended."
              : getErrorMessage("SERVER_SUSPEND_FAILED");

            currentView = "main";

            await i.editReply({
              components: [ buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, message, consoleBuffer) ],
              flags: MessageFlags.IsComponentsV2
            });

            disconnectWebSocket();
          } else if (i.customId === "unsuspend-server") {
            logMenuAction(i, "unsuspend-server");
            await i.deferUpdate();

            const serverIsSuspended = await isServerSuspended(currentSelectedServer.attributes.identifier, interaction.user.id);

            if (!serverIsSuspended) {
              await i.editReply({
                components: [ buildModalErrorView(`\`${currentSelectedServer.attributes.name}\`\n\n${getErrorMessage("SERVER_UNSUSPEND_FAILED_ALREADY_ACTIVE")}`) ],
                flags: MessageFlags.IsComponentsV2
              });
              return;
            }

            const serverMemory = currentSelectedServer.attributes.limits.memory;
            const availableMemory = await getAvailableUserMemory(getUserId(interaction.user.id), interaction.user.id);

            if (availableMemory !== -1 && availableMemory - serverMemory < 0) {
              const memoryToFree = (availableMemory - serverMemory) * -1;
              await i.editReply({
                components: [ buildModalErrorView(`\`${currentSelectedServer.attributes.name}\`\n\n${getErrorMessage("SERVER_UNSUSPENSION_FAILED_MEMORY", memoryToFree)}`) ],
                flags: MessageFlags.IsComponentsV2
              });
              return;
            }

            const suspensionStatusCode = await unsuspendServer(currentSelectedServer.attributes.internal_id);

            const selectedServerId = currentSelectedServer.attributes.identifier;
            await refreshCurrentServer(selectedServerId);

            const serverResourceApi = await getServerResourceInfoById(selectedServerId, interaction.user.id);
            if (serverResourceApi.statusCode === HTTP_STATUS_CODES.OK) {
              currentServerResourceInfo = await serverResourceApi.body.json();
            } else {
              currentServerResourceInfo = null;
            }

            const message = suspensionStatusCode === HTTP_STATUS_CODES.NO_CONTENT
              ? "Server unsuspended."
              : getErrorMessage("SERVER_UNSUSPEND_FAILED");

            currentView = "main";

            await i.editReply({
              components: [ buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, message, consoleBuffer) ],
              flags: MessageFlags.IsComponentsV2
            });

            connectWebSocket(currentSelectedServer.attributes.identifier);
          } else if (i.customId === "delete-server") {
            await i.deferUpdate();

            const confirmContainer = new ContainerBuilder()
              .setAccentColor(COLORS.PRIMARY)
              .addTextDisplayComponents(text =>
                text.setContent(
                  "**Delete Server**\n\n" +
                  `Are you sure you want to delete \`${currentSelectedServer.attributes.name}\`?\n\n` +
                  "**This action cannot be undone!**\n" +
                  "All server data will be permanently lost.\n" +
                  "If you are just trying to free up memory, consider suspending the server instead."
                )
              )
              .addSeparatorComponents(separator => separator)
              .addActionRowComponents(actionRow =>
                actionRow.setComponents(
                  new ButtonBuilder().setCustomId("confirm-delete").setLabel("Yes, Delete Server").setStyle(ButtonStyle.Danger),
                  new ButtonBuilder().setCustomId("cancel-delete").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
                )
              );

            await i.editReply({
              components: [ confirmContainer ],
              flags: MessageFlags.IsComponentsV2
            });
          } else if (i.customId === "confirm-delete") {
            logMenuAction(i, "delete-server:confirmed");
            await i.deferUpdate();

            const deletingContainer = new ContainerBuilder()
              .setAccentColor(COLORS.PRIMARY)
              .addTextDisplayComponents(text =>
                text.setContent("**Deleting Server...**\n\nPlease wait.")
              );

            await i.editReply({
              components: [ deletingContainer ],
              flags: MessageFlags.IsComponentsV2
            });

            const deleteStatusCode = await deleteServer(currentSelectedServer.attributes.internal_id);

            let resultContainer;
            if (deleteStatusCode === HTTP_STATUS_CODES.NO_CONTENT) {
              const serverIndex = serverObjects.data.findIndex(
                server => server.attributes.identifier === currentSelectedServer.attributes.identifier
              );
              if (serverIndex !== -1) {
                serverObjects.data.splice(serverIndex, 1);
              }

              resultContainer = new ContainerBuilder()
                .setAccentColor(COLORS.PRIMARY)
                .addTextDisplayComponents(text =>
                  text.setContent(`**Server Deleted**\n\n\`${currentSelectedServer.attributes.name}\` has been permanently deleted.`)
                );

              currentSelectedServer = null;
              currentServerResourceInfo = null;
              currentView = "main";
            } else {
              resultContainer = new ContainerBuilder()
                .setAccentColor(COLORS.PRIMARY)
                .addTextDisplayComponents(text =>
                  text.setContent(`**Server Deletion Failed**\n\n${getErrorMessage("SERVER_DELETE_FAILED")}`)
                )
                .addSeparatorComponents(separator => separator)
                .addActionRowComponents(actionRow =>
                  actionRow.setComponents(
                    new ButtonBuilder().setCustomId("back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                  )
                );
            }

            await i.editReply({
              components: [ resultContainer ],
              flags: MessageFlags.IsComponentsV2
            });

            if (deleteStatusCode === HTTP_STATUS_CODES.NO_CONTENT) {
              collector.stop("deleted");
            }
          } else if (i.customId === "cancel-delete") {
            await i.deferUpdate();

            let isSuspended = false;
            const serverResourceApi = await getServerResourceInfoById(currentSelectedServer.attributes.identifier, interaction.user.id);
            if (serverResourceApi.statusCode === HTTP_STATUS_CODES.OK) {
              currentServerResourceInfo = await serverResourceApi.body.json();
              isSuspended = currentServerResourceInfo?.attributes?.is_suspended || false;
            } else if (serverResourceApi.statusCode === HTTP_STATUS_CODES.CONFLICT) {
              isSuspended = true;
              currentServerResourceInfo = null;
            }

            await i.editReply({
              components: [ buildSettingsView(currentSelectedServer.attributes.name, isSuspended) ],
              flags: MessageFlags.IsComponentsV2
            });
          } else if (i.customId === "console-view") {
            await i.deferUpdate();
            currentView = "console";
            await interaction.editReply({
              components: [ buildConsoleView(currentSelectedServer.attributes.name, consoleBuffer) ],
              flags: MessageFlags.IsComponentsV2
            });
          } else if (i.customId === "send-command") {
            const cmdModal = new ModalBuilder()
              .setCustomId("send-command-modal")
              .setTitle("Send Console Command")
              .addComponents(
                new ActionRowBuilder().addComponents(
                  new TextInputBuilder()
                    .setCustomId("command-input")
                    .setLabel("Command")
                    .setStyle(TextInputStyle.Short)
                    .setMaxLength(512)
                    .setRequired(true)
                )
              );

            await i.showModal(cmdModal);

            const submitted = await i.awaitModalSubmit({ time: 60_000 }).catch(() => null);
            if (!submitted) return;
            await submitted.deferUpdate();
            const cmd = submitted.fields.getTextInputValue("command-input").trim();
            if (activeWs) activeWs.sendCommand(cmd);
          } else if (i.customId === "back") {
            currentView = "main";

            await i.update({
              components: [ buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, null, consoleBuffer) ],
              flags: MessageFlags.IsComponentsV2
            });

            connectWebSocket(currentSelectedServer.attributes.identifier);
          }
        } catch (error) {
          msgLog.error(`Error handling interaction: ${error.message}`);
          const errorResponse = {
            content: "An error occurred while processing your request.",
            ephemeral: true
          };

          if (i.replied || i.deferred) {
            await i.followUp(errorResponse).catch(() => {});
          } else {
            await i.reply(errorResponse).catch(() => {});
          }
        }
      });

      collector.on("end", async (collected, reason) => {
        disconnectWebSocket();

        if (reason === "idle") {
          await interaction.editReply({
            components: [ createDisabledMenu("USER_TIMEOUT") ],
            flags: MessageFlags.IsComponentsV2
          }).catch(() => {});
        } else if (reason === "unauthorized") {
          await interaction.editReply({
            components: [ createDisabledMenu("CLIENT_API_FAILURE") ],
            flags: MessageFlags.IsComponentsV2
          }).catch(() => {});
        }
      });
    } catch (error) {
      msgLog.error(`Error in edit server command: ${error.message}`);
      const errorMessage = {
        content: "An error occurred while loading the server menu.",
        ephemeral: true
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorMessage).catch(() => {});
      } else {
        await interaction.reply(errorMessage).catch(() => {});
      }
    }
  }
};
