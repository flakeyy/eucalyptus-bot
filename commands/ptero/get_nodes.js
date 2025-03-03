const { SlashCommandBuilder } = require('discord.js');
const { Client } = require('undici');
const { api_key } = require('../../keys.json');
const client = new Client('https://dino.flakey.tech/');
const wait = require('node:timers/promises').setTimeout;

function formatNames(jsonData) {
    if (!jsonData || !Array.isArray(jsonData.data)) {
        throw new Error("Invalid input: Expected an object with a 'data' array.");
    }

    return jsonData.data.map(item => `- '${item.attributes.name}', ${item.attributes.description} | MEM: ${item.attributes.allocated_resources.memory}/${item.attributes.memory}MB Allocated`).join("\n");
}

async function getNodes() {
    const result = await client.request({
            path: `/api/application/nodes`,
            method: 'GET',
            headers: {'Accept': 'application/json', 'content-type': 'application/json', 'Authorization': `Bearer ${api_key}`},
        }); 
        const jsonString = await result.body.json();
        const formattedString = formatNames(jsonString)

        return "```List of Nodes:\n\n" + formattedString + "```"
       
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('get-nodes')
        .setDescription('Gets information about available nodes.'),
    async execute(interaction) {
        const nodeData = await getNodes();

        await interaction.deferReply();
        await wait(2_000);
        if(typeof(nodeData) === "string") {
            await interaction.editReply(nodeData);
        }
        else {
            await interaction.editReply("Server did not respond in time, it's likely the request timed out.");
        }
        
    },
};