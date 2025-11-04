const { SlashCommandBuilder } = require('discord.js');
const wait = require('node:timers/promises').setTimeout;
const { formatNames } = require('../../utility/helper_functions.js');
const { PERMISSIONS, authenticateUserForPermission } = require ('../../permissions.js');
const { getNodes } = require('../../utility/server_functions.js');
const { getErrorMessage } = require('../../error_messages.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('get-nodes')
        .setDescription('Gets information about available nodes.'),
    async execute(interaction) {
        const authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.READ_NODES);
        if(authenticated == -1) {
            interaction.reply(getErrorMessage('USER_NOT_FOUND'));
            return;
        }
        else if(authenticated == false) {
            interaction.reply(getErrorMessage('INSUFFICIENT_PERMISSIONS'));
            return;
        }
        
        const nodeData = await getNodes();

        const formattedString = "```List of Nodes:\n\n" + formatNames(nodeData) + "```"

        await interaction.deferReply();
        await wait(2_000);
        if(nodeData) {
            await interaction.editReply(formattedString);
        }
        else {
            await interaction.editReply(getErrorMessage('SERVER_TIMEOUT'));
        }
        
    },
};