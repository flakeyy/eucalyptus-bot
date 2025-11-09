import { createRequire } from "module";
const require = createRequire(import.meta.url);
const blacklist = require("../blacklist.json");
const users = require("../users.json");
const { apiCall } = require("./helper_functions.js");

// EGGS
export async function getEggs(nestId) {
  const apiResult = await apiCall(`application/nests/${nestId}/eggs`, "GET");
  const jsonString = await apiResult.body.json();
  return jsonString;
}

export async function getEggData(nestId, eggId) {
  const apiResult = await apiCall(`application/nests/${nestId}/eggs/${eggId}?include=variables`, "GET");
  const jsonData = await apiResult.body.json();

  if (jsonData == undefined) {
    return -1;
  }

  return jsonData;
}

export async function getEggIdByName(nestId, egg) {
  const apiResult = await apiCall(`application/nests/${nestId}/eggs`, "GET");
  const jsonString = await apiResult.body.json();
  const jsonData = await jsonString.data;

  if (jsonData == undefined) {
    return -1;
  }

  const filteredData = jsonData.filter(word => word.attributes.name.toLowerCase().includes(egg.toLowerCase()))[0];
  if (filteredData == undefined) {
    console.error(`Egg '${egg}' does not exist`);
    return -1;
  }
  else {
    return filteredData.attributes.id;
  }
}

// NESTS

export async function getNests() {
  const apiResult = await apiCall("application/nests", "GET");
  const jsonString = await apiResult.body.json();

  return jsonString;
}

export async function getNestIdByName(nest) {
  const apiResult = await apiCall("application/nests", "GET");

  const jsonString = await apiResult.body.json();
  const jsonData = await jsonString.data;

  if (jsonData == undefined) {
    return -1;
  }

  const filteredData = jsonData.filter(word => word.attributes.name.toLowerCase().includes(nest.toLowerCase()))[0];
  if (filteredData == undefined) {
    console.error(`Nest '${nest}' does not exist`);
    return -1;
  }
  else {
    return filteredData.attributes.id;
  }
}

// NODES

export async function getNodes() {
  const apiResult = await apiCall("application/nodes", "GET");
  const jsonString = await apiResult.body.json();
  return jsonString;
}

export async function getNodeIdByName(node) {
  const apiResult = await apiCall("application/nodes", "GET");

  const jsonString = await apiResult.body.json();
  const jsonData = await jsonString.data;

  if (jsonData == undefined) {
    return -1;
  }

  const filteredData = jsonData.filter(word => word.attributes.name.toLowerCase().includes(node.toLowerCase()))[0];
  if (filteredData == undefined) {
    return -1;
  }
  if (blacklist.nodes[filteredData.attributes.name]) {
    return `Node '${filteredData.attributes.name}' is currently blacklisted: ${blacklist.nodes[filteredData.attributes.name]}`;
  }
  return filteredData.attributes.id;
}

// SERVERS

export async function getServersByUser(userId) {
  const apiResult = await apiCall(`application/users/${userId}?include=servers`, "GET");
  const jsonData = await apiResult.body.json();
  const serverObjects = jsonData.attributes.relationships.servers;

  return serverObjects;
}

export async function getServerInfoById(serverId) {
  const apiResult = await apiCall(`application/servers/${serverId}`, "GET");
  const jsonData = await apiResult.body.json();
  const attributes = jsonData.attributes;
  return attributes;
}

export async function getServerOwnerId(serverId) {
  const apiResult = await apiCall(`application/servers/${serverId}`, "GET");
  const jsonData = await apiResult.body.json();
  const ownerId = jsonData.attributes.user;
  return ownerId;
}

export async function isServerSuspended(serverId) {
  const apiResult = await apiCall(`application/servers/${serverId}`, "GET");
  const jsonData = await apiResult.body.json();
  const suspended = jsonData.attributes.suspended;
  return suspended;
}

export async function editServerBuild(serverId, settingName, value) {
  const serverInfo = await getServerInfoById(serverId);
  const requestBody = {
    allocation: serverInfo.allocation,
    memory: serverInfo.limits.memory,
    swap: serverInfo.limits.swap,
    disk: serverInfo.limits.disk,
    io: serverInfo.limits.io,
    cpu: serverInfo.limits.cpu,
    feature_limits: {
      databases: serverInfo.feature_limits.databases,
      allocations: serverInfo.feature_limits.allocations,
      backups: serverInfo.feature_limits.backups
    }
  };

  const validSettings = ["memory"];
  if(!validSettings.includes(settingName)) {
    throw new Error(`Invalid setting name. Valid settings are: ${validSettings.join(", ")}`);
  }

  if(settingName in requestBody) {
    requestBody[settingName] = value;
  } else if (settingName in requestBody.feature_limits) {
    requestBody.feature_limits[settingName] = value;
  }

  const apiResult = await apiCall(`application/servers/${serverId}/build`, "PATCH", JSON.stringify(requestBody));

  return apiResult.statusCode;
}

// MISC

export async function getAvailableUserMemory(userId, discordId) {
  const apiResult = await apiCall(`application/users/${userId}?include=servers`, "GET");
  const jsonData = await apiResult.body.json();

  if (apiResult == -1) {
    return apiResult;
  }
  else {
    let memoryAvailable = 0;
    let totalMemoryUsage = 0;
    for (let i = 0; i < jsonData.attributes.relationships.servers.data.length; i++) {
      totalMemoryUsage += jsonData.attributes.relationships.servers.data[i].attributes.limits.memory;
    }
    for (let i = 0; i < users.users.length; i++) {
      if (users.users[i].discordId == discordId) {
        if (users.users[i].maximumAllowedMemory == -1) {
          memoryAvailable = 100000;
          break;
        }
        else {
          memoryAvailable = users.users[i].maximumAllowedMemory - totalMemoryUsage;
        }
      }
    }
    return memoryAvailable;
  }
}
