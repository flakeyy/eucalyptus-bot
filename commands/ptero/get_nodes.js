const { SlashCommandBuilder } = require("discord.js");
const msgLog = require("../../utility/logger.js");
const config = require("../../config.json");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const { getNodes } = require("../../utility/server_functions.js");
const { reconstructCommand, userHasClientApiKey } = require("../../utility/helper_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("get-nodes")
    .setDescription("Gets information about available nodes."),
  async execute(interaction) {
    await interaction.deferReply();
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);
    const authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.GET_SERVICE_INFORMATION);
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

    const nodeData = await getNodes();

    if (!nodeData || !Array.isArray(nodeData.data)) {
      throw new Error("Invalid input: Expected an object with a 'data' array.");
    }

    const formattedString = nodeData.data.map(item => `- ${item.attributes.name} | ${item.attributes.description} | MEM: ${item.attributes.allocated_resources.memory}/${item.attributes.memory}MB Allocated`).join("\n");

    if (formattedString) {
      interactionReply = "```List of Nodes:\n\n" + formattedString + "```";
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
