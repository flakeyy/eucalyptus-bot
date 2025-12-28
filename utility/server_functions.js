const blacklist = require("../blacklist.json");
const msgLog = require("./logger.js");
const { users } = require("../users.json");
const { applicationApiCall: applicationApiCall } = require("./helper_functions.js");

// EGGS
async function getEggs(nestId) {
  const parsedId = parseInt(nestId, 10);
  if (isNaN(parsedId)) {
    return -1;
  }
  const apiResult = await applicationApiCall(`application/nests/${parsedId}/eggs`, "GET");
  const jsonString = await apiResult.body.json();
  return jsonString;
}

async function getEggData(nestId, eggId) {
  const parsedNestId = parseInt(nestId, 10);
  const parsedEggId = parseInt(eggId, 10);
  if (isNaN(parsedNestId) || isNaN(parsedEggId)) {
    return -1;
  }
  const apiResult = await applicationApiCall(`application/nests/${parsedNestId}/eggs/${parsedEggId}?include=variables`, "GET");
  const jsonData = await apiResult.body.json();

  if (jsonData == undefined) {
    return -1;
  }

  return jsonData;
}

async function getEggIdByName(nestId, egg) {
  const parsedId = parseInt(nestId, 10);
  if (isNaN(parsedId)) {
    return -1;
  }
  const apiResult = await applicationApiCall(`application/nests/${parsedId}/eggs`, "GET");
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

async function getNests() {
  const apiResult = await applicationApiCall("application/nests", "GET");
  const jsonString = await apiResult.body.json();

  return jsonString;
}

async function getNestIdByName(nest) {
  const apiResult = await applicationApiCall("application/nests", "GET");

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

async function getNodes() {
  const apiResult = await applicationApiCall("application/nodes", "GET");
  const jsonString = await apiResult.body.json();
  return jsonString;
}

async function getNodeIdByName(node) {
  const apiResult = await applicationApiCall("application/nodes", "GET");

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

async function getServersByUser(userId) {
  const parsedId = parseInt(userId, 10);
  if (isNaN(parsedId)) {
    return -1;
  }
  const apiResult = await applicationApiCall(`application/users/${parsedId}?include=servers`, "GET");
  const jsonData = await apiResult.body.json();
  const serverObjects = jsonData.attributes.relationships.servers;

  return serverObjects;
}

async function getServerInfoById(serverId) {
  const parsedId = parseInt(serverId, 10);
  if (isNaN(parsedId)) {
    return -1;
  }
  const apiResult = await applicationApiCall(`application/servers/${parsedId}`, "GET");
  const jsonData = await apiResult.body.json();
  const attributes = jsonData.attributes;
  return attributes;
}

async function getServerOwnerId(serverId) {
  const parsedId = parseInt(serverId, 10);
  if (isNaN(parsedId)) {
    return -1;
  }
  const apiResult = await applicationApiCall(`application/servers/${parsedId}`, "GET");
  const jsonData = await apiResult.body.json();
  const ownerId = jsonData.attributes.user;
  return ownerId;
}

async function isServerSuspended(serverId) {
  const parsedId = parseInt(serverId, 10);
  if (isNaN(parsedId)) {
    return -1;
  }
  const apiResult = await applicationApiCall(`application/servers/${parsedId}`, "GET");
  const jsonData = await apiResult.body.json();
  const suspended = jsonData.attributes.suspended;
  return suspended;
}

async function editServerBuild(serverId, settingName, value) {
  const parsedId = parseInt(serverId, 10);
  if (isNaN(parsedId)) {
    return -1;
  }
  const serverInfo = await getServerInfoById(parsedId);
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

  const validSettings = [ "memory" ];
  if (!validSettings.includes(settingName)) {
    msgLog.error(`Invalid setting name: ${settingName}`);
    throw new Error(`Invalid setting name. Valid settings are: ${validSettings.join(", ")}`);
  }
  if (isNaN(value) || value < 0) {
    msgLog.error(`Invalid value for ${settingName}: ${value}`);
    throw new Error("Value must be a non-negative number.");
  }

  if (settingName in requestBody) {
    requestBody[settingName] = value;
  } else if (settingName in requestBody.feature_limits) {
    requestBody.feature_limits[settingName] = value;
  }

  const apiResult = await applicationApiCall(`application/servers/${parsedId}/build`, "PATCH", JSON.stringify(requestBody));

  return apiResult.statusCode;
}

// MISC

async function getAvailableUserMemory(userId, discordId) {
  const parsedId = parseInt(userId, 10);
  if (isNaN(parsedId)) {
    return -1;
  }
  const apiResult = await applicationApiCall(`application/users/${parsedId}?include=servers`, "GET");
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
    for (let i = 0; i < users.length; i++) {
      if (users[i].discordId == discordId) {
        if (users[i].maximumAllowedMemory == -1) {
          memoryAvailable = 128000;
          break;
        }
        else {
          memoryAvailable = users[i].maximumAllowedMemory - totalMemoryUsage;
        }
      }
    }
    return memoryAvailable;
  }
}

module.exports = {
  getEggs,
  getEggData,
  getEggIdByName,
  getNests,
  getNestIdByName,
  getNodes,
  getNodeIdByName,
  getServersByUser,
  getServerInfoById,
  getServerOwnerId,
  isServerSuspended,
  editServerBuild,
  getAvailableUserMemory
};
