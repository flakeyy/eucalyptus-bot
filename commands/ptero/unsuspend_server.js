const { SlashCommandBuilder } = require("discord.js");
const { getErrorMessage } = require("../../error_messages.js");
const wait = require("node:timers/promises").setTimeout;
const { PERMISSIONS, authenticateUserForPermission } = require("../../permissions.js");
const { apiCall, getUserId } = require("../../utility/helper_functions.js");
const { getServerOwnerId, isServerSuspended, getAvailableUserMemory, getServerInfoById } = require("../../utility/server_functions.js");

async function unsuspendServer(serverId) {
  const apiResult = await apiCall(`application/servers/${serverId}/unsuspend`, "POST");

  const statusCode = apiResult.statusCode;

  return statusCode;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("unsuspend-server")
    .setDescription("Unsuspends a server based on a server ID.")
    .addStringOption(option =>
      option.setName("server-id")
        .setDescription("/get-owned-servers for server IDs")
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply();
    let authenticated = -1;
    let interactionReply = "";
    const serverOwnerId = await getServerOwnerId(interaction.options.getString("server-id"));

    if (serverOwnerId == getUserId(interaction.user.id)) {
      authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.UNSUSPEND_OWN_SERVER);
    }
    else {
      authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.UNSUSPEND_ANY_SERVER);
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
    if (serverIsSuspended == false) {
      interaction.reply(getErrorMessage("SERVER_UNSUSPEND_FAILED_ALREADY_ACTIVE"));
      return;
    }

    const serverInfo = await getServerInfoById(interaction.options.getString("server-id"));
    const serverMemory = serverInfo.limits.memory;

    const availableMemory = await getAvailableUserMemory(getUserId(interaction.user.id), interaction.user.id);
    if (availableMemory - serverMemory < 0) {
      const memoryToFree = (availableMemory - serverMemory) * -1;
      return getErrorMessage("SERVER_UNSUSPENSION_FAILED_MEMORY", memoryToFree);
    }

    const serverId = interaction.options.getString("server-id");
    const suspensionStatusCode = await unsuspendServer(serverId);

    if (suspensionStatusCode == 204) {
      interactionReply = `Server with ID: ${serverId} has been unsuspended.`;
    }
    else {
      interactionReply = getErrorMessage("SERVER_UNSUSPEND_FAILED");
    }

    await wait(2_500);
    if (interactionReply != "") {
      await interaction.editReply(interactionReply);
    }
    else {
      await interaction.editReply(getErrorMessage("SERVER_TIMEOUT"));
    }

  }
};
