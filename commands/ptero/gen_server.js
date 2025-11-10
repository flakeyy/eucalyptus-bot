const { SlashCommandBuilder } = require("discord.js");
const config = require("../../config.json");
const wait = require("node:timers/promises").setTimeout;
const { PERMISSIONS, authenticateUserForPermission } = require ("../../utility/permissions.js");
const { apiCall, extractEnvVariables, getUserId } = require("../../utility/helper_functions.js");
const { getEggData, getNodeIdByName, getNestIdByName, getEggIdByName, getAvailableUserMemory } = require("../../utility/server_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");

async function getDefaultAllocation(node) {
  const apiResult = await apiCall(`application/nodes/${node}/allocations`, "GET");
  const jsonString = await apiResult.body.json();
  const jsonData = await jsonString.data;

  for (let i = 0;i < jsonData.length;i++) {
    if (!jsonData[i].attributes.assigned && (jsonData[i].attributes.alias == null || (jsonData[i].attributes.alias != null && jsonData[i].attributes.ip == "0.0.0.0"))) {
      return jsonData[i].attributes.id;
    }
  }
  return -1;
}

async function createServer(name, node, nest, egg, memory, discordId, userId) {
  if (name == "" || name == null) {
    return getErrorMessage("INVALID_SERVER_NAME");
  }
  const nodeId = await getNodeIdByName(node);
  if (nodeId == -1) {
    return getErrorMessage("NODE_NOT_FOUND");
  }
  else if (typeof(nodeId) === "string") {
    return nodeId;
  }

  let overheadMemory = config["default_overhead_mb"];
  const nestId = await getNestIdByName(nest);
  if (nestId == -1) {
    return getErrorMessage("NEST_NOT_FOUND");
  }
  if (nestId == config["minecraft_nest_id"]) {
    overheadMemory = config["java_overhead_mb"];
  }

  const eggId = await getEggIdByName(nestId, egg);
  if (eggId == -1) {
    return getErrorMessage("EGG_NOT_FOUND");
  }

  const availableMemory = await getAvailableUserMemory(userId, discordId);
  if (availableMemory - memory < 0) {
    const memoryToFree = (availableMemory - memory) * -1;
    return getErrorMessage("SERVER_CREATION_FAILED_MEMORY", memoryToFree);
  }

  const defaultAllocation = await getDefaultAllocation(nodeId);
  if (defaultAllocation == -1) {
    return getErrorMessage("ALLOCATION_NOT_FOUND");
  }

  const eggInfo = await getEggData(nestId, eggId);
  if (eggInfo == -1) {
    return getErrorMessage("EGG_INFO_NOT_RETURNED");
  }

  const requestBody = JSON.stringify({
    "name": name,
    "user": userId,
    "egg": eggId,
    "docker_image": eggInfo.attributes.docker_image,
    "startup": eggInfo.attributes.startup,
    "environment": extractEnvVariables(eggInfo.attributes.relationships.variables),
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
  });

  if (config["developer_mode"]) {
    console.log(requestBody);
    return "Developer mode enabled, no real API request was made, check console for details.";
  }

  const apiResult = await apiCall("application/servers", "POST", requestBody);
  const jsonText = await apiResult.body.json();

  jsonText.statusCode = apiResult.statusCode;

  return jsonText;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("gen-server")
    .setDescription("Generates a server on https://dino.flakey.tech/")
    .addStringOption(option =>
      option.setName("server-name")
        .setDescription("Server Name")
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("node")
        .setDescription("/get-nodes for details")
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("nest")
        .setDescription("/get-nests for details")
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("egg")
        .setDescription("/get-eggs for details")
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName("memory")
        .setDescription("Container Memory (MB)")
        .setRequired(true)
    ),

  async execute(interaction) {
    const authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.CREATE_SERVER);
    if (authenticated == -1) {
      interaction.reply(getErrorMessage("USER_NOT_FOUND"));
      return;
    }
    else if (authenticated == false) {
      interaction.reply(getErrorMessage("INSUFFICIENT_PERMISSIONS"));
      return;
    }

    const panelId = getUserId(interaction.user.id);
    const discordId = interaction.user.id;
    const serverName = interaction.options.getString("server-name");
    const nodeName = interaction.options.getString("node");
    const nestName = interaction.options.getString("nest");
    const eggName = interaction.options.getString("egg");
    const memoryMB = interaction.options.getInteger("memory");
    const apiResult = await createServer(serverName, nodeName, nestName, eggName, memoryMB, discordId, panelId);

    await interaction.deferReply();
    await wait(2_500);

    const text = await apiResult.text();
    const response = JSON.parse(text);
    if (apiResult.statusCode !== 201) {
      await interaction.editReply(getErrorMessage("API_REQUEST_FAILED", apiResult.statusCode));
      return;
    }

    const responseMessage = `Server '${response.attributes.name}' was successfully created and is currently installing at: https://dino.flakey.tech/server/${response.attributes.identifier}`;
    await interaction.editReply(responseMessage);
  }
};

// Export helper for tests
module.exports.createServer = createServer;

