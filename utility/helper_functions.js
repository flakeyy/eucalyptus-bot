require("dotenv").config();
const { Client } = require("undici");
const client = new Client(process.env.PANEL_URL);
const config = require("../config.json");
const msgLog = require("./logger.js");
const API_KEY = process.env.PANEL_API_KEY;
const db = require("./database.js");
const fs = require("node:fs");
const path = require("node:path");

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
    msgLog.debug(`API: ${method} /panel/${path} | Status Code: ${result.statusCode}`);
  }

  return result;
}

async function clientApiCall(path, method, body, userDiscordId, customAPIKey) {
  let API_KEY = customAPIKey || "";
  if (API_KEY === "") {
    const user = db.getUserByDiscordId(userDiscordId);
    if (user) {
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
    msgLog.debug(`API: ${method} /panel/${path} | Status Code: ${result.statusCode}`);
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

function getUserId(val) {
  let user;
  if (typeof val === "number") {
    user = db.getUserByDiscordId(String(val));
  } else if (typeof val === "string") {
    user = db.getUserByDiscordId(val) || db.getUserByPanelUsername(val);
  }
  return user ? user.panelId : -1;
}

function getPanelUsername(val) {
  let user;
  if (typeof val === "number") {
    user = db.getUserByDiscordId(String(val));
  } else if (typeof val === "string") {
    user = db.getUserByDiscordId(val) || db.getUserByPanelUsername(val);
  }
  return user ? user.panelUsername : -1;
}

function getDiscordId(val) {
  let user;
  if (typeof val === "number") {
    user = db.getUserByDiscordId(String(val)) || db.getUserByPanelId(val);
  } else if (typeof val === "string") {
    user = db.getUserByDiscordId(val) || db.getUserByPanelUsername(val);
  }
  return user ? user.discordId : -1;
}

function reconstructCommand(interaction) {
  function serializeOptions(options) {
    return options.map(option => {
      if (option.options) {
        return `${option.name} ${serializeOptions(option.options)}`;
      }
      return `${option.name}:${option.name === "api-key" ? "********" : option.value}`;
    }).join(" ");
  }

  return `/${interaction.commandName} ${serializeOptions(interaction.options.data)}`;
}

async function getMonitorUptime(type) {
  const URL = process.env.UPTIME_URL;
  const SLUG = process.env.UPTIME_SLUG;
  const MONITOR_ID = (type === "panel" ? 1 : (type === "node" ? 7 : null));

  if (MONITOR_ID === null) {
    throw new Error("Invalid monitor type specified.");
  }

  try {
    const response = await fetch(`${URL}/api/status-page/heartbeat/${SLUG}`);
    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`);
    }
    const data = await response.json();
    const key = `${MONITOR_ID}_24`;
    if (data.uptimeList && data.uptimeList[key] !== undefined) {
      const uptime24hr = (data.uptimeList[key] * 100).toFixed(2);
      return uptime24hr;
    }
  } catch (error) {
    msgLog.error(`getMonitorUptime failed: ${error.message}`);
    return null;
  }

}

function validateString(str, minLength = 1, maxLength = 32) {
  if (typeof str !== "string") {
    return false;
  }

  const trimmed = str.trim();

  if (trimmed.length < minLength || trimmed.length > maxLength) {
    return false;
  }

  return trimmed;
}

function userHasClientApiKey(discordId) {
  const user = db.getUserByDiscordId(discordId);
  if (!user) return false;
  return !!(user.panelAPIKey && user.panelAPIKey !== "");
}

async function getCommands() {
  const commands = [];
  const foldersPath = path.join(__dirname, "../commands");
  try {
    const commandFolders = await fs.promises.readdir(foldersPath);

    for (const folder of commandFolders) {
      const commandsPath = path.join(foldersPath, folder);
      const commandFiles = (await fs.promises.readdir(commandsPath)).filter(file => file.endsWith(".js"));

      for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        if ("data" in command && "execute" in command) {
          commands.push(command.data.toJSON());
        } else {
          msgLog.error(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
      }
    }
    return commands;
  }
  catch (error) {
    msgLog.error(`getCommands failed: ${error.message}`);
    return null;
  }
}

module.exports = {
  applicationApiCall,
  clientApiCall,
  extractEnvVariables,
  formatNames,
  getUserId,
  getPanelUsername,
  getDiscordId,
  reconstructCommand,
  getMonitorUptime,
  validateString,
  userHasClientApiKey,
  getCommands
};
