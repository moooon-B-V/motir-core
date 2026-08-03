import {
  exitCodeOf,
  flyFleetConfig,
  flyMachinesClient,
  isTerminalState,
  startedAtOf,
  stoppedAtOf,
  type FlyMachine,
} from './flyMachines';
import { buildContainerUsage } from '../../usage';
import type { FleetWorkloadKind } from '@/lib/ciFleet/workloads';
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

/**
 * The tag's VALUE, per workload (MOTIR-2025) — it used to be the constant
 * `'ci-runner'`, which was accurate while the fleet had one consumer and became
 * a lie the moment it had two.
 *
 * ⚠️ TOTAL BY CONSTRUCTION, deliberately mirroring `FLEET_WORKLOADS`: adding a
 * member to `FleetWorkloadKind` without giving it a tag is a COMPILE error, not
 * a container that boots tagged as something it is not. An index machine
 * mis-tagged `ci-runner` is unattributable in the Fly console AND indistinguish-
 * able to `reap()`, which is the failure this record exists to make impossible.
 *
 * ⚠️ THE `ci_runner` VALUE IS FROZEN. Machines already running in the fleet app
 * carry `ci-runner`, and `reap()` recognises its own containers by exactly this
 * string — changing it would strand every live machine outside the sweep that
 * exists to stop them billing.
 */
export const FLEET_METADATA_VALUES: Record<FleetWorkloadKind, string> = {
  ci_runner: 'ci-runner',
  code_graph_index: 'code-graph-index',
  hosted_agent: 'hosted-agent',
};

/** Every tag value the fleet answers to — what makes a machine one of OURS,
 *  whatever it is running. `reap()` sweeps the set, never a single value. */
const FLEET_METADATA_VALUE_SET: ReadonlySet<string> = new Set(Object.values(FLEET_METADATA_VALUES));

/** Machine metadata naming the intent a container serves, so the reaper can
 *  resolve attribution from the PROVIDER's own record rather than from a Motir
 *  table it may disagree with. */
export const FLEET_METADATA_INTENT_KEY = 'motir_intent_id';

/**
 * The machine-NAME prefix per workload — how a human tells the containers apart
 * in the Fly console, where the metadata is one click further away.
 *
 * `ci_runner`'s is frozen for the same reason its tag is: `motir-runner-<jobId>`
 * is the name the operator runbook, the console and MOTIR-1921's own tests read.
 */
const FLEET_MACHINE_NAME_PREFIXES: Record<FleetWorkloadKind, string> = {
  ci_runner: 'motir-runner',
  code_graph_index: 'motir-index',
  hosted_agent: 'motir-agent',
};

/** Fly machine names are lower-case alphanumerics and hyphens. */
function slug(value: string, maxLength: number): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLength)
      .replace(/-+$/, '') || 'x'
  );
}

/** FNV-1a, 32-bit, as 8 hex digits — a stable discriminator for a name whose
 *  readable part has to be truncated. Chosen because the plan loader already
 *  uses FNV-1a for deterministic derivation, not for any cryptographic property. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * A deterministic, attributable machine name — derived from the WORKLOAD, not
 * hardcoded to the runner shape.
 *
 * The property that matters is the one the original comment named: an orphan in
 * the Fly console is traceable to the work it served with no reverse lookup.
 *
 * ⚠️ THE CI NAME IS BYTE-FOR-BYTE WHAT IT WAS. GitHub's job id is the strongest
 * discriminator a container can carry — one job, one container — so it stays the
 * name whenever it exists.
 *
 * A workload with no job id is discriminated by the pair that DOES identify it:
 * the repository and the project. Both go in, the repo readably and the pair as
 * a hash, because a Motir project spans several repositories and a project
 * spans several containers — a name built from either alone would collide, and a
 * Fly machine name has to be unique within the app.
 */
function machineNameFor(spec: ContainerSpec): string {
  const prefix = FLEET_MACHINE_NAME_PREFIXES[spec.workload];
  if (spec.workflowJobId !== null) return `${prefix}-${spec.workflowJobId}`;
  const repo = slug(spec.repoFullName.split('/').pop() ?? spec.repoFullName, 24);
  return `${prefix}-${repo}-${shortHash(`${spec.repoFullName}:${spec.projectId}`)}`;
}

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
      // traceable to the work it served with no reverse lookup, the same property
      // `runnerGroupNameFor` gives a runner group.
      name: machineNameFor(spec),
      region: spec.region || config.region,
      image: spec.image,
      cpuKind: spec.size.cpuKind,
      cpus: spec.size.cpus,
      memoryMb: spec.size.memoryMb,
      env: spec.env,
      metadata: {
        [FLEET_METADATA_KEY]: FLEET_METADATA_VALUES[spec.workload],
        // Only a CI container has an Actions job to name. The key is OMITTED
        // rather than set to a placeholder for a workload that has none: an
        // empty `motir_intent_id` reads, in the console and to anything that
        // greps metadata, as an intent that could not be resolved.
        ...(spec.workflowJobId !== null
          ? { [FLEET_METADATA_INTENT_KEY]: String(spec.workflowJobId) }
          : {}),
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
        // GONE takes the exit code with it. The consumer has to treat "stopped,
        // code unknown" as its own case, which is why the port documents `null`
        // as an answer rather than as a missing success.
        exitCode: null,
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
      exitCode: exitCodeOf(machine),
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
      // ⚠️ THE WHOLE FLEET, NOT JUST THE RUNNERS. The sweep recognises any tag
      // value the registry declares — an index or agent container leaked by a
      // dead dispatcher bills exactly like a runner does, and a reaper that
      // matched one hardcoded string would walk straight past it.
      if (!FLEET_METADATA_VALUE_SET.has(machine.metadata[FLEET_METADATA_KEY] ?? '')) continue;
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
