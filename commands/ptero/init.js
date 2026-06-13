const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { validateAndConsumeToken, isBootstrapActive } = require("../../utility/bootstrap.js");
const db = require("../../utility/database.js");
const { PERMISSIONS } = require("../../utility/permissions.js");
const msgLog = require("../../utility/logger.js");

module.exports = {
  category: "Getting Started",

  data: new SlashCommandBuilder()
    .setName("init")
    .setDescription("First-run setup: create the initial admin account.")
    .addStringOption(opt =>
      opt.setName("token").setDescription("Bootstrap token printed to the server console.").setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName("panel_username").setDescription("Your Pterodactyl panel username.").setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName("panel_id").setDescription("Your numeric Pterodactyl user ID.").setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!isBootstrapActive()) {
      await interaction.editReply({ content: "Setup is already complete. This command is no longer available.", flags: MessageFlags.Ephemeral });
      return;
    }

    const token = interaction.options.getString("token");
    const panelUsername = interaction.options.getString("panel_username");
    const panelId = interaction.options.getInteger("panel_id");

    if (!validateAndConsumeToken(token)) {
      msgLog.warn(`${interaction.user.username}/${interaction.user.id} | /init failed — invalid token`);
      await interaction.editReply({ content: "Invalid token. Check the server console and try again.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (db.getUserByDiscordId(interaction.user.id)) {
      await interaction.editReply({ content: "Your account already exists.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (db.getUserByPanelId(panelId)) {
      await interaction.editReply({ content: `Panel ID \`${panelId}\` is already assigned to another user.`, flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      db.createUser(interaction.user.id, panelUsername, panelId, -1, PERMISSIONS.ADMINISTRATOR | PERMISSIONS.IMMUNITY, null);
      msgLog.log(`${interaction.user.username}/${interaction.user.id} | /init | first admin account created (panel: ${panelUsername}, id: ${panelId})`);
      await interaction.editReply({
        content: `**Setup complete!** Your account has been created with Administrator permissions.\n\n**Panel Username:** \`${panelUsername}\`\n**Panel ID:** \`${panelId}\`\n\nYou can now use \`/admin\` to manage other users.`,
        flags: MessageFlags.Ephemeral
      });
    } catch (err) {
      msgLog.error(`/init failed: ${err.message}`);
      await interaction.editReply({ content: `Failed to create account: \`${err.message}\``, flags: MessageFlags.Ephemeral });
    }
  }
};
