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

const store = new InMemoryStore();
const accessClient = new AccessClient();
const manifestService = new ManifestService(accessClient);
const discordClient = new DiscordRestClient();
const gateSyncService = new GateSyncService(store, accessClient, manifestService, discordClient);

export default async function verificationLink(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  if (config.verifySharedSecret) {
    const supplied = req.headers["x-verify-secret"];
    if (supplied !== config.verifySharedSecret) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
  }

  const body = parseBody(req.body);
  if (!body.discordUserId || !body.walletPubkey || !body.guildId) {
    res.status(400).json({
      ok: false,
      error: "discordUserId, walletPubkey, and guildId are required"
    });
    return;
  }

  store.addWalletLink({
    discordUserId: body.discordUserId,
    walletPubkey: body.walletPubkey,
    guildId: body.guildId,
    verifiedAt: body.verifiedAt,
    source: body.source ?? "verification"
  });

  const mappings = body.gateId
    ? [store.getGateMapping(body.guildId, body.gateId)].filter((x): x is NonNullable<typeof x> => Boolean(x))
    : store.listEnabledGateMappings(body.guildId);

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
