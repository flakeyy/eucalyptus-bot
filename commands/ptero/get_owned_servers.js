const { SlashCommandBuilder } = require("discord.js");
const msgLog = require("../../utility/logger.js");
const config = require("../../config.json");
const { getUserId, getPanelUsername, reconstructCommand, userHasClientApiKey } = require("../../utility/helper_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const { getServersByUser } = require("../../utility/server_functions.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("get-owned-servers")
    .setDescription("Gets information about owned servers."),
  async execute(interaction) {
    await interaction.deferReply();
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);
    const authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.READ_SERVERS);
    let interactionReply = "";
    if (authenticated == -1) {
      await interaction.editReply(getErrorMessage("USER_NOT_FOUND"));
      return;
    }
    else if (authenticated == false) {
      await interaction.editReply(getErrorMessage("INSUFFICIENT_PERMISSIONS"));
      return;
    }

    if (!userHasClientApiKey(interaction.user.id)) {
      await interaction.editReply(getErrorMessage("API_KEY_NOT_SET"));
      return;
    }

    const serverObjects = await getServersByUser(getUserId(interaction.user.id));

    let totalMemory = 0;
    serverObjects.data.forEach(item => {
      totalMemory += item.attributes.limits.memory;
    });

    let unsuspendedMemory = 0;
    serverObjects.data.forEach(item => {
      if (item.attributes.suspended == false) {
        unsuspendedMemory += item.attributes.limits.memory;
      }
    });

    const formattedString = serverObjects.data.map(item => `${item.attributes.name.padEnd(16)} | ${String(item.attributes.limits.memory).padEnd(5)} MB | ID:${item.attributes.identifier} ${(item.attributes.suspended ? `| SUSPENDED` : `| Available`)}`).join("\n");

    if (serverObjects) {
      interactionReply =
        `\`\`\`Servers owned by ${getPanelUsername(interaction.user.id)}:\n\n` +
        `Servers: ${serverObjects.data.length} | Memory (unsuspended/total) MB: ${unsuspendedMemory}/${totalMemory}\n\n` +
        `${formattedString}\`\`\``;
    }

    if (interactionReply != "") {
      if (config.debug) {
        msgLog.debug(`${interactionReply}`);
      }
      await interaction.editReply(interactionReply);
    }
    else {
      msgLog.warn(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)} | ${getErrorMessage("SERVER_TIMEOUT")}`);
      await interaction.editReply(getErrorMessage("SERVER_TIMEOUT"));
    }
  }
};
