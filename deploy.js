require("dotenv").config();
const { REST, Routes } = require("discord.js");
const { getCommands } = require("./utility/helper_functions.js");

const useDev = process.argv[2] === "--dev";

const TOKEN = useDev ? process.env.DEV_DISCORD_TOKEN : process.env.PROD_DISCORD_TOKEN;
const CLIENT_ID = useDev ? process.env.DEV_CLIENT_ID : process.env.PROD_CLIENT_ID;
const GUILD_ID = process.env.DEV_GUILD_ID;

const rest = new REST().setToken(TOKEN);

(async () => {
  try {
    const commands = await getCommands();

    console.log(`Started refreshing ${commands.length} application (/) commands.`);

    if (commands === null) {
      console.error("Error retrieving commands.");
      return;
    }

    const route = useDev
      ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
      : Routes.applicationCommands(CLIENT_ID);

    const data = await rest.put(route, { body: commands });

    console.log(`Successfully reloaded ${data.length} application (/) commands.${useDev ? "" : " This may take up to an hour to propagate."}`);
  } catch (error) {
    console.error(error);
  }
})();
