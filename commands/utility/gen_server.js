const { SlashCommandBuilder } = require('discord.js');
const { Client } = require('undici');
const { api_key } = require('../../config.json');
const { users } = require('../../users.json');
const client = new Client('https://dino.flakey.tech/');
const wait = require('node:timers/promises').setTimeout;

async function authenticateUserAndReturnUserId(discordId) {
    for (const user of users) {
        if (user.discordId === discordId) {
            return await getUserIdByName(user.panelUsername);
        }
    }
    return -1;
}

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
        console.error(`User '${username}' does not exist`)
        return -1;
    }
}

async function getNestIdByName(nest) { 
    const result = await client.request({
        path: `/api/application/nests`,
        method: 'GET',
        headers: {'Accept': 'application/json', 'content-type': 'application/json', 'Authorization': `Bearer ${api_key}`},
    }); 
    const jsonString = await result.body.json();
    const jsonData = await jsonString.data;
    const filteredData = jsonData.filter((word) => word.attributes.name.toLowerCase().includes(nest.toLowerCase()))[0]
    if(filteredData == undefined) {
        console.error(`Nest '${nest}' does not exist`)
        return -1;
    }
    else {
        return filteredData.attributes.id;
    }
}

async function getEggIdByName(nestId, egg) {
    const result = await client.request({
        path: `/api/application/nests/${nestId}/eggs`,
        method: 'GET',
        headers: {'Accept': 'application/json', 'content-type': 'application/json', 'Authorization': `Bearer ${api_key}`}
    });
    const jsonString = await result.body.json();
    const jsonData = await jsonString.data;
    const filteredData = jsonData.filter((word) => word.attributes.name.toLowerCase().includes(egg.toLowerCase()))[0]
    if(filteredData == undefined) {
        console.error(`Egg '${egg}' does not exist`)
        return -1;
    }
    else {
        return filteredData.attributes.id;
    }
}

async function getDefaultAllocation() {
    const result = await client.request({
        path: `/api/application/nodes/1/allocations`,
        method: 'GET',
        headers: {'Accept': 'application/json', 'content-type': 'application/json', 'Authorization': `Bearer ${api_key}`}
    });
    const jsonString = await result.body.json();
    const jsonData = await jsonString.data;

    for(i=0;i<jsonData.length;i++) {
        if(!jsonData[i].attributes.assigned && jsonData[i].attributes.alias == null) {
            return jsonData[i].attributes.id;
        }
    }
    return -1;
}

async function getEggData(nestId, eggId) {
    const result = await client.request({
        path: `/api/application/nests/${nestId}/eggs/${eggId}?include=variables`,
        method: 'GET',
        headers: {'Accept': 'application/json', 'content-type': 'application/json', 'Authorization': `Bearer ${api_key}`}
    });
    const jsonString = await result.body.json();
    const jsonData = await jsonString.attributes;
    
    if(jsonData == undefined) {
        return -1;
    }
    else {
        return jsonData;
    }
}

function extractEnvVariables(jsonData) {
    const envVariables = {};

    jsonData.data.forEach(item => {
        const { env_variable, default_value } = item.attributes;
        envVariables[env_variable] = default_value;
    });
    return envVariables;
}

async function createServer(name, nest, egg, memory, discordId) {
    const testRequest = false;
    if(name == "" || name == null) {
        return `Server name cannot be blank.`
    }
    const userId = await authenticateUserAndReturnUserId(discordId);
    if(userId == -1) {
        return `Unable to find any authenticatable user based on your Discord account.\nPlease let <@132675281348460544> know if you believe this is in error.`
    }
    const nestId = await getNestIdByName(nest);
    if(nestId == -1) {
        return `Nest ${nest} does not exist.\nPlease try again.`
    }
    const eggId = await getEggIdByName(nestId, egg);
    if(eggId == -1) {
        return `Egg ${egg} does not exist.\nPlease try again.`
    }
    const defaultAllocation = await getDefaultAllocation();
    if(defaultAllocation == -1) {
        return `Could not find a port to assign to the server.\nPlease let <@132675281348460544> know.`
    }
    const eggInfo = await getEggData(nestId, eggId);
    if(eggInfo == -1) {
        return `Egg info could not be returned.\nPlease let <@132675281348460544> know.`
    }

    const requestBody = JSON.stringify({
        "name": name,
        "user": userId,
        "egg": eggId,
        "docker_image": eggInfo.docker_image,
        "startup": eggInfo.startup,
        "environment" : extractEnvVariables(eggInfo.relationships.variables),
        "limits": {
            "memory": memory,
            "swap": 0,
            "disk": 0,
            "io": 500,
            "cpu": 400
        },
        "feature_limits": {
            "databases": 0,
            "backups": 24,
            "allocations": 2
        },
        "allocation": {
            "default": defaultAllocation
        }
    })

    if(testRequest) {
        return `Request was marked as test, no real API request was made, check console for details.`;
    }

    const result = await client.request({
        path: `/api/application/servers`,
        method: 'POST',
        headers: {'Accept': 'application/json', 'content-type': 'application/json', 'Authorization': `Bearer ${api_key}`},
        body: requestBody
    });

    // take buffer data, turn into text, then into a json object
    const bufferData = await result.body.arrayBuffer();
    const buffer = Buffer.from(bufferData);
    const text = buffer.toString('utf-8');
    const jsonText = JSON.parse(text);

    if(result.statusCode == 201) {
        console.log(`A server was created.\n${text}`)
        return `Server '${jsonText.attributes.name}' successfully created and is currently installing and should be available at https://dino.flakey.tech/server/${jsonText.attributes.identifier}`
    }
    else {
        console.error(`Server creation failed.\n${text}`)
        return `The API responded but returned an error, please check your request or try again later. HTTP Code: ${result.statusCode}`
    }
    
}

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
            option.setName('nest')
                .setDescription('/get-nests for details')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('egg')
                .setDescription('/get-eggs for details')
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option.setName('memory')
                .setDescription('Container Memory (MB)')
                .setRequired(true)
        ),

	async execute(interaction) {
        const discordId = interaction.user.id;
        const serverName = interaction.options.getString('server-name');
        const nestName = interaction.options.getString('nest');
        const eggName = interaction.options.getString('egg');
        const memoryMB = interaction.options.getInteger('memory');
        const serverResult = await createServer(serverName, nestName, eggName, memoryMB, discordId)

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

