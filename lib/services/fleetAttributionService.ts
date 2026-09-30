import type { FleetInventory, InventoryMachine } from '@motir/orchestrator';
import { getFleetInventory } from '@/lib/orchestrator';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  ciRunnerProvisioningIntentRepository as intents,
  CI_RUNNER_INTENT_IN_FLIGHT,
} from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { ciContainerUsageRepository } from '@/lib/repositories/ciContainerUsageRepository';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { fleetMachineKillRepository } from '@/lib/repositories/fleetMachineKillRepository';
import { ciRunnerBootService, FLEET_TIME_BUDGETS } from '@/lib/services/ciRunnerBootService';
import { indexSlotRef } from '@/lib/services/codeGraphIndexAdmissionService';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import type { FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import {
  FleetInventoryUnavailableError,
  UnattributedMachineDestroyedError,
  type AttributionKillReason,
} from '@/lib/ciFleet/attributionErrors';
import { alertFleetAttribution } from '@/lib/monitoring/fleetAttributionAlert';

// EVERY MACHINE BELONGS TO A PAYING ORG, OR IT DIES (Story MOTIR-6906 ·
// MOTIR-6925) — `docs/decisions/fleet-per-org-pool.md` §5 is the record.
//
// Credits bound what an ATTRIBUTED machine costs. The one way Motir can pay for a
// machine nobody is charged for is a machine that belongs to nobody — a crashed
// boot, a failed teardown, a record that was never written, a machine started by
// hand — and neither credits nor anything that reads Motir's own tables can see
// one. So this pass starts from the PROVIDER:
//
//   1. every app in the fleet organisation, then every machine in each, tagged or
//      not (`FleetInventory`);
//   2. each machine matched to a live record of its workload — a CI intent in
//      flight, a hosted-agent or index checkpoint still holding an unexpired
//      slot, a non-deleted agent instance. Metadata is never attribution: anyone
//      holding the token can write it;
//   3. a machine nothing attributes, or whose record says it should have
//      stopped, is killed once it is past the GRACE — recorded first, then
//      destroyed (an agent instance's persistent machine is STOPPED instead), and
//      one Sentry issue raised per machine.
//
// ⚠️ A LISTING ERROR IS NEVER "NOTHING IS RUNNING". A failed app list ends the
// pass and destroys nothing anywhere; a failed machine list skips that one app.
// Both alert. A machine the provider lists without a creation instant cannot be
// aged, so it is alerted and left alone rather than destroyed on a guess.
//
// ⚠️ IT DOES NOT RE-CHECK PLAN OR BALANCE (§5). Refusing work for money is
// admission's job and the zero-stop's; two killers for one reason would race.
// `org_stopped` is read off the record the stop already wrote — a CI intent
// settled `credits_exhausted` or `admin_stop` — never re-derived here.

/** How long a machine may exist before its record names it — or run on after its
 *  record ended — before it is killed (§5: three times the longest legitimate
 *  create-then-record window, the hosted run's 210 s). */
export const FLEET_ATTRIBUTION_GRACE_MS = 10 * 60_000;

/** A CI intent's own end: boot + the job timeout + 10 minutes. What the old
 *  reaper's age cutoff became (§6) — a property of the RECORD, not of the machine. */
export const CI_INTENT_END_AFTER_BOOT_MS = FLEET_TIME_BUDGETS.reapAfterMs;

/** The teardown reasons the org stop writes (`fleetStopService`, MOTIR-6908). */
const ORG_STOP_REASONS: ReadonlySet<string> = new Set(['credits_exhausted', 'admin_stop']);

const CI_RUNNER: FleetWorkloadKind = 'ci_runner';
const HOSTED_AGENT: FleetWorkloadKind = 'hosted_agent';
const CODE_GRAPH_INDEX: FleetWorkloadKind = 'code_graph_index';
const AGENT_INSTANCE: FleetWorkloadKind = 'agent_instance';

/** What the matcher concluded about one machine. */
type Verdict =
  | { kind: 'attributed'; workload: FleetWorkloadKind }
  | {
      kind: 'kill';
      reason: AttributionKillReason;
      /** When the record ended; null for a machine no record ever named, which is
       *  aged from its own creation instead. */
      endedAt: Date | null;
      workload: FleetWorkloadKind | null;
      recordRef: string | null;
      organizationId: string | null;
      action: 'destroyed' | 'stopped';
      /** The record still has a container to settle — tear it down through the
       *  port so the usage row is written and the run or intent ends. */
      settle: boolean;
    };

/** One machine the pass killed. */
export interface FleetKill {
  app: string;
  machineId: string;
  reason: AttributionKillReason;
  action: 'destroyed' | 'stopped';
  workload: FleetWorkloadKind | null;
}

export type FleetAttributionResult =
  /** No fleet on this deployment — nothing to inventory. */
  | { outcome: 'disabled' }
  /** The app list failed: NOTHING was destroyed anywhere. */
  | { outcome: 'inventory_unavailable'; detail: string }
  | {
      outcome: 'reconciled';
      apps: number;
      /** Machines the provider listed that still exist. */
      listed: number;
      /** Attributed to a live record — left running. */
      matched: number;
      /** Unattributed or ended, but still inside the grace. */
      spared: number;
      /** Listed with no creation instant — alerted, not destroyed. */
      undated: number;
      killed: FleetKill[];
      /** Apps whose machine list failed — skipped, alerted. */
      unavailableApps: string[];
      /** Kills the provider refused, and machines the matcher could not judge —
       *  each alerted or logged, retried next pass. */
      failures: number;
    };

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

function kill(
  reason: AttributionKillReason,
  endedAt: Date | null,
  rest: Partial<Omit<Extract<Verdict, { kind: 'kill' }>, 'kind' | 'reason' | 'endedAt'>> = {},
): Verdict {
  return {
    kind: 'kill',
    reason,
    endedAt,
    workload: rest.workload ?? null,
    recordRef: rest.recordRef ?? null,
    organizationId: rest.organizationId ?? null,
    action: rest.action ?? 'destroyed',
    settle: rest.settle ?? false,
  };
}

export const fleetAttributionService = {
  /**
   * One pass over the whole fleet organisation. Never throws: every failure is a
   * counted, alerted finding, and the pass reaches every other app and machine.
   */
  async reconcile(
    options: { now?: () => Date; inventory?: FleetInventory | null } = {},
  ): Promise<FleetAttributionResult> {
    const inventory = options.inventory === undefined ? getFleetInventory() : options.inventory;
    if (!inventory) return { outcome: 'disabled' };
    const now = options.now ?? (() => new Date());

    let apps: string[];
    try {
      apps = await inventory.listApps();
    } catch (err) {
      alertFleetAttribution(
        new FleetInventoryUnavailableError('the fleet organization', detailOf(err)),
      );
      return { outcome: 'inventory_unavailable', detail: detailOf(err) };
    }

    const result = {
      outcome: 'reconciled' as const,
      apps: apps.length,
      listed: 0,
      matched: 0,
      spared: 0,
      undated: 0,
      killed: [] as FleetKill[],
      unavailableApps: [] as string[],
      failures: 0,
    };

    for (const app of apps) {
      let machines: InventoryMachine[];
      try {
        machines = await inventory.listMachines(app);
      } catch (err) {
        result.unavailableApps.push(app);
        alertFleetAttribution(new FleetInventoryUnavailableError(app, detailOf(err)));
        continue;
      }

      for (const machine of machines) {
        if (machine.state === 'gone') continue;
        result.listed += 1;
        if (!machine.createdAt) {
          result.undated += 1;
          alertFleetAttribution(
            new FleetInventoryUnavailableError(
              app,
              `machine ${machine.machineId} has no creation instant, so it cannot be aged`,
            ),
          );
          continue;
        }

        let verdict: Verdict;
        try {
          verdict = await this.judge(inventory.provider, machine, now());
        } catch (err) {
          // Could not read the records: never a reason to destroy.
          result.failures += 1;
          console.error('[fleetAttribution] could not judge a machine — left running', {
            app,
            machineId: machine.machineId,
            detail: detailOf(err),
          });
          continue;
        }
        if (verdict.kind === 'attributed') {
          result.matched += 1;
          continue;
        }

        // The grace runs from the later of the machine's creation and its
        // record's end, so the pass never races a boot or an ordinary teardown.
        const since = Math.max(machine.createdAt.getTime(), verdict.endedAt?.getTime() ?? 0);
        if (now().getTime() - since < FLEET_ATTRIBUTION_GRACE_MS) {
          result.spared += 1;
          continue;
        }

        const dated = { ...machine, createdAt: machine.createdAt };
        const done = await this.killMachine(inventory, dated, verdict, now);
        if (done) {
          result.killed.push({
            app,
            machineId: machine.machineId,
            reason: verdict.reason,
            action: verdict.action,
            workload: verdict.workload,
          });
        } else {
          result.failures += 1;
        }
      }
    }
    return result;
  },

  /** Match ONE machine against the records (§5's table). Reads only. */
  async judge(provider: string, machine: InventoryMachine, now: Date): Promise<Verdict> {
    // ── CI runner: an intent names it as its container ──────────────────────
    const intent = await withSystemContext((tx) =>
      intents.findByContainerId(provider, machine.machineId, tx),
    );
    if (intent) {
      const inFlight = CI_RUNNER_INTENT_IN_FLIGHT.includes(intent.status);
      const end = intent.bootedAt
        ? new Date(intent.bootedAt.getTime() + CI_INTENT_END_AFTER_BOOT_MS)
        : null;
      if (inFlight && (!end || now.getTime() < end.getTime())) {
        return { kind: 'attributed', workload: CI_RUNNER };
      }
      const stopped = intent.teardownReason !== null && ORG_STOP_REASONS.has(intent.teardownReason);
      return kill(
        stopped ? 'org_stopped' : 'record_ended',
        inFlight ? end : (intent.settledAt ?? intent.updatedAt),
        {
          workload: CI_RUNNER,
          recordRef: intent.id,
          organizationId: intent.organizationId,
          // An intent still in flight past its end has a container to settle.
          settle: inFlight,
        },
      );
    }

    // ── Hosted-agent run or index container: a checkpoint + an unexpired slot ──
    const usage = await withSystemContext((tx) =>
      ciContainerUsageRepository.findLatestByHandle(provider, machine.machineId, tx),
    );
    if (usage && (usage.workload === 'agent' || usage.workload === 'index')) {
      const workload = usage.workload === 'agent' ? HOSTED_AGENT : CODE_GRAPH_INDEX;
      const recordRef = usage.dispatchRunId ?? usage.id;
      if (usage.containerStoppedAt) {
        return kill('record_ended', usage.containerStoppedAt, {
          workload,
          recordRef,
          organizationId: usage.organizationId,
        });
      }
      const ref =
        workload === HOSTED_AGENT
          ? usage.dispatchRunId
            ? hostedRunDispatchId(usage.dispatchRunId)
            : null
          : usage.projectId && usage.repoFullName
            ? indexSlotRef(usage.projectId, usage.repoFullName)
            : null;
      const slot = ref
        ? await withSystemContext((tx) => fleetInFlightSlotRepository.findByRef(workload, ref, tx))
        : null;
      if (slot && slot.expiresAt.getTime() > now.getTime()) {
        return { kind: 'attributed', workload };
      }
      // The slot expired (its backstop) or is gone: the record has ended. With no
      // slot left to date it by, the checkpoint's own creation is the floor.
      return kill('record_ended', slot?.expiresAt ?? usage.containerCreatedAt, {
        workload,
        recordRef,
        organizationId: usage.organizationId,
        // A hosted run is settled, charged and ended through the port (MOTIR-6524).
        settle: workload === HOSTED_AGENT,
      });
    }

    // ── Agent instance: a record in THIS app names it as its machine ────────
    const instance = await withSystemContext((tx) =>
      agentInstanceRepository.findByMachine(machine.app, machine.machineId, tx),
    );
    if (instance) {
      const common = {
        workload: AGENT_INSTANCE,
        recordRef: instance.id,
        organizationId: instance.organizationId,
      };
      if (instance.deletedAt) return kill('record_ended', instance.deletedAt, common);
      // A resting record whose machine runs: STOPPED, never destroyed — the
      // record owns a persistent machine and its home volume (§5).
      const resting = instance.state === 'hibernated' || instance.state === 'failed';
      const running = machine.state === 'running' || machine.state === 'starting';
      if (resting && running) {
        return kill('record_ended', instance.stateChangedAt, { ...common, action: 'stopped' });
      }
      return { kind: 'attributed', workload: AGENT_INSTANCE };
    }

    return kill('no_record', null);
  },

  /**
   * Kill ONE machine: record the decision, act on it, alert. Answers whether the
   * provider carried it out; a refusal is recorded on the row, alerted, and left
   * for the next pass to decide again.
   */
  async killMachine(
    inventory: FleetInventory,
    machine: InventoryMachine & { createdAt: Date },
    verdict: Extract<Verdict, { kind: 'kill' }>,
    now: () => Date,
  ): Promise<boolean> {
    const decidedAt = now();
    const ageMs = decidedAt.getTime() - machine.createdAt.getTime();
    const row = await withSystemContext((tx) =>
      fleetMachineKillRepository.create(
        {
          app: machine.app,
          machineId: machine.machineId,
          machineName: machine.name,
          reason: verdict.reason,
          action: verdict.action,
          workload: verdict.workload,
          recordRef: verdict.recordRef,
          organizationId: verdict.organizationId,
          machineCreatedAt: machine.createdAt,
          ageSeconds: Math.floor(ageMs / 1000),
          decidedAt,
        },
        tx,
      ),
    );

    try {
      if (verdict.action === 'stopped') {
        await inventory.stopMachine(machine.app, machine.machineId);
      } else {
        // A record with a container to settle is torn down THROUGH the port, so
        // its usage row is written and its intent or run ends. The inventory's
        // own destroy follows either way: it is idempotent, and it is the one
        // call addressed to the app the machine was actually listed in.
        if (verdict.settle) {
          await ciRunnerBootService.reapContainer(
            {
              provider: inventory.provider,
              id: machine.machineId,
              region: machine.region,
              createdAt: machine.createdAt,
            },
            { now },
          );
        }
        await inventory.destroyMachine(machine.app, machine.machineId);
      }
    } catch (err) {
      const detail = detailOf(err);
      await withSystemContext((tx) => fleetMachineKillRepository.markFailed(row.id, detail, tx));
      alertFleetAttribution(
        new FleetInventoryUnavailableError(
          machine.app,
          `could not ${verdict.action === 'stopped' ? 'stop' : 'destroy'} machine ` +
            `${machine.machineId}: ${detail}`,
        ),
      );
      return false;
    }

    await withSystemContext((tx) => fleetMachineKillRepository.markCompleted(row.id, now(), tx));
    console.warn('[fleetAttribution] killed a machine', {
      app: machine.app,
      machineId: machine.machineId,
      reason: verdict.reason,
      action: verdict.action,
      workload: verdict.workload,
      recordRef: verdict.recordRef,
    });
    alertFleetAttribution(
      new UnattributedMachineDestroyedError(
        machine.app,
        machine.machineId,
        machine.name,
        ageMs,
        verdict.reason,
        verdict.action,
      ),
    );
    return true;
  },
};
