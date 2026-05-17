require("dotenv").config();
const { REST, Routes } = require("discord.js");
const { getCommands } = require("./utility/helper_functions.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error("Missing required env variables (DISCORD_TOKEN / CLIENT_ID). Check your .env file.");
  process.exit(1);
}

const rest = new REST().setToken(TOKEN);

(async () => {
  try {
    const commands = await getCommands();

    if (commands === null) {
      console.error("Error retrieving commands.");
      return;
    }

    console.log(`Started refreshing ${commands.length} application (/) commands.`);

    const route = GUILD_ID
      ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
      : Routes.applicationCommands(CLIENT_ID);

    const data = await rest.put(route, { body: commands });

    console.log(`Successfully reloaded ${data.length} application (/) commands.${GUILD_ID ? "" : " This may take up to an hour to propagate."}`);
  } catch (error) {
    console.error(error);
  }
})();
