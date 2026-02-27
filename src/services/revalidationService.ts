import { config } from "../config.js";
import { logger } from "../logger.js";
import { InMemoryStore } from "../store.js";
import { GateSyncService } from "./gateSyncService.js";
import { ManifestService } from "./manifestService.js";

export class RevalidationService {
  constructor(
    private readonly store: InMemoryStore,
    private readonly gateSyncService: GateSyncService,
    private readonly manifestService: ManifestService
  ) {}

  async runOnce(): Promise<{ processed: number; errors: number }> {
    const now = Date.now();
    const gateMaps = this.store.listEnabledGateMappings();

    let processed = 0;
    let errors = 0;

    for (const gateMap of gateMaps) {
      const hints = await this.manifestService.getHints(gateMap.gateId);
      const gateIntervalSec = hints.revalidation?.intervalSeconds ?? config.defaultRecheckIntervalSec;
      const lastRun = this.store.getLastWorkerRunMs(gateMap.guildId, gateMap.gateId);

      if (now - lastRun < gateIntervalSec * 1000) {
        continue;
      }

      this.store.setLastWorkerRunMs(gateMap.guildId, gateMap.gateId, now);

      try {
        const summary = await this.gateSyncService.syncGate(gateMap, {
          trigger: "cron",
          sourceLabel: "worker"
        });

        processed += 1;
        logger.info(
          {
            guild_id: gateMap.guildId,
            gate_id: gateMap.gateId,
            summary
          },
          "Cron revalidation summary"
        );
      } catch (err) {
        errors += 1;
        logger.error(
          {
            guild_id: gateMap.guildId,
            gate_id: gateMap.gateId,
            reason: String(err)
          },
          "Cron revalidation failed"
        );
      }
    }

    return { processed, errors };
  }
}
