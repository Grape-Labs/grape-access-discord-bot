import type { VercelRequest, VercelResponse } from "@vercel/node";
import { config } from "../../src/config.js";
import { logger } from "../../src/logger.js";
import { InMemoryStore } from "../../src/store.js";
import { AccessClient } from "../../src/services/accessClient.js";
import { ManifestService } from "../../src/services/manifestService.js";
import { GateSyncService } from "../../src/services/gateSyncService.js";
import { DiscordRestClient } from "../../src/services/discordRestClient.js";
import { RevalidationService } from "../../src/services/revalidationService.js";

function isAuthorized(req: VercelRequest): boolean {
  if (!config.cronSecret) {
    return true;
  }

  const auth = req.headers.authorization;
  return auth === `Bearer ${config.cronSecret}`;
}

const store = new InMemoryStore();
const accessClient = new AccessClient();
const manifestService = new ManifestService(accessClient);
const discordClient = new DiscordRestClient();
const gateSyncService = new GateSyncService(store, accessClient, manifestService, discordClient);
const revalidationService = new RevalidationService(store, gateSyncService, manifestService);

export default async function revalidate(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  if (!isAuthorized(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const jobs = store.drainSyncJobs(config.maxSyncJobsPerCron);
  const jobResults: Array<Record<string, unknown>> = [];

  for (const job of jobs) {
    const gateMap = store.getGateMapping(job.guildId, job.gateId);
    if (!gateMap || !gateMap.enabled) {
      jobResults.push({
        jobId: job.id,
        gateId: job.gateId,
        guildId: job.guildId,
        status: "skipped",
        reason: "mapping_not_found"
      });
      continue;
    }

    try {
      const summary = await gateSyncService.syncGate(gateMap, {
        trigger: "command",
        sourceLabel: "sync_job",
        dryRun: job.dryRun
      });

      jobResults.push({
        jobId: job.id,
        gateId: job.gateId,
        guildId: job.guildId,
        status: "ok",
        summary
      });
    } catch (err) {
      jobResults.push({
        jobId: job.id,
        gateId: job.gateId,
        guildId: job.guildId,
        status: "error",
        reason: String(err)
      });
    }
  }

  const revalidation = await revalidationService.runOnce();

  logger.info(
    {
      processed_jobs: jobResults.length,
      revalidation
    },
    "Cron run complete"
  );

  res.status(200).json({
    ok: true,
    jobsProcessed: jobResults.length,
    jobResults,
    revalidation
  });
}
