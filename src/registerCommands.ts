import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commandDefinitions } from "./discord/commands.js";

async function main(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordBotToken);

  if (config.discordCommandGuildId) {
    await rest.put(
      Routes.applicationGuildCommands(config.discordAppId, config.discordCommandGuildId),
      { body: commandDefinitions }
    );
    console.log(`Registered guild commands for ${config.discordCommandGuildId}`);
    return;
  }

  await rest.put(Routes.applicationCommands(config.discordAppId), {
    body: commandDefinitions
  });
  console.log("Registered global commands");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
