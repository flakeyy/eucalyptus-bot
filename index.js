require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const {
  Client: discordClient,
  Collection,
  Events,
  GatewayIntentBits,
  ActivityType,
  MessageFlags
} = require("discord.js");
const { Client: httpClient } = require("undici");
const dClient = new discordClient({ intents: [ GatewayIntentBits.Guilds ] });
const hClient = new httpClient("https://dino.flakey.tech/");

// Environment variables with defaults
let useDev = false;
let DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
let API_KEY = process.env.API_KEY || "";

// Check for dev mode
if (process.argv[2] === "--dev") {
  useDev = true;
}

if (useDev) {
  try {
    DISCORD_TOKEN = process.env.DEV_DISCORD_TOKEN;
    API_KEY = process.env.PANEL_API_KEY;
  } catch {
    console.error("Error loading env variables. Please make sure you have filled out the required env variables in .env.");
    process.exit(1);
  }
} else {
  try {
    DISCORD_TOKEN = process.env.PROD_DISCORD_TOKEN;
    API_KEY = process.env.PANEL_API_KEY;
  } catch {
    console.error("Error loading env variables. Please make sure you have filled out the required env variables in .env.");
    process.exit(1);
  }
}

try {
  require("./config.json");
} catch {
  console.error("Error loading config.json. Please make sure you have a config.json file in the root directory.");
  process.exit(1);
}

try {
  require("./users.json");
} catch {
  console.error("Error loading users.json. Please make sure you have a users.json file in the root directory.");
  process.exit(1);
}

async function setPresence() {
  const result = await hClient.request({
    path: "/api/application/servers",
    method: "GET",
    headers: { "Accept": "application/json", "content-type": "application/json", "Authorization": `Bearer ${API_KEY}` }
  });
  const jsonString = await result.body.json();
  const jsonData = await jsonString.data;

  dClient.user.setPresence({
    activities: [ {
      name: `over ${jsonData.length} servers.`,
      type: ActivityType.Watching
    } ],
    status: "online"
  });
};

dClient.once(Events.ClientReady, readyClient => {
  console.log(`${readyClient.user.tag} is ready.`);
  setPresence();
  setInterval(setPresence, 300000);
});

dClient.commands = new Collection();

const foldersPath = path.join(__dirname, "commands");
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
  const commandsPath = path.join(foldersPath, folder);
  const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith(".js"));
  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    // Set a new item in the Collection with the key as the command name and the value as the exported module
    if ("data" in command && "execute" in command) {
      dClient.commands.set(command.data.name, command);
    } else {
      console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
    }
  }
}

dClient.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = interaction.client.commands.get(interaction.commandName);

  if (!command) {
    console.error(`No such command: ${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: "There was an error while executing this command!", flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: "There was an error while executing this command!", flags: MessageFlags.Ephemeral });
    }
  }
});

dClient.login(DISCORD_TOKEN);
