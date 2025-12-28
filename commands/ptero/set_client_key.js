const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const msgLog = require("../../utility/logger.js");
const config = require("../../config.json");
const { users } = require("../../users.json");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const { reconstructCommand, getUserId, saveUsersFile, clientApiCall } = require("../../utility/helper_functions.js");
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);
    const authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.SET_CLIENT_KEY);
    if (authenticated == -1) {
      await interaction.editReply(getErrorMessage("USER_NOT_FOUND"));
      return;
    }
    else if (authenticated == false) {
      await interaction.editReply(getErrorMessage("INSUFFICIENT_PERMISSIONS"));
      return;
    }

    const userId = getUserId(interaction.user.id);
    let success = false;
    for (const user of users) {
      if (user.panelId === userId) {
        user.panelAPIKey = interaction.options.getString("api-key");
        const result = await clientApiCall("client/account", "GET", null, interaction.user.id);
        if (result.statusCode === 200) {
          saveUsersFile();
          success = true;
        }
      }
    }

    if(success) {
      if (config.debug) {
        msgLog.debug(`Successfully set client API key for user: ${interaction.user.username}/${interaction.user.id}`);
      }
      await interaction.editReply({content: "Successfully set client API key.", flags: MessageFlags.Ephemeral});
    }
    else {
      msgLog.warn(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)} | ${getErrorMessage("API_KEY_INVALID")}`);
      await interaction.editReply(getErrorMessage("API_KEY_INVALID"));
    }
  }
};
