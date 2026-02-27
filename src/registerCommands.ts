import { REST, Routes } from "discord.js";
import { config } from "./config.js";
import { commandDefinitions } from "./discord/commands.js";

async function main(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);

  if (config.discordGuildId) {
    await rest.put(
      Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId),
      { body: commandDefinitions }
    );
    console.log(`Registered guild commands for ${config.discordGuildId}`);
    return;
  }

  await rest.put(Routes.applicationCommands(config.discordClientId), {
    body: commandDefinitions
  });
  console.log("Registered global commands");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
