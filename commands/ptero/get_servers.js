const { SlashCommandBuilder } = require("discord.js");
const msgLog = require("../../utility/logger.js");
const config = require("../../config.json");
const { getUserId, getPanelUsername, reconstructCommand, userHasClientApiKey } = require("../../utility/helper_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const { getServersByUser } = require("../../utility/server_functions.js");
const { users } = require("../../users.json");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("get-servers")
    .setDescription("Gets information about user-owned servers.")
    .addStringOption(option =>
      option.setName("user")
        .setDescription("Specify user (forum name) (not required, administrator only)")
        .setRequired(false)
      ),
  async execute(interaction) {
    await interaction.deferReply();
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);
    let authenticated = -1;
    let interactionReply = "";

    if(interaction.options.getString("user") == null || (interaction.options.getString("user") === getPanelUsername(interaction.user.id))) {
      authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.READ_SERVERS);
    }
    else {
      authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.ADMINISTRATOR);
    }

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

    let userValue = interaction.options.getString("user") ? interaction.options.getString("user") : interaction.user.id;

    const serverObjects = await getServersByUser(getUserId(userValue));

    if(serverObjects === -1) {
      await interaction.editReply(getErrorMessage("INVALID_INPUT"));
      return;
    }

    let unsuspendedMemory = 0;
    serverObjects.data.forEach(item => {
      if (item.attributes.suspended == false) {
        unsuspendedMemory += item.attributes.limits.memory;
      }
    });
    
    const user = users.find(u => u.panelId === getUserId(userValue));
    let allowedTotalMemory = user.maximumAllowedMemory >= 0 ? user.maximumAllowedMemory : "Unlimited";

    const formattedString = serverObjects.data.map(item => `${item.attributes.name.padEnd(16)} | ${String(item.attributes.limits.memory).padEnd(5)} MB | ID:${item.attributes.identifier} ${(item.attributes.suspended ? `| SUSPENDED` : `| Available`)}`).join("\n");

    if (serverObjects) {
      interactionReply =
        `\`\`\`Servers owned by ${getPanelUsername(userValue)}\n\n` +
        `Servers: ${serverObjects.data.length}\n`+ 
        `Memory Total MB (active/allowed): ${unsuspendedMemory}/${allowedTotalMemory}\n\n` +
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
