const { SlashCommandBuilder } = require('discord.js');
const { Client } = require('undici');
const { api_key } = require('../../config.json');
const client = new Client('https://dino.flakey.tech/');
const wait = require('node:timers/promises').setTimeout;

async function getUserIdByName(username) {
    const result = await client.request({
        path: `/api/application/users?filter[username]=${username}`,
        method: 'GET',
        headers: {'Accept': 'application/json', 'content-type': 'application/json', 'Authorization': `Bearer ${api_key}`}
    });
    const jsonString = await result.body.json();
    const jsonObject = await jsonString.data[0];
    try {
        return jsonObject.attributes.id;
    } catch(error) {
        console.error(`User ${username} does not exist`)
        return -1;
    }
    
}

// CANT FILTER NESTS
async function getNestIdByName(nest) { 
    const result = await client.request({
        path: `/api/application/nests?filter[name]=${nest}`,
        method: 'GET',
        headers: {'Accept': 'application/json', 'content-type': 'application/json', 'Authorization': `Bearer ${api_key}`}
    }); 
    const jsonString = await result.body.json();
    const jsonObject = await jsonString.data[0];
    try {
        return jsonObject.attributes.id;
    } catch(error) {
        console.error(`Nest ${nest} does not exist`)
        return -1;
    }
}

// CANT FILTER EGGS
async function getEggIdByName(nestId, egg) {
    const result = await client.request({
        path: `/api/application/nests/${nestId}/eggs?filter[name]=${egg}`,
        method: 'GET',
        headers: {'Accept': 'application/json', 'content-type': 'application/json', 'Authorization': `Bearer ${api_key}`}
    });
    const jsonString = await result.body.json();
    const jsonObject = await jsonString.data[0];
    try {
        console.
        console.log(jsonObject);
        console.log(jsonObject.attributes.name);
        return jsonObject.attributes.id;
    } catch(error) {
        console.error(`Egg ${egg} does not exist`)
        return -1;
    }
}


async function createServer(name, user, nest, egg, memory) {
    console.log("starting server creation")
    returnMessage = "";
    const userId = await getUserIdByName(user);
    const nestId = await getNestIdByName(nest);
    const eggId = await getEggIdByName(nestId, egg);

    if(name == "" || name == null) {
        returnMessage = `Server name cannot be blank.`
    }
    else if(userId == -1) {
        returnMessage = `User ${user} does not exist.\nPlease try again.`
    }
    else if(nestId == -1) {
        returnMessage = `Nest ${nest} does not exist.\nPlease try again.`
    }
    else if(eggId == -1) {
        returnMessage = `Egg ${egg} does not exist.\nPlease try again.`
    }
    else {
        returnMessage = `Server successfully created.\nname: ${name}, user: ${user}, nest: ${nest}, egg: ${egg}, memory: ${memory}`
    }
    console.log("finishing server creation")
    return returnMessage

}

/*client.request({
    path: '/application/servers',
    method: 'POST',
    headers: '',
    body: '?'
})*/

module.exports = {
	data: new SlashCommandBuilder()
		.setName('gen-server')
		.setDescription('Generates a server on https://dino.flakey.tech/')
        .addStringOption(option =>
            option.setName('server-name')
                .setDescription('Server Name')
                .setRequired(true)
        )
        .addStringOption(option => 
            option.setName('user')
                .setDescription('Your Panel Username')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('nest')
                .setDescription('The Game Name')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('egg')
                .setDescription('The Server Type (if supported)')
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option.setName('memory')
                .setDescription('Container Memory (MB)')
                .setRequired(true)
        ),

	async execute(interaction) {
        const serverName = interaction.options.getString('server-name');
        const userName = interaction.options.getString('user');
        const nestName = interaction.options.getString('nest');
        const eggName = interaction.options.getString('egg');
        const memoryMB = interaction.options.getInteger('memory')
        
        const serverResult = await createServer(serverName, userName, nestName, eggName, memoryMB)

        await interaction.deferReply();
        await wait(2_500);
        if(typeof(serverResult) === "string") {
            await interaction.editReply(serverResult);
        }
        else {
            await interaction.editReply("Server did not respond in time, it's likely the request timed out.\nPlease check if the server was created before continuing with further requests.");
        }
        
	},
};

