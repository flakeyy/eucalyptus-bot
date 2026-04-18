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
const { initDatabase, getAllUsers } = require("./utility/database.js");
const { generateBootstrapToken } = require("./utility/bootstrap.js");
const dClient = new discordClient({ intents: [ GatewayIntentBits.Guilds ] });
const msgLog = require("./utility/logger.js");

const useDev = process.argv[2] === "--dev";
const DISCORD_TOKEN = useDev ? process.env.DEV_DISCORD_TOKEN : process.env.PROD_DISCORD_TOKEN;
const API_KEY = process.env.PANEL_API_KEY;

if (!DISCORD_TOKEN || !API_KEY) {
  msgLog.error("Missing required env variables (DISCORD_TOKEN / PANEL_API_KEY). Check your .env file.");
  process.exit(1);
}

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
  msgLog.error("Missing or invalid ENCRYPTION_KEY. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" and add it to your .env file.");
  process.exit(1);
}

try {
  require("./config.json");
} catch {
  msgLog.error("Error loading config.json. Please make sure you have a config.json file in the root directory.");
  process.exit(1);
}

try {
  initDatabase();
} catch (err) {
  msgLog.error(`Failed to initialize database: ${err.message}`);
  process.exit(1);
}

if (getAllUsers().length === 0) {
  const token = generateBootstrapToken();
  msgLog.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  msgLog.log("NO USERS FOUND — FIRST RUN SETUP");
  msgLog.log(`Bootstrap token: ${token}`);
  msgLog.log("Run /init in Discord with this token to create the first admin account.");
  msgLog.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
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
  const json = await result.body.json();
  global.serverCount = json.data.length;
}

async function getTotalUsers() {
  const result = await applicationApiCall("application/users", "GET", null);
  const json = await result.body.json();
  global.userCount = json.data.length;
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

(async () => {
  const foldersPath = path.join(__dirname, "commands");
  const commandFolders = await fs.promises.readdir(foldersPath);

  for (const folder of commandFolders) {
    const commandsPath = path.join(foldersPath, folder);
    const commandFiles = (await fs.promises.readdir(commandsPath)).filter(file => file.endsWith(".js"));
    for (const file of commandFiles) {
      const filePath = path.join(commandsPath, file);
      const command = require(filePath);
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
