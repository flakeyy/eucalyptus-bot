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
const { PERMISSIONS } = require("../../../utility/permissions.js");
const msgLog = require("../../../utility/logger.js");
const db = require("../../../utility/database.js");
const { getAvailableUserMemory } = require("../../../utility/server_functions.js");
const { getErrorMessage } = require("../../../utility/error_messages.js");
const { COLORS, COLLECTOR_IDLE_TIMEOUT } = require("../../../utility/constants.js");
const { EDITABLE_FIELDS } = require("./constants.js");
const { formatUserInfo, buildMainEditView, buildPermToggleView } = require("./views.js");
const { requireDbUser, denyIfImmune } = require("./helpers.js");

const ID_SUFFIX = id => ` (\`${id}\`).`;

// Maps a DB column name (the select-menu value) to the camelCase property on the
// user object returned by the database layer.
const FIELD_TO_PROP = {
  maximum_allowed_memory: "maximumAllowedMemory",
  panel_api_key: "panelAPIKey",
  panel_username: "panelUsername",
  panel_id: "panelId"
};

async function handleUserView(interaction) {
  const targetUser = interaction.options.getUser("user");
  const existing = await requireDbUser(interaction, targetUser, ID_SUFFIX(targetUser.id));
  if (!existing) return;

  const availableMemory = await getAvailableUserMemory(existing.panelId, targetUser.id);

  await interaction.editReply({
    content: formatUserInfo(existing, `User Info — ${targetUser.username}`, availableMemory),
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
    db.createUser(targetUser.id, panelUsername, panelId, maxMemory, permissions & ~PERMISSIONS.IMMUNITY, null);
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
  const existing = await requireDbUser(interaction, targetUser, ID_SUFFIX(targetUser.id));
  if (!existing) return;

  if (await denyIfImmune(interaction, existing, { callerId: interaction.user.id, targetId: targetUser.id, allowSelf: true, action: "modified" })) {
    return;
  }

  let pendingPermissions = null;

  const availableMemory = await getAvailableUserMemory(existing.panelId, targetUser.id);

  await interaction.editReply({
    components: [ buildMainEditView(targetUser, existing, availableMemory) ],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
  });

  const response = await interaction.fetchReply();
  const collector = response.createMessageComponentCollector({
    filter: i => i.user.id === interaction.user.id,
    idle: COLLECTOR_IDLE_TIMEOUT
  });

  const logAdminUserAction = (i, action, extra = "") => {
    msgLog.log(`${i.user.username}/${i.user.id} | [admin] ${action} | target: ${targetUser.username} (${targetUser.id})${extra ? ` | ${extra}` : ""}`);
  };

  collector.on("collect", async i => {
    if (i.customId === "admin-edit-field-select") {
      const selectedField = EDITABLE_FIELDS.find(f => f.value === i.values[0]);
      if (!selectedField) return;

      if (selectedField.value === "permissions") {
        const fresh = db.getUserByDiscordId(targetUser.id);
        pendingPermissions = fresh.permissions;
        await i.deferUpdate();
        await i.editReply({
          components: [ buildPermToggleView(targetUser, pendingPermissions) ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
        });
        return;
      }

      const currentValue = existing[FIELD_TO_PROP[selectedField.value] ?? selectedField.value];

      const modal = new ModalBuilder()
        .setCustomId(`admin-edit-modal-${selectedField.value}`)
        .setTitle(`Edit: ${selectedField.label}`);

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("admin-edit-value-input")
            .setLabel(selectedField.label)
            .setStyle(TextInputStyle.Short)
            .setValue(currentValue !== null && currentValue !== undefined ? String(currentValue) : "")
            .setRequired(true)
        )
      );

      await i.showModal(modal);

      try {
        const modalSubmit = await i.awaitModalSubmit({
          filter: sub => sub.customId === `admin-edit-modal-${selectedField.value}` && sub.user.id === i.user.id,
          time: 300_000
        });

        await modalSubmit.deferUpdate();

        const rawValue = modalSubmit.fields.getTextInputValue("admin-edit-value-input").trim();
        logAdminUserAction(i, "edit-field-submit", `field: ${selectedField.value} | value: ${selectedField.value === "panel_api_key" ? "********" : rawValue}`);

        let parsedValue = rawValue;
        if (selectedField.numeric) {
          parsedValue = parseInt(rawValue, 10);
          if (isNaN(parsedValue)) {
            const updated = db.getUserByDiscordId(targetUser.id);
            await modalSubmit.editReply({
              components: [ buildMainEditView(targetUser, updated, null, `**Error:** \`${selectedField.label}\` must be a number.`) ],
              flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
            });
            return;
          }
        }

        try {
          db.updateUser(targetUser.id, selectedField.value, parsedValue);
          const updated = db.getUserByDiscordId(targetUser.id);
          Object.assign(existing, updated);
          const updatedAvailableMemory = await getAvailableUserMemory(updated.panelId, targetUser.id);
          await modalSubmit.editReply({
            components: [ buildMainEditView(targetUser, updated, updatedAvailableMemory, `**Updated \`${selectedField.label}\` successfully.**`) ],
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
          });
        } catch (err) {
          msgLog.error(`Admin user update failed: ${err.message}`);
          const current = db.getUserByDiscordId(targetUser.id);
          await modalSubmit.editReply({
            components: [ buildMainEditView(targetUser, current, null, `**Error:** \`${err.message}\``) ],
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
          });
        }
      } catch {
        // Modal timed out — silently end
      }

    } else if (i.customId.startsWith("admin-perm-toggle-")) {
      if (pendingPermissions === null) return;
      const permKey = i.customId.slice("admin-perm-toggle-".length);
      const bit = PERMISSIONS[permKey];
      if (bit === undefined) return;
      pendingPermissions ^= bit;
      await i.update({
        components: [ buildPermToggleView(targetUser, pendingPermissions) ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
      });

    } else if (i.customId === "admin-perm-save") {
      if (pendingPermissions === null) return;
      const safePermissions = i.user.id === targetUser.id ? pendingPermissions : pendingPermissions & ~PERMISSIONS.IMMUNITY;
      logAdminUserAction(i, "perm-save", `bitmask: ${safePermissions} (0x${safePermissions.toString(16).toUpperCase()})`);
      await i.deferUpdate();
      try {
        db.updateUser(targetUser.id, "permissions", safePermissions);
        const updated = db.getUserByDiscordId(targetUser.id);
        Object.assign(existing, updated);
        const updatedAvailableMemory = await getAvailableUserMemory(updated.panelId, targetUser.id);
        pendingPermissions = null;
        await i.editReply({
          components: [ buildMainEditView(targetUser, updated, updatedAvailableMemory, "**Updated `Permissions` successfully.**") ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
        });
      } catch (err) {
        msgLog.error(`Admin user permissions update failed: ${err.message}`);
        await i.editReply({
          components: [ buildPermToggleView(targetUser, pendingPermissions, `**Error:** \`${err.message}\``) ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
        });
      }

    } else if (i.customId === "admin-perm-cancel") {
      pendingPermissions = null;
      const current = db.getUserByDiscordId(targetUser.id);
      Object.assign(existing, current);
      await i.update({
        components: [ buildMainEditView(targetUser, existing, null) ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
      });
    }
  });

  collector.on("end", async (collected, reason) => {
    if (reason === "idle") {
      await interaction.editReply({
        components: [
          new ContainerBuilder()
            .setAccentColor(COLORS.DISABLED)
            .addTextDisplayComponents(text => text.setContent(getErrorMessage("USER_TIMEOUT", "/admin user edit")))
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
      }).catch(() => {});
    }
  });
}

async function handleUserDelete(interaction) {
  const targetUser = interaction.options.getUser("user");
  const existing = await requireDbUser(interaction, targetUser, ID_SUFFIX(targetUser.id));
  if (!existing) return;

  if (await denyIfImmune(interaction, existing, { callerId: interaction.user.id, targetId: targetUser.id, allowSelf: false, action: "removed" })) {
    return;
  }

  const confirmContainer = new ContainerBuilder()
    .setAccentColor(COLORS.ADMIN)
    .addTextDisplayComponents(text =>
      text.setContent(
        "**Delete User**\n\n" +
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
      msgLog.log(`${i.user.username}/${i.user.id} | [admin] delete-user:confirmed | target: ${targetUser.username} (${targetUser.id})`);
      try {
        db.deleteUser(targetUser.id);
        await i.editReply({
          components: [
            new ContainerBuilder()
              .setAccentColor(COLORS.ADMIN)
              .addTextDisplayComponents(text =>
                text.setContent(`**User Removed**\n\n\`${targetUser.username}\` (\`${targetUser.id}\`) has been removed from the database.`)
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
              text.setContent("**Cancelled.** No changes were made.")
            )
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
      });
    }
  });

  collector.on("end", async (collected, reason) => {
    if (reason === "time" && collected.size === 0) {
      await interaction.editReply({
        components: [
          new ContainerBuilder()
            .setAccentColor(COLORS.DISABLED)
            .addTextDisplayComponents(text => text.setContent(getErrorMessage("USER_TIMEOUT", "/admin user delete")))
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
      }).catch(() => {});
    }
  });
}

module.exports = {
  handleUserView,
  handleUserCreate,
  handleUserEdit,
  handleUserDelete
};
