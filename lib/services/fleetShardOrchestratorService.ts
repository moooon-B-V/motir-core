import type { CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import {
  getOrchestrator,
  orchestratorForShard,
  type ContainerOrchestrator,
} from '@/lib/orchestrator';
import { fleetShardService } from '@/lib/services/fleetShardService';

// WHICH ORCHESTRATOR a CI-runner container is reached through (Story MOTIR-8953 ·
// MOTIR-8964) — the one seam every container path (boot, poll, settle, stop,
// reap, the volume sweep) resolves through.
//
// `null` is a first-class account: "the process-wide fleet". It is what every
// intent and memoised session from before accounts existed resolves to, what
// every non-CI workload keeps using, and what a fleet kind whose switch is Fly
// boots on. Production stays exactly as it was until a row is written AND
// `chooseBootShard` answers it.

interface CachedOrchestrator {
  updatedAt: string;
  orchestrator: ContainerOrchestrator;
}

/** Per process, keyed on the account id and rebuilt when its row changes, so a
 *  rotated credential or a moved app is picked up without a deploy. */
const cache = new Map<string, CachedOrchestrator>();

export const fleetShardOrchestratorService = {
  /** The orchestrator for an account row. */
  forShardRow(shard: FleetShardDTO): ContainerOrchestrator {
    const cached = cache.get(shard.id);
    if (cached && cached.updatedAt === shard.updatedAt) return cached.orchestrator;
    const orchestrator = orchestratorForShard(shard);
    cache.set(shard.id, { updatedAt: shard.updatedAt, orchestrator });
    return orchestrator;
  },

  /** The orchestrator for an account id — `null` is the process-wide fleet. An
   *  account is reached whatever its state: a `disabled` one still has
   *  containers to poll, settle and reap. */
  async forShard(shardId: string | null): Promise<ContainerOrchestrator> {
    if (shardId === null) return getOrchestrator();
    return this.forShardRow(await fleetShardService.getShard(shardId));
  },

  /** The orchestrator for the account an intent's container was booted in. */
  async forIntent(
    intent: Pick<CiRunnerProvisioningIntent, 'fleetShardId'>,
  ): Promise<ContainerOrchestrator> {
    return this.forShard(intent.fleetShardId);
  },

  /**
   * Which account a NEW boot goes to. `null` = the process-wide fleet, today's
   * only answer. Admission (MOTIR-8968) replaces this body with the per-job
   * choice, and keeps its contract: it NEVER answers a `disabled` or
   * `provisioning` account.
   */
  async chooseBootShard(
    _intent: Pick<CiRunnerProvisioningIntent, 'id' | 'organizationId'>,
  ): Promise<FleetShardDTO | null> {
    return null;
  },

  /** Forget every cached account orchestrator — for tests. */
  resetCache(): void {
    cache.clear();
  },
};
