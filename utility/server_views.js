const { StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require("discord.js");
const { UNIT_CONVERSIONS, CONSOLE_PREVIEW_LINES } = require("./constants.js");

// Shared, customId-free building blocks for the server-management UIs. Both the
// user-facing /servers menu (commands/ptero/server_menu.js) and the admin
// "servers manage" menu render these identically; keeping them here avoids the
// two collectors drifting apart visually.

// Discord embeds/components cap text at ~4096 chars; we stay under 4000 for headroom.
const MAX_CONSOLE_BLOCK_LENGTH = 4000;

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

// Renders the Status/ID/Memory/Disk/CPU/Node detail block for a selected server.
// When resourceInfo is null/absent the server is treated as suspended.
// isSuspended only matters when resourceInfo is missing: it distinguishes a
// genuinely suspended server from a failed stats fetch. Defaults to true to
// preserve the legacy "no stats means suspended" rendering for callers that
// don't pass it.
function buildServerDetailsText(server, resourceInfo, isSuspended = true) {
  const limits = server.attributes.limits;

  if (resourceInfo && resourceInfo.attributes) {
    const memUsageMB = (resourceInfo.attributes.resources.memory_bytes / UNIT_CONVERSIONS.BYTES_TO_MB).toFixed(0);
    const diskUsageGB = (resourceInfo.attributes.resources.disk_bytes / UNIT_CONVERSIONS.BYTES_TO_GB).toFixed(2);
    const cpuUsage = (resourceInfo.attributes.resources.cpu_absolute).toFixed(2);
    const diskLimitGB = limits.disk > 0 ? `${(limits.disk / 1024).toFixed(2)} GB` : null;
    const diskText = diskLimitGB ? `${diskUsageGB} / ${diskLimitGB}` : `${diskUsageGB} GB`;
    const state = resourceInfo.attributes.is_suspended
      ? "Suspended"
      : `Active — ${resourceInfo.attributes.current_state}`;

    return `**Status:** ${state}\n` +
      `**ID:** \`${server.attributes.identifier}\`\n` +
      `**Memory:** ${memUsageMB} / ${limits.memory} MB\n` +
      `**Disk:** ${diskText}\n` +
      `**CPU:** ${cpuUsage}%\n` +
      `**Node:** ${server.attributes.node}`;
  }

  const diskLimitGB = limits.disk > 0 ? `${(limits.disk / 1024).toFixed(2)} GB` : null;
  const diskText = diskLimitGB ? `— / ${diskLimitGB}` : "—";

  return `**Status:** ${isSuspended ? "Suspended" : "Unknown"}\n` +
    `**ID:** \`${server.attributes.identifier}\`\n` +
    `**Memory:** — / ${limits.memory} MB\n` +
    `**Disk:** ${diskText}\n` +
    "**CPU:** —\n" +
    `**Node:** ${server.attributes.node}`;
}

// Wraps console lines in a code block, trimming the oldest lines until the block
// fits within Discord's text limit. Returns null when there is nothing to show.
// Pass { preview: true } to render only the last CONSOLE_PREVIEW_LINES lines.
function renderConsoleBlock(lines, { preview = false } = {}) {
  if (!lines || lines.length === 0) return null;

  const subset = preview ? lines.slice(-CONSOLE_PREVIEW_LINES) : lines.slice();
  let text;
  do {
    text = "```\n" + subset.join("\n") + "\n```";
    if (text.length <= MAX_CONSOLE_BLOCK_LENGTH) break;
    subset.shift();
  } while (subset.length > 0);

  return subset.length > 0 ? text : null;
}

module.exports = {
  buildServerSelectMenu,
  buildServerDetailsText,
  renderConsoleBlock
};
