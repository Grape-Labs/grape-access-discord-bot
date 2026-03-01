import { PermissionFlagsBits } from "discord.js";
import { URL } from "node:url";
import { PublicKey } from "@solana/web3.js";
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
    user?: {
      id: string;
      username?: string;
      global_name?: string | null;
      discriminator?: string;
    };
    nick?: string | null;
  };
  user?: {
    id: string;
    username?: string;
    global_name?: string | null;
    discriminator?: string;
  };
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

function collectDiscordIdentityCandidates(interaction: DiscordInteraction): string[] {
  const u = interaction.member?.user ?? interaction.user;
  const candidatesRaw = [
    u?.id,
    u?.username,
    u?.global_name ?? undefined,
    interaction.member?.nick ?? undefined
  ];

  const withDiscriminator =
    u?.username && u?.discriminator && u.discriminator !== "0"
      ? `${u.username}#${u.discriminator}`
      : undefined;
  if (withDiscriminator) {
    candidatesRaw.push(withDiscriminator);
  }

  return Array.from(
    new Set(
      candidatesRaw
        .map((x) => (x ?? "").trim())
        .filter((x) => x.length > 0)
    )
  );
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
      case "link-wallet":
        return this.handleLinkWallet(interaction);
      case "sync-gate":
        return this.handleSyncGate(interaction);
      default:
        return ephemeralMessage("Unknown command.");
    }
  }

  private async handleLinkWallet(interaction: DiscordInteraction): Promise<InteractionResult> {
    const guildId = interaction.guild_id;
    const discordUserId = interaction.member?.user?.id ?? interaction.user?.id;
    if (!guildId || !discordUserId) {
      return ephemeralMessage("This command must be run in a server.");
    }

    const wallet = getOptionString(interaction.data?.options, "wallet");
    if (!wallet) {
      return ephemeralMessage("Missing required option: wallet.");
    }

    try {
      new PublicKey(wallet);
    } catch {
      return ephemeralMessage("Invalid wallet pubkey.");
    }

    await this.store.addWalletLink({
      discordUserId,
      guildId,
      walletPubkey: wallet,
      source: "manual_link_wallet_command"
    });

    const latest = await this.store.getLatestWalletLink(discordUserId, guildId);
    return ephemeralMessage(
      [
        "Wallet linked for this guild.",
        `guild_id: ${guildId}`,
        `discord_user_id: ${discordUserId}`,
        `wallet: ${latest?.walletPubkey ?? wallet}`,
        `verified_at: ${latest?.verifiedAt ?? new Date().toISOString()}`,
        "Run /check now."
      ].join("\n")
    );
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
    const providedGuildId = getOptionString(options, "guild_id");
    const interactionGuildId = interaction.guild_id;
    const guildId = interactionGuildId ?? providedGuildId;
    const passRoleId = getOptionString(options, "pass_role_id");
    const daoIdFallback = getOptionString(options, "dao_id");
    const verificationDaoIdInput = getOptionString(options, "verification_dao_id");
    const reputationDaoIdInput = getOptionString(options, "reputation_dao_id");
    const failActionRaw = getOptionString(options, "fail_action");

    if (interactionGuildId && providedGuildId && providedGuildId !== interactionGuildId) {
      return ephemeralMessage(
        [
          "guild_id option does not match this server.",
          `guild_id_option: ${providedGuildId}`,
          `interaction_guild_id: ${interactionGuildId}`,
          "Use this server's guild ID, or leave guild_id empty."
        ].join("\n")
      );
    }

    if (!gateId || !guildId || !passRoleId) {
      return ephemeralMessage("Missing required options: gate_id, pass_role_id (and guild_id if used in DMs).");
    }

    const hints = await this.manifestService.getHints(gateId);
    const needsOnchainLookup = !verificationDaoIdInput || !reputationDaoIdInput || !daoIdFallback;
    const onchainDaoIds = needsOnchainLookup ? await this.accessClient.getGateDaoIds(gateId) : {};
    const resolvedVerificationDaoId =
      verificationDaoIdInput ??
      daoIdFallback ??
      onchainDaoIds.verificationDaoId ??
      onchainDaoIds.daoId ??
      hints.daoId;
    const resolvedReputationDaoId =
      reputationDaoIdInput ??
      daoIdFallback ??
      onchainDaoIds.reputationDaoId ??
      onchainDaoIds.daoId ??
      hints.daoId;
    const resolvedDaoId =
      daoIdFallback ??
      onchainDaoIds.daoId ??
      resolvedVerificationDaoId ??
      resolvedReputationDaoId ??
      hints.daoId;
    const failAction = (failActionRaw as FailAction | undefined) ?? hints.integrations?.discord?.failAction ?? "none";

    await this.store.upsertGateMapping({
      guildId,
      gateId,
      verificationDaoId: resolvedVerificationDaoId,
      reputationDaoId: resolvedReputationDaoId,
      daoId: resolvedDaoId,
      passRoleId,
      failAction,
      enabled: true
    });
    const readBack = await this.store.getGateMapping(guildId, gateId);
    const enabledInGuild = await this.store.listEnabledGateMappings(guildId);

    return ephemeralMessage(
      [
        "Gate mapping saved.",
        `guild_id: ${guildId}`,
        `gate_id: ${gateId}`,
        `verification_dao_id: ${resolvedVerificationDaoId ?? "not_set"}`,
        `reputation_dao_id: ${resolvedReputationDaoId ?? "not_set"}`,
        `dao_id: ${resolvedDaoId ?? "not_set"}`,
        `pass_role_id: ${passRoleId}`,
        `fail_action: ${failAction}`,
        `verification_dao_id_source: ${
          verificationDaoIdInput
            ? "command:verification_dao_id"
            : daoIdFallback
              ? "command:dao_id_fallback"
              : onchainDaoIds.verificationDaoId || onchainDaoIds.daoId
                ? "onchain"
                : hints.daoId
                  ? "manifest"
                  : "missing"
        }`,
        `reputation_dao_id_source: ${
          reputationDaoIdInput
            ? "command:reputation_dao_id"
            : daoIdFallback
              ? "command:dao_id_fallback"
              : onchainDaoIds.reputationDaoId || onchainDaoIds.daoId
                ? "onchain"
                : hints.daoId
                  ? "manifest"
                  : "missing"
        }`,
        `manifest_discord_hints: ${hints.schemaValid ? "present" : "not_found"}`,
        `storage_mode: ${this.store.getStorageMode()}`,
        `storage_missing_kv_env: ${
          this.store.getMissingKvEnvVars().length > 0
            ? this.store.getMissingKvEnvVars().join(",")
            : "none"
        }`,
        `post_write_readback: ${readBack ? "ok" : "missing"}`,
        `enabled_mappings_in_guild: ${enabledInGuild.length}`
      ].join("\n")
    );
  }

  private async handleVerify(interaction: DiscordInteraction): Promise<InteractionResult> {
    const guildId = interaction.guild_id;
    const discordUserId = interaction.member?.user?.id ?? interaction.user?.id;

    if (!guildId || !discordUserId) {
      return ephemeralMessage("This command must be run in a server.");
    }

    const maps = await this.store.listEnabledGateMappings(guildId);
    if (maps.length === 0) {
      const storageMode = this.store.getStorageMode();
      const missingKvEnv = this.store.getMissingKvEnvVars();
      return ephemeralMessage(
        [
          "No gates configured for this guild. Run /setup-gate or set BOOTSTRAP_GATES_JSON.",
          `guild_id: ${guildId}`,
          `storage_mode: ${storageMode}`,
          `storage_missing_kv_env: ${missingKvEnv.length > 0 ? missingKvEnv.join(",") : "none"}`
        ].join("\n")
      );
    }

    const lines: string[] = ["Access Links:"];
    for (const map of maps) {
      const hints = await this.manifestService.getHints(map.gateId);
      const needsOnchainLookup = !map.verificationDaoId || !map.reputationDaoId || !map.daoId;
      const onchainDaoIds = needsOnchainLookup ? await this.accessClient.getGateDaoIds(map.gateId) : {};
      const verificationDaoId =
        map.verificationDaoId ??
        map.daoId ??
        onchainDaoIds.verificationDaoId ??
        onchainDaoIds.daoId ??
        hints.daoId;
      const reputationDaoId =
        map.reputationDaoId ??
        map.daoId ??
        onchainDaoIds.reputationDaoId ??
        onchainDaoIds.daoId ??
        hints.daoId;
      const daoId = map.daoId ?? onchainDaoIds.daoId ?? verificationDaoId ?? reputationDaoId;

      if (
        daoId !== map.daoId ||
        verificationDaoId !== map.verificationDaoId ||
        reputationDaoId !== map.reputationDaoId
      ) {
        await this.store.upsertGateMapping({
          guildId: map.guildId,
          gateId: map.gateId,
          verificationDaoId,
          reputationDaoId,
          daoId,
          passRoleId: map.passRoleId,
          failAction: map.failAction,
          enabled: map.enabled
        });
      }

      const url = new URL("/access", config.accessFrontendBaseUrl);
      url.searchParams.set("gateId", map.gateId);
      url.searchParams.set("guildId", guildId);
      url.searchParams.set("discordUserId", discordUserId);

      lines.push(`gate_id ${map.gateId}: ${url.toString()}`);
      lines.push(
        verificationDaoId
          ? `verification: https://verification.governance.so/dao/${verificationDaoId}`
          : "verification: DAO_ID missing (set `verification_dao_id` or `dao_id` in /setup-gate)"
      );
      lines.push(
        reputationDaoId
          ? `reputation: https://vine.governance.so/dao/${reputationDaoId}`
          : "reputation: DAO_ID missing (set `reputation_dao_id` or `dao_id` in /setup-gate)"
      );
    }

    return ephemeralMessage(lines.join("\n"));
  }

  private async handleCheck(interaction: DiscordInteraction): Promise<InteractionResult> {
    const guildId = interaction.guild_id;
    const discordUserId = interaction.member?.user?.id ?? interaction.user?.id;

    if (!guildId || !discordUserId) {
      return ephemeralMessage("This command must be run in a server.");
    }

    const maps = await this.store.listEnabledGateMappings(guildId);
    if (maps.length === 0) {
      const globalMappings = await this.store.listEnabledGateMappings();
      const storageMode = this.store.getStorageMode();
      const missingKvEnv = this.store.getMissingKvEnvVars();
      return ephemeralMessage(
        [
          "No enabled gate mappings found for this guild. Run /setup-gate first.",
          `guild_id: ${guildId}`,
          `enabled_mappings_global: ${globalMappings.length}`,
          `storage_mode: ${storageMode}`,
          `storage_missing_kv_env: ${missingKvEnv.length > 0 ? missingKvEnv.join(",") : "none"}`
        ].join("\n")
      );
    }

    const identityCandidates = collectDiscordIdentityCandidates(interaction);

    let latestLink = await this.store.getLatestWalletLink(discordUserId, guildId);
    if (!latestLink) {
      const lookupNotes: string[] = [];
      const verificationFindings: Array<{
        gateId: string;
        identityFound: boolean;
        linksFound: number;
        reason?: string;
        identityPda?: string;
        matchedIdentifier?: string;
      }> = [];

      for (const map of maps) {
        const onchainDaoIds =
          map.verificationDaoId || map.daoId ? {} : await this.accessClient.getGateDaoIds(map.gateId);
        const verificationDaoId =
          map.verificationDaoId ?? map.daoId ?? onchainDaoIds.verificationDaoId ?? onchainDaoIds.daoId;
        const reputationDaoId = map.reputationDaoId ?? onchainDaoIds.reputationDaoId;
        const daoId = map.daoId ?? onchainDaoIds.daoId ?? verificationDaoId ?? reputationDaoId;

        if (
          daoId !== map.daoId ||
          verificationDaoId !== map.verificationDaoId ||
          (reputationDaoId && reputationDaoId !== map.reputationDaoId)
        ) {
          await this.store.upsertGateMapping({
            guildId: map.guildId,
            gateId: map.gateId,
            verificationDaoId,
            reputationDaoId,
            daoId,
            passRoleId: map.passRoleId,
            failAction: map.failAction,
            enabled: map.enabled
          });
        }

        if (!verificationDaoId) {
          lookupNotes.push(`gate ${map.gateId}: verification_dao_id unresolved`);
          continue;
        }

        const walletFromVerification = await this.accessClient.getVerifiedWalletForDiscordUser({
          daoId: verificationDaoId,
          discordUserId,
          identifiers: identityCandidates
        });

        if (walletFromVerification) {
          await this.store.addWalletLink({
            discordUserId,
            guildId,
            walletPubkey: walletFromVerification,
            source: "onchain_verification_lookup"
          });

          latestLink = await this.store.getLatestWalletLink(discordUserId, guildId);
          break;
        }

        const verificationStatus = await this.accessClient.getDiscordVerificationStatus({
          daoId: verificationDaoId,
          discordUserId,
          identifiers: identityCandidates
        });
        verificationFindings.push({
          gateId: map.gateId,
          identityFound: verificationStatus.identityFound,
          linksFound: verificationStatus.linksFound,
          reason: verificationStatus.reason,
          identityPda: verificationStatus.identityPda,
          matchedIdentifier: verificationStatus.matchedIdentifier
        });

        if (verificationStatus.identityFound) {
          lookupNotes.push(
            `gate ${map.gateId}: identity_found pda=${verificationStatus.identityPda ?? "unknown"} links=${verificationStatus.linksFound}`
          );
        } else {
          lookupNotes.push(
            `gate ${map.gateId}: no verification link match for verification_dao_id ${verificationDaoId} (${verificationStatus.reason ?? "identity_not_found"})`
          );
        }
      }

      if (!latestLink && lookupNotes.length > 0) {
        const anyIdentityFound = verificationFindings.some((x) => x.identityFound);
        logger.warn(
          {
            guild_id: guildId,
            user: discordUserId,
            identities: identityCandidates,
            lookup_notes: lookupNotes,
            verification_findings: verificationFindings
          },
          "On-chain verification lookup did not find wallet"
        );

        if (anyIdentityFound && config.basicIdentityCheckMode) {
          const findingByGate = new Map(verificationFindings.map((x) => [x.gateId, x]));
          const lines: string[] = ["basic_mode: identity_only", "wallet_link: missing"];
          let passed = 0;
          let failed = 0;

          for (const map of maps) {
            const finding = findingByGate.get(map.gateId);
            const gatePassed = Boolean(finding?.identityFound);
            if (gatePassed) {
              passed += 1;
            } else {
              failed += 1;
            }

            lines.push(
              `gate ${map.gateId}: ${gatePassed ? "PASS" : "FAIL"} (${gatePassed ? "identity_found" : finding?.reason ?? "identity_not_found_or_dao_unresolved"})`
            );
          }

          lines.unshift(`summary: pass=${passed} fail=${failed}`);
          lines.push("note: BASIC_IDENTITY_CHECK_MODE is enabled (wallet-based criteria are not validated).");
          return ephemeralMessage(lines.join("\n"));
        }

        if (anyIdentityFound) {
          return ephemeralMessage(
            [
              "Verified Discord identity found on-chain, but wallet pubkey is not in bot KV yet.",
              "The verification registry stores wallet hash links, so wallet recovery requires callback sync.",
              "Configure verification callback to one of:",
              "- /api/verification/link",
              "- /api/discord/callback",
              "Required callback fields: discordUserId, walletPubkey, guildId.",
              `debug: ${lookupNotes.join(" | ")}`
            ].join("\n")
          );
        }
      }
    }

    if (!latestLink) {
      return ephemeralMessage(
        [
          "No linked wallet found for your Discord user.",
          "Run /verify and complete verification first so the bot can read your latest verified wallet.",
          "If already verified on-chain, ensure verification_dao_id (or dao_id fallback) resolves for this gate and the Discord identity hash matches."
        ].join("\n")
      );
    }

    const wallet = latestLink.walletPubkey;
    const mode = config.checkMode === "write" ? "onchain_write" : "simulate";
    const lines: string[] = [
      `wallet: ${wallet}`,
      `verified_at: ${latestLink.verifiedAt}`
    ];
    let passedCount = 0;
    let failedCount = 0;

    for (const map of maps) {
      const onchainDaoIds =
        map.verificationDaoId || map.reputationDaoId || map.daoId
          ? {}
          : await this.accessClient.getGateDaoIds(map.gateId);
      const verificationDaoId =
        map.verificationDaoId ?? map.daoId ?? onchainDaoIds.verificationDaoId ?? onchainDaoIds.daoId;
      const reputationDaoId =
        map.reputationDaoId ?? map.daoId ?? onchainDaoIds.reputationDaoId ?? onchainDaoIds.daoId;
      const daoId = map.daoId ?? onchainDaoIds.daoId ?? verificationDaoId ?? reputationDaoId;

      if (
        daoId !== map.daoId ||
        verificationDaoId !== map.verificationDaoId ||
        reputationDaoId !== map.reputationDaoId
      ) {
        await this.store.upsertGateMapping({
          guildId: map.guildId,
          gateId: map.gateId,
          verificationDaoId,
          reputationDaoId,
          daoId,
          passRoleId: map.passRoleId,
          failAction: map.failAction,
          enabled: map.enabled
        });
      }

      try {
        const result = await retryWithBackoff(
          () =>
            this.accessClient.checkAccess({
              gateId: map.gateId,
              walletPubkey: wallet,
              mode,
              discordUserId,
              identifiers: identityCandidates,
              verificationDaoId,
              reputationDaoId
            }),
          {
            maxAttempts: 4,
            baseDelayMs: 500,
            maxDelayMs: 4_000
          }
        );

        await this.store.addCheckResult({
          guildId,
          discordUserId,
          walletPubkey: wallet,
          gateId: map.gateId,
          passed: result.passed,
          source: `command:${result.source}`,
          reason: result.reason,
          proof: result.proof
        });

        if (result.passed) {
          passedCount += 1;
        } else {
          failedCount += 1;
        }

        let reasonText = result.reason ?? "no_reason";
        if (
          !result.passed &&
          result.reason === "discord_identity_not_found_for_verification_criteria" &&
          verificationDaoId
        ) {
          const status = await this.accessClient.getDiscordVerificationStatus({
            daoId: verificationDaoId,
            discordUserId,
            identifiers: identityCandidates
          });
          reasonText = [
            result.reason,
            `verification_dao_id=${verificationDaoId}`,
            `discord_user_id=${discordUserId}`,
            `identity_found=${status.identityFound}`,
            `matched_identifier=${status.matchedIdentifier ?? "none"}`,
            `identifiers=${identityCandidates.join(",")}`
          ].join(" ");
        }

        lines.push(
          `gate ${map.gateId}: ${result.passed ? "PASS" : "FAIL"} (${reasonText})`
        );

        logger.info(
          {
            guild_id: guildId,
            gate_id: map.gateId,
            user: discordUserId,
            wallet,
            result: result.passed ? "pass" : "fail",
            reason: result.reason,
            proof: result.proof
          },
          "User self check"
        );
      } catch (err) {
        const reason = String(err);

        failedCount += 1;
        lines.push(`gate ${map.gateId}: ERROR (${reason})`);

        await this.store.addCheckResult({
          guildId,
          discordUserId,
          walletPubkey: wallet,
          gateId: map.gateId,
          passed: false,
          source: "command:error",
          reason
        });

        logger.error(
          {
            guild_id: guildId,
            gate_id: map.gateId,
            user: discordUserId,
            wallet,
            result: "error",
            reason
          },
          "User self check failed"
        );
      }
    }

    lines.unshift(`summary: pass=${passedCount} fail=${failedCount}`);
    return ephemeralMessage(lines.join("\n"));
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

    const gateMap = await this.store.getGateMapping(guildId, gateId);
    if (!gateMap || !gateMap.enabled) {
      return ephemeralMessage(`No enabled mapping found for gate ${gateId} in this guild.`);
    }

    const job = await this.store.enqueueSyncJob({
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
