const { SlashCommandBuilder } = require("discord.js");
const { getErrorMessage } = require("../../utility/error_messages.js");
const msgLog = require("../../utility/logger.js");
const config = require("../../config.json");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const { applicationApiCall, getUserId, reconstructCommand, validateString, userHasClientApiKey } = require("../../utility/helper_functions.js");
const { getServerOwnerId, isServerSuspended, getAvailableUserMemory, getServerInfoById } = require("../../utility/server_functions.js");

async function unsuspendServer(serverId) {
  const apiResult = await applicationApiCall(`application/servers/${serverId}/unsuspend`, "POST");

  const statusCode = apiResult.statusCode;

  return statusCode;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("unsuspend-server")
    .setDescription("Unsuspends a server based on a server ID.")
    .addStringOption(option =>
      option.setName("server-id")
        .setDescription("/get-servers for server IDs")
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply();
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);
    let authenticated = -1;
    let interactionReply = "";
    
    const serverId = validateString(interaction.options.getString("server-id"));
    if (!serverId) {
      await interaction.editReply(getErrorMessage("INVALID_INPUT"));
      return;
    }
    
    const serverOwnerId = await getServerOwnerId(serverId);

    if (serverOwnerId == getUserId(interaction.user.id)) {
      authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.UNSUSPEND_SERVER);
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

    const serverIsSuspended = await isServerSuspended(serverId);
    if (serverIsSuspended == false) {
      await interaction.editReply(getErrorMessage("SERVER_UNSUSPEND_FAILED_ALREADY_ACTIVE"));
      if (config.debug) {
        msgLog.debug(getErrorMessage("SERVER_UNSUSPEND_FAILED_ALREADY_ACTIVE"));
      }
      return;
    }
    
    const apiResult = await getServerInfoById(serverId, interaction.user.id);
    const serverData = await apiResult.body.json();
    const serverMemory = serverData.attributes.limits.memory;

    const availableMemory = await getAvailableUserMemory(getUserId(interaction.user.id), interaction.user.id);
    if (availableMemory - serverMemory < 0) {
      const memoryToFree = (availableMemory - serverMemory) * -1;
      return getErrorMessage("SERVER_UNSUSPENSION_FAILED_MEMORY", memoryToFree);
    }

    const serverIdInt = parseInt(serverId, 10);
    const suspensionStatusCode = await unsuspendServer(serverIdInt);

    if (suspensionStatusCode == 204) {
      interactionReply = `Server with ID: ${serverIdInt} has been unsuspended.`;
    }
    else {
      interactionReply = getErrorMessage("SERVER_UNSUSPEND_FAILED");
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
