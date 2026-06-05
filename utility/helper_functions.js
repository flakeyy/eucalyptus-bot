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

// Derive a value for a required egg variable whose default is blank, using only
// its Laravel validation rules so this stays egg-agnostic. Currently handles
// numeric/port variables (e.g. "required|numeric|between:1024,65535"): if the
// server's assigned allocation port satisfies the range, we reuse it. Returns
// undefined when no safe value can be inferred.
function deriveRequiredValue(ruleList, { port } = {}) {
  const isNumeric = ruleList.includes("numeric") || ruleList.includes("integer");
  const between = ruleList.find(r => r.startsWith("between:"));
  if (isNumeric && between && port !== null && port !== undefined) {
    const [ min, max ] = between.slice("between:".length).split(",").map(Number);
    if (!Number.isNaN(min) && !Number.isNaN(max) && port >= min && port <= max) {
      return String(port);
    }
  }
  return undefined;
}

// Build the environment map for a new server, like extractEnvVariables, but also
// fill in required variables whose default_value is blank. Pterodactyl validates
// the environment against each egg variable's rules, so a blank "required" value
// (e.g. Satisfactory's RELIABLE_PORT) otherwise causes an opaque 422 on creation.
// Returns { environment, missing }, where missing lists the required variables we
// could not fill so the caller can surface a clear error instead.
function resolveEnvVariables(jsonData, context = {}) {
  const environment = {};
  const missing = [];

  jsonData.data.forEach(item => {
    const { env_variable, default_value, rules, name } = item.attributes;
    const ruleList = typeof rules === "string" ? rules.split("|") : [];
    const isRequired = ruleList.includes("required");
    const isBlank = default_value === null || default_value === "";

    let value = default_value;
    if (isRequired && isBlank) {
      const derived = deriveRequiredValue(ruleList, context);
      if (derived === undefined) {
        missing.push({ envVariable: env_variable, name: name || env_variable });
      } else {
        value = derived;
      }
    }

    environment[env_variable] = value;
  });

  return { environment, missing };
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
  if (type !== "panel" && type !== "node") {
    throw new Error("Invalid monitor type specified.");
  }

  const provider = (process.env.UPTIME_PROVIDER || "kuma").toLowerCase();

  try {
    if (provider === "custom") {
      return await getCustomUptime(type);
    }
    return await getKumaUptime(type);
  } catch (error) {
    msgLog.error(`getMonitorUptime failed: ${error.message}`);
    return null;
  }
}

async function getKumaUptime(type) {
  const URL = process.env.UPTIME_URL;
  const SLUG = process.env.UPTIME_SLUG;
  const MONITOR_ID = type === "panel"
    ? process.env.UPTIME_PANEL_MONITOR_ID
    : process.env.UPTIME_NODE_MONITOR_ID;

  if (!MONITOR_ID) {
    throw new Error(`Missing ${type === "panel" ? "UPTIME_PANEL_MONITOR_ID" : "UPTIME_NODE_MONITOR_ID"} env var`);
  }

  const response = await fetch(`${URL}/api/status-page/heartbeat/${SLUG}`);
  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status}`);
  }
  const data = await response.json();
  const key = `${MONITOR_ID}_24`;
  if (data.uptimeList && data.uptimeList[key] !== undefined) {
    return (data.uptimeList[key] * 100).toFixed(2);
  }
  return null;
}

async function getCustomUptime(type) {
  const URL = process.env.UPTIME_URL;
  const API_KEY = process.env.UPTIME_API_KEY;
  const SLUG = process.env.UPTIME_SLUG;
  const wantedType = type === "panel" ? "pterodactyl_panel" : "pterodactyl_node";

  const endpoint = SLUG
    ? `${URL}/api/status?page=${encodeURIComponent(SLUG)}`
    : `${URL}/api/status`;
  const response = await fetch(endpoint, {
    headers: API_KEY ? { "Authorization": `Bearer ${API_KEY}` } : {}
  });
  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status}`);
  }
  const data = await response.json();
  const service = (data.services || []).find(s => s.type === wantedType);
  if (!service || !Array.isArray(service.history24h)) {
    return null;
  }

  let totalChecks = 0;
  let upChecks = 0;
  for (const bucket of service.history24h) {
    totalChecks += bucket.total || 0;
    upChecks += bucket.up || 0;
  }
  if (totalChecks === 0) {
    return null;
  }
  return ((upChecks / totalChecks) * 100).toFixed(2);
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
  resolveEnvVariables,
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
