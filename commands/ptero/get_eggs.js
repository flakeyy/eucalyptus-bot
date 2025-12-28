const { SlashCommandBuilder } = require("discord.js");
const msgLog = require("../../utility/logger.js");
const config = require("../../config.json");
const { getEggs, getNestIdByName } = require("../../utility/server_functions.js");
const { formatNames, reconstructCommand, validateString } = require("../../utility/helper_functions.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("get-eggs")
    .setDescription("Gets the names of available eggs. Requires the name of a Nest.")
    .addStringOption(option =>
      option.setName("nest")
        .setDescription("Game Name")
        .setRequired(true)
    ),
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

    const nestName = validateString(interaction.options.getString("nest"));
    if (!nestName) {
      await interaction.editReply(getErrorMessage("INVALID_INPUT"));
      return;
    }

    const nestId = await getNestIdByName(nestName);
    const eggData = await getEggs(nestId);

    if (eggData) {
      interactionReply = "```List of Eggs:\n\n" + formatNames(eggData) + "```";
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
