import { Client, Guild, GuildMember, Role } from "discord.js";
import { BotDatabase } from "../database.js";
import { AccessClient } from "./accessClient.js";
import { ManifestService } from "./manifestService.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { CheckSource, GuildGateMap } from "../types.js";
import { retryWithBackoff } from "../utils/backoff.js";

export interface SyncSummary {
  guildId: string;
  gateId: string;
  checked: number;
  passed: number;
  failed: number;
  roleGranted: number;
  roleRemoved: number;
  skippedNoMember: number;
  errors: number;
  dryRun: boolean;
}

interface SyncOptions {
  dryRun?: boolean;
  trigger: "worker" | "command";
  sourceLabel: string;
}

export class GateSyncService {
  constructor(
    private readonly client: Client,
    private readonly db: BotDatabase,
    private readonly accessClient: AccessClient,
    private readonly manifestService: ManifestService
  ) {}

  private async fetchGuild(guildId: string): Promise<Guild> {
    const cached = this.client.guilds.cache.get(guildId);
    if (cached) {
      return cached;
    }
    return this.client.guilds.fetch(guildId);
  }

  private async fetchMember(guild: Guild, discordUserId: string): Promise<GuildMember | null> {
    try {
      return await guild.members.fetch(discordUserId);
    } catch {
      return null;
    }
  }

  private async fetchRole(guild: Guild, roleId: string): Promise<Role | null> {
    try {
      const role = await guild.roles.fetch(roleId);
      return role ?? null;
    } catch {
      return null;
    }
  }

  private async applyRoleOutcome(params: {
    member: GuildMember;
    role: Role;
    passed: boolean;
    failAction: GuildGateMap["fail_action"];
    dryRun: boolean;
  }): Promise<"granted" | "removed" | "none"> {
    const hasRole = params.member.roles.cache.has(params.role.id);

    if (params.passed) {
      if (hasRole) {
        return "none";
      }

      if (params.dryRun) {
        return "granted";
      }

      await params.member.roles.add(params.role.id, "Grape Access gate check passed");
      return "granted";
    }

    if (params.failAction === "remove_role" && hasRole) {
      if (params.dryRun) {
        return "removed";
      }

      await params.member.roles.remove(params.role.id, "Grape Access gate check failed");
      return "removed";
    }

    return "none";
  }

  async syncGate(gateMap: GuildGateMap, options: SyncOptions): Promise<SyncSummary> {
    const dryRun = options.dryRun ?? config.dryRunSync;
    const checkMode: CheckSource = config.checkMode === "write" ? "onchain_write" : "simulate";

    const summary: SyncSummary = {
      guildId: gateMap.guild_id,
      gateId: gateMap.gate_id,
      checked: 0,
      passed: 0,
      failed: 0,
      roleGranted: 0,
      roleRemoved: 0,
      skippedNoMember: 0,
      errors: 0,
      dryRun
    };

    const guild = await this.fetchGuild(gateMap.guild_id);
    const role = await this.fetchRole(guild, gateMap.pass_role_id);
    if (!role) {
      throw new Error(`Pass role ${gateMap.pass_role_id} not found in guild ${gateMap.guild_id}`);
    }

    const hints = await this.manifestService.getHints(gateMap.gate_id);
    const links = this.db.listLatestWalletLinksForGuild(gateMap.guild_id);

    for (const link of links) {
      const member = await this.fetchMember(guild, link.discord_user_id);
      if (!member) {
        summary.skippedNoMember += 1;
        continue;
      }

      summary.checked += 1;

      try {
        const result = await retryWithBackoff(
          () =>
            this.accessClient.checkAccess({
              gateId: gateMap.gate_id,
              walletPubkey: link.wallet_pubkey,
              mode: checkMode
            }),
          {
            maxAttempts: 4,
            baseDelayMs: 500,
            maxDelayMs: 4_000
          },
          (attempt, err, delayMs) => {
            logger.warn(
              {
                guild_id: gateMap.guild_id,
                gate_id: gateMap.gate_id,
                user: link.discord_user_id,
                wallet: link.wallet_pubkey,
                attempt,
                delay_ms: delayMs,
                err: String(err)
              },
              "Retrying gate check"
            );
          }
        );

        const applied = await this.applyRoleOutcome({
          member,
          role,
          passed: result.passed,
          failAction: gateMap.fail_action,
          dryRun
        });

        if (result.passed) {
          summary.passed += 1;
        } else {
          summary.failed += 1;
        }

        if (applied === "granted") {
          summary.roleGranted += 1;
        }

        if (applied === "removed") {
          summary.roleRemoved += 1;
        }

        this.db.insertCheckResult({
          discordUserId: link.discord_user_id,
          walletPubkey: link.wallet_pubkey,
          gateId: gateMap.gate_id,
          passed: result.passed,
          source: `${options.sourceLabel}:${result.source}`,
          reason: result.reason,
          proof: {
            ...(result.proof ?? {}),
            verifiedAt: link.verified_at,
            manifestSchemaValid: hints.schemaValid
          }
        });

        logger.info(
          {
            guild_id: gateMap.guild_id,
            gate_id: gateMap.gate_id,
            user: link.discord_user_id,
            wallet: link.wallet_pubkey,
            result: result.passed ? "pass" : "fail",
            reason: result.reason,
            action: applied,
            proof: result.proof,
            trigger: options.trigger,
            dry_run: dryRun
          },
          "Gate revalidation complete"
        );
      } catch (err) {
        summary.errors += 1;
        const reason = String(err);
        this.db.insertCheckResult({
          discordUserId: link.discord_user_id,
          walletPubkey: link.wallet_pubkey,
          gateId: gateMap.gate_id,
          passed: false,
          source: `${options.sourceLabel}:error`,
          reason
        });

        logger.error(
          {
            guild_id: gateMap.guild_id,
            gate_id: gateMap.gate_id,
            user: link.discord_user_id,
            wallet: link.wallet_pubkey,
            result: "error",
            reason,
            trigger: options.trigger
          },
          "Gate revalidation failed"
        );
      }
    }

    return summary;
  }
}
