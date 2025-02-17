const { SlashCommandBuilder } = require('discord.js');
const { Client } = require('undici');
const { api_key } = require('../../config.json');
const client = new Client('https://dino.flakey.tech/');
const wait = require('node:timers/promises').setTimeout;

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

function formatNames(jsonData) {
    if (!jsonData || !Array.isArray(jsonData.data)) {
        throw new Error("Invalid input: Expected an object with a 'data' array.");
    }

    return jsonData.data.map(item => `- ${item.attributes.name}`).join("\n");
}

async function getEggs(nestId) {
    const result = await client.request({
            path: `/api/application/nests/${nestId}/eggs`,
            method: 'GET',
            headers: {'Accept': 'application/json', 'content-type': 'application/json', 'Authorization': `Bearer ${api_key}`},
        }); 
        const jsonString = await result.body.json();
        const formattedString = formatNames(jsonString)

        return "```List of Eggs:\n\n" + formattedString + "```"
       
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('get-eggs')
        .setDescription('Gets the names of available eggs. Requires the name of a Nest.')
        .addStringOption(option =>
            option.setName('nest')
                .setDescription('Game Name')
                .setRequired(true)
        ),
    async execute(interaction) {
        const nestId = await getNestIdByName(interaction.options.getString('nest'));
        const eggData = await getEggs(nestId);

        await interaction.deferReply();
        await wait(1_500);
        if(typeof(eggData) === "string") {
            await interaction.editReply(eggData);
        }
        else {
            await interaction.editReply("Server did not respond in time, it's likely the request timed out.");
        }
        
    },
};