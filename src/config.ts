import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1).optional(),
  DATABASE_PATH: z.string().default("./data/bot.sqlite"),
  RPC_ENDPOINT: z.string().url(),
  CLUSTER: z.enum(["mainnet-beta", "devnet", "testnet"]).default("mainnet-beta"),
  CHECK_MODE: z.enum(["simulate", "write"]).default("simulate"),
  ONCHAIN_CHECKER_KEYPAIR_PATH: z.string().optional(),
  ACCESS_FRONTEND_BASE_URL: z.string().url(),
  DEFAULT_RECHECK_INTERVAL_SEC: z.coerce.number().int().positive().default(900),
  DRY_RUN_SYNC: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  CALLBACK_PORT: z.coerce.number().int().positive().default(8787),
  VERIFY_SHARED_SECRET: z.string().optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info")
});

const env = envSchema.parse(process.env);

export const config = {
  discordToken: env.DISCORD_TOKEN,
  discordClientId: env.DISCORD_CLIENT_ID,
  discordGuildId: env.DISCORD_GUILD_ID,
  databasePath: env.DATABASE_PATH,
  rpcEndpoint: env.RPC_ENDPOINT,
  cluster: env.CLUSTER,
  checkMode: env.CHECK_MODE,
  onchainCheckerKeypairPath: env.ONCHAIN_CHECKER_KEYPAIR_PATH,
  accessFrontendBaseUrl: env.ACCESS_FRONTEND_BASE_URL,
  defaultRecheckIntervalSec: env.DEFAULT_RECHECK_INTERVAL_SEC,
  dryRunSync: env.DRY_RUN_SYNC ?? false,
  callbackPort: env.CALLBACK_PORT,
  verifySharedSecret: env.VERIFY_SHARED_SECRET,
  logLevel: env.LOG_LEVEL,
  programs: {
    access: "GPASSzQQF1H8cdj5pUwFkeYEE4VdMQtCrYtUaMXvPz48",
    verification: "VrFyyRxPoyWxpABpBXU4YUCCF9p8giDSJUv2oXfDr5q",
    reputation: "V1NE6WCWJPRiVFq5DtaN8p87M9DmmUd2zQuVbvLgQwX"
  }
} as const;
