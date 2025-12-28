const { SlashCommandBuilder } = require("discord.js");
const msgLog = require("../../utility/logger.js");
const config = require("../../config.json");
const { users } = require("../../users.json");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const { getNodes } = require("../../utility/server_functions.js");
const { reconstructCommand, getUserId } = require("../../utility/helper_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("set-client-key")
    .setDescription("Sets your client API key required for certain commands.")
    .addStringOption(option =>
      option.setName("api-key")
        .setDescription("A valid client API key, generated from https://dino.flakey.tech/account/api")
        .setRequired(true)
    ),
  async execute(interaction) {
    await interaction.deferReply();
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);
    const authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.SET_CLIENT_KEY);
    let interactionReply = "";
    if (authenticated == -1) {
      await interaction.editReply(getErrorMessage("USER_NOT_FOUND"));
      return;
    }
    else if (authenticated == false) {
      await interaction.editReply(getErrorMessage("INSUFFICIENT_PERMISSIONS"));
      return;
    }



    const userId = getUserId(interaction.user.id);
    for (const user of users) {
      if (user.panelId === userId) {
        user.panelAPIKey = interaction.options.getString("api-key");
      }
    }

    const nodeData = await getNodes();

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
