const {
  ContainerBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder
} = require("discord.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const msgLog = require("../../utility/logger.js");
const db = require("../../utility/database.js");
const {
  reconstructCommand,
  userHasClientApiKey
} = require("../../utility/helper_functions.js");
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
} = require("../../utility/server_functions.js");
const { buildServerSelectMenu } = require("./server_menu.js");
const { getErrorMessage } = require("../../utility/error_messages.js");

const COLORS = {
  PRIMARY: 0x6b34eb,
  ADMIN: 0xeb4034,
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

// Maps select option values to DB column names and display labels
const EDITABLE_FIELDS = [
  { value: "panel_username",        label: "Panel Username",             description: "The user's Pterodactyl panel username",           numeric: false },
  { value: "panel_id",              label: "Panel ID",                   description: "The user's numeric Pterodactyl user ID",           numeric: true  },
  { value: "maximum_allowed_memory", label: "Max Memory (MB, -1 = ∞)",  description: "Maximum total memory this user can allocate",      numeric: true  },
  { value: "permissions",           label: "Permissions (bitmask)",      description: "Bitfield of granted permissions (e.g. 65536 = admin)", numeric: true },
  { value: "panel_api_key",         label: "Panel API Key",              description: "The user's stored client API key",                 numeric: false }
];

function formatUserInfo(user, header = "User Info") {
  const memDisplay = user.maximumAllowedMemory === -1 ? "Unlimited" : `${user.maximumAllowedMemory} MB`;
  return (
    `**${header}**\n\n` +
    `**Discord ID:** \`${user.discordId}\`\n` +
    `**Panel Username:** \`${user.panelUsername}\`\n` +
    `**Panel ID:** \`${user.panelId}\`\n` +
    `**Max Memory:** ${memDisplay}\n` +
    `**Permissions:** \`${user.permissions}\` (0x${user.permissions.toString(16).toUpperCase()})\n` +
    `**Panel API Key:** ${user.panelAPIKey ? "`[set]`" : "`[not set]`"}`
  );
}

// ─── Admin server menu helpers ──────────────────────────────────────────────

async function handleAdminPowerAction(action, server, targetDiscordId, updateLoadingMessage) {
  try {
    const apiResult = await setServerPowerState(
      server.attributes.identifier,
      targetDiscordId,
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
    const verb = actionVerbs[action] || action;

    for (let attempt = 0; attempt < POWER_ACTION_CONFIG.MAX_ATTEMPTS; attempt++) {
      const dots = ".".repeat((attempt % 3) + 1);
      if (updateLoadingMessage) {
        await updateLoadingMessage(`${verb} server${dots}`);
      }

      await new Promise(resolve => setTimeout(resolve, POWER_ACTION_CONFIG.POLL_INTERVAL));

      const resourceApi = await getServerResourceInfoById(server.attributes.identifier, targetDiscordId);
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
    msgLog.error(`Error handling admin power action ${action}: ${error.message}`);
    return {
      success: false,
      message: `Failed to ${action} server. Please try again.`
    };
  }
}

// ─── Subcommand handlers ─────────────────────────────────────────────────────

async function handleUserView(interaction) {
  const targetUser = interaction.options.getUser("user");
  const existing = db.getUserByDiscordId(targetUser.id);
  if (!existing) {
    await interaction.editReply({
      content: `No database entry found for <@${targetUser.id}> (\`${targetUser.id}\`).`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.editReply({
    content: formatUserInfo(existing, `User Info — ${targetUser.username}`),
    flags: MessageFlags.Ephemeral
  });
}

async function handleUserCreate(interaction) {
  const targetUser = interaction.options.getUser("user");
  const panelUsername = interaction.options.getString("panel_username");
  const panelId = interaction.options.getInteger("panel_id");
  const maxMemory = interaction.options.getInteger("max_memory") ?? -1;
  const permissions = interaction.options.getInteger("permissions") ?? 0;

  if (db.getUserByDiscordId(targetUser.id)) {
    await interaction.editReply({
      content: `<@${targetUser.id}> already has a database entry. Use \`/admin user edit\` to modify it.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (db.getUserByPanelId(panelId)) {
    await interaction.editReply({
      content: `Panel ID \`${panelId}\` is already assigned to another user.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  try {
    db.createUser(targetUser.id, panelUsername, panelId, maxMemory, permissions, null);
    const created = db.getUserByDiscordId(targetUser.id);
    await interaction.editReply({
      content: `User created successfully!\n\n${formatUserInfo(created, `Created — ${targetUser.username}`)}`,
      flags: MessageFlags.Ephemeral
    });
  } catch (err) {
    msgLog.error(`Admin user create failed: ${err.message}`);
    await interaction.editReply({
      content: `Failed to create user: \`${err.message}\``,
      flags: MessageFlags.Ephemeral
    });
  }
}

async function handleUserEdit(interaction) {
  const targetUser = interaction.options.getUser("user");
  const existing = db.getUserByDiscordId(targetUser.id);

  if (!existing) {
    await interaction.editReply({
      content: `No database entry found for <@${targetUser.id}> (\`${targetUser.id}\`).`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // Build the initial view: user info + select menu
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("admin-edit-field-select")
    .setPlaceholder("Select a field to edit");

  for (const field of EDITABLE_FIELDS) {
    selectMenu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(field.label)
        .setDescription(field.description)
        .setValue(field.value)
    );
  }

  const container = new ContainerBuilder()
    .setAccentColor(COLORS.ADMIN)
    .addTextDisplayComponents(text =>
      text.setContent(`**[ADMIN] Editing — ${targetUser.username}**\n\n${formatUserInfo(existing)}`)
    )
    .addSeparatorComponents(sep => sep)
    .addActionRowComponents(row => row.setComponents(selectMenu));

  await interaction.editReply({
    components: [ container ],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
  });

  const response = await interaction.fetchReply();
  const collector = response.createMessageComponentCollector({
    filter: i => i.user.id === interaction.user.id,
    idle: COLLECTOR_IDLE_TIMEOUT
  });

  collector.on("collect", async i => {
    if (i.customId !== "admin-edit-field-select") return;

    const selectedField = EDITABLE_FIELDS.find(f => f.value === i.values[0]);
    if (!selectedField) return;

    // Get current value for the field
    const currentValue = existing[
      selectedField.value === "maximum_allowed_memory" ? "maximumAllowedMemory"
        : selectedField.value === "panel_api_key" ? "panelAPIKey"
          : selectedField.value === "panel_username" ? "panelUsername"
            : selectedField.value === "panel_id" ? "panelId"
              : selectedField.value
    ];

    const modal = new ModalBuilder()
      .setCustomId(`admin-edit-modal-${selectedField.value}`)
      .setTitle(`Edit: ${selectedField.label}`);

    const input = new TextInputBuilder()
      .setCustomId("admin-edit-value-input")
      .setLabel(selectedField.label)
      .setStyle(TextInputStyle.Short)
      .setValue(currentValue !== null && currentValue !== undefined ? String(currentValue) : "")
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));

    await i.showModal(modal);

    try {
      const modalSubmit = await i.awaitModalSubmit({
        filter: sub => sub.customId === `admin-edit-modal-${selectedField.value}` && sub.user.id === i.user.id,
        time: 300_000
      });

      await modalSubmit.deferUpdate();

      const rawValue = modalSubmit.fields.getTextInputValue("admin-edit-value-input").trim();

      let parsedValue = rawValue;
      if (selectedField.numeric) {
        parsedValue = parseInt(rawValue, 10);
        if (isNaN(parsedValue)) {
          const updated = db.getUserByDiscordId(targetUser.id);
          const errorContainer = new ContainerBuilder()
            .setAccentColor(COLORS.ADMIN)
            .addTextDisplayComponents(text =>
              text.setContent(`**[ADMIN] Editing — ${targetUser.username}**\n\n${formatUserInfo(updated)}\n\n**Error:** \`${selectedField.label}\` must be a number.`)
            )
            .addSeparatorComponents(sep => sep)
            .addActionRowComponents(row => row.setComponents(selectMenu));

          await modalSubmit.editReply({
            components: [ errorContainer ],
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
          });
          return;
        }
      }

      try {
        db.updateUser(targetUser.id, selectedField.value, parsedValue);
        // Re-fetch to show updated state
        const updated = db.getUserByDiscordId(targetUser.id);

        // Refresh the select menu options for any further edits
        const refreshedSelect = new StringSelectMenuBuilder()
          .setCustomId("admin-edit-field-select")
          .setPlaceholder("Select a field to edit");

        for (const field of EDITABLE_FIELDS) {
          refreshedSelect.addOptions(
            new StringSelectMenuOptionBuilder()
              .setLabel(field.label)
              .setDescription(field.description)
              .setValue(field.value)
          );
        }

        const successContainer = new ContainerBuilder()
          .setAccentColor(COLORS.ADMIN)
          .addTextDisplayComponents(text =>
            text.setContent(`**[ADMIN] Editing — ${targetUser.username}**\n\n${formatUserInfo(updated)}\n\n**Updated \`${selectedField.label}\` successfully.**`)
          )
          .addSeparatorComponents(sep => sep)
          .addActionRowComponents(row => row.setComponents(refreshedSelect));

        await modalSubmit.editReply({
          components: [ successContainer ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
        });
      } catch (err) {
        msgLog.error(`Admin user update failed: ${err.message}`);
        const current = db.getUserByDiscordId(targetUser.id);
        const errContainer = new ContainerBuilder()
          .setAccentColor(COLORS.ADMIN)
          .addTextDisplayComponents(text =>
            text.setContent(`**[ADMIN] Editing — ${targetUser.username}**\n\n${formatUserInfo(current)}\n\n**Error:** \`${err.message}\``)
          )
          .addSeparatorComponents(sep => sep)
          .addActionRowComponents(row => row.setComponents(selectMenu));

        await modalSubmit.editReply({
          components: [ errContainer ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
        });
      }
    } catch {
      // Modal timed out — silently end
    }
  });

  collector.on("end", async (collected, reason) => {
    if (reason === "idle") {
      const timedOutContainer = new ContainerBuilder()
        .setAccentColor(COLORS.DISABLED)
        .addTextDisplayComponents(text =>
          text.setContent(getErrorMessage("USER_TIMEOUT"))
        );

      await interaction.editReply({
        components: [ timedOutContainer ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
      }).catch(() => {});
    }
  });
}

async function handleUserDelete(interaction) {
  const targetUser = interaction.options.getUser("user");
  const existing = db.getUserByDiscordId(targetUser.id);

  if (!existing) {
    await interaction.editReply({
      content: `No database entry found for <@${targetUser.id}> (\`${targetUser.id}\`).`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const confirmContainer = new ContainerBuilder()
    .setAccentColor(COLORS.ADMIN)
    .addTextDisplayComponents(text =>
      text.setContent(
        "**[ADMIN] Delete User**\n\n" +
        `Are you sure you want to remove <@${targetUser.id}> (\`${targetUser.username}\`) from the database?\n\n` +
        formatUserInfo(existing) + "\n\n" +
        "**This only removes them from the bot's database.** Their panel account will not be affected."
      )
    )
    .addSeparatorComponents(sep => sep)
    .addActionRowComponents(row =>
      row.setComponents(
        new ButtonBuilder().setCustomId("admin-confirm-delete-user").setLabel("Yes, Remove User").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("admin-cancel-delete-user").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
      )
    );

  await interaction.editReply({
    components: [ confirmContainer ],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
  });

  const response = await interaction.fetchReply();
  const collector = response.createMessageComponentCollector({
    filter: i => i.user.id === interaction.user.id,
    max: 1,
    time: 60_000
  });

  collector.on("collect", async i => {
    await i.deferUpdate();
    if (i.customId === "admin-confirm-delete-user") {
      try {
        db.deleteUser(targetUser.id);
        await i.editReply({
          components: [
            new ContainerBuilder()
              .setAccentColor(COLORS.ADMIN)
              .addTextDisplayComponents(text =>
                text.setContent(`**[ADMIN] User Removed**\n\n\`${targetUser.username}\` (\`${targetUser.id}\`) has been removed from the database.`)
              )
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
        });
      } catch (err) {
        msgLog.error(`Admin user delete failed: ${err.message}`);
        await i.editReply({
          content: `Failed to delete user: \`${err.message}\``,
          flags: MessageFlags.Ephemeral
        });
      }
    } else {
      await i.editReply({
        components: [
          new ContainerBuilder()
            .setAccentColor(COLORS.ADMIN)
            .addTextDisplayComponents(text =>
              text.setContent("**[ADMIN] Cancelled.** No changes were made.")
            )
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
      });
    }
  });
}

async function handleAdminServers(interaction) {
  const targetUser = interaction.options.getUser("user");
  const targetDiscordId = targetUser.id;

  const targetDbUser = db.getUserByDiscordId(targetDiscordId);
  if (!targetDbUser) {
    await interaction.editReply({
      content: `No database entry found for <@${targetDiscordId}>. Add them with \`/admin user create\` first.`,
      flags: MessageFlags.Ephemeral
    });
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

  const adminHeader = `**[ADMIN] Managing servers for <@${targetDiscordId}>** (\`${targetDbUser.panelUsername}\`)\n\n`;

  const selectMenu = buildServerSelectMenu(serverObjects);

  const initialContainer = new ContainerBuilder()
    .setAccentColor(COLORS.ADMIN)
    .addTextDisplayComponents(text => text.setContent(adminHeader))
    .addActionRowComponents(actionRow => actionRow.setComponents(selectMenu));

  await interaction.editReply({
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

  const buildFullAdminMainView = (statusMessage = null) => {
    const isSuspended = !currentServerResourceInfo;
    const container = new ContainerBuilder()
      .setAccentColor(COLORS.ADMIN)
      .addTextDisplayComponents(text => text.setContent(adminHeader))
      .addActionRowComponents(actionRow =>
        actionRow.setComponents(buildServerSelectMenu(serverObjects, currentSelectedServer?.attributes?.identifier))
      );

    if (currentSelectedServer) {
      let detailsText = "";
      if (currentServerResourceInfo && currentServerResourceInfo.attributes) {
        const memUsageMB = (currentServerResourceInfo.attributes.resources.memory_bytes / UNIT_CONVERSIONS.BYTES_TO_MB).toFixed(0);
        const diskUsageGB = (currentServerResourceInfo.attributes.resources.disk_bytes / UNIT_CONVERSIONS.BYTES_TO_GB).toFixed(2);
        const cpuUsage = (currentServerResourceInfo.attributes.resources.cpu_absolute).toFixed(2);
        const state = currentServerResourceInfo.attributes.is_suspended
          ? "Suspended"
          : `Active, ${currentServerResourceInfo.attributes.current_state}`;
        detailsText =
          `**Status:** ${state}\n` +
          `**ID:** \`${currentSelectedServer.attributes.identifier}\`\n` +
          `**Memory:** ${memUsageMB}/${currentSelectedServer.attributes.limits.memory} MB\n` +
          `**Disk:** ${diskUsageGB} GB\n` +
          `**CPU:** ${cpuUsage}/${(currentSelectedServer.attributes.limits.cpu).toFixed(2)}%\n` +
          `**Node:** ${currentSelectedServer.attributes.node}`;
      } else {
        detailsText =
          "**Status:** Suspended\n" +
          `**ID:** \`${currentSelectedServer.attributes.identifier}\`\n` +
          `**Memory Limit:** ${currentSelectedServer.attributes.limits.memory} MB\n` +
          `**Node:** ${currentSelectedServer.attributes.node}`;
      }
      if (statusMessage) detailsText += `\n\n${statusMessage}`;

      container
        .addTextDisplayComponents(text => text.setContent(detailsText))
        .addSeparatorComponents(sep => sep)
        .addActionRowComponents(row =>
          row.setComponents(
            new ButtonBuilder().setCustomId("admin-server-settings").setLabel("Server Settings").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("admin-refresh").setLabel("Refresh").setStyle(ButtonStyle.Secondary)
          )
        )
        .addActionRowComponents(row =>
          row.setComponents(
            new ButtonBuilder().setCustomId("admin-power-start").setLabel("Start").setStyle(ButtonStyle.Success).setDisabled(isSuspended),
            new ButtonBuilder().setCustomId("admin-power-restart").setLabel("Restart").setStyle(ButtonStyle.Primary).setDisabled(isSuspended),
            new ButtonBuilder().setCustomId("admin-power-stop").setLabel("Stop").setStyle(ButtonStyle.Danger).setDisabled(isSuspended)
          )
        );
    }

    return container;
  };

  const startAutoRefresh = async () => {
    clearAutoRefresh();
    if (!currentSelectedServer || currentView !== "main") return;

    const refreshServerInfo = async () => {
      try {
        if (!currentSelectedServer || currentView !== "main") { clearAutoRefresh(); return; }
        const resourceApi = await getServerResourceInfoById(currentSelectedServer.attributes.identifier, targetDiscordId);
        if (resourceApi.statusCode === HTTP_STATUS_CODES.OK) {
          currentServerResourceInfo = await resourceApi.body.json();
          await interaction.editReply({
            components: [ buildFullAdminMainView() ],
            flags: MessageFlags.IsComponentsV2
          }).catch(() => clearAutoRefresh());
          const state = currentServerResourceInfo.attributes.current_state;
          const isSuspended = currentServerResourceInfo.attributes.is_suspended;
          if (isSuspended || state !== "running") clearAutoRefresh();
        } else {
          currentServerResourceInfo = null;
          clearAutoRefresh();
          await interaction.editReply({
            components: [ buildFullAdminMainView() ],
            flags: MessageFlags.IsComponentsV2
          }).catch(() => {});
        }
      } catch (err) {
        msgLog.error(`Admin auto-refresh error: ${err.message}`);
        clearAutoRefresh();
      }
    };

    if (currentServerResourceInfo && !currentServerResourceInfo.attributes.is_suspended) {
      const state = currentServerResourceInfo.attributes.current_state;
      if (state === "running") {
        autoRefreshInterval = setInterval(refreshServerInfo, AUTO_REFRESH_INTERVALS.RUNNING);
      }
    }
  };

  const createDisabledAdminMenu = errorKey => {
    const disabledSelect = buildServerSelectMenu(
      serverObjects,
      currentSelectedServer?.attributes?.identifier,
      true
    );
    return new ContainerBuilder()
      .setAccentColor(COLORS.DISABLED)
      .addTextDisplayComponents(text => text.setContent(adminHeader))
      .addActionRowComponents(row => row.setComponents(disabledSelect))
      .addTextDisplayComponents(text => text.setContent(getErrorMessage(errorKey)));
  };

  collector.on("collect", async i => {
    try {
      if (i.customId === "server-selection") {
        clearAutoRefresh();
        const selectedServerId = i.values[0];
        const selectedServerObject = await getServerInfoById(selectedServerId, targetDiscordId);

        if (selectedServerObject.statusCode === HTTP_STATUS_CODES.UNAUTHORIZED) {
          collector.stop("unauthorized");
          return;
        }

        currentSelectedServer = serverObjects.data.find(s => s.attributes.identifier === selectedServerId);

        const resourceApi = await getServerResourceInfoById(selectedServerId, targetDiscordId);
        currentServerResourceInfo = resourceApi.statusCode === HTTP_STATUS_CODES.OK
          ? await resourceApi.body.json()
          : null;

        currentView = "main";
        await i.update({ components: [ buildFullAdminMainView() ], flags: MessageFlags.IsComponentsV2 });
        startAutoRefresh();

      } else if (i.customId === "admin-refresh") {
        await i.deferUpdate();
        const selectedServerId = currentSelectedServer.attributes.identifier;
        const selectedServerObject = await getServerInfoById(selectedServerId, targetDiscordId);
        if (selectedServerObject.statusCode === HTTP_STATUS_CODES.OK) {
          const updatedData = await selectedServerObject.body.json();
          const idx = serverObjects.data.findIndex(s => s.attributes.identifier === selectedServerId);
          if (idx !== -1) { serverObjects.data[idx] = updatedData; currentSelectedServer = updatedData; }
        }
        const resourceApi = await getServerResourceInfoById(selectedServerId, targetDiscordId);
        currentServerResourceInfo = resourceApi.statusCode === HTTP_STATUS_CODES.OK
          ? await resourceApi.body.json()
          : null;
        await i.editReply({ components: [ buildFullAdminMainView() ], flags: MessageFlags.IsComponentsV2 });
        startAutoRefresh();

      } else if (i.customId === "admin-server-settings") {
        clearAutoRefresh();
        await i.deferUpdate();

        let isSuspended = false;
        const resourceApi = await getServerResourceInfoById(currentSelectedServer.attributes.identifier, targetDiscordId);
        if (resourceApi.statusCode === HTTP_STATUS_CODES.OK) {
          currentServerResourceInfo = await resourceApi.body.json();
          isSuspended = currentServerResourceInfo?.attributes?.is_suspended || false;
        } else if (resourceApi.statusCode === HTTP_STATUS_CODES.CONFLICT) {
          isSuspended = true;
          currentServerResourceInfo = null;
        }

        const settingsContainer = new ContainerBuilder()
          .setAccentColor(COLORS.ADMIN)
          .addActionRowComponents(row =>
            row.setComponents(new ButtonBuilder().setCustomId("admin-back").setLabel("← Back").setStyle(ButtonStyle.Secondary))
          )
          .addTextDisplayComponents(text =>
            text.setContent(`**[ADMIN] ${currentSelectedServer.attributes.name}** settings\n\n`)
          )
          .addActionRowComponents(row =>
            row.setComponents(
              new ButtonBuilder().setCustomId("admin-edit-name").setLabel("Edit Name").setStyle(ButtonStyle.Primary),
              new ButtonBuilder().setCustomId("admin-edit-memory").setLabel("Edit Memory").setStyle(ButtonStyle.Primary)
            )
          )
          .addSeparatorComponents(sep => sep)
          .addActionRowComponents(row =>
            row.setComponents(
              isSuspended
                ? new ButtonBuilder().setCustomId("admin-unsuspend-server").setLabel("Unsuspend Server").setStyle(ButtonStyle.Success)
                : new ButtonBuilder().setCustomId("admin-suspend-server").setLabel("Suspend Server").setStyle(ButtonStyle.Danger)
            )
          )
          .addActionRowComponents(row =>
            row.setComponents(
              new ButtonBuilder().setCustomId("admin-delete-server").setLabel("Delete Server").setStyle(ButtonStyle.Danger)
            )
          );

        currentView = "settings";
        await i.editReply({ components: [ settingsContainer ], flags: MessageFlags.IsComponentsV2 });

      } else if (i.customId === "admin-back") {
        const backContainer = buildFullAdminMainView();
        currentView = "main";
        await i.update({ components: [ backContainer ], flags: MessageFlags.IsComponentsV2 });
        startAutoRefresh();

      } else if (i.customId === "admin-power-start" || i.customId === "admin-power-restart" || i.customId === "admin-power-stop") {
        await i.deferUpdate();
        const action = i.customId === "admin-power-start" ? "start" : i.customId === "admin-power-restart" ? "restart" : "stop";
        const verb = { "start": "Starting", "restart": "Restarting", "stop": "Stopping" }[action];

        await i.editReply({ components: [ buildFullAdminMainView(`${verb} server.`) ], flags: MessageFlags.IsComponentsV2 });

        const updateLoadingMessage = async msg => {
          await i.editReply({ components: [ buildFullAdminMainView(msg) ], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
        };

        const result = await handleAdminPowerAction(action, currentSelectedServer, targetDiscordId, updateLoadingMessage);
        if (result.resourceInfo) currentServerResourceInfo = result.resourceInfo;

        await i.editReply({ components: [ buildFullAdminMainView(result.message) ], flags: MessageFlags.IsComponentsV2 });
        startAutoRefresh();

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
          if (!newName) {
            await submit.editReply({ components: [ buildFullAdminMainView(getErrorMessage("INVALID_SERVER_NAME")) ], flags: MessageFlags.IsComponentsV2 });
            return;
          }
          const statusCode = await editServerInfo(currentSelectedServer.attributes.internal_id, "name", newName);
          let message;
          if (statusCode === HTTP_STATUS_CODES.OK) {
            message = `Server name updated to **${newName}**!`;
            const refreshed = await getServerInfoById(currentSelectedServer.attributes.identifier, targetDiscordId);
            if (refreshed.statusCode === HTTP_STATUS_CODES.OK) {
              const updatedData = await refreshed.body.json();
              const idx = serverObjects.data.findIndex(s => s.attributes.identifier === currentSelectedServer.attributes.identifier);
              if (idx !== -1) { serverObjects.data[idx] = updatedData; currentSelectedServer = updatedData; }
            }
          } else {
            message = getErrorMessage("SERVER_NAME_UPDATE_FAILED");
          }
          currentView = "main";
          await submit.editReply({ components: [ buildFullAdminMainView(message) ], flags: MessageFlags.IsComponentsV2 });
          startAutoRefresh();
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
          if (isNaN(newMemory) || newMemory <= 0) {
            await submit.editReply({ components: [ buildFullAdminMainView(getErrorMessage("INVALID_MEMORY_VALUE")) ], flags: MessageFlags.IsComponentsV2 });
            return;
          }
          const statusCode = await editServerInfo(currentSelectedServer.attributes.internal_id, "memory", newMemory);
          let message;
          if (statusCode === HTTP_STATUS_CODES.OK) {
            message = `Server memory updated to **${newMemory} MB**!`;
            const refreshed = await getServerInfoById(currentSelectedServer.attributes.identifier, targetDiscordId);
            if (refreshed.statusCode === HTTP_STATUS_CODES.OK) {
              const updatedData = await refreshed.body.json();
              const idx = serverObjects.data.findIndex(s => s.attributes.identifier === currentSelectedServer.attributes.identifier);
              if (idx !== -1) { serverObjects.data[idx] = updatedData; currentSelectedServer = updatedData; }
            }
          } else {
            message = getErrorMessage("SERVER_MEMORY_UPDATE_FAILED");
          }
          currentView = "main";
          await submit.editReply({ components: [ buildFullAdminMainView(message) ], flags: MessageFlags.IsComponentsV2 });
          startAutoRefresh();
        } catch { /* modal timed out */ }

      } else if (i.customId === "admin-suspend-server") {
        await i.deferUpdate();
        const serverIsSuspended = await isServerSuspended(currentSelectedServer.attributes.identifier, targetDiscordId);
        if (serverIsSuspended) {
          const errContainer = new ContainerBuilder()
            .setAccentColor(COLORS.ADMIN)
            .addActionRowComponents(row => row.setComponents(new ButtonBuilder().setCustomId("admin-back").setLabel("← Back").setStyle(ButtonStyle.Secondary)))
            .addTextDisplayComponents(text => text.setContent(`**[ADMIN] Server Settings**\n\n\`${currentSelectedServer.attributes.name}\`\n\n${getErrorMessage("SERVER_SUSPEND_FAILED_ALREADY_SUSPENDED")}`));
          await i.editReply({ components: [ errContainer ], flags: MessageFlags.IsComponentsV2 });
          return;
        }
        const statusCode = await suspendServer(currentSelectedServer.attributes.internal_id);
        const selectedId = currentSelectedServer.attributes.identifier;
        const refreshed = await getServerInfoById(selectedId, targetDiscordId);
        if (refreshed.statusCode === HTTP_STATUS_CODES.OK) {
          const updatedData = await refreshed.body.json();
          const idx = serverObjects.data.findIndex(s => s.attributes.identifier === selectedId);
          if (idx !== -1) { serverObjects.data[idx] = updatedData; currentSelectedServer = updatedData; }
        }
        const resourceApi = await getServerResourceInfoById(selectedId, targetDiscordId);
        currentServerResourceInfo = resourceApi.statusCode === HTTP_STATUS_CODES.OK ? await resourceApi.body.json() : null;
        const message = statusCode === HTTP_STATUS_CODES.NO_CONTENT ? "Server suspended successfully!" : getErrorMessage("SERVER_SUSPEND_FAILED");
        currentView = "main";
        await i.editReply({ components: [ buildFullAdminMainView(message) ], flags: MessageFlags.IsComponentsV2 });
        clearAutoRefresh();

      } else if (i.customId === "admin-unsuspend-server") {
        await i.deferUpdate();
        const serverIsSuspended = await isServerSuspended(currentSelectedServer.attributes.identifier, targetDiscordId);
        if (!serverIsSuspended) {
          const errContainer = new ContainerBuilder()
            .setAccentColor(COLORS.ADMIN)
            .addActionRowComponents(row => row.setComponents(new ButtonBuilder().setCustomId("admin-back").setLabel("← Back").setStyle(ButtonStyle.Secondary)))
            .addTextDisplayComponents(text => text.setContent(`**[ADMIN] Server Settings**\n\n\`${currentSelectedServer.attributes.name}\`\n\n${getErrorMessage("SERVER_UNSUSPEND_FAILED_ALREADY_ACTIVE")}`));
          await i.editReply({ components: [ errContainer ], flags: MessageFlags.IsComponentsV2 });
          return;
        }

        // Admin bypasses memory limit check — unsuspend unconditionally
        const statusCode = await unsuspendServer(currentSelectedServer.attributes.internal_id);
        const selectedId = currentSelectedServer.attributes.identifier;
        const refreshed = await getServerInfoById(selectedId, targetDiscordId);
        if (refreshed.statusCode === HTTP_STATUS_CODES.OK) {
          const updatedData = await refreshed.body.json();
          const idx = serverObjects.data.findIndex(s => s.attributes.identifier === selectedId);
          if (idx !== -1) { serverObjects.data[idx] = updatedData; currentSelectedServer = updatedData; }
        }
        const resourceApi = await getServerResourceInfoById(selectedId, targetDiscordId);
        currentServerResourceInfo = resourceApi.statusCode === HTTP_STATUS_CODES.OK ? await resourceApi.body.json() : null;
        const message = statusCode === HTTP_STATUS_CODES.NO_CONTENT ? "Server unsuspended successfully!" : getErrorMessage("SERVER_UNSUSPEND_FAILED");
        currentView = "main";
        await i.editReply({ components: [ buildFullAdminMainView(message) ], flags: MessageFlags.IsComponentsV2 });
        startAutoRefresh();

      } else if (i.customId === "admin-delete-server") {
        await i.deferUpdate();
        const confirmContainer = new ContainerBuilder()
          .setAccentColor(COLORS.ADMIN)
          .addTextDisplayComponents(text =>
            text.setContent(
              "**[ADMIN] Delete Server**\n\n" +
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
        await i.deferUpdate();
        await i.editReply({ components: [ new ContainerBuilder().setAccentColor(COLORS.ADMIN).addTextDisplayComponents(t => t.setContent("**Deleting Server...**\n\nPlease wait.")) ], flags: MessageFlags.IsComponentsV2 });
        const statusCode = await deleteServer(currentSelectedServer.attributes.internal_id);
        let resultContainer;
        if (statusCode === HTTP_STATUS_CODES.NO_CONTENT) {
          const idx = serverObjects.data.findIndex(s => s.attributes.identifier === currentSelectedServer.attributes.identifier);
          if (idx !== -1) serverObjects.data.splice(idx, 1);
          resultContainer = new ContainerBuilder()
            .setAccentColor(COLORS.ADMIN)
            .addTextDisplayComponents(t => t.setContent(`**[ADMIN] Server Deleted**\n\n\`${currentSelectedServer.attributes.name}\` has been permanently deleted.`));
          currentSelectedServer = null;
          currentServerResourceInfo = null;
          currentView = "main";
          collector.stop("deleted");
        } else {
          resultContainer = new ContainerBuilder()
            .setAccentColor(COLORS.ADMIN)
            .addTextDisplayComponents(t => t.setContent(`**[ADMIN] Server Deletion Failed**\n\n${getErrorMessage("SERVER_DELETE_FAILED")}`))
            .addSeparatorComponents(sep => sep)
            .addActionRowComponents(row => row.setComponents(new ButtonBuilder().setCustomId("admin-back").setLabel("← Back").setStyle(ButtonStyle.Secondary)));
        }
        await i.editReply({ components: [ resultContainer ], flags: MessageFlags.IsComponentsV2 });

      } else if (i.customId === "admin-cancel-delete-server") {
        await i.deferUpdate();
        let isSuspended = false;
        const resourceApi = await getServerResourceInfoById(currentSelectedServer.attributes.identifier, targetDiscordId);
        if (resourceApi.statusCode === HTTP_STATUS_CODES.OK) {
          currentServerResourceInfo = await resourceApi.body.json();
          isSuspended = currentServerResourceInfo?.attributes?.is_suspended || false;
        } else if (resourceApi.statusCode === HTTP_STATUS_CODES.CONFLICT) {
          isSuspended = true;
          currentServerResourceInfo = null;
        }
        const settingsContainer = new ContainerBuilder()
          .setAccentColor(COLORS.ADMIN)
          .addActionRowComponents(row => row.setComponents(new ButtonBuilder().setCustomId("admin-back").setLabel("← Back").setStyle(ButtonStyle.Secondary)))
          .addTextDisplayComponents(text => text.setContent(`**[ADMIN] ${currentSelectedServer.attributes.name}** settings\n\n`))
          .addActionRowComponents(row =>
            row.setComponents(
              new ButtonBuilder().setCustomId("admin-edit-name").setLabel("Edit Name").setStyle(ButtonStyle.Primary),
              new ButtonBuilder().setCustomId("admin-edit-memory").setLabel("Edit Memory").setStyle(ButtonStyle.Primary)
            )
          )
          .addSeparatorComponents(sep => sep)
          .addActionRowComponents(row =>
            row.setComponents(
              isSuspended
                ? new ButtonBuilder().setCustomId("admin-unsuspend-server").setLabel("Unsuspend Server").setStyle(ButtonStyle.Success)
                : new ButtonBuilder().setCustomId("admin-suspend-server").setLabel("Suspend Server").setStyle(ButtonStyle.Danger)
            )
          )
          .addActionRowComponents(row =>
            row.setComponents(new ButtonBuilder().setCustomId("admin-delete-server").setLabel("Delete Server").setStyle(ButtonStyle.Danger))
          );
        await i.editReply({ components: [ settingsContainer ], flags: MessageFlags.IsComponentsV2 });
      }
    } catch (error) {
      msgLog.error(`Error handling admin server interaction: ${error.message}`);
      const errorReply = { content: "An error occurred while processing your request.", flags: MessageFlags.Ephemeral };
      if (i.replied || i.deferred) await i.followUp(errorReply).catch(() => {});
      else await i.reply(errorReply).catch(() => {});
    }
  });

  collector.on("end", async (collected, reason) => {
    clearAutoRefresh();
    if (reason === "idle") {
      await interaction.editReply({ components: [ createDisabledAdminMenu("USER_TIMEOUT") ], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    } else if (reason === "unauthorized") {
      await interaction.editReply({ components: [ createDisabledAdminMenu("CLIENT_API_FAILURE") ], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    }
  });
}

// ─── Command definition ───────────────────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Administrator tools for managing users and servers.")
    .addSubcommandGroup(group =>
      group
        .setName("user")
        .setDescription("Manage bot users.")
        .addSubcommand(sub =>
          sub
            .setName("view")
            .setDescription("View a user's bot profile.")
            .addUserOption(opt =>
              opt.setName("user").setDescription("The Discord user to look up.").setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName("create")
            .setDescription("Add a Discord user to the bot database.")
            .addUserOption(opt =>
              opt.setName("user").setDescription("The Discord user to add.").setRequired(true)
            )
            .addStringOption(opt =>
              opt.setName("panel_username").setDescription("Their Pterodactyl panel username.").setRequired(true)
            )
            .addIntegerOption(opt =>
              opt.setName("panel_id").setDescription("Their numeric Pterodactyl user ID.").setRequired(true)
            )
            .addIntegerOption(opt =>
              opt.setName("max_memory").setDescription("Maximum memory in MB (-1 = unlimited). Default: -1.").setRequired(false)
            )
            .addIntegerOption(opt =>
              opt.setName("permissions").setDescription("Permission bitmask. Default: 0.").setRequired(false)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName("edit")
            .setDescription("Interactively edit a user's bot profile.")
            .addUserOption(opt =>
              opt.setName("user").setDescription("The Discord user to edit.").setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName("delete")
            .setDescription("Remove a user from the bot database.")
            .addUserOption(opt =>
              opt.setName("user").setDescription("The Discord user to remove.").setRequired(true)
            )
        )
    )
    .addSubcommand(sub =>
      sub
        .setName("servers")
        .setDescription("Manage a user's servers as admin (bypasses memory limits).")
        .addUserOption(opt =>
          opt.setName("user").setDescription("The Discord user whose servers to manage.").setRequired(true)
        )
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);

    const authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.ADMINISTRATOR);
    if (authenticated === -1) {
      await interaction.editReply(getErrorMessage("USER_NOT_FOUND"));
      return;
    }
    if (authenticated === false) {
      await interaction.editReply(getErrorMessage("INSUFFICIENT_PERMISSIONS"));
      return;
    }

    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommandGroup === "user") {
        if (subcommand === "view") await handleUserView(interaction);
        else if (subcommand === "create") await handleUserCreate(interaction);
        else if (subcommand === "edit") await handleUserEdit(interaction);
        else if (subcommand === "delete") await handleUserDelete(interaction);
      } else if (subcommand === "servers") {
        await handleAdminServers(interaction);
      }
    } catch (error) {
      msgLog.error(`Error in admin command (${subcommandGroup}/${subcommand}): ${error.message}`);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: "An error occurred while executing this command.", flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await interaction.editReply({ content: "An error occurred while executing this command.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  }
};
