const { SlashCommandBuilder } = require("discord.js");
const { getErrorMessage } = require("../../utility/error_messages.js");
const wait = require("node:timers/promises").setTimeout;
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const { getUserId } = require("../../utility/helper_functions.js");
const { getServerOwnerId, editServerBuild } = require("../../utility/server_functions.js");

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
        .setRequired(true),
    )
    .addStringOption(option =>
      option.setName("value")
        .setDescription("New value for the setting")
        .setRequired(true)
    ),


  // ADJUSTING MEMORY THIS WAY CAN BE EXPLOITED TO BYPASS THE PER-USER MEMORY CAP. OH WELL.
  async execute(interaction) {
    let authenticated = -1;
    let interactionReply = "";
    const serverOwnerId = await getServerOwnerId(interaction.options.getString("server-id"));
    const settingName = interaction.options.getString("setting");
    const settingValue = interaction.options.getString("value");

    if (serverOwnerId == getUserId(interaction.user.id)) {
      authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.EDIT_OWN_SERVER_SETTINGS);
    }
    else {
      authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.EDIT_ANY_SERVER_SETTINGS);
    }

    if (authenticated == -1) {
      interaction.reply(getErrorMessage("USER_NOT_FOUND"));
      return;
    }
    else if (authenticated == false) {
      interaction.reply(getErrorMessage("INSUFFICIENT_PERMISSIONS"));
      return;
    }

    const serverId = interaction.options.getString("server-id");

    const editStatusCode = await editServerBuild(serverId, settingName, settingValue);

    if (editStatusCode == 200) {
      interactionReply = `Server with ID: ${serverId} has been edited.`;
    }
    else {
      interactionReply = getErrorMessage("SERVER_EDIT_FAILED");
    }

    await interaction.deferReply();
    await wait(2_500);
    if (interactionReply != "") {
      await interaction.editReply(interactionReply);
    }
    else {
      await interaction.editReply(getErrorMessage("SERVER_TIMEOUT"));
    }

  }
};
