const { ContainerBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require("discord.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const msgLog = require("../../utility/logger.js");
const { getUserId, reconstructCommand, userHasClientApiKey } = require("../../utility/helper_functions.js");
const { getClientServers, setServerPowerState, getServerInfoById, getServerResourceInfoById, isServerSuspended, suspendServer, unsuspendServer, getAvailableUserMemory, deleteServer, editServerInfo } = require("../../utility/server_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");

const COLORS = {
  PRIMARY: 0x6b34eb,
  DISABLED: 0x808080
};

const COLLECTOR_IDLE_TIMEOUT = 300_000;

const AUTO_REFRESH_INTERVALS = {
  RUNNING: 5000,
  OFFLINE: null,
  SUSPENDED: null
};

const POWER_ACTION_CONFIG = {
  MAX_ATTEMPTS: 30,
  POLL_INTERVAL: 1000
};

const HTTP_STATUS_CODES = {
  OK: 200,
  NO_CONTENT: 204,
  UNAUTHORIZED: 401,
  CONFLICT: 409
};

const UNIT_CONVERSIONS = {
  BYTES_TO_MB: 1_000_000,
  BYTES_TO_GB: 1_000_000_000
};

function buildServerSelectMenu(serverObjects, selectedServerId = null, disabled = false) {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("server-selection")
    .setPlaceholder(disabled ? "Session ended" : "Select a server")
    .setDisabled(disabled);

  if (serverObjects && serverObjects.data && serverObjects.data.length > 0) {
    for (const server of serverObjects.data) {
      selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(server.attributes.name)
          .setDescription(`ID: ${server.attributes.identifier}`)
          .setValue(server.attributes.identifier)
          .setDefault(Boolean(selectedServerId && server.attributes.identifier === selectedServerId))
      );
    }
  } else {
    selectMenu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(disabled ? "No servers" : "No servers found")
        .setDescription(disabled ? undefined : "No servers available")
        .setValue("none")
    );
  }

  return selectMenu;
}

function buildMainServerView(serverObjects, currentSelectedServer, serverResourceInfo = null, statusMessage = null) {
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
    let detailsText = "";

    if (serverResourceInfo && serverResourceInfo.attributes) {
      const memUsageMB = (serverResourceInfo.attributes.resources.memory_bytes / UNIT_CONVERSIONS.BYTES_TO_MB).toFixed(0);
      const diskUsageGB = (serverResourceInfo.attributes.resources.disk_bytes / UNIT_CONVERSIONS.BYTES_TO_GB).toFixed(2);
      const cpuUsage = (serverResourceInfo.attributes.resources.cpu_absolute).toFixed(2);
      const state = serverResourceInfo.attributes.is_suspended
        ? "Suspended"
        : `Active, ${serverResourceInfo.attributes.current_state}`;

      detailsText = `**Status:** ${state}\n` +
                `**ID:** \`${currentSelectedServer.attributes.identifier}\`\n` +
                `**Memory:** ${memUsageMB}/${currentSelectedServer.attributes.limits.memory} MB\n` +
                `**Disk:** ${diskUsageGB} GB\n` +
                `**CPU Threads:** ${cpuUsage}/${(currentSelectedServer.attributes.limits.cpu).toFixed(2)}%\n` +
                `**Node:** ${currentSelectedServer.attributes.node}`;
    } else {
      detailsText = "**Status:** Suspended\n" +
                `**ID:** \`${currentSelectedServer.attributes.identifier}\`\n` +
                `**Memory Limit:** ${currentSelectedServer.attributes.limits.memory} MB\n` +
                `**Node:** ${currentSelectedServer.attributes.node}`;
    }

    if (statusMessage) {
      detailsText += `\n\n${statusMessage}`;
    }

    const isSuspended = !serverResourceInfo;

    container
      .addTextDisplayComponents(text =>
        text.setContent(detailsText)
      )
      .addSeparatorComponents(separator => separator)
      .addActionRowComponents(actionRow =>
        actionRow.setComponents(
          new ButtonBuilder().setCustomId("server-settings").setLabel("Server Settings").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("refresh").setLabel("Refresh").setStyle(ButtonStyle.Secondary)
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

async function handlePowerAction(action, server, userId, updateLoadingMessage) {
  try {
    const apiResult = await setServerPowerState(
      server.attributes.identifier,
      userId,
      action
    );

    if (apiResult.statusCode !== HTTP_STATUS_CODES.NO_CONTENT) {
      return {
        success: false,
        message: `Server ${action} command returned status code: ${apiResult.statusCode}`
      };
    }

    const expectedStates = {
      "start": [ "running" ],
      "restart": [ "running" ],
      "stop": [ "offline" ]
    };

    const actionVerbs = {
      "start": "Starting",
      "restart": "Restarting",
      "stop": "Stopping"
    };

    const targetStates = expectedStates[action];
    const maxAttempts = POWER_ACTION_CONFIG.MAX_ATTEMPTS;
    const pollInterval = POWER_ACTION_CONFIG.POLL_INTERVAL;
    const verb = actionVerbs[action] || action;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const dots = ".".repeat((attempt % 3) + 1);
      if (updateLoadingMessage) {
        await updateLoadingMessage(`${verb} server${dots}`);
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));

      const resourceApi = await getServerResourceInfoById(server.attributes.identifier, userId);
      if (resourceApi.statusCode === HTTP_STATUS_CODES.OK) {
        const resourceData = await resourceApi.body.json();
        const currentState = resourceData.attributes.current_state;

        if (targetStates.includes(currentState)) {
          return {
            success: true,
            message: `Server ${action} completed successfully!`,
            resourceInfo: resourceData
          };
        }
      }
    }

    return {
      success: true,
      message: `Server ${action} command sent, but state change is taking longer than expected.\nTry manually refreshing or check the server panel.`,
      timeout: true
    };
  } catch (error) {
    msgLog.error(`Error handling power action ${action}: ${error.message}`);
    return {
      success: false,
      message: `Failed to ${action} server. Please try again.`
    };
  }
}

module.exports = {
  buildServerSelectMenu,
  buildMainServerView,

  data: new SlashCommandBuilder()
    .setName("servers")
    .setDescription("Opens the interactive server management menu."),

  async execute(interaction) {
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);

    const hasReadServers = authenticateUserForPermission(interaction.user.id, PERMISSIONS.READ_SERVERS);
    const hasEditSettings = authenticateUserForPermission(interaction.user.id, PERMISSIONS.EDIT_SERVER_PROPERTIES);

    if (hasReadServers === -1 || hasEditSettings === -1) {
      await interaction.reply(getErrorMessage("USER_NOT_FOUND"));
      return;
    }

    if (!hasReadServers || !hasEditSettings) {
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

      const selectMenu = buildServerSelectMenu(serverObjects);

      const initialContainer = new ContainerBuilder()
        .setAccentColor(COLORS.PRIMARY)
        .addActionRowComponents(actionRow =>
          actionRow.setComponents(selectMenu)
        );

      await interaction.reply({
        components: [ initialContainer ],
        flags: MessageFlags.IsComponentsV2
      });

      const response = await interaction.fetchReply();
      const collector = response.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id,
        idle: COLLECTOR_IDLE_TIMEOUT
      });

      let currentSelectedServer = null;
      let currentServerResourceInfo = null;
      let currentView = "main";
      let autoRefreshInterval = null;

      const clearAutoRefresh = () => {
        if (autoRefreshInterval) {
          clearInterval(autoRefreshInterval);
          autoRefreshInterval = null;
        }
      };

      const startAutoRefresh = async () => {
        clearAutoRefresh();

        if (!currentSelectedServer || currentView !== "main") {
          return;
        }

        const refreshServerInfo = async () => {
          try {
            if (!currentSelectedServer || currentView !== "main") {
              clearAutoRefresh();
              return;
            }

            const selectedServerId = currentSelectedServer.attributes.identifier;
            const serverResourceApi = await getServerResourceInfoById(selectedServerId, interaction.user.id);

            if (serverResourceApi.statusCode === HTTP_STATUS_CODES.OK) {
              const newResourceInfo = await serverResourceApi.body.json();
              currentServerResourceInfo = newResourceInfo;

              const updatedContainer = buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo);

              await interaction.editReply({
                components: [ updatedContainer ],
                flags: MessageFlags.IsComponentsV2
              }).catch(() => {
                clearAutoRefresh();
              });

              const currentState = newResourceInfo.attributes.current_state;
              const isSuspended = newResourceInfo.attributes.is_suspended;
              const currentInterval = currentState === "running"
                ? AUTO_REFRESH_INTERVALS.RUNNING
                : AUTO_REFRESH_INTERVALS.OFFLINE;

              if (isSuspended || currentInterval === null) {
                clearAutoRefresh();
              } else if (autoRefreshInterval && autoRefreshInterval._interval !== currentInterval) {
                clearAutoRefresh();
                autoRefreshInterval = setInterval(refreshServerInfo, currentInterval);
              }
            } else {
              currentServerResourceInfo = null;
              clearAutoRefresh();

              const updatedContainer = buildMainServerView(serverObjects, currentSelectedServer, null);
              await interaction.editReply({
                components: [ updatedContainer ],
                flags: MessageFlags.IsComponentsV2
              }).catch(() => {});
            }
          } catch (error) {
            msgLog.error(`Auto-refresh error: ${error.message}`);
            clearAutoRefresh();
          }
        };

        let refreshInterval = AUTO_REFRESH_INTERVALS.OFFLINE;

        if (currentServerResourceInfo) {
          const isSuspended = currentServerResourceInfo.attributes.is_suspended;
          if (isSuspended) {
            return;
          }

          const currentState = currentServerResourceInfo.attributes.current_state;
          refreshInterval = currentState === "running"
            ? AUTO_REFRESH_INTERVALS.RUNNING
            : AUTO_REFRESH_INTERVALS.OFFLINE;
        }

        if (refreshInterval !== null) {
          autoRefreshInterval = setInterval(refreshServerInfo, refreshInterval);
        }
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
                new ButtonBuilder().setCustomId("server-settings").setLabel("Server Settings").setStyle(ButtonStyle.Primary).setDisabled(true),
                new ButtonBuilder().setCustomId("refresh").setLabel("Refresh").setStyle(ButtonStyle.Secondary).setDisabled(true)
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

      collector.on("collect", async i => {
        try {
          if (i.customId === "server-selection") {
            clearAutoRefresh();

            const selectedServerId = i.values[0];
            msgLog.debugExtended(`${i.user.username}/${i.user.id} | [servers] select-server | ${selectedServerId}`);

            const selectedServerObject = await getServerInfoById(selectedServerId, interaction.user.id);

            if (selectedServerObject.statusCode === HTTP_STATUS_CODES.UNAUTHORIZED) {
              collector.stop("unauthorized");
              return;
            }

            const selectedServer = serverObjects.data.find(
              server => server.attributes.identifier === selectedServerId
            );

            currentSelectedServer = selectedServer;

            const serverResourceApi = await getServerResourceInfoById(selectedServerId, interaction.user.id);
            if (serverResourceApi.statusCode === HTTP_STATUS_CODES.OK) {
              currentServerResourceInfo = await serverResourceApi.body.json();
            } else {
              currentServerResourceInfo = null;
            }

            const updatedContainer = buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo);

            currentView = "main";

            await i.update({
              components: [ updatedContainer ],
              flags: MessageFlags.IsComponentsV2
            });

            startAutoRefresh();
          } else if (i.customId === "server-settings") {
            clearAutoRefresh();

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

            const settingsContainer = new ContainerBuilder()
              .setAccentColor(COLORS.PRIMARY)
              .addActionRowComponents(actionRow =>
                actionRow.setComponents(
                  new ButtonBuilder().setCustomId("back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                )
              )
              .addTextDisplayComponents(text =>
                text.setContent(`**${currentSelectedServer.attributes.name}** settings\n\n`)
              )
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

            currentView = "settings";

            await i.editReply({
              components: [ settingsContainer ],
              flags: MessageFlags.IsComponentsV2
            });
          } else if (i.customId === "power-start") {
            logMenuAction(i, "power-start");
            await i.deferUpdate();

            const loadingContainer = buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, "Starting server.");
            await i.editReply({
              components: [ loadingContainer ],
              flags: MessageFlags.IsComponentsV2
            });

            const updateLoadingMessage = async message => {
              const updatedLoadingContainer = buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, message);
              await i.editReply({
                components: [ updatedLoadingContainer ],
                flags: MessageFlags.IsComponentsV2
              }).catch(() => {});
            };

            const result = await handlePowerAction("start", currentSelectedServer, interaction.user.id, updateLoadingMessage);

            if (result.resourceInfo) {
              currentServerResourceInfo = result.resourceInfo;
            }

            const statusMessage = result.success ? `${result.message}` : `${result.message}`;
            const updatedContainer = buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, statusMessage);

            await i.editReply({
              components: [ updatedContainer ],
              flags: MessageFlags.IsComponentsV2
            });

            startAutoRefresh();
          } else if (i.customId === "power-restart") {
            logMenuAction(i, "power-restart");
            await i.deferUpdate();

            const loadingContainer = buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, "Restarting server.");
            await i.editReply({
              components: [ loadingContainer ],
              flags: MessageFlags.IsComponentsV2
            });

            const updateLoadingMessage = async message => {
              const updatedLoadingContainer = buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, message);
              await i.editReply({
                components: [ updatedLoadingContainer ],
                flags: MessageFlags.IsComponentsV2
              }).catch(() => {});
            };

            const result = await handlePowerAction("restart", currentSelectedServer, interaction.user.id, updateLoadingMessage);

            if (result.resourceInfo) {
              currentServerResourceInfo = result.resourceInfo;
            }

            const statusMessage = result.success ? `${result.message}` : `${result.message}`;
            const updatedContainer = buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, statusMessage);

            await i.editReply({
              components: [ updatedContainer ],
              flags: MessageFlags.IsComponentsV2
            });

            startAutoRefresh();
          } else if (i.customId === "power-stop") {
            logMenuAction(i, "power-stop");
            await i.deferUpdate();

            const loadingContainer = buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, "Stopping server.");
            await i.editReply({
              components: [ loadingContainer ],
              flags: MessageFlags.IsComponentsV2
            });

            const updateLoadingMessage = async message => {
              const updatedLoadingContainer = buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, message);
              await i.editReply({
                components: [ updatedLoadingContainer ],
                flags: MessageFlags.IsComponentsV2
              }).catch(() => {});
            };

            const result = await handlePowerAction("stop", currentSelectedServer, interaction.user.id, updateLoadingMessage);

            if (result.resourceInfo) {
              currentServerResourceInfo = result.resourceInfo;
            }

            const statusMessage = result.success ? `${result.message}` : `${result.message}`;
            const updatedContainer = buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, statusMessage);

            await i.editReply({
              components: [ updatedContainer ],
              flags: MessageFlags.IsComponentsV2
            });

            startAutoRefresh();
          } else if (i.customId === "refresh") {
            await i.deferUpdate();

            const selectedServerId = currentSelectedServer.attributes.identifier;
            const selectedServerObject = await getServerInfoById(selectedServerId, interaction.user.id);

            if (selectedServerObject.statusCode === HTTP_STATUS_CODES.OK) {
              const updatedServerData = await selectedServerObject.body.json();
              const serverIndex = serverObjects.data.findIndex(
                server => server.attributes.identifier === selectedServerId
              );
              if (serverIndex !== -1) {
                serverObjects.data[serverIndex] = updatedServerData;
                currentSelectedServer = updatedServerData;
              }
            }

            const serverResourceApi = await getServerResourceInfoById(selectedServerId, interaction.user.id);
            if (serverResourceApi.statusCode === HTTP_STATUS_CODES.OK) {
              currentServerResourceInfo = await serverResourceApi.body.json();
            } else {
              currentServerResourceInfo = null;
            }

            const refreshedContainer = buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo);

            await i.editReply({
              components: [ refreshedContainer ],
              flags: MessageFlags.IsComponentsV2
            });

            startAutoRefresh();
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
                const errorContainer = new ContainerBuilder()
                  .setAccentColor(COLORS.PRIMARY)
                  .addActionRowComponents(actionRow =>
                    actionRow.setComponents(
                      new ButtonBuilder().setCustomId("back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                    )
                  )
                  .addTextDisplayComponents(text =>
                    text.setContent(`**Server Settings**\n\n${getErrorMessage("INVALID_SERVER_NAME")}`)
                  );

                await modalSubmit.editReply({
                  components: [ errorContainer ],
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
                message = `Server name updated to **${newName}**!`;

                const selectedServerId = currentSelectedServer.attributes.identifier;
                const selectedServerObject = await getServerInfoById(selectedServerId, interaction.user.id);

                if (selectedServerObject.statusCode === HTTP_STATUS_CODES.OK) {
                  const updatedServerData = await selectedServerObject.body.json();
                  const serverIndex = serverObjects.data.findIndex(
                    server => server.attributes.identifier === selectedServerId
                  );
                  if (serverIndex !== -1) {
                    serverObjects.data[serverIndex] = updatedServerData;
                    currentSelectedServer = updatedServerData;
                  }
                }
              } else {
                message = getErrorMessage("SERVER_NAME_UPDATE_FAILED");
              }

              const resultContainer = buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, message);

              currentView = "main";

              await modalSubmit.editReply({
                components: [ resultContainer ],
                flags: MessageFlags.IsComponentsV2
              });

              startAutoRefresh();
            } catch (error) {
              msgLog.error(`Name edit modal error: ${error.message}`);
            }
          } else if (i.customId === "edit-server-memory") {
            const memoryModal = new ModalBuilder()
              .setCustomId("edit-memory-modal")
              .setTitle("Edit Server Memory");

            const currentMemoryMB = currentSelectedServer.attributes.limits.memory;

            const memoryInput = new TextInputBuilder()
              .setCustomId("server-memory-input")
              .setLabel("Memory (MB)")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("Enter memory in MB")
              .setValue(currentMemoryMB.toString())
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
                const errorContainer = new ContainerBuilder()
                  .setAccentColor(COLORS.PRIMARY)
                  .addActionRowComponents(actionRow =>
                    actionRow.setComponents(
                      new ButtonBuilder().setCustomId("back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                    )
                  )
                  .addTextDisplayComponents(text =>
                    text.setContent(`**Server Settings**\n\n${getErrorMessage("INVALID_MEMORY_VALUE")}`)
                  );

                await modalSubmit.editReply({
                  components: [ errorContainer ],
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
                message = `Server memory updated to **${newMemory} MB**!`;

                const selectedServerId = currentSelectedServer.attributes.identifier;
                const selectedServerObject = await getServerInfoById(selectedServerId, interaction.user.id);

                if (selectedServerObject.statusCode === HTTP_STATUS_CODES.OK) {
                  const updatedServerData = await selectedServerObject.body.json();
                  const serverIndex = serverObjects.data.findIndex(
                    server => server.attributes.identifier === selectedServerId
                  );
                  if (serverIndex !== -1) {
                    serverObjects.data[serverIndex] = updatedServerData;
                    currentSelectedServer = updatedServerData;
                  }
                }
              } else {
                message = getErrorMessage("SERVER_MEMORY_UPDATE_FAILED");
              }

              const resultContainer = buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, message);

              currentView = "main";

              await modalSubmit.editReply({
                components: [ resultContainer ],
                flags: MessageFlags.IsComponentsV2
              });

              startAutoRefresh();
            } catch (error) {
              msgLog.error(`Memory edit modal error: ${error.message}`);
            }
          } else if (i.customId === "suspend-server") {
            logMenuAction(i, "suspend-server");
            await i.deferUpdate();

            const serverIsSuspended = await isServerSuspended(currentSelectedServer.attributes.identifier, interaction.user.id);

            if (serverIsSuspended) {
              const errorContainer = new ContainerBuilder()
                .setAccentColor(COLORS.PRIMARY)
                .addActionRowComponents(actionRow =>
                  actionRow.setComponents(
                    new ButtonBuilder().setCustomId("back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                  )
                )
                .addTextDisplayComponents(text =>
                  text.setContent(`**Server Settings**\n\n\`${currentSelectedServer.attributes.name}\`\n\n${getErrorMessage("SERVER_SUSPEND_FAILED_ALREADY_SUSPENDED")}`)
                );

              await i.editReply({
                components: [ errorContainer ],
                flags: MessageFlags.IsComponentsV2
              });
              return;
            }

            const suspensionStatusCode = await suspendServer(currentSelectedServer.attributes.internal_id);

            const selectedServerId = currentSelectedServer.attributes.identifier;
            const selectedServerObject = await getServerInfoById(selectedServerId, interaction.user.id);

            if (selectedServerObject.statusCode === HTTP_STATUS_CODES.OK) {
              const updatedServerData = await selectedServerObject.body.json();
              const serverIndex = serverObjects.data.findIndex(
                server => server.attributes.identifier === selectedServerId
              );
              if (serverIndex !== -1) {
                serverObjects.data[serverIndex] = updatedServerData;
                currentSelectedServer = updatedServerData;
              }
            }

            const serverResourceApi = await getServerResourceInfoById(selectedServerId, interaction.user.id);
            if (serverResourceApi.statusCode === HTTP_STATUS_CODES.OK) {
              currentServerResourceInfo = await serverResourceApi.body.json();
            } else {
              currentServerResourceInfo = null;
            }

            const message = suspensionStatusCode === HTTP_STATUS_CODES.NO_CONTENT
              ? "Server suspended successfully!"
              : getErrorMessage("SERVER_SUSPEND_FAILED");

            const resultContainer = buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, message);

            currentView = "main";

            await i.editReply({
              components: [ resultContainer ],
              flags: MessageFlags.IsComponentsV2
            });

            clearAutoRefresh();
          } else if (i.customId === "unsuspend-server") {
            logMenuAction(i, "unsuspend-server");
            await i.deferUpdate();

            const serverIsSuspended = await isServerSuspended(currentSelectedServer.attributes.identifier, interaction.user.id);

            if (!serverIsSuspended) {
              const errorContainer = new ContainerBuilder()
                .setAccentColor(COLORS.PRIMARY)
                .addActionRowComponents(actionRow =>
                  actionRow.setComponents(
                    new ButtonBuilder().setCustomId("back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                  )
                )
                .addTextDisplayComponents(text =>
                  text.setContent(`**Server Settings**\n\n\`${currentSelectedServer.attributes.name}\`\n\n${getErrorMessage("SERVER_UNSUSPEND_FAILED_ALREADY_ACTIVE")}`)
                );

              await i.editReply({
                components: [ errorContainer ],
                flags: MessageFlags.IsComponentsV2
              });
              return;
            }

            const serverMemory = currentSelectedServer.attributes.limits.memory;
            const availableMemory = await getAvailableUserMemory(getUserId(interaction.user.id), interaction.user.id);

            if (availableMemory !== -1 && availableMemory - serverMemory < 0) {
              const memoryToFree = (availableMemory - serverMemory) * -1;
              const errorContainer = new ContainerBuilder()
                .setAccentColor(COLORS.PRIMARY)
                .addActionRowComponents(actionRow =>
                  actionRow.setComponents(
                    new ButtonBuilder().setCustomId("back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                  )
                )
                .addTextDisplayComponents(text =>
                  text.setContent(`**Server Settings**\n\n\`${currentSelectedServer.attributes.name}\`\n\n${getErrorMessage("SERVER_UNSUSPENSION_FAILED_MEMORY", memoryToFree)}`)
                );

              await i.editReply({
                components: [ errorContainer ],
                flags: MessageFlags.IsComponentsV2
              });
              return;
            }

            const suspensionStatusCode = await unsuspendServer(currentSelectedServer.attributes.internal_id);

            const selectedServerId = currentSelectedServer.attributes.identifier;
            const selectedServerObject = await getServerInfoById(selectedServerId, interaction.user.id);

            if (selectedServerObject.statusCode === HTTP_STATUS_CODES.OK) {
              const updatedServerData = await selectedServerObject.body.json();
              const serverIndex = serverObjects.data.findIndex(
                server => server.attributes.identifier === selectedServerId
              );
              if (serverIndex !== -1) {
                serverObjects.data[serverIndex] = updatedServerData;
                currentSelectedServer = updatedServerData;
              }
            }

            const serverResourceApi = await getServerResourceInfoById(selectedServerId, interaction.user.id);
            if (serverResourceApi.statusCode === HTTP_STATUS_CODES.OK) {
              currentServerResourceInfo = await serverResourceApi.body.json();
            } else {
              currentServerResourceInfo = null;
            }

            const message = suspensionStatusCode === HTTP_STATUS_CODES.NO_CONTENT
              ? "Server unsuspended successfully!"
              : getErrorMessage("SERVER_UNSUSPEND_FAILED");

            const resultContainer = buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo, message);

            currentView = "main";

            await i.editReply({
              components: [ resultContainer ],
              flags: MessageFlags.IsComponentsV2
            });

            startAutoRefresh();
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
                  text.setContent(`**Server Deleted Successfully**\n\n\`${currentSelectedServer.attributes.name}\` has been permanently deleted.`)
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

            const settingsContainer = new ContainerBuilder()
              .setAccentColor(COLORS.PRIMARY)
              .addActionRowComponents(actionRow =>
                actionRow.setComponents(
                  new ButtonBuilder().setCustomId("back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                )
              )
              .addSeparatorComponents(separator => separator)
              .addTextDisplayComponents(text =>
                text.setContent(`**${currentSelectedServer.attributes.name}** settings\n\n`)
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

            await i.editReply({
              components: [ settingsContainer ],
              flags: MessageFlags.IsComponentsV2
            });
          } else if (i.customId === "back") {
            const backContainer = buildMainServerView(serverObjects, currentSelectedServer, currentServerResourceInfo);

            currentView = "main";

            await i.update({
              components: [ backContainer ],
              flags: MessageFlags.IsComponentsV2
            });

            startAutoRefresh();
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
        clearAutoRefresh();

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
