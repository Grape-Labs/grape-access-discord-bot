import { PermissionFlagsBits } from "discord.js";
import { URL } from "node:url";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { InMemoryStore } from "../store.js";
import { FailAction } from "../types.js";
import { retryWithBackoff } from "../utils/backoff.js";
import { AccessClient } from "../services/accessClient.js";
import { GateSyncService } from "../services/gateSyncService.js";
import { ManifestService } from "../services/manifestService.js";

const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4
} as const;

interface DiscordInteractionOption {
  name: string;
  value?: string | boolean | number;
}

interface DiscordApplicationCommandData {
  name: string;
  options?: DiscordInteractionOption[];
}

interface DiscordInteraction {
  type: number;
  guild_id?: string;
  member?: {
    permissions?: string;
    user?: { id: string };
  };
  user?: { id: string };
  data?: DiscordApplicationCommandData;
}

export interface InteractionResult {
  status: number;
  body: Record<string, unknown>;
}

function getOptionString(options: DiscordInteractionOption[] | undefined, name: string): string | undefined {
  const option = options?.find((entry) => entry.name === name);
  return typeof option?.value === "string" ? option.value : undefined;
}

function getOptionBoolean(options: DiscordInteractionOption[] | undefined, name: string): boolean | undefined {
  const option = options?.find((entry) => entry.name === name);
  return typeof option?.value === "boolean" ? option.value : undefined;
}

function hasAnyPermission(bitfieldRaw: string | undefined, flags: bigint[]): boolean {
  if (!bitfieldRaw) {
    return false;
  }

  let perms = 0n;
  try {
    perms = BigInt(bitfieldRaw);
  } catch {
    return false;
  }

  for (const flag of flags) {
    if ((perms & flag) === flag) {
      return true;
    }
  }
  return false;
}

function ephemeralMessage(message: string): InteractionResult {
  return {
    status: 200,
    body: {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: message,
        flags: 64
      }
    }
  };
}

export class InteractionWebhookHandler {
  constructor(
    private readonly store: InMemoryStore,
    private readonly accessClient: AccessClient,
    private readonly manifestService: ManifestService,
    private readonly gateSyncService: GateSyncService
  ) {}

  async handle(interaction: DiscordInteraction): Promise<InteractionResult> {
    if (interaction.type === 1) {
      return {
        status: 200,
        body: { type: InteractionResponseType.PONG }
      };
    }

    const name = interaction.data?.name;
    if (!name) {
      return ephemeralMessage("Unsupported interaction payload.");
    }

    switch (name) {
      case "setup-gate":
        return this.handleSetupGate(interaction);
      case "verify":
        return this.handleVerify(interaction);
      case "check":
        return this.handleCheck(interaction);
      case "sync-gate":
        return this.handleSyncGate(interaction);
      default:
        return ephemeralMessage("Unknown command.");
    }
  }

  private async handleSetupGate(interaction: DiscordInteraction): Promise<InteractionResult> {
    const canAdmin = hasAnyPermission(interaction.member?.permissions, [
      PermissionFlagsBits.Administrator,
      PermissionFlagsBits.ManageGuild
    ]);

    if (!canAdmin) {
      return ephemeralMessage("Administrator or Manage Server permission is required.");
    }

    const options = interaction.data?.options;
    const gateId = getOptionString(options, "gate_id");
    const guildId = getOptionString(options, "guild_id");
    const passRoleId = getOptionString(options, "pass_role_id");
    const failActionRaw = getOptionString(options, "fail_action");

    if (!gateId || !guildId || !passRoleId) {
      return ephemeralMessage("Missing required options: gate_id, guild_id, pass_role_id.");
    }

    const hints = await this.manifestService.getHints(gateId);
    const failAction = (failActionRaw as FailAction | undefined) ?? hints.integrations?.discord?.failAction ?? "none";

    this.store.upsertGateMapping({
      guildId,
      gateId,
      passRoleId,
      failAction,
      enabled: true
    });

    return ephemeralMessage(
      [
        "Gate mapping saved in memory.",
        `guild_id: ${guildId}`,
        `gate_id: ${gateId}`,
        `pass_role_id: ${passRoleId}`,
        `fail_action: ${failAction}`,
        `manifest_discord_hints: ${hints.schemaValid ? "present" : "not_found"}`,
        "note: memory-only storage resets on cold starts/deploys"
      ].join("\n")
    );
  }

  private async handleVerify(interaction: DiscordInteraction): Promise<InteractionResult> {
    const guildId = interaction.guild_id;
    const discordUserId = interaction.member?.user?.id ?? interaction.user?.id;

    if (!guildId || !discordUserId) {
      return ephemeralMessage("This command must be run in a server.");
    }

    const maps = this.store.listEnabledGateMappings(guildId);
    if (maps.length === 0) {
      return ephemeralMessage(
        "No gates configured for this guild. Run /setup-gate or set BOOTSTRAP_GATES_JSON."
      );
    }

    const lines: string[] = ["Verification links:"];
    for (const map of maps) {
      const hints = await this.manifestService.getHints(map.gateId);
      const daoId = hints.daoId ?? map.gateId;

      const url = new URL("/access", config.accessFrontendBaseUrl);
      url.searchParams.set("gateId", map.gateId);
      url.searchParams.set("guildId", guildId);
      url.searchParams.set("discordUserId", discordUserId);

      lines.push(`gate_id ${map.gateId}: ${url.toString()}`);
      lines.push(`verification: https://verification.governance.so/dao/${daoId}`);
      lines.push(`reputation: https://vine.governance.so/dao/${daoId}`);
    }

    return ephemeralMessage(lines.join("\n"));
  }

  private async handleCheck(interaction: DiscordInteraction): Promise<InteractionResult> {
    const canCheck = hasAnyPermission(interaction.member?.permissions, [
      PermissionFlagsBits.Administrator,
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.ModerateMembers
    ]);

    if (!canCheck) {
      return ephemeralMessage(
        "Moderator/Admin permissions required (Manage Roles, Moderate Members, or Administrator)."
      );
    }

    const options = interaction.data?.options;
    const gateId = getOptionString(options, "gate_id");
    const wallet = getOptionString(options, "user_wallet");

    if (!gateId || !wallet) {
      return ephemeralMessage("Missing required options: gate_id, user_wallet.");
    }

    const mode = config.checkMode === "write" ? "onchain_write" : "simulate";

    try {
      const result = await retryWithBackoff(
        () => this.accessClient.checkAccess({ gateId, walletPubkey: wallet, mode }),
        {
          maxAttempts: 4,
          baseDelayMs: 500,
          maxDelayMs: 4_000
        }
      );

      this.store.addCheckResult({
        guildId: interaction.guild_id,
        walletPubkey: wallet,
        gateId,
        passed: result.passed,
        source: `command:${result.source}`,
        reason: result.reason,
        proof: result.proof
      });

      logger.info(
        {
          guild_id: interaction.guild_id,
          gate_id: gateId,
          user: interaction.member?.user?.id ?? interaction.user?.id,
          wallet,
          result: result.passed ? "pass" : "fail",
          reason: result.reason,
          proof: result.proof
        },
        "Manual gate check"
      );

      return ephemeralMessage(
        [
          `Result: ${result.passed ? "PASS" : "FAIL"}`,
          `source: ${result.source}`,
          `reason: ${result.reason ?? "none"}`
        ].join("\n")
      );
    } catch (err) {
      const reason = String(err);
      this.store.addCheckResult({
        guildId: interaction.guild_id,
        walletPubkey: wallet,
        gateId,
        passed: false,
        source: "command:error",
        reason
      });

      logger.error(
        {
          guild_id: interaction.guild_id,
          gate_id: gateId,
          user: interaction.member?.user?.id ?? interaction.user?.id,
          wallet,
          result: "error",
          reason
        },
        "Manual gate check failed"
      );

      return ephemeralMessage(`Check failed: ${reason}`);
    }
  }

  private async handleSyncGate(interaction: DiscordInteraction): Promise<InteractionResult> {
    const canSync = hasAnyPermission(interaction.member?.permissions, [
      PermissionFlagsBits.Administrator,
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.ModerateMembers
    ]);

    if (!canSync) {
      return ephemeralMessage(
        "Moderator/Admin permissions required (Manage Roles, Moderate Members, or Administrator)."
      );
    }

    const guildId = interaction.guild_id;
    const requestedBy = interaction.member?.user?.id ?? interaction.user?.id;
    if (!guildId || !requestedBy) {
      return ephemeralMessage("This command must be run in a server.");
    }

    const options = interaction.data?.options;
    const gateId = getOptionString(options, "gate_id");
    const dryRun = getOptionBoolean(options, "dry_run") ?? config.dryRunSync;

    if (!gateId) {
      return ephemeralMessage("Missing required option: gate_id.");
    }

    const gateMap = this.store.getGateMapping(guildId, gateId);
    if (!gateMap || !gateMap.enabled) {
      return ephemeralMessage(`No enabled mapping found for gate ${gateId} in this guild.`);
    }

    const job = this.store.enqueueSyncJob({
      guildId,
      gateId,
      requestedBy,
      dryRun
    });

    return ephemeralMessage(
      [
        "Sync job queued.",
        `job_id: ${job.id}`,
        `gate_id: ${job.gateId}`,
        `dry_run: ${job.dryRun}`,
        "Cron endpoint /api/cron/revalidate will process this job."
      ].join("\n")
    );
  }
}
