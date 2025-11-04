const { Client } = require('undici');
const { api_key } = require('../../keys.json');
const client = new Client('https://dino.flakey.tech/');

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
    
    return jsonData;
}

export function extractEnvVariables(jsonData) {
    const envVariables = {};

    jsonData.data.forEach(item => {
        const { env_variable, default_value } = item.attributes;
        envVariables[env_variable] = default_value;
    });
    return envVariables;
}

