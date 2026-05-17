const { ContainerBuilder, SlashCommandBuilder, MessageFlags } = require("discord.js");
const msgLog = require("../../utility/logger.js");
const { reconstructCommand, getMonitorUptime } = require("../../utility/helper_functions.js");

const COLORS = {
  PRIMARY: 0x6b34eb
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName("info")
    .setDescription("Retrieves current service information."),
  async execute(interaction) {
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);

    try {
      const panelUptime = await getMonitorUptime("panel");
      const nodeUptime = await getMonitorUptime("node");

      const provider = (process.env.UPTIME_PROVIDER || "kuma").toLowerCase();
      const uptimeStatusUrl = process.env.UPTIME_URL && process.env.UPTIME_SLUG
        ? (provider === "custom"
          ? `${process.env.UPTIME_URL}/p/${process.env.UPTIME_SLUG}`
          : `${process.env.UPTIME_URL}/status/${process.env.UPTIME_SLUG}`)
        : null;

      const infoText =
        "**cathost/pyrodactyl bot**\n" +
        `v${global.version}/${global.commitHash}\n\n` +
        `**Hosting:** ${global.serverCount} servers for ${global.userCount} users\n` +
        `**Panel:** ${process.env.PANEL_URL}\n` +
        (uptimeStatusUrl ? `**Uptime:** ${uptimeStatusUrl}\n` : "") +
        `  • Panel: ${panelUptime !== null ? panelUptime + "%" : "Unavailable"} (24 hrs)\n` +
        `  • Server Node: ${nodeUptime !== null ? nodeUptime + "%" : "Unavailable"} (24 hrs)\n\n` +
        "/service for more specific service information.\n\n" +
        "_developed by flakey_";

      const container = new ContainerBuilder()
        .setAccentColor(COLORS.PRIMARY)
        .addTextDisplayComponents(text =>
          text.setContent(infoText)
        );

      await interaction.reply({
        components: [ container ],
        flags: MessageFlags.IsComponentsV2
      });

    } catch (error) {
      msgLog.error(`Error in info command: ${error.message}`);
      const errorMessage = {
        content: "An error occurred while loading the service information.",
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
