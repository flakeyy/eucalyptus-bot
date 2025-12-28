const { SlashCommandBuilder } = require("discord.js");
const msgLog = require("../../utility/logger.js");
const config = require("../../config.json");
const { reconstructCommand, getMonitorUptime } = require("../../utility/helper_functions.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("info")
    .setDescription("Retrieves current service information."),
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

    const panelUptime = await getMonitorUptime('panel');
    const nodeUptime = await getMonitorUptime('node');

    interactionReply = `\`\`\`\n`+
        `cathost/pyrodactyl bot\n`+
        `v${global.version}/${global.commitHash}${(global.isDev ? " | dev" : " | prod")}\n`+
        `\n`+
        `Hosting ${global.serverCount} servers for ${global.userCount} users\n`+ 
        `Panel:  https://dino.flakey.tech\n`+
        `Uptime: https://uptime.flakey.tech/status/node\n`+
        `  - Panel: ${panelUptime != null ? panelUptime + "%" : "Unavailable"} (24 hrs)\n`+
        `  - HMB01 Node: ${nodeUptime != null ? nodeUptime + "%" : "Unavailable"} (24 hrs)\n`+
        `\n`+
        `developed by flakey \n`+
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
