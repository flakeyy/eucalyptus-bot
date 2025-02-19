const { SlashCommandBuilder } = require('discord.js');
const { Client } = require('undici');
const { api_key } = require('../../config.json');
const client = new Client('https://dino.flakey.tech/');
const wait = require('node:timers/promises').setTimeout;

function formatNames(jsonData) {
    if (!jsonData || !Array.isArray(jsonData.data)) {
        throw new Error("Invalid input: Expected an object with a 'data' array.");
    }

    return jsonData.data.map(item => `- ${item.attributes.name}`).join("\n");
}

async function getNests() {
    const result = await client.request({
            path: `/api/application/nests`,
            method: 'GET',
            headers: {'Accept': 'application/json', 'content-type': 'application/json', 'Authorization': `Bearer ${api_key}`},
        }); 
        const jsonString = await result.body.json();
        const formattedString = formatNames(jsonString)

        return "```List of Nests:\n\n" + formattedString + "```"
       
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('get-nests')
        .setDescription('Gets the names of available nests.'),
    async execute(interaction) {
        const nestData = await getNests();

        await interaction.deferReply();
        await wait(2_000);
        if(typeof(nestData) === "string") {
            await interaction.editReply(nestData);
        }
        else {
            await interaction.editReply("Server did not respond in time, it's likely the request timed out.");
        }
        
    },
};