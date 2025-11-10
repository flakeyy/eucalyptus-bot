const { SlashCommandBuilder } = require("discord.js");
const wait = require("node:timers/promises").setTimeout;
const msgLog = require("../../utility/logger.js")
const { getNests } = require("../../utility/server_functions.js");
const { formatNames } = require("../../utility/helper_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");
const { PERMISSIONS, authenticateUserForPermission } = require ("../../utility/permissions.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("get-nests")
    .setDescription("Gets the names of available nests."),
  async execute(interaction) {
    const authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.READ_NESTS);
    let interactionReply = "";
    if (authenticated == -1) {
      interaction.reply(getErrorMessage("USER_NOT_FOUND"));
      return;
    }
    else if (authenticated == false) {
      interaction.reply(getErrorMessage("INSUFFICIENT_PERMISSIONS"));
      return;
    }

    const nestData = await getNests();

    await interaction.deferReply();
    await wait(1_000);

    if(nestData) {
      interactionReply = "```List of Nests:\n\n" + formatNames(nestData) + "```";
    }

    if (interactionReply != "") {
      msgLog.log(interaction.user.id, '|', interactionReply)
      await interaction.editReply(interactionReply);
    }
    else {
      msgLog.warn(interaction.user.id, '|', getErrorMessage("SERVER_TIMEOUT"))
      await interaction.editReply(getErrorMessage("SERVER_TIMEOUT"));
    }
  }
};
