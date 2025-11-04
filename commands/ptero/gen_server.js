const { SlashCommandBuilder } = require('discord.js');
const config = require('../../config.json');
const users = require('../../users.json');
const wait = require('node:timers/promises').setTimeout;
const { PERMISSIONS, authenticateUserForPermission } = require ('../../permissions.js');
const { apiCall, extractEnvVariables } = require('../../utility/helper_functions.js');
const { getEggData, getNodeIdByName, getNestIdByName, getEggIdByName } = require('../../utility/server_functions.js');

async function getDefaultAllocation(node) {
    const apiResult = await apiCall(`application/nodes/${node}/allocations`, 'GET');

    for(i=0;i<apiResult.length;i++) {
        if(!apiResult[i].attributes.assigned && (apiResult[i].attributes.alias == null || (apiResult[i].attributes.alias != null && apiResult[i].attributes.ip == "0.0.0.0"))) {
            return apiResult[i].attributes.id;
        }
    }
    return -1;
}

async function checkAvailableMemory(userId, discordId, memory) {
    const apiResult = await apiCall(`application/users/${userId}?include=servers`, 'GET');
    
    if(apiResult == -1) {
        return apiResult;
    }
    else {
        memoryOverusage = 0;
        totalMemoryUsage = 0;
        for(i=0;i<jsonData.relationships.servers.data.length;i++) {
            totalMemoryUsage += jsonData.relationships.servers.data[i].attributes.limits.memory
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

async function createServer(name, node, nest, egg, memory, discordId) {
    const userId = authenticateUserForPermission(discordId, PERMISSIONS.CREATE_SERVER);
    
    if(userId == -1) {
        return `Unable to find any authenticatable user based on your Discord account.\nPlease let <@132675281348460544> know if you believe this is in error.`
    }
    else if(userId == -2) {
        return `You do not have permission to create a server.\nPlease let <@132675281348460544> know if you believe this is in error.`
    }

    if(name == "" || name == null) {
        return `Server name cannot be blank.`
    }
    const nodeId = await getNodeIdByName(node);
    if(nodeId == -1) {
        return `Node ${node} does not exist.\nPlease try again.`
    }
    else if(typeof(nodeId) === "string") {
        return nodeId
    }

    overheadMemory = 128;
    const nestId = await getNestIdByName(nest);
    if(nestId == -1) {
        return `Nest ${nest} does not exist.\nPlease try again.`
    }
    if(nestId == 1) {
        overheadMemory = config['java_overhead_mb']; // add java overhead for minecraft servers
    }

    const eggId = await getEggIdByName(nestId, egg);
    if(eggId == -1) {
        return `Egg ${egg} does not exist.\nPlease try again.`
    }

    const memoryExceedingUsage = await checkAvailableMemory(userId, discordId, memory);
    if(memoryExceedingUsage > 0) {
        return `Creating this server would put your over your allowed maximum memory usage.\nPlease free up at least ${memoryExceedingUsage} MB of memory by suspending or deleting other active servers before creating a new one.`
    }

    const defaultAllocation = await getDefaultAllocation(nodeId);
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

    const resultBuffer = await apiResult.body.arrayBuffer();
    const responseJson = JSON.parse(Buffer.from(resultBuffer).toString('utf-8'));

    if(apiResult.statusCode == 201) {
        console.log(`A server was created.\n${text}`)
        return `Server '${responseJson.attributes.name}' was successfully created and is currently installing at: https://dino.flakey.tech/server/${jsonText.attributes.identifier}`
    }
    else {
        console.error(`Server creation failed.\n${text}`)
        return `The API responded but returned an error, please check your request or try again later. HTTP Code: ${apiResult.statusCode}\n<@132675281348460544>`
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
        const discordId = interaction.user.id;
        const serverName = interaction.options.getString('server-name');
        const nodeName = interaction.options.getString('node');
        const nestName = interaction.options.getString('nest');
        const eggName = interaction.options.getString('egg');
        const memoryMB = interaction.options.getInteger('memory');
        const serverResult = await createServer(serverName, nodeName, nestName, eggName, memoryMB, discordId)

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

