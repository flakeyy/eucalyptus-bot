const { SlashCommandBuilder } = require('discord.js');
const { Client } = require('undici');
const client = new Client('https://dino.flakey.tech/api/');
const wait = require('node:timers/promises').setTimeout;

/*client.request({
    path: '/application/servers',
    method: 'POST',
    headers: '',
    body: '?'
})*/

module.exports = {
	data: new SlashCommandBuilder()
		.setName('gen-server')
		.setDescription('Generates a server on https://dino.flakey.tech/'),
	async execute(interaction) {
        await interaction.deferReply();
        await wait(4_000);
        await interaction.editReply('server is ready!');
	},
};