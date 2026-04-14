const { ContainerBuilder, SlashCommandBuilder, MessageFlags } = require("discord.js");
const msgLog = require("../../utility/logger.js");
const config = require("../../config.json");
const { reconstructCommand, getCommands } = require("../../utility/helper_functions.js");

const COLORS = {
  PRIMARY: 0x6b34eb
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("Displays available commands."),
  async execute(interaction) {
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);

    try {
      const commands = await getCommands();

      const helpText =
        "**Available Commands**\n\n" +
        "_Client API key must be set before using many commands!_\n\n" +
        `${commands.map(cmd => `**/${cmd.name}** - ${cmd.description}`).join("\n")}`;

      if (config.debug) {
        msgLog.debug(`Help command executed for ${interaction.user.username}`);
      }

      const container = new ContainerBuilder()
        .setAccentColor(COLORS.PRIMARY)
        .addTextDisplayComponents(text =>
          text.setContent(helpText)
        );

      await interaction.reply({
        components: [ container ],
        flags: MessageFlags.IsComponentsV2
      });

    } catch (error) {
      msgLog.error(`Error in help command: ${error.message}`);
      const errorMessage = {
        content: "An error occurred while loading commands.",
        ephemeral: true
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorMessage).catch(() => {});
      } else {
        await interaction.reply(errorMessage).catch(() => {});
      }
    }
  }
};
