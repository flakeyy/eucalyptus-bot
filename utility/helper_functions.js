require("dotenv").config();
const { Client } = require("undici");
const client = new Client(process.env.PANEL_URL);
const config = require("../config.json");
const msgLog = require("./logger.js");
const API_KEY = process.env.PANEL_API_KEY;
const { users } = require("../users.json");
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
    msgLog.debug(`API: ${method} /api/${path} | Status Code: ${result.statusCode}`);
  }

  return result;
}

async function clientApiCall(path, method, body, userDiscordId, customAPIKey) {
  let API_KEY = customAPIKey || "";
  if (API_KEY === "") {
    for (const user of users) {
      if (user.discordId === userDiscordId) {
        API_KEY = user.panelAPIKey;
      }
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

function getUserId(val) {
  if(typeof val == 'number') {
    for (const user of users) {
      if (user.discordId == val) {
        return user.panelId;
      }
    }
  }
  else if(typeof val == 'string') {
    for (const user of users) {
      if (user.panelUsername == val || user.discordId.toString() == val) {
        return user.panelId;
      }
    }
  }

  return -1; // no user found
}

function getPanelUsername(val) {
  if(typeof val == 'number') {
    for (const user of users) {
      if (user.discordId == val) {
        return user.panelUsername;
      }
    }
  }
  else if(typeof val == 'string') {
    for (const user of users) {
      if (user.panelUsername == val || user.discordId.toString() == val) {
        return user.panelUsername;
      }
    }
  }
  
  return -1; // no user found
}

function getDiscordId(val) {
  if(typeof val == 'number') {
    // Could be Discord ID or panel ID
    for (const user of users) {
      if (user.discordId == val) {
        return user.discordId;
      }
      if (user.panelId == val) {
        return user.discordId;
      }
    }
  }
  else if(typeof val == 'string') {
    for (const user of users) {
      if (user.panelUsername == val || user.discordId.toString() == val) {
        return user.discordId;
      }
    }
  }
  
  return -1; // no user found
}

function reconstructCommand(interaction) {
  const fullCommand = `/${interaction.commandName} ${interaction.options.data
    .map(option => `${option.name}:${(option.name === "api-key") ? "********" : option.value}`)
    .join(" ")}`;

  return fullCommand;
}

function saveUsersFile() {
  const fs = require("fs");
  fs.writeFile("./users.json", JSON.stringify({ users: users }, null, 2), (err) => {
    if (err) {
      msgLog.error("Error writing users.json:");
    }
  });
}

async function getMonitorUptime(type) {
  const URL = 'https://uptime.flakey.tech';
  const SLUG = 'eucalyptus';
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
    console.error(error);
    return null;
  }

}

function validateString(str, minLength = 1, maxLength = 32) {
  if (typeof str !== 'string') {
    return false;
  }
  
  const trimmed = str.trim();
  
  if (trimmed.length < minLength || trimmed.length > maxLength) {
    return false;
  }
  
  return trimmed;
}

function userHasClientApiKey(discordId) {
  for (const user of users) {
    if (user.discordId === discordId) {
      return user.panelAPIKey && user.panelAPIKey !== "";
    }
  }
  return false;
}

async function getCommands() {
  let commands = [];
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
          console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
      }
    }
    return commands;
  }
  catch (error) {
    console.error(error);
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
  saveUsersFile,
  reconstructCommand,
  getMonitorUptime,
  validateString,
  userHasClientApiKey,
  getCommands
};
