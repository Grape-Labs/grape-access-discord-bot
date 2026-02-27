export type FailAction = "none" | "remove_role";

export type CheckSource = "simulate" | "onchain_write";

export interface GuildGateMap {
  guild_id: string;
  gate_id: string;
  pass_role_id: string;
  fail_action: FailAction;
  enabled: number;
  updated_at: string;
}

export interface UserWalletLink {
  id: number;
  discord_user_id: string;
  wallet_pubkey: string;
  guild_id: string;
  verified_at: string;
  source: string;
}

export interface LatestUserWalletLink {
  discord_user_id: string;
  wallet_pubkey: string;
  guild_id: string;
  verified_at: string;
}

export interface CheckResultRow {
  id: number;
  discord_user_id: string | null;
  wallet_pubkey: string;
  gate_id: string;
  passed: number;
  checked_at: string;
  source: string;
  proof: string | null;
  reason: string | null;
}

export interface BotSettings {
  id: number;
  recheck_interval_sec: number;
  rpc_endpoint: string;
  cluster: string;
  updated_at: string;
}

export interface AccessCheckResult {
  passed: boolean;
  source: CheckSource;
  proof?: Record<string, unknown>;
  reason?: string;
}

export interface AccessManifestHints {
  schemaValid: boolean;
  daoId?: string;
  integrations?: {
    discord?: {
      guildId?: string;
      passRoleId?: string;
      failAction?: FailAction;
    };
  };
  revalidation?: {
    intervalSeconds?: number;
  };
}
