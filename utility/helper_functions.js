const { Client } = require('undici');
const { api_key } = require('../../keys.json');
const { client } = new Client('https://dino.flakey.tech/');
const { users } = require('../users.json');

export async function apiCall(path, method, body) {
    const result = await client.request({
        path: `/api/${path}`,
        method: `${method}`,
        headers: {
            'Accept': 'application/json', 
            'content-type': 'application/json',
            'Authorization': `Bearer ${api_key}`
        },
        body: body
    });
    
    return result;
}

export function extractEnvVariables(jsonData) {
    const envVariables = {};

    jsonData.data.forEach(item => {
        const { env_variable, default_value } = item.attributes;
        envVariables[env_variable] = default_value;
    });
    return envVariables;
}

export function formatNames(jsonData) {
    if (!jsonData || !Array.isArray(jsonData.data)) {
        throw new Error("Invalid input: Expected an object with a 'data' array.");
    }

    return jsonData.data.map(item => `- ${item.attributes.name}`).join("\n");
}

export function getUserId(discordId) {
    for (const user of users) {
        if (user.discordId === discordId) {
            return user.panelId;
        }
    }
    return -1; // no user found
}

