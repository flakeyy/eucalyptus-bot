const { SlashCommandBuilder } = require("discord.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const msgLog = require("../../utility/logger.js");
const config = require("../../config.json");
const { getUserId, reconstructCommand, validateString, userHasClientApiKey } = require("../../utility/helper_functions.js");
const { getServerOwnerId, editServerBuild } = require("../../utility/server_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("edit-server")
    .setDescription("Edit specific server values not possible through the panel.")
    .addStringOption(option =>
      option.setName("server-id")
        .setDescription("/get-owned-servers for server IDs")
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("setting")
        .setDescription("Choose from: 'memory'")
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("value")
        .setDescription("New value for the setting")
        .setRequired(true)
    ),

  // ADJUSTING MEMORY THIS WAY CAN BE EXPLOITED TO BYPASS THE PER-USER MEMORY CAP. OH WELL.
  async execute(interaction) {
    await interaction.deferReply();
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);
    let authenticated = -1;
    let interactionReply = "";
    
    const serverId = validateString(interaction.options.getString("server-id"));
    const settingName = validateString(interaction.options.getString("setting"));
    const settingValue = validateString(interaction.options.getString("value"));
    
    if (!serverId || !settingName || !settingValue) {
      await interaction.editReply(getErrorMessage("INVALID_INPUT"));
      return;
    }
    
    const serverOwnerId = await getServerOwnerId(serverId);

    if (serverOwnerId == getUserId(interaction.user.id)) {
      authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.EDIT_SERVER_SETTINGS);
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

    const serverIdInt = parseInt(serverId, 10);
    const editStatusCode = await editServerBuild(serverIdInt, settingName, settingValue);

    if (editStatusCode == 200) {
      interactionReply = `Server with ID: ${serverIdInt} has been edited.`;
    }
    else {
      interactionReply = getErrorMessage("SERVER_EDIT_FAILED");
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
