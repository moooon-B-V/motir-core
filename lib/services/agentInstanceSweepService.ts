import type { AgentInstance } from '@/generated/prisma/client';
import {
  INSTANCE_IDLE_WINDOW_MS,
  INSTANCE_INTERVAL_BACKSTOP_MS,
} from '@/lib/agentInstances/config';
import { checkAgentRunCredits } from '@/lib/ai/motirAiClient';
import { isCloudBilling } from '@/lib/billing/availability';
import { getPersistentOrchestrator, isPersistentOrchestratorConfigured } from '@/lib/orchestrator';
import { agentInstanceIntervalRepository } from '@/lib/repositories/agentInstanceIntervalRepository';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { agentInstanceChargeService } from '@/lib/services/agentInstanceChargeService';
import { agentInstanceLapseService } from '@/lib/services/agentInstanceLapseService';
import {
  agentInstanceClock,
  agentInstanceLifecycleService as lifecycle,
  readUnlimitedAgentOrg,
} from '@/lib/services/agentInstanceLifecycleService';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// THE AGENT-INSTANCE SWEEP (Story MOTIR-6860 · MOTIR-6873;
// `docs/decisions/agent-instances.md` §2, §5, §6) — what keeps instances honest
// when nobody is looking: an idle instance hibernates, a running interval never
// outlives the 12-hour backstop, an organisation the credit pre-flight now
// refuses stops running, a machine that stopped or vanished behind Motir's back
// is reconciled and its interval charged, an orphan volume is destroyed (an
// orphan MACHINE is the attribution reconciler's, MOTIR-6925), and every
// closed interval is charged exactly once.
//
// ⚠️ TWO CLOCKS, AND THE DECISION'S "EVERY 5 MINUTES" IS THE ONE THAT MOVED.
// §2 names a 5-minute sweep. The job substrate refuses any cron off the
// clustered minutes `0` and `30` (`lib/jobs/schedules.ts`,
// `tests/jobs/schedule-cluster.test.ts` — the database suspends when idle, and
// every tick is a guaranteed wake), and says a finer cadence is a decision to
// bring back to `application-hosting.md` §21, not a minute to pick. So:
//   * the IDLE TIMER is per instance and event-driven — the debounced
//     `agent-instance/idle-check` job ({@link checkIdle}), armed when an instance
//     starts running and re-armed on every activity bump. It fires once the
//     instance has been quiet for the 30-minute window — MORE precise than a
//     5-minute poll, and it wakes nothing while no instance exists;
//   * THIS SWEEP runs every 5 minutes (`*/5 * * * *` since MOTIR-6932, which
//     retired the cluster above) for everything that is not latency-critical:
//     reconcile, orphans, the credit refusal, the charge backstop, and a catch
//     for an idle timer that was lost.
// The 12-hour backstop is enforced by the idle timer's debounce cap AND by this
// sweep; the fleet slot's TTL was sized to the old 30-minute cadence, so at 5
// minutes it is a looser upper bound than it needs to be, never a short one.
//
// ⚠️ THE RUNNING CHARGE, AND WHY THE RUNNING PASS IS TWO LOOPS (AMENDMENT 2). The
// credit pre-flight only asks "is the balance above zero?", and a machine used to
// be charged only when it stopped — up to 12 hours later — so a running agent's
// own minutes never lowered the balance a credit check read, and an organisation
// with one credit could run a machine all day. Now every pass first CHARGES each
// running machine for the whole minutes it has used ({@link
// agentInstanceLifecycleService.rollInterval}), and only THEN asks each
// organisation for credits, so the check reads a balance every running agent has
// already paid into. An organisation that has run out stops within one pass: the
// overdraft is bounded by the sweep's 30 minutes, not by the backstop's 12 hours.

/** A volume younger than this is never an orphan — its create may be in flight. */
const ORPHAN_MIN_AGE_MS = 15 * 60 * 1000;

/** How many rows one pass reads per state — a sweep is bounded, the next one continues. */
const SWEEP_BATCH = 200;

export interface AgentInstanceSweepSummary {
  settled: number;
  reconciled: number;
  /** Running machines charged for their minutes so far without stopping (AMENDMENT 2). */
  rolled: number;
  hibernated: { idle: number; backstop: number; credits: number };
  /** Orphan volumes destroyed. Orphan MACHINES are the attribution reconciler's (MOTIR-6925). */
  orphans: { volumes: number };
  charges: { charged: number; notCharged: number; refused: number; retryable: number };
  errors: number;
}

function isIdle(row: AgentInstance, now: Date): boolean {
  return now.getTime() - row.lastActivityAt.getTime() >= INSTANCE_IDLE_WINDOW_MS;
}

/** When the instance's current machine RUN began — not its open interval, which
 *  the running charge restarts every pass (AMENDMENT 2). */
async function runStart(row: AgentInstance): Promise<Date | null> {
  const open = await withWorkspaceServiceContext(row.workspaceId, (tx) =>
    agentInstanceIntervalRepository.findOpen(row.id, tx),
  );
  return open?.runStartedAt ?? null;
}

async function pastBackstop(row: AgentInstance, now: Date): Promise<boolean> {
  const startedAt = await runStart(row);
  return startedAt !== null && now.getTime() - startedAt.getTime() >= INSTANCE_INTERVAL_BACKSTOP_MS;
}

export const agentInstanceSweepService = {
  /**
   * THE IDLE TIMER'S HANDLER — one instance. Hibernates it (`idle`) when it has
   * been quiet for the window, or (`backstop`) when its interval has reached 12
   * hours; otherwise does nothing (a later activity re-arms the timer).
   */
  async checkIdle(instanceId: string): Promise<'idle' | 'backstop' | 'active' | 'noop'> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row || row.deletedAt || row.state !== 'running') return 'noop';
    const now = agentInstanceClock.now();
    if (await pastBackstop(row, now)) {
      return (await lifecycle.beginHibernate(row.id, 'backstop')) ? 'backstop' : 'noop';
    }
    if (isIdle(row, now)) {
      return (await lifecycle.beginHibernate(row.id, 'idle')) ? 'idle' : 'noop';
    }
    return 'active';
  },

  /**
   * The plan-lapse pass (MOTIR-6921, `agent-instance-storage.md` §4): send every
   * deletion notice still owed, then delete each agent whose date has passed —
   * through the lifecycle's ordinary delete, so its machine, its volume and its
   * final interval's charge are handled as an owner's delete handles them. Never
   * before the date; never an agent of Motir's own organisations (§5). Never
   * throws for one instance's failure — it counts it.
   */
  async sweepPlanLapse(): Promise<{ noticed: number; deleted: number; errors: number }> {
    const result = { noticed: 0, deleted: 0, errors: 0 };
    result.noticed = await agentInstanceLapseService.sendPendingNotices();
    const due = await agentInstanceLapseService.listDue(agentInstanceClock.now());
    for (const row of due) {
      try {
        if (await lifecycle.beginDelete(row.id)) result.deleted += 1;
      } catch (err) {
        result.errors += 1;
        console.error('[agentInstanceSweep] a plan-lapse deletion failed', {
          instanceId: row.id,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return result;
  },

  /** One pass of the sweep. Never throws for one instance's failure — it counts it. */
  async sweep(): Promise<AgentInstanceSweepSummary> {
    const summary: AgentInstanceSweepSummary = {
      settled: 0,
      reconciled: 0,
      rolled: 0,
      hibernated: { idle: 0, backstop: 0, credits: 0 },
      orphans: { volumes: 0 },
      charges: { charged: 0, notCharged: 0, refused: 0, retryable: 0 },
      errors: 0,
    };
    const guarded = async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        summary.errors += 1;
        console.error('[agentInstanceSweep] one step failed', {
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    };

    if (isPersistentOrchestratorConfigured()) {
      // 1 · Anything in motion: finish what an earlier request left pending.
      const moving = await withSystemContext((tx) =>
        agentInstanceRepository.listLiveInStates(
          ['starting', 'waking', 'hibernating', 'deleting'],
          SWEEP_BATCH,
          tx,
        ),
      );
      for (const row of moving) {
        await guarded(async () => {
          const result =
            row.state === 'hibernating'
              ? await lifecycle.settleStop(row.id, 'hibernated')
              : row.state === 'deleting'
                ? await lifecycle.settleDelete(row.id)
                : await lifecycle.settleBoot(row.id);
          if (result !== 'pending' && result !== 'noop') summary.settled += 1;
        });
      }

      // 2a · Every running instance: reconcile it against its machine, then charge
      //      the minutes it has used so far — BEFORE any credit check below.
      const running = await withSystemContext((tx) =>
        agentInstanceRepository.listLiveInStates(['running'], SWEEP_BATCH, tx),
      );
      const stillRunning: AgentInstance[] = [];
      for (const row of running) {
        await guarded(async () => {
          const reconciled = await lifecycle.reconcileRunning(row.id);
          if (reconciled === 'hibernated' || reconciled === 'failed') {
            summary.reconciled += 1;
            return;
          }
          if ((await lifecycle.rollInterval(row.id)) === 'rolled') summary.rolled += 1;
          stillRunning.push(row);
        });
      }

      // 2b · Then the three reasons to hibernate it: the backstop, credits, idle.
      //     Motir's own organisations (`isMeta` / `internalBilling`) are never
      //     hibernated for credits (AMENDMENT 3): read once per org per pass.
      const creditsByOrg = new Map<string, boolean>();
      const unlimitedByOrg = new Map<string, boolean>();
      const now = agentInstanceClock.now();
      for (const row of stillRunning) {
        await guarded(async () => {
          if (await pastBackstop(row, now)) {
            if (await lifecycle.beginHibernate(row.id, 'backstop'))
              summary.hibernated.backstop += 1;
            return;
          }
          let unlimited = unlimitedByOrg.get(row.organizationId);
          if (unlimited === undefined && isCloudBilling()) {
            unlimited = await readUnlimitedAgentOrg(row.organizationId);
            unlimitedByOrg.set(row.organizationId, unlimited);
          }
          if (isCloudBilling() && !unlimited) {
            let mayRun = creditsByOrg.get(row.organizationId);
            if (mayRun === undefined) {
              // "Could not ask" is not a refusal here: stopping a person's machine
              // needs a definite NO, so an unanswerable pre-flight keeps it running.
              mayRun = (await checkAgentRunCredits(row.organizationId))?.mayRun ?? true;
              creditsByOrg.set(row.organizationId, mayRun);
            }
            if (!mayRun) {
              if (await lifecycle.beginHibernate(row.id, 'credits'))
                summary.hibernated.credits += 1;
              return;
            }
          }
          if (isIdle(row, now)) {
            if (await lifecycle.beginHibernate(row.id, 'idle')) summary.hibernated.idle += 1;
          }
        });
      }

      // 3 · Orphan VOLUMES: a volume in an instance app no live record owns.
      //     The MACHINE half moved to the attribution reconciler
      //     (`fleetAttributionService`, MOTIR-6925 — `fleet-per-org-pool.md` §6),
      //     so one rule, in one place, raises one alert for every machine Fly runs.
      const apps = await withSystemContext((tx) => agentInstanceRepository.listDistinctApps(tx));
      const orchestrator = getPersistentOrchestrator();
      for (const app of apps) {
        await guarded(async () => {
          const owners = await withSystemContext((tx) =>
            agentInstanceRepository.listLiveInApp(app, tx),
          );
          const volumeIds = new Set(owners.flatMap((o) => (o.volumeId ? [o.volumeId] : [])));
          const inventory = await orchestrator.listPersistent(app);
          const old = (at: Date | null) =>
            at !== null && now.getTime() - at.getTime() >= ORPHAN_MIN_AGE_MS;
          // A volume still attached waits for the next pass: Fly refuses a volume
          // delete while its machine exists, and the reconciler destroys an
          // orphan machine on its own schedule.
          for (const volume of inventory.volumes) {
            if (volumeIds.has(volume.volumeId) || volume.attachedMachineId) continue;
            if (!old(volume.createdAt)) continue;
            await orchestrator.destroyVolume(app, volume.volumeId);
            console.warn('[agentInstanceSweep] destroyed an orphan instance volume', {
              app,
              volumeId: volume.volumeId,
            });
            summary.orphans.volumes += 1;
          }
        });
      }
    }

    // 4 · The charge backstop: every closed interval still pending, once more.
    const pending = await withSystemContext((tx) =>
      agentInstanceIntervalRepository.listPendingCharges(SWEEP_BATCH, tx),
    );
    for (const interval of pending) {
      await guarded(async () => {
        const result = await agentInstanceChargeService.chargeInterval(interval.id);
        if (result.outcome === 'charged') summary.charges.charged += 1;
        else if (result.outcome === 'not_charged') summary.charges.notCharged += 1;
        else if (result.outcome === 'refused') summary.charges.refused += 1;
        else if (result.outcome === 'retryable') summary.charges.retryable += 1;
      });
    }
    return summary;
  },
};
