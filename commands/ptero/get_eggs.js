const { SlashCommandBuilder } = require("discord.js");
const wait = require("node:timers/promises").setTimeout;
const { getEggs, getNestIdByName } = require("../../utility/server_functions.js");
const { formatNames } = require("../../utility/helper_functions.js");
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
    const authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.READ_EGGS);
    if (authenticated == -1) {
      interaction.reply(getErrorMessage("USER_NOT_FOUND"));
      return;
    }
    else if (authenticated == false) {
      interaction.reply(getErrorMessage("INSUFFICIENT_PERMISSIONS"));
      return;
    }

    const nestId = await getNestIdByName(interaction.options.getString("nest"));
    const eggData = await getEggs(nestId);

    const interactionReply = "```List of Eggs:\n\n" + formatNames(eggData) + "```";

    await interaction.deferReply();
    await wait(1_500);
    if (eggData) {
      await interaction.editReply(interactionReply);
    }
    else {
      await interaction.editReply(getErrorMessage("SERVER_TIMEOUT"));
    }

  }
};
