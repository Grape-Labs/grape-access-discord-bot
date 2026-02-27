import { Client, GatewayIntentBits, Events } from "discord.js";
import { config } from "./config.js";
import { BotDatabase } from "./database.js";
import { logger } from "./logger.js";
import { InteractionHandler } from "./discord/interactionHandler.js";
import { AccessClient } from "./services/accessClient.js";
import { ManifestService } from "./services/manifestService.js";
import { GateSyncService } from "./services/gateSyncService.js";
import { RevalidationWorker } from "./worker/revalidationWorker.js";
import { VerificationServer } from "./services/verificationServer.js";

async function main(): Promise<void> {
  const db = new BotDatabase(config.databasePath);
  if (!db.getBotSettings()) {
    db.upsertBotSettings({
      recheckIntervalSec: config.defaultRecheckIntervalSec,
      rpcEndpoint: config.rpcEndpoint,
      cluster: config.cluster
    });
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
  });

  const accessClient = new AccessClient();
  const manifestService = new ManifestService(accessClient);
  const gateSyncService = new GateSyncService(client, db, accessClient, manifestService);
  const interactionHandler = new InteractionHandler(
    client,
    db,
    accessClient,
    manifestService,
    gateSyncService
  );
  const worker = new RevalidationWorker(db, gateSyncService, manifestService);
  const verificationServer = new VerificationServer(db);

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(
      {
        bot_user: readyClient.user.tag,
        cluster: config.cluster,
        rpc_endpoint: config.rpcEndpoint,
        check_mode: config.checkMode,
        programs: config.programs,
        dry_run_sync: config.dryRunSync
      },
      "Discord bot connected"
    );

    verificationServer.start();
    worker.start();
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    try {
      await interactionHandler.handle(interaction);
    } catch (err) {
      logger.error({ err: String(err), command: interaction.commandName }, "Interaction handler failed");

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("Unexpected error handling command.");
      } else {
        await interaction.reply({ content: "Unexpected error handling command.", ephemeral: true });
      }
    }
  });

  process.on("SIGINT", () => {
    worker.stop();
    verificationServer.stop();
    client.destroy();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    worker.stop();
    verificationServer.stop();
    client.destroy();
    process.exit(0);
  });

  await client.login(config.discordToken);
}

main().catch((err) => {
  logger.error({ err: String(err) }, "Fatal startup error");
  process.exit(1);
});
