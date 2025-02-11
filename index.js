const fs = require('node:fs');
const path = require('node:path');
const { Client: discordClient, Collection, Events, GatewayIntentBits, ActivityType } = require('discord.js');
const { Client: httpClient } = require('undici');
const { discord_token, api_key } = require('./config.json');

const dClient = new discordClient({ intents: [GatewayIntentBits.Guilds] });
const hClient = new httpClient('https://dino.flakey.tech/');

async function setPresence(){
	const result = await hClient.request({
        path: `/api/application/servers`,
        method: 'GET',
        headers: {'Accept': 'application/json', 'content-type': 'application/json', 'Authorization': `Bearer ${api_key}`}
    });
	const jsonString = await result.body.json();
    const jsonData = await jsonString.data;

	dClient.user.setPresence({
		activities: [{
			name: `over ${jsonData.length} servers.`,
			type: ActivityType.Watching
		}],
		status:"online"
	})
};

dClient.once(Events.ClientReady, readyClient => {
	console.log(`${readyClient.user.tag} is ready.`);
	setPresence();
});

dClient.commands = new Collection();

const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
	const commandsPath = path.join(foldersPath, folder);
	const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
	for (const file of commandFiles) {
		const filePath = path.join(commandsPath, file);
		const command = require(filePath);
		// Set a new item in the Collection with the key as the command name and the value as the exported module
		if ('data' in command && 'execute' in command) {
			dClient.commands.set(command.data.name, command);
		} else {
			console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
		}
	}
}

dClient.on(Events.InteractionCreate, async interaction => {
	if (!interaction.isChatInputCommand()) return;

	const command = interaction.client.commands.get(interaction.commandName);

	if (!command) {
		console.error(`No command matching ${interaction.commandName} was found.`);
		return;
	}

    if(command === 'gen-server') {
        await interaction.deferReply();
        await wait(4_000);
        await interaction.editReply('done!');
		setPresence();
    }

	try {
		await command.execute(interaction);
	} catch (error) {
		console.error(error);
		if (interaction.replied || interaction.deferred) {
			await interaction.followUp({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral });
		} else {
			await interaction.reply({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral });
		}
	}
});

dClient.login(discord_token);