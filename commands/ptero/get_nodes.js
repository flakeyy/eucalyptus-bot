const { SlashCommandBuilder } = require("discord.js");
const wait = require("node:timers/promises").setTimeout;
const msgLog = require("../../utility/logger.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const { getNodes } = require("../../utility/server_functions.js");
const { reconstructCommand } = require("../../utility/helper_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("get-nodes")
    .setDescription("Gets information about available nodes."),
  async execute(interaction) {
    const authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.READ_NODES);
    let interactionReply = "";
    if (authenticated == -1) {
      interaction.reply(getErrorMessage("USER_NOT_FOUND"));
      return;
    }
    else if (authenticated == false) {
      interaction.reply(getErrorMessage("INSUFFICIENT_PERMISSIONS"));
      return;
    }

    const nodeData = await getNodes();

    await interaction.deferReply();
    await wait(1_000);

    if (!nodeData || !Array.isArray(nodeData.data)) {
      throw new Error("Invalid input: Expected an object with a 'data' array.");
    }

    let formattedString = nodeData.data.map(item => `- ${item.attributes.name} | ${item.attributes.description} | MEM: ${item.attributes.allocated_resources.memory}/${item.attributes.memory}MB Allocated`).join("\n");

    if(formattedString) {
      interactionReply = "```List of Nodes:\n\n" + formattedString + "```";
    }

    if (interactionReply != "") {
      msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)} | ${interactionReply}`)
      await interaction.editReply(interactionReply);
    }
    else {
      msgLog.warn(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)} | ${getErrorMessage("SERVER_TIMEOUT")}`)
      await interaction.editReply(getErrorMessage("SERVER_TIMEOUT"));
    }
  }
};
