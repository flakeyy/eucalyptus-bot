const db = require("./database.js");
const msgLog = require("./logger.js");
const { applicationApiCall, clientApiCall, validateString } = require("./helper_functions.js");

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

  if (jsonData === undefined) {
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

  if (jsonData === undefined) {
    return -1;
  }

  const filteredData = jsonData.filter(word => word.attributes.name.toLowerCase().includes(egg.toLowerCase()))[0];
  if (filteredData === undefined) {
    msgLog.error(`Egg '${egg}' does not exist`);
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

  if (jsonData === undefined) {
    return -1;
  }

  const filteredData = jsonData.filter(word => word.attributes.name.toLowerCase().includes(nest.toLowerCase()))[0];
  if (filteredData === undefined) {
    msgLog.error(`Nest '${nest}' does not exist`);
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

  if (jsonData === undefined) {
    return -1;
  }

  const filteredData = jsonData.filter(word => word.attributes.name.toLowerCase().includes(node.toLowerCase()))[0];
  if (filteredData === undefined) {
    return -1;
  }
  const blacklistEntry = db.getBlacklistedNode(filteredData.attributes.name);
  if (blacklistEntry) {
    return `Node '${filteredData.attributes.name}' is currently blacklisted: ${blacklistEntry.reason}`;
  }
  return filteredData.attributes.id;
}

// SERVERS

async function getClientServers(discordId) {
  const apiResult = await clientApiCall("client", "GET", null, discordId);
  const jsonData = await apiResult.body.json();

  return jsonData;
}

async function getServerInfoById(serverId, discordId) {
  const validatedId = validateString(serverId);
  const apiResult = await clientApiCall(`client/servers/${validatedId}`, "GET", null, discordId);

  return apiResult;
}

async function getServerResourceInfoById(serverId, discordId) {
  const validatedId = validateString(serverId);
  const apiResult = await clientApiCall(`client/servers/${validatedId}/resources`, "GET", null, discordId);

  return apiResult;
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

async function isServerSuspended(serverId, discordId) {
  const serverData = await getServerInfoById(serverId, discordId);
  const jsonData = await serverData.body.json();
  const suspended = jsonData.attributes.is_suspended;
  return suspended;
}

async function editServerInfo(serverId, settingName, value) {
  const parsedId = parseInt(serverId, 10);
  if (isNaN(parsedId)) {
    return -1;
  }

  const validSettings = [ "memory", "name" ];
  if (!validSettings.includes(settingName)) {
    msgLog.error(`Invalid setting name: ${settingName}`);
    throw new Error(`Invalid setting name. Valid settings are: ${validSettings.join(", ")}`);
  }

  // Handle name update separately (uses /details endpoint)
  if (settingName === "name") {
    if (!value || typeof value !== "string" || value.trim().length === 0) {
      msgLog.error(`Invalid value for name: ${value}`);
      throw new Error("Name must be a non-empty string.");
    }

    // Get current server info to preserve other fields
    const serverInfoResponse = await applicationApiCall(`application/servers/${parsedId}`, "GET");
    if (serverInfoResponse.statusCode !== 200) {
      msgLog.error(`Failed to fetch server info for name update: ${serverInfoResponse.statusCode}`);
      return serverInfoResponse.statusCode;
    }
    const serverData = await serverInfoResponse.body.json();

    const requestBody = {
      name: value,
      user: serverData.attributes.user,
      external_id: serverData.attributes.external_id,
      description: serverData.attributes.description
    };

    const apiResult = await applicationApiCall(`application/servers/${parsedId}/details`, "PATCH", JSON.stringify(requestBody));
    return apiResult.statusCode;
  }

  const serverInfoResponse = await applicationApiCall(`application/servers/${parsedId}`, "GET");
  if (serverInfoResponse.statusCode !== 200) {
    msgLog.error(`Failed to fetch server info for build update: ${serverInfoResponse.statusCode}`);
    return serverInfoResponse.statusCode;
  }
  const serverData = await serverInfoResponse.body.json();

  const requestBody = {
    allocation: serverData.attributes.allocation,
    memory: serverData.attributes.limits.memory,
    swap: serverData.attributes.limits.swap,
    disk: serverData.attributes.limits.disk,
    io: serverData.attributes.limits.io,
    cpu: serverData.attributes.limits.cpu,
    feature_limits: {
      databases: serverData.attributes.feature_limits.databases,
      allocations: serverData.attributes.feature_limits.allocations,
      backups: serverData.attributes.feature_limits.backups
    }
  };

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

async function suspendServer(serverId) {
  const apiResult = await applicationApiCall(`application/servers/${serverId}/suspend`, "POST");
  return apiResult.statusCode;
}

async function unsuspendServer(serverId) {
  const apiResult = await applicationApiCall(`application/servers/${serverId}/unsuspend`, "POST");
  return apiResult.statusCode;
}

async function deleteServer(serverId) {
  const apiResult = await applicationApiCall(`application/servers/${serverId}`, "DELETE");
  return apiResult.statusCode;
}

async function setServerPowerState(serverId, userId, action) {
  const validatedId = validateString(serverId);

  const body = JSON.stringify({
    signal: action
  });

  const apiResult = await clientApiCall(`client/servers/${validatedId}/power`, "POST", body, userId);

  return apiResult;
}

// FILE MANAGEMENT

async function listServerFiles(serverId, discordId, dirPath = "/") {
  const validatedId = validateString(serverId);
  if (!validatedId) return null;
  const apiResult = await clientApiCall(
    `client/servers/${validatedId}/files/list?directory=${encodeURIComponent(dirPath)}`,
    "GET", null, discordId
  );
  if (apiResult.statusCode !== 200) return null;
  const jsonData = await apiResult.body.json();
  return jsonData.data || [];
}

async function deleteServerFiles(serverId, discordId, filenames) {
  const validatedId = validateString(serverId);
  if (!validatedId) return -1;
  const body = JSON.stringify({ root: "/", files: filenames });
  const apiResult = await clientApiCall(`client/servers/${validatedId}/files/delete`, "POST", body, discordId);
  return apiResult.statusCode;
}

async function getFileUploadUrl(serverId, discordId) {
  const validatedId = validateString(serverId);
  if (!validatedId) return null;
  const apiResult = await clientApiCall(`client/servers/${validatedId}/files/upload`, "GET", null, discordId);
  if (apiResult.statusCode !== 200) return null;
  const jsonData = await apiResult.body.json();
  return jsonData.attributes?.url || null;
}

async function pullServerFile(serverId, discordId, url, directory, filename) {
  const validatedId = validateString(serverId);
  if (!validatedId) return -1;
  const body = JSON.stringify({ url, directory, filename, use_header: false, foreground: false });
  const apiResult = await clientApiCall(`client/servers/${validatedId}/files/pull`, "POST", body, discordId);
  return apiResult.statusCode;
}

async function decompressFile(serverId, discordId, root, filename) {
  const validatedId = validateString(serverId);
  if (!validatedId) return -1;
  const body = JSON.stringify({ root, file: filename });
  const apiResult = await clientApiCall(`client/servers/${validatedId}/files/decompress`, "POST", body, discordId);
  return apiResult.statusCode;
}

async function changeServerEgg(internalServerId, eggId, nestId, envOverrides = {}, imageOverride = null) {
  const parsedServerId = parseInt(internalServerId, 10);
  const parsedEggId = parseInt(eggId, 10);
  const parsedNestId = parseInt(nestId, 10);
  if (isNaN(parsedServerId) || isNaN(parsedEggId) || isNaN(parsedNestId)) return -1;

  const eggData = await getEggData(parsedNestId, parsedEggId);
  if (eggData === -1 || !eggData.attributes) return -1;

  const egg = eggData.attributes;
  const environment = {};
  if (egg.relationships?.variables?.data) {
    for (const varEntry of egg.relationships.variables.data) {
      const attr = varEntry.attributes;
      environment[attr.env_variable] = attr.default_value || "";
    }
  }

  const body = JSON.stringify({
    egg: parsedEggId,
    startup: egg.startup,
    environment: { ...environment, ...envOverrides },
    image: imageOverride || egg.docker_image,
    skip_scripts: false
  });

  const apiResult = await applicationApiCall(`application/servers/${parsedServerId}/startup`, "PATCH", body);
  return apiResult.statusCode;
}

async function reinstallServer(internalServerId) {
  const parsedId = parseInt(internalServerId, 10);
  if (isNaN(parsedId)) return -1;
  const apiResult = await applicationApiCall(`application/servers/${parsedId}/reinstall`, "POST");
  return apiResult.statusCode;
}

// MISC

async function getAvailableUserMemory(userId, discordId) {
  const parsedId = parseInt(userId, 10);
  if (isNaN(parsedId)) {
    return -1;
  }
  const apiResult = await applicationApiCall(`application/users/${parsedId}?include=servers`, "GET");

  if (apiResult.statusCode !== 200) {
    msgLog.error(`Failed to fetch user data for memory calculation: HTTP ${apiResult.statusCode}`);
    return -1;
  }

  const jsonData = await apiResult.body.json();
  let totalMemoryUsage = 0;
  for (let i = 0; i < jsonData.attributes.relationships.servers.data.length; i++) {
    totalMemoryUsage += jsonData.attributes.relationships.servers.data[i].attributes.limits.memory;
  }
  const user = db.getUserByDiscordId(discordId);
  if (!user) return 0;
  if (user.maximumAllowedMemory === -1) return -1;
  return user.maximumAllowedMemory - totalMemoryUsage;
}

module.exports = {
  getEggs,
  getEggData,
  getEggIdByName,
  getNests,
  getNestIdByName,
  getNodes,
  getNodeIdByName,
  getClientServers,
  getServerInfoById,
  getServerResourceInfoById,
  getServerOwnerId,
  isServerSuspended,
  editServerInfo: editServerInfo,
  setServerPowerState,
  suspendServer,
  unsuspendServer,
  deleteServer,
  getAvailableUserMemory,
  listServerFiles,
  deleteServerFiles,
  getFileUploadUrl,
  decompressFile,
  pullServerFile,
  changeServerEgg,
  reinstallServer
};
