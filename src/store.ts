import { kv } from "@vercel/kv";
import { config } from "./config.js";
import {
  CheckResult,
  FailAction,
  GateMapping,
  IdentityOverride,
  LatestWalletLink,
  SyncJob,
  WalletLink
} from "./types.js";

type InMemoryState = {
  gateMappings: Map<string, GateMapping>;
  identityOverrides: Map<string, IdentityOverride>;
  walletLinks: WalletLink[];
  checkResults: CheckResult[];
  syncJobs: SyncJob[];
  lastGateRunMs: Map<string, number>;
};

declare global {
  // eslint-disable-next-line no-var
  var __grapeAccessBotState__: InMemoryState | undefined;
}

function gateMapMemKey(guildId: string, gateId: string): string {
  return `${guildId}:${gateId}`;
}

function identityOverrideMemKey(guildId: string, gateId: string, discordUserId: string): string {
  return `${guildId}:${gateId}:${discordUserId}`;
}

function getMemoryState(): InMemoryState {
  if (!globalThis.__grapeAccessBotState__) {
    globalThis.__grapeAccessBotState__ = {
      gateMappings: new Map<string, GateMapping>(),
      identityOverrides: new Map<string, IdentityOverride>(),
      walletLinks: [],
      checkResults: [],
      syncJobs: [],
      lastGateRunMs: new Map<string, number>()
    };
  }

  if (!globalThis.__grapeAccessBotState__.identityOverrides) {
    globalThis.__grapeAccessBotState__.identityOverrides = new Map<string, IdentityOverride>();
  }

  return globalThis.__grapeAccessBotState__;
}

function gateIndexMember(guildId: string, gateId: string): string {
  return JSON.stringify([guildId, gateId]);
}

function parseGateIndexMember(raw: unknown): { guildId: string; gateId: string } | undefined {
  if (Array.isArray(raw) && raw.length === 2) {
    const [guildId, gateId] = raw;
    if (typeof guildId === "string" && typeof gateId === "string") {
      return { guildId, gateId };
    }
  }

  if (typeof raw !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) {
      return undefined;
    }

    const [guildId, gateId] = parsed;
    if (typeof guildId !== "string" || typeof gateId !== "string") {
      return undefined;
    }

    return { guildId, gateId };
  } catch {
    return undefined;
  }
}

function parseDiscordUserId(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.length > 0) {
    return raw;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  return undefined;
}

function newerOrEqual(a: string, b: string): boolean {
  const aTs = Date.parse(a);
  const bTs = Date.parse(b);

  if (Number.isNaN(aTs)) {
    return false;
  }

  if (Number.isNaN(bTs)) {
    return true;
  }

  return aTs >= bTs;
}

function parseJob(raw: unknown): SyncJob | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const rec = raw as Record<string, unknown>;
  if (
    typeof rec.id !== "string" ||
    typeof rec.guildId !== "string" ||
    typeof rec.gateId !== "string" ||
    typeof rec.requestedBy !== "string" ||
    typeof rec.dryRun !== "boolean" ||
    typeof rec.createdAt !== "string"
  ) {
    return undefined;
  }

  return {
    id: rec.id,
    guildId: rec.guildId,
    gateId: rec.gateId,
    requestedBy: rec.requestedBy,
    dryRun: rec.dryRun,
    createdAt: rec.createdAt
  };
}

export class InMemoryStore {
  private readonly state = getMemoryState();
  private readonly useKv: boolean;
  private readonly missingKvEnvVars: string[];
  private readonly keyPrefix: string;
  private bootstrapPromise?: Promise<void>;

  constructor() {
    const hasKvUrl = Boolean(process.env.KV_REST_API_URL);
    const hasKvWriteToken = Boolean(process.env.KV_REST_API_TOKEN);
    this.missingKvEnvVars = [];
    if (!hasKvUrl) {
      this.missingKvEnvVars.push("KV_REST_API_URL");
    }
    if (!hasKvWriteToken) {
      this.missingKvEnvVars.push("KV_REST_API_TOKEN");
    }
    this.useKv = hasKvUrl && hasKvWriteToken;
    this.keyPrefix = config.kvKeyPrefix;
  }

  isKvEnabled(): boolean {
    return this.useKv;
  }

  getStorageMode(): "kv" | "memory" {
    return this.useKv ? "kv" : "memory";
  }

  getMissingKvEnvVars(): string[] {
    return this.missingKvEnvVars.slice();
  }

  private withPrefix(...parts: string[]): string {
    return [this.keyPrefix, ...parts].join(":");
  }

  private gateMapKey(guildId: string, gateId: string): string {
    return this.withPrefix("gate", guildId, gateId);
  }

  private identityOverrideKey(guildId: string, gateId: string, discordUserId: string): string {
    return this.withPrefix("identity-override", guildId, gateId, discordUserId);
  }

  private gateIndexKey(): string {
    return this.withPrefix("index", "gates");
  }

  private guildUsersKey(guildId: string): string {
    return this.withPrefix("index", "guild-users", guildId);
  }

  private walletLatestKey(guildId: string, discordUserId: string): string {
    return this.withPrefix("wallet", "latest", guildId, discordUserId);
  }

  private checkResultsKey(): string {
    return this.withPrefix("check-results");
  }

  private syncJobsKey(): string {
    return this.withPrefix("queue", "sync-jobs");
  }

  private lastRunKey(guildId: string, gateId: string): string {
    return this.withPrefix("last-run", guildId, gateId);
  }

  private async ensureBootstrapped(): Promise<void> {
    if (this.bootstrapPromise) {
      await this.bootstrapPromise;
      return;
    }

    this.bootstrapPromise = this.bootstrap();
    await this.bootstrapPromise;
  }

  private async bootstrap(): Promise<void> {
    if (config.bootstrapGates.length === 0) {
      return;
    }

    const now = new Date().toISOString();

    if (this.useKv) {
      for (const item of config.bootstrapGates) {
        const key = this.gateMapKey(item.guildId, item.gateId);
        const existing = await kv.get<GateMapping>(key);
        if (existing) {
          await kv.sadd(this.gateIndexKey(), gateIndexMember(item.guildId, item.gateId));
          continue;
        }

        const mapping: GateMapping = {
          guildId: item.guildId,
          gateId: item.gateId,
          verificationDaoId: item.verificationDaoId,
          reputationDaoId: item.reputationDaoId,
          daoId: item.daoId,
          passRoleId: item.passRoleId,
          failAction: item.failAction ?? "none",
          enabled: item.enabled ?? true,
          updatedAt: now
        };

        await kv.set(key, mapping);
        await kv.sadd(this.gateIndexKey(), gateIndexMember(item.guildId, item.gateId));
      }
      return;
    }

    for (const item of config.bootstrapGates) {
      const memKey = gateMapMemKey(item.guildId, item.gateId);
      if (this.state.gateMappings.has(memKey)) {
        continue;
      }

      this.state.gateMappings.set(memKey, {
        guildId: item.guildId,
        gateId: item.gateId,
        verificationDaoId: item.verificationDaoId,
        reputationDaoId: item.reputationDaoId,
        daoId: item.daoId,
        passRoleId: item.passRoleId,
        failAction: item.failAction ?? "none",
        enabled: item.enabled ?? true,
        updatedAt: now
      });
    }
  }

  async upsertGateMapping(params: {
    guildId: string;
    gateId: string;
    verificationDaoId?: string;
    reputationDaoId?: string;
    daoId?: string;
    passRoleId: string;
    failAction: FailAction;
    enabled: boolean;
  }): Promise<void> {
    await this.ensureBootstrapped();

    const mapping: GateMapping = {
      guildId: params.guildId,
      gateId: params.gateId,
      verificationDaoId: params.verificationDaoId,
      reputationDaoId: params.reputationDaoId,
      daoId: params.daoId,
      passRoleId: params.passRoleId,
      failAction: params.failAction,
      enabled: params.enabled,
      updatedAt: new Date().toISOString()
    };

    if (this.useKv) {
      await kv.set(this.gateMapKey(params.guildId, params.gateId), mapping);
      await kv.sadd(this.gateIndexKey(), gateIndexMember(params.guildId, params.gateId));
      return;
    }

    this.state.gateMappings.set(gateMapMemKey(params.guildId, params.gateId), mapping);
  }

  async getGateMapping(guildId: string, gateId: string): Promise<GateMapping | undefined> {
    await this.ensureBootstrapped();

    if (this.useKv) {
      return (await kv.get<GateMapping>(this.gateMapKey(guildId, gateId))) ?? undefined;
    }

    return this.state.gateMappings.get(gateMapMemKey(guildId, gateId));
  }

  async listEnabledGateMappings(guildId?: string): Promise<GateMapping[]> {
    await this.ensureBootstrapped();

    if (this.useKv) {
      const members = await kv.smembers<unknown[]>(this.gateIndexKey());
      if (!Array.isArray(members) || members.length === 0) {
        return [];
      }

      const gateKeys = members
        .map((raw) => parseGateIndexMember(raw))
        .filter((item): item is { guildId: string; gateId: string } => Boolean(item))
        .filter((item) => !guildId || item.guildId === guildId)
        .map((item) => this.gateMapKey(item.guildId, item.gateId));

      if (gateKeys.length === 0) {
        return [];
      }

      const maps = await kv.mget<GateMapping[]>(...gateKeys);
      return maps.filter((item): item is GateMapping => Boolean(item && item.enabled));
    }

    const out: GateMapping[] = [];

    for (const map of this.state.gateMappings.values()) {
      if (!map.enabled) {
        continue;
      }
      if (guildId && map.guildId !== guildId) {
        continue;
      }
      out.push(map);
    }

    return out;
  }

  async upsertIdentityOverride(params: {
    guildId: string;
    gateId: string;
    discordUserId: string;
    identityAccount: string;
    linkAccount?: string;
    source?: string;
  }): Promise<IdentityOverride> {
    await this.ensureBootstrapped();

    const override: IdentityOverride = {
      guildId: params.guildId,
      gateId: params.gateId,
      discordUserId: params.discordUserId,
      identityAccount: params.identityAccount,
      linkAccount: params.linkAccount,
      source: params.source ?? "manual",
      updatedAt: new Date().toISOString()
    };

    if (this.useKv) {
      await kv.set(this.identityOverrideKey(params.guildId, params.gateId, params.discordUserId), override);
      return override;
    }

    this.state.identityOverrides.set(
      identityOverrideMemKey(params.guildId, params.gateId, params.discordUserId),
      override
    );
    return override;
  }

  async getIdentityOverride(
    guildId: string,
    gateId: string,
    discordUserId: string
  ): Promise<IdentityOverride | undefined> {
    await this.ensureBootstrapped();

    if (this.useKv) {
      return (
        (await kv.get<IdentityOverride>(this.identityOverrideKey(guildId, gateId, discordUserId))) ?? undefined
      );
    }

    return this.state.identityOverrides.get(identityOverrideMemKey(guildId, gateId, discordUserId));
  }

  async deleteIdentityOverridesForUser(guildId: string, discordUserId: string): Promise<number> {
    await this.ensureBootstrapped();

    if (this.useKv) {
      const pattern = this.withPrefix("identity-override", guildId, "*", discordUserId);
      const keys: string[] = [];
      let cursor = "0";

      do {
        const [next, batch] = await kv.scan(cursor, { match: pattern, count: 1000 });
        cursor = String(next);
        for (const key of batch) {
          if (typeof key === "string") {
            keys.push(key);
          }
        }
      } while (cursor !== "0");

      if (keys.length > 0) {
        await kv.del(...keys);
      }
      return keys.length;
    }

    let removed = 0;
    for (const key of Array.from(this.state.identityOverrides.keys())) {
      const [kGuildId, _kGateId, kDiscordUserId] = key.split(":");
      if (kGuildId === guildId && kDiscordUserId === discordUserId) {
        this.state.identityOverrides.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async deleteLatestWalletLink(discordUserId: string, guildId: string): Promise<boolean> {
    await this.ensureBootstrapped();

    if (this.useKv) {
      const key = this.walletLatestKey(guildId, discordUserId);
      const existing = await kv.get<WalletLink>(key);
      if (!existing) {
        return false;
      }
      await kv.del(key);
      return true;
    }

    let hadLatest = false;
    for (const link of this.state.walletLinks) {
      if (link.discordUserId === discordUserId && link.guildId === guildId) {
        hadLatest = true;
        break;
      }
    }

    this.state.walletLinks = this.state.walletLinks.filter(
      (link) => !(link.discordUserId === discordUserId && link.guildId === guildId)
    );

    return hadLatest;
  }

  async addWalletLink(link: {
    discordUserId: string;
    walletPubkey: string;
    guildId: string;
    verifiedAt?: string;
    source?: string;
  }): Promise<void> {
    await this.ensureBootstrapped();

    const toWrite: WalletLink = {
      discordUserId: link.discordUserId,
      walletPubkey: link.walletPubkey,
      guildId: link.guildId,
      verifiedAt: link.verifiedAt ?? new Date().toISOString(),
      source: link.source ?? "verification"
    };

    if (this.useKv) {
      const key = this.walletLatestKey(link.guildId, link.discordUserId);
      const existing = await kv.get<WalletLink>(key);

      if (!existing || newerOrEqual(toWrite.verifiedAt, existing.verifiedAt)) {
        await kv.set(key, toWrite);
      }

      await kv.sadd(this.guildUsersKey(link.guildId), link.discordUserId);
      return;
    }

    this.state.walletLinks.push(toWrite);

    if (this.state.walletLinks.length > 20_000) {
      this.state.walletLinks.splice(0, this.state.walletLinks.length - 20_000);
    }
  }

  async getLatestWalletLink(discordUserId: string, guildId: string): Promise<WalletLink | undefined> {
    await this.ensureBootstrapped();

    if (this.useKv) {
      return (await kv.get<WalletLink>(this.walletLatestKey(guildId, discordUserId))) ?? undefined;
    }

    let latest: WalletLink | undefined;

    for (const link of this.state.walletLinks) {
      if (link.discordUserId !== discordUserId || link.guildId !== guildId) {
        continue;
      }

      if (!latest || newerOrEqual(link.verifiedAt, latest.verifiedAt)) {
        latest = link;
      }
    }

    return latest;
  }

  async listLatestWalletLinksForGuild(guildId: string): Promise<LatestWalletLink[]> {
    await this.ensureBootstrapped();

    if (this.useKv) {
      const userIdsRaw = await kv.smembers<unknown[]>(this.guildUsersKey(guildId));
      if (!Array.isArray(userIdsRaw) || userIdsRaw.length === 0) {
        return [];
      }

      const userIds = userIdsRaw
        .map((item) => parseDiscordUserId(item))
        .filter((item): item is string => Boolean(item));
      if (userIds.length === 0) {
        return [];
      }

      const keys = userIds.map((discordUserId) => this.walletLatestKey(guildId, discordUserId));
      const links = await kv.mget<WalletLink[]>(...keys);

      return links
        .filter((link): link is WalletLink => Boolean(link))
        .map((link) => ({
          discordUserId: link.discordUserId,
          walletPubkey: link.walletPubkey,
          guildId: link.guildId,
          verifiedAt: link.verifiedAt
        }));
    }

    const latestByUser = new Map<string, WalletLink>();

    for (const link of this.state.walletLinks) {
      if (link.guildId !== guildId) {
        continue;
      }

      const prev = latestByUser.get(link.discordUserId);
      if (!prev || newerOrEqual(link.verifiedAt, prev.verifiedAt)) {
        latestByUser.set(link.discordUserId, link);
      }
    }

    return Array.from(latestByUser.values()).map((link) => ({
      discordUserId: link.discordUserId,
      walletPubkey: link.walletPubkey,
      guildId: link.guildId,
      verifiedAt: link.verifiedAt
    }));
  }

  async addCheckResult(result: Omit<CheckResult, "checkedAt">): Promise<void> {
    await this.ensureBootstrapped();

    const withTimestamp: CheckResult = {
      ...result,
      checkedAt: new Date().toISOString()
    };

    if (this.useKv) {
      await kv.lpush(this.checkResultsKey(), JSON.stringify(withTimestamp));
      await kv.ltrim(this.checkResultsKey(), 0, 49_999);
      return;
    }

    this.state.checkResults.push(withTimestamp);

    if (this.state.checkResults.length > 50_000) {
      this.state.checkResults.splice(0, this.state.checkResults.length - 50_000);
    }
  }

  async getLastWorkerRunMs(guildId: string, gateId: string): Promise<number> {
    await this.ensureBootstrapped();

    if (this.useKv) {
      const raw = await kv.get<number | string>(this.lastRunKey(guildId, gateId));
      if (typeof raw === "number") {
        return raw;
      }
      if (typeof raw === "string") {
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : 0;
      }
      return 0;
    }

    return this.state.lastGateRunMs.get(gateMapMemKey(guildId, gateId)) ?? 0;
  }

  async setLastWorkerRunMs(guildId: string, gateId: string, tsMs: number): Promise<void> {
    await this.ensureBootstrapped();

    if (this.useKv) {
      await kv.set(this.lastRunKey(guildId, gateId), tsMs);
      return;
    }

    this.state.lastGateRunMs.set(gateMapMemKey(guildId, gateId), tsMs);
  }

  async enqueueSyncJob(job: Omit<SyncJob, "id" | "createdAt">): Promise<SyncJob> {
    await this.ensureBootstrapped();

    const created: SyncJob = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      guildId: job.guildId,
      gateId: job.gateId,
      requestedBy: job.requestedBy,
      dryRun: job.dryRun,
      createdAt: new Date().toISOString()
    };

    if (this.useKv) {
      await kv.rpush(this.syncJobsKey(), JSON.stringify(created));
      return created;
    }

    this.state.syncJobs.push(created);
    return created;
  }

  async drainSyncJobs(limit: number): Promise<SyncJob[]> {
    await this.ensureBootstrapped();

    if (this.useKv) {
      const out: SyncJob[] = [];

      for (let i = 0; i < limit; i += 1) {
        const raw = await kv.lpop<SyncJob | string>(this.syncJobsKey());
        if (!raw) {
          break;
        }

        if (typeof raw === "string") {
          try {
            const parsed = JSON.parse(raw) as unknown;
            const job = parseJob(parsed);
            if (job) {
              out.push(job);
            }
          } catch {
            // ignore malformed entry
          }
          continue;
        }

        const parsed = parseJob(raw);
        if (parsed) {
          out.push(parsed);
        }
      }

      return out;
    }

    const out = this.state.syncJobs.slice(0, limit);
    this.state.syncJobs = this.state.syncJobs.slice(limit);
    return out;
  }
}
