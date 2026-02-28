import dotenv from "dotenv";
import { z } from "zod";
import { FailAction } from "./types.js";

dotenv.config();

const envSchema = z.object({
  DISCORD_APP_ID: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_TOKEN: z.string().optional(),
  DISCORD_PUBLIC_KEY: z.string().optional(),
  DISCORD_COMMAND_GUILD_ID: z.string().optional(),
  RPC_ENDPOINT: z.string().url().default("https://api.mainnet-beta.solana.com"),
  CLUSTER: z.enum(["mainnet-beta", "devnet", "testnet"]).default("mainnet-beta"),
  CHECK_MODE: z.enum(["simulate", "write"]).default("simulate"),
  ONCHAIN_CHECKER_KEYPAIR_PATH: z.string().optional(),
  ACCESS_FRONTEND_BASE_URL: z.string().url(),
  DEFAULT_RECHECK_INTERVAL_SEC: z.coerce.number().int().positive().default(900),
  DRY_RUN_SYNC: z.string().optional(),
  VERIFY_SHARED_SECRET: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  MAX_SYNC_JOBS_PER_CRON: z.coerce.number().int().positive().default(3),
  MAX_USERS_PER_SYNC: z.coerce.number().int().positive().default(500),
  RPC_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  BOOTSTRAP_GATES_JSON: z.string().optional(),
  KV_KEY_PREFIX: z.string().optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info")
});

type BootstrapGate = {
  guildId: string;
  gateId: string;
  daoId?: string;
  passRoleId: string;
  failAction?: FailAction;
  enabled?: boolean;
};

function parseBool(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function parseBootstrapGates(raw: string | undefined): BootstrapGate[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const out: BootstrapGate[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const rec = item as Record<string, unknown>;
      const guildId = typeof rec.guildId === "string" ? rec.guildId : undefined;
      const gateId = typeof rec.gateId === "string" ? rec.gateId : undefined;
      const daoId = typeof rec.daoId === "string" ? rec.daoId : undefined;
      const passRoleId = typeof rec.passRoleId === "string" ? rec.passRoleId : undefined;
      if (!guildId || !gateId || !passRoleId) {
        continue;
      }

      out.push({
        guildId,
        gateId,
        daoId,
        passRoleId,
        failAction: rec.failAction === "remove_role" ? "remove_role" : "none",
        enabled: typeof rec.enabled === "boolean" ? rec.enabled : true
      });
    }

    return out;
  } catch {
    return [];
  }
}

const env = envSchema.parse(process.env);
const discordAppId = env.DISCORD_APP_ID ?? env.DISCORD_CLIENT_ID;
const discordBotToken = env.DISCORD_BOT_TOKEN ?? env.DISCORD_TOKEN;

if (!discordAppId) {
  throw new Error("Set DISCORD_APP_ID (or DISCORD_CLIENT_ID)");
}

if (!discordBotToken) {
  throw new Error("Set DISCORD_BOT_TOKEN (or DISCORD_TOKEN)");
}

if (!env.DISCORD_PUBLIC_KEY) {
  throw new Error("Set DISCORD_PUBLIC_KEY");
}

export const config = {
  discordAppId,
  discordBotToken,
  discordPublicKey: env.DISCORD_PUBLIC_KEY,
  discordCommandGuildId: env.DISCORD_COMMAND_GUILD_ID,
  rpcEndpoint: env.RPC_ENDPOINT,
  cluster: env.CLUSTER,
  checkMode: env.CHECK_MODE,
  onchainCheckerKeypairPath: env.ONCHAIN_CHECKER_KEYPAIR_PATH,
  accessFrontendBaseUrl: env.ACCESS_FRONTEND_BASE_URL,
  defaultRecheckIntervalSec: env.DEFAULT_RECHECK_INTERVAL_SEC,
  dryRunSync: parseBool(env.DRY_RUN_SYNC),
  verifySharedSecret: env.VERIFY_SHARED_SECRET,
  cronSecret: env.CRON_SECRET,
  maxSyncJobsPerCron: env.MAX_SYNC_JOBS_PER_CRON,
  maxUsersPerSync: env.MAX_USERS_PER_SYNC,
  rpcRequestTimeoutMs: env.RPC_REQUEST_TIMEOUT_MS,
  bootstrapGates: parseBootstrapGates(env.BOOTSTRAP_GATES_JSON),
  kvKeyPrefix: env.KV_KEY_PREFIX ?? "grape-access-discord-bot:v1",
  logLevel: env.LOG_LEVEL,
  programs: {
    access: "GPASSzQQF1H8cdj5pUwFkeYEE4VdMQtCrYtUaMXvPz48",
    verification: "VrFyyRxPoyWxpABpBXU4YUCCF9p8giDSJUv2oXfDr5q",
    reputation: "V1NE6WCWJPRiVFq5DtaN8p87M9DmmUd2zQuVbvLgQwX"
  }
} as const;
