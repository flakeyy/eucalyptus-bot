const { SlashCommandBuilder } = require('discord.js');
const config = require('../../config.json');
const users = require('../../users.json');
const wait = require('node:timers/promises').setTimeout;
const { PERMISSIONS, authenticateUserForPermission } = require ('../../permissions.js');
const { apiCall, extractEnvVariables, getUserId } = require('../../utility/helper_functions.js');
const { getEggData, getNodeIdByName, getNestIdByName, getEggIdByName } = require('../../utility/server_functions.js');
const { getErrorMessage } = require('../../error_messages.js');
const { json } = require('node:stream/consumers');

async function getDefaultAllocation(node) {
    const apiResult = await apiCall(`application/nodes/${node}/allocations`, 'GET');
    const jsonString = await apiResult.body.json();
    const jsonData = await jsonString.data;

    for(i=0;i<jsonData.length;i++) {
        if(!jsonData[i].attributes.assigned && (jsonData[i].attributes.alias == null || (jsonData[i].attributes.alias != null && jsonData[i].attributes.ip == "0.0.0.0"))) {
            return jsonData[i].attributes.id;
        }
    }
    return -1;
}

async function checkAvailableUserMemory(userId, discordId, memory) {
    const apiResult = await apiCall(`application/users/${userId}?include=servers`, 'GET');
    const jsonData = await apiResult.body.json();
    
    if(apiResult == -1) {
        return apiResult;
    }
    else {
        memoryOverusage = 0;
        totalMemoryUsage = 0;
        for(i=0;i<jsonData.attributes.relationships.servers.data.length;i++) {
            totalMemoryUsage += jsonData.attributes.relationships.servers.data[i].attributes.limits.memory
        }
        for(i=0;i<users.users.length;i++) {
            if(users.users[i].discordId == discordId) {
                if(totalMemoryUsage + memory > users.users[i].maximumAllowedMemory && users.users[i].maximumAllowedMemory != -1) {
                    memoryOverusage = (totalMemoryUsage + memory) - users.users[i].maximumAllowedMemory;
                }
                else {
                    memoryOverusage = -1;
                }
            }
        }
        return memoryOverusage;
    }
}

async function createServer(name, node, nest, egg, memory, discordId, userId) {
    if(name == "" || name == null) {
        return getErrorMessage('INVALID_SERVER_NAME');
    }
    const nodeId = await getNodeIdByName(node);
    if(nodeId == -1) {
        return getErrorMessage('NODE_NOT_FOUND');
    }
    else if(typeof(nodeId) === "string") {
        return nodeId
    }

    overheadMemory = 128;
    const nestId = await getNestIdByName(nest);
    if(nestId == -1) {
        return getErrorMessage('NEST_NOT_FOUND');
    }
    if(nestId == 1) {
        overheadMemory = config['java_overhead_mb']; // add java overhead for minecraft servers
    }

    const eggId = await getEggIdByName(nestId, egg);
    if(eggId == -1) {
        return getErrorMessage('EGG_NOT_FOUND');
    }

    const memoryExceedingUsage = await checkAvailableUserMemory(userId, discordId, memory);
    if(memoryExceedingUsage > 0) {
        return getErrorMessage('MEMORY_EXCEEDS_LIMIT', memoryExceedingUsage);
    }

    const defaultAllocation = await getDefaultAllocation(nodeId);
    if(defaultAllocation == -1) {
        return getErrorMessage('ALLOCATION_NOT_FOUND');
    }

    const eggInfo = await getEggData(nestId, eggId);
    if(eggInfo == -1) {
        return getErrorMessage('EGG_INFO_NOT_RETURNED');
    }

    const requestBody = JSON.stringify({
        "name": name,
        "user": userId,
        "egg": eggId,
        "docker_image": eggInfo.attributes.docker_image,
        "startup": eggInfo.attributes.startup,
        "environment" : extractEnvVariables(eggInfo.attributes.relationships.variables),
        "limits": {
            "memory": memory,
            "overhead_memory": overheadMemory,
            "swap": -1,
            "disk": 0,
            "io": 500,
            "cpu": 800
        },
        "feature_limits": {
            "databases": 0,
            "backups": 24,
            "allocations": 4
        },
        "allocation": {
            "default": defaultAllocation
        }
    })

    if(config['developer_mode']) {
        console.log(requestBody);
        return `Developer mode enabled, no real API request was made, check console for details.`;
    }

    const apiResult = await apiCall(`application/servers`, 'POST', requestBody);

    const bufferData = await apiResult.body.arrayBuffer();
    const buffer = Buffer.from(bufferData);
    const text = buffer.toString('utf-8');
    const jsonText = JSON.parse(text);

    if(apiResult.statusCode == 201) {
        console.log(`A server was created.\n${text}`)
        return `Server '${jsonText.attributes.name}' was successfully created and is currently installing at: https://dino.flakey.tech/server/${jsonText.attributes.identifier}`
    }
    else {
        console.error(`Server creation failed.\n${text}`)
        return getErrorMessage('API_REQUEST_FAILED', apiResult.statusCode);
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
            option.setName('node')
                .setDescription('/get-nodes for details')
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
        const authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.CREATE_SERVER);
        if(authenticated == -1) {
            interaction.reply(getErrorMessage('USER_NOT_FOUND'));
            return;
        }
        else if(authenticated == false) {
            interaction.reply(getErrorMessage('INSUFFICIENT_PERMISSIONS'));
            return;
        }

        const panelId = getUserId(interaction.user.id);
        const discordId = interaction.user.id;
        const serverName = interaction.options.getString('server-name');
        const nodeName = interaction.options.getString('node');
        const nestName = interaction.options.getString('nest');
        const eggName = interaction.options.getString('egg');
        const memoryMB = interaction.options.getInteger('memory');
        const serverResult = await createServer(serverName, nodeName, nestName, eggName, memoryMB, discordId, panelId)

        interactionReply = serverResult;

        await interaction.deferReply();
        await wait(2_500);
        if(typeof(serverResult) === "string") {
            await interaction.editReply(serverResult);
        }
        else {
            await interaction.editReply(getErrorMessage('SERVER_CREATION_TIMEOUT'));
        }
        
	},
};

