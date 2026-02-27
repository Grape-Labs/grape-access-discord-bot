import { config } from "./config.js";
import { CheckResult, FailAction, GateMapping, LatestWalletLink, SyncJob, WalletLink } from "./types.js";

type InMemoryState = {
  gateMappings: Map<string, GateMapping>;
  walletLinks: WalletLink[];
  checkResults: CheckResult[];
  syncJobs: SyncJob[];
  lastGateRunMs: Map<string, number>;
};

declare global {
  // eslint-disable-next-line no-var
  var __grapeAccessBotState__: InMemoryState | undefined;
}

function key(guildId: string, gateId: string): string {
  return `${guildId}:${gateId}`;
}

function getState(): InMemoryState {
  if (!globalThis.__grapeAccessBotState__) {
    const gateMappings = new Map<string, GateMapping>();

    for (const item of config.bootstrapGates) {
      gateMappings.set(key(item.guildId, item.gateId), {
        guildId: item.guildId,
        gateId: item.gateId,
        daoId: item.daoId,
        passRoleId: item.passRoleId,
        failAction: item.failAction ?? "none",
        enabled: item.enabled ?? true,
        updatedAt: new Date().toISOString()
      });
    }

    globalThis.__grapeAccessBotState__ = {
      gateMappings,
      walletLinks: [],
      checkResults: [],
      syncJobs: [],
      lastGateRunMs: new Map<string, number>()
    };
  }

  return globalThis.__grapeAccessBotState__;
}

export class InMemoryStore {
  private readonly state = getState();

  upsertGateMapping(params: {
    guildId: string;
    gateId: string;
    daoId?: string;
    passRoleId: string;
    failAction: FailAction;
    enabled: boolean;
  }): void {
    this.state.gateMappings.set(key(params.guildId, params.gateId), {
      guildId: params.guildId,
      gateId: params.gateId,
      daoId: params.daoId,
      passRoleId: params.passRoleId,
      failAction: params.failAction,
      enabled: params.enabled,
      updatedAt: new Date().toISOString()
    });
  }

  getGateMapping(guildId: string, gateId: string): GateMapping | undefined {
    return this.state.gateMappings.get(key(guildId, gateId));
  }

  listEnabledGateMappings(guildId?: string): GateMapping[] {
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

  addWalletLink(link: {
    discordUserId: string;
    walletPubkey: string;
    guildId: string;
    verifiedAt?: string;
    source?: string;
  }): void {
    this.state.walletLinks.push({
      discordUserId: link.discordUserId,
      walletPubkey: link.walletPubkey,
      guildId: link.guildId,
      verifiedAt: link.verifiedAt ?? new Date().toISOString(),
      source: link.source ?? "verification"
    });

    if (this.state.walletLinks.length > 20_000) {
      this.state.walletLinks.splice(0, this.state.walletLinks.length - 20_000);
    }
  }

  getLatestWalletLink(discordUserId: string, guildId: string): WalletLink | undefined {
    let latest: WalletLink | undefined;

    for (const link of this.state.walletLinks) {
      if (link.discordUserId !== discordUserId || link.guildId !== guildId) {
        continue;
      }

      if (!latest || Date.parse(link.verifiedAt) > Date.parse(latest.verifiedAt)) {
        latest = link;
      }
    }

    return latest;
  }

  listLatestWalletLinksForGuild(guildId: string): LatestWalletLink[] {
    const latestByUser = new Map<string, WalletLink>();

    for (const link of this.state.walletLinks) {
      if (link.guildId !== guildId) {
        continue;
      }

      const prev = latestByUser.get(link.discordUserId);
      if (!prev || Date.parse(link.verifiedAt) > Date.parse(prev.verifiedAt)) {
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

  addCheckResult(result: Omit<CheckResult, "checkedAt">): void {
    this.state.checkResults.push({
      ...result,
      checkedAt: new Date().toISOString()
    });

    if (this.state.checkResults.length > 50_000) {
      this.state.checkResults.splice(0, this.state.checkResults.length - 50_000);
    }
  }

  getLastWorkerRunMs(guildId: string, gateId: string): number {
    return this.state.lastGateRunMs.get(key(guildId, gateId)) ?? 0;
  }

  setLastWorkerRunMs(guildId: string, gateId: string, tsMs: number): void {
    this.state.lastGateRunMs.set(key(guildId, gateId), tsMs);
  }

  enqueueSyncJob(job: Omit<SyncJob, "id" | "createdAt">): SyncJob {
    const created: SyncJob = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      guildId: job.guildId,
      gateId: job.gateId,
      requestedBy: job.requestedBy,
      dryRun: job.dryRun,
      createdAt: new Date().toISOString()
    };

    this.state.syncJobs.push(created);
    return created;
  }

  drainSyncJobs(limit: number): SyncJob[] {
    const out = this.state.syncJobs.slice(0, limit);
    this.state.syncJobs = this.state.syncJobs.slice(limit);
    return out;
  }
}
