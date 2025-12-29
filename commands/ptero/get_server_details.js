const { SlashCommandBuilder } = require("discord.js");
const msgLog = require("../../utility/logger.js");
const config = require("../../config.json");
const { reconstructCommand, userHasClientApiKey, validateString } = require("../../utility/helper_functions.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const { getServerInfoById, getServerResourceInfoById } = require("../../utility/server_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("get-server-details")
    .setDescription("Get the details of a specific server that you own.")
    .addStringOption(option =>
      option.setName("id")
        .setDescription("Server ID, use /get-servers to get IDs.")
        .setRequired(true)
    ),
  async execute(interaction) {
    await interaction.deferReply();
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);
    const authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.READ_SERVERS);
    let interactionReply = "";
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

    const serverId = validateString(interaction.options.getString("id"));

    const serverInfoApi = await getServerInfoById(serverId, interaction.user.id);
    const serverInfo = await serverInfoApi.body.json();

    if(serverInfoApi.statusCode === 401) {
        await interaction.editReply(getErrorMessage("CLIENT_API_FAILURE"));
        return;
    }
    else if(serverInfoApi.statusCode === 404) {
            await interaction.editReply(getErrorMessage("SERVER_NOT_FOUND"));
        return;
    }

    const serverResourceApi = await getServerResourceInfoById(serverId, interaction.user.id);
    const serverResourceInfo = await serverResourceApi.body.json();

    if(serverInfoApi.statusCode === 200 && serverResourceApi.statusCode === 200) {
        interactionReply = `\`\`\`\n`+
            `Name: ${serverInfo.attributes.name}\n`+
            `State: ${(serverResourceInfo.attributes.is_suspended ? "Suspended" : "Active, " + serverResourceInfo.attributes.current_state)}\n`+
            `Mem Usage: ${serverResourceInfo.attributes.resources.memory_bytes / 1_000_000}/${serverInfo.attributes.limits.memory} MB\n`+
            `Disk Usage: ${(serverResourceInfo.attributes.resources.disk_bytes / 1_000_000_000).toFixed(2)} GB\n`+
            `Threads: ${serverInfo.attributes.limits.cpu/100}\n`+
            `Node: ${serverInfo.attributes.node}\n`+
            `\`\`\``;
    }
    

    if (interactionReply !== "") {
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
