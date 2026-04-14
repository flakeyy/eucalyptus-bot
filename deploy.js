require("dotenv").config();
const { REST, Routes } = require("discord.js");
const { getCommands } = require("./utility/helper_functions.js");
const PROD_DISCORD_TOKEN = process.env.PROD_DISCORD_TOKEN;
const PROD_CLIENT_ID = process.env.PROD_CLIENT_ID;

const rest = new REST().setToken(PROD_DISCORD_TOKEN);

(async () => {
  try {
    const commands = await getCommands();

    console.log(`Started refreshing ${commands.length} application (/) commands.`);

    if (commands === null) {
      console.error("Error retrieving commands.");
      return;
    }

    // refresh commands
    const data = await rest.put(Routes.applicationCommands(PROD_CLIENT_ID), { body: commands });

    console.log(`Successfully reloaded ${data.length} application (/) commands. This may take up to an hour to propagate.`);
  } catch (error) {
    console.error(error);
  }
})();
