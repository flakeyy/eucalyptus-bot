const { SlashCommandBuilder } = require("discord.js");
const { getErrorMessage } = require("../../error_messages.js");
const wait = require("node:timers/promises").setTimeout;
const { PERMISSIONS, authenticateUserForPermission } = require("../../permissions.js");
const { apiCall, getUserId } = require("../../utility/helper_functions.js");
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
    let authenticated = -1;
    let interactionReply = "";
    const serverOwnerId = await getServerOwnerId(interaction.options.getString("server-id"));

    if (serverOwnerId == getUserId(interaction.user.id)) {
      authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.SUSPEND_OWN_SERVER);
    }
    else {
      authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.SUSPEND_ANY_SERVER);
    }

    if (authenticated == -1) {
      interaction.reply(getErrorMessage("USER_NOT_FOUND"));
      return;
    }
    else if (authenticated == false) {
      interaction.reply(getErrorMessage("INSUFFICIENT_PERMISSIONS"));
      return;
    }

    const serverIsSuspended = await isServerSuspended(interaction.options.getString("server-id"));

    if (serverIsSuspended == true) {
      interaction.reply(getErrorMessage("SERVER_SUSPEND_FAILED_ALREADY_SUSPENDED"));
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
