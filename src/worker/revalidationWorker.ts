import { BotDatabase } from "../database.js";
import { GateSyncService } from "../services/gateSyncService.js";
import { ManifestService } from "../services/manifestService.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

export class RevalidationWorker {
  private timer: NodeJS.Timeout | null = null;
  private readonly lastGateRunMs = new Map<string, number>();
  private running = false;

  constructor(
    private readonly db: BotDatabase,
    private readonly gateSyncService: GateSyncService,
    private readonly manifestService: ManifestService
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, 30_000);

    void this.tick();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      const now = Date.now();
      const settings = this.db.getBotSettings();
      const dbIntervalSec =
        settings?.recheck_interval_sec && settings.recheck_interval_sec > 0
          ? settings.recheck_interval_sec
          : undefined;

      const gateMaps = this.db.listEnabledGateMaps();

      for (const gateMap of gateMaps) {
        const hints = await this.manifestService.getHints(gateMap.gate_id);
        const gateIntervalSec =
          dbIntervalSec ?? hints.revalidation?.intervalSeconds ?? config.defaultRecheckIntervalSec;
        const key = `${gateMap.guild_id}:${gateMap.gate_id}`;
        const lastRun = this.lastGateRunMs.get(key) ?? 0;

        if (now - lastRun < gateIntervalSec * 1000) {
          continue;
        }

        this.lastGateRunMs.set(key, now);

        try {
          const summary = await this.gateSyncService.syncGate(gateMap, {
            trigger: "worker",
            sourceLabel: "worker"
          });

          logger.info(
            {
              guild_id: gateMap.guild_id,
              gate_id: gateMap.gate_id,
              summary
            },
            "Worker sync summary"
          );
        } catch (err) {
          logger.error(
            {
              guild_id: gateMap.guild_id,
              gate_id: gateMap.gate_id,
              reason: String(err)
            },
            "Worker sync failed"
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}
