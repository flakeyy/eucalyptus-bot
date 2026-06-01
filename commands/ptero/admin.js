const { SlashCommandBuilder, MessageFlags } = require("discord.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const msgLog = require("../../utility/logger.js");
const { reconstructCommand } = require("../../utility/helper_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");
const {
  handleUserView,
  handleUserCreate,
  handleUserEdit,
  handleUserDelete
} = require("./admin/user_handlers.js");
const {
  handleAdminServers,
  handleAdminServersView
} = require("./admin/server_handlers.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Administrator tools for managing users and servers.")
    .addSubcommandGroup(group =>
      group
        .setName("user")
        .setDescription("Manage bot users.")
        .addSubcommand(sub =>
          sub
            .setName("view")
            .setDescription("View a user's bot profile.")
            .addUserOption(opt =>
              opt.setName("user").setDescription("The Discord user to look up.").setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName("create")
            .setDescription("Add a Discord user to the bot database.")
            .addUserOption(opt =>
              opt.setName("user").setDescription("The Discord user to add.").setRequired(true)
            )
            .addStringOption(opt =>
              opt.setName("panel_username").setDescription("Their Pterodactyl panel username.").setRequired(true)
            )
            .addIntegerOption(opt =>
              opt.setName("panel_id").setDescription("Their numeric Pterodactyl user ID.").setRequired(true)
            )
            .addIntegerOption(opt =>
              opt.setName("max_memory").setDescription("Maximum memory in MB (-1 = unlimited). Default: -1.").setRequired(false)
            )
            .addIntegerOption(opt =>
              opt.setName("permissions").setDescription("Permission bitmask. Default: 0.").setRequired(false)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName("edit")
            .setDescription("Interactively edit a user's bot profile.")
            .addUserOption(opt =>
              opt.setName("user").setDescription("The Discord user to edit.").setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName("delete")
            .setDescription("Remove a user from the bot database.")
            .addUserOption(opt =>
              opt.setName("user").setDescription("The Discord user to remove.").setRequired(true)
            )
        )
    )
    .addSubcommandGroup(group =>
      group
        .setName("servers")
        .setDescription("Admin server management.")
        .addSubcommand(sub =>
          sub
            .setName("view")
            .setDescription("View servers.")
            .addStringOption(opt =>
              opt
                .setName("filter")
                .setDescription("Which servers to show. Default: online only.")
                .setRequired(false)
                .addChoices(
                  { name: "Online only", value: "online" },
                  { name: "All servers", value: "all" }
                )
            )
        )
        .addSubcommand(sub =>
          sub
            .setName("manage")
            .setDescription("Manage a user's servers as admin (bypasses memory limits).")
            .addUserOption(opt =>
              opt.setName("user").setDescription("The Discord user whose servers to manage.").setRequired(true)
            )
        )
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);

    const authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.ADMINISTRATOR);
    if (authenticated === -1) {
      await interaction.editReply(getErrorMessage("USER_NOT_FOUND"));
      return;
    }
    if (authenticated === false) {
      await interaction.editReply(getErrorMessage("INSUFFICIENT_PERMISSIONS"));
      return;
    }

    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommandGroup === "user") {
        if (subcommand === "view") await handleUserView(interaction);
        else if (subcommand === "create") await handleUserCreate(interaction);
        else if (subcommand === "edit") await handleUserEdit(interaction);
        else if (subcommand === "delete") await handleUserDelete(interaction);
      } else if (subcommandGroup === "servers") {
        if (subcommand === "view") await handleAdminServersView(interaction);
        else if (subcommand === "manage") await handleAdminServers(interaction);
      }
    } catch (error) {
      msgLog.error(`Error in admin command (${subcommandGroup}/${subcommand}): ${error.message}`);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: "An error occurred while executing this command.", flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await interaction.editReply({ content: "An error occurred while executing this command.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  }
};
