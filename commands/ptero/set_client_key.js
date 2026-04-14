const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const msgLog = require("../../utility/logger.js");
const config = require("../../config.json");
const db = require("../../utility/database.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const { reconstructCommand, getUserId, clientApiCall } = require("../../utility/helper_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("set-client-key")
    .setDescription("Sets your client API key required for certain commands.")
    .addStringOption(option =>
      option.setName("api-key")
        .setDescription(`A valid client API key, generated from ${process.env.PANEL_URL}account/api`)
        .setRequired(true)
    ),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);
    const authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.SET_CLIENT_KEY);
    if (authenticated === -1) {
      await interaction.editReply(getErrorMessage("USER_NOT_FOUND"));
      return;
    }
    else if (authenticated === false) {
      await interaction.editReply(getErrorMessage("INSUFFICIENT_PERMISSIONS"));
      return;
    }

    const newApiKey = interaction.options.getString("api-key");
    if (!newApiKey) {
      await interaction.editReply(getErrorMessage("INVALID_INPUT"));
      return;
    }

    const userId = getUserId(interaction.user.id);
    const user = db.getUserByPanelId(userId);
    let success = false;
    if (user) {
      const result = await clientApiCall("client/account", "GET", null, interaction.user.id, newApiKey);
      if (result.statusCode === 200) {
        db.updateUserApiKey(user.discordId, newApiKey);
        success = true;
      }
    }

    if (success) {
      if (config.debug) {
        msgLog.debug(`Successfully set client API key for user: ${interaction.user.username}/${interaction.user.id}`);
      }
      await interaction.editReply({ content: "Successfully set client API key.", flags: MessageFlags.Ephemeral });
    }
    else {
      await interaction.editReply(getErrorMessage("API_KEY_INVALID"));
    }
  }
};
