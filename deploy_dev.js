require("dotenv").config();
const { REST, Routes } = require("discord.js");
const { getCommands } = require("./utility/helper_functions.js");

const DEV_CLIENT_ID = process.env.DEV_CLIENT_ID;
const DEV_GUILD_ID = process.env.DEV_GUILD_ID;
const DEV_DISCORD_TOKEN = process.env.DEV_DISCORD_TOKEN;

const rest = new REST().setToken(DEV_DISCORD_TOKEN);

(async () => {
  try {
    let commands = await getCommands();

    console.log(`Started refreshing ${commands.length} application (/) commands.`);

    // refresh commands
    if(commands === null) {
      console.error("Error retrieving commands.");
      return;
    }
    const data = await rest.put(Routes.applicationGuildCommands(DEV_CLIENT_ID, DEV_GUILD_ID),{ body: commands });
    console.log(`Successfully reloaded ${data.length} application (/) commands.`);
  } catch (error) {
    console.error(error);
  }
})();
