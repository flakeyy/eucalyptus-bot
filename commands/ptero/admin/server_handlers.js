const {
  ContainerBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder
} = require("discord.js");
const msgLog = require("../../../utility/logger.js");
const db = require("../../../utility/database.js");
const { userHasClientApiKey, applicationApiCall } = require("../../../utility/helper_functions.js");
const {
  getClientServers,
  setServerPowerState,
  getServerInfoById,
  getServerResourceInfoById,
  isServerSuspended,
  suspendServer,
  unsuspendServer,
  deleteServer,
  editServerInfo
} = require("../../../utility/server_functions.js");
const { PterodactylWebSocket } = require("../../../utility/pterodactyl_websocket.js");
const { getErrorMessage } = require("../../../utility/error_messages.js");
const { COLORS, HTTP_STATUS_CODES, COLLECTOR_IDLE_TIMEOUT, WS_THROTTLE_MS, CONSOLE_MAX_LINES } = require("../../../utility/constants.js");
const { POWER_ACTION_CONFIG, SERVERS_PER_PAGE } = require("./constants.js");
const { requireDbUser, denyIfImmune, refreshServerInState, fetchResourceInfo } = require("./helpers.js");
const {
  buildAdminMainView,
  buildAdminConsoleView,
  buildAdminSettingsView,
  createDisabledAdminMenu,
  buildServerListView
} = require("./views.js");

// Sends a power action, then polls the server's resource state until it reaches
// the expected state (admin gets live feedback rather than fire-and-forget).
async function handleAdminPowerAction(action, server, targetDiscordId, updateLoadingMessage) {
  try {
    const apiResult = await setServerPowerState(server.attributes.identifier, targetDiscordId, action);

    if (apiResult.statusCode !== HTTP_STATUS_CODES.NO_CONTENT) {
      return {
        success: false,
        message: `Server ${action} command returned status code: ${apiResult.statusCode}`
      };
    }

    const expectedStates = { start: [ "running" ], restart: [ "running" ], stop: [ "offline" ] };
    const actionVerbs = { start: "Starting", restart: "Restarting", stop: "Stopping" };
    const targetStates = expectedStates[action];
    const verb = actionVerbs[action] || action;

    for (let attempt = 0; attempt < POWER_ACTION_CONFIG.MAX_ATTEMPTS; attempt++) {
      const dots = ".".repeat((attempt % 3) + 1);
      if (updateLoadingMessage) await updateLoadingMessage(`${verb} server${dots}`);

      await new Promise(resolve => setTimeout(resolve, POWER_ACTION_CONFIG.POLL_INTERVAL));

      const resourceData = await fetchResourceInfo(server.attributes.identifier, targetDiscordId);
      if (resourceData && targetStates.includes(resourceData.attributes.current_state)) {
        return {
          success: true,
          message: `Server ${action} completed successfully!`,
          resourceInfo: resourceData
        };
      }
    }

    return {
      success: true,
      message: `Server ${action} command sent, but state change is taking longer than expected.\nTry manually refreshing or check the server panel.`,
      timeout: true
    };
  } catch (error) {
    msgLog.error(`Error handling admin power action ${action}: ${error.message}`);
    return { success: false, message: `Failed to ${action} server. Please try again.` };
  }
}

async function handleAdminServers(interaction) {
  const targetUser = interaction.options.getUser("user");
  const targetDiscordId = targetUser.id;

  const targetDbUser = await requireDbUser(interaction, targetUser, ". Add them with `/admin user create` first.");
  if (!targetDbUser) return;

  if (await denyIfImmune(interaction, targetDbUser, { callerId: interaction.user.id, targetId: targetDiscordId, allowSelf: true, action: "modified" })) {
    return;
  }

  if (!userHasClientApiKey(targetDiscordId)) {
    await interaction.editReply({
      content: `<@${targetDiscordId}> has no client API key set. They must use \`/set-client-key\` first.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const serverObjects = await getClientServers(targetDiscordId);
  if (!serverObjects || !serverObjects.data) {
    await interaction.editReply({
      content: getErrorMessage("CLIENT_API_FAILURE"),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const adminHeader = `**Managing servers for <@${targetDiscordId}>** (\`${targetDbUser.panelUsername}\`)\n\n`;

  let currentSelectedServer = null;
  let currentServerResourceInfo = null;
  let currentView = "main";
  let activeWs = null;
  let lastDiscordEditTime = 0;
  let consoleBuffer = [];

  const mainView = (statusMessage = null) =>
    buildAdminMainView(adminHeader, serverObjects, currentSelectedServer, currentServerResourceInfo, consoleBuffer, statusMessage);

  // Initial render: header + server select menu only (no server selected yet).
  await interaction.editReply({
    components: [ mainView() ],
    flags: MessageFlags.IsComponentsV2
  });

  const response = await interaction.fetchReply();
  const collector = response.createMessageComponentCollector({
    filter: i => i.user.id === interaction.user.id,
    idle: COLLECTOR_IDLE_TIMEOUT
  });

  const disconnectWebSocket = () => {
    if (activeWs) {
      activeWs.close();
      activeWs = null;
    }
  };

  const connectWebSocket = serverId => {
    disconnectWebSocket();
    if (!currentSelectedServer || !currentServerResourceInfo) return;

    const ws = new PterodactylWebSocket(serverId, targetDiscordId);
    activeWs = ws;

    ws.on("stats", async resourceInfo => {
      currentServerResourceInfo = resourceInfo;
      const now = Date.now();
      if (now - lastDiscordEditTime < WS_THROTTLE_MS || currentView !== "main") return;
      lastDiscordEditTime = now;
      await interaction.editReply({
        components: [ mainView() ],
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
        components: [ buildAdminConsoleView(currentSelectedServer.attributes.name, consoleBuffer) ],
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
        components: [ mainView() ],
        flags: MessageFlags.IsComponentsV2
      }).catch(() => disconnectWebSocket());
    });

    ws.on("error", err => {
      msgLog.error(`[admin-server-menu] WS error for ${serverId}: ${err.message}`);
    });

    ws.on("close", () => {
      if (activeWs === ws) activeWs = null;
    });

    ws.connect().catch(err => {
      msgLog.error(`[admin-server-menu] WS connect failed for ${serverId}: ${err.message}`);
      activeWs = null;
    });
  };

  // Builds the settings view, refreshing suspension state from the panel first.
  const loadSettingsView = async () => {
    let isSuspended = false;
    const resourceApi = await getServerResourceInfoById(currentSelectedServer.attributes.identifier, targetDiscordId);
    if (resourceApi.statusCode === HTTP_STATUS_CODES.OK) {
      currentServerResourceInfo = await resourceApi.body.json();
      isSuspended = currentServerResourceInfo?.attributes?.is_suspended || false;
    } else {
      try { await resourceApi.body.text(); } catch { /* drain */ }
      isSuspended = resourceApi.statusCode === HTTP_STATUS_CODES.CONFLICT;
      currentServerResourceInfo = null;
    }
    return buildAdminSettingsView(currentSelectedServer.attributes.name, isSuspended);
  };

  const settingsErrorView = message => new ContainerBuilder()
    .setAccentColor(COLORS.ADMIN)
    .addActionRowComponents(row =>
      row.setComponents(new ButtonBuilder().setCustomId("admin-back").setLabel("← Back").setStyle(ButtonStyle.Secondary))
    )
    .addTextDisplayComponents(text =>
      text.setContent(`**Server Settings**\n\n\`${currentSelectedServer.attributes.name}\`\n\n${message}`)
    );

  const logAdminServerAction = (i, action, extra = "") => {
    const serverCtx = currentSelectedServer
      ? ` | ${currentSelectedServer.attributes.name} (${currentSelectedServer.attributes.identifier})`
      : "";
    msgLog.log(`${i.user.username}/${i.user.id} | [admin] ${action} | target: ${targetUser.username} (${targetDiscordId})${serverCtx}${extra ? ` | ${extra}` : ""}`);
  };

  collector.on("collect", async i => {
    try {
      if (i.customId === "server-selection") {
        disconnectWebSocket();
        consoleBuffer = [];
        const selectedServerId = i.values[0];
        const selectedServerObject = await getServerInfoById(selectedServerId, targetDiscordId);

        if (selectedServerObject.statusCode === HTTP_STATUS_CODES.UNAUTHORIZED) {
          collector.stop("unauthorized");
          return;
        }

        currentSelectedServer = serverObjects.data.find(s => s.attributes.identifier === selectedServerId);
        currentServerResourceInfo = await fetchResourceInfo(selectedServerId, targetDiscordId);

        currentView = "main";
        await i.update({ components: [ mainView() ], flags: MessageFlags.IsComponentsV2 });
        connectWebSocket(selectedServerId);

      } else if (i.customId === "admin-refresh") {
        await i.deferUpdate();
        const selectedServerId = currentSelectedServer.attributes.identifier;
        const updated = await refreshServerInState(serverObjects, selectedServerId, targetDiscordId);
        if (updated) currentSelectedServer = updated;
        currentServerResourceInfo = await fetchResourceInfo(selectedServerId, targetDiscordId);
        await i.editReply({ components: [ mainView() ], flags: MessageFlags.IsComponentsV2 });
        connectWebSocket(selectedServerId);

      } else if (i.customId === "admin-server-settings") {
        disconnectWebSocket();
        await i.deferUpdate();
        currentView = "settings";
        await i.editReply({ components: [ await loadSettingsView() ], flags: MessageFlags.IsComponentsV2 });

      } else if (i.customId === "admin-back") {
        currentView = "main";
        await i.update({ components: [ mainView() ], flags: MessageFlags.IsComponentsV2 });
        connectWebSocket(currentSelectedServer.attributes.identifier);

      } else if (i.customId === "admin-power-start" || i.customId === "admin-power-restart" || i.customId === "admin-power-stop") {
        const action = i.customId === "admin-power-start" ? "start" : i.customId === "admin-power-restart" ? "restart" : "stop";
        logAdminServerAction(i, `power-${action}`);
        await i.deferUpdate();
        const verb = { start: "Starting", restart: "Restarting", stop: "Stopping" }[action];

        await i.editReply({ components: [ mainView(`${verb} server.`) ], flags: MessageFlags.IsComponentsV2 });

        const updateLoadingMessage = async msg => {
          await i.editReply({ components: [ mainView(msg) ], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
        };

        const result = await handleAdminPowerAction(action, currentSelectedServer, targetDiscordId, updateLoadingMessage);
        if (result.resourceInfo) currentServerResourceInfo = result.resourceInfo;

        await i.editReply({ components: [ mainView(result.message) ], flags: MessageFlags.IsComponentsV2 });
        connectWebSocket(currentSelectedServer.attributes.identifier);

      } else if (i.customId === "admin-edit-name") {
        const nameModal = new ModalBuilder()
          .setCustomId("admin-edit-name-modal")
          .setTitle("Edit Server Name");
        nameModal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("admin-server-name-input")
              .setLabel("Server Name")
              .setStyle(TextInputStyle.Short)
              .setValue(currentSelectedServer.attributes.name)
              .setRequired(true)
              .setMaxLength(50)
          )
        );
        await i.showModal(nameModal);
        try {
          const submit = await i.awaitModalSubmit({
            filter: s => s.customId === "admin-edit-name-modal" && s.user.id === i.user.id,
            time: 300_000
          });
          await submit.deferUpdate();
          const newName = submit.fields.getTextInputValue("admin-server-name-input").trim();
          logAdminServerAction(i, "edit-server-name:submit", `new name: ${newName}`);
          if (!newName) {
            await submit.editReply({ components: [ mainView(getErrorMessage("INVALID_SERVER_NAME")) ], flags: MessageFlags.IsComponentsV2 });
            return;
          }
          const statusCode = await editServerInfo(currentSelectedServer.attributes.internal_id, "name", newName);
          let message;
          if (statusCode === HTTP_STATUS_CODES.OK) {
            message = `Server name updated to **${newName}**.`;
            const updated = await refreshServerInState(serverObjects, currentSelectedServer.attributes.identifier, targetDiscordId);
            if (updated) currentSelectedServer = updated;
          } else {
            message = getErrorMessage("SERVER_NAME_UPDATE_FAILED");
          }
          currentView = "main";
          await submit.editReply({ components: [ mainView(message) ], flags: MessageFlags.IsComponentsV2 });
          connectWebSocket(currentSelectedServer.attributes.identifier);
        } catch { /* modal timed out */ }

      } else if (i.customId === "admin-edit-memory") {
        const memoryModal = new ModalBuilder()
          .setCustomId("admin-edit-memory-modal")
          .setTitle("Edit Server Memory");
        memoryModal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("admin-server-memory-input")
              .setLabel("Memory (MB)")
              .setStyle(TextInputStyle.Short)
              .setValue(String(currentSelectedServer.attributes.limits.memory))
              .setRequired(true)
          )
        );
        await i.showModal(memoryModal);
        try {
          const submit = await i.awaitModalSubmit({
            filter: s => s.customId === "admin-edit-memory-modal" && s.user.id === i.user.id,
            time: 300_000
          });
          await submit.deferUpdate();
          const newMemory = parseInt(submit.fields.getTextInputValue("admin-server-memory-input").trim(), 10);
          logAdminServerAction(i, "edit-server-memory:submit", `new memory: ${newMemory} MB`);
          if (isNaN(newMemory) || newMemory <= 0) {
            await submit.editReply({ components: [ mainView(getErrorMessage("INVALID_MEMORY_VALUE")) ], flags: MessageFlags.IsComponentsV2 });
            return;
          }
          const statusCode = await editServerInfo(currentSelectedServer.attributes.internal_id, "memory", newMemory);
          let message;
          if (statusCode === HTTP_STATUS_CODES.OK) {
            message = `Server memory updated to **${newMemory} MB**.`;
            const updated = await refreshServerInState(serverObjects, currentSelectedServer.attributes.identifier, targetDiscordId);
            if (updated) currentSelectedServer = updated;
          } else {
            message = getErrorMessage("SERVER_MEMORY_UPDATE_FAILED");
          }
          currentView = "main";
          await submit.editReply({ components: [ mainView(message) ], flags: MessageFlags.IsComponentsV2 });
          connectWebSocket(currentSelectedServer.attributes.identifier);
        } catch { /* modal timed out */ }

      } else if (i.customId === "admin-suspend-server") {
        logAdminServerAction(i, "suspend-server");
        await i.deferUpdate();
        const serverIsSuspended = await isServerSuspended(currentSelectedServer.attributes.identifier, targetDiscordId);
        if (serverIsSuspended) {
          await i.editReply({ components: [ settingsErrorView(getErrorMessage("SERVER_SUSPEND_FAILED_ALREADY_SUSPENDED")) ], flags: MessageFlags.IsComponentsV2 });
          return;
        }
        const statusCode = await suspendServer(currentSelectedServer.attributes.internal_id);
        const selectedId = currentSelectedServer.attributes.identifier;
        const updated = await refreshServerInState(serverObjects, selectedId, targetDiscordId);
        if (updated) currentSelectedServer = updated;
        currentServerResourceInfo = await fetchResourceInfo(selectedId, targetDiscordId);
        const message = statusCode === HTTP_STATUS_CODES.NO_CONTENT ? "Server suspended." : getErrorMessage("SERVER_SUSPEND_FAILED");
        currentView = "main";
        await i.editReply({ components: [ mainView(message) ], flags: MessageFlags.IsComponentsV2 });
        disconnectWebSocket();

      } else if (i.customId === "admin-unsuspend-server") {
        logAdminServerAction(i, "unsuspend-server");
        await i.deferUpdate();
        const serverIsSuspended = await isServerSuspended(currentSelectedServer.attributes.identifier, targetDiscordId);
        if (!serverIsSuspended) {
          await i.editReply({ components: [ settingsErrorView(getErrorMessage("SERVER_UNSUSPEND_FAILED_ALREADY_ACTIVE")) ], flags: MessageFlags.IsComponentsV2 });
          return;
        }

        // Admin bypasses memory limit check — unsuspend unconditionally
        const statusCode = await unsuspendServer(currentSelectedServer.attributes.internal_id);
        const selectedId = currentSelectedServer.attributes.identifier;
        const updated = await refreshServerInState(serverObjects, selectedId, targetDiscordId);
        if (updated) currentSelectedServer = updated;
        currentServerResourceInfo = await fetchResourceInfo(selectedId, targetDiscordId);
        const message = statusCode === HTTP_STATUS_CODES.NO_CONTENT ? "Server unsuspended." : getErrorMessage("SERVER_UNSUSPEND_FAILED");
        currentView = "main";
        await i.editReply({ components: [ mainView(message) ], flags: MessageFlags.IsComponentsV2 });
        connectWebSocket(currentSelectedServer.attributes.identifier);

      } else if (i.customId === "admin-delete-server") {
        await i.deferUpdate();
        const confirmContainer = new ContainerBuilder()
          .setAccentColor(COLORS.ADMIN)
          .addTextDisplayComponents(text =>
            text.setContent(
              "**Delete Server**\n\n" +
              `Are you sure you want to delete \`${currentSelectedServer.attributes.name}\`?\n\n` +
              "**This action cannot be undone.** All server data will be permanently lost."
            )
          )
          .addSeparatorComponents(sep => sep)
          .addActionRowComponents(row =>
            row.setComponents(
              new ButtonBuilder().setCustomId("admin-confirm-delete-server").setLabel("Yes, Delete Server").setStyle(ButtonStyle.Danger),
              new ButtonBuilder().setCustomId("admin-cancel-delete-server").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
            )
          );
        await i.editReply({ components: [ confirmContainer ], flags: MessageFlags.IsComponentsV2 });

      } else if (i.customId === "admin-confirm-delete-server") {
        logAdminServerAction(i, "delete-server:confirmed");
        await i.deferUpdate();
        await i.editReply({
          components: [ new ContainerBuilder().setAccentColor(COLORS.ADMIN).addTextDisplayComponents(t => t.setContent("**Deleting Server...**\n\nPlease wait.")) ],
          flags: MessageFlags.IsComponentsV2
        });
        const statusCode = await deleteServer(currentSelectedServer.attributes.internal_id);
        let resultContainer;
        if (statusCode === HTTP_STATUS_CODES.NO_CONTENT) {
          const idx = serverObjects.data.findIndex(s => s.attributes.identifier === currentSelectedServer.attributes.identifier);
          if (idx !== -1) serverObjects.data.splice(idx, 1);
          resultContainer = new ContainerBuilder()
            .setAccentColor(COLORS.ADMIN)
            .addTextDisplayComponents(t => t.setContent(`**Server Deleted**\n\n\`${currentSelectedServer.attributes.name}\` has been permanently deleted.`));
          currentSelectedServer = null;
          currentServerResourceInfo = null;
          currentView = "main";
          collector.stop("deleted");
        } else {
          resultContainer = new ContainerBuilder()
            .setAccentColor(COLORS.ADMIN)
            .addTextDisplayComponents(t => t.setContent(`**Server Deletion Failed**\n\n${getErrorMessage("SERVER_DELETE_FAILED")}`))
            .addSeparatorComponents(sep => sep)
            .addActionRowComponents(row => row.setComponents(new ButtonBuilder().setCustomId("admin-back").setLabel("← Back").setStyle(ButtonStyle.Secondary)));
        }
        await i.editReply({ components: [ resultContainer ], flags: MessageFlags.IsComponentsV2 });

      } else if (i.customId === "admin-console-view") {
        await i.deferUpdate();
        currentView = "console";
        await interaction.editReply({
          components: [ buildAdminConsoleView(currentSelectedServer.attributes.name, consoleBuffer) ],
          flags: MessageFlags.IsComponentsV2
        });

      } else if (i.customId === "admin-send-command") {
        const cmdModal = new ModalBuilder()
          .setCustomId("admin-send-command-modal")
          .setTitle("Send Console Command")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("admin-command-input")
                .setLabel("Command")
                .setStyle(TextInputStyle.Short)
                .setMaxLength(512)
                .setRequired(true)
            )
          );

        await i.showModal(cmdModal);

        const submitted = await i.awaitModalSubmit({
          filter: s => s.customId === "admin-send-command-modal" && s.user.id === i.user.id,
          time: 60_000
        }).catch(() => null);
        if (!submitted) return;
        await submitted.deferUpdate();
        const cmd = submitted.fields.getTextInputValue("admin-command-input").trim();
        if (activeWs) activeWs.sendCommand(cmd);

      } else if (i.customId === "admin-cancel-delete-server") {
        await i.deferUpdate();
        await i.editReply({ components: [ await loadSettingsView() ], flags: MessageFlags.IsComponentsV2 });
      }
    } catch (error) {
      msgLog.error(`Error handling admin server interaction: ${error.message}`);
      const errorReply = { content: "An error occurred while processing your request.", flags: MessageFlags.Ephemeral };
      if (i.replied || i.deferred) await i.followUp(errorReply).catch(() => {});
      else await i.reply(errorReply).catch(() => {});
    }
  });

  collector.on("end", async (collected, reason) => {
    disconnectWebSocket();
    if (reason === "idle") {
      await interaction.editReply({ components: [ createDisabledAdminMenu(adminHeader, serverObjects, currentSelectedServer, "USER_TIMEOUT") ], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    } else if (reason === "unauthorized") {
      await interaction.editReply({ components: [ createDisabledAdminMenu(adminHeader, serverObjects, currentSelectedServer, "CLIENT_API_FAILURE") ], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    }
  });
}

async function handleAdminServersView(interaction) {
  const filter = interaction.options.getString("filter") ?? "online";

  const appApi = await applicationApiCall("application/servers?per_page=100&include=user", "GET");
  if (appApi.statusCode !== HTTP_STATUS_CODES.OK) {
    await interaction.editReply(getErrorMessage("PANEL_UNREACHABLE"));
    return;
  }
  const appData = await appApi.body.json();
  const allServers = appData?.data ?? [];

  const servers = [];
  await Promise.all(allServers.map(async server => {
    const owner = db.getUserByPanelId(server.attributes.user);

    let state = "unknown";
    let memoryUsed = 0;
    let cpuUsage = 0;

    if (owner?.panelAPIKey) {
      const resourceData = await fetchResourceInfo(server.attributes.identifier, owner.discordId);
      if (resourceData) {
        state = resourceData?.attributes?.current_state ?? "unknown";
        memoryUsed = resourceData.attributes.resources.memory_bytes;
        cpuUsage = resourceData.attributes.resources.cpu_absolute;
      }
    }

    if (filter === "online" && state !== "running") return;

    servers.push({
      name: server.attributes.name,
      owner: owner?.panelUsername ?? `panel:${server.attributes.relationships?.user?.attributes?.username ?? server.attributes.user}`,
      state,
      memoryUsed,
      memoryLimit: server.attributes.limits.memory,
      cpuUsage
    });
  }));

  servers.sort((a, b) => {
    if (a.state === "running" && b.state !== "running") return -1;
    if (a.state !== "running" && b.state === "running") return 1;
    return a.name.localeCompare(b.name);
  });

  const totalPages = Math.max(1, Math.ceil(servers.length / SERVERS_PER_PAGE));
  let page = 0;

  const listView = () => buildServerListView(servers, filter, page, totalPages, SERVERS_PER_PAGE);

  await interaction.editReply({ components: [ listView() ], flags: MessageFlags.IsComponentsV2 });

  if (totalPages <= 1) return;

  const message = await interaction.fetchReply();
  const collector = message.createMessageComponentCollector({ idle: COLLECTOR_IDLE_TIMEOUT });

  collector.on("collect", async i => {
    if (i.user.id !== interaction.user.id) {
      await i.reply({ content: "This is not your menu.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (i.customId === "admin-sv-next") page = Math.min(page + 1, totalPages - 1);
    else if (i.customId === "admin-sv-prev") page = Math.max(page - 1, 0);
    await i.update({ components: [ listView() ], flags: MessageFlags.IsComponentsV2 });
  });

  collector.on("end", async () => {
    await interaction.editReply({ components: [ listView() ], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
  });
}

module.exports = {
  handleAdminServers,
  handleAdminServersView
};
