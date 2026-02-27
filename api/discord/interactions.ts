import type { VercelRequest, VercelResponse } from "@vercel/node";
import nacl from "tweetnacl";
import { config } from "../../src/config.js";
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

  const result = await handler.handle(payload as never);
  res.status(result.status).json(result.body);
}
