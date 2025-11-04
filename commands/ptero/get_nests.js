const { SlashCommandBuilder } = require('discord.js');
const wait = require('node:timers/promises').setTimeout;
const { getNests } = require('../../utility/server_functions.js');
const { formatNames } = require('../../utility/helper_functions.js');
const { getErrorMessage } = require('../../error_messages.js');
const { PERMISSIONS, authenticateUserForPermission } = require ('../../permissions.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('get-nests')
        .setDescription('Gets the names of available nests.'),
    async execute(interaction) {
        const authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.READ_NESTS);
        if(authenticated == -1) {
            interaction.reply(getErrorMessage('USER_NOT_FOUND'));
            return;
        }
        else if(authenticated == false) {
            interaction.reply(getErrorMessage('INSUFFICIENT_PERMISSIONS'));
            return;
        }

        const nestData = await getNests();

        const formattedString = "```List of Nests:\n\n" + formatNames(nestData) + "```";

        await interaction.deferReply();
        await wait(2_000);
        if(nestData) {
            await interaction.editReply(formattedString);
        }
        else {
            await interaction.editReply(getErrorMessage('SERVER_TIMEOUT'));
        }
        
    },
};