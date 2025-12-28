require("dotenv").config();
const { Client } = require("undici");
const client = new Client("https://dino.flakey.tech/");
const config = require("../config.json");
const msgLog = require("./logger.js");
const API_KEY = process.env.PANEL_API_KEY;
const { users } = require("../users.json");

async function applicationApiCall(path, method, body) {
  const result = await client.request({
    path: `/api/${path}`,
    method: `${method}`,
    headers: {
      "Accept": "application/json",
      "content-type": "application/json",
      "Authorization": `Bearer ${API_KEY}`
    },
    body: body
  });

  if (config.debug) {
    msgLog.debug(`API: ${method} /api/${path} | Status Code: ${result.statusCode}`);
  }

  return result;
}

async function clientApiCall(path, method, body, userDiscordId) {
  let API_KEY = "";
  for (const user of users) {
    if (user.discordId === userDiscordId) {
      API_KEY = user.panelAPIKey;
    }
  }
  const result = await client.request({
    path: `/api/${path}`,
    method: `${method}`,
    headers: {
      "Accept": "application/json",
      "content-type": "application/json",
      "Authorization": `Bearer ${API_KEY}`
    },
  body: body
  });

  if (config.debug) {
    msgLog.debug(`API: ${method} /api/${path} | Status Code: ${result.statusCode}`);
  }

  return result;
}

function extractEnvVariables(jsonData) {
  const envVariables = {};

  jsonData.data.forEach(item => {
    const { env_variable, default_value } = item.attributes;
    envVariables[env_variable] = default_value;
  });
  return envVariables;
}

function formatNames(jsonData) {
  if (!jsonData || !Array.isArray(jsonData.data)) {
    throw new Error("Invalid input: Expect an object with a 'data' array.");
  }

  return jsonData.data.map(item => `- ${item.attributes.name}`).join("\n");
}

function getUserId(discordId) {
  for (const user of users) {
    if (user.discordId === discordId) {
      return user.panelId;
    }
  }
  return -1; // no user found
}

function getPanelUsername(discordId) {
  for (const user of users) {
    if (user.discordId === discordId) {
      return user.panelUsername;
    }
  }
  return -1; // no user found
}

function reconstructCommand(interaction) {
  const fullCommand = `/${interaction.commandName} ${interaction.options.data
    .map(option => `${option.name}:${(option.name == "api-key") ? "********" : option.value}`)
    .join(" ")}`;

  return fullCommand;
}

function saveUsersFile() {
  const fs = require("fs");
  fs.writeFileSync("./users.json", JSON.stringify({ users: users }, null, 2));
}

async function getMonitorUptime(type) {
  const URL = 'https://uptime.flakey.tech';
  const SLUG = 'node';
  const MONITOR_ID = (type == 'panel' ? 1 : (type == 'node' ? 7 : null));

  if (MONITOR_ID === null) {
    throw new Error("Invalid monitor type specified.");
  }

  try {
    const response = await fetch(`${URL}/api/status-page/heartbeat/${SLUG}`);
    if(!response.ok) {
      throw new Error(`HTTP error: ${response.status}`);
    }
    const data = await response.json();
    const key = `${MONITOR_ID}_24`;
    if(data.uptimeList && data.uptimeList[key] !== undefined) {
      const uptime24hr = (data.uptimeList[key] * 100).toFixed(2);
      return uptime24hr;
    }
  } catch(error) {
    console.error
  }

}

module.exports = {
  applicationApiCall,
  clientApiCall,
  extractEnvVariables,
  formatNames,
  getUserId,
  getPanelUsername,
  saveUsersFile,
  reconstructCommand,
  getMonitorUptime
};
