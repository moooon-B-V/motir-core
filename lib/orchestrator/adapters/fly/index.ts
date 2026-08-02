import {
  flyFleetConfig,
  flyMachinesClient,
  isTerminalState,
  startedAtOf,
  stoppedAtOf,
  type FlyMachine,
} from './flyMachines';
import { buildContainerUsage } from '../../usage';
import type {
  ContainerHandle,
  ContainerOrchestrator,
  ContainerSpec,
  ContainerStatus,
  ContainerUsage,
  TeardownReason,
  UsageAttribution,
  UsageAttributionResolver,
} from '../../types';

// The FLY adapter (Story MOTIR-1916 · MOTIR-1921) — `ContainerOrchestrator`
// implemented on Fly Machines, per `docs/decisions/ci-runner-fleet.md` §1.
//
// It is thin ON PURPOSE. Every decision that is not "how do you say this to Fly"
// lives above it: the rate table, the usage arithmetic, the supervision loop, the
// JIT credential. What remains here is translation, and that is the measure of
// whether the port is real — an adapter thick with policy is a port in name only,
// and §3's migration target (B1 · RunsOn) would have to re-implement the policy
// rather than just the translation.

/** The tag every fleet machine carries, and the reaper's recognition key.
 *  Metadata rather than a name convention: a name can be typed by hand in the
 *  Fly console, metadata is what Motir's own code writes. */
export const FLEET_METADATA_KEY = 'motir_fleet';
export const FLEET_METADATA_VALUE = 'ci-runner';

/** Machine metadata naming the intent a container serves, so the reaper can
 *  resolve attribution from the PROVIDER's own record rather than from a Motir
 *  table it may disagree with. */
export const FLEET_METADATA_INTENT_KEY = 'motir_intent_id';

/**
 * Turn a Fly Machine into the port's opaque handle.
 *
 * `createdAt` falls back to now when Fly omits it, because a handle with no
 * creation instant is un-reapable — `reap(olderThan)` compares against exactly
 * this field, and a null would make the container invisible to the one mechanism
 * that exists to catch it.
 */
function toHandle(machine: FlyMachine, fallbackRegion: string): ContainerHandle {
  return {
    provider: 'fly',
    id: machine.id,
    region: machine.region || fallbackRegion,
    createdAt: machine.createdAt ?? new Date(),
  };
}

/** Read the machine, tolerating a provider failure — used only on paths where
 *  the machine is about to be destroyed anyway and a read failure must not stop
 *  that. Returns null both for "gone" and for "could not ask". */
async function readQuietly(id: string): Promise<FlyMachine | null> {
  try {
    return await flyMachinesClient.getMachine(id);
  } catch (err) {
    console.warn('[flyOrchestrator] could not read a machine before teardown', {
      machineId: id,
      detail: err instanceof Error ? err.message : 'unknown',
    });
    return null;
  }
}

export const flyOrchestrator: ContainerOrchestrator = {
  provider: 'fly',

  /**
   * Boot one Machine and return its handle. Does NOT wait for it to start.
   *
   * ⚠️ THE WAIT DELIBERATELY BELONGS TO THE CALLER, and this is the design
   * decision that makes §5's invariant hold. If `provision` waited and threw on a
   * machine that never started, the handle would never reach the caller — and a
   * container that exists but whose handle nobody holds is precisely the untracked
   * container the port forbids, plus a usage row that can never be written.
   * Returning the handle the instant Fly acknowledges the machine means EVERY
   * created machine is tracked from its first moment, and the never-started case
   * is a normal `provision_failed` teardown rather than a leak.
   */
  async provision(spec: ContainerSpec): Promise<ContainerHandle> {
    const config = flyFleetConfig();
    const machine = await flyMachinesClient.createMachine({
      // A deterministic, attributable name: an orphan in the Fly console is
      // traceable to the job it served with no reverse lookup, the same property
      // `runnerGroupNameFor` gives a runner group.
      name: `motir-runner-${spec.workflowJobId}`,
      region: spec.region || config.region,
      image: spec.image,
      cpuKind: spec.size.cpuKind,
      cpus: spec.size.cpus,
      memoryMb: spec.size.memoryMb,
      env: spec.env,
      metadata: {
        [FLEET_METADATA_KEY]: FLEET_METADATA_VALUE,
        [FLEET_METADATA_INTENT_KEY]: String(spec.workflowJobId),
        motir_org_id: spec.orgId,
        motir_project_id: spec.projectId,
      },
    });
    return toHandle(machine, spec.region || config.region);
  },

  async describe(handle: ContainerHandle): Promise<ContainerStatus> {
    const machine = await flyMachinesClient.getMachine(handle.id);
    if (!machine) {
      // GONE is a real answer, and on the happy path it is THE answer:
      // `auto_destroy` means a completed run deletes its own machine.
      return {
        handleId: handle.id,
        exists: false,
        state: 'destroyed',
        terminal: true,
        createdAt: handle.createdAt,
        startedAt: null,
        stoppedAt: null,
      };
    }
    return {
      handleId: handle.id,
      exists: true,
      state: machine.state,
      terminal: isTerminalState(machine.state),
      createdAt: machine.createdAt ?? handle.createdAt,
      startedAt: startedAtOf(machine),
      stoppedAt: stoppedAtOf(machine),
    };
  },

  /**
   * Destroy the machine and return what it cost. IDEMPOTENT — a second call on a
   * destroyed machine returns a usage row rather than throwing, because the
   * `finally` path and the reaper can both reach the same container.
   *
   * The read happens BEFORE the destroy so the row carries Fly's own event
   * timestamps (§5's provider-attested instants). When the machine is already
   * gone the caller's `observedStartedAt` carries the row instead — see
   * `UsageAttribution`.
   */
  async teardown(
    handle: ContainerHandle,
    reason: TeardownReason,
    context: UsageAttribution,
  ): Promise<ContainerUsage> {
    const machine = await readQuietly(handle.id);
    await flyMachinesClient.destroyMachine(handle.id);
    return usageFor(handle, machine, reason, context);
  },

  /**
   * THE CRASH BACKSTOP (§7.1's third guarantee). Destroy every fleet machine
   * older than `olderThan`, whatever Motir's own tables think.
   *
   * It reads the PROVIDER, never in-process state, because the case it exists for
   * — the orchestrator dying between provision and teardown — is exactly the case
   * in which in-process state is the thing that is missing. The intent table is
   * consulted only to ATTRIBUTE what the provider reports, never to decide what
   * exists.
   *
   * A machine with no attribution is still DESTROYED, and loudly logged, but
   * yields no usage row: a cost row attributed to nobody would pollute the meter
   * with spend it cannot assign, which is worse for the reconciliation than a
   * gap it can see in the log. Stopping the fleet from billing is the property
   * that costs money; recording it is the property that costs an entry.
   */
  async reap(olderThan: Date, resolve: UsageAttributionResolver): Promise<ContainerUsage[]> {
    const machines = await flyMachinesClient.listMachines();
    const usages: ContainerUsage[] = [];

    for (const machine of machines) {
      if (machine.metadata[FLEET_METADATA_KEY] !== FLEET_METADATA_VALUE) continue;
      const createdAt = machine.createdAt;
      // A machine with no creation instant cannot be aged, and destroying it on a
      // guess could kill a container that booted a second ago. Report it instead
      // — a fleet machine Fly describes without a `created_at` is a provider
      // anomaly worth seeing, not something to act on blind.
      if (!createdAt) {
        console.warn('[flyOrchestrator] fleet machine has no creation instant — not reaped', {
          machineId: machine.id,
        });
        continue;
      }
      if (createdAt.getTime() >= olderThan.getTime()) continue;

      const handle = toHandle(machine, machine.region);
      const attribution = await resolve(handle);
      try {
        await flyMachinesClient.destroyMachine(handle.id);
      } catch (err) {
        // One machine's refusal must not abandon the rest of the sweep — the
        // sweep is the last line, and a fleet-wide leak because one destroy
        // 500'd is the failure mode it exists to prevent.
        console.error('[flyOrchestrator] could not reap a fleet machine', {
          machineId: handle.id,
          detail: err instanceof Error ? err.message : 'unknown',
        });
        continue;
      }

      if (!attribution) {
        console.warn('[flyOrchestrator] reaped a fleet machine with no attributable intent', {
          machineId: handle.id,
          createdAt: createdAt.toISOString(),
        });
        continue;
      }
      usages.push(usageFor(handle, machine, 'reaped', attribution));
    }

    return usages;
  },
};

/**
 * Build the §5 record from whatever the provider was still able to tell us.
 *
 * The precedence is deliberate and stated once here rather than at three call
 * sites: Fly's own event timestamps WIN (they are provider-attested and measure
 * Fly's boot, not our polling), the caller's observation is the FALLBACK for the
 * self-destroyed happy path, and `stoppedAt` falls back to now — the instant we
 * destroyed it, which is the truthful answer when the provider no longer has one.
 */
function usageFor(
  handle: ContainerHandle,
  machine: FlyMachine | null,
  reason: TeardownReason,
  context: UsageAttribution,
): ContainerUsage {
  const providerStartedAt = machine ? startedAtOf(machine) : null;
  const providerStoppedAt = machine ? stoppedAtOf(machine) : null;
  return buildContainerUsage({
    handle,
    attribution: context,
    reason,
    lifecycle: {
      createdAt: machine?.createdAt ?? handle.createdAt,
      startedAt: providerStartedAt ?? context.observedStartedAt,
      stoppedAt: providerStoppedAt ?? new Date(),
      terminalState: machine?.state ?? 'destroyed',
    },
  });
}
