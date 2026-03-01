import { config } from "../config.js";
import { logger } from "../logger.js";
import { InMemoryStore } from "../store.js";
import { CheckSource, GateMapping } from "../types.js";
import { retryWithBackoff } from "../utils/backoff.js";
import { AccessClient } from "./accessClient.js";
import { DiscordRestClient } from "./discordRestClient.js";
import { ManifestService } from "./manifestService.js";

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
  errorReasons: string[];
  dryRun: boolean;
}

interface SyncOptions {
  dryRun?: boolean;
  trigger: "cron" | "command" | "callback";
  sourceLabel: string;
  singleDiscordUserId?: string;
}

function collectIdentityCandidatesFromMember(member: {
  user: {
    id: string;
    username?: string;
    global_name?: string | null;
    discriminator?: string;
  };
  nick?: string | null;
}): string[] {
  const raw = [
    member.user.id,
    member.user.username,
    member.user.global_name ?? undefined,
    member.nick ?? undefined
  ];

  const withDiscriminator =
    member.user.username &&
    member.user.discriminator &&
    member.user.discriminator !== "0"
      ? `${member.user.username}#${member.user.discriminator}`
      : undefined;
  if (withDiscriminator) {
    raw.push(withDiscriminator);
  }

  return Array.from(
    new Set(
      raw
        .map((x) => (x ?? "").trim())
        .filter((x) => x.length > 0)
    )
  );
}

export class GateSyncService {
  constructor(
    private readonly store: InMemoryStore,
    private readonly accessClient: AccessClient,
    private readonly manifestService: ManifestService,
    private readonly discordClient: DiscordRestClient
  ) {}

  private async applyRoleOutcome(params: {
    guildId: string;
    userId: string;
    roleId: string;
    memberRoles: string[];
    passed: boolean;
    failAction: GateMapping["failAction"];
    dryRun: boolean;
  }): Promise<"granted" | "removed" | "none"> {
    const hasRole = params.memberRoles.includes(params.roleId);

    if (params.passed) {
      if (hasRole) {
        return "none";
      }

      if (params.dryRun) {
        return "granted";
      }

      await this.discordClient.addRole(
        params.guildId,
        params.userId,
        params.roleId,
        "Grape Access gate check passed"
      );
      return "granted";
    }

    if (params.failAction === "remove_role" && hasRole) {
      if (params.dryRun) {
        return "removed";
      }

      await this.discordClient.removeRole(
        params.guildId,
        params.userId,
        params.roleId,
        "Grape Access gate check failed"
      );
      return "removed";
    }

    return "none";
  }

  async syncGate(gateMap: GateMapping, options: SyncOptions): Promise<SyncSummary> {
    const dryRun = options.dryRun ?? config.dryRunSync;
    const checkMode: CheckSource = config.checkMode === "write" ? "onchain_write" : "simulate";

    const summary: SyncSummary = {
      guildId: gateMap.guildId,
      gateId: gateMap.gateId,
      checked: 0,
      passed: 0,
      failed: 0,
      roleGranted: 0,
      roleRemoved: 0,
      skippedNoMember: 0,
      errors: 0,
      errorReasons: [],
      dryRun
    };

    const roleExists = await this.discordClient.fetchRole(gateMap.guildId, gateMap.passRoleId);
    if (!roleExists) {
      throw new Error(`Pass role ${gateMap.passRoleId} not found in guild ${gateMap.guildId}`);
    }

    const hints = await this.manifestService.getHints(gateMap.gateId);

    let links = await this.store.listLatestWalletLinksForGuild(gateMap.guildId);
    if (options.singleDiscordUserId) {
      links = links.filter((item) => item.discordUserId === options.singleDiscordUserId);
    }

    if (links.length > config.maxUsersPerSync) {
      links = links.slice(0, config.maxUsersPerSync);
    }

    for (const link of links) {
      const member = await this.discordClient.fetchMember(gateMap.guildId, link.discordUserId);
      if (!member) {
        summary.skippedNoMember += 1;
        continue;
      }

      const identityOverride = await this.store.getIdentityOverride(
        gateMap.guildId,
        gateMap.gateId,
        link.discordUserId
      );
      const identityCandidates = collectIdentityCandidatesFromMember(member);
      const verificationDaoId = gateMap.verificationDaoId ?? gateMap.daoId;
      const reputationDaoId = gateMap.reputationDaoId ?? gateMap.daoId;

      summary.checked += 1;

      try {
        const checkWithOverrides = async (overrides?: { identityAccount?: string; linkAccount?: string }) =>
          retryWithBackoff(
            () =>
              this.accessClient.checkAccess({
                gateId: gateMap.gateId,
                walletPubkey: link.walletPubkey,
                mode: checkMode,
                discordUserId: link.discordUserId,
                identifiers: identityCandidates,
                verificationDaoId,
                reputationDaoId,
                identityAccountOverride: overrides?.identityAccount,
                linkAccountOverride: overrides?.linkAccount
              }),
            {
              maxAttempts: 4,
              baseDelayMs: 500,
              maxDelayMs: 4_000
            },
            (attempt, err, delayMs) => {
              logger.warn(
                {
                  guild_id: gateMap.guildId,
                  gate_id: gateMap.gateId,
                  user: link.discordUserId,
                  wallet: link.walletPubkey,
                  attempt,
                  delay_ms: delayMs,
                  err: String(err)
                },
                "Retrying gate check"
              );
            }
          );

        let effectiveOverride = identityOverride;
        let autoResolution: Record<string, unknown> | undefined;
        let result = await checkWithOverrides({
          identityAccount: effectiveOverride?.identityAccount,
          linkAccount: effectiveOverride?.linkAccount
        });

        if (!result.passed && result.reason === "identity_account_required_custom_6004" && verificationDaoId) {
          const debug = await this.accessClient.debugIdentityResolution({
            gateId: gateMap.gateId,
            walletPubkey: link.walletPubkey,
            discordUserId: link.discordUserId,
            identifiers: identityCandidates,
            verificationDaoId
          });

          const resolvedIdentity =
            debug.fromIdentifiers?.identityAccount ??
            debug.fromWalletFallback?.identityAccount ??
            debug.verificationStatus?.identityPda;
          const resolvedLink = debug.fromIdentifiers?.linkAccount ?? debug.fromWalletFallback?.linkAccount;

          if (resolvedIdentity) {
            effectiveOverride = await this.store.upsertIdentityOverride({
              guildId: gateMap.guildId,
              gateId: gateMap.gateId,
              discordUserId: link.discordUserId,
              identityAccount: resolvedIdentity,
              linkAccount: resolvedLink,
              source: "gate_sync_auto_identity_resolution"
            });

            autoResolution = {
              attempted: true,
              identityAccount: resolvedIdentity,
              linkAccount: resolvedLink ?? null,
              verificationIdentityFound: debug.verificationStatus?.identityFound ?? false,
              verificationMatchedIdentifier: debug.verificationStatus?.matchedIdentifier ?? null
            };

            result = await checkWithOverrides({
              identityAccount: effectiveOverride.identityAccount,
              linkAccount: effectiveOverride.linkAccount
            });
          } else {
            autoResolution = {
              attempted: true,
              identityAccount: null,
              linkAccount: null,
              verificationIdentityFound: debug.verificationStatus?.identityFound ?? false,
              verificationMatchedIdentifier: debug.verificationStatus?.matchedIdentifier ?? null
            };
          }
        }

        const action = await this.applyRoleOutcome({
          guildId: gateMap.guildId,
          userId: link.discordUserId,
          roleId: gateMap.passRoleId,
          memberRoles: member.roles,
          passed: result.passed,
          failAction: gateMap.failAction,
          dryRun
        });

        if (result.passed) {
          summary.passed += 1;
        } else {
          summary.failed += 1;
        }

        if (action === "granted") {
          summary.roleGranted += 1;
        }

        if (action === "removed") {
          summary.roleRemoved += 1;
        }

        await this.store.addCheckResult({
          discordUserId: link.discordUserId,
          guildId: gateMap.guildId,
          walletPubkey: link.walletPubkey,
          gateId: gateMap.gateId,
          passed: result.passed,
          source: `${options.sourceLabel}:${result.source}`,
          reason: result.reason,
          proof: {
            ...(result.proof ?? {}),
            identityCandidates,
            autoIdentityResolution: autoResolution,
            identityOverride: effectiveOverride
              ? {
                  identityAccount: effectiveOverride.identityAccount,
                  linkAccount: effectiveOverride.linkAccount,
                  source: effectiveOverride.source,
                  updatedAt: effectiveOverride.updatedAt
                }
              : undefined,
            verifiedAt: link.verifiedAt,
            manifestSchemaValid: hints.schemaValid
          }
        });

        logger.info(
          {
            guild_id: gateMap.guildId,
            gate_id: gateMap.gateId,
            user: link.discordUserId,
            wallet: link.walletPubkey,
            result: result.passed ? "pass" : "fail",
            reason: result.reason,
            action,
            proof: result.proof,
            trigger: options.trigger,
            dry_run: dryRun
          },
          "Gate revalidation complete"
        );
      } catch (err) {
        summary.errors += 1;
        const reason = String(err);
        if (summary.errorReasons.length < 5) {
          summary.errorReasons.push(reason);
        }

        await this.store.addCheckResult({
          discordUserId: link.discordUserId,
          guildId: gateMap.guildId,
          walletPubkey: link.walletPubkey,
          gateId: gateMap.gateId,
          passed: false,
          source: `${options.sourceLabel}:error`,
          reason
        });

        logger.error(
          {
            guild_id: gateMap.guildId,
            gate_id: gateMap.gateId,
            user: link.discordUserId,
            wallet: link.walletPubkey,
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
