import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  BotSettings,
  CheckResultRow,
  FailAction,
  GuildGateMap,
  LatestUserWalletLink,
  UserWalletLink
} from "./types.js";

export class BotDatabase {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guild_gate_map (
        guild_id TEXT NOT NULL,
        gate_id TEXT NOT NULL,
        pass_role_id TEXT NOT NULL,
        fail_action TEXT NOT NULL DEFAULT 'none',
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, gate_id)
      );

      CREATE TABLE IF NOT EXISTS user_wallet_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_user_id TEXT NOT NULL,
        wallet_pubkey TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'verification',
        UNIQUE (discord_user_id, wallet_pubkey, guild_id, verified_at)
      );

      CREATE INDEX IF NOT EXISTS idx_user_wallet_links_lookup
      ON user_wallet_links (guild_id, discord_user_id, verified_at DESC);

      CREATE TABLE IF NOT EXISTS check_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_user_id TEXT,
        wallet_pubkey TEXT NOT NULL,
        gate_id TEXT NOT NULL,
        passed INTEGER NOT NULL,
        checked_at TEXT NOT NULL,
        source TEXT NOT NULL,
        proof TEXT,
        reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_check_results_gate_time
      ON check_results (gate_id, checked_at DESC);

      CREATE TABLE IF NOT EXISTS bot_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        recheck_interval_sec INTEGER NOT NULL,
        rpc_endpoint TEXT NOT NULL,
        cluster TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  upsertGuildGateMap(params: {
    guildId: string;
    gateId: string;
    passRoleId: string;
    failAction: FailAction;
    enabled: boolean;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO guild_gate_map (guild_id, gate_id, pass_role_id, fail_action, enabled, updated_at)
      VALUES (@guildId, @gateId, @passRoleId, @failAction, @enabled, @updatedAt)
      ON CONFLICT (guild_id, gate_id) DO UPDATE SET
        pass_role_id = excluded.pass_role_id,
        fail_action = excluded.fail_action,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `);

    stmt.run({
      guildId: params.guildId,
      gateId: params.gateId,
      passRoleId: params.passRoleId,
      failAction: params.failAction,
      enabled: params.enabled ? 1 : 0,
      updatedAt: new Date().toISOString()
    });
  }

  getGuildGateMap(guildId: string, gateId: string): GuildGateMap | undefined {
    const stmt = this.db.prepare(`
      SELECT guild_id, gate_id, pass_role_id, fail_action, enabled, updated_at
      FROM guild_gate_map
      WHERE guild_id = ? AND gate_id = ?
      LIMIT 1
    `);
    return stmt.get(guildId, gateId) as unknown as GuildGateMap | undefined;
  }

  listEnabledGateMaps(guildId?: string): GuildGateMap[] {
    if (guildId) {
      const stmt = this.db.prepare(`
        SELECT guild_id, gate_id, pass_role_id, fail_action, enabled, updated_at
        FROM guild_gate_map
        WHERE enabled = 1 AND guild_id = ?
      `);
      return stmt.all(guildId) as unknown as GuildGateMap[];
    }

    const stmt = this.db.prepare(`
      SELECT guild_id, gate_id, pass_role_id, fail_action, enabled, updated_at
      FROM guild_gate_map
      WHERE enabled = 1
    `);
    return stmt.all() as unknown as GuildGateMap[];
  }

  addWalletLink(params: {
    discordUserId: string;
    walletPubkey: string;
    guildId: string;
    verifiedAt?: string;
    source?: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO user_wallet_links (discord_user_id, wallet_pubkey, guild_id, verified_at, source)
      VALUES (@discordUserId, @walletPubkey, @guildId, @verifiedAt, @source)
    `);

    stmt.run({
      discordUserId: params.discordUserId,
      walletPubkey: params.walletPubkey,
      guildId: params.guildId,
      verifiedAt: params.verifiedAt ?? new Date().toISOString(),
      source: params.source ?? "verification"
    });
  }

  getLatestWalletLink(discordUserId: string, guildId: string): UserWalletLink | undefined {
    const stmt = this.db.prepare(`
      SELECT id, discord_user_id, wallet_pubkey, guild_id, verified_at, source
      FROM user_wallet_links
      WHERE discord_user_id = ? AND guild_id = ?
      ORDER BY datetime(verified_at) DESC
      LIMIT 1
    `);
    return stmt.get(discordUserId, guildId) as unknown as UserWalletLink | undefined;
  }

  listLatestWalletLinksForGuild(guildId: string): LatestUserWalletLink[] {
    const stmt = this.db.prepare(`
      SELECT discord_user_id, wallet_pubkey, guild_id, verified_at
      FROM (
        SELECT
          discord_user_id,
          wallet_pubkey,
          guild_id,
          verified_at,
          ROW_NUMBER() OVER (
            PARTITION BY discord_user_id
            ORDER BY datetime(verified_at) DESC
          ) AS rn
        FROM user_wallet_links
        WHERE guild_id = ?
      ) ranked
      WHERE rn = 1
    `);
    return stmt.all(guildId) as unknown as LatestUserWalletLink[];
  }

  insertCheckResult(params: {
    discordUserId?: string;
    walletPubkey: string;
    gateId: string;
    passed: boolean;
    source: string;
    proof?: Record<string, unknown>;
    reason?: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO check_results
      (discord_user_id, wallet_pubkey, gate_id, passed, checked_at, source, proof, reason)
      VALUES (@discordUserId, @walletPubkey, @gateId, @passed, @checkedAt, @source, @proof, @reason)
    `);

    stmt.run({
      discordUserId: params.discordUserId ?? null,
      walletPubkey: params.walletPubkey,
      gateId: params.gateId,
      passed: params.passed ? 1 : 0,
      checkedAt: new Date().toISOString(),
      source: params.source,
      proof: params.proof ? JSON.stringify(params.proof) : null,
      reason: params.reason ?? null
    });
  }

  listRecentCheckResults(gateId: string, limit = 20): CheckResultRow[] {
    const stmt = this.db.prepare(`
      SELECT id, discord_user_id, wallet_pubkey, gate_id, passed, checked_at, source, proof, reason
      FROM check_results
      WHERE gate_id = ?
      ORDER BY datetime(checked_at) DESC
      LIMIT ?
    `);
    return stmt.all(gateId, limit) as unknown as CheckResultRow[];
  }

  upsertBotSettings(params: {
    recheckIntervalSec: number;
    rpcEndpoint: string;
    cluster: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO bot_settings (id, recheck_interval_sec, rpc_endpoint, cluster, updated_at)
      VALUES (1, @recheckIntervalSec, @rpcEndpoint, @cluster, @updatedAt)
      ON CONFLICT (id) DO UPDATE SET
        recheck_interval_sec = excluded.recheck_interval_sec,
        rpc_endpoint = excluded.rpc_endpoint,
        cluster = excluded.cluster,
        updated_at = excluded.updated_at
    `);

    stmt.run({
      recheckIntervalSec: params.recheckIntervalSec,
      rpcEndpoint: params.rpcEndpoint,
      cluster: params.cluster,
      updatedAt: new Date().toISOString()
    });
  }

  getBotSettings(): BotSettings | undefined {
    const stmt = this.db.prepare(`
      SELECT id, recheck_interval_sec, rpc_endpoint, cluster, updated_at
      FROM bot_settings
      WHERE id = 1
      LIMIT 1
    `);
    return stmt.get() as unknown as BotSettings | undefined;
  }
}
