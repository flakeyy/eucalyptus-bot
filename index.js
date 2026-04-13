require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const {
  Client: discordClient,
  Collection,
  Events,
  GatewayIntentBits,
  MessageFlags
} = require("discord.js");
const { applicationApiCall } = require("./utility/helper_functions");
const dClient = new discordClient({ intents: [ GatewayIntentBits.Guilds ] });
const msgLog = require("./utility/logger.js");

// Environment variables with defaults
let useDev = false;
let DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
let API_KEY = process.env.PANEL_API_KEY || "";

// Check for dev mode
if (process.argv[2] === "--dev") {
  useDev = true;
}

if (useDev) {
  DISCORD_TOKEN = process.env.DEV_DISCORD_TOKEN;
  API_KEY = process.env.PANEL_API_KEY;
} else {
  DISCORD_TOKEN = process.env.PROD_DISCORD_TOKEN;
  API_KEY = process.env.PANEL_API_KEY;
}

if (!DISCORD_TOKEN || !API_KEY) {
  msgLog.error("Missing required env variables (DISCORD_TOKEN / PANEL_API_KEY). Check your .env file.");
  process.exit(1);
}

try {
  require("./config.json");
} catch {
  msgLog.error("Error loading config.json. Please make sure you have a config.json file in the root directory.");
  process.exit(1);
}

try {
  require("./users.json");
} catch {
  msgLog.error("Error loading users.json. Please make sure you have a users.json file in the root directory.");
  process.exit(1);
}

global.isDev = useDev;

global.version = require("./package.json").version;

try {
  global.commitHash = require("node:child_process").execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
} catch {
  global.commitHash = "unknown";
}

async function getTotalServers() {
  const result = await applicationApiCall("application/servers", "GET", null);
  const jsonString = await result.body.json();
  const jsonData = await jsonString.data;

  global.serverCount = jsonData.length;
}

async function getTotalUsers() {
  const result = await applicationApiCall("application/users", "GET", null);
  const jsonString = await result.body.json();
  const jsonData = await jsonString.data;

  global.userCount = jsonData.length;
}

async function setPresence() {
  try {
    await getTotalServers();
    await getTotalUsers();

    dClient.user.setStatus("online");
    dClient.application.edit({ description: `Watching over ${global.serverCount} servers\n${process.env.PANEL_URL}\n/info for more details` });
  } catch (error) {
    msgLog.error(`Failed to update presence: ${error.message}`);
  }
}

dClient.once(Events.ClientReady, readyClient => {
  msgLog.log(`${readyClient.user.tag} is live | v${global.version}/${global.commitHash}${useDev ? " | dev" : ""}`);
  setPresence();
  setInterval(setPresence, 300000);
});

dClient.commands = new Collection();

// Load commands asynchronously
(async () => {
  const foldersPath = path.join(__dirname, "commands");
  const commandFolders = await fs.promises.readdir(foldersPath);

  for (const folder of commandFolders) {
    const commandsPath = path.join(foldersPath, folder);
    const commandFiles = (await fs.promises.readdir(commandsPath)).filter(file => file.endsWith(".js"));
    for (const file of commandFiles) {
      const filePath = path.join(commandsPath, file);
      const command = require(filePath);
      // Set a new item in the Collection with the key as the command name and the value as the exported module
      if ("data" in command && "execute" in command) {
        dClient.commands.set(command.data.name, command);
      } else {
        msgLog.error(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
      }
    }
  }
})().catch(err => {
  msgLog.error(`Error loading commands: ${err}`);
  process.exit(1);
});

dClient.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = interaction.client.commands.get(interaction.commandName);

  if (!command) {
    msgLog.error(`No such command: ${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    msgLog.error(`Error executing ${interaction.commandName}`);
    msgLog.debug(error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: "There was an error while executing this command!", flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: "There was an error while executing this command!", flags: MessageFlags.Ephemeral });
    }
  }
});

dClient.login(DISCORD_TOKEN);
