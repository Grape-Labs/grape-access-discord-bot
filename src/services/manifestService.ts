import { AccessClient } from "./accessClient.js";
import { AccessManifestHints } from "../types.js";

interface CachedManifest {
  fetchedAt: number;
  hints: AccessManifestHints;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseFailAction(value: unknown): "none" | "remove_role" | undefined {
  if (value === "none" || value === "remove_role") {
    return value;
  }
  return undefined;
}

function parseHints(raw: unknown): AccessManifestHints {
  const rec = asRecord(raw);
  if (!rec) {
    return { schemaValid: false };
  }

  const schemaValue = rec.schema ?? rec.kind ?? rec.type ?? rec.spec;
  const schemaValid = schemaValue === "grape.access-manifest.v1";

  if (!schemaValid) {
    return { schemaValid: false };
  }

  const integrations = asRecord(rec.integrations);
  const discord = asRecord(integrations?.discord);
  const revalidation = asRecord(rec.revalidation);

  return {
    schemaValid: true,
    daoId: typeof rec.daoId === "string" ? rec.daoId : undefined,
    integrations: {
      discord: {
        guildId: typeof discord?.guildId === "string" ? discord.guildId : undefined,
        passRoleId: typeof discord?.passRoleId === "string" ? discord.passRoleId : undefined,
        failAction: parseFailAction(discord?.failAction)
      }
    },
    revalidation: {
      intervalSeconds:
        typeof revalidation?.intervalSeconds === "number"
          ? revalidation.intervalSeconds
          : undefined
    }
  };
}

export class ManifestService {
  private readonly accessClient: AccessClient;
  private readonly cache = new Map<string, CachedManifest>();
  private readonly ttlMs = 5 * 60 * 1000;

  constructor(accessClient: AccessClient) {
    this.accessClient = accessClient;
  }

  async getHints(gateId: string): Promise<AccessManifestHints> {
    const now = Date.now();
    const cached = this.cache.get(gateId);
    if (cached && now - cached.fetchedAt < this.ttlMs) {
      return cached.hints;
    }

    try {
      const metadataUri = await this.accessClient.getGateMetadataUri(gateId);
      if (!metadataUri) {
        const hints = { schemaValid: false };
        this.cache.set(gateId, { fetchedAt: now, hints });
        return hints;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(metadataUri, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        const hints = { schemaValid: false };
        this.cache.set(gateId, { fetchedAt: now, hints });
        return hints;
      }

      const raw = (await response.json()) as unknown;
      const hints = parseHints(raw);
      this.cache.set(gateId, { fetchedAt: now, hints });
      return hints;
    } catch {
      const hints = { schemaValid: false };
      this.cache.set(gateId, { fetchedAt: now, hints });
      return hints;
    }
  }
}
