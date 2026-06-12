const { ContainerBuilder, SlashCommandBuilder, MessageFlags } = require("discord.js");
const msgLog = require("../../utility/logger.js");
const config = require("../../config.json");
const { reconstructCommand, getCommands } = require("../../utility/helper_functions.js");
const { COLORS } = require("../../utility/constants.js");

// Display order for /help; categories not listed here sort after, alphabetically.
const CATEGORY_ORDER = [ "Getting Started", "Servers", "Panel", "Admin" ];
const FALLBACK_CATEGORY = "Other";

function buildHelpText(commands) {
  const grouped = new Map();
  for (const cmd of commands) {
    const category = cmd.category || FALLBACK_CATEGORY;
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category).push(cmd);
  }

  const sortedCategories = [ ...grouped.keys() ].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a);
    const bi = CATEGORY_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  const sections = sortedCategories.map(category => {
    const lines = grouped.get(category).map(cmd =>
      `**/${cmd.name}**${cmd.requiresApiKey ? " 🔑" : ""} - ${cmd.description}`
    );
    return `**${category}**\n${lines.join("\n")}`;
  });

  return "**Available Commands**\n\n" +
    `${sections.join("\n\n")}\n\n` +
    "_🔑 requires a client API key — set one with /set-client-key._";
}

module.exports = {
  category: "Getting Started",

  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("Displays available commands."),
  async execute(interaction) {
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);

    try {
      const commands = await getCommands({ includeMeta: true });

      const helpText = buildHelpText(commands);

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
        flags: MessageFlags.Ephemeral
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorMessage).catch(() => {});
      } else {
        await interaction.reply(errorMessage).catch(() => {});
      }
    }
  }
};
