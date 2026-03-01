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

function buildDiscordVerificationUrl(params: {
  verificationDaoId: string;
  discordUserId: string;
  guildId: string;
  gateId: string;
}): string {
  const url = new URL(`/dao/${params.verificationDaoId}`, "https://verification.governance.so");
  url.searchParams.set("source", "discord");
  url.searchParams.set("platform", "discord");
  url.searchParams.set("platform_user_id", params.discordUserId);
  url.searchParams.set("guild_id", params.guildId);
  url.searchParams.set("gate_id", params.gateId);
  return url.toString();
}

function buildAccessUrl(params: {
  gateId: string;
  guildId: string;
  discordUserId: string;
}): string {
  const url = new URL("/access", config.accessFrontendBaseUrl);
  url.searchParams.set("gateId", params.gateId);
  url.searchParams.set("guildId", params.guildId);
  url.searchParams.set("discordUserId", params.discordUserId);
  url.searchParams.set("cluster", config.cluster);
  return url.toString();
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
      case "debug-identity":
        return this.handleDebugIdentity(interaction);
      case "link-identity":
        return this.handleLinkIdentity(interaction);
      case "link-wallet":
        return this.handleLinkWallet(interaction);
      case "reset-me":
        return this.handleResetMe(interaction);
      case "sync-gate":
        return this.handleSyncGate(interaction);
      default:
        return ephemeralMessage("Unknown command.");
    }
  }

  private async handleLinkWallet(interaction: DiscordInteraction): Promise<InteractionResult> {
    const canAdmin = hasAnyPermission(interaction.member?.permissions, [PermissionFlagsBits.Administrator]);
    if (!canAdmin) {
      return ephemeralMessage(
        "Administrator permission is required for manual wallet linking. End users should use /verify."
      );
    }

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

  private async handleLinkIdentity(interaction: DiscordInteraction): Promise<InteractionResult> {
    const canAdmin = hasAnyPermission(interaction.member?.permissions, [PermissionFlagsBits.Administrator]);
    if (!canAdmin) {
      return ephemeralMessage(
        "Administrator permission is required for manual identity linking. End users should use /verify."
      );
    }

    const guildId = interaction.guild_id;
    const discordUserId = interaction.member?.user?.id ?? interaction.user?.id;
    if (!guildId || !discordUserId) {
      return ephemeralMessage("This command must be run in a server.");
    }

    const requestedGateId = getOptionString(interaction.data?.options, "gate_id");
    const identityPda = getOptionString(interaction.data?.options, "identity_pda");
    const linkPda = getOptionString(interaction.data?.options, "link_pda");

    if (!requestedGateId || !identityPda) {
      return ephemeralMessage("Missing required options: gate_id, identity_pda.");
    }

    try {
      new PublicKey(identityPda);
    } catch {
      return ephemeralMessage("Invalid identity_pda pubkey.");
    }

    if (linkPda) {
      try {
        new PublicKey(linkPda);
      } catch {
        return ephemeralMessage("Invalid link_pda pubkey.");
      }
    }

    const resolvedGateId = await this.accessClient.resolveGateId(requestedGateId);
    let gateMap =
      (await this.store.getGateMapping(guildId, requestedGateId)) ??
      (await this.store.getGateMapping(guildId, resolvedGateId));

    if (!gateMap) {
      const guildMaps = await this.store.listEnabledGateMappings(guildId);
      for (const candidate of guildMaps) {
        if (candidate.gateId === requestedGateId || candidate.gateId === resolvedGateId) {
          gateMap = candidate;
          break;
        }

        const candidateResolved = await this.accessClient.resolveGateId(candidate.gateId);
        if (candidateResolved === resolvedGateId) {
          gateMap = candidate;
          break;
        }
      }
    }

    if (!gateMap || !gateMap.enabled) {
      return ephemeralMessage(
        `No enabled mapping found in this guild for gate ${requestedGateId}${resolvedGateId !== requestedGateId ? ` (resolved: ${resolvedGateId})` : ""}.`
      );
    }

    const saved = await this.store.upsertIdentityOverride({
      guildId,
      gateId: gateMap.gateId,
      discordUserId,
      identityAccount: identityPda,
      linkAccount: linkPda,
      source: "manual_link_identity_command"
    });

    return ephemeralMessage(
      [
        "Manual identity override saved.",
        `guild_id: ${saved.guildId}`,
        `discord_user_id: ${saved.discordUserId}`,
        `gate_id: ${saved.gateId}`,
        `identity_pda: ${saved.identityAccount}`,
        `link_pda: ${saved.linkAccount ?? "not_set"}`,
        `updated_at: ${saved.updatedAt}`,
        "Run /check now.",
        "Tip: use /debug-identity to compare auto-resolution vs manual override."
      ].join("\n")
    );
  }

  private async handleResetMe(interaction: DiscordInteraction): Promise<InteractionResult> {
    const canAdmin = hasAnyPermission(interaction.member?.permissions, [PermissionFlagsBits.Administrator]);
    if (!canAdmin) {
      return ephemeralMessage(
        "Administrator permission is required for manual reset. End users should use /verify."
      );
    }

    const guildId = interaction.guild_id;
    const discordUserId = interaction.member?.user?.id ?? interaction.user?.id;
    if (!guildId || !discordUserId) {
      return ephemeralMessage("This command must be run in a server.");
    }

    const walletRemoved = await this.store.deleteLatestWalletLink(discordUserId, guildId);
    const overridesRemoved = await this.store.deleteIdentityOverridesForUser(guildId, discordUserId);
    const latestAfter = await this.store.getLatestWalletLink(discordUserId, guildId);

    return ephemeralMessage(
      [
        "Reset complete for your user in this guild.",
        `guild_id: ${guildId}`,
        `discord_user_id: ${discordUserId}`,
        `wallet_link_removed: ${walletRemoved}`,
        `identity_overrides_removed: ${overridesRemoved}`,
        `wallet_link_exists_after_reset: ${latestAfter ? "yes" : "no"}`,
        "Next: run /verify and complete the verification flow again."
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

    const lines: string[] = [
      "Access Links:",
      "Complete verification from one link below; callback sync will automatically apply your role.",
      "/check and manual link commands are admin-only."
    ];
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

      lines.push(
        `gate_id ${map.gateId}: ${buildAccessUrl({
          gateId: map.gateId,
          guildId,
          discordUserId
        })}`
      );
      lines.push(
        verificationDaoId
          ? `verification: ${buildDiscordVerificationUrl({
              verificationDaoId,
              discordUserId,
              guildId,
              gateId: map.gateId
            })}`
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
    const canAdmin = hasAnyPermission(interaction.member?.permissions, [PermissionFlagsBits.Administrator]);
    if (!canAdmin) {
      return ephemeralMessage(
        "Administrator permission is required for /check. End users should use /verify and rely on callback auto-sync."
      );
    }

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

      const identityOverride = await this.store.getIdentityOverride(guildId, map.gateId, discordUserId);

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
              reputationDaoId,
              identityAccountOverride: identityOverride?.identityAccount,
              linkAccountOverride: identityOverride?.linkAccount
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
        if (!result.passed) {
          const proof = result.proof as Record<string, unknown> | undefined;
          const logsRaw = proof?.logs;
          const logs =
            Array.isArray(logsRaw)
              ? logsRaw.filter((entry): entry is string => typeof entry === "string")
              : [];
          if (logs.length > 0) {
            const logHint =
              logs.find((line) => line.startsWith("Program log:")) ??
              logs.find((line) => line.startsWith("Program ")) ??
              logs.at(-1);
            if (logHint) {
              reasonText = `${reasonText} log_hint=${logHint}`;
            }
          }

          if (result.reason === "identity_account_required_custom_6004" && verificationDaoId) {
            const verificationStatus = await this.accessClient.getDiscordVerificationStatus({
              daoId: verificationDaoId,
              discordUserId,
              identifiers: identityCandidates
            });
            reasonText = [
              reasonText,
              `verification_identity_found=${verificationStatus.identityFound}`,
              `verification_matched_identifier=${verificationStatus.matchedIdentifier ?? "none"}`,
              `verification_identity_pda=${verificationStatus.identityPda ?? "none"}`
            ].join(" ");

            if (verificationStatus.identityFound) {
              lines.push(
                "action: identity is present on-chain, but bot account derivation did not resolve it for this check."
              );
              lines.push(
                "action: run /link-identity with identity_pda (and link_pda) or ensure callback includes identity/link PDAs."
              );
            } else {
              lines.push(
                `action: complete Discord verification with this URL: ${buildAccessUrl({
                  gateId: map.gateId,
                  discordUserId,
                  guildId
                })}`
              );
              lines.push(
                "action: if you already verified, check that your Discord ID (not just username) is the linked identifier."
              );
            }
          }

          if (result.reason === "invalid_identity_account_custom_6008") {
            lines.push(
              "action: provided identity account is invalid for this gate space; re-check the identity PDA."
            );
          }

          if (result.reason === "link_account_required_custom_6005" && identityOverride?.identityAccount) {
            lines.push(
              "action: identity override is present but link PDA is missing/invalid; re-run /link-identity with link_pda."
            );
          }
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

  private async handleDebugIdentity(interaction: DiscordInteraction): Promise<InteractionResult> {
    const canAdmin = hasAnyPermission(interaction.member?.permissions, [PermissionFlagsBits.Administrator]);
    if (!canAdmin) {
      return ephemeralMessage(
        "Administrator permission is required for /debug-identity. End users should use /verify."
      );
    }

    const guildId = interaction.guild_id;
    const discordUserId = interaction.member?.user?.id ?? interaction.user?.id;
    if (!guildId || !discordUserId) {
      return ephemeralMessage("This command must be run in a server.");
    }

    const gateId = getOptionString(interaction.data?.options, "gate_id");
    if (!gateId) {
      return ephemeralMessage("Missing required option: gate_id.");
    }

    const map = await this.store.getGateMapping(guildId, gateId);
    if (!map || !map.enabled) {
      return ephemeralMessage(`No enabled mapping found for gate ${gateId} in this guild.`);
    }

    const latestLink = await this.store.getLatestWalletLink(discordUserId, guildId);
    if (!latestLink) {
      return ephemeralMessage("No linked wallet in KV for your user. Run /verify or /link-wallet first.");
    }

    const identityCandidates = collectDiscordIdentityCandidates(interaction);
    const onchainDaoIds =
      map.verificationDaoId || map.daoId ? {} : await this.accessClient.getGateDaoIds(map.gateId);
    const verificationDaoId =
      map.verificationDaoId ?? map.daoId ?? onchainDaoIds.verificationDaoId ?? onchainDaoIds.daoId;
    const identityOverride = await this.store.getIdentityOverride(guildId, map.gateId, discordUserId);

    const debug = await this.accessClient.debugIdentityResolution({
      gateId: map.gateId,
      walletPubkey: latestLink.walletPubkey,
      discordUserId,
      identifiers: identityCandidates,
      verificationDaoId
    });

    return ephemeralMessage(
      [
        "Identity debug:",
        `gate_id: ${debug.gateId}`,
        `resolved_gate_id: ${debug.resolvedGateId}`,
        `wallet: ${latestLink.walletPubkey}`,
        `verification_dao_id: ${debug.verificationDaoId ?? "missing"}`,
        `grape_space: ${debug.grapeSpace ?? "missing"}`,
        `identifiers: ${debug.identifiers.join(",") || "none"}`,
        `expanded_identifiers_count: ${debug.expandedIdentifiers.length}`,
        `verification_identity_found: ${debug.verificationStatus?.identityFound ?? false}`,
        `verification_identity_pda: ${debug.verificationStatus?.identityPda ?? "none"}`,
        `verification_matched_identifier: ${debug.verificationStatus?.matchedIdentifier ?? "none"}`,
        `manual_override.identity: ${identityOverride?.identityAccount ?? "none"}`,
        `manual_override.link: ${identityOverride?.linkAccount ?? "none"}`,
        `from_identifiers.identity: ${debug.fromIdentifiers?.identityAccount ?? "none"}`,
        `from_identifiers.link: ${debug.fromIdentifiers?.linkAccount ?? "none"}`,
        `from_wallet_fallback.identity: ${debug.fromWalletFallback?.identityAccount ?? "none"}`,
        `from_wallet_fallback.link: ${debug.fromWalletFallback?.linkAccount ?? "none"}`
      ].join("\n")
    );
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
