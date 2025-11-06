const { SlashCommandBuilder } = require('discord.js');
const { getErrorMessage } = require('../../error_messages');
const wait = require('node:timers/promises').setTimeout;
const { PERMISSIONS, authenticateUserForPermission } = require('../../permissions.js');
const { apiCall } = require('../../utility/helper_functions.js');

async function suspendOwnedServer() {
    const apiResult = await apiCall(`application/servers/${serverId}/suspend`, 'POST');

    const statusCode = await apiResult.statusCode

    if(statusCode == 204) {
        interactionReply = `Server with ID ${serverId} has been suspended successfully.`;
    }
    else {
        interactionReply = getErrorMessage('SERVER_SUSPEND_FAILED');
    }
    
    return statusCode;
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName('suspend-server')
		.setDescription('Suspends a server based on a server ID.')
        .addStringOption(option =>
            option.setName('server-id')
                .setDescription('/get-owned-servers for server IDs')
                .setRequired(true)
        ),

	async execute(interaction) {
        const authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.SUSPEND_OWN_SERVER);
        if(authenticated == -1) {
            interaction.reply(getErrorMessage('USER_NOT_FOUND'));
            return;
        }
        else if(authenticated == false) {
            interaction.reply(getErrorMessage('INSUFFICIENT_PERMISSIONS'));
            return;
        }

        const discordId = interaction.user.id;
        const serverId = interaction.options.getString('server-id');
        suspendOwnedServer(discordId, serverId)

        await interaction.deferReply();
        await wait(2_500);
        if(interactionReply != "") {
            await interaction.editReply(interactionReply);
        }
        else {
            await interaction.editReply(getErrorMessage('SERVER_TIMEOUT'));
        }
        
	},
};