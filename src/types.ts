export type FailAction = "none" | "remove_role";

export type CheckSource = "simulate" | "onchain_write";

export interface GateMapping {
  guildId: string;
  gateId: string;
  passRoleId: string;
  failAction: FailAction;
  enabled: boolean;
  updatedAt: string;
}

export interface WalletLink {
  discordUserId: string;
  walletPubkey: string;
  guildId: string;
  verifiedAt: string;
  source: string;
}

export interface LatestWalletLink {
  discordUserId: string;
  walletPubkey: string;
  guildId: string;
  verifiedAt: string;
}

export interface CheckResult {
  discordUserId?: string;
  guildId?: string;
  walletPubkey: string;
  gateId: string;
  passed: boolean;
  checkedAt: string;
  source: string;
  proof?: Record<string, unknown>;
  reason?: string;
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

export interface SyncJob {
  id: string;
  guildId: string;
  gateId: string;
  requestedBy: string;
  dryRun: boolean;
  createdAt: string;
}
