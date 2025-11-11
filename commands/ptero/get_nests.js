const { SlashCommandBuilder } = require("discord.js");
const msgLog = require("../../utility/logger.js");
const config = require("../../config.json");
const { getNests } = require("../../utility/server_functions.js");
const { formatNames, reconstructCommand } = require("../../utility/helper_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("get-nests")
    .setDescription("Gets the names of available nests."),
  async execute(interaction) {
    await interaction.deferReply();
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);
    const authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.READ_NESTS);
    let interactionReply = "";
    if (authenticated == -1) {
      await interaction.editReply(getErrorMessage("USER_NOT_FOUND"));
      return;
    }
    else if (authenticated == false) {
      await interaction.editReply(getErrorMessage("INSUFFICIENT_PERMISSIONS"));
      return;
    }

    const nestData = await getNests();

    if (nestData) {
      interactionReply = "```List of Nests:\n\n" + formatNames(nestData) + "```";
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
