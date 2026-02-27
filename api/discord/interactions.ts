import type { VercelRequest, VercelResponse } from "@vercel/node";
import nacl from "tweetnacl";
import { config } from "../../src/config.js";
import { logger } from "../../src/logger.js";
import { InMemoryStore } from "../../src/store.js";
import { AccessClient } from "../../src/services/accessClient.js";
import { ManifestService } from "../../src/services/manifestService.js";
import { GateSyncService } from "../../src/services/gateSyncService.js";
import { DiscordRestClient } from "../../src/services/discordRestClient.js";
import { InteractionWebhookHandler } from "../../src/discord/interactionWebhookHandler.js";

async function readRawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function verifyDiscordRequest(rawBody: string, signature: string, timestamp: string): boolean {
  const message = Buffer.from(timestamp + rawBody);
  const sig = Buffer.from(signature, "hex");
  const publicKey = Buffer.from(config.discordPublicKey, "hex");
  return nacl.sign.detached.verify(message, sig, publicKey);
}

const store = new InMemoryStore();
const accessClient = new AccessClient();
const manifestService = new ManifestService(accessClient);
const discordClient = new DiscordRestClient();
const gateSyncService = new GateSyncService(store, accessClient, manifestService, discordClient);
const handler = new InteractionWebhookHandler(store, accessClient, manifestService, gateSyncService);

const InteractionResponseType = {
  PONG: 1,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5
} as const;

function extractContent(result: Record<string, unknown>): string {
  const data = result.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Done.";
  }
  const content = (data as Record<string, unknown>).content;
  return typeof content === "string" && content.length > 0 ? content : "Done.";
}

async function editOriginalInteractionResponse(params: {
  applicationId: string;
  interactionToken: string;
  content: string;
}): Promise<void> {
  await fetch(
    `https://discord.com/api/v10/webhooks/${params.applicationId}/${params.interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        content: params.content
      })
    }
  );
}

export default async function interactions(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  if (typeof signature !== "string" || typeof timestamp !== "string") {
    res.status(401).json({ error: "missing_signature_headers" });
    return;
  }

  const rawBody = await readRawBody(req);
  if (!verifyDiscordRequest(rawBody, signature, timestamp)) {
    res.status(401).json({ error: "invalid_request_signature" });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    res.status(400).json({ error: "invalid_json" });
    return;
  }

  const interaction = payload as Record<string, unknown>;
  const type = typeof interaction.type === "number" ? interaction.type : undefined;
  const interactionToken =
    typeof interaction.token === "string" && interaction.token.length > 0 ? interaction.token : undefined;
  const applicationId =
    typeof interaction.application_id === "string" && interaction.application_id.length > 0
      ? interaction.application_id
      : config.discordAppId;

  if (type === 1) {
    res.status(200).json({ type: InteractionResponseType.PONG });
    return;
  }

  if (!interactionToken || !applicationId) {
    const result = await handler.handle(payload as never);
    res.status(result.status).json(result.body);
    return;
  }

  res.status(200).json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: 64 }
  });

  void (async () => {
    try {
      const result = await handler.handle(payload as never);
      const content = extractContent(result.body);
      await editOriginalInteractionResponse({
        applicationId,
        interactionToken,
        content
      });
    } catch (err) {
      logger.error({ err: String(err) }, "Deferred interaction handling failed");
      try {
        await editOriginalInteractionResponse({
          applicationId,
          interactionToken,
          content:
            "Request failed while processing RPC checks. Verify RPC_ENDPOINT health and try again."
        });
      } catch {
        // Ignore follow-up failures.
      }
    }
  })();
}
