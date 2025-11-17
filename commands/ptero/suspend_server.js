const { SlashCommandBuilder } = require("discord.js");
const { getErrorMessage } = require("../../utility/error_messages.js");
const msgLog = require("../../utility/logger.js");
const config = require("../../config.json");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const { apiCall, getUserId, reconstructCommand } = require("../../utility/helper_functions.js");
const { getServerOwnerId, isServerSuspended } = require("../../utility/server_functions.js");

async function suspendServer(serverId) {
  const apiResult = await apiCall(`application/servers/${serverId}/suspend`, "POST");

  const statusCode = await apiResult.statusCode;

  return statusCode;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("suspend-server")
    .setDescription("Suspends a server based on a server ID.")
    .addStringOption(option =>
      option.setName("server-id")
        .setDescription("/get-owned-servers for server IDs")
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply();
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);
    let authenticated = -1;
    let interactionReply = "";
    const serverOwnerId = await getServerOwnerId(interaction.options.getString("server-id"));

    if (serverOwnerId == getUserId(interaction.user.id)) {
      authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.SUSPEND_SERVER);
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

    const serverIsSuspended = await isServerSuspended(interaction.options.getString("server-id"));

    if (serverIsSuspended == true) {
      await interaction.editReply(getErrorMessage("SERVER_SUSPEND_FAILED_ALREADY_SUSPENDED"));
      if (config.debug) {
        msgLog.debug(getErrorMessage("SERVER_SUSPEND_FAILED_ALREADY_SUSPENDED"));
      }
      return;
    }

    const serverId = interaction.options.getString("server-id");
    const suspensionStatusCode = await suspendServer(serverId);

    if (suspensionStatusCode == 204) {
      interactionReply = `Server with ID: ${serverId} has been suspended.`;
    }
    else {
      interactionReply = getErrorMessage("SERVER_SUSPEND_FAILED");
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
