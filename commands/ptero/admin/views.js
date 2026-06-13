const {
  ContainerBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} = require("discord.js");
const { PERMISSIONS } = require("../../../utility/permissions.js");
const { getErrorMessage } = require("../../../utility/error_messages.js");
const { COLORS, UNIT_CONVERSIONS } = require("../../../utility/constants.js");
const { buildServerSelectMenu, buildServerDetailsText, renderConsoleBlock } = require("../../../utility/server_views.js");
const { EDITABLE_FIELDS, PERM_LABELS } = require("./constants.js");

// All ContainerBuilder views for the /admin command. Server views mirror the
// layout of commands/ptero/server_menu.js (same headers/structure) and differ
// only by the COLORS.ADMIN accent and the admin-namespaced component customIds.

// ─── User views ──────────────────────────────────────────────────────────────

function formatUserInfo(user, header = "User Info", availableMemory = null) {
  const maxIsUnlimited = Number(user.maximumAllowedMemory) === -1;
  const maxDisplay = maxIsUnlimited ? "Unlimited" : `${user.maximumAllowedMemory} MB`;
  const availDisplay = availableMemory === null ? ""
    : `**Available Memory:** ${(maxIsUnlimited || availableMemory === -1) ? "Unlimited" : `${availableMemory} MB`}\n`;
  return (
    `**${header}**\n\n` +
    `**Discord ID:** \`${user.discordId}\`\n` +
    `**Panel Username:** \`${user.panelUsername}\`\n` +
    `**Panel ID:** \`${user.panelId}\`\n` +
    `**Max Memory:** ${maxDisplay}\n` +
    availDisplay +
    `**Permissions:** \`${user.permissions}\` (0x${user.permissions.toString(16).toUpperCase()})\n` +
    `**Panel API Key:** ${user.panelAPIKey ? "`[set]`" : "`[not set]`"}`
  );
}

function buildFieldSelectMenu() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("admin-edit-field-select")
    .setPlaceholder("Select a field to edit");
  for (const field of EDITABLE_FIELDS) {
    menu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(field.label)
        .setDescription(field.description)
        .setValue(field.value)
    );
  }
  return menu;
}

function buildMainEditView(targetUser, user, availMem, statusMsg = null) {
  let content = `**Editing User — ${targetUser.username}**\n\n${formatUserInfo(user, "User Info", availMem)}`;
  if (statusMsg) content += `\n\n${statusMsg}`;
  return new ContainerBuilder()
    .setAccentColor(COLORS.ADMIN)
    .addTextDisplayComponents(text => text.setContent(content))
    .addSeparatorComponents(sep => sep)
    .addActionRowComponents(row => row.setComponents(buildFieldSelectMenu()));
}

function buildPermToggleView(targetUser, bitmask, statusMsg = null) {
  let content = `**Editing Permissions — ${targetUser.username}**\n\nBitmask: \`${bitmask}\` (0x${bitmask.toString(16).toUpperCase()})\n\nToggle permissions:`;
  if (statusMsg) content += `\n\n${statusMsg}`;
  const container = new ContainerBuilder()
    .setAccentColor(COLORS.ADMIN)
    .addTextDisplayComponents(text => text.setContent(content))
    .addSeparatorComponents(sep => sep);

  for (let idx = 0; idx < PERM_LABELS.length; idx += 3) {
    const chunk = PERM_LABELS.slice(idx, idx + 3);
    container.addActionRowComponents(row =>
      row.setComponents(
        ...chunk.map(p => {
          const bit = PERMISSIONS[p.key];
          const enabled = (bitmask & bit) === bit;
          return new ButtonBuilder()
            .setCustomId(`admin-perm-toggle-${p.key}`)
            .setLabel((enabled ? "✓ " : "✗ ") + p.label)
            .setStyle(enabled ? ButtonStyle.Success : ButtonStyle.Secondary);
        })
      )
    );
  }

  container
    .addSeparatorComponents(sep => sep)
    .addActionRowComponents(row =>
      row.setComponents(
        new ButtonBuilder().setCustomId("admin-perm-save").setLabel("Save Permissions").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("admin-perm-cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
      )
    );

  return container;
}

// ─── Server management views ───────────────────────────────────────────────

function buildAdminMainView(adminHeader, serverObjects, currentSelectedServer, resourceInfo, consoleBuffer = [], statusMessage = null) {
  const isSuspended = !resourceInfo;
  const container = new ContainerBuilder()
    .setAccentColor(COLORS.ADMIN)
    .addTextDisplayComponents(text => text.setContent(adminHeader))
    .addActionRowComponents(row =>
      row.setComponents(buildServerSelectMenu(serverObjects, currentSelectedServer?.attributes?.identifier))
    );

  if (currentSelectedServer) {
    let detailsText = buildServerDetailsText(currentSelectedServer, resourceInfo);
    if (statusMessage) detailsText += `\n\n${statusMessage}`;

    container
      .addTextDisplayComponents(text => text.setContent(detailsText))
      .addSeparatorComponents(sep => sep);

    const consolePreview = renderConsoleBlock(consoleBuffer, { preview: true });
    if (consolePreview) {
      container
        .addTextDisplayComponents(text => text.setContent(consolePreview))
        .addSeparatorComponents(sep => sep);
    }

    container
      .addActionRowComponents(row =>
        row.setComponents(
          new ButtonBuilder().setCustomId("admin-server-settings").setLabel("Server Settings").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("admin-console-view").setLabel("Console").setStyle(ButtonStyle.Secondary).setDisabled(isSuspended),
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
}

function buildAdminConsoleView(serverName, lines) {
  const consoleText = renderConsoleBlock(lines) ?? "No output yet.";
  return new ContainerBuilder()
    .setAccentColor(COLORS.ADMIN)
    .addActionRowComponents(row =>
      row.setComponents(new ButtonBuilder().setCustomId("admin-back").setLabel("← Back").setStyle(ButtonStyle.Secondary))
    )
    .addTextDisplayComponents(text => text.setContent(`**${serverName}** — Console`))
    .addSeparatorComponents(sep => sep)
    .addTextDisplayComponents(text => text.setContent(consoleText))
    .addSeparatorComponents(sep => sep)
    .addActionRowComponents(row =>
      row.setComponents(new ButtonBuilder().setCustomId("admin-send-command").setLabel("Send Command").setStyle(ButtonStyle.Primary))
    );
}

function buildAdminSettingsView(serverName, isSuspended) {
  return new ContainerBuilder()
    .setAccentColor(COLORS.ADMIN)
    .addActionRowComponents(row =>
      row.setComponents(new ButtonBuilder().setCustomId("admin-back").setLabel("← Back").setStyle(ButtonStyle.Secondary))
    )
    .addTextDisplayComponents(text => text.setContent(`**${serverName}** — Settings`))
    .addSeparatorComponents(sep => sep)
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
}

// Greyed-out version of the main view shown when the session ends (idle/unauthorized).
function createDisabledAdminMenu(adminHeader, serverObjects, currentSelectedServer, errorKey) {
  const container = new ContainerBuilder()
    .setAccentColor(COLORS.DISABLED)
    .addTextDisplayComponents(text => text.setContent(adminHeader))
    .addActionRowComponents(row =>
      row.setComponents(buildServerSelectMenu(serverObjects, currentSelectedServer?.attributes?.identifier, true))
    )
    .addTextDisplayComponents(text => text.setContent(getErrorMessage(errorKey, "/admin servers manage")));

  if (currentSelectedServer) {
    container
      .addSeparatorComponents(sep => sep)
      .addActionRowComponents(row =>
        row.setComponents(
          new ButtonBuilder().setCustomId("admin-server-settings").setLabel("Server Settings").setStyle(ButtonStyle.Primary).setDisabled(true),
          new ButtonBuilder().setCustomId("admin-console-view").setLabel("Console").setStyle(ButtonStyle.Secondary).setDisabled(true),
          new ButtonBuilder().setCustomId("admin-refresh").setLabel("Refresh").setStyle(ButtonStyle.Secondary).setDisabled(true)
        )
      )
      .addActionRowComponents(row =>
        row.setComponents(
          new ButtonBuilder().setCustomId("admin-power-start").setLabel("Start").setStyle(ButtonStyle.Success).setDisabled(true),
          new ButtonBuilder().setCustomId("admin-power-restart").setLabel("Restart").setStyle(ButtonStyle.Primary).setDisabled(true),
          new ButtonBuilder().setCustomId("admin-power-stop").setLabel("Stop").setStyle(ButtonStyle.Danger).setDisabled(true)
        )
      );
  }

  return container;
}

// ─── Server list view (/admin servers view) ─────────────────────────────────

function buildServerListView(servers, filter, page, totalPages, perPage) {
  const pageServers = servers.slice(page * perPage, (page + 1) * perPage);
  const filterLabel = filter === "online" ? "Online Servers" : "All Servers";
  let content = `**${filterLabel}** (${servers.length} total)\n\n`;

  if (pageServers.length === 0) {
    content += "No servers found.";
  } else {
    for (const s of pageServers) {
      const memMB = (s.memoryUsed / UNIT_CONVERSIONS.BYTES_TO_MB).toFixed(0);
      const cpu = s.cpuUsage.toFixed(1);
      const stateLabel = filter === "all" ? ` — \`${s.state}\`` : "";
      content += `**${s.name}**${stateLabel} — ${s.owner}\nMemory: ${memMB}/${s.memoryLimit} MB | CPU: ${cpu}%\n\n`;
    }
  }

  if (totalPages > 1) content += `Page ${page + 1}/${totalPages}`;

  const container = new ContainerBuilder()
    .setAccentColor(COLORS.ADMIN)
    .addTextDisplayComponents(text => text.setContent(content.trimEnd()));

  if (totalPages > 1) {
    container
      .addSeparatorComponents(sep => sep)
      .addActionRowComponents(row =>
        row.setComponents(
          new ButtonBuilder().setCustomId("admin-sv-prev").setLabel("◀").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
          new ButtonBuilder().setCustomId("admin-sv-next").setLabel("▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
        )
      );
  }

  return container;
}

module.exports = {
  formatUserInfo,
  buildFieldSelectMenu,
  buildMainEditView,
  buildPermToggleView,
  buildAdminMainView,
  buildAdminConsoleView,
  buildAdminSettingsView,
  createDisabledAdminMenu,
  buildServerListView
};
