const blacklist = require('../../blacklist.json');
const { apiCall } = require('../../utility/helper_functions.js');

export async function getEggData(nestId, eggId) {
    const apiResult = await apiCall(`application/nests/${nestId}/eggs/${eggId}?include=variables`, 'GET');
    
    const jsonData = await apiResult.body.json().attributes;
    
    if(jsonData == undefined) {
        return -1;
    }

    return jsonData;
}

export async function getNodeIdByName(node) {
    const apiResult = await apiCall(`application/nodes`, 'GET');

    const jsonData = await apiResult.body.json().attributes;
    
    if(jsonData == undefined) {
        return -1;
    }

    const filteredData = jsonData.filter((word) => word.attributes.name.toLowerCase().includes(node.toLowerCase()))[0]
    if(filteredData == undefined) {
        console.error(`Node '${node}' does not exist`)
        return -1;
    }
    if (blacklist.nodes[filteredData.attributes.name]) {
        return `Node '${filteredData.attributes.name}' is currently blacklisted: ${blacklist.nodes[filteredData.attributes.name]}`;
    }
    return filteredData.attributes.id;
}

export async function getNestIdByName(nest) { 
    const apiResult = await apiCall(`application/nests`, 'GET');

    const jsonData = await apiResult.body.json().attributes;
    
    if(jsonData == undefined) {
        return -1;
    }

    const filteredData = jsonData.filter((word) => word.attributes.name.toLowerCase().includes(nest.toLowerCase()))[0]
    if(filteredData == undefined) {
        console.error(`Nest '${nest}' does not exist`)
        return -1;
    }
    else {
        return filteredData.attributes.id;
    }
}

export async function getEggIdByName(nestId, egg) {
    const apiResult = await apiCall(`application/nests/${nestId}/eggs`, 'GET');

    const jsonData = await apiResult.body.json().attributes;
    
    if(jsonData == undefined) {
        return -1;
    }

    const filteredData = jsonData.filter((word) => word.attributes.name.toLowerCase().includes(egg.toLowerCase()))[0]
    if(filteredData == undefined) {
        console.error(`Egg '${egg}' does not exist`)
        return -1;
    }
    else {
        return filteredData.attributes.id;
    }
}