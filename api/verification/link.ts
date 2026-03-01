import type { VercelRequest, VercelResponse } from "@vercel/node";
import { PublicKey } from "@solana/web3.js";
import { config } from "../../src/config.js";
import { logger } from "../../src/logger.js";
import { InMemoryStore } from "../../src/store.js";
import { AccessClient } from "../../src/services/accessClient.js";
import { ManifestService } from "../../src/services/manifestService.js";
import { GateSyncService } from "../../src/services/gateSyncService.js";
import { DiscordRestClient } from "../../src/services/discordRestClient.js";
import type { GateMapping } from "../../src/types.js";

type CallbackPayload = {
  discordUserId?: string;
  walletPubkey?: string;
  guildId?: string;
  gateId?: string;
  verifiedAt?: string;
  source?: string;
  identityPda?: string;
  linkPda?: string;
};

function collectIdentityCandidatesFromMember(
  discordUserId: string,
  member:
    | {
        user?: {
          id?: string;
          username?: string;
          global_name?: string | null;
          discriminator?: string;
        };
        nick?: string | null;
      }
    | null
): string[] {
  const userId = member?.user?.id ?? discordUserId;
  const username = member?.user?.username;
  const globalName = member?.user?.global_name ?? undefined;
  const nick = member?.nick ?? undefined;
  const discriminator = member?.user?.discriminator;
  const usernameWithDiscriminator =
    username && discriminator && discriminator !== "0" ? `${username}#${discriminator}` : undefined;

  return Array.from(
    new Set(
      [userId, username, globalName, nick, usernameWithDiscriminator]
        .map((x) => (x ?? "").trim())
        .filter((x) => x.length > 0)
    )
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseBody(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return asRecord(JSON.parse(raw)) ?? {};
    } catch {
      return {};
    }
  }

  const rec = asRecord(raw);
  if (!rec) {
    return {};
  }

  return rec;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim().length > 0) {
        return item.trim();
      }
    }
  }
  return undefined;
}

function pickString(
  sources: Array<Record<string, unknown>>,
  query: Record<string, unknown>,
  aliases: string[]
): string | undefined {
  for (const alias of aliases) {
    for (const source of sources) {
      const value = firstString(source[alias]);
      if (value) {
        return value;
      }
    }

    const queryValue = firstString(query[alias]);
    if (queryValue) {
      return queryValue;
    }
  }

  return undefined;
}

function parsePayload(req: VercelRequest): CallbackPayload {
  const body = parseBody(req.body);
  const q = req.query as Record<string, unknown>;
  const bodySources = [
    body,
    asRecord(body.payload),
    asRecord(body.data),
    asRecord(body.event),
    asRecord(body.verification),
    asRecord(body.context),
    asRecord(body.meta),
    asRecord(body.metadata),
    asRecord(body.result)
  ].filter((item): item is Record<string, unknown> => Boolean(item));

  const discordUserId = pickString(bodySources, q, [
    "discordUserId",
    "discord_user_id",
    "platform_user_id",
    "userId",
    "user_id",
    "discordId",
    "discord_id",
    "user"
  ]);

  const walletPubkey = pickString(bodySources, q, [
    "walletPubkey",
    "wallet_pubkey",
    "wallet",
    "wallet_address",
    "address",
    "user_wallet",
    "publicKey",
    "public_key"
  ]);

  const guildId = pickString(bodySources, q, [
    "guildId",
    "guild_id",
    "guild",
    "serverId",
    "server_id"
  ]);

  const gateId = pickString(bodySources, q, [
    "gateId",
    "gate_id",
    "accessId",
    "access_id"
  ]);

  const verifiedAt = pickString(bodySources, q, [
    "verifiedAt",
    "verified_at",
    "timestamp",
    "createdAt",
    "created_at"
  ]);

  const source = pickString(bodySources, q, [
    "source",
    "event",
    "event_type",
    "type"
  ]);

  const identityPda = pickString(bodySources, q, [
    "identityPda",
    "identity_pda",
    "identityAccount",
    "identity_account",
    "identity"
  ]);

  const linkPda = pickString(bodySources, q, [
    "linkPda",
    "link_pda",
    "linkAccount",
    "link_account",
    "link"
  ]);

  return {
    discordUserId,
    walletPubkey,
    guildId,
    gateId,
    verifiedAt,
    source,
    identityPda,
    linkPda
  };
}

function isValidPubkey(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

const store = new InMemoryStore();
const accessClient = new AccessClient();
const manifestService = new ManifestService(accessClient);
const discordClient = new DiscordRestClient();
const gateSyncService = new GateSyncService(store, accessClient, manifestService, discordClient);

export default async function verificationLink(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST" && req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  if (config.verifySharedSecret) {
    const supplied = firstString(req.headers["x-verify-secret"]);
    const authorization = firstString(req.headers.authorization);
    const bearerSecret =
      authorization && authorization.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : undefined;
    const querySecret = firstString((req.query as Record<string, unknown>).verify_secret);
    if (
      supplied !== config.verifySharedSecret &&
      querySecret !== config.verifySharedSecret &&
      bearerSecret !== config.verifySharedSecret
    ) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
  }

  const payload = parsePayload(req);
  if (!payload.discordUserId || !payload.walletPubkey) {
    res.status(400).json({
      ok: false,
      error:
        "discordUserId and walletPubkey are required (supports body/query aliases: discord_user_id, platform_user_id, wallet, wallet_pubkey)"
    });
    return;
  }

  if (!isValidPubkey(payload.walletPubkey)) {
    res.status(400).json({ ok: false, error: "invalid_wallet_pubkey" });
    return;
  }
  if (payload.identityPda && !isValidPubkey(payload.identityPda)) {
    res.status(400).json({ ok: false, error: "invalid_identity_pda" });
    return;
  }
  if (payload.linkPda && !isValidPubkey(payload.linkPda)) {
    res.status(400).json({ ok: false, error: "invalid_link_pda" });
    return;
  }

  let guildId = payload.guildId;
  let resolvedGateId = payload.gateId ? await accessClient.resolveGateId(payload.gateId) : undefined;

  if (!guildId && resolvedGateId) {
    const globalMappings = await store.listEnabledGateMappings();
    const matching = globalMappings.filter((m) => m.gateId === resolvedGateId || m.gateId === payload.gateId);
    const uniqueGuilds = Array.from(new Set(matching.map((m) => m.guildId)));
    if (uniqueGuilds.length === 1) {
      guildId = uniqueGuilds[0];
    } else if (uniqueGuilds.length > 1) {
      res.status(400).json({
        ok: false,
        error: "guild_id_required_for_ambiguous_gate",
        matchingGuilds: uniqueGuilds
      });
      return;
    }
  }

  if (!guildId) {
    res.status(400).json({
      ok: false,
      error: "guildId is required unless gate_id maps to exactly one configured guild"
    });
    return;
  }

  await store.addWalletLink({
    discordUserId: payload.discordUserId,
    walletPubkey: payload.walletPubkey,
    guildId,
    verifiedAt: payload.verifiedAt,
    source: payload.source ?? "verification"
  });

  const mappings = payload.gateId
    ? [
        await store.getGateMapping(guildId, payload.gateId),
        ...(resolvedGateId && resolvedGateId !== payload.gateId
          ? [await store.getGateMapping(guildId, resolvedGateId)]
          : [])
      ].filter((x): x is NonNullable<typeof x> => Boolean(x))
    : await store.listEnabledGateMappings(guildId);

  const uniqueMappings = new Map(mappings.map((m) => [m.gateId, m]));
  const mappingsToSync: GateMapping[] = [];

  for (const map of uniqueMappings.values()) {
    const hints = await manifestService.getHints(map.gateId);
    const needsOnchainLookup = !map.verificationDaoId || !map.reputationDaoId || !map.daoId;
    const onchainDaoIds = needsOnchainLookup ? await accessClient.getGateDaoIds(map.gateId) : {};
    const verificationDaoId =
      map.verificationDaoId ?? map.daoId ?? onchainDaoIds.verificationDaoId ?? onchainDaoIds.daoId ?? hints.daoId;
    const reputationDaoId =
      map.reputationDaoId ?? map.daoId ?? onchainDaoIds.reputationDaoId ?? onchainDaoIds.daoId ?? hints.daoId;
    const daoId = map.daoId ?? onchainDaoIds.daoId ?? verificationDaoId ?? reputationDaoId;

    let syncMap = map;
    if (
      verificationDaoId !== map.verificationDaoId ||
      reputationDaoId !== map.reputationDaoId ||
      daoId !== map.daoId
    ) {
      await store.upsertGateMapping({
        guildId: map.guildId,
        gateId: map.gateId,
        verificationDaoId,
        reputationDaoId,
        daoId,
        passRoleId: map.passRoleId,
        failAction: map.failAction,
        enabled: map.enabled
      });

      syncMap = {
        ...map,
        verificationDaoId,
        reputationDaoId,
        daoId
      };
    }

    mappingsToSync.push(syncMap);
  }

  const syncResults: Array<Record<string, unknown>> = [];
  const appliedIdentityOverrides: Array<Record<string, unknown>> = [];
  let callbackMember: Awaited<ReturnType<DiscordRestClient["fetchMember"]>> = null;
  try {
    callbackMember = await discordClient.fetchMember(guildId, payload.discordUserId);
  } catch (err) {
    logger.warn(
      {
        guild_id: guildId,
        user: payload.discordUserId,
        err: String(err)
      },
      "Failed to fetch Discord member during callback identity candidate build; using user ID fallback"
    );
  }
  const callbackIdentifiers = collectIdentityCandidatesFromMember(payload.discordUserId, callbackMember);

  if (mappingsToSync.length > 0) {
    for (const map of mappingsToSync) {
      let identityPda = payload.identityPda;
      let linkPda = payload.linkPda;
      let overrideSource = payload.source ?? "verification_callback";

      if (!identityPda) {
        const debug = await accessClient.debugIdentityResolution({
          gateId: map.gateId,
          walletPubkey: payload.walletPubkey,
          discordUserId: payload.discordUserId,
          identifiers: callbackIdentifiers,
          verificationDaoId: map.verificationDaoId ?? map.daoId
        });

        identityPda =
          debug.fromIdentifiers?.identityAccount ??
          debug.fromWalletFallback?.identityAccount ??
          debug.verificationStatus?.identityPda;
        linkPda = debug.fromIdentifiers?.linkAccount ?? debug.fromWalletFallback?.linkAccount ?? linkPda;
        overrideSource = "verification_callback:auto_identity_resolution";
      }

      if (!identityPda || !isValidPubkey(identityPda)) {
        continue;
      }
      if (linkPda && !isValidPubkey(linkPda)) {
        linkPda = undefined;
      }

      await store.upsertIdentityOverride({
        guildId,
        gateId: map.gateId,
        discordUserId: payload.discordUserId,
        identityAccount: identityPda,
        linkAccount: linkPda,
        source: overrideSource
      });

      appliedIdentityOverrides.push({
        gateId: map.gateId,
        identityPda,
        linkPda: linkPda ?? null,
        source: overrideSource
      });
    }
  }

  for (const map of mappingsToSync) {
    try {
      const summary = await gateSyncService.syncGate(map, {
        trigger: "callback",
        sourceLabel: "verify_callback",
        singleDiscordUserId: payload.discordUserId,
        dryRun: false
      });

      syncResults.push({ gateId: map.gateId, status: "ok", summary });
    } catch (err) {
      syncResults.push({ gateId: map.gateId, status: "error", reason: String(err) });
    }
  }

  logger.info(
    {
      guild_id: guildId,
      gate_id: payload.gateId,
      resolved_gate_id: resolvedGateId,
      user: payload.discordUserId,
      wallet: payload.walletPubkey,
      identity_pda: payload.identityPda,
      link_pda: payload.linkPda,
      applied_identity_overrides: appliedIdentityOverrides,
      verified_at: payload.verifiedAt,
      sync_results: syncResults
    },
    "Linked wallet from verification callback"
  );

  res.status(200).json({
    ok: true,
    guildId,
    gateId: payload.gateId,
    resolvedGateId: resolvedGateId ?? null,
    linkedWallet: payload.walletPubkey,
    appliedIdentityOverride: appliedIdentityOverrides.length > 0,
    appliedIdentityOverrides,
    mappingsSynced: mappingsToSync.map((m) => m.gateId),
    syncResults
  });
}
