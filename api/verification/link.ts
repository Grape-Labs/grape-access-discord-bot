import type { VercelRequest, VercelResponse } from "@vercel/node";
import { config } from "../../src/config.js";
import { logger } from "../../src/logger.js";
import { InMemoryStore } from "../../src/store.js";
import { AccessClient } from "../../src/services/accessClient.js";
import { ManifestService } from "../../src/services/manifestService.js";
import { GateSyncService } from "../../src/services/gateSyncService.js";
import { DiscordRestClient } from "../../src/services/discordRestClient.js";

function parseBody(raw: unknown): {
  discordUserId?: string;
  walletPubkey?: string;
  guildId?: string;
  gateId?: string;
  verifiedAt?: string;
  source?: string;
} {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as {
        discordUserId?: string;
        walletPubkey?: string;
        guildId?: string;
        gateId?: string;
        verifiedAt?: string;
        source?: string;
      };
    } catch {
      return {};
    }
  }

  if (!raw || typeof raw !== "object") {
    return {};
  }

  return raw as {
    discordUserId?: string;
    walletPubkey?: string;
    guildId?: string;
    gateId?: string;
    verifiedAt?: string;
    source?: string;
  };
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

function parsePayload(req: VercelRequest): {
  discordUserId?: string;
  walletPubkey?: string;
  guildId?: string;
  gateId?: string;
  verifiedAt?: string;
  source?: string;
} {
  const body = parseBody(req.body);
  const q = req.query as Record<string, unknown>;

  const discordUserId =
    body.discordUserId ??
    firstString(q.discordUserId) ??
    firstString(q.discord_user_id) ??
    firstString(q.userId) ??
    firstString(q.user_id) ??
    firstString(q.discordId) ??
    firstString(q.discord_id);

  const walletPubkey =
    body.walletPubkey ??
    firstString(q.walletPubkey) ??
    firstString(q.wallet_pubkey) ??
    firstString(q.wallet) ??
    firstString(q.publicKey) ??
    firstString(q.public_key);

  const guildId =
    body.guildId ??
    firstString(q.guildId) ??
    firstString(q.guild_id);

  const gateId =
    body.gateId ??
    firstString(q.gateId) ??
    firstString(q.gate_id);

  const verifiedAt =
    body.verifiedAt ??
    firstString(q.verifiedAt) ??
    firstString(q.verified_at);

  const source =
    body.source ??
    firstString(q.source);

  return { discordUserId, walletPubkey, guildId, gateId, verifiedAt, source };
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
    const supplied = req.headers["x-verify-secret"];
    const querySecret = firstString((req.query as Record<string, unknown>).verify_secret);
    if (supplied !== config.verifySharedSecret && querySecret !== config.verifySharedSecret) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
  }

  const body = parsePayload(req);
  if (!body.discordUserId || !body.walletPubkey || !body.guildId) {
    res.status(400).json({
      ok: false,
      error:
        "discordUserId, walletPubkey, and guildId are required (supports query aliases: discord_user_id, wallet, guild_id)"
    });
    return;
  }

  await store.addWalletLink({
    discordUserId: body.discordUserId,
    walletPubkey: body.walletPubkey,
    guildId: body.guildId,
    verifiedAt: body.verifiedAt,
    source: body.source ?? "verification"
  });

  const mappings = body.gateId
    ? [await store.getGateMapping(body.guildId, body.gateId)].filter(
        (x): x is NonNullable<typeof x> => Boolean(x)
      )
    : await store.listEnabledGateMappings(body.guildId);

  const syncResults: Array<Record<string, unknown>> = [];

  for (const map of mappings) {
    try {
      const summary = await gateSyncService.syncGate(map, {
        trigger: "callback",
        sourceLabel: "verify_callback",
        singleDiscordUserId: body.discordUserId,
        dryRun: false
      });

      syncResults.push({ gateId: map.gateId, status: "ok", summary });
    } catch (err) {
      syncResults.push({ gateId: map.gateId, status: "error", reason: String(err) });
    }
  }

  logger.info(
    {
      guild_id: body.guildId,
      user: body.discordUserId,
      wallet: body.walletPubkey,
      verified_at: body.verifiedAt,
      sync_results: syncResults
    },
    "Linked wallet from verification callback"
  );

  res.status(200).json({ ok: true, syncResults });
}
