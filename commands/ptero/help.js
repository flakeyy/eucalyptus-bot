const { SlashCommandBuilder } = require("discord.js");
const msgLog = require("../../utility/logger.js");
const config = require("../../config.json");
const { reconstructCommand, getCommands } = require("../../utility/helper_functions.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("Displays available commands."),
  async execute(interaction) {
    await interaction.deferReply();
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);

    const commands = await getCommands();

    interactionReply = `\`\`\`\n`+
        `Available Commands:\n`+
        `Client API key must be set before using most commands!\n\n`+
        `${commands.map(cmd => `/${cmd.name} - ${cmd.description}`).join("\n")}` +
        `\`\`\``;

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
