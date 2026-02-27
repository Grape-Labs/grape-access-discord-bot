import express from "express";
import { config } from "../config.js";
import { BotDatabase } from "../database.js";
import { logger } from "../logger.js";

export class VerificationServer {
  private server: ReturnType<ReturnType<typeof express>["listen"]> | null = null;

  constructor(private readonly db: BotDatabase) {}

  start(): void {
    const app = express();
    app.use(express.json({ limit: "64kb" }));

    app.get("/healthz", (_req, res) => {
      res.json({ ok: true });
    });

    app.post("/verification/link", (req, res) => {
      const expected = config.verifySharedSecret;
      if (expected) {
        const supplied = req.header("x-verify-secret");
        if (supplied !== expected) {
          res.status(401).json({ ok: false, error: "unauthorized" });
          return;
        }
      }

      const body = req.body as {
        discordUserId?: string;
        walletPubkey?: string;
        guildId?: string;
        verifiedAt?: string;
        source?: string;
      };

      if (!body.discordUserId || !body.walletPubkey || !body.guildId) {
        res.status(400).json({
          ok: false,
          error: "discordUserId, walletPubkey, and guildId are required"
        });
        return;
      }

      this.db.addWalletLink({
        discordUserId: body.discordUserId,
        walletPubkey: body.walletPubkey,
        guildId: body.guildId,
        verifiedAt: body.verifiedAt,
        source: body.source ?? "verification"
      });

      logger.info(
        {
          guild_id: body.guildId,
          user: body.discordUserId,
          wallet: body.walletPubkey,
          verified_at: body.verifiedAt
        },
        "Linked wallet from verification callback"
      );

      res.json({ ok: true });
    });

    this.server = app.listen(config.callbackPort, () => {
      logger.info({ port: config.callbackPort }, "Verification callback server listening");
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}
