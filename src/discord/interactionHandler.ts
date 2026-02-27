import { ChatInputCommandInteraction, Client, PermissionFlagsBits } from "discord.js";
import { URL } from "node:url";
import { BotDatabase } from "../database.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { AccessClient } from "../services/accessClient.js";
import { GateSyncService } from "../services/gateSyncService.js";
import { ManifestService } from "../services/manifestService.js";
import { FailAction } from "../types.js";
import { retryWithBackoff } from "../utils/backoff.js";

function hasModOrAdminPermissions(interaction: ChatInputCommandInteraction): boolean {
  const perms = interaction.memberPermissions;
  if (!perms) {
    return false;
  }

  return (
    perms.has(PermissionFlagsBits.Administrator) ||
    perms.has(PermissionFlagsBits.ManageRoles) ||
    perms.has(PermissionFlagsBits.ModerateMembers)
  );
}

function hasAdminPermissions(interaction: ChatInputCommandInteraction): boolean {
  const perms = interaction.memberPermissions;
  if (!perms) {
    return false;
  }
  return perms.has(PermissionFlagsBits.Administrator) || perms.has(PermissionFlagsBits.ManageGuild);
}

function boolEmoji(value: boolean): string {
  return value ? "PASS" : "FAIL";
}

export class InteractionHandler {
  constructor(
    private readonly client: Client,
    private readonly db: BotDatabase,
    private readonly accessClient: AccessClient,
    private readonly manifestService: ManifestService,
    private readonly gateSyncService: GateSyncService
  ) {}

  async handle(interaction: ChatInputCommandInteraction): Promise<void> {
    switch (interaction.commandName) {
      case "setup-gate":
        await this.handleSetupGate(interaction);
        return;
      case "verify":
        await this.handleVerify(interaction);
        return;
      case "check":
        await this.handleCheck(interaction);
        return;
      case "sync-gate":
        await this.handleSyncGate(interaction);
        return;
      default:
        return;
    }
  }

  private async handleSetupGate(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!hasAdminPermissions(interaction)) {
      await interaction.reply({
        content: "Administrator or Manage Server permission is required.",
        ephemeral: true
      });
      return;
    }

    const gateId = interaction.options.getString("gate_id", true);
    const guildId = interaction.options.getString("guild_id", true);
    const passRoleId = interaction.options.getString("pass_role_id", true);
    const failActionRaw = interaction.options.getString("fail_action");

    const hints = await this.manifestService.getHints(gateId);
    const failAction = (failActionRaw as FailAction | null) ?? hints.integrations?.discord?.failAction ?? "none";

    this.db.upsertGuildGateMap({
      guildId,
      gateId,
      passRoleId,
      failAction,
      enabled: true
    });

    await interaction.reply({
      ephemeral: true,
      content: [
        "Gate mapping saved.",
        `guild_id: ${guildId}`,
        `gate_id: ${gateId}`,
        `pass_role_id: ${passRoleId}`,
        `fail_action: ${failAction}`,
        `manifest_discord_hints: ${hints.schemaValid ? "present" : "not_found"}`
      ].join("\n")
    });
  }

  private async handleVerify(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: "This command must be run in a server.", ephemeral: true });
      return;
    }

    const maps = this.db.listEnabledGateMaps(guildId);
    if (maps.length === 0) {
      await interaction.reply({
        content: "No gates configured for this guild. Run /setup-gate first.",
        ephemeral: true
      });
      return;
    }

    const lines: string[] = ["Verification links:"];

    for (const map of maps) {
      const hints = await this.manifestService.getHints(map.gate_id);
      const daoId = hints.daoId ?? map.gate_id;

      const url = new URL("/access", config.accessFrontendBaseUrl);
      url.searchParams.set("gateId", map.gate_id);
      url.searchParams.set("guildId", guildId);
      url.searchParams.set("discordUserId", interaction.user.id);

      lines.push(`gate_id ${map.gate_id}: ${url.toString()}`);
      lines.push(`verification: https://verification.governance.so/dao/${daoId}`);
      lines.push(`reputation: https://vine.governance.so/dao/${daoId}`);
    }

    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
  }

  private async handleCheck(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!hasModOrAdminPermissions(interaction)) {
      await interaction.reply({
        content: "Moderator/Admin permissions required (Manage Roles, Moderate Members, or Administrator).",
        ephemeral: true
      });
      return;
    }

    const gateId = interaction.options.getString("gate_id", true);
    const wallet = interaction.options.getString("user_wallet", true);

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

      this.db.insertCheckResult({
        walletPubkey: wallet,
        gateId,
        passed: result.passed,
        source: `command:${result.source}`,
        reason: result.reason,
        proof: result.proof
      });

      logger.info(
        {
          guild_id: interaction.guildId,
          gate_id: gateId,
          user: interaction.user.id,
          wallet,
          result: result.passed ? "pass" : "fail",
          reason: result.reason,
          proof: result.proof
        },
        "Manual gate check"
      );

      await interaction.reply({
        ephemeral: true,
        content: [
          `Result: ${boolEmoji(result.passed)}`,
          `source: ${result.source}`,
          `reason: ${result.reason ?? "none"}`
        ].join("\n")
      });
    } catch (err) {
      const reason = String(err);
      this.db.insertCheckResult({
        walletPubkey: wallet,
        gateId,
        passed: false,
        source: "command:error",
        reason
      });

      logger.error(
        {
          guild_id: interaction.guildId,
          gate_id: gateId,
          user: interaction.user.id,
          wallet,
          result: "error",
          reason
        },
        "Manual gate check failed"
      );

      await interaction.reply({
        ephemeral: true,
        content: `Check failed: ${reason}`
      });
    }
  }

  private async handleSyncGate(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!hasModOrAdminPermissions(interaction)) {
      await interaction.reply({
        content: "Moderator/Admin permissions required (Manage Roles, Moderate Members, or Administrator).",
        ephemeral: true
      });
      return;
    }

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: "This command must be run in a server.", ephemeral: true });
      return;
    }

    const gateId = interaction.options.getString("gate_id", true);
    const dryRun = interaction.options.getBoolean("dry_run") ?? config.dryRunSync;

    const gateMap = this.db.getGuildGateMap(guildId, gateId);
    if (!gateMap || gateMap.enabled !== 1) {
      await interaction.reply({
        content: `No enabled mapping found for gate ${gateId} in this guild.`,
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const summary = await this.gateSyncService.syncGate(gateMap, {
        trigger: "command",
        sourceLabel: "sync_command",
        dryRun
      });

      await interaction.editReply(
        [
          "Sync complete.",
          `gate_id: ${summary.gateId}`,
          `checked: ${summary.checked}`,
          `passed: ${summary.passed}`,
          `failed: ${summary.failed}`,
          `role_granted: ${summary.roleGranted}`,
          `role_removed: ${summary.roleRemoved}`,
          `skipped_no_member: ${summary.skippedNoMember}`,
          `errors: ${summary.errors}`,
          `dry_run: ${summary.dryRun}`
        ].join("\n")
      );
    } catch (err) {
      await interaction.editReply(`Sync failed: ${String(err)}`);
    }
  }
}
